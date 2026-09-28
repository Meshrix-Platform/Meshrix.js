import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createToolCatalogRegistry } from "../../../packages/capabilities/src/operation-permission-core/catalog.ts";
import { createApiKeyDistributionProvider } from "../../../packages/capabilities/src/operation-permission-core/api-key-distribution.ts";
import { createOperationPermissionStore } from "../../../packages/capabilities/src/operation-permission-core/store.ts";
import { createMemoryApiKeyVerifierKeyProvider } from "../../../packages/foundation/src/security/authorization/api-key-verifier-key-provider.ts";
import { createToolExecutionRuntime } from "../../../packages/capabilities/src/operation-permission-core/runtime.ts";
import { createOperationProofSubstrate } from "../../../packages/foundation/src/proof/proof-substrate/index.ts";
import { MemoryLockManager } from "@meshrix/foundation/concurrency/lock-manager";
import { createSystemControllerFoundationHandlers } from "../../../packages/protocols/http/controllers/system-controller-foundation-handlers.ts";
import { executeConsoleDomainOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executor.ts";
import { dispatchOperation } from "../../../packages/server-runtime/src/composition/dispatch-operation.ts";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { compileUpstreamOperationProjection } from "../../../packages/agents/src/upstream-gateway/operation-projection.ts";
import { normalizeService } from "../../../packages/agents/src/upstream-gateway/support.ts";
import { createUpstreamMcpSessionManager } from "../../../packages/protocols/mcp/upstream-mcp-gateway-transport.ts";
import {
  installUpstreamRuntimeServices,
  structuredJsonPayloadTransport
} from "../../helpers/upstream-runtime-snapshot.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const cleanups: Array<() => Promise<void>> = [];
const releases: Array<() => void> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const release of releases.splice(0)) release();
  while (cleanups.length) await cleanups.pop()!();
});

async function listen(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic upstream did not bind.");
  return `http://127.0.0.1:${address.port}`;
}

function legacyStdioPeer() {
  const messages: Array<Record<string, any>> = [];
  const callArrived = deferred<Record<string, any>>();
  const child: any = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let inputBuffer = "";
  let exited = false;

  const emitExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
    child.stdout.end();
    child.stderr.end();
  };

  child.kill = (signal: NodeJS.Signals = "SIGTERM") => {
    emitExit(null, signal);
    return true;
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      inputBuffer += String(chunk);
      const lines = inputBuffer.split(/\r?\n/u);
      inputBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        messages.push(message);
        if (message.method === "tools/call") callArrived.resolve(message);
        if (message.method === "initialize") {
          child.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "admitted-lifetime-peer", version: "1" }
            }
          })}\n`);
        } else if (message.method === "tools/list") {
          child.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] }
          })}\n`);
        }
      }
      callback();
    },
    final(callback) {
      callback();
      queueMicrotask(() => emitExit(0, null));
    }
  });
  return { child, messages, callArrived: callArrived.promise };
}

async function createDispatchPorts(registry: ReturnType<typeof createUpstreamGatewayRegistry>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-admitted-lifetime-proof-"));
  cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));
  const proof = createOperationProofSubstrate({ dataDir: path.join(root, "proof") });
  cleanups.push(async () => proof.close());
  const lockManager = new MemoryLockManager({ defaultTtlMs: 60_000, maxWaitMs: 60_000 });
  cleanups.push(async () => lockManager.destroy());
  const ownerMarkers: boolean[] = [];
  const system = createSystemControllerFoundationHandlers({
    accessControlContext: (authSession: any, extra: Record<string, any> = {}) => ({ authSession, ...extra }),
    authorizationFacadeContext: (authSession: any, extra: Record<string, any> = {}) => ({ authSession, ...extra }),
    agentWorkspace: {},
    protocolPayload: (body: any) => {
      const value = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
      return value ? JSON.parse(value) : {};
    },
    runtime: {},
    workspaceIdFrom: () => "",
    sendConsoleDomainOperation: async ({ operationId, input, context, response }: Record<string, any>) => {
      ownerMarkers.push(context.operationBudgetOwned === true);
      const operationResult = await executeConsoleDomainOperation({
        operationId,
        input,
        context: { ...context, upstreamGatewayRegistry: registry, operationProofSubstrate: proof }
      });
      response.writeHead(operationResult.status || 200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(operationResult.payload ?? operationResult));
    }
  });
  const dispatch = (input: Record<string, any>) => dispatchOperation({
    ...input,
    controllers: { system },
    operationProofSubstrate: proof,
    lockManager
  });
  return { dispatch, lockManager, ownerMarkers, proof, system };
}

