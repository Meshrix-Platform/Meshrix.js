import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createOperationPermissionPlatform } from "../../../../packages/capabilities/src/operation-permission-core/index.ts";
import { createToolSkillManagementProvider } from "../../../../packages/capabilities/src/skills/tool-skill-management-provider.ts";
import { API_KEY_MANAGEMENT_ACTION } from "../../../../packages/foundation/src/security/authorization/api-key-issuer-authority.ts";
import { createMemoryApiKeyVerifierKeyProvider } from "../../../../packages/foundation/src/security/authorization/api-key-verifier-key-provider.ts";
import { createAuthorizationEngine } from "../../../../packages/foundation/src/security/authorization/authorization-engine.ts";
import { createSecurityPermissionsProvider } from "../../../../packages/foundation/src/security/security-permissions-provider.ts";
import { createOperationProofSubstrate } from "../../../../packages/foundation/src/proof/proof-substrate/index.ts";
import { createSystemControllerFoundationHandlers } from "../../../../packages/protocols/http/controllers/system-controller-foundation-handlers.ts";
import { SERVER_API_OPERATIONS } from "../../../../packages/contracts/src/operations/operation-registry.ts";
import { createUpstreamGatewayRegistry, compileUpstreamOperationProjection } from "../../../../packages/agents/src/upstream-gateway/index.ts";
import { executeConsoleDomainOperation } from "../../../../packages/server-runtime/src/composition/console-domain/operation-executor.ts";
import { dispatchOperation } from "../../../../packages/server-runtime/src/composition/dispatch-operation.ts";
import { createPlatformMcpGateway } from "../../../../packages/server-runtime/src/composition/gateway-composition.ts";
import { installUpstreamRuntimeServices, structuredUpstreamServiceFixture } from "../../../helpers/upstream-runtime-snapshot.ts";
import { modernHttpRequest } from "../support.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";

type RouteKind = "platform-operation" | "discovered-mcp";
type Deferred = { promise: Promise<void>; resolve(): void };
type Gate = {
  entered: Promise<void>;
  arrive(): void;
  release: Deferred;
  disconnected: Promise<void>;
  sawDisconnect(): void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function issuerSecurityPermissions(): Record<string, any> {
  const policyProvider = createSecurityPermissionsProvider({ authorizationEngine: createAuthorizationEngine() });
  const roles = [{
    roleId: "key-manager",
    name: "Key manager",
    scopeNodeId: "issuer",
    scopeNodeType: "organization",
    managementActions: [API_KEY_MANAGEMENT_ACTION],
  }];
  const nodes = [
    { nodeId: "root", nodeType: "group", parentId: "", name: "Root" },
    { nodeId: "issuer", nodeType: "organization", parentId: "root", name: "Issuer" },
  ];
  return {
    evaluatePolicy: policyProvider.evaluatePolicy,
    getOrganizationGovernance: () => ({ configured: true, revision: 1, nodes, roles }),
    getGovernanceSummary: () => ({
      policyRevision: { revision: 1, updatedAt: "2026-09-28T00:00:00.000Z" },
      roles: roles.map((role) => ({ ...role, enabled: true })),
      userPolicies: [{ userId: "issuer-admin", enabled: true, roleIds: ["key-manager"] }],
      apiKeyRecoveryAssignments: [],
    }),
    getGovernancePolicyRevision: () => ({ revision: 1 }),
    authorizeOperation: async () => ({
      ok: true,
      status: 200,
      session: { sessionId: "issuer-console-session", user: { userId: "issuer-admin", roleId: "key-manager", scopes: ["console:read"] } },
    }),
    verifyProcessIdentity: (evidence: unknown) => evidence,
  };
}

function emptyResources() {
  return {
    mode: "restricted",
    workspaceIds: [],
    dataClassifications: [],
    egressClasses: [],
    semanticFamilies: [],
    capabilityDomains: [],
    capabilityVerbs: [],
    resourceKinds: [],
    effectKinds: [],
    secretBindingIds: [],
    allowedOrigins: [],
    allowedCidrs: [],
  };
}

function responseCode(result: any): string {
  const pending = [result];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const code = current.code;
    if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,96}$/u.test(code)) return code;
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === "object") pending.push(value);
    }
  }
  return "";
}

