import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const RECORD_NAMES: any = new Set<any>([
  "journal",
  "ledger",
  "artifact-install-journal",
  "artifact-removal-journal"
]);
const MAX_RECORD_BYTES: any = 64 * 1024;
const MAX_PLUGIN_LIFECYCLE_ROOTS: any = 1024;
const LEASE_DIRECTORY_NAME: any = "lease";
const LEASE_RECORD_NAME: any = "owner.json";
const LEASE_RECORD_KIND: any = "plugin-lifecycle-lease";
const LEASE_RECORD_FIELDS: readonly any[] = Object.freeze([
  "acquiredAtMs",
  "heartbeatIntervalMs",
  "kind",
  "leaseDurationMs",
  "ownerToken",
  "pluginId",
  "staleThresholdMs"
]);
const localQueues: any = new Map<any, any>();
const leaseContext: any = new AsyncLocalStorage();

export const PLUGIN_LIFECYCLE_LOCK_POLICY: Readonly<Record<string, any>> = Object.freeze({
  leaseDurationMs: 30_000,
  staleThresholdMs: 45_000,
  heartbeatIntervalMs: 10_000
});

function controlledError(code?: any, message?: any) : any {
  return Object.assign(new Error(message), { code });
}

function pluginId(value?: any) : any {
  const normalized: any = String(value || "").trim();
  if (!/^[a-z][a-z0-9-]*$/u.test(normalized)) {
    throw new TypeError("Plugin lifecycle state requires a valid plugin id.");
  }
  return normalized;
}

export async function discoverPluginLifecycleStateIds({ userDataPath }: Record<string, any> = {}) : Promise<any> {
  if (typeof userDataPath !== "string" || !userDataPath.trim()) {
    throw new TypeError("Plugin lifecycle discovery requires an explicit data root.");
  }
  const dataRoot: any = await fs.realpath(path.resolve(userDataPath));
  const lifecycleRoot: any = path.join(dataRoot, "plugin-lifecycle");
  let rootStat: any;
  try {
    rootStat = await fs.lstat(lifecycleRoot);
  } catch (error: any) {
    if (error?.code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw controlledError("PLUGIN_LIFECYCLE_ROOT_INVALID", "Plugin lifecycle root must be a real directory.");
  }
  const resolvedRoot: any = await fs.realpath(lifecycleRoot);
  if (path.relative(dataRoot, resolvedRoot) !== "plugin-lifecycle") {
    throw controlledError("PLUGIN_LIFECYCLE_ROOT_INVALID", "Plugin lifecycle root escaped its data root.");
  }
  const entries: any = await fs.readdir(resolvedRoot, { withFileTypes: true });
  if (entries.length > MAX_PLUGIN_LIFECYCLE_ROOTS) {
    throw controlledError("PLUGIN_LIFECYCLE_CATALOG_OVERSIZED", "Plugin lifecycle catalog exceeds its bound.");
  }
  const ids: any[] = [];
  for (const entry of entries.sort((left?: any, right?: any) : any => left.name.localeCompare(right.name))) {
    const id: any = pluginId(entry.name);
    const candidate: any = path.join(resolvedRoot, id);
    const stat: any = await fs.lstat(candidate);
    if (entry.isSymbolicLink() || stat.isSymbolicLink() || !entry.isDirectory() || !stat.isDirectory()) {
      throw controlledError("PLUGIN_LIFECYCLE_ENTRY_INVALID", "Plugin lifecycle entries must be real directories.");
    }
    const resolved: any = await fs.realpath(candidate);
    if (path.relative(resolvedRoot, resolved) !== id) {
      throw controlledError("PLUGIN_LIFECYCLE_ENTRY_INVALID", "Plugin lifecycle entry escaped its root.");
    }
    ids.push(id);
  }
  return Object.freeze(ids);
}

function recordName(value?: any) : any {
  const normalized: any = String(value || "").trim();
  if (!RECORD_NAMES.has(normalized)) {
    throw new TypeError("Plugin lifecycle record name is unsupported.");
  }
  return normalized;
}

function snapshot(value?: any) : any {
  let serialized: any;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("Plugin lifecycle record must be JSON-compatible.");
  }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw new TypeError("Plugin lifecycle record exceeds its bounded size.");
  }
  const parsed: any = JSON.parse(serialized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Plugin lifecycle record must be an object.");
  }
  const freeze: any = (entry?: any) : any => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return entry;
    for (const child of (Object.values(entry) as any[])) freeze(child);
    return Object.freeze(entry);
  };
  return freeze(parsed);
}

