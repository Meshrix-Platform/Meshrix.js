import crypto from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { Hash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type Database from "better-sqlite3";

import {
  SANDBOX_CUSTODY_ENVELOPE_SCHEMA,
  normalizeCustodyHandle
} from "#meshrix/foundation/execution-sandbox/custody-contracts";
import { assertConsumedGovernedExecutionPermit } from "#meshrix/foundation/security/governed-execution-permit-authority";
import {
  CHUNK_BYTES,
  CONTENT_ALGORITHM,
  chunkAad,
  hashHex,
  nonceFor,
  timingSafeDigest
} from "../execution-sandbox/opaque-custody.ts";
import type { StorageKernel } from "#meshrix/foundation/storage/storage-kernel";
import type { StorageProvider } from "#meshrix/foundation/storage/storage-provider";
import { errorProperty, isObjectRecord, type CodedError } from "./jobs/contracts.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
interface CustodyOwnerInput { subjectId?: string; ownerSubjectId?: string; userId?: string; ownerUserId?: string; tenantId?: string; ownerTenantId?: string; tenant?: string }
interface CustodyBeginInput { sessionId?: string; fileIndex?: number; expectedSha256?: string; expectedByteSize?: number; owner?: CustodyOwnerInput; idempotencyKey?: string; custodyRef?: string }
interface CustodyRow {
  custody_ref: string; owner_binding_digest: string; state: "sealed" | "staging"; pending_identity: string;
  expected_byte_size: number; expected_content_digest: string; committed_plaintext_bytes: number;
  committed_frame_count: number; committed_ciphertext_digest: string; sealed_envelope_digest: string;
  envelope_id: string; sealed_object_id: string; resource_binding_digest: string;
  idempotency_digest: string; prepared_plaintext_bytes: number | null;
  prepared_frame_count: number | null; prepared_ciphertext_digest: string | null;
  created_at: string; updated_at: string;
  storage_rel_path?: string; envelope_byte_count?: number;
}
interface SealedCustodyObject extends CustodyRow { storage_rel_path: string; envelope_byte_count: number }
interface SealedArtifactRow {
  object_id: string; content_digest: string; envelope_digest: string;
  plaintext_bytes: number; chunk_count: number; state: string;
}
interface WrappedKey { keyReference: string; [key: string]: JsonValue }
interface EnvelopeRecord {
  [key: string]: JsonValue | undefined;
  type: string; schemaVersion?: string; algorithm?: string; envelopeId?: string;
  noncePrefix?: string; wrappedKey?: JsonValue; headerDigest?: string;
  index?: number; previousFrameDigest?: string; plaintextBytes?: number;
  nonce?: string; ciphertext?: string; authTag?: string;
}
interface EnvelopeHeader extends EnvelopeRecord {
  type: "header"; envelopeId: string; noncePrefix: string; mediaType: string;
  wrappedKey: WrappedKey; headerDigest: string;
}
type RecoveredCustodyRow = CustodyRow & { header?: EnvelopeHeader };
interface RecordCapture { handle: FileHandle; byteCount: number; maxBytes: number }
interface KeyBroker { wrapKey(key: Buffer, envelopeId: string): Promise<WrappedKey>; unwrapKey(wrappedKey: WrappedKey, envelopeId: string): Promise<Buffer> }
interface CustodyFaultInjector { afterChunkPrepared?(input: Record<string, unknown>): Promise<void> | void }
interface CustodyAuthorization {
  allowed?: boolean; revoked?: boolean; evidenceRef?: string; proofRef?: string;
  currentPolicyRevision?: unknown; currentGrantRevision?: unknown; decisionRef?: unknown;
}
interface AuthorizationReceipt { policyRevision?: unknown; grantRevision?: unknown; decisionRef?: unknown }
type GovernedExecutionReceipt = Parameters<typeof assertConsumedGovernedExecutionPermit>[0];
interface CustodyIdentityInput { custodyRef?: string; owner?: CustodyOwnerInput }
interface CustodyAppendInput extends CustodyIdentityInput { offset?: number; bytes?: Buffer | string; signal?: AbortSignal }
interface CustodyReadInput extends CustodyIdentityInput {
  contentDigest?: string; envelopeDigest?: string; byteCount?: number; resourceRef?: string;
  authorizationReceipt?: AuthorizationReceipt; governedExecutionReceipt?: GovernedExecutionReceipt; maxBytes?: number; signal?: AbortSignal;
}
interface DecryptInput { encryptedStream: Readable; expectedEnvelopeId: string; expectedEnvelopeByteCount: number; expectedByteCount: number; expectedContentDigest: string; expectedEnvelopeDigest: string; maxBytes: number; signal?: AbortSignal }

function isEnvelopeRecord(value: unknown): value is EnvelopeRecord {
  return isObjectRecord(value) && typeof value.type === "string";
}

function isChunkRecord(record: EnvelopeRecord): record is EnvelopeRecord & { type: "chunk"; index: number; previousFrameDigest: string; plaintextBytes: number } {
  return record.type === "chunk" && Number.isSafeInteger(record.plaintextBytes);
}

function envelopeRecordDigest(record: Record<string, JsonValue | undefined>): string {
  return hashHex(Buffer.from(JSON.stringify(record), "utf8"));
}

function envelopeHeaderBinding(header: EnvelopeHeader) {
  return {
    type: "header", schemaVersion: header.schemaVersion, envelopeId: header.envelopeId,
    algorithm: header.algorithm, mediaType: header.mediaType, noncePrefix: header.noncePrefix,
    wrappedKey: header.wrappedKey
  };
}

const MAX_UPLOAD_CUSTODY_BYTES = 512 * 1024 * 1024;
const MAX_UPLOAD_CUSTODY_ENVELOPE_BYTES =
  MAX_UPLOAD_CUSTODY_BYTES * 2 + 1024 * 1024;
const READ_AUDIENCE = "upload-custody-read";
const ZERO_DIGEST = "0".repeat(64);
const REQUEST_SCHEMA = "v0.0.1:upload:no-run-custody-request-1";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function fail(code: string, message: string, details: Record<string, unknown> | null = null, cause: unknown = null) {
  const error = new Error(message, cause ? { cause } : undefined) as CodedError;
  error.code = code;
  if (details && typeof details === "object") {
    for (const [key, value] of Object.entries(details)) error[key] = value;
  }
  return error;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedText(value: unknown, label: string, max = 512) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > max || normalized.includes("\0")) {
    throw new TypeError(`${label} must be a bounded non-empty string.`);
  }
  return normalized;
}

function normalizeDigest(value: unknown, label: string) {
  const normalized = boundedText(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new TypeError(`${label} must be a SHA-256 digest.`);
  }
  return normalized;
}

function normalizeByteCount(value: unknown, label: string, maximum = MAX_UPLOAD_CUSTODY_BYTES) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > maximum) {
    throw new TypeError(`${label} must be a bounded non-negative safe integer.`);
  }
  return normalized;
}

function normalizeFileIndex(value: unknown) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 255) {
    throw new TypeError("fileIndex must be a bounded non-negative safe integer.");
  }
  return normalized;
}

