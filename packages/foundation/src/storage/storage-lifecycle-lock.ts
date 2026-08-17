import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ServerConfig } from "#meshrix/server-config";

type UnknownRecord = Record<PropertyKey, unknown>;
type ProcessIdentitySource = "linux-proc-start" | "node-time-origin" | "posix-ps-start" | "windows-cim-start";
type LeaseState = "active" | "stale" | "unknown" | "absent";

interface LifecyclePaths {
  rootPath: string;
  lockRoot: string;
  runtimeLeasePath: string;
  maintenanceLockPath: string;
}

interface ProcessIdentity {
  value: string;
  source: ProcessIdentitySource;
}

interface LeaseRecord {
  state: LeaseState;
  pid?: number;
  token?: string;
  processIdentity?: string;
  processIdentitySource?: string;
  fileSignature?: string;
}

interface SharedRuntimeLease {
  rootPath: string;
  runtimeLeasePath: string;
  token: string;
  descriptor: number;
  referenceCount: number;
}

export interface StorageRuntimeLease {
  readonly rootPath: string;
  readonly released?: boolean;
  release(): void;
}

export interface StorageMaintenanceLock {
  readonly rootPath: string;
  assertRestoreQuiesced(): Promise<void>;
  release(): Promise<void>;
}

type StorageLifecycleError = Error & { code: string; reasonCode: string };

const LOCK_DIRECTORY = "locks";
const RUNTIME_LEASE_FILE = "storage-runtime.lease";
const MAINTENANCE_LOCK_FILE = "storage-backup-restore.lock";
const LEASE_SCHEMA_VERSION = "v0.0.1:schema:definition-1";
const RUNTIME_LEASE_REGISTRY = Symbol.for(
  "meshrix.storage.active-runtime-leases"
);
const processRegistry = process as NodeJS.Process & UnknownRecord;
const existingRuntimeLeaseRegistry = processRegistry[RUNTIME_LEASE_REGISTRY];
const activeRuntimeLeases: Map<string, SharedRuntimeLease> = existingRuntimeLeaseRegistry instanceof Map
  ? existingRuntimeLeaseRegistry as Map<string, SharedRuntimeLease>
  : new Map();
processRegistry[RUNTIME_LEASE_REGISTRY] = activeRuntimeLeases;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROCESS_IDENTITY_PATTERN = /^[a-f0-9]{64}$/u;
const PROCESS_IDENTITY_SOURCES = new Set<ProcessIdentitySource>([
  "linux-proc-start",
  "node-time-origin",
  "posix-ps-start",
  "windows-cim-start"
]);
const PROCESS_IDENTITY_CACHE = Symbol.for(
  "meshrix.storage.current-process-identity"
);

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? value as UnknownRecord : {};
}

function errorCode(error: unknown): string {
  return String(record(error).code || "");
}

function lifecycleError(code: string, message: string): StorageLifecycleError {
  const error = new Error(message) as StorageLifecycleError;
  error.name = "StorageLifecycleError";
  error.code = code;
  error.reasonCode = code;
  return error;
}

function storageRoot(userDataPath = ""): string {
  return path.resolve(userDataPath || ServerConfig.getDataDir());
}

function lifecyclePaths(userDataPath = ""): LifecyclePaths {
  const rootPath = storageRoot(userDataPath);
  const lockRoot = path.join(rootPath, LOCK_DIRECTORY);
  return {
    rootPath,
    lockRoot,
    runtimeLeasePath: path.join(lockRoot, RUNTIME_LEASE_FILE),
    maintenanceLockPath: path.join(lockRoot, MAINTENANCE_LOCK_FILE)
  };
}