function outcomeCategory(result: any): string {
  const fields: string[] = [];
  const pending = [{ value: result, path: "root", depth: 0 }];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop()!;
    if (!current.value || typeof current.value !== "object" || current.depth > 8 || seen.has(current.value)) continue;
    seen.add(current.value);
    for (const key of ["status", "statusCode", "code", "reasonCode", "errorCode", "resultType", "isError", "ok"]) {
      if (!Object.hasOwn(current.value, key)) continue;
      const value = current.value[key];
      if (typeof value === "number" && Number.isFinite(value)) fields.push(`${current.path}.${key}=${value}`);
      else if (typeof value === "boolean") fields.push(`${current.path}.${key}=${value}`);
      else if (typeof value === "string") {
        const category = /^[A-Za-z0-9_.-]{1,96}$/u.test(value) ? value : "present";
        fields.push(`${current.path}.${key}=${category}`);
      }
    }
    for (const [key, value] of Object.entries(current.value)) {
      if (Array.isArray(value)) {
        value.forEach((item, index) => pending.push({ value: item, path: `${current.path}.${key}[${index}]`, depth: current.depth + 1 }));
      } else if (value && typeof value === "object") {
        pending.push({ value, path: `${current.path}.${key}`, depth: current.depth + 1 });
      }
    }
  }
  return fields.length ? fields.join(",") : "no_public_outcome_fields";
}

function successfulResponse(result: any): boolean {
  const body = result?.response?.body ?? result?.body ?? {};
  return !result?.error && !body?.error && !body?.result?.error &&
    (result?.response?.status ?? result?.status ?? 200) < 400 &&
    body?.result?.isError !== true && body?.result?.resultType !== "failed";
}

async function waitForPeerArrival(gate: Gate, call: Promise<any>): Promise<void> {
  const first = await Promise.race([
    gate.entered.then(() => ({ kind: "peer" as const })),
    call.then((result) => ({ kind: "settled" as const, result })),
  ]);
  if (first.kind === "peer") return;
  gate.release.resolve();
  const code = responseCode(first.result);
  const status = first.result?.response?.status ?? first.result?.status;
  throw new Error(`Invocation settled before its upstream effect (${code || (status ? `http_${status}` : "returned_without_effect")}; ${outcomeCategory(first.result)}).`);
}

