import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { openSqliteDatabase } from "./sqlite-database.ts";
import { ServerConfig } from "#meshrix/server-config";
import { backupRoot as resolveBackupRoot } from "./backup-contract.ts";

const TRANSACTION_SCHEMA_VERSION: any = "v0.0.1:schema:definition-1";
const TRANSACTION_PROTOCOL: any = "v0.0.1:storage:restore-transaction-1";
const TRANSACTION_DIRECTORY: any = "tmp";
const JOURNAL_FILE: any = "restore-transaction.json";
const STAGED_FILES_DIRECTORY: any = "files";
const ROLLBACK_DIRECTORY: any = "rollback";
const STAGED_RECEIPT_FILE: any = "restore-receipt.json";
const RESTORE_REPORT_DIRECTORY: any = "restore-reports";
const SQLITE_SIDECAR_SUFFIXES: readonly any[] = Object.freeze(["-wal", "-shm", "-journal"]);
const SHA256_PATTERN: any = /^[a-f0-9]{64}$/u;
const UUID_PATTERN: any = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BACKUP_ID_PATTERN: any = /^backup_[A-Za-z0-9_.-]+$/u;
const RECEIPT_ID_PATTERN: any = /^restore_[A-Za-z0-9_.-]+$/u;
const EXCLUDED_TARGET_ROOTS: any = new Set<any>(["backups", "locks", "logs", TRANSACTION_DIRECTORY]);
const PHASES: any = new Set<any>(["prepared", "rollback-required", "commit-complete"]);

function isSqliteTarget(relativePath: any = "") : any {
  const value: any = String(relativePath || "").toLowerCase();
  return value.endsWith(".sqlite") || value.endsWith(".sqlite3") || value.endsWith(".db");
}

function transactionError(code?: any, message?: any, cause?: any) : any {
  const error: Error & Record<string, any> = new Error(message, cause ? { cause } : undefined);
  error.name = "StorageRestoreTransactionError";
  error.code = code;
  error.reasonCode = code;
  return error;
}

function storageRoot(userDataPath: any = "") : any {
  return path.resolve(userDataPath || ServerConfig.getDataDir());
}

