import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  hashClientString,
  serverToken
} from "#meshrix/client-strings";
import { listStorageBackups } from "./backup-query.ts";
import { applyStorageBackupRetention } from "./backup-retention.ts";
import { createStorageBackup } from "./backup-snapshot.ts";
import { reconcileStorage, runStorageDoctor } from "./ops-tools.ts";
import {
  getObjectRootPath,
  openPrivateNoExecObjectReadStream,
  openStoredObjectReadStream,
  putStoredObject,
  putStoredObjectFromFile,
  recordStoredObject,
  readStoredObject,
  removeStoredObject,
  resolveStoredObjectPath,
  statStoredObject,
  verifyStoredObjectIntegrity
} from "./object-store.ts";
import { getStorageDatabasePath } from "./schema-manager.ts";
import { createServiceManifestStore } from "./service-manifest-store.ts";
import {
  assertGovernedObjectStorageCapabilities,
  GOVERNED_OBJECT_STORAGE_DISCIPLINE,
} from "./governed-object-storage.ts";
import { createManifestCandidateAuthorityPort } from "./storage-ports.ts";
import { restoreStorageBackup } from "./restore-execution.ts";
import { runStorageMaintenanceMutation } from "./storage-maintenance-coordinator.ts";
import type { StorageArtifactClassifier } from "./backup-contract.ts";
import type { StoredObjectRecord, StoredObjectReadStream } from "./object-store.ts";
import type { StorageKernel, StorageKernelSummary } from "./storage-kernel.ts";
import type { ServiceManifestStore } from "./service-manifest-store.ts";

type JsonRecord = Record<string, unknown>;
type SqliteValue = string | number | Buffer | null;
type StorageRow = Record<string, SqliteValue>;
type StorageDatabase = Database.Database;
type StorageError = Error & { code: string };

interface ReceiptOwner {
  tenantId: string;
  subjectId: string;
  userId: string;
  username: string;
}

interface NormalizedReceipt {
  sessionId: string;
  ownerKey: string;
  objects: readonly UploadConsumptionLogicalObject[];
  custodyDescriptors: readonly JsonRecord[];
  receiptDigest: string;
  receiptId: string;
}

interface UploadConsumptionReceipt {
  schemaVersion: string;
  receiptId: string;
  sessionId: string;
  ownerKey: string;
  objects: readonly UploadConsumptionLogicalObject[];
  receiptDigest: string;
}

interface StoredObjectProviderRecord extends StoredObjectRecord {
  fileName: string;
}

interface DeletionOperation {
  operationId: string;
  ownerId: string;
  jobId: string;
  status: string;
  state: JsonRecord;
  error: string;
  createdAt: string;
  updatedAt: string;
}

interface StorageProviderOptions {
  userDataPath?: string;
  storageKernel?: StorageKernel | null;
  artifactClassifiers?: unknown;
  serviceManifestStore?: ServiceManifestStore | null;
}

interface RestoreExecutionContext {
  assertActive(): void;
  consume(value: { files?: number; bytes?: number; cleanupItems?: number }): void;
}

function optionalSignal(value: unknown): AbortSignal | null | undefined {
  return value instanceof AbortSignal ? value : value === null ? null : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) || 0;
    return code <= 31 || code === 127;
  });
}

export interface StorageProvider {
  readonly protocolVersion: typeof STORAGE_PROTOCOL_VERSION;
  getStorageKernel(): StorageKernel | null;
  getStorageSummary(): StorageKernelSummary | JsonRecord;
  getUpgradePreflight(): unknown;
  getDurableManifestWriterPort(): unknown;
  getDurableManifestReaderPort(): unknown;
  getDurableManifestCandidateAuthorityPort(): unknown;
  getUploadConsumptionReceipt(receiptId: unknown): UploadConsumptionReceipt | null;
  commitUploadConsumptionReceipt(input?: JsonRecord): Promise<UploadConsumptionReceipt>;
  putObject(input?: JsonRecord): Promise<StoredObjectRecord>;
  putObjectsFromFiles(inputs?: readonly JsonRecord[]): Promise<readonly StoredObjectRecord[]>;
  getObject(objectId: unknown): StoredObjectProviderRecord | null;
  findObjectOwner(ownerId: unknown): JsonRecord | null;
  listObjectStoragePathsByOwner(ownerId: unknown): string[];
  getObjectOwnerArtifactPaths(): JsonRecord;
  deleteObjectRecordsByOwner(ownerId: unknown): number;
  getDeletionOperationByOwnerId(ownerId: unknown): DeletionOperation | null;
  upsertDeletionOperation(input?: JsonRecord): DeletionOperation | null;
  updateDeletionOperation(operationId: unknown, patch?: JsonRecord): DeletionOperation | null;
  deleteDeletionOperation(operationId: unknown): number;
  listPendingDeletionOperations(): DeletionOperation[];
  readObject(input?: JsonRecord): Promise<unknown>;
  openObjectReadStream(input?: JsonRecord): StoredObjectReadStream | Promise<StoredObjectReadStream>;
  openPrivateNoExecObjectReadStream(input?: JsonRecord): StoredObjectReadStream | Promise<StoredObjectReadStream>;
  statObject(input?: JsonRecord): Promise<unknown>;
  resolveStoredObjectPath(storageRelativePath: unknown): string;
  runDoctor(): Promise<unknown>;
  reconcile(input?: JsonRecord): Promise<unknown>;
  listBackups(): Promise<unknown>;
  createBackup(input?: JsonRecord): Promise<unknown>;
  restoreBackupPreview(input?: JsonRecord): Promise<unknown>;
  restoreBackup(input?: JsonRecord): Promise<unknown>;
  applyBackupRetention(input?: JsonRecord): Promise<unknown>;
  listCapabilities(): JsonRecord;
}

