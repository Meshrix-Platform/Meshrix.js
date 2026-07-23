import { randomBytes } from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  serviceManifestError,
  sha256ManifestBytes,
  stableManifestJson,
  validateManifestDigest,
  validateManifestRevision,
  validateOpaqueServiceId
} from "./storage-ports.mjs";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(["EACCES", "EINVAL", "ENOTSUP", "EPERM"]);
const RECEIPT_REF_PATTERN = /^urn:lico:storage-manifest-receipt:[a-f0-9]{64}$/u;
const TEMP_FILE_PATTERN = /^\.(?:manifest|generation|latest|journal)\.[a-f0-9]{16}\.tmp$/u;
const IMMUTABLE_FILE_PATTERN = /^([a-f0-9]{64})\.json$/u;
const WRITER_FENCE_OWNER_PATTERN = /^([1-9][0-9]{0,9}):([a-f0-9]{32})$/u;
const EMPTY_SERVICES = Object.freeze([]);

export const SERVICE_MANIFEST_POINTER_SCHEMA_VERSION = "v0.0.1:storage:service-manifest-pointer-1";
export const SERVICE_MANIFEST_GENERATION_SCHEMA_VERSION = "v0.0.1:storage:service-manifest-generation-1";
export const SERVICE_MANIFEST_JOURNAL_SCHEMA_VERSION = "v0.0.1:storage:service-manifest-journal-1";

function isUnsupportedDirectorySync(error) {
  return process.platform === "win32" && WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code);
}

function assertExactKeys(value, expected, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw serviceManifestError(code, message);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw serviceManifestError(code, message);
  }
  return value;
}

function signature(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.mode
  ]
    .map((value) => String(value))
    .join(":");
}

function samePointer(left, right) {
  if (left === null || right === null) return left === right;
  return stableManifestJson(left) === stableManifestJson(right);
}

function entryPath(directoryPath, digest) {
  validateManifestDigest(digest);
  return path.join(directoryPath, `${digest}.json`);
}

