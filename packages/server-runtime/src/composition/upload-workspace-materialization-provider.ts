import crypto from "node:crypto";
import path from "node:path";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import {
  assertAgentWorkspaceMaterializationPort
} from "#meshrix/agents/agent-workspace/agent-workspace-materialization-port";
import { ensurePrivateDir } from "#meshrix/foundation/storage/private-file-atomic";
import { ensurePrivateSqliteLocation } from "#meshrix/foundation/storage/private-sqlite";
import {
  createUploadWorkspaceMaterialization,
  materializationFailureDisposition,
  UPLOAD_WORKSPACE_MATERIALIZATION_SCHEMA_VERSION
} from "../jobs/upload-workspace-materialization.ts";

const DEFINITION_ID: any =
  "queue.jobs.upload-workspace-materialization";
const DEFINITION_VERSION: any = 3;
const DEFAULT_LEASE_MS: any = 60_000;
const MAX_DESCRIPTOR_BYTES: any = 64 * 1024 * 1024;
const SCHEMA_VERSION: any = 1;
const SCHEMA_FINGERPRINT_VERSION: any =
  "v0.0.1:server-runtime:upload-workspace-materialization-schema-1";
const PUBLICATION_INTENT_VERSION: any =
  "v0.0.1:agent-workspace:materialization-publication-intent-2";
const PUBLICATION_RESERVATION_VERSION: any =
  "v0.0.1:agent-workspace:materialization-publication-reservation-1";
const PUBLICATION_PROOF_VERSION: any =
  "v0.0.1:agent-workspace:materialization-publication-proof-2";
const SETTLEMENT_VERSION: any =
  "v0.0.1:server-runtime:upload-workspace-materialization-settlement-1";
const RECONCILE_INDEX: any =
  "idx_materialization_requests_reconcile";
const MAX_RECONCILE_BATCH: any = 256;
const MATERIALIZATION_MAX_ATTEMPTS: any = 1_000_000;
const REQUEST_STATUSES: readonly any[] = Object.freeze([
  "cancelled",
  "completed",
  "failed",
  "queued",
  "running"
]);
const REQUEST_STAGES: readonly any[] = Object.freeze([
  "admitted",
  "publication_intent",
  "temp_reserved",
  "publication_prepared",
  "published",
  "evidence_pending",
  "audit_finalized",
  "proof_finalized",
  "completed",
  "rollback_incomplete"
]);
const REQUEST_COLUMNS: readonly any[] = Object.freeze([
  "effect_json",
  "error_json",
  "evidence_json",
  "lease_until",
  "owner_fence",
  "parent_fingerprint",
  "parent_identity_json",
  "preimage_json",
  "prior_revision",
  "publication_json",
  "published_revision",
  "request_digest",
  "request_json",
  "request_ref",
  "result_json",
  "stage",
  "status",
  "target_state_digest",
  "updated_at"
]);
const LEGACY_WORKTREE_REQUEST_COLUMNS: readonly any[] = Object.freeze([
  "error_json",
  "lease_until",
  "owner_fence",
  "parent_fingerprint",
  "preimage_json",
  "prior_revision",
  "publication_json",
  "published_revision",
  "request_json",
  "request_ref",
  "result_json",
  "stage",
  "status",
  "target_state_digest",
  "updated_at"
]);
const LEGACY_AUXILIARY_TABLES: readonly any[] = Object.freeze([
  "materialization_capacity",
  "materialization_inputs",
  "materialization_scope_capacity"
]);
const LEGACY_AUXILIARY_COLUMNS: Readonly<Record<string, any>> = Object.freeze({
  materialization_capacity: Object.freeze([
    "input_bytes",
    "request_count",
    "singleton"
  ]),
  materialization_inputs: Object.freeze([
    "byte_size",
    "content_sha256",
    "custody_rel_path",
    "request_ref",
    "source_path"
  ]),
  materialization_scope_capacity: Object.freeze([
    "active_bytes",
    "scope_ref"
  ])
});
const REQUEST_RECORD_KEYS: readonly any[] = Object.freeze([
  "approvalIntentDigest",
  "authorityBindingDigest",
  "authorityRef",
  "bindingDigest",
  "descriptor",
  "expectedWorkspaceRevision",
  "logicalTarget",
  "operationId",
  "requestDigest",
  "requestRef",
  "resourceRevision",
  "uploadSessionId",
  "workspaceId"
]);
const SCHEMA_FINGERPRINT: any = digestSchema();

function digest(value?: any) : any {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function digestSchema() : any {
  return digest({
    version: SCHEMA_FINGERPRINT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    requestColumns: REQUEST_COLUMNS,
    statuses: REQUEST_STATUSES,
    stages: REQUEST_STAGES
  });
}

function text(value?: any) : any {
  return String(value || "").trim();
}

function failure(code?: any, statusCode?: any, message?: any) : any {
  return Object.assign(new Error(message), { code, statusCode });
}

function normalizedOwner(value: Record<string, any> = {}) : any {
  const user: any = value?.user || value;
  const subjectCandidate: any =
    user?.subjectId ?? user?.userId ?? user?.id;
  const tenantCandidate: any =
    user?.tenantId ?? user?.tenant ?? "default";
  const validIdentity: any = (candidate?: any) : any =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate === candidate.trim() &&
    candidate.length <= 768 &&
    !/[\u0000-\u001f\u007f]/u.test(candidate);
  if (
    !validIdentity(subjectCandidate) ||
    !validIdentity(tenantCandidate)
  ) {
    throw failure(
      "materialization_subject_required",
      401,
      "Authenticated materialization subject is required."
    );
  }
  return Object.freeze({
    subjectId: subjectCandidate,
    tenantId: tenantCandidate,
    userId: subjectCandidate
  });
}

function normalizeLogicalTarget(value?: any) : any {
  const logicalTarget: any =
    typeof value === "string" ? value : "";
  const segments: any = logicalTarget.split("/");
  if (
    !logicalTarget ||
    logicalTarget !== logicalTarget.trim() ||
    logicalTarget.length > 768 ||
    logicalTarget.startsWith("/") ||
    logicalTarget.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(logicalTarget) ||
    segments.some(
      (segment?: any) : any =>
        !segment ||
        segment.startsWith(".")
    )
  ) {
    throw failure(
      "materialization_path_invalid",
      400,
      "Workspace materialization target is invalid."
    );
  }
  return logicalTarget;
}

function closedAdmissionId(value?: any, label?: any) : any {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > 768 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw failure(
      "materialization_input_invalid",
      400,
      `${label} is invalid.`
    );
  }
  return value;
}

function closedAdmissionInput(value: Record<string, any> = {}) : any {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw failure(
      "materialization_input_invalid",
      400,
      "Materialization input is invalid."
    );
  }
  const allowed: any = new Set<any>([
    "expectedWorkspaceRevision",
    "logicalTarget",
    "safetyConfirm",
    "uploadSessionId",
    "workspaceId"
  ]);
  if (Object.keys(value).some((key?: any) : any => !allowed.has(key))) {
    throw failure(
      "materialization_input_invalid",
      400,
      "Materialization input contains unsupported fields."
    );
  }
  if (
    !Object.hasOwn(value, "safetyConfirm") ||
    typeof value.safetyConfirm !== "boolean"
  ) {
    throw failure(
      "materialization_input_invalid",
      400,
      "Materialization safety confirmation is invalid."
    );
  }
  const input: Readonly<Record<string, any>> = Object.freeze({
    expectedWorkspaceRevision:
      closedAdmissionId(
        value.expectedWorkspaceRevision,
        "Expected workspace revision"
    ),
    logicalTarget: normalizeLogicalTarget(value.logicalTarget),
    safetyConfirm: value.safetyConfirm,
    uploadSessionId: closedAdmissionId(
      value.uploadSessionId,
      "Upload session"
    ),
    workspaceId: closedAdmissionId(
      value.workspaceId,
      "Workspace identity"
    )
  });
  if (
    input.safetyConfirm !== true
  ) {
    throw failure(
      "materialization_input_invalid",
      400,
      "Materialization input is incomplete."
    );
  }
  return input;
}

function requestReference(input?: any, owner?: any) : any {
  return `materialization:${digest({
    operationId: "jobs.upload_workspace_materialize",
    ownerBinding: digest(owner),
    uploadSessionId: input.uploadSessionId,
    workspaceId: input.workspaceId,
    expectedWorkspaceRevision: input.expectedWorkspaceRevision,
    logicalTarget: input.logicalTarget
  })}`;
}

