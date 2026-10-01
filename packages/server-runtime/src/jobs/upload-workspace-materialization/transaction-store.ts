import path from "node:path";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import { ensurePrivateDir } from "#meshrix/foundation/storage/private-file-atomic";
import { ensurePrivateSqliteLocation } from "#meshrix/foundation/storage/private-sqlite";
import { ensureCurrentSchema } from "./schema.ts";
import {
  DEFAULT_LEASE_MS,
  MAX_RECONCILE_BATCH,
  boundedId,
  canonicalErrorJson,
  digest,
  factsFromRow,
  failure,
  hydrateStoredRequestRow,
  isMaterializationCompletedState,
  isMaterializationRunningState,
  normalizeCompletedResult,
  normalizeFsIdentity,
  normalizePreimage,
  normalizePublicationIntent,
  normalizePublicationPrepared,
  normalizePublicationReserved,
  normalizePublishedEffect,
  normalizeRequestRecord,
  normalizeStateEventAnchor,
  parseStoredJson,
  sameCanonical,
  settlementEvidence,
  sha256Digest,
  text,
  type MaterializationCompletedState,
  type MaterializationDurableState,
  type MaterializationFenceInput,
  type MaterializationOperationResult,
  type MaterializationPublicationIntentState,
  type MaterializationPublicationPreparedState,
  type MaterializationRecordPreimageInput,
  type MaterializationRecordPublicationInput,
  type MaterializationRecordPublishedInput,
  type MaterializationRunningState,
  type MaterializationStoreCancelResult,
  type MaterializationStoreCreateResult,
  type MaterializationStoreLeaseState,
  type MaterializationStoreReconcileInput,
  type MaterializationStoreTerminalState,
  type MaterializationTempReservedState,
  type MaterializationTransactionStore,
  type PublicationIntent,
  type PublicationPrepared,
  type PublicationReservation
} from "./model.ts";

/**
 * Cohesive SQLite transaction store for governed upload-workspace
 * materialization. This module owns its database connection, lease fences and
 * every atomic command that transitions a durable request row; the engine and
 * the composition adapter consume the model-typed contract.
 */

