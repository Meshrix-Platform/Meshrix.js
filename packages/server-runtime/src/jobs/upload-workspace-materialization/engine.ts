import crypto from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  claimFinalProtectedSinkAttempt,
  createFinalProtectedSinkAttempt
} from "#meshrix/foundation/security/final-protected-sink-permit";
import { errorProperty } from "../jobs/contracts.ts";
import {
  UPLOAD_WORKSPACE_MATERIALIZATION_SCHEMA_VERSION,
  digest,
  failure,
  isMaterializationCommittedState,
  isMaterializationCompletedState,
  isMaterializationPrecommitState,
  isMaterializationRecoveryState,
  publicationIntentDigest,
  text,
  type MaterializationAuthorityDecision,
  type MaterializationAuthorityPort,
  type MaterializationAuditPort,
  type MaterializationClosedAdmissionInput,
  type MaterializationCommittedState,
  type MaterializationCustodyReadPort,
  type MaterializationDurableState,
  type MaterializationExecutionResult,
  type MaterializationFaultObserver,
  type MaterializationFaultPayload,
  type MaterializationOperationResult,
  type MaterializationOwner,
  type MaterializationPreimage,
  type MaterializationProofEntry,
  type MaterializationProofPort,
  type MaterializationProofReceipt,
  type MaterializationPublication,
  type MaterializationPublishedReceipt,
  type MaterializationRecoveryResult,
  type MaterializationRequestRecord,
  type MaterializationResolvedOperation,
  type MaterializationResourcePort,
  type MaterializationTargetInspection,
  type MaterializationTransactionPort,
  type MaterializationWorkspacePort,
  type MaterializationWorkspaceSession,
  type PublicationIntent,
  type PublicationIntentFacts,
  type PublicationPrepared,
  type PublicationReservation
} from "./model.ts";

type FaultKind = "digest" | "optional-digest" | "id" | "integer";

function isUnknownRecord(
  value: unknown
): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function requirePresent<T>(
  value: T | null | undefined,
  label: string
): T {
  if (value === null || value === undefined) {
    throw failure(
      "materialization_state_incomplete",
      500,
      `${label} is unavailable.`
    );
  }
  return value;
}