function exactDescriptor(files?: any, uploadSessionId?: any) : any {
  if (!Array.isArray(files) || files.length !== 1) {
    throw failure(
      "materialization_descriptor_invalid",
      409,
      "Completed upload must contain exactly one sealed object."
    );
  }
  const file: any = files[0];
  const byteCount: any = file?.byteSize;
  const descriptorText: any = (value?: any) : any =>
    typeof value === "string" &&
    value &&
    value === value.trim() &&
    value.length <= 768 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
      ? value
      : "";
  const descriptor: Readonly<Record<string, any>> = Object.freeze({
    byteCount,
    contentDigest: descriptorText(file?.contentDigest),
    custodyRef: descriptorText(file?.custodyRef),
    envelopeDigest: descriptorText(file?.envelopeDigest),
    resourceRef: `upload-resource:${uploadSessionId}:0`,
    state: descriptorText(file?.custodyState)
  });
  if (
    descriptor.state !== "sealed_no_run" ||
    !descriptor.custodyRef ||
    !/^[a-f0-9]{64}$/u.test(descriptor.contentDigest) ||
    !/^[a-f0-9]{64}$/u.test(descriptor.envelopeDigest) ||
    !Number.isSafeInteger(byteCount) ||
    byteCount < 0 ||
    byteCount > MAX_DESCRIPTOR_BYTES
  ) {
    throw failure(
      "materialization_descriptor_invalid",
      409,
      "Completed upload custody descriptor is invalid."
    );
  }
  return descriptor;
}

function sameDescriptor(left?: any, right?: any) : any {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeRequestRecord(value?: any) : any {
  if (!exactKeys(value, REQUEST_RECORD_KEYS)) {
    throw failure(
      "materialization_request_record_invalid",
      409,
      "Materialization request record is not a closed binding."
    );
  }
  const descriptor: any = exactDescriptor(
    [{
      byteSize: value.descriptor?.byteCount,
      contentDigest: value.descriptor?.contentDigest,
      custodyRef: value.descriptor?.custodyRef,
      envelopeDigest: value.descriptor?.envelopeDigest,
      custodyState: value.descriptor?.state
    }],
    value.uploadSessionId
  );
  if (
    descriptor.resourceRef !== text(value.descriptor?.resourceRef) ||
    !sameDescriptor(descriptor, value.descriptor)
  ) {
    throw failure(
      "materialization_request_record_invalid",
      409,
      "Materialization descriptor binding is invalid."
    );
  }
  const normalized: Readonly<Record<string, any>> = Object.freeze({
    approvalIntentDigest: sha256Digest(
      value.approvalIntentDigest,
      "Approval-intent digest"
    ),
    authorityBindingDigest: sha256Digest(
      value.authorityBindingDigest,
      "Authority-binding digest"
    ),
    authorityRef: boundedId(
      value.authorityRef,
      "Authority reference"
    ),
    bindingDigest: sha256Digest(
      value.bindingDigest,
      "Materialization binding digest"
    ),
    descriptor,
    expectedWorkspaceRevision: boundedId(
      value.expectedWorkspaceRevision,
      "Expected workspace revision"
    ),
    logicalTarget: normalizeLogicalTarget(value.logicalTarget),
    operationId: boundedId(
      value.operationId,
      "Materialization operation"
    ),
    requestDigest: sha256Digest(
      value.requestDigest,
      "Materialization request digest"
    ),
    requestRef: boundedId(
      value.requestRef,
      "Materialization request reference"
    ),
    resourceRevision: sha256Digest(
      value.resourceRevision,
      "Materialization resource revision"
    ),
    uploadSessionId: boundedId(
      value.uploadSessionId,
      "Upload session"
    ),
    workspaceId: boundedId(
      value.workspaceId,
      "Workspace identity"
    )
  });
  const expectedResourceRevision: any = digest(normalized.descriptor);
  const expectedBindingDigest: any = digest({
    authorityBindingDigest: normalized.authorityBindingDigest,
    descriptor: normalized.descriptor,
    expectedWorkspaceRevision:
      normalized.expectedWorkspaceRevision,
    logicalTarget: normalized.logicalTarget,
    operationId: normalized.operationId,
    requestDigest: normalized.requestDigest,
    requestRef: normalized.requestRef,
    uploadSessionId: normalized.uploadSessionId,
    workspaceId: normalized.workspaceId
  });
  if (
    normalized.operationId !==
      "jobs.upload_workspace_materialize" ||
    !/^materialization:[a-f0-9]{64}$/u.test(
      normalized.requestRef
    ) ||
    normalized.resourceRevision !== expectedResourceRevision ||
    normalized.bindingDigest !== expectedBindingDigest
  ) {
    throw failure(
      "materialization_request_record_invalid",
      409,
      "Materialization request binding is not canonical."
    );
  }
  return normalized;
}

const PUBLICATION_KEYS: readonly any[] = Object.freeze([
  "byteCount",
  "contentDigest",
  "intentDigest",
  "logicalTargetDigest",
  "parentFingerprint",
  "parentIdentity",
  "preparedIdentity",
  "priorRevision",
  "proofDigest",
  "publicationId",
  "reservationDigest",
  "stateEventAnchor",
  "stateOperationId",
  "targetStateDigest",
  "tempLeafRef"
]);

function exactKeys(value?: any, keys?: any) : any {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join("\0") ===
      [...keys].sort().join("\0")
  );
}

function boundedId(value?: any, label?: any) : any {
  const normalized: any =
    typeof value === "string" ? value : "";
  if (
    !normalized ||
    normalized !== normalized.trim() ||
    normalized.length > 768 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      `${label} is invalid.`
    );
  }
  return normalized;
}

function sha256Digest(value?: any, label?: any) : any {
  const normalized: any =
    typeof value === "string" ? value : "";
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      `${label} is invalid.`
    );
  }
  return normalized;
}

function safeCount(value?: any, label?: any) : any {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      `${label} is invalid.`
    );
  }
  return value;
}

function normalizeStateEventAnchor(value?: any) : any {
  if (!exactKeys(value, ["eventHash", "offset"])) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      "Publication state-event anchor is invalid."
    );
  }
  return Object.freeze({
    eventHash: sha256Digest(
      text(value.eventHash).replace(/^sha256:/u, ""),
      "Publication state-event hash"
    ),
    offset: safeCount(
      value.offset,
      "Publication state-event offset"
    )
  });
}

function normalizeFsIdentity(
  value?: any,
  label?: any,
  {
    prepared = false,
    byteCount = null,
    contentDigest = ""
  }: Record<string, any> = {}
) : any {
  const keys: any = prepared
    ? [
        "birthtimeNs",
        "byteCount",
        "contentDigest",
        "dev",
        "ino",
        "mode"
      ]
    : ["birthtimeNs", "dev", "ino", "mode"];
  if (
    !exactKeys(value, keys)
  ) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      `${label} is invalid.`
    );
  }
  const normalized: Record<string, any> = {
    birthtimeNs: boundedId(
      value.birthtimeNs,
      `${label} birth time`
    ),
    dev: boundedId(value.dev, "Prepared publication device"),
    ino: boundedId(value.ino, "Prepared publication inode"),
    mode: safeCount(value.mode, `${label} mode`)
  };
  if (
    !/^\d+$/u.test(normalized.birthtimeNs) ||
    !/^\d+$/u.test(normalized.dev) ||
    !/^\d+$/u.test(normalized.ino)
  ) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      `${label} is invalid.`
    );
  }
  if (prepared) {
    normalized.byteCount = safeCount(
      value.byteCount,
      `${label} byte count`
    );
    normalized.contentDigest = sha256Digest(
      value.contentDigest,
      `${label} content digest`
    );
  }
  if (
    (prepared && normalized.byteCount !== byteCount) ||
    (prepared && normalized.contentDigest !== contentDigest) ||
    (prepared && normalized.mode !== 0o600)
  ) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      `${label} does not match its publication binding.`
    );
  }
  return Object.freeze(normalized);
}

function normalizeTempLeaf(value?: any) : any {
  const normalized: any = boundedId(
    value,
    "Publication temporary leaf"
  );
  if (
    !/^\.meshrix-materialization-[A-Za-z0-9_-]{16,128}(?:\.tmp)?$/u
      .test(normalized) ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("..")
  ) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      "Publication temporary leaf is invalid."
    );
  }
  return normalized;
}

function publicationIntentDigest(publication?: any) : any {
  return digest({
    version: PUBLICATION_INTENT_VERSION,
    publicationId: publication.publicationId,
    tempLeafRef: publication.tempLeafRef,
    stateOperationId: publication.stateOperationId,
    priorRevision: publication.priorRevision,
    stateEventAnchor: publication.stateEventAnchor,
    logicalTargetDigest: publication.logicalTargetDigest,
    parentFingerprint: publication.parentFingerprint,
    parentIdentity: publication.parentIdentity,
    targetStateDigest: publication.targetStateDigest,
    contentDigest: publication.contentDigest,
    byteCount: publication.byteCount
  });
}