async function syncDirectory(directoryPath) {
  let handle = null;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function hardenFile(filePath) {
  try {
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  }
}

async function ensurePrivateDirectory(directoryPath) {
  const missing = [];
  let current = path.resolve(directoryPath);
  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw serviceManifestError(
          "storage_manifest_directory_unsafe",
          "Service manifest storage ancestry must contain only real directories."
        );
      }
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  for (const target of missing.reverse()) {
    try {
      await fs.mkdir(target, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const concurrentStat = await fs.lstat(target);
      if (!concurrentStat.isDirectory() || concurrentStat.isSymbolicLink()) {
        throw serviceManifestError(
          "storage_manifest_directory_unsafe",
          "Service manifest storage ancestry must contain only real directories."
        );
      }
    }
    await fs.chmod(target, PRIVATE_DIRECTORY_MODE);
    await syncDirectory(path.dirname(target));
  }
  const finalStat = await fs.lstat(directoryPath);
  if (!finalStat.isDirectory() || finalStat.isSymbolicLink()) {
    throw serviceManifestError(
      "storage_manifest_directory_unsafe",
      "Service manifest storage directory must be a real directory."
    );
  }
  await fs.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
}

function combineSignals(signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

export function createManifestTransactionContext({
  budget,
  signal,
  laneSignal,
  startedAt = Date.now()
}) {
  const combinedSignal = combineSignals([signal, laneSignal]);
  const deadline = startedAt + budget.maxOperationMs;
  let readBytes = 0;
  let writeBytes = 0;
  let files = 0;
  let cleanupEntries = 0;

  function check() {
    if (combinedSignal?.aborted) {
      const reason = combinedSignal.reason;
      if (reason instanceof Error) throw reason;
      throw serviceManifestError(
        "storage_manifest_aborted",
        "Service manifest operation was cancelled before publication."
      );
    }
    if (Date.now() > deadline) {
      throw serviceManifestError(
        "storage_manifest_timeout",
        "Service manifest operation exceeded its elapsed-time budget."
      );
    }
  }

  function touchFile() {
    check();
    files += 1;
    if (files > budget.maxFiles) {
      throw serviceManifestError(
        "storage_manifest_budget_exceeded",
        "Service manifest file-operation budget was exceeded."
      );
    }
  }

  function consumeRead(byteCount) {
    check();
    readBytes += byteCount;
    if (readBytes > budget.maxReadBytes) {
      throw serviceManifestError(
        "storage_manifest_budget_exceeded",
        "Service manifest read budget was exceeded."
      );
    }
  }

  function consumeWrite(byteCount) {
    check();
    writeBytes += byteCount;
    if (writeBytes > budget.maxWriteBytes) {
      throw serviceManifestError(
        "storage_manifest_budget_exceeded",
        "Service manifest write budget was exceeded."
      );
    }
  }

  function inspectCleanupEntry() {
    check();
    cleanupEntries += 1;
    if (cleanupEntries > budget.maxCleanupEntries) {
      throw serviceManifestError(
        "storage_manifest_cleanup_budget_exceeded",
        "Service manifest cleanup requires more work than the declared budget."
      );
    }
  }

  return Object.freeze({
    budget,
    signal: combinedSignal,
    deadline,
    check,
    touchFile,
    consumeRead,
    consumeWrite,
    inspectCleanupEntry
  });
}

async function safeReadFile(filePath, context, { optional = false, maxBytes } = {}) {
  context.check();
  context.touchFile();
  const flags = fsNative.constants.O_RDONLY | (fsNative.constants.O_NOFOLLOW || 0);
  let handle = null;
  try {
    handle = await fs.open(filePath, flags);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") {
      throw serviceManifestError(
        "storage_manifest_file_unsafe",
        "Service manifest storage contains an unsafe filesystem artifact.",
        error
      );
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !Number.isSafeInteger(Number(before.size))) {
      throw serviceManifestError(
        "storage_manifest_file_unsafe",
        "Service manifest storage files must be regular files."
      );
    }
    const byteSize = Number(before.size);
    if (byteSize > maxBytes) {
      throw serviceManifestError(
        "storage_manifest_budget_exceeded",
        "Service manifest persisted bytes exceed the read budget."
      );
    }
    const bytes = await handle.readFile();
    context.consumeRead(bytes.length);
    const after = await handle.stat({ bigint: true });
    if (signature(before) !== signature(after) || bytes.length !== Number(after.size)) {
      throw serviceManifestError(
        "storage_manifest_file_changed",
        "Service manifest storage changed during opened-file verification."
      );
    }
    return bytes;
  } finally {
    await handle.close().catch(() => {});
  }
}

function parseCanonicalJson(bytes, code, message) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw serviceManifestError(code, message, error);
  }
  if (stableManifestJson(parsed) !== bytes.toString("utf8")) {
    throw serviceManifestError(code, message);
  }
  return parsed;
}