function normalizeOwner(owner: CustodyOwnerInput = {}) {
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
    throw new TypeError("Upload custody owner binding is required.");
  }
  const subjectId = boundedText(
    owner.subjectId || owner.ownerSubjectId || owner.userId,
    "owner.subjectId",
    256
  );
  const userId = boundedText(
    owner.userId || owner.ownerUserId || subjectId,
    "owner.userId",
    256
  );
  const tenantId = boundedText(
    owner.tenantId || owner.ownerTenantId || owner.tenant,
    "owner.tenantId",
    256
  );
  return Object.freeze({ subjectId, tenantId, userId });
}

function ownerBindingDigest(owner?: CustodyOwnerInput) {
  return hashHex(Buffer.from(canonicalJson(normalizeOwner(owner)), "utf8"));
}

function resourceReference(sessionId: string, fileIndex: number) {
  return `upload-resource:${sessionId}:${fileIndex}`;
}

function resourceBindingDigest(resourceRef: string) {
  return hashHex(Buffer.from(boundedText(resourceRef, "resourceRef", 768), "utf8"));
}

function normalizeBeginInput(input: CustodyBeginInput = {}) {
  const sessionId = boundedText(input.sessionId, "sessionId", 512);
  const fileIndex = normalizeFileIndex(input.fileIndex);
  const expectedContentDigest = normalizeDigest(input.expectedSha256, "expectedSha256");
  const expectedByteSize = normalizeByteCount(input.expectedByteSize, "expectedByteSize");
  const ownerDigest = ownerBindingDigest(input.owner);
  const resourceRef = resourceReference(sessionId, fileIndex);
  const resourceDigest = resourceBindingDigest(resourceRef);
  const idempotencyKey = boundedText(input.idempotencyKey, "idempotencyKey", 512);
  const idempotencyDigest = hashHex(Buffer.from(canonicalJson({
    schemaVersion: REQUEST_SCHEMA,
    sessionId,
    fileIndex,
    expectedContentDigest,
    expectedByteSize,
    ownerBindingDigest: ownerDigest,
    resourceBindingDigest: resourceDigest,
    idempotencyKey
  }), "utf8"));
  const custodyRef = `custody:upload_${idempotencyDigest.slice(0, 48)}`;
  return Object.freeze({
    custodyRef,
    expectedByteSize,
    expectedContentDigest,
    fileIndex,
    idempotencyDigest,
    ownerBindingDigest: ownerDigest,
    resourceBindingDigest: resourceDigest,
    resourceRef,
    sessionId
  });
}

function validateHeader(header: EnvelopeRecord | null, envelopeId = ""): EnvelopeHeader {
  if (
    !header ||
    header.type !== "header" ||
    header.schemaVersion !== SANDBOX_CUSTODY_ENVELOPE_SCHEMA ||
    header.algorithm !== CONTENT_ALGORITHM ||
    (envelopeId && header.envelopeId !== envelopeId) ||
    Buffer.from(String(header.noncePrefix || ""), "base64").length !== 8 ||
    !isObjectRecord(header.wrappedKey) ||
    typeof header.wrappedKey.keyReference !== "string"
  ) {
    throw fail("upload_custody_envelope_invalid", "Upload custody envelope is invalid.");
  }
  const expectedHeaderDigest = hashHex(
    Buffer.from(JSON.stringify(envelopeHeaderBinding(header as EnvelopeHeader)), "utf8")
  );
  if (!timingSafeDigest(expectedHeaderDigest, header.headerDigest)) {
    throw fail("upload_custody_envelope_invalid", "Upload custody envelope is invalid.");
  }
  return header as EnvelopeHeader;
}

function jsonLine(value: JsonValue) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

async function writeAll(handle: FileHandle, bytes: Buffer, position: number | null = null) {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(
      bytes,
      written,
      bytes.length - written,
      position === null ? null : position + written
    );
    if (result.bytesWritten <= 0) {
      throw fail("upload_custody_write_stalled", "Upload custody write made no forward progress.");
    }
    written += result.bytesWritten;
  }
}

async function syncDirectory(directoryPath: string) {
  let handle = null;
  try {
    handle = await fs.open(directoryPath, fsNative.constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const unsupported =
      process.platform === "win32" &&
      ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(String(errorProperty(error, "code")));
    if (!unsupported) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function ensurePrivateDirectory(directoryPath: string) {
  await fs.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw fail("upload_custody_directory_unsafe", "Upload custody directory is unsafe.");
  }
  if (process.platform !== "win32") await fs.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
}

async function ensureCustodyRoots(rootPath: string, pendingRoot: string) {
  const custodyRoot = path.dirname(pendingRoot);
  await ensurePrivateDirectory(custodyRoot);
  await ensurePrivateDirectory(pendingRoot);
  const relative = path.relative(rootPath, pendingRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw fail("upload_custody_directory_unsafe", "Upload custody directory is unsafe.");
  }
}

async function openPrivatePendingFile(filePath: string, flags: number) {
  const openFlags = flags | (fsNative.constants.O_NOFOLLOW || 0);
  let handle = null;
  try {
    handle = await fs.open(filePath, openFlags);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) {
      throw fail("upload_custody_file_unsafe", "Upload custody file is unsafe.");
    }
    if (Number(stat.nlink) !== 1) {
      throw fail("upload_custody_file_aliased", "Upload custody file has an unsafe alias.");
    }
    if (process.platform !== "win32" && Number(stat.mode & 0o777n) !== PRIVATE_FILE_MODE) {
      throw fail("upload_custody_mode_unsafe", "Upload custody file mode is unsafe.");
    }
    return { handle, stat };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (String(errorProperty(error, "code") || "").startsWith("upload_custody_")) throw error;
    throw fail("upload_custody_file_unsafe", "Upload custody file is unsafe.", null, error);
  }
}

async function *jsonRecords(stream: Readable, rawHash: Hash | null = null, capture: RecordCapture | null = null): AsyncGenerator<{ endOffset: number; record: EnvelopeRecord }, void, void> {
  let pending = Buffer.alloc(0);
  let consumed = 0;
  for await (const input of stream) {
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
    rawHash?.update(chunk);
    if (capture) {
      const nextCapturedBytes = capture.byteCount + chunk.length;
      if (nextCapturedBytes > capture.maxBytes) {
        throw fail(
          "upload_custody_envelope_invalid",
          "Upload custody envelope is invalid."
        );
      }
      await writeAll(capture.handle, chunk, capture.byteCount);
      capture.byteCount = nextCapturedBytes;
    }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (true) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      const raw = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      consumed += newline + 1;
      if (raw.length === 0 || raw.length > 256 * 1024) {
        throw fail("upload_custody_envelope_invalid", "Upload custody envelope is invalid.");
      }
      let record: unknown;
      try {
        record = JSON.parse(raw.toString("utf8"));
      } catch (error) {
        throw fail(
          "upload_custody_envelope_invalid",
          "Upload custody envelope is invalid.",
          null,
          error
        );
      }
      if (!isEnvelopeRecord(record)) {
        throw fail("upload_custody_envelope_invalid", "Upload custody envelope is invalid.");
      }
      yield { endOffset: consumed, record };
    }
  }
  if (pending.length !== 0) {
    throw fail("upload_custody_envelope_invalid", "Upload custody envelope is incomplete.");
  }
}

