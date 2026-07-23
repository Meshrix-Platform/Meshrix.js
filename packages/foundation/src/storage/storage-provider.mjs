import { randomUUID } from "node:crypto";
import path from "node:path";
import { listStorageBackups } from "./backup-query.mjs";
import { applyStorageBackupRetention } from "./backup-retention.mjs";
import { createStorageBackup } from "./backup-snapshot.mjs";
import { reconcileStorage, runStorageDoctor } from "./ops-tools.mjs";
import {
  getObjectRootPath,
  putStoredObject,
  putStoredObjectFromFile,
  recordStoredObject,
  readStoredObject,
  removeStoredObject,
  resolveStoredObjectPath,
  statStoredObject,
  verifyStoredObjectIntegrity
} from "./object-store.mjs";
import { getStorageDatabasePath } from "./schema-manager.mjs";
import { createServiceManifestStore } from "./service-manifest-store.mjs";
import { createManifestCandidateAuthorityPort } from "./storage-ports.mjs";
import { restoreStorageBackup } from "./restore-execution.mjs";
import { runStorageMaintenanceMutation } from "./storage-maintenance-coordinator.mjs";

export const STORAGE_PROTOCOL_VERSION = "v0.0.1:storage:core-2";

function nowIso() {
  return new Date().toISOString();
}

function normalizeArtifactClassifiers(artifactClassifiers = []) {
  return Array.isArray(artifactClassifiers)
    ? artifactClassifiers.filter((classifier) => typeof classifier === "function")
    : [];
}