const LINEAGE_AMBIGUITY_CODES = new Set<string>([
  "materialization_parent_identity_mismatch",
  "materialization_path_invalid",
  "materialization_target_changed",
  "materialization_target_identity_mismatch",
  "materialization_target_unsafe"
]);
const TERMINAL_FAILURE_CODES = new Set<string>([
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

function requireMethod(
  port: object | null | undefined,
  method: string,
  label: string
): void {
  const candidate =
    port && method in port
      ? (port as Record<string, unknown>)[method]
      : undefined;
  if (typeof candidate !== "function") {
    throw new TypeError(`${label}.${method} is required.`);
  }
}

function closedInput(
  record: MaterializationRequestRecord
): MaterializationClosedAdmissionInput {
  return Object.freeze({
    expectedWorkspaceRevision: record.expectedWorkspaceRevision,
    logicalTarget: record.logicalTarget,
    safetyConfirm: true,
    uploadSessionId: record.uploadSessionId,
    workspaceId: record.workspaceId
  });
}

function ownerFromAuthority(
  authority?: MaterializationAuthorityDecision
): MaterializationOwner {
  const subjectId = text(authority?.subject?.subjectId);
  const tenantId = text(authority?.subject?.tenantId);
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

function publicResult(
  value: {
    requestRef: string;
    contentDigest: string;
    byteCount: number;
    workspaceRevision: string;
    checkpointRef: string;
    auditRef?: string;
    proofRef?: string;
  },
  replayed = false
): MaterializationOperationResult {
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

const FAULT_SCHEMAS = Object.freeze({
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

function boundedFaultValue(value: unknown, kind: FaultKind): boolean {
  if (kind === "integer") {
    return Number.isSafeInteger(value) && Number(value) >= 0;
  }
  if (kind === "optional-digest" && value === "") return true;
  if (typeof value !== "string") return false;
  if (
    !value ||
    value.length > 768 ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) || 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    return false;
  }
  return !kind.endsWith("digest") ||
    /^[a-f0-9]{64}$/u.test(value);
}

export async function invokeMaterializationFault(
  faultObserver: MaterializationFaultObserver | null,
  callbackName: keyof typeof FAULT_SCHEMAS,
  input: unknown
): Promise<MaterializationFaultPayload> {
  const schema = FAULT_SCHEMAS[callbackName];
  const invalid = () => failure(
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
  const candidate = input as Record<string, unknown>;
  const expectedKeys = Object.keys(schema).sort();
  const actualKeys = Object.keys(candidate).sort();
  if (
    expectedKeys.join("\0") !== actualKeys.join("\0") ||
    expectedKeys.some(
      (key) => !boundedFaultValue(
        candidate[key],
        (schema as Record<string, FaultKind>)[key]
      )
    )
  ) {
    throw invalid();
  }
  const bounded = Object.freeze({ ...candidate }) as MaterializationFaultPayload;
  await faultObserver?.[callbackName]?.(bounded);
  return bounded;
}

function nestedSnapshotAnchor(
  preimage: MaterializationPreimage | null
): unknown {
  const snapshot: unknown = preimage?.snapshot;
  return isUnknownRecord(snapshot)
    ? snapshot.stateEventAnchor
    : undefined;
}

function createPublicationIntent(
  execution: MaterializationRequestRecord & {
    readonly preimage: MaterializationPreimage | null;
  },
  target: MaterializationTargetInspection
): PublicationIntent {
  const descriptor = execution.descriptor;
  const stateEventAnchor: unknown =
    execution.preimage?.stateEventAnchor ??
    nestedSnapshotAnchor(execution.preimage) ??
    target.anchor;
  const anchor = isUnknownRecord(stateEventAnchor)
    ? stateEventAnchor
    : null;
  const eventHash = text(anchor?.eventHash)
    .replace(/^sha256:/u, "");
  if (
    !anchor ||
    !/^[a-f0-9]{64}$/u.test(eventHash) ||
    !Number.isSafeInteger(Number(anchor.offset)) ||
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
  const base: PublicationIntentFacts = {
    byteCount: descriptor.byteCount,
    contentDigest: descriptor.contentDigest,
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
      offset: Number(anchor.offset),
      eventHash
    }),
    stateOperationId:
      `${execution.operationId}.state:${crypto.randomUUID()}`,
    targetStateDigest: target.targetStateDigest,
    tempLeafRef:
      `.meshrix-materialization-${crypto.randomUUID()}`
  };
  const intentDigest = publicationIntentDigest(base);
  return Object.freeze({
    ...base,
    intentDigest,
    preparedIdentity: null,
    reservationDigest: "",
    proofDigest: ""
  });
}

function publicationFaultPayload(
  callbackName: string,
  requestRef: string,
  publication: MaterializationPublication
): {
  intentDigest?: string;
  proofDigest?: string;
  publicationId: string;
  requestRef: string;
  reservationDigest?: string;
  stateOperationId: string;
} {
  if (callbackName === "afterTempReservedBeforeFirstWrite") {
    return {
      publicationId: publication.publicationId,
      requestRef,
      reservationDigest: publication.reservationDigest,
      stateOperationId: publication.stateOperationId
    };
  }
  const digestKey: "intentDigest" | "proofDigest" =
    callbackName.includes("Intent") ||
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

function validatePublishedReceipt(
  execution: MaterializationDurableState,
  receipt: unknown
): asserts receipt is MaterializationPublishedReceipt {
  const publication = execution.publication;
  const descriptor = execution.descriptor;
  if (
    !isUnknownRecord(receipt) ||
    receipt.contentDigest !== descriptor.contentDigest ||
    receipt.byteCount !== descriptor.byteCount ||
    typeof receipt.workspaceRevision !== "string" || !receipt.workspaceRevision ||
    typeof receipt.checkpointRef !== "string" || !receipt.checkpointRef ||
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
}

export function materializationFailureDisposition(error?: unknown) {
  const code =
    text(errorProperty(error, "code")) || "materialization_failed";
  return Object.freeze({
    code,
    retryable: !TERMINAL_FAILURE_CODES.has(code)
  });
}

export interface CreateUploadWorkspaceMaterializationOptions {
  authorityPort: MaterializationAuthorityPort;
  custodyReadPort: MaterializationCustodyReadPort;
  resourcePort: MaterializationResourcePort;
  workspacePort: MaterializationWorkspacePort;
  transactionStore: MaterializationTransactionPort;
  resolveOperation(
    operationId: string
  ): MaterializationResolvedOperation | null | undefined;
  auditPort: MaterializationAuditPort;
  proofPort: MaterializationProofPort;
  faultObserver?: MaterializationFaultObserver | null;
  leaseHeartbeatMs?: number;
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
}: CreateUploadWorkspaceMaterializationOptions) {
  const portRequirements: Array<readonly [object, readonly string[], string]> = [
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
  ];
  for (const [port, methods, label] of portRequirements) {
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
  }: {
    requestRef: string;
    ownerFence?: string;
    signal?: AbortSignal | null;
    renewLease?: (() => Promise<void>) | null;
  }): Promise<MaterializationExecutionResult> {
    const stored = await transactionStore.get(requestRef);
    if (!stored) {
      throw failure(
        "materialization_request_missing",
        404,
        "Materialization request is missing."
      );
    }
    if (isMaterializationCompletedState(stored)) {
      return publicResult(stored.result, true);
    }
    return workspacePort.withRequest(stored, async (workspace: MaterializationWorkspaceSession) => {
      let execution: MaterializationDurableState =
        await transactionStore.begin(
          requestRef,
          { ownerFence }
        );
      if (isMaterializationCompletedState(execution)) {
        return publicResult(execution.result, true);
      }
      let heartbeatFailure: unknown = null;
      let heartbeatInFlight = Promise.resolve();
      let proofEntry: MaterializationProofEntry | null = null;
      let proofLifecycleExpected =
        isMaterializationRecoveryState(execution);

      const heartbeat = async () => {
        heartbeatInFlight = heartbeatInFlight.then(async () => {
          if (typeof renewLease === "function") {
            await renewLease();
          }
          await transactionStore.renew(requestRef, { ownerFence });
        });
        try {
          await heartbeatInFlight;
        } catch (error) {
          heartbeatFailure = error;
          throw error;
        }
      };
      const fence = async ({
        renew = false,
        allowCancelledSettlement = false
      }: { renew?: boolean; allowCancelledSettlement?: boolean } = {}) => {
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
      const timer = setInterval(
        () => void heartbeat().catch(() => null),
        Math.max(10, Number(leaseHeartbeatMs) || 10_000)
      );
      timer.unref?.();

      const beginProof = async (
        record: MaterializationRequestRecord
      ): Promise<MaterializationProofEntry> => {
        proofLifecycleExpected = true;
        const entry = await proofPort.beginLifecycle({
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

      const finishProofDisposition = async (
        record: MaterializationRequestRecord,
        { status, reasonCode }: {
          status: "failed" | "in_doubt";
          reasonCode: string;
        }
      ): Promise<MaterializationProofReceipt> => {
        if (!["failed", "in_doubt"].includes(status)) {
          throw new TypeError(
            "Materialization proof disposition is invalid."
          );
        }
        await fence({
          renew: true,
          allowCancelledSettlement: true
        });
        const entry = proofEntry || await beginProof(record);
        if (entry.proof?.terminal === true) {
          if (entry.status === status) return entry;
          throw failure(
            "materialization_proof_terminal_conflict",
            409,
            "Materialization proof already has another terminal outcome."
          );
        }
        const outcomeIdempotencyKey = [
          "materialization-outcome",
          digest({
            bindingDigest: record.bindingDigest,
            status
          })
        ].join(":");
        const proof = await proofPort.finishLifecycle({
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

      const markRollbackInDoubt = async (
        record: MaterializationDurableState,
        reasonCode: string
      ): Promise<void> => {
        let terminalConflict = false;
        try {
          await finishProofDisposition(record, {
            status: "in_doubt",
            reasonCode
          });
        } catch (error) {
          if (
            errorProperty(error, "code") !==
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

      const recordPublishedReceipt = async (
        record: MaterializationDurableState,
        receipt: unknown
      ): Promise<MaterializationDurableState> => {
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
        return requirePresent(
          await transactionStore.get(requestRef),
          "Materialization state"
        );
      };

      const recoverPublication = async (
        record: MaterializationDurableState
      ): Promise<MaterializationDurableState> => {
        if (!isMaterializationRecoveryState(record)) return record;
        const recovered: MaterializationRecoveryResult =
          await workspace.recover({
            leaseGuard: () => fence({ renew: true }),
            preimage: record.preimage,
            publication: record.publication,
            signal
          });
        if (recovered?.ok !== true) {
          const reasonCode =
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
          if (!isMaterializationPrecommitState(record)) {
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
          const publication = record.publication;
          await invokeMaterializationFault(
            faultObserver,
            "afterPrecommitCleanupBeforeRecord",
            {
              publicationId: publication.publicationId,
              requestRef,
              reservationDigest:
                publication.reservationDigest || ""
            }
          );
          await transactionStore.recordPrecommitCleaned(requestRef, {
            ownerFence,
            publicationId: publication.publicationId,
            reservationDigest:
              publication.reservationDigest || ""
          });
          return requirePresent(
            await transactionStore.get(requestRef),
            "Materialization state"
          );
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
        const receipt = recovered.receipt;
        if (isMaterializationPrecommitState(record)) {
          return recordPublishedReceipt(record, receipt);
        }
        validatePublishedReceipt(record, receipt);
        if (
          record.publishedRevision !==
            receipt.workspaceRevision ||
          record.result?.checkpointRef !==
            receipt.checkpointRef
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

      const settleCommitted = async (
        record: MaterializationCommittedState
      ): Promise<MaterializationOperationResult> => {
        let current: MaterializationDurableState = record;
        await fence({ renew: true });
        const entry = proofEntry || await beginProof(current);
        if (current.stage === "published") {
          await transactionStore.recordEvidencePending(requestRef, {
            ownerFence
          });
          current = requirePresent(
            await transactionStore.get(requestRef),
            "Materialization state"
          );
          const pendingEvidence = requirePresent(
            current.evidence,
            "Materialization evidence"
          );
          await invokeMaterializationFault(
            faultObserver,
            "afterEvidencePending",
            {
              requestRef,
              settlementDigest: pendingEvidence.settlementDigest
            }
          );
        }
        const evidence = requirePresent(
          current.evidence,
          "Materialization evidence"
        );
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
        const publication = requirePresent(
          current.publication,
          "Materialization publication"
        );
        const currentResult = requirePresent(
          current.result,
          "Materialization result"
        );
        const descriptor = current.descriptor;
        await fence({ renew: true });
        const audit = await auditPort.appendIdempotent({
          action: "materialize",
          auditId: evidence.auditId,
          createdAt: evidence.auditCreatedAt,
          input: {
            bindingDigest: current.bindingDigest,
            publicationProofDigest:
              publication.proofDigest,
            settlementDigest: evidence.settlementDigest
          },
          operationId: current.operationId,
          output: {
            checkpointRef: currentResult.checkpointRef,
            contentDigest: descriptor.contentDigest,
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
          current = requirePresent(
            await transactionStore.get(requestRef),
            "Materialization state"
          );
        } else if (
          requirePresent(
            current.evidence,
            "Materialization evidence"
          ).auditRef !== `audit:${audit.auditId}`
        ) {
          throw failure(
            "materialization_evidence_wal_mismatch",
            409,
            "Materialization audit reference does not match."
          );
        }
        await fence({ renew: true });
        const proof = await proofPort.finishLifecycle({
          entry,
          auditId: audit.auditId,
          idempotencyKey: evidence.proofOutcomeKey,
          outcomeIdempotencyKey: evidence.proofOutcomeKey,
          receiptRefs: [currentResult.checkpointRef],
          result: {
            bindingDigest: current.bindingDigest,
            publicationProofDigest:
              publication.proofDigest,
            settlementDigest: evidence.settlementDigest,
            workspaceRevision: current.publishedRevision
          },
          status: "succeeded"
        });
        const proofLedgerEventId = text(proof?.ledgerEventId);
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
          current = requirePresent(
            await transactionStore.get(requestRef),
            "Materialization state"
          );
        } else if (
          requirePresent(
            current.evidence,
            "Materialization evidence"
          ).proofRef !== `proof:${proofLedgerEventId}`
        ) {
          throw failure(
            "materialization_evidence_wal_mismatch",
            409,
            "Materialization proof reference does not match."
          );
        }
        await fence({ renew: true });
        const finalEvidence = requirePresent(
          current.evidence,
          "Materialization evidence"
        );
        const result = publicResult({
          requestRef,
          contentDigest: descriptor.contentDigest,
          byteCount: descriptor.byteCount,
          workspaceRevision: current.publishedRevision,
          checkpointRef: currentResult.checkpointRef,
          auditRef: finalEvidence.auditRef,
          proofRef: finalEvidence.proofRef
        });
        await transactionStore.complete(requestRef, {
          ownerFence,
          result,
          settlementDigest: evidence.settlementDigest
        });
        return result;
      };

      function requireCommitted(
        state: MaterializationDurableState
      ) {
        if (!isMaterializationCommittedState(state)) {
          throw failure(
            "materialization_publication_wal_mismatch",
            409,
            "Materialization settlement requires a committed effect."
          );
        }
        return state;
      }

      try {
        await fence({ renew: true });
        execution = await recoverPublication(execution);
        if (isMaterializationCommittedState(execution)) {
          return await settleCommitted(execution);
        }

        const currentRevision = await workspace.getRevision();
        if (
          currentRevision !== execution.expectedWorkspaceRevision
        ) {
          throw failure(
            "materialization_stale_revision",
            409,
            "Workspace revision is stale."
          );
        }
        const target = await workspace.inspectTarget({
          leaseGuard: () => fence({ renew: true }),
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
        const preimage = await workspace.capturePreimage({
          leaseGuard: () => fence({ renew: true }),
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
        execution = requirePresent(
          await transactionStore.get(requestRef),
          "Materialization state"
        );

        proofEntry = await beginProof(execution);
        const publicationIntent = createPublicationIntent(
          execution,
          target
        );
        let publication: MaterializationPublication = publicationIntent;
        await fence({ renew: true });
        let claimedPublicationResourceRevision = "";
        const published = await workspace.materialize({
          publication: publicationIntent,
          leaseGuard: () => fence({ renew: true }),
          signal,
          claimPublicationAuthority: async () => {
            const resolveAuthorityInput = () => {
              const operation = resolveOperation(text(execution.operationId));
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
            const revalidatePublicationAuthority = async () => {
              const authority =
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
            const inspectCurrentTarget = async () => {
              const current = await workspace.inspectTarget({
                leaseGuard: () => fence({ renew: true }),
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

            let currentAuthority =
              await revalidatePublicationAuthority();
            const currentTarget = await inspectCurrentTarget();
            const currentResource =
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
            const targetSelector = Object.freeze({
              bindingDigest: execution.bindingDigest,
              descriptorDigest:
                currentResource.resourceRevision,
              logicalTargetDigest:
                digest(execution.logicalTarget),
              targetStateDigest:
                currentTarget.targetStateDigest,
              workspaceDigest: digest(execution.workspaceId)
            });
            const effect = Object.freeze({
              kind: "workspace-file-materialization",
              targetDigest: digest(targetSelector)
            });
            const attempt = createFinalProtectedSinkAttempt({
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
              revalidateCurrentAuthority: async () => {
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
              resolveCurrentResource: async () => {
                const refreshedTarget =
                  await inspectCurrentTarget();
                const refreshed =
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
            const custodyAuthorizationReceipt =
              currentAuthority.custodyAuthorizationReceipt;
            if (!custodyAuthorizationReceipt) {
              throw failure(
                "upload_custody_read_denied",
                403,
                "Custody read authorization is unavailable."
              );
            }
            const currentOwner =
              ownerFromAuthority(currentAuthority);
            claimedPublicationResourceRevision = text(
              currentResource.resourceRevision
            );
            execution =
              await transactionStore.recordPublicationIntent(
                requestRef,
                {
                  ownerFence,
                  publication: publicationIntent
                }
              );
            publication = requirePresent(
              execution.publication,
              "Materialization publication"
            );
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
            return (async function* authorizedCustodyStream() : AsyncGenerator<Buffer, void, void> {
              const descriptor = execution.descriptor;
              const opened = await custodyReadPort.open({
                authorizationReceipt:
                  custodyAuthorizationReceipt,
                byteCount: descriptor.byteCount,
                contentDigest:
                  descriptor.contentDigest,
                custodyRef: descriptor.custodyRef,
                envelopeDigest:
                  descriptor.envelopeDigest,
                maxBytes: descriptor.byteCount,
                owner: currentOwner,
                resourceRef:
                  descriptor.resourceRef,
                signal
              });
              if (!opened.stream) {
                throw failure(
                  "upload_custody_read_denied",
                  403,
                  "Custody read stream is unavailable."
                );
              }
              for await (const chunk of opened.stream) {
                yield chunk;
              }
            })();
          },
          recordTempReserved: async (
            candidate: unknown
          ): Promise<PublicationReservation> => {
            const recorded =
              await transactionStore.recordTempReserved(
                requestRef,
                {
                  ownerFence,
                  publication: candidate
                }
              );
            execution = recorded;
            publication = recorded.publication;
            return recorded.publication;
          },
          recordPublicationPrepared: async (
            candidate: unknown
          ): Promise<PublicationPrepared> => {
            const recorded =
              await transactionStore.recordPublicationPrepared(
                requestRef,
                {
                  ownerFence,
                  publication: candidate
                }
              );
            execution = recorded;
            publication = recorded.publication;
            return recorded.publication;
          },
          afterDirectoryWorkerBoundBeforeReserve: (candidate: {
            intentDigest: string;
            publicationId: string;
            stateOperationId: string;
          }) =>
            invokeMaterializationFault(
              faultObserver,
              "afterDirectoryWorkerBoundBeforeReserve",
              {
                ...candidate,
                requestRef
              }
            ),
          afterTempInodeReservedBeforeWal: (candidate: {
            intentDigest: string;
            publicationId: string;
            stateOperationId: string;
          }) =>
            invokeMaterializationFault(
              faultObserver,
              "afterTempInodeReservedBeforeWal",
              {
                ...candidate,
                requestRef
              }
            ),
          afterTempReservedBeforeFirstWrite: (candidate: {
            publicationId: string;
            reservationDigest: string;
            stateOperationId: string;
          }) =>
            invokeMaterializationFault(
              faultObserver,
              "afterTempReservedBeforeFirstWrite",
              {
                ...candidate,
                requestRef
              }
            ),
          afterFirstChunkWrittenBeforeContinue: (candidate: {
            copiedBytes: number;
            publicationId: string;
            stateOperationId: string;
          }) =>
            invokeMaterializationFault(
              faultObserver,
              "afterFirstChunkWrittenBeforeContinue",
              {
                ...candidate,
                requestRef
              }
            ),
          afterPublicationPreparedBeforeLink: (candidate: {
            proofDigest: string;
            publicationId: string;
            stateOperationId: string;
          }) =>
            invokeMaterializationFault(
              faultObserver,
              "afterPublicationPreparedBeforeLink",
              {
                ...candidate,
                requestRef
              }
            ),
          afterPublicationLinkedBeforeTempUnlink: (candidate: {
            proofDigest: string;
            publicationId: string;
            stateOperationId: string;
          }) =>
            invokeMaterializationFault(
              faultObserver,
              "afterPublicationLinkedBeforeTempUnlink",
              {
                ...candidate,
                requestRef
              }
            ),
          afterPublishedFileDurableBeforeStateCommit: (candidate: {
            proofDigest: string;
            publicationId: string;
            stateOperationId: string;
          }) =>
            invokeMaterializationFault(
              faultObserver,
              "afterPublishedFileDurableBeforeStateCommit",
              {
                ...candidate,
                requestRef
              }
            ),
          afterStateAndCheckpointDurableBeforeReceipt: (candidate: {
            checkpointRef: string;
            proofDigest: string;
            publicationId: string;
            publishedRevision: string;
            stateOperationId: string;
          }) =>
            invokeMaterializationFault(
              faultObserver,
              "afterStateAndCheckpointDurableBeforeReceipt",
              {
                ...candidate,
                requestRef
              }
            )
        });
        execution = requirePresent(
          await transactionStore.get(requestRef),
          "Materialization state"
        );
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
        return await settleCommitted(requireCommitted(execution));
      } catch (error) {
        if (errorProperty(error, "abrupt") === true) throw error;
        let ownsFence = false;
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
          let current: MaterializationDurableState | null =
            await transactionStore.get(requestRef);
          if (current && isMaterializationRecoveryState(current)) {
            try {
              const recovered = await recoverPublication(current);
              current = recovered;
              if (isMaterializationCommittedState(recovered)) {
                return await settleCommitted(recovered);
              }
            } catch (recoveryError) {
              if (
                errorProperty(recoveryError, "code") ===
                "materialization_rollback_incomplete"
              ) {
                throw recoveryError;
              }
            }
          }
          if (!current || !isMaterializationRecoveryState(current)) {
            const disposition =
              materializationFailureDisposition(error);
            if (
              current?.preimage &&
              LINEAGE_AMBIGUITY_CODES.has(disposition.code)
            ) {
              await markRollbackInDoubt(current, disposition.code);
            } else if (
              execution.preimage &&
              LINEAGE_AMBIGUITY_CODES.has(disposition.code)
            ) {
              await finishProofDisposition(current || execution, {
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
              await finishProofDisposition(current || execution, {
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
        await heartbeatInFlight.catch(() => null);
      }
    });
  }

  return Object.freeze({
    execute,
    get(requestRef: string) {
      return transactionStore.get(requestRef);
    }
  });
}