function publicationReservationDigest(
  publication?: any,
  preparedIdentity?: any
) : any {
  return digest({
    version: PUBLICATION_RESERVATION_VERSION,
    intentDigest: publication.intentDigest,
    preparedIdentity
  });
}

function publicationProofDigest(publication?: any) : any {
  return digest({
    version: PUBLICATION_PROOF_VERSION,
    intentDigest: publication.intentDigest,
    reservationDigest: publication.reservationDigest,
    preparedIdentity: publication.preparedIdentity
  });
}

function normalizePublicationBase(value?: any, facts?: any) : any {
  if (!exactKeys(value, PUBLICATION_KEYS)) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      "Publication descriptor is not an exact closed binding."
    );
  }
  const publication: Record<string, any> = {
    byteCount: safeCount(value.byteCount, "Publication byte count"),
    contentDigest: sha256Digest(
      value.contentDigest,
      "Publication content digest"
    ),
    logicalTargetDigest: sha256Digest(
      value.logicalTargetDigest,
      "Publication logical-target digest"
    ),
    parentFingerprint: sha256Digest(
      value.parentFingerprint,
      "Publication parent fingerprint"
    ),
    parentIdentity: normalizeFsIdentity(
      value.parentIdentity,
      "Publication parent identity"
    ),
    priorRevision: boundedId(
      value.priorRevision,
      "Publication prior revision"
    ),
    publicationId: boundedId(
      value.publicationId,
      "Publication identity"
    ),
    stateEventAnchor: normalizeStateEventAnchor(
      value.stateEventAnchor
    ),
    stateOperationId: boundedId(
      value.stateOperationId,
      "Publication state operation"
    ),
    targetStateDigest: sha256Digest(
      value.targetStateDigest,
      "Publication target-state digest"
    ),
    tempLeafRef: normalizeTempLeaf(value.tempLeafRef)
  };
  publication.intentDigest = publicationIntentDigest(publication);
  if (
    publication.byteCount !== facts.request.descriptor.byteCount ||
    publication.contentDigest !==
      facts.request.descriptor.contentDigest ||
    publication.logicalTargetDigest !==
      digest(facts.request.logicalTarget) ||
    publication.parentFingerprint !== facts.parentFingerprint ||
    !sameCanonical(
      publication.parentIdentity,
      facts.parentIdentity
    ) ||
    publication.priorRevision !==
      facts.request.expectedWorkspaceRevision ||
    publication.targetStateDigest !== facts.targetStateDigest ||
    !sameCanonical(
      publication.stateEventAnchor,
      facts.stateEventAnchor
    ) ||
    publication.intentDigest !==
      sha256Digest(value.intentDigest, "Publication intent digest")
  ) {
    throw failure(
      "materialization_publication_wal_mismatch",
      409,
      "Publication intent does not match its persisted request facts."
    );
  }
  return publication;
}

function normalizePublicationIntent(value?: any, facts?: any) : any {
  const publication: any = normalizePublicationBase(value, facts);
  if (
    value.preparedIdentity !== null ||
    text(value.reservationDigest) ||
    text(value.proofDigest)
  ) {
    throw failure(
      "materialization_publication_wal_mismatch",
      409,
      "Publication intent unexpectedly contains reservation evidence."
    );
  }
  return Object.freeze({
    ...publication,
    preparedIdentity: null,
    reservationDigest: "",
    proofDigest: ""
  });
}

function normalizePublicationReserved(value?: any, facts?: any) : any {
  const publication: any = normalizePublicationBase(value, facts);
  const preparedIdentity: any = normalizeFsIdentity(
    value.preparedIdentity,
    "Prepared publication identity",
    {
      prepared: true,
      byteCount: publication.byteCount,
      contentDigest: publication.contentDigest
    }
  );
  const reservationDigest: any = publicationReservationDigest(
    publication,
    preparedIdentity
  );
  if (
    reservationDigest !== sha256Digest(
      value.reservationDigest,
      "Publication reservation digest"
    ) ||
    text(value.proofDigest)
  ) {
    throw failure(
      "materialization_publication_wal_mismatch",
      409,
      "Publication reservation is not canonical."
    );
  }
  return Object.freeze({
    ...publication,
    preparedIdentity,
    reservationDigest,
    proofDigest: ""
  });
}

function normalizePublicationPrepared(value?: any, facts?: any) : any {
  const reserved: any = normalizePublicationReserved(
    {
      ...value,
      proofDigest: ""
    },
    facts
  );
  const proofDigest: any = publicationProofDigest(reserved);
  if (
    proofDigest !== sha256Digest(
      value.proofDigest,
      "Publication proof digest"
    )
  ) {
    throw failure(
      "materialization_publication_wal_mismatch",
      409,
      "Publication proof is not canonical."
    );
  }
  return Object.freeze({
    ...reserved,
    proofDigest
  });
}

function sameCanonical(left?: any, right?: any) : any {
  return canonicalJson(left) === canonicalJson(right);
}

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

function schemaFailure(code?: any, message?: any) : any {
  return failure(code, 500, message);
}

function tableExists(db?: any, tableName?: any) : any {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function tableColumns(db?: any, tableName?: any) : any {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((row?: any) : any => row.name)
    .sort();
}

function tableCount(db?: any, tableName?: any) : any {
  return Number(
    db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
      .get().count
  );
}

function userTables(db?: any) : any {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row?: any) : any => row.name);
}

function userViews(db?: any) : any {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'view'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row?: any) : any => row.name);
}

function tableTriggers(db?: any, tableName?: any) : any {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = ?
    ORDER BY name
  `).all(tableName).map((row?: any) : any => row.name);
}

function userTriggers(db?: any) : any {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'trigger'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row?: any) : any => row.name);
}

function unexpectedRequestIndexes(db?: any) : any {
  return db
    .prepare("PRAGMA index_list(materialization_requests)")
    .all()
    .filter(
      (row?: any) : any =>
        row.origin !== "pk" &&
        row.name !== RECONCILE_INDEX
    );
}

function userDefinedIndexes(db?: any) : any {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index' AND sql IS NOT NULL
    ORDER BY name
  `).all().map((row?: any) : any => row.name);
}

function indexColumns(db?: any, indexName?: any) : any {
  return db
    .prepare(`PRAGMA index_info(${indexName})`)
    .all()
    .map((row?: any) : any => row.name);
}

function assertCanonicalReconcileIndex(db?: any, { required }: Record<string, any> = {}) : any {
  const index: any = db
    .prepare("PRAGMA index_list(materialization_requests)")
    .all()
    .find((row?: any) : any => row.name === RECONCILE_INDEX);
  const exists: any = Boolean(index);
  const indexedFields: any = exists
    ? db
        .prepare(`PRAGMA index_xinfo(${RECONCILE_INDEX})`)
        .all()
        .filter((row?: any) : any => Number(row.key) === 1)
    : [];
  if (
    (required && !exists) ||
    (
      exists &&
      (
        Number(index.unique) !== 0 ||
        Number(index.partial) !== 0 ||
        index.origin !== "c" ||
        indexColumns(db, RECONCILE_INDEX).join("\0") !==
          [
            "status",
            "stage",
            "lease_until",
            "updated_at",
            "request_ref"
          ].join("\0") ||
        indexedFields.some(
          (field?: any) : any =>
            Number(field.desc) !== 0 ||
            field.coll !== "BINARY"
        )
      )
    )
  ) {
    throw schemaFailure(
      "materialization_schema_layout_unknown",
      "Materialization reconciliation index is not canonical."
    );
  }
}

function sameColumns(actual?: any, expected?: any) : any {
  return [...actual].sort().join("\0") ===
    [...expected].sort().join("\0");
}

function parseStoredJson(value?: any, label?: any) : any {
  try {
    return JSON.parse(value);
  } catch {
    throw schemaFailure(
      "materialization_schema_data_invalid",
      `${label} is not valid JSON.`
    );
  }
}