async function createFixture() {
  let nowMs = Date.parse("2026-09-28T08:00:00.000Z");
  let callId = 0;
  const attempts: Array<{ route: RouteKind; name: string; value: string }> = [];
  const effects: Array<{ route: RouteKind; name: string; value: string }> = [];
  const held = new Map<RouteKind, Gate>();
  const allGates = new Set<Gate>();
  const failNext = new Set<RouteKind>();
  let tempRoot: string | null = null;
  let registry: any = null;
  let proof: any = null;
  let operationPermission: Record<string, any> | null = null;
  let platform: any = null;
  let operationPermissionClosed = false;

  function releaseAll(): void {
    for (const gate of allGates) gate.release.resolve();
    allGates.clear();
    held.clear();
  }

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/mcp") {
      let wire: any;
      try { wire = JSON.parse(bodyText); } catch {
        response.writeHead(400).end();
        return;
      }
      if (wire.method === "server/discover") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result: { resultType: "complete", supportedVersions: ["2026-07-28"] } }));
        return;
      }
      if (wire.method === "tools/list") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result: {
          resultType: "complete",
          tools: ["write_selected", "write_sibling"].map((name) => ({
            name,
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          })),
        } }));
        return;
      }
      if (wire.method !== "tools/call") {
        response.writeHead(404).end();
        return;
      }
      const name = String(wire.params?.name || "");
      const value = String(wire.params?.arguments?.value || "");
      const attempt = { route: "discovered-mcp" as const, name, value };
      attempts.push(attempt);
      const gate = held.get(attempt.route);
      if (gate) {
        held.delete(attempt.route);
        response.once("close", () => { if (!response.writableEnded) gate.sawDisconnect(); });
        gate.arrive();
        await gate.release.promise;
        if (response.destroyed) return;
      }
      if (failNext.delete(attempt.route)) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, error: { code: -32000, message: "controlled upstream failure" } }));
        return;
      }
      effects.push(attempt);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result: {
        resultType: "complete",
        content: [{ type: "text", text: value }],
        structuredContent: { accepted: true, value },
      } }));
      return;
    }

    const route = pathname === "/configured/write-selected" || pathname === "/configured/write-sibling"
      ? "platform-operation" as const
      : null;
    if (request.method !== "POST" || !route) {
      response.writeHead(404).end();
      return;
    }
    let payload: any = {};
    try { payload = bodyText ? JSON.parse(bodyText) : {}; } catch {
      response.writeHead(400).end();
      return;
    }
    const attempt = {
      route,
      name: pathname.endsWith("write-sibling") ? "write_sibling" : "write_selected",
      value: String(payload?.value || ""),
    };
    attempts.push(attempt);
    const gate = held.get(route);
    if (gate) {
      held.delete(route);
      response.once("close", () => { if (!response.writableEnded) gate.sawDisconnect(); });
      gate.arrive();
      await gate.release.promise;
      if (response.destroyed) return;
    }
    if (failNext.delete(route)) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "controlled upstream failure" }));
      return;
    }
    effects.push(attempt);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true, value: attempt.value }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    releaseAll();
    const errors: unknown[] = [];
    const close = async (action: (() => Promise<unknown>) | null) => {
      if (!action) return;
      try { await action(); } catch (error) { errors.push(error); }
    };
    await close(platform ? () => platform.close() : null);
    if (!operationPermissionClosed) await close(operationPermission ? () => operationPermission!.close() : null);
    await close(registry ? () => registry.close() : null);
    await close(proof ? () => proof.close() : null);
    if (server.listening) {
      await close(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    }
    if (tempRoot) await close(() => fs.rm(tempRoot!, { recursive: true, force: true }));
    if (errors.length) throw new AggregateError(errors, "Controlled API-key fixture cleanup failed.");
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Controlled API-key peer did not bind.");

  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-api-key-reservation-"));
  registry = createUpstreamGatewayRegistry({ schemaPort: createGatewaySchemaPort(), schemaPort: createGatewaySchemaPort() });
  const peerUrl = `http://127.0.0.1:${address.port}`;
  installUpstreamRuntimeServices(registry, [
    structuredUpstreamServiceFixture({
      serviceId: "configured-store",
      serviceProtocol: "http",
      label: "Configured store",
      baseUrl: peerUrl,
      allowLocalNetwork: true,
      operations: ["write_selected", "write_sibling"].map((operationKey) => ({
        operationKey,
        protocol: "http",
        method: "POST",
        path: `/configured/${operationKey.replaceAll("_", "-")}`,
        risk: "safe_write",
        requiredScopes: ["gateway:write"],
        requestSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      })),
    }),
    {
      serviceId: "inventory-write",
      serviceProtocol: "mcp",
      label: "Inventory write",
      allowLocalNetwork: true,
      // The portable MCP descriptor deliberately omits operations; publication supplies
      // the default tools/call authority while each discovered tool keeps its own capability.
      mcp: { transport: "http", url: `${peerUrl}/mcp`, protocolVersion: "2026-07-28" },
    },
  ]);
  const listed = await registry.listMcpTools({ serviceId: "inventory-write", refresh: true });
  const selectedMcpTool = listed.items.find((tool: Record<string, any>) => tool.name.endsWith(".write_selected"));
  const siblingMcpTool = listed.items.find((tool: Record<string, any>) => tool.name.endsWith(".write_sibling"));
  if (!selectedMcpTool || !siblingMcpTool) throw new Error("Controlled MCP peer did not publish both fixture tools.");
  const projection = compileUpstreamOperationProjection(registry.captureManifestSnapshotState());
  const selectedHttpOperation = projection.operations.find((operation: Record<string, any>) =>
    operation._meta?.serviceId === "configured-store" && operation._meta?.operationKey === "write_selected");
  const siblingHttpOperation = projection.operations.find((operation: Record<string, any>) =>
    operation._meta?.serviceId === "configured-store" && operation._meta?.operationKey === "write_sibling");
  const mcpBaseOperation = projection.operations.find((operation: Record<string, any>) =>
    operation._meta?.serviceId === "inventory-write" && operation._meta?.operationKey === "tools/call");
  if (!selectedHttpOperation || !siblingHttpOperation || !mcpBaseOperation) {
    throw new Error("Fixture projection omitted a selected or base operation.");
  }

  proof = createOperationProofSubstrate({ dataDir: path.join(tempRoot!, "proof") });
  const securityPermissions = issuerSecurityPermissions();
  let toolProvider: Record<string, any> | null = null;
  const controllerHandlers = createSystemControllerFoundationHandlers({
    accessControlContext: (authSession: unknown, extra: Record<string, any> = {}) => ({ authSession, ...extra }),
    authorizationFacadeContext: (authSession: unknown, extra: Record<string, any> = {}) => ({ authSession, ...extra }),
    agentWorkspace: {},
    getToolSkillManagementProvider: () => toolProvider,
    getStrategyManagementProvider: () => null,
    protocolPayload: (body: unknown) => JSON.parse(Buffer.from(body as any || Buffer.alloc(0)).toString("utf8") || "{}"),
    runtime: {},
    workspaceIdFrom: () => "",
    sendConsoleDomainOperation: async ({ operationId, input, context, response }: Record<string, any>) => {
      const result = await executeConsoleDomainOperation({
        operationId,
        input,
        context: { ...context, upstreamGatewayRegistry: registry, operationProofSubstrate: proof },
      });
      response.writeHead(result.status || 200, { "content-type": "application/json" });
      response.end(JSON.stringify(result.payload));
    },
  });
  operationPermission = await createOperationPermissionPlatform({
    userDataPath: path.join(tempRoot!, "operation-permission"),
    operations: [...SERVER_API_OPERATIONS, ...projection.operations],
    operationDispatcher: (input: Record<string, any>) => dispatchOperation(input),
    controllers: { system: controllerHandlers },
    securityPermissions,
    proofSubstrate: proof,
    apiKeyVerifierKeyProvider: createMemoryApiKeyVerifierKeyProvider(Buffer.alloc(32, 73)),
    apiKeyClock: () => nowMs,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  toolProvider = createToolSkillManagementProvider({
    operationPermissionPlatform: operationPermission,
    securityPermissions,
    evaluateToolAudience: ({ authorization, grant, restriction, subject, tool, purpose }: Record<string, any>) => {
      if (tool?._meta?.upstreamMcp === true) {
        return registry.evaluateDiscoveredMcpToolAudience({ grant, restriction, subject, tool, purpose });
      }
      return registry.evaluateProjectedOperationAudience({
        grant,
        restriction,
        subject,
        tool: { ...tool, upstreamProjectedOperation: true },
        purpose,
      });
    },
  });
  platform = createPlatformMcpGateway({
    upstreamGatewayRegistry: registry,
    toolSkillManagementProvider: toolProvider,
    operationProofSubstrate: proof,
    runtimeLogger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await platform.gateway.start();

  const keyIds = new Map<string, string>();
  const keyRecords = new Map<string, Record<string, any>>();
  async function createKey(name: string, maxUses: number, lifetimeMs = 24 * 60 * 60 * 1000): Promise<string> {
    const created = await operationPermission!.apiKeyDistributionProvider.create({
      subjectId: "issuer-admin",
      workloadDisplayName: name,
      organizationNodeId: "issuer",
      expiresAt: new Date(nowMs + lifetimeMs).toISOString(),
      policy: {
        protocol: "mcp",
        serviceIds: [],
        capabilityIds: [selectedMcpTool._meta.dynamicCapability.capabilityId],
        toolsetIds: [],
        allowedTools: [selectedHttpOperation.toolId, mcpBaseOperation.toolId],
        deniedTools: [],
        scopeIds: ["gateway:write"],
        maximumRisk: "medium",
        audience: { serverAudience: "meshrix.test", targetIds: [], connectorPackageIds: [] },
        resources: emptyResources(),
        processIdentity: { mode: "optional" },
        limits: { maxUses, requestsPerWindow: 100, windowSeconds: 3600, maxConcurrentEffects: 1 },
        catalogFingerprint: operationPermission!.registry.getCatalog().fingerprint,
      },
    });
    keyIds.set(name, created.record.keyId);
    keyRecords.set(name, created.record);
    return created.apiKey;
  }

  async function request(credential: string, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const wireRequest = modernHttpRequest(method, `reservation-${++callId}`, params, {}, {
      host: "meshrix.test",
      "X-Meshrix.js-Api-Key": credential,
    });
    const headers = Object.fromEntries(Object.entries(wireRequest.headers).map(([name, header]) => [name.toLowerCase(), header]));
    try {
      const response = await platform.adapter.handle({
        ...wireRequest,
        headers,
        rawRequest: { method: "POST", headers, url: "/mcp" },
        requestBody: Buffer.from(JSON.stringify(wireRequest.body), "utf8"),
        url: new URL("http://meshrix.test/mcp"),
        ...(signal ? { signal } : {}),
      });
      return { response };
    } catch (error) {
      return { error };
    }
  }

  async function call(credential: string, kind: RouteKind, value = "payload", signal?: AbortSignal, selected = true): Promise<any> {
    const toolName = kind === "platform-operation"
      ? selected ? selectedHttpOperation.toolId : siblingHttpOperation.toolId
      : selected ? selectedMcpTool.name : siblingMcpTool.name;
    return request(credential, "tools/call", { name: toolName, arguments: { value } }, signal);
  }

  async function useCount(name: string): Promise<number> {
    const page = await operationPermission!.apiKeyDistributionProvider.list({ subjectId: "issuer-admin", limit: 20 });
    return Number(page.items.find((record: Record<string, any>) => record.keyId === keyIds.get(name))?.useCount || 0);
  }

  function holdNext(kind: RouteKind): Gate {
    const entered = deferred();
    const release = deferred();
    const disconnected = deferred();
    const gate: Gate = {
      entered: entered.promise,
      arrive: () => entered.resolve(),
      release,
      disconnected: disconnected.promise,
      sawDisconnect: () => disconnected.resolve(),
    };
    held.set(kind, gate);
    allGates.add(gate);
    return gate;
  }

  return {
    attempts,
    effects,
    selectedMcpTool,
    siblingMcpTool,
    selectedHttpOperation,
    siblingHttpOperation,
    nowMs: () => nowMs,
    advance: (milliseconds: number) => { nowMs += milliseconds; },
    failNext: (kind: RouteKind) => { failNext.add(kind); },
    holdNext,
    waitForPeerArrival,
    call,
    listTools: (credential: string) => request(credential, "tools/list", {}),
    createKey,
    useCount,
    revokeKey: async (name: string) => {
      const record = keyRecords.get(name);
      if (!record) throw new Error("Scoped API key fixture is missing.");
      return operationPermission!.apiKeyDistributionProvider.revoke({
        subjectId: "issuer-admin",
        keyId: record.keyId,
        expectedLifecycleRevision: record.lifecycleRevision,
        reasonCode: "fixture_revocation",
      });
    },
    closeOperationPermission: async () => {
      await operationPermission!.close();
      operationPermissionClosed = true;
    },
  };
}

describe.each([
  ["platform-operation", "configured Operation Permission route"],
  ["discovered-mcp", "direct discovered upstream MCP route"],
] as const)("API-key reservation through %s (%s)", (kind) => {
  it("holds exactly one quota reservation beyond five minutes and releases every settled attempt", async () => {
    const fixture = await createFixture();
    const keyName = `long-lived-${kind}`;
    const credential = await fixture.createKey(keyName, 5);
    const listing = await fixture.listTools(credential);
    const listedNames = ((listing.response?.body as any)?.result?.tools || []).map((tool: Record<string, any>) => tool.name);
    expect(listedNames).toContain(fixture.selectedHttpOperation.toolId);

    const unselected = await fixture.call(credential, kind, "denied-before-send", undefined, false);
    expect(successfulResponse(unselected)).toBe(false);
    expect(fixture.attempts).toEqual([]);
    expect(await fixture.useCount(keyName)).toBe(0);

    const firstGate = fixture.holdNext(kind);
    const firstCall = fixture.call(credential, kind, "held-first");
    await fixture.waitForPeerArrival(firstGate, firstCall);
    expect(fixture.attempts).toHaveLength(1);
    expect(await fixture.useCount(keyName)).toBe(1);

    fixture.advance(6 * 60 * 1000);
    const concurrent = await fixture.call(credential, kind, "concurrent-denial");
    expect(successfulResponse(concurrent)).toBe(false);
    expect(responseCode(concurrent), outcomeCategory(concurrent)).toBe("api_key_concurrency_limit_reached");
    expect(fixture.attempts).toHaveLength(1);
    expect(await fixture.useCount(keyName)).toBe(1);

    firstGate.release.resolve();
    expect(successfulResponse(await firstCall)).toBe(true);
    expect(await fixture.useCount(keyName)).toBe(1);

    expect(successfulResponse(await fixture.call(credential, kind, "after-completion"))).toBe(true);
    expect(await fixture.useCount(keyName)).toBe(2);

    fixture.failNext(kind);
    await fixture.call(credential, kind, "controlled-failure");
    expect(fixture.attempts).toHaveLength(3);
    expect(fixture.effects).toHaveLength(2);
    expect(await fixture.useCount(keyName)).toBe(3);

    expect(successfulResponse(await fixture.call(credential, kind, "after-failure"))).toBe(true);
    expect(await fixture.useCount(keyName)).toBe(4);
    expect(successfulResponse(await fixture.call(credential, kind, "last-permitted-use"))).toBe(true);
    expect(await fixture.useCount(keyName)).toBe(5);

    const exhausted = await fixture.call(credential, kind, "beyond-last-use");
    expect(successfulResponse(exhausted)).toBe(false);
    expect(responseCode(exhausted)).toBe("api_key_use_limit_reached");
    expect(fixture.attempts).toHaveLength(5);
    expect(await fixture.useCount(keyName)).toBe(5);
  }, 20_000);

  it("releases a caller-cancelled call and cancels/drains its active call on platform close", async () => {
    const fixture = await createFixture();
    const keyName = `cancellation-${kind}`;
    const credential = await fixture.createKey(keyName, 4);

    const controller = new AbortController();
    const cancelledGate = fixture.holdNext(kind);
    const cancelledCall = fixture.call(credential, kind, "cancelled", controller.signal);
    await fixture.waitForPeerArrival(cancelledGate, cancelledCall);
    controller.abort(new Error("test caller cancellation"));
    await cancelledGate.disconnected;
    cancelledGate.release.resolve();
    await cancelledCall;
    expect(await fixture.useCount(keyName)).toBe(1);

    expect(successfulResponse(await fixture.call(credential, kind, "after-cancellation"))).toBe(true);
    expect(await fixture.useCount(keyName)).toBe(2);

    const closeGate = fixture.holdNext(kind);
    const closingCall = fixture.call(credential, kind, "closed-in-flight");
    await fixture.waitForPeerArrival(closeGate, closingCall);
    expect(await fixture.useCount(keyName)).toBe(3);
    const closing = fixture.closeOperationPermission();
    await closeGate.disconnected;
    closeGate.release.resolve();
    await Promise.all([closingCall, closing]);

    const afterClose = await fixture.call(credential, kind, "after-close");
    expect(successfulResponse(afterClose)).toBe(false);
    expect(fixture.attempts).toHaveLength(3);
  }, 20_000);

  it("rejects expired and revoked scoped keys before either upstream effect", async () => {
    const fixture = await createFixture();
    const expiringName = `expiring-${kind}`;
    const expiringCredential = await fixture.createKey(expiringName, 2, 60_000);
    const revokedName = `revoked-${kind}`;
    const revokedCredential = await fixture.createKey(revokedName, 2);

    await fixture.revokeKey(revokedName);

    fixture.advance(60_001);
    const expired = await fixture.call(expiringCredential, kind, "expired");
    const revoked = await fixture.call(revokedCredential, kind, "revoked");
    expect(successfulResponse(expired)).toBe(false);
    expect(successfulResponse(revoked)).toBe(false);
    expect(responseCode(expired)).toBe("api_key_inactive");
    expect(responseCode(revoked)).toBe("api_key_inactive");
    expect(fixture.attempts).toEqual([]);
    expect(fixture.effects).toEqual([]);
    expect(await fixture.useCount(expiringName)).toBe(0);
    expect(await fixture.useCount(revokedName)).toBe(0);
  }, 20_000);
});