export const STORAGE_PROTOCOL_VERSION = "v0.0.1:storage:core-2";
export const UPLOAD_CONSUMPTION_RECEIPT_SCHEMA_VERSION =
  "v0.0.1:storage:upload-consumption-receipt-1";

const RECEIPT_OBJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const UPLOAD_SESSION_ID_PATTERN = /^upload_session_[a-f0-9]{32}$/u;
const UPLOAD_RECEIPT_ID_PATTERN =
  /^upload_consumption_receipt_[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type UploadConsumptionLogicalObject = Readonly<{
  objectId: string;
  sha256: string;
  byteSize: number;
}>;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeArtifactClassifiers(artifactClassifiers: unknown = []): StorageArtifactClassifier[] {
  return Array.isArray(artifactClassifiers)
    ? artifactClassifiers.filter((classifier): classifier is StorageArtifactClassifier => typeof classifier === "function")
    : [];
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function parseMetadata(value: unknown): JsonRecord {
  try {
    return record(JSON.parse(String(value || "{}")));
  } catch {
    return {};
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item): string => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key): string =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function uploadConsumptionError(code: string, message: string, cause: unknown = null): StorageError {
  const error = new Error(message, cause ? { cause } : undefined) as StorageError;
  error.code = code;
  return error;
}

function normalizeReceiptOwner(owner: JsonRecord = {}): ReceiptOwner {
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
    throw uploadConsumptionError(
      "upload_consumption_receipt_invalid",
      "Upload consumption receipt owner is invalid."
    );
  }
  const normalized: ReceiptOwner = {
    tenantId: String(owner.tenantId || "").trim(),
    subjectId: String(owner.subjectId || "").trim(),
    userId: String(owner.userId || owner.subjectId || "").trim(),
    username: String(owner.username || "").trim()
  };
  if (
    !normalized.subjectId ||
    Object.values(normalized).some(
      (value): boolean => value.length > 256 || hasControlCharacter(value)
    )
  ) {
    throw uploadConsumptionError(
      "upload_consumption_receipt_invalid",
      "Upload consumption receipt owner is required."
    );
  }
  return normalized;
}

function normalizeReceiptInput(input: JsonRecord = {}): NormalizedReceipt {
  const sessionId = String(input.sessionId || "").trim();
  if (!UPLOAD_SESSION_ID_PATTERN.test(sessionId)) {
    throw uploadConsumptionError(
      "upload_consumption_receipt_invalid",
      "Upload consumption receipt session identity is invalid."
    );
  }
  const owner = normalizeReceiptOwner(record(input.owner));
  const custodyDescriptors: JsonRecord[] = Array.isArray(input.custodyDescriptors)
    ? input.custodyDescriptors.map((descriptor): JsonRecord => record(descriptor))
    : [];
  if (
    Object.keys(input).sort().join(",") !==
      "custodyDescriptors,owner,sessionId" ||
    custodyDescriptors.length === 0 ||
    custodyDescriptors.length > 256
  ) {
    throw uploadConsumptionError(
      "upload_consumption_receipt_invalid",
      "Upload consumption receipt custody descriptor list is invalid."
    );
  }
  const seenObjectIds = new Set<string>();
  const objects: UploadConsumptionLogicalObject[] = custodyDescriptors.map((descriptor, index): UploadConsumptionLogicalObject => {
    const expectedKeys: readonly string[] = [
      "byteSize",
      "contentDigest",
      "custodyRef",
      "custodyState",
      "envelopeDigest",
      "resourceRef"
    ];
    const custodyRef = String(descriptor.custodyRef || "").trim();
    const objectId = custodyRef.startsWith("custody:")
      ? custodyRef.slice("custody:".length)
      : "";
    const sha256 = String(descriptor.contentDigest || "").trim().toLowerCase();
    const byteSize = Number(descriptor.byteSize);
    if (
      Object.keys(descriptor || {}).sort().join(",") !==
        expectedKeys.join(",") ||
      !RECEIPT_OBJECT_ID_PATTERN.test(objectId) ||
      seenObjectIds.has(objectId) ||
      !SHA256_PATTERN.test(sha256) ||
      !SHA256_PATTERN.test(String(descriptor.envelopeDigest || "")) ||
      descriptor.custodyState !== "sealed_no_run" ||
      descriptor.resourceRef !== `upload-resource:${sessionId}:${index}` ||
      !Number.isSafeInteger(byteSize) ||
      byteSize < 0
    ) {
      throw uploadConsumptionError(
        "upload_consumption_receipt_invalid",
        "Upload consumption receipt object metadata is invalid."
      );
    }
    seenObjectIds.add(objectId);
    return Object.freeze({ objectId, sha256, byteSize });
  });
  const ownerKey = hashClientString(
    JSON.stringify(owner),
    "upload.session.owner"
  );
  const receiptDigest = createHash("sha256")
    .update(canonicalJson({
      schemaVersion: UPLOAD_CONSUMPTION_RECEIPT_SCHEMA_VERSION,
      sessionId,
      ownerKey,
      objects
    }), "utf8")
    .digest("hex");
  return {
    sessionId,
    ownerKey,
    objects,
    custodyDescriptors,
    receiptDigest,
    receiptId: serverToken("upload_consumption_receipt", receiptDigest)
  };
}

function custodyObjectRow(db: StorageDatabase | null | undefined, custodyRef: unknown): StorageRow | null {
  if (!db || !custodyRef) return null;
  return db.prepare(`
    SELECT staging.custody_ref,
           staging.expected_content_digest,
           staging.expected_byte_size,
           staging.owner_binding_digest,
           staging.resource_binding_digest,
           staging.sealed_envelope_digest,
           staging.sealed_object_id,
           artifacts.state AS artifact_state,
           artifacts.content_digest AS artifact_content_digest,
           artifacts.envelope_digest AS artifact_envelope_digest,
           artifacts.owner_subject_ref,
           artifacts.tenant_ref,
           artifacts.workspace_ref,
           artifacts.plaintext_bytes,
           artifacts.ciphertext_bytes,
           objects.object_id,
           objects.sha256,
           objects.byte_size
    FROM upload_no_run_custody_staging AS staging
    JOIN opaque_custody_artifacts AS artifacts
      ON artifacts.custody_ref = staging.custody_ref
    JOIN storage_objects AS objects
      ON objects.object_id = artifacts.object_id
    WHERE staging.custody_ref = ?
      AND staging.state = 'sealed'
      AND artifacts.state = 'sealed'
    LIMIT 1
  `).get(custodyRef) as StorageRow | undefined || null;
}

function receiptOwnerBindingDigest(owner: ReceiptOwner): string {
  return createHash("sha256")
    .update(canonicalJson({
      subjectId: owner.subjectId,
      tenantId: owner.tenantId,
      userId: owner.userId
    }), "utf8")
    .digest("hex");
}

function receiptResourceBindingDigest(resourceRef: unknown): string {
  return createHash("sha256")
    .update(String(resourceRef || "").trim(), "utf8")
    .digest("hex");
}

function verifyCustodyDescriptorObject({
  descriptor,
  logicalObject,
  owner,
  storageKernel
}: {
  descriptor: JsonRecord;
  logicalObject: UploadConsumptionLogicalObject;
  owner: ReceiptOwner;
  storageKernel: StorageKernel;
}): void {
  const row = custodyObjectRow(
    storageKernel.db,
    descriptor.custodyRef
  );
  if (
    !row ||
    row.object_id !== logicalObject.objectId ||
    row.sealed_object_id !== logicalObject.objectId ||
    row.expected_content_digest !== logicalObject.sha256 ||
    Number(row.expected_byte_size) !== logicalObject.byteSize ||
    row.owner_binding_digest !== receiptOwnerBindingDigest(owner) ||
    row.resource_binding_digest !== receiptResourceBindingDigest(descriptor.resourceRef) ||
    row.sealed_envelope_digest !== descriptor.envelopeDigest ||
    row.artifact_content_digest !== logicalObject.sha256 ||
    row.artifact_envelope_digest !== descriptor.envelopeDigest ||
    row.owner_subject_ref !== row.owner_binding_digest ||
    row.tenant_ref !== row.resource_binding_digest ||
    row.workspace_ref !== row.resource_binding_digest ||
    row.sha256 !== descriptor.envelopeDigest ||
    Number(row.plaintext_bytes) !== logicalObject.byteSize ||
    Number(row.ciphertext_bytes) !== Number(row.byte_size)
  ) {
    throw uploadConsumptionError(
      "upload_consumption_receipt_conflict",
      "Upload custody descriptor does not match canonical storage."
    );
  }
}

function uploadConsumptionReceiptFromRow(row: StorageRow | null | undefined): UploadConsumptionReceipt | null {
  if (!row) return null;
  let objects: unknown;
  try {
    objects = JSON.parse(String(row.objects_json || "[]"));
  } catch {
    throw uploadConsumptionError(
      "upload_consumption_receipt_corrupt",
      "Persisted upload consumption receipt is invalid."
    );
  }
  if (!Array.isArray(objects)) {
    throw uploadConsumptionError(
      "upload_consumption_receipt_corrupt",
      "Persisted upload consumption receipt is invalid."
    );
  }
  const receipt: UploadConsumptionReceipt = {
    schemaVersion: String(row.schema_version || ""),
    receiptId: String(row.receipt_id || ""),
    sessionId: String(row.session_id || ""),
    ownerKey: String(row.owner_key || ""),
    objects: objects.map((item): UploadConsumptionLogicalObject => {
      const object = record(item);
      return {
        objectId: String(object.objectId || ""),
        sha256: String(object.sha256 || ""),
        byteSize: Number(object.byteSize)
      };
    }),
    receiptDigest: String(row.receipt_digest || "")
  };
  const objectShapeValid = receipt.objects.every((object, index): boolean =>
    Object.keys(record(objects[index])).sort().join(",") ===
      "byteSize,objectId,sha256" &&
    RECEIPT_OBJECT_ID_PATTERN.test(object.objectId) &&
    SHA256_PATTERN.test(object.sha256) &&
    Number.isSafeInteger(object.byteSize) &&
    object.byteSize >= 0
  );
  const expectedDigest = createHash("sha256")
    .update(canonicalJson({
      schemaVersion: receipt.schemaVersion,
      sessionId: receipt.sessionId,
      ownerKey: receipt.ownerKey,
      objects: receipt.objects
    }), "utf8")
    .digest("hex");
  if (
    receipt.schemaVersion !== UPLOAD_CONSUMPTION_RECEIPT_SCHEMA_VERSION ||
    !UPLOAD_SESSION_ID_PATTERN.test(receipt.sessionId) ||
    !SHA256_PATTERN.test(receipt.ownerKey) ||
    receipt.objects.length === 0 ||
    !objectShapeValid ||
    receipt.receiptDigest !== expectedDigest ||
    receipt.receiptId !==
      serverToken("upload_consumption_receipt", receipt.receiptDigest)
  ) {
    throw uploadConsumptionError(
      "upload_consumption_receipt_corrupt",
      "Persisted upload consumption receipt is invalid."
    );
  }
  return receipt;
}

function uploadConsumptionReceiptRowBySession(db: StorageDatabase | null | undefined, sessionId: string): StorageRow | null {
  if (!db) return null;
  return db.prepare(`
    SELECT receipt_id, session_id, schema_version, owner_key,
           objects_json, receipt_digest
    FROM storage_upload_consumption_receipts
    WHERE session_id = ?
    LIMIT 1
  `).get(sessionId) as StorageRow | undefined || null;
}

function uploadConsumptionReceiptRowById(db: StorageDatabase | null | undefined, receiptId: string): StorageRow | null {
  if (!db) return null;
  return db.prepare(`
    SELECT receipt_id, session_id, schema_version, owner_key,
           objects_json, receipt_digest
    FROM storage_upload_consumption_receipts
    WHERE receipt_id = ?
    LIMIT 1
  `).get(receiptId) as StorageRow | undefined || null;
}

function receiptMatches(receipt: UploadConsumptionReceipt | null, normalized: NormalizedReceipt): boolean {
  return Boolean(
    receipt &&
    receipt.schemaVersion === UPLOAD_CONSUMPTION_RECEIPT_SCHEMA_VERSION &&
    receipt.receiptId === normalized.receiptId &&
    receipt.sessionId === normalized.sessionId &&
    receipt.ownerKey === normalized.ownerKey &&
    receipt.receiptDigest === normalized.receiptDigest &&
    canonicalJson(receipt.objects) === canonicalJson(normalized.objects)
  );
}

function storedObjectRow(db: StorageDatabase | null | undefined, objectId: string): StorageRow | null {
  if (!db || !objectId) return null;
  return db.prepare(`
    SELECT object_id, namespace, storage_rel_path, sha256, byte_size,
           media_type, metadata_json, created_at, updated_at
    FROM storage_objects
    WHERE object_id = ?
    LIMIT 1
  `).get(objectId) as StorageRow | undefined || null;
}

function storedObjectPathReferenced(db: StorageDatabase | null | undefined, storageRelativePath: string): boolean {
  if (!db || !storageRelativePath) return false;
  return Boolean(db.prepare(`
    SELECT 1 AS referenced
    FROM storage_objects
    WHERE storage_rel_path = ?
    LIMIT 1
  `).get(storageRelativePath) as StorageRow | undefined);
}

async function removeUnreferencedStoredObject(
  db: StorageDatabase | null | undefined,
  userDataPath: string,
  object: { storageRelativePath?: unknown } = {}
): Promise<void> {
  const storageRelativePath = String(object.storageRelativePath || "");
  if (!storageRelativePath || storedObjectPathReferenced(db, storageRelativePath)) return;
  await removeStoredObject({
    userDataPath,
    storageRelativePath
  }).catch((): void => {});
}

function objectFromRow(row: StorageRow, input: JsonRecord = {}): StoredObjectProviderRecord {
  return {
    objectId: String(row.object_id || ""),
    namespace: String(row.namespace || ""),
    fileName: String(input.fileName || "object.bin"),
    storageRelativePath: String(row.storage_rel_path || ""),
    sha256: String(row.sha256 || ""),
    byteSize: Number(row.byte_size || 0),
    mediaType: String(row.media_type || ""),
    metadata: parseMetadata(row.metadata_json),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || "")
  };
}

