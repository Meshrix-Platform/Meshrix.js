import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const REGISTRY_MUTATION_LOCK_FILE = ".mutation.lock";
const EXTERNAL_TRANSACTION_FILE = ".settings-transaction.json";
const REGISTRY_LOCK_WAIT_MS = 10_000;
const REGISTRY_LOCK_STALE_MS = 30_000;
const registryMutationQueues = new Map();

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return String(value || "").trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function registryLockOwned(lock) {
  try {
    const owner = await readJson(lock.lockPath, null);
    return owner?.token === lock.token;
  } catch {
    return false;
  }
}

async function reclaimAbandonedRegistryLock(lockPath) {
  let stat;
  let owner;
  try {
    [stat, owner] = await Promise.all([fs.stat(lockPath), readJson(lockPath, null)]);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
  const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
  if (processIsAlive(Number(owner?.pid || 0)) && ageMs < REGISTRY_LOCK_STALE_MS) {
    return false;
  }
  const abandonedPath = `${lockPath}.abandoned-${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, abandonedPath);
    await fs.rm(abandonedPath, { force: true });
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function acquireRegistryLock(rootPath) {
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  await fs.chmod(rootPath, 0o700);
  const lockPath = path.join(rootPath, REGISTRY_MUTATION_LOCK_FILE);
  const token = crypto.randomUUID();
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      let initialized = false;
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: nowIso() })}\n`, "utf8");
        await handle.sync();
        initialized = true;
      } finally {
        await handle.close();
        if (!initialized) await fs.rm(lockPath, { force: true }).catch(() => {});
      }
      return { lockPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await reclaimAbandonedRegistryLock(lockPath)) continue;
      await delay(15 + crypto.randomInt(35));
    }
  }
  const error = new Error("Agent config registry is busy; retry the mutation.");
  error.code = "agent_config_registry_busy";
  throw error;
}

async function releaseRegistryLock(lock) {
  if (!await registryLockOwned(lock)) return;
  const releasePath = `${lock.lockPath}.release-${lock.token}`;
  try {
    await fs.rename(lock.lockPath, releasePath);
    await fs.rm(releasePath, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function withRegistryLock(rootPath, task) {
  const lock = await acquireRegistryLock(rootPath);
  const heartbeat = setInterval(() => {
    void registryLockOwned(lock).then((owned) => {
      if (!owned) return;
      const now = new Date();
      return fs.utimes(lock.lockPath, now, now).catch(() => {});
    });
  }, Math.floor(REGISTRY_LOCK_STALE_MS / 3));
  heartbeat.unref?.();
  try {
    return await task();
  } finally {
    clearInterval(heartbeat);
    await releaseRegistryLock(lock);
  }
}

async function assertExternalTransactionAccess(rootPath, transactionId = "") {
  const journal = await readJson(path.join(rootPath, EXTERNAL_TRANSACTION_FILE), null);
  if (!journal) return;
  const activeTransactionId = text(journal.transactionId);
  if (activeTransactionId && activeTransactionId === text(transactionId)) return;
  const error = new Error("Agent config registry has a pending coordinated transaction.");
  error.code = "agent_config_registry_transaction_pending";
  throw error;
}

export async function mutateRegistry(rootPath, task, options = {}) {
  const previous = registryMutationQueues.get(rootPath) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => withRegistryLock(rootPath, async () => {
    await assertExternalTransactionAccess(rootPath, options.transactionId);
    return task();
  }));
  registryMutationQueues.set(rootPath, current);
  try {
    return await current;
  } finally {
    if (registryMutationQueues.get(rootPath) === current) {
      registryMutationQueues.delete(rootPath);
    }
  }
}