function isWithin(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureLockRootSync(paths: LifecyclePaths): void {
  fs.mkdirSync(paths.lockRoot, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(paths.lockRoot);
  const realRoot = fs.realpathSync(paths.rootPath);
  const realLockRoot = fs.realpathSync(paths.lockRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !isWithin(realLockRoot, realRoot)) {
    throw lifecycleError("storage_lock_boundary_invalid", "Storage lifecycle lock directory has an unsafe boundary.");
  }
  fs.chmodSync(paths.lockRoot, 0o700);
}

async function ensureLockRoot(paths: LifecyclePaths): Promise<void> {
  await fs.promises.mkdir(paths.lockRoot, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(paths.lockRoot);
  const realRoot = await fs.promises.realpath(paths.rootPath);
  const realLockRoot = await fs.promises.realpath(paths.lockRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !isWithin(realLockRoot, realRoot)) {
    throw lifecycleError("storage_lock_boundary_invalid", "Storage lifecycle lock directory has an unsafe boundary.");
  }
  await fs.promises.chmod(paths.lockRoot, 0o700);
}

function hashProcessIdentity(value: unknown): string {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function currentNodeProcessIdentity(): string {
  if (!Number.isFinite(performance.timeOrigin) || performance.timeOrigin <= 0) return "";
  return hashProcessIdentity(
    `${process.platform}:${process.pid}:node-time-origin:${Math.trunc(performance.timeOrigin)}`
  );
}

function linuxProcessIdentity(pid: number): string {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = stat.lastIndexOf(")");
    if (closingParenthesis < 0) return "";
    const fieldsFromState = stat.slice(closingParenthesis + 1).trim().split(/\s+/u);
    const startTicks = fieldsFromState[19];
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!startTicks || !bootId) return "";
    return hashProcessIdentity(`linux:${bootId}:${pid}:${startTicks}`);
  } catch {
    return "";
  }
}

function posixProcessIdentity(pid: number): string {
  const executable = "/bin/ps";
  if (!fs.existsSync(executable)) return "";
  const result = spawnSync(executable, ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    maxBuffer: 4 * 1024,
    timeout: 5_000,
    windowsHide: true
  });
  const startedAt = String(result.stdout || "").trim().replace(/\s+/gu, " ");
  return result.status === 0 && startedAt
    ? hashProcessIdentity(`${process.platform}:${pid}:${startedAt}`)
    : "";
}

function windowsProcessIdentity(pid: number): string {
  const systemRoot = String(process.env.SystemRoot || "Windows");
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CreationDate.ToUniversalTime().Ticks`;
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    maxBuffer: 4 * 1024,
    timeout: 2_000,
    windowsHide: true
  });
  const startedAt = String(result.stdout || "").trim();
  return result.status === 0 && /^\d+$/u.test(startedAt)
    ? hashProcessIdentity(`win32:${pid}:${startedAt}`)
    : "";
}

function processIdentityForSource(pid: unknown, source: unknown): string {
  const selectedPid = Number(pid);
  if (!Number.isSafeInteger(selectedPid) || selectedPid <= 0) return "";
  if (source === "linux-proc-start" && process.platform === "linux") {
    return linuxProcessIdentity(selectedPid);
  }
  if (source === "posix-ps-start" && process.platform !== "win32") {
    return posixProcessIdentity(selectedPid);
  }
  if (source === "windows-cim-start" && process.platform === "win32") {
    return windowsProcessIdentity(selectedPid);
  }
  if (source === "node-time-origin" && selectedPid === process.pid) {
    return currentNodeProcessIdentity();
  }
  return "";
}

function currentProcessIdentity(): ProcessIdentity | null {
  const cached = processRegistry[PROCESS_IDENTITY_CACHE];
  if (cached && typeof cached === "object") {
    return cached as ProcessIdentity;
  }
  const operatingSystemSources: ProcessIdentitySource[] = process.platform === "linux"
    ? ["linux-proc-start", "posix-ps-start"]
    : process.platform === "win32"
      ? ["windows-cim-start"]
      : ["posix-ps-start"];
  for (const source of operatingSystemSources) {
    const value = processIdentityForSource(process.pid, source);
    if (value) {
      const identity = { value, source };
      processRegistry[PROCESS_IDENTITY_CACHE] = identity;
      return identity;
    }
  }
  const nodeIdentity = currentNodeProcessIdentity();
  if (!nodeIdentity) return null;
  const identity: ProcessIdentity = {
    value: nodeIdentity,
    source: "node-time-origin"
  };
  processRegistry[PROCESS_IDENTITY_CACHE] = identity;
  return identity;
}

function processState(pid: unknown, expectedIdentity: string, expectedIdentitySource: string): Exclude<LeaseState, "absent"> {
  const selectedPid = Number(pid);
  if (!Number.isSafeInteger(selectedPid) || selectedPid <= 0) return "unknown";
  try {
    process.kill(selectedPid, 0);
  } catch (error: unknown) {
    if (errorCode(error) === "ESRCH") return "stale";
    if (errorCode(error) !== "EPERM") return "unknown";
  }
  const actualIdentity = processIdentityForSource(selectedPid, expectedIdentitySource);
  if (!actualIdentity) return "unknown";
  return actualIdentity === expectedIdentity ? "active" : "stale";
}

function leaseFileSignature(stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map((value) => String(value))
    .join(":");
}

function normalizeLeaseRecord(parsed: unknown, fileSignature = ""): LeaseRecord {
  const source = record(parsed);
  const pid = Number(source.pid);
  const token = String(source.token || "");
  const expectedProcessIdentity = String(source.processIdentity || "").toLowerCase();
  const expectedProcessIdentitySource = String(source.processIdentitySource || "");
  const createdAt = String(source.createdAt || "");
  if (
    source.schemaVersion !== LEASE_SCHEMA_VERSION ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !UUID_PATTERN.test(token) ||
    !PROCESS_IDENTITY_PATTERN.test(expectedProcessIdentity) ||
    (expectedProcessIdentitySource && !PROCESS_IDENTITY_SOURCES.has(expectedProcessIdentitySource as ProcessIdentitySource)) ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    return { state: "unknown" };
  }
  return {
    state: processState(pid, expectedProcessIdentity, expectedProcessIdentitySource),
    pid,
    token,
    processIdentity: expectedProcessIdentity,
    processIdentitySource: expectedProcessIdentitySource,
    fileSignature
  };
}

function readLeaseSync(filePath: string): LeaseRecord {
  let descriptor: number | null = null;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(filePath, flags);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) return { state: "unknown" };
    const parsed: unknown = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (leaseFileSignature(before) !== leaseFileSignature(after)) {
      return { state: "unknown" };
    }
    return normalizeLeaseRecord(parsed, leaseFileSignature(after));
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { state: "absent" };
    return { state: "unknown" };
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the lease inspection result.
      }
    }
  }
}

async function readLease(filePath: string): Promise<LeaseRecord> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    handle = await fs.promises.open(filePath, flags);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return { state: "unknown" };
    const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
    const after = await handle.stat({ bigint: true });
    if (leaseFileSignature(before) !== leaseFileSignature(after)) {
      return { state: "unknown" };
    }
    return normalizeLeaseRecord(parsed, leaseFileSignature(after));
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { state: "absent" };
    return { state: "unknown" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function leasePayload(token: string): string {
  const identity = currentProcessIdentity();
  if (!identity || !PROCESS_IDENTITY_PATTERN.test(identity.value)) {
    throw lifecycleError(
      "storage_process_identity_unavailable",
      "Storage lifecycle ownership could not establish a process-start identity."
    );
  }
  return `${JSON.stringify({
    schemaVersion: LEASE_SCHEMA_VERSION,
    pid: process.pid,
    token,
    processIdentity: identity.value,
    processIdentitySource: identity.source,
    createdAt: new Date().toISOString()
  })}\n`;
}

function removeOwnedLeaseSync(filePath: string, token: string): void {
  const current = readLeaseSync(filePath);
  if (current.state === "absent" || current.token !== token) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Closing the database remains authoritative even when lease cleanup needs operator attention.
  }
}

function removeStaleLeaseSync(filePath: string, lease: LeaseRecord): boolean {
  if (lease?.state !== "stale" || !lease.fileSignature) return false;
  try {
    const current = fs.lstatSync(filePath, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      leaseFileSignature(current) !== lease.fileSignature
    ) {
      return false;
    }
    fs.rmSync(filePath);
    return true;
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT";
  }
}

async function removeStaleLease(filePath: string, lease: LeaseRecord): Promise<boolean> {
  if (lease?.state !== "stale" || !lease.fileSignature) return false;
  try {
    const current = await fs.promises.lstat(filePath, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      leaseFileSignature(current) !== lease.fileSignature
    ) {
      return false;
    }
    await fs.promises.rm(filePath);
    return true;
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT";
  }
}

function assertMaintenanceAvailableForRuntimeSync(maintenanceLockPath: string): void {
  let existing = readLeaseSync(maintenanceLockPath);
  if (existing.state === "absent") return;
  if (existing.state === "stale" && removeStaleLeaseSync(maintenanceLockPath, existing)) {
    existing = readLeaseSync(maintenanceLockPath);
    if (existing.state === "absent") return;
  }
  if (existing.state === "active") {
    throw lifecycleError(
      "storage_maintenance_active",
      "Storage maintenance is active; runtime startup is temporarily unavailable."
    );
  }
  throw lifecycleError(
    "storage_maintenance_state_unknown",
    "Storage maintenance ownership cannot be verified; runtime startup was refused."
  );
}

function createRuntimeLeaseHandle(sharedLease: SharedRuntimeLease): Readonly<StorageRuntimeLease> {
  let released = false;
  return Object.freeze({
    rootPath: sharedLease.rootPath,
    release(): void {
      if (released) return;
      if (sharedLease.referenceCount > 1) {
        sharedLease.referenceCount -= 1;
        released = true;
        return;
      }
      if (activeRuntimeLeases.get(sharedLease.rootPath) !== sharedLease) {
        released = true;
        return;
      }
      fs.closeSync(sharedLease.descriptor);
      removeOwnedLeaseSync(sharedLease.runtimeLeasePath, sharedLease.token);
      sharedLease.referenceCount = 0;
      activeRuntimeLeases.delete(sharedLease.rootPath);
      released = true;
    }
  });
}

export function acquireStorageRuntimeLease(userDataPath = ""): Readonly<StorageRuntimeLease> {
  const paths = lifecyclePaths(userDataPath);
  const sharedLease = activeRuntimeLeases.get(paths.rootPath);
  if (sharedLease) {
    sharedLease.referenceCount += 1;
    return createRuntimeLeaseHandle(sharedLease);
  }
  ensureLockRootSync(paths);
  const token = crypto.randomUUID();
  let payload: string | null = null;
  let descriptor: number | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let existing = readLeaseSync(paths.runtimeLeasePath);
    if (existing.state === "absent") {
      payload ||= leasePayload(token);
      try {
        descriptor = fs.openSync(paths.runtimeLeasePath, "wx", 0o600);
        break;
      } catch (error: unknown) {
        if (errorCode(error) !== "EEXIST") throw error;
        existing = readLeaseSync(paths.runtimeLeasePath);
      }
    }
    if (
      existing.state === "stale" &&
      attempt === 0 &&
      removeStaleLeaseSync(paths.runtimeLeasePath, existing)
    ) {
      continue;
    }
    const identity = currentProcessIdentity();
    if (
      existing.state === "active" &&
      existing.pid === process.pid &&
      identity?.value === existing.processIdentity
    ) {
      let released = false;
      return Object.freeze({
        rootPath: paths.rootPath,
        release(): void {
          released = true;
        },
        get released(): boolean {
          return released;
        }
      });
    }
    const code = existing.state === "active"
      ? "storage_runtime_active"
      : "storage_runtime_state_unknown";
    throw lifecycleError(code, "Storage runtime ownership is already held or cannot be verified.");
  }

  if (descriptor === null) {
    throw lifecycleError("storage_runtime_state_unknown", "Storage runtime ownership could not be acquired.");
  }
  if (payload === null) {
    fs.closeSync(descriptor);
    throw lifecycleError("storage_runtime_state_unknown", "Storage runtime ownership payload was not prepared.");
  }

  try {
    fs.writeFileSync(descriptor, payload, "utf8");
    fs.fsyncSync(descriptor);
    assertMaintenanceAvailableForRuntimeSync(paths.maintenanceLockPath);
  } catch (error: unknown) {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Preserve the acquisition failure.
    }
    removeOwnedLeaseSync(paths.runtimeLeasePath, token);
    throw error;
  }

  const lease: SharedRuntimeLease = {
    rootPath: paths.rootPath,
    runtimeLeasePath: paths.runtimeLeasePath,
    token,
    descriptor,
    referenceCount: 1
  };
  activeRuntimeLeases.set(paths.rootPath, lease);
  return createRuntimeLeaseHandle(lease);
}

export async function acquireStorageMaintenanceLock(userDataPath = ""): Promise<StorageMaintenanceLock> {
  const paths = lifecyclePaths(userDataPath);
  await ensureLockRoot(paths);
  const token = crypto.randomUUID();
  let payload: string | null = null;
  let handle: fs.promises.FileHandle | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let existing = await readLease(paths.maintenanceLockPath);
    if (existing.state === "absent") {
      payload ||= leasePayload(token);
      try {
        handle = await fs.promises.open(paths.maintenanceLockPath, "wx", 0o600);
        break;
      } catch (error: unknown) {
        if (errorCode(error) !== "EEXIST") throw error;
        existing = await readLease(paths.maintenanceLockPath);
      }
    }
    if (
      existing.state === "stale" &&
      attempt === 0 &&
      await removeStaleLease(paths.maintenanceLockPath, existing)
    ) {
      continue;
    }
    throw lifecycleError(
      "storage_operation_busy",
      "Another storage backup or restore operation is already active."
    );
  }

  if (!handle) {
    throw lifecycleError("storage_operation_busy", "Storage maintenance ownership could not be acquired.");
  }
  if (payload === null) {
    await handle.close().catch(() => {});
    throw lifecycleError("storage_operation_busy", "Storage maintenance ownership payload was not prepared.");
  }

  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } catch (error: unknown) {
    await handle.close().catch(() => {});
    await fs.promises.rm(paths.maintenanceLockPath, { force: true }).catch(() => {});
    throw error;
  }
  let released = false;
  return {
    rootPath: paths.rootPath,
    async assertRestoreQuiesced(): Promise<void> {
      if (activeRuntimeLeases.has(paths.rootPath)) {
        throw lifecycleError(
          "storage_restore_runtime_active",
          "Storage restore requires the runtime to be stopped and all storage resources to be closed."
        );
      }
      const runtimeLease = await readLease(paths.runtimeLeasePath);
      if (runtimeLease.state === "stale") {
        if (await removeStaleLease(paths.runtimeLeasePath, runtimeLease)) return;
        throw lifecycleError(
          "storage_restore_runtime_state_unknown",
          "Storage runtime ownership changed during verification; restore was refused."
        );
      }
      if (runtimeLease.state === "active") {
        throw lifecycleError(
          "storage_restore_runtime_active",
          "Storage restore requires the runtime to be stopped and all storage resources to be closed."
        );
      }
      if (runtimeLease.state === "unknown") {
        throw lifecycleError(
          "storage_restore_runtime_state_unknown",
          "Storage runtime ownership cannot be verified; restore was refused."
        );
      }
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await handle.close();
      } finally {
        const current = await readLease(paths.maintenanceLockPath);
        if (current.token === token) {
          await fs.promises.rm(paths.maintenanceLockPath, { force: true });
        }
      }
    }
  };
}
