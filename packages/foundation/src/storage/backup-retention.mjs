import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsNative from "node:fs";
import path from "node:path";
import { ServerConfig } from "#lico/server-config";
import { rebuildStorageBackupCatalog } from "./backup-manifest.mjs";
import { listStorageBackups } from "./backup-query.mjs";
import { writePrivateFileAtomic } from "./private-file-atomic.mjs";
import { createStorageReceipt } from "./storage-evidence.mjs";
import { acquireStorageMaintenanceLock } from "./storage-lifecycle-lock.mjs";
import { createStorageWorkTracker } from "./storage-maintenance-coordinator.mjs";

const TRANSACTION_DIRECTORY = ".retention-transactions";
const RECEIPT_DIRECTORY = "retention-receipts";
const JOURNAL_FILE = "retention-journal.json";
const BACKUP_ID_PATTERN = /^backup_[A-Za-z0-9_.-]+$/u;
const PHASES = new Set(["prepared", "commit-ready"]);

function retentionError(code, message) {
  const error = new Error(message);
  error.name = "StorageRetentionError";
  error.code = code;
  error.reasonCode = code;
  return error;
}

function safeBackupId(value) {
  const id = String(value || "");
  if (!BACKUP_ID_PATTERN.test(id)) {
    throw retentionError("storage_retention_backup_id_invalid", "Retention received an invalid backup identity.");
  }
  return id;
}

function normalizePolicy(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw retentionError("storage_retention_policy_invalid", "Retention policy must be an object.");
  }
  const hasKeepLast = Object.hasOwn(value, "keepLast");
  const hasMaxAge = Object.hasOwn(value, "maxAgeMs");
  if (!hasKeepLast && !hasMaxAge) {
    throw retentionError("storage_retention_policy_invalid", "Retention policy must select keepLast or maxAgeMs.");
  }
  const keepLast = hasKeepLast ? Number(value.keepLast) : 1;
  const maxAgeMs = hasMaxAge ? Number(value.maxAgeMs) : null;
  if (!Number.isSafeInteger(keepLast) || keepLast < 1) {
    throw retentionError("storage_retention_policy_invalid", "Retention keepLast must preserve at least one generation.");
  }
  if (maxAgeMs !== null && (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1)) {
    throw retentionError("storage_retention_policy_invalid", "Retention maxAgeMs must be a positive safe integer.");
  }
  const protectedBackupIds = Array.isArray(value.protectedBackupIds)
    ? [...new Set(value.protectedBackupIds.map(safeBackupId))].sort()
    : [];
  return Object.freeze({ keepLast, maxAgeMs, protectedBackupIds: Object.freeze(protectedBackupIds) });
}

async function syncDirectory(directoryPath) {
  let handle = null;
  try {
    handle = await fs.open(directoryPath, fsNative.constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const unsupported = process.platform === "win32" && ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code);
    if (!unsupported) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function pathExists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function ensurePrivateDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw retentionError("storage_retention_boundary_invalid", "Retention directory is not a private real directory.");
  }
  await fs.chmod(directoryPath, 0o700);
}

function roots(userDataPath) {
  const rootPath = path.resolve(userDataPath || ServerConfig.getDataDir());
  const backupRoot = path.join(rootPath, "backups");
  return {
    rootPath,
    backupRoot,
    transactionRoot: path.join(backupRoot, TRANSACTION_DIRECTORY),
    receiptRoot: path.join(backupRoot, RECEIPT_DIRECTORY)
  };
}

function validateJournal(value, transactionId) {
  if (
    !value ||
    value.schema !== "licomesh.storage.retention-journal" ||
    value.transactionId !== transactionId ||
    !PHASES.has(value.phase) ||
    !Array.isArray(value.candidateIds) ||
    !Array.isArray(value.movedIds)
  ) {
    throw retentionError("storage_retention_journal_invalid", "Retention journal is invalid.");
  }
  const candidateIds = value.candidateIds.map(safeBackupId);
  const movedIds = value.movedIds.map(safeBackupId);
  if (
    new Set(candidateIds).size !== candidateIds.length ||
    new Set(movedIds).size !== movedIds.length ||
    movedIds.some((id) => !candidateIds.includes(id))
  ) {
    throw retentionError("storage_retention_journal_invalid", "Retention journal contains inconsistent identities.");
  }
  return { ...value, candidateIds, movedIds };
}