async function rejectUnsafeReplacementTarget(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw serviceManifestError(
        "storage_manifest_file_unsafe",
        "Service manifest replacement targets must be regular files."
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeStagedFile({ directoryPath, targetPath, kind, bytes, context }) {
  context.check();
  context.consumeWrite(bytes.length);
  context.touchFile();
  await rejectUnsafeReplacementTarget(targetPath);
  const temporaryPath = path.join(
    directoryPath,
    `.${kind}.${randomBytes(8).toString("hex")}.tmp`
  );
  let handle = null;
  let renamed = false;
  try {
    handle = await fs.open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(bytes, { signal: context.signal });
    context.check();
    await handle.sync();
    await handle.close();
    handle = null;
    await hardenFile(temporaryPath);
    context.check();
    await fs.rename(temporaryPath, targetPath);
    renamed = true;
    await hardenFile(targetPath);
    await syncDirectory(directoryPath);
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function writeImmutableFile({ directoryPath, digest, kind, bytes, context }) {
  const targetPath = entryPath(directoryPath, digest);
  const existing = await safeReadFile(targetPath, context, {
    optional: true,
    maxBytes: context.budget.maxReadBytes
  });
  if (existing) {
    if (!existing.equals(bytes) || sha256ManifestBytes(existing) !== digest) {
      throw serviceManifestError(
        "storage_manifest_immutable_conflict",
        "Service manifest immutable content does not match its digest address."
      );
    }
    return targetPath;
  }
  await writeStagedFile({ directoryPath, targetPath, kind, bytes, context });
  const persisted = await safeReadFile(targetPath, context, {
    maxBytes: context.budget.maxReadBytes
  });
  if (!persisted.equals(bytes) || sha256ManifestBytes(persisted) !== digest) {
    throw serviceManifestError(
      "storage_manifest_immutable_conflict",
      "Service manifest immutable content failed post-publication verification."
    );
  }
  return targetPath;
}

function validatePointer(value) {
  assertExactKeys(
    value,
    ["schemaVersion", "setRevision", "setDigest", "generationDigest"],
    "storage_manifest_pointer_invalid",
    "Service manifest latest pointer is invalid."
  );
  if (value.schemaVersion !== SERVICE_MANIFEST_POINTER_SCHEMA_VERSION) {
    throw serviceManifestError(
      "storage_manifest_pointer_invalid",
      "Service manifest latest pointer schema is invalid."
    );
  }
  validateManifestRevision(value.setRevision, "set revision");
  if (value.setRevision < 1) {
    throw serviceManifestError(
      "storage_manifest_pointer_invalid",
      "Service manifest latest pointer revision is invalid."
    );
  }
  validateManifestDigest(value.setDigest, "set digest");
  validateManifestDigest(value.generationDigest, "generation digest");
  return value;
}

function validateServiceEntry(value) {
  assertExactKeys(
    value,
    ["serviceId", "serviceRevision", "manifestDigest"],
    "storage_manifest_generation_invalid",
    "Service manifest generation contains an invalid service entry."
  );
  validateOpaqueServiceId(value.serviceId);
  validateManifestRevision(value.serviceRevision, "service revision");
  if (value.serviceRevision < 1) {
    throw serviceManifestError(
      "storage_manifest_generation_invalid",
      "Service manifest generation service revision is invalid."
    );
  }
  validateManifestDigest(value.manifestDigest, "manifest digest");
  return value;
}

function validateRequestEntry(value) {
  assertExactKeys(
    value,
    [
      "requestDigest",
      "serviceId",
      "manifestDigest",
      "expectedServiceRevision",
      "expectedSetRevision",
      "serviceRevision",
      "setRevision",
      "setDigest",
      "receiptRef"
    ],
    "storage_manifest_generation_invalid",
    "Service manifest generation contains an invalid request outcome."
  );
  validateManifestDigest(value.requestDigest, "request digest");
  validateOpaqueServiceId(value.serviceId);
  validateManifestDigest(value.manifestDigest, "manifest digest");
  validateManifestRevision(value.expectedServiceRevision, "expected service revision");
  validateManifestRevision(value.expectedSetRevision, "expected set revision");
  validateManifestRevision(value.serviceRevision, "service revision");
  validateManifestRevision(value.setRevision, "set revision");
  validateManifestDigest(value.setDigest, "set digest");
  if (value.serviceRevision < 1 || value.setRevision < 1 || !RECEIPT_REF_PATTERN.test(value.receiptRef)) {
    throw serviceManifestError(
      "storage_manifest_generation_invalid",
      "Service manifest request outcome is invalid."
    );
  }
  return value;
}

export function serviceManifestSetDigest(services) {
  return sha256ManifestBytes(Buffer.from(stableManifestJson(services), "utf8"));
}

export function emptyServiceManifestGeneration() {
  return Object.freeze({
    schemaVersion: SERVICE_MANIFEST_GENERATION_SCHEMA_VERSION,
    setRevision: 0,
    setDigest: serviceManifestSetDigest(EMPTY_SERVICES),
    services: EMPTY_SERVICES,
    requests: Object.freeze([])
  });
}

function validateGeneration(value, pointer, budget) {
  assertExactKeys(
    value,
    ["schemaVersion", "setRevision", "setDigest", "services", "requests"],
    "storage_manifest_generation_invalid",
    "Service manifest generation is invalid."
  );
  if (
    value.schemaVersion !== SERVICE_MANIFEST_GENERATION_SCHEMA_VERSION ||
    !Array.isArray(value.services) ||
    !Array.isArray(value.requests)
  ) {
    throw serviceManifestError(
      "storage_manifest_generation_invalid",
      "Service manifest generation schema is invalid."
    );
  }
  validateManifestRevision(value.setRevision, "set revision");
  validateManifestDigest(value.setDigest, "set digest");
  if (
    value.setRevision !== pointer.setRevision ||
    value.setDigest !== pointer.setDigest ||
    value.services.length > budget.maxServices ||
    value.requests.length > budget.maxRequestRecords
  ) {
    throw serviceManifestError(
      "storage_manifest_generation_invalid",
      "Service manifest generation does not match its published pointer or resource budget."
    );
  }
  let previousServiceId = "";
  for (const entry of value.services) {
    validateServiceEntry(entry);
    if (entry.serviceId <= previousServiceId) {
      throw serviceManifestError(
        "storage_manifest_generation_invalid",
        "Service manifest generation service entries must be unique and ordered."
      );
    }
    previousServiceId = entry.serviceId;
  }
  let previousRequestDigest = "";
  for (const entry of value.requests) {
    validateRequestEntry(entry);
    if (entry.requestDigest <= previousRequestDigest || entry.setRevision > value.setRevision) {
      throw serviceManifestError(
        "storage_manifest_generation_invalid",
        "Service manifest generation request outcomes must be unique, ordered, and monotonic."
      );
    }
    previousRequestDigest = entry.requestDigest;
  }
  if (serviceManifestSetDigest(value.services) !== value.setDigest) {
    throw serviceManifestError(
      "storage_manifest_generation_invalid",
      "Service manifest generation set digest is invalid."
    );
  }
  return value;
}

function validateJournal(value) {
  assertExactKeys(
    value,
    ["schemaVersion", "phase", "previousPointer", "candidatePointer", "requestDigest", "serviceId", "manifestDigest", "terminalOutcome"],
    "storage_manifest_journal_invalid",
    "Service manifest transaction journal is invalid."
  );
  if (value.schemaVersion !== SERVICE_MANIFEST_JOURNAL_SCHEMA_VERSION || value.phase !== "prepared") {
    throw serviceManifestError(
      "storage_manifest_journal_invalid",
      "Service manifest transaction journal phase is invalid."
    );
  }
  if (value.previousPointer !== null) validatePointer(value.previousPointer);
  validatePointer(value.candidatePointer);
  validateManifestDigest(value.requestDigest, "request digest");
  validateOpaqueServiceId(value.serviceId);
  validateManifestDigest(value.manifestDigest, "manifest digest");
  validateRequestEntry(value.terminalOutcome);
  if (
    value.terminalOutcome.requestDigest !== value.requestDigest ||
    value.terminalOutcome.serviceId !== value.serviceId ||
    value.terminalOutcome.manifestDigest !== value.manifestDigest ||
    value.terminalOutcome.setRevision !== value.candidatePointer.setRevision ||
    value.terminalOutcome.setDigest !== value.candidatePointer.setDigest
  ) {
    throw serviceManifestError(
      "storage_manifest_journal_invalid",
      "Service manifest transaction journal outcome is inconsistent."
    );
  }
  return value;
}

async function readOptionalCanonicalJson(filePath, context, code, message) {
  const bytes = await safeReadFile(filePath, context, {
    optional: true,
    maxBytes: Math.min(context.budget.maxReadBytes, 16 * 1024 * 1024)
  });
  return bytes ? parseCanonicalJson(bytes, code, message) : null;
}

async function removeRegularFileAndSync(filePath, directoryPath) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw serviceManifestError(
        "storage_manifest_file_unsafe",
        "Service manifest transaction metadata must be a regular file."
      );
    }
    await fs.unlink(filePath);
    await syncDirectory(directoryPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function cleanupTemporaryFiles(directories, context) {
  for (const directoryPath of directories) {
    context.check();
    const removable = [];
    const handle = await fs.opendir(directoryPath);
    for await (const entry of handle) {
      context.inspectCleanupEntry();
      if (!TEMP_FILE_PATTERN.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw serviceManifestError(
          "storage_manifest_file_unsafe",
          "Service manifest staging contains an unsafe filesystem artifact."
        );
      }
      removable.push(entry.name);
    }
    for (const name of removable) await fs.unlink(path.join(directoryPath, name));
    if (removable.length > 0) await syncDirectory(directoryPath);
  }
}

async function cleanupImmutableOrphans({ directoryPath, retainedDigests, context }) {
  context.check();
  const removable = [];
  const handle = await fs.opendir(directoryPath);
  for await (const entry of handle) {
    context.inspectCleanupEntry();
    const match = IMMUTABLE_FILE_PATTERN.exec(entry.name);
    if (!match) {
      throw serviceManifestError(
        "storage_manifest_file_unsafe",
        "Service manifest immutable storage contains an unexpected filesystem artifact."
      );
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw serviceManifestError(
        "storage_manifest_file_unsafe",
        "Service manifest immutable storage must contain only regular digest-addressed files."
      );
    }
    if (retainedDigests.has(match[1])) continue;
    removable.push(entry.name);
  }
  for (const name of removable) await fs.unlink(path.join(directoryPath, name));
  if (removable.length > 0) await syncDirectory(directoryPath);
}

export function serviceManifestAuthorityRoot(storageRoot) {
  if (typeof storageRoot !== "string" || !storageRoot.trim() || storageRoot.includes("\u0000")) {
    throw serviceManifestError(
      "storage_manifest_root_invalid",
      "Service manifest storage root is required."
    );
  }
  return path.join(path.resolve(storageRoot), "service-manifests");
}

export function createServiceManifestTransaction({ storageRoot }) {
  const rootPath = serviceManifestAuthorityRoot(storageRoot);
  const manifestsPath = path.join(rootPath, "manifests");
  const generationsPath = path.join(rootPath, "generations");
  const latestPath = path.join(rootPath, "latest.json");
  const publishedPath = path.join(rootPath, "published.json");
  const journalPath = path.join(rootPath, "journal.json");
  const writerFencePath = path.join(rootPath, ".writer-fence");

  async function ensureLayout(context) {
    context.check();
    await ensurePrivateDirectory(rootPath);
    await ensurePrivateDirectory(manifestsPath);
    await ensurePrivateDirectory(generationsPath);
  }

  async function readPointer(context) {
    const raw = await readOptionalCanonicalJson(
      latestPath,
      context,
      "storage_manifest_pointer_invalid",
      "Service manifest latest pointer is invalid."
    );
    return raw ? validatePointer(raw) : null;
  }

  async function readPublishedPointer(context) {
    const raw = await readOptionalCanonicalJson(
      publishedPath,
      context,
      "storage_manifest_pointer_invalid",
      "Service manifest published pointer is invalid."
    );
    return raw ? validatePointer(raw) : null;
  }

  async function readGeneration(pointer, context) {
    if (!pointer) return emptyServiceManifestGeneration();
    const bytes = await safeReadFile(entryPath(generationsPath, pointer.generationDigest), context, {
      maxBytes: Math.min(context.budget.maxReadBytes, 16 * 1024 * 1024)
    });
    if (sha256ManifestBytes(bytes) !== pointer.generationDigest) {
      throw serviceManifestError(
        "storage_manifest_generation_invalid",
        "Service manifest generation digest does not match its immutable address."
      );
    }
    const parsed = parseCanonicalJson(
      bytes,
      "storage_manifest_generation_invalid",
      "Service manifest generation is invalid."
    );
    return validateGeneration(parsed, pointer, context.budget);
  }

  async function recover(context) {
    const journalRaw = await readOptionalCanonicalJson(
      journalPath,
      context,
      "storage_manifest_journal_invalid",
      "Service manifest transaction journal is invalid."
    );
    let pointer = await readPointer(context);
    if (journalRaw) {
      const journal = validateJournal(journalRaw);
      if (samePointer(pointer, journal.candidatePointer)) {
        await readGeneration(journal.candidatePointer, context);
        pointer = journal.candidatePointer;
      } else if (samePointer(pointer, journal.previousPointer)) {
        pointer = journal.previousPointer;
      } else {
        throw serviceManifestError(
          "storage_manifest_recovery_conflict",
          "Service manifest journal cannot be reconciled with the durable pointer."
        );
      }
    }
    const generation = await readGeneration(pointer, context);
    return Object.freeze({ pointer, generation, journal: journalRaw ? validateJournal(journalRaw) : null });
  }

  async function readPublished(context) {
    const pointer = await readPublishedPointer(context);
    const generation = await readGeneration(pointer, context);
    return Object.freeze({ pointer, generation });
  }

  async function readFenceOwner() {
    let handle = null;
    try {
      handle = await fs.open(
        path.join(writerFencePath, "owner"),
        fsNative.constants.O_RDONLY | (fsNative.constants.O_NOFOLLOW || 0)
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 64) {
        throw serviceManifestError(
          "storage_manifest_file_unsafe",
          "Service manifest writer fence owner is invalid."
        );
      }
      return (await handle.readFile("utf8")).trim();
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error?.code === "ELOOP") {
        throw serviceManifestError(
          "storage_manifest_file_unsafe",
          "Service manifest writer fence owner is unsafe.",
          error
        );
      }
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function acquireWriterFence(context) {
    const owner = `${process.pid}:${randomBytes(16).toString("hex")}`;
    const ownerPath = path.join(writerFencePath, "owner");
    while (true) {
      context.check();
      try {
        await fs.mkdir(writerFencePath, { mode: PRIVATE_DIRECTORY_MODE });
        await writeStagedFile({
          directoryPath: writerFencePath,
          targetPath: ownerPath,
          kind: "owner",
          bytes: Buffer.from(owner, "utf8"),
          context
        });
        await syncDirectory(rootPath);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const stat = await fs.lstat(writerFencePath).catch(() => null);
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
          throw serviceManifestError(
            "storage_manifest_file_unsafe",
            "Service manifest writer fence must be a real directory."
          );
        }
        const persistedOwner = stat ? await readFenceOwner() : null;
        if (stat && persistedOwner === null) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        const ownerMatch = WRITER_FENCE_OWNER_PATTERN.exec(persistedOwner || "");
        if (stat && !ownerMatch) {
          throw serviceManifestError(
            "storage_manifest_file_unsafe",
            "Service manifest writer fence owner is invalid."
          );
        }
        let ownerAlive = true;
        if (ownerMatch) {
          try {
            process.kill(Number(ownerMatch[1]), 0);
          } catch (ownerError) {
            ownerAlive = ownerError?.code !== "ESRCH";
          }
        }
        if (stat && ownerMatch && !ownerAlive &&
            Date.now() - stat.mtimeMs > context.budget.maxOperationMs * 2) {
          const quarantine = `${writerFencePath}.${randomBytes(8).toString("hex")}.stale`;
          await fs.rename(writerFencePath, quarantine).catch((renameError) => {
            if (renameError?.code !== "ENOENT") throw renameError;
          });
          await fs.rm(quarantine, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    async function assertOwned() {
      const persisted = await readFenceOwner();
      if (!WRITER_FENCE_OWNER_PATTERN.test(persisted || "") || persisted !== owner) {
        throw serviceManifestError(
          "storage_manifest_writer_fenced",
          "Service manifest writer lost its durable publication fence."
        );
      }
    }
    async function release() {
      if (await readFenceOwner() !== owner) return;
      await fs.unlink(ownerPath).catch(() => {});
      await fs.rmdir(writerFencePath).catch(() => {});
      await syncDirectory(rootPath).catch(() => {});
    }
    return Object.freeze({ assertOwned, release });
  }

  async function readManifest(manifestDigest, context) {
    validateManifestDigest(manifestDigest, "manifest digest");
    const bytes = await safeReadFile(entryPath(manifestsPath, manifestDigest), context, {
      maxBytes: context.budget.maxManifestBytes
    });
    if (sha256ManifestBytes(bytes) !== manifestDigest) {
      throw serviceManifestError(
        "storage_manifest_content_invalid",
        "Service manifest content digest does not match its immutable address."
      );
    }
    return bytes;
  }

  async function commit({
    previousPointer,
    generation,
    manifestBytes,
    manifestDigest,
    requestDigest,
    serviceId,
    terminalOutcome
  }, context) {
    context.check();
    await ensureLayout(context);
    const fence = await acquireWriterFence(context);
    try {
    validateManifestDigest(manifestDigest, "manifest digest");
    validateManifestDigest(requestDigest, "request digest");
    validateOpaqueServiceId(serviceId);
    if (sha256ManifestBytes(manifestBytes) !== manifestDigest) {
      throw serviceManifestError(
        "storage_manifest_content_invalid",
        "Service manifest canonical bytes do not match their digest."
      );
    }
    const generationBytes = Buffer.from(stableManifestJson(generation), "utf8");
    const generationDigest = sha256ManifestBytes(generationBytes);
    const candidatePointer = Object.freeze({
      schemaVersion: SERVICE_MANIFEST_POINTER_SCHEMA_VERSION,
      setRevision: generation.setRevision,
      setDigest: generation.setDigest,
      generationDigest
    });
    validateGeneration(generation, candidatePointer, context.budget);
    const currentPointer = await readPointer(context);
    if (!samePointer(currentPointer, previousPointer)) {
      throw serviceManifestError(
        "storage_manifest_cas_stale",
        "Service manifest durable pointer changed before publication."
      );
    }
    await writeImmutableFile({
      directoryPath: manifestsPath,
      digest: manifestDigest,
      kind: "manifest",
      bytes: manifestBytes,
      context
    });
    await writeImmutableFile({
      directoryPath: generationsPath,
      digest: generationDigest,
      kind: "generation",
      bytes: generationBytes,
      context
    });
    const journal = {
      schemaVersion: SERVICE_MANIFEST_JOURNAL_SCHEMA_VERSION,
      phase: "prepared",
      previousPointer,
      candidatePointer,
      requestDigest,
      serviceId,
      manifestDigest,
      terminalOutcome
    };
    validateJournal(journal);
    await writeStagedFile({
      directoryPath: rootPath,
      targetPath: journalPath,
      kind: "journal",
      bytes: Buffer.from(stableManifestJson(journal), "utf8"),
      context
    });
    context.check();
    await fence.assertOwned();
    await writeStagedFile({
      directoryPath: rootPath,
      targetPath: latestPath,
      kind: "latest",
      bytes: Buffer.from(stableManifestJson(candidatePointer), "utf8"),
      context
    });

    // The latest-pointer rename is the commit point. Journal cleanup is bounded
    // maintenance; a retained prepared journal is reconciled on the next open.
    await fence.assertOwned();
    try {
      await removeRegularFileAndSync(journalPath, rootPath);
    } catch {
      // A durable candidate pointer plus the prepared journal remains recoverable.
    }
    return candidatePointer;
    } finally {
      await fence.release();
    }
  }

  async function acknowledgePublished({ candidatePointer, candidateGeneration, publishedPointer, publishedGeneration }, context) {
    context.check();
    await ensureLayout(context);
    const fence = await acquireWriterFence(context);
    try {
      const durableCandidate = await readPointer(context);
      const durablePublished = await readPublishedPointer(context);
      if (!samePointer(durableCandidate, candidatePointer) || !samePointer(durablePublished, publishedPointer)) {
        throw serviceManifestError(
          "storage_manifest_cas_stale",
          "Service manifest publication authority changed before acknowledgement."
        );
      }
      await readGeneration(candidatePointer, context);
      await fence.assertOwned();
      await writeStagedFile({
        directoryPath: rootPath,
        targetPath: publishedPath,
        kind: "latest",
        bytes: Buffer.from(stableManifestJson(candidatePointer), "utf8"),
        context
      });
      await fence.assertOwned();
      try {
        await cleanupTemporaryFiles([rootPath, manifestsPath, generationsPath], context);
        const retainedGenerationDigests = new Set([candidatePointer, publishedPointer]
          .filter(Boolean)
          .map((pointer) => pointer.generationDigest));
        const retainedManifestDigests = new Set([
          ...candidateGeneration.services,
          ...(publishedGeneration?.services || [])
        ].map((entry) => entry.manifestDigest));
        await cleanupImmutableOrphans({
          directoryPath: generationsPath,
          retainedDigests: retainedGenerationDigests,
          context
        });
        await cleanupImmutableOrphans({
          directoryPath: manifestsPath,
          retainedDigests: retainedManifestDigests,
          context
        });
        await removeRegularFileAndSync(journalPath, rootPath);
      } catch {
        // published.json is the acknowledgement commit point. Cleanup is retryable
        // maintenance and cannot turn an accepted snapshot into an ambiguous error.
      }
      return candidatePointer;
    } finally {
      await fence.release();
    }
  }

  return Object.freeze({
    rootPath,
    manifestsPath,
    generationsPath,
    latestPath,
    publishedPath,
    journalPath,
    recover,
    readPublished,
    readManifest,
    commit,
    acknowledgePublished
  });
}