function createRequestTable(db?: any, tableName?: any) : any {
  db.exec(`
    CREATE TABLE ${tableName} (
      request_ref TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'completed', 'failed', 'cancelled')
      ),
      stage TEXT NOT NULL CHECK (
        stage IN (
          'admitted',
          'publication_intent',
          'temp_reserved',
          'publication_prepared',
          'published',
          'evidence_pending',
          'audit_finalized',
          'proof_finalized',
          'completed',
          'rollback_incomplete'
        )
      ),
      owner_fence TEXT NOT NULL DEFAULT '',
      lease_until INTEGER NOT NULL DEFAULT 0 CHECK (lease_until >= 0),
      request_json TEXT NOT NULL,
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      preimage_json TEXT,
      target_state_digest TEXT NOT NULL DEFAULT '',
      parent_fingerprint TEXT NOT NULL DEFAULT '',
      parent_identity_json TEXT,
      publication_json TEXT,
      prior_revision TEXT NOT NULL DEFAULT '',
      published_revision TEXT NOT NULL DEFAULT '',
      effect_json TEXT,
      evidence_json TEXT,
      result_json TEXT,
      error_json TEXT,
      updated_at TEXT NOT NULL,
      CHECK (
        (
          status = 'running' AND
          owner_fence <> '' AND
          lease_until > 0 AND
          stage IN (
            'admitted',
            'publication_intent',
            'temp_reserved',
            'publication_prepared',
            'published',
            'evidence_pending',
            'audit_finalized',
            'proof_finalized'
          )
        ) OR (
          status = 'queued' AND
          stage = 'admitted' AND
          owner_fence = '' AND
          lease_until = 0
        ) OR (
          status = 'completed' AND
          stage = 'completed' AND
          owner_fence = '' AND
          lease_until = 0
        ) OR (
          status = 'failed' AND
          stage IN ('admitted', 'rollback_incomplete') AND
          owner_fence = '' AND
          lease_until = 0
        ) OR (
          status = 'cancelled' AND
          stage = 'admitted' AND
          owner_fence = '' AND
          lease_until = 0
        )
      ),
      CHECK (
        stage NOT IN (
          'publication_intent',
          'temp_reserved',
          'publication_prepared',
          'published',
          'evidence_pending',
          'audit_finalized',
          'proof_finalized',
          'completed',
          'rollback_incomplete'
        ) OR preimage_json IS NOT NULL
      ),
      CHECK (
        stage NOT IN (
          'publication_intent',
          'temp_reserved',
          'publication_prepared',
          'published',
          'evidence_pending',
          'audit_finalized',
          'proof_finalized',
          'completed'
        ) OR publication_json IS NOT NULL
      ),
      CHECK (
        stage NOT IN (
          'published',
          'evidence_pending',
          'audit_finalized',
          'proof_finalized',
          'completed'
        ) OR effect_json IS NOT NULL
      ),
      CHECK (
        stage NOT IN (
          'evidence_pending',
          'audit_finalized',
          'proof_finalized',
          'completed'
        ) OR evidence_json IS NOT NULL
      ),
      CHECK (
        stage <> 'admitted' OR (
          publication_json IS NULL AND
          effect_json IS NULL AND
          evidence_json IS NULL AND
          result_json IS NULL
        )
      ),
      CHECK (
        stage NOT IN (
          'publication_intent',
          'temp_reserved',
          'publication_prepared'
        ) OR (
          effect_json IS NULL AND
          evidence_json IS NULL AND
          result_json IS NULL
        )
      ),
      CHECK (
        (
          stage IN (
            'published',
            'evidence_pending',
            'audit_finalized',
            'proof_finalized',
            'completed'
          ) AND result_json IS NOT NULL
        ) OR (
          stage IN (
            'admitted',
            'publication_intent',
            'temp_reserved',
            'publication_prepared'
          ) AND result_json IS NULL
        ) OR stage = 'rollback_incomplete'
      ),
      CHECK (
        (status = 'failed' AND error_json IS NOT NULL) OR
        (
          status IN ('running', 'completed', 'cancelled') AND
          error_json IS NULL
        ) OR status = 'queued'
      ),
      CHECK (
        status <> 'cancelled' OR (
          preimage_json IS NULL AND
          target_state_digest = '' AND
          parent_fingerprint = '' AND
          parent_identity_json IS NULL AND
          prior_revision = ''
        )
      ),
      CHECK (
        status <> 'failed' OR
        stage <> 'admitted' OR (
          preimage_json IS NULL AND
          target_state_digest = '' AND
          parent_fingerprint = '' AND
          parent_identity_json IS NULL AND
          prior_revision = ''
        )
      )
    );
  `);
}

function createCurrentIndexes(db?: any) : any {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ${RECONCILE_INDEX}
      ON materialization_requests(
        status,
        stage,
        lease_until,
        updated_at,
        request_ref
      );
  `);
}

function writeSchemaMetadata(db?: any) : any {
  db.exec(`
    CREATE TABLE IF NOT EXISTS materialization_schema_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      schema_fingerprint TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO materialization_schema_meta (
      singleton,
      schema_version,
      schema_fingerprint
    ) VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      schema_version = excluded.schema_version,
      schema_fingerprint = excluded.schema_fingerprint
  `).run(SCHEMA_VERSION, SCHEMA_FINGERPRINT);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function assertAuxiliaryTablesAreEmpty(db?: any) : any {
  for (const tableName of LEGACY_AUXILIARY_TABLES) {
    if (!tableExists(db, tableName)) continue;
    if (
      !sameColumns(
        tableColumns(db, tableName),
        LEGACY_AUXILIARY_COLUMNS[tableName]
      )
    ) {
      throw schemaFailure(
        "materialization_schema_layout_unknown",
        "Legacy materialization table layout is not recognized."
      );
    }
    if (tableCount(db, tableName) > 0) {
      throw schemaFailure(
        "materialization_schema_unsafe_legacy_data",
        "Legacy materialization data requires explicit offline recovery."
      );
    }
  }
}

function dropEmptyAuxiliaryTables(db?: any) : any {
  for (const tableName of LEGACY_AUXILIARY_TABLES) {
    if (tableExists(db, tableName)) {
      if (tableCount(db, tableName) > 0) {
        throw schemaFailure(
          "materialization_schema_unsafe_legacy_data",
          "Legacy materialization data requires explicit offline recovery."
        );
      }
      db.exec(`DROP TABLE ${tableName}`);
    }
  }
}

function normalizeLegacyWorktreeRow(row?: any) : any {
  const request: any = normalizeRequestRecord(
    parseStoredJson(
      row.request_json,
      "Materialization request record"
    )
  );
  if (request.requestRef !== row.request_ref) {
    throw schemaFailure(
      "materialization_schema_data_invalid",
      "Materialization request identity is inconsistent."
    );
  }
  const effectFree: any =
    row.publication_json === null &&
    row.result_json === null &&
    row.published_revision === "";
  if (
    effectFree &&
    row.status === "queued" &&
    ["admitted", "preimage_ready"].includes(row.stage)
  ) {
    return {
      request,
      status: "queued",
      stage: "admitted",
      errorJson: row.error_json
        ? canonicalErrorJson(
            parseStoredJson(
              row.error_json,
              "Legacy materialization error"
            ),
            "materialization_failed"
          )
        : null
    };
  }
  if (
    effectFree &&
    row.status === "running" &&
    ["admitted", "preimage_ready"].includes(row.stage)
  ) {
    return {
      request,
      status: "queued",
      stage: "admitted",
      errorJson: row.error_json
        ? canonicalErrorJson(
            parseStoredJson(
              row.error_json,
              "Legacy materialization error"
            ),
            "materialization_failed"
          )
        : null
    };
  }
  if (
    effectFree &&
    row.status === "failed" &&
    ["failed", "retry_exhausted"].includes(row.stage)
  ) {
    return {
      request,
      status: "failed",
      stage: "admitted",
      errorJson: row.error_json
        ? canonicalErrorJson(
            parseStoredJson(
              row.error_json,
              "Legacy materialization error"
            ),
            "materialization_retry_exhausted"
          )
        : canonicalErrorJson(
            null,
            "materialization_retry_exhausted"
          )
    };
  }
  if (
    effectFree &&
    row.status === "cancelled" &&
    row.stage === "cancelled"
  ) {
    return {
      request,
      status: "cancelled",
      stage: "admitted",
      errorJson: null
    };
  }
  throw schemaFailure(
    "materialization_schema_unsafe_legacy_data",
    "Existing materialization state requires explicit offline recovery."
  );
}

function migrateLegacyWorktreeSchema(db?: any) : any {
  const rows: any = db.prepare(`
    SELECT *
    FROM materialization_requests
    ORDER BY request_ref
  `).all();
  const converted: any = rows.map(normalizeLegacyWorktreeRow);
  createRequestTable(db, "materialization_requests_next");
  const insert: any = db.prepare(`
    INSERT INTO materialization_requests_next (
      request_ref,
      status,
      stage,
      request_json,
      request_digest,
      error_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of converted) {
    const requestJson: any = canonicalJson(row.request);
    insert.run(
      row.request.requestRef,
      row.status,
      row.stage,
      requestJson,
      digest(row.request),
      row.errorJson,
      new Date().toISOString()
    );
  }
  const copied: any = tableCount(
    db,
    "materialization_requests_next"
  );
  if (copied !== rows.length) {
    throw schemaFailure(
      "materialization_schema_migration_incomplete",
      "Materialization schema migration did not preserve every safe row."
    );
  }
  for (const row of db.prepare(`
    SELECT *
    FROM materialization_requests_next
    ORDER BY request_ref
  `).all()) {
    hydrateStoredRequestRow(row);
  }
  db.exec(`
    DROP TABLE materialization_requests;
    ALTER TABLE materialization_requests_next
      RENAME TO materialization_requests;
  `);
}

