import {
  assertAgentWorkspaceMaterializationPort
} from "#meshrix/agents/agent-workspace/agent-workspace-materialization-port";
import {
  createUploadWorkspaceMaterialization,
  createUploadWorkspaceMaterializationTransactionStore,
  materializationFailureDisposition
} from "../jobs/upload-workspace-materialization/index.ts";
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
} from "../jobs/upload-workspace-materialization/model.ts";

const PROVIDER_FAULT_SCHEMAS: Readonly<Record<string, any>> = Object.freeze({
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

function validProviderFaultValue(value?: any, kind?: any) : any {
  if (kind === "integer") {
    return Number.isSafeInteger(value) && value >= 0;
  }
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 768 &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    (kind !== "digest" || /^[a-f0-9]{64}$/u.test(value))
  );
}

async function invokeProviderFault(observer?: any, callbackName?: any, input?: any) : Promise<any> {
  const schema: any = PROVIDER_FAULT_SCHEMAS[callbackName];
  if (
    !schema ||
    !exactKeys(input, Object.keys(schema)) ||
    (Object.entries(schema) as [string, any][]).some(
      ([key, kind]: any[]) : any => !validProviderFaultValue(input[key], kind)
    )
  ) {
    throw failure(
      "materialization_fault_payload_invalid",
      500,
      "Materialization provider fault payload is invalid."
    );
  }
  const bounded: Readonly<Record<string, any>> = Object.freeze({ ...input });
  await observer?.[callbackName]?.(bounded);
  return bounded;
}

export async function createUploadWorkspaceMaterializationProvider({
  userDataPath,
  queueApplicationPort,
  workspaceMaterializationPort,
  uploadSessionStore,
  uploadCustodyReadPort,
  deferredProtectedSinkAuthorityPort,
  resolveOperation,
  operationAuditStore,
  operationProofSubstrate,
  transactionStore = null,
  faultInjector = null
}: Record<string, any> = {}) : Promise<any> {
  const privateWorkspaceMaterializationPort: any =
    assertAgentWorkspaceMaterializationPort(
      workspaceMaterializationPort
    );
  for (const [value, methods, label] of [
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
  ]) {
    for (const method of methods) {
      if (typeof value?.[method] !== "function") {
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
  const store: any =
    transactionStore ||
    createUploadWorkspaceMaterializationTransactionStore({
      userDataPath
    });
  const ownsStore: any = !transactionStore;
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
    if (typeof store?.[method] !== "function") {
      if (ownsStore) store.close();
      throw new TypeError(`transactionStore.${method} is required.`);
    }
  }
  let closing: any = false;

  async function resolveCurrentDescriptor({ record, owner }: Record<string, any>) : Promise<any> {
    const files: any =
      await uploadSessionStore.resolveUploadSessionFiles(
        record.uploadSessionId,
        { owner }
      );
    const descriptor: any = exactDescriptor(
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

  const workspacePort = Object.freeze({
    withRequest(record?: any, task?: any) : any {
      if (typeof task !== "function") {
        throw new TypeError(
          "Workspace materialization request task is required."
        );
      }
      const descriptor: any = exactDescriptor(
        [{
          byteSize: record?.descriptor?.byteCount,
          contentDigest: record?.descriptor?.contentDigest,
          custodyRef: record?.descriptor?.custodyRef,
          envelopeDigest: record?.descriptor?.envelopeDigest,
          custodyState: record?.descriptor?.state
        }],
        record?.uploadSessionId
      );
      const binding: Readonly<Record<string, any>> = Object.freeze({
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
        (bound?: any) : any => task(bound)
      );
    }
  });

  let engine: any;
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
  } catch (error: any) {
    if (ownsStore) store.close();
    throw error;
  }

  let queue: any;
  try {
    queue = await queueApplicationPort.registerQueue({
    batchSize: 4,
    handler: async ({ workItem }: Record<string, any>, context?: any) : Promise<any> => {
      if (closing) {
        return {
          action: "retry",
          reason: "materialization_provider_closing"
        };
      }
      const requestRef: any = text(workItem?.payloadRef?.requestRef);
      try {
        await invokeProviderFault(faultInjector, "afterQueueClaim", {
          leaseSequence: Number(context?.lease?.leaseSeq || 0),
          requestRef
        });
        await engine.execute({
          ownerFence:
            `${workItem.workItemId}:${context.lease.leaseSeq}`,
          renewLease: () : any =>
            context.renewLease({
              reason: "materialization_lease_heartbeat"
            }),
          requestRef,
          signal: context.signal
        });
        await invokeProviderFault(
          faultInjector,
          "afterTransactionCompletedBeforeQueueAck",
          {
            leaseSequence: Number(context?.lease?.leaseSeq || 0),
            requestRef
          }
        );
        const settled: any = await store.retryAfterLease(requestRef);
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
      } catch (error: any) {
        const disposition: any =
          materializationFailureDisposition(error);
        let settled: any = await store.retryAfterLease(requestRef);
        if (settled.terminal) {
          return {
            action: "completed",
            reason: `materialization_${settled.status}`
          };
        }
        if (error?.abrupt === true) {
          return {
            action: "retry",
            delayMs: settled.delayMs,
            reason: disposition.code
          };
        }
        const exhausted: any =
          Number(workItem?.attempt || 0) >=
          Number(workItem?.maxAttempts || 1);
        if (!disposition.retryable || exhausted) {
          const terminal: any = await store.terminalFail(requestRef, {
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
      if (typeof queue?.[method] !== "function") {
        throw new TypeError(`queue.${method} is required.`);
      }
    }
  } catch (error: any) {
    await Promise.resolve()
      .then(() : any => queue?.close?.({ timeoutMs: 0 }))
      .catch(() : any => null);
    if (ownsStore) store.close();
    throw error;
  }

  async function enqueue(
    record?: any,
    { requestDispatch = true }: Record<string, any> = {}
  ) : Promise<any> {
    const requestRef: any = boundedId(
      record?.requestRef,
      "Materialization request reference"
    );
    const bindingDigest: any = sha256Digest(
      record?.bindingDigest,
      "Materialization binding digest"
    );
    const workspaceId: any = boundedId(
      record?.workspaceId,
      "Workspace identity"
    );
    await queue.enqueue({
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
        .then(() : any => queue.requestDispatch())
        .catch(() : any => null);
    }
  }

  async function reconcilePendingRequests() : Promise<any> {
    let afterRequestRef: any = "";
    let reconciled: any = false;
    for (;;) {
      const records: any = await store.listReconcileCandidates({
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
        const requestRef: any = boundedId(
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
        .then(() : any => queue.requestDispatch())
        .catch(() : any => null);
    }
  }

  try {
    await reconcilePendingRequests();
  } catch (error: any) {
    closing = true;
    await Promise.resolve()
      .then(() : any => queue.close({ timeoutMs: 0 }))
      .catch(() : any => null);
    if (ownsStore) store.close();
    throw error;
  }

  function publicAdmission(record?: any, { deduped = false }: Record<string, any> = {}) : any {
    return Object.freeze({
      accepted: true,
      deduped,
      requestRef: record.requestRef,
      ...(record.status === "completed"
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

  return Object.freeze({
    async submit({
      request,
      authSession,
      operation,
      input
    }: Record<string, any> = {}) : Promise<any> {
      if (closing) {
        throw failure(
          "materialization_provider_closing",
          503,
          "Materialization provider is closing."
        );
      }
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
      const closedInput: any = closedAdmissionInput(input);
      const owner: any = normalizedOwner(authSession);
      const requestRef: any = requestReference(closedInput, owner);
      const existing: any = await store.get(requestRef);
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
      const files: any =
        await uploadSessionStore.resolveUploadSessionFiles(
          closedInput.uploadSessionId,
          { owner }
        );
      const descriptor: any = exactDescriptor(
        files,
        closedInput.uploadSessionId
      );
      const captured: any =
        await deferredProtectedSinkAuthorityPort.capture({
          authSession,
          input: closedInput,
          operation,
          request
        });
      const resourceRevision: any = digest(descriptor);
      const bindingDigest: any = digest({
        authorityBindingDigest:
          captured.authorityBindingDigest,
        descriptor,
        expectedWorkspaceRevision:
          closedInput.expectedWorkspaceRevision,
        logicalTarget: closedInput.logicalTarget,
        operationId: operation.id,
        requestDigest: captured.requestDigest,
        requestRef,
        uploadSessionId: closedInput.uploadSessionId,
        workspaceId: closedInput.workspaceId
      });
      const record: Readonly<Record<string, any>> = Object.freeze({
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
        operationId: operation.id,
        requestDigest: captured.requestDigest,
        requestRef,
        resourceRevision,
        uploadSessionId: closedInput.uploadSessionId,
        workspaceId: closedInput.workspaceId
      });
      let created: any;
      try {
        created = await store.create(record);
      } catch (error: any) {
        await Promise.resolve()
          .then(() : any =>
            deferredProtectedSinkAuthorityPort.revoke({
              authorityRef: captured.authorityRef,
              reason: "materialization_admission_failed"
            })
          )
          .catch(() : any => null);
        throw error;
      }
      if (created.inserted !== true) {
        await deferredProtectedSinkAuthorityPort.revoke({
          authorityRef: captured.authorityRef,
          reason: "materialization_admission_race"
        });
        const raced: any = await store.get(requestRef);
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
      await invokeProviderFault(
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
    get(requestRef?: any) : any {
      return engine.get(requestRef);
    },
    async cancel(requestRef?: any, { subject }: Record<string, any> = {}) : Promise<any> {
      const record: any = await store.get(requestRef);
      if (!record) return null;
      let expectedRef: any;
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
      await queue.cancel({
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
      const cancelled: any = await store.get(requestRef);
      return Object.freeze({
        requestRef,
        stage: cancelled.stage,
        status: cancelled.status
      });
    },
    async close() : Promise<any> {
      if (closing) return;
      closing = true;
      try {
        await queue.close({ timeoutMs: 30_000 });
      } finally {
        if (ownsStore) store.close();
      }
    }
  });
}
