import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ServerConfig } from "#meshrix/server-config";

const LOCK_DIRECTORY: any = "locks";
const RUNTIME_LEASE_FILE: any = "storage-runtime.lease";
const MAINTENANCE_LOCK_FILE: any = "storage-backup-restore.lock";
const LEASE_SCHEMA_VERSION: any = "v0.0.1:schema:definition-1";
const RUNTIME_LEASE_REGISTRY: any = Symbol.for(
  "meshrix.storage.active-runtime-leases"
);
const processRegistry: Record<PropertyKey, any> = process as any;
const activeRuntimeLeases: any =
  processRegistry[RUNTIME_LEASE_REGISTRY] ||
  (processRegistry[RUNTIME_LEASE_REGISTRY] =
    new Map<any, any>());
const UUID_PATTERN: any = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROCESS_IDENTITY_PATTERN: any = /^[a-f0-9]{64}$/u;
const PROCESS_IDENTITY_SOURCES: any = new Set<any>([
  "linux-proc-start",
  "node-time-origin",
  "posix-ps-start",
  "windows-cim-start"
]);
const PROCESS_IDENTITY_CACHE: any = Symbol.for(
  "meshrix.storage.current-process-identity"
);

function lifecycleError(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.name = "StorageLifecycleError";
  error.code = code;
  error.reasonCode = code;
  return error;
}

function storageRoot(userDataPath: any = "") : any {
  return path.resolve(userDataPath || ServerConfig.getDataDir());
}

function lifecyclePaths(userDataPath: any = "") : any {
  const rootPath: any = storageRoot(userDataPath);
  const lockRoot: any = path.join(rootPath, LOCK_DIRECTORY);
  return {
    rootPath,
    lockRoot,
    runtimeLeasePath: path.join(lockRoot, RUNTIME_LEASE_FILE),
    maintenanceLockPath: path.join(lockRoot, MAINTENANCE_LOCK_FILE)
  };
}

function isWithin(candidatePath?: any, rootPath?: any) : any {
  const relative: any = path.relative(rootPath, candidatePath);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureLockRootSync(paths?: any) : any {
  fs.mkdirSync(paths.lockRoot, { recursive: true, mode: 0o700 });
  const stat: any = fs.lstatSync(paths.lockRoot);
  const realRoot: any = fs.realpathSync(paths.rootPath);
  const realLockRoot: any = fs.realpathSync(paths.lockRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !isWithin(realLockRoot, realRoot)) {
    throw lifecycleError("storage_lock_boundary_invalid", "Storage lifecycle lock directory has an unsafe boundary.");
  }
  fs.chmodSync(paths.lockRoot, 0o700);
}

async function ensureLockRoot(paths?: any) : Promise<any> {
  await fs.promises.mkdir(paths.lockRoot, { recursive: true, mode: 0o700 });
  const stat: any = await fs.promises.lstat(paths.lockRoot);
  const realRoot: any = await fs.promises.realpath(paths.rootPath);
  const realLockRoot: any = await fs.promises.realpath(paths.lockRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !isWithin(realLockRoot, realRoot)) {
    throw lifecycleError("storage_lock_boundary_invalid", "Storage lifecycle lock directory has an unsafe boundary.");
  }
  await fs.promises.chmod(paths.lockRoot, 0o700);
}

function hashProcessIdentity(value?: any) : any {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function currentNodeProcessIdentity() : any {
  if (!Number.isFinite(performance.timeOrigin) || performance.timeOrigin <= 0) return "";
  return hashProcessIdentity(
    `${process.platform}:${process.pid}:node-time-origin:${Math.trunc(performance.timeOrigin)}`
  );
}

function linuxProcessIdentity(pid?: any) : any {
  try {
    const stat: any = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis: any = stat.lastIndexOf(")");
    if (closingParenthesis < 0) return "";
    const fieldsFromState: any = stat.slice(closingParenthesis + 1).trim().split(/\s+/u);
    const startTicks: any = fieldsFromState[19];
    const bootId: any = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!startTicks || !bootId) return "";
    return hashProcessIdentity(`linux:${bootId}:${pid}:${startTicks}`);
  } catch {
    return "";
  }
}

function posixProcessIdentity(pid?: any) : any {
  const executable: any = "/bin/ps";
  if (!fs.existsSync(executable)) return "";
  const result: any = spawnSync(executable, ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    maxBuffer: 4 * 1024,
    timeout: 5_000,
    windowsHide: true
  });
  const startedAt: any = String(result.stdout || "").trim().replace(/\s+/gu, " ");
  return result.status === 0 && startedAt
    ? hashProcessIdentity(`${process.platform}:${pid}:${startedAt}`)
    : "";
}

