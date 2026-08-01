import crypto from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  claimFinalProtectedSinkAttempt,
  createFinalProtectedSinkAttempt
} from "#meshrix/foundation/security/final-protected-sink-permit";

export const UPLOAD_WORKSPACE_MATERIALIZATION_SCHEMA_VERSION: any =
  "v0.0.1:jobs:upload-workspace-materialization-3";
export const UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID: any =
  "jobs.upload_workspace_materialize";

const RECOVERY_STAGES: any = new Set<any>([
  "publication_intent",
  "temp_reserved",
  "publication_prepared",
  "published",
  "evidence_pending",
  "audit_finalized",
  "proof_finalized"
]);
const PRECOMMIT_RECOVERY_STAGES: any = new Set<any>([
  "publication_intent",
  "temp_reserved",
  "publication_prepared"
]);
const COMMITTED_STAGES: any = new Set<any>([
  "published",
  "evidence_pending",
  "audit_finalized",
  "proof_finalized"
]);
const LINEAGE_AMBIGUITY_CODES: any = new Set<any>([
  "materialization_parent_identity_mismatch",
  "materialization_path_invalid",
  "materialization_target_changed",
  "materialization_target_identity_mismatch",
  "materialization_target_unsafe"
]);
const TERMINAL_FAILURE_CODES: any = new Set<any>([
  "deferred_protected_sink_authority_changed",
  "deferred_protected_sink_authority_denied",
  "deferred_protected_sink_authority_unavailable",
  "materialization_binding_invalid",
  "materialization_cancelled",
  "materialization_descriptor_changed",
  "materialization_descriptor_invalid",
  "materialization_fault_payload_invalid",
  "materialization_owner_denied",
  "materialization_parent_identity_mismatch",
  "materialization_path_invalid",
  "materialization_platform_unsupported",
  "materialization_preimage_conflict",
  "materialization_preimage_incomplete",
  "materialization_publication_wal_invalid",
  "materialization_publication_wal_mismatch",
  "materialization_revision_uninitialized",
  "materialization_rollback_incomplete",
  "materialization_stale_revision",
  "materialization_target_changed",
  "materialization_target_exists",
  "materialization_target_identity_mismatch",
  "materialization_target_not_missing",
  "materialization_target_unsafe",
  "materialization_upload_digest_mismatch",
  "upload_custody_read_denied"
]);

