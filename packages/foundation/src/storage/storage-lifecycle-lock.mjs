import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ServerConfig } from "#lico/server-config";

const LOCK_DIRECTORY = "locks";
const RUNTIME_LEASE_FILE = "storage-runtime.lease";
const MAINTENANCE_LOCK_FILE = "storage-backup-restore.lock";
const LEASE_SCHEMA_VERSION = "v0.0.1:schema:definition-1";
const activeRuntimeLeases = new Map();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROCESS_IDENTITY_PATTERN = /^[a-f0-9]{64}$/u;
const PROCESS_IDENTITY_SOURCES = new Set([
  "linux-proc-start",
  "node-time-origin",
  "posix-ps-start",
  "windows-cim-start"
]);
let cachedCurrentProcessIdentity = null;

function lifecycleError(code, message) {
  const error = new Error(message);
  error.name = "StorageLifecycleError";
  error.code = code;
  error.reasonCode = code;
  return error;
}

function storageRoot(userDataPath = "") {
  return path.resolve(userDataPath || ServerConfig.getDataDir());
}

function lifecyclePaths(userDataPath = "") {
  const rootPath = storageRoot(userDataPath);
  const lockRoot = path.join(rootPath, LOCK_DIRECTORY);
  return {
    rootPath,
    lockRoot,
    runtimeLeasePath: path.join(lockRoot, RUNTIME_LEASE_FILE),
    maintenanceLockPath: path.join(lockRoot, MAINTENANCE_LOCK_FILE)
  };
}

