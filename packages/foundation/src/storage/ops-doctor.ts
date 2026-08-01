import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { openSqliteDatabase } from "./sqlite-database.ts";
import {
  getObjectRootPath,
  resolveStoredObjectPath
} from "./object-store.ts";
import { getStorageDatabasePath } from "./schema-manager.ts";

const SAFE_PATH_SEGMENT_PATTERN: any = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN: any = /^[a-f0-9]{64}$/u;
const HASH_BUFFER_BYTES: any = 64 * 1024;

export const CANONICAL_STORAGE_TABLES: readonly any[] = Object.freeze([
  "storage_objects",
  "storage_object_owners",
  "storage_deletion_operations",
  "opaque_custody_artifacts",
  "opaque_custody_promotions"
]);

export function getJobsRootPath(userDataPath?: any) : any {
  return path.join(userDataPath, "jobs");
}

export function safePathSegment(value?: any, label: any = "path segment") : any {
  const text: any = String(value || "").trim();
  if (!SAFE_PATH_SEGMENT_PATTERN.test(text) || text === "." || text === ".." || text.includes("/") || text.includes("\\") || text.includes("\0")) {
    throw new Error(`Invalid ${label}.`);
  }
  return text;
}

export function toPosixRelative(basePath?: any, targetPath?: any) : any {
  return path.relative(basePath, targetPath).split(path.sep).join("/");
}