function parseMetadata(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function storedObjectRow(db, objectId) {
  if (!db || !objectId) return null;
  return db.prepare(`
    SELECT object_id, namespace, storage_rel_path, sha256, byte_size,
           media_type, metadata_json, created_at, updated_at
    FROM storage_objects
    WHERE object_id = ?
    LIMIT 1
  `).get(objectId) || null;
}

function storedObjectPathReferenced(db, storageRelativePath) {
  if (!db || !storageRelativePath) return false;
  return Boolean(db.prepare(`
    SELECT 1 AS referenced
    FROM storage_objects
    WHERE storage_rel_path = ?
    LIMIT 1
  `).get(storageRelativePath));
}

async function removeUnreferencedStoredObject(db, userDataPath, object = {}) {
  if (!object.storageRelativePath || storedObjectPathReferenced(db, object.storageRelativePath)) return;
  await removeStoredObject({
    userDataPath,
    storageRelativePath: object.storageRelativePath
  }).catch(() => {});
}

function objectFromRow(row, input = {}) {
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

function ownerRow(db, ownerId) {
  const normalizedOwnerId = String(ownerId || "").trim();
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

function publicOwnerRow(row) {
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

function objectRowsByOwner(db, ownerId) {
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
  `).all(normalizedOwnerId, normalizedOwnerId);
}

function deletionOperationFromRow(row) {
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

function deletionOperationRowByOwner(db, ownerId) {
  const normalizedOwnerId = String(ownerId || "").trim();
  if (!db || !normalizedOwnerId) return null;
  return db.prepare(`
    SELECT operation_id, owner_id, job_id, status, state_json,
           error, created_at, updated_at
    FROM storage_deletion_operations
    WHERE owner_id = ?
    LIMIT 1
  `).get(normalizedOwnerId) || null;
}

function deletionOperationRowById(db, operationId) {
  const normalizedOperationId = String(operationId || "").trim();
  if (!db || !normalizedOperationId) return null;
  return db.prepare(`
    SELECT operation_id, owner_id, job_id, status, state_json,
           error, created_at, updated_at
    FROM storage_deletion_operations
    WHERE operation_id = ?
    LIMIT 1
  `).get(normalizedOperationId) || null;
}

function existingObjectMatches(row, input = {}) {
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
} = {}) {
  const storageArtifactClassifiers = normalizeArtifactClassifiers(artifactClassifiers);
  let selectedServiceManifestStore = serviceManifestStore;

  function manifestStore() {
    if (!selectedServiceManifestStore) {
      const selectedStorageRoot = path.dirname(path.dirname(getStorageDatabasePath(userDataPath)));
      selectedServiceManifestStore = createServiceManifestStore({ storageRoot: selectedStorageRoot });
    }
    return selectedServiceManifestStore;
  }

  return Object.freeze({
    protocolVersion: STORAGE_PROTOCOL_VERSION,
    getStorageKernel() {
      return storageKernel;
    },
    getStorageSummary() {
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
    getDurableManifestWriterPort() {
      return manifestStore().writerPort;
    },
    getDurableManifestReaderPort() {
      return manifestStore().readerPort;
    },
    getDurableManifestCandidateAuthorityPort() {
      const store = manifestStore();
      return createManifestCandidateAuthorityPort({
        getCandidateSnapshot: store.getCandidateSnapshot,
        acknowledgePublished: store.acknowledgePublished
      });
    },
    async putObject(input = {}) {
      const storedObject = await putStoredObject({
        userDataPath,
        ...input
      });
      try {
        recordStoredObject(storageKernel?.db, storedObject);
        return storedObject;
      } catch (error) {
        await removeUnreferencedStoredObject(storageKernel?.db, userDataPath, storedObject);
        throw error;
      }
    },
    async putObjectsFromFiles(inputs = []) {
      if (!storageKernel?.db) {
        const error = new Error("Storage kernel is required for durable file persistence.");
        error.code = "storage_kernel_required";
        throw error;
      }
      const normalizedInputs = Array.isArray(inputs) ? inputs : [];
      const stored = [];
      const newlyCreated = [];
      try {
        for (const input of normalizedInputs) {
          const existing = storedObjectRow(storageKernel.db, input?.objectId);
          if (existing) {
            if (!existingObjectMatches(existing, input)) {
              const error = new Error("Stable storage object identity conflicts with persisted content.");
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
        const persistBatch = storageKernel.db.transaction((objects) => {
          for (const object of objects) {
            recordStoredObject(storageKernel.db, object);
          }
        });
        persistBatch(stored);
        return stored;
      } catch (error) {
        await Promise.all(newlyCreated.map((object) =>
          removeUnreferencedStoredObject(storageKernel.db, userDataPath, object)
        ));
        throw error;
      }
    },
    getObject(objectId) {
      const row = storedObjectRow(storageKernel?.db, String(objectId || "").trim());
      return row ? objectFromRow(row) : null;
    },
    findObjectOwner(ownerId) {
      return publicOwnerRow(ownerRow(storageKernel?.db, ownerId));
    },
    listObjectStoragePathsByOwner(ownerId) {
      return objectRowsByOwner(storageKernel?.db, ownerId)
        .map((row) => String(row.storage_rel_path || "").trim())
        .filter(Boolean);
    },
    getObjectOwnerArtifactPaths() {
      return {
        objectRootPath: getObjectRootPath(userDataPath),
        objectBatchPath: ""
      };
    },
    deleteObjectRecordsByOwner(ownerId) {
      const rows = objectRowsByOwner(storageKernel?.db, ownerId);
      if (rows.length === 0) return 0;
      const removeRecords = storageKernel.db.transaction((objectIds) => {
        const statement = storageKernel.db.prepare("DELETE FROM storage_objects WHERE object_id = ?");
        for (const objectId of objectIds) statement.run(objectId);
      });
      removeRecords(rows.map((row) => row.object_id));
      return rows.length;
    },
    getDeletionOperationByOwnerId(ownerId) {
      return deletionOperationFromRow(deletionOperationRowByOwner(storageKernel?.db, ownerId));
    },
    upsertDeletionOperation(input = {}) {
      const ownerId = String(input.ownerId || input.batchId || "").trim();
      if (!ownerId) {
        throw new Error("Storage deletion owner id is required.");
      }
      const existing = deletionOperationRowByOwner(storageKernel?.db, ownerId);
      if (existing) return deletionOperationFromRow(existing);
      const operationId = String(input.operationId || randomUUID());
      const timestamp = nowIso();
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
    updateDeletionOperation(operationId, patch = {}) {
      const existing = deletionOperationFromRow(
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
    deleteDeletionOperation(operationId) {
      return storageKernel?.db
        ?.prepare("DELETE FROM storage_deletion_operations WHERE operation_id = ?")
        .run(String(operationId || "").trim()).changes || 0;
    },
    listPendingDeletionOperations() {
      if (!storageKernel?.db) return [];
      return storageKernel.db.prepare(`
        SELECT operation_id, owner_id, job_id, status, state_json,
               error, created_at, updated_at
        FROM storage_deletion_operations
        ORDER BY updated_at ASC, operation_id ASC
      `).all().map(deletionOperationFromRow);
    },
    readObject(input = {}) {
      return readStoredObject({
        userDataPath,
        storageRelativePath: input.storageRelativePath || input.storage_rel_path || ""
      });
    },
    statObject(input = {}) {
      return statStoredObject({
        userDataPath,
        storageRelativePath: input.storageRelativePath || input.storage_rel_path || ""
      });
    },
    resolveStoredObjectPath(storageRelativePath) {
      return resolveStoredObjectPath(userDataPath, storageRelativePath);
    },
    runDoctor() {
      return runStorageDoctor({ userDataPath });
    },
    reconcile(input = {}) {
      return reconcileStorage({
        userDataPath,
        apply: input.apply !== false,
        pruneOrphanObjects: input.pruneOrphanObjects === true
      });
    },
    listBackups() {
      return listStorageBackups({ userDataPath });
    },
    createBackup(input = {}) {
      return runStorageMaintenanceMutation(
        userDataPath,
        (executionContext) => createStorageBackup({
          userDataPath,
          label: input.label || "",
          artifactClassifiers: storageArtifactClassifiers,
          executionContext
        }),
        { signal: input.signal, budget: input.budget, kind: "storage.backup.create" }
      );
    },
    restoreBackupPreview(input = {}) {
      return restoreStorageBackup({
        userDataPath,
        backupId: input.backupId,
        dryRun: true,
        includePaths: input.includePaths || [],
        signal: input.signal,
        budget: input.budget
      });
    },
    restoreBackup(input = {}) {
      const shouldApply = input.confirm === true || input.apply === true;
      const execute = (executionContext = null) => restoreStorageBackup({
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
    applyBackupRetention(input = {}) {
      return runStorageMaintenanceMutation(
        userDataPath,
        (executionContext) => applyStorageBackupRetention({
          userDataPath,
          policy: input.policy,
          now: input.now,
          executionContext
        }),
        { signal: input.signal, budget: input.budget, kind: "storage.backup.retention" }
      );
    },
    listCapabilities() {
      return {
        protocolVersion: STORAGE_PROTOCOL_VERSION,
        capabilities: [
          {
            id: "storage-summary",
            kind: "projection",
            operations: ["getStorageSummary"]
          },
          {
            id: "object-store",
            kind: "blob-store",
            operations: [
              "putObject",
              "putObjectsFromFiles",
              "getObject",
              "readObject",
              "statObject",
              "resolveStoredObjectPath"
            ]
          },
          {
            id: "storage-object-ownership",
            kind: "metadata",
            operations: [
              "findObjectOwner",
              "listObjectStoragePathsByOwner",
              "deleteObjectRecordsByOwner",
              "getDeletionOperationByOwnerId",
              "upsertDeletionOperation",
              "updateDeletionOperation",
              "deleteDeletionOperation",
              "listPendingDeletionOperations"
            ]
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
        ]
      };
    }
  });
}