function isWithin(candidatePath?: any, rootPath?: any) : any {
  const relative: any = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeTargetRelativePath(value: any = "") : any {
  const selected: any = String(value || "").replace(/\\/g, "/");
  const segments: any = selected.split("/");
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

function normalizeRecord(record: Record<string, any> = {}) : any {
  const relativePath: any = normalizeTargetRelativePath(record.relativePath);
  const operation: any = String(record.operation || "");
  const hadOriginal: any = record.hadOriginal === true;
  const previousBytes: any = Number(record.previousBytes || 0);
  const previousSha256: any = String(record.previousSha256 || "").toLowerCase();
  const installedBytes: any = Number(record.installedBytes || 0);
  const installedSha256: any = String(record.installedSha256 || "").toLowerCase();
  const sqlite: any = record.sqlite === true;
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
    operation,
    hadOriginal,
    previousBytes,
    previousSha256,
    installedBytes,
    installedSha256,
    sqlite
  };
}

function validateJournal(value?: any, expectedTransactionId: any = "") : any {
  const transactionId: any = String(value?.transactionId || "");
  const backupId: any = String(value?.backupId || "");
  const receiptId: any = String(value?.receiptId || "");
  const phase: any = String(value?.phase || "");
  const receiptSha256: any = String(value?.receiptSha256 || "").toLowerCase();
  if (
    !value ||
    value.schemaVersion !== TRANSACTION_SCHEMA_VERSION ||
    value.protocol !== TRANSACTION_PROTOCOL ||
    !UUID_PATTERN.test(transactionId) ||
    (expectedTransactionId && transactionId !== expectedTransactionId) ||
    !BACKUP_ID_PATTERN.test(backupId) ||
    !RECEIPT_ID_PATTERN.test(receiptId) ||
    !PHASES.has(phase) ||
    !SHA256_PATTERN.test(receiptSha256) ||
    !Array.isArray(value.records)
  ) {
    throw transactionError(
      "storage_restore_journal_invalid",
      "A restore transaction journal is missing required durable metadata."
    );
  }
  const seen: any = new Set<any>();
  const records: any = value.records.map((record?: any) : any => {
    const normalized: any = normalizeRecord(record);
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
    phase,
    records
  };
}

function transactionPaths(rootPath?: any, transactionId?: any) : any {
  const temporaryRoot: any = path.join(rootPath, TRANSACTION_DIRECTORY);
  return {
    temporaryRoot,
    pendingRoot: path.join(temporaryRoot, `.storage-restore-${transactionId}.preparing`),
    transactionRoot: path.join(temporaryRoot, `storage-restore-${transactionId}`)
  };
}

function pathsInsideTransaction(transactionRoot?: any) : any {
  return {
    journalPath: path.join(transactionRoot, JOURNAL_FILE),
    stagedFilesRoot: path.join(transactionRoot, STAGED_FILES_DIRECTORY),
    rollbackRoot: path.join(transactionRoot, ROLLBACK_DIRECTORY),
    stagedReceiptPath: path.join(transactionRoot, STAGED_RECEIPT_FILE)
  };
}

async function syncDirectory(directoryPath?: any) : Promise<any> {
  let handle: any = null;
  try {
    handle = await fsPromises.open(directoryPath, fs.constants.O_RDONLY);
    await handle.sync();
  } catch (error: any) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    await handle?.close().catch(() : any => {});
  }
}

function syncDirectorySync(directoryPath?: any) : any {
  let descriptor: any = null;
  try {
    descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error: any) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function isUnsupportedDirectorySyncError(error?: any) : any {
  return process.platform === "win32" &&
    ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code);
}

async function syncDirectoryHierarchy(directoryPath?: any, boundaryPath?: any) : Promise<any> {
  const boundary: any = path.resolve(boundaryPath);
  const selected: any = path.resolve(directoryPath);
  if (!isWithin(selected, boundary)) {
    throw transactionError(
      "storage_restore_transaction_boundary_invalid",
      "A restore transaction directory escaped its durable boundary."
    );
  }
  const chain: any[] = [];
  let current: any = selected;
  while (true) {
    chain.push(current);
    if (current === boundary) break;
    current = path.dirname(current);
  }
  for (const item of chain.reverse()) await syncDirectory(item);
}

function syncDirectoryHierarchySync(directoryPath?: any, boundaryPath?: any) : any {
  const boundary: any = path.resolve(boundaryPath);
  const selected: any = path.resolve(directoryPath);
  if (!isWithin(selected, boundary)) {
    throw transactionError(
      "storage_restore_recovery_failed",
      "A restore recovery directory escaped its durable boundary."
    );
  }
  const chain: any[] = [];
  let current: any = selected;
  while (true) {
    chain.push(current);
    if (current === boundary) break;
    current = path.dirname(current);
  }
  for (const item of chain.reverse()) syncDirectorySync(item);
}

async function syncDirectoryTree(directoryPath?: any) : Promise<any> {
  const entries: any = await fsPromises.readdir(directoryPath, { withFileTypes: true });
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

async function ensurePrivateDirectory(directoryPath?: any) : Promise<any> {
  await fsPromises.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat: any = await fsPromises.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw transactionError(
      "storage_restore_transaction_boundary_invalid",
      "A restore transaction directory has an unsafe filesystem boundary."
    );
  }
  await fsPromises.chmod(directoryPath, 0o700);
}

async function writeJsonDurable(filePath?: any, value?: any) : Promise<any> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath: any = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  let handle: any = null;
  try {
    handle = await fsPromises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error: any) {
    await handle?.close().catch(() : any => {});
    await fsPromises.rm(temporaryPath, { force: true }).catch(() : any => {});
    throw error;
  }
}

