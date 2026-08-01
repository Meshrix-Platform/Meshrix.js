import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const REGISTRY_MUTATION_LOCK_FILE: any = ".mutation.lock";
const EXTERNAL_TRANSACTION_FILE: any = ".settings-transaction.json";
const REGISTRY_LOCK_WAIT_MS: any = 10_000;
const REGISTRY_LOCK_STALE_MS: any = 30_000;
const registryMutationQueues: any = new Map<any, any>();

function nowIso() : any {
  return new Date().toISOString();
}

function text(value?: any) : any {
  return String(value || "").trim();
}

function delay(ms?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

async function readJson(filePath?: any, fallback?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function processIsAlive(pid?: any) : any {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

async function registryLockOwned(lock?: any) : Promise<any> {
  try {
    const owner: any = await readJson(lock.lockPath, null);
    return owner?.token === lock.token;
  } catch {
    return false;
  }
}

async function reclaimAbandonedRegistryLock(lockPath?: any) : Promise<any> {
  let stat: any;
  let owner: any;
  try {
    [stat, owner] = await Promise.all([fs.stat(lockPath), readJson(lockPath, null)]);
  } catch (error: any) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
  const ageMs: any = Math.max(0, Date.now() - stat.mtimeMs);
  if (processIsAlive(Number(owner?.pid || 0)) && ageMs < REGISTRY_LOCK_STALE_MS) {
    return false;
  }
  const abandonedPath: any = `${lockPath}.abandoned-${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, abandonedPath);
    await fs.rm(abandonedPath, { force: true });
    return true;
  } catch (error: any) {
    return error?.code === "ENOENT";
  }
}

async function acquireRegistryLock(rootPath?: any) : Promise<any> {
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  await fs.chmod(rootPath, 0o700);
  const lockPath: any = path.join(rootPath, REGISTRY_MUTATION_LOCK_FILE);
  const token: any = crypto.randomUUID();
  const deadline: any = Date.now() + REGISTRY_LOCK_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      const handle: any = await fs.open(lockPath, "wx", 0o600);
      let initialized: any = false;
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: nowIso() })}\n`, "utf8");
        await handle.sync();
        initialized = true;
      } finally {
        await handle.close();
        if (!initialized) await fs.rm(lockPath, { force: true }).catch(() : any => {});
      }
      return { lockPath, token };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (await reclaimAbandonedRegistryLock(lockPath)) continue;
      await delay(15 + crypto.randomInt(35));
    }
  }
  const error: Error & Record<string, any> = new Error("Agent config registry is busy; retry the mutation.");
  error.code = "agent_config_registry_busy";
  throw error;
}

async function releaseRegistryLock(lock?: any) : Promise<any> {
  if (!await registryLockOwned(lock)) return;
  const releasePath: any = `${lock.lockPath}.release-${lock.token}`;
  try {
    await fs.rename(lock.lockPath, releasePath);
    await fs.rm(releasePath, { force: true });
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function withRegistryLock(rootPath?: any, task?: any) : Promise<any> {
  const lock: any = await acquireRegistryLock(rootPath);
  const heartbeat: any = setInterval(() : any => {
    void registryLockOwned(lock).then((owned?: any) : any => {
      if (!owned) return;
      const now: any = new Date();
      return fs.utimes(lock.lockPath, now, now).catch(() : any => {});
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

async function assertExternalTransactionAccess(rootPath?: any, transactionId: any = "") : Promise<any> {
  const journal: any = await readJson(path.join(rootPath, EXTERNAL_TRANSACTION_FILE), null);
  if (!journal) return;
  const activeTransactionId: any = text(journal.transactionId);
  if (activeTransactionId && activeTransactionId === text(transactionId)) return;
  const error: Error & Record<string, any> = new Error("Agent config registry has a pending coordinated transaction.");
  error.code = "agent_config_registry_transaction_pending";
  throw error;
}

export async function mutateRegistry(rootPath?: any, task?: any, options: Record<string, any> = {}) : Promise<any> {
  const previous: any = registryMutationQueues.get(rootPath) || Promise.resolve();
  const current: any = previous.catch(() : any => {}).then(() : any => withRegistryLock(rootPath, async () : Promise<any> => {
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
