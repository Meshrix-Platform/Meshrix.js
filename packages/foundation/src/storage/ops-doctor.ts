import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type Database from "better-sqlite3";
import { openSqliteDatabase } from "./sqlite-database.ts";
import {
  getObjectRootPath,
  resolveStoredObjectPath
} from "./object-store.ts";
import { getStorageDatabasePath } from "./schema-manager.ts";

type UnknownRecord = Record<string, unknown>;
type IssueRecord = Record<string, unknown>;
type IssueCollection = Record<string, IssueRecord[]>;
type ObjectFileIssues = IssueCollection & { orphanObjectFiles: Array<IssueRecord & { path: string }> };
export type StorageDoctorIssues = IssueCollection & { orphanObjectFiles: Array<IssueRecord & { path: string }> };

interface StorageObjectRow extends UnknownRecord {
  object_id: string;
  storage_rel_path: string;
  sha256: string;
  byte_size: number;
}

interface StorageOwnerRow extends UnknownRecord {
  object_id: string;
  job_id: string;
  archive_batch_id: string;
}

interface DeletionOperationRow extends UnknownRecord {
  operation_id: string;
  owner_id: string;
  job_id: string;
  status: string;
  updated_at: string;
}

interface DatabaseSnapshot {
  objects: StorageObjectRow[];
  owners: StorageOwnerRow[];
  deletionOperations: DeletionOperationRow[];
  opaqueCustodyArtifacts: UnknownRecord[];
  opaqueCustodyPromotions: UnknownRecord[];
  counts: {
    objectCount: number;
    ownedObjectCount: number;
    deletionOperationCount: number;
    opaqueCustodyArtifactCount: number;
    opaqueCustodyPromotionCount: number;
  };
}

export interface StorageOpsPaths {
  userDataPath: string;
  databasePath: string;
  jobsRootPath: string;
  objectRootPath: string;
}

export interface StorageDoctorReport extends StorageOpsPaths {
  databasePresent: boolean;
  summary: DatabaseSnapshot["counts"] & {
    objectFileCount: number;
    objectBytes: number;
    jobDirectoryCount: number;
  };
  issues: StorageDoctorIssues;
  healthy: boolean;
}

const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const HASH_BUFFER_BYTES = 64 * 1024;

export const CANONICAL_STORAGE_TABLES: readonly string[] = Object.freeze([
  "storage_objects",
  "storage_object_owners",
  "storage_deletion_operations",
  "opaque_custody_artifacts",
  "opaque_custody_promotions"
]);

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function errorCode(error: unknown): string {
  return String(record(error).code || "");
}

export function getJobsRootPath(userDataPath: string): string {
  return path.join(userDataPath, "jobs");
}

export function safePathSegment(value: unknown, label = "path segment"): string {
  const text = String(value || "").trim();
  if (!SAFE_PATH_SEGMENT_PATTERN.test(text) || text === "." || text === ".." || text.includes("/") || text.includes("\\") || text.includes(String.fromCodePoint(0))) {
    throw new Error(`Invalid ${label}.`);
  }
  return text;
}

