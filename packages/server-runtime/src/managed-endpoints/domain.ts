import { createHash, randomUUID } from "node:crypto";
import {
  MANAGED_ENDPOINT_PROTOCOL, MANAGED_DEVICE_CREDENTIAL_PATTERN,
  MANAGED_ENROLLMENT_TOKEN_PATTERN, MANAGED_ENDPOINT_MAX_COUNT,
  MANAGED_CAPABILITY_MAX_COUNT, assertManagedActor, assertManagedCapability,
  assertManagedCapabilityIds, assertManagedFields, assertManagedId,
  assertManagedSignaturePolicy, assertManagedWorkspaceList,
  type ManagedActor, type ManagedCapability
} from "@meshrix/contracts/managed-endpoints";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { compileClosedJsonSchema } from "@meshrix/foundation/security/closed-json-schema";
import { mintManagedSecret } from "./store.ts";
import type { ManagedTaskAuthorityPort } from "./authority.ts";
import { createManagedTaskService } from "./task-service.ts";
import { managedError, managedQueueDefinitionId } from "./common.ts";

// Organization-scoped managed endpoint service. The work queue remains the
// sole task lifecycle authority: device inventory, enrollment, credential
// hashes, requestId idempotence, result persistence and permission prompts
// live in the managed store. Every worker mutation validates the authenticated
// device, exact lease generation and scope before touching the queue.

export const MANAGED_ENROLLMENT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// ManagedActor derives exclusively from authenticated authority: console
// session user fields or the verified scoped-API-key identity, never request
// body fields. Missing organization identity fails closed.
export function managedActorFromSession(authSession: Record<string, any> | null | undefined): ManagedActor {
  const user = authSession?.user || authSession || {};
  const organizationId = user.orgId || user.organizationId || user.organizationNodeId;
  const tenantId = user.tenantId;
  const subjectId = user.userId || user.subjectId || user.workloadPrincipalId;
  if (!organizationId) managedError("managed_organization_required", "Managed organization identity is required.", 403);
  if (!tenantId) managedError("managed_tenant_required", "Managed tenant identity is required.", 403);
  if (!subjectId) managedError("managed_subject_required", "Managed subject identity is required.", 403);
  return assertManagedActor({ tenantId, organizationId, subjectId });
}

export interface ManagedEndpointServiceDeps {
  store: any;
  queuePort: any;
  authorityPort: ManagedTaskAuthorityPort;
  nowMs?: () => number;
  maxLeasedPerEndpoint?: number;
  enrollmentTokenTtlMs?: number;
}