function assertCurrentSchema(db?: any) : any {
  if (
    userViews(db).length > 0 ||
    userTriggers(db).length > 0 ||
    !sameColumns(
      userTables(db),
      [
        "materialization_requests",
        "materialization_schema_meta"
      ]
    ) ||
    !tableExists(db, "materialization_requests") ||
    !sameColumns(
      tableColumns(db, "materialization_requests"),
      REQUEST_COLUMNS
    ) ||
    tableTriggers(db, "materialization_requests").length > 0 ||
    unexpectedRequestIndexes(db).length > 0 ||
    !sameColumns(
      userDefinedIndexes(db),
      [RECONCILE_INDEX]
    )
  ) {
    throw schemaFailure(
      "materialization_schema_layout_unknown",
      "Materialization schema layout is not recognized."
    );
  }
  if (
    LEGACY_AUXILIARY_TABLES.some((tableName?: any) : any =>
      tableExists(db, tableName)
    )
  ) {
    throw schemaFailure(
      "materialization_schema_layout_unknown",
      "Legacy materialization tables remain in the current schema."
    );
  }
  const hasMetadata: any = tableExists(
    db,
    "materialization_schema_meta"
  );
  if (
    !hasMetadata ||
    !sameColumns(
      tableColumns(db, "materialization_schema_meta"),
      ["schema_fingerprint", "schema_version", "singleton"]
    ) ||
    tableCount(db, "materialization_schema_meta") !== 1
  ) {
    throw schemaFailure(
      "materialization_schema_fingerprint_mismatch",
      "Materialization schema metadata is not recognized."
    );
  }
  const meta: any = hasMetadata
    ? db.prepare(`
        SELECT schema_version AS schemaVersion,
               schema_fingerprint AS schemaFingerprint
        FROM materialization_schema_meta
        WHERE singleton = 1
      `).get()
    : null;
  if (
    Number(meta?.schemaVersion) !== SCHEMA_VERSION ||
    meta?.schemaFingerprint !== SCHEMA_FINGERPRINT
  ) {
    throw schemaFailure(
      "materialization_schema_fingerprint_mismatch",
      "Materialization schema fingerprint is not recognized."
    );
  }
  assertCanonicalReconcileIndex(db, { required: true });
  for (const row of db.prepare(`
    SELECT *
    FROM materialization_requests
    ORDER BY request_ref
  `).all()) {
    hydrateStoredRequestRow(row);
  }
}

function verifyDatabaseIntegrity(db?: any) : any {
  const integrity: any = db.pragma("quick_check", { simple: true });
  if (integrity !== "ok") {
    throw schemaFailure(
      "materialization_schema_integrity_failed",
      "Materialization database integrity verification failed."
    );
  }
  if (db.pragma("foreign_key_check").length > 0) {
    throw schemaFailure(
      "materialization_schema_foreign_key_failed",
      "Materialization database foreign-key verification failed."
    );
  }
}

function ensureCurrentSchema(db?: any, now: any = Date.now) : any {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.pragma("foreign_keys = ON");
  const userVersion: any = Number(
    db.pragma("user_version", { simple: true }) || 0
  );
  if (userVersion < 0 || userVersion > SCHEMA_VERSION) {
    throw schemaFailure(
      "materialization_schema_version_unsupported",
      "Materialization schema version is not supported."
    );
  }
  if (userVersion === SCHEMA_VERSION) {
    assertCurrentSchema(db);
    verifyDatabaseIntegrity(db);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    return;
  }

  const migrate: any = db.transaction(() : any => {
    const tables: any = userTables(db);
    if (
      userViews(db).length > 0 ||
      userTriggers(db).length > 0
    ) {
      throw schemaFailure(
        "materialization_schema_layout_unknown",
        "Materialization schema views are not recognized."
      );
    }
    if (tableExists(db, "materialization_schema_meta")) {
      throw schemaFailure(
        "materialization_schema_layout_unknown",
        "Unversioned materialization metadata is not recognized."
      );
    }
    const auxiliaryTables: any = LEGACY_AUXILIARY_TABLES.filter(
      (tableName?: any) : any => tableExists(db, tableName)
    );
    assertAuxiliaryTablesAreEmpty(db);
    if (!tableExists(db, "materialization_requests")) {
      if (tables.length > 0) {
        throw schemaFailure(
          "materialization_schema_layout_unknown",
          "Orphaned materialization tables are not a recognized schema."
        );
      }
      createRequestTable(db, "materialization_requests");
    } else {
      const columns: any = tableColumns(
        db,
        "materialization_requests"
      );
      if (sameColumns(columns, REQUEST_COLUMNS)) {
        if (
          !sameColumns(tables, ["materialization_requests"]) ||
          tableTriggers(db, "materialization_requests").length > 0 ||
          unexpectedRequestIndexes(db).length > 0 ||
          userDefinedIndexes(db).some(
            (name?: any) : any => name !== RECONCILE_INDEX
          )
        ) {
          throw schemaFailure(
            "materialization_schema_layout_unknown",
            "The unversioned materialization schema is not canonical."
          );
        }
        assertCanonicalReconcileIndex(db);
        const rows: any = db.prepare(`
          SELECT *
          FROM materialization_requests
          ORDER BY request_ref
        `).all();
        for (const row of rows) hydrateStoredRequestRow(row);
        const current: any = Number(now());
        if (!Number.isFinite(current)) {
          throw schemaFailure(
            "materialization_schema_data_invalid",
            "Materialization migration time is invalid."
          );
        }
        db.prepare(`
          UPDATE materialization_requests
          SET status = 'queued',
              owner_fence = '',
              lease_until = 0,
              updated_at = ?
          WHERE status = 'running'
            AND stage = 'admitted'
            AND lease_until < ?
        `).run(new Date(current).toISOString(), current);
      } else if (
        sameColumns(columns, LEGACY_WORKTREE_REQUEST_COLUMNS)
      ) {
        const allowedLegacyTables: any[] = [
          "materialization_requests",
          ...LEGACY_AUXILIARY_TABLES.filter((tableName?: any) : any =>
            tableExists(db, tableName)
          )
        ];
        if (
          !sameColumns(tables, allowedLegacyTables) ||
          tableTriggers(db, "materialization_requests").length > 0 ||
          userDefinedIndexes(db).length > 0
        ) {
          throw schemaFailure(
            "materialization_schema_layout_unknown",
            "Legacy materialization schema objects are not recognized."
          );
        }
        migrateLegacyWorktreeSchema(db);
        dropEmptyAuxiliaryTables(db);
      } else {
        throw schemaFailure(
          "materialization_schema_layout_unknown",
          "Materialization schema layout requires offline recovery."
        );
      }
    }
    createCurrentIndexes(db);
    writeSchemaMetadata(db);
    assertCurrentSchema(db);
    verifyDatabaseIntegrity(db);
  });
  migrate.immediate();
  assertCurrentSchema(db);
  verifyDatabaseIntegrity(db);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
}

function canonicalClone(value?: any) : any {
  return JSON.parse(canonicalJson(value));
}

function normalizePreimage(value?: any, request?: any) : any {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.workspaceId !== request.workspaceId ||
    value.stateRoot !== request.expectedWorkspaceRevision
  ) {
    throw failure(
      "materialization_preimage_incomplete",
      409,
      "Materialization preimage does not match its request."
    );
  }
  const files: any = Array.isArray(value.files) ? value.files : [];
  const entry: any = files[0];
  const entryPath: any =
    typeof entry?.relativePath === "string"
      ? entry.relativePath
      : typeof entry?.path === "string"
        ? entry.path
        : "";
  if (
    files.length !== 1 ||
    entryPath !== request.logicalTarget ||
    entry?.exists !== false
  ) {
    throw failure(
      "materialization_preimage_incomplete",
      409,
      "Materialization preimage does not prove a missing target."
    );
  }
  normalizeStateEventAnchor(value.stateEventAnchor);
  return Object.freeze(canonicalClone(value));
}