function normalizeLockPolicy(input: Record<string, any> = {}) : any {
  const policy: Record<string, any> = {
    leaseDurationMs: Number(input.leaseDurationMs ?? PLUGIN_LIFECYCLE_LOCK_POLICY.leaseDurationMs),
    staleThresholdMs: Number(input.staleThresholdMs ?? PLUGIN_LIFECYCLE_LOCK_POLICY.staleThresholdMs),
    heartbeatIntervalMs: Number(input.heartbeatIntervalMs ?? PLUGIN_LIFECYCLE_LOCK_POLICY.heartbeatIntervalMs)
  };
  if (!Number.isSafeInteger(policy.heartbeatIntervalMs) || policy.heartbeatIntervalMs < 10 ||
      !Number.isSafeInteger(policy.leaseDurationMs) || policy.leaseDurationMs <= policy.heartbeatIntervalMs ||
      !Number.isSafeInteger(policy.staleThresholdMs) || policy.staleThresholdMs < policy.leaseDurationMs) {
    throw new TypeError("Plugin lifecycle lock policy is invalid.");
  }
  return Object.freeze(policy);
}

async function ensureDirectory(directory?: any, parent?: any, label?: any) : Promise<any> {
  try {
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat: any = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  const resolved: any = await fs.realpath(directory);
  const relative: any = path.relative(parent, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped its parent.`);
  }
  return resolved;
}

async function syncDirectory(directory?: any) : Promise<any> {
  let handle: any;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    await handle.sync();
  } catch (error: any) {
    if (error?.code?.startsWith?.("PLUGIN_LIFECYCLE_")) throw error;
    throw controlledError(
      "PLUGIN_LIFECYCLE_DURABILITY_FAILED",
      "Plugin lifecycle durability sync failed."
    );
  } finally {
    await handle?.close().catch(() : any => {});
  }
}

async function readBoundedRegularFile(filePath?: any, missingValue?: any) : Promise<any> {
  let handle: any;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat: any = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error("invalid_lifecycle_record");
    const bytes: any = await handle.readFile();
    if (bytes.length > MAX_RECORD_BYTES) throw new Error("invalid_lifecycle_record");
    return bytes;
  } catch (error: any) {
    if (error?.code === "ENOENT") return missingValue;
    throw error;
  } finally {
    await handle?.close().catch(() : any => {});
  }
}

async function assertCommitFence() : Promise<any> {
  const lease: any = leaseContext.getStore();
  if (lease) await lease.assertOwned();
}

async function durableWriteThenRename(temporary?: any, destination?: any, content?: any, { enforceFence = true }: Record<string, any> = {}) : Promise<any> {
  let handle: any;
  try {
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    if (enforceFence) await assertCommitFence();
    await fs.rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
  } catch (error: any) {
    if (error?.code?.startsWith?.("PLUGIN_LIFECYCLE_")) throw error;
    throw controlledError(
      "PLUGIN_LIFECYCLE_DURABILITY_FAILED",
      "Plugin lifecycle durable write failed."
    );
  } finally {
    await handle?.close().catch(() : any => {});
  }
}

async function existingRegularFile(target?: any) : Promise<any> {
  try {
    const stat: any = await fs.lstat(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function validateLeaseRecord(value?: any, id?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== LEASE_RECORD_FIELDS.length ||
      Object.keys(value).sort().some((field?: any, index?: any) : any => field !== LEASE_RECORD_FIELDS[index]) ||
      value.kind !== LEASE_RECORD_KIND || value.pluginId !== id ||
      !/^[a-f0-9]{64}$/u.test(String(value.ownerToken || "")) ||
      !Number.isSafeInteger(value.acquiredAtMs) || value.acquiredAtMs < 0 ||
      !Number.isSafeInteger(value.heartbeatIntervalMs) || value.heartbeatIntervalMs < 10 ||
      !Number.isSafeInteger(value.leaseDurationMs) || value.leaseDurationMs <= value.heartbeatIntervalMs ||
      !Number.isSafeInteger(value.staleThresholdMs) || value.staleThresholdMs < value.leaseDurationMs) {
    throw controlledError(
      "PLUGIN_LIFECYCLE_LOCK_INVALID",
      "Plugin lifecycle lock metadata is invalid."
    );
  }
  return Object.freeze({ ...value });
}

async function readLeaseRecord(directory?: any, id?: any) : Promise<any> {
  try {
    const bytes: any = await readBoundedRegularFile(path.join(directory, LEASE_RECORD_NAME), null);
    if (!bytes) throw new Error("missing_lifecycle_lease_record");
    return validateLeaseRecord(JSON.parse(bytes.toString("utf8")), id);
  } catch (error: any) {
    if (error?.code === "PLUGIN_LIFECYCLE_LOCK_INVALID") throw error;
    throw controlledError(
      "PLUGIN_LIFECYCLE_LOCK_INVALID",
      "Plugin lifecycle lock metadata is invalid."
    );
  }
}

async function currentLease(lockPath?: any, id?: any) : Promise<any> {
  let stat: any;
  try {
    stat = await fs.lstat(lockPath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw controlledError("PLUGIN_LIFECYCLE_LOCK_INVALID", "Plugin lifecycle lock is invalid.");
  }
  return Object.freeze({
    record: await readLeaseRecord(lockPath, id),
    modifiedAtMs: stat.mtimeMs
  });
}

async function removeOwnedLock(lockPath?: any, id?: any, ownerToken?: any) : Promise<any> {
  const current: any = await currentLease(lockPath, id);
  if (!current || current.record.ownerToken !== ownerToken) return false;
  const releasePath: any = `${lockPath}.release-${ownerToken}`;
  try {
    await fs.rename(lockPath, releasePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const moved: any = await readLeaseRecord(releasePath, id);
  if (moved.ownerToken !== ownerToken) {
    await fs.rename(releasePath, lockPath).catch(() : any => {});
    return false;
  }
  await fs.rm(releasePath, { recursive: true, force: true });
  await syncDirectory(path.dirname(lockPath));
  return true;
}

async function takeOverStaleLock(lockPath?: any, id?: any, observed?: any, challengerToken?: any, nowMs?: any) : Promise<any> {
  if (nowMs - observed.modifiedAtMs <= observed.record.staleThresholdMs) return false;
  const stalePath: any = `${lockPath}.stale-${challengerToken}`;
  try {
    await fs.rename(lockPath, stalePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  const moved: any = await readLeaseRecord(stalePath, id);
  if (moved.ownerToken !== observed.record.ownerToken) {
    await fs.rename(stalePath, lockPath).catch(() : any => {});
    throw controlledError("PLUGIN_LIFECYCLE_BUSY", "Plugin lifecycle mutation is already running.");
  }
  await fs.rm(stalePath, { recursive: true, force: true });
  await syncDirectory(path.dirname(lockPath));
  return true;
}

async function acquireFilesystemLease({ lockPath, id, policyInput, scopeKey }: Record<string, any>) : Promise<any> {
  const policy: any = normalizeLockPolicy(policyInput);
  const now: any = typeof policyInput.now === "function" ? policyInput.now : Date.now;
  const ownerToken: any = crypto.randomBytes(32).toString("hex");
  let acquired: any = false;
  let record: any = null;
  for (let attempt: any = 0; attempt < 4; attempt += 1) {
    const stagingPath: any = `${lockPath}.acquire-${crypto.randomUUID()}`;
    let published: any = false;
    try {
      await fs.mkdir(stagingPath, { mode: 0o700 });
      record = Object.freeze({
        kind: LEASE_RECORD_KIND,
        pluginId: id,
        ownerToken,
        acquiredAtMs: now(),
        leaseDurationMs: policy.leaseDurationMs,
        staleThresholdMs: policy.staleThresholdMs,
        heartbeatIntervalMs: policy.heartbeatIntervalMs
      });
      const recordPath: any = path.join(stagingPath, LEASE_RECORD_NAME);
      const temporary: any = path.join(stagingPath, `.owner-${ownerToken}.tmp`);
      await durableWriteThenRename(
        temporary,
        recordPath,
        `${JSON.stringify(record)}\n`,
        { enforceFence: false }
      );
      await syncDirectory(stagingPath);
      try {
        await fs.rename(stagingPath, lockPath);
        published = true;
      } catch (error: any) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      }
      if (!published) {
        await fs.rm(stagingPath, { recursive: true, force: true });
        const observed: any = await currentLease(lockPath, id);
        if (!observed) continue;
        if (await takeOverStaleLock(lockPath, id, observed, ownerToken, now())) continue;
        throw controlledError("PLUGIN_LIFECYCLE_BUSY", "Plugin lifecycle mutation is already running.");
      }
      await syncDirectory(path.dirname(lockPath));
      acquired = true;
      break;
    } catch (error: any) {
      await fs.rm(stagingPath, { recursive: true, force: true }).catch(() : any => {});
      if (published) await removeOwnedLock(lockPath, id, ownerToken).catch(() : any => {});
      if (error?.code?.startsWith?.("PLUGIN_LIFECYCLE_")) throw error;
      throw controlledError(
        "PLUGIN_LIFECYCLE_DURABILITY_FAILED",
        "Plugin lifecycle lease publication failed."
      );
    }
  }
  if (!acquired) throw controlledError("PLUGIN_LIFECYCLE_BUSY", "Plugin lifecycle mutation is already running.");

  let directoryHandle: any;
  try {
    directoryHandle = await fs.open(lockPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  } catch (error: any) {
    await removeOwnedLock(lockPath, id, ownerToken).catch(() : any => {});
    throw controlledError(
      "PLUGIN_LIFECYCLE_DURABILITY_FAILED",
      "Plugin lifecycle lease publication failed."
    );
  }
  let heartbeatFailure: any = null;
  let heartbeatTail: any = Promise.resolve();
  let released: any = false;
  const heartbeat: any = setInterval(() : any => {
    heartbeatTail = heartbeatTail.then(async () : Promise<any> => {
      const timestamp: any = new Date(now());
      await directoryHandle.utimes(timestamp, timestamp);
    }).catch(() : any => {
      heartbeatFailure ||= controlledError(
        "PLUGIN_LIFECYCLE_LOCK_COMPROMISED",
        "Plugin lifecycle lock heartbeat failed."
      );
    });
  }, policy.heartbeatIntervalMs);
  heartbeat.unref?.();

  return Object.freeze({
    scopeKey,
    ownerToken,
    async assertOwned() : Promise<any> {
      if (released) {
        throw controlledError("PLUGIN_LIFECYCLE_LOCK_FENCE_LOST", "Plugin lifecycle lock ownership was lost.");
      }
      if (heartbeatFailure) throw heartbeatFailure;
      const current: any = await currentLease(lockPath, id);
      if (!current || current.record.ownerToken !== ownerToken) {
        throw controlledError("PLUGIN_LIFECYCLE_LOCK_FENCE_LOST", "Plugin lifecycle lock ownership was lost.");
      }
    },
    async release() : Promise<any> {
      if (released) return true;
      released = true;
      clearInterval(heartbeat);
      await heartbeatTail;
      await directoryHandle.close();
      const removed: any = await removeOwnedLock(lockPath, id, ownerToken);
      if (heartbeatFailure) throw heartbeatFailure;
      if (!removed) {
        throw controlledError("PLUGIN_LIFECYCLE_LOCK_FENCE_LOST", "Plugin lifecycle lock ownership was lost.");
      }
      return true;
    }
  });
}

export async function createPluginLifecycleStatePort({
  userDataPath,
  pluginId: rawPluginId,
  lockPolicy = {}
}: Record<string, any> = {}) : Promise<any> {
  const id: any = pluginId(rawPluginId);
  if (typeof userDataPath !== "string" || !userDataPath.trim()) {
    throw new TypeError("Plugin lifecycle state requires an explicit data root.");
  }
  const dataRoot: any = await fs.realpath(path.resolve(userDataPath));
  const lifecycleRoot: any = await ensureDirectory(
    path.join(dataRoot, "plugin-lifecycle"),
    dataRoot,
    "Plugin lifecycle root"
  );
  const root: any = await ensureDirectory(path.join(lifecycleRoot, id), lifecycleRoot, "Plugin lifecycle plugin root");
  const lockPath: any = path.join(root, LEASE_DIRECTORY_NAME);
  const queueKey: any = `plugin-lifecycle:${root}`;
  const target: any = (name?: any) : any => path.join(root, `${recordName(name)}.json`);
  const policy: any = normalizeLockPolicy(lockPolicy);

  const port: Record<string, any> = {
    id: "PluginLifecycleStatePort",
    pluginId: id,
    async readRecord(name?: any) : Promise<any> {
      const filePath: any = target(name);
      try {
        const bytes: any = await readBoundedRegularFile(filePath, null);
        if (bytes === null) return null;
        return snapshot(JSON.parse(bytes.toString("utf8")));
      } catch {
        throw controlledError(
          "PLUGIN_LIFECYCLE_STATE_READ_FAILED",
          "Plugin lifecycle record could not be read."
        );
      }
    },
    async writeRecord(name?: any, value?: any) : Promise<any> {
      const record: any = snapshot(value);
      const filePath: any = target(name);
      const temporary: any = path.join(root, `.record-${crypto.randomUUID()}.tmp`);
      try {
        const exists: any = await existingRegularFile(filePath);
        try {
          await fs.lstat(filePath);
          if (!exists) throw new Error("invalid_lifecycle_record_target");
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
        await durableWriteThenRename(temporary, filePath, JSON.stringify(record));
        return Object.freeze({ ok: true });
      } catch (error: any) {
        await fs.rm(temporary, { force: true }).catch(() : any => {});
        if (error?.code?.startsWith?.("PLUGIN_LIFECYCLE_LOCK_") ||
            error?.code === "PLUGIN_LIFECYCLE_DURABILITY_FAILED") throw error;
        throw controlledError(
          "PLUGIN_LIFECYCLE_STATE_WRITE_FAILED",
          "Plugin lifecycle record could not be written."
        );
      }
    },
    async assertExclusive() : Promise<any> {
      const lease: any = leaseContext.getStore();
      if (!lease || lease.scopeKey !== queueKey) {
        throw controlledError(
          "PLUGIN_LIFECYCLE_LOCK_REQUIRED",
          "Plugin lifecycle mutation requires the active lifecycle lock."
        );
      }
      await lease.assertOwned();
      return Object.freeze({ ok: true });
    },
    runExclusive(task?: any) : any {
      if (typeof task !== "function") {
        throw new TypeError("Plugin lifecycle state transaction requires a callback.");
      }
      const inheritedLease: any = leaseContext.getStore();
      if (inheritedLease?.scopeKey === queueKey) {
        return Promise.resolve().then(async () : Promise<any> => {
          await inheritedLease.assertOwned();
          return task();
        });
      }
      const predecessor: any = localQueues.get(queueKey) || Promise.resolve();
      let releaseQueue: any;
      const turn: any = new Promise((resolve?: any) : any => { releaseQueue = resolve; });
      const tail: any = predecessor.catch(() : any => {}).then(() : any => turn);
      localQueues.set(queueKey, tail);
      return (async () : Promise<any> => {
        await predecessor.catch(() : any => {});
        let lease: any;
        let taskFailure: any = null;
        try {
          lease = await acquireFilesystemLease({
            lockPath,
            id,
            scopeKey: queueKey,
            policyInput: { ...policy, now: lockPolicy.now }
          });
          return await leaseContext.run(lease, task);
        } catch (error: any) {
          taskFailure = error;
          throw error;
        } finally {
          try {
            await lease?.release();
          } catch (releaseError: any) {
            if (!taskFailure) throw releaseError;
          } finally {
            releaseQueue();
            if (localQueues.get(queueKey) === tail) localQueues.delete(queueKey);
          }
        }
      })();
    }
  };
  return Object.freeze(port);
}