export function createManagedEndpointService({
  store, queuePort, authorityPort, nowMs = Date.now,
  maxLeasedPerEndpoint = Number(process.env.MESHRIX_MANAGED_ENDPOINT_MAX_LEASED || 1),
  enrollmentTokenTtlMs = Number(process.env.MESHRIX_MANAGED_ENROLLMENT_TOKEN_TTL_MS || MANAGED_ENROLLMENT_TOKEN_TTL_MS)
}: ManagedEndpointServiceDeps) {
  if (!authorityPort || ["capture", "revalidate", "release"].some((key) =>
    typeof (authorityPort as any)[key] !== "function")) {
    managedError("managed_authority_required", "Managed requester authority is required.", 503);
  }
  if (!Number.isSafeInteger(maxLeasedPerEndpoint) || maxLeasedPerEndpoint < 1) {
    throw new TypeError("Managed endpoint concurrency must be a positive integer.");
  }
  if (!Number.isSafeInteger(enrollmentTokenTtlMs) || enrollmentTokenTtlMs < 1) {
    throw new TypeError("Managed enrollment-token lifetime must be a positive integer of milliseconds.");
  }
  const queueFacets = new Map<string, Promise<any>>();
  const compiledCatalogs = new Map<string, Map<string, {
    schema: string; validate: ReturnType<typeof compileClosedJsonSchema>["validate"]
  }>>();

  function endpointQueue(endpoint: Record<string, any>): Promise<any> {
    const endpointId = endpoint.endpointId;
    let pending = queueFacets.get(endpointId);
    if (!pending) {
      pending = Promise.resolve().then(() => queuePort.registerQueue({
        queueDefinitionId: managedQueueDefinitionId(endpointId),
        label: `managed-endpoint:${endpointId}`,
        ownerCapability: "meshrix.managed-endpoints",
        consumerEnabled: false,
        workerId: `managed-endpoint:${endpointId}`,
        scope: { tenantId: endpoint.tenantId, workspaceId: endpoint.organizationId, projectId: endpointId },
        metadata: { kind: "managed-endpoint", organizationId: endpoint.organizationId, endpointId },
        policy: { workExpiry: { allowUnbounded: true }, capacity: { maxLeasedPerProject: maxLeasedPerEndpoint } }
      })).catch((error) => {
        queueFacets.delete(endpointId);
        throw error;
      });
      queueFacets.set(endpointId, pending);
    }
    return pending;
  }

  function assertSameOrg(endpoint: Record<string, any> | null, actor: ManagedActor) {
    if (!endpoint) managedError("managed_endpoint_not_found", "Managed resource does not exist.", 404);
    if (endpoint.tenantId !== actor.tenantId || endpoint.organizationId !== actor.organizationId) {
      managedError("managed_organization_forbidden", "Managed resource is outside the authorized organization.", 404);
    }
  }

  function currentDevice(device: Record<string, any>) {
    const endpoint = store.getEndpoint(device.endpointId);
    assertSameOrg(endpoint, { tenantId: device.tenantId, organizationId: device.organizationId, subjectId: "device" });
    if (endpoint.state !== "active" || endpoint.generation !== (device.generation ?? device.endpoint?.generation)) {
      managedError("managed_endpoint_revoked", "Managed endpoint is revoked.", 403);
    }
    return endpoint;
  }

  function enrollmentAuthority(input: Record<string, any>) {
    if (typeof input.enrollmentToken !== "string" || !MANAGED_ENROLLMENT_TOKEN_PATTERN.test(input.enrollmentToken)) {
      managedError("managed_enrollment_token_invalid", "Managed enrollment token is invalid.", 403);
    }
    if (typeof input.deviceCredential !== "string" || !MANAGED_DEVICE_CREDENTIAL_PATTERN.test(input.deviceCredential)) {
      managedError("managed_device_credential_invalid", "Managed device credential is invalid.", 403);
    }
    const enrollment = store.getEnrollment(input.enrollmentToken);
    if (!enrollment) managedError("managed_enrollment_token_invalid", "Managed enrollment token is invalid.", 403);
    const endpoint = store.getEndpoint(enrollment.endpointId);
    if (!endpoint || endpoint.state === "revoked") managedError("managed_endpoint_revoked", "Managed endpoint is revoked.", 409);
    if (enrollment.boundCredentialHash) {
      if (enrollment.boundCredentialHash !== createHash("sha256").update(input.deviceCredential).digest("hex")) {
        managedError("managed_enrollment_rebind_rejected", "Managed enrollment token is already bound.", 403);
      }
    } else if (nowMs() > enrollment.expiresAtMs) {
      managedError("managed_enrollment_token_expired", "Managed enrollment token has expired.", 403);
    }
    return { enrollment, endpoint };
  }

  function validateCatalog(endpointId: string, input: unknown): ManagedCapability[] {
    if (!Array.isArray(input) || input.length > MANAGED_CAPABILITY_MAX_COUNT) {
      managedError("managed_capability_set_invalid", "Managed capability set is invalid.");
    }
    const capabilities = input.map(assertManagedCapability);
    if (new Set(capabilities.map((entry) => entry.capabilityId)).size !== capabilities.length) {
      managedError("managed_capability_set_invalid", "Managed capability set is invalid.");
    }
    const previous = compiledCatalogs.get(endpointId);
    const current = new Map<string, { schema: string; validate: ReturnType<typeof compileClosedJsonSchema>["validate"] }>();
    for (const capability of capabilities) {
      const schema = canonicalJson(capability.inputSchema);
      const existing = previous?.get(capability.capabilityId);
      try {
        current.set(capability.capabilityId, existing?.schema === schema ? existing : {
          schema,
          validate: compileClosedJsonSchema(capability.inputSchema, {
            typeSemantics: "external", requireTopLevelObject: false
          }).validate
        });
      } catch {
        managedError("managed_capability_schema_invalid", "Managed capability schema is unsupported.");
      }
    }
    compiledCatalogs.set(endpointId, current);
    return capabilities;
  }

  function capabilityFor(endpoint: Record<string, any>, capabilityId: string, input?: unknown) {
    if (endpoint.state !== "active") managedError("managed_endpoint_revoked", "Managed endpoint is revoked.", 409);
    if (!endpoint.allowedCapabilityIds.includes(capabilityId)) {
      managedError("managed_capability_not_allowed", "Managed capability is not allowed.", 403);
    }
    const capability = endpoint.publishedCapabilities.find((entry: ManagedCapability) => entry.capabilityId === capabilityId);
    if (!capability) managedError("managed_capability_unpublished", "Managed capability is not published.", 404);
    if (compiledCatalogs.get(endpoint.endpointId)?.get(capabilityId)?.schema !== canonicalJson(capability.inputSchema)) {
      validateCatalog(endpoint.endpointId, endpoint.publishedCapabilities);
    }
    if (input !== undefined && !compiledCatalogs.get(endpoint.endpointId)!.get(capabilityId)!.validate(input).ok) {
      managedError("managed_task_input_invalid", "Managed task input does not satisfy the capability schema.");
    }
    return capability;
  }

  const tasks = createManagedTaskService({
    store, endpointQueue, authorityPort, currentDevice, assertSameOrg, capabilityFor,
    nowMs, maxLeasedPerEndpoint
  });

  return {
    ...tasks,
    // ---- member/admin surface -------------------------------------------
    async listEndpoints(actor: ManagedActor) {
      const endpoints = store.listEndpoints(actor.tenantId, actor.organizationId);
      const records = store.listTasks(actor.tenantId, actor.organizationId);
      const results = await Promise.all(records.map((task: any) => tasks.getTask(actor, task.taskId)));
      return {
        endpoints, tasks: results.map((result) => result.task),
        observations: store.endpointObservations(actor.tenantId, actor.organizationId),
        pendingPermissions: store.listOrgPendingPermissions(actor.tenantId, actor.organizationId).map(tasks.publicPermission)
      };
    },
    async createEndpoint(actor: ManagedActor, rawInput: Record<string, unknown>) {
      const input = assertManagedFields(rawInput, ["label", "kind", "allowedCapabilityIds"]);
      if (typeof input.label !== "string" || !input.label.trim() || input.label.length > 160) {
        managedError("managed_endpoint_label_invalid", "Managed endpoint label is required.");
      }
      const kind = input.kind ?? "workstation";
      if (kind !== "workstation" && kind !== "shared") {
        managedError("managed_endpoint_kind_invalid", "Managed endpoint kind must be workstation or shared.");
      }
      const allowedCapabilityIds = assertManagedCapabilityIds(input.allowedCapabilityIds ?? []);
      return store.transaction(() => {
        if (store.countActiveEndpoints(actor.tenantId, actor.organizationId) >= MANAGED_ENDPOINT_MAX_COUNT) {
          managedError("managed_endpoint_capacity_exceeded", "Managed endpoint capacity is exceeded.", 429);
        }
        const endpointId = `me_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const now = nowMs();
        const endpoint = store.createEndpoint({
          endpointId, tenantId: actor.tenantId, organizationId: actor.organizationId,
          label: input.label, kind, state: "pending", generation: 1,
          allowedCapabilityIds, publishedCapabilities: [], publishedWorkspaces: []
        }, now);
        const enrollmentToken = mintManagedSecret("met_");
        store.createEnrollment({
          token: enrollmentToken, endpointId, tenantId: actor.tenantId,
          organizationId: actor.organizationId, nowMs: now, ttlMs: enrollmentTokenTtlMs
        });
        // The token is returned exactly once in this response; only its hash is
        // ever persisted.
        return { endpoint, enrollmentToken };
      });
    },
    async updateEndpoint(actor: ManagedActor, endpointId: string, rawInput: Record<string, unknown>) {
      const input = assertManagedFields(rawInput, ["label", "allowedCapabilityIds"]);
      const endpoint = store.getEndpoint(assertManagedId(endpointId, "endpointId"));
      assertSameOrg(endpoint, actor);
      if (endpoint.state === "revoked") managedError("managed_endpoint_revoked", "Managed endpoint is revoked.", 409);
      if (input.label !== undefined && (typeof input.label !== "string" || !input.label.trim() || input.label.length > 160)) {
        managedError("managed_endpoint_label_invalid", "Managed endpoint label is invalid.");
      }
      const updated = store.updateEndpointPolicy(endpoint, {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.allowedCapabilityIds === undefined ? {} : { allowedCapabilityIds: assertManagedCapabilityIds(input.allowedCapabilityIds) })
      }, nowMs());
      if (!updated) managedError("managed_endpoint_revoked", "Managed endpoint policy changed.", 409);
      tasks.wake(endpointId);
      return { endpoint: updated };
    },
    async revokeEndpoint(actor: ManagedActor, endpointId: string) {
      store.transaction(() => {
        const endpoint = store.getEndpoint(endpointId);
        assertSameOrg(endpoint, actor);
        if (endpoint.state !== "revoked") {
          store.updateEndpoint({ ...endpoint, state: "revoked", generation: endpoint.generation + 1 }, nowMs());
          store.revokeCredentials(endpointId, nowMs());
        }
      });
      // Queued work that never produced an effect is cancelled. Leased work
      // stays leased; the device can no longer authenticate, so lease expiry
      // settles it as in_doubt rather than silently re-executing.
      await tasks.cancelEndpointTasks(actor, endpointId);
      return { endpoint: store.getEndpoint(endpointId) };
    },
    setSignaturePolicy(actor: ManagedActor, rawInput: Record<string, unknown>) {
      const input = assertManagedFields(rawInput, ["policy"]);
      const policy = assertManagedSignaturePolicy(input.policy);
      store.setSignaturePolicy(actor.tenantId, actor.organizationId, policy, nowMs());
      return { ok: true };
    },
    getSignaturePolicy(actor: ManagedActor) {
      return { policy: store.getSignaturePolicy(actor.tenantId, actor.organizationId) };
    },
    // ---- worker/device surface ------------------------------------------
    verifyEnrollment(input: Record<string, unknown>) {
      const { endpoint } = enrollmentAuthority(input);
      return {
        endpointId: endpoint.endpointId, tenantId: endpoint.tenantId,
        organizationId: endpoint.organizationId, generation: endpoint.generation
      };
    },
    async enroll(rawInput: Record<string, unknown>) {
      const input = assertManagedFields(rawInput, ["enrollmentToken", "deviceCredential", "capabilities"]);
      const token = input.enrollmentToken;
      const credential = input.deviceCredential;
      if (typeof token !== "string" || !MANAGED_ENROLLMENT_TOKEN_PATTERN.test(token)) {
        managedError("managed_enrollment_token_invalid", "Managed enrollment token is invalid.", 403);
      }
      if (typeof credential !== "string" || !MANAGED_DEVICE_CREDENTIAL_PATTERN.test(credential)) {
        managedError("managed_device_credential_invalid", "Managed device credential is invalid.", 403);
      }
      const enrollment = store.getEnrollment(token);
      if (!enrollment) managedError("managed_enrollment_token_invalid", "Managed enrollment token is invalid.", 403);
      const publishedCapabilities = validateCatalog(enrollment.endpointId, input.capabilities ?? []);
      const enrolled = store.transaction(() => {
        const { enrollment: current, endpoint } = enrollmentAuthority(input);
        if (current.boundCredentialHash) {
          // Enrollment replay: identical token+credential is idempotent; a
          // different candidate credential is a rebinding attack and rejected.
          store.observeContact(endpoint, nowMs());
          return endpoint;
        }
        // Atomic bind: consume the token and bind the device credential hash
        // inside one transaction-shaped sequence.
        store.bindEnrollment(token, credential, nowMs());
        store.bindCredential({
          credential, endpointId: endpoint.endpointId, tenantId: endpoint.tenantId,
          organizationId: endpoint.organizationId, generation: endpoint.generation, nowMs: nowMs()
        });
        const active = store.updateEndpoint({ ...endpoint, state: "active", publishedCapabilities }, nowMs());
        store.observeContact(active, nowMs());
        return active;
      });
      compiledCatalogs.delete(enrolled.endpointId);
      return {
        protocol: MANAGED_ENDPOINT_PROTOCOL, endpoint: enrolled,
        device: {
          endpointId: enrolled.endpointId, tenantId: enrolled.tenantId,
          organizationId: enrolled.organizationId, generation: enrolled.generation
        }
      };
    },
    verifyWorker(deviceCredential: unknown, { observe = true } = {}): Record<string, any> {
      if (typeof deviceCredential !== "string" || !MANAGED_DEVICE_CREDENTIAL_PATTERN.test(deviceCredential)) {
        managedError("managed_device_credential_invalid", "Managed device credential is invalid.", 403);
      }
      const binding = store.resolveCredential(deviceCredential);
      if (!binding) managedError("managed_device_credential_invalid", "Managed device credential is invalid.", 403);
      const endpoint = currentDevice(binding);
      if (observe) store.observeContact(endpoint, nowMs());
      return { ...binding, endpoint };
    },
    async workerCatalog(device: Record<string, any>, rawInput: Record<string, unknown>) {
      const input = assertManagedFields(rawInput, ["capabilities", "workspaces"]);
      const endpoint = currentDevice(device);
      const publishedCapabilities = validateCatalog(endpoint.endpointId, input.capabilities);
      const workspaces = assertManagedWorkspaceList(input.workspaces);
      for (const capability of publishedCapabilities) {
        const previous = endpoint.publishedCapabilities.find((entry: ManagedCapability) => entry.capabilityId === capability.capabilityId);
        if (previous && (previous.revision > capability.revision ||
            previous.revision === capability.revision && canonicalJson(previous) !== canonicalJson(capability))) {
          compiledCatalogs.delete(endpoint.endpointId);
          managedError("managed_capability_revision_conflict", "Managed capability revision is already bound.", 409);
        }
      }
      const updated = store.updateCatalog(endpoint, publishedCapabilities, workspaces, nowMs());
      if (!updated) {
        compiledCatalogs.delete(endpoint.endpointId);
        managedError("managed_catalog_conflict", "Managed catalog changed concurrently.", 409);
      }
      tasks.wake(endpoint.endpointId);
      return { endpoint: updated };
    },
    async close() {
      await tasks.close();
      queueFacets.clear();
      compiledCatalogs.clear();
    }
  };
}