function factsFromRow(row?: any, request?: any) : any {
  if (
    !row.preimage_json ||
    !row.parent_identity_json ||
    !row.parent_fingerprint ||
    !row.target_state_digest
  ) {
    throw failure(
      "materialization_publication_wal_mismatch",
      409,
      "Materialization publication facts are incomplete."
    );
  }
  const preimage: any = normalizePreimage(
    parseStoredJson(
      row.preimage_json,
      "Materialization preimage"
    ),
    request
  );
  return Object.freeze({
    request,
    parentFingerprint: sha256Digest(
      row.parent_fingerprint,
      "Materialization parent fingerprint"
    ),
    parentIdentity: normalizeFsIdentity(
      parseStoredJson(
        row.parent_identity_json,
        "Materialization parent identity"
      ),
      "Materialization parent identity"
    ),
    stateEventAnchor: normalizeStateEventAnchor(
      preimage.stateEventAnchor
    ),
    targetStateDigest: sha256Digest(
      row.target_state_digest,
      "Materialization target-state digest"
    )
  });
}

const EFFECT_KEYS: readonly any[] = Object.freeze([
  "byteCount",
  "checkpointRef",
  "contentDigest",
  "proofDigest",
  "publicationId",
  "publishedIdentity",
  "publishedRevision",
  "stateOperationId"
]);

function normalizePublishedEffect(value?: any, request?: any, publication?: any) : any {
  if (!exactKeys(value, EFFECT_KEYS)) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      "Published materialization receipt is not closed."
    );
  }
  const effect: Readonly<Record<string, any>> = Object.freeze({
    byteCount: safeCount(
      value.byteCount,
      "Published byte count"
    ),
    checkpointRef: boundedId(
      value.checkpointRef,
      "Published checkpoint"
    ),
    contentDigest: sha256Digest(
      value.contentDigest,
      "Published content digest"
    ),
    proofDigest: sha256Digest(
      value.proofDigest,
      "Published proof digest"
    ),
    publicationId: boundedId(
      value.publicationId,
      "Published publication identity"
    ),
    publishedIdentity: normalizeFsIdentity(
      value.publishedIdentity,
      "Published file identity",
      {
        prepared: true,
        byteCount: publication.byteCount,
        contentDigest: publication.contentDigest
      }
    ),
    publishedRevision: boundedId(
      value.publishedRevision,
      "Published workspace revision"
    ),
    stateOperationId: boundedId(
      value.stateOperationId,
      "Published state operation"
    )
  });
  if (
    effect.byteCount !== request.descriptor.byteCount ||
    effect.contentDigest !== request.descriptor.contentDigest ||
    effect.proofDigest !== publication.proofDigest ||
    effect.publicationId !== publication.publicationId ||
    effect.stateOperationId !== publication.stateOperationId ||
    effect.publishedRevision ===
      request.expectedWorkspaceRevision ||
    !sameCanonical(
      effect.publishedIdentity,
      publication.preparedIdentity
    )
  ) {
    throw failure(
      "materialization_publication_wal_mismatch",
      409,
      "Published materialization receipt does not match its WAL."
    );
  }
  return effect;
}

const EVIDENCE_KEYS: readonly any[] = Object.freeze([
  "auditCreatedAt",
  "auditId",
  "auditRef",
  "proofOutcomeKey",
  "proofRef",
  "settlementDigest"
]);

function settlementEvidence({
  request,
  publication,
  effect,
  auditCreatedAt,
  auditRef = "",
  proofRef = ""
}: Record<string, any>) : any {
  const settlementDigest: any = digest({
    version: SETTLEMENT_VERSION,
    bindingDigest: request.bindingDigest,
    publicationProofDigest: publication.proofDigest,
    publishedRevision: effect.publishedRevision,
    checkpointRef: effect.checkpointRef,
    status: "succeeded"
  });
  const auditId: any =
    `materialization_audit_${digest({
      version: SETTLEMENT_VERSION,
      kind: "audit",
      settlementDigest
    })}`;
  return Object.freeze({
    auditCreatedAt,
    auditId,
    auditRef,
    proofOutcomeKey:
      `${request.bindingDigest}:succeeded:${settlementDigest}`,
    proofRef,
    settlementDigest
  });
}

function normalizeEvidence(
  value: any,
  { request, publication, effect, stage }: Record<string, any>
) : any {
  if (!exactKeys(value, EVIDENCE_KEYS)) {
    throw failure(
      "materialization_evidence_wal_incomplete",
      409,
      "Materialization evidence descriptor is not closed."
    );
  }
  const auditCreatedAt: any = text(value.auditCreatedAt);
  if (
    !auditCreatedAt ||
    !Number.isFinite(Date.parse(auditCreatedAt)) ||
    new Date(auditCreatedAt).toISOString() !== auditCreatedAt
  ) {
    throw failure(
      "materialization_evidence_wal_incomplete",
      409,
      "Materialization audit timestamp is invalid."
    );
  }
  const expected: any = settlementEvidence({
    request,
    publication,
    effect,
    auditCreatedAt,
    auditRef: value.auditRef
      ? boundedId(
          value.auditRef,
          "Materialization audit reference"
        )
      : "",
    proofRef: value.proofRef
      ? boundedId(
          value.proofRef,
          "Materialization proof reference"
        )
      : ""
  });
  if (
    expected.auditId !== value.auditId ||
    expected.proofOutcomeKey !== value.proofOutcomeKey ||
    expected.settlementDigest !== value.settlementDigest ||
    (
      expected.auditRef &&
      expected.auditRef !== `audit:${expected.auditId}`
    ) ||
    (
      expected.proofRef &&
      (
        !expected.proofRef.startsWith("proof:") ||
        expected.proofRef.length <= "proof:".length
      )
    )
  ) {
    throw failure(
      "materialization_evidence_wal_mismatch",
      409,
      "Materialization evidence binding is not canonical."
    );
  }
  if (
    (stage === "evidence_pending" &&
      (expected.auditRef || expected.proofRef)) ||
    (stage === "audit_finalized" &&
      (!expected.auditRef || expected.proofRef)) ||
    (["proof_finalized", "completed"].includes(stage) &&
      (!expected.auditRef || !expected.proofRef))
  ) {
    throw failure(
      "materialization_evidence_wal_mismatch",
      409,
      "Materialization evidence references do not match their stage."
    );
  }
  if (expected.proofRef && !expected.auditRef) {
    throw failure(
      "materialization_evidence_wal_mismatch",
      409,
      "Materialization proof evidence requires finalized audit evidence."
    );
  }
  return expected;
}

function storedDataFailure(message?: any) : any {
  return failure(
    "materialization_schema_data_invalid",
    409,
    message
  );
}

function normalizeStoredError(value?: any) : any {
  if (!exactKeys(value, ["code"])) {
    throw storedDataFailure(
      "Materialization error state is not closed."
    );
  }
  return Object.freeze({
    code: boundedId(value.code, "Materialization error code")
  });
}

function canonicalErrorJson(value?: any, fallbackCode?: any) : any {
  const candidate: any =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.code === "string"
      ? value.code
      : fallbackCode;
  return canonicalJson(
    normalizeStoredError({ code: candidate })
  );
}

function normalizeCheckpointResult(value?: any, effect?: any) : any {
  if (
    !exactKeys(value, ["checkpointRef"]) ||
    boundedId(
      value.checkpointRef,
      "Materialization result checkpoint"
    ) !== effect.checkpointRef
  ) {
    throw storedDataFailure(
      "Materialization checkpoint result is inconsistent."
    );
  }
  return Object.freeze({
    checkpointRef: effect.checkpointRef
  });
}

