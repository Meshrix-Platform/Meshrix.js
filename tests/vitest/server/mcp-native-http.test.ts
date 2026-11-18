import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createOperationPermissionPlatform } from "../../../packages/capabilities/src/operation-permission-core/index.ts";
import { createToolSkillManagementProvider } from "../../../packages/capabilities/src/skills/tool-skill-management-provider.ts";
import { evaluateAuthorizationPolicy } from "../../../packages/foundation/src/security/authorization/authorization-engine.ts";
import { API_KEY_MANAGEMENT_ACTION } from "../../../packages/foundation/src/security/authorization/api-key-issuer-authority.ts";
import { createMemoryApiKeyVerifierKeyProvider } from "../../../packages/foundation/src/security/authorization/api-key-verifier-key-provider.ts";
import { createOperationProofSubstrate } from "../../../packages/foundation/src/proof/proof-substrate/index.ts";
import { OPERATION_REGISTRY_GOVERNED_DEFINITIONS } from "../../../packages/contracts/src/operations/operation-registry-governed-definitions.ts";
import { createPlatformMcpGateway } from "../../../packages/server-runtime/src/composition/gateway-composition.ts";
import { createHttpServerRequestHandler } from "../../../apps/server/runtime/http-server-routes.ts";
import { bindServerMcpNotificationBus } from "../../../packages/server-runtime/src/composition/mcp-notification-bus-binding.ts";
import { disconnectMcpSseConnectionsByGrant, getMcpSseConnectionState, resetMcpSseConnectionStateForTests } from "../../../packages/server-runtime/src/state/sse-connection-state.ts";
import { broadcastMcpToolListChanged, configureMcpNotificationBus } from "../../../packages/protocols/mcp/notifications.ts";
import { mcpModernHttpRequest } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-client-wire.ts";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  configureMcpNotificationBus();
  resetMcpSseConnectionStateForTests();
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
const noop = () => {};
const logger = { debug: noop, info: noop, warn: noop, error: noop };
const toolName = "meshrix.gateway.metrics";
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-native-http-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const roles = [{ roleId: "key-manager", name: "Key manager", scopeNodeId: "issuer", scopeNodeType: "organization", managementActions: [API_KEY_MANAGEMENT_ACTION] }];
  let issuerPresent = true;
  const securityPermissions = {
    getOrganizationGovernance: () => ({ configured: true, revision: 1, nodes: [{ nodeId: "root", nodeType: "group", parentId: "", name: "Root" }, ...(issuerPresent ? [{ nodeId: "issuer", nodeType: "organization", parentId: "root", name: "Issuer" }] : [])], roles }),
    getGovernanceSummary: () => ({ policyRevision: { revision: 1 }, roles: roles.map(role => ({ ...role, enabled: true })), userPolicies: [{ userId: "admin", enabled: true, roleIds: ["key-manager"] }], apiKeyRecoveryAssignments: [] }),
    getGovernancePolicyRevision: () => ({ revision: 1 }),
    evaluatePolicy: evaluateAuthorizationPolicy,
    verifyProcessIdentity: () => ({ ok: false })
  };
  const proof = createOperationProofSubstrate({ dataDir: path.join(root, "proof") });
  cleanup.push(() => proof.close());
  const dispatches: AbortSignal[] = [];
  let dispatch: (signal: AbortSignal) => Promise<void> = async () => {};
  const operationPermission = await createOperationPermissionPlatform({
    userDataPath: path.join(root, "permission"),
    operations: OPERATION_REGISTRY_GOVERNED_DEFINITIONS.filter((operation: any) => operation.id === "gateway.metrics"),
    controllers: {}, securityPermissions, proofSubstrate: proof, logger,
    apiKeyVerifierKeyProvider: createMemoryApiKeyVerifierKeyProvider(Buffer.alloc(32, 81)),
    operationDispatcher: async ({ signal, response }: any) => {
      dispatches.push(signal);
      await dispatch(signal);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ synthetic: "native-http-result" }));
    }
  });
  cleanup.push(() => operationPermission.close());
  const coreProvider = createToolSkillManagementProvider({ operationPermissionPlatform: operationPermission, securityPermissions });
  let catalogVisible = true;
  const provider = {
    ...coreProvider,
    listVisibleTools: (input: any) => coreProvider.listVisibleTools(input).filter((tool: any) => catalogVisible || tool.id !== toolName)
  };
  provider.configurePublicOrigin("http://meshrix.test");
  const platform = createPlatformMcpGateway({ toolSkillManagementProvider: provider, operationProofSubstrate: proof, runtimeLogger: logger });
  cleanup.push(() => platform.close());
  await platform.gateway.start();
  bindServerMcpNotificationBus();
  operationPermission.registerChangeHandler((event: any) => {
    if (["api_key_rotate", "api_key_revoke"].includes(event.reasonCode)) disconnectMcpSseConnectionsByGrant(event.grantId);
  });
  const handler = createHttpServerRequestHandler({
    activeApiOperations: [], consoleAuth: {}, controllers: {}, distPath: "", getDiscoveryState: () => ({}), getListenUrl: () => "http://meshrix.test", getOperationPermissionPlatform: () => operationPermission,
    lifecycle: { beginRequest: () => new AbortController(), endRequest: noop, markSocketActive: noop, markSocketIdle: noop, getInFlightCount: () => 0 },
    operationAuditStore: null, operationConcurrencyScope: "synthetic-native-http", proxyApiRequest: noop, rateLimits: { windowMs: 1000 }, runtimeLogger: logger, securityPermissions,
    subjectRateLimiter: { shouldAllow: () => ({ allowed: true }) }, tenantRateLimiter: { shouldAllow: () => ({ allowed: true }) }, ipRateLimiter: { shouldAllow: () => ({ allowed: true }) },
    toolSkillManagementProvider: provider, platformMcpGatewayAdapter: platform.adapter, upstreamGatewayRegistryForMcp: null
  });
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    platform.adapter.close();
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    expect(server.listening).toBe(false);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic server did not listen.");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  async function issue(extra: Record<string, any> = {}) {
    return operationPermission.apiKeyDistributionProvider.create({
      subjectId: "admin", workloadDisplayName: "Synthetic native MCP client", organizationNodeId: "issuer", expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      policy: {
        protocol: "mcp", serviceIds: [], capabilityIds: [], toolsetIds: operationPermission.catalog().tools.find((tool: any) => tool.id === toolName).toolsets, allowedTools: [toolName], deniedTools: [], scopeIds: ["gateway:read"], maximumRisk: "low",
        audience: { serverAudience: "meshrix.test", targetIds: [], connectorPackageIds: [] },
        resources: { mode: "unrestricted", workspaceIds: [], dataClassifications: [], egressClasses: [], semanticFamilies: [], capabilityDomains: [], capabilityVerbs: [], resourceKinds: [], effectKinds: [], secretBindingIds: [], allowedOrigins: [], allowedCidrs: [] }, processIdentity: { mode: "optional" },
        limits: { maxUses: 100, requestsPerWindow: 100, windowSeconds: 60, maxConcurrentEffects: 10 }, catalogFingerprint: operationPermission.catalog().fingerprint, ...extra
      }
    });
  }
  const key = await issue();
  function headers(credential: string, session = "", version = "2025-11-25") {
    return { "content-type": "application/json", accept: "application/json, text/event-stream", "X-Meshrix.js-Api-Key": credential, ...(session ? { "Mcp-Session-Id": session, "MCP-Protocol-Version": version } : {}) };
  }
  async function send(message: any, { credential = key.apiKey, session = "", version = "2025-11-25", signal }: { credential?: string; session?: string; version?: string; signal?: AbortSignal } = {}) {
    const response = await fetch(url, { method: "POST", headers: headers(credential, session, version), body: JSON.stringify(message), signal });
    const text = await response.text();
    return { status: response.status, session: response.headers.get("mcp-session-id"), body: text ? JSON.parse(text) : null };
  }
  async function initialize(credential = key.apiKey, version = "2025-11-25") {
    const init = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "synthetic-client", version: "1" } } }, { credential });
    expect(init.status).toBe(200);
    expect(init.session).toBeTruthy();
    const session = init.session!;
    const negotiated = init.body.result.protocolVersion;
    expect((await send({ jsonrpc: "2.0", method: "notifications/initialized" }, { credential, session, version: negotiated })).status).toBe(202);
    return { session, version: negotiated, credential };
  }
  const call = { jsonrpc: "2.0", id: "call", method: "tools/call", params: { name: toolName, arguments: {} } };
  return { key, issue, initialize, send, url, headers, platform, provider, operationPermission, dispatches, call, withdrawIssuer: () => { issuerPresent = false; }, setCatalogVisible: (visible: boolean) => { catalogVisible = visible; }, setDispatch: (next: typeof dispatch) => { dispatch = next; } };
}
async function eventReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const next = async (): Promise<any> => {
    while (true) {
      const end = pending.indexOf("\n\n");
      if (end >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const data = frame.split("\n").find(line => line.startsWith("data: "));
        if (data) return JSON.parse(data.slice(6));
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) return null;
      pending += decoder.decode(chunk.value, { stream: true });
    }
  };
  return { next, close: () => reader.cancel() };
}

