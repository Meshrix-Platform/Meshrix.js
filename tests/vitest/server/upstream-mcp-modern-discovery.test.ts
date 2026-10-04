import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { createMemoryLocalSecretKeyProvider } from "../../../packages/foundation/src/security/secrets/local-secret-key-provider.ts";
import { initializeLocalSecret, rotateLocalSecret } from "../../../packages/foundation/src/security/secrets/local-secret-store.ts";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";

type PeerRequest = {
  method: string;
  id: string | number;
  params: Record<string, any>;
  headers: IncomingMessage["headers"];
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function responseBody(response: ServerResponse, id: string | number, result: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

const registries: Array<ReturnType<typeof createUpstreamGatewayRegistry>> = [];
const servers: Array<ReturnType<typeof createServer>> = [];
const keyProviders: Array<ReturnType<typeof createMemoryLocalSecretKeyProvider>> = [];
const tempRoots: string[] = [];
afterEach(async () => {
  while (registries.length) await registries.pop()!.close();
  while (keyProviders.length) keyProviders.pop()!.close();
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (tempRoots.length) await fs.rm(tempRoots.pop()!, { recursive: true, force: true });
});

async function controlledPeer() {
  const requests: PeerRequest[] = [];
  let supportedVersions: unknown[] = ["2026-07-28"];
  let listMode: "valid" | "malformed" | "null-cursor" = "valid";
  const discoveryGates: Array<{
    gate: ReturnType<typeof deferred>;
    started: ReturnType<typeof deferred<number>>;
    canceled: ReturnType<typeof deferred>;
    setCanceled(): void;
    wasCanceled(): boolean;
  }> = [];
  let calls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ method: String(wire.method), id: wire.id, params: wire.params || {}, headers: request.headers });
    if (wire.method === "server/discover") {
      calls += 1;
      const heldDiscovery = discoveryGates.shift();
      heldDiscovery?.started.resolve(calls);
      if (heldDiscovery) {
        response.once("close", () => {
          if (!response.writableEnded) {
            heldDiscovery.setCanceled();
            heldDiscovery.canceled.resolve();
          }
        });
        await heldDiscovery.gate.promise;
      }
      if (response.destroyed) return;
      responseBody(response, wire.id, { resultType: "complete", supportedVersions });
      return;
    }
    if (wire.method === "tools/list") {
      if (listMode === "malformed") {
        responseBody(response, wire.id, { resultType: "complete", tools: { name: "not-an-array" } });
      } else if (listMode === "null-cursor") {
        responseBody(response, wire.id, { resultType: "complete", tools: [{ name: "echo", inputSchema: { type: "object" } }], nextCursor: null });
      } else if (wire.params.cursor === undefined) {
        const toolName = request.headers.authorization === "Bearer rotated-token" ? "rotated" : "echo";
        responseBody(response, wire.id, {
          resultType: "complete",
          tools: [{ name: toolName, inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }],
          nextCursor: "page two"
        });
      } else if (wire.params.cursor === "page two") {
        responseBody(response, wire.id, { resultType: "complete", tools: [{ name: "status", inputSchema: { type: "object" } }] });
      } else {
        response.writeHead(400).end();
      }
      return;
    }
    if (wire.method === "tools/call") {
      responseBody(response, wire.id, {
        resultType: "complete",
        content: [{ type: "text", text: "modern-peer" }],
        structuredContent: { accepted: true, value: wire.params.arguments?.value }
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic modern MCP peer did not bind.");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    setSupportedVersions(versions: unknown[]) { supportedVersions = versions; },
    setListMode(mode: typeof listMode) { listMode = mode; },
    holdNextDiscovery() {
      const gate = deferred();
      const started = deferred<number>();
      const canceled = deferred();
      let didCancel = false;
      discoveryGates.push({
        gate,
        started,
        canceled,
        setCanceled() { didCancel = true; },
        wasCanceled() { return didCancel; }
      });
      return { gate, started: started.promise, canceled: canceled.promise, wasCanceled: () => didCancel };
    }
  };
}

async function registryFor(url: string, options: Record<string, any> = {}, credentialRefs: string[] = []) {
  const registry = createUpstreamGatewayRegistry({ schemaPort: createGatewaySchemaPort(), ...options });
  registries.push(registry);
  await installUpstreamRuntimeServices(registry, [{
    serviceId: "modern-peer",
    serviceProtocol: "mcp",
    label: "modern-peer",
    allowLocalNetwork: true,
    ...(credentialRefs.length > 0 ? { credentialRefs } : {}),
    operations: [{ operationKey: "tools/call", protocol: "mcp", risk: "read_only", requiredScopes: ["gateway:read"] }],
    mcp: { transport: "http", url, protocolVersion: "2026-07-28", toolsCacheTtlMs: 60_000 }
  }]);
  return registry;
}

async function credentialRegistryFor(peer: Awaited<ReturnType<typeof controlledPeer>>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-modern-discovery-credentials-"));
  tempRoots.push(root);
  const keyProvider = createMemoryLocalSecretKeyProvider();
  keyProviders.push(keyProvider);
  const secretRef = "secret://modern-discovery/catalog";
  const target = {
    provider: "modern-discovery-test",
    family: "modern-discovery",
    authType: "bearer",
    secretRef,
    scope: {
      serviceId: "modern-peer",
      allowedHosts: [new URL(peer.url).hostname],
      allowedProtocols: ["http"],
      scopes: ["gateway:read"]
    }
  };
  const initialized = await initializeLocalSecret({ dataDir: root, keyProvider, target, payload: { token: "initial-token" } });
  let expectedRevision = initialized.secret.revision;
  const keyLoadGates: Array<{
    gate: ReturnType<typeof deferred>;
    started: ReturnType<typeof deferred>;
    settled: ReturnType<typeof deferred>;
  }> = [];
  const registryKeyProvider = {
    protocolVersion: keyProvider.protocolVersion,
    custody: keyProvider.custody,
    async loadKey() {
      const held = keyLoadGates.shift();
      held?.started.resolve();
      try {
        if (held) await held.gate.promise;
        return await keyProvider.loadKey();
      } finally {
        held?.settled.resolve();
      }
    },
    close() { keyProvider.close(); },
    describe() { return keyProvider.describe(); }
  };
  const registry = await registryFor(peer.url, { userDataPath: root, secretKeyProvider: registryKeyProvider }, [secretRef]);
  return {
    registry,
    async rotate(token: string) {
      const rotated = await rotateLocalSecret({ dataDir: root, keyProvider, target, payload: { token }, expectedRevision });
      expectedRevision = rotated.secret.revision;
    },
    holdNextKeyLoad() {
      const gate = deferred();
      const started = deferred();
      const settled = deferred();
      keyLoadGates.push({ gate, started, settled });
      return { gate, started: started.promise, settled: settled.promise };
    }
  };
}

describe("configured modern upstream MCP discovery", () => {
  it("discovers, collects a complete paginated catalog, caches it, then calls the peer through the registry", async () => {
    const peer = await controlledPeer();
    const registry = await registryFor(peer.url);

    const listed = await registry.listMcpTools({ serviceId: "modern-peer" });
    expect(listed.items.map((tool: any) => tool.name)).toEqual([
      "upstream.modern-peer.echo",
      "upstream.modern-peer.status"
    ]);
    expect(peer.requests.map((request) => request.method)).toEqual([
      "server/discover",
      "tools/list",
      "tools/list"
    ]);
    expect(peer.requests[0].headers["mcp-method"]).toBe("server/discover");
    expect(peer.requests[0].headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(peer.requests[1].params.cursor).toBeUndefined();
    expect(peer.requests[2].params.cursor).toBe("page two");
    expect(peer.requests.every((request) => request.method !== "initialize")).toBe(true);

    await registry.listMcpTools({ serviceId: "modern-peer" });
    expect(peer.requests).toHaveLength(3);

    const called = await registry.callMcpToolByPublicName(
      "upstream.modern-peer.echo",
      { arguments: { value: "works" } },
      { type: "operator", subjectId: "synthetic-caller", grantId: "synthetic-grant", scopes: ["gateway:admin"] }
    );
    expect(called).toMatchObject({ ok: true, response: { structuredContent: { accepted: true, value: "works" } } });
    expect(peer.requests.map((request) => request.method)).toEqual([
      "server/discover",
      "tools/list",
      "tools/list",
      "server/discover",
      "tools/call"
    ]);
    expect(peer.requests.at(-1)?.params).toMatchObject({ name: "echo", arguments: { value: "works" } });
    expect(peer.requests.at(-1)?.headers["mcp-method"]).toBe("tools/call");
  });

  it("does not cache failed discovery, malformed pages, or incomplete catalogs", async () => {
    const peer = await controlledPeer();
    const registry = await registryFor(peer.url);

    peer.setSupportedVersions(["2025-06-18"]);
    await expect(registry.listMcpTools({ serviceId: "modern-peer" }))
      .rejects.toMatchObject({ reasonCode: "upstream_mcp_discovery_failed" });
    peer.setSupportedVersions(["2026-07-28"]);

    peer.setListMode("malformed");
    await expect(registry.listMcpTools({ serviceId: "modern-peer" }))
      .rejects.toMatchObject({ reasonCode: "upstream_mcp_discovery_failed" });
    peer.setListMode("null-cursor");
    await expect(registry.listMcpTools({ serviceId: "modern-peer" }))
      .rejects.toMatchObject({ reasonCode: "upstream_mcp_discovery_failed" });

    peer.setListMode("valid");
    const recovered = await registry.listMcpTools({ serviceId: "modern-peer" });
    expect(recovered.items.map((tool: any) => tool.name)).toEqual([
      "upstream.modern-peer.echo",
      "upstream.modern-peer.status"
    ]);
    expect(peer.requests.filter((request) => request.method === "server/discover")).toHaveLength(4);
  });

  it("releases a canceled in-flight modern discovery and permits a fresh complete refresh", async () => {
    const peer = await controlledPeer();
    const registry = await registryFor(peer.url);
    const held = peer.holdNextDiscovery();
    const controller = new AbortController();
    const refresh = registry.listMcpTools({ serviceId: "modern-peer" }, { signal: controller.signal });
    await held.started;
    controller.abort();
    await expect(refresh).rejects.toMatchObject({ reasonCode: "upstream_mcp_cancelled" });
    await held.canceled;
    held.gate.resolve();

    const listed = await registry.listMcpTools({ serviceId: "modern-peer" });
    expect(listed.items.map((tool: any) => tool.name)).toEqual([
      "upstream.modern-peer.echo",
      "upstream.modern-peer.status"
    ]);
    expect(peer.requests.map((request) => request.method)).toEqual([
      "server/discover",
      "server/discover",
      "tools/list",
      "tools/list"
    ]);
  });

  it("cancels an abandoned refresh when its credential-preparing follower also leaves", async () => {
    const peer = await controlledPeer();
    const { registry, holdNextKeyLoad } = await credentialRegistryFor(peer);
    const heldDiscovery = peer.holdNextDiscovery();
    const creatorController = new AbortController();
    const creator = registry.listMcpTools({ serviceId: "modern-peer" }, { signal: creatorController.signal });
    const followerController = new AbortController();
    let heldKeyLoad: ReturnType<typeof holdNextKeyLoad> | null = null;
    const pending = [creator];

    try {
      await heldDiscovery.started;
      const keyLoad = holdNextKeyLoad();
      heldKeyLoad = keyLoad;
      const currentFollower = registry.listMcpTools({ serviceId: "modern-peer" }, { signal: followerController.signal });
      pending.push(currentFollower);
      await keyLoad.started;

      const creatorCanceled = expect(creator).rejects.toMatchObject({ reasonCode: "upstream_mcp_cancelled" });
      creatorController.abort();
      await creatorCanceled;
      expect(heldDiscovery.wasCanceled()).toBe(false);

      const followerCanceled = expect(currentFollower).rejects.toMatchObject({ reasonCode: "upstream_mcp_cancelled" });
      followerController.abort();
      await followerCanceled;
      await heldDiscovery.canceled;

      heldDiscovery.gate.resolve();
      keyLoad.gate.resolve();
      await keyLoad.settled;

      const fresh = await registry.listMcpTools({ serviceId: "modern-peer" });
      expect(fresh.items.map((tool: any) => tool.name)).toContain("upstream.modern-peer.echo");
      expect(peer.requests.map((request) => request.method)).toEqual([
        "server/discover",
        "server/discover",
        "tools/list",
        "tools/list"
      ]);
    } finally {
      heldDiscovery.gate.resolve();
      heldKeyLoad?.gate.resolve();
      if (heldKeyLoad) await heldKeyLoad.settled;
      await Promise.allSettled(pending);
    }
  });

  it("cancels and settles an owned modern discovery when the registry closes", async () => {
    const peer = await controlledPeer();
    const registry = await registryFor(peer.url);
    const held = peer.holdNextDiscovery();
    const refresh = registry.listMcpTools({ serviceId: "modern-peer" });
    try {
      await held.started;
      const canceled = expect(refresh).rejects.toMatchObject({ reasonCode: "upstream_mcp_cancelled" });
      const closing = registry.close();
      await held.canceled;
      held.gate.resolve();
      await closing;
      await canceled;
      expect(peer.requests.map((request) => request.method)).toEqual(["server/discover"]);
    } finally {
      held.gate.resolve();
      await Promise.allSettled([refresh]);
    }
  });

  it("does not start a late discovery after close wins a credential-resolution wait", async () => {
    const peer = await controlledPeer();
    const { registry, holdNextKeyLoad } = await credentialRegistryFor(peer);
    const held = holdNextKeyLoad();
    const refresh = registry.listMcpTools({ serviceId: "modern-peer" });
    try {
      await held.started;
      const canceled = expect(refresh).rejects.toMatchObject({ reasonCode: "upstream_mcp_registry_closed" });
      await registry.close();
      await canceled;
      expect(peer.requests).toEqual([]);
      held.gate.resolve();
      await held.settled;
      expect(peer.requests).toEqual([]);
    } finally {
      held.gate.resolve();
      await held.settled;
      await Promise.allSettled([refresh]);
    }
  });

  it("cancels credential preparation when its service is invalidated", async () => {
    const peer = await controlledPeer();
    const { registry, holdNextKeyLoad } = await credentialRegistryFor(peer);
    const held = holdNextKeyLoad();
    const refresh = registry.listMcpTools({ serviceId: "modern-peer" });
    try {
      await held.started;
      const canceled = expect(refresh).rejects.toMatchObject({ reasonCode: "upstream_mcp_cancelled" });
      await installUpstreamRuntimeServices(registry, []);
      await canceled;
      expect(peer.requests).toEqual([]);
      held.gate.resolve();
      await held.settled;
      expect(peer.requests).toEqual([]);
    } finally {
      held.gate.resolve();
      await held.settled;
      await Promise.allSettled([refresh]);
    }
  });

  it("partitions completed catalogs by the existing credential revision generation", async () => {
    const peer = await controlledPeer();
    const { registry, rotate } = await credentialRegistryFor(peer);

    const initial = await registry.listMcpTools({ serviceId: "modern-peer" });
    expect(initial.items.map((tool: any) => tool.name)).toContain("upstream.modern-peer.echo");
    await rotate("rotated-token");
    const rotated = await registry.listMcpTools({ serviceId: "modern-peer" });
    expect(rotated.items.map((tool: any) => tool.name)).toContain("upstream.modern-peer.rotated");
    expect(peer.requests.filter((request) => request.method === "server/discover")).toHaveLength(2);
    expect(peer.requests.filter((request) => request.method === "tools/list").map((request) => request.headers.authorization))
      .toEqual(["Bearer initial-token", "Bearer initial-token", "Bearer rotated-token", "Bearer rotated-token"]);
  });

  it("keeps concurrent refreshes for distinct credential generations independent", async () => {
    const peer = await controlledPeer();
    const { registry, rotate } = await credentialRegistryFor(peer);
    const initialDiscovery = peer.holdNextDiscovery();
    const initialRefresh = registry.listMcpTools({ serviceId: "modern-peer" });
    let releaseRotatedDiscovery: (() => void) | null = null;
    const pending = [initialRefresh];

    try {
      await initialDiscovery.started;
      await rotate("rotated-token");
      const rotatedDiscovery = peer.holdNextDiscovery();
      releaseRotatedDiscovery = () => rotatedDiscovery.gate.resolve();
      const rotatedRefresh = registry.listMcpTools({ serviceId: "modern-peer" });
      pending.push(rotatedRefresh);
      await rotatedDiscovery.started;

      initialDiscovery.gate.resolve();
      const initial = await initialRefresh;
      expect(initial.items.map((tool: any) => tool.name)).toContain("upstream.modern-peer.echo");
      expect(rotatedDiscovery.wasCanceled()).toBe(false);

      rotatedDiscovery.gate.resolve();
      const rotated = await rotatedRefresh;
      expect(rotated.items.map((tool: any) => tool.name)).toContain("upstream.modern-peer.rotated");
      expect(peer.requests.filter((request) => request.method === "server/discover")).toHaveLength(2);
      expect(peer.requests.filter((request) => request.method === "tools/list").map((request) => request.headers.authorization))
        .toEqual(["Bearer initial-token", "Bearer initial-token", "Bearer rotated-token", "Bearer rotated-token"]);
    } finally {
      initialDiscovery.gate.resolve();
      releaseRotatedDiscovery?.();
      await Promise.allSettled(pending);
    }
  });
});