function normalizeCompletedResult(
  value: any,
  { request, effect, evidence }: Record<string, any>
) : any {
  if (
    !exactKeys(value, [
      "auditRef",
      "byteCount",
      "checkpointRef",
      "contentDigest",
      "proofRef",
      "replayed",
      "requestRef",
      "schemaVersion",
      "status",
      "workspaceRevision"
    ])
  ) {
    throw storedDataFailure(
      "Completed materialization result is not closed."
    );
  }
  const normalized: Readonly<Record<string, any>> = Object.freeze({
    auditRef: boundedId(
      value.auditRef,
      "Materialization result audit reference"
    ),
    byteCount: safeCount(
      value.byteCount,
      "Materialization result byte count"
    ),
    checkpointRef: boundedId(
      value.checkpointRef,
      "Materialization result checkpoint"
    ),
    contentDigest: sha256Digest(
      value.contentDigest,
      "Materialization result content digest"
    ),
    proofRef: boundedId(
      value.proofRef,
      "Materialization result proof reference"
    ),
    replayed: value.replayed,
    requestRef: boundedId(
      value.requestRef,
      "Materialization result request"
    ),
    schemaVersion: boundedId(
      value.schemaVersion,
      "Materialization result schema"
    ),
    status: value.status,
    workspaceRevision: boundedId(
      value.workspaceRevision,
      "Materialization result workspace revision"
    )
  });
  if (
    normalized.schemaVersion !==
      UPLOAD_WORKSPACE_MATERIALIZATION_SCHEMA_VERSION ||
    normalized.status !== "completed" ||
    normalized.replayed !== false ||
    normalized.requestRef !== request.requestRef ||
    normalized.contentDigest !==
      request.descriptor.contentDigest ||
    normalized.byteCount !== request.descriptor.byteCount ||
    normalized.workspaceRevision !== effect.publishedRevision ||
    normalized.checkpointRef !== effect.checkpointRef ||
    normalized.auditRef !== evidence.auditRef ||
    normalized.proofRef !== evidence.proofRef
  ) {
    throw storedDataFailure(
      "Completed materialization result is inconsistent."
    );
  }
  return normalized;
}

function hydrateStoredRequestRow(row?: any) : any {
  if (
    !row ||
    typeof row !== "object" ||
    !sameColumns(Object.keys(row), REQUEST_COLUMNS) ||
    !REQUEST_STATUSES.includes(row.status) ||
    !REQUEST_STAGES.includes(row.stage)
  ) {
    throw storedDataFailure(
      "Persisted materialization row shape is invalid."
    );
  }
  const leaseUntil: any = row.lease_until;
  const ownerFence: any = row.owner_fence;
  const running: any = row.status === "running";
  const timestampValue: any = row.updated_at;
  if (
    typeof leaseUntil !== "number" ||
    !Number.isSafeInteger(leaseUntil) ||
    leaseUntil < 0 ||
    typeof ownerFence !== "string" ||
    (ownerFence &&
      boundedId(
        ownerFence,
        "Materialization owner fence"
      ) !== ownerFence) ||
    typeof timestampValue !== "string" ||
    !Number.isFinite(Date.parse(timestampValue)) ||
    new Date(timestampValue).toISOString() !== timestampValue ||
    (running && (!ownerFence || leaseUntil <= 0)) ||
    (!running && (ownerFence || leaseUntil !== 0)) ||
    (row.status === "queued" && row.stage !== "admitted") ||
    (row.status === "completed" && row.stage !== "completed") ||
    (row.status === "cancelled" && row.stage !== "admitted") ||
    (row.status === "failed" &&
      !["admitted", "rollback_incomplete"].includes(row.stage)) ||
    (running &&
      ["completed", "rollback_incomplete"].includes(row.stage))
  ) {
    throw storedDataFailure(
      "Persisted materialization lifecycle state is invalid."
    );
  }

  const request: any = normalizeRequestRecord(
    parseStoredJson(
      row.request_json,
      "Materialization request record"
    )
  );
  if (
    request.requestRef !== row.request_ref ||
    row.request_json !== canonicalJson(request) ||
    digest(request) !==
      sha256Digest(
        row.request_digest,
        "Materialization request-record digest"
      )
  ) {
    throw storedDataFailure(
      "Persisted materialization request binding is invalid."
    );
  }

  const factPresence: any[] = [
    row.preimage_json !== null,
    Boolean(row.target_state_digest),
    Boolean(row.parent_fingerprint),
    row.parent_identity_json !== null,
    Boolean(row.prior_revision)
  ];
  const hasFacts: any = factPresence.every(Boolean);
  if (
    factPresence.some(Boolean) !== hasFacts ||
    (
      !hasFacts &&
      (
        row.preimage_json !== null ||
        row.target_state_digest !== "" ||
        row.parent_fingerprint !== "" ||
        row.parent_identity_json !== null ||
        row.prior_revision !== ""
      )
    ) ||
    (["failed", "cancelled"].includes(row.status) &&
      row.stage === "admitted" &&
      hasFacts)
  ) {
    throw storedDataFailure(
      "Persisted materialization preimage facts are incomplete."
    );
  }
  const preimage: any = hasFacts
    ? normalizePreimage(
        parseStoredJson(
          row.preimage_json,
          "Materialization preimage"
        ),
        request
      )
    : null;
  const parentIdentity: any = hasFacts
    ? normalizeFsIdentity(
        parseStoredJson(
          row.parent_identity_json,
          "Materialization parent identity"
        ),
        "Materialization parent identity"
      )
    : null;
  if (
    hasFacts &&
    (
      row.preimage_json !== canonicalJson(preimage) ||
      row.parent_identity_json !== canonicalJson(parentIdentity) ||
      sha256Digest(
        row.target_state_digest,
        "Materialization target-state digest"
      ) !== row.target_state_digest ||
      sha256Digest(
        row.parent_fingerprint,
        "Materialization parent fingerprint"
      ) !== row.parent_fingerprint ||
      row.prior_revision !== request.expectedWorkspaceRevision
    )
  ) {
    throw storedDataFailure(
      "Persisted materialization preimage facts are inconsistent."
    );
  }

  const publicationRequired: any = [
    "publication_intent",
    "temp_reserved",
    "publication_prepared",
    "published",
    "evidence_pending",
    "audit_finalized",
    "proof_finalized",
    "completed"
  ].includes(row.stage);
  const hasPublication: any = row.publication_json !== null;
  if (
    (publicationRequired && !hasPublication) ||
    (hasPublication && !hasFacts) ||
    (!publicationRequired &&
      row.stage !== "rollback_incomplete" &&
      hasPublication)
  ) {
    throw storedDataFailure(
      "Persisted materialization publication state is incomplete."
    );
  }
  const facts: any = hasPublication
    ? Object.freeze({
        request,
        parentFingerprint: row.parent_fingerprint,
        parentIdentity,
        stateEventAnchor: normalizeStateEventAnchor(
          preimage.stateEventAnchor
        ),
        targetStateDigest: row.target_state_digest
      })
    : null;
  let publication: any = null;
  if (hasPublication) {
    const candidate: any = parseStoredJson(
      row.publication_json,
      "Materialization publication"
    );
    if (row.stage === "publication_intent") {
      publication = normalizePublicationIntent(candidate, facts);
    } else if (row.stage === "temp_reserved") {
      publication = normalizePublicationReserved(candidate, facts);
    } else if (
      [
        "publication_prepared",
        "published",
        "evidence_pending",
        "audit_finalized",
        "proof_finalized",
        "completed"
      ].includes(row.stage)
    ) {
      publication = normalizePublicationPrepared(candidate, facts);
    } else if (row.stage === "rollback_incomplete") {
      publication = candidate.proofDigest
        ? normalizePublicationPrepared(candidate, facts)
        : candidate.reservationDigest
          ? normalizePublicationReserved(candidate, facts)
          : normalizePublicationIntent(candidate, facts);
    } else {
      throw storedDataFailure(
        "Persisted materialization publication stage is invalid."
      );
    }
    if (row.publication_json !== canonicalJson(publication)) {
      throw storedDataFailure(
        "Persisted materialization publication is not canonical."
      );
    }
  }

  const effectRequired: any = [
    "published",
    "evidence_pending",
    "audit_finalized",
    "proof_finalized",
    "completed"
  ].includes(row.stage);
  const hasEffect: any = row.effect_json !== null;
  if (
    (effectRequired && !hasEffect) ||
    (hasEffect && !publication?.proofDigest) ||
    (!effectRequired &&
      row.stage !== "rollback_incomplete" &&
      hasEffect)
  ) {
    throw storedDataFailure(
      "Persisted materialization effect state is incomplete."
    );
  }
  const effect: any = hasEffect
    ? normalizePublishedEffect(
        parseStoredJson(
          row.effect_json,
          "Materialization published effect"
        ),
        request,
        publication
      )
    : null;
  if (
    effect &&
    (
      row.effect_json !== canonicalJson(effect) ||
      row.published_revision !== effect.publishedRevision
    )
  ) {
    throw storedDataFailure(
      "Persisted materialization effect is inconsistent."
    );
  }
  if (!effect && row.published_revision !== "") {
    throw storedDataFailure(
      "Published revision exists without a committed effect."
    );
  }

  const evidenceRequired: any = [
    "evidence_pending",
    "audit_finalized",
    "proof_finalized",
    "completed"
  ].includes(row.stage);
  const hasEvidence: any = row.evidence_json !== null;
  if (
    (evidenceRequired && !hasEvidence) ||
    (hasEvidence && !effect) ||
    (!evidenceRequired &&
      row.stage !== "rollback_incomplete" &&
      hasEvidence)
  ) {
    throw storedDataFailure(
      "Persisted materialization evidence state is incomplete."
    );
  }
  const evidence: any = hasEvidence
    ? normalizeEvidence(
        parseStoredJson(
          row.evidence_json,
          "Materialization evidence"
        ),
        {
          request,
          publication,
          effect,
          stage: row.stage
        }
      )
    : null;
  if (
    evidence &&
    row.evidence_json !== canonicalJson(evidence)
  ) {
    throw storedDataFailure(
      "Persisted materialization evidence is not canonical."
    );
  }

  const hasResult: any = row.result_json !== null;
  const parsedResult: any = hasResult
    ? parseStoredJson(
        row.result_json,
        "Materialization result"
      )
    : null;
  let result: any = null;
  if (row.stage === "completed") {
    if (!hasResult || !effect || !evidence) {
      throw storedDataFailure(
        "Completed materialization state is incomplete."
      );
    }
    result = normalizeCompletedResult(parsedResult, {
      request,
      effect,
      evidence
    });
  } else if (
    effect &&
    [
      "published",
      "evidence_pending",
      "audit_finalized",
      "proof_finalized",
      "rollback_incomplete"
    ].includes(row.stage)
  ) {
    if (!hasResult) {
      throw storedDataFailure(
        "Committed materialization checkpoint is missing."
      );
    }
    result = normalizeCheckpointResult(parsedResult, effect);
  } else if (hasResult) {
    throw storedDataFailure(
      "Materialization result exists before a committed effect."
    );
  }
  if (result && row.result_json !== canonicalJson(result)) {
    throw storedDataFailure(
      "Persisted materialization result is not canonical."
    );
  }

  const hasError: any = row.error_json !== null;
  const error: any = hasError
    ? normalizeStoredError(
        parseStoredJson(
          row.error_json,
          "Materialization error"
        )
      )
    : null;
  if (
    (error && row.error_json !== canonicalJson(error)) ||
    (row.status === "failed" && !error) ||
    (
      ["running", "completed", "cancelled"].includes(
        row.status
      ) &&
      error
    )
  ) {
    throw storedDataFailure(
      "Persisted materialization error state is inconsistent."
    );
  }

  return Object.freeze({
    ...request,
    status: row.status,
    stage: row.stage,
    ownerFence,
    leaseUntil,
    preimage,
    targetStateDigest: row.target_state_digest || "",
    parentFingerprint: row.parent_fingerprint || "",
    parentIdentity,
    publication,
    publishedIdentity:
      publication?.preparedIdentity || null,
    priorRevision: row.prior_revision || "",
    publishedRevision: row.published_revision || "",
    effect,
    evidence,
    result,
    error
  });
}

