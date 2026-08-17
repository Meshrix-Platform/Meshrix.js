import crypto from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  claimFinalProtectedSinkAttempt,
  createFinalProtectedSinkAttempt
} from "#meshrix/foundation/security/final-protected-sink-permit";
import { errorProperty } from "./jobs/contracts.ts";

interface MaterializationRecord {
  [key: string]: unknown;
  requestRef?: string; operationId?: string; stage?: string; status?: string; reasonCode?: string;
  uploadSessionId?: string; workspaceId?: string; expectedWorkspaceRevision?: string;
  workspaceRevision?: string; checkpointRef?: string; auditRef?: string; proofRef?: string;
  contentDigest?: string; byteCount?: number; bindingDigest?: string; settlementDigest?: string;
  logicalTarget?: MaterializationRecord; target?: MaterializationRecord; descriptor?: MaterializationRecord;
  publication?: MaterializationRecord; preimage?: MaterializationRecord; snapshot?: MaterializationRecord;
  stateEventAnchor?: MaterializationRecord; subject?: MaterializationRecord;
  result?: MaterializationRecord; evidence?: MaterializationRecord; receipt?: MaterializationRecord;
  parentIdentity?: unknown; parentFingerprint?: string; targetStateDigest?: string; anchor?: MaterializationRecord;
  eventHash?: string; offset?: number; preparedIdentity?: unknown; proofDigest?: string;
  intentDigest?: string; publicationId?: string; stateOperationId?: string; reservationDigest?: string;
  tempLeafRef?: string; priorRevision?: string; publishedRevision?: string; beforeRevision?: string;
  publishedIdentity?: unknown; execution?: MaterializationRecord;
  authorityBindingDigest?: string; authorityRef?: string; requestDigest?: string; resourceRevision?: string;
  custodyRef?: string; envelopeDigest?: string; resourceRef?: string; custodyAuthorizationReceipt?: MaterializationRecord;
  code?: string; ok?: boolean; disposition?: string; abrupt?: boolean;
  auditId?: string; auditCreatedAt?: string; proofOutcomeKey?: string;
  proof?: MaterializationRecord;
  ledgerEventId?: string; createdAt?: string; id?: string; stream?: AsyncIterable<Buffer>;
}
type FaultKind = "digest" | "optional-digest" | "id" | "integer";
type FaultPayload = Record<string, string | number>;
type FaultObserver = Record<string, ((input: FaultPayload) => Promise<void> | void) | undefined>;
type RecordOutcome = MaterializationRecord | Promise<MaterializationRecord>;
interface AuthorityPort { revalidate(input: MaterializationRecord): RecordOutcome }
interface CustodyReadPort { open(input: MaterializationRecord): RecordOutcome }
interface ResourcePort { resolveCurrentDescriptor(input: MaterializationRecord): RecordOutcome }
interface WorkspaceSession {
  getRevision(): string | Promise<string>;
  inspectTarget(input: MaterializationRecord): RecordOutcome;
  capturePreimage(input: MaterializationRecord): RecordOutcome;
  recover(input: MaterializationRecord): RecordOutcome;
  materialize(input: MaterializationRecord): RecordOutcome;
}
interface WorkspacePort {
  withRequest<T>(record: MaterializationRecord, callback: (workspace: WorkspaceSession) => Promise<T>): Promise<T>;
}
interface TransactionStore {
  assertFence(requestRef: string, input: MaterializationRecord): RecordOutcome;
  begin(requestRef: string, input: MaterializationRecord): RecordOutcome;
  complete(requestRef: string, input: MaterializationRecord): RecordOutcome;
  fail(requestRef: string, input: MaterializationRecord): RecordOutcome;
  get(requestRef: string): RecordOutcome;
  markRollbackIncomplete(requestRef: string, input: MaterializationRecord): RecordOutcome;
  recordAuditFinalized(requestRef: string, input: MaterializationRecord): RecordOutcome;
  recordEvidencePending(requestRef: string, input: MaterializationRecord): RecordOutcome;
  recordPrecommitCleaned(requestRef: string, input: MaterializationRecord): RecordOutcome;
  recordPreimage(requestRef: string, input: MaterializationRecord): RecordOutcome;
  recordProofFinalized(requestRef: string, input: MaterializationRecord): RecordOutcome;
  recordPublicationIntent(requestRef: string, input: MaterializationRecord): RecordOutcome;
  recordPublicationPrepared(requestRef: string, input: MaterializationRecord): RecordOutcome;
  recordPublished(requestRef: string, input: MaterializationRecord): RecordOutcome;
  recordTempReserved(requestRef: string, input: MaterializationRecord): RecordOutcome;
  renew(requestRef: string, input: MaterializationRecord): RecordOutcome;
}
interface AuditPort { appendIdempotent(input: MaterializationRecord): RecordOutcome; getById(id: string): RecordOutcome }
interface ProofPort { beginLifecycle(input: MaterializationRecord): RecordOutcome; finishLifecycle(input: MaterializationRecord): RecordOutcome }