describe("native MCP over the production HTTP route and authorization composition", () => {
  it("negotiates versions, initializes, lists and calls while preserving the modern path and security refusals", async () => {
    const f = await fixture();
    const session = await f.initialize();
    for (const version of ["2025-06-18", "2025-03-26", "unknown"]) expect((await f.initialize(f.key.apiKey, version)).version).toBe(version === "unknown" ? "2025-11-25" : version);
    const listed = await f.send({ jsonrpc: "2.0", id: 2, method: "tools/list" }, session);
    expect(listed.body.result.tools.map((tool: any) => tool.name)).toContain(toolName);
    expect(listed.body.result).not.toHaveProperty("resultType");
    const page = await f.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { limit: 1 } }, session);
    expect(page.body.result.tools).toHaveLength(1);
    expect(page.body.result.nextCursor).toBeTruthy();
    const next = await f.send({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { limit: 1, cursor: page.body.result.nextCursor } }, session);
    expect(next.body.result.tools[0].name).not.toBe(page.body.result.tools[0].name);
    expect(await f.send({ jsonrpc: "2.0", id: 5, method: "tools/list", params: { cursor: "invalid" } }, session)).toMatchObject({ status: 200, body: { error: { code: -32602 } } });
    const called = await f.send(f.call, session);
    expect(called.status).toBe(200);
    expect(called.body.result.structuredContent).toMatchObject({ synthetic: "native-http-result" });
    expect(f.dispatches).toHaveLength(1);
    const denied = await f.send({ ...f.call, id: "denied", params: { name: "not.authorized", arguments: {} } }, session);
    expect(denied).toMatchObject({ status: 200, body: { error: { code: -32003, data: { effectOutcome: "not_started" } } } });
    expect(f.dispatches).toHaveLength(1);
    expect(await f.send({ ...f.call, method: "not.a.method" }, session)).toMatchObject({ status: 200, body: { error: { code: -32601 } } });
    expect(await f.send(f.call, { ...session, version: "2025-06-18" })).toMatchObject({ status: 400 });
    const other = await f.issue();
    expect(await f.send(f.call, { ...session, credential: other.apiKey })).toMatchObject({ status: 404 });
    const wire = mcpModernHttpRequest({ jsonrpc: "2.0", id: "modern", method: "tools/list" }, { "X-Meshrix.js-Api-Key": f.key.apiKey });
    const modern = await fetch(f.url, { method: "POST", ...wire });
    expect((await modern.json()).result.resultType).toBe("complete");
    const malformedModern = await fetch(f.url, { method: "POST", headers: { ...wire.headers, "Mcp-Method": "tools/call" }, body: wire.body });
    expect((await malformedModern.json()).error.code).toBe(-32020);
    const bearer = await fetch(f.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${f.key.apiKey}`, "Mcp-Session-Id": session.session }, body: JSON.stringify(f.call) });
    expect(bearer.status).toBe(401); await bearer.body?.cancel();
    const required = await f.issue({ processIdentity: { mode: "required", allowedPublicKeyFingerprints: ["synthetic-fingerprint"] } });
    expect((await f.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } } }, { credential: required.apiKey })).status).toBe(403);
    const terminated = await fetch(f.url, { method: "DELETE", headers: f.headers(f.key.apiKey, session.session) });
    expect(terminated.status).toBe(200); await terminated.body?.cancel();
    expect((await f.send(f.call, session)).status).toBe(404);
  });

  it("cancels only the authenticated session request and propagates HTTP disconnect without replay", async () => {
    const f = await fixture();
    const first = await f.initialize(), second = await f.initialize();
    const entered = deferred();
    const stopped = deferred();
    const finish = deferred();
    f.setDispatch(async signal => { entered.resolve(); signal.addEventListener("abort", () => { stopped.resolve(); finish.resolve(); }, { once: true }); await finish.promise; });
    const active = f.send(f.call, first);
    cleanup.push(async () => { finish.resolve(); await active; });
    await Promise.race([entered.promise, active.then(result => { throw new Error(`Synthetic invocation did not enter dispatch: ${JSON.stringify(result.body)}`); })]);
    const cancellation = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: f.call.id } };
    expect((await f.send(cancellation, second)).status).toBe(202);
    expect(f.dispatches[0].aborted).toBe(false);
    const other = await f.issue();
    expect((await f.send(cancellation, { ...first, credential: other.apiKey })).status).toBe(404);
    expect((await f.send(f.call, first)).status).toBe(400);
    expect(f.dispatches).toHaveLength(1);
    expect((await f.send(cancellation, first)).status).toBe(202);
    await stopped.promise; await active;
    expect(f.dispatches[0].aborted).toBe(true);
    const nextEntered = deferred(), nextStopped = deferred();
    f.setDispatch(async signal => { nextEntered.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { nextStopped.resolve(); resolve(); }, { once: true })); });
    const controller = new AbortController();
    const disconnected = f.send({ ...f.call, id: "disconnect" }, { ...second, signal: controller.signal }).catch(() => null);
    await Promise.race([nextEntered.promise, disconnected.then(() => { throw new Error("Synthetic disconnect invocation did not enter dispatch."); })]);
    controller.abort(); await disconnected; await nextStopped.promise;
    expect(f.dispatches).toHaveLength(2);
  });

  it("delivers each scoped notification once and retires streams and sessions on credential revocation", async () => {
    const f = await fixture();
    const first = await f.initialize(), second = await f.initialize();
    const otherKey = await f.issue(), other = await f.initialize(otherKey.apiKey);
    const streams = [];
    for (const session of [first, second, other]) {
      const response = await fetch(f.url, { headers: { ...f.headers(session.credential, session.session), accept: "text/event-stream" } });
      expect(response.status).toBe(200);
      const stream = await eventReader(response); streams.push(stream); cleanup.push(() => stream.close().catch(noop));
    }
    const duplicate = await fetch(f.url, { headers: { ...f.headers(first.credential, first.session), accept: "text/event-stream" } });
    expect(duplicate.status).toBe(409); await duplicate.body?.cancel();
    expect(getMcpSseConnectionState().activeConnectionCount).toBe(3);
    const workload = f.key.record.workloadPrincipalId;
    broadcastMcpToolListChanged({ grantId: workload, sourceRevision: 1, catalogRevision: "catalog-1", audienceRevision: 1 });
    for (const stream of streams.slice(0, 2)) expect((await stream.next()).params.change.sourceRevision).toBe(1);
    broadcastMcpToolListChanged({ grantId: workload, sourceRevision: 2, catalogRevision: "catalog-2", audienceRevision: 2 });
    for (const stream of streams.slice(0, 2)) expect((await stream.next()).params.change.sourceRevision).toBe(2);
    broadcastMcpToolListChanged({ grantId: otherKey.record.workloadPrincipalId, sourceRevision: 3, catalogRevision: "catalog-3", audienceRevision: 3 });
    expect((await streams[2].next()).params.change.sourceRevision).toBe(3);
    expect(getMcpSseConnectionState().cohortRecordCount).toBe(0);
    await f.operationPermission.apiKeyDistributionProvider.revoke({ subjectId: "admin", keyId: f.key.record.keyId, expectedLifecycleRevision: f.key.record.lifecycleRevision, reasonCode: "administrator_request" });
    for (const stream of streams.slice(0, 2)) expect(await stream.next().catch(() => null)).toBeNull();
    expect(getMcpSseConnectionState().activeConnectionCount).toBe(1);
    expect((await f.send(f.call, first)).status).toBe(404);
    expect((await f.send({ jsonrpc: "2.0", id: 9, method: "tools/list" }, other)).status).toBe(200);
  });

  it("keeps the session and active work when a catalog change alters its visible routes", async () => {
    const f = await fixture();
    const session = await f.initialize();
    const response = await fetch(f.url, { headers: { ...f.headers(session.credential, session.session), accept: "text/event-stream" } });
    expect(response.status).toBe(200);
    const stream = await eventReader(response);
    cleanup.push(() => stream.close().catch(noop));
    const entered = deferred(), finish = deferred();
    f.setDispatch(async () => { entered.resolve(); await finish.promise; });
    const active = f.send(f.call, session);
    cleanup.push(async () => { finish.resolve(); await active; });
    await entered.promise;
    for (const [visible, revision] of [[false, 1], [true, 2]] as const) {
      f.setCatalogVisible(visible);
      broadcastMcpToolListChanged({ grantId: f.key.record.workloadPrincipalId, sourceRevision: revision, catalogRevision: `catalog-${revision}`, audienceRevision: revision });
      expect(await stream.next()).toMatchObject({ method: "notifications/tools/list_changed", params: { change: { sourceRevision: revision } } });
      const listed = await f.send({ jsonrpc: "2.0", id: `list-${revision}`, method: "tools/list" }, session);
      expect(listed.status).toBe(200);
      expect(listed.body.result.tools.some((tool: any) => tool.name === toolName)).toBe(visible);
      expect(f.dispatches[0].aborted).toBe(false);
    }
    finish.resolve();
    expect((await active).status).toBe(200);
    expect(f.dispatches).toHaveLength(1);
  });

  it("rechecks authority on delivery and closes the session when organization authority disappears", async () => {
    const f = await fixture();
    const session = await f.initialize();
    const response = await fetch(f.url, { headers: { ...f.headers(session.credential, session.session), accept: "text/event-stream" } });
    expect(response.status).toBe(200);
    const stream = await eventReader(response);
    cleanup.push(() => stream.close().catch(noop));
    f.withdrawIssuer();
    broadcastMcpToolListChanged({ grantId: f.key.record.workloadPrincipalId, sourceRevision: 1, catalogRevision: "catalog-1", audienceRevision: 1 });
    expect(await stream.next().catch(() => null)).toBeNull();
    expect(getMcpSseConnectionState().activeConnectionCount).toBe(0);
    expect((await f.send(f.call, session)).status).toBe(404);
  });

  it("connects an unmodified SDK HTTP client, returns tool errors, cancels work and closes its native session", async () => {
    const f = await fixture();
    // Use normal dependency exports in the consumer process. Repository source
    // conditions must not make Node strip dependency TypeScript in node_modules.
    const source = `
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const input = await new Promise(resolve => process.once('message', resolve));
const client = new Client({name:'synthetic-sdk-client',version:'1'},{capabilities:{}});
const transport = new StreamableHTTPClientTransport(new URL(input.url), {requestInit:{headers:{'X-Meshrix.js-Api-Key':input.key}}});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const called = await client.callTool({name:input.tool,arguments:{}});
  let denied;
  try { await client.callTool({name:'not.authorized',arguments:{}}); } catch(error) { denied=error.code; }
  process.send({phase:'ready'});
  await new Promise(resolve => process.once('message', resolve));
  const controller = new AbortController();
  process.once('message', () => controller.abort());
  let cancelled = false;
  try { await client.callTool({name:input.tool,arguments:{}}, undefined, {signal:controller.signal}); } catch { cancelled = controller.signal.aborted; }
  await new Promise(resolve => process.once('message', resolve));
  process.send({listed:tools.tools.some(tool=>tool.name===input.tool),called:called.structuredContent?.synthetic,denied,cancelled});
} finally { await transport.terminateSession(); await client.close(); process.disconnect(); }
`;
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
    const ready = once(child, "message");
    const exited = once(child, "exit");
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    });
    child.send({ url: f.url, key: f.key.apiKey, tool: toolName });
    await Promise.race([ready, exited.then(([code]) => { throw new Error(`SDK consumer exited before readiness (${code}): ${errors}`); })]);
    const entered = deferred(), stopped = deferred();
    f.setDispatch(async signal => {
      entered.resolve();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { stopped.resolve(); resolve(); }, { once: true }));
    });
    const result = once(child, "message");
    child.send("start");
    await entered.promise;
    child.send("cancel");
    await stopped.promise;
    child.send("settled");
    const [code] = await exited;
    expect(code, errors).toBe(0);
    expect((await result)[0]).toEqual({ listed: true, called: "native-http-result", denied: -32003, cancelled: true });
    expect(f.dispatches).toHaveLength(2);
    expect(getMcpSseConnectionState().activeConnectionCount).toBe(0);
  });
});
