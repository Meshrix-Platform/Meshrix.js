import { randomUUID } from "node:crypto";
import {
  MANAGED_ENDPOINT_PROTOCOL, MANAGED_LEASE_ID_PATTERN, MANAGED_REQUEST_ID_PATTERN,
  MANAGED_EVENT_MAX_COUNT, MANAGED_TASK_EVENTS_WAIT_MAX_MS,
  assertManagedTaskRequest, assertManagedTaskOutcome, assertManagedTaskStartResponse,
  assertManagedTaskEventBatch,
  assertManagedFields, assertManagedId, assertManagedInteger, assertManagedJson,
  type ManagedActor
} from "@meshrix/contracts/managed-endpoints";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  createFinalProtectedSinkAttempt, claimFinalProtectedSinkAttempt, digestFinalProtectedSinkInput
} from "@meshrix/foundation/security/final-protected-sink-permit";
import type { ManagedTaskAuthorityPort } from "./authority.ts";
import { managedError, managedQueueDefinitionId, MANAGED_WORKER_POLL_MAX_WAIT_MS } from "./common.ts";

type RecordValue = Record<string, any>;

export function createManagedTaskService({
  store, endpointQueue, authorityPort, currentDevice, assertSameOrg, capabilityFor,
  nowMs
}: {
  store: any; endpointQueue: (endpoint: RecordValue) => Promise<any>;
  authorityPort: ManagedTaskAuthorityPort; currentDevice: (device: RecordValue) => RecordValue;
  assertSameOrg: (resource: RecordValue | null, actor: ManagedActor) => void;
  capabilityFor: (endpoint: RecordValue, capabilityId: string, input?: unknown) => RecordValue;
  nowMs: () => number; maxLeasedPerEndpoint: number;
}) {
  const locks = new Map<string, Promise<any>>();
  const waiters = new Map<string, Set<() => void>>();
  const wakeVersions = new Map<string, number>();
  const selections = new Map<string, number>();
  let readyPromise: Promise<void> | undefined;
  let closed = false;

  function exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const pending = (locks.get(id) || Promise.resolve()).catch(() => {}).then(action);
    locks.set(id, pending);
    void pending.finally(() => {
      if (locks.get(id) === pending) locks.delete(id);
    }).catch(() => {});
    return pending;
  }

  function wake(endpointId: string) {
    wakeVersions.set(endpointId, (wakeVersions.get(endpointId) || 0) + 1);
    for (const resolve of waiters.get(endpointId) || []) resolve();
  }

  async function wait(endpointId: string, waitMs: number, version: number, signal?: AbortSignal) {
    if (closed || signal?.aborted || (wakeVersions.get(endpointId) || 0) !== version) return;
    await new Promise<void>((resolve) => {
      const listeners = waiters.get(endpointId) || new Set();
      waiters.set(endpointId, listeners);
      const finish = () => {
        clearTimeout(timer);
        listeners.delete(finish);
        if (listeners.size === 0) waiters.delete(endpointId);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      listeners.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
      if (closed || signal?.aborted || (wakeVersions.get(endpointId) || 0) !== version) finish();
    });
  }

  async function pages(filter: RecordValue, action: (task: RecordValue) => Promise<void>) {
    let after = "";
    for (;;) {
      const rows = store.taskPage({ ...filter, after });
      if (!rows.length) return;
      for (const row of rows) await action(row);
      after = rows[rows.length - 1].taskId;
    }
  }

  function patch(taskId: string, update: RecordValue) {
    const task = store.getTask(taskId);
    store.updateTask(task, update, nowMs());
    return store.getTask(taskId);
  }

  function workspaceFor(endpoint: RecordValue, workspaceId?: string) {
    if (!workspaceId) return;
    if (!(endpoint.publishedWorkspaces || []).some((entry: RecordValue) => entry.workspaceId === workspaceId)) {
      managedError("managed_workspace_unavailable", "Managed workspace is not declared by the endpoint.", 404);
    }
  }

  function businessRequest(task: RecordValue) {
    return {
      requestId: task.requestId, ...(task.governance.requestedEndpointId ? { endpointId: task.governance.requestedEndpointId } : {}),
      capabilityId: task.capabilityId, ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}), input: task.input,
      ...(task.signature ? { signature: task.signature } : {})
    };
  }

  function governedInput(task: RecordValue) {
    return { ...businessRequest(task), ...task.governance.confirmation };
  }

  function publicPermission(permission: RecordValue | null) {
    if (!permission) return null;
    const { permissionId, taskId, state, prompt, selectedOptionId } = permission;
    return { permissionId, taskId, state, prompt, selectedOptionId };
  }

  function publicTask(task: RecordValue, workItem: RecordValue | null) {
    const state = workItem?.state === "completed" ? "succeeded"
      : workItem?.state === "in_doubt" ? "unknown"
      : workItem?.state || (task.admissionState === "cancelled" ? "cancelled" : "pending");
    return {
      taskId: task.taskId, requestId: task.requestId, tenantId: task.tenantId,
      organizationId: task.organizationId, endpointId: task.endpointId,
      capabilityId: task.capabilityId, capabilityRevision: task.capabilityRevision,
      workspaceId: task.workspaceId,
      input: task.input, ...(task.signature ? { signature: task.signature } : {}),
      requester: task.requester, workItemId: task.workItemId,
      state, cancelRequested: task.cancelRequested,
      result: task.result, errorCode: task.errorCode ||
        (workItem?.lastError?.type === "managed_policy_revoked" ? "managed_policy_revoked" : ""),
      createdAtMs: task.createdAtMs, updatedAtMs: task.updatedAtMs, terminalAtMs: task.terminalAtMs
    };
  }

  async function inspect(task: RecordValue) {
    const endpoint = store.getEndpoint(task.endpointId);
    assertSameOrg(endpoint, task.requester);
    const facet = await endpointQueue(endpoint);
    const inspection = await facet.remote.inspectWorkItem({ workItemId: task.workItemId });
    return { facet, workItem: inspection?.workItem || null };
  }

  async function getTask(actor: ManagedActor, taskId: string) {
    const task = store.getTask(assertManagedId(taskId, "taskId"));
    assertSameOrg(task, actor);
    const { workItem } = await inspect(task);
    return {
      task: publicTask(task, workItem),
      workItem: workItem ? {
        workItemId: workItem.workItemId, queueDefinitionId: workItem.queueDefinitionId,
        state: workItem.state, lease: workItem.lease ? {
          leaseId: workItem.lease.leaseId, leaseSeq: workItem.lease.leaseSeq, expiresAtMs: workItem.lease.expiresAtMs
        } : null, payloadRef: { taskId: task.taskId }
      } : null,
      pendingPermission: publicPermission(store.getPendingPermission(task.taskId, task.resultLeaseId))
    };
  }

  async function taskEvents(actor: ManagedActor, taskId: string, rawInput: RecordValue, { signal }: { signal?: AbortSignal } = {}) {
    const task = store.getTask(assertManagedId(taskId, "taskId"));
    assertSameOrg(task, actor);
    const input = assertManagedFields(rawInput || {}, ["after", "wait"]);
    const after = assertManagedInteger(input.after ?? 0, "after", 0, Number.MAX_SAFE_INTEGER);
    const waitMs = assertManagedInteger(input.wait ?? 0, "wait", 0, MANAGED_TASK_EVENTS_WAIT_MAX_MS / 1000) * 1000;
    let events = store.listTaskEvents(task.taskId, after, MANAGED_EVENT_MAX_COUNT);
    if (events.length === 0 && waitMs > 0 && !closed && !signal?.aborted) {
      const key = `task-events:${task.taskId}`;
      await wait(key, waitMs, wakeVersions.get(key) || 0, signal);
      events = store.listTaskEvents(task.taskId, after, MANAGED_EVENT_MAX_COUNT);
    }
    return { taskId: task.taskId, after, lastSeq: store.lastTaskEventSeq(task.taskId), events };
  }

  function validatePolicy(task: RecordValue) {
    const endpoint = store.getEndpoint(task.endpointId);
    assertSameOrg(endpoint, task.requester);
    const capability = capabilityFor(endpoint, task.capabilityId, task.input);
    workspaceFor(endpoint, task.workspaceId);
    if (capability.revision !== task.capabilityRevision) {
      managedError("managed_capability_revision_conflict", "Managed capability revision changed.", 409);
    }
    return { endpoint, capability };
  }

  async function requesterDecision(task: RecordValue) {
    if (!task.authority) managedError("managed_authority_required", "Managed requester authority is required.", 403);
    const decision = await authorityPort.revalidate(task.authority, governedInput(task));
    if (!decision.allowed || decision.revoked || canonicalJson(decision.actor) !== canonicalJson(task.requester) ||
        !decision.subject || !decision.context) {
      managedError("managed_authority_denied", "Managed requester authority is no longer authorized.", 403);
    }
    return decision;
  }

  async function ensureAdmitted(taskId: string) {
    let task = store.getTask(taskId);
    if (task.admissionState !== "pending") return;
    if (!task.authority) managedError("managed_authority_required", "Managed requester authority is required.", 403);
    if (task.cancelRequested) {
      patch(taskId, { admissionState: "cancelled" });
      return;
    }
    const endpoint = store.getEndpoint(task.endpointId);
    assertSameOrg(endpoint, task.requester);
    const facet = await endpointQueue(endpoint);
    task = store.getTask(taskId);
    const enqueued = await facet.enqueue({
      workItemId: taskId, dedupeKey: taskId, expiresAtMs: 0, payloadKind: "managed-task",
      payloadRef: { taskId }, ownerRef: { kind: "managed-endpoint", endpointId: task.endpointId },
      actor: { type: "managed-member", subjectId: task.requester.subjectId }
    });
    if (enqueued.workItem?.workItemId !== taskId) throw new Error("Managed queue admission identity mismatch.");
    patch(taskId, { admissionState: "admitted" });
    wake(task.endpointId);
  }

  function leaseInput(raw: RecordValue, extra: string[] = []): RecordValue & { taskId: string; leaseId: string; leaseSeq: number } {
    const input = assertManagedFields(raw, ["taskId", "leaseId", "leaseSeq", ...extra]);
    return {
      ...input, taskId: assertManagedId(input.taskId, "taskId"),
      leaseId: assertManagedId(input.leaseId, "leaseId", MANAGED_LEASE_ID_PATTERN),
      leaseSeq: assertManagedInteger(input.leaseSeq, "leaseSeq", 1, Number.MAX_SAFE_INTEGER)
    };
  }

  async function leasedTask(device: RecordValue, input: RecordValue, allowTerminal = false) {
    const endpoint = currentDevice(device);
    const task = store.getTask(input.taskId);
    assertSameOrg(task, { tenantId: endpoint.tenantId, organizationId: endpoint.organizationId, subjectId: "device" });
    if (task.endpointId !== endpoint.endpointId) managedError("managed_task_not_found", "Managed task does not exist for this device.", 404);
    const inspected = await inspect(task);
    currentDevice(device);
    const { workItem } = inspected;
    const boundLease = task.resultLeaseId === input.leaseId && task.resultLeaseSeq === input.leaseSeq;
    const queueLease = workItem?.lease?.leaseId === input.leaseId && workItem?.lease?.leaseSeq === input.leaseSeq;
    const terminal = ["completed", "failed", "cancelled"].includes(workItem?.state);
    if (!boundLease || (!queueLease && !(allowTerminal && terminal && task.outcomeState))) {
      managedError("managed_lease_conflict", "Managed lease generation is stale.", 409);
    }
    return { task, ...inspected };
  }

  function assertLive(task: RecordValue, workItem: RecordValue) {
    if (task.cancelRequested || task.outcomeState || workItem?.state !== "running" || workItem.lease?.expiresAtMs <= nowMs()) {
      managedError("managed_task_not_running", "Managed task is not authorized for a new effect.", 409);
    }
  }

  async function livePermission(device: RecordValue, permission: RecordValue) {
    try {
      const current = await leasedTask(device, permission);
      assertLive(current.task, current.workItem);
      validatePolicy(current.task);
      return current;
    } catch (error: any) {
      if ([
        "managed_lease_conflict", "managed_task_not_running", "managed_task_not_found",
        "managed_capability_not_allowed", "managed_capability_unpublished",
        "managed_capability_revision_conflict", "managed_task_input_invalid"
      ].includes(error.code)) return null;
      throw error;
    }
  }

  async function settle(taskId: string) {
    let task = store.getTask(taskId);
    if (!task.settlementPending) return;
    const { facet, workItem } = await inspect(task);
    if (!workItem) {
      if (task.admissionState !== "cancelled" || task.outcomeState !== "cancelled") {
        throw new Error("Managed result has no admitted queue item.");
      }
    } else if (task.outcomeState === "cancelled" && ["queued", "retry_wait"].includes(workItem.state)) {
      await facet.cancel({ workItemId: taskId, reason: "managed_task_cancelled" });
    } else if (["completed", "failed", "cancelled"].includes(workItem.state)) {
      const expected = task.outcomeState === "succeeded" ? "completed" : task.outcomeState;
      if (workItem.state !== expected) managedError("managed_task_outcome_conflict", "Managed task outcome conflicts with the queue.", 409);
    } else {
      if (workItem.lease?.leaseId !== task.resultLeaseId || workItem.lease?.leaseSeq !== task.resultLeaseSeq) {
        managedError("managed_lease_conflict", "Managed lease generation is stale.", 409);
      }
      const command = {
        workItemId: taskId, leaseId: task.resultLeaseId, leaseSeq: task.resultLeaseSeq,
        generation: task.resultLeaseSeq, result: task.result,
        effectId: `${taskId}:${task.resultLeaseSeq}:${task.outcomeState}`,
        actor: { type: "managed-device", subjectId: task.endpointId }
      };
      if (task.outcomeState === "unknown") {
        if (workItem.state !== "in_doubt") await facet.remote.markInDoubt({
          ...command, reason: "managed_outcome_unknown", error: { type: "unknown" }
        });
      } else {
        const sinkId = task.outcomeState === "succeeded" ? "complete" : task.outcomeState === "cancelled" ? "cancel" : "fail";
        await facet.remote.recordSinkReceipt({ ...command, sinkId });
        if (workItem.state === "in_doubt" || workItem.lease.expiresAtMs <= nowMs()) {
          if (workItem.state !== "in_doubt") await facet.remote.markInDoubt({ ...command, reason: "managed_result_after_lease" });
          await facet.remote.reconcileInDoubt(command);
        } else if (task.outcomeState === "succeeded") {
          await facet.remote.complete(command);
        } else if (task.outcomeState === "cancelled") {
          await facet.remote.cancelRunning({ ...command, reason: "managed_task_cancelled" });
        } else {
          await facet.remote.fail({ ...command, reason: "managed_task_failed", error: { type: "failed", code: task.errorCode } });
        }
      }
    }
    await authorityPort.release(task.authority, { taskId, state: task.outcomeState });
    task = patch(taskId, {
      settlementPending: false, deliveryPending: false, controlPending: false,
      terminalAtMs: task.outcomeState === "unknown" ? 0 : nowMs()
    });
  }

  async function recover(endpointId?: string) {
    await pages({ ...(endpointId ? { endpointId } : {}), admissionState: "cancelling" },
      (task) => cancelTask(task.requester, task.taskId).then(() => {}));
    await pages({ ...(endpointId ? { endpointId } : {}), admissionState: "pending" },
      (task) => exclusive(task.taskId, () => ensureAdmitted(task.taskId)));
    await pages({ ...(endpointId ? { endpointId } : {}), settlementPending: true },
      (task) => exclusive(task.taskId, () => settle(task.taskId)));
  }

  function ready() {
    readyPromise ??= recover().catch((error) => { readyPromise = undefined; throw error; });
    return readyPromise;
  }

  async function submitTask(actor: ManagedActor, rawInput: unknown, admissionContext: RecordValue = {}) {
    const request = assertManagedTaskRequest(rawInput);
    const requestDigest = store.requestDigest(request);
    const requester = { tenantId: actor.tenantId, organizationId: actor.organizationId, subjectId: actor.subjectId };
    const existing = store.getTaskByRequestId(actor.tenantId, actor.organizationId, request.requestId);
    const admission: { reservation?: { task: RecordValue; created: boolean } } = {};
    const proof = admissionContext.request?.__meshrixOperationProof;
    const sameRequest = existing && existing.requestDigest === requestDigest &&
      canonicalJson(existing.requester) === canonicalJson(requester);
    if (proof?.proof?.terminal === true) {
      const reusable = sameRequest && proof.status === "succeeded" &&
        Boolean(proof.pactium?.intentId) &&
        existing.governance?.proofIntentId === proof.pactium.intentId &&
        existing.admissionState !== "pending";
      admissionContext.onProofReplay?.(reusable ? "existing" : "rejected");
      if (!reusable) managedError("managed_request_conflict", "Managed request is already closed or its admission binding is unavailable.", 409);
      return { task: (await getTask(actor, existing.taskId)).task, idempotent: true };
    }
    if (existing) {
      if (!sameRequest) {
        managedError("managed_request_conflict", "Managed requestId is already bound to a different request.", 409);
      }
      admission.reservation = { task: existing, created: false };
    } else {
      const candidates = store.listEndpoints(actor.tenantId, actor.organizationId).filter((endpoint: RecordValue) =>
        endpoint.state === "active" && (!request.endpointId || request.endpointId === endpoint.endpointId));
      const eligible = candidates.filter((endpoint: RecordValue) => {
        try { capabilityFor(endpoint, request.capabilityId, request.input); workspaceFor(endpoint, request.workspaceId); return true; } catch { return false; }
      });
      if (!eligible.length) {
        if (request.endpointId && candidates.length) {
          capabilityFor(candidates[0], request.capabilityId, request.input);
          workspaceFor(candidates[0], request.workspaceId);
        }
        managedError("managed_capability_unavailable", "No active managed endpoint publishes that capability.", 404);
      }
      const selectionKey = canonicalJson([actor.tenantId, actor.organizationId, request.capabilityId]);
      const selection = request.endpointId ? 0 : selections.get(selectionKey) || 0;
      const endpoint = eligible[selection % eligible.length];
      if (!request.endpointId) selections.set(selectionKey, (selection + 1) % eligible.length);
      const capability = capabilityFor(endpoint, request.capabilityId, request.input);
      const taskId = `mtask_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const candidate = {
        taskId, requestId: request.requestId, requestDigest, tenantId: actor.tenantId,
        organizationId: actor.organizationId, endpointId: endpoint.endpointId,
        capabilityId: request.capabilityId, capabilityRevision: capability.revision,
        workspaceId: request.workspaceId || "", input: request.input,
        signature: request.signature || null,
        requester, queueDefinitionId: managedQueueDefinitionId(endpoint.endpointId), workItemId: taskId,
        governance: { requestedEndpointId: request.endpointId || "", confirmation: admissionContext.confirmation || {}, proofIntentId: proof?.pactium?.intentId || "" }
      };
      const authority = await authorityPort.capture({
        request: admissionContext.request, authSession: admissionContext.authSession,
        operation: admissionContext.operation, input: governedInput(candidate),
        persist: (authority) => {
          // Commit inside the live admission authority callback, before its
          // reservation is released, and before any asynchronous queue work.
          admissionContext.operationLock?.assertActive?.();
          const persisted = store.reserveTask({ ...candidate, authority }, nowMs());
          admission.reservation = persisted;
          return { taskId: persisted.task.taskId, created: persisted.created };
        }
      });
      if (!admission.reservation) managedError("managed_admission_incomplete", "Managed admission authority was not persisted.", 503);
      if (!admission.reservation.created && authority.kind === "console" &&
          authority.binding.authorityRef !== admission.reservation.task.authority?.binding.authorityRef) {
        await authorityPort.release(authority);
      }
    }
    const { task, created } = admission.reservation;
    await exclusive(task.taskId, () => ensureAdmitted(task.taskId));
    return { task: (await getTask(actor, task.taskId)).task, idempotent: !created };
  }

  async function cancelTask(actor: ManagedActor, taskId: string) {
    return exclusive(taskId, async () => {
      const task = store.getTask(taskId);
      assertSameOrg(task, actor);
      if (task.outcomeState && task.outcomeState !== "unknown") {
        await settle(taskId);
        return { task: (await getTask(actor, taskId)).task, idempotent: true };
      }
      // Record the cancellation before touching the asynchronous queue. A
      // restart retries this disposition from the existing admission index.
      store.transaction(() => {
        patch(taskId, { cancelRequested: true, admissionState: "cancelling" });
        store.invalidateTaskPermissions(taskId);
      });
      const { workItem } = await inspect(task);
      if (["completed", "failed", "cancelled"].includes(workItem?.state)) {
        patch(taskId, { admissionState: "admitted", controlPending: false });
        return { task: publicTask(task, workItem), idempotent: true };
      }
      // Cancellation is a durable request, never an immediate claim of
      // terminated work. Queued items settle at once; leased items are
      // notified to the device on its next poll and terminate only when the
      // device reports termination evidence.
      store.transaction(() => {
        const unlaunched = !workItem || ["queued", "retry_wait"].includes(workItem.state);
        patch(taskId, {
          admissionState: workItem ? "admitted" : "cancelled", controlPending: Boolean(workItem?.lease),
          ...(unlaunched ? {
            outcomeState: "cancelled", settlementPending: true,
            ...(!workItem ? { admissionState: "cancelled" } : {})
          } : {})
        });
      });
      if (workItem && ["queued", "retry_wait"].includes(workItem.state)) {
        await settle(taskId);
      } else if (!workItem) {
        await settle(taskId);
      }
      wake(task.endpointId);
      return { task: (await getTask(actor, taskId)).task, idempotent: false };
    });
  }

  function assignment(task: RecordValue, workItem: RecordValue) {
    return {
      protocol: MANAGED_ENDPOINT_PROTOCOL, taskId: task.taskId, endpointId: task.endpointId,
      organizationId: task.organizationId, capabilityId: task.capabilityId,
      capabilityRevision: task.capabilityRevision,
      ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}), input: task.input,
      leaseId: workItem.lease.leaseId, leaseSeq: workItem.lease.leaseSeq,
      ...(task.signature ? { signature: task.signature } : {})
    };
  }

  async function pollOnce(device: RecordValue, batchSize: number, leaseTimeoutMs: number, ack: string[]) {
    const endpoint = currentDevice(device);
    const facet = await endpointQueue(endpoint);
    // Queue claim is durable before the managed-store assignment binding.
    // Recover this gap by active queue identity, never a newest-task scan.
    let leaseCursor = "";
    for (;;) {
      const leased = await facet.remote.listLeased(leaseCursor);
      if (!leased.length) break;
      for (const workItem of leased) {
        await exclusive(workItem.workItemId, async () => {
          const task = store.getTask(workItem.workItemId);
          if (!task || task.endpointId !== endpoint.endpointId) throw new Error("Managed queue lease has no owned intent.");
          assertSameOrg(task, { tenantId: endpoint.tenantId, organizationId: endpoint.organizationId, subjectId: endpoint.endpointId });
          if (task.startAuthorized || task.outcomeState ||
              (task.resultLeaseId === workItem.lease.leaseId && task.resultLeaseSeq === workItem.lease.leaseSeq)) return;
          patch(task.taskId, {
            resultLeaseId: workItem.lease.leaseId, resultLeaseSeq: workItem.lease.leaseSeq,
            deliveryPending: !task.cancelRequested, controlPending: task.cancelRequested
          });
        });
      }
      leaseCursor = leased[leased.length - 1].workItemId;
    }
    const assignments: RecordValue[] = [];
    const controls: RecordValue[] = [];
    const permissionResolutions: RecordValue[] = [];
    for (const permissionId of ack) {
      const permission = store.getPermission(permissionId);
      if (!permission || permission.endpointId !== endpoint.endpointId || permission.state !== "resolved") continue;
      if (await livePermission(device, permission)) store.ackPermissionDelivered(permissionId);
    }
    await pages({ endpointId: endpoint.endpointId, controlPending: true }, async (task) => {
      const { workItem } = await inspect(task);
      if (workItem?.lease && workItem.lease.leaseSeq === task.resultLeaseSeq) {
        controls.push({ type: "cancel", taskId: task.taskId, leaseId: task.resultLeaseId, leaseSeq: task.resultLeaseSeq });
      }
    });
    let after = "";
    for (;;) {
      const permissions = store.listResolvedPermissionsForDevice(endpoint.endpointId, after);
      if (!permissions.length) break;
      for (const permission of permissions) {
        const current = await livePermission(device, permission);
        if (!current) continue;
        try { await requesterDecision(current.task); } catch (error: any) {
          if (error.code === "managed_authority_denied") continue;
          throw error;
        }
        permissionResolutions.push({
          permissionId: permission.permissionId, taskId: permission.taskId, leaseId: permission.leaseId,
          leaseSeq: permission.leaseSeq, resolution: { selectedOptionId: permission.selectedOptionId }
        });
        if (permissionResolutions.length >= 256) break;
      }
      if (permissionResolutions.length >= 256) break;
      after = permissions[permissions.length - 1].permissionId;
    }
    if (batchSize > 0) {
      await pages({ endpointId: endpoint.endpointId, deliveryPending: true }, async (task) => {
        if (assignments.length >= batchSize) return;
        const { workItem } = await inspect(task);
        if (workItem?.state !== "running" || workItem.lease?.expiresAtMs <= nowMs()) return;
        validatePolicy(task);
        assignments.push(assignment(task, workItem));
      });
      if (assignments.length < batchSize) {
        const claimed = await facet.remote.claim({ batchSize: batchSize - assignments.length, leaseTimeoutMs });
        for (const entry of claimed.claimed || []) {
          currentDevice(device);
          const workItem = entry.workItem || entry;
          const task = store.getTask(workItem.workItemId);
          if (!task) throw new Error("Managed queue admission has no durable intent.");
          try {
            validatePolicy(task);
            await requesterDecision(task);
          } catch (error: any) {
            if (!String(error.code || "").startsWith("managed_")) throw error;
            patch(task.taskId, {
              resultLeaseId: workItem.lease.leaseId, resultLeaseSeq: workItem.lease.leaseSeq,
              outcomeState: "failed", errorCode: "managed_policy_revoked", settlementPending: true
            });
            await settle(task.taskId);
            continue;
          }
          patch(task.taskId, {
            resultLeaseId: workItem.lease.leaseId, resultLeaseSeq: workItem.lease.leaseSeq, deliveryPending: true
          });
          assignments.push(assignment(task, workItem));
        }
      }
    }
    currentDevice(device);
    return { protocol: MANAGED_ENDPOINT_PROTOCOL, assignments, controls, permissionResolutions };
  }

  async function workerPoll(device: RecordValue, rawInput: RecordValue, { signal }: { signal?: AbortSignal } = {}) {
    const input = assertManagedFields(rawInput, ["batchSize", "waitMs", "leaseTimeoutMs", "acknowledgedPermissionIds"]);
    const batchSize = assertManagedInteger(input.batchSize ?? 1, "batchSize", 0, 8);
    const waitMs = assertManagedInteger(input.waitMs ?? 0, "waitMs", 0, MANAGED_WORKER_POLL_MAX_WAIT_MS);
    const leaseTimeoutMs = assertManagedInteger(input.leaseTimeoutMs ?? 30_000, "leaseTimeoutMs", 5_000, 300_000);
    const ack = input.acknowledgedPermissionIds ?? [];
    if (!Array.isArray(ack) || ack.length > 256 || new Set(ack).size !== ack.length) {
      managedError("managed_permission_invalid", "Managed permission acknowledgements are invalid.");
    }
    ack.forEach((id) => assertManagedId(id, "permissionId", MANAGED_REQUEST_ID_PATTERN));
    await recover(currentDevice(device).endpointId);
    const version = wakeVersions.get(device.endpointId) || 0;
    let result = await pollOnce(device, batchSize, leaseTimeoutMs, ack);
    if (!result.assignments.length && !result.controls.length && !result.permissionResolutions.length && waitMs > 0) {
      await wait(device.endpointId, waitMs, version, signal);
      if (!closed && !signal?.aborted) result = await pollOnce(device, batchSize, leaseTimeoutMs, []);
    }
    return result;
  }

  async function workerStart(device: RecordValue, rawInput: RecordValue) {
    const input = leaseInput(rawInput);
    return exclusive(input.taskId, async () => {
      const { task, workItem } = await leasedTask(device, input);
      const response = (authorized: boolean, cancelRequested: boolean) =>
        assertManagedTaskStartResponse({ ...input, authorized, cancelRequested });
      if (task.cancelRequested) return response(false, true);
      assertLive(task, workItem);
      const resource = () => {
        const current = store.getTask(task.taskId);
        currentDevice(device);
        if (current.cancelRequested) managedError("managed_task_cancelled", "Managed task cancellation was requested.", 409);
        const { endpoint, capability } = validatePolicy(current);
        return {
          taskId: current.taskId, endpointId: endpoint.endpointId, tenantId: endpoint.tenantId,
          organizationId: endpoint.organizationId, capabilityId: capability.capabilityId,
          capabilityRevision: capability.revision, generation: endpoint.generation,
          leaseId: input.leaseId, leaseSeq: input.leaseSeq
        };
      };
      const target = resource();
      const decision = await requesterDecision(task);
      if (task.startAuthorized) {
        resource();
        assertLive(store.getTask(task.taskId), workItem);
        return response(true, false);
      }
      const effect = { kind: "managed-endpoint-start", targetDigest: store.requestDigest(target) };
      const attempt = createFinalProtectedSinkAttempt({
        audience: "managed-endpoint-start", operationId: "endpoints.tasks.submit",
        subject: decision.subject, context: decision.context,
        requestDigest: digestFinalProtectedSinkInput(businessRequest(task)),
        targetSelector: target,
        proofRef: `managed-task:${task.taskId}`,
        authorization: { authorityBindingDigest: store.requestDigest(task.authority) },
        revalidateCurrentAuthority: async () => requesterDecision(store.getTask(task.taskId))
      });
      const startReceipt = await claimFinalProtectedSinkAttempt({
        attempt, targetSelector: target, effect, resourceRevision: store.requestDigest(target),
        resolveCurrentResource: async () => {
          const { task: current, workItem: live } = await leasedTask(device, input);
          assertLive(current, live);
          const currentTarget = resource();
          return {
            effect: { kind: effect.kind, targetDigest: store.requestDigest(currentTarget) },
            resourceRevision: store.requestDigest(currentTarget)
          };
        }
      });
      resource();
      patch(task.taskId, { startAuthorized: true, startReceipt, deliveryPending: false });
      return response(true, false);
    });
  }

  async function workerEvent(device: RecordValue, rawInput: RecordValue) {
    const input = leaseInput(rawInput, ["events"]);
    const events = assertManagedTaskEventBatch(input.events);
    return exclusive(input.taskId, async () => {
      const { task, facet } = await leasedTask(device, input);
      // The queue progress call is the lease-liveness signal, not the public
      // progress channel: it confirms the authorized execution is still alive
      // before the durable event batch is accepted.
      await facet.remote.progress({
        workItemId: task.taskId, leaseId: input.leaseId, leaseSeq: input.leaseSeq, progress: null,
        confirmRunning: task.startAuthorized && !task.outcomeState
      });
      const lastSeq = store.appendTaskEvents(task.taskId, events, MANAGED_EVENT_MAX_COUNT);
      wake(`task-events:${task.taskId}`);
      return { taskId: task.taskId, accepted: events.length, lastSeq };
    });
  }

  async function workerPermission(device: RecordValue, rawInput: RecordValue) {
    const input = leaseInput(rawInput, ["permissionId", "prompt"]);
    const permissionId = assertManagedId(input.permissionId, "permissionId", MANAGED_REQUEST_ID_PATTERN);
    const prompt = assertManagedJson(input.prompt, "prompt", "managed_permission_invalid", 16 * 1024) as RecordValue;
    if (!prompt || !Array.isArray(prompt.options) || !prompt.options.length || prompt.options.length > 64) {
      managedError("managed_permission_invalid", "Managed permission prompt is invalid.");
    }
    const options = prompt.options.map((option: RecordValue) => {
      if (!option || typeof option !== "object" || Array.isArray(option) ||
          typeof option.optionId !== "string" || !option.optionId.length || option.optionId.length > 160 ||
          /[\u0000-\u001f\u007f]/u.test(option.optionId)) {
        managedError("managed_permission_invalid", "Managed permission option is invalid.");
      }
      return option.optionId;
    });
    if (new Set(options).size !== options.length) managedError("managed_permission_invalid", "Managed permission options are duplicated.");
    return exclusive(input.taskId, async () => {
      const { task, workItem } = await leasedTask(device, input);
      assertLive(task, workItem);
      validatePolicy(task);
      await requesterDecision(task);
      const existing = store.getPermission(permissionId);
      if (existing) {
        if (existing.taskId !== task.taskId || existing.endpointId !== task.endpointId ||
            existing.leaseId !== input.leaseId || existing.leaseSeq !== input.leaseSeq ||
            canonicalJson(existing.prompt) !== canonicalJson(prompt)) {
          managedError("managed_permission_conflict", "Managed permission prompt conflicts with its recorded identity.", 409);
        }
        return { permission: publicPermission(existing), idempotent: true };
      }
      const permission = store.createPermission({
        permissionId, taskId: task.taskId, tenantId: task.tenantId, organizationId: task.organizationId,
        endpointId: task.endpointId, leaseId: input.leaseId, leaseSeq: input.leaseSeq, prompt
      }, nowMs());
      wake(task.endpointId);
      return { permission: publicPermission(permission), idempotent: false };
    });
  }

  async function resolvePermission(actor: ManagedActor, taskId: string, rawInput: RecordValue) {
    const input = assertManagedFields(rawInput, ["permissionId", "selectedOptionId"]);
    return exclusive(taskId, async () => {
      const task = store.getTask(taskId);
      assertSameOrg(task, actor);
      const permission = store.getPermission(assertManagedId(input.permissionId, "permissionId", MANAGED_REQUEST_ID_PATTERN));
      if (!permission || permission.taskId !== taskId) managedError("managed_permission_not_found", "Managed permission prompt does not exist.", 404);
      const { workItem } = await inspect(task);
      assertLive(task, workItem);
      if (permission.leaseId !== workItem.lease?.leaseId || permission.leaseSeq !== workItem.lease?.leaseSeq) {
        managedError("managed_lease_conflict", "Managed lease generation is stale.", 409);
      }
      validatePolicy(task);
      await requesterDecision(task);
      if (!permission.prompt.options.some((option: RecordValue) => option.optionId === input.selectedOptionId)) {
        managedError("managed_permission_option_invalid", "Managed permission option is not part of the prompt.", 409);
      }
      if (permission.state !== "pending") {
        if (permission.selectedOptionId !== input.selectedOptionId) managedError("managed_permission_conflict", "Managed permission resolution conflicts.", 409);
        return { permission: publicPermission(permission), idempotent: true };
      }
      store.resolvePermission(permission.permissionId, input.selectedOptionId, actor, nowMs());
      wake(task.endpointId);
      return { permission: publicPermission(store.getPermission(permission.permissionId)), idempotent: false };
    });
  }

  async function workerComplete(device: RecordValue, rawOutcome: unknown) {
    const outcome = assertManagedTaskOutcome(rawOutcome);
    return exclusive(outcome.taskId, async () => {
      const { task, workItem } = await leasedTask(device, outcome, true);
      // Completion replay: identical task+lease+outcome is idempotent; any
      // conflicting payload or mismatched lease/organization identity fails.
      const recorded = {
        taskId: task.taskId, leaseId: task.resultLeaseId, leaseSeq: task.resultLeaseSeq,
        state: task.outcomeState, result: task.result, ...(task.errorCode ? { errorCode: task.errorCode } : {})
      };
      if (task.outcomeState && canonicalJson(recorded) !== canonicalJson(outcome)) {
        managedError("managed_task_outcome_conflict", "Managed task outcome conflicts with the recorded result.", 409);
      }
      const unstartedCancellation = task.cancelRequested && outcome.state === "cancelled";
      const unstartedFailure = outcome.state === "failed";
      if (!task.outcomeState && ((!task.startAuthorized && !unstartedCancellation && !unstartedFailure) ||
          !["running", "in_doubt"].includes(workItem?.state))) {
        managedError("managed_task_not_running", "Managed task was not authorized to start.", 409);
      }
      // Durable result bound to task + lease generation BEFORE the terminal
      // queue acknowledgement; a lost ACK replays idempotently instead of
      // launching a second effect.
      if (!task.outcomeState) store.transaction(() => {
        patch(task.taskId, {
          outcomeState: outcome.state, result: outcome.result, errorCode: outcome.errorCode || "", settlementPending: true
        });
        store.invalidateTaskPermissions(task.taskId);
      });
      await settle(task.taskId);
      return { task: (await getTask(task.requester, task.taskId)).task, idempotent: Boolean(task.outcomeState) };
    });
  }

  function workerSignaturePolicy(device: RecordValue) {
    const endpoint = currentDevice(device);
    return { policy: store.getSignaturePolicy(endpoint.tenantId, endpoint.organizationId) };
  }

  return {
    ready, wake, publicPermission, submitTask, getTask, taskEvents, cancelTask, resolvePermission,
    workerPoll, workerStart, workerEvent, workerPermission, workerComplete, workerSignaturePolicy,
    async cancelEndpointTasks(actor: ManagedActor, endpointId: string) {
      await pages({ endpointId }, (task) => cancelTask(actor, task.taskId).then(() => {}));
    },
    async close() {
      closed = true;
      for (const endpointId of waiters.keys()) wake(endpointId);
      await Promise.allSettled([...locks.values()]);
      selections.clear();
    }
  };
}
