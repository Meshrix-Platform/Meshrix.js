import fs from "node:fs/promises";
import {
  buildJobLocation,
  createDatabaseHandle,
  getOpsPaths,
  listDatabaseTables,
  pathExists,
  runStorageDoctor
} from "./ops-doctor.mjs";
import { resolveStoredObjectPath } from "./object-store.mjs";

export { runStorageDoctor } from "./ops-doctor.mjs";

function parseMetadata(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function publicObject(row, userDataPath) {
  if (!row) return null;
  const storageRelativePath = String(row.storage_rel_path || "").trim();
  let absolutePath = "";
  try {
    absolutePath = resolveStoredObjectPath(userDataPath, storageRelativePath);
  } catch {
    absolutePath = "";
  }
  return {
    objectId: row.object_id,
    namespace: row.namespace,
    storageRelativePath,
    sha256: row.sha256,
    byteSize: Number(row.byte_size || 0),
    mediaType: row.media_type,
    metadata: parseMetadata(row.metadata_json),
    jobId: row.job_id || "",
    archiveBatchId: row.archive_batch_id || "",
    ownerSubjectId: row.owner_subject_id || "",
    ownerUserId: row.owner_user_id || "",
    ownerUsername: row.owner_username || "",
    path: absolutePath
  };
}

function objectSelectionSql(whereClause) {
  return `
    SELECT objects.object_id, objects.namespace, objects.storage_rel_path,
           objects.sha256, objects.byte_size, objects.media_type,
           objects.metadata_json, owners.job_id, owners.archive_batch_id,
           owners.owner_subject_id, owners.owner_user_id, owners.owner_username
    FROM storage_objects AS objects
    LEFT JOIN storage_object_owners AS owners
      ON owners.object_id = objects.object_id
    ${whereClause}
  `;
}

export async function locateStorageEntity({ userDataPath, jobId = "", batchId = "", objectId = "" }) {
  const paths = getOpsPaths(userDataPath);
  const databasePresent = await pathExists(paths.databasePath);
  const jobsRootPresent = await pathExists(paths.jobsRootPath);
  const objectRootPresent = await pathExists(paths.objectRootPath);
  const normalizedJobId = String(jobId || "").trim();
  const normalizedBatchId = String(batchId || "").trim();
  const normalizedObjectId = String(objectId || "").trim();

  if (!normalizedJobId && !normalizedBatchId && !normalizedObjectId) {
    throw new Error("至少需要提供 --job-id、--batch-id 或 --object-id 其中一个参数。");
  }

  const result = {
    ...paths,
    databasePresent,
    jobsRootPresent,
    objectRootPresent,
    query: {
      jobId: normalizedJobId,
      batchId: normalizedBatchId,
      objectId: normalizedObjectId
    }
  };
  if (normalizedJobId) {
    result.job = await buildJobLocation(paths.jobsRootPath, normalizedJobId);
  }
  if (!databasePresent) return result;

  const db = createDatabaseHandle(paths.databasePath, { readonly: true });
  try {
    const tables = listDatabaseTables(db);
    const objectTablesPresent = tables.has("storage_objects") && tables.has("storage_object_owners");
    if ((normalizedJobId || normalizedBatchId) && objectTablesPresent) {
      const rows = db.prepare(`${objectSelectionSql(`
        WHERE (? <> '' AND owners.job_id = ?)
           OR (? <> '' AND owners.archive_batch_id = ?)
      `)} ORDER BY objects.created_at ASC, objects.object_id ASC LIMIT 20`).all(
        normalizedJobId,
        normalizedJobId,
        normalizedBatchId,
        normalizedBatchId
      );
      if (rows.length > 0) {
        const owner = rows[0];
        const effectiveJobId = normalizedJobId || owner.job_id || "";
        if (effectiveJobId) {
          result.job = await buildJobLocation(paths.jobsRootPath, effectiveJobId);
        }
        result.ownership = {
          jobId: owner.job_id || "",
          archiveBatchId: owner.archive_batch_id || "",
          objectCount: db.prepare(`
            SELECT COUNT(*) AS count
            FROM storage_object_owners
            WHERE (? <> '' AND job_id = ?)
               OR (? <> '' AND archive_batch_id = ?)
          `).get(
            normalizedJobId,
            normalizedJobId,
            normalizedBatchId,
            normalizedBatchId
          )?.count || 0,
          sampleObjects: rows.map((row) => publicObject(row, userDataPath))
        };
        if (tables.has("storage_deletion_operations")) {
          const ownerId = owner.archive_batch_id || owner.job_id;
          result.ownership.deletionOperation = ownerId
            ? db.prepare(`
                SELECT operation_id, owner_id, job_id, status, error, updated_at
                FROM storage_deletion_operations
                WHERE owner_id = ?
                LIMIT 1
              `).get(ownerId) || null
            : null;
        }
      }
    }

    if (normalizedObjectId && tables.has("storage_objects")) {
      const joinsAvailable = tables.has("storage_object_owners");
      const row = joinsAvailable
        ? db.prepare(`${objectSelectionSql("WHERE objects.object_id = ?")} LIMIT 1`).get(normalizedObjectId)
        : db.prepare(`
            SELECT object_id, namespace, storage_rel_path, sha256, byte_size,
                   media_type, metadata_json, '' AS job_id, '' AS archive_batch_id,
                   '' AS owner_subject_id, '' AS owner_user_id, '' AS owner_username
            FROM storage_objects
            WHERE object_id = ?
            LIMIT 1
          `).get(normalizedObjectId);
      if (row) {
        result.object = publicObject(row, userDataPath);
        result.object.exists = result.object.path
          ? await pathExists(result.object.path)
          : false;
      }
    }
    return result;
  } finally {
    db.close();
  }
}

function countIssue(doctor, name) {
  return Array.isArray(doctor?.issues?.[name]) ? doctor.issues[name].length : 0;
}

export async function reconcileStorage({
  userDataPath,
  apply = false,
  pruneOrphanObjects = false
}) {
  const doctor = await runStorageDoctor({ userDataPath });
  const report = {
    userDataPath,
    apply,
    pruneOrphanObjects,
    databasePresent: doctor.databasePresent,
    plannedActions: {
      removeCompletedDeletionOperations: countIssue(doctor, "completedDeletionOperations"),
      pruneOrphanObjectFiles: pruneOrphanObjects ? countIssue(doctor, "orphanObjectFiles") : 0
    },
    appliedActions: {
      removedCompletedDeletionOperations: 0,
      prunedOrphanObjectFiles: 0
    },
    unresolvedIssues: {
      missingCanonicalTables: countIssue(doctor, "missingCanonicalTables"),
      missingOwnedJobDirectories: countIssue(doctor, "missingOwnedJobDirectories"),
      missingJobMeta: countIssue(doctor, "missingJobMeta"),
      malformedJobMeta: countIssue(doctor, "malformedJobMeta"),
      missingJobPayload: countIssue(doctor, "missingJobPayload"),
      malformedJobPayload: countIssue(doctor, "malformedJobPayload"),
      missingJobResult: countIssue(doctor, "missingJobResult"),
      malformedJobResult: countIssue(doctor, "malformedJobResult"),
      missingObjectFiles: countIssue(doctor, "missingObjectFiles"),
      unsafeObjectFiles: countIssue(doctor, "unsafeObjectFiles"),
      unreadableObjectFiles: countIssue(doctor, "unreadableObjectFiles"),
      objectSizeMismatches: countIssue(doctor, "objectSizeMismatches"),
      invalidObjectDigests: countIssue(doctor, "invalidObjectDigests"),
      objectDigestMismatches: countIssue(doctor, "objectDigestMismatches"),
      danglingObjectOwners: countIssue(doctor, "danglingObjectOwners"),
      unscopedObjectOwners: countIssue(doctor, "unscopedObjectOwners"),
      pendingDeletionOperations: countIssue(doctor, "pendingDeletionOperations")
    }
  };

  if (!apply) {
    return {
      ...report,
      healthyAfter: doctor.healthy,
      doctor
    };
  }

  if (doctor.databasePresent && report.plannedActions.removeCompletedDeletionOperations > 0) {
    const db = createDatabaseHandle(doctor.databasePath);
    try {
      if (listDatabaseTables(db).has("storage_deletion_operations")) {
        report.appliedActions.removedCompletedDeletionOperations = db
          .prepare("DELETE FROM storage_deletion_operations WHERE status = 'completed'")
          .run().changes;
      }
    } finally {
      db.close();
    }
  }

  if (pruneOrphanObjects) {
    for (const orphan of doctor.issues.orphanObjectFiles) {
      try {
        await fs.rm(orphan.path, { force: true });
        report.appliedActions.prunedOrphanObjectFiles += 1;
      } catch {
        // Orphan cleanup is best-effort and remains visible in the follow-up doctor report.
      }
    }
  }

  const afterDoctor = await runStorageDoctor({ userDataPath });
  return {
    ...report,
    healthyAfter: afterDoctor.healthy,
    doctor: afterDoctor
  };
}