function digest(value?: any) : any {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function text(value?: any) : any {
  return String(value || "").trim();
}

function failure(code?: any, statusCode?: any, message?: any) : any {
  return Object.assign(new Error(message), { code, statusCode });
}

function requireMethod(port?: any, method?: any, label?: any) : any {
  if (typeof port?.[method] !== "function") {
    throw new TypeError(`${label}.${method} is required.`);
  }
}

function closedInput(record?: any) : any {
  return Object.freeze({
    expectedWorkspaceRevision: record.expectedWorkspaceRevision,
    logicalTarget: record.logicalTarget,
    safetyConfirm: true,
    uploadSessionId: record.uploadSessionId,
    workspaceId: record.workspaceId
  });
}

function ownerFromAuthority(authority?: any) : any {
  const subjectId: any = text(authority?.subject?.subjectId);
  const tenantId: any = text(authority?.subject?.tenantId);
  if (!subjectId || !tenantId) {
    throw failure(
      "materialization_owner_denied",
      403,
      "Current materialization owner is unavailable."
    );
  }
  return Object.freeze({
    subjectId,
    tenantId,
    userId: subjectId
  });
}

function publicResult(value: Record<string, any> = {}, replayed: any = false) : any {
  return Object.freeze({
    schemaVersion: UPLOAD_WORKSPACE_MATERIALIZATION_SCHEMA_VERSION,
    status: "completed",
    replayed,
    requestRef: value.requestRef,
    contentDigest: value.contentDigest,
    byteCount: Number(value.byteCount),
    workspaceRevision: value.workspaceRevision,
    checkpointRef: value.checkpointRef,
    auditRef: value.auditRef || "",
    proofRef: value.proofRef || ""
  });
}

const FAULT_SCHEMAS: Readonly<Record<string, any>> = Object.freeze({
  afterFinalPermitConsumed: Object.freeze({
    bindingDigest: "digest",
    requestRef: "id",
    resourceRevision: "digest"
  }),
  afterPublicationIntentBeforeCustodyOpen: Object.freeze({
    intentDigest: "digest",
    publicationId: "id",
    requestRef: "id",
    stateOperationId: "id"
  }),
  afterDirectoryWorkerBoundBeforeReserve: Object.freeze({
    intentDigest: "digest",
    publicationId: "id",
    requestRef: "id",
    stateOperationId: "id"
  }),
  afterTempInodeReservedBeforeWal: Object.freeze({
    intentDigest: "digest",
    publicationId: "id",
    requestRef: "id",
    stateOperationId: "id"
  }),
  afterTempReservedBeforeFirstWrite: Object.freeze({
    publicationId: "id",
    requestRef: "id",
    reservationDigest: "digest",
    stateOperationId: "id"
  }),
  afterFirstChunkWrittenBeforeContinue: Object.freeze({
    copiedBytes: "integer",
    publicationId: "id",
    requestRef: "id",
    stateOperationId: "id"
  }),
  afterPublicationPreparedBeforeLink: Object.freeze({
    proofDigest: "digest",
    publicationId: "id",
    requestRef: "id",
    stateOperationId: "id"
  }),
  afterPublicationLinkedBeforeTempUnlink: Object.freeze({
    proofDigest: "digest",
    publicationId: "id",
    requestRef: "id",
    stateOperationId: "id"
  }),
  afterPublishedFileDurableBeforeStateCommit: Object.freeze({
    proofDigest: "digest",
    publicationId: "id",
    requestRef: "id",
    stateOperationId: "id"
  }),
  afterStateAndCheckpointDurableBeforeReceipt: Object.freeze({
    checkpointRef: "id",
    proofDigest: "digest",
    publicationId: "id",
    publishedRevision: "id",
    requestRef: "id",
    stateOperationId: "id"
  }),
  afterPrecommitCleanupBeforeRecord: Object.freeze({
    publicationId: "id",
    requestRef: "id",
    reservationDigest: "optional-digest"
  }),
  afterWorkspacePublish: Object.freeze({
    bindingDigest: "digest",
    publishedRevision: "id",
    requestRef: "id"
  }),
  afterEvidencePending: Object.freeze({
    requestRef: "id",
    settlementDigest: "digest"
  }),
  afterAuditWriteBeforeRecord: Object.freeze({
    auditId: "id",
    requestRef: "id",
    settlementDigest: "digest"
  }),
  afterAuditFinalizedRecord: Object.freeze({
    auditId: "id",
    requestRef: "id",
    settlementDigest: "digest"
  }),
  afterProofWriteBeforeRecord: Object.freeze({
    proofLedgerEventId: "id",
    requestRef: "id",
    settlementDigest: "digest"
  }),
  afterProofFinalizedRecord: Object.freeze({
    proofLedgerEventId: "id",
    requestRef: "id",
    settlementDigest: "digest"
  })
});

function boundedFaultValue(value?: any, kind?: any) : any {
  if (kind === "integer") {
    return Number.isSafeInteger(value) && Number(value) >= 0;
  }
  if (kind === "optional-digest" && value === "") return true;
  if (typeof value !== "string") return false;
  if (
    !value ||
    value.length > 768 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  return !kind.endsWith("digest") ||
    /^[a-f0-9]{64}$/u.test(value);
}

export async function invokeMaterializationFault(
  faultObserver?: any,
  callbackName?: any,
  input?: any
) : Promise<any> {
  const schema: any = FAULT_SCHEMAS[callbackName];
  const invalid: any = () : any => failure(
    "materialization_fault_payload_invalid",
    500,
    `Materialization fault payload for ${callbackName} is invalid.`
  );
  if (
    !schema ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw invalid();
  }
  const expectedKeys: any = Object.keys(schema).sort();
  const actualKeys: any = Object.keys(input).sort();
  if (
    expectedKeys.join("\0") !== actualKeys.join("\0") ||
    expectedKeys.some(
      (key?: any) : any => !boundedFaultValue(input[key], schema[key])
    )
  ) {
    throw invalid();
  }
  const bounded: Readonly<Record<string, any>> = Object.freeze({ ...input });
  await faultObserver?.[callbackName]?.(bounded);
  return bounded;
}

function createPublicationIntent(execution?: any) : any {
  const target: any = execution.target || {};
  const stateEventAnchor: any =
    execution.preimage?.stateEventAnchor ||
    execution.preimage?.snapshot?.stateEventAnchor ||
    target.anchor;
  const eventHash: any = text(stateEventAnchor?.eventHash)
    .replace(/^sha256:/u, "");
  if (
    !/^[a-f0-9]{64}$/u.test(eventHash) ||
    !Number.isSafeInteger(Number(stateEventAnchor?.offset)) ||
    !target.parentIdentity ||
    !target.parentFingerprint ||
    !target.targetStateDigest
  ) {
    throw failure(
      "materialization_preimage_incomplete",
      500,
      "Workspace publication preimage is incomplete."
    );
  }
  const base: Readonly<Record<string, any>> = Object.freeze({
    byteCount: execution.descriptor.byteCount,
    contentDigest: execution.descriptor.contentDigest,
    logicalTargetDigest: digest(execution.logicalTarget),
    parentFingerprint: target.parentFingerprint,
    parentIdentity: target.parentIdentity,
    preparedIdentity: null,
    priorRevision: execution.expectedWorkspaceRevision,
    proofDigest: "",
    publicationId:
      `materialization-publication:${crypto.randomUUID()}`,
    reservationDigest: "",
    stateEventAnchor: Object.freeze({
      offset: Number(stateEventAnchor.offset),
      eventHash
    }),
    stateOperationId:
      `${execution.operationId}.state:${crypto.randomUUID()}`,
    targetStateDigest: target.targetStateDigest,
    tempLeafRef:
      `.meshrix-materialization-${crypto.randomUUID()}`
  });
  const intentDigest: any = digest({
    version:
      "v0.0.1:agent-workspace:materialization-publication-intent-2",
    publicationId: base.publicationId,
    tempLeafRef: base.tempLeafRef,
    stateOperationId: base.stateOperationId,
    priorRevision: base.priorRevision,
    stateEventAnchor: base.stateEventAnchor,
    logicalTargetDigest: base.logicalTargetDigest,
    parentFingerprint: base.parentFingerprint,
    parentIdentity: base.parentIdentity,
    targetStateDigest: base.targetStateDigest,
    contentDigest: base.contentDigest,
    byteCount: base.byteCount
  });
  return Object.freeze({ ...base, intentDigest });
}

function publicationFaultPayload(
  callbackName?: any,
  requestRef?: any,
  publication?: any
) : any {
  if (callbackName === "afterTempReservedBeforeFirstWrite") {
    return {
      publicationId: publication.publicationId,
      requestRef,
      reservationDigest: publication.reservationDigest,
      stateOperationId: publication.stateOperationId
    };
  }
  const digestKey: any = callbackName.includes("Intent") ||
    callbackName.includes("DirectoryWorker") ||
    callbackName.includes("TempInode")
    ? "intentDigest"
    : "proofDigest";
  return {
    [digestKey]: publication[digestKey],
    publicationId: publication.publicationId,
    requestRef,
    stateOperationId: publication.stateOperationId
  };
}

function validatePublishedReceipt(execution?: any, receipt?: any) : any {
  const publication: any = execution.publication;
  if (
    receipt?.contentDigest !== execution.descriptor.contentDigest ||
    Number(receipt?.byteCount) !== execution.descriptor.byteCount ||
    !receipt?.workspaceRevision ||
    !receipt?.checkpointRef ||
    !receipt?.publishedIdentity ||
    receipt.beforeRevision !== execution.expectedWorkspaceRevision ||
    receipt.publishedRevision !== receipt.workspaceRevision ||
    receipt.publicationId !== publication?.publicationId ||
    receipt.stateOperationId !== publication?.stateOperationId ||
    receipt.proofDigest !== publication?.proofDigest ||
    canonicalJson(receipt.publishedIdentity) !==
      canonicalJson(publication?.preparedIdentity)
  ) {
    throw failure(
      "materialization_publish_incomplete",
      500,
      "Workspace publication receipt is incomplete."
    );
  }
  return receipt;
}

export function materializationFailureDisposition(error?: any) : any {
  const code: any = text(error?.code) || "materialization_failed";
  return Object.freeze({
    code,
    retryable: !TERMINAL_FAILURE_CODES.has(code)
  });
}

export function createUploadWorkspaceMaterialization({
  authorityPort,
  custodyReadPort,
  resourcePort,
  workspacePort,
  transactionStore,
  resolveOperation,
  auditPort,
  proofPort,
  faultObserver = null,
  leaseHeartbeatMs = 10_000
}: Record<string, any> = {}) : any {
  for (const [port, methods, label] of [
    [authorityPort, ["revalidate"], "authorityPort"],
    [custodyReadPort, ["open"], "custodyReadPort"],
    [resourcePort, ["resolveCurrentDescriptor"], "resourcePort"],
    [workspacePort, ["withRequest"], "workspacePort"],
    [
      transactionStore,
      [
        "assertFence",
        "begin",
        "complete",
        "fail",
        "get",
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
        "renew"
      ],
      "transactionStore"
    ],
    [auditPort, ["appendIdempotent", "getById"], "auditPort"],
    [proofPort, ["beginLifecycle", "finishLifecycle"], "proofPort"]
  ]) {
    for (const method of methods) requireMethod(port, method, label);
  }
  if (typeof resolveOperation !== "function") {
    throw new TypeError("resolveOperation is required.");
  }

  async function execute({
    requestRef,
    ownerFence,
    signal = null,
    renewLease = null
  }: Record<string, any> = {}) : Promise<any> {
    const stored: any = await transactionStore.get(requestRef);
    if (!stored) {
      throw failure(
        "materialization_request_missing",
        404,
        "Materialization request is missing."
      );
    }
    if (stored.status === "completed") {
      return publicResult(stored.result, true);
    }
    return workspacePort.withRequest(stored, async (workspace?: any) : Promise<any> => {
      let execution: any = await transactionStore.begin(
        requestRef,
        { ownerFence }
      );
      if (execution.status === "completed") {
        return publicResult(execution.result, true);
      }
      let heartbeatFailure: any = null;
      let heartbeatInFlight: any = Promise.resolve();
      let proofEntry: any = null;
      let proofLifecycleExpected: any =
        RECOVERY_STAGES.has(execution.stage);

      const heartbeat: any = async () : Promise<any> => {
        heartbeatInFlight = heartbeatInFlight.then(async () : Promise<any> => {
          if (typeof renewLease === "function") {
            await renewLease();
          }
          await transactionStore.renew(requestRef, { ownerFence });
        });
        try {
          await heartbeatInFlight;
        } catch (error: any) {
          heartbeatFailure = error;
          throw error;
        }
      };
      const fence: any = async ({
        renew = false,
        allowCancelledSettlement = false
      }: Record<string, any> = {}) : Promise<any> => {
        if (signal?.aborted && !allowCancelledSettlement) {
          throw failure(
            "materialization_cancelled",
            409,
            "Materialization was cancelled."
          );
        }
        if (heartbeatFailure) throw heartbeatFailure;
        if (renew) await heartbeat();
        await transactionStore.assertFence(
          requestRef,
          { ownerFence }
        );
      };
      const timer: any = setInterval(
        () : any => void heartbeat().catch(() : any => null),
        Math.max(10, Number(leaseHeartbeatMs) || 10_000)
      );
      timer.unref?.();

      const beginProof: any = async (record?: any) : Promise<any> => {
        proofLifecycleExpected = true;
        const entry: any = await proofPort.beginLifecycle({
          idempotencyKey: record.bindingDigest,
          input: {
            bindingDigest: record.bindingDigest,
            resourceRevision: record.resourceRevision
          },
          operationId: record.operationId,
          workspaceId: record.workspaceId
        });
        proofEntry = entry;
        return entry;
      };

      const finishProofDisposition: any = async (
        record: any,
        { status, reasonCode }: Record<string, any>
      ) : Promise<any> => {
        if (!["failed", "in_doubt"].includes(status)) {
          throw new TypeError(
            "Materialization proof disposition is invalid."
          );
        }
        await fence({
          renew: true,
          allowCancelledSettlement: true
        });
        const entry: any = proofEntry || await beginProof(record);
        if (entry?.proof?.terminal === true) {
          if (entry.status === status) return entry;
          throw failure(
            "materialization_proof_terminal_conflict",
            409,
            "Materialization proof already has another terminal outcome."
          );
        }
        const outcomeIdempotencyKey: any = [
          "materialization-outcome",
          digest({
            bindingDigest: record.bindingDigest,
            status
          })
        ].join(":");
        const proof: any = await proofPort.finishLifecycle({
          entry,
          ledgerEventId: entry?.ledgerEventId,
          idempotencyKey: outcomeIdempotencyKey,
          outcomeIdempotencyKey,
          result: {
            bindingDigest: record.bindingDigest,
            disposition: status,
            reasonCode
          },
          status,
          outcomeKind: status,
          failed: status === "failed",
          error: status === "failed" ? reasonCode : ""
        });
        if (!text(proof?.ledgerEventId)) {
          throw failure(
            "materialization_proof_incomplete",
            500,
            "Materialization proof receipt is incomplete."
          );
        }
        return proof;
      };

      const markRollbackInDoubt: any = async (record?: any, reasonCode?: any) : Promise<any> => {
        let terminalConflict: any = false;
        try {
          await finishProofDisposition(record, {
            status: "in_doubt",
            reasonCode
          });
        } catch (error: any) {
          if (
            error?.code !==
            "materialization_proof_terminal_conflict"
          ) {
            throw error;
          }
          terminalConflict = true;
        }
        await fence({
          renew: true,
          allowCancelledSettlement: true
        });
        await transactionStore.markRollbackIncomplete(requestRef, {
          ownerFence,
          error: {
            code: terminalConflict
              ? "materialization_proof_terminal_conflict"
              : reasonCode
          }
        });
      };

      const recordPublishedReceipt: any = async (record?: any, receipt?: any) : Promise<any> => {
        validatePublishedReceipt(record, receipt);
        await transactionStore.recordPublished(requestRef, {
          ownerFence,
          checkpointRef: receipt.checkpointRef,
          proofDigest: receipt.proofDigest,
          publicationId: receipt.publicationId,
          publishedIdentity: receipt.publishedIdentity,
          publishedRevision: receipt.workspaceRevision,
          priorRevision: record.expectedWorkspaceRevision,
          stateOperationId: receipt.stateOperationId
        });
        return transactionStore.get(requestRef);
      };

      const recoverPublication: any = async (record?: any) : Promise<any> => {
        if (!RECOVERY_STAGES.has(record?.stage)) return record;
        const recovered: any = await workspace.recover({
          leaseGuard: () : any => fence({ renew: true }),
          preimage: record.preimage,
          publication: record.publication,
          signal
        });
        if (recovered?.ok !== true) {
          const reasonCode: any =
            recovered?.code ||
            "materialization_rollback_incomplete";
          await markRollbackInDoubt(record, reasonCode);
          throw failure(
            "materialization_rollback_incomplete",
            409,
            "Workspace publication recovery is incomplete."
          );
        }
        if (recovered.disposition === "retry") {
          if (!PRECOMMIT_RECOVERY_STAGES.has(record.stage)) {
            await markRollbackInDoubt(
              record,
              "materialization_rollback_incomplete"
            );
            throw failure(
              "materialization_rollback_incomplete",
              409,
              "Committed publication cannot transition back to retry."
            );
          }
          await invokeMaterializationFault(
            faultObserver,
            "afterPrecommitCleanupBeforeRecord",
            {
              publicationId: record.publication.publicationId,
              requestRef,
              reservationDigest:
                record.publication.reservationDigest || ""
            }
          );
          await transactionStore.recordPrecommitCleaned(requestRef, {
            ownerFence,
            publicationId: record.publication.publicationId,
            reservationDigest:
              record.publication.reservationDigest || ""
          });
          return transactionStore.get(requestRef);
        }
        if (recovered.disposition !== "committed" || !recovered.receipt) {
          await markRollbackInDoubt(
            record,
            "materialization_rollback_incomplete"
          );
          throw failure(
            "materialization_rollback_incomplete",
            409,
            "Workspace publication recovery disposition is invalid."
          );
        }
        if (PRECOMMIT_RECOVERY_STAGES.has(record.stage)) {
          return recordPublishedReceipt(record, recovered.receipt);
        }
        validatePublishedReceipt(record, recovered.receipt);
        if (
          record.publishedRevision !==
            recovered.receipt.workspaceRevision ||
          record.result?.checkpointRef !==
            recovered.receipt.checkpointRef
        ) {
          await markRollbackInDoubt(
            record,
            "materialization_rollback_incomplete"
          );
          throw failure(
            "materialization_rollback_incomplete",
            409,
            "Persisted publication receipt does not match its state event."
          );
        }
        return record;
      };

      const settleCommitted: any = async (record?: any) : Promise<any> => {
        let current: any = record;
        if (!COMMITTED_STAGES.has(current.stage)) {
          throw failure(
            "materialization_publication_wal_mismatch",
            409,
            "Materialization settlement requires a committed effect."
          );
        }
        await fence({ renew: true });
        const entry: any = proofEntry || await beginProof(current);
        if (current.stage === "published") {
          await transactionStore.recordEvidencePending(requestRef, {
            ownerFence
          });
          current = await transactionStore.get(requestRef);
          await invokeMaterializationFault(
            faultObserver,
            "afterEvidencePending",
            {
              requestRef,
              settlementDigest: current.evidence.settlementDigest
            }
          );
        }
        const evidence: any = current.evidence;
        if (
          !evidence?.settlementDigest ||
          !evidence.auditId ||
          !evidence.auditCreatedAt ||
          !evidence.proofOutcomeKey
        ) {
          throw failure(
            "materialization_evidence_wal_incomplete",
            500,
            "Materialization evidence journal is incomplete."
          );
        }
        await fence({ renew: true });
        const audit: any = await auditPort.appendIdempotent({
          action: "materialize",
          auditId: evidence.auditId,
          createdAt: evidence.auditCreatedAt,
          input: {
            bindingDigest: current.bindingDigest,
            publicationProofDigest:
              current.publication.proofDigest,
            settlementDigest: evidence.settlementDigest
          },
          operationId: current.operationId,
          output: {
            checkpointRef: current.result.checkpointRef,
            contentDigest: current.descriptor.contentDigest,
            workspaceRevision: current.publishedRevision
          },
          requestId: requestRef,
          status: "completed",
          transport: "job-worker"
        });
        await invokeMaterializationFault(
          faultObserver,
          "afterAuditWriteBeforeRecord",
          {
            auditId: audit.auditId,
            requestRef,
            settlementDigest: evidence.settlementDigest
          }
        );
        await fence({ renew: true });
        if (current.stage === "evidence_pending") {
          await transactionStore.recordAuditFinalized(requestRef, {
            ownerFence,
            auditRef: `audit:${audit.auditId}`,
            settlementDigest: evidence.settlementDigest
          });
          await invokeMaterializationFault(
            faultObserver,
            "afterAuditFinalizedRecord",
            {
              auditId: audit.auditId,
              requestRef,
              settlementDigest: evidence.settlementDigest
            }
          );
          current = await transactionStore.get(requestRef);
        } else if (
          current.evidence.auditRef !== `audit:${audit.auditId}`
        ) {
          throw failure(
            "materialization_evidence_wal_mismatch",
            409,
            "Materialization audit reference does not match."
          );
        }
        await fence({ renew: true });
        const proof: any = await proofPort.finishLifecycle({
          entry,
          auditId: audit.auditId,
          idempotencyKey: evidence.proofOutcomeKey,
          outcomeIdempotencyKey: evidence.proofOutcomeKey,
          receiptRefs: [current.result.checkpointRef],
          result: {
            bindingDigest: current.bindingDigest,
            publicationProofDigest:
              current.publication.proofDigest,
            settlementDigest: evidence.settlementDigest,
            workspaceRevision: current.publishedRevision
          },
          status: "succeeded"
        });
        const proofLedgerEventId: any = text(proof?.ledgerEventId);
        if (!proofLedgerEventId) {
          throw failure(
            "materialization_proof_incomplete",
            500,
            "Materialization proof receipt is incomplete."
          );
        }
        await invokeMaterializationFault(
          faultObserver,
          "afterProofWriteBeforeRecord",
          {
            proofLedgerEventId,
            requestRef,
            settlementDigest: evidence.settlementDigest
          }
        );
        await fence({ renew: true });
        if (current.stage === "audit_finalized") {
          await transactionStore.recordProofFinalized(requestRef, {
            ownerFence,
            proofRef: `proof:${proofLedgerEventId}`,
            settlementDigest: evidence.settlementDigest
          });
          await invokeMaterializationFault(
            faultObserver,
            "afterProofFinalizedRecord",
            {
              proofLedgerEventId,
              requestRef,
              settlementDigest: evidence.settlementDigest
            }
          );
          current = await transactionStore.get(requestRef);
        } else if (
          current.evidence.proofRef !== `proof:${proofLedgerEventId}`
        ) {
          throw failure(
            "materialization_evidence_wal_mismatch",
            409,
            "Materialization proof reference does not match."
          );
        }
        await fence({ renew: true });
        const result: any = publicResult({
          requestRef,
          contentDigest: current.descriptor.contentDigest,
          byteCount: current.descriptor.byteCount,
          workspaceRevision: current.publishedRevision,
          checkpointRef: current.result.checkpointRef,
          auditRef: current.evidence.auditRef,
          proofRef: current.evidence.proofRef
        });
        await transactionStore.complete(requestRef, {
          ownerFence,
          result,
          settlementDigest: evidence.settlementDigest
        });
        return result;
      };

      try {
        await fence({ renew: true });
        execution = await recoverPublication(execution);
        if (COMMITTED_STAGES.has(execution.stage)) {
          return await settleCommitted(execution);
        }

        const currentRevision: any = await workspace.getRevision();
        if (
          currentRevision !== execution.expectedWorkspaceRevision
        ) {
          throw failure(
            "materialization_stale_revision",
            409,
            "Workspace revision is stale."
          );
        }
        const target: any = await workspace.inspectTarget({
          leaseGuard: () : any => fence({ renew: true }),
          signal
        });
        if (
          target?.ok !== true ||
          !target.targetStateDigest ||
          !target.parentFingerprint ||
          !target.parentIdentity
        ) {
          throw failure(
            target?.code || "materialization_target_unsafe",
            Number(target?.status || 409),
            "Workspace materialization target is unavailable."
          );
        }
        const preimage: any = await workspace.capturePreimage({
          leaseGuard: () : any => fence({ renew: true }),
          signal
        });
        if (
          preimage?.ok !== true ||
          preimage.priorRevision !==
            execution.expectedWorkspaceRevision
        ) {
          throw failure(
            preimage?.code || "materialization_preimage_incomplete",
            Number(preimage?.status || 500),
            "Workspace preimage capture is incomplete."
          );
        }
        await transactionStore.recordPreimage(requestRef, {
          ownerFence,
          parentFingerprint: target.parentFingerprint,
          parentIdentity: target.parentIdentity,
          preimage: preimage.preimage,
          targetStateDigest: target.targetStateDigest
        });
        execution = await transactionStore.get(requestRef);

        proofEntry = await beginProof(execution);
        let publication: any = createPublicationIntent({
          ...execution,
          target
        });
        await fence({ renew: true });
        let claimedPublicationResourceRevision: any = "";
        const published: any = await workspace.materialize({
          publication,
          leaseGuard: () : any => fence({ renew: true }),
          signal,
          claimPublicationAuthority: async () : Promise<any> => {
            const resolveAuthorityInput: any = () : any => {
              const operation: any = resolveOperation(
                execution.operationId
              );
              if (
                !operation ||
                operation.id !== execution.operationId
              ) {
                throw failure(
                  "materialization_operation_unavailable",
                  503,
                  "Materialization operation authority is unavailable."
                );
              }
              return Object.freeze({
                authorityBindingDigest:
                  execution.authorityBindingDigest,
                authorityRef: execution.authorityRef,
                input: closedInput(execution),
                operation,
                requestDigest: execution.requestDigest,
                resourceBinding: Object.freeze({
                  descriptor: execution.descriptor,
                  expectedWorkspaceRevision:
                    execution.expectedWorkspaceRevision,
                  logicalTarget: execution.logicalTarget,
                  targetStateDigest:
                    execution.targetStateDigest,
                  workspaceId: execution.workspaceId
                })
              });
            };
            const revalidatePublicationAuthority: any = async () : Promise<any> => {
              const authority: any =
                await authorityPort.revalidate(
                  resolveAuthorityInput()
                );
              if (
                authority?.allowed !== true ||
                authority.revoked === true
              ) {
                throw failure(
                  authority?.reasonCode ||
                    "deferred_protected_sink_authority_denied",
                  403,
                  "Current protected sink authority was denied."
                );
              }
              return authority;
            };
            const inspectCurrentTarget: any = async () : Promise<any> => {
              const current: any = await workspace.inspectTarget({
                leaseGuard: () : any => fence({ renew: true }),
                signal
              });
              if (
                current?.ok !== true ||
                current.targetStateDigest !==
                  execution.targetStateDigest ||
                current.parentFingerprint !==
                  execution.parentFingerprint ||
                canonicalJson(current.parentIdentity) !==
                  canonicalJson(execution.parentIdentity)
              ) {
                throw failure(
                  "materialization_target_unsafe",
                  409,
                  "Workspace target changed before publication."
                );
              }
              return current;
            };

            let currentAuthority: any =
              await revalidatePublicationAuthority();
            const currentTarget: any = await inspectCurrentTarget();
            const currentResource: any =
              await resourcePort.resolveCurrentDescriptor({
                record: execution,
                owner: ownerFromAuthority(currentAuthority),
                target: currentTarget
              });
            if (
              !currentResource ||
              currentResource.resourceRevision !==
                execution.resourceRevision
            ) {
              throw failure(
                "materialization_descriptor_changed",
                409,
                "Upload custody descriptor changed."
              );
            }
            const targetSelector: Readonly<Record<string, any>> = Object.freeze({
              bindingDigest: execution.bindingDigest,
              descriptorDigest:
                currentResource.resourceRevision,
              logicalTargetDigest:
                digest(execution.logicalTarget),
              targetStateDigest:
                currentTarget.targetStateDigest,
              workspaceDigest: digest(execution.workspaceId)
            });
            const effect: Readonly<Record<string, any>> = Object.freeze({
              kind: "workspace-file-materialization",
              targetDigest: digest(targetSelector)
            });
            const attempt: any = createFinalProtectedSinkAttempt({
              audience: "upload-workspace-materialization",
              subject: currentAuthority.subject,
              operationId: execution.operationId,
              requestDigest: execution.requestDigest,
              context: currentAuthority.context,
              targetSelector,
              proofRef:
                `materialization-proof:${execution.bindingDigest}`,
              authorization: {
                authorityBindingDigest:
                  execution.authorityBindingDigest
              },
              approval: {
                approvalIntentDigest:
                  execution.approvalIntentDigest
              },
              risk: {
                operationId: execution.operationId
              },
              revalidateCurrentAuthority: async () : Promise<any> => {
                currentAuthority =
                  await revalidatePublicationAuthority();
                return currentAuthority;
              },
              signal
            });
            await claimFinalProtectedSinkAttempt({
              attempt,
              targetSelector,
              effect,
              resourceRevision:
                currentResource.resourceRevision,
              resolveCurrentResource: async () : Promise<any> => {
                const refreshedTarget: any =
                  await inspectCurrentTarget();
                const refreshed: any =
                  await resourcePort.resolveCurrentDescriptor({
                    record: execution,
                    owner: ownerFromAuthority(currentAuthority),
                    target: refreshedTarget
                  });
                return Object.freeze({
                  effect,
                  resourceRevision:
                    refreshed?.resourceRevision
                });
              }
            });
            const custodyAuthorizationReceipt: any =
              currentAuthority.custodyAuthorizationReceipt;
            if (!custodyAuthorizationReceipt) {
              throw failure(
                "upload_custody_read_denied",
                403,
                "Custody read authorization is unavailable."
              );
            }
            const currentOwner: any =
              ownerFromAuthority(currentAuthority);
            claimedPublicationResourceRevision =
              currentResource.resourceRevision;
            execution =
              await transactionStore.recordPublicationIntent(
                requestRef,
                {
                  ownerFence,
                  publication
                }
              );
            publication = execution.publication;
            await invokeMaterializationFault(
              faultObserver,
              "afterFinalPermitConsumed",
              {
                bindingDigest: execution.bindingDigest,
                requestRef,
                resourceRevision:
                  claimedPublicationResourceRevision
              }
            );
            await invokeMaterializationFault(
              faultObserver,
              "afterPublicationIntentBeforeCustodyOpen",
              publicationFaultPayload(
                "afterPublicationIntentBeforeCustodyOpen",
                requestRef,
                publication
              )
            );
            return (async function* authorizedCustodyStream() : AsyncGenerator<any, any, any> {
              const opened: any = await custodyReadPort.open({
                authorizationReceipt:
                  custodyAuthorizationReceipt,
                byteCount: execution.descriptor.byteCount,
                contentDigest:
                  execution.descriptor.contentDigest,
                custodyRef: execution.descriptor.custodyRef,
                envelopeDigest:
                  execution.descriptor.envelopeDigest,
                maxBytes: execution.descriptor.byteCount,
                owner: currentOwner,
                resourceRef:
                  execution.descriptor.resourceRef,
                signal
              });
              for await (const chunk of opened.stream) {
                yield chunk;
              }
            })();
          },
          recordTempReserved: async (candidate?: any) : Promise<any> => {
            const recorded: any = await transactionStore.recordTempReserved(
              requestRef,
              {
                ownerFence,
                publication: candidate
              }
            );
            execution = recorded;
            publication = recorded.publication;
            return publication;
          },
          recordPublicationPrepared: async (candidate?: any) : Promise<any> => {
            const recorded: any =
              await transactionStore.recordPublicationPrepared(
                requestRef,
                {
                  ownerFence,
                  publication: candidate
                }
              );
            execution = recorded;
            publication = recorded.publication;
            return publication;
          },
          afterDirectoryWorkerBoundBeforeReserve: (candidate?: any) : any =>
            invokeMaterializationFault(
              faultObserver,
              "afterDirectoryWorkerBoundBeforeReserve",
              {
                ...candidate,
                requestRef
              }
            ),
          afterTempInodeReservedBeforeWal: (candidate?: any) : any =>
            invokeMaterializationFault(
              faultObserver,
              "afterTempInodeReservedBeforeWal",
              {
                ...candidate,
                requestRef
              }
            ),
          afterTempReservedBeforeFirstWrite: (candidate?: any) : any =>
            invokeMaterializationFault(
              faultObserver,
              "afterTempReservedBeforeFirstWrite",
              {
                ...candidate,
                requestRef
              }
            ),
          afterFirstChunkWrittenBeforeContinue: (candidate?: any) : any =>
            invokeMaterializationFault(
              faultObserver,
              "afterFirstChunkWrittenBeforeContinue",
              {
                ...candidate,
                requestRef
              }
            ),
          afterPublicationPreparedBeforeLink: (candidate?: any) : any =>
            invokeMaterializationFault(
              faultObserver,
              "afterPublicationPreparedBeforeLink",
              {
                ...candidate,
                requestRef
              }
            ),
          afterPublicationLinkedBeforeTempUnlink: (candidate?: any) : any =>
            invokeMaterializationFault(
              faultObserver,
              "afterPublicationLinkedBeforeTempUnlink",
              {
                ...candidate,
                requestRef
              }
            ),
          afterPublishedFileDurableBeforeStateCommit: (candidate?: any) : any =>
            invokeMaterializationFault(
              faultObserver,
              "afterPublishedFileDurableBeforeStateCommit",
              {
                ...candidate,
                requestRef
              }
            ),
          afterStateAndCheckpointDurableBeforeReceipt: (candidate?: any) : any =>
            invokeMaterializationFault(
              faultObserver,
              "afterStateAndCheckpointDurableBeforeReceipt",
              {
                ...candidate,
                requestRef
              }
            )
        });
        execution = await transactionStore.get(requestRef);
        validatePublishedReceipt(execution, published);
        execution = await recordPublishedReceipt(
          execution,
          published
        );
        await invokeMaterializationFault(
          faultObserver,
          "afterWorkspacePublish",
          {
            bindingDigest: execution.bindingDigest,
            publishedRevision: execution.publishedRevision,
            requestRef
          }
        );
        return await settleCommitted(execution);
      } catch (error: any) {
        if (error?.abrupt === true) throw error;
        let ownsFence: any = false;
        try {
          await transactionStore.assertFence(
            requestRef,
            { ownerFence }
          );
          ownsFence = true;
        } catch {
          ownsFence = false;
        }
        if (ownsFence) {
          let current: any = await transactionStore.get(requestRef);
          if (RECOVERY_STAGES.has(current?.stage)) {
            try {
              const beforeRecovery: any = current;
              current = await recoverPublication(current);
              if (COMMITTED_STAGES.has(current?.stage)) {
                return await settleCommitted(current);
              }
            } catch (recoveryError: any) {
              if (
                recoveryError?.code ===
                "materialization_rollback_incomplete"
              ) {
                throw recoveryError;
              }
            }
          }
          if (!RECOVERY_STAGES.has(current?.stage)) {
            const disposition: any =
              materializationFailureDisposition(error);
            if (
              current?.preimage &&
              LINEAGE_AMBIGUITY_CODES.has(disposition.code)
            ) {
              await markRollbackInDoubt(current, disposition.code);
            } else if (
              execution?.preimage &&
              LINEAGE_AMBIGUITY_CODES.has(disposition.code)
            ) {
              await finishProofDisposition(current, {
                status: "in_doubt",
                reasonCode: disposition.code
              });
              await transactionStore.fail(requestRef, {
                ownerFence,
                error: {
                  code: "materialization_rollback_incomplete"
                },
                recoverable: false
              });
            } else if (
              disposition.retryable !== true &&
              proofLifecycleExpected
            ) {
              await finishProofDisposition(current, {
                status: "failed",
                reasonCode: disposition.code
              });
              await transactionStore.fail(requestRef, {
                ownerFence,
                error: {
                  code: disposition.code
                },
                recoverable: disposition.retryable
              });
            } else {
              await transactionStore.fail(requestRef, {
                ownerFence,
                error: {
                  code: disposition.code
                },
                recoverable: disposition.retryable
              });
            }
          }
        }
        throw error;
      } finally {
        clearInterval(timer);
        await heartbeatInFlight.catch(() : any => null);
      }
    });
  }

  return Object.freeze({
    execute,
    get(requestRef?: any) : any {
      return transactionStore.get(requestRef);
    }
  });
}
