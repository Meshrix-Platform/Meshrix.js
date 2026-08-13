import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";

import {
  normalizeSha256,
  normalizeWorkspaceRelativePath,
  nowIso
} from "./agent-workspace-support.ts";
import {
  createMaterializationDirectoryWorker
} from "./agent-workspace-materialization-file-worker.ts";
import {
  issueAgentWorkspaceMaterializationPort
} from "./agent-workspace-materialization-brand.ts";

const MAX_STREAM_WINDOW_BYTES: any = 64 * 1024;
const PRIVATE_FILE_MODE: any = 0o600;
const PRIVATE_DIRECTORY_MODE: any = 0o700;
const UNSAFE_INODE_TOPOLOGY_CODES: any = new Set<any>([
  "EISDIR",
  "EINVAL",
  "ENODEV",
  "ENOTDIR",
  "ENXIO",
  "materialization_file_worker_syscall_failed"
]);
const TARGET_FINGERPRINT_VERSION: any =
  "v0.0.1:agent-workspace:materialization-target-fingerprint-2";
const PUBLICATION_INTENT_VERSION: any =
  "v0.0.1:agent-workspace:materialization-publication-intent-2";
const PUBLICATION_RESERVATION_VERSION: any =
  "v0.0.1:agent-workspace:materialization-publication-reservation-1";
const PUBLICATION_PROOF_VERSION: any =
  "v0.0.1:agent-workspace:materialization-publication-proof-2";

function materializationError(code?: any, status?: any, message?: any) : any {
  return Object.assign(new Error(message), {
    code,
    status,
    statusCode: status
  });
}

function controlledFailure(error?: any, fallbackCode: any = "workspace_materialization_failed") : any {
  return Object.freeze({
    ok: false,
    status: Number(error?.status || error?.statusCode || 500),
    code: String(error?.code || fallbackCode),
    error: String(error?.message || "Workspace materialization failed.")
  });
}

function isControlledError(error?: any) : any {
  return Boolean(
    error?.code &&
    Number.isInteger(Number(error?.status || error?.statusCode))
  );
}

function fingerprint(value?: any) : any {
  return createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function exactObject(value?: any, keys?: any) : any {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function normalizeDigest(value?: any, label: any = "Content digest") : any {
  const digest: any = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw materializationError(
      "materialization_binding_invalid",
      409,
      `${label} must be a SHA-256 digest.`
    );
  }
  return digest;
}

function boundedId(value?: any, label?: any) : any {
  const normalized: any = String(value || "").trim();
  if (
    !normalized ||
    normalized.length > 768 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw materializationError(
      "materialization_binding_invalid",
      400,
      `${label} is invalid.`
    );
  }
  return normalized;
}

function normalizeByteCount(value?: any) : any {
  const byteCount: any = Number(value);
  if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
    throw materializationError(
      "materialization_binding_invalid",
      409,
      "The materialization byte count is invalid."
    );
  }
  return byteCount;
}

function normalizeLogicalTarget(value?: any) : any {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.includes("\\")
  ) {
    throw materializationError(
      "materialization_path_invalid",
      400,
      "The logical target must be a normalized workspace-relative path."
    );
  }
  let normalized: any;
  try {
    normalized = normalizeWorkspaceRelativePath(
      value,
      { allowEmpty: false }
    );
  } catch {
    throw materializationError(
      "materialization_path_invalid",
      400,
      "The logical target must be a normalized workspace-relative path."
    );
  }
  const segments: any = value.split("/");
  if (
    normalized !== value ||
    segments.some((segment?: any) : any =>
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".") ||
      segment.includes("\0")
    )
  ) {
    throw materializationError(
      "materialization_path_invalid",
      400,
      "The logical target contains an unsafe path segment."
    );
  }
  return normalized;
}

function normalizeTempLeaf(value?: any) : any {
  const normalized: any = String(value || "");
  if (
    !/^\.meshrix-materialization-[A-Za-z0-9_-]{16,128}(?:\.tmp)?$/u
      .test(normalized) ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("..") ||
    path.basename(normalized) !== normalized
  ) {
    throw materializationError(
      "materialization_binding_invalid",
      400,
      "The publication temporary leaf is invalid."
    );
  }
  return normalized;
}

function statMode(stat?: any) : any {
  return Number(
    typeof stat.mode === "bigint"
      ? stat.mode & 0o7777n
      : stat.mode & 0o7777
  );
}

function statIdentity(stat?: any) : any {
  const birthtimeNs: any = typeof stat.birthtimeNs === "bigint"
    ? stat.birthtimeNs
    : BigInt(Math.max(
        0,
        Math.trunc(Number(stat.birthtimeMs || 0) * 1_000_000)
      ));
  return Object.freeze({
    birthtimeNs: String(birthtimeNs),
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: statMode(stat)
  });
}

function normalizeFsIdentity(value?: any, label?: any, { requirePrivateFile = false }: Record<string, any> = {}) : any {
  if (
    !exactObject(value, ["birthtimeNs", "dev", "ino", "mode"]) &&
    !exactObject(
      value,
      [
        "birthtimeNs",
        "byteCount",
        "contentDigest",
        "dev",
        "ino",
        "mode"
      ]
    )
  ) {
    throw materializationError(
      "materialization_binding_invalid",
      409,
      `${label} is invalid.`
    );
  }
  const normalized: Record<string, any> = {
    birthtimeNs: String(value.birthtimeNs || ""),
    dev: String(value.dev || ""),
    ino: String(value.ino || ""),
    mode: Number(value.mode)
  };
  if (
    !/^\d+$/u.test(normalized.birthtimeNs) ||
    !/^\d+$/u.test(normalized.dev) ||
    !/^\d+$/u.test(normalized.ino) ||
    !Number.isSafeInteger(normalized.mode) ||
    normalized.mode < 0 ||
    (requirePrivateFile && normalized.mode !== PRIVATE_FILE_MODE)
  ) {
    throw materializationError(
      "materialization_binding_invalid",
      409,
      `${label} is invalid.`
    );
  }
  if (Object.hasOwn(value, "contentDigest")) {
    normalized.contentDigest = normalizeDigest(
      value.contentDigest,
      `${label} content digest`
    );
    normalized.byteCount = normalizeByteCount(value.byteCount);
  }
  return Object.freeze(normalized);
}

function workerIdentity(value?: any, label?: any) : any {
  const identity: any = normalizeFsIdentity(value, label);
  return Object.freeze({
    birthtimeNs: identity.birthtimeNs,
    dev: identity.dev,
    ino: identity.ino,
    mode: identity.mode
  });
}

function sameIdentity(left?: any, right?: any) : any {
  return Boolean(
    left &&
    right &&
    String(left.birthtimeNs) === String(right.birthtimeNs) &&
    String(left.dev) === String(right.dev) &&
    String(left.ino) === String(right.ino) &&
    Number(left.mode) === Number(right.mode)
  );
}