async function writeJournal(journalPath, value) {
  await writePrivateFileAtomic(journalPath, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

async function reconcileTransaction({ backupRoot, transactionPath, transactionId }) {
  const journalPath = path.join(transactionPath, JOURNAL_FILE);
  const journal = validateJournal(JSON.parse(await fs.readFile(journalPath, "utf8")), transactionId);
  const quarantineRoot = path.join(transactionPath, "quarantine");
  if (journal.phase === "prepared") {
    for (const backupId of [...journal.movedIds].reverse()) {
      const sourcePath = path.join(backupRoot, backupId);
      const quarantinePath = path.join(quarantineRoot, backupId);
      const sourceExists = await pathExists(sourcePath);
      const quarantineExists = await pathExists(quarantinePath);
      if (sourceExists && quarantineExists) {
        throw retentionError("storage_retention_recovery_conflict", "Retention rollback found two authoritative generations.");
      }
      if (!sourceExists && quarantineExists) {
        await fs.rename(quarantinePath, sourcePath);
        await syncDirectory(backupRoot);
      }
    }
  } else {
    for (const backupId of journal.candidateIds) {
      if (await pathExists(path.join(backupRoot, backupId))) {
        throw retentionError("storage_retention_recovery_conflict", "Committed retention found an unquarantined generation.");
      }
      await fs.rm(path.join(quarantineRoot, backupId), { recursive: true, force: true });
    }
    await syncDirectory(quarantineRoot).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  await fs.rm(transactionPath, { recursive: true, force: true });
  await syncDirectory(path.dirname(transactionPath));
}

export async function reconcileStorageRetentionTransactions({ userDataPath } = {}) {
  const selectedRoots = roots(userDataPath);
  let entries = [];
  try {
    entries = await fs.readdir(selectedRoots.transactionRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { reconciled: 0 };
    throw error;
  }
  let reconciled = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !/^retention_[0-9a-f-]{36}$/u.test(entry.name)) {
      throw retentionError("storage_retention_journal_invalid", "Retention transaction directory is invalid.");
    }
    await reconcileTransaction({
      backupRoot: selectedRoots.backupRoot,
      transactionPath: path.join(selectedRoots.transactionRoot, entry.name),
      transactionId: entry.name
    });
    reconciled += 1;
  }
  return { reconciled };
}

function pathExistsSync(targetPath) {
  try {
    fsNative.lstatSync(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function syncDirectorySync(directoryPath) {
  let descriptor = null;
  try {
    descriptor = fsNative.openSync(directoryPath, fsNative.constants.O_RDONLY);
    fsNative.fsyncSync(descriptor);
  } catch (error) {
    const unsupported = process.platform === "win32" && ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code);
    if (!unsupported && error?.code !== "ENOENT") throw error;
  } finally {
    if (descriptor !== null) fsNative.closeSync(descriptor);
  }
}

function reconcileTransactionSync({ backupRoot, transactionPath, transactionId }) {
  const journalPath = path.join(transactionPath, JOURNAL_FILE);
  const journal = validateJournal(JSON.parse(fsNative.readFileSync(journalPath, "utf8")), transactionId);
  const quarantineRoot = path.join(transactionPath, "quarantine");
  if (journal.phase === "prepared") {
    for (const backupId of [...journal.movedIds].reverse()) {
      const sourcePath = path.join(backupRoot, backupId);
      const quarantinePath = path.join(quarantineRoot, backupId);
      const sourceExists = pathExistsSync(sourcePath);
      const quarantineExists = pathExistsSync(quarantinePath);
      if (sourceExists && quarantineExists) {
        throw retentionError("storage_retention_recovery_conflict", "Retention rollback found two authoritative generations.");
      }
      if (!sourceExists && quarantineExists) {
        fsNative.renameSync(quarantinePath, sourcePath);
        syncDirectorySync(backupRoot);
      }
    }
  } else {
    for (const backupId of journal.candidateIds) {
      if (pathExistsSync(path.join(backupRoot, backupId))) {
        throw retentionError("storage_retention_recovery_conflict", "Committed retention found an unquarantined generation.");
      }
      fsNative.rmSync(path.join(quarantineRoot, backupId), { recursive: true, force: true });
    }
    syncDirectorySync(quarantineRoot);
  }
  fsNative.rmSync(transactionPath, { recursive: true, force: true });
  syncDirectorySync(path.dirname(transactionPath));
}

export function reconcileStorageRetentionTransactionsSync({ userDataPath } = {}) {
  const selectedRoots = roots(userDataPath);
  let entries = [];
  try {
    entries = fsNative.readdirSync(selectedRoots.transactionRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { reconciled: 0 };
    throw error;
  }
  let reconciled = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^retention_[0-9a-f-]{36}$/u.test(entry.name)) {
      throw retentionError("storage_retention_journal_invalid", "Retention transaction directory is invalid.");
    }
    reconcileTransactionSync({
      backupRoot: selectedRoots.backupRoot,
      transactionPath: path.join(selectedRoots.transactionRoot, entry.name),
      transactionId: entry.name
    });
    reconciled += 1;
  }
  return { reconciled };
}

function selectCandidates(backups, policy, nowMs) {
  const protectedIds = new Set(policy.protectedBackupIds);
  const rankedProtected = new Set(backups.slice(0, policy.keepLast).map((entry) => entry.backupId));
  return backups.filter((entry) => {
    if (protectedIds.has(entry.backupId) || rankedProtected.has(entry.backupId)) return false;
    if (policy.maxAgeMs === null) return true;
    const createdAt = Date.parse(entry.createdAt);
    if (!Number.isFinite(createdAt)) {
      throw retentionError("storage_retention_manifest_invalid", "Retention cannot order a backup with an invalid timestamp.");
    }
    return createdAt <= nowMs - policy.maxAgeMs;
  });
}

export async function applyStorageBackupRetention({
  userDataPath,
  policy,
  signal = null,
  budget = {},
  executionContext = null,
  maintenanceLock = null,
  now = Date.now()
} = {}) {
  const selectedPolicy = normalizePolicy(policy);
  if (!selectedPolicy) {
    return {
      status: "not_configured",
      deletedBackupIds: [],
      receipt: createStorageReceipt({
        kind: "backup-retention",
        status: "not_configured",
        reasonCode: "storage_retention_not_configured",
        counts: { deleted: 0 }
      })
    };
  }
  const selectedRoots = roots(userDataPath);
  const tracker = executionContext || createStorageWorkTracker({ signal, budget });
  tracker.assertActive();
  const lock = maintenanceLock || await acquireStorageMaintenanceLock(selectedRoots.rootPath);
  const ownsLock = !maintenanceLock;
  let commitReady = false;
  let transactionPath = "";
  let journal = null;
  try {
    await reconcileStorageRetentionTransactions({ userDataPath: selectedRoots.rootPath });
    const listing = await listStorageBackups({ userDataPath: selectedRoots.rootPath });
    tracker.consume({ files: listing.backups.length });
    const candidates = selectCandidates(listing.backups, selectedPolicy, Number(now));
    tracker.consume({ cleanupItems: candidates.length });
    const policyDigest = crypto.createHash("sha256").update(JSON.stringify(selectedPolicy)).digest("hex");
    if (candidates.length === 0) {
      return {
        status: "applied",
        deletedBackupIds: [],
        receipt: createStorageReceipt({
          kind: "backup-retention",
          status: "applied",
          counts: { deleted: 0, retained: listing.backups.length, protected: selectedPolicy.protectedBackupIds.length },
          digestPrefixes: { policy: policyDigest.slice(0, 16) }
        })
      };
    }
    await ensurePrivateDirectory(selectedRoots.backupRoot);
    await ensurePrivateDirectory(selectedRoots.transactionRoot);
    const transactionId = `retention_${crypto.randomUUID()}`;
    transactionPath = path.join(selectedRoots.transactionRoot, transactionId);
    const quarantineRoot = path.join(transactionPath, "quarantine");
    await ensurePrivateDirectory(quarantineRoot);
    journal = {
      schema: "licomesh.storage.retention-journal",
      transactionId,
      phase: "prepared",
      policyDigest,
      candidateIds: candidates.map((entry) => safeBackupId(entry.backupId)),
      movedIds: []
    };
    const journalPath = path.join(transactionPath, JOURNAL_FILE);
    await writeJournal(journalPath, journal);
    for (const backupId of journal.candidateIds) {
      tracker.assertActive();
      const sourcePath = path.join(selectedRoots.backupRoot, backupId);
      const sourceStat = await fs.lstat(sourcePath);
      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
        throw retentionError("storage_retention_boundary_invalid", "Retention candidate is not a real backup directory.");
      }
      journal = { ...journal, movedIds: [...journal.movedIds, backupId] };
      await writeJournal(journalPath, journal);
      await fs.rename(sourcePath, path.join(quarantineRoot, backupId));
      await syncDirectory(selectedRoots.backupRoot);
    }
    journal = { ...journal, phase: "commit-ready" };
    await writeJournal(journalPath, journal);
    commitReady = true;
    for (const backupId of journal.candidateIds) {
      await fs.rm(path.join(quarantineRoot, backupId), { recursive: true, force: true });
    }
    await ensurePrivateDirectory(selectedRoots.receiptRoot);
    const receipt = createStorageReceipt({
      kind: "backup-retention",
      status: "applied",
      counts: {
        deleted: journal.candidateIds.length,
        retained: listing.backups.length - journal.candidateIds.length,
        protected: selectedPolicy.protectedBackupIds.length
      },
      digestPrefixes: { policy: policyDigest.slice(0, 16) }
    });
    await writePrivateFileAtomic(
      path.join(selectedRoots.receiptRoot, `${receipt.receiptId}.json`),
      `${JSON.stringify(receipt, null, 2)}\n`
    );
    await fs.rm(transactionPath, { recursive: true, force: true });
    await syncDirectory(selectedRoots.transactionRoot);
    await rebuildStorageBackupCatalog({ userDataPath: selectedRoots.rootPath });
    return { status: "applied", deletedBackupIds: [...journal.candidateIds], receipt };
  } catch (error) {
    if (transactionPath && journal && !commitReady) {
      await reconcileTransaction({
        backupRoot: selectedRoots.backupRoot,
        transactionPath,
        transactionId: journal.transactionId
      }).catch(() => {});
    }
    throw error;
  } finally {
    if (ownsLock) await lock.release().catch(() => {});
  }
}