function ownerRow(db: StorageDatabase | null | undefined, ownerId: unknown): StorageRow | null {
  const normalizedOwnerId = String(ownerId || "").trim();
  if (!db || !normalizedOwnerId) return null;
  return db.prepare(`
    SELECT object_id, job_id, archive_batch_id, owner_subject_id,
           owner_user_id, owner_username, created_at, updated_at
    FROM storage_object_owners
    WHERE job_id = ? OR archive_batch_id = ?
    ORDER BY updated_at DESC, object_id ASC
    LIMIT 1
  `).get(normalizedOwnerId, normalizedOwnerId) as StorageRow | undefined || null;
}

function publicOwnerRow(row: StorageRow | null): JsonRecord | null {
  return row
    ? {
        objectId: String(row.object_id || ""),
        jobId: String(row.job_id || ""),
        archiveBatchId: String(row.archive_batch_id || ""),
        ownerSubjectId: String(row.owner_subject_id || ""),
        ownerUserId: String(row.owner_user_id || ""),
        ownerUsername: String(row.owner_username || ""),
        createdAt: String(row.created_at || ""),
        updatedAt: String(row.updated_at || "")
      }
    : null;
}

function objectRowsByOwner(db: StorageDatabase | null | undefined, ownerId: unknown): StorageRow[] {
  const normalizedOwnerId = String(ownerId || "").trim();
  if (!db || !normalizedOwnerId) return [];
  return db.prepare(`
    SELECT objects.object_id, objects.namespace, objects.storage_rel_path,
           objects.sha256, objects.byte_size, objects.media_type,
           objects.metadata_json, objects.created_at, objects.updated_at
    FROM storage_objects AS objects
    INNER JOIN storage_object_owners AS owners
      ON owners.object_id = objects.object_id
    WHERE owners.job_id = ? OR owners.archive_batch_id = ?
    ORDER BY objects.created_at ASC, objects.object_id ASC
  `).all(normalizedOwnerId, normalizedOwnerId) as StorageRow[];
}

