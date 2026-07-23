import crypto from "node:crypto";

import { sandboxDigest } from "#lico/foundation/execution-sandbox/contracts";

export const SANDBOX_EXECUTION_PORT_ID = "SandboxExecutionPort";

const QUEUE_DEFINITION_ID = "platform.sandbox-execution";
const QUEUE_DEFINITION_VERSION = 1;
const MAX_PENDING_EXECUTIONS = 4096;
const QUEUE_SCOPE = Object.freeze({ tenantId: "", workspaceId: "", projectId: "" });

function combinedSignal(left, right) {
  const signals = [left, right].filter((signal) => signal instanceof AbortSignal);
  if (signals.length === 0) return null;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function queueIdentity(kind, request) {
  const digest = sandboxDigest({ kind, request });
  const dispatchRef = crypto.randomUUID();
  return Object.freeze({
    contextRef: digest,
    workItemId: `sandbox-work:${digest.slice(0, 32)}:${dispatchRef}`,
    dedupeKey: `sandbox-execution:${digest}:${dispatchRef}`
  });
}

function terminalAction(receipt) {
  if (receipt?.runtimeState === "cancelled") return "cancelled";
  if (receipt?.runtimeState === "timed_out") return "failed";
  return receipt?.status === "failed" || receipt?.status === "denied" ? "failed" : "completed";
}

export async function createQueuedSandboxExecutionPort({
  broker,
  queueApplicationPort,
  maxInFlight = 64
} = {}) {
  if (!broker || typeof broker.execute !== "function" || typeof broker.recover !== "function") {
    throw new TypeError("Queued sandbox execution requires the canonical broker.");
  }
  if (!queueApplicationPort || typeof queueApplicationPort.registerQueue !== "function") {
    throw new TypeError("Queued sandbox execution requires the canonical queue application port.");
  }
  const pending = new Map();
  let closing = false;
  const queue = await queueApplicationPort.registerQueue({
    queueDefinitionId: QUEUE_DEFINITION_ID,
    queueDefinitionVersion: QUEUE_DEFINITION_VERSION,
    label: "Controlled sandbox execution",
    ownerCapability: "platform.controlled-execution",
    metadata: {
      lifecycleStateOwner: "queue-application-port",
      executionStateOwner: "sandbox-execution-broker"
    },
    policy: {
      policyVersion: "licomesh.sandbox-execution-queue-policy/1",
      maxInFlight,
      maxAttempts: 1
    },
    scope: QUEUE_SCOPE,
    workerId: "platform-sandbox-execution-worker",
    maxInFlight,
    batchSize: Math.min(16, maxInFlight),
    onTerminal: ({ workItem }) => {
      const record = pending.get(String(workItem?.payloadRef?.contextRef || ""));
      if (!record || record.settled) return;
      record.settled = true;
      pending.delete(record.contextRef);
      record.reject(Object.assign(new Error("Sandbox execution queue reached a terminal state."), {
        code: "sandbox_execution_queue_terminal"
      }));
    },
    handler: async ({ workItem }, context) => {
      const contextRef = String(workItem?.payloadRef?.contextRef || "");
      const record = pending.get(contextRef);
      if (!record || record.settled) {
        return { action: "failed", reason: "sandbox_execution_context_unavailable" };
      }
      try {
        const receipt = await record.task(context.signal);
        record.settled = true;
        pending.delete(contextRef);
        record.resolve(receipt);
        return { action: terminalAction(receipt), reason: String(receipt?.reasonCode || "sandbox_execution_terminal") };
      } catch (error) {
        record.settled = true;
        pending.delete(contextRef);
        record.reject(error);
        return { action: "failed", reason: "sandbox_execution_failed" };
      }
    }
  });

  async function dispatch(kind, request, task, deadlineAt = "") {
    if (closing) throw new Error("Sandbox execution port is closing.");
    const identity = queueIdentity(kind, request);
    const existing = pending.get(identity.contextRef);
    if (existing) return existing.promise;
    if (pending.size >= MAX_PENDING_EXECUTIONS) {
      throw Object.assign(new Error("Sandbox execution queue capacity is exhausted."), {
        code: "sandbox_execution_queue_capacity_exhausted"
      });
    }
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const record = { ...identity, promise, resolve, reject, task, settled: false };
    pending.set(identity.contextRef, record);
    try {
      const parsedDeadline = Date.parse(String(deadlineAt || ""));
      await queue.enqueue({
        schedulingScope: QUEUE_SCOPE,
        dedupeKey: identity.dedupeKey,
        workItemId: identity.workItemId,
        payloadRef: Object.freeze({ kind, contextRef: identity.contextRef }),
        payloadKind: "sandbox_execution",
        ownerRef: { capability: "platform.controlled-execution" },
        maxAttempts: 1,
        ...(Number.isFinite(parsedDeadline) ? { expiresAtMs: parsedDeadline } : {}),
        actor: { system: "sandbox-execution-port" },
        reason: "sandbox_execution_queued",
        policyVersion: "licomesh.sandbox-execution-queue-policy/1"
      });
      void queue.requestDispatch().catch((error) => {
        if (record.settled) return;
        record.settled = true;
        pending.delete(identity.contextRef);
        reject(error);
      });
    } catch (error) {
      pending.delete(identity.contextRef);
      record.settled = true;
      reject(error);
    }
    return promise;
  }

  const execute = (request, options = {}) => dispatch(
    "execute",
    request,
    (queueSignal) => broker.execute(request, {
      ...options,
      signal: combinedSignal(options.signal, queueSignal)
    }),
    request?.deadlineAt
  );
  const executeConfigured = (request, resolveInput, options = {}) => dispatch(
    "executeConfigured",
    request,
    (queueSignal) => broker.executeConfigured(request, resolveInput, {
      ...options,
      signal: combinedSignal(options.signal, queueSignal)
    }),
    request?.deadlineAt
  );
  const executeOpaque = (request, opaqueInputs = [], options = {}) => dispatch(
    "executeOpaque",
    request,
    (queueSignal) => broker.executeOpaque(request, opaqueInputs, {
      ...options,
      signal: combinedSignal(options.signal, queueSignal)
    }),
    request?.deadlineAt
  );
  const executeConfiguredOpaque = (request, opaqueInputs = [], options = {}) => dispatch(
    "executeConfiguredOpaque",
    request,
    (queueSignal) => broker.executeConfiguredOpaque(request, opaqueInputs, {
      ...options,
      signal: combinedSignal(options.signal, queueSignal)
    }),
    request?.deadlineAt
  );

  return Object.freeze({
    id: SANDBOX_EXECUTION_PORT_ID,
    execute,
    executeConfigured,
    executeOpaque,
    executeConfiguredOpaque,
    async cancel(reference, options = {}) {
      const brokerCancelled = await broker.cancel(reference, options);
      const queueRecord = [...pending.values()].find((record) =>
        record.workItemId === reference || record.contextRef === reference
      );
      const queueCancelled = queueRecord
        ? await queue.cancel({ workItemId: queueRecord.workItemId, reason: "sandbox_execution_cancelled" })
        : null;
      return brokerCancelled || queueCancelled?.cancelled === true;
    },
    getStatus: broker.getStatus,
    getReceipt: broker.getReceipt,
    resolveQuarantinedOutput: broker.resolveQuarantinedOutput,
    disposeOutput: broker.disposeOutput,
    recover: broker.recover,
    configurationState: broker.configurationState,
    publicAvailability: broker.publicAvailability,
    administrativeAvailability: broker.administrativeAvailability,
    requiredBackendRestrictions: broker.requiredBackendRestrictions,
    async close() {
      closing = true;
      await queue.close();
      for (const record of pending.values()) {
        if (!record.settled) record.reject(new Error("Sandbox execution port closed."));
      }
      pending.clear();
      await broker.close();
    }
  });
}

export const SANDBOX_EXECUTION_QUEUE_DEFINITION_ID = QUEUE_DEFINITION_ID;
