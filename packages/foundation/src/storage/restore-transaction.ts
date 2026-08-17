import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { BigIntStats, Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type Database from "better-sqlite3";
import { openSqliteDatabase } from "./sqlite-database.ts";
import { ServerConfig } from "#meshrix/server-config";
import { backupRoot as resolveBackupRoot } from "./backup-contract.ts";

type JsonRecord = Record<string, unknown>;
type RestoreOperation = "install" | "delete";
type RestorePhase = "prepared" | "rollback-required" | "commit-complete";
type RestoreError = Error & { code: string; reasonCode: string };

interface RestoreRecord {
  relativePath: string;
  operation: RestoreOperation;
  hadOriginal: boolean;
  previousBytes: number;
  previousSha256: string;
  installedBytes: number;
  installedSha256: string;
  sqlite: boolean;
}

interface RestoreJournal {
  schemaVersion: typeof TRANSACTION_SCHEMA_VERSION;
  protocol: typeof TRANSACTION_PROTOCOL;
  transactionId: string;
  backupId: string;
  receiptId: string;
  receiptSha256: string;
  phase: RestorePhase;
  records: readonly RestoreRecord[];
}

interface TransactionPaths {
  temporaryRoot: string;
  pendingRoot: string;
  transactionRoot: string;
}

interface TransactionContents {
  journalPath: string;
  stagedFilesRoot: string;
  rollbackRoot: string;
  stagedReceiptPath: string;
}

interface FileIntegrity {
  bytes: number;
  sha256: string;
}

interface RestoreExecutionOptions {
  userDataPath?: string;
  backupId?: unknown;
  receiptId?: unknown;
  report?: unknown;
  records?: readonly (JsonRecord | RestoreRecord)[];
  stageInstall?: (record: RestoreRecord, stagedPath: string) => Promise<void>;
}

const TRANSACTION_SCHEMA_VERSION = "v0.0.1:schema:definition-1";
const TRANSACTION_PROTOCOL = "v0.0.1:storage:restore-transaction-1";
const TRANSACTION_DIRECTORY = "tmp";
const JOURNAL_FILE = "restore-transaction.json";
const STAGED_FILES_DIRECTORY = "files";
const ROLLBACK_DIRECTORY = "rollback";
const STAGED_RECEIPT_FILE = "restore-receipt.json";
const RESTORE_REPORT_DIRECTORY = "restore-reports";
const SQLITE_SIDECAR_SUFFIXES: readonly string[] = Object.freeze(["-wal", "-shm", "-journal"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BACKUP_ID_PATTERN = /^backup_[A-Za-z0-9_.-]+$/u;
const RECEIPT_ID_PATTERN = /^restore_[A-Za-z0-9_.-]+$/u;
const EXCLUDED_TARGET_ROOTS = new Set<string>(["backups", "locks", "logs", TRANSACTION_DIRECTORY]);
const PHASES = new Set<RestorePhase>(["prepared", "rollback-required", "commit-complete"]);

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function errorCode(error: unknown): string {
  return String(record(error).code || "");
}

function isSqliteTarget(relativePath: unknown = ""): boolean {
  const value = String(relativePath || "").toLowerCase();
  return value.endsWith(".sqlite") || value.endsWith(".sqlite3") || value.endsWith(".db");
}

function transactionError(code: string, message: string, cause?: unknown): RestoreError {
  const error = new Error(message, cause ? { cause } : undefined) as RestoreError;
  error.name = "StorageRestoreTransactionError";
  error.code = code;
  error.reasonCode = code;
  return error;
}

function storageRoot(userDataPath = ""): string {
  return path.resolve(userDataPath || ServerConfig.getDataDir());
}

function isWithin(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeTargetRelativePath(value: unknown = ""): string {
  const selected = String(value || "").replace(/\\/g, "/");
  const segments = selected.split("/");
  if (
    !selected ||
    selected.startsWith("/") ||
    path.posix.isAbsolute(selected) ||
    segments.includes("") ||
    segments.includes("..") ||
    EXCLUDED_TARGET_ROOTS.has(segments[0])
  ) {
    throw transactionError(
      "storage_restore_journal_invalid",
      "A restore transaction journal contains an unsafe target path."
    );
  }
  return selected;
}

function normalizeRecord(source: JsonRecord | RestoreRecord = {}): RestoreRecord {
  const relativePath = normalizeTargetRelativePath(source.relativePath);
  const operation = String(source.operation || "");
  const hadOriginal = source.hadOriginal === true;
  const previousBytes = Number(source.previousBytes || 0);
  const previousSha256 = String(source.previousSha256 || "").toLowerCase();
  const installedBytes = Number(source.installedBytes || 0);
  const installedSha256 = String(source.installedSha256 || "").toLowerCase();
  const sqlite = source.sqlite === true;
  if (
    !["install", "delete"].includes(operation) ||
    !Number.isSafeInteger(previousBytes) ||
    previousBytes < 0 ||
    (hadOriginal && !SHA256_PATTERN.test(previousSha256)) ||
    (!hadOriginal && (previousBytes !== 0 || previousSha256)) ||
    !Number.isSafeInteger(installedBytes) ||
    installedBytes < 0 ||
    (operation === "install" && !SHA256_PATTERN.test(installedSha256)) ||
    (operation === "install" && sqlite !== isSqliteTarget(relativePath)) ||
    (operation === "delete" && (!hadOriginal || installedBytes !== 0 || installedSha256 || sqlite))
  ) {
    throw transactionError(
      "storage_restore_journal_invalid",
      "A restore transaction journal contains invalid mutation metadata."
    );
  }
  return {
    relativePath,
    operation: operation as RestoreOperation,
    hadOriginal,
    previousBytes,
    previousSha256,
    installedBytes,
    installedSha256,
    sqlite
  };
}

function validateJournal(value: unknown, expectedTransactionId = ""): RestoreJournal {
  const source = record(value);
  const transactionId = String(source.transactionId || "");
  const backupId = String(source.backupId || "");
  const receiptId = String(source.receiptId || "");
  const phase = String(source.phase || "");
  const receiptSha256 = String(source.receiptSha256 || "").toLowerCase();
  if (
    source.schemaVersion !== TRANSACTION_SCHEMA_VERSION ||
    source.protocol !== TRANSACTION_PROTOCOL ||
    !UUID_PATTERN.test(transactionId) ||
    (expectedTransactionId && transactionId !== expectedTransactionId) ||
    !BACKUP_ID_PATTERN.test(backupId) ||
    !RECEIPT_ID_PATTERN.test(receiptId) ||
    !PHASES.has(phase as RestorePhase) ||
    !SHA256_PATTERN.test(receiptSha256) ||
    !Array.isArray(source.records)
  ) {
    throw transactionError(
      "storage_restore_journal_invalid",
      "A restore transaction journal is missing required durable metadata."
    );
  }
  const seen = new Set<string>();
  const records = source.records.map((item: unknown): RestoreRecord => {
    const normalized = normalizeRecord(record(item));
    if (seen.has(normalized.relativePath)) {
      throw transactionError(
        "storage_restore_journal_invalid",
        "A restore transaction journal contains duplicate target paths."
      );
    }
    seen.add(normalized.relativePath);
    return normalized;
  });
  return {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    protocol: TRANSACTION_PROTOCOL,
    transactionId,
    backupId,
    receiptId,
    receiptSha256,
    phase: phase as RestorePhase,
    records: Object.freeze(records)
  };
}

function transactionPaths(rootPath: string, transactionId: string): TransactionPaths {
  const temporaryRoot = path.join(rootPath, TRANSACTION_DIRECTORY);
  return {
    temporaryRoot,
    pendingRoot: path.join(temporaryRoot, `.storage-restore-${transactionId}.preparing`),
    transactionRoot: path.join(temporaryRoot, `storage-restore-${transactionId}`)
  };
}

function pathsInsideTransaction(transactionRoot: string): TransactionContents {
  return {
    journalPath: path.join(transactionRoot, JOURNAL_FILE),
    stagedFilesRoot: path.join(transactionRoot, STAGED_FILES_DIRECTORY),
    rollbackRoot: path.join(transactionRoot, ROLLBACK_DIRECTORY),
    stagedReceiptPath: path.join(transactionRoot, STAGED_RECEIPT_FILE)
  };
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await fsPromises.open(directoryPath, fs.constants.O_RDONLY);
    await handle.sync();
  } catch (error: unknown) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    await handle?.close().catch((): void => {});
  }
}

function syncDirectorySync(directoryPath: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error: unknown) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return process.platform === "win32" &&
    ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(errorCode(error));
}

async function syncDirectoryHierarchy(directoryPath: string, boundaryPath: string): Promise<void> {
  const boundary = path.resolve(boundaryPath);
  const selected = path.resolve(directoryPath);
  if (!isWithin(selected, boundary)) {
    throw transactionError(
      "storage_restore_transaction_boundary_invalid",
      "A restore transaction directory escaped its durable boundary."
    );
  }
  const chain: string[] = [];
  let current = selected;
  while (true) {
    chain.push(current);
    if (current === boundary) break;
    current = path.dirname(current);
  }
  for (const item of chain.reverse()) await syncDirectory(item);
}

function syncDirectoryHierarchySync(directoryPath: string, boundaryPath: string): void {
  const boundary = path.resolve(boundaryPath);
  const selected = path.resolve(directoryPath);
  if (!isWithin(selected, boundary)) {
    throw transactionError(
      "storage_restore_recovery_failed",
      "A restore recovery directory escaped its durable boundary."
    );
  }
  const chain: string[] = [];
  let current = selected;
  while (true) {
    chain.push(current);
    if (current === boundary) break;
    current = path.dirname(current);
  }
  for (const item of chain.reverse()) syncDirectorySync(item);
}

async function syncDirectoryTree(directoryPath: string): Promise<void> {
  const entries: Dirent[] = await fsPromises.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw transactionError(
        "storage_restore_transaction_boundary_invalid",
        "A restore transaction staging tree contains a symbolic link."
      );
    }
    if (entry.isDirectory()) await syncDirectoryTree(path.join(directoryPath, entry.name));
  }
  await syncDirectory(directoryPath);
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await fsPromises.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat = await fsPromises.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw transactionError(
      "storage_restore_transaction_boundary_invalid",
      "A restore transaction directory has an unsafe filesystem boundary."
    );
  }
  await fsPromises.chmod(directoryPath, 0o700);
}

