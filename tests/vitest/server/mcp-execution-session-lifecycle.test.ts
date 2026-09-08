import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createUpstreamMcpSessionManager } from "../../../packages/protocols/mcp/upstream-mcp-gateway-transport.ts";
import { resolveMcpServiceConfigWithCredentials } from "../../../packages/agents/src/upstream-gateway/credential-material.ts";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { fingerprint } from "../../../packages/agents/src/upstream-gateway/manifest-compiler.ts";
import { normalizeService } from "../../../packages/agents/src/upstream-gateway/support.ts";
import { executionSubject } from "../../helpers/mcp-downstream-request.ts";

const managers: any = new Set<any>();
const servers: any = new Set<any>();

afterEach(async () : Promise<any> => {
  await Promise.all([...managers].map((manager?: any) : any => manager.close()));
  managers.clear();
  await Promise.allSettled([...servers].map((server?: any) : any => new Promise((resolve?: any) : any => server.close(resolve))));
  servers.clear();
});

function statefulScript() : any {
  return String.raw`
let buffer = "";
let state = 0;
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\n"); }
function handle(message) {
  if (!message || message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stateful", version: "1" } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "state.increment", inputSchema: { type: "object" } }, { name: "state.probe", inputSchema: { type: "object" } }] } });
    return;
  }
  if (message.method !== "tools/call") return;
  if (message.params.name === "state.increment") state += 1;
  send({ jsonrpc: "2.0", id: message.id, result: { structuredContent: { value: state } } });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) if (line.trim()) handle(JSON.parse(line));
});
`;
}

function lifecycleRawService() : any {
  return {
    serviceId: "lifecycle",
    serviceProtocol: "mcp",
    mcp: {
      transport: "stdio",
      command: process.execPath,
      args: ["-e", statefulScript()],
      toolNamePrefix: "lifecycle",
      timeoutMs: 2000
    }
  };
}

function installLifecycleService(registry?: any, revision: any = 1) : any {
  const raw: any = lifecycleRawService();
  const service: Readonly<Record<string, any>> = Object.freeze({
    ...normalizeService(raw, {}),
    manifestDigest: fingerprint({ ...raw, revision }),
    serviceRevision: revision,
    updatedAt: `revision-${revision}`
  });
  return registry.replaceFromManifestSnapshot(Object.freeze({
    setRevision: revision,
    setDigest: fingerprint({ serviceId: "lifecycle", revision }),
    serviceEntries: Object.freeze([Object.freeze(["lifecycle", service])])
  }));
}

function statefulConfig(overrides: Record<string, any> = {}) : any {
  return {
    transport: "stdio",
    command: process.execPath,
    args: ["-e", statefulScript()],
    timeoutMs: 2000,
    sessionKey: "exec-stateful",
    sessionScope: "svc:lifecycle:exec:subject-1:grant-1",
    sessionKind: "stateful",
    ...overrides
  };
}