async function guardAttempt({ leaseGuard = null, signal = null }: Record<string, any> = {}) : Promise<any> {
  if (signal?.aborted) {
    throw materializationError(
      "materialization_cancelled",
      409,
      "Workspace materialization was cancelled."
    );
  }
  if (typeof leaseGuard === "function") {
    const result: any = await leaseGuard();
    if (result === false) {
      throw materializationError(
        "materialization_fenced",
        409,
        "Workspace materialization lost its lease."
      );
    }
  }
  if (signal?.aborted) {
    throw materializationError(
      "materialization_cancelled",
      409,
      "Workspace materialization was cancelled."
    );
  }
}

async function lstatOrMissing(candidate?: any) : Promise<any> {
  try {
    return await fs.lstat(candidate, { bigint: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertPrivateDirectory(stat?: any) : any {
  if (
    !stat?.isDirectory?.() ||
    stat?.isSymbolicLink?.() ||
    statMode(stat) !== PRIVATE_DIRECTORY_MODE ||
    (
      Number.isInteger(process.geteuid?.()) &&
      Number(stat.uid) !== process.geteuid?.()
    ) ||
    (
      Number.isInteger(process.getegid?.()) &&
      Number(stat.gid) !== process.getegid?.()
    )
  ) {
    throw materializationError(
      "materialization_path_invalid",
      409,
      "The logical target parent chain is not private and link-safe."
    );
  }
}

async function inspectTargetChain(rootPath?: any, logicalTarget?: any) : Promise<any> {
  const root: any = path.resolve(rootPath);
  const segments: any = logicalTarget.split("/");
  const parentSegments: any = segments.slice(0, -1);
  const rootStat: any = await lstatOrMissing(root);
  assertPrivateDirectory(rootStat);
  const parentStates: any[] = [{
    depth: 0,
    nameDigest: fingerprint("workspace-root"),
    ...statIdentity(rootStat)
  }];
  let current: any = root;
  let missingFrom: any = -1;
  for (let index: any = 0; index < parentSegments.length; index += 1) {
    current = path.join(current, parentSegments[index]);
    const stat: any = await lstatOrMissing(current);
    if (!stat) {
      missingFrom = index;
      break;
    }
    assertPrivateDirectory(stat);
    parentStates.push({
      depth: index + 1,
      nameDigest: fingerprint(parentSegments[index]),
      ...statIdentity(stat)
    });
  }
  const targetPath: any = path.join(root, ...segments);
  const targetStat: any = missingFrom < 0
    ? await lstatOrMissing(targetPath)
    : null;
  const parentIdentity: any = parentStates.at(-1);
  const normalizedParentIdentity: Readonly<Record<string, any>> = Object.freeze({
    birthtimeNs: parentIdentity.birthtimeNs,
    dev: parentIdentity.dev,
    ino: parentIdentity.ino,
    mode: parentIdentity.mode
  });
  const parentFingerprint: any = fingerprint({
    version: TARGET_FINGERPRINT_VERSION,
    logicalTargetDigest: fingerprint(logicalTarget),
    missingParentDepth: missingFrom,
    parentStates
  });
  const targetStateDigest: any = fingerprint({
    version: TARGET_FINGERPRINT_VERSION,
    parentFingerprint,
    target: targetStat
      ? {
          state: "present",
          ...statIdentity(targetStat),
          nlink: String(targetStat.nlink)
        }
      : { state: "missing" }
  });
  return Object.freeze({
    parentFingerprint,
    parentIdentity: normalizedParentIdentity,
    parentPath: path.dirname(targetPath),
    targetLeaf: segments.at(-1),
    targetPath,
    targetStat,
    targetStateDigest,
    missingFrom
  });
}

function normalizeStateEventAnchor(value?: any) : any {
  if (!exactObject(value, ["eventHash", "offset"])) {
    throw materializationError(
      "materialization_binding_invalid",
      409,
      "The state event anchor is invalid."
    );
  }
  const offset: any = Number(value.offset);
  const eventHash: any = String(value.eventHash || "")
    .trim()
    .toLowerCase()
    .replace(/^sha256:/u, "");
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !/^[a-f0-9]{64}$/u.test(eventHash)
  ) {
    throw materializationError(
      "materialization_binding_invalid",
      409,
      "The state event anchor is invalid."
    );
  }
  return Object.freeze({ eventHash, offset });
}

function normalizeBinding(input?: any) : any {
  if (
    !exactObject(
      input,
      [
        "bindingDigest",
        "byteCount",
        "contentDigest",
        "expectedWorkspaceRevision",
        "logicalTarget",
        "operationId",
        "requestRef",
        "workspaceId"
      ]
    )
  ) {
    throw materializationError(
      "materialization_binding_invalid",
      400,
      "Workspace materialization request binding is not closed."
    );
  }
  return Object.freeze({
    bindingDigest: normalizeDigest(
      input.bindingDigest,
      "Materialization binding digest"
    ),
    byteCount: normalizeByteCount(input.byteCount),
    contentDigest: normalizeDigest(input.contentDigest),
    expectedWorkspaceRevision: boundedId(
      input.expectedWorkspaceRevision,
      "Expected workspace revision"
    ),
    logicalTarget: normalizeLogicalTarget(input.logicalTarget),
    operationId: boundedId(input.operationId, "Operation identity"),
    requestRef: boundedId(input.requestRef, "Request reference"),
    workspaceId: boundedId(input.workspaceId, "Workspace identity")
  });
}

function publicationIntentDigest(publication?: any) : any {
  return fingerprint({
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

function normalizePublicationIntent(value?: any, binding?: any, target?: any, anchor?: any) : any {
  const expectedKeys: any[] = [
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
  ];
  if (!exactObject(value, expectedKeys)) {
    throw materializationError(
      "materialization_publication_wal_invalid",
      409,
      "Publication intent is not a closed descriptor."
    );
  }
  const publication: Record<string, any> = {
    byteCount: normalizeByteCount(value.byteCount),
    contentDigest: normalizeDigest(value.contentDigest),
    logicalTargetDigest: normalizeDigest(
      value.logicalTargetDigest,
      "Logical target digest"
    ),
    parentFingerprint: normalizeDigest(
      value.parentFingerprint,
      "Parent fingerprint"
    ),
    parentIdentity: normalizeFsIdentity(
      value.parentIdentity,
      "Parent identity"
    ),
    preparedIdentity: null,
    priorRevision: boundedId(
      value.priorRevision,
      "Prior workspace revision"
    ),
    proofDigest: "",
    publicationId: boundedId(
      value.publicationId,
      "Publication identity"
    ),
    reservationDigest: "",
    stateEventAnchor: normalizeStateEventAnchor(value.stateEventAnchor),
    stateOperationId: boundedId(
      value.stateOperationId,
      "State operation identity"
    ),
    targetStateDigest: normalizeDigest(
      value.targetStateDigest,
      "Target-state digest"
    ),
    tempLeafRef: normalizeTempLeaf(value.tempLeafRef)
  };
  if (
    publication.byteCount !== binding.byteCount ||
    publication.contentDigest !== binding.contentDigest ||
    publication.logicalTargetDigest !== fingerprint(binding.logicalTarget) ||
    publication.parentFingerprint !== target.parentFingerprint ||
    !sameIdentity(publication.parentIdentity, target.parentIdentity) ||
    publication.priorRevision !== binding.expectedWorkspaceRevision ||
    publication.stateEventAnchor.offset !== anchor.offset ||
    publication.stateEventAnchor.eventHash !== anchor.eventHash ||
    publication.targetStateDigest !== target.targetStateDigest ||
    value.preparedIdentity !== null ||
    value.reservationDigest !== "" ||
    value.proofDigest !== ""
  ) {
    throw materializationError(
      "materialization_publication_wal_mismatch",
      409,
      "Publication intent does not match the inspected workspace state."
    );
  }
  publication.intentDigest = publicationIntentDigest(publication);
  if (publication.intentDigest !== String(value.intentDigest || "")) {
    throw materializationError(
      "materialization_publication_wal_mismatch",
      409,
      "Publication intent digest is not canonical."
    );
  }
  return Object.freeze(publication);
}

function preparedIdentityFromReserved(reserved?: any, publication?: any) : any {
  const identity: any = normalizeFsIdentity(
    reserved,
    "Reserved inode identity",
    { requirePrivateFile: true }
  );
  return Object.freeze({
    ...identity,
    byteCount: publication.byteCount,
    contentDigest: publication.contentDigest
  });
}

function publicationReservationDigest(publication?: any, preparedIdentity?: any) : any {
  return fingerprint({
    version: PUBLICATION_RESERVATION_VERSION,
    intentDigest: publication.intentDigest,
    preparedIdentity
  });
}

function publicationProofDigest(publication?: any) : any {
  return fingerprint({
    version: PUBLICATION_PROOF_VERSION,
    intentDigest: publication.intentDigest,
    reservationDigest: publication.reservationDigest,
    preparedIdentity: publication.preparedIdentity
  });
}

function reservedPublication(publication?: any, reservedIdentity?: any) : any {
  const preparedIdentity: any = preparedIdentityFromReserved(
    reservedIdentity,
    publication
  );
  return Object.freeze({
    ...publication,
    preparedIdentity,
    reservationDigest: publicationReservationDigest(
      publication,
      preparedIdentity
    ),
    proofDigest: ""
  });
}

function preparedPublication(publication?: any) : any {
  return Object.freeze({
    ...publication,
    proofDigest: publicationProofDigest(publication)
  });
}

function normalizeRecoveryPublication(value?: any, binding?: any) : any {
  const expectedKeys: any[] = [
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
  ];
  if (!exactObject(value, expectedKeys)) {
    throw materializationError(
      "materialization_publication_wal_invalid",
      409,
      "Recovery publication is unavailable."
    );
  }
  const base: Record<string, any> = {
    byteCount: normalizeByteCount(value.byteCount),
    contentDigest: normalizeDigest(value.contentDigest),
    intentDigest: normalizeDigest(value.intentDigest, "Intent digest"),
    logicalTargetDigest: normalizeDigest(
      value.logicalTargetDigest,
      "Logical target digest"
    ),
    parentFingerprint: normalizeDigest(
      value.parentFingerprint,
      "Parent fingerprint"
    ),
    parentIdentity: normalizeFsIdentity(
      value.parentIdentity,
      "Parent identity"
    ),
    priorRevision: boundedId(value.priorRevision, "Prior revision"),
    publicationId: boundedId(value.publicationId, "Publication identity"),
    stateEventAnchor: normalizeStateEventAnchor(value.stateEventAnchor),
    stateOperationId: boundedId(
      value.stateOperationId,
      "State operation identity"
    ),
    targetStateDigest: normalizeDigest(
      value.targetStateDigest,
      "Target-state digest"
    ),
    tempLeafRef: normalizeTempLeaf(value.tempLeafRef)
  };
  if (
    base.byteCount !== binding.byteCount ||
    base.contentDigest !== binding.contentDigest ||
    base.logicalTargetDigest !== fingerprint(binding.logicalTarget) ||
    base.priorRevision !== binding.expectedWorkspaceRevision ||
    publicationIntentDigest(base) !== base.intentDigest
  ) {
    throw materializationError(
      "materialization_publication_wal_mismatch",
      409,
      "Recovery publication binding is not canonical."
    );
  }
  if (value.preparedIdentity === null) {
    if (
      String(value.reservationDigest || "") !== "" ||
      String(value.proofDigest || "") !== ""
    ) {
      throw materializationError(
        "materialization_publication_wal_mismatch",
        409,
        "Intent-only recovery contains an inode proof."
      );
    }
    return Object.freeze({
      ...base,
      preparedIdentity: null,
      reservationDigest: "",
      proofDigest: ""
    });
  }
  const preparedIdentity: any = normalizeFsIdentity(
    value.preparedIdentity,
    "Prepared inode identity",
    { requirePrivateFile: true }
  );
  if (
    preparedIdentity.contentDigest !== base.contentDigest ||
    preparedIdentity.byteCount !== base.byteCount
  ) {
    throw materializationError(
      "materialization_publication_wal_mismatch",
      409,
      "Prepared inode identity does not match its content binding."
    );
  }
  const reserved: Readonly<Record<string, any>> = Object.freeze({
    ...base,
    preparedIdentity,
    reservationDigest: publicationReservationDigest(
      base,
      preparedIdentity
    ),
    proofDigest: ""
  });
  if (reserved.reservationDigest !== String(value.reservationDigest || "")) {
    throw materializationError(
      "materialization_publication_wal_mismatch",
      409,
      "Publication reservation digest is not canonical."
    );
  }
  if (!value.proofDigest) return reserved;
  const prepared: any = preparedPublication(reserved);
  if (prepared.proofDigest !== String(value.proofDigest || "")) {
    throw materializationError(
      "materialization_publication_wal_mismatch",
      409,
      "Publication proof digest is not canonical."
    );
  }
  return prepared;
}

async function requireExactAck(callback?: any, publication?: any, stage?: any) : Promise<any> {
  if (typeof callback !== "function") {
    throw materializationError(
      "materialization_publication_wal_unavailable",
      503,
      `The ${stage} publication journal is unavailable.`
    );
  }
  const acknowledged: any = await callback(publication);
  const candidate: any = acknowledged?.publication || acknowledged;
  if (
    !candidate ||
    canonicalJson(candidate) !== canonicalJson(publication)
  ) {
    throw materializationError(
      "materialization_publication_wal_mismatch",
      409,
      `The ${stage} journal did not acknowledge the exact descriptor.`
    );
  }
}

function bufferView(value?: any) : any {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw materializationError(
    "materialization_upload_digest_mismatch",
    409,
    "The authorized custody stream emitted a non-binary chunk."
  );
}

async function copyBoundedStream({
  stream,
  worker,
  byteCount,
  guard,
  afterFirstWrite = null
}: Record<string, any>) : Promise<any> {
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    throw materializationError(
      "materialization_stream_required",
      503,
      "An authorized custody stream is required."
    );
  }
  let copied: any = 0;
  for await (const value of stream) {
    const chunk: any = bufferView(value);
    for (
      let offset: any = 0;
      offset < chunk.byteLength;
      offset += MAX_STREAM_WINDOW_BYTES
    ) {
      await guardAttempt(guard);
      const window: any = chunk.subarray(
        offset,
        Math.min(
          chunk.byteLength,
          offset + MAX_STREAM_WINDOW_BYTES
        )
      );
      if (copied + window.byteLength > byteCount) {
        throw materializationError(
          "materialization_upload_digest_mismatch",
          409,
          "The authorized custody stream exceeded its byte binding."
        );
      }
      await worker.write(window);
      copied += window.byteLength;
      if (copied === window.byteLength) {
        await afterFirstWrite?.({ copiedBytes: copied });
      }
    }
  }
  if (copied !== byteCount) {
    throw materializationError(
      "materialization_upload_digest_mismatch",
      409,
      "The authorized custody stream was shorter than its byte binding."
    );
  }
}

async function* guardedArchiveChunks(worker?: any, guard?: any) : AsyncGenerator<any, any, any> {
  const iterator: any = worker.readChunks()[Symbol.asyncIterator]();
  while (true) {
    await guardAttempt(guard);
    const next: any = await iterator.next();
    await guardAttempt(guard);
    if (next.done) return;
    yield next.value;
  }
}

function incrementalCheckpointSnapshot({
  workspace,
  logicalTarget,
  stateCommit,
  archived,
  publication
}: Record<string, any>) : any {
  return Object.freeze({
    schemaVersion: "v0.0.1:workspace:file-incremental-checkpoint-1",
    workspaceId: workspace.workspaceId,
    stateRoot: stateCommit.afterRoot,
    incremental: true,
    files: [{
      path: logicalTarget,
      exists: true,
      contentCid: archived.rootCid,
      contentSha256: publication.contentDigest,
      byteLength: publication.byteCount,
      mode: PRIVATE_FILE_MODE,
      executable: false
    }]
  });
}

function exactPublicationPayload({
  workspace,
  logicalTarget,
  publication,
  archived
}: Record<string, any>) : any {
  return Object.freeze({
    action: "file.materialize",
    archiveContentRefsDigest: fingerprint(archived.contentRefs || []),
    archiveRootCid: archived.rootCid,
    contentSha256: publication.contentDigest,
    pathDigest: fingerprint(logicalTarget),
    publicationId: publication.publicationId,
    publicationProofDigest: publication.proofDigest,
    publishedIdentityDigest: fingerprint(publication.preparedIdentity),
    sizeBytes: publication.byteCount,
    workspaceId: workspace.workspaceId
  });
}

function isExactPublicationEvent({
  event,
  workspace,
  logicalTarget,
  publication
}: Record<string, any>) : any {
  if (!event || !publication?.proofDigest) return false;
  const payload: any = event.payload;
  const expectedKeys: any[] = [
    "action",
    "archiveContentRefsDigest",
    "archiveRootCid",
    "contentSha256",
    "pathDigest",
    "publicationId",
    "publicationProofDigest",
    "publishedIdentityDigest",
    "sizeBytes",
    "workspaceId"
  ];
  return Boolean(
    event.operationId === publication.stateOperationId &&
    Number(event.offset) === publication.stateEventAnchor.offset + 1 &&
    String(event.prevEventHash || "").replace(/^sha256:/u, "") ===
      publication.stateEventAnchor.eventHash &&
    event.beforeRoot === publication.priorRevision &&
    exactObject(payload, expectedKeys) &&
    payload.action === "file.materialize" &&
    payload.archiveRootCid &&
    payload.contentSha256 === publication.contentDigest &&
    payload.pathDigest === fingerprint(logicalTarget) &&
    payload.publicationId === publication.publicationId &&
    payload.publicationProofDigest === publication.proofDigest &&
    payload.publishedIdentityDigest ===
      fingerprint(publication.preparedIdentity) &&
    Number(payload.sizeBytes) === publication.byteCount &&
    payload.workspaceId === workspace.workspaceId
  );
}

function requireDependencies(dependencies?: any) : any {
  for (const [name, value] of [
    ["workspaceForMaterialization", dependencies.workspaceForMaterialization],
    ["workspaceFsRoot", dependencies.workspaceFsRoot],
    ["workspaceFileRevision", dependencies.workspaceFileRevision],
    [
      "captureWorkspaceMaterializationSnapshot",
      dependencies.captureWorkspaceMaterializationSnapshot
    ],
    ["withWorkspaceMutation", dependencies.withWorkspaceMutation],
    ["fileStateApi", dependencies.fileStateApi]
  ]) {
    if (
      !value ||
      (name !== "fileStateApi" && typeof value !== "function")
    ) {
      throw new TypeError(
        `Agent workspace materialization requires ${name}.`
      );
    }
  }
  for (const [name, method] of [
    ["state begin", dependencies.merkleState?.stateCommit?.begin],
    ["state commit", dependencies.merkleState?.stateCommit?.commit],
    [
      "state commit event lookup",
      dependencies.merkleState?.stateCommit?.getCommitByEventHash
    ],
    ["event lookup", dependencies.merkleState?.eventLog?.getEvent],
    ["event list", dependencies.merkleState?.eventLog?.listEvents],
    ["event verification", dependencies.merkleState?.eventLog?.verifyPartition],
    ["state membership lookup", dependencies.merkleState?.merkleIndex?.get],
    [
      "stream archive",
      dependencies.fileStateApi?.archiveWorkspaceFileSource
    ]
  ]) {
    if (typeof method !== "function") {
      throw new TypeError(
        `Agent workspace materialization requires ${name}.`
      );
    }
  }
}

async function strictAccess(binding?: any, dependencies?: any) : Promise<any> {
  const access: any = dependencies.workspaceForMaterialization({
    workspaceId: binding.workspaceId
  });
  if (!access?.ok) {
    throw materializationError(
      access?.code || "materialization_workspace_missing",
      Number(access?.status || 404),
      "The materialization workspace is unavailable."
    );
  }
  const rootPath: any = dependencies.workspaceFsRoot(access.workspace);
  return { access, rootPath, workspace: access.workspace };
}

async function strictRevision(binding?: any, dependencies?: any) : Promise<any> {
  const result: any = await dependencies.workspaceFileRevision({
    workspaceId: binding.workspaceId
  });
  if (!result?.ok || !result.revision) {
    throw materializationError(
      result?.code || "materialization_revision_uninitialized",
      Number(result?.status || 409),
      "Workspace materialization revision is uninitialized."
    );
  }
  return String(result.revision);
}

async function latestAnchor(workspace?: any, dependencies?: any) : Promise<any> {
  const events: any = await dependencies.merkleState.eventLog.listEvents(
    dependencies.fileStateApi.workspaceStateScope(workspace),
    { limit: 1 }
  );
  return events[0]
    ? normalizeStateEventAnchor({
        eventHash: events[0].eventHash,
        offset: events[0].offset
      })
    : null;
}

async function inspectBoundTarget(binding?: any, dependencies?: any, guard: Record<string, any> = {}) : Promise<any> {
  await guardAttempt(guard);
  const { rootPath, workspace } = await strictAccess(
    binding,
    dependencies
  );
  const revision: any = await strictRevision(binding, dependencies);
  if (revision !== binding.expectedWorkspaceRevision) {
    throw materializationError(
      "materialization_stale_revision",
      409,
      "Workspace materialization revision is stale."
    );
  }
  const target: any = await inspectTargetChain(
    rootPath,
    binding.logicalTarget
  );
  if (target.missingFrom >= 0) {
    throw materializationError(
      "materialization_parent_missing",
      409,
      "The workspace materialization parent must already exist."
    );
  }
  if (target.targetStat) {
    throw materializationError(
      "materialization_target_not_missing",
      409,
      "The workspace materialization target must be missing."
    );
  }
  const anchor: any = await latestAnchor(workspace, dependencies);
  if (!anchor) {
    throw materializationError(
      "materialization_revision_uninitialized",
      409,
      "Workspace materialization state has no durable anchor."
    );
  }
  await guardAttempt(guard);
  return Object.freeze({
    anchor,
    currentRevision: revision,
    parentFingerprint: target.parentFingerprint,
    parentIdentity: target.parentIdentity,
    targetStateDigest: target.targetStateDigest
  });
}

async function captureBoundPreimage(binding?: any, dependencies?: any, guard: Record<string, any> = {}) : Promise<any> {
  const before: any = await inspectBoundTarget(
    binding,
    dependencies,
    guard
  );
  const captured: any =
    await dependencies.captureWorkspaceMaterializationSnapshot({
      workspaceId: binding.workspaceId,
      logicalTarget: binding.logicalTarget,
      leaseGuard: guard.leaseGuard
    });
  const snapshot: any = captured?.snapshot;
  const files: any = Array.isArray(snapshot?.files) ? snapshot.files : [];
  const entry: any = files[0] || null;
  if (
    captured?.ok !== true ||
    snapshot?.workspaceId !== binding.workspaceId ||
    snapshot?.stateRoot !== binding.expectedWorkspaceRevision ||
    files.length !== 1 ||
    String(entry?.relativePath || entry?.path || "") !==
      binding.logicalTarget ||
    entry?.exists !== false ||
    normalizeStateEventAnchor(snapshot.stateEventAnchor).offset !==
      before.anchor.offset ||
    normalizeStateEventAnchor(snapshot.stateEventAnchor).eventHash !==
      before.anchor.eventHash
  ) {
    throw materializationError(
      "materialization_preimage_incomplete",
      409,
      "Workspace materialization preimage is incomplete."
    );
  }
  const after: any = await inspectBoundTarget(
    binding,
    dependencies,
    guard
  );
  if (
    after.parentFingerprint !== before.parentFingerprint ||
    !sameIdentity(after.parentIdentity, before.parentIdentity) ||
    after.targetStateDigest !== before.targetStateDigest
  ) {
    throw materializationError(
      "materialization_preimage_conflict",
      409,
      "Workspace materialization target changed during preimage capture."
    );
  }
  return Object.freeze({
    ok: true,
    preimage: snapshot,
    priorRevision: binding.expectedWorkspaceRevision,
    target: before
  });
}

async function assertBoundTargetUnchanged(
  binding?: any,
  expected?: any,
  dependencies?: any,
  guard?: any
) : Promise<any> {
  const current: any = await inspectBoundTarget(
    binding,
    dependencies,
    guard
  );
  if (
    current.parentFingerprint !== expected.parentFingerprint ||
    !sameIdentity(current.parentIdentity, expected.parentIdentity) ||
    current.targetStateDigest !== expected.targetStateDigest ||
    current.anchor.offset !== expected.anchor.offset ||
    current.anchor.eventHash !== expected.anchor.eventHash
  ) {
    throw materializationError(
      "materialization_target_changed",
      409,
      "Workspace materialization target changed."
    );
  }
}

async function materializeBoundStream(
  binding?: any,
  input?: any,
  dependencies?: any
) : Promise<any> {
  const guard: Record<string, any> = {
    leaseGuard: input.leaseGuard,
    signal: input.signal
  };
  const { rootPath, workspace } = await strictAccess(
    binding,
    dependencies
  );
  const target: any = await inspectBoundTarget(
    binding,
    dependencies,
    guard
  );
  const inspected: any = await inspectTargetChain(
    rootPath,
    binding.logicalTarget
  );
  const publication: any = normalizePublicationIntent(
    input.publication,
    binding,
    inspected,
    target.anchor
  );
  let currentPublication: any = publication;
  let worker: any = null;
  let stateCommit: any = null;
  let stateCommitAttempted: any = false;
  try {
    await assertBoundTargetUnchanged(
      binding,
      target,
      dependencies,
      guard
    );
    worker = await createMaterializationDirectoryWorker({
      parentPath: inspected.parentPath,
      parentIdentity: publication.parentIdentity,
      preparedContentVerified: false,
      targetLeaf: inspected.targetLeaf,
      tempLeaf: publication.tempLeafRef,
      contentDigest: publication.contentDigest,
      byteCount: publication.byteCount
    });
    await input.afterDirectoryWorkerBoundBeforeReserve?.({
      intentDigest: publication.intentDigest,
      publicationId: publication.publicationId,
      stateOperationId: publication.stateOperationId
    });
    await guardAttempt(guard);
    if (typeof input.claimPublicationAuthority !== "function") {
      throw materializationError(
        "materialization_publication_authority_required",
        503,
        "Current workspace publication authority is required."
      );
    }
    const authorizedStream: any =
      await input.claimPublicationAuthority();
    const reserved: any = await worker.reserve();
    await input.afterTempInodeReservedBeforeWal?.({
      intentDigest: publication.intentDigest,
      publicationId: publication.publicationId,
      stateOperationId: publication.stateOperationId
    });
    currentPublication = reservedPublication(
      publication,
      reserved.preparedIdentity
    );
    await requireExactAck(
      input.recordTempReserved,
      currentPublication,
      "temp_reserved"
    );
    await input.afterTempReservedBeforeFirstWrite?.({
      publicationId: currentPublication.publicationId,
      reservationDigest: currentPublication.reservationDigest,
      stateOperationId: currentPublication.stateOperationId
    });
    await copyBoundedStream({
      stream: authorizedStream,
      worker,
      byteCount: currentPublication.byteCount,
      guard,
      afterFirstWrite: ({ copiedBytes }: Record<string, any>) : any =>
        input.afterFirstChunkWrittenBeforeContinue?.({
          copiedBytes,
          publicationId: currentPublication.publicationId,
          stateOperationId: currentPublication.stateOperationId
        })
    });
    await guardAttempt(guard);
    const finished: any = await worker.finish();
    if (
      !sameIdentity(
        finished.preparedIdentity,
        currentPublication.preparedIdentity
      ) ||
      finished.contentDigest !== currentPublication.contentDigest
    ) {
      throw materializationError(
        "materialization_target_identity_mismatch",
        409,
        "Prepared materialization identity changed."
      );
    }
    currentPublication = preparedPublication(currentPublication);
    await requireExactAck(
      input.recordPublicationPrepared,
      currentPublication,
      "publication_prepared"
    );
    await input.afterPublicationPreparedBeforeLink?.({
      proofDigest: currentPublication.proofDigest,
      publicationId: currentPublication.publicationId,
      stateOperationId: currentPublication.stateOperationId
    });
    await assertBoundTargetUnchanged(
      binding,
      target,
      dependencies,
      guard
    );
    await guardAttempt(guard);
    await worker.link();
    await input.afterPublicationLinkedBeforeTempUnlink?.({
      proofDigest: currentPublication.proofDigest,
      publicationId: currentPublication.publicationId,
      stateOperationId: currentPublication.stateOperationId
    });
    await guardAttempt(guard);
    await worker.finishPublish();
    await input.afterPublishedFileDurableBeforeStateCommit?.({
      proofDigest: currentPublication.proofDigest,
      publicationId: currentPublication.publicationId,
      stateOperationId: currentPublication.stateOperationId
    });
    await guardAttempt(guard);
    const currentParent: any = await inspectTargetChain(
      rootPath,
      binding.logicalTarget
    );
    if (
      !currentParent.targetStat ||
      currentParent.parentFingerprint !== publication.parentFingerprint ||
      !sameIdentity(
        currentParent.parentIdentity,
        publication.parentIdentity
      ) ||
      !sameIdentity(
        statIdentity(currentParent.targetStat),
        currentPublication.preparedIdentity
      )
    ) {
      throw materializationError(
        "materialization_parent_identity_mismatch",
        409,
        "Workspace parent changed during descriptor-bound publication."
      );
    }
    const preArchiveVerification: any = await worker.verify();
    if (
      preArchiveVerification.contentDigest !==
        currentPublication.contentDigest ||
      preArchiveVerification.byteCount !== currentPublication.byteCount ||
      preArchiveVerification.nlink !== 1 ||
      !sameIdentity(
        preArchiveVerification.preparedIdentity,
        currentPublication.preparedIdentity
      )
    ) {
      throw materializationError(
        "materialization_target_identity_mismatch",
        409,
        "Published materialization identity changed before archive."
      );
    }
    await guardAttempt(guard);
    const archived: any =
      await dependencies.fileStateApi.archiveWorkspaceFileSource(
        workspace,
        binding.logicalTarget,
        {
          source: guardedArchiveChunks(worker, guard),
          expectedSha256: currentPublication.contentDigest,
          expectedByteCount: currentPublication.byteCount,
          metadata: {
            bindingDigest: binding.bindingDigest
          }
        }
      );
    const payload: any = exactPublicationPayload({
      workspace,
      logicalTarget: binding.logicalTarget,
      publication: currentPublication,
      archived
    });
    const verified: any = await worker.verify();
    if (
      verified.contentDigest !== currentPublication.contentDigest ||
      verified.byteCount !== currentPublication.byteCount ||
      verified.nlink !== 1 ||
      !sameIdentity(
        verified.preparedIdentity,
        currentPublication.preparedIdentity
      )
    ) {
      throw materializationError(
        "materialization_target_identity_mismatch",
        409,
        "Published materialization identity changed before state commit."
      );
    }
    await guardAttempt(guard);
    stateCommitAttempted = true;
    stateCommit = await dependencies.fileStateApi.commitWorkspaceFileState({
      workspace,
      operationId: currentPublication.stateOperationId,
      expectedCurrentRoot: binding.expectedWorkspaceRevision,
      idempotencyKey: currentPublication.proofDigest,
      mutations: [{
        action: "put",
        key: binding.logicalTarget,
        valueRef: archived.rootCid,
        metadata: {
          type: "file",
          sizeBytes: currentPublication.byteCount,
          contentSha256: currentPublication.contentDigest,
          mode: PRIVATE_FILE_MODE,
          executable: false,
          updatedAt: nowIso()
        }
      }],
      contentRefs: archived.contentRefs,
      payload
    });
    if (
      !stateCommit?.commitId ||
      stateCommit.beforeRoot !== binding.expectedWorkspaceRevision ||
      stateCommit.operationId !== currentPublication.stateOperationId ||
      stateCommit.payload?.publicationProofDigest !==
        currentPublication.proofDigest
    ) {
      throw materializationError(
        "materialization_revision_unverified",
        500,
        "Workspace materialization state commit is incomplete."
      );
    }
    await guardAttempt(guard);
    const checkpoint: any =
      await dependencies.fileStateApi.recordWorkspaceFileCheckpoint({
        workspace,
        operationId: currentPublication.stateOperationId,
        stateCommit,
        action: "file.materialize",
        path: binding.logicalTarget,
        workspaceFileSnapshot: incrementalCheckpointSnapshot({
          workspace,
          logicalTarget: binding.logicalTarget,
          stateCommit,
          archived,
          publication: currentPublication
        })
      });
    if (!checkpoint?.nodeId) {
      throw materializationError(
        "materialization_checkpoint_incomplete",
        500,
        "Workspace materialization checkpoint is incomplete."
      );
    }
    const durableNames: any = await worker.inspectPublished();
    if (
      durableNames.nlink !== 1 ||
      !sameIdentity(
        durableNames.preparedIdentity,
        currentPublication.preparedIdentity
      )
    ) {
      throw materializationError(
        "materialization_target_identity_mismatch",
        409,
        "Published materialization identity changed."
      );
    }
    await guardAttempt(guard);
    dependencies.updateWorkspaceTimeStmt?.run?.(
      nowIso(),
      workspace.workspaceId
    );
    const finalVerification: any = await worker.verify();
    if (
      finalVerification.contentDigest !==
        currentPublication.contentDigest ||
      finalVerification.byteCount !== currentPublication.byteCount ||
      finalVerification.nlink !== 1 ||
      !sameIdentity(
        finalVerification.preparedIdentity,
        currentPublication.preparedIdentity
      )
    ) {
      throw materializationError(
        "materialization_target_identity_mismatch",
        409,
        "Published materialization content changed after checkpoint."
      );
    }
    await input.afterStateAndCheckpointDurableBeforeReceipt?.({
      checkpointRef: checkpoint.nodeId,
      proofDigest: currentPublication.proofDigest,
      publicationId: currentPublication.publicationId,
      publishedRevision: stateCommit.afterRoot,
      stateOperationId: currentPublication.stateOperationId
    });
    return Object.freeze({
      ok: true,
      contentDigest: currentPublication.contentDigest,
      byteCount: currentPublication.byteCount,
      beforeRevision: binding.expectedWorkspaceRevision,
      workspaceRevision: stateCommit.afterRoot,
      publishedRevision: stateCommit.afterRoot,
      publishedIdentity: currentPublication.preparedIdentity,
      checkpointRef: checkpoint.nodeId,
      publicationId: currentPublication.publicationId,
      stateOperationId: currentPublication.stateOperationId,
      proofDigest: currentPublication.proofDigest,
      stateCommit
    });
  } catch (error: any) {
    if (error?.abrupt === true) {
      worker?.terminate?.();
      throw error;
    }
    if (
      !stateCommitAttempted &&
      !stateCommit &&
      currentPublication.preparedIdentity &&
      worker
    ) {
      await guardAttempt(guard)
        .then(() : any => worker.cleanup())
        .catch(() : any => {});
    }
    if (
      UNSAFE_INODE_TOPOLOGY_CODES.has(String(error?.code || ""))
    ) {
      throw materializationError(
        "materialization_rollback_incomplete",
        409,
        "Workspace materialization found an unsafe inode topology."
      );
    }
    throw error;
  } finally {
    await worker?.close?.().catch(() : any => {});
  }
}

function preimageProvesMissingTarget(binding?: any, preimage?: any) : any {
  const snapshot: any = preimage?.snapshot &&
    typeof preimage.snapshot === "object"
    ? preimage.snapshot
    : preimage;
  const files: any = Array.isArray(snapshot?.files) ? snapshot.files : [];
  const entry: any = files.find(
    (candidate?: any) : any =>
      String(candidate?.relativePath || candidate?.path || "") ===
      binding.logicalTarget
  );
  return Boolean(
    snapshot?.workspaceId === binding.workspaceId &&
    snapshot?.stateRoot === binding.expectedWorkspaceRevision &&
    entry?.exists === false &&
    snapshot?.stateEventAnchor
  )
    ? snapshot
    : null;
}

async function recoverBoundPublication(
  binding?: any,
  input?: any,
  dependencies?: any
) : Promise<any> {
  const guard: Record<string, any> = {
    leaseGuard: input.leaseGuard,
    signal: input.signal
  };
  await guardAttempt(guard);
  const snapshot: any = preimageProvesMissingTarget(
    binding,
    input.preimage
  );
  if (!snapshot) {
    return controlledFailure(materializationError(
      "materialization_rollback_incomplete",
      409,
      "Workspace materialization preimage cannot be proven."
    ));
  }
  const publication: any = normalizeRecoveryPublication(
    input.publication,
    binding
  );
  const snapshotAnchor: any = normalizeStateEventAnchor(
    snapshot.stateEventAnchor
  );
  if (
    snapshotAnchor.offset !== publication.stateEventAnchor.offset ||
    snapshotAnchor.eventHash !== publication.stateEventAnchor.eventHash
  ) {
    return controlledFailure(materializationError(
      "materialization_rollback_incomplete",
      409,
      "Workspace materialization event anchor changed."
    ));
  }
  const { rootPath, workspace } = await strictAccess(
    binding,
    dependencies
  );
  const inspected: any = await inspectTargetChain(
    rootPath,
    binding.logicalTarget
  );
  if (
    inspected.missingFrom >= 0 ||
    inspected.parentFingerprint !== publication.parentFingerprint ||
    !sameIdentity(
      inspected.parentIdentity,
      publication.parentIdentity
    )
  ) {
    return controlledFailure(materializationError(
      "materialization_rollback_incomplete",
      409,
      "Workspace materialization parent identity changed."
    ));
  }
  const scope: any = dependencies.fileStateApi.workspaceStateScope(workspace);
  const event: any = await dependencies.merkleState.eventLog.getEvent(
    scope,
    publication.stateEventAnchor.offset + 1
  );
  const currentState: any = await dependencies.merkleState.stateCommit.begin({
    scope
  });
  let worker: any;
  try {
    worker = await createMaterializationDirectoryWorker({
      parentPath: inspected.parentPath,
      parentIdentity: publication.parentIdentity,
      preparedContentVerified: Boolean(publication.proofDigest),
      preparedIdentity: publication.preparedIdentity
        ? workerIdentity(
            publication.preparedIdentity,
            "Prepared inode identity"
          )
        : null,
      targetLeaf: inspected.targetLeaf,
      tempLeaf: publication.tempLeafRef,
      contentDigest: publication.contentDigest,
      byteCount: publication.byteCount
    });
    if (event) {
      const [partitionVerification, latestEvents] = await Promise.all([
        dependencies.merkleState.eventLog.verifyPartition(scope),
        dependencies.merkleState.eventLog.listEvents(scope, { limit: 1 })
      ]);
      const latestEvent: any = latestEvents[0] || null;
      if (
        partitionVerification?.ok !== true ||
        !latestEvent ||
        Number(latestEvent.offset) < Number(event.offset) ||
        latestEvent.afterRoot !== currentState.currentRoot ||
        !isExactPublicationEvent({
          event,
          workspace,
          logicalTarget: binding.logicalTarget,
          publication
        })
      ) {
        return controlledFailure(materializationError(
          "materialization_rollback_incomplete",
          409,
          "Workspace materialization event lineage is ambiguous."
        ));
      }
      const currentEntry: any =
        await dependencies.merkleState.merkleIndex.get(
          currentState.currentRoot,
          binding.logicalTarget
        );
      if (
        currentEntry?.valueRef !== event.payload.archiveRootCid ||
        currentEntry?.metadata?.contentSha256 !==
          publication.contentDigest ||
        Number(currentEntry?.metadata?.sizeBytes) !==
          publication.byteCount ||
        Number(currentEntry?.metadata?.mode) !== PRIVATE_FILE_MODE ||
        currentEntry?.metadata?.executable !== false
      ) {
        return controlledFailure(materializationError(
          "materialization_rollback_incomplete",
          409,
          "Committed workspace materialization membership is not exact."
        ));
      }
      const names: any = await worker.inspectRecovery();
      if (names.target !== true || names.temp === true) {
        return controlledFailure(materializationError(
          "materialization_rollback_incomplete",
          409,
          "Committed workspace materialization inode is not exact."
        ));
      }
      const verified: any = await worker.verify();
      if (
        verified.contentDigest !== publication.contentDigest ||
        verified.byteCount !== publication.byteCount ||
        verified.nlink !== 1
      ) {
        return controlledFailure(materializationError(
          "materialization_rollback_incomplete",
          409,
          "Committed workspace materialization content is not exact."
        ));
      }
      const stateCommit: any =
        await dependencies.merkleState.stateCommit.getCommitByEventHash({
          scope,
          eventHash: event.eventHash
        });
      if (
        !stateCommit ||
        stateCommit.operationId !== publication.stateOperationId ||
        stateCommit.beforeRoot !== publication.priorRevision ||
        stateCommit.afterRoot !== event.afterRoot ||
        stateCommit.payload?.publicationProofDigest !==
          publication.proofDigest
      ) {
        return controlledFailure(materializationError(
          "materialization_rollback_incomplete",
          409,
          "Committed workspace materialization receipt is incomplete."
        ));
      }
      const mutation: any = stateCommit.mutations?.find(
        (candidate?: any) : any =>
          candidate.action === "put" &&
          candidate.key === binding.logicalTarget
      );
      if (
        !mutation?.valueRef ||
        event.payload.archiveRootCid !== mutation.valueRef ||
        event.payload.archiveContentRefsDigest !==
          fingerprint(stateCommit.contentRefs || []) ||
        canonicalJson(event.contentRefs || []) !==
          canonicalJson(stateCommit.contentRefs || [])
      ) {
        return controlledFailure(materializationError(
          "materialization_rollback_incomplete",
          409,
          "Committed workspace materialization mutation is incomplete."
        ));
      }
      const archived: Record<string, any> = {
        rootCid: mutation.valueRef,
        contentRefs: stateCommit.contentRefs || [],
        metadata: {
          contentSha256: publication.contentDigest,
          sizeBytes: publication.byteCount
        }
      };
      await guardAttempt(guard);
      const checkpoint: any =
        await dependencies.fileStateApi.recordWorkspaceFileCheckpoint({
          workspace,
          operationId: publication.stateOperationId,
          stateCommit:
            dependencies.fileStateApi.compactStateCommit(stateCommit),
          action: "file.materialize",
          path: binding.logicalTarget,
          workspaceFileSnapshot: incrementalCheckpointSnapshot({
            workspace,
            logicalTarget: binding.logicalTarget,
            stateCommit,
            archived,
            publication
          })
        });
      if (!checkpoint?.nodeId) {
        return controlledFailure(materializationError(
          "materialization_rollback_incomplete",
          409,
          "Committed workspace materialization checkpoint is incomplete."
        ));
      }
      const finalVerification: any = await worker.verify();
      if (
        finalVerification.contentDigest !== publication.contentDigest ||
        finalVerification.byteCount !== publication.byteCount ||
        finalVerification.nlink !== 1
      ) {
        return controlledFailure(materializationError(
          "materialization_rollback_incomplete",
          409,
          "Committed workspace materialization changed after checkpoint."
        ));
      }
      return Object.freeze({
        ok: true,
        disposition: "committed",
        receipt: Object.freeze({
          contentDigest: publication.contentDigest,
          byteCount: publication.byteCount,
          beforeRevision: publication.priorRevision,
          workspaceRevision: stateCommit.afterRoot,
          publishedRevision: stateCommit.afterRoot,
          publishedIdentity: publication.preparedIdentity,
          checkpointRef: checkpoint.nodeId,
          publicationId: publication.publicationId,
          stateOperationId: publication.stateOperationId,
          proofDigest: publication.proofDigest,
          stateCommit:
            dependencies.fileStateApi.compactStateCommit(stateCommit)
        })
      });
    }
    if (
      currentState.currentRoot !== publication.priorRevision ||
      publication.stateEventAnchor.offset !==
        normalizeStateEventAnchor(snapshot.stateEventAnchor).offset
    ) {
      return controlledFailure(materializationError(
        "materialization_rollback_incomplete",
        409,
        "Pre-commit workspace materialization root is ambiguous."
      ));
    }
    const names: any = await worker.inspectRecovery();
    if (
      !publication.preparedIdentity &&
      (
        names.target ||
        (names.temp && names.intentReservation !== true)
      )
    ) {
      return controlledFailure(materializationError(
        "materialization_rollback_incomplete",
        409,
        "Intent-only recovery found an unowned inode."
      ));
    }
    await guardAttempt(guard);
    await worker.cleanup();
    return Object.freeze({
      ok: true,
      disposition: "retry",
      workspaceRevision: publication.priorRevision
    });
  } catch (error: any) {
    if (isControlledError(error)) return controlledFailure(error);
    return controlledFailure(materializationError(
      "materialization_rollback_incomplete",
      409,
      "Workspace materialization recovery could not be proven."
    ));
  } finally {
    await worker?.close?.().catch(() : any => {});
  }
}

function createBoundRequestPort(binding?: any, dependencies?: any) : any {
  return Object.freeze({
    getRevision: async () : Promise<any> => strictRevision(binding, dependencies),
    async inspectTarget(options: Record<string, any> = {}) : Promise<any> {
      try {
        return Object.freeze({
          ok: true,
          ...await inspectBoundTarget(binding, dependencies, options)
        });
      } catch (error: any) {
        if (isControlledError(error)) return controlledFailure(error);
        throw error;
      }
    },
    async capturePreimage(options: Record<string, any> = {}) : Promise<any> {
      try {
        return await captureBoundPreimage(
          binding,
          dependencies,
          options
        );
      } catch (error: any) {
        if (isControlledError(error)) return controlledFailure(error);
        throw error;
      }
    },
    materialize(input: Record<string, any> = {}) : any {
      return materializeBoundStream(binding, input, dependencies);
    },
    async recover(input: Record<string, any> = {}) : Promise<any> {
      try {
        return await recoverBoundPublication(
          binding,
          input,
          dependencies
        );
      } catch (error: any) {
        if (isControlledError(error)) {
          return controlledFailure(error);
        }
        throw error;
      }
    }
  });
}

export function createAgentWorkspaceMaterializationPort(
  dependencies: Record<string, any> = {}
) : any {
  requireDependencies(dependencies);
  const port: Readonly<Record<string, any>> = Object.freeze({
    async withRequest(input?: any, task?: any) : Promise<any> {
      if (typeof task !== "function") {
        throw new TypeError(
          "Workspace materialization request task is required."
        );
      }
      const binding: any = normalizeBinding(input);
      return dependencies.withWorkspaceMutation(
        binding.workspaceId,
        () : any => task(createBoundRequestPort(binding, dependencies))
      );
    }
  });
  return issueAgentWorkspaceMaterializationPort(port);
}
