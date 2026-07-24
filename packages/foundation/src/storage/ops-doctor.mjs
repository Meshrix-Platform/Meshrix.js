import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { openSqliteDatabase } from "./sqlite-database.mjs";
import {
  getObjectRootPath,
  resolveStoredObjectPath
} from "./object-store.mjs";
import { getStorageDatabasePath } from "./schema-manager.mjs";

const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const HASH_BUFFER_BYTES = 64 * 1024;

export const CANONICAL_STORAGE_TABLES = Object.freeze([
  "storage_objects",
  "storage_object_owners",
  "storage_deletion_operations",
  "opaque_custody_artifacts",
  "opaque_custody_promotions"
]);

export function getJobsRootPath(userDataPath) {
  return path.join(userDataPath, "jobs");
}

export function safePathSegment(value, label = "path segment") {
  const text = String(value || "").trim();
  if (!SAFE_PATH_SEGMENT_PATTERN.test(text) || text === "." || text === ".." || text.includes("/") || text.includes("\\") || text.includes("\0")) {
    throw new Error(`Invalid ${label}.`);
  }
  return text;
}

export function toPosixRelative(basePath, targetPath) {
  return path.relative(basePath, targetPath).split(path.sep).join("/");
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function buildJobLocation(jobsRootPath, jobId) {
  const safeJobId = safePathSegment(jobId, "job id");
  const jobDirectory = path.join(jobsRootPath, safeJobId);
  return {
    jobId: safeJobId,
    directoryPath: jobDirectory,
    metaPath: path.join(jobDirectory, "meta.json"),
    payloadPath: path.join(jobDirectory, "payload.json"),
    resultPath: path.join(jobDirectory, "result.json"),
    meta: await readJsonIfExists(path.join(jobDirectory, "meta.json")),
    payload: await readJsonIfExists(path.join(jobDirectory, "payload.json")),
    result: await readJsonIfExists(path.join(jobDirectory, "result.json"))
  };
}

export async function listFilesRecursively(rootPath) {
  const output = [];

  async function walk(currentPath) {
    let entries = [];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        output.push(absolutePath);
      }
    }
  }

  await walk(rootPath);
  return output;
}

export function getOpsPaths(userDataPath) {
  return {
    userDataPath,
    databasePath: getStorageDatabasePath(userDataPath),
    jobsRootPath: getJobsRootPath(userDataPath),
    objectRootPath: getObjectRootPath(userDataPath)
  };
}

export function createDatabaseHandle(databasePath, { readonly = false } = {}) {
  return openSqliteDatabase(databasePath, { fileMustExist: true, readonly });
}