function requireRecord(record: MaterializationRecord | undefined, label: string): MaterializationRecord {
  if (!record) {
    throw failure("materialization_state_incomplete", 500, `${label} is unavailable.`);
  }
  return record;
}

function recordStageIs(stages: ReadonlySet<string>, record: MaterializationRecord): boolean {
  return typeof record.stage === "string" && stages.has(record.stage);
}

export const UPLOAD_WORKSPACE_MATERIALIZATION_SCHEMA_VERSION =
  "v0.0.1:jobs:upload-workspace-materialization-3";
export const UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID =
  "jobs.upload_workspace_materialize";

const RECOVERY_STAGES = new Set<string>([
  "publication_intent",
  "temp_reserved",
  "publication_prepared",
  "published",
  "evidence_pending",
  "audit_finalized",
  "proof_finalized"
]);
const PRECOMMIT_RECOVERY_STAGES = new Set<string>([
  "publication_intent",
  "temp_reserved",
  "publication_prepared"
]);
const COMMITTED_STAGES = new Set<string>([
  "published",
  "evidence_pending",
  "audit_finalized",
  "proof_finalized"
]);
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

function digest(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function text(value: unknown) {
  return String(value || "").trim();
}

function failure(code: string, statusCode: number, message: string) {
  return Object.assign(new Error(message), { code, statusCode });
}

function requireMethod(port: object | null | undefined, method: string, label: string) {
  const candidate = port && method in port ? (port as Record<string, unknown>)[method] : undefined;
  if (typeof candidate !== "function") {
    throw new TypeError(`${label}.${method} is required.`);
  }
}

function closedInput(record: MaterializationRecord) {
  return Object.freeze({
    expectedWorkspaceRevision: record.expectedWorkspaceRevision,
    logicalTarget: record.logicalTarget,
    safetyConfirm: true,
    uploadSessionId: record.uploadSessionId,
    workspaceId: record.workspaceId
  });
}

function ownerFromAuthority(authority?: MaterializationRecord) {
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

function publicResult(value: MaterializationRecord = {}, replayed = false) {
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

function boundedFaultValue(value: unknown, kind: FaultKind) {
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
  faultObserver: Record<string, ((input: FaultPayload) => Promise<void> | void) | undefined> | null,
  callbackName: keyof typeof FAULT_SCHEMAS,
  input: unknown
) {
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
  const expectedKeys = Object.keys(schema).sort();
  const actualKeys = Object.keys(input).sort();
  if (
    expectedKeys.join("\0") !== actualKeys.join("\0") ||
    expectedKeys.some(
      (key) => !boundedFaultValue(
        (input as Record<string, unknown>)[key],
        (schema as Record<string, FaultKind>)[key]
      )
    )
  ) {
    throw invalid();
  }
  const bounded = Object.freeze({ ...(input as FaultPayload) });
  await faultObserver?.[callbackName]?.(bounded);
  return bounded;
}

function createPublicationIntent(execution: MaterializationRecord) {
  const target = execution.target || {};
  const descriptor = requireRecord(execution.descriptor, "Materialization descriptor");
  const stateEventAnchor =
    execution.preimage?.stateEventAnchor ||
    execution.preimage?.snapshot?.stateEventAnchor ||
    target.anchor;
  const eventHash = text(stateEventAnchor?.eventHash)
    .replace(/^sha256:/u, "");
  if (
    !stateEventAnchor ||
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
  const base = Object.freeze({
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
      offset: Number(stateEventAnchor.offset),
      eventHash
    }),
    stateOperationId:
      `${execution.operationId}.state:${crypto.randomUUID()}`,
    targetStateDigest: target.targetStateDigest,
    tempLeafRef:
      `.meshrix-materialization-${crypto.randomUUID()}`
  });
  const intentDigest = digest({
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
  callbackName: string,
  requestRef: string,
  publication: MaterializationRecord
) {
  if (callbackName === "afterTempReservedBeforeFirstWrite") {
    return {
      publicationId: publication.publicationId,
      requestRef,
      reservationDigest: publication.reservationDigest,
      stateOperationId: publication.stateOperationId
    };
  }
  const digestKey = callbackName.includes("Intent") ||
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

function validatePublishedReceipt(execution: MaterializationRecord, receipt: MaterializationRecord) {
  const publication = execution.publication;
  const descriptor = requireRecord(execution.descriptor, "Materialization descriptor");
  if (
    receipt?.contentDigest !== descriptor.contentDigest ||
    Number(receipt?.byteCount) !== descriptor.byteCount ||
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

export function materializationFailureDisposition(error?: unknown) {
  const code = text(errorProperty(error, "code")) || "materialization_failed";
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
}: {
  authorityPort: AuthorityPort; custodyReadPort: CustodyReadPort;
  resourcePort: ResourcePort; workspacePort: WorkspacePort;
  transactionStore: TransactionStore;
  resolveOperation(operationId: string): MaterializationRecord;
  auditPort: AuditPort; proofPort: ProofPort;
  faultObserver?: FaultObserver | null; leaseHeartbeatMs?: number;
}) {
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
    requestRef: string; ownerFence?: string; signal?: AbortSignal | null;
    renewLease?: (() => Promise<void>) | null;
  }) {
    const stored = await transactionStore.get(requestRef);
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
    return workspacePort.withRequest(stored, async (workspace: WorkspaceSession) => {
      let execution = await transactionStore.begin(
        requestRef,
        { ownerFence }
      );
      if (execution.status === "completed") {
        return publicResult(execution.result, true);
      }
      let heartbeatFailure: unknown = null;
      let heartbeatInFlight = Promise.resolve();
      let proofEntry: MaterializationRecord | null = null;
      let proofLifecycleExpected =
        recordStageIs(RECOVERY_STAGES, execution);

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

      const beginProof = async (record: MaterializationRecord) => {
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
        record: MaterializationRecord,
        { status, reasonCode }: { status: "failed" | "in_doubt"; reasonCode: string }
      ) => {
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

      const markRollbackInDoubt = async (record: MaterializationRecord, reasonCode: string) => {
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

      const recordPublishedReceipt = async (record: MaterializationRecord, receipt: MaterializationRecord) => {
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

      const recoverPublication = async (record: MaterializationRecord) => {
        if (!recordStageIs(RECOVERY_STAGES, record)) return record;
        const recovered = await workspace.recover({
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
          if (!recordStageIs(PRECOMMIT_RECOVERY_STAGES, record)) {
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
          const publication = requireRecord(
            record.publication,
            "Materialization publication"
          );
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
        if (recordStageIs(PRECOMMIT_RECOVERY_STAGES, record)) {
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

      const settleCommitted = async (record: MaterializationRecord) => {
        let current = record;
        if (!recordStageIs(COMMITTED_STAGES, current)) {
          throw failure(
            "materialization_publication_wal_mismatch",
            409,
            "Materialization settlement requires a committed effect."
          );
        }
        await fence({ renew: true });
        const entry = proofEntry || await beginProof(current);
        if (current.stage === "published") {
          await transactionStore.recordEvidencePending(requestRef, {
            ownerFence
          });
          current = await transactionStore.get(requestRef);
          const pendingEvidence = requireRecord(
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
        const evidence = requireRecord(
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
        const publication = requireRecord(
          current.publication,
          "Materialization publication"
        );
        const currentResult = requireRecord(
          current.result,
          "Materialization result"
        );
        const descriptor = requireRecord(
          current.descriptor,
          "Materialization descriptor"
        );
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
          current = await transactionStore.get(requestRef);
        } else if (
          requireRecord(current.evidence, "Materialization evidence").auditRef !==
            `audit:${audit.auditId}`
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
          current = await transactionStore.get(requestRef);
        } else if (
          requireRecord(current.evidence, "Materialization evidence").proofRef !==
            `proof:${proofLedgerEventId}`
        ) {
          throw failure(
            "materialization_evidence_wal_mismatch",
            409,
            "Materialization proof reference does not match."
          );
        }
        await fence({ renew: true });
        const finalEvidence = requireRecord(
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

      try {
        await fence({ renew: true });
        execution = await recoverPublication(execution);
        if (recordStageIs(COMMITTED_STAGES, execution)) {
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
        execution = await transactionStore.get(requestRef);

        proofEntry = await beginProof(execution);
        let publication: MaterializationRecord = createPublicationIntent({
          ...execution,
          target
        });
        await fence({ renew: true });
        let claimedPublicationResourceRevision = "";
        const published = await workspace.materialize({
          publication,
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
                  publication
                }
              );
            publication = requireRecord(
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
              const descriptor = requireRecord(
                execution.descriptor,
                "Materialization descriptor"
              );
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
          recordTempReserved: async (candidate: MaterializationRecord) => {
            const recorded = await transactionStore.recordTempReserved(
              requestRef,
              {
                ownerFence,
                publication: candidate
              }
            );
            execution = recorded;
            publication = requireRecord(
              recorded.publication,
              "Materialization publication"
            );
            return publication;
          },
          recordPublicationPrepared: async (candidate: MaterializationRecord) => {
            const recorded =
              await transactionStore.recordPublicationPrepared(
                requestRef,
                {
                  ownerFence,
                  publication: candidate
                }
              );
            execution = recorded;
            publication = requireRecord(
              recorded.publication,
              "Materialization publication"
            );
            return publication;
          },
          afterDirectoryWorkerBoundBeforeReserve: (candidate: MaterializationRecord) =>
            invokeMaterializationFault(
              faultObserver,
              "afterDirectoryWorkerBoundBeforeReserve",
              {
                ...candidate,
                requestRef
              }
            ),
          afterTempInodeReservedBeforeWal: (candidate: MaterializationRecord) =>
            invokeMaterializationFault(
              faultObserver,
              "afterTempInodeReservedBeforeWal",
              {
                ...candidate,
                requestRef
              }
            ),
          afterTempReservedBeforeFirstWrite: (candidate: MaterializationRecord) =>
            invokeMaterializationFault(
              faultObserver,
              "afterTempReservedBeforeFirstWrite",
              {
                ...candidate,
                requestRef
              }
            ),
          afterFirstChunkWrittenBeforeContinue: (candidate: MaterializationRecord) =>
            invokeMaterializationFault(
              faultObserver,
              "afterFirstChunkWrittenBeforeContinue",
              {
                ...candidate,
                requestRef
              }
            ),
          afterPublicationPreparedBeforeLink: (candidate: MaterializationRecord) =>
            invokeMaterializationFault(
              faultObserver,
              "afterPublicationPreparedBeforeLink",
              {
                ...candidate,
                requestRef
              }
            ),
          afterPublicationLinkedBeforeTempUnlink: (candidate: MaterializationRecord) =>
            invokeMaterializationFault(
              faultObserver,
              "afterPublicationLinkedBeforeTempUnlink",
              {
                ...candidate,
                requestRef
              }
            ),
          afterPublishedFileDurableBeforeStateCommit: (candidate: MaterializationRecord) =>
            invokeMaterializationFault(
              faultObserver,
              "afterPublishedFileDurableBeforeStateCommit",
              {
                ...candidate,
                requestRef
              }
            ),
          afterStateAndCheckpointDurableBeforeReceipt: (candidate: MaterializationRecord) =>
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
          let current = await transactionStore.get(requestRef);
          if (recordStageIs(RECOVERY_STAGES, current)) {
            try {
              current = await recoverPublication(current);
              if (recordStageIs(COMMITTED_STAGES, current)) {
                return await settleCommitted(current);
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
          if (!recordStageIs(RECOVERY_STAGES, current)) {
            const disposition =
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