export function toPosixRelative(basePath: string, targetPath: string): string {
  return path.relative(basePath, targetPath).split(path.sep).join("/");
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonIfExists(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function buildJobLocation(jobsRootPath: string, jobId: unknown): Promise<UnknownRecord> {
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

export async function listFilesRecursively(rootPath: string): Promise<string[]> {
  const output: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    let entries: Dirent<string>[] = [];
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

export function getOpsPaths(userDataPath: string): StorageOpsPaths {
  return {
    userDataPath,
    databasePath: getStorageDatabasePath(userDataPath),
    jobsRootPath: getJobsRootPath(userDataPath),
    objectRootPath: getObjectRootPath(userDataPath)
  };
}

export function createDatabaseHandle(
  databasePath: string,
  { readonly = false }: { readonly?: boolean } = {}
): Database.Database {
  return openSqliteDatabase(databasePath, { fileMustExist: true, readonly });
}

export function listDatabaseTables(db: Database.Database): Set<string> {
  return new Set(db.prepare<[], { name: string }>(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name ASC
  `).all().map((row) => row.name));
}

function emptySnapshot(): DatabaseSnapshot {
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

export function loadDatabaseSnapshot(
  db: Database.Database,
  tableNames: ReadonlySet<string> = listDatabaseTables(db)
): DatabaseSnapshot {
  const snapshot = emptySnapshot();
  if (tableNames.has("storage_objects")) {
    snapshot.objects = db.prepare(`
      SELECT object_id, namespace, storage_rel_path, sha256, byte_size,
             media_type, metadata_json, created_at, updated_at
      FROM storage_objects
      ORDER BY created_at ASC, object_id ASC
    `).all() as StorageObjectRow[];
  }
  if (tableNames.has("storage_object_owners")) {
    snapshot.owners = db.prepare(`
      SELECT object_id, job_id, archive_batch_id, owner_subject_id,
             owner_user_id, owner_username, created_at, updated_at
      FROM storage_object_owners
      ORDER BY created_at ASC, object_id ASC
    `).all() as StorageOwnerRow[];
  }
  if (tableNames.has("storage_deletion_operations")) {
    snapshot.deletionOperations = db.prepare(`
      SELECT operation_id, owner_id, job_id, status, state_json,
             error, created_at, updated_at
      FROM storage_deletion_operations
      ORDER BY updated_at ASC, operation_id ASC
    `).all() as DeletionOperationRow[];
  }
  if (tableNames.has("opaque_custody_artifacts")) {
    snapshot.opaqueCustodyArtifacts = db.prepare(`
      SELECT custody_ref, object_id, content_digest, envelope_digest, plaintext_bytes,
             ciphertext_bytes, chunk_count, media_type, owner_subject_ref, tenant_ref,
             workspace_ref, state, created_at, updated_at
      FROM opaque_custody_artifacts
      ORDER BY created_at ASC, custody_ref ASC
    `).all() as UnknownRecord[];
  }
  if (tableNames.has("opaque_custody_promotions")) {
    snapshot.opaqueCustodyPromotions = db.prepare(`
      SELECT promotion_id, custody_ref, request_digest, state, provider_receipt_digest,
             reason_code, created_at, updated_at
      FROM opaque_custody_promotions
      ORDER BY created_at ASC, promotion_id ASC
    `).all() as UnknownRecord[];
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

function pathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function hashFileSha256(filePath: string): Promise<string> {
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

async function inspectJobArtifacts(
  jobsRootPath: string,
  owners: readonly StorageOwnerRow[]
): Promise<{ issues: IssueCollection; jobDirectoryCount: number }> {
  const issues: IssueCollection = {
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
  let directories: Dirent<string>[] = [];
  try {
    directories = await fs.readdir(jobsRootPath, { withFileTypes: true });
  } catch {
    directories = [];
  }

  const safeDirectories = new Map<string, string>();
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    try {
      const jobId = safePathSegment(directory.name, "job id");
      safeDirectories.set(jobId, path.join(jobsRootPath, jobId));
    } catch {
      issues.invalidJobDirectories.push({ directoryName: directory.name });
    }
  }

  const ownedJobIds = new Set<string>();
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
    } else if (String(record(meta).id || "") !== jobId) {
      issues.jobIdentityMismatches.push({ jobId, metadataJobId: String(record(meta).id || ""), path: metaPath });
    }
    if (!payloadExists) {
      issues.missingJobPayload.push({ jobId, path: payloadPath });
    } else if (!payload) {
      issues.malformedJobPayload.push({ jobId, path: payloadPath });
    }
    if (record(meta).status === "completed" && !resultExists) {
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

async function inspectObjectFiles({
  userDataPath,
  objectRootPath,
  objects
}: {
  userDataPath: string;
  objectRootPath: string;
  objects: readonly StorageObjectRow[];
}): Promise<{ issues: ObjectFileIssues; objectFileCount: number; objectBytes: number }> {
  const issues: ObjectFileIssues = {
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
    let absolutePath: string;
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

    let fileStat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      fileStat = await fs.lstat(absolutePath);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") {
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

function inspectOwnershipIntegrity({
  objects,
  owners
}: {
  objects: readonly StorageObjectRow[];
  owners: readonly StorageOwnerRow[];
}): IssueCollection {
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

function inspectDeletionOperations(deletionOperations: readonly DeletionOperationRow[]): IssueCollection {
  const completedDeletionOperations: IssueRecord[] = [];
  const pendingDeletionOperations: IssueRecord[] = [];
  for (const operation of deletionOperations) {
    const entry: IssueRecord = {
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

export function summarizeHealth(issues: IssueCollection): boolean {
  return Object.values(issues).every((entries) => Array.isArray(entries) && entries.length === 0);
}

export async function runStorageDoctor({ userDataPath }: { userDataPath: string }): Promise<StorageDoctorReport> {
  const paths = getOpsPaths(userDataPath);
  const databasePresent = await pathExists(paths.databasePath);
  let tableNames = new Set<string>();
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
  const issues: StorageDoctorIssues = {
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
