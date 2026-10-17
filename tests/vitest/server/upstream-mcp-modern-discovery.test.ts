import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { createMemoryLocalSecretKeyProvider } from "../../../packages/foundation/src/security/secret-store/local-secret-key-provider.ts";
import { initializeLocalSecret, rotateLocalSecret } from "../../../packages/foundation/src/security/secret-store/local-secret-store.ts";
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
  let listMode: "valid" | "malformed" | "null-cursor" = "valid";
  let mismatchToolCallResponseId = false;
  let nextToolCallJsonRpcError = false;
  let nextToolCallHttpError = false;
  let nextToolCallHttpErrorClose: ReturnType<typeof deferred<boolean>> | null = null;
  let hasNextToolCallResult = false;
  let nextToolCallResult: unknown;
  let nextToolCallSseResponse: { closed: ReturnType<typeof deferred<boolean>> } | null = null;
  const requestGates: Array<{
    method: string;
    authorization?: string;
    gate: ReturnType<typeof deferred>;
    started: ReturnType<typeof deferred<number>>;
    canceled: ReturnType<typeof deferred>;
    setCanceled(): void;
    wasCanceled(): boolean;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ method: String(wire.method), id: wire.id, params: wire.params || {}, headers: request.headers });
    const gateIndex = requestGates.findIndex((candidate) =>
      candidate.method === wire.method &&
      (candidate.authorization === undefined || candidate.authorization === request.headers.authorization)
    );
    const heldRequest = gateIndex < 0 ? undefined : requestGates.splice(gateIndex, 1)[0];
    heldRequest?.started.resolve(requests.length);
    if (heldRequest) {
      response.once("close", () => {
        if (!response.writableEnded) {
          heldRequest.setCanceled();
          heldRequest.canceled.resolve();
        }
      });
      await heldRequest.gate.promise;
    }
    if (response.destroyed) return;
    if (wire.method === "server/discover") {
      responseBody(response, wire.id, { resultType: "complete", supportedVersions: ["2026-07-28"] });
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
      if (nextToolCallHttpError) {
        nextToolCallHttpError = false;
        response.writeHead(502, { "content-type": "application/json" });
        const closed = nextToolCallHttpErrorClose;
        nextToolCallHttpErrorClose = null;
        let finishErrorBody: ReturnType<typeof setTimeout> | undefined;
        response.once("close", () => {
          clearTimeout(finishErrorBody);
          closed?.resolve(!response.writableEnded);
        });
        response.write(JSON.stringify({ error: "synthetic-provider-detail" }));
        if (closed) finishErrorBody = setTimeout(() => response.end(), 200);
        else response.end();
        return;
      }
      if (nextToolCallJsonRpcError) {
        nextToolCallJsonRpcError = false;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: wire.id,
          error: { code: -32000, message: "synthetic-provider-detail" }
        }));
        return;
      }
      if (hasNextToolCallResult) {
        hasNextToolCallResult = false;
        responseBody(response, wire.id, nextToolCallResult);
        return;
      }
      if (nextToolCallSseResponse) {
        const { closed } = nextToolCallSseResponse;
        nextToolCallSseResponse = null;
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        response.once("close", () => {
          clearTimeout(finishSse);
          closed.resolve(!response.writableEnded);
        });
        response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
        response.write(`event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: wire.id,
          result: {
            resultType: "complete",
            content: [{ type: "text", text: "modern-peer" }],
            structuredContent: { accepted: true, value: wire.params.arguments?.value }
          }
        })}\n\n`);
        const finishSse = setTimeout(() => response.end(), 200);
        return;
      }
      responseBody(response, mismatchToolCallResponseId ? `${wire.id}-mismatch` : wire.id, {
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
    setListMode(mode: typeof listMode) { listMode = mode; },
    mismatchNextToolCallResponseId() { mismatchToolCallResponseId = true; },
    failNextToolCallWithJsonRpcError() { nextToolCallJsonRpcError = true; },
    failNextToolCallWithHttpError() { nextToolCallHttpError = true; },
    failNextToolCallWithOpenHttpErrorBody() {
      const closed = deferred<boolean>();
      nextToolCallHttpError = true;
      nextToolCallHttpErrorClose = closed;
      return closed.promise;
    },
    returnNextToolCallResult(result: unknown) {
      nextToolCallResult = result;
      hasNextToolCallResult = true;
    },
    streamNextToolCallResponseAsSse() {
      const closed = deferred<boolean>();
      nextToolCallSseResponse = { closed };
      return closed.promise;
    },
    holdNextRequest(method: string, authorization?: string) {
      const gate = deferred();
      const started = deferred<number>();
      const canceled = deferred();
      let didCancel = false;
      requestGates.push({
        method,
        ...(authorization === undefined ? {} : { authorization }),
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
      allowedOrigins: [new URL(peer.url).origin],
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

describe("configured modern upstream MCP catalog", () => {
  // Governed callers hold the explicit upstream tool capability; the capability
  // check is the gate for every subject type, not just typed grants.
  const CALLER = {
    type: "operator",
    subjectId: "synthetic-caller",
    grantId: "synthetic-grant",
    scopes: ["gateway:admin"],
    dynamicCapabilities: [
      "cap:upstream:modern-peer:tools-call-echo",
      "cap:upstream:modern-peer:tools-call-status"
    ]
  } as const;
  it("collects a complete paginated catalog, caches it, then calls the peer directly through the registry", async () => {
    const peer = await controlledPeer();
    const registry = await registryFor(peer.url);

    const listed = await registry.listMcpTools({ serviceId: "modern-peer" });
    expect(listed.items.map((tool: any) => tool.name)).toEqual([
      "upstream.modern-peer.echo",
      "upstream.modern-peer.status"
    ]);
    expect(peer.requests.map((request) => request.method)).toEqual([
      "tools/list",
      "tools/list"
    ]);
    expect(peer.requests[0].headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(peer.requests[0].params.cursor).toBeUndefined();
    expect(peer.requests[1].params.cursor).toBe("page two");
    expect(peer.requests.every((request) => request.method !== "initialize")).toBe(true);

    await registry.listMcpTools({ serviceId: "modern-peer" });
    expect(peer.requests).toHaveLength(2);

    const called = await registry.callMcpToolByPublicName(
      "upstream.modern-peer.echo",
      { arguments: { value: "works" } },
      CALLER
    );
    expect(called).toMatchObject({ ok: true, response: { structuredContent: { accepted: true, value: "works" } } });
    expect(peer.requests.map((request) => request.method)).toEqual([
      "tools/list",
      "tools/list",
      "tools/call"
    ]);
    expect(peer.requests.at(-1)?.params).toMatchObject({ name: "echo", arguments: { value: "works" } });
    expect(peer.requests.at(-1)?.headers["mcp-method"]).toBe("tools/call");
  });

  it("reads the matching SSE response frame and cancels the still-open stream", async () => {
    const peer = await controlledPeer();
    const registry = await registryFor(peer.url);
    await registry.listMcpTools({ serviceId: "modern-peer" });
    const streamClosedBeforeServerEnd = peer.streamNextToolCallResponseAsSse();

    const called = await registry.callMcpToolByPublicName(
      "upstream.modern-peer.echo",
      { arguments: { value: "works" } },
      CALLER
    );

    expect(called).toMatchObject({ ok: true, response: { structuredContent: { accepted: true, value: "works" } } });
    expect(await streamClosedBeforeServerEnd).toBe(true);
    expect(peer.requests.map((request) => request.method)).toEqual(["tools/list", "tools/list", "tools/call"]);
  });

  it("does not cache malformed pages or incomplete catalogs", async () => {
    const peer = await controlledPeer();
    const registry = await registryFor(peer.url);

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
    expect(peer.requests.map((request) => request.method)).toEqual([
      "tools/list",
      "tools/list",
      "tools/list",
      "tools/list"
    ]);
  });

  it("rejects a successful tools/call response whose JSON-RPC id does not match", async () => {
    const peer = await controlledPeer();
    const registry = await registryFor(peer.url);
    await registry.listMcpTools({ serviceId: "modern-peer" });
    peer.mismatchNextToolCallResponseId();
    const beforeMetrics = registry.getMetrics();

    await expect(registry.callMcpToolByPublicName(
      "upstream.modern-peer.echo",
      { arguments: { value: "works" } },
      CALLER
    )).rejects.toMatchObject({ message: "Upstream MCP forwarding failed." });

    expect(peer.requests.map((request) => request.method)).toEqual(["tools/list", "tools/list", "tools/call"]);
    const afterMetrics = registry.getMetrics();
    expect(afterMetrics.totalFailureCount).toBe(beforeMetrics.totalFailureCount + 1);
    expect(afterMetrics.totalForwardCount).toBe(beforeMetrics.totalForwardCount + 1);
    const callAudits = registry.listAudit({ serviceId: "modern-peer" }).items
      .filter((event: any) => event.operationKey === "tools/call");
    expect(callAudits.map((event: any) => event.eventType)).toContain("upstream.mcp.gateway.failed");
    expect(callAudits.map((event: any) => event.eventType)).not.toContain("upstream.mcp.gateway.completed");
  });

  it.each([
    { name: "null result", result: null, reasonCode: "upstream_mcp_response_invalid" },
    { name: "missing result type", result: {}, reasonCode: "upstream_mcp_response_invalid" },
    { name: "complete result without content", result: { resultType: "complete" }, reasonCode: "upstream_mcp_response_invalid" },
    { name: "unnegotiated result type", result: { resultType: "unnegotiated" }, reasonCode: "upstream_mcp_result_type_unnegotiated" }
  ])("rejects a modern tools/call with $name as a failed operation", async ({ result, reasonCode }) => {
    const peer = await controlledPeer();
    const registry = await registryFor(peer.url);
    await registry.listMcpTools({ serviceId: "modern-peer" });
    peer.returnNextToolCallResult(result);
    const beforeMetrics = registry.getMetrics();

    await expect(registry.callMcpToolByPublicName(
      "upstream.modern-peer.echo",
      { arguments: { value: "works" } },
      CALLER
    )).rejects.toMatchObject({
      message: "Upstream MCP forwarding failed.",
      status: 502,
      reasonCode
    });

    expect(peer.requests.map((request) => request.method)).toEqual(["tools/list", "tools/list", "tools/call"]);
    const afterMetrics = registry.getMetrics();
    expect(afterMetrics.totalFailureCount).toBe(beforeMetrics.totalFailureCount + 1);
    expect(afterMetrics.totalForwardCount).toBe(beforeMetrics.totalForwardCount + 1);
    const callAudits = registry.listAudit({ serviceId: "modern-peer" }).items
      .filter((event: any) => event.operationKey === "tools/call");
    expect(callAudits.map((event: any) => event.eventType)).toContain("upstream.mcp.gateway.failed");
    expect(callAudits.map((event: any) => event.eventType)).not.toContain("upstream.mcp.gateway.completed");
  });

  it("projects JSON-RPC peer errors as bounded failures without provider text", async () => {
    const peer = await controlledPeer();
    const registry = await registryFor(peer.url);
    await registry.listMcpTools({ serviceId: "modern-peer" });
    peer.failNextToolCallWithJsonRpcError();

    await expect(registry.callMcpToolByPublicName(
      "upstream.modern-peer.echo",
      { arguments: { value: "works" } },
      CALLER
    )).rejects.toMatchObject({
      message: "Upstream MCP forwarding failed.",
      status: 502,
      reasonCode: "upstream_jsonrpc_error"
    });

    const callAudits = registry.listAudit({ serviceId: "modern-peer" }).items
      .filter((event: any) => event.operationKey === "tools/call");
    expect(callAudits.map((event: any) => event.eventType)).toContain("upstream.mcp.gateway.failed");
    expect(callAudits.map((event: any) => event.eventType)).not.toContain("upstream.mcp.gateway.completed");
    expect(JSON.stringify(callAudits)).not.toContain("synthetic-provider-detail");
  });

  it("redacts HTTP error bodies while recording a failed modern call", async () => {
    const peer = await controlledPeer();
    const registry = await registryFor(peer.url);
    await registry.listMcpTools({ serviceId: "modern-peer" });
    peer.failNextToolCallWithHttpError();

    const result = await registry.executePublishedMcpRoute(
      "upstream.modern-peer.echo",
      { arguments: { value: "works" } },
      CALLER
    );

    expect(result.status).toBe(502);
    expect(JSON.stringify(result)).not.toContain("synthetic-provider-detail");
    expect(result.body).toMatchObject({ error: { message: "Upstream MCP request failed." } });
    peer.failNextToolCallWithHttpError();
    await expect(registry.callMcpToolByPublicName(
      "upstream.modern-peer.echo",
      { arguments: { value: "works" } },
      CALLER
    )).rejects.toMatchObject({
      message: "Upstream MCP forwarding failed.",
      status: 502,
      reasonCode: "upstream_mcp_call_failed"
    });
    const callAudits = registry.listAudit({ serviceId: "modern-peer" }).items
      .filter((event: any) => event.operationKey === "tools/call");
    expect(callAudits.map((event: any) => event.eventType)).toContain("upstream.mcp.gateway.failed");
    expect(callAudits.map((event: any) => event.eventType)).not.toContain("upstream.mcp.gateway.completed");
    expect(JSON.stringify(callAudits)).not.toContain("synthetic-provider-detail");
  });

  it("cancels an unnecessary HTTP failure body without waiting to read it", async () => {
    const peer = await controlledPeer();
    const registry = await registryFor(peer.url);
    await registry.listMcpTools({ serviceId: "modern-peer" });
    const bodyCanceledBeforeServerEnd = peer.failNextToolCallWithOpenHttpErrorBody();

    const result = await registry.executePublishedMcpRoute(
      "upstream.modern-peer.echo",
      { arguments: { value: "works" } },
      CALLER
    );

    expect(result.status).toBe(502);
    expect(JSON.stringify(result)).not.toContain("synthetic-provider-detail");
    expect(await bodyCanceledBeforeServerEnd).toBe(true);
    expect(peer.requests.map((request) => request.method)).toEqual(["tools/list", "tools/list", "tools/call"]);
  });

  it("releases a canceled catalog request and permits a fresh complete refresh", async () => {
    const peer = await controlledPeer();
    const registry = await registryFor(peer.url);
    const held = peer.holdNextRequest("tools/list");
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
      "tools/list",
      "tools/list",
      "tools/list"
    ]);
  });

  it("cancels an abandoned refresh when its credential-preparing follower also leaves", async () => {
    const peer = await controlledPeer();
    const { registry, holdNextKeyLoad } = await credentialRegistryFor(peer);
    const heldCatalogRequest = peer.holdNextRequest("tools/list", "Bearer initial-token");
    const creatorController = new AbortController();
    const creator = registry.listMcpTools({ serviceId: "modern-peer" }, { signal: creatorController.signal });
    const followerController = new AbortController();
    let heldKeyLoad: ReturnType<typeof holdNextKeyLoad> | null = null;
    const pending = [creator];

    try {
      await heldCatalogRequest.started;
      const keyLoad = holdNextKeyLoad();
      heldKeyLoad = keyLoad;
      const currentFollower = registry.listMcpTools({ serviceId: "modern-peer" }, { signal: followerController.signal });
      pending.push(currentFollower);
      await keyLoad.started;

      const creatorCanceled = expect(creator).rejects.toMatchObject({ reasonCode: "upstream_mcp_cancelled" });
      creatorController.abort();
      await creatorCanceled;
      expect(heldCatalogRequest.wasCanceled()).toBe(false);

      const followerCanceled = expect(currentFollower).rejects.toMatchObject({ reasonCode: "upstream_mcp_cancelled" });
      followerController.abort();
      await followerCanceled;
      await heldCatalogRequest.canceled;

      heldCatalogRequest.gate.resolve();
      keyLoad.gate.resolve();
      await keyLoad.settled;

      const fresh = await registry.listMcpTools({ serviceId: "modern-peer" });
      expect(fresh.items.map((tool: any) => tool.name)).toContain("upstream.modern-peer.echo");
      expect(peer.requests.map((request) => request.method)).toEqual([
        "tools/list",
        "tools/list",
        "tools/list"
      ]);
    } finally {
      heldCatalogRequest.gate.resolve();
      heldKeyLoad?.gate.resolve();
      if (heldKeyLoad) await heldKeyLoad.settled;
      await Promise.allSettled(pending);
    }
  });

  it("cancels and settles an owned catalog request when the registry closes", async () => {
    const peer = await controlledPeer();
    const registry = await registryFor(peer.url);
    const held = peer.holdNextRequest("tools/list");
    const refresh = registry.listMcpTools({ serviceId: "modern-peer" });
    try {
      await held.started;
      const canceled = expect(refresh).rejects.toMatchObject({ reasonCode: "upstream_mcp_cancelled" });
      const closing = registry.close();
      await held.canceled;
      held.gate.resolve();
      await closing;
      await canceled;
      expect(peer.requests.map((request) => request.method)).toEqual(["tools/list"]);
    } finally {
      held.gate.resolve();
      await Promise.allSettled([refresh]);
    }
  });

  it("does not start a late catalog request after close wins a credential-resolution wait", async () => {
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
    expect(peer.requests.filter((request) => request.method === "tools/list")).toHaveLength(4);
    expect(peer.requests.filter((request) => request.method === "tools/list").map((request) => request.headers.authorization))
      .toEqual(["Bearer initial-token", "Bearer initial-token", "Bearer rotated-token", "Bearer rotated-token"]);
  });

  it("keeps concurrent refreshes for distinct credential generations independent", async () => {
    const peer = await controlledPeer();
    const { registry, rotate } = await credentialRegistryFor(peer);
    const initialCatalogRequest = peer.holdNextRequest("tools/list", "Bearer initial-token");
    const initialRefresh = registry.listMcpTools({ serviceId: "modern-peer" });
    let releaseRotatedCatalogRequest: (() => void) | null = null;
    const pending = [initialRefresh];

    try {
      await initialCatalogRequest.started;
      await rotate("rotated-token");
      const rotatedCatalogRequest = peer.holdNextRequest("tools/list", "Bearer rotated-token");
      releaseRotatedCatalogRequest = () => rotatedCatalogRequest.gate.resolve();
      const rotatedRefresh = registry.listMcpTools({ serviceId: "modern-peer" });
      pending.push(rotatedRefresh);
      await rotatedCatalogRequest.started;

      initialCatalogRequest.gate.resolve();
      const initial = await initialRefresh;
      expect(initial.items.map((tool: any) => tool.name)).toContain("upstream.modern-peer.echo");
      expect(rotatedCatalogRequest.wasCanceled()).toBe(false);

      rotatedCatalogRequest.gate.resolve();
      const rotated = await rotatedRefresh;
      expect(rotated.items.map((tool: any) => tool.name)).toContain("upstream.modern-peer.rotated");
      expect(peer.requests.filter((request) => request.method === "tools/list")).toHaveLength(4);
      expect(peer.requests.filter((request) => request.method === "tools/list").map((request) => request.headers.authorization).sort())
        .toEqual(["Bearer initial-token", "Bearer initial-token", "Bearer rotated-token", "Bearer rotated-token"].sort());
    } finally {
      initialCatalogRequest.gate.resolve();
      releaseRotatedCatalogRequest?.();
      await Promise.allSettled(pending);
    }
  });
});