async function createHarness(
  registry: ReturnType<typeof createUpstreamGatewayRegistry>,
  snapshot: any,
  discoveredCapabilities: any[] = [],
  operationKey = "",
  apiKeyDistributionProvider: any = null
) {
  const projection = compileUpstreamOperationProjection(snapshot);
  const operation = projection.operations.find((candidate: any) => candidate._meta?.operationKey === operationKey) || projection.operations[0];
  const catalogRegistry = createToolCatalogRegistry({ operations: projection.operations });
  const projectedCapabilities = projection.operations.map((candidate: any) => candidate._meta?.dynamicCapability || {});
  const capabilities = [
    ...projectedCapabilities.map((item: any) => item.capabilityId),
    ...discoveredCapabilities.map((item) => item?.capabilityId)
  ].filter(Boolean);
  const secretBindings = [
    ...projectedCapabilities.flatMap((item: any) => item.credentialBindingIds || []),
    ...discoveredCapabilities.flatMap((item) => item?.credentialBindingIds || [])
  ];
  const scopes = [...new Set([
    ...projectedCapabilities.flatMap((item: any) => item.requiredScopes || []),
    ...discoveredCapabilities.flatMap((item) => item?.requiredScopes || [])
  ])];
  const resourceContexts = [
    ...projectedCapabilities.map((item: any) => item.resourceContext || {}),
    ...discoveredCapabilities.map((item: any) => item?.resourceContext || {})
  ];
  const allowedValues = (...keys: string[]) => [...new Set(resourceContexts.flatMap((resource: any) => keys.flatMap((key) => {
    const value = resource?.[key];
    return Array.isArray(value) ? value : value ? [value] : [];
  })))];
  const grant = {
    id: "lifetime-subject",
    label: "Lifetime fixture",
    subjectId: "lifetime-subject",
    scopes,
    capabilities,
    dynamicCapabilities: capabilities,
    allowedSecretBindings: secretBindings,
    allowedServiceIds: allowedValues("serviceId", "serviceIds"),
    allowedEgress: allowedValues("requestedEgress", "requestedEgresses"),
    allowedCapabilityDomains: allowedValues("capabilityDomain", "capabilityDomains"),
    allowedCapabilityVerbs: allowedValues("capabilityVerb", "capabilityVerbs"),
    allowedResourceKinds: allowedValues("resourceKind", "resourceKinds"),
    allowedEffectKinds: allowedValues("effectKind", "effectKinds"),
    maxRisk: "safe_write",
    enabled: true,
    revokedAt: "",
    projectionFingerprint: "sha256:lifetime-fixture"
  };
  const store = {
    async authorizeRequest() {
      return {
        ok: true,
        grant,
        subject: {
          type: "tool-grant",
          subjectId: grant.subjectId,
          username: grant.label,
          scopes: grant.scopes,
          capabilities: grant.capabilities,
          allowedServiceIds: grant.allowedServiceIds,
          allowedEgress: grant.allowedEgress,
          allowedCapabilityDomains: grant.allowedCapabilityDomains,
          allowedCapabilityVerbs: grant.allowedCapabilityVerbs,
          allowedResourceKinds: grant.allowedResourceKinds,
          allowedEffectKinds: grant.allowedEffectKinds,
          dynamicCapabilities: grant.dynamicCapabilities,
          allowedSecretBindings: grant.allowedSecretBindings
        },
        sourceIp: "127.0.0.1"
      };
    },
    async authorizeGrantForExecution() {
      return {
        ok: true,
        grant,
        subject: {
          type: "tool-grant",
          subjectId: grant.subjectId,
          username: grant.label,
          scopes: grant.scopes,
          capabilities: grant.capabilities,
          allowedServiceIds: grant.allowedServiceIds,
          allowedEgress: grant.allowedEgress,
          allowedCapabilityDomains: grant.allowedCapabilityDomains,
          allowedCapabilityVerbs: grant.allowedCapabilityVerbs,
          allowedResourceKinds: grant.allowedResourceKinds,
          allowedEffectKinds: grant.allowedEffectKinds,
          dynamicCapabilities: grant.dynamicCapabilities,
          allowedSecretBindings: grant.allowedSecretBindings
        },
        sourceIp: "127.0.0.1"
      };
    },
    async appendExecution() {},
    async appendMetric() {},
    async appendPolicyDecision() {}
  };
  const policyEngine = {
    async evaluate() {
      return {
        effect: "allow",
        decisionId: "lifetime-policy",
        reasonCode: "",
        redactedReason: "",
        missingScopes: [],
        missingCapabilities: [],
        missingToolsets: [],
        grantPolicyRevision: 1,
        grantPolicyState: "active",
        governancePolicyRevision: {
          protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
          revision: 1,
          updatedAt: "2026-09-28T00:00:00.000Z"
        }
      };
    }
  };
  const dispatchPorts = await createDispatchPorts(registry);
  const resolvedApiKeyDistributionProvider = typeof apiKeyDistributionProvider === "function"
    ? await apiKeyDistributionProvider(catalogRegistry)
    : apiKeyDistributionProvider;
  const runtime = createToolExecutionRuntime({
    registry: catalogRegistry,
    store,
    policyEngine,
    securityPermissions: {
      appendDecision() {},
      getGovernanceApproval() { return null; },
      listGovernanceApprovals() { return []; }
    },
    operations: projection.operations,
    operationDispatcher: dispatchPorts.dispatch,
    controllers: { system: dispatchPorts.system },
    operationProofSubstrate: dispatchPorts.proof,
    ...(resolvedApiKeyDistributionProvider ? { apiKeyDistributionProvider: resolvedApiKeyDistributionProvider } : {}),
    protocolEventBus: { async publish() {} },
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  });
  return {
    projection,
    catalogRegistry,
    runtime,
    operation,
    tool: catalogRegistry.getTool(operation.toolId),
    dispatchPorts,
    catalogRegistry,
    apiKeyDistributionProvider: resolvedApiKeyDistributionProvider
  };
}