function isWithin(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureLockRootSync(paths) {
  fs.mkdirSync(paths.lockRoot, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(paths.lockRoot);
  const realRoot = fs.realpathSync(paths.rootPath);
  const realLockRoot = fs.realpathSync(paths.lockRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !isWithin(realLockRoot, realRoot)) {
    throw lifecycleError("storage_lock_boundary_invalid", "Storage lifecycle lock directory has an unsafe boundary.");
  }
  fs.chmodSync(paths.lockRoot, 0o700);
}

async function ensureLockRoot(paths) {
  await fs.promises.mkdir(paths.lockRoot, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(paths.lockRoot);
  const realRoot = await fs.promises.realpath(paths.rootPath);
  const realLockRoot = await fs.promises.realpath(paths.lockRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !isWithin(realLockRoot, realRoot)) {
    throw lifecycleError("storage_lock_boundary_invalid", "Storage lifecycle lock directory has an unsafe boundary.");
  }
  await fs.promises.chmod(paths.lockRoot, 0o700);
}

function hashProcessIdentity(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function currentNodeProcessIdentity() {
  if (!Number.isFinite(performance.timeOrigin) || performance.timeOrigin <= 0) return "";
  return hashProcessIdentity(
    `${process.platform}:${process.pid}:node-time-origin:${Math.trunc(performance.timeOrigin)}`
  );
}

function linuxProcessIdentity(pid) {
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

function posixProcessIdentity(pid) {
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

function windowsProcessIdentity(pid) {
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

function processIdentityForSource(pid, source) {
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

function currentProcessIdentity() {
  if (cachedCurrentProcessIdentity) return cachedCurrentProcessIdentity;
  const operatingSystemSources = process.platform === "linux"
    ? ["linux-proc-start", "posix-ps-start"]
    : process.platform === "win32"
      ? ["windows-cim-start"]
      : ["posix-ps-start"];
  for (const source of operatingSystemSources) {
    const value = processIdentityForSource(process.pid, source);
    if (value) {
      cachedCurrentProcessIdentity = { value, source };
      return cachedCurrentProcessIdentity;
    }
  }
  const nodeIdentity = currentNodeProcessIdentity();
  if (!nodeIdentity) return null;
  cachedCurrentProcessIdentity = { value: nodeIdentity, source: "node-time-origin" };
  return cachedCurrentProcessIdentity;
}

function processState(pid, expectedIdentity, expectedIdentitySource) {
  const selectedPid = Number(pid);
  if (!Number.isSafeInteger(selectedPid) || selectedPid <= 0) return "unknown";
  try {
    process.kill(selectedPid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return "stale";
    if (error?.code !== "EPERM") return "unknown";
  }
  const actualIdentity = processIdentityForSource(selectedPid, expectedIdentitySource);
  if (!actualIdentity) return "unknown";
  return actualIdentity === expectedIdentity ? "active" : "stale";
}

function leaseFileSignature(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map((value) => String(value))
    .join(":");
}

function normalizeLeaseRecord(parsed, fileSignature = "") {
  const pid = Number(parsed?.pid);
  const token = String(parsed?.token || "");
  const expectedProcessIdentity = String(parsed?.processIdentity || "").toLowerCase();
  const expectedProcessIdentitySource = String(parsed?.processIdentitySource || "");
  const createdAt = String(parsed?.createdAt || "");
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schemaVersion !== LEASE_SCHEMA_VERSION ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !UUID_PATTERN.test(token) ||
    !PROCESS_IDENTITY_PATTERN.test(expectedProcessIdentity) ||
    (expectedProcessIdentitySource && !PROCESS_IDENTITY_SOURCES.has(expectedProcessIdentitySource)) ||
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

function readLeaseSync(filePath) {
  let descriptor = null;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(filePath, flags);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) return { state: "unknown" };
    const parsed = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (leaseFileSignature(before) !== leaseFileSignature(after)) {
      return { state: "unknown" };
    }
    return normalizeLeaseRecord(parsed, leaseFileSignature(after));
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
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

async function readLease(filePath) {
  let handle = null;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    handle = await fs.promises.open(filePath, flags);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return { state: "unknown" };
    const parsed = JSON.parse(await handle.readFile("utf8"));
    const after = await handle.stat({ bigint: true });
    if (leaseFileSignature(before) !== leaseFileSignature(after)) {
      return { state: "unknown" };
    }
    return normalizeLeaseRecord(parsed, leaseFileSignature(after));
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    return { state: "unknown" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function leasePayload(token) {
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

function removeOwnedLeaseSync(filePath, token) {
  const current = readLeaseSync(filePath);
  if (current.state === "absent" || current.token !== token) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Closing the database remains authoritative even when lease cleanup needs operator attention.
  }
}

function removeStaleLeaseSync(filePath, lease) {
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
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function removeStaleLease(filePath, lease) {
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
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function assertMaintenanceAvailableForRuntimeSync(maintenanceLockPath) {
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

function createRuntimeLeaseHandle(sharedLease) {
  let released = false;
  return Object.freeze({
    rootPath: sharedLease.rootPath,
    release() {
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

export function acquireStorageRuntimeLease(userDataPath = "") {
  const paths = lifecyclePaths(userDataPath);
  const sharedLease = activeRuntimeLeases.get(paths.rootPath);
  if (sharedLease) {
    sharedLease.referenceCount += 1;
    return createRuntimeLeaseHandle(sharedLease);
  }
  ensureLockRootSync(paths);
  const token = crypto.randomUUID();
  let payload = null;
  let descriptor = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let existing = readLeaseSync(paths.runtimeLeasePath);
    if (existing.state === "absent") {
      payload ||= leasePayload(token);
      try {
        descriptor = fs.openSync(paths.runtimeLeasePath, "wx", 0o600);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
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
    const code = existing.state === "active"
      ? "storage_runtime_active"
      : "storage_runtime_state_unknown";
    throw lifecycleError(code, "Storage runtime ownership is already held or cannot be verified.");
  }

  if (descriptor === null) {
    throw lifecycleError("storage_runtime_state_unknown", "Storage runtime ownership could not be acquired.");
  }

  try {
    fs.writeFileSync(descriptor, payload, "utf8");
    fs.fsyncSync(descriptor);
    assertMaintenanceAvailableForRuntimeSync(paths.maintenanceLockPath);
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Preserve the acquisition failure.
    }
    removeOwnedLeaseSync(paths.runtimeLeasePath, token);
    throw error;
  }

  const lease = {
    rootPath: paths.rootPath,
    runtimeLeasePath: paths.runtimeLeasePath,
    token,
    descriptor,
    referenceCount: 1
  };
  activeRuntimeLeases.set(paths.rootPath, lease);
  return createRuntimeLeaseHandle(lease);
}

export async function acquireStorageMaintenanceLock(userDataPath = "") {
  const paths = lifecyclePaths(userDataPath);
  await ensureLockRoot(paths);
  const token = crypto.randomUUID();
  let payload = null;
  let handle = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let existing = await readLease(paths.maintenanceLockPath);
    if (existing.state === "absent") {
      payload ||= leasePayload(token);
      try {
        handle = await fs.promises.open(paths.maintenanceLockPath, "wx", 0o600);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
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

  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.rm(paths.maintenanceLockPath, { force: true }).catch(() => {});
    throw error;
  }
  let released = false;
  return {
    rootPath: paths.rootPath,
    async assertRestoreQuiesced() {
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
    async release() {
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
