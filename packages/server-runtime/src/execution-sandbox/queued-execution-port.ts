import crypto from "node:crypto";

import { sandboxDigest } from "#meshrix/foundation/execution-sandbox/contracts";

export const SANDBOX_EXECUTION_PORT_ID: any = "SandboxExecutionPort";

const QUEUE_DEFINITION_ID: any = "platform.sandbox-execution";
const QUEUE_DEFINITION_VERSION: any = 1;
const MAX_PENDING_EXECUTIONS: any = 4096;
const QUEUE_SCOPE: Readonly<Record<string, any>> = Object.freeze({ tenantId: "", workspaceId: "", projectId: "" });

function combinedSignal(left?: any, right?: any) : any {
  const signals: any = [left, right].filter((signal?: any) : any => signal instanceof AbortSignal);
  if (signals.length === 0) return null;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function queueIdentity(kind?: any, request?: any) : any {
  const digest: any = sandboxDigest({ kind, request });
  const dispatchRef: any = crypto.randomUUID();
  return Object.freeze({
    contextRef: digest,
    workItemId: `sandbox-work:${digest.slice(0, 32)}:${dispatchRef}`,
    dedupeKey: `sandbox-execution:${digest}:${dispatchRef}`
  });
}

function terminalAction(receipt?: any) : any {
  if (receipt?.runtimeState === "cancelled") return "cancelled";
  if (receipt?.runtimeState === "timed_out") return "failed";
  return receipt?.status === "failed" || receipt?.status === "denied" ? "failed" : "completed";
}

export async function createQueuedSandboxExecutionPort({
  broker,
  queueApplicationPort,
  maxInFlight = 64
}: Record<string, any> = {}) : Promise<any> {
  if (!broker || typeof broker.execute !== "function" || typeof broker.recover !== "function") {
    throw new TypeError("Queued sandbox execution requires the canonical broker.");
  }
  if (!queueApplicationPort || typeof queueApplicationPort.registerQueue !== "function") {
    throw new TypeError("Queued sandbox execution requires the canonical queue application port.");
  }
  const pending: any = new Map<any, any>();
  let closing: any = false;
  const queue: any = await queueApplicationPort.registerQueue({
    queueDefinitionId: QUEUE_DEFINITION_ID,
    queueDefinitionVersion: QUEUE_DEFINITION_VERSION,
    label: "Controlled sandbox execution",
    ownerCapability: "platform.controlled-execution",
    metadata: {
      lifecycleStateOwner: "queue-application-port",
      executionStateOwner: "sandbox-execution-broker"
    },
    policy: {
      policyVersion: "meshrix.sandbox-execution-queue-policy/1",
      maxInFlight,
      maxAttempts: 1
    },
    scope: QUEUE_SCOPE,
    workerId: "platform-sandbox-execution-worker",
    maxInFlight,
    batchSize: Math.min(16, maxInFlight),
    onTerminal: ({ workItem }: Record<string, any>) : any => {
      const record: any = pending.get(String(workItem?.payloadRef?.contextRef || ""));
      if (!record || record.settled) return;
      record.settled = true;
      pending.delete(record.contextRef);
      record.reject(Object.assign(new Error("Sandbox execution queue reached a terminal state."), {
        code: "sandbox_execution_queue_terminal"
      }));
    },
    handler: async ({ workItem }: Record<string, any>, context?: any) : Promise<any> => {
      const contextRef: any = String(workItem?.payloadRef?.contextRef || "");
      const record: any = pending.get(contextRef);
      if (!record || record.settled) {
        return { action: "failed", reason: "sandbox_execution_context_unavailable" };
      }
      try {
        const receipt: any = await record.task(context.signal);
        record.settled = true;
        pending.delete(contextRef);
        record.resolve(receipt);
        return { action: terminalAction(receipt), reason: String(receipt?.reasonCode || "sandbox_execution_terminal") };
      } catch (error: any) {
        record.settled = true;
        pending.delete(contextRef);
        record.reject(error);
        return { action: "failed", reason: "sandbox_execution_failed" };
      }
    }
  });

  async function dispatch(kind?: any, request?: any, task?: any, deadlineAt: any = "") : Promise<any> {
    if (closing) throw new Error("Sandbox execution port is closing.");
    const identity: any = queueIdentity(kind, request);
    const existing: any = pending.get(identity.contextRef);
    if (existing) return existing.promise;
    if (pending.size >= MAX_PENDING_EXECUTIONS) {
      throw Object.assign(new Error("Sandbox execution queue capacity is exhausted."), {
        code: "sandbox_execution_queue_capacity_exhausted"
      });
    }
    let resolve: any;
    let reject: any;
    const promise: any = new Promise((resolvePromise?: any, rejectPromise?: any) : any => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const record: Record<string, any> = { ...identity, promise, resolve, reject, task, settled: false };
    pending.set(identity.contextRef, record);
    try {
      const parsedDeadline: any = Date.parse(String(deadlineAt || ""));
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
        policyVersion: "meshrix.sandbox-execution-queue-policy/1"
      });
      void queue.requestDispatch().catch((error?: any) : any => {
        if (record.settled) return;
        record.settled = true;
        pending.delete(identity.contextRef);
        reject(error);
      });
    } catch (error: any) {
      pending.delete(identity.contextRef);
      record.settled = true;
      reject(error);
    }
    return promise;
  }

  const execute: any = (request?: any, options: Record<string, any> = {}) : any => dispatch(
    "execute",
    request,
    (queueSignal?: any) : any => broker.execute(request, {
      ...options,
      signal: combinedSignal(options.signal, queueSignal)
    }),
    request?.deadlineAt
  );
  const executeConfigured: any = (request?: any, resolveInput?: any, options: Record<string, any> = {}) : any => dispatch(
    "executeConfigured",
    request,
    (queueSignal?: any) : any => broker.executeConfigured(request, resolveInput, {
      ...options,
      signal: combinedSignal(options.signal, queueSignal)
    }),
    request?.deadlineAt
  );
  const executeOpaque: any = (request?: any, opaqueInputs: any = [], options: Record<string, any> = {}) : any => dispatch(
    "executeOpaque",
    request,
    (queueSignal?: any) : any => broker.executeOpaque(request, opaqueInputs, {
      ...options,
      signal: combinedSignal(options.signal, queueSignal)
    }),
    request?.deadlineAt
  );
  const executeConfiguredOpaque: any = (request?: any, opaqueInputs: any = [], options: Record<string, any> = {}) : any => dispatch(
    "executeConfiguredOpaque",
    request,
    (queueSignal?: any) : any => broker.executeConfiguredOpaque(request, opaqueInputs, {
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
    async cancel(reference?: any, options: Record<string, any> = {}) : Promise<any> {
      const brokerCancelled: any = await broker.cancel(reference, options);
      const queueRecord: any = [...pending.values()].find((record?: any) : any =>
        record.workItemId === reference || record.contextRef === reference
      );
      const queueCancelled: any = queueRecord
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
    async close() : Promise<any> {
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

export const SANDBOX_EXECUTION_QUEUE_DEFINITION_ID: any = QUEUE_DEFINITION_ID;