async function writeJsonDurable(filePath: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  let handle: FileHandle | null = null;
  try {
    handle = await fsPromises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error: unknown) {
    await handle?.close().catch((): void => {});
    await fsPromises.rm(temporaryPath, { force: true }).catch((): void => {});
    throw error;
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fsPromises.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function readJsonSafeSync(filePath: string): unknown {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before: BigIntStats = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("not a regular file");
    const parsed: unknown = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    const after: BigIntStats = fs.fstatSync(descriptor, { bigint: true });
    const beforeSignature = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(":");
    const afterSignature = [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(":");
    if (beforeSignature !== afterSignature) throw new Error("journal changed during inspection");
    return parsed;
  } catch (error: unknown) {
    throw transactionError(
      "storage_restore_journal_invalid",
      "A restore transaction journal could not be read safely.",
      error
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function inspectRegularFileSync(filePath: string): FileIntegrity {
  let descriptor: number | null = null;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before: BigIntStats = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw transactionError(
        "storage_restore_recovery_failed",
        "A restore recovery target is not a regular file."
      );
    }
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    const after: BigIntStats = fs.fstatSync(descriptor, { bigint: true });
    const beforeSignature = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(":");
    const afterSignature = [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(":");
    if (beforeSignature !== afterSignature || bytes !== Number(after.size)) {
      throw transactionError(
        "storage_restore_recovery_failed",
        "A restore recovery target changed during verification."
      );
    }
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function assertExpectedFileSync(filePath: string, bytes: number, sha256: string): void {
  const integrity = inspectRegularFileSync(filePath);
  if (integrity.bytes !== bytes || integrity.sha256 !== sha256) {
    throw transactionError(
      "storage_restore_recovery_failed",
      "A restore recovery target does not match its durable transaction metadata."
    );
  }
}

function pathExistsSync(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function assertSafeTargetParentSync(rootPath: string, targetPath: string): void {
  if (!isWithin(targetPath, rootPath)) {
    throw transactionError(
      "storage_restore_recovery_failed",
      "A restore recovery target escaped the storage root."
    );
  }
  const relativeParent = path.relative(rootPath, path.dirname(targetPath));
  let currentPath = rootPath;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    if (!pathExistsSync(currentPath)) break;
    const stat = fs.lstatSync(currentPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw transactionError(
        "storage_restore_recovery_failed",
        "A restore recovery target has an unsafe parent directory."
      );
    }
  }
}

function removeSafeFileSync(rootPath: string, targetPath: string): void {
  if (!pathExistsSync(targetPath)) return;
  assertSafeTargetParentSync(rootPath, targetPath);
  const stat = fs.lstatSync(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw transactionError(
      "storage_restore_recovery_failed",
      "A restore recovery target cannot be removed safely."
    );
  }
  fs.rmSync(targetPath);
  syncDirectorySync(path.dirname(targetPath));
}

function verifySqliteAndRemoveVerificationSidecarsSync(rootPath: string, targetPath: string): void {
  let database: Database.Database | null = null;
  try {
    database = openSqliteDatabase(targetPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
    if (String(database.pragma("quick_check", { simple: true }) || "").toLowerCase() !== "ok") {
      throw transactionError(
        "storage_restore_recovery_failed",
        "A committed SQLite restore target failed integrity verification."
      );
    }
  } finally {
    database?.close();
  }
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    removeSafeFileSync(rootPath, `${targetPath}${suffix}`);
  }
}

function verifyCommittedRecordsSync(rootPath: string, records: readonly RestoreRecord[]): void {
  for (const record of records) {
    const targetPath = path.join(rootPath, record.relativePath);
    assertSafeTargetParentSync(rootPath, targetPath);
    if (record.operation === "delete") {
      if (pathExistsSync(targetPath)) {
        throw transactionError(
          "storage_restore_recovery_failed",
          "A committed restore deletion was not completed."
        );
      }
      continue;
    }
    if (!pathExistsSync(targetPath)) {
      throw transactionError(
        "storage_restore_recovery_failed",
        "A committed restore target is missing."
      );
    }
    assertExpectedFileSync(targetPath, record.installedBytes, record.installedSha256);
    if (record.sqlite) verifySqliteAndRemoveVerificationSidecarsSync(rootPath, targetPath);
  }
}

function rollbackRecordsSync(rootPath: string, transactionRoot: string, records: readonly RestoreRecord[]): void {
  const { rollbackRoot } = pathsInsideTransaction(transactionRoot);
  for (const record of [...records].reverse()) {
    const targetPath = path.join(rootPath, record.relativePath);
    const rollbackPath = path.join(rollbackRoot, record.relativePath);
    assertSafeTargetParentSync(rootPath, targetPath);
    if (pathExistsSync(rollbackPath)) {
      assertExpectedFileSync(rollbackPath, record.previousBytes, record.previousSha256);
      removeSafeFileSync(rootPath, targetPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      syncDirectoryHierarchySync(path.dirname(targetPath), rootPath);
      fs.renameSync(rollbackPath, targetPath);
      syncDirectorySync(path.dirname(targetPath));
      assertExpectedFileSync(targetPath, record.previousBytes, record.previousSha256);
      continue;
    }
    if (record.hadOriginal) {
      if (!pathExistsSync(targetPath)) {
        throw transactionError(
          "storage_restore_recovery_failed",
          "Restore recovery cannot locate the prior target generation."
        );
      }
      assertExpectedFileSync(targetPath, record.previousBytes, record.previousSha256);
      continue;
    }
    removeSafeFileSync(rootPath, targetPath);
  }
}

function finalizeCommittedTransactionSync(rootPath: string, transactionRoot: string, journal: RestoreJournal): string {
  verifyCommittedRecordsSync(rootPath, journal.records);
  const { stagedReceiptPath } = pathsInsideTransaction(transactionRoot);
  const selectedBackupRoot = resolveBackupRoot(rootPath);
  const reportRoot = path.join(selectedBackupRoot, journal.backupId, RESTORE_REPORT_DIRECTORY);
  const reportPath = path.join(reportRoot, `${journal.receiptId}.json`);
  assertSafeTargetParentSync(selectedBackupRoot, reportPath);
  fs.mkdirSync(reportRoot, { recursive: true, mode: 0o700 });
  syncDirectoryHierarchySync(reportRoot, selectedBackupRoot);
  if (pathExistsSync(stagedReceiptPath)) {
    assertExpectedFileSync(
      stagedReceiptPath,
      fs.statSync(stagedReceiptPath).size,
      journal.receiptSha256
    );
    if (pathExistsSync(reportPath)) {
      assertExpectedFileSync(reportPath, fs.statSync(reportPath).size, journal.receiptSha256);
      fs.rmSync(stagedReceiptPath);
    } else {
      fs.renameSync(stagedReceiptPath, reportPath);
    }
    fs.chmodSync(reportPath, 0o600);
    syncDirectorySync(reportRoot);
  } else if (pathExistsSync(reportPath)) {
    assertExpectedFileSync(reportPath, fs.statSync(reportPath).size, journal.receiptSha256);
  } else {
    throw transactionError(
      "storage_restore_recovery_failed",
      "A committed restore receipt cannot be recovered."
    );
  }
  fs.rmSync(transactionRoot, { recursive: true, force: true });
  syncDirectorySync(path.dirname(transactionRoot));
  return reportPath;
}

function reconcileTransactionSync(rootPath: string, transactionRoot: string, expectedTransactionId?: string): string {
  const stat = fs.lstatSync(transactionRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw transactionError(
      "storage_restore_recovery_failed",
      "A restore transaction root has an unsafe filesystem boundary."
    );
  }
  const { journalPath } = pathsInsideTransaction(transactionRoot);
  const journal = validateJournal(readJsonSafeSync(journalPath), expectedTransactionId);
  if (journal.phase === "prepared") {
    fs.rmSync(transactionRoot, { recursive: true, force: true });
    syncDirectorySync(path.dirname(transactionRoot));
    return "discarded";
  }
  if (journal.phase === "rollback-required") {
    rollbackRecordsSync(rootPath, transactionRoot, journal.records);
    fs.rmSync(transactionRoot, { recursive: true, force: true });
    syncDirectorySync(path.dirname(transactionRoot));
    return "rolled-back";
  }
  finalizeCommittedTransactionSync(rootPath, transactionRoot, journal);
  return "finalized";
}

export function reconcileStorageRestoreTransactionsSync(userDataPath = ""): Readonly<{ reconciled: number }> {
  const rootPath = storageRoot(userDataPath);
  const temporaryRoot = path.join(rootPath, TRANSACTION_DIRECTORY);
  let entries: Dirent[] = [];
  try {
    entries = fs.readdirSync(temporaryRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return Object.freeze({ reconciled: 0 });
    throw transactionError(
      "storage_restore_recovery_failed",
      "Restore transaction recovery could not inspect its durable journal root.",
      error
    );
  }
  let reconciled = 0;
  for (const entry of entries.sort((left, right): number => left.name.localeCompare(right.name))) {
    const pendingMatch = /^\.storage-restore-([0-9a-f-]+)\.preparing$/iu.exec(entry.name);
    if (
      entry.name.startsWith(".storage-restore-") &&
      entry.name.endsWith(".preparing") &&
      !pendingMatch
    ) {
      throw transactionError(
        "storage_restore_recovery_failed",
        "A pending restore transaction directory has an invalid durable identity."
      );
    }
    if (pendingMatch) {
      if (!UUID_PATTERN.test(pendingMatch[1])) {
        throw transactionError(
          "storage_restore_recovery_failed",
          "A pending restore transaction directory has an invalid durable identity."
        );
      }
      const pendingRoot = path.join(temporaryRoot, entry.name);
      const stat = fs.lstatSync(pendingRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw transactionError(
          "storage_restore_recovery_failed",
          "A pending restore transaction has an unsafe filesystem boundary."
        );
      }
      fs.rmSync(pendingRoot, { recursive: true, force: true });
      syncDirectorySync(temporaryRoot);
      reconciled += 1;
      continue;
    }
    const match = /^storage-restore-([0-9a-f-]+)$/iu.exec(entry.name);
    if (entry.name.startsWith("storage-restore-") && !match) {
      throw transactionError(
        "storage_restore_recovery_failed",
        "A restore transaction directory has an invalid durable identity."
      );
    }
    if (!match) continue;
    if (!UUID_PATTERN.test(match[1])) {
      throw transactionError(
        "storage_restore_recovery_failed",
        "A restore transaction directory has an invalid durable identity."
      );
    }
    reconcileTransactionSync(rootPath, path.join(temporaryRoot, entry.name), match[1]);
    reconciled += 1;
  }
  return Object.freeze({ reconciled });
}

async function moveOriginalToRollback({
  rootPath,
  rollbackRoot,
  record
}: {
  rootPath: string;
  rollbackRoot: string;
  record: RestoreRecord;
}): Promise<void> {
  const targetPath = path.join(rootPath, record.relativePath);
  if (!record.hadOriginal) return;
  const rollbackPath = path.join(rollbackRoot, record.relativePath);
  await ensurePrivateDirectory(path.dirname(rollbackPath));
  await syncDirectoryHierarchy(path.dirname(rollbackPath), rollbackRoot);
  await fsPromises.rename(targetPath, rollbackPath);
  // Make the rollback name durable before persisting deletion of the source
  // name. A power loss between the two fsync calls can then leave two names,
  // but never lose the only recoverable generation.
  await syncDirectory(path.dirname(rollbackPath));
  await syncDirectory(path.dirname(targetPath));
}

async function assertPreimageUnchanged(rootPath: string, record: RestoreRecord): Promise<void> {
  const targetPath = path.join(rootPath, record.relativePath);
  assertSafeTargetParentSync(rootPath, targetPath);
  let exists = true;
  try {
    await fsPromises.access(targetPath);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") exists = false;
    else throw error;
  }
  if (!record.hadOriginal) {
    if (exists) {
      throw transactionError(
        "restore_target_changed",
        "A restore target changed after preview."
      );
    }
    return;
  }
  if (!exists) {
    throw transactionError(
      "restore_target_changed",
      "A restore target changed after preview."
    );
  }
  const integrity = inspectRegularFileSync(targetPath);
  if (integrity.bytes !== record.previousBytes || integrity.sha256 !== record.previousSha256) {
    throw transactionError(
      "restore_target_changed",
      "A restore target changed after preview."
    );
  }
}

export async function executeDurableRestoreTransaction({
  userDataPath,
  backupId,
  receiptId,
  report,
  records = [],
  stageInstall
}: RestoreExecutionOptions = {}): Promise<string> {
  const rootPath = storageRoot(userDataPath);
  const transactionId = crypto.randomUUID();
  const selectedBackupId = String(backupId || "");
  const selectedReceiptId = String(receiptId || "");
  if (!BACKUP_ID_PATTERN.test(selectedBackupId) || !RECEIPT_ID_PATTERN.test(selectedReceiptId)) {
    throw transactionError(
      "storage_restore_transaction_invalid",
      "A restore transaction requires valid backup and receipt identities."
    );
  }
  if (typeof stageInstall !== "function") {
    throw new TypeError("stageInstall must be a function.");
  }
  const installer = stageInstall;
  const normalizedRecords = records.map((item): RestoreRecord => normalizeRecord(item));
  if (new Set<string>(normalizedRecords.map((item): string => item.relativePath)).size !== normalizedRecords.length) {
    throw transactionError(
      "storage_restore_transaction_invalid",
      "A restore transaction contains duplicate mutation targets."
    );
  }
  const roots = transactionPaths(rootPath, transactionId);
  const pendingPaths = pathsInsideTransaction(roots.pendingRoot);
  const finalPaths = pathsInsideTransaction(roots.transactionRoot);
  let published = false;
  try {
    await ensurePrivateDirectory(roots.temporaryRoot);
    await syncDirectory(rootPath);
    await ensurePrivateDirectory(pendingPaths.stagedFilesRoot);
    await ensurePrivateDirectory(pendingPaths.rollbackRoot);
    for (const record of normalizedRecords) {
      if (record.operation !== "install") continue;
      const stagedPath = path.join(pendingPaths.stagedFilesRoot, record.relativePath);
      await installer(record, stagedPath);
      await syncFile(stagedPath);
      const integrity = inspectRegularFileSync(stagedPath);
      if (integrity.bytes !== record.installedBytes || integrity.sha256 !== record.installedSha256) {
        throw transactionError(
          "storage_restore_staging_failed",
          "A staged restore target failed durable integrity verification."
        );
      }
    }
    await writeJsonDurable(pendingPaths.stagedReceiptPath, report);
    const receiptIntegrity = inspectRegularFileSync(pendingPaths.stagedReceiptPath);
    const journal = validateJournal({
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
      protocol: TRANSACTION_PROTOCOL,
      transactionId,
      backupId: selectedBackupId,
      receiptId: selectedReceiptId,
      receiptSha256: receiptIntegrity.sha256,
      phase: "prepared",
      records: normalizedRecords
    }, transactionId);
    await writeJsonDurable(pendingPaths.journalPath, journal);
    await syncDirectoryTree(roots.pendingRoot);
    await fsPromises.rename(roots.pendingRoot, roots.transactionRoot);
    await syncDirectory(roots.temporaryRoot);
    published = true;

    const rollbackJournal: RestoreJournal = { ...journal, phase: "rollback-required" };
    await writeJsonDurable(finalPaths.journalPath, rollbackJournal);
    for (const record of normalizedRecords) await assertPreimageUnchanged(rootPath, record);
    for (const record of normalizedRecords) {
      const targetPath = path.join(rootPath, record.relativePath);
      await moveOriginalToRollback({ rootPath, rollbackRoot: finalPaths.rollbackRoot, record });
      if (record.operation === "install") {
        await ensurePrivateDirectory(path.dirname(targetPath));
        await syncDirectoryHierarchy(path.dirname(targetPath), rootPath);
        await fsPromises.rename(path.join(finalPaths.stagedFilesRoot, record.relativePath), targetPath);
        await fsPromises.chmod(targetPath, 0o600);
        await syncDirectory(path.dirname(targetPath));
      }
    }
    verifyCommittedRecordsSync(rootPath, normalizedRecords);
    const committedJournal: RestoreJournal = { ...rollbackJournal, phase: "commit-complete" };
    await writeJsonDurable(finalPaths.journalPath, committedJournal);
    return finalizeCommittedTransactionSync(
      rootPath,
      roots.transactionRoot,
      committedJournal
    );
  } catch (error: unknown) {
    try {
      if (published && pathExistsSync(roots.transactionRoot)) {
        reconcileTransactionSync(rootPath, roots.transactionRoot, transactionId);
      } else {
        await fsPromises.rm(roots.pendingRoot, { recursive: true, force: true });
        if (pathExistsSync(roots.temporaryRoot)) await syncDirectory(roots.temporaryRoot);
      }
    } catch (recoveryError: unknown) {
      throw transactionError(
        "storage_restore_recovery_failed",
        "Storage restore recovery could not establish a complete generation.",
        recoveryError
      );
    }
    if (record(error).name === "StorageRestoreTransactionError") throw error;
    throw transactionError(
      "storage_restore_commit_failed",
      "Storage restore failed and the prior state was restored.",
      error
    );
  }
}