async function syncFile(filePath?: any) : Promise<any> {
  const handle: any = await fsPromises.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function readJsonSafeSync(filePath?: any) : any {
  let descriptor: any = null;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before: any = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("not a regular file");
    const parsed: any = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    const after: any = fs.fstatSync(descriptor, { bigint: true });
    const beforeSignature: any = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(":");
    const afterSignature: any = [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(":");
    if (beforeSignature !== afterSignature) throw new Error("journal changed during inspection");
    return parsed;
  } catch (error: any) {
    throw transactionError(
      "storage_restore_journal_invalid",
      "A restore transaction journal could not be read safely.",
      error
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function inspectRegularFileSync(filePath?: any) : any {
  let descriptor: any = null;
  const buffer: any = Buffer.allocUnsafe(64 * 1024);
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before: any = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw transactionError(
        "storage_restore_recovery_failed",
        "A restore recovery target is not a regular file."
      );
    }
    const hash: any = crypto.createHash("sha256");
    let bytes: any = 0;
    while (true) {
      const count: any = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    const after: any = fs.fstatSync(descriptor, { bigint: true });
    const beforeSignature: any = [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(":");
    const afterSignature: any = [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(":");
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

function assertExpectedFileSync(filePath?: any, bytes?: any, sha256?: any) : any {
  const integrity: any = inspectRegularFileSync(filePath);
  if (integrity.bytes !== bytes || integrity.sha256 !== sha256) {
    throw transactionError(
      "storage_restore_recovery_failed",
      "A restore recovery target does not match its durable transaction metadata."
    );
  }
}

function pathExistsSync(filePath?: any) : any {
  try {
    fs.accessSync(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertSafeTargetParentSync(rootPath?: any, targetPath?: any) : any {
  if (!isWithin(targetPath, rootPath)) {
    throw transactionError(
      "storage_restore_recovery_failed",
      "A restore recovery target escaped the storage root."
    );
  }
  const relativeParent: any = path.relative(rootPath, path.dirname(targetPath));
  let currentPath: any = rootPath;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    if (!pathExistsSync(currentPath)) break;
    const stat: any = fs.lstatSync(currentPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw transactionError(
        "storage_restore_recovery_failed",
        "A restore recovery target has an unsafe parent directory."
      );
    }
  }
}

function removeSafeFileSync(rootPath?: any, targetPath?: any) : any {
  if (!pathExistsSync(targetPath)) return;
  assertSafeTargetParentSync(rootPath, targetPath);
  const stat: any = fs.lstatSync(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw transactionError(
      "storage_restore_recovery_failed",
      "A restore recovery target cannot be removed safely."
    );
  }
  fs.rmSync(targetPath);
  syncDirectorySync(path.dirname(targetPath));
}

function verifySqliteAndRemoveVerificationSidecarsSync(rootPath?: any, targetPath?: any) : any {
  let database: any = null;
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

function verifyCommittedRecordsSync(rootPath?: any, records?: any) : any {
  for (const record of records) {
    const targetPath: any = path.join(rootPath, record.relativePath);
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

function rollbackRecordsSync(rootPath?: any, transactionRoot?: any, records?: any) : any {
  const { rollbackRoot } = pathsInsideTransaction(transactionRoot);
  for (const record of [...records].reverse()) {
    const targetPath: any = path.join(rootPath, record.relativePath);
    const rollbackPath: any = path.join(rollbackRoot, record.relativePath);
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

function finalizeCommittedTransactionSync(rootPath?: any, transactionRoot?: any, journal?: any) : any {
  verifyCommittedRecordsSync(rootPath, journal.records);
  const { stagedReceiptPath } = pathsInsideTransaction(transactionRoot);
  const selectedBackupRoot: any = resolveBackupRoot(rootPath);
  const reportRoot: any = path.join(selectedBackupRoot, journal.backupId, RESTORE_REPORT_DIRECTORY);
  const reportPath: any = path.join(reportRoot, `${journal.receiptId}.json`);
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

function reconcileTransactionSync(rootPath?: any, transactionRoot?: any, expectedTransactionId?: any) : any {
  const stat: any = fs.lstatSync(transactionRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw transactionError(
      "storage_restore_recovery_failed",
      "A restore transaction root has an unsafe filesystem boundary."
    );
  }
  const { journalPath } = pathsInsideTransaction(transactionRoot);
  const journal: any = validateJournal(readJsonSafeSync(journalPath), expectedTransactionId);
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

export function reconcileStorageRestoreTransactionsSync(userDataPath: any = "") : any {
  const rootPath: any = storageRoot(userDataPath);
  const temporaryRoot: any = path.join(rootPath, TRANSACTION_DIRECTORY);
  let entries: any[] = [];
  try {
    entries = fs.readdirSync(temporaryRoot, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return Object.freeze({ reconciled: 0 });
    throw transactionError(
      "storage_restore_recovery_failed",
      "Restore transaction recovery could not inspect its durable journal root.",
      error
    );
  }
  let reconciled: any = 0;
  for (const entry of entries.sort((left?: any, right?: any) : any => left.name.localeCompare(right.name))) {
    const pendingMatch: any = /^\.storage-restore-([0-9a-f-]+)\.preparing$/iu.exec(entry.name);
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
      const pendingRoot: any = path.join(temporaryRoot, entry.name);
      const stat: any = fs.lstatSync(pendingRoot);
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
    const match: any = /^storage-restore-([0-9a-f-]+)$/iu.exec(entry.name);
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

async function moveOriginalToRollback({ rootPath, rollbackRoot, record }: Record<string, any>) : Promise<any> {
  const targetPath: any = path.join(rootPath, record.relativePath);
  if (!record.hadOriginal) return;
  const rollbackPath: any = path.join(rollbackRoot, record.relativePath);
  await ensurePrivateDirectory(path.dirname(rollbackPath));
  await syncDirectoryHierarchy(path.dirname(rollbackPath), rollbackRoot);
  await fsPromises.rename(targetPath, rollbackPath);
  // Make the rollback name durable before persisting deletion of the source
  // name. A power loss between the two fsync calls can then leave two names,
  // but never lose the only recoverable generation.
  await syncDirectory(path.dirname(rollbackPath));
  await syncDirectory(path.dirname(targetPath));
}

async function assertPreimageUnchanged(rootPath?: any, record?: any) : Promise<any> {
  const targetPath: any = path.join(rootPath, record.relativePath);
  assertSafeTargetParentSync(rootPath, targetPath);
  let exists: any = true;
  try {
    await fsPromises.access(targetPath);
  } catch (error: any) {
    if (error?.code === "ENOENT") exists = false;
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
  const integrity: any = inspectRegularFileSync(targetPath);
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
}: Record<string, any> = {}) : Promise<any> {
  const rootPath: any = storageRoot(userDataPath);
  const transactionId: any = crypto.randomUUID();
  const selectedBackupId: any = String(backupId || "");
  const selectedReceiptId: any = String(receiptId || "");
  if (!BACKUP_ID_PATTERN.test(selectedBackupId) || !RECEIPT_ID_PATTERN.test(selectedReceiptId)) {
    throw transactionError(
      "storage_restore_transaction_invalid",
      "A restore transaction requires valid backup and receipt identities."
    );
  }
  if (typeof stageInstall !== "function") {
    throw new TypeError("stageInstall must be a function.");
  }
  const normalizedRecords: any = records.map(normalizeRecord);
  if (new Set<any>(normalizedRecords.map((record?: any) : any => record.relativePath)).size !== normalizedRecords.length) {
    throw transactionError(
      "storage_restore_transaction_invalid",
      "A restore transaction contains duplicate mutation targets."
    );
  }
  const roots: any = transactionPaths(rootPath, transactionId);
  const pendingPaths: any = pathsInsideTransaction(roots.pendingRoot);
  const finalPaths: any = pathsInsideTransaction(roots.transactionRoot);
  let published: any = false;
  try {
    await ensurePrivateDirectory(roots.temporaryRoot);
    await syncDirectory(rootPath);
    await ensurePrivateDirectory(pendingPaths.stagedFilesRoot);
    await ensurePrivateDirectory(pendingPaths.rollbackRoot);
    for (const record of normalizedRecords) {
      if (record.operation !== "install") continue;
      const stagedPath: any = path.join(pendingPaths.stagedFilesRoot, record.relativePath);
      await stageInstall(record, stagedPath);
      await syncFile(stagedPath);
      const integrity: any = inspectRegularFileSync(stagedPath);
      if (integrity.bytes !== record.installedBytes || integrity.sha256 !== record.installedSha256) {
        throw transactionError(
          "storage_restore_staging_failed",
          "A staged restore target failed durable integrity verification."
        );
      }
    }
    await writeJsonDurable(pendingPaths.stagedReceiptPath, report);
    const receiptIntegrity: any = inspectRegularFileSync(pendingPaths.stagedReceiptPath);
    const journal: any = validateJournal({
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

    const rollbackJournal: Record<string, any> = { ...journal, phase: "rollback-required" };
    await writeJsonDurable(finalPaths.journalPath, rollbackJournal);
    for (const record of normalizedRecords) await assertPreimageUnchanged(rootPath, record);
    for (const record of normalizedRecords) {
      const targetPath: any = path.join(rootPath, record.relativePath);
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
    await writeJsonDurable(finalPaths.journalPath, { ...rollbackJournal, phase: "commit-complete" });
    return finalizeCommittedTransactionSync(
      rootPath,
      roots.transactionRoot,
      { ...rollbackJournal, phase: "commit-complete" }
    );
  } catch (error: any) {
    try {
      if (published && pathExistsSync(roots.transactionRoot)) {
        reconcileTransactionSync(rootPath, roots.transactionRoot, transactionId);
      } else {
        await fsPromises.rm(roots.pendingRoot, { recursive: true, force: true });
        if (pathExistsSync(roots.temporaryRoot)) await syncDirectory(roots.temporaryRoot);
      }
    } catch (recoveryError: any) {
      throw transactionError(
        "storage_restore_recovery_failed",
        "Storage restore recovery could not establish a complete generation.",
        recoveryError
      );
    }
    if (error?.name === "StorageRestoreTransactionError") throw error;
    throw transactionError(
      "storage_restore_commit_failed",
      "Storage restore failed and the prior state was restored.",
      error
    );
  }
}