function windowsProcessIdentity(pid?: any) : any {
  const systemRoot: any = String(process.env.SystemRoot || "Windows");
  const executable: any = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command: any = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CreationDate.ToUniversalTime().Ticks`;
  const result: any = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    maxBuffer: 4 * 1024,
    timeout: 2_000,
    windowsHide: true
  });
  const startedAt: any = String(result.stdout || "").trim();
  return result.status === 0 && /^\d+$/u.test(startedAt)
    ? hashProcessIdentity(`win32:${pid}:${startedAt}`)
    : "";
}

function processIdentityForSource(pid?: any, source?: any) : any {
  const selectedPid: any = Number(pid);
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

function currentProcessIdentity() : any {
  const globalState: Record<PropertyKey, any> = processRegistry;
  if (globalState[PROCESS_IDENTITY_CACHE]) {
    return globalState[PROCESS_IDENTITY_CACHE];
  }
  const operatingSystemSources: any = process.platform === "linux"
    ? ["linux-proc-start", "posix-ps-start"]
    : process.platform === "win32"
      ? ["windows-cim-start"]
      : ["posix-ps-start"];
  for (const source of operatingSystemSources) {
    const value: any = processIdentityForSource(process.pid, source);
    if (value) {
      globalState[PROCESS_IDENTITY_CACHE] = { value, source };
      return globalState[PROCESS_IDENTITY_CACHE];
    }
  }
  const nodeIdentity: any = currentNodeProcessIdentity();
  if (!nodeIdentity) return null;
  globalState[PROCESS_IDENTITY_CACHE] = {
    value: nodeIdentity,
    source: "node-time-origin"
  };
  return globalState[PROCESS_IDENTITY_CACHE];
}

function processState(pid?: any, expectedIdentity?: any, expectedIdentitySource?: any) : any {
  const selectedPid: any = Number(pid);
  if (!Number.isSafeInteger(selectedPid) || selectedPid <= 0) return "unknown";
  try {
    process.kill(selectedPid, 0);
  } catch (error: any) {
    if (error?.code === "ESRCH") return "stale";
    if (error?.code !== "EPERM") return "unknown";
  }
  const actualIdentity: any = processIdentityForSource(selectedPid, expectedIdentitySource);
  if (!actualIdentity) return "unknown";
  return actualIdentity === expectedIdentity ? "active" : "stale";
}

function leaseFileSignature(stat?: any) : any {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map((value?: any) : any => String(value))
    .join(":");
}

function normalizeLeaseRecord(parsed?: any, fileSignature: any = "") : any {
  const pid: any = Number(parsed?.pid);
  const token: any = String(parsed?.token || "");
  const expectedProcessIdentity: any = String(parsed?.processIdentity || "").toLowerCase();
  const expectedProcessIdentitySource: any = String(parsed?.processIdentitySource || "");
  const createdAt: any = String(parsed?.createdAt || "");
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

function readLeaseSync(filePath?: any) : any {
  let descriptor: any = null;
  try {
    const flags: any = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(filePath, flags);
    const before: any = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) return { state: "unknown" };
    const parsed: any = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    const after: any = fs.fstatSync(descriptor, { bigint: true });
    if (leaseFileSignature(before) !== leaseFileSignature(after)) {
      return { state: "unknown" };
    }
    return normalizeLeaseRecord(parsed, leaseFileSignature(after));
  } catch (error: any) {
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

async function readLease(filePath?: any) : Promise<any> {
  let handle: any = null;
  try {
    const flags: any = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    handle = await fs.promises.open(filePath, flags);
    const before: any = await handle.stat({ bigint: true });
    if (!before.isFile()) return { state: "unknown" };
    const parsed: any = JSON.parse(await handle.readFile("utf8"));
    const after: any = await handle.stat({ bigint: true });
    if (leaseFileSignature(before) !== leaseFileSignature(after)) {
      return { state: "unknown" };
    }
    return normalizeLeaseRecord(parsed, leaseFileSignature(after));
  } catch (error: any) {
    if (error?.code === "ENOENT") return { state: "absent" };
    return { state: "unknown" };
  } finally {
    await handle?.close().catch(() : any => {});
  }
}

function leasePayload(token?: any) : any {
  const identity: any = currentProcessIdentity();
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

function removeOwnedLeaseSync(filePath?: any, token?: any) : any {
  const current: any = readLeaseSync(filePath);
  if (current.state === "absent" || current.token !== token) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Closing the database remains authoritative even when lease cleanup needs operator attention.
  }
}

function removeStaleLeaseSync(filePath?: any, lease?: any) : any {
  if (lease?.state !== "stale" || !lease.fileSignature) return false;
  try {
    const current: any = fs.lstatSync(filePath, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      leaseFileSignature(current) !== lease.fileSignature
    ) {
      return false;
    }
    fs.rmSync(filePath);
    return true;
  } catch (error: any) {
    return error?.code === "ENOENT";
  }
}

async function removeStaleLease(filePath?: any, lease?: any) : Promise<any> {
  if (lease?.state !== "stale" || !lease.fileSignature) return false;
  try {
    const current: any = await fs.promises.lstat(filePath, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      leaseFileSignature(current) !== lease.fileSignature
    ) {
      return false;
    }
    await fs.promises.rm(filePath);
    return true;
  } catch (error: any) {
    return error?.code === "ENOENT";
  }
}

function assertMaintenanceAvailableForRuntimeSync(maintenanceLockPath?: any) : any {
  let existing: any = readLeaseSync(maintenanceLockPath);
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

function createRuntimeLeaseHandle(sharedLease?: any) : any {
  let released: any = false;
  return Object.freeze({
    rootPath: sharedLease.rootPath,
    release() : any {
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

export function acquireStorageRuntimeLease(userDataPath: any = "") : any {
  const paths: any = lifecyclePaths(userDataPath);
  const sharedLease: any = activeRuntimeLeases.get(paths.rootPath);
  if (sharedLease) {
    sharedLease.referenceCount += 1;
    return createRuntimeLeaseHandle(sharedLease);
  }
  ensureLockRootSync(paths);
  const token: any = crypto.randomUUID();
  let payload: any = null;
  let descriptor: any = null;

  for (let attempt: any = 0; attempt < 2; attempt += 1) {
    let existing: any = readLeaseSync(paths.runtimeLeasePath);
    if (existing.state === "absent") {
      payload ||= leasePayload(token);
      try {
        descriptor = fs.openSync(paths.runtimeLeasePath, "wx", 0o600);
        break;
      } catch (error: any) {
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
    const identity: any = currentProcessIdentity();
    if (
      existing.state === "active" &&
      existing.pid === process.pid &&
      identity?.value === existing.processIdentity
    ) {
      let released: any = false;
      return Object.freeze({
        rootPath: paths.rootPath,
        release() : any {
          released = true;
        },
        get released() : any {
          return released;
        }
      });
    }
    const code: any = existing.state === "active"
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
  } catch (error: any) {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Preserve the acquisition failure.
    }
    removeOwnedLeaseSync(paths.runtimeLeasePath, token);
    throw error;
  }

  const lease: Record<string, any> = {
    rootPath: paths.rootPath,
    runtimeLeasePath: paths.runtimeLeasePath,
    token,
    descriptor,
    referenceCount: 1
  };
  activeRuntimeLeases.set(paths.rootPath, lease);
  return createRuntimeLeaseHandle(lease);
}

export async function acquireStorageMaintenanceLock(userDataPath: any = "") : Promise<any> {
  const paths: any = lifecyclePaths(userDataPath);
  await ensureLockRoot(paths);
  const token: any = crypto.randomUUID();
  let payload: any = null;
  let handle: any = null;

  for (let attempt: any = 0; attempt < 2; attempt += 1) {
    let existing: any = await readLease(paths.maintenanceLockPath);
    if (existing.state === "absent") {
      payload ||= leasePayload(token);
      try {
        handle = await fs.promises.open(paths.maintenanceLockPath, "wx", 0o600);
        break;
      } catch (error: any) {
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
  } catch (error: any) {
    await handle.close().catch(() : any => {});
    await fs.promises.rm(paths.maintenanceLockPath, { force: true }).catch(() : any => {});
    throw error;
  }
  let released: any = false;
  return {
    rootPath: paths.rootPath,
    async assertRestoreQuiesced() : Promise<any> {
      if (activeRuntimeLeases.has(paths.rootPath)) {
        throw lifecycleError(
          "storage_restore_runtime_active",
          "Storage restore requires the runtime to be stopped and all storage resources to be closed."
        );
      }
      const runtimeLease: any = await readLease(paths.runtimeLeasePath);
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
    async release() : Promise<any> {
      if (released) return;
      released = true;
      try {
        await handle.close();
      } finally {
        const current: any = await readLease(paths.maintenanceLockPath);
        if (current.token === token) {
          await fs.promises.rm(paths.maintenanceLockPath, { force: true });
        }
      }
    }
  };
}