describe("Stateful MCP execution session lifecycle", () : any => {
  it("rejects a missing trusted principal instead of sharing an empty-principal session", async () : Promise<any> => {
    await expect(resolveMcpServiceConfigWithCredentials({
      service: {
        serviceId: "lifecycle",
        serviceProtocol: "mcp",
        mcp: { transport: "stdio", command: process.execPath }
      },
      purpose: "execution",
      subject: { scopes: ["gateway:write"] }
    })).rejects.toMatchObject({
      status: 403,
      reasonCode: "upstream_mcp_execution_principal_required"
    });
  });

  it("keeps business state beyond both idle TTLs, max lifetime, and capacity pressure", async () : Promise<any> => {
    let now: any = 1_000;
    const manager: any = createUpstreamMcpSessionManager({
      now: () : any => now,
      idleTtlMs: 60_000,
      maxLifetimeMs: 15 * 60_000,
      maxSessions: 1
    });
    managers.add(manager);
    const config: any = statefulConfig();
    const first: any = await manager.callTool(config, { name: "state.increment" });
    expect(first.result.structuredContent.value).toBe(1);
    now += 61_000;
    const afterOldIdle: any = await manager.callTool(config, { name: "state.probe" });
    expect(afterOldIdle.result.structuredContent.value).toBe(1);
    now += 5 * 60_000;
    const afterFiveMinutes: any = await manager.callTool(config, { name: "state.increment" });
    expect(afterFiveMinutes.result.structuredContent.value).toBe(2);
    now += 15 * 60_000;
    const afterMaxLifetime: any = await manager.callTool(config, { name: "state.probe" });
    expect(afterMaxLifetime.result.structuredContent.value).toBe(2);
    expect(manager.snapshot().sessions[0].kind).toBe("stateful");

    const catalog: any = await manager.listTools({
      ...config,
      sessionKey: "ephemeral-catalog",
      sessionScope: "svc:lifecycle:discovery",
      sessionKind: "ephemeral"
    });
    expect(catalog.tools.map((tool?: any) : any => tool.name)).toContain("state.probe");
    await expect(manager.callTool({
      ...config,
      sessionKey: "exec-stateful-other",
      sessionScope: "svc:lifecycle:exec:subject-2:grant-2"
    }, { name: "state.probe" })).rejects.toMatchObject({
      code: "UPSTREAM_MCP_SESSION_CAPACITY"
    });
    expect(manager.snapshot().trackedScopeCount).toBe(2);
    const stillHeld: any = await manager.callTool(config, { name: "state.probe" });
    expect(stillHeld.result.structuredContent.value).toBe(2);
  });

  it("admits concurrent calls on one stateful session and retires every svc scope", async () : Promise<any> => {
    const manager: any = createUpstreamMcpSessionManager();
    managers.add(manager);
    const config: any = statefulConfig();
    const [one, two]: any[] = await Promise.all([
      manager.callTool(config, { name: "state.increment" }),
      manager.callTool(config, { name: "state.increment" })
    ]);
    expect([one.result.structuredContent.value, two.result.structuredContent.value].sort()).toEqual([1, 2]);
    await expect(manager.retireServiceScopes("lifecycle")).resolves.toMatchObject({
      retired: 1
    });
    const afterRetirement: any = await manager.callTool({
      ...config,
      sessionKey: "exec-stateful-after-retire"
    }, { name: "state.probe" });
    expect(afterRetirement.result.structuredContent.value).toBe(0);
  });

  it("retires new session scopes from registry republish and shutdown", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-exec-lifecycle-"));
    const manager: any = createUpstreamMcpSessionManager();
    managers.add(manager);
    const registry: any = createUpstreamGatewayRegistry({
      userDataPath: root,
      mcpSessionManager: manager
    });
    installLifecycleService(registry, 1);
    const subject: Record<string, any> = executionSubject({
      publicToolName: "upstream.lifecycle.state.increment"
    });
    try {
      const first: any = await registry.callMcpToolByPublicName(
        "upstream.lifecycle.state.increment",
        { arguments: {} },
        subject
      );
      expect(first.response.structuredContent.value).toBe(1);
      expect(manager.snapshot().sessions.some((session?: any) : any => session.kind === "stateful")).toBe(true);
      installLifecycleService(registry, 2);
      const afterRepublish: any = await registry.callMcpToolByPublicName(
        "upstream.lifecycle.state.increment",
        { arguments: {} },
        subject
      );
      expect(afterRepublish.response.structuredContent.value).toBe(1);
    } finally {
      await registry.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not retry a stateful HTTP not-found and does not silently rebuild the same logical session", async () : Promise<any> => {
    const fixture: any = await createLifecycleHttpFixture();
    const manager: any = createUpstreamMcpSessionManager({
      fetchTransport: async (url?: any, init?: any) : Promise<any> => ({
        response: await fetch(url, init)
      })
    });
    managers.add(manager);
    const config: Record<string, any> = {
      transport: "streamable-http",
      url: fixture.url,
      timeoutMs: 1000,
      sessionKey: "exec-http-stateful",
      sessionScope: "svc:lifecycle:exec:subject-1:grant-1",
      sessionKind: "stateful",
      sessionGeneration: { serviceRevision: 1, credentialRevisions: [] }
    };
    const first: any = await manager.callTool(config, { name: "state.increment" });
    expect(first.result.structuredContent.value).toBe(1);
    expect(fixture.evidence.initializations).toHaveLength(1);

    await expect(manager.callTool(config, { name: "vanish" })).rejects.toMatchObject({
      code: "UPSTREAM_MCP_STATEFUL_SESSION_LOST",
      reasonCode: "upstream_mcp_stateful_session_lost",
      status: 409
    });
    expect(fixture.evidence.calls.filter((call?: any) : any => call.name === "vanish")).toHaveLength(1);
    expect(fixture.evidence.initializations).toHaveLength(1);
    expect(manager.snapshot().lostStatefulScopeCount).toBe(1);

    await expect(manager.callTool(config, { name: "state.probe" })).rejects.toMatchObject({
      code: "UPSTREAM_MCP_STATEFUL_SESSION_LOST",
      reasonCode: "upstream_mcp_stateful_session_lost"
    });
    expect(fixture.evidence.initializations).toHaveLength(1);
    expect(fixture.evidence.calls.filter((call?: any) : any => call.name === "state.probe")).toHaveLength(0);

    const rebuilt: any = await manager.callTool({
      ...config,
      sessionKey: "exec-http-stateful-generation-2",
      sessionGeneration: { serviceRevision: 2, credentialRevisions: [] }
    }, { name: "state.probe" });
    expect(rebuilt.result.structuredContent.value).toBe(0);
    expect(fixture.evidence.initializations).toHaveLength(2);
  });

  it("counts state-lost logical sessions toward bounded ownership until release", async () : Promise<any> => {
    const evidence: Record<string, any> = { initializations: 0 };
    const manager: any = createUpstreamMcpSessionManager({
      maxSessions: 1,
      async fetchTransport(_url?: any, init?: any) : Promise<any> {
        if (String(init?.method || "GET").toUpperCase() === "DELETE") {
          return { response: new Response(null, { status: 204 }) };
        }
        const message: any = JSON.parse(String(init?.body || "{}"));
        if (message.method === "initialize") {
          evidence.initializations += 1;
          return {
            response: new Response(JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "synthetic", version: "1" }
              }
            }), {
              status: 200,
              headers: {
                "content-type": "application/json",
                "mcp-session-id": `session-${evidence.initializations}`
              }
            })
          };
        }
        if (message.method === "notifications/initialized") {
          return { response: new Response(null, { status: 202 }) };
        }
        if (message.method === "tools/call") {
          return { response: new Response(null, { status: 404 }) };
        }
        return { response: new Response(null, { status: 202 }) };
      }
    });
    managers.add(manager);
    const lostConfig: any = (index?: any) : any => ({
      transport: "streamable-http",
      url: "http://127.0.0.1:9/mcp",
      timeoutMs: 1000,
      sessionKey: String(index),
      sessionScope: `svc:synthetic:exec:p-${index}:g-${index}`,
      sessionKind: "stateful",
      sessionGeneration: { serviceRevision: 1, credentialRevisions: [] }
    });

    await expect(manager.callTool(lostConfig(1), { name: "probe" })).rejects.toMatchObject({
      code: "UPSTREAM_MCP_STATEFUL_SESSION_LOST"
    });
    await expect(manager.callTool(lostConfig(1), { name: "probe" })).rejects.toMatchObject({
      code: "UPSTREAM_MCP_STATEFUL_SESSION_LOST"
    });
    for (let index = 2; index <= 6; index += 1) {
      await expect(manager.callTool(lostConfig(index), { name: "probe" })).rejects.toMatchObject({
        code: "UPSTREAM_MCP_SESSION_CAPACITY"
      });
    }
    expect(evidence.initializations).toBe(1);
    expect(manager.snapshot()).toMatchObject({
      maxSessions: 1,
      lostStatefulScopeCount: 1,
      trackedScopeCount: 1
    });

    await expect(manager.retireScope("svc:synthetic:exec:p-1:g-1", { remove: true })).resolves.toMatchObject({
      removed: true
    });
    await expect(manager.callTool(lostConfig(2), { name: "probe" })).rejects.toMatchObject({
      code: "UPSTREAM_MCP_STATEFUL_SESSION_LOST"
    });
    expect(evidence.initializations).toBe(2);
    expect(manager.snapshot()).toMatchObject({
      maxSessions: 1,
      lostStatefulScopeCount: 1,
      trackedScopeCount: 1
    });
  });

  it("still rebuilds an ephemeral HTTP session after a not-found", async () : Promise<any> => {
    const fixture: any = await createLifecycleHttpFixture();
    const manager: any = createUpstreamMcpSessionManager({
      fetchTransport: async (url?: any, init?: any) : Promise<any> => ({
        response: await fetch(url, init)
      })
    });
    managers.add(manager);
    const config: Record<string, any> = {
      transport: "streamable-http",
      url: fixture.url,
      timeoutMs: 1000,
      sessionKey: "ephemeral-http",
      sessionScope: "svc:lifecycle:discovery",
      sessionKind: "ephemeral"
    };
    await manager.callTool(config, { name: "echo" });
    const recovered: any = await manager.callTool(config, { name: "vanish" });
    expect(recovered.result.structuredContent.name).toBe("vanish");
    expect(fixture.evidence.initializations).toHaveLength(2);
    expect(fixture.evidence.calls.filter((call?: any) : any => call.name === "vanish")).toHaveLength(2);
  });

  it("keeps catalog refresh for an existing caller when execution sessions fill capacity", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-exec-capacity-"));
    const manager: any = createUpstreamMcpSessionManager({ maxSessions: 2 });
    managers.add(manager);
    const registry: any = createUpstreamGatewayRegistry({
      userDataPath: root,
      mcpSessionManager: manager
    });
    const raw: any = {
      serviceId: "synthetic",
      serviceProtocol: "mcp",
      mcp: {
        transport: "stdio",
        command: process.execPath,
        args: ["-e", statefulScript()],
        toolNamePrefix: "synthetic",
        toolsCacheTtlMs: 0,
        timeoutMs: 5000
      }
    };
    registry.replaceFromManifestSnapshot(Object.freeze({
      setRevision: 1,
      setDigest: fingerprint({ serviceId: "synthetic", revision: 1 }),
      serviceEntries: Object.freeze([Object.freeze(["synthetic", Object.freeze({
        ...normalizeService(raw, {}),
        manifestDigest: fingerprint({ ...raw, revision: 1 }),
        serviceRevision: 1,
        updatedAt: "revision-1"
      })])])
    }));
    const subject: any = (id?: any) : any => executionSubject({
      publicToolName: "upstream.synthetic.state.increment",
      subjectId: `synthetic-principal-${id}`,
      grantId: `synthetic-grant-${id}`,
      grant: { id: `synthetic-grant-${id}` }
    });
    try {
      const first: any = await registry.callMcpToolByPublicName("upstream.synthetic.state.increment", { arguments: {} }, subject(1));
      expect(first.response.structuredContent.value).toBe(1);
      const second: any = await registry.callMcpToolByPublicName("upstream.synthetic.state.increment", { arguments: {} }, subject(2));
      expect(second.response.structuredContent.value).toBe(1);
      const again: any = await registry.callMcpToolByPublicName("upstream.synthetic.state.increment", { arguments: {} }, subject(1));
      expect(again.response.structuredContent.value).toBe(2);
      await expect(registry.callMcpToolByPublicName("upstream.synthetic.state.increment", { arguments: {} }, subject(3)))
        .rejects.toMatchObject({
          status: 503,
          reasonCode: "upstream_mcp_call_failed"
        });
    } finally {
      await registry.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not retain scope metadata after unsuccessful initialization", async () : Promise<any> => {
    const evidence: Record<string, any> = { attempts: 0, retried: 0 };
    const manager: any = createUpstreamMcpSessionManager({
      maxSessions: 1,
      fetchTransport: async () : Promise<any> => {
        evidence.attempts += 1;
        return new Response(null, { status: 503 });
      }
    });
    managers.add(manager);
    const failedConfig: any = (index?: any) : any => ({
      transport: "streamable-http",
      url: "http://127.0.0.1:9/mcp",
      timeoutMs: 1000,
      sessionKey: String(index),
      sessionScope: `svc:synthetic:exec:p-${index}:g-${index}`,
      sessionKind: "stateful",
      sessionGeneration: { serviceRevision: 1, credentialRevisions: [] }
    });
    for (let index = 1; index <= 6; index += 1) {
      await expect(manager.callTool(failedConfig(index), { name: "probe" })).rejects.toMatchObject({
        code: "UPSTREAM_MCP_SESSION_FATAL"
      });
    }
    expect(evidence.attempts).toBe(6);
    expect(manager.snapshot()).toMatchObject({
      sessionCount: 0,
      creatingSessionCount: 0,
      trackedScopeCount: 0,
      lostStatefulScopeCount: 0
    });
    await expect(manager.callTool(failedConfig(1), { name: "probe" })).rejects.toMatchObject({
      code: "UPSTREAM_MCP_SESSION_FATAL"
    });
    evidence.retried = evidence.attempts - 6;
    expect(evidence.retried).toBe(1);
    expect(manager.snapshot()).toMatchObject({
      sessionCount: 0,
      creatingSessionCount: 0,
      trackedScopeCount: 0,
      lostStatefulScopeCount: 0
    });
  });

  it("does not retain scope metadata after a failed stateful admission", async () : Promise<any> => {
    const manager: any = createUpstreamMcpSessionManager({ maxSessions: 1 });
    managers.add(manager);
    const held: any = statefulConfig();
    await manager.callTool(held, { name: "state.increment" });
    expect(manager.snapshot().trackedScopeCount).toBe(1);
    for (let index = 0; index < 8; index += 1) {
      await expect(manager.callTool({
        ...held,
        sessionKey: `exec-rejected-${index}`,
        sessionScope: `svc:lifecycle:exec:subject-new-${index}:grant-new-${index}`
      }, { name: "state.probe" })).rejects.toMatchObject({
        code: "UPSTREAM_MCP_SESSION_CAPACITY"
      });
    }
    expect(manager.snapshot().trackedScopeCount).toBe(1);
  });

  it("releases execution sessions that match a grant or API-key principal without dropping discovery", async () : Promise<any> => {
    const manager: any = createUpstreamMcpSessionManager();
    managers.add(manager);
    const grantConfig: any = statefulConfig();
    const apiKeyConfig: any = statefulConfig({
      sessionKey: "exec-api-key",
      sessionScope: "svc:lifecycle:exec:workload-principal-1:api-key-row-1"
    });
    const otherConfig: any = statefulConfig({
      sessionKey: "exec-other-grant",
      sessionScope: "svc:lifecycle:exec:subject-2:grant-2"
    });
    const discovery: any = {
      ...statefulConfig(),
      sessionKey: "discovery-lifecycle",
      sessionScope: "svc:lifecycle:discovery",
      sessionKind: "ephemeral"
    };
    await manager.callTool(grantConfig, { name: "state.increment" });
    await manager.callTool(apiKeyConfig, { name: "state.increment" });
    await manager.callTool(otherConfig, { name: "state.increment" });
    await manager.listTools(discovery);

    await expect(manager.retireGrantScopes("grant-1", { remove: true })).resolves.toMatchObject({
      retired: 1,
      scopes: 1
    });
    await expect(manager.callTool(grantConfig, { name: "state.probe" })).resolves.toMatchObject({
      result: { structuredContent: { value: 0 } }
    });
    await expect(manager.retireGrantScopes("workload-principal-1", { remove: true })).resolves.toMatchObject({
      retired: 1,
      scopes: 1
    });
    const stillOther: any = await manager.callTool(otherConfig, { name: "state.probe" });
    expect(stillOther.result.structuredContent.value).toBe(1);
    const stillDiscovery: any = await manager.listTools(discovery);
    expect(stillDiscovery.tools).toHaveLength(2);
  });

  it("retires matching registry execution sessions on grant release", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-exec-grant-"));
    const manager: any = createUpstreamMcpSessionManager();
    managers.add(manager);
    const registry: any = createUpstreamGatewayRegistry({
      userDataPath: root,
      mcpSessionManager: manager
    });
    installLifecycleService(registry, 1);
    const subject: Record<string, any> = executionSubject({
      publicToolName: "upstream.lifecycle.state.increment"
    });
    try {
      const first: any = await registry.callMcpToolByPublicName(
        "upstream.lifecycle.state.increment",
        { arguments: {} },
        subject
      );
      expect(first.response.structuredContent.value).toBe(1);
      await expect(registry.retireMcpGrantScopes("grant-1", { remove: true })).resolves.toMatchObject({
        retired: 1
      });
      const afterRelease: any = await registry.callMcpToolByPublicName(
        "upstream.lifecycle.state.increment",
        { arguments: {} },
        subject
      );
      expect(afterRelease.response.structuredContent.value).toBe(1);
    } finally {
      await registry.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function listenLoopback(server?: any) : any {
  return new Promise((resolve?: any, reject?: any) : any => {
    const onError: any = (error?: any) : any => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening: any = () : any => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function readJsonBody(request?: any) : Promise<any> {
  let body: any = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function createLifecycleHttpFixture() : Promise<any> {
  const evidence: Record<string, any> = {
    initializations: [],
    calls: [],
    vanished: false
  };
  let nextSessionId: any = 1;
  const activeSessions: any = new Map<any, any>();
  const server: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
    if (request.method === "DELETE") {
      activeSessions.delete(String(request.headers["mcp-session-id"] || ""));
      response.writeHead(204);
      response.end();
      return;
    }
    const message: any = await readJsonBody(request);
    const sessionId: any = String(request.headers["mcp-session-id"] || "");
    if (message.method === "initialize") {
      const createdSessionId: any = `session-${nextSessionId++}`;
      activeSessions.set(createdSessionId, { state: 0 });
      evidence.initializations.push({ sessionId: createdSessionId });
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": createdSessionId
      });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "lifecycle-http", version: "1" }
        }
      }));
      return;
    }
    if (message.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    evidence.calls.push({ method: message.method, name: message.params?.name, sessionId });
    const session: any = activeSessions.get(sessionId);
    if (!session) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (message.method === "tools/list") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: "state.increment", inputSchema: { type: "object" } }] }
      }));
      return;
    }
    const name: any = message.params?.name;
    if (name === "vanish" && !evidence.vanished) {
      evidence.vanished = true;
      activeSessions.delete(sessionId);
      response.writeHead(404);
      response.end();
      return;
    }
    if (name === "state.increment") session.state += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        structuredContent: name === "state.increment" || name === "state.probe"
          ? { value: session.state }
          : { name }
      }
    }));
  });
  servers.add(server);
  await listenLoopback(server);
  const address: any = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    evidence
  };
}
