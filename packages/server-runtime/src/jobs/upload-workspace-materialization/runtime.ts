import type { CreateUploadWorkspaceMaterializationOptions } from "./engine.ts";
import type {
  MaterializationAuthorityPort, MaterializationClosedAdmissionInput, MaterializationDurableState,
  MaterializationFaultObserver, MaterializationOwner, MaterializationRequestRecord,
  MaterializationResolvedOperation, MaterializationResourcePort, MaterializationStoreCreateResult,
  MaterializationTransactionStore, MaterializationWorkspacePort, MaterializationWorkspaceSession
} from "./model.ts";

import {
  createUploadWorkspaceMaterialization,
  materializationFailureDisposition
} from "./engine.ts";
import {
  createUploadWorkspaceMaterializationTransactionStore
} from "./transaction-store.ts";
import {
  DEFINITION_ID,
  DEFINITION_VERSION,
  MATERIALIZATION_MAX_ATTEMPTS,
  MAX_RECONCILE_BATCH,
  boundedId,
  closedAdmissionInput,
  digest,
  exactDescriptor,
  exactKeys,
  failure,
  normalizeLogicalTarget,
  normalizedOwner,
  requestReference,
  sameDescriptor,
  sha256Digest,
  text
} from "./model.ts";

/**
 * Feature runtime for governed upload-workspace materialization.
 *
 * This module owns queue registration, deduplicated admission, the ordered
 * restart reconciliation batch, execution wiring, cancellation and the
 * queue/store lifetime. Composition only obtains concrete ports, injects them
 * here, and returns the resulting runtime.
 */

export interface MaterializationQueueFacet {
  enqueue(input: {
    dedupeKey: string;
    maxAttempts: number;
    ownerRef: { capability: string; subjectRef: string };
    payloadKind: string;
    payloadRef: { requestRef: string };
    schedulingScope: { workspaceId: string };
    workItemId: string;
  }): Promise<unknown>;
  cancel(input: {
    actor: { system: string };
    operationId: string;
    reason: string;
    workItemId: string;
  }): Promise<unknown>;
  requestDispatch(): Promise<unknown>;
  close(): Promise<unknown>;
}

interface MaterializationQueueRegistration {
  batchSize: number;
  label: string;
  maxInFlight: number;
  ownerCapability: string;
  queueDefinitionId: string;
  queueDefinitionVersion: number;
  scope: { tenantId: string; workspaceId: string };
  workerId: string;
  handler(input: {
    workItem: {
      workItemId: string;
      payloadRef: { requestRef: string };
      attempt: number;
      maxAttempts: number;
    };
  }, context: {
    lease: { leaseSeq: number };
    signal: AbortSignal;
    renewLease(input: { reason: string }): Promise<unknown>;
  }): Promise<{ action: "retry" | "completed"; reason: string; delayMs?: number }>;
}

export interface MaterializationSubmitInput {
  request: unknown;
  authSession: unknown;
  operation: MaterializationResolvedOperation;
  input: unknown;
}

export interface CreateMaterializationRuntimeOptions {
  userDataPath: string;
  queueApplicationPort: {
    registerQueue(input: MaterializationQueueRegistration): Promise<MaterializationQueueFacet>;
  };
  privateWorkspaceMaterializationPort: {
    withRequest<T>(
      binding: Readonly<Pick<MaterializationRequestRecord,
        "bindingDigest" | "expectedWorkspaceRevision" | "logicalTarget" | "requestRef" | "workspaceId"
      > & { byteCount: number; contentDigest: string; operationId: string }>,
      task: (workspace: MaterializationWorkspaceSession) => T | Promise<T>
    ): Promise<T>;
  };
  uploadSessionStore: {
    resolveUploadSessionFiles(id: string, input: { owner: MaterializationOwner }): Promise<unknown>;
  };
  uploadCustodyReadPort: CreateUploadWorkspaceMaterializationOptions["custodyReadPort"];
  deferredProtectedSinkAuthorityPort: MaterializationAuthorityPort & {
    capture(input: Omit<MaterializationSubmitInput, "input"> & {
      input: MaterializationClosedAdmissionInput;
    }): Promise<Pick<MaterializationRequestRecord,
      "approvalIntentDigest" | "authorityBindingDigest" | "authorityRef" | "requestDigest"
    >>;
    revoke(input: { authorityRef: string; reason: string }): Promise<unknown>;
  };
  resolveOperation: CreateUploadWorkspaceMaterializationOptions["resolveOperation"];
  operationAuditStore: CreateUploadWorkspaceMaterializationOptions["auditPort"];
  operationProofSubstrate: CreateUploadWorkspaceMaterializationOptions["proofPort"];
  transactionStore?: MaterializationTransactionStore | null;
  faultInjector?: MaterializationFaultObserver | null;
}