function apiKeyGovernancePermissions() {
  const roles = [{
    roleId: "key-manager",
    name: "Key manager",
    scopeNodeId: "issuer",
    scopeNodeType: "organization",
    managementActions: ["operation_permission.api_keys.manage"]
  }];
  return {
    getOrganizationGovernance: () => ({
      configured: true,
      revision: 1,
      nodes: [
        { nodeId: "root", nodeType: "group", parentId: "", name: "Root" },
        { nodeId: "issuer", nodeType: "organization", parentId: "root", name: "Issuer" },
        { nodeId: "child", nodeType: "department", parentId: "issuer", name: "Child" }
      ],
      roles
    }),
    getGovernanceSummary: () => ({
      policyRevision: { revision: 1, updatedAt: "2026-09-28T00:00:00.000Z" },
      roles: roles.map((role) => ({ ...role, enabled: true })),
      userPolicies: [{ userId: "admin", enabled: true, roleIds: ["key-manager"] }],
      apiKeyRecoveryAssignments: []
    }),
    getGovernancePolicyRevision: () => ({ revision: 1 }),
    verifyProcessIdentity: (evidence: unknown) => evidence
  };
}

function registryWithTestSink(manager: any = null) {
  const registry = createUpstreamGatewayRegistry({
    ...(manager ? { mcpSessionManager: manager } : {})
  });
  cleanups.push(async () => registry.close());
  return registry;
}

function mcpService(url: string, timeoutMs?: number, transport = "http") {
  return {
    serviceId: `lifetime-${transport}`,
    serviceProtocol: "mcp",
    label: "Lifetime MCP fixture",
    allowLocalNetwork: true,
    mcp: {
      transport,
      ...(transport === "stdio" ? { command: "admitted-lifetime-fixture" } : { url, protocolVersion: "2026-07-28" }),
      toolsCacheTtlMs: 60_000,
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    }
  };
}