function deletionOperationFromRow(row: StorageRow | null): DeletionOperation | null {
  if (!row) return null;
  return {
    operationId: String(row.operation_id || ""),
    ownerId: String(row.owner_id || ""),
    jobId: String(row.job_id || ""),
    status: String(row.status || ""),
    state: parseMetadata(row.state_json),
    error: String(row.error || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || "")
  };
}

function deletionOperationRowByOwner(db: StorageDatabase | null | undefined, ownerId: unknown): StorageRow | null {
  const normalizedOwnerId = String(ownerId || "").trim();
  if (!db || !normalizedOwnerId) return null;
  return db.prepare(`
    SELECT operation_id, owner_id, job_id, status, state_json,
           error, created_at, updated_at
    FROM storage_deletion_operations
    WHERE owner_id = ?
    LIMIT 1
  `).get(normalizedOwnerId) as StorageRow | undefined || null;
}

function deletionOperationRowById(db: StorageDatabase | null | undefined, operationId: unknown): StorageRow | null {
  const normalizedOperationId = String(operationId || "").trim();
  if (!db || !normalizedOperationId) return null;
  return db.prepare(`
    SELECT operation_id, owner_id, job_id, status, state_json,
           error, created_at, updated_at
    FROM storage_deletion_operations
    WHERE operation_id = ?
    LIMIT 1
  `).get(normalizedOperationId) as StorageRow | undefined || null;
}