export function createUploadWorkspaceMaterializationTransactionStore({
  userDataPath,
  leaseMs = DEFAULT_LEASE_MS,
  now = Date.now
}: {
  userDataPath?: unknown;
  leaseMs?: number;
  now?: () => number;
} = {}): MaterializationTransactionStore {
  const root: string =
    typeof userDataPath === "string" ? userDataPath : "";
  if (
    !root.trim() ||
    typeof now !== "function" ||
    typeof leaseMs !== "number" ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs <= 0
  ) {
    throw new TypeError(
      "Materialization transaction store dependencies are invalid."
    );
  }
  const jobsRoot: string = path.join(root, "jobs");
  ensurePrivateDir(jobsRoot);
  const databasePath: string = ensurePrivateSqliteLocation(
    path.join(jobsRoot, "upload-workspace-materialization.sqlite")
  );
  let db: any = null;
  try {
    db = openSqliteDatabase(databasePath);
    ensureCurrentSchema(db, now);
  } catch (error: any) {
    try {
      db?.close?.();
    } catch {
      // Preserve the schema initialization failure.
    }
    throw error;
  }
  const read: any = db.prepare(`
    SELECT *
    FROM materialization_requests
    WHERE request_ref = ?
  `);
  const timestamp = (): string =>
    new Date(Number(now())).toISOString();
  const hydrate = (
    row: unknown
  ): MaterializationDurableState | null =>
    row === null || row === undefined
      ? null
      : hydrateStoredRequestRow(row);
  const requireStoredState = (
    state: MaterializationDurableState | null
  ): MaterializationDurableState => {
    if (!state) {
      throw failure(
        "materialization_request_missing",
        404,
        "Materialization request is missing."
      );
    }
    return state;
  };
  const requireRunningOrCompleted = (
    state: MaterializationDurableState | null
  ): MaterializationRunningState | MaterializationCompletedState => {
    const stored = requireStoredState(state);
    if (
      isMaterializationCompletedState(stored) ||
      isMaterializationRunningState(stored)
    ) {
      return stored;
    }
    throw failure(
      "materialization_request_terminal",
      409,
      "Materialization request is terminal."
    );
  };
  const requireChange = (result?: { changes?: number }): void => {
    if (Number(result?.changes || 0) !== 1) {
      throw failure(
        "materialization_fenced",
        409,
        "Materialization lease fence was lost."
      );
    }
  };
  const assertLiveFence = (
    requestRef: string,
    ownerFence?: string
  ): Record<string, any> => {
    const row: any = read.get(requestRef);
    if (
      !row ||
      row.status !== "running" ||
      row.owner_fence !== ownerFence ||
      Number(row.lease_until) < Number(now())
    ) {
      throw failure(
        "materialization_fenced",
        409,
        "Materialization lease fence was lost."
      );
    }
    hydrate(row);
    return row;
  };
  const walMismatch = () => failure(
    "materialization_publication_wal_mismatch",
    409,
    "Publication write-ahead descriptor does not match."
  );
  const requirePublicationIntentState = (
    state: MaterializationDurableState | null
  ): MaterializationPublicationIntentState => {
    const stored = requireStoredState(state);
    if (stored.stage !== "publication_intent") throw walMismatch();
    return stored;
  };
  const requireTempReservedState = (
    state: MaterializationDurableState | null
  ): MaterializationTempReservedState => {
    const stored = requireStoredState(state);
    if (stored.stage !== "temp_reserved") throw walMismatch();
    return stored;
  };
  const requirePublicationPreparedState = (
    state: MaterializationDurableState | null
  ): MaterializationPublicationPreparedState => {
    const stored = requireStoredState(state);
    if (stored.stage !== "publication_prepared") throw walMismatch();
    return stored;
  };
  const currentLeaseMs: number = leaseMs;

  return Object.freeze({
    async create(value: unknown): Promise<MaterializationStoreCreateResult> {
      const request: any = normalizeRequestRecord(value);
      const requestJson: any = canonicalJson(request);
      const result: any = db.prepare(`
        INSERT OR IGNORE INTO materialization_requests (
          request_ref,
          status,
          stage,
          request_json,
          request_digest,
          updated_at
        ) VALUES (?, 'queued', 'admitted', ?, ?, ?)
      `).run(
        request.requestRef,
        requestJson,
        digest(request),
        timestamp()
      );
      return Object.freeze({
        inserted: Number(result.changes || 0) === 1
      });
    },
    async get(requestRef: string): Promise<MaterializationDurableState | null> {
      return hydrate(read.get(requestRef));
    },
    async begin(requestRef: string, { ownerFence }: MaterializationFenceInput): Promise<MaterializationRunningState | MaterializationCompletedState> {
      const current: any = Number(now());
      const normalizedOwnerFence: any = boundedId(
        ownerFence,
        "Materialization owner fence"
      );
      const existing: any = hydrate(read.get(requestRef));
      if (!existing) {
        throw failure(
          "materialization_request_missing",
          404,
          "Materialization request is missing."
        );
      }
      if (existing.status === "completed") return existing;
      if (["cancelled", "failed"].includes(existing.status)) {
        throw failure(
          "materialization_request_terminal",
          409,
          "Materialization request is terminal."
        );
      }
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET status = 'running',
            owner_fence = ?,
            lease_until = ?,
            error_json = NULL,
            updated_at = ?
        WHERE request_ref = ?
          AND (
            status = 'queued' OR
            (status = 'running' AND lease_until < ?)
          )
      `).run(
        normalizedOwnerFence,
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        current
      ));
      return requireRunningOrCompleted(hydrate(read.get(requestRef)));
    },
    async renew(requestRef: string, { ownerFence }: MaterializationFenceInput): Promise<void> {
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET lease_until = ?, updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        ownerFence,
        current
      ));
    },
    async assertFence(requestRef: string, { ownerFence }: MaterializationFenceInput): Promise<boolean> {
      assertLiveFence(requestRef, ownerFence);
      return true;
    },
    async recordPreimage(
      requestRef: string,
      {
        ownerFence,
        preimage,
        targetStateDigest,
        parentFingerprint,
        parentIdentity,
        stateEventAnchor = null
      }: MaterializationRecordPreimageInput
    ): Promise<MaterializationDurableState> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      if (
        row.stage !== "admitted" ||
        row.publication_json
      ) {
        throw walMismatch();
      }
      const request: any = normalizeRequestRecord(
        parseStoredJson(
          row.request_json,
          "Materialization request record"
        )
      );
      const normalizedPreimage: any = normalizePreimage(
        preimage,
        request
      );
      const normalizedAnchor: any = normalizeStateEventAnchor(
        normalizedPreimage.stateEventAnchor
      );
      if (
        stateEventAnchor &&
        !sameCanonical(
          normalizedAnchor,
          normalizeStateEventAnchor(stateEventAnchor)
        )
      ) {
        throw walMismatch();
      }
      const normalizedTargetStateDigest: any = sha256Digest(
        targetStateDigest,
        "Materialization target-state digest"
      );
      const normalizedParentFingerprint: any = sha256Digest(
        parentFingerprint,
        "Materialization parent fingerprint"
      );
      const normalizedParentIdentity: any = normalizeFsIdentity(
        parentIdentity,
        "Materialization parent identity"
      );
      const preimageJson: any = canonicalJson(normalizedPreimage);
      const parentIdentityJson: any = canonicalJson(
        normalizedParentIdentity
      );
      if (row.preimage_json) {
        if (
          row.preimage_json !== preimageJson ||
          row.target_state_digest !==
            normalizedTargetStateDigest ||
          row.parent_fingerprint !==
            normalizedParentFingerprint ||
          row.parent_identity_json !== parentIdentityJson ||
          row.prior_revision !==
            request.expectedWorkspaceRevision
        ) {
          throw walMismatch();
        }
        return requireStoredState(hydrate(row));
      }
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET preimage_json = ?,
            target_state_digest = ?,
            parent_fingerprint = ?,
            parent_identity_json = ?,
            prior_revision = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'admitted'
          AND preimage_json IS NULL
          AND publication_json IS NULL
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        preimageJson,
        normalizedTargetStateDigest,
        normalizedParentFingerprint,
        parentIdentityJson,
        request.expectedWorkspaceRevision,
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        ownerFence,
        current
      ));
      return requireStoredState(hydrate(read.get(requestRef)));
    },
    async recordPublicationIntent(
      requestRef: string,
      { ownerFence, publication }: MaterializationRecordPublicationInput<PublicationIntent>
    ): Promise<MaterializationPublicationIntentState> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const request: any = normalizeRequestRecord(
        parseStoredJson(
          row.request_json,
          "Materialization request record"
        )
      );
      const normalized: any = normalizePublicationIntent(
        publication,
        factsFromRow(row, request)
      );
      const publicationJson: any = canonicalJson(normalized);
      if (row.stage === "publication_intent") {
        if (row.publication_json !== publicationJson) {
          throw walMismatch();
        }
        return requirePublicationIntentState(hydrate(row));
      }
      if (
        row.stage !== "admitted" ||
        !row.preimage_json ||
        row.publication_json
      ) {
        throw walMismatch();
      }
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'publication_intent',
            publication_json = ?,
            prior_revision = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'admitted'
          AND preimage_json IS NOT NULL
          AND publication_json IS NULL
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        publicationJson,
        normalized.priorRevision,
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        ownerFence,
        current
      ));
      return requirePublicationIntentState(hydrate(read.get(requestRef)));
    },
    async recordTempReserved(
      requestRef: string,
      { ownerFence, publication }: MaterializationFenceInput & { publication: unknown }
    ): Promise<MaterializationTempReservedState> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const request: any = normalizeRequestRecord(
        parseStoredJson(
          row.request_json,
          "Materialization request record"
        )
      );
      const facts: any = factsFromRow(row, request);
      const normalized: any = normalizePublicationReserved(
        publication,
        facts
      );
      const publicationJson: any = canonicalJson(normalized);
      if (row.stage === "temp_reserved") {
        if (row.publication_json !== publicationJson) {
          throw walMismatch();
        }
        return requireTempReservedState(hydrate(row));
      }
      if (
        row.stage !== "publication_intent" ||
        !row.publication_json
      ) {
        throw walMismatch();
      }
      const existing: any = normalizePublicationIntent(
        parseStoredJson(
          row.publication_json,
          "Materialization publication intent"
        ),
        facts
      );
      if (
        existing.intentDigest !== normalized.intentDigest ||
        existing.publicationId !== normalized.publicationId ||
        existing.stateOperationId !==
          normalized.stateOperationId
      ) {
        throw walMismatch();
      }
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'temp_reserved',
            publication_json = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'publication_intent'
          AND publication_json = ?
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        publicationJson,
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        row.publication_json,
        ownerFence,
        current
      ));
      return requireTempReservedState(hydrate(read.get(requestRef)));
    },
    async recordPublicationPrepared(
      requestRef: string,
      { ownerFence, publication }: MaterializationFenceInput & { publication: unknown }
    ): Promise<MaterializationPublicationPreparedState> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const request: any = normalizeRequestRecord(
        parseStoredJson(
          row.request_json,
          "Materialization request record"
        )
      );
      const facts: any = factsFromRow(row, request);
      const normalized: any = normalizePublicationPrepared(
        publication,
        facts
      );
      const publicationJson: any = canonicalJson(normalized);
      if (row.stage === "publication_prepared") {
        if (row.publication_json !== publicationJson) {
          throw walMismatch();
        }
        return requirePublicationPreparedState(hydrate(row));
      }
      if (
        row.stage !== "temp_reserved" ||
        !row.publication_json
      ) {
        throw walMismatch();
      }
      const existing: any = normalizePublicationReserved(
        parseStoredJson(
          row.publication_json,
          "Materialization reservation"
        ),
        facts
      );
      if (
        existing.reservationDigest !==
          normalized.reservationDigest ||
        !sameCanonical(
          existing.preparedIdentity,
          normalized.preparedIdentity
        )
      ) {
        throw walMismatch();
      }
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'publication_prepared',
            publication_json = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'temp_reserved'
          AND publication_json = ?
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        publicationJson,
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        row.publication_json,
        ownerFence,
        current
      ));
      return requirePublicationPreparedState(hydrate(read.get(requestRef)));
    },
    async recordPublished(
      requestRef: string,
      {
        ownerFence,
        checkpointRef,
        proofDigest,
        publicationId,
        publishedIdentity,
        publishedRevision,
        priorRevision,
        stateOperationId
      }: MaterializationRecordPublishedInput
    ): Promise<MaterializationDurableState> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      if (!row.publication_json) throw walMismatch();
      const request: any = normalizeRequestRecord(
        parseStoredJson(
          row.request_json,
          "Materialization request record"
        )
      );
      const facts: any = factsFromRow(row, request);
      const storedPublication: any = parseStoredJson(
        row.publication_json,
        "Materialization publication"
      );
      if (
        ![
          "publication_prepared",
          "published",
          "evidence_pending",
          "audit_finalized",
          "proof_finalized"
        ].includes(row.stage)
      ) {
        throw walMismatch();
      }
      const publication: any = normalizePublicationPrepared(
        storedPublication,
        facts
      );
      if (
        boundedId(
          priorRevision,
          "Publication prior revision"
        ) !== request.expectedWorkspaceRevision
      ) {
        throw walMismatch();
      }
      const effect: any = normalizePublishedEffect(
        {
          byteCount: request.descriptor.byteCount,
          checkpointRef,
          contentDigest: request.descriptor.contentDigest,
          proofDigest,
          publicationId,
          publishedIdentity,
          publishedRevision,
          stateOperationId
        },
        request,
        publication
      );
      const effectJson: any = canonicalJson(effect);
      const resultJson: any = canonicalJson({
        checkpointRef: effect.checkpointRef
      });
      if (
        [
          "published",
          "evidence_pending",
          "audit_finalized",
          "proof_finalized"
        ].includes(row.stage)
      ) {
        if (
          row.published_revision !== effect.publishedRevision ||
          row.effect_json !== effectJson ||
          row.result_json !== resultJson
        ) {
          throw walMismatch();
        }
        return requireStoredState(hydrate(row));
      }
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'published',
            publication_json = ?,
            published_revision = ?,
            prior_revision = ?,
            effect_json = ?,
            result_json = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'publication_prepared'
          AND publication_json = ?
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        canonicalJson(publication),
        effect.publishedRevision,
        request.expectedWorkspaceRevision,
        effectJson,
        resultJson,
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        row.publication_json,
        ownerFence,
        current
      ));
      return requireStoredState(hydrate(read.get(requestRef)));
    },
    async recordPrecommitCleaned(
      requestRef: string,
      {
        ownerFence,
        publicationId,
        reservationDigest
      }: MaterializationFenceInput & {
        publicationId: string;
        reservationDigest: string;
      }
    ): Promise<MaterializationDurableState> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      if (
        ![
          "publication_intent",
          "temp_reserved",
          "publication_prepared",
        ].includes(row.stage) ||
        !row.publication_json
      ) {
        throw walMismatch();
      }
      const currentRecord = requireStoredState(hydrate(row));
      const publication: any = currentRecord.publication;
      const normalizedReservationDigest: any =
        publication.reservationDigest
          ? sha256Digest(
              reservationDigest,
              "Publication reservation digest"
            )
          : reservationDigest === ""
            ? ""
            : null;
      if (
        boundedId(publicationId, "Publication identity") !==
          publication.publicationId ||
        normalizedReservationDigest !==
          publication.reservationDigest
      ) {
        throw walMismatch();
      }
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'admitted',
            preimage_json = NULL,
            target_state_digest = '',
            parent_fingerprint = '',
            parent_identity_json = NULL,
            publication_json = NULL,
            published_revision = '',
            prior_revision = '',
            effect_json = NULL,
            evidence_json = NULL,
            result_json = NULL,
            error_json = NULL,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage IN (
            'publication_intent',
            'temp_reserved',
            'publication_prepared'
          )
          AND publication_json = ?
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        row.publication_json,
        ownerFence,
        current
      ));
      return requireStoredState(hydrate(read.get(requestRef)));
    },
    async recordEvidencePending(
      requestRef: string,
      { ownerFence }: MaterializationFenceInput
    ): Promise<MaterializationDurableState> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      if (
        [
          "evidence_pending",
          "audit_finalized",
          "proof_finalized"
        ].includes(row.stage)
      ) {
        return requireStoredState(hydrate(row));
      }
      if (
        row.stage !== "published" ||
        !row.publication_json ||
        !row.effect_json ||
        row.evidence_json
      ) {
        throw walMismatch();
      }
      const currentRecord = requireStoredState(hydrate(row));
      if (currentRecord.stage !== "published") throw walMismatch();
      const evidence: any = settlementEvidence({
        request: currentRecord,
        publication: currentRecord.publication,
        effect: currentRecord.effect,
        auditCreatedAt: timestamp()
      });
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'evidence_pending',
            evidence_json = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'published'
          AND evidence_json IS NULL
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        canonicalJson(evidence),
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        ownerFence,
        current
      ));
      return requireStoredState(hydrate(read.get(requestRef)));
    },
    async recordAuditFinalized(
      requestRef: string,
      {
        ownerFence,
        auditRef,
        settlementDigest
      }: MaterializationFenceInput & {
        auditRef: string;
        settlementDigest: string;
      }
    ): Promise<MaterializationDurableState> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const currentRecord = requireStoredState(hydrate(row));
      const evidence: any = currentRecord.evidence;
      const normalizedAuditRef: any = boundedId(
        auditRef,
        "Materialization audit reference"
      );
      if (
        !evidence ||
        settlementDigest !== evidence.settlementDigest ||
        normalizedAuditRef !== `audit:${evidence.auditId}`
      ) {
        throw walMismatch();
      }
      if (
        ["audit_finalized", "proof_finalized"].includes(
          row.stage
        )
      ) {
        if (evidence.auditRef !== normalizedAuditRef) {
          throw walMismatch();
        }
        return currentRecord;
      }
      if (row.stage !== "evidence_pending") {
        throw walMismatch();
      }
      const finalized: Readonly<Record<string, any>> = Object.freeze({
        ...evidence,
        auditRef: normalizedAuditRef
      });
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'audit_finalized',
            evidence_json = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'evidence_pending'
          AND evidence_json = ?
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        canonicalJson(finalized),
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        row.evidence_json,
        ownerFence,
        current
      ));
      return requireStoredState(hydrate(read.get(requestRef)));
    },
    async recordProofFinalized(
      requestRef: string,
      {
        ownerFence,
        proofRef,
        settlementDigest
      }: MaterializationFenceInput & {
        proofRef: string;
        settlementDigest: string;
      }
    ): Promise<MaterializationDurableState> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const currentRecord = requireStoredState(hydrate(row));
      const evidence: any = currentRecord.evidence;
      const normalizedProofRef: any = boundedId(
        proofRef,
        "Materialization proof reference"
      );
      if (
        !evidence ||
        settlementDigest !== evidence.settlementDigest
      ) {
        throw walMismatch();
      }
      if (row.stage === "proof_finalized") {
        if (evidence.proofRef !== normalizedProofRef) {
          throw walMismatch();
        }
        return currentRecord;
      }
      if (
        row.stage !== "audit_finalized" ||
        !evidence.auditRef
      ) {
        throw walMismatch();
      }
      const finalized: Readonly<Record<string, any>> = Object.freeze({
        ...evidence,
        proofRef: normalizedProofRef
      });
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'proof_finalized',
            evidence_json = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'audit_finalized'
          AND evidence_json = ?
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        canonicalJson(finalized),
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        row.evidence_json,
        ownerFence,
        current
      ));
      return requireStoredState(hydrate(read.get(requestRef)));
    },
    async complete(
      requestRef: string,
      {
        ownerFence,
        result,
        settlementDigest
      }: MaterializationFenceInput & {
        result: MaterializationOperationResult;
        settlementDigest: string;
      }
    ): Promise<MaterializationDurableState> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const currentRecord = requireStoredState(hydrate(row));
      if (currentRecord.stage !== "proof_finalized") throw walMismatch();
      const evidence: any = currentRecord.evidence;
      if (
        row.stage !== "proof_finalized" ||
        !evidence ||
        evidence.settlementDigest !== settlementDigest
      ) {
        throw walMismatch();
      }
      const normalizedResult: any = normalizeCompletedResult(
        result,
        {
          request: currentRecord,
          effect: currentRecord.effect,
          evidence
        }
      );
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET status = 'completed',
            stage = 'completed',
            result_json = ?,
            error_json = NULL,
            owner_fence = '',
            lease_until = 0,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'proof_finalized'
          AND evidence_json = ?
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        canonicalJson(normalizedResult),
        timestamp(),
        requestRef,
        row.evidence_json,
        ownerFence,
        current
      ));
      return requireStoredState(hydrate(read.get(requestRef)));
    },
    async fail(
      requestRef: string,
      { ownerFence, recoverable, error }: MaterializationFenceInput & {
        error: { code: string };
        recoverable: boolean;
      }
    ): Promise<MaterializationDurableState> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      if (
        row.stage !== "admitted" ||
        row.publication_json ||
        row.effect_json ||
        row.evidence_json
      ) {
        throw failure(
          "materialization_recovery_required",
          409,
          "Materialization recovery must settle before failure."
        );
      }
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET status = ?,
            stage = 'admitted',
            preimage_json = NULL,
            target_state_digest = '',
            parent_fingerprint = '',
            parent_identity_json = NULL,
            prior_revision = '',
            error_json = ?,
            owner_fence = '',
            lease_until = 0,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'admitted'
          AND publication_json IS NULL
          AND effect_json IS NULL
          AND evidence_json IS NULL
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        recoverable ? "queued" : "failed",
        canonicalErrorJson(
          error,
          "materialization_failed"
        ),
        timestamp(),
        requestRef,
        ownerFence,
        current
      ));
      return requireStoredState(hydrate(read.get(requestRef)));
    },
    async markRollbackIncomplete(
      requestRef: string,
      { ownerFence, error }: MaterializationFenceInput & {
        error: { code: string };
      }
    ): Promise<void> {
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET status = 'failed',
            stage = 'rollback_incomplete',
            error_json = ?,
            owner_fence = '',
            lease_until = 0,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND (
            stage IN (
              'publication_intent',
              'temp_reserved',
              'publication_prepared',
              'published',
              'evidence_pending',
              'audit_finalized',
              'proof_finalized'
            )
            OR (stage = 'admitted' AND preimage_json IS NOT NULL)
          )
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        canonicalErrorJson(
          error,
          "materialization_rollback_incomplete"
        ),
        timestamp(),
        requestRef,
        ownerFence,
        current
      ));
    },
    async cancelQueued(requestRef: string): Promise<MaterializationStoreCancelResult> {
      const result: any = db.prepare(`
        UPDATE materialization_requests
        SET status = 'cancelled',
            stage = 'admitted',
            preimage_json = NULL,
            target_state_digest = '',
            parent_fingerprint = '',
            parent_identity_json = NULL,
            prior_revision = '',
            error_json = NULL,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'queued'
          AND stage = 'admitted'
          AND publication_json IS NULL
      `).run(timestamp(), requestRef);
      return Object.freeze({
        cancelled: Number(result.changes || 0) === 1
      });
    },
    async terminalFail(requestRef: string, error: unknown): Promise<MaterializationStoreTerminalState> {
      const before: any = read.get(requestRef);
      if (!before) {
        return Object.freeze({
          transitioned: false,
          terminal: false,
          status: "missing",
          stage: ""
        });
      }
      const currentRecord = requireStoredState(hydrate(before));
      if (
        ["cancelled", "completed", "failed"].includes(
          currentRecord.status
        )
      ) {
        return Object.freeze({
          transitioned: false,
          terminal: true,
          status: currentRecord.status,
          stage: currentRecord.stage
        });
      }
      const changed: any = db.prepare(`
        UPDATE materialization_requests
        SET status = 'failed',
            stage = 'admitted',
            preimage_json = NULL,
            target_state_digest = '',
            parent_fingerprint = '',
            parent_identity_json = NULL,
            prior_revision = '',
            error_json = ?,
            owner_fence = '',
            lease_until = 0,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'queued'
          AND stage = 'admitted'
          AND publication_json IS NULL
          AND effect_json IS NULL
          AND evidence_json IS NULL
      `).run(
        canonicalErrorJson(
          error,
          "materialization_retry_exhausted"
        ),
        timestamp(),
        requestRef
      );
      const after: any = read.get(requestRef);
      const afterRecord = after ? requireStoredState(hydrate(after)) : null;
      return Object.freeze({
        transitioned:
          Number(changed.changes || 0) === 1,
        terminal: Boolean(
          afterRecord &&
          ["cancelled", "completed", "failed"].includes(
            afterRecord.status
          )
        ),
        status: afterRecord?.status || "missing",
        stage: afterRecord?.stage || ""
      });
    },
    async listReconcileCandidates({
      afterRequestRef = "",
      limit = MAX_RECONCILE_BATCH
    }: MaterializationStoreReconcileInput = {}): Promise<MaterializationDurableState[]> {
      const boundedLimit: any = Math.max(
        1,
        Math.min(
          MAX_RECONCILE_BATCH,
          Number.isSafeInteger(Number(limit))
            ? Number(limit)
            : MAX_RECONCILE_BATCH
        )
      );
      return db.prepare(`
        SELECT *
        FROM materialization_requests
        WHERE status IN ('queued', 'running')
          AND request_ref > ?
        ORDER BY request_ref ASC
        LIMIT ?
      `).all(text(afterRequestRef), boundedLimit).map(
        (row: unknown) => requireStoredState(hydrate(row))
      );
    },
    async retryAfterLease(requestRef: string): Promise<MaterializationStoreLeaseState> {
      const row: any = read.get(requestRef);
      if (!row) {
        return Object.freeze({
          delayMs: 1,
          terminal: false,
          status: "missing",
          stage: ""
        });
      }
      const currentRecord = requireStoredState(hydrate(row));
      const terminal: any = [
        "cancelled",
        "completed",
        "failed"
      ].includes(currentRecord.status);
      return Object.freeze({
        delayMs: terminal
          ? 0
          : Math.max(
              1,
              currentRecord.leaseUntil -
                Number(now()) +
                1
            ),
        terminal,
        status: currentRecord.status,
        stage: currentRecord.stage
      });
    },
    count(): number {
      return Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM materialization_requests"
          )
          .get().count
      );
    },
    close(): void {
      db.close();
    }
  });
}