function statusFromRow(row: CustodyRow | null, { replayed }: { replayed?: boolean } = {}) {
  if (!row) throw fail("upload_custody_missing", "Upload custody object is unavailable.");
  const sealed = row.state === "sealed";
  return Object.freeze({
    custodyRef: row.custody_ref,
    nextOffset: Number(row.committed_plaintext_bytes),
    committedChunkCount: Number(row.committed_frame_count),
    committedEnvelopeDigest: String(row.committed_ciphertext_digest || ""),
    ...(sealed
      ? {
          byteCount: Number(row.expected_byte_size),
          contentDigest: String(row.expected_content_digest),
          envelopeDigest: String(row.sealed_envelope_digest || ""),
          state: "sealed_no_run"
        }
      : { state: "staging_no_run" }),
    ...(replayed === undefined ? {} : { replayed })
  });
}

function rowForCustody(db: Database.Database, custodyRef: string): CustodyRow | null {
  return db.prepare(`
    SELECT custody_ref, idempotency_digest, expected_content_digest,
           expected_byte_size, owner_binding_digest, resource_binding_digest,
           state, envelope_id, pending_identity, committed_plaintext_bytes,
           committed_frame_count, committed_ciphertext_digest,
           prepared_plaintext_bytes, prepared_frame_count,
           prepared_ciphertext_digest, sealed_object_id,
           sealed_envelope_digest, created_at, updated_at
    FROM upload_no_run_custody_staging
    WHERE custody_ref = ?
    LIMIT 1
  `).get(custodyRef) as CustodyRow | undefined || null;
}

function rowForResource(db: Database.Database, resourceDigest: string): CustodyRow | null {
  return db.prepare(`
    SELECT custody_ref, idempotency_digest, expected_content_digest,
           expected_byte_size, owner_binding_digest, resource_binding_digest,
           state, envelope_id, pending_identity, committed_plaintext_bytes,
           committed_frame_count, committed_ciphertext_digest,
           prepared_plaintext_bytes, prepared_frame_count,
           prepared_ciphertext_digest, sealed_object_id,
           sealed_envelope_digest, created_at, updated_at
    FROM upload_no_run_custody_staging
    WHERE resource_binding_digest = ?
    LIMIT 1
  `).get(resourceDigest) as CustodyRow | undefined || null;
}

function assertOwner(row: CustodyRow, owner?: CustodyOwnerInput) {
  if (row.owner_binding_digest !== ownerBindingDigest(owner)) {
    throw fail("upload_custody_owner_mismatch", "Upload custody object is unavailable.");
  }
}

function assertAbort(signal?: AbortSignal | null) {
  if (signal?.aborted) {
    throw fail("upload_custody_read_aborted", "Upload custody read was aborted.");
  }
}