function existingObjectMatches(row: StorageRow | null, input: JsonRecord = {}): boolean {
  const expectedSha256 = String(input.expectedSha256 || "").trim().toLowerCase();
  const expectedByteSize = input.expectedByteSize === undefined || input.expectedByteSize === null
    ? null
    : Number(input.expectedByteSize);
  return Boolean(
    row &&
    (!expectedSha256 || row.sha256 === expectedSha256) &&
    (expectedByteSize === null || Number(row.byte_size) === expectedByteSize)
  );
}

export function createStorageProvider({
  userDataPath = "",
  storageKernel = null,
  artifactClassifiers = [],
  serviceManifestStore = null
}: StorageProviderOptions = {}): Readonly<StorageProvider> {
  const storageArtifactClassifiers = normalizeArtifactClassifiers(artifactClassifiers);
  let selectedServiceManifestStore: ServiceManifestStore | null = serviceManifestStore;

  function requireStorageKernel(): StorageKernel {
    if (!storageKernel) {
      throw uploadConsumptionError(
        "storage_kernel_required",
        "Storage kernel is required for this storage operation."
      );
    }
    return storageKernel;
  }

  function manifestStore(): ServiceManifestStore {
    if (!selectedServiceManifestStore) {
      const selectedStorageRoot = path.dirname(path.dirname(getStorageDatabasePath(userDataPath)));
      selectedServiceManifestStore = createServiceManifestStore({ storageRoot: selectedStorageRoot });
    }
    return selectedServiceManifestStore;
  }

  return Object.freeze({
    protocolVersion: STORAGE_PROTOCOL_VERSION,
    getStorageKernel(): StorageKernel | null {
      return storageKernel;
    },
    getStorageSummary(): StorageKernelSummary | JsonRecord {
      return storageKernel?.getStorageSummary?.() || {
        databasePath: getStorageDatabasePath(userDataPath),
        objectRootPath: getObjectRootPath(userDataPath),
        databaseExists: false,
        objectCount: 0,
        ownedObjectCount: 0,
        deletionOperationCount: 0,
        opaqueCustodyArtifactCount: 0,
        opaqueCustodyPromotionCount: 0,
        objectFileCount: 0,
        objectBytes: 0
      };
    },
    getUpgradePreflight(): unknown {
      return storageKernel?.getUpgradePreflight?.() || {
        ready: false,
        currentRevision: 0,
        targetRevision: 0,
        initializationRequired: true,
        metadataUpgradeRequired: false,
        futureRevisionDetected: false,
        missingCoreTableCount: 0,
        missingColumnCount: 0
      };
    },
    getDurableManifestWriterPort(): unknown {
      return manifestStore().writerPort;
    },
    getDurableManifestReaderPort(): unknown {
      return manifestStore().readerPort;
    },
    getDurableManifestCandidateAuthorityPort(): unknown {
      const store = manifestStore();
      return createManifestCandidateAuthorityPort({
        getCandidateSnapshot: store.getCandidateSnapshot as unknown as (...arguments_: unknown[]) => unknown,
        acknowledgePublished: store.acknowledgePublished as unknown as (...arguments_: unknown[]) => unknown
      });
    },
    getUploadConsumptionReceipt(receiptId: unknown): UploadConsumptionReceipt | null {
      const normalizedReceiptId = String(receiptId || "").trim();
      if (
        !UPLOAD_RECEIPT_ID_PATTERN.test(normalizedReceiptId) ||
        !storageKernel?.db
      ) {
        return null;
      }
      return uploadConsumptionReceiptFromRow(
        uploadConsumptionReceiptRowById(
          storageKernel.db,
          normalizedReceiptId
        )
      );
    },
    async commitUploadConsumptionReceipt(input: JsonRecord = {}): Promise<UploadConsumptionReceipt> {
      if (!storageKernel?.db) {
        throw uploadConsumptionError(
          "storage_kernel_required",
          "Storage kernel is required for a durable upload consumption receipt."
        );
      }
      const normalized = normalizeReceiptInput(input);
      const normalizedOwner = normalizeReceiptOwner(record(input.owner));
      for (const [index, descriptor] of normalized.custodyDescriptors.entries()) {
        verifyCustodyDescriptorObject({
          descriptor,
          logicalObject: normalized.objects[index],
          owner: normalizedOwner,
          storageKernel
        });
      }
      const persisted = uploadConsumptionReceiptFromRow(
        uploadConsumptionReceiptRowBySession(
          storageKernel.db,
          normalized.sessionId
        )
      );
      if (persisted) {
        if (!receiptMatches(persisted, normalized)) {
          throw uploadConsumptionError(
            "upload_consumption_receipt_conflict",
            "Upload consumption receipt replay conflicts with durable state."
          );
        }
        return persisted;
      }

      const commit = storageKernel.db.transaction((): UploadConsumptionReceipt => {
          const concurrent = uploadConsumptionReceiptFromRow(
            uploadConsumptionReceiptRowBySession(
              storageKernel.db,
              normalized.sessionId
            )
          );
          if (concurrent) {
            if (!receiptMatches(concurrent, normalized)) {
              throw uploadConsumptionError(
                "upload_consumption_receipt_conflict",
                "Upload consumption receipt replay conflicts with durable state."
              );
            }
            return concurrent;
          }
          storageKernel.db.prepare(`
            INSERT INTO storage_upload_consumption_receipts (
              receipt_id, session_id, schema_version, owner_key,
              objects_json, receipt_digest, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            normalized.receiptId,
            normalized.sessionId,
            UPLOAD_CONSUMPTION_RECEIPT_SCHEMA_VERSION,
            normalized.ownerKey,
            JSON.stringify(normalized.objects),
            normalized.receiptDigest,
            nowIso()
          );
          const committed = uploadConsumptionReceiptFromRow(
            uploadConsumptionReceiptRowBySession(
              storageKernel.db,
              normalized.sessionId
            )
          );
          if (!committed) {
            throw uploadConsumptionError(
              "upload_consumption_receipt_commit_failed",
              "Upload consumption receipt was not visible after commit."
            );
          }
          return committed;
      });

        try {
          return commit();
        } catch (error: unknown) {
          const code = error && typeof error === "object"
            ? String((error as { code?: unknown }).code || "")
            : "";
          if (code === "upload_consumption_receipt_conflict") {
            throw error;
          }
          const concurrent = uploadConsumptionReceiptFromRow(
            uploadConsumptionReceiptRowBySession(
              storageKernel.db,
              normalized.sessionId
            )
          );
          if (concurrent) {
            if (receiptMatches(concurrent, normalized)) {
              return concurrent;
            }
            throw uploadConsumptionError(
              "upload_consumption_receipt_conflict",
              "Upload consumption receipt replay conflicts with durable state.",
              error
            );
          }
          throw uploadConsumptionError(
            "upload_consumption_receipt_commit_failed",
            "Upload consumption receipt could not be committed.",
            error
          );
        }
    },
    async putObject(input: JsonRecord = {}): Promise<StoredObjectRecord> {
      const storedObject = await putStoredObject({
        userDataPath,
        ...input
      });
      try {
        recordStoredObject(storageKernel?.db, storedObject);
        return storedObject;
      } catch (error: unknown) {
        await removeUnreferencedStoredObject(storageKernel?.db, userDataPath, storedObject);
        throw error;
      }
    },
    async putObjectsFromFiles(inputs: readonly JsonRecord[] = []): Promise<readonly StoredObjectRecord[]> {
      const kernel = requireStorageKernel();
      const normalizedInputs = Array.isArray(inputs) ? inputs : [];
      const stored: StoredObjectRecord[] = [];
      const newlyCreated: StoredObjectRecord[] = [];
      try {
        for (const input of normalizedInputs) {
          const existing = storedObjectRow(kernel.db, String(input.objectId || ""));
          if (existing) {
            if (!existingObjectMatches(existing, input)) {
              const error = new Error("Stable storage object identity conflicts with persisted content.") as StorageError;
              error.code = "storage_object_identity_conflict";
              throw error;
            }
            await verifyStoredObjectIntegrity({
              userDataPath,
              storageRelativePath: existing.storage_rel_path,
              expectedSha256: existing.sha256,
              expectedByteSize: Number(existing.byte_size)
            });
            stored.push(objectFromRow(existing, input));
            continue;
          }
          const object = await putStoredObjectFromFile({
            userDataPath,
            ...input
          });
          stored.push(object);
          newlyCreated.push(object);
        }
        const persistBatch = kernel.db.transaction((objects: readonly StoredObjectRecord[]): void => {
          for (const object of objects) {
            recordStoredObject(kernel.db, object);
          }
        });
        persistBatch(stored);
        return stored;
      } catch (error: unknown) {
        await Promise.all(newlyCreated.map((object): Promise<void> =>
          removeUnreferencedStoredObject(kernel.db, userDataPath, object)
        ));
        throw error;
      }
    },
    getObject(objectId: unknown): StoredObjectProviderRecord | null {
      const row = storedObjectRow(storageKernel?.db, String(objectId || "").trim());
      return row ? objectFromRow(row) : null;
    },
    findObjectOwner(ownerId: unknown): JsonRecord | null {
      return publicOwnerRow(ownerRow(storageKernel?.db, ownerId));
    },
    listObjectStoragePathsByOwner(ownerId: unknown): string[] {
      return objectRowsByOwner(storageKernel?.db, ownerId)
        .map((row): string => String(row.storage_rel_path || "").trim())
        .filter(Boolean);
    },
    getObjectOwnerArtifactPaths(): JsonRecord {
      return {
        objectRootPath: getObjectRootPath(userDataPath),
        objectBatchPath: ""
      };
    },
    deleteObjectRecordsByOwner(ownerId: unknown): number {
      const rows = objectRowsByOwner(storageKernel?.db, ownerId);
      if (rows.length === 0) return 0;
      const removeRecords = storageKernel!.db.transaction((objectIds: readonly string[]): void => {
        const statement = storageKernel!.db.prepare("DELETE FROM storage_objects WHERE object_id = ?");
        for (const objectId of objectIds) statement.run(objectId);
      });
      removeRecords(rows.map((row): string => String(row.object_id || "")));
      return rows.length;
    },
    getDeletionOperationByOwnerId(ownerId: unknown): DeletionOperation | null {
      return deletionOperationFromRow(deletionOperationRowByOwner(storageKernel?.db, ownerId));
    },
    upsertDeletionOperation(input: JsonRecord = {}): DeletionOperation | null {
      const ownerId = String(input.ownerId || input.batchId || "").trim();
      if (!ownerId) {
        throw new Error("Storage deletion owner id is required.");
      }
      const existing = deletionOperationRowByOwner(storageKernel?.db, ownerId);
      if (existing) return deletionOperationFromRow(existing);
      const kernel = requireStorageKernel();
      const operationId = String(input.operationId || randomUUID());
      const timestamp = nowIso();
      kernel.db.prepare(`
        INSERT INTO storage_deletion_operations (
          operation_id, owner_id, job_id, status, state_json,
          error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operationId,
        ownerId,
        String(input.jobId || "").trim(),
        String(input.status || "runtime_pending"),
        JSON.stringify(input.state && typeof input.state === "object" ? input.state : {}),
        String(input.error || ""),
        timestamp,
        timestamp
      );
      return deletionOperationFromRow(deletionOperationRowById(kernel.db, operationId));
    },
    updateDeletionOperation(operationId: unknown, patch: JsonRecord = {}): DeletionOperation | null {
      const existing = deletionOperationFromRow(
        deletionOperationRowById(storageKernel?.db, operationId)
      );
      if (!existing) return null;
      const kernel = requireStorageKernel();
      kernel.db.prepare(`
        UPDATE storage_deletion_operations
        SET status = ?, state_json = ?, error = ?, updated_at = ?
        WHERE operation_id = ?
      `).run(
        String(patch.status || existing.status),
        JSON.stringify(
          patch.state && typeof patch.state === "object" ? patch.state : existing.state
        ),
        String(patch.error ?? existing.error ?? ""),
        nowIso(),
        existing.operationId
      );
      return deletionOperationFromRow(
        deletionOperationRowById(kernel.db, existing.operationId)
      );
    },
    deleteDeletionOperation(operationId: unknown): number {
      return storageKernel?.db
        ?.prepare("DELETE FROM storage_deletion_operations WHERE operation_id = ?")
        .run(String(operationId || "").trim()).changes || 0;
    },
    listPendingDeletionOperations(): DeletionOperation[] {
      if (!storageKernel?.db) return [];
      return storageKernel.db.prepare(`
        SELECT operation_id, owner_id, job_id, status, state_json,
               error, created_at, updated_at
        FROM storage_deletion_operations
        ORDER BY updated_at ASC, operation_id ASC
      `).all().map((row): DeletionOperation | null => deletionOperationFromRow(row as StorageRow)).filter(
        (operation): operation is DeletionOperation => operation !== null
      );
    },
    readObject(input: JsonRecord = {}): Promise<unknown> {
      return readStoredObject({
        userDataPath,
        storageRelativePath: input.storageRelativePath || input.storage_rel_path || ""
      });
    },
    openObjectReadStream(input: JsonRecord = {}): Promise<StoredObjectReadStream> {
      return openStoredObjectReadStream({
        userDataPath,
        storageRelativePath: String(input.storageRelativePath || input.storage_rel_path || ""),
        signal: optionalSignal(input.signal) || undefined
      });
    },
    openPrivateNoExecObjectReadStream(input: JsonRecord = {}): Promise<StoredObjectReadStream> {
      return openPrivateNoExecObjectReadStream({
        userDataPath,
        storageRelativePath: String(input.storageRelativePath || ""),
        signal: optionalSignal(input.signal) || undefined
      });
    },
    statObject(input: JsonRecord = {}): Promise<unknown> {
      return statStoredObject({
        userDataPath,
        storageRelativePath: input.storageRelativePath || input.storage_rel_path || ""
      });
    },
    resolveStoredObjectPath(storageRelativePath: unknown): string {
      return resolveStoredObjectPath(userDataPath, storageRelativePath);
    },
    runDoctor(): Promise<unknown> {
      return runStorageDoctor({ userDataPath });
    },
    reconcile(input: JsonRecord = {}): Promise<unknown> {
      return reconcileStorage({
        userDataPath,
        apply: input.apply !== false,
        pruneOrphanObjects: input.pruneOrphanObjects === true
      });
    },
    listBackups(): Promise<unknown> {
      return listStorageBackups({ userDataPath });
    },
    createBackup(input: JsonRecord = {}): Promise<unknown> {
      return runStorageMaintenanceMutation(
        userDataPath,
        (executionContext) => createStorageBackup({
          userDataPath,
          label: String(input.label || ""),
          retentionPolicy: input.retentionPolicy || input.retention || null,
          artifactClassifiers: storageArtifactClassifiers,
          executionContext
        }),
        { signal: optionalSignal(input.signal), budget: input.budget, kind: "storage.backup.create" }
      );
    },
    restoreBackupPreview(input: JsonRecord = {}): Promise<unknown> {
      return restoreStorageBackup({
        userDataPath,
        backupId: stringValue(input.backupId),
        dryRun: true,
        includePaths: stringList(input.includePaths),
        signal: optionalSignal(input.signal),
        budget: record(input.budget)
      });
    },
    restoreBackup(input: JsonRecord = {}): Promise<unknown> {
      const shouldApply = input.confirm === true || input.apply === true;
      const execute = (executionContext: RestoreExecutionContext | null = null): Promise<unknown> => restoreStorageBackup({
        userDataPath,
        backupId: stringValue(input.backupId),
        dryRun: false,
        apply: shouldApply,
        includePaths: stringList(input.includePaths),
        signal: optionalSignal(input.signal),
        budget: record(input.budget),
        executionContext
      });
      return shouldApply
        ? runStorageMaintenanceMutation(
            userDataPath,
            execute,
            { signal: optionalSignal(input.signal), budget: input.budget, kind: "storage.backup.restore" }
          )
        : execute();
    },
    applyBackupRetention(input: JsonRecord = {}): Promise<unknown> {
      return runStorageMaintenanceMutation(
        userDataPath,
        (executionContext) => applyStorageBackupRetention({
          userDataPath,
          policy: input.policy,
          now: typeof input.now === "number" ? input.now : undefined,
          executionContext
        }),
        { signal: optionalSignal(input.signal), budget: input.budget, kind: "storage.backup.retention" }
      );
    },
    listCapabilities(): JsonRecord {
      const capabilities: JsonRecord[] = [
          {
            id: "storage-summary",
            kind: "projection",
            operations: ["getStorageSummary"]
          },
          {
            id: GOVERNED_OBJECT_STORAGE_DISCIPLINE.byteStore.capabilityId,
            kind: GOVERNED_OBJECT_STORAGE_DISCIPLINE.byteStore.kind,
            operations: [...GOVERNED_OBJECT_STORAGE_DISCIPLINE.byteStore.operations]
          },
          {
            id: GOVERNED_OBJECT_STORAGE_DISCIPLINE.ownershipAuthority.capabilityId,
            kind: GOVERNED_OBJECT_STORAGE_DISCIPLINE.ownershipAuthority.kind,
            operations: [...GOVERNED_OBJECT_STORAGE_DISCIPLINE.ownershipAuthority.operations]
          },
          {
            id: "maintenance",
            kind: "ops",
            operations: [
              "runDoctor",
              "reconcile",
              "listBackups",
              "createBackup",
              "restoreBackupPreview",
              "restoreBackup",
              "applyBackupRetention"
            ]
          },
          {
            id: "durable-service-manifests",
            kind: "manifest-authority",
            operations: [
              "getDurableManifestWriterPort",
              "getDurableManifestReaderPort",
              "getDurableManifestCandidateAuthorityPort"
            ]
          }
        ];
      assertGovernedObjectStorageCapabilities(capabilities);
      return {
        protocolVersion: STORAGE_PROTOCOL_VERSION,
        capabilities,
      };
    }
  });
}