const RUNTIME_FAULT_SCHEMAS: Readonly<Record<string, Readonly<Record<string, "integer" | "id" | "digest">>>> = Object.freeze({
  afterQueueClaim: Object.freeze({
    leaseSequence: "integer",
    requestRef: "id"
  }),
  afterTransactionCompletedBeforeQueueAck: Object.freeze({
    leaseSequence: "integer",
    requestRef: "id"
  }),
  afterTransactionCreatedBeforeEnqueue: Object.freeze({
    bindingDigest: "digest",
    requestRef: "id"
  })
});

function validRuntimeFaultValue(value: unknown, kind: string): boolean {
  if (kind === "integer") {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 768 &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    (kind !== "digest" || /^[a-f0-9]{64}$/u.test(value))
  );
}

async function invokeRuntimeFault(observer: MaterializationFaultObserver | null, callbackName: string, input: Record<string, string | number>): Promise<Readonly<Record<string, string | number>>> {
  const schema = RUNTIME_FAULT_SCHEMAS[callbackName];
  if (
    !schema ||
    !exactKeys(input, Object.keys(schema)) ||
    Object.entries(schema).some(
      ([key, kind]) => !validRuntimeFaultValue(input[key], kind)
    )
  ) {
    throw failure(
      "materialization_fault_payload_invalid",
      500,
      "Materialization runtime fault payload is invalid."
    );
  }
  const bounded: Readonly<Record<string, string | number>> = Object.freeze({ ...input });
  await observer?.[callbackName]?.(bounded);
  return bounded;
}