export function createUploadWorkspaceMaterializationTransactionStore({
  userDataPath,
  leaseMs = DEFAULT_LEASE_MS,
  now = Date.now
}: Record<string, any> = {}) : any {
  const root: any =
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
  const jobsRoot: any = path.join(root, "jobs");
  ensurePrivateDir(jobsRoot);
  const databasePath: any = ensurePrivateSqliteLocation(
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
  const timestamp: any = () : any => new Date(Number(now())).toISOString();
  const hydrate: any = (row?: any) : any =>
    row ? hydrateStoredRequestRow(row) : null;
  const requireChange: any = (result?: any) : any => {
    if (Number(result?.changes || 0) !== 1) {
      throw failure(
        "materialization_fenced",
        409,
        "Materialization lease fence was lost."
      );
    }
  };
  const assertLiveFence: any = (requestRef?: any, ownerFence?: any) : any => {
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
  const walMismatch: any = () : any => failure(
    "materialization_publication_wal_mismatch",
    409,
    "Publication write-ahead descriptor does not match."
  );
  const currentLeaseMs: any = leaseMs;

  return Object.freeze({
    async create(value?: any) : Promise<any> {
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
    async get(requestRef?: any) : Promise<any> {
      return hydrate(read.get(requestRef));
    },
    async begin(requestRef?: any, { ownerFence }: Record<string, any> = {}) : Promise<any> {
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
      return hydrate(read.get(requestRef));
    },
    async renew(requestRef?: any, { ownerFence }: Record<string, any> = {}) : Promise<any> {
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
    async assertFence(requestRef?: any, { ownerFence }: Record<string, any> = {}) : Promise<any> {
      assertLiveFence(requestRef, ownerFence);
      return true;
    },
    async recordPreimage(
      requestRef?: any,
      {
        ownerFence,
        preimage,
        targetStateDigest,
        parentFingerprint,
        parentIdentity,
        stateEventAnchor = null
      }: Record<string, any> = {}
    ) : Promise<any> {
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
        return hydrate(row);
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
      return hydrate(read.get(requestRef));
    },
    async recordPublicationIntent(
      requestRef?: any,
      { ownerFence, publication }: Record<string, any> = {}
    ) : Promise<any> {
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
        return hydrate(row);
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
      return hydrate(read.get(requestRef));
    },
    async recordTempReserved(
      requestRef?: any,
      { ownerFence, publication }: Record<string, any> = {}
    ) : Promise<any> {
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
        return hydrate(row);
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
      return hydrate(read.get(requestRef));
    },
    async recordPublicationPrepared(
      requestRef?: any,
      { ownerFence, publication }: Record<string, any> = {}
    ) : Promise<any> {
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
        return hydrate(row);
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
      return hydrate(read.get(requestRef));
    },
    async recordPublished(
      requestRef?: any,
      {
        ownerFence,
        checkpointRef,
        proofDigest,
        publicationId,
        publishedIdentity,
        publishedRevision,
        priorRevision,
        stateOperationId
      }: Record<string, any> = {}
    ) : Promise<any> {
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
        return hydrate(row);
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
      return hydrate(read.get(requestRef));
    },
    async recordPrecommitCleaned(
      requestRef?: any,
      {
        ownerFence,
        publicationId,
        reservationDigest
      }: Record<string, any> = {}
    ) : Promise<any> {
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
      const currentRecord: any = hydrate(row);
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
      return hydrate(read.get(requestRef));
    },
    async recordEvidencePending(
      requestRef?: any,
      { ownerFence }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      if (
        [
          "evidence_pending",
          "audit_finalized",
          "proof_finalized"
        ].includes(row.stage)
      ) {
        return hydrate(row);
      }
      if (
        row.stage !== "published" ||
        !row.publication_json ||
        !row.effect_json ||
        row.evidence_json
      ) {
        throw walMismatch();
      }
      const currentRecord: any = hydrate(row);
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
      return hydrate(read.get(requestRef));
    },
    async recordAuditFinalized(
      requestRef?: any,
      {
        ownerFence,
        auditRef,
        settlementDigest
      }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const currentRecord: any = hydrate(row);
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
      return hydrate(read.get(requestRef));
    },
    async recordProofFinalized(
      requestRef?: any,
      {
        ownerFence,
        proofRef,
        settlementDigest
      }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const currentRecord: any = hydrate(row);
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
      return hydrate(read.get(requestRef));
    },
    async complete(
      requestRef?: any,
      {
        ownerFence,
        result,
        settlementDigest
      }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const currentRecord: any = hydrate(row);
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
      return hydrate(read.get(requestRef));
    },
    async fail(
      requestRef?: any,
      { ownerFence, recoverable, error }: Record<string, any> = {}
    ) : Promise<any> {
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
      return hydrate(read.get(requestRef));
    },
    async markRollbackIncomplete(
      requestRef?: any,
      { ownerFence, error }: Record<string, any> = {}
    ) : Promise<any> {
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
    async cancelQueued(requestRef?: any) : Promise<any> {
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
    async terminalFail(requestRef?: any, error?: any) : Promise<any> {
      const before: any = read.get(requestRef);
      if (!before) {
        return Object.freeze({
          transitioned: false,
          terminal: false,
          status: "missing",
          stage: ""
        });
      }
      const currentRecord: any = hydrate(before);
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
      const afterRecord: any = after ? hydrate(after) : null;
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
    }: Record<string, any> = {}) : Promise<any> {
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
      `).all(text(afterRequestRef), boundedLimit).map(hydrate);
    },
    async retryAfterLease(requestRef?: any) : Promise<any> {
      const row: any = read.get(requestRef);
      if (!row) {
        return Object.freeze({
          delayMs: 1,
          terminal: false,
          status: "missing",
          stage: ""
        });
      }
      const currentRecord: any = hydrate(row);
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
    count() : any {
      return Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM materialization_requests"
          )
          .get().count
      );
    },
    close() : any {
      db.close();
    }
  });
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

  const workspacePort: Readonly<Record<string, any>> = Object.freeze({
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