export async function pathExists(targetPath?: any) : Promise<any> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonIfExists(filePath?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function buildJobLocation(jobsRootPath?: any, jobId?: any) : Promise<any> {
  const safeJobId: any = safePathSegment(jobId, "job id");
  const jobDirectory: any = path.join(jobsRootPath, safeJobId);
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

export async function listFilesRecursively(rootPath?: any) : Promise<any> {
  const output: any[] = [];

  async function walk(currentPath?: any) : Promise<any> {
    let entries: any[] = [];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath: any = path.join(currentPath, entry.name);
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

export function getOpsPaths(userDataPath?: any) : any {
  return {
    userDataPath,
    databasePath: getStorageDatabasePath(userDataPath),
    jobsRootPath: getJobsRootPath(userDataPath),
    objectRootPath: getObjectRootPath(userDataPath)
  };
}

export function createDatabaseHandle(databasePath?: any, { readonly = false }: Record<string, any> = {}) : any {
  return openSqliteDatabase(databasePath, { fileMustExist: true, readonly });
}

export function listDatabaseTables(db?: any) : any {
  return new Set<any>(db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name ASC
  `).all().map((row?: any) : any => row.name));
}

function emptySnapshot() : any {
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

export function loadDatabaseSnapshot(db?: any, tableNames: any = listDatabaseTables(db)) : any {
  const snapshot: any = emptySnapshot();
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

function pathWithinRoot(candidatePath?: any, rootPath?: any) : any {
  const relative: any = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function hashFileSha256(filePath?: any) : Promise<any> {
  const handle: any = await fs.open(filePath, "r");
  const digest: any = createHash("sha256");
  const buffer: any = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
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

async function inspectJobArtifacts(jobsRootPath?: any, owners?: any) : Promise<any> {
  const issues: Record<string, any> = {
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
  let directories: any[] = [];
  try {
    directories = await fs.readdir(jobsRootPath, { withFileTypes: true });
  } catch {
    directories = [];
  }

  const safeDirectories: any = new Map<any, any>();
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    try {
      const jobId: any = safePathSegment(directory.name, "job id");
      safeDirectories.set(jobId, path.join(jobsRootPath, jobId));
    } catch {
      issues.invalidJobDirectories.push({ directoryName: directory.name });
    }
  }

  const ownedJobIds: any = new Set<any>();
  for (const owner of owners) {
    const candidate: any = String(owner.job_id || "").trim();
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
    const metaPath: any = path.join(directoryPath, "meta.json");
    const payloadPath: any = path.join(directoryPath, "payload.json");
    const resultPath: any = path.join(directoryPath, "result.json");
    const metaExists: any = await pathExists(metaPath);
    const payloadExists: any = await pathExists(payloadPath);
    const resultExists: any = await pathExists(resultPath);
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

async function inspectObjectFiles({ userDataPath, objectRootPath, objects }: Record<string, any>) : Promise<any> {
  const issues: Record<string, any> = {
    invalidObjectPaths: [],
    unsafeObjectFiles: [],
    missingObjectFiles: [],
    unreadableObjectFiles: [],
    objectSizeMismatches: [],
    invalidObjectDigests: [],
    objectDigestMismatches: [],
    orphanObjectFiles: []
  };
  const expectedRelativePaths: any = new Set<any>(
    objects.map((row?: any) : any => String(row.storage_rel_path || "").trim()).filter(Boolean)
  );
  const realObjectRootPath: any = await fs.realpath(objectRootPath).catch(() : any => path.resolve(objectRootPath));

  for (const row of objects) {
    let absolutePath: any;
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

    let fileStat: any;
    try {
      fileStat = await fs.lstat(absolutePath);
    } catch (error: any) {
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
    const realObjectPath: any = await fs.realpath(absolutePath).catch(() : any => "");
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
    const expectedDigest: any = String(row.sha256 || "").trim().toLowerCase();
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

  const objectFiles: any = await listFilesRecursively(objectRootPath);
  let objectBytes: any = 0;
  for (const filePath of objectFiles) {
    const relativePath: any = toPosixRelative(userDataPath, filePath);
    const stat: any = await fs.lstat(filePath).catch(() : any => null);
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

function inspectOwnershipIntegrity({ objects, owners }: Record<string, any>) : any {
  const objectIds: any = new Set<any>(objects.map((row?: any) : any => row.object_id));
  return {
    danglingObjectOwners: owners
      .filter((owner?: any) : any => !objectIds.has(owner.object_id))
      .map((owner?: any) : any => ({ objectId: owner.object_id, jobId: owner.job_id })),
    unscopedObjectOwners: owners
      .filter((owner?: any) : any => !owner.job_id && !owner.archive_batch_id)
      .map((owner?: any) : any => ({ objectId: owner.object_id }))
  };
}

function inspectDeletionOperations(deletionOperations?: any) : any {
  const completedDeletionOperations: any[] = [];
  const pendingDeletionOperations: any[] = [];
  for (const operation of deletionOperations) {
    const entry: Record<string, any> = {
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

export function summarizeHealth(issues?: any) : any {
  return (Object.values(issues) as any[]).every((entries?: any) : any => Array.isArray(entries) && entries.length === 0);
}

export async function runStorageDoctor({ userDataPath }: Record<string, any>) : Promise<any> {
  const paths: any = getOpsPaths(userDataPath);
  const databasePresent: any = await pathExists(paths.databasePath);
  let tableNames: any = new Set<any>();
  let snapshot: any = emptySnapshot();

  if (databasePresent) {
    const db: any = createDatabaseHandle(paths.databasePath, { readonly: true });
    try {
      tableNames = listDatabaseTables(db);
      snapshot = loadDatabaseSnapshot(db, tableNames);
    } finally {
      db.close();
    }
  }

  const jobInspection: any = await inspectJobArtifacts(paths.jobsRootPath, snapshot.owners);
  const objectInspection: any = await inspectObjectFiles({
    userDataPath,
    objectRootPath: paths.objectRootPath,
    objects: snapshot.objects
  });
  const issues: Record<string, any> = {
    databaseMissing: databasePresent ? [] : [{ databasePath: paths.databasePath }],
    missingCanonicalTables: databasePresent
      ? CANONICAL_STORAGE_TABLES.filter((tableName?: any) : any => !tableNames.has(tableName))
          .map((tableName?: any) : any => ({ tableName }))
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
