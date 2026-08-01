import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
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

export const STORAGE_PROTOCOL_VERSION: any = "v0.0.1:storage:core-2";
export const UPLOAD_CONSUMPTION_RECEIPT_SCHEMA_VERSION: any =
  "v0.0.1:storage:upload-consumption-receipt-1";

const RECEIPT_OBJECT_ID_PATTERN: any = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const UPLOAD_SESSION_ID_PATTERN: any = /^upload_session_[a-f0-9]{32}$/u;
const UPLOAD_RECEIPT_ID_PATTERN: any =
  /^upload_consumption_receipt_[a-f0-9]{32}$/u;
const SHA256_PATTERN: any = /^[a-f0-9]{64}$/u;

function nowIso() : any {
  return new Date().toISOString();
}

function normalizeArtifactClassifiers(artifactClassifiers: any = []) : any {
  return Array.isArray(artifactClassifiers)
    ? artifactClassifiers.filter((classifier?: any) : any => typeof classifier === "function")
    : [];
}

function parseMetadata(value?: any) : any {
  try {
    const parsed: any = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function canonicalJson(value?: any) : any {
  if (Array.isArray(value)) {
    return `[${value.map((item?: any) : any => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key?: any) : any =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function uploadConsumptionError(code?: any, message?: any, cause: any = null) : any {
  const error: Error & Record<string, any> = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function normalizeReceiptOwner(owner: Record<string, any> = {}) : any {
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
    throw uploadConsumptionError(
      "upload_consumption_receipt_invalid",
      "Upload consumption receipt owner is invalid."
    );
  }
  const normalized: Record<string, any> = {
    tenantId: String(owner.tenantId || "").trim(),
    subjectId: String(owner.subjectId || "").trim(),
    userId: String(owner.userId || owner.subjectId || "").trim(),
    username: String(owner.username || "").trim()
  };
  if (
    !normalized.subjectId ||
    (Object.values(normalized) as any[]).some(
      (value?: any) : any => value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)
    )
  ) {
    throw uploadConsumptionError(
      "upload_consumption_receipt_invalid",
      "Upload consumption receipt owner is required."
    );
  }
  return normalized;
}

function normalizeReceiptInput(input: Record<string, any> = {}) : any {
  const sessionId: any = String(input.sessionId || "").trim();
  if (!UPLOAD_SESSION_ID_PATTERN.test(sessionId)) {
    throw uploadConsumptionError(
      "upload_consumption_receipt_invalid",
      "Upload consumption receipt session identity is invalid."
    );
  }
  const owner: any = normalizeReceiptOwner(input.owner);
  const custodyDescriptors: any = Array.isArray(input.custodyDescriptors)
    ? input.custodyDescriptors
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
  const seenObjectIds: any = new Set<any>();
  const objects: any = custodyDescriptors.map((descriptor?: any, index?: any) : any => {
    const expectedKeys: any = [
      "byteSize",
      "contentDigest",
      "custodyRef",
      "custodyState",
      "envelopeDigest",
      "resourceRef"
    ];
    const custodyRef: any = String(descriptor?.custodyRef || "").trim();
    const objectId: any = custodyRef.startsWith("custody:")
      ? custodyRef.slice("custody:".length)
      : "";
    const sha256: any = String(descriptor?.contentDigest || "").trim().toLowerCase();
    const byteSize: any = Number(descriptor?.byteSize);
    if (
      Object.keys(descriptor || {}).sort().join(",") !==
        expectedKeys.join(",") ||
      !RECEIPT_OBJECT_ID_PATTERN.test(objectId) ||
      seenObjectIds.has(objectId) ||
      !SHA256_PATTERN.test(sha256) ||
      !SHA256_PATTERN.test(String(descriptor?.envelopeDigest || "")) ||
      descriptor?.custodyState !== "sealed_no_run" ||
      descriptor?.resourceRef !== `upload-resource:${sessionId}:${index}` ||
      !Number.isSafeInteger(byteSize) ||
      byteSize < 0
    ) {
      throw uploadConsumptionError(
        "upload_consumption_receipt_invalid",
        "Upload consumption receipt object metadata is invalid."
      );
    }
    seenObjectIds.add(objectId);
    return { objectId, sha256, byteSize };
  });
  const ownerKey: any = hashClientString(
    JSON.stringify(owner),
    "upload.session.owner"
  );
  const receiptDigest: any = createHash("sha256")
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

function custodyObjectRow(db?: any, custodyRef?: any) : any {
  if (!db || !custodyRef) return null;
  return db.prepare(`
    SELECT staging.custody_ref,
           staging.expected_content_digest,
           staging.expected_byte_size,
           staging.sealed_envelope_digest,
           staging.sealed_object_id,
           artifacts.state AS artifact_state,
           artifacts.plaintext_bytes,
           artifacts.ciphertext_bytes,
           objects.object_id,
           objects.storage_rel_path,
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
  `).get(custodyRef) || null;
}

async function verifyCustodyDescriptorObject({
  descriptor,
  logicalObject,
  storageKernel,
  userDataPath
}: Record<string, any>) : Promise<any> {
  const row: any = custodyObjectRow(
    storageKernel?.db,
    descriptor.custodyRef
  );
  if (
    !row ||
    row.object_id !== logicalObject.objectId ||
    row.sealed_object_id !== logicalObject.objectId ||
    row.expected_content_digest !== logicalObject.sha256 ||
    Number(row.expected_byte_size) !== logicalObject.byteSize ||
    row.sealed_envelope_digest !== descriptor.envelopeDigest ||
    row.sha256 !== descriptor.envelopeDigest ||
    Number(row.plaintext_bytes) !== logicalObject.byteSize ||
    Number(row.ciphertext_bytes) !== Number(row.byte_size)
  ) {
    throw uploadConsumptionError(
      "upload_consumption_receipt_conflict",
      "Upload custody descriptor does not match canonical storage."
    );
  }
  await verifyStoredObjectIntegrity({
    userDataPath,
    storageRelativePath: row.storage_rel_path,
    expectedSha256: descriptor.envelopeDigest,
    expectedByteSize: Number(row.byte_size)
  });
}

function uploadConsumptionReceiptFromRow(row?: any) : any {
  if (!row) return null;
  let objects: any;
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
  const receipt: Record<string, any> = {
    schemaVersion: String(row.schema_version || ""),
    receiptId: String(row.receipt_id || ""),
    sessionId: String(row.session_id || ""),
    ownerKey: String(row.owner_key || ""),
    objects: objects.map((object?: any) : any => ({
      objectId: String(object?.objectId || ""),
      sha256: String(object?.sha256 || ""),
      byteSize: Number(object?.byteSize)
    })),
    receiptDigest: String(row.receipt_digest || "")
  };
  const objectShapeValid: any = receipt.objects.every((object?: any, index?: any) : any =>
    Object.keys(objects[index] || {}).sort().join(",") ===
      "byteSize,objectId,sha256" &&
    RECEIPT_OBJECT_ID_PATTERN.test(object.objectId) &&
    SHA256_PATTERN.test(object.sha256) &&
    Number.isSafeInteger(object.byteSize) &&
    object.byteSize >= 0
  );
  const expectedDigest: any = createHash("sha256")
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

function uploadConsumptionReceiptRowBySession(db?: any, sessionId?: any) : any {
  if (!db) return null;
  return db.prepare(`
    SELECT receipt_id, session_id, schema_version, owner_key,
           objects_json, receipt_digest
    FROM storage_upload_consumption_receipts
    WHERE session_id = ?
    LIMIT 1
  `).get(sessionId) || null;
}

function uploadConsumptionReceiptRowById(db?: any, receiptId?: any) : any {
  if (!db) return null;
  return db.prepare(`
    SELECT receipt_id, session_id, schema_version, owner_key,
           objects_json, receipt_digest
    FROM storage_upload_consumption_receipts
    WHERE receipt_id = ?
    LIMIT 1
  `).get(receiptId) || null;
}

function receiptMatches(receipt?: any, normalized?: any) : any {
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

function storedObjectRow(db?: any, objectId?: any) : any {
  if (!db || !objectId) return null;
  return db.prepare(`
    SELECT object_id, namespace, storage_rel_path, sha256, byte_size,
           media_type, metadata_json, created_at, updated_at
    FROM storage_objects
    WHERE object_id = ?
    LIMIT 1
  `).get(objectId) || null;
}

function storedObjectPathReferenced(db?: any, storageRelativePath?: any) : any {
  if (!db || !storageRelativePath) return false;
  return Boolean(db.prepare(`
    SELECT 1 AS referenced
    FROM storage_objects
    WHERE storage_rel_path = ?
    LIMIT 1
  `).get(storageRelativePath));
}

async function removeUnreferencedStoredObject(db?: any, userDataPath?: any, object: Record<string, any> = {}) : Promise<any> {
  if (!object.storageRelativePath || storedObjectPathReferenced(db, object.storageRelativePath)) return;
  await removeStoredObject({
    userDataPath,
    storageRelativePath: object.storageRelativePath
  }).catch(() : any => {});
}

function objectFromRow(row?: any, input: Record<string, any> = {}) : any {
  return {
    objectId: row.object_id,
    namespace: row.namespace,
    fileName: String(input.fileName || "object.bin"),
    storageRelativePath: row.storage_rel_path,
    sha256: row.sha256,
    byteSize: Number(row.byte_size || 0),
    mediaType: row.media_type,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function ownerRow(db?: any, ownerId?: any) : any {
  const normalizedOwnerId: any = String(ownerId || "").trim();
  if (!db || !normalizedOwnerId) return null;
  return db.prepare(`
    SELECT object_id, job_id, archive_batch_id, owner_subject_id,
           owner_user_id, owner_username, created_at, updated_at
    FROM storage_object_owners
    WHERE job_id = ? OR archive_batch_id = ?
    ORDER BY updated_at DESC, object_id ASC
    LIMIT 1
  `).get(normalizedOwnerId, normalizedOwnerId) || null;
}

function publicOwnerRow(row?: any) : any {
  return row
    ? {
        objectId: row.object_id,
        jobId: row.job_id,
        archiveBatchId: row.archive_batch_id,
        ownerSubjectId: row.owner_subject_id,
        ownerUserId: row.owner_user_id,
        ownerUsername: row.owner_username,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    : null;
}

function objectRowsByOwner(db?: any, ownerId?: any) : any {
  const normalizedOwnerId: any = String(ownerId || "").trim();
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
  `).all(normalizedOwnerId, normalizedOwnerId);
}

function deletionOperationFromRow(row?: any) : any {
  if (!row) return null;
  return {
    operationId: row.operation_id,
    ownerId: row.owner_id,
    jobId: row.job_id,
    status: row.status,
    state: parseMetadata(row.state_json),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function deletionOperationRowByOwner(db?: any, ownerId?: any) : any {
  const normalizedOwnerId: any = String(ownerId || "").trim();
  if (!db || !normalizedOwnerId) return null;
  return db.prepare(`
    SELECT operation_id, owner_id, job_id, status, state_json,
           error, created_at, updated_at
    FROM storage_deletion_operations
    WHERE owner_id = ?
    LIMIT 1
  `).get(normalizedOwnerId) || null;
}

function deletionOperationRowById(db?: any, operationId?: any) : any {
  const normalizedOperationId: any = String(operationId || "").trim();
  if (!db || !normalizedOperationId) return null;
  return db.prepare(`
    SELECT operation_id, owner_id, job_id, status, state_json,
           error, created_at, updated_at
    FROM storage_deletion_operations
    WHERE operation_id = ?
    LIMIT 1
  `).get(normalizedOperationId) || null;
}

function existingObjectMatches(row?: any, input: Record<string, any> = {}) : any {
  const expectedSha256: any = String(input.expectedSha256 || "").trim().toLowerCase();
  const expectedByteSize: any = input.expectedByteSize === undefined || input.expectedByteSize === null
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
}: Record<string, any> = {}) : any {
  const storageArtifactClassifiers: any = normalizeArtifactClassifiers(artifactClassifiers);
  let selectedServiceManifestStore: any = serviceManifestStore;

  function manifestStore() : any {
    if (!selectedServiceManifestStore) {
      const selectedStorageRoot: any = path.dirname(path.dirname(getStorageDatabasePath(userDataPath)));
      selectedServiceManifestStore = createServiceManifestStore({ storageRoot: selectedStorageRoot });
    }
    return selectedServiceManifestStore;
  }

  return Object.freeze({
    protocolVersion: STORAGE_PROTOCOL_VERSION,
    getStorageKernel() : any {
      return storageKernel;
    },
    getStorageSummary() : any {
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
    getUpgradePreflight() : any {
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
    getDurableManifestWriterPort() : any {
      return manifestStore().writerPort;
    },
    getDurableManifestReaderPort() : any {
      return manifestStore().readerPort;
    },
    getDurableManifestCandidateAuthorityPort() : any {
      const store: any = manifestStore();
      return createManifestCandidateAuthorityPort({
        getCandidateSnapshot: store.getCandidateSnapshot,
        acknowledgePublished: store.acknowledgePublished
      });
    },
    getUploadConsumptionReceipt(receiptId?: any) : any {
      const normalizedReceiptId: any = String(receiptId || "").trim();
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
    async commitUploadConsumptionReceipt(input: Record<string, any> = {}) : Promise<any> {
      if (!storageKernel?.db) {
        throw uploadConsumptionError(
          "storage_kernel_required",
          "Storage kernel is required for a durable upload consumption receipt."
        );
      }
      const normalized: any = normalizeReceiptInput(input);
      const persisted: any = uploadConsumptionReceiptFromRow(
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

      try {
        for (const [index, descriptor] of normalized.custodyDescriptors.entries()) {
          await verifyCustodyDescriptorObject({
            descriptor,
            logicalObject: normalized.objects[index],
            storageKernel,
            userDataPath
          });
        }

        const commit: any = storageKernel.db.transaction(() : any => {
          const concurrent: any = uploadConsumptionReceiptFromRow(
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
          return uploadConsumptionReceiptFromRow(
            uploadConsumptionReceiptRowBySession(
              storageKernel.db,
              normalized.sessionId
            )
          );
        });

        try {
          return commit();
        } catch (error: any) {
          if (error?.code === "upload_consumption_receipt_conflict") {
            throw error;
          }
          const concurrent: any = uploadConsumptionReceiptFromRow(
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
      } catch (error: any) {
        throw error;
      }
    },
    async putObject(input: Record<string, any> = {}) : Promise<any> {
      const storedObject: any = await putStoredObject({
        userDataPath,
        ...input
      });
      try {
        recordStoredObject(storageKernel?.db, storedObject);
        return storedObject;
      } catch (error: any) {
        await removeUnreferencedStoredObject(storageKernel?.db, userDataPath, storedObject);
        throw error;
      }
    },
    async putObjectsFromFiles(inputs: any = []) : Promise<any> {
      if (!storageKernel?.db) {
        const error: Error & Record<string, any> = new Error("Storage kernel is required for durable file persistence.");
        error.code = "storage_kernel_required";
        throw error;
      }
      const normalizedInputs: any = Array.isArray(inputs) ? inputs : [];
      const stored: any[] = [];
      const newlyCreated: any[] = [];
      try {
        for (const input of normalizedInputs) {
          const existing: any = storedObjectRow(storageKernel.db, input?.objectId);
          if (existing) {
            if (!existingObjectMatches(existing, input)) {
              const error: Error & Record<string, any> = new Error("Stable storage object identity conflicts with persisted content.");
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
          const object: any = await putStoredObjectFromFile({
            userDataPath,
            ...input
          });
          stored.push(object);
          newlyCreated.push(object);
        }
        const persistBatch: any = storageKernel.db.transaction((objects?: any) : any => {
          for (const object of objects) {
            recordStoredObject(storageKernel.db, object);
          }
        });
        persistBatch(stored);
        return stored;
      } catch (error: any) {
        await Promise.all(newlyCreated.map((object?: any) : any =>
          removeUnreferencedStoredObject(storageKernel.db, userDataPath, object)
        ));
        throw error;
      }
    },
    getObject(objectId?: any) : any {
      const row: any = storedObjectRow(storageKernel?.db, String(objectId || "").trim());
      return row ? objectFromRow(row) : null;
    },
    findObjectOwner(ownerId?: any) : any {
      return publicOwnerRow(ownerRow(storageKernel?.db, ownerId));
    },
    listObjectStoragePathsByOwner(ownerId?: any) : any {
      return objectRowsByOwner(storageKernel?.db, ownerId)
        .map((row?: any) : any => String(row.storage_rel_path || "").trim())
        .filter(Boolean);
    },
    getObjectOwnerArtifactPaths() : any {
      return {
        objectRootPath: getObjectRootPath(userDataPath),
        objectBatchPath: ""
      };
    },
    deleteObjectRecordsByOwner(ownerId?: any) : any {
      const rows: any = objectRowsByOwner(storageKernel?.db, ownerId);
      if (rows.length === 0) return 0;
      const removeRecords: any = storageKernel.db.transaction((objectIds?: any) : any => {
        const statement: any = storageKernel.db.prepare("DELETE FROM storage_objects WHERE object_id = ?");
        for (const objectId of objectIds) statement.run(objectId);
      });
      removeRecords(rows.map((row?: any) : any => row.object_id));
      return rows.length;
    },
    getDeletionOperationByOwnerId(ownerId?: any) : any {
      return deletionOperationFromRow(deletionOperationRowByOwner(storageKernel?.db, ownerId));
    },
    upsertDeletionOperation(input: Record<string, any> = {}) : any {
      const ownerId: any = String(input.ownerId || input.batchId || "").trim();
      if (!ownerId) {
        throw new Error("Storage deletion owner id is required.");
      }
      const existing: any = deletionOperationRowByOwner(storageKernel?.db, ownerId);
      if (existing) return deletionOperationFromRow(existing);
      const operationId: any = String(input.operationId || randomUUID());
      const timestamp: any = nowIso();
      storageKernel.db.prepare(`
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
      return deletionOperationFromRow(deletionOperationRowById(storageKernel.db, operationId));
    },
    updateDeletionOperation(operationId?: any, patch: Record<string, any> = {}) : any {
      const existing: any = deletionOperationFromRow(
        deletionOperationRowById(storageKernel?.db, operationId)
      );
      if (!existing) return null;
      storageKernel.db.prepare(`
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
        deletionOperationRowById(storageKernel.db, existing.operationId)
      );
    },
    deleteDeletionOperation(operationId?: any) : any {
      return storageKernel?.db
        ?.prepare("DELETE FROM storage_deletion_operations WHERE operation_id = ?")
        .run(String(operationId || "").trim()).changes || 0;
    },
    listPendingDeletionOperations() : any {
      if (!storageKernel?.db) return [];
      return storageKernel.db.prepare(`
        SELECT operation_id, owner_id, job_id, status, state_json,
               error, created_at, updated_at
        FROM storage_deletion_operations
        ORDER BY updated_at ASC, operation_id ASC
      `).all().map(deletionOperationFromRow);
    },
    readObject(input: Record<string, any> = {}) : any {
      return readStoredObject({
        userDataPath,
        storageRelativePath: input.storageRelativePath || input.storage_rel_path || ""
      });
    },
    openObjectReadStream(input: Record<string, any> = {}) : any {
      return openStoredObjectReadStream({
        userDataPath,
        storageRelativePath: input.storageRelativePath || input.storage_rel_path || "",
        signal: input.signal
      });
    },
    openPrivateNoExecObjectReadStream(input: Record<string, any> = {}) : any {
      return openPrivateNoExecObjectReadStream({
        userDataPath,
        storageRelativePath: input.storageRelativePath || "",
        signal: input.signal
      });
    },
    statObject(input: Record<string, any> = {}) : any {
      return statStoredObject({
        userDataPath,
        storageRelativePath: input.storageRelativePath || input.storage_rel_path || ""
      });
    },
    resolveStoredObjectPath(storageRelativePath?: any) : any {
      return resolveStoredObjectPath(userDataPath, storageRelativePath);
    },
    runDoctor() : any {
      return runStorageDoctor({ userDataPath });
    },
    reconcile(input: Record<string, any> = {}) : any {
      return reconcileStorage({
        userDataPath,
        apply: input.apply !== false,
        pruneOrphanObjects: input.pruneOrphanObjects === true
      });
    },
    listBackups() : any {
      return listStorageBackups({ userDataPath });
    },
    createBackup(input: Record<string, any> = {}) : any {
      return runStorageMaintenanceMutation(
        userDataPath,
        (executionContext?: any) : any => createStorageBackup({
          userDataPath,
          label: input.label || "",
          retentionPolicy: input.retentionPolicy || input.retention || null,
          artifactClassifiers: storageArtifactClassifiers,
          executionContext
        }),
        { signal: input.signal, budget: input.budget, kind: "storage.backup.create" }
      );
    },
    restoreBackupPreview(input: Record<string, any> = {}) : any {
      return restoreStorageBackup({
        userDataPath,
        backupId: input.backupId,
        dryRun: true,
        includePaths: input.includePaths || [],
        signal: input.signal,
        budget: input.budget
      });
    },
    restoreBackup(input: Record<string, any> = {}) : any {
      const shouldApply: any = input.confirm === true || input.apply === true;
      const execute: any = (executionContext: any = null) : any => restoreStorageBackup({
        userDataPath,
        backupId: input.backupId,
        dryRun: false,
        apply: shouldApply,
        includePaths: input.includePaths || [],
        signal: input.signal,
        budget: input.budget,
        executionContext
      });
      return shouldApply
        ? runStorageMaintenanceMutation(
            userDataPath,
            execute,
            { signal: input.signal, budget: input.budget, kind: "storage.backup.restore" }
          )
        : execute();
    },
    applyBackupRetention(input: Record<string, any> = {}) : any {
      return runStorageMaintenanceMutation(
        userDataPath,
        (executionContext?: any) : any => applyStorageBackupRetention({
          userDataPath,
          policy: input.policy,
          now: input.now,
          executionContext
        }),
        { signal: input.signal, budget: input.budget, kind: "storage.backup.retention" }
      );
    },
    listCapabilities() : any {
      const capabilities: any[] = [
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
