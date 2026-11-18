import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import { createConsoleAuth } from "../../../packages/foundation/src/security/auth/console-auth.ts";
import { createSecurityPermissionsProvider } from "../../../packages/foundation/src/security/security-permissions-provider.ts";
import { createTagStoreAdapter } from "../../../packages/server-runtime/src/state/tags/tag-store.adapter.ts";
import { createQueueApplicationPort } from "../../../packages/server-runtime/src/composition/queue-application-port.ts";
import { createManagedEndpointService, managedActorFromSession } from "../../../packages/server-runtime/src/managed-endpoints/domain.ts";
import { openManagedEndpointStore } from "../../../packages/server-runtime/src/managed-endpoints/store.ts";
import { createManagedTaskAuthorityPort } from "../../../packages/server-runtime/src/managed-endpoints/authority.ts";
import { createManagedEndpointsController } from "../../../packages/protocols/http/controllers/managed-endpoints-controller.ts";
import { createSystemController } from "../../../packages/protocols/http/controllers/system-controller.ts";
import { dispatchOperation, dispatchRpcOperation, dispatchRegisteredHttpOperation } from "../../../packages/server-runtime/src/composition/dispatch-operation.ts";
import { createOperationRouteIndex } from "../../../packages/server-runtime/src/routing/operation-route-index.ts";
import { executeConsoleAuthOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/console-auth-executor.ts";
import { createCapturedResponse, parseCapturedResult } from "../../../packages/server-runtime/src/composition/dispatch-operation-captured-response.ts";
import { createOperationPermissionPlatform } from "../../../packages/capabilities/src/operation-permission-core/index.ts";
import { createToolSkillManagementProvider } from "../../../packages/capabilities/src/skills/tool-skill-management-provider.ts";
import { createPlatformMcpGateway } from "../../../packages/server-runtime/src/composition/gateway-composition.ts";
import { createOperationProofSubstrate } from "../../../packages/foundation/src/proof/proof-substrate/index.ts";
import { createMemoryApiKeyVerifierKeyProvider } from "../../../packages/foundation/src/security/authorization/api-key-verifier-key-provider.ts";
import { evaluateAuthorizationPolicy } from "../../../packages/foundation/src/security/authorization/authorization-engine.ts";
import { API_KEY_MANAGEMENT_ACTION } from "../../../packages/foundation/src/security/authorization/api-key-issuer-authority.ts";
import { MemoryLockManager } from "../../../packages/foundation/src/concurrency/lock-manager.ts";
import { assertManagedEndpoint } from "../../../packages/contracts/src/managed-endpoints.ts";
import { getOperationPermissionDatabasePath } from "../../../packages/capabilities/src/operation-permission-core/store.ts";
import { createRecordingSinkStore } from "../../../packages/foundation/src/recording/recording-sink-store.ts";

const operations = SERVER_API_OPERATIONS.filter((operation: any) => operation.id.startsWith("endpoints."));
const submitOperation = operations.find((operation: any) => operation.id === "endpoints.tasks.submit")!;
const diagnosticErrors: unknown[] = [];
const logger = { debug() {}, info() {}, warn() {}, error(_event: unknown, details: any) {
  if (details?.error) diagnosticErrors.push(details.error);
} };
const capability = {
  capabilityId: "fixture.echo", label: "Fixture echo", kind: "command",
  inputSchema: { type: "object", required: ["message"], properties: { message: { type: "string" } }, additionalProperties: false },
  revision: 1
};
const deviceCredential = `mdc_${randomBytes(12).toString("hex")}`;
const permissionMarker = `synthetic-permission-${randomBytes(12).toString("hex")}`;
const lease = (assignment: any) => ({
  taskId: assignment.taskId, leaseId: assignment.leaseId, leaseSeq: assignment.leaseSeq
});

async function withFixture(action: (fixture: any) => Promise<void>, { approvalRequired = false, failFirstEnqueue = false } = {}) {
  diagnosticErrors.length = 0;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-managed-authority-"));
  const closers: Array<() => any> = [];
  try {
    const tagManagementStore = createTagStoreAdapter({ userDataPath: directory });
    closers.unshift(() => tagManagementStore.close());
    const consoleAuth = createConsoleAuth({ userDataPath: directory, tagManagementStore });
    closers.unshift(() => consoleAuth.close());
    const consolePermissions = createSecurityPermissionsProvider({ consoleAuth });
    const initial = await consoleAuth.ensureInitialOwner();
    const login: any = await consoleAuth.login(
      { username: initial.username, password: initial.password },
      { headers: { host: "console.local" }, socket: { remoteAddress: "127.0.0.1" } }
    );
    const consoleRequest = {
      method: "POST", url: "/api/endpoints/tasks",
      headers: {
        host: "console.local", origin: "http://console.local",
        cookie: login.cookies.map((cookie: string) => cookie.split(";")[0]).join("; "),
        "x-meshrix-csrf": login.csrfToken
      },
      socket: { remoteAddress: "127.0.0.1" }
    };
    const roles = [{
      roleId: "key-manager", name: "Key manager", scopeNodeId: "issuer",
      scopeNodeType: "organization", managementActions: [API_KEY_MANAGEMENT_ACTION]
    }];
    const securityPermissions = {
      getOrganizationGovernance: () => ({
        configured: true, revision: 1, roles,
        nodes: [
          { nodeId: "root", nodeType: "group", parentId: "", name: "Root" },
          { nodeId: "issuer", nodeType: "organization", parentId: "root", name: "Issuer" }
        ]
      }),
      getGovernanceSummary: () => ({
        policyRevision: { revision: 1 }, roles: roles.map((role) => ({ ...role, enabled: true })),
        userPolicies: [{ userId: "fixture-admin", enabled: true, roleIds: ["key-manager"] }],
        apiKeyRecoveryAssignments: []
      }),
      getGovernancePolicyRevision: () => ({ revision: 1 }),
      evaluatePolicy: (input: any) => {
        const decision = evaluateAuthorizationPolicy(input);
        return approvalRequired && decision.effect === "allow" && input.tool?.operationId === "endpoints.tasks.submit"
          ? {
            ...decision, effect: "needsApproval", allowed: false,
            requiredApproval: {
              approvalLayers: ["user"], grantKinds: ["once"],
              userId: managedActorFromSession(login.session).subjectId
            }
          } : decision;
      },
      getGovernanceApproval: consolePermissions.getGovernanceApproval,
      upsertGovernanceApproval: consolePermissions.upsertGovernanceApproval,
      revokeGovernanceApproval: consolePermissions.revokeGovernanceApproval,
      verifyProcessIdentity: () => ({ ok: false })
    };
    const port = await createQueueApplicationPort({ userDataPath: directory });
    closers.unshift(() => port.close());
    const store = openManagedEndpointStore({ userDataPath: directory });
    closers.unshift(() => store.close());
    let platform: any;
    const authorityPort = createManagedTaskAuthorityPort({
      deferredConsoleAuthorityPort: consolePermissions.deferredProtectedSinkAuthorityPort,
      getOperationPermissionPlatform: () => platform,
      resolveOperation: (id) => operations.find((operation: any) => operation.id === id)
    });
    let enqueueFailed = false;
    const queuePort = failFirstEnqueue ? {
      async registerQueue(input: any) {
        const facet = await port.registerQueue(input);
        return {
          ...facet,
          async enqueue(input: any) {
            if (!enqueueFailed) { enqueueFailed = true; throw new Error("Synthetic approval enqueue interruption."); }
            return facet.enqueue(input);
          }
        };
      }
    } : port;
    const service = createManagedEndpointService({ store, queuePort, authorityPort, maxLeasedPerEndpoint: 1 });
    closers.unshift(() => service.close());
    const controller = createManagedEndpointsController({ managedEndpointService: service, actorFromSession: managedActorFromSession });
    const controllers: any = { managedEndpoints: controller };
    const proof = createOperationProofSubstrate({
      dataDir: path.join(directory, "proof"), evidencePolicy: "development",
      signerSecret: randomBytes(24).toString("hex").repeat(3)
    });
    const lockManager = new MemoryLockManager();
    closers.unshift(() => proof.close());
    platform = await createOperationPermissionPlatform({
      userDataPath: path.join(directory, "permissions"), operations, controllers,
      operationDispatcher: (input: any) => dispatchOperation({ ...input, lockManager }),
      securityPermissions, proofSubstrate: proof, logger,
      apiKeyVerifierKeyProvider: createMemoryApiKeyVerifierKeyProvider(randomBytes(32))
    });
    closers.unshift(() => platform.close());
    const provider = createToolSkillManagementProvider({ operationPermissionPlatform: platform, securityPermissions });
    provider.configurePublicOrigin("http://managed.invalid");
    controllers.system = createSystemController({
      userDataPath: directory, securityPermissions: consolePermissions,
      settingsPort: {
        loadSettings: () => ({}), saveSettings: () => ({}), normalizeSettings: (value: any) => value,
        getSettingsPath: () => path.join(directory, "synthetic-settings.json")
      },
      discoveryPort: { saveDiscoveryConfig: () => ({}) },
      consoleDomainServices: {
        executeConsoleDomainOperation: executeConsoleAuthOperation,
        uploadSessionStore: { resolveUploadSessionFiles() {}, deleteUploadSession() {} }
      },
      getToolSkillManagementProvider: () => provider,
      getOperationPermissionPlatform: () => platform
    });
    const actor = managedActorFromSession(login.session);
    async function enroll(owner = actor) {
      const created = await service.createEndpoint(owner, { label: "Synthetic authority device", allowedCapabilityIds: [capability.capabilityId] });
      await service.enroll({ enrollmentToken: created.enrollmentToken, deviceCredential, capabilities: [capability] });
      return {
        device: service.verifyWorker(deviceCredential),
        input: { requestId: "req-authority-fixture", endpointId: created.endpoint.endpointId, capabilityId: capability.capabilityId, input: { message: "synthetic" } }
      };
    }
    async function issue(maxUses = 20) {
      const catalog = platform.catalog();
      const tools = catalog.tools.filter((tool: any) => tool.operationId.startsWith("endpoints."));
      return platform.apiKeyDistributionProvider.create({
        subjectId: "fixture-admin", workloadDisplayName: "Synthetic managed caller", organizationNodeId: "issuer",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        policy: {
          protocol: "mcp", serviceIds: [], capabilityIds: [],
          toolsetIds: [...new Set(tools.flatMap((tool: any) => tool.toolsets))],
          allowedTools: tools.map((tool: any) => tool.id), deniedTools: [],
          scopeIds: ["endpoints:execute", "endpoints:read", "endpoints:manage", "endpoints:approve"], maximumRisk: "high",
          audience: { serverAudience: "managed.invalid", targetIds: [], connectorPackageIds: [] },
          resources: {
            mode: "unrestricted", workspaceIds: [], dataClassifications: [], egressClasses: [],
            semanticFamilies: [], capabilityDomains: [], capabilityVerbs: [], resourceKinds: [], effectKinds: [],
            secretBindingIds: [], allowedOrigins: [], allowedCidrs: []
          },
          processIdentity: { mode: "optional" },
          limits: { maxUses, requestsPerWindow: 100, windowSeconds: 60, maxConcurrentEffects: 1 },
          catalogFingerprint: catalog.fingerprint
        }
      });
    }
    await action({
      directory, consoleAuth, login, consoleRequest, actor, enroll, issue,
      port, store, service, authorityPort, controller, controllers, proof, lockManager, platform, provider, closers, securityPermissions
    });
  } finally {
    const errors: unknown[] = [];
    for (const close of closers) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    await fs.rm(directory, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "Managed authority fixture cleanup failed.");
  }
}

async function dispatchManagedHttp(f: any, operationId: string, input: any) {
  const operation: any = operations.find((entry: any) => entry.id === operationId)!;
  const body = { ...input };
  if (operationId === "endpoints.tasks.permission") body.confirm = true;
  let pathname = operation.http.path;
  if (pathname.includes(":taskId")) {
    pathname = pathname.replace(":taskId", encodeURIComponent(body.taskId));
    delete body.taskId;
  }
  const url = new URL(pathname, "http://managed.invalid");
  const response = createCapturedResponse();
  await dispatchRegisteredHttpOperation({
    operations, controllers: f.controllers, routeIndex: createOperationRouteIndex(operations),
    operationProofSubstrate: f.proof, lockManager: f.lockManager, logger, recordingSink: f.recording,
    operationAuditStore: f.operationAuditStore,
    request: {
      method: operation.http.method, url: pathname, socket: { remoteAddress: "127.0.0.1" },
      headers: operationId.startsWith("endpoints.worker.")
        ? { "x-meshrix-device-credential": deviceCredential }
        : f.consoleRequest.headers
    },
    response, method: operation.http.method, url, requestBody: Buffer.from(JSON.stringify(body))
  });
  return { status: response.statusCode, body: parseCapturedResult({ captured: response }) };
}

function trackAudit(f: any) {
  const records: any[] = [];
  f.operationAuditStore = {
    append: async (entry: any) => {
      const record = { ...entry, auditId: `audit_managed_replay_${records.length + 1}` };
      records.push(record);
      return record;
    }
  };
  return records;
}

function permissionRecording(f: any) {
  const selection = {
    obligation: "optional", sinkRef: "sink.managed.permission", fieldAllow: ["permissionId", "selectedOptionId"],
    fieldRedact: [], eventAllow: [], readerRoles: ["role.managed-reader"], configurerRoles: ["role.managed-admin"],
    retention: { maxAgeSeconds: 3600, maxRecords: 64, maxContentBytes: 65536, maxIndexBytes: 65536 },
    capacity: { maxBufferedRecords: 16, maxRecordBytes: 8192 }
  };
  const recording = createRecordingSinkStore({
    rootPath: path.join(f.directory, "recording"),
    sink: {
      schemaVersion: "v0.0.1:recording:lifecycle-1", kind: "recording-sink",
      sinkId: selection.sinkRef, custody: "enterprise_local", durable: true,
      budgets: { maxRecordBytes: 16384, maxContentBytes: 131072, maxIndexBytes: 262144, maxBufferedRecords: 128, maxPendingWrites: 16 }
    },
    policy: {
      schemaVersion: "v0.0.1:recording:policy-1", kind: "recording-policy", policyId: "pol.managed.permission",
      policyRevision: 1, issuedAt: "2026-10-10T00:00:00Z", issuerRole: "role.managed-admin",
      configurerRoles: ["role.managed-admin"], categories: {
        content: selection,
        execution_history: { ...selection, fieldAllow: [], retention: { ...selection.retention, maxContentBytes: 0 } }
      }
    }
  });
  f.closers.unshift(() => recording.close());
  f.recording = recording;
  return recording;
}

describe("managed endpoint durable authority and canonical dispatch", () => {
  it("roundtrips opaque permission identities through the actual HTTP dispatcher without secret recording", async () => {
    await withFixture(async (f) => {
      const recording = permissionRecording(f);
      const { input } = await f.enroll();
      expect((await dispatchManagedHttp(f, "endpoints.tasks.submit", input)).status).toBe(202);
      const claimed = await dispatchManagedHttp(f, "endpoints.worker.poll", { batchSize: 1 });
      expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
      const assignment = claimed.body.assignments[0];
      expect((await dispatchManagedHttp(f, "endpoints.worker.start", lease(assignment))).body.authorized).toBe(true);
      const permissionId = `perm.${Buffer.from(assignment.taskId).toString("base64url")}.json.${assignment.leaseSeq}`;
      expect(permissionId).toMatch(/[A-Z]/);
      const optionId = " Allow.Once/ACP ";
      const requested = await dispatchManagedHttp(f, "endpoints.worker.permission", {
        ...lease(assignment), permissionId,
        prompt: { options: [{ optionId }], deviceCredential, secret: permissionMarker }
      });
      expect(requested.status).toBe(200);
      expect(requested.body.permission).toMatchObject({ permissionId, prompt: { options: [{ optionId }] } });
      expect((await dispatchManagedHttp(f, "endpoints.tasks.permission", {
        taskId: assignment.taskId, permissionId, selectedOptionId: optionId.trim()
      })).status).toBe(409);
      expect((await dispatchManagedHttp(f, "endpoints.tasks.permission", {
        taskId: assignment.taskId, permissionId, selectedOptionId: optionId
      })).status).toBe(200);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const delivered = await dispatchManagedHttp(f, "endpoints.worker.poll", { batchSize: 0 });
        expect(delivered.status).toBe(200);
        expect(delivered.body.permissionResolutions).toEqual([{
          ...lease(assignment), permissionId, resolution: { selectedOptionId: optionId }
        }]);
      }
      expect((await dispatchManagedHttp(f, "endpoints.worker.poll", {
        batchSize: 0, acknowledgedPermissionIds: [permissionId, permissionId]
      })).status).toBe(400);
      expect(f.store.getPermission(permissionId).state).toBe("resolved");
      const acknowledged = await dispatchManagedHttp(f, "endpoints.worker.poll", {
        batchSize: 0, acknowledgedPermissionIds: [permissionId]
      });
      expect(acknowledged.status).toBe(200);
      expect(acknowledged.body.permissionResolutions).toEqual([]);
      expect((await dispatchManagedHttp(f, "endpoints.worker.poll", { batchSize: 0 })).body.permissionResolutions).toEqual([]);
      expect(f.store.getPermission(permissionId).state).toBe("delivered");
      const records = ["execution_history", "content"].flatMap((category) =>
        recording.listRecords({ category, role: "role.managed-reader" }));
      expect(records.some((record: any) => record.category === "execution_history")).toBe(true);
      expect(records.some((record: any) => record.detail.artifactRefs?.length)).toBe(true);
      const artifacts = records.flatMap((record: any) => (record.detail.artifactRefs || []).map((artifactRef: string) =>
        recording.readArtifact({ artifactRef, role: "role.managed-reader" }).bytes.toString("utf8")));
      const captured = JSON.stringify({ records, artifacts });
      for (const secret of [deviceCredential, f.consoleRequest.headers.cookie, permissionMarker]) {
        expect(captured).not.toContain(secret);
      }
    });
  });

  it.each(["request", "resolve", "ack"])("accepts mixed-case permission IDs at the isolated HTTP %s boundary", async (stage) => {
    await withFixture(async (f) => {
      const { input, device } = await f.enroll();
      await f.service.submitTask(f.actor, input, { request: f.consoleRequest, authSession: f.login.session, operation: submitOperation });
      const assignment = (await f.service.workerPoll(device, { batchSize: 1 })).assignments[0];
      await f.service.workerStart(device, lease(assignment));
      const permissionId = "perm.bXRhc2tfTUlYRURE.json.1";
      const permissionInput = { ...lease(assignment), permissionId, prompt: { options: [{ optionId: "allow" }] } };
      if (stage !== "request") await f.service.workerPermission(device, permissionInput);
      if (stage === "ack") await f.service.resolvePermission(f.actor, assignment.taskId, { permissionId, selectedOptionId: "allow" });
      const response = stage === "request"
        ? await dispatchManagedHttp(f, "endpoints.worker.permission", permissionInput)
        : stage === "resolve"
        ? await dispatchManagedHttp(f, "endpoints.tasks.permission", { taskId: assignment.taskId, permissionId, selectedOptionId: "allow" })
        : await dispatchManagedHttp(f, "endpoints.worker.poll", { batchSize: 0, acknowledgedPermissionIds: [permissionId] });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(f.store.getPermission(permissionId).state).toBe(stage === "request" ? "pending" : stage === "resolve" ? "resolved" : "delivered");
    });
  });

  it.each([false, true])("rejects public confirmRunning=%s before queue mutation", async (confirmRunning) => {
    await withFixture(async (f) => {
      const { input, device } = await f.enroll();
      await f.service.submitTask(f.actor, input, { request: f.consoleRequest, authSession: f.login.session, operation: submitOperation });
      const assignment = (await f.service.workerPoll(device, { batchSize: 1 })).assignments[0];
      const before = f.store.getTask(assignment.taskId);
      const queueBefore = await f.service.getTask(f.actor, assignment.taskId);
      expect((await dispatchManagedHttp(f, "endpoints.worker.event", { ...lease(assignment), confirmRunning })).status).toBe(400);
      expect(f.store.getTask(assignment.taskId)).toEqual(before);
      expect(await f.service.getTask(f.actor, assignment.taskId)).toEqual(queueBefore);
    });
  });

  it.each(["complete", "revoke", "enqueue-recovery", "cancel"])("retains real single-use approval until the admitted device task settles (%s)", async (action) => {
    await withFixture(async (f) => {
      const key = await f.issue(1);
      const authorization = await f.platform.apiKeyDistributionProvider.authenticateRuntime({
        credential: key.apiKey, serverAudience: "managed.invalid", targetId: null,
        connectorPackageId: null, processIdentityEvidence: null
      });
      const { input, device } = await f.enroll({ tenantId: "local", organizationId: "issuer", subjectId: authorization.workloadPrincipalId });
      const request = { method: "POST", url: "/mcp", headers: {}, socket: { remoteAddress: "127.0.0.1" } };
      const pending = await f.platform.runtime.executeTool({
        toolId: "meshrix.endpoints.tasks.submit", input, request, apiKeyAuthorization: authorization
      });
      expect(pending).toMatchObject({ ok: true, status: 202, payload: { status: "pending_approval" } });
      const pendingId = pending.payload.pendingOperation.pendingOperationId;
      expect(f.store.getTaskByRequestId("local", "issuer", input.requestId)).toBeNull();
      await f.platform.runtime.resumePendingOperation({
        pendingOperationId: pendingId, request, resolvedBy: f.actor.subjectId,
        approver: f.login.session.user, reason: "Synthetic governed approval"
      });
      expect(await f.platform.store.getPendingOperation(pendingId)).toMatchObject({ status: "approved" });
      expect(f.securityPermissions.getGovernanceApproval(`pending-${pendingId}`)).toMatchObject({ grantKind: "once", revokedAt: "" });
      await f.service.ready();
      if (action === "cancel") {
        const task = f.store.getTaskByRequestId("local", "issuer", input.requestId);
        await f.service.cancelTask({ tenantId: "local", organizationId: "issuer", subjectId: authorization.workloadPrincipalId }, task.taskId);
        expect(await f.platform.store.getPendingOperation(pendingId)).toMatchObject({ status: "cancelled" });
        expect(f.securityPermissions.getGovernanceApproval(`pending-${pendingId}`).revokedAt).toBeTruthy();
        expect((await f.service.workerPoll(device, { batchSize: 1 })).assignments).toEqual([]);
        return;
      }
      const assignment = (await f.service.workerPoll(device, { batchSize: 1 })).assignments[0];
      expect(assignment).toBeTruthy();
      if (action === "revoke") {
        f.securityPermissions.revokeGovernanceApproval(`pending-${pendingId}`, "Synthetic administrator revocation");
        await expect(f.service.workerStart(device, lease(assignment))).rejects.toMatchObject({ code: "managed_authority_denied" });
      } else {
        const decision = await f.authorityPort.revalidate(f.store.getTask(assignment.taskId).authority, input);
        expect(decision).toMatchObject({
          actor: { tenantId: "local", organizationId: "issuer" },
          subject: { tenantId: "issuer" }
        });
        expect(await f.service.workerStart(device, lease(assignment))).toMatchObject({ authorized: true });
        await f.service.workerComplete(device, { ...lease(assignment), state: "succeeded", result: { syntheticApproval: true } });
        expect(await f.platform.store.getPendingOperation(pendingId)).toMatchObject({ status: "completed" });
        expect(f.securityPermissions.getGovernanceApproval(`pending-${pendingId}`).revokedAt).toBeTruthy();
      }
      const keys = await f.platform.apiKeyDistributionProvider.list({ subjectId: "fixture-admin", limit: 10 });
      expect(keys.items[0].useCount).toBe(1);
    }, { approvalRequired: true, failFirstEnqueue: action === "enqueue-recovery" });
  });

  it("persists direct HTTP admission inside its real API-key reservation and releases before queued work", async () => {
    await withFixture(async (f) => {
      const key = await f.issue(1);
      const { input, device } = await f.enroll({ tenantId: "local", organizationId: "issuer", subjectId: key.record.workloadPrincipalId });
      const database = new Database(getOperationPermissionDatabasePath(path.join(f.directory, "permissions")), { readonly: true });
      f.closers.unshift(() => database.close());
      const activeLeases = () => (database.prepare("SELECT COUNT(*) AS count FROM api_key_effect_leases").get() as { count: number }).count;
      const reserve = f.store.reserveTask.bind(f.store);
      let observed = 0;
      f.store.reserveTask = (...args: any[]) => {
        observed += 1;
        expect(activeLeases()).toBe(1);
        return reserve(...args);
      };
      const url = new URL(submitOperation.http.path, "http://managed.invalid");
      const response = createCapturedResponse();
      await dispatchRegisteredHttpOperation({
        operations, controllers: f.controllers, routeIndex: createOperationRouteIndex(operations),
        operationProofSubstrate: f.proof, lockManager: f.lockManager, logger,
        request: { method: "POST", url: url.pathname, headers: { "x-meshrix.js-api-key": key.apiKey }, socket: { remoteAddress: "127.0.0.1" } },
        response, method: "POST", url, requestBody: Buffer.from(JSON.stringify(input))
      });
      expect(response.statusCode, JSON.stringify(parseCapturedResult({ captured: response }))).toBe(202);
      expect(observed).toBe(1);
      expect(activeLeases()).toBe(0);
      const assignment = (await f.service.workerPoll(device, { batchSize: 1 })).assignments[0];
      expect(await f.service.workerStart(device, lease(assignment))).toMatchObject({ authorized: true });
      expect(activeLeases()).toBe(0);
    });
  });

  it("uses the real HTTP enrollment route with closed worker schemas and errors", async () => {
    await withFixture(async (f) => {
      const created = await f.service.createEndpoint(f.actor, { label: "Synthetic HTTP device", allowedCapabilityIds: [capability.capabilityId] });
      const operation: any = operations.find((entry: any) => entry.id === "endpoints.worker.enroll")!;
      const invoke = async (body: any) => {
        const response = createCapturedResponse();
        const url = new URL(operation.http.path, "http://managed.invalid");
        await dispatchRegisteredHttpOperation({
          operations, controllers: f.controllers, routeIndex: createOperationRouteIndex(operations),
          operationProofSubstrate: f.proof, lockManager: f.lockManager, logger,
          request: { method: "POST", url: url.pathname, headers: {}, socket: { remoteAddress: "127.0.0.1" } },
          response, method: "POST", url, requestBody: Buffer.from(JSON.stringify(body))
        });
        return { status: response.statusCode, body: parseCapturedResult({ captured: response }) };
      };
      expect(operation.inputSchema.properties).not.toHaveProperty("confirm");
      expect(operation.inputSchema.properties).not.toHaveProperty("safetyConfirm");
      const enrolled = await invoke({
        enrollmentToken: created.enrollmentToken, deviceCredential, capabilities: [capability]
      });
      expect(enrolled.status, JSON.stringify(diagnosticErrors)).toBe(200);
      expect(assertManagedEndpoint(enrolled.body.endpoint)).toMatchObject({ state: "active" });
      const invalid = await invoke({ enrollmentToken: created.enrollmentToken, deviceCredential, injected: true });
      expect(invalid.status).toBe(400);
      expect(Object.keys(invalid.body).sort()).toEqual(["code", "error"]);
    });
  });

  it("requires authority dependencies and nonempty verified tenant identity", async () => {
    expect(() => createManagedEndpointService({ store: {}, queuePort: {} } as any)).toThrowError(
      expect.objectContaining({ code: "managed_authority_required" })
    );
    expect(() => managedActorFromSession({ user: { orgId: "issuer", subjectId: "fixture-subject" } })).toThrowError(
      expect.objectContaining({ code: "managed_tenant_required" })
    );
  });

  it.each([false, true])("revalidates the real deferred Console session at start (revoked=%s)", async (revoked) => {
    await withFixture(async (f) => {
      const { input, device } = await f.enroll();
      await f.service.submitTask(f.actor, input, {
        request: f.consoleRequest, authSession: f.login.session, operation: submitOperation
      });
      const assignment = (await f.service.workerPoll(device, { batchSize: 1 })).assignments[0];
      expect(assignment).toBeTruthy();
      if (revoked) {
        f.consoleAuth.revokeSession(f.login.session.sessionId);
        await expect(f.service.workerStart(device, lease(assignment))).rejects.toMatchObject({ code: "managed_authority_denied" });
      } else {
        expect(await f.service.workerStart(device, lease(assignment))).toEqual({
          ...lease(assignment), authorized: true, cancelRequested: false
        });
      }
      const durable = f.store.getTask(assignment.taskId);
      expect(JSON.stringify(durable)).not.toContain(f.consoleRequest.headers.cookie);
      expect(durable.authority.binding).not.toHaveProperty("session");
    });
  });

  it("dispatches canonical RPC member input and preserves confirmation outside business JSON", async () => {
    await withFixture(async (f) => {
      const { input } = await f.enroll();
      const response = createCapturedResponse();
      await dispatchRpcOperation({
        operations, controllers: f.controllers, request: f.consoleRequest, response,
        routeIndex: createOperationRouteIndex(operations),
        requestBody: Buffer.from(JSON.stringify({
          jsonrpc: "2.0", id: "fixture-rpc", method: "endpoints.tasks.submit",
          params: { ...input, safetyConfirm: true }
        })),
        operationProofSubstrate: f.proof, lockManager: f.lockManager, logger
      });
      const body = parseCapturedResult({ captured: response });
      expect(body.error, JSON.stringify(diagnosticErrors)).toBeUndefined();
      const task = f.store.getTaskByRequestId(f.actor.tenantId, f.actor.organizationId, input.requestId);
      expect(task).toMatchObject({ input: input.input, governance: { confirmation: { safetyConfirm: true } } });
      expect(task.input).not.toHaveProperty("safetyConfirm");
    });
  });

  it.each([false, true])("uses one real API-key reservation and revalidates deferred authority (revoked=%s)", async (revoked) => {
    await withFixture(async (f) => {
      const key = await f.issue(1);
      const authorization = await f.platform.apiKeyDistributionProvider.authenticateRuntime({
        credential: key.apiKey, serverAudience: "managed.invalid", targetId: null,
        connectorPackageId: null, processIdentityEvidence: null
      });
      const { input, device } = await f.enroll({
        tenantId: "local", organizationId: "issuer", subjectId: authorization.workloadPrincipalId
      });
      const request: any = { method: "POST", url: "/mcp", headers: {}, socket: { remoteAddress: "127.0.0.1" } };
      const result = await f.platform.runtime.executeTool({
        toolId: "meshrix.endpoints.tasks.submit", input, request, apiKeyAuthorization: authorization
      });
      expect(result.ok, JSON.stringify({ payload: result.payload, errors: diagnosticErrors })).toBe(true);
      expect(request.__meshrixCaptureManagedTaskAuthority).toBeUndefined();
      const assignment = (await f.service.workerPoll(device, { batchSize: 1 })).assignments[0];
      expect(assignment).toBeTruthy();
      if (revoked) {
        await f.platform.apiKeyDistributionProvider.revoke({
          subjectId: "fixture-admin", keyId: key.record.keyId,
          expectedLifecycleRevision: key.record.lifecycleRevision, reasonCode: "administrator_request"
        });
        await expect(f.service.workerStart(device, lease(assignment))).rejects.toMatchObject({ code: "managed_authority_denied" });
      } else {
        expect(await f.service.workerStart(device, lease(assignment))).toMatchObject({ authorized: true });
      }
      const records = await f.platform.apiKeyDistributionProvider.list({ subjectId: "fixture-admin", limit: 10 });
      expect(records.items[0].useCount).toBe(1);
      expect(JSON.stringify(f.store.getTask(assignment.taskId))).not.toContain(key.apiKey);
    });
  });

  it("lists member tools but never worker authority through the real standard MCP catalog", async () => {
    await withFixture(async (f) => {
      const key = await f.issue();
      const gateway = createPlatformMcpGateway({
        toolSkillManagementProvider: f.provider, operationProofSubstrate: f.proof, runtimeLogger: logger
      });
      f.closers.unshift(() => gateway.close());
      await gateway.gateway.start();
      let session = "";
      const send = (body: any) => {
        const headers = {
          "content-type": "application/json", accept: "application/json, text/event-stream",
          "x-meshrix.js-api-key": key.apiKey,
          ...(session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" } : {})
        };
        const rawRequest = Object.assign(new EventEmitter(), { method: "POST", url: "/mcp", headers, socket: { remoteAddress: "127.0.0.1" } });
        return gateway.adapter.handle({
          method: "POST", headers, body, rawRequest, url: new URL("http://managed.invalid/mcp"),
          requestBody: Buffer.from(JSON.stringify(body))
        });
      };
      const initialized: any = await send({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-standard-caller", version: "1" } }
      });
      expect(initialized.status).toBe(200);
      session = initialized.headers["Mcp-Session-Id"] || initialized.headers["mcp-session-id"];
      expect(session).toBeTruthy();
      expect((await send({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
      const listed: any = await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(listed.status).toBe(200);
      const names = listed.body.result.tools.map((tool: any) => tool.name);
      for (const operation of operations.filter((entry: any) => !entry.id.startsWith("endpoints.worker."))) {
        expect(names).toContain(`meshrix.${operation.id}`);
      }
      expect(names.some((name: string) => name.startsWith("meshrix.endpoints.worker."))).toBe(false);
      const { input, device } = await f.enroll({
        tenantId: "local", organizationId: "issuer", subjectId: key.record.workloadPrincipalId
      });
      const called: any = await send({
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "meshrix.endpoints.tasks.submit", arguments: input }
      });
      expect(called.body.error, JSON.stringify(diagnosticErrors)).toBeUndefined();
      expect(called.body.result?.isError, JSON.stringify(called.body)).not.toBe(true);
      const task = f.store.getTaskByRequestId("local", "issuer", input.requestId);
      expect(task).toMatchObject({ input: input.input });
      const assignment = (await f.service.workerPoll(device, { batchSize: 1 })).assignments[0];
      expect(await f.service.workerStart(device, lease(assignment))).toMatchObject({ authorized: true });
      const records = await f.platform.apiKeyDistributionProvider.list({ subjectId: "fixture-admin", limit: 10 });
      expect(records.items[0].useCount).toBe(1);
      await f.service.workerComplete(device, { ...lease(assignment), state: "succeeded", result: { syntheticResult: true } });
      const result: any = await send({
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "meshrix.endpoints.tasks.get", arguments: { taskId: task.taskId } }
      });
      expect(result.body.error).toBeUndefined();
      expect(result.body.result?.isError, JSON.stringify(result.body)).not.toBe(true);
      expect(JSON.stringify(result.body.result)).toContain('"syntheticResult":true');
    });
  });

  it("managed proof replay keeps one completed admission and its immutable evidence", async () => {
    await withFixture(async (f) => {
      const audits = trackAudit(f);
      const { input, device } = await f.enroll();
      const first = await dispatchManagedHttp(f, "endpoints.tasks.submit", input);
      expect(first.status).toBe(202);
      const taskId = first.body.task.taskId;
      const assignment = (await f.service.workerPoll(device, { batchSize: 1 })).assignments[0];
      await f.service.workerStart(device, lease(assignment));
      await f.service.workerComplete(device, { ...lease(assignment), state: "succeeded", result: { synthetic: "durable" } });
      const size = (await f.proof.pactiumRuntime.core.readLedgerHead()).size;
      const auditCount = audits.length;
      expect(auditCount).toBeGreaterThan(0);
      const retry = await dispatchManagedHttp(f, "endpoints.tasks.submit", input);
      expect(retry).toMatchObject({ status: 202, body: { idempotent: true, task: { taskId, state: "succeeded", result: { synthetic: "durable" } } } });
      expect((await f.service.workerPoll(device, { batchSize: 1 })).assignments).toEqual([]);
      expect((await f.proof.pactiumRuntime.core.readLedgerHead()).size).toBe(size);
      expect(audits).toHaveLength(auditCount);
    });
  });

  it("managed proof replay cannot turn a closed failed admission into new work", async () => {
    await withFixture(async (f) => {
      trackAudit(f);
      const input = { requestId: "req-managed-proof-failed", capabilityId: capability.capabilityId, input: { message: "synthetic" } };
      const failed = await dispatchManagedHttp(f, "endpoints.tasks.submit", input);
      expect(failed.status).toBe(404);
      const { device } = await f.enroll();
      let replay: any, error: unknown;
      try { replay = await dispatchManagedHttp(f, "endpoints.tasks.submit", input); } catch (caught) { error = caught; }
      expect(f.store.getTaskByRequestId(f.actor.tenantId, f.actor.organizationId, input.requestId)).toBeNull();
      expect((await f.service.workerPoll(device, { batchSize: 1 })).assignments).toEqual([]);
      expect(error).toBeUndefined();
      expect(replay.status).toBe(409);
    });
  });

  it("managed proof replay cannot recreate a missing admitted binding", async () => {
    await withFixture(async (f) => {
      trackAudit(f);
      const { input } = await f.enroll();
      expect((await dispatchManagedHttp(f, "endpoints.tasks.submit", input)).status).toBe(202);
      const lookup = vi.spyOn(f.store, "getTaskByRequestId").mockReturnValue(null);
      const reserve = vi.spyOn(f.store, "reserveTask");
      try {
        let replay: any, error: unknown;
        try { replay = await dispatchManagedHttp(f, "endpoints.tasks.submit", input); } catch (caught) { error = caught; }
        expect(reserve).not.toHaveBeenCalled();
        expect(error).toBeUndefined();
        expect(replay.status).toBe(409);
      } finally { lookup.mockRestore(); reserve.mockRestore(); }
    });
  });

  it("managed proof replay settlement keeps the operation lock until a queued resubmission", async () => {
    await withFixture(async (f) => {
      const audits = trackAudit(f);
      const { input } = await f.enroll();
      let releaseFinish: any;
      let finishStarted: any;
      const finishGate = new Promise((resolve) => { releaseFinish = resolve; });
      const firstFinish = new Promise((resolve) => { finishStarted = resolve; });
      let finishCalls = 0;
      let beginCalls = 0;
      const realProof = f.proof;
      f.proof = {
        ...realProof,
        finishLifecycle: async (args: any) => {
          finishCalls += 1;
          if (finishCalls === 1) {
            finishStarted();
            await finishGate;
          }
          return realProof.finishLifecycle(args);
        },
        beginLifecycle: (...args: any[]) => {
          beginCalls += 1;
          return realProof.beginLifecycle(...args);
        }
      };
      let acquireCalls = 0;
      let secondAcquireStarted: any;
      const secondAcquire = new Promise((resolve) => { secondAcquireStarted = resolve; });
      const originalAcquire = f.lockManager.acquire.bind(f.lockManager);
      f.lockManager.acquire = (...args: any[]) => {
        acquireCalls += 1;
        if (acquireCalls === 2) secondAcquireStarted();
        return originalAcquire(...args);
      };
      let firstDispatch: any, secondDispatch: any;
      try {
        firstDispatch = dispatchManagedHttp(f, "endpoints.tasks.submit", input);
        await Promise.race([firstFinish, firstDispatch]);
        secondDispatch = dispatchManagedHttp(f, "endpoints.tasks.submit", input);
        await Promise.race([secondAcquire, secondDispatch]);
        expect(beginCalls).toBe(1);
        releaseFinish();
        const [firstSettled, secondSettled] = await Promise.allSettled([firstDispatch, secondDispatch]);
        expect(firstSettled.status).toBe("fulfilled");
        expect(secondSettled.status).toBe("fulfilled");
        expect(firstSettled.status === "fulfilled" && firstSettled.value.status).toBe(202);
        expect(secondSettled.status === "fulfilled" && secondSettled.value.status).toBe(202);
        if (firstSettled.status === "fulfilled" && secondSettled.status === "fulfilled") {
          expect(secondSettled.value.body.idempotent).toBe(true);
          expect(secondSettled.value.body.task.taskId).toBe(firstSettled.value.body.task.taskId);
        }
        expect(audits).toHaveLength(1);
      } finally {
        releaseFinish?.();
        await Promise.allSettled([firstDispatch, secondDispatch].filter(Boolean));
        f.proof = realProof;
        delete f.lockManager.acquire;
      }
    });
  });

  it("managed proof replay rejects a contradictory owner result", async () => {
    await withFixture(async (f) => {
      trackAudit(f);
      const { input } = await f.enroll();
      expect((await dispatchManagedHttp(f, "endpoints.tasks.submit", input)).status).toBe(202);
      const size = (await f.proof.pactiumRuntime.core.readLedgerHead()).size;
      const originalSubmit = f.service.submitTask.bind(f.service);
      const submit = vi.spyOn(f.service, "submitTask").mockImplementation(async (actor: any, rawInput: any, context: any) => {
        const result = await originalSubmit(actor, rawInput, context);
        return { ...result, task: { ...result.task, taskId: "mtask_contradictory_owner_replay" } };
      });
      try {
        let replay: any, error: any;
        try { replay = await dispatchManagedHttp(f, "endpoints.tasks.submit", input); } catch (caught) { error = caught; }
        expect(replay).toBeUndefined();
        expect(error?.code).toBe("operation_outcome_in_doubt");
        expect((await f.proof.pactiumRuntime.core.readLedgerHead()).size).toBe(size);
      } finally { submit.mockRestore(); }
    });
  });
});