function mcpReply(response: http.ServerResponse, id: string | number, result: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function dispatchResponse() {
  return {
    chunks: [] as Buffer[],
    headers: {} as Record<string, string>,
    statusCode: 0,
    writeHead(statusCode: number, headers: Record<string, string> = {}) {
      this.statusCode = statusCode;
      Object.assign(this.headers, headers);
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    write(chunk: unknown) {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return true;
    },
    end(chunk?: unknown) {
      this.write(chunk);
      return this;
    }
  };
}

function directFinalSinkAuthorization() {
  return {
    ok: true,
    session: {
      sessionId: "admitted-lifetime-direct-session",
      user: {
        userId: "admitted-lifetime-direct-subject",
        subjectId: "admitted-lifetime-direct-subject",
        username: "Lifetime direct caller",
        roleId: "owner",
        scopes: ["gateway:write"]
      }
    },
    grant: { id: "admitted-lifetime-direct-grant", revision: "1" },
    authorizationDecision: { allowed: true, decisionId: "admitted-lifetime-direct-decision", reasonCode: "fixture_allow", riskRevision: "1" },
    governancePolicyRevision: { revision: 1 },
    protectedSinkAuthority: {
      subject: {
        generation: "1",
        subjectId: "admitted-lifetime-direct-subject",
        tenantId: "admitted-lifetime-direct-tenant",
        type: "console-user"
      },
      context: {
        approvalRevision: "1",
        grantRevision: "1",
        policyRevision: "1",
        riskRevision: "1",
        workloadGeneration: "1"
      }
    }
  };
}

describe("admitted upstream execution lifetime", () => {
  it("uses one real API Key reservation across a last-use medium-risk MCP call and final-sink revalidation", async () => {
    const callGate = deferred();
    const callArrived = deferred<Record<string, any>>();
    releases.push(() => callGate.resolve());
    const baseUrl = await listen(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (wire.method === "server/discover") {
        mcpReply(response, wire.id, { resultType: "complete", supportedVersions: ["2026-07-28"] });
        return;
      }
      if (wire.method === "tools/list") {
        mcpReply(response, wire.id, { resultType: "complete", tools: [{ name: "lookup", inputSchema: { type: "object" } }] });
        return;
      }
      if (wire.method !== "tools/call") {
        response.writeHead(404).end();
        return;
      }
      callArrived.resolve(wire);
      await callGate.promise;
      if (response.destroyed) return;
      mcpReply(response, wire.id, {
        resultType: "complete",
        content: [{ type: "text", text: "last-use completed" }]
      });
    });
    const service = mcpService(`${baseUrl}/mcp`);
    const registry = registryWithTestSink();
    await installUpstreamRuntimeServices(registry, [service]);
    const snapshot = registry.captureManifestSnapshotState();
    const discovered = await registry.listMcpTools({ serviceId: service.serviceId });
    const dynamicCapability = discovered.items[0]._meta.dynamicCapability;
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-api-key-mcp-runtime-"));
    cleanups.push(async () => fs.rm(dataRoot, { recursive: true, force: true }));
    let apiKeyStore: any = null;
    let apiKeyProvider: any = null;
    const fixture = await createHarness(
      registry,
      snapshot,
      [dynamicCapability],
      "",
      (catalogRegistry) => {
        apiKeyStore = createOperationPermissionStore({
          userDataPath: dataRoot,
          registry: catalogRegistry,
          securityPermissions: apiKeyGovernancePermissions(),
          capabilityBindingGuard: false,
          apiKeyVerifierKeyProvider: createMemoryApiKeyVerifierKeyProvider(Buffer.alloc(32, 83))
        });
        apiKeyProvider = createApiKeyDistributionProvider({ store: apiKeyStore });
        return apiKeyProvider;
      }
    );
    cleanups.push(() => apiKeyStore.close());
    const resource = dynamicCapability.resourceContext;
    const created = await apiKeyProvider.create({
      subjectId: "admin",
      workloadDisplayName: "MCP runtime lifetime fixture",
      organizationNodeId: "child",
      expiresAt: "2099-01-01T00:00:00.000Z",
      policy: {
        protocol: "mcp",
        serviceIds: [service.serviceId],
        capabilityIds: [dynamicCapability.capabilityId],
        toolsetIds: ["meshrix.gateway.write"],
        allowedTools: [fixture.tool.id],
        deniedTools: [],
        scopeIds: ["gateway:write"],
        maximumRisk: "medium",
        audience: {
          serverAudience: "https://meshrix.invalid",
          targetIds: ["server"],
          connectorPackageIds: []
        },
        resources: {
          mode: "restricted",
          workspaceIds: [],
          dataClassifications: [],
          egressClasses: [resource.requestedEgress],
          semanticFamilies: [],
          capabilityDomains: [resource.capabilityDomain],
          capabilityVerbs: [resource.capabilityVerb],
          resourceKinds: [resource.resourceKind],
          effectKinds: [],
          secretBindingIds: [...resource.secretBindingIds],
          allowedOrigins: [],
          allowedCidrs: []
        },
        processIdentity: { mode: "optional" },
        limits: { maxUses: 1, requestsPerWindow: 10, windowSeconds: 60, maxConcurrentEffects: 1 },
        catalogFingerprint: fixture.catalogRegistry.getCatalog().fingerprint
      }
    });
    const authorization = await apiKeyProvider.authenticateRuntime({
      credential: created.apiKey,
      serverAudience: "https://meshrix.invalid",
      targetId: "server",
      connectorPackageId: null,
      processIdentityEvidence: null
    });
    expect(authorization.policy.maximumRisk).toBe("medium");
    expect(dynamicCapability.risk).toBe("safe_write");

    const execution = fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { toolName: "lookup", arguments: { query: "last-use" } },
      context: { dynamicCapability },
      apiKeyAuthorization: authorization,
      request: { __meshrixRequestId: "api-key-mcp-last-use", headers: {}, socket: { remoteAddress: "127.0.0.1" } }
    });
    const admission = await Promise.race([
      callArrived.promise.then((wire) => ({ type: "call", wire })),
      execution.then(
        (value: any) => ({ type: "settled", category: value?.ok === false ? `status-${value.status}` : "completed" }),
        () => ({ type: "rejected" })
      )
    ]);
    expect(admission.type, JSON.stringify(admission)).toBe("call");
    expect((admission as any).wire).toMatchObject({
      method: "tools/call",
      params: { name: "lookup", arguments: { query: "last-use" } }
    });
    callGate.resolve();
    await expect(execution).resolves.toMatchObject({ ok: true, status: 200 });
    await expect(apiKeyProvider.list({ subjectId: "admin", limit: 10 }))
      .resolves.toMatchObject({ items: [expect.objectContaining({ keyId: created.record.keyId, useCount: 1 })] });
    await expect(apiKeyProvider.authenticateRuntime({
      credential: created.apiKey,
      serverAudience: "https://meshrix.invalid",
      targetId: "server",
      connectorPackageId: null,
      processIdentityEvidence: null
    })).rejects.toMatchObject({ code: "api_key_use_limit_reached" });
  });

  it("keeps a normalized modern MCP executeTool call alive beyond every retired implicit cutoff", async () => {
    const callGate = deferred();
    const callArrived = deferred<Record<string, any>>();
    const responseClosed = deferred<boolean>();
    releases.push(() => callGate.resolve());
    const requests: Array<Record<string, any>> = [];
    const baseUrl = await listen(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(wire);
      if (wire.method === "server/discover") {
        mcpReply(response, wire.id, {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          serverInfo: { name: "admitted-lifetime-peer", version: "1" }
        });
        return;
      }
      if (wire.method === "tools/list") {
        mcpReply(response, wire.id, {
          resultType: "complete",
          tools: [{ name: "lookup", inputSchema: { type: "object", properties: { value: { type: "string" } } } }]
        });
        return;
      }
      if (wire.method !== "tools/call") {
        response.writeHead(404).end();
        return;
      }
      response.once("close", () => responseClosed.resolve(!response.writableEnded));
      callArrived.resolve(wire);
      await callGate.promise;
      if (response.destroyed) return;
      mcpReply(response, wire.id, {
        resultType: "complete",
        content: [{ type: "text", text: "completed after virtual time" }],
        structuredContent: { value: wire.params.arguments.value }
      });
    });
    const raw = mcpService(`${baseUrl}/mcp`);
    const normalizedForReload = normalizeService(raw);
    const reloaded = normalizeService(raw, normalizedForReload);
    expect(Object.hasOwn(normalizedForReload.mcp, "timeoutMs")).toBe(false);
    expect(Object.hasOwn(reloaded.mcp, "timeoutMs")).toBe(false);

    const registry = registryWithTestSink();
    await installUpstreamRuntimeServices(registry, [raw]);
    const installedSnapshot = registry.captureManifestSnapshotState();
    expect(Object.hasOwn(installedSnapshot.serviceEntries[0][1].mcp, "timeoutMs")).toBe(false);
    const discovered = await registry.listMcpTools({ serviceId: raw.serviceId });
    const discoveredCapability = discovered.items[0]._meta.dynamicCapability;
    const { runtime, tool, projection, dispatchPorts } = await createHarness(registry, installedSnapshot, [discoveredCapability]);
    expect(tool.timeoutMs).toBeNull();
    expect(projection.operations[0].execution.timeoutMs).toBeNull();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let settled = false;
    const execution = runtime.executeTool({
      toolId: tool.id,
      input: { toolName: "lookup", arguments: { value: "virtual-clock" } },
      context: { dynamicCapability: discoveredCapability },
      request: { __meshrixRequestId: "admitted-lifetime", headers: {}, socket: { remoteAddress: "127.0.0.1" } }
    }).then((value: any) => {
      settled = true;
      return value;
    });

    const enteredCall = await Promise.race([
      callArrived.promise.then((wire) => ({ type: "call", wire })),
      execution.then((value) => ({ type: "settled", value }))
    ]);
    expect(enteredCall.type, JSON.stringify(enteredCall)).toBe("call");
    const wire = (enteredCall as any).wire;
    await vi.advanceTimersByTimeAsync(300_001);
    expect(settled).toBe(false);
    expect(wire.method).toBe("tools/call");
    expect(requests.map((item) => item.method)).toEqual([
      "server/discover",
      "tools/list",
      "server/discover",
      "tools/call"
    ]);

    callGate.resolve();
    await expect(execution).resolves.toMatchObject({
      ok: true,
      status: 200,
      payload: {
        result: expect.objectContaining({
          ok: true,
          response: expect.objectContaining({
            resultType: "complete",
            structuredContent: { value: "virtual-clock" }
          })
        })
      }
    });
    expect(dispatchPorts.ownerMarkers).toEqual([true]);
    await expect(responseClosed.promise).resolves.toBe(false);
  });

  it("keeps projected structured HTTP and JSON-RPC executeTool calls alive without an implicit deadline", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const arrivals = new Map<string, ReturnType<typeof deferred<Record<string, any>>>>();
    const requests: Array<Record<string, any>> = [];
    for (const route of ["/records", "/rpc"]) {
      gates.set(route, deferred());
      arrivals.set(route, deferred());
      releases.push(() => gates.get(route)?.resolve());
    }
    const baseUrl = await listen(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(request.url || "/", "http://fixture.invalid");
      const route = url.pathname;
      const wire = route === "/rpc" ? JSON.parse(body) : { query: Object.fromEntries(url.searchParams) };
      requests.push({ method: request.method, route, wire });
      arrivals.get(route)?.resolve({ method: request.method, route, wire });
      await gates.get(route)?.promise;
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(route === "/rpc"
        ? { jsonrpc: "2.0", id: wire.id, result: { itemId: wire.params.itemId, found: true } }
        : { itemId: wire.query.itemId, found: true }));
    });
    const service = {
      serviceId: "lifetime-projected-http",
      serviceProtocol: "http",
      label: "Projected HTTP and JSON-RPC fixture",
      baseUrl,
      allowLocalNetwork: true,
      operations: [
        {
          operationKey: "records.read",
          protocol: "http",
          method: "GET",
          path: "/records",
          risk: "read_only",
          requiredScopes: ["gateway:read"],
          requestSchema: {
            type: "object",
            additionalProperties: false,
            required: ["itemId"],
            properties: { itemId: { type: "string" } }
          },
          payloadTransport: structuredJsonPayloadTransport()
        },
        {
          operationKey: "inventory.lookup",
          protocol: "json-rpc",
          method: "POST",
          path: "/rpc",
          jsonRpcMethod: "inventory.lookup",
          risk: "read_only",
          requiredScopes: ["gateway:read"],
          requestSchema: {
            type: "object",
            additionalProperties: false,
            required: ["itemId"],
            properties: { itemId: { type: "string" } }
          },
          payloadTransport: structuredJsonPayloadTransport()
        }
      ]
    };
    const registry = registryWithTestSink();
    await installUpstreamRuntimeServices(registry, [service]);
    const snapshot = registry.captureManifestSnapshotState();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    for (const operationKey of ["records.read", "inventory.lookup"]) {
      const { runtime, tool, operation } = await createHarness(registry, snapshot, [], operationKey);
      expect(tool.timeoutMs).toBeNull();
      expect(operation.execution.timeoutMs).toBeNull();
      let settled = false;
      const execution = runtime.executeTool({
        toolId: tool.id,
        input: { itemId: `held-${operationKey}` },
        context: { dynamicCapability: operation._meta.dynamicCapability },
        request: { __meshrixRequestId: `admitted-${operationKey}`, headers: {}, socket: { remoteAddress: "127.0.0.1" } }
      }).then((value: any) => {
        settled = true;
        return value;
      });
      const request = await Promise.race([
        arrivals.get(operationKey === "records.read" ? "/records" : "/rpc")!.promise.then((value) => ({ type: "request", value })),
        execution.then((value) => ({ type: "settled", value }))
      ]);
      expect(request.type, JSON.stringify(request)).toBe("request");
      const route = operationKey === "records.read" ? "/records" : "/rpc";
      await vi.advanceTimersByTimeAsync(300_001);
      expect(settled).toBe(false);
      expect(requests.find((item) => item.route === route)?.wire).toMatchObject(
        operationKey === "records.read"
          ? { query: { itemId: `held-${operationKey}` } }
          : { method: "inventory.lookup", params: { itemId: `held-${operationKey}` } }
      );
      gates.get(route)!.resolve();
      await expect(execution).resolves.toMatchObject({ ok: true, status: 200 });
    }
    expect(requests.map((item) => item.route)).toEqual(["/records", "/rpc"]);
  });

  it("keeps the generated MCP service budget for an ordinary dispatched caller that has only a signal", async () => {
    const callArrived = deferred<Record<string, any>>();
    const responseClosed = deferred<boolean>();
    const baseUrl = await listen(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (wire.method === "server/discover") {
        mcpReply(response, wire.id, { resultType: "complete", supportedVersions: ["2026-07-28"] });
      } else if (wire.method === "tools/list") {
        mcpReply(response, wire.id, { resultType: "complete", tools: [{ name: "lookup", inputSchema: { type: "object" } }] });
      } else {
        response.once("close", () => responseClosed.resolve(!response.writableEnded));
        callArrived.resolve(wire);
      }
    });
    const service = mcpService(`${baseUrl}/mcp`, 60_000);
    const registry = registryWithTestSink();
    await installUpstreamRuntimeServices(registry, [service]);
    const snapshot = registry.captureManifestSnapshotState();
    const operation = compileUpstreamOperationProjection(snapshot).operations[0];
    expect(operation.execution.timeoutMs).toBe(60_000);
    expect(operation.safety.risk).toBe("safe_write");
    await registry.listMcpTools({ serviceId: service.serviceId });
    const dispatchPorts = await createDispatchPorts(registry);
    const controller = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const input = { toolName: "lookup", arguments: { value: "direct-explicit" }, operationBudgetOwned: true };
    const response = dispatchResponse();
    const authorization = directFinalSinkAuthorization();
    let settled = false;
    const dispatch = dispatchPorts.dispatch({
      operation,
      request: {
        method: operation.http.method,
        url: operation.http.path,
        headers: { host: "meshrix.test" },
        socket: { remoteAddress: "127.0.0.1" }
      },
      response,
      requestBody: Buffer.from(JSON.stringify(input)),
      url: new URL(operation.http.path, "http://meshrix.test"),
      params: { operationBudgetOwned: true },
      input,
      transport: "http",
      method: operation.http.method,
      signal: controller.signal,
      authorizeOperation: async () => authorization,
      revalidateAuthorization: async () => authorization
    }).then((value: any) => {
      settled = true;
      return value;
    });
    await expect(callArrived.promise).resolves.toMatchObject({
      method: "tools/call",
      params: { name: "lookup", arguments: { value: "direct-explicit" } }
    });
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(responseClosed.promise).resolves.toBe(true);
    await expect(dispatch).resolves.toMatchObject({ ok: false, handled: true, statusCode: 504 });
    expect(settled).toBe(true);
    expect(response.statusCode).toBe(504);
    expect(controller.signal.aborted).toBe(false);
    expect(dispatchPorts.ownerMarkers).toEqual([false]);
  });

  it("applies an explicit MCP service budget through the modern adapter and waits for cancellation settlement", async () => {
    const callArrived = deferred<Record<string, any>>();
    const responseClosed = deferred<boolean>();
    const requests: Array<Record<string, any>> = [];
    const baseUrl = await listen(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(wire);
      if (wire.method === "server/discover") {
        mcpReply(response, wire.id, { resultType: "complete", supportedVersions: ["2026-07-28"] });
      } else if (wire.method === "tools/list") {
        mcpReply(response, wire.id, { resultType: "complete", tools: [{ name: "lookup", inputSchema: { type: "object" } }] });
      } else {
        response.once("close", () => responseClosed.resolve(!response.writableEnded));
        callArrived.resolve(wire);
      }
    });
    const raw = mcpService(`${baseUrl}/mcp`, 60_000);
    const registry = registryWithTestSink();
    const projectedForward = vi.spyOn(registry, "forwardProjectedOperation");
    await installUpstreamRuntimeServices(registry, [raw]);
    const snapshot = registry.captureManifestSnapshotState();
    const discovered = await registry.listMcpTools({ serviceId: raw.serviceId });
    const discoveredCapability = discovered.items[0]._meta.dynamicCapability;
    const { runtime, tool, projection, dispatchPorts } = await createHarness(registry, snapshot, [discoveredCapability]);
    expect(snapshot.serviceEntries[0][1].mcp.timeoutMs).toBe(60_000);
    expect(projection.operations[0].execution.timeoutMs).toBe(60_000);
    expect(tool.timeoutMs).toBe(60_000);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let settled = false;
    const execution = runtime.executeTool({
      toolId: tool.id,
      input: { toolName: "lookup", arguments: {} },
      context: { dynamicCapability: discoveredCapability },
      request: { __meshrixRequestId: "explicit-modern-budget", headers: {}, socket: { remoteAddress: "127.0.0.1" } }
    }).then((value: any) => {
      settled = true;
      return value;
    });
    const enteredCall = await Promise.race([
      callArrived.promise.then(() => "call"),
      execution.then(() => "settled")
    ]);
    expect(enteredCall).toBe("call");
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(responseClosed.promise).resolves.toBe(true);
    const result = await execution;
    expect(settled).toBe(true);
    expect(result).toMatchObject({ ok: false });
    expect(requests.filter((item) => item.method === "tools/call")).toHaveLength(1);
    expect(projectedForward).toHaveBeenCalledWith(
      projection.operations[0].id,
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ timeoutMs: null })
    );
    expect(dispatchPorts.ownerMarkers).toEqual([true]);
  });

  it("carries an explicit MCP budget through normalization, Operation Permission and the legacy stdio session", async () => {
    const peer = legacyStdioPeer();
    const manager = createUpstreamMcpSessionManager({
      stdioLauncher: { launch: () => peer.child },
      maxSessions: 2,
      maxConcurrentRequestsPerSession: 2
    });
    const registry = registryWithTestSink(manager);
    const raw = mcpService("", 60_000, "stdio");
    await installUpstreamRuntimeServices(registry, [raw]);
    const snapshot = registry.captureManifestSnapshotState();
    const discovered = await registry.listMcpTools({ serviceId: raw.serviceId });
    const discoveredCapability = discovered.items[0]._meta.dynamicCapability;
    const { runtime, tool, projection, dispatchPorts } = await createHarness(registry, snapshot, [discoveredCapability]);
    expect(snapshot.serviceEntries[0][1].mcp.timeoutMs).toBe(60_000);
    expect(projection.operations[0].execution.timeoutMs).toBe(60_000);
    expect(tool.timeoutMs).toBe(60_000);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const execution = runtime.executeTool({
      toolId: tool.id,
      input: { toolName: "lookup", arguments: {} },
      context: { dynamicCapability: discoveredCapability },
      request: { __meshrixRequestId: "explicit-legacy-budget", headers: {}, socket: { remoteAddress: "127.0.0.1" } }
    });
    const enteredCall = await Promise.race([
      peer.callArrived.then(() => "call"),
      execution.then(() => "settled")
    ]);
    expect(enteredCall).toBe("call");
    await vi.advanceTimersByTimeAsync(60_001);
    const result = await execution;
    expect(result).toMatchObject({ ok: false });
    expect(peer.messages.filter((message) => message.method === "tools/call")).toHaveLength(1);
    expect(peer.messages.filter((message) => message.method === "notifications/cancelled")).toHaveLength(1);
    expect(dispatchPorts.ownerMarkers).toEqual([true]);
  });
});