export function createUploadNoRunCustody({
  userDataPath,
  storageKernel,
  storageProvider,
  keyBroker,
  reauthorizeCustodyRead,
  faultInjector = null
}: {
  userDataPath: string; storageKernel: StorageKernel; storageProvider: StorageProvider;
  keyBroker: KeyBroker;
  reauthorizeCustodyRead(input: Record<string, unknown>): Promise<CustodyAuthorization>;
  faultInjector?: CustodyFaultInjector | null;
}) {
  const rootPath = path.resolve(String(userDataPath || ""));
  if (!String(userDataPath || "").trim()) {
    throw new TypeError("Upload no-run custody requires userDataPath.");
  }
  if (!storageKernel?.db) {
    throw new TypeError("Upload no-run custody requires the core storage kernel.");
  }
  if (
    !storageProvider?.putObjectsFromFiles ||
    !storageProvider?.openPrivateNoExecObjectReadStream
  ) {
    throw new TypeError("Upload no-run custody requires the core storage provider.");
  }
  if (!keyBroker?.wrapKey || !keyBroker?.unwrapKey) {
    throw new TypeError("Upload no-run custody requires a custody key broker.");
  }
  if (typeof reauthorizeCustodyRead !== "function") {
    throw new TypeError("Upload no-run custody requires a final-boundary read authority.");
  }
  const db = storageKernel.db;
  const pendingRoot = path.join(rootPath, "upload-custody", "pending");
  const authenticatedReplayRoot = path.join(
    rootPath,
    "upload-custody",
    "authenticated-replays"
  );
  const custodyMutations = new Map<string, Promise<void>>();

  async function withCustodyMutation<T>(custodyRef: string, mutation: () => Promise<T>): Promise<T> {
    const previous = custodyMutations.get(custodyRef) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    custodyMutations.set(custodyRef, current);
    await previous.catch(() => {});
    try {
      return await mutation();
    } finally {
      release();
      if (custodyMutations.get(custodyRef) === current) {
        custodyMutations.delete(custodyRef);
      }
    }
  }

  function pendingPath(rowOrIdentity: CustodyRow | string) {
    const identity = typeof rowOrIdentity === "string"
      ? rowOrIdentity
      : rowOrIdentity.pending_identity;
    if (!/^[a-f0-9]{64}$/u.test(String(identity || ""))) {
      throw fail("upload_custody_state_corrupt", "Upload custody state is invalid.");
    }
    return path.join(pendingRoot, `${identity}.custody`);
  }

  async function openAuthenticatedEnvelopeReplay() {
    await ensureCustodyRoots(rootPath, pendingRoot);
    await ensurePrivateDirectory(authenticatedReplayRoot);
    const relative = path.relative(rootPath, authenticatedReplayRoot);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw fail("upload_custody_directory_unsafe", "Upload custody directory is unsafe.");
    }
    const replayPath = path.join(
      authenticatedReplayRoot,
      `${crypto.randomUUID()}.encrypted-replay`
    );
    let handle = null;
    try {
      handle = await fs.open(
        replayPath,
        fsNative.constants.O_RDWR |
          fsNative.constants.O_CREAT |
          fsNative.constants.O_EXCL |
          (fsNative.constants.O_NOFOLLOW || 0),
        PRIVATE_FILE_MODE
      );
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || Number(stat.nlink) !== 1) {
        throw fail("upload_custody_file_unsafe", "Upload custody file is unsafe.");
      }
      if (
        process.platform !== "win32" &&
        Number(stat.mode & 0o777n) !== PRIVATE_FILE_MODE
      ) {
        throw fail("upload_custody_mode_unsafe", "Upload custody file mode is unsafe.");
      }
      let linked = true;
      try {
        await fs.unlink(replayPath);
        linked = false;
      } catch (error) {
        const ciphertextReplayMayRemainLinked =
          process.platform === "win32" &&
          ["EACCES", "EBUSY", "EPERM"].includes(String(errorProperty(error, "code")));
        if (!ciphertextReplayMayRemainLinked) throw error;
      }
      return { handle, linked, replayPath };
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.rm(replayPath, { force: true }).catch(() => {});
      if (String(errorProperty(error, "code") || "").startsWith("upload_custody_")) throw error;
      throw fail(
        "upload_custody_replay_unavailable",
        "Upload custody authenticated replay is unavailable.",
        null,
        error
      );
    }
  }

  async function recoverStaging(row: CustodyRow): Promise<RecoveredCustodyRow> {
    if (!row) throw fail("upload_custody_missing", "Upload custody object is unavailable.");
    if (row.state === "sealed") return row;
    await ensureCustodyRoots(rootPath, pendingRoot);
    const { handle } = await openPrivatePendingFile(
      pendingPath(row),
      fsNative.constants.O_RDWR
    );
    let header: EnvelopeHeader | null = null;
    let committedEnd = 0;
    let committedCount = 0;
    let committedDigest = "";
    try {
      let pending = Buffer.alloc(0);
      let readPosition = 0;
      const readBuffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let complete = false;
      while (!complete) {
        const { bytesRead } = await handle.read(
          readBuffer,
          0,
          readBuffer.length,
          readPosition
        );
        if (bytesRead === 0) break;
        readPosition += bytesRead;
        const chunk = readBuffer.subarray(0, bytesRead);
        pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
        while (true) {
          const newline = pending.indexOf(0x0a);
          if (newline < 0) break;
          const raw = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          committedEnd += newline + 1;
          let record: unknown;
          try {
            record = JSON.parse(raw.toString("utf8"));
          } catch (error) {
            throw fail(
              "upload_custody_state_corrupt",
              "Upload custody state is invalid.",
              null,
              error
            );
          }
          if (!isEnvelopeRecord(record)) {
            throw fail("upload_custody_state_corrupt", "Upload custody state is invalid.");
          }
          const envelopeRecord = record;
          if (!header) {
            header = validateHeader(envelopeRecord, row.envelope_id);
            committedDigest = ZERO_DIGEST;
            if (Number(row.committed_frame_count) === 0) {
              complete = true;
              break;
            }
            continue;
          }
          if (
            envelopeRecord.type !== "chunk" ||
            envelopeRecord.index !== committedCount ||
            envelopeRecord.previousFrameDigest !== committedDigest ||
            !Number.isSafeInteger(envelopeRecord.plaintextBytes) ||
            Number(envelopeRecord.plaintextBytes) < 1 ||
            Number(envelopeRecord.plaintextBytes) > CHUNK_BYTES
          ) {
            throw fail("upload_custody_state_corrupt", "Upload custody state is invalid.");
          }
          committedDigest = envelopeRecordDigest(envelopeRecord);
          committedCount += 1;
          if (committedCount === Number(row.committed_frame_count)) {
            complete = true;
            break;
          }
        }
      }
      if (
        !header ||
        committedCount !== Number(row.committed_frame_count) ||
        committedDigest !== row.committed_ciphertext_digest
      ) {
        throw fail("upload_custody_state_corrupt", "Upload custody state is invalid.");
      }
      await handle.truncate(committedEnd);
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    if (
      row.prepared_plaintext_bytes !== null ||
      row.prepared_frame_count !== null ||
      row.prepared_ciphertext_digest !== null
    ) {
      db.prepare(`
        UPDATE upload_no_run_custody_staging
        SET prepared_plaintext_bytes = NULL,
            prepared_frame_count = NULL,
            prepared_ciphertext_digest = NULL,
            updated_at = ?
        WHERE custody_ref = ? AND state = 'staging'
      `).run(new Date().toISOString(), row.custody_ref);
    }
    const recovered = rowForCustody(db, row.custody_ref);
    if (!recovered || recovered.state !== "staging" || !header) {
      throw fail("upload_custody_state_corrupt", "Upload custody state is invalid.");
    }
    return { ...recovered, header };
  }

  async function beginLocked(input: CustodyBeginInput = {}) {
    const normalized = normalizeBeginInput(input);
    const current = rowForResource(db, normalized.resourceBindingDigest);
    if (current) {
      if (
        current.custody_ref !== normalized.custodyRef ||
        current.idempotency_digest !== normalized.idempotencyDigest ||
        current.expected_content_digest !== normalized.expectedContentDigest ||
        Number(current.expected_byte_size) !== normalized.expectedByteSize ||
        current.owner_binding_digest !== normalized.ownerBindingDigest
      ) {
        throw fail(
          "upload_custody_idempotency_conflict",
          "Upload custody idempotency binding conflicts."
        );
      }
      const recovered = await recoverStaging(current);
      return statusFromRow(recovered, { replayed: true });
    }

    await ensureCustodyRoots(rootPath, pendingRoot);
    const envelopeId = `env_${crypto.randomUUID()}`;
    const pendingIdentity = hashHex(
      Buffer.from(`upload-custody\0${normalized.custodyRef}`, "utf8")
    );
    const dataKey = crypto.randomBytes(32);
    let handle = null;
    try {
      const wrappedKey = await keyBroker.wrapKey(dataKey, envelopeId);
      const headerBase = {
        type: "header",
        schemaVersion: SANDBOX_CUSTODY_ENVELOPE_SCHEMA,
        envelopeId,
        algorithm: CONTENT_ALGORITHM,
        mediaType: "application/octet-stream",
        noncePrefix: crypto.randomBytes(8).toString("base64"),
        wrappedKey
      };
      const headerDigest = hashHex(
        Buffer.from(JSON.stringify(headerBase), "utf8")
      );
      handle = await fs.open(
        pendingPath(pendingIdentity),
        fsNative.constants.O_WRONLY |
          fsNative.constants.O_CREAT |
          fsNative.constants.O_EXCL |
          (fsNative.constants.O_NOFOLLOW || 0),
        PRIVATE_FILE_MODE
      );
      await writeAll(handle, jsonLine({ ...headerBase, headerDigest }), 0);
      await handle.sync();
      await handle.close();
      handle = null;
      await syncDirectory(pendingRoot);
      const timestamp = new Date().toISOString();
      db.prepare(`
        INSERT INTO upload_no_run_custody_staging (
          custody_ref, idempotency_digest, expected_content_digest,
          expected_byte_size, owner_binding_digest, resource_binding_digest,
          state, envelope_id, pending_identity, committed_plaintext_bytes,
          committed_frame_count, committed_ciphertext_digest,
          prepared_plaintext_bytes, prepared_frame_count,
          prepared_ciphertext_digest, sealed_object_id,
          sealed_envelope_digest, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'staging', ?, ?, 0, 0, ?,
                  NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        normalized.custodyRef,
        normalized.idempotencyDigest,
        normalized.expectedContentDigest,
        normalized.expectedByteSize,
        normalized.ownerBindingDigest,
        normalized.resourceBindingDigest,
        envelopeId,
        pendingIdentity,
        ZERO_DIGEST,
        timestamp,
        timestamp
      );
      return statusFromRow(rowForCustody(db, normalized.custodyRef), {
        replayed: false
      });
    } catch (error) {
      await handle?.close().catch(() => {});
      const raced = rowForResource(db, normalized.resourceBindingDigest);
      if (raced && raced.idempotency_digest === normalized.idempotencyDigest) {
        await fs.rm(pendingPath(pendingIdentity), { force: true }).catch(() => {});
        return statusFromRow(await recoverStaging(raced), { replayed: true });
      }
      await fs.rm(pendingPath(pendingIdentity), { force: true }).catch(() => {});
      throw error;
    } finally {
      dataKey.fill(0);
    }
  }

  async function appendLocked({
    custodyRef,
    owner,
    offset,
    bytes,
    signal
  }: CustodyAppendInput = {}) {
    if (signal?.aborted) {
      throw fail("upload_custody_append_aborted", "Upload custody append was aborted.");
    }
    const normalizedRef = normalizeCustodyHandle(custodyRef);
    let row = rowForCustody(db, normalizedRef);
    if (!row) throw fail("upload_custody_missing", "Upload custody object is unavailable.");
    assertOwner(row, owner);
    const recovered = await recoverStaging(row);
    if (recovered.state !== "staging") {
      throw fail("upload_custody_already_sealed", "Upload custody object is already sealed.");
    }
    row = recovered;
    const expectedOffset = Number(row.committed_plaintext_bytes);
    const requestedOffset = Number(offset);
    if (!Number.isSafeInteger(requestedOffset) || requestedOffset !== expectedOffset) {
      throw fail(
        "upload_custody_offset_mismatch",
        "Upload custody append offset does not match durable state.",
        { expectedOffset }
      );
    }
    const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || "");
    if (expectedOffset + input.length > Number(row.expected_byte_size)) {
      throw fail(
        "upload_custody_size_exceeded",
        "Upload custody append exceeds the declared byte size."
      );
    }
    if (input.length === 0) return statusFromRow(row);

    const header = recovered.header;
    if (!header) {
      throw fail("upload_custody_state_corrupt", "Upload custody state is invalid.");
    }
    const dataKey = await keyBroker.unwrapKey(header.wrappedKey, header.envelopeId);
    const { handle } = await openPrivatePendingFile(
      pendingPath(row),
      fsNative.constants.O_RDWR
    );
    let nextOffset = expectedOffset;
    let frameCount = Number(row.committed_frame_count);
    let previousFrameDigest = row.committed_ciphertext_digest;
    let filePosition = Number((await handle.stat()).size);
    try {
      for (let inputOffset = 0; inputOffset < input.length; inputOffset += CHUNK_BYTES) {
        if (signal?.aborted) {
          throw fail("upload_custody_append_aborted", "Upload custody append was aborted.");
        }
        const chunk = input.subarray(
          inputOffset,
          Math.min(input.length, inputOffset + CHUNK_BYTES)
        );
        const nonce = nonceFor(header.noncePrefix, frameCount);
        const cipher = crypto.createCipheriv(CONTENT_ALGORITHM, dataKey, nonce);
        cipher.setAAD(
          chunkAad(
            header.headerDigest,
            frameCount,
            chunk.length,
            previousFrameDigest
          )
        );
        const ciphertext = Buffer.concat([cipher.update(chunk), cipher.final()]);
        const frame = {
          type: "chunk",
          index: frameCount,
          plaintextBytes: chunk.length,
          previousFrameDigest,
          ciphertext: ciphertext.toString("base64"),
          tag: cipher.getAuthTag().toString("base64")
        };
        const preparedCiphertextDigest = envelopeRecordDigest(frame);
        const preparedOffset = nextOffset + chunk.length;
        const preparedFrameCount = frameCount + 1;
        const prepare = db.prepare(`
          UPDATE upload_no_run_custody_staging
          SET prepared_plaintext_bytes = ?,
              prepared_frame_count = ?,
              prepared_ciphertext_digest = ?,
              updated_at = ?
          WHERE custody_ref = ?
            AND state = 'staging'
            AND committed_plaintext_bytes = ?
            AND committed_frame_count = ?
            AND committed_ciphertext_digest = ?
            AND prepared_frame_count IS NULL
        `).run(
          preparedOffset,
          preparedFrameCount,
          preparedCiphertextDigest,
          new Date().toISOString(),
          row.custody_ref,
          nextOffset,
          frameCount,
          previousFrameDigest
        );
        if (prepare.changes !== 1) {
          throw fail(
            "upload_custody_offset_mismatch",
            "Upload custody append offset does not match durable state.",
            { expectedOffset: Number(rowForCustody(db, row.custody_ref)?.committed_plaintext_bytes || 0) }
          );
        }

        const encoded = jsonLine(frame);
        await writeAll(handle, encoded, filePosition);
        await handle.sync();
        await faultInjector?.afterChunkPrepared?.({
          custodyRef: row.custody_ref,
          expectedOffset: nextOffset,
          chunkByteCount: chunk.length,
          preparedCiphertextDigest
        });

        const commit = db.prepare(`
          UPDATE upload_no_run_custody_staging
          SET committed_plaintext_bytes = ?,
              committed_frame_count = ?,
              committed_ciphertext_digest = ?,
              prepared_plaintext_bytes = NULL,
              prepared_frame_count = NULL,
              prepared_ciphertext_digest = NULL,
              updated_at = ?
          WHERE custody_ref = ?
            AND state = 'staging'
            AND committed_plaintext_bytes = ?
            AND committed_frame_count = ?
            AND committed_ciphertext_digest = ?
            AND prepared_plaintext_bytes = ?
            AND prepared_frame_count = ?
            AND prepared_ciphertext_digest = ?
        `).run(
          preparedOffset,
          preparedFrameCount,
          preparedCiphertextDigest,
          new Date().toISOString(),
          row.custody_ref,
          nextOffset,
          frameCount,
          previousFrameDigest,
          preparedOffset,
          preparedFrameCount,
          preparedCiphertextDigest
        );
        if (commit.changes !== 1) {
          throw fail("upload_custody_state_conflict", "Upload custody state changed during append.");
        }
        filePosition += encoded.length;
        nextOffset = preparedOffset;
        frameCount = preparedFrameCount;
        previousFrameDigest = preparedCiphertextDigest;
      }
    } finally {
      dataKey.fill(0);
      await handle.close().catch(() => {});
    }
    row = rowForCustody(db, row.custody_ref);
    return statusFromRow(row);
  }

  async function verifyCommittedPlaintext(row: CustodyRow) {
    const { handle } = await openPrivatePendingFile(
      pendingPath(row),
      fsNative.constants.O_RDONLY
    );
    const stream = handle.createReadStream({
      highWaterMark: CHUNK_BYTES,
      start: 0
    });
    let header = null;
    let dataKey = null;
    let count = 0;
    let byteCount = 0;
    let previousFrameDigest = "";
    const contentHash = crypto.createHash("sha256");
    try {
      for await (const { record } of jsonRecords(stream)) {
        if (!header) {
          header = validateHeader(record, row.envelope_id);
          previousFrameDigest = ZERO_DIGEST;
          dataKey = await keyBroker.unwrapKey(header.wrappedKey, header.envelopeId);
          continue;
        }
        if (
          !isChunkRecord(record) ||
          record.index !== count ||
          record.previousFrameDigest !== previousFrameDigest ||
          record.plaintextBytes < 1 ||
          record.plaintextBytes > CHUNK_BYTES
        ) {
          throw fail("upload_custody_envelope_invalid", "Upload custody envelope is invalid.");
        }
        if (!dataKey) {
          throw fail("upload_custody_envelope_invalid", "Upload custody envelope is invalid.");
        }
        const decipher = crypto.createDecipheriv(
          CONTENT_ALGORITHM,
          dataKey,
          nonceFor(header.noncePrefix, count)
        );
        decipher.setAAD(
          chunkAad(
            header.headerDigest,
            count,
            record.plaintextBytes,
            previousFrameDigest
          )
        );
        decipher.setAuthTag(Buffer.from(String(record.tag || ""), "base64"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(String(record.ciphertext || ""), "base64")),
          decipher.final()
        ]);
        if (plaintext.length !== record.plaintextBytes) {
          plaintext.fill(0);
          throw fail("upload_custody_envelope_invalid", "Upload custody envelope is invalid.");
        }
        contentHash.update(plaintext);
        byteCount += plaintext.length;
        plaintext.fill(0);
        previousFrameDigest = envelopeRecordDigest(record);
        count += 1;
      }
      const contentDigest = contentHash.digest("hex");
      if (
        !header ||
        !dataKey ||
        count !== Number(row.committed_frame_count) ||
        byteCount !== Number(row.committed_plaintext_bytes) ||
        previousFrameDigest !== row.committed_ciphertext_digest
      ) {
        throw fail("upload_custody_envelope_invalid", "Upload custody envelope is invalid.");
      }
      return { byteCount, contentDigest, dataKey, header };
    } catch (error) {
      dataKey?.fill(0);
      throw error;
    } finally {
      stream.destroy();
      await handle.close().catch(() => {});
    }
  }

  async function sealLocked({ custodyRef, owner }: CustodyIdentityInput = {}) {    const normalizedRef = normalizeCustodyHandle(custodyRef);
    let row = rowForCustody(db, normalizedRef);
    if (!row) throw fail("upload_custody_missing", "Upload custody object is unavailable.");
    assertOwner(row, owner);
    if (row.state === "sealed") return statusFromRow(row, { replayed: true });
    row = await recoverStaging(row);
    if (Number(row.committed_plaintext_bytes) !== Number(row.expected_byte_size)) {
      throw fail(
        "upload_custody_incomplete",
        "Upload custody object has not received its declared byte size."
      );
    }
    const verified = await verifyCommittedPlaintext(row);
    try {
      if (!timingSafeDigest(verified.contentDigest, row.expected_content_digest)) {
        throw fail(
          "upload_custody_content_digest_mismatch",
          "Upload custody content digest does not match its declaration."
        );
      }
      const footerPayload = {
        type: "footer",
        contentDigest: verified.contentDigest,
        byteCount: verified.byteCount,
        chunkCount: Number(row.committed_frame_count),
        finalFrameDigest: row.committed_ciphertext_digest,
        mediaTypeDigest: hashHex(
          Buffer.from(verified.header.mediaType, "utf8")
        )
      };
      const footerMac = crypto
        .createHmac("sha256", verified.dataKey)
        .update(JSON.stringify(footerPayload))
        .digest("hex");
      const { handle } = await openPrivatePendingFile(
        pendingPath(row),
        fsNative.constants.O_RDWR
      );
      try {
        const position = Number((await handle.stat()).size);
        await writeAll(handle, jsonLine({ ...footerPayload, footerMac }), position);
        await handle.sync();
      } finally {
        await handle.close().catch(() => {});
      }

      const objectId = row.custody_ref.slice("custody:".length);
      const [stored] = await storageProvider.putObjectsFromFiles([{
        sourcePath: pendingPath(row),
        namespace: "execution-sandbox-custody",
        fileName: "opaque-envelope.custody",
        mediaType: "application/vnd.meshrix.opaque-custody",
        objectId,
        metadata: {
          artifactKind: "upload-no-run-custody"
        }
      }]);
      const timestamp = new Date().toISOString();
      const commit = db.transaction(() => {
        const existing = db.prepare(`
          SELECT custody_ref, object_id, content_digest, envelope_digest,
                 plaintext_bytes, chunk_count, state
          FROM opaque_custody_artifacts
          WHERE custody_ref = ?
          LIMIT 1
        `).get(row.custody_ref) as SealedArtifactRow | undefined;
        if (existing) {
          if (
            existing.object_id !== stored.objectId ||
            existing.content_digest !== row.expected_content_digest ||
            existing.envelope_digest !== stored.sha256 ||
            Number(existing.plaintext_bytes) !== Number(row.expected_byte_size) ||
            Number(existing.chunk_count) !== Number(row.committed_frame_count) ||
            existing.state !== "sealed"
          ) {
            throw fail(
              "upload_custody_state_conflict",
              "Upload custody sealed state conflicts with durable storage."
            );
          }
        } else {
          db.prepare(`
            INSERT INTO opaque_custody_artifacts (
              custody_ref, object_id, seal_idempotency_key,
              seal_request_digest, content_digest, envelope_digest,
              plaintext_bytes, ciphertext_bytes, chunk_count, media_type,
              owner_subject_ref, tenant_ref, workspace_ref, key_ref,
              state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sealed', ?, ?)
          `).run(
            row.custody_ref,
            stored.objectId,
            row.idempotency_digest,
            row.idempotency_digest,
            row.expected_content_digest,
            stored.sha256,
            Number(row.expected_byte_size),
            Number(stored.byteSize),
            Number(row.committed_frame_count),
            "application/octet-stream",
            row.owner_binding_digest,
            row.resource_binding_digest,
            row.resource_binding_digest,
            verified.header.wrappedKey.keyReference,
            timestamp,
            timestamp
          );
        }
        db.prepare(`
          UPDATE upload_no_run_custody_staging
          SET state = 'sealed',
              sealed_object_id = ?,
              sealed_envelope_digest = ?,
              updated_at = ?
          WHERE custody_ref = ? AND state = 'staging'
        `).run(stored.objectId, stored.sha256, timestamp, row.custody_ref);
      });
      commit();
      await fs.rm(pendingPath(row), { force: true });
      await syncDirectory(pendingRoot);
      return statusFromRow(rowForCustody(db, row.custody_ref), {
        replayed: false
      });
    } finally {
      verified.dataKey.fill(0);
    }
  }

  async function describeLocked({ custodyRef, owner }: CustodyIdentityInput = {}) {
    const normalizedRef = normalizeCustodyHandle(custodyRef);
    let row = rowForCustody(db, normalizedRef);
    if (!row) throw fail("upload_custody_missing", "Upload custody object is unavailable.");
    assertOwner(row, owner);
    row = await recoverStaging(row);
    return statusFromRow(row);
  }

  function sealedObject(custodyRef: string): SealedCustodyObject | null {
    return db.prepare(`
      SELECT staging.custody_ref, staging.expected_content_digest,
             staging.expected_byte_size, staging.owner_binding_digest,
             staging.resource_binding_digest, staging.envelope_id,
             staging.sealed_envelope_digest,
             custody.ciphertext_bytes AS envelope_byte_count,
             objects.storage_rel_path
      FROM upload_no_run_custody_staging AS staging
      JOIN opaque_custody_artifacts AS custody
        ON custody.custody_ref = staging.custody_ref
      JOIN storage_objects AS objects
        ON objects.object_id = custody.object_id
      WHERE staging.custody_ref = ?
        AND staging.state = 'sealed'
        AND custody.state = 'sealed'
      LIMIT 1
    `).get(custodyRef) as SealedCustodyObject | undefined || null;
  }

  async function *decryptReadStream({
    encryptedStream,
    expectedEnvelopeId,
    expectedEnvelopeByteCount,
    expectedByteCount,
    expectedContentDigest,
    expectedEnvelopeDigest,
    maxBytes,
    signal
  }: DecryptInput): AsyncGenerator<Buffer, void, void> {
    const envelopeByteCount = Number(expectedEnvelopeByteCount);
    if (
      !Number.isSafeInteger(envelopeByteCount) ||
      envelopeByteCount < 1 ||
      envelopeByteCount > MAX_UPLOAD_CUSTODY_ENVELOPE_BYTES
    ) {
      throw fail(
        "upload_custody_envelope_authentication_failed",
        "Upload custody envelope authentication failed."
      );
    }
    const rawHash = crypto.createHash("sha256");
    const contentHash = crypto.createHash("sha256");
    let header = null;
    let footer = null;
    let dataKey = null;
    let frameCount = 0;
    let byteCount = 0;
    let previousFrameDigest = "";
    let authenticatedReplay = null;
    let replayStream = null;
    try {
      authenticatedReplay = await openAuthenticatedEnvelopeReplay();
      const capture = {
        byteCount: 0,
        handle: authenticatedReplay.handle,
        maxBytes: envelopeByteCount
      };
      for await (const { record } of jsonRecords(
        encryptedStream,
        rawHash,
        capture
      )) {
        assertAbort(signal);
        if (!header) {
          header = validateHeader(record);
          previousFrameDigest = ZERO_DIGEST;
          dataKey = await keyBroker.unwrapKey(header.wrappedKey, header.envelopeId);
          continue;
        }
        if (record?.type === "footer") {
          if (footer) {
            throw fail("upload_custody_envelope_invalid", "Upload custody envelope is invalid.");
          }
          footer = record;
          continue;
        }
        if (
          footer ||
          !isChunkRecord(record) ||
          record.index !== frameCount ||
          record.previousFrameDigest !== previousFrameDigest ||
          record.plaintextBytes < 1 ||
          record.plaintextBytes > CHUNK_BYTES
        ) {
          throw fail("upload_custody_envelope_invalid", "Upload custody envelope is invalid.");
        }
        if (!dataKey) {
          throw fail("upload_custody_envelope_invalid", "Upload custody envelope is invalid.");
        }
        const decipher = crypto.createDecipheriv(
          CONTENT_ALGORITHM,
          dataKey,
          nonceFor(header.noncePrefix, frameCount)
        );
        decipher.setAAD(
          chunkAad(
            header.headerDigest,
            frameCount,
            record.plaintextBytes,
            previousFrameDigest
          )
        );
        decipher.setAuthTag(Buffer.from(String(record.tag || ""), "base64"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(String(record.ciphertext || ""), "base64")),
          decipher.final()
        ]);
        if (plaintext.length !== record.plaintextBytes) {
          plaintext.fill(0);
          throw fail("upload_custody_envelope_invalid", "Upload custody envelope is invalid.");
        }
        const nextByteCount = byteCount + plaintext.length;
        if (nextByteCount > maxBytes || nextByteCount > expectedByteCount) {
          plaintext.fill(0);
          throw fail(
            "upload_custody_read_limit_exceeded",
            "Upload custody read exceeds its byte budget."
          );
        }
        try {
          contentHash.update(plaintext);
        } finally {
          plaintext.fill(0);
        }
        byteCount = nextByteCount;
        previousFrameDigest = envelopeRecordDigest(record);
        frameCount += 1;
      }
      if (!header || !footer || footer.chunkCount !== frameCount) {
        throw fail("upload_custody_envelope_invalid", "Upload custody envelope is incomplete.");
      }
      dataKey ||= await keyBroker.unwrapKey(header.wrappedKey, header.envelopeId);
      const footerPayload = {
        type: "footer",
        contentDigest: footer.contentDigest,
        byteCount: footer.byteCount,
        chunkCount: footer.chunkCount,
        finalFrameDigest: footer.finalFrameDigest,
        mediaTypeDigest: footer.mediaTypeDigest
      };
      const expectedMac = crypto
        .createHmac("sha256", dataKey)
        .update(JSON.stringify(footerPayload))
        .digest("hex");
      const observedContentDigest = contentHash.digest("hex");
      const observedEnvelopeDigest = rawHash.digest("hex");
      if (
        capture.byteCount !== envelopeByteCount ||
        header.envelopeId !== expectedEnvelopeId ||
        byteCount !== expectedByteCount ||
        footer.byteCount !== expectedByteCount ||
        footer.contentDigest !== expectedContentDigest ||
        !timingSafeDigest(observedContentDigest, expectedContentDigest) ||
        footer.finalFrameDigest !== previousFrameDigest ||
        footer.mediaTypeDigest !== hashHex(Buffer.from(header.mediaType, "utf8")) ||
        !timingSafeDigest(expectedMac, footer.footerMac) ||
        !timingSafeDigest(observedEnvelopeDigest, expectedEnvelopeDigest)
      ) {
        throw fail(
          "upload_custody_envelope_authentication_failed",
          "Upload custody envelope authentication failed."
        );
      }

      replayStream = authenticatedReplay.handle.createReadStream({
        highWaterMark: CHUNK_BYTES,
        start: 0
      });
      let replayHeader = null;
      let replayFooter = null;
      let replayFrameCount = 0;
      let replayByteCount = 0;
      let replayPreviousFrameDigest = "";
      const authenticatedFooterDigest = hashHex(
        Buffer.from(JSON.stringify(footer), "utf8")
      );
      for await (const { record } of jsonRecords(replayStream)) {
        assertAbort(signal);
        if (
          !replayHeader
        ) {
          replayHeader = validateHeader(record, expectedEnvelopeId);
          if (!timingSafeDigest(replayHeader.headerDigest, header.headerDigest)) {
            throw fail(
              "upload_custody_envelope_authentication_failed",
              "Upload custody envelope authentication failed."
            );
          }
          replayPreviousFrameDigest = ZERO_DIGEST;
          continue;
        }
        if (record?.type === "footer") {
          if (
            replayFooter ||
            replayFrameCount !== frameCount ||
            !timingSafeDigest(
              hashHex(Buffer.from(JSON.stringify(record), "utf8")),
              authenticatedFooterDigest
            )
          ) {
            throw fail(
              "upload_custody_envelope_authentication_failed",
              "Upload custody envelope authentication failed."
            );
          }
          replayFooter = record;
          continue;
        }
        const observedFrameDigest = envelopeRecordDigest(record);
        if (
          replayFooter ||
          !isChunkRecord(record) ||
          record.index !== replayFrameCount ||
          record.previousFrameDigest !== replayPreviousFrameDigest ||
          record.plaintextBytes < 1 ||
          record.plaintextBytes > CHUNK_BYTES
        ) {
          throw fail(
            "upload_custody_envelope_authentication_failed",
            "Upload custody envelope authentication failed."
          );
        }
        const decipher = crypto.createDecipheriv(
          CONTENT_ALGORITHM,
          dataKey,
          nonceFor(replayHeader.noncePrefix, replayFrameCount)
        );
        decipher.setAAD(
          chunkAad(
            replayHeader.headerDigest,
            replayFrameCount,
            record.plaintextBytes,
            replayPreviousFrameDigest
          )
        );
        decipher.setAuthTag(Buffer.from(String(record.tag || ""), "base64"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(String(record.ciphertext || ""), "base64")),
          decipher.final()
        ]);
        if (
          plaintext.length !== record.plaintextBytes ||
          replayByteCount + plaintext.length > expectedByteCount
        ) {
          plaintext.fill(0);
          throw fail(
            "upload_custody_envelope_authentication_failed",
            "Upload custody envelope authentication failed."
          );
        }
        replayByteCount += plaintext.length;
        replayPreviousFrameDigest = observedFrameDigest;
        replayFrameCount += 1;
        try {
          yield plaintext;
        } finally {
          plaintext.fill(0);
        }
      }
      if (
        !replayHeader ||
        !replayFooter ||
        replayFrameCount !== frameCount ||
        replayByteCount !== expectedByteCount ||
        replayPreviousFrameDigest !== previousFrameDigest
      ) {
        throw fail(
          "upload_custody_envelope_authentication_failed",
          "Upload custody envelope authentication failed."
        );
      }
    } catch (error) {
      if (errorProperty(error, "code")) throw error;
      throw fail(
        "upload_custody_envelope_authentication_failed",
        "Upload custody envelope authentication failed.",
        null,
        error
      );
    } finally {
      dataKey?.fill(0);
      encryptedStream.destroy?.();
      replayStream?.destroy();
      await authenticatedReplay?.handle.close().catch(() => {});
      if (authenticatedReplay?.linked) {
        await fs.rm(authenticatedReplay.replayPath, { force: true }).catch(() => {});
      }
    }
  }

  async function open({
    custodyRef,
    contentDigest,
    envelopeDigest,
    byteCount,
    owner,
    resourceRef,
    authorizationReceipt,
    governedExecutionReceipt,
    maxBytes,
    signal
  }: CustodyReadInput = {}) {
    assertAbort(signal);
    const normalizedRef = normalizeCustodyHandle(custodyRef);
    const normalizedContentDigest = normalizeDigest(contentDigest, "contentDigest");
    const normalizedEnvelopeDigest = normalizeDigest(envelopeDigest, "envelopeDigest");
    const normalizedByteCount = normalizeByteCount(byteCount, "byteCount");
    const normalizedMaxBytes = normalizeByteCount(maxBytes, "maxBytes");
    if (normalizedMaxBytes < normalizedByteCount) {
      throw fail(
        "upload_custody_read_limit_exceeded",
        "Upload custody read exceeds its byte budget."
      );
    }
    const object = sealedObject(normalizedRef);
    const ownerDigest = ownerBindingDigest(owner);
    const normalizedResourceRef = boundedText(resourceRef, "resourceRef", 768);
    if (
      !object ||
      object.expected_content_digest !== normalizedContentDigest ||
      object.sealed_envelope_digest !== normalizedEnvelopeDigest ||
      Number(object.expected_byte_size) !== normalizedByteCount ||
      object.owner_binding_digest !== ownerDigest ||
      object.resource_binding_digest !== resourceBindingDigest(normalizedResourceRef)
    ) {
      throw fail("upload_custody_read_denied", "Upload custody read is denied.");
    }

    let evidenceRef = "";
    if (governedExecutionReceipt) {
      try {
        const receipt = assertConsumedGovernedExecutionPermit(
          governedExecutionReceipt,
          { audience: "upstream-structured-http-final-effect" }
        );
        evidenceRef = receipt.proofRef;
      } catch (error) {
        throw fail("upload_custody_read_denied", "Upload custody read is denied.", null, error);
      }
    } else {
      let authorization: CustodyAuthorization;
      try {
        authorization = await reauthorizeCustodyRead({
          authorizationReceipt,
          audience: READ_AUDIENCE,
          custodyRef: normalizedRef,
          contentDigest: normalizedContentDigest,
          envelopeDigest: normalizedEnvelopeDigest,
          byteCount: normalizedByteCount,
          ownerBindingDigest: ownerDigest,
          resourceRef: normalizedResourceRef
        });
      } catch (error) {
        assertAbort(signal);
        throw fail("upload_custody_read_denied", "Upload custody read is denied.", null, error);
      }
      assertAbort(signal);
      if (
        authorization?.allowed !== true ||
        authorization.revoked === true ||
        !String(authorization.evidenceRef || "").trim() ||
        authorization.currentPolicyRevision !== authorizationReceipt?.policyRevision ||
        authorization.currentGrantRevision !== authorizationReceipt?.grantRevision ||
        authorization.decisionRef !== authorizationReceipt?.decisionRef
      ) {
        throw fail("upload_custody_read_denied", "Upload custody read is denied.");
      }
      evidenceRef = String(authorization.evidenceRef);
    }

    const opened = await storageProvider.openPrivateNoExecObjectReadStream({
      storageRelativePath: object.storage_rel_path,
      signal
    });
    const stream = decryptReadStream({
      encryptedStream: opened.stream,
      expectedEnvelopeId: object.envelope_id,
      expectedEnvelopeByteCount: Number(object.envelope_byte_count),
      expectedByteCount: normalizedByteCount,
      expectedContentDigest: normalizedContentDigest,
      expectedEnvelopeDigest: normalizedEnvelopeDigest,
      maxBytes: normalizedMaxBytes,
      signal
    });
    return Object.freeze({
      receipt: Object.freeze({
        authorizationEvidenceRef: String(evidenceRef),
        byteCount: normalizedByteCount,
        contentDigest: normalizedContentDigest,
        custodyRef: normalizedRef,
        envelopeDigest: normalizedEnvelopeDigest,
        state: "authorized_custody_read"
      }),
      stream
    });
  }

  function begin(input: CustodyBeginInput = {}) {
    const custodyRef = normalizeBeginInput(input).custodyRef;
    return withCustodyMutation(custodyRef, () => beginLocked(input));
  }

  function append(input: CustodyAppendInput = {}) {
    const custodyRef = normalizeCustodyHandle(input.custodyRef);
    return withCustodyMutation(custodyRef, () => appendLocked(input));
  }

  function seal(input: CustodyIdentityInput = {}) {
    const custodyRef = normalizeCustodyHandle(input.custodyRef);
    return withCustodyMutation(custodyRef, () => sealLocked(input));
  }

  function describe(input: CustodyIdentityInput = {}) {
    const custodyRef = normalizeCustodyHandle(input.custodyRef);
    return withCustodyMutation(custodyRef, () => describeLocked(input));
  }

  const stagingPort = Object.freeze({ begin, append, seal });
  const readPort = Object.freeze({ open });
  return Object.freeze({ stagingPort, readPort, describe });
}