export async function createUploadWorkspaceMaterializationRuntime({
  userDataPath,
  queueApplicationPort,
  privateWorkspaceMaterializationPort,
  uploadSessionStore,
  uploadCustodyReadPort,
  deferredProtectedSinkAuthorityPort,
  resolveOperation,
  operationAuditStore,
  operationProofSubstrate,
  transactionStore = null,
  faultInjector = null
}: CreateMaterializationRuntimeOptions) {
  const requiredPorts: Array<readonly [object, readonly string[], string]> = [
    [
      privateWorkspaceMaterializationPort,
      ["withRequest"],
      "privateWorkspaceMaterializationPort"
    ],
    [
      queueApplicationPort,
      ["registerQueue"],
      "queueApplicationPort"
    ],
    [
      uploadSessionStore,
      ["resolveUploadSessionFiles"],
      "uploadSessionStore"
    ],
    [uploadCustodyReadPort, ["open"], "uploadCustodyReadPort"],
    [
      deferredProtectedSinkAuthorityPort,
      ["capture", "revalidate", "revoke"],
      "deferredProtectedSinkAuthorityPort"
    ]
  ];
  for (const [value, methods, label] of requiredPorts) {
    for (const method of methods) {
      if (!value || typeof Reflect.get(value, method) !== "function") {
        throw new TypeError(`${label}.${method} is required.`);
      }
    }
  }
  if (
    typeof resolveOperation !== "function" ||
    typeof operationAuditStore?.appendIdempotent !== "function" ||
    typeof operationAuditStore?.getById !== "function" ||
    typeof operationProofSubstrate?.beginLifecycle !== "function" ||
    typeof operationProofSubstrate?.finishLifecycle !== "function"
  ) {
    throw new TypeError(
      "Materialization authority and evidence dependencies are required."
    );
  }
  const store: MaterializationTransactionStore =
    transactionStore ||
    createUploadWorkspaceMaterializationTransactionStore({
      userDataPath
    });
  const ownsStore = !transactionStore;
  for (const method of [
    "assertFence",
    "begin",
    "cancelQueued",
    "complete",
    "create",
    "fail",
    "get",
    "listReconcileCandidates",
    "markRollbackIncomplete",
    "recordAuditFinalized",
    "recordEvidencePending",
    "recordPrecommitCleaned",
    "recordPreimage",
    "recordProofFinalized",
    "recordPublicationIntent",
    "recordPublicationPrepared",
    "recordPublished",
    "recordTempReserved",
    "renew",
    "retryAfterLease",
    "terminalFail"
  ]) {
    if (typeof Reflect.get(store, method) !== "function") {
      if (ownsStore) store.close();
      throw new TypeError(`transactionStore.${method} is required.`);
    }
  }
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const activeOperations = new Set<Promise<unknown>>();

  function runOperation<T>(task: () => T | Promise<T>): Promise<T> {
    if (closing) {
      return Promise.reject(failure(
        "materialization_provider_closing", 503, "Materialization provider is closing."
      ));
    }
    const operation = Promise.resolve().then(task);
    activeOperations.add(operation);
    void operation.then(
      () => activeOperations.delete(operation),
      () => activeOperations.delete(operation)
    );
    return operation;
  }

  async function resolveCurrentDescriptor({ record, owner }: Parameters<MaterializationResourcePort["resolveCurrentDescriptor"]>[0]) {
    const files =
      await uploadSessionStore.resolveUploadSessionFiles(
        record.uploadSessionId,
        { owner }
      );
    const descriptor = exactDescriptor(
      files,
      record.uploadSessionId
    );
    if (!sameDescriptor(descriptor, record.descriptor)) {
      throw failure(
        "materialization_descriptor_changed",
        409,
        "Upload custody descriptor changed."
      );
    }
    return Object.freeze({
      descriptor,
      resourceRevision: digest(descriptor)
    });
  }

  const workspacePort: MaterializationWorkspacePort = {
    async withRequest(record, task) {
      if (typeof task !== "function") {
        throw new TypeError(
          "Workspace materialization request task is required."
        );
      }
      const descriptor = exactDescriptor(
        [{
          byteSize: record?.descriptor?.byteCount,
          contentDigest: record?.descriptor?.contentDigest,
          custodyRef: record?.descriptor?.custodyRef,
          envelopeDigest: record?.descriptor?.envelopeDigest,
          custodyState: record?.descriptor?.state
        }],
        record?.uploadSessionId
      );
      const binding = Object.freeze({
        bindingDigest: sha256Digest(
          record?.bindingDigest,
          "Materialization binding digest"
        ),
        byteCount: descriptor.byteCount,
        contentDigest: descriptor.contentDigest,
        expectedWorkspaceRevision: boundedId(
          record?.expectedWorkspaceRevision,
          "Expected workspace revision"
        ),
        logicalTarget: normalizeLogicalTarget(
          record?.logicalTarget
        ),
        operationId: boundedId(
          record?.operationId,
          "Materialization operation"
        ),
        requestRef: boundedId(
          record?.requestRef,
          "Materialization request reference"
        ),
        workspaceId: boundedId(
          record?.workspaceId,
          "Workspace identity"
        )
      });
      return privateWorkspaceMaterializationPort.withRequest(
        binding,
        (bound) => task(bound)
      );
    }
  };

  let engine: ReturnType<typeof createUploadWorkspaceMaterialization>;
  try {
    engine = createUploadWorkspaceMaterialization({
      authorityPort: deferredProtectedSinkAuthorityPort,
      custodyReadPort: uploadCustodyReadPort,
      resourcePort: {
        resolveCurrentDescriptor
      },
      workspacePort,
      transactionStore: store,
      resolveOperation,
      auditPort: operationAuditStore,
      proofPort: operationProofSubstrate,
      faultObserver: faultInjector
    });
  } catch (error: unknown) {
    if (ownsStore) store.close();
    throw error;
  }

  let queue: MaterializationQueueFacet | undefined;
  try {
    queue = await queueApplicationPort.registerQueue({
      batchSize: 4,
      handler: async ({ workItem }, context) => {
        if (closing) {
          return {
            action: "retry",
            reason: "materialization_provider_closing"
          };
        }
        const requestRef = text(workItem?.payloadRef?.requestRef);
        try {
          await invokeRuntimeFault(faultInjector, "afterQueueClaim", {
            leaseSequence: Number(context?.lease?.leaseSeq || 0),
            requestRef
          });
          await engine.execute({
            ownerFence:
              `${workItem.workItemId}:${context.lease.leaseSeq}`,
            renewLease: async () => {
              await context.renewLease({ reason: "materialization_lease_heartbeat" });
            },
            requestRef,
            signal: context.signal
          });
          await invokeRuntimeFault(
            faultInjector,
            "afterTransactionCompletedBeforeQueueAck",
            {
              leaseSequence: Number(context?.lease?.leaseSeq || 0),
              requestRef
            }
          );
          const settled = await store.retryAfterLease(requestRef);
          if (!settled.terminal) {
            return {
              action: "retry",
              delayMs: settled.delayMs,
              reason: "materialization_transaction_pending"
            };
          }
          return {
            action: "completed",
            reason: `materialization_${settled.status}`
          };
        } catch (error: unknown) {
          const disposition =
            materializationFailureDisposition(error);
          let settled = await store.retryAfterLease(requestRef);
          if (settled.terminal) {
            return {
              action: "completed",
              reason: `materialization_${settled.status}`
            };
          }
          if (error !== null && typeof error === "object" && "abrupt" in error && error.abrupt === true) {
            return {
              action: "retry",
              delayMs: settled.delayMs,
              reason: disposition.code
            };
          }
          const exhausted =
            Number(workItem?.attempt || 0) >=
            Number(workItem?.maxAttempts || 1);
          if (!disposition.retryable || exhausted) {
            const terminal = await store.terminalFail(requestRef, {
              code: disposition.code
            });
            settled = await store.retryAfterLease(requestRef);
            if (terminal.terminal && settled.terminal) {
              return {
                action: "completed",
                reason: disposition.code
              };
            }
            if (settled.terminal) {
              return {
                action: "completed",
                reason: `materialization_${settled.status}`
              };
            }
          }
          return {
            action: "retry",
            delayMs: settled.delayMs,
            reason: disposition.code
          };
        }
      },
      label: "meshrix.jobs.upload-workspace-materialization",
      maxInFlight: 4,
      ownerCapability: "platform.job-workflow",
      queueDefinitionId: DEFINITION_ID,
      queueDefinitionVersion: DEFINITION_VERSION,
      scope: {
        tenantId: "platform",
        workspaceId: "governed"
      },
      workerId: "upload-workspace-materialization-worker"
    });
    for (const method of [
      "cancel",
      "close",
      "enqueue",
      "requestDispatch"
    ]) {
      if (typeof (queue && Reflect.get(queue, method)) !== "function") {
        throw new TypeError(`queue.${method} is required.`);
      }
    }
  } catch (error: unknown) {
    await queue?.close();
    if (ownsStore) store.close();
    throw error;
  }

  async function enqueue(
    record: MaterializationRequestRecord,
    { requestDispatch = true }: { requestDispatch?: boolean } = {}
  ): Promise<void> {
    const requestRef = boundedId(
      record?.requestRef,
      "Materialization request reference"
    );
    const bindingDigest = sha256Digest(
      record?.bindingDigest,
      "Materialization binding digest"
    );
    const workspaceId = boundedId(
      record?.workspaceId,
      "Workspace identity"
    );
    await queue!.enqueue({
      dedupeKey: requestRef,
      maxAttempts: MATERIALIZATION_MAX_ATTEMPTS,
      ownerRef: {
        capability: "platform.job-workflow",
        subjectRef: digest(requestRef)
      },
      payloadKind: "upload_workspace_materialization",
      payloadRef: {
        requestRef
      },
      schedulingScope: {
        workspaceId
      },
      workItemId: `materialization-work:${bindingDigest}`
    });
    if (requestDispatch) {
      void Promise.resolve()
        .then(() => queue!.requestDispatch())
        .catch(() => null);
    }
  }

  async function reconcilePendingRequests(): Promise<void> {
    let afterRequestRef = "";
    let reconciled = false;
    for (;;) {
      const records = await store.listReconcileCandidates({
        afterRequestRef,
        limit: MAX_RECONCILE_BATCH
      });
      if (!Array.isArray(records)) {
        throw new TypeError(
          "transactionStore.listReconcileCandidates must return an array."
        );
      }
      if (records.length > MAX_RECONCILE_BATCH) {
        throw new TypeError(
          "transactionStore.listReconcileCandidates exceeded its limit."
        );
      }
      for (const record of records) {
        const requestRef = boundedId(
          record?.requestRef,
          "Materialization request reference"
        );
        if (requestRef <= afterRequestRef) {
          throw new TypeError(
            "transactionStore.listReconcileCandidates is not ordered."
          );
        }
        await enqueue(record, { requestDispatch: false });
        afterRequestRef = requestRef;
        reconciled = true;
      }
      if (records.length < MAX_RECONCILE_BATCH) break;
    }
    if (reconciled) {
      void Promise.resolve()
        .then(() => queue!.requestDispatch())
        .catch(() => null);
    }
  }

  try {
    await reconcilePendingRequests();
  } catch (error: unknown) {
    closing = true;
    await queue!.close();
    if (ownsStore) store.close();
    throw error;
  }

  function publicAdmission(record: MaterializationRequestRecord | MaterializationDurableState, { deduped = false } = {}) {
    return Object.freeze({
      accepted: true,
      deduped,
      requestRef: record.requestRef,
      ...("status" in record && record.status === "completed"
        ? {
            result: Object.freeze({
              ...record.result,
              replayed: true,
              status: "completed"
            })
          }
        : {})
    });
  }

  const operations = {
    async submit({
      request,
      authSession,
      operation,
      input
    }: MaterializationSubmitInput) {
      if (
        operation?.id !==
        "jobs.upload_workspace_materialize"
      ) {
        throw failure(
          "materialization_operation_invalid",
          400,
          "Materialization operation is invalid."
        );
      }
      const closedInput = closedAdmissionInput(input);
      const owner = normalizedOwner(authSession);
      const requestRef = requestReference(closedInput, owner);
      const existing = await store.get(requestRef);
      if (existing?.status === "completed") {
        return publicAdmission(existing, { deduped: true });
      }
      if (existing?.status === "cancelled") {
        throw failure(
          "materialization_cancelled",
          409,
          "Materialization request was cancelled."
        );
      }
      if (existing?.status === "failed") {
        throw failure(
          "materialization_terminal_failed",
          409,
          "Materialization request is terminal."
        );
      }
      if (existing) {
        await enqueue(existing);
        return publicAdmission(existing, { deduped: true });
      }
      const files =
        await uploadSessionStore.resolveUploadSessionFiles(
          closedInput.uploadSessionId,
          { owner }
        );
      const descriptor = exactDescriptor(
        files,
        closedInput.uploadSessionId
      );
      const captured =
        await deferredProtectedSinkAuthorityPort.capture({
          authSession,
          input: closedInput,
          operation,
          request
        });
      const resourceRevision = digest(descriptor);
      const bindingDigest = digest({
        authorityBindingDigest:
          captured.authorityBindingDigest,
        descriptor,
        expectedWorkspaceRevision:
          closedInput.expectedWorkspaceRevision,
        logicalTarget: closedInput.logicalTarget,
        operationId: "jobs.upload_workspace_materialize",
        requestDigest: captured.requestDigest,
        requestRef,
        uploadSessionId: closedInput.uploadSessionId,
        workspaceId: closedInput.workspaceId
      });
      const record: MaterializationRequestRecord = Object.freeze({
        approvalIntentDigest:
          captured.approvalIntentDigest,
        authorityBindingDigest:
          captured.authorityBindingDigest,
        authorityRef: captured.authorityRef,
        bindingDigest,
        descriptor,
        expectedWorkspaceRevision:
          closedInput.expectedWorkspaceRevision,
        logicalTarget: closedInput.logicalTarget,
        operationId: "jobs.upload_workspace_materialize",
        requestDigest: captured.requestDigest,
        requestRef,
        resourceRevision,
        uploadSessionId: closedInput.uploadSessionId,
        workspaceId: closedInput.workspaceId
      });
      let created: MaterializationStoreCreateResult;
      try {
        created = await store.create(record);
      } catch (error: unknown) {
        await Promise.resolve()
          .then(() =>
            deferredProtectedSinkAuthorityPort.revoke({
              authorityRef: captured.authorityRef,
              reason: "materialization_admission_failed"
            })
          )
          .catch(() => null);
        throw error;
      }
      if (created.inserted !== true) {
        await deferredProtectedSinkAuthorityPort.revoke({
          authorityRef: captured.authorityRef,
          reason: "materialization_admission_race"
        });
        const raced = await store.get(requestRef);
        if (!raced) {
          throw failure(
            "materialization_admission_failed",
            500,
            "Materialization admission failed."
          );
        }
        if (raced.status === "cancelled") {
          throw failure(
            "materialization_cancelled",
            409,
            "Materialization request was cancelled."
          );
        }
        if (raced.status === "failed") {
          throw failure(
            "materialization_terminal_failed",
            409,
            "Materialization request is terminal."
          );
        }
        if (raced.status !== "completed") {
          await enqueue(raced);
        }
        return publicAdmission(raced, { deduped: true });
      }
      await invokeRuntimeFault(
        faultInjector,
        "afterTransactionCreatedBeforeEnqueue",
        {
          bindingDigest: record.bindingDigest,
          requestRef: record.requestRef
        }
      );
      await enqueue(record);
      return publicAdmission(record);
    },
    get(requestRef: string) {
      return engine.get(requestRef);
    },
    async cancel(requestRef: string, { subject }: { subject?: unknown } = {}) {
      const record = await store.get(requestRef);
      if (!record) return null;
      let expectedRef: string;
      try {
        expectedRef = requestReference(
          {
            expectedWorkspaceRevision:
              record.expectedWorkspaceRevision,
            logicalTarget: record.logicalTarget,
            uploadSessionId: record.uploadSessionId,
            workspaceId: record.workspaceId
          },
          normalizedOwner(subject)
        );
      } catch {
        return null;
      }
      if (expectedRef !== requestRef) return null;
      if (
        ["cancelled", "completed", "failed"].includes(
          record.status
        )
      ) {
        return Object.freeze({
          requestRef,
          stage: record.stage,
          status: record.status
        });
      }
      await queue!.cancel({
        actor: {
          system: "platform-job-workflow"
        },
        operationId:
          "jobs.upload_workspace_materialization_cancel",
        reason: "workspace_materialization_cancelled",
        workItemId:
          `materialization-work:${record.bindingDigest}`
      });
      await store.cancelQueued(requestRef);
      const cancelled = await store.get(requestRef);
      return cancelled ? Object.freeze({
        requestRef,
        stage: cancelled.stage,
        status: cancelled.status
      }) : null;
    }
  };

  return Object.freeze({
    submit(input: MaterializationSubmitInput) {
      return runOperation(() => operations.submit(input));
    },
    get(requestRef: string) {
      return runOperation(() => operations.get(requestRef));
    },
    cancel(requestRef: string, input?: { subject?: unknown }) {
      return runOperation(() => operations.cancel(requestRef, input));
    },
    close(): Promise<void> {
      if (!closePromise) {
        closing = true;
        closePromise = (async () => {
          await Promise.allSettled([...activeOperations]);
          await queue!.close();
          if (ownsStore) store.close();
        })().catch((error: unknown) => {
          closePromise = undefined;
          throw error;
        });
      }
      return closePromise;
    }
  });
}