export function listDatabaseTables(db) {
  return new Set(db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name ASC
  `).all().map((row) => row.name));
}

function emptySnapshot() {
  return {
    objects: [],
    owners: [],
    deletionOperations: [],
    opaqueCustodyArtifacts: [],
    opaqueCustodyPromotions: [],
    counts: {
      objectCount: 0,
      ownedObjectCount: 0,
      deletionOperationCount: 0,
      opaqueCustodyArtifactCount: 0,
      opaqueCustodyPromotionCount: 0
    }
  };
}

export function loadDatabaseSnapshot(db, tableNames = listDatabaseTables(db)) {
  const snapshot = emptySnapshot();
  if (tableNames.has("storage_objects")) {
    snapshot.objects = db.prepare(`
      SELECT object_id, namespace, storage_rel_path, sha256, byte_size,
             media_type, metadata_json, created_at, updated_at
      FROM storage_objects
      ORDER BY created_at ASC, object_id ASC
    `).all();
  }
  if (tableNames.has("storage_object_owners")) {
    snapshot.owners = db.prepare(`
      SELECT object_id, job_id, archive_batch_id, owner_subject_id,
             owner_user_id, owner_username, created_at, updated_at
      FROM storage_object_owners
      ORDER BY created_at ASC, object_id ASC
    `).all();
  }
  if (tableNames.has("storage_deletion_operations")) {
    snapshot.deletionOperations = db.prepare(`
      SELECT operation_id, owner_id, job_id, status, state_json,
             error, created_at, updated_at
      FROM storage_deletion_operations
      ORDER BY updated_at ASC, operation_id ASC
    `).all();
  }
  if (tableNames.has("opaque_custody_artifacts")) {
    snapshot.opaqueCustodyArtifacts = db.prepare(`
      SELECT custody_ref, object_id, content_digest, envelope_digest, plaintext_bytes,
             ciphertext_bytes, chunk_count, media_type, owner_subject_ref, tenant_ref,
             workspace_ref, state, created_at, updated_at
      FROM opaque_custody_artifacts
      ORDER BY created_at ASC, custody_ref ASC
    `).all();
  }
  if (tableNames.has("opaque_custody_promotions")) {
    snapshot.opaqueCustodyPromotions = db.prepare(`
      SELECT promotion_id, custody_ref, request_digest, state, provider_receipt_digest,
             reason_code, created_at, updated_at
      FROM opaque_custody_promotions
      ORDER BY created_at ASC, promotion_id ASC
    `).all();
  }
  snapshot.counts = {
    objectCount: snapshot.objects.length,
    ownedObjectCount: snapshot.owners.length,
    deletionOperationCount: snapshot.deletionOperations.length,
    opaqueCustodyArtifactCount: snapshot.opaqueCustodyArtifacts.length,
    opaqueCustodyPromotionCount: snapshot.opaqueCustodyPromotions.length
  };
  return snapshot;
}

function pathWithinRoot(candidatePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function hashFileSha256(filePath) {
  const handle = await fs.open(filePath, "r");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

async function inspectJobArtifacts(jobsRootPath, owners) {
  const issues = {
    invalidJobDirectories: [],
    invalidOwnedJobIds: [],
    missingOwnedJobDirectories: [],
    missingJobMeta: [],
    malformedJobMeta: [],
    jobIdentityMismatches: [],
    missingJobPayload: [],
    malformedJobPayload: [],
    missingJobResult: [],
    malformedJobResult: []
  };
  let directories = [];
  try {
    directories = await fs.readdir(jobsRootPath, { withFileTypes: true });
  } catch {
    directories = [];
  }

  const safeDirectories = new Map();
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    try {
      const jobId = safePathSegment(directory.name, "job id");
      safeDirectories.set(jobId, path.join(jobsRootPath, jobId));
    } catch {
      issues.invalidJobDirectories.push({ directoryName: directory.name });
    }
  }

  const ownedJobIds = new Set();
  for (const owner of owners) {
    const candidate = String(owner.job_id || "").trim();
    if (!candidate) continue;
    try {
      ownedJobIds.add(safePathSegment(candidate, "job id"));
    } catch {
      issues.invalidOwnedJobIds.push({ objectId: owner.object_id, jobId: candidate });
    }
  }
  for (const jobId of ownedJobIds) {
    if (!safeDirectories.has(jobId)) {
      issues.missingOwnedJobDirectories.push({ jobId });
    }
  }

  for (const [jobId, directoryPath] of safeDirectories) {
    const metaPath = path.join(directoryPath, "meta.json");
    const payloadPath = path.join(directoryPath, "payload.json");
    const resultPath = path.join(directoryPath, "result.json");
    const metaExists = await pathExists(metaPath);
    const payloadExists = await pathExists(payloadPath);
    const resultExists = await pathExists(resultPath);
    const [meta, payload, result] = await Promise.all([
      metaExists ? readJsonIfExists(metaPath) : null,
      payloadExists ? readJsonIfExists(payloadPath) : null,
      resultExists ? readJsonIfExists(resultPath) : null
    ]);

    if (!metaExists) {
      issues.missingJobMeta.push({ jobId, path: metaPath });
    } else if (!meta) {
      issues.malformedJobMeta.push({ jobId, path: metaPath });
    } else if (String(meta.id || "") !== jobId) {
      issues.jobIdentityMismatches.push({ jobId, metadataJobId: String(meta.id || ""), path: metaPath });
    }
    if (!payloadExists) {
      issues.missingJobPayload.push({ jobId, path: payloadPath });
    } else if (!payload) {
      issues.malformedJobPayload.push({ jobId, path: payloadPath });
    }
    if (meta?.status === "completed" && !resultExists) {
      issues.missingJobResult.push({ jobId, path: resultPath });
    } else if (resultExists && !result) {
      issues.malformedJobResult.push({ jobId, path: resultPath });
    }
  }

  return {
    issues,
    jobDirectoryCount: safeDirectories.size
  };
}

async function inspectObjectFiles({ userDataPath, objectRootPath, objects }) {
  const issues = {
    invalidObjectPaths: [],
    unsafeObjectFiles: [],
    missingObjectFiles: [],
    unreadableObjectFiles: [],
    objectSizeMismatches: [],
    invalidObjectDigests: [],
    objectDigestMismatches: [],
    orphanObjectFiles: []
  };
  const expectedRelativePaths = new Set(
    objects.map((row) => String(row.storage_rel_path || "").trim()).filter(Boolean)
  );
  const realObjectRootPath = await fs.realpath(objectRootPath).catch(() => path.resolve(objectRootPath));

  for (const row of objects) {
    let absolutePath;
    try {
      absolutePath = resolveStoredObjectPath(userDataPath, row.storage_rel_path);
      if (!pathWithinRoot(absolutePath, objectRootPath)) {
        throw new Error("outside object root");
      }
    } catch {
      issues.invalidObjectPaths.push({
        objectId: row.object_id,
        storageRelativePath: row.storage_rel_path
      });
      continue;
    }

    let fileStat;
    try {
      fileStat = await fs.lstat(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        issues.missingObjectFiles.push({
          objectId: row.object_id,
          storageRelativePath: row.storage_rel_path,
          path: absolutePath
        });
      } else {
        issues.unreadableObjectFiles.push({
          objectId: row.object_id,
          storageRelativePath: row.storage_rel_path,
          path: absolutePath
        });
      }
      continue;
    }
    const realObjectPath = await fs.realpath(absolutePath).catch(() => "");
    if (!fileStat.isFile() || !realObjectPath || !pathWithinRoot(realObjectPath, realObjectRootPath)) {
      issues.unsafeObjectFiles.push({
        objectId: row.object_id,
        storageRelativePath: row.storage_rel_path,
        path: absolutePath
      });
      continue;
    }
    if (fileStat.size !== Number(row.byte_size || 0)) {
      issues.objectSizeMismatches.push({
        objectId: row.object_id,
        storageRelativePath: row.storage_rel_path,
        expectedByteSize: Number(row.byte_size || 0),
        actualByteSize: fileStat.size
      });
      continue;
    }
    const expectedDigest = String(row.sha256 || "").trim().toLowerCase();
    if (!SHA256_PATTERN.test(expectedDigest)) {
      issues.invalidObjectDigests.push({
        objectId: row.object_id,
        storageRelativePath: row.storage_rel_path
      });
      continue;
    }
    try {
      if (await hashFileSha256(absolutePath) !== expectedDigest) {
        issues.objectDigestMismatches.push({
          objectId: row.object_id,
          storageRelativePath: row.storage_rel_path
        });
      }
    } catch {
      issues.unreadableObjectFiles.push({
        objectId: row.object_id,
        storageRelativePath: row.storage_rel_path,
        path: absolutePath
      });
    }
  }

  const objectFiles = await listFilesRecursively(objectRootPath);
  let objectBytes = 0;
  for (const filePath of objectFiles) {
    const relativePath = toPosixRelative(userDataPath, filePath);
    const stat = await fs.lstat(filePath).catch(() => null);
    objectBytes += stat?.size || 0;
    if (!expectedRelativePaths.has(relativePath)) {
      issues.orphanObjectFiles.push({
        storageRelativePath: relativePath,
        path: filePath
      });
    }
  }

  return {
    issues,
    objectFileCount: objectFiles.length,
    objectBytes
  };
}

function inspectOwnershipIntegrity({ objects, owners }) {
  const objectIds = new Set(objects.map((row) => row.object_id));
  return {
    danglingObjectOwners: owners
      .filter((owner) => !objectIds.has(owner.object_id))
      .map((owner) => ({ objectId: owner.object_id, jobId: owner.job_id })),
    unscopedObjectOwners: owners
      .filter((owner) => !owner.job_id && !owner.archive_batch_id)
      .map((owner) => ({ objectId: owner.object_id }))
  };
}

function inspectDeletionOperations(deletionOperations) {
  const completedDeletionOperations = [];
  const pendingDeletionOperations = [];
  for (const operation of deletionOperations) {
    const entry = {
      operationId: operation.operation_id,
      ownerId: operation.owner_id,
      jobId: operation.job_id,
      status: operation.status,
      updatedAt: operation.updated_at
    };
    if (operation.status === "completed") {
      completedDeletionOperations.push(entry);
    } else {
      pendingDeletionOperations.push(entry);
    }
  }
  return { completedDeletionOperations, pendingDeletionOperations };
}

export function summarizeHealth(issues) {
  return Object.values(issues).every((entries) => Array.isArray(entries) && entries.length === 0);
}

export async function runStorageDoctor({ userDataPath }) {
  const paths = getOpsPaths(userDataPath);
  const databasePresent = await pathExists(paths.databasePath);
  let tableNames = new Set();
  let snapshot = emptySnapshot();

  if (databasePresent) {
    const db = createDatabaseHandle(paths.databasePath, { readonly: true });
    try {
      tableNames = listDatabaseTables(db);
      snapshot = loadDatabaseSnapshot(db, tableNames);
    } finally {
      db.close();
    }
  }

  const jobInspection = await inspectJobArtifacts(paths.jobsRootPath, snapshot.owners);
  const objectInspection = await inspectObjectFiles({
    userDataPath,
    objectRootPath: paths.objectRootPath,
    objects: snapshot.objects
  });
  const issues = {
    databaseMissing: databasePresent ? [] : [{ databasePath: paths.databasePath }],
    missingCanonicalTables: databasePresent
      ? CANONICAL_STORAGE_TABLES.filter((tableName) => !tableNames.has(tableName))
          .map((tableName) => ({ tableName }))
      : [],
    ...jobInspection.issues,
    ...objectInspection.issues,
    ...inspectOwnershipIntegrity(snapshot),
    ...inspectDeletionOperations(snapshot.deletionOperations)
  };

  return {
    ...paths,
    databasePresent,
    summary: {
      ...snapshot.counts,
      objectFileCount: objectInspection.objectFileCount,
      objectBytes: objectInspection.objectBytes,
      jobDirectoryCount: jobInspection.jobDirectoryCount
    },
    issues,
    healthy: summarizeHealth(issues)
  };
}
