import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ServerConfig } from "#meshrix/server-config";
import {
  ensurePrivateDir as ensurePrivateDirSync,
  writePrivateFileAtomic
} from "../../storage/private-file-atomic.ts";

const SECRET_STORE_DIR: any = "secrets";
const REGISTRY_FILE: any = "registry.json";
const AUDIT_FILE: any = "audit.jsonl";
const VALUES_DIR: any = "values";
const MUTATION_LOCK_FILE: any = ".mutation.lock";
const MUTATION_LOCK_WAIT_MS: any = 10_000;
const MUTATION_LOCK_STALE_MS: any = 30_000;

function nowIso() : any {
  return new Date().toISOString();
}

function text(value?: any) : any {
  return String(value ?? "").trim();
}

function clone(value?: any) : any {
  return JSON.parse(JSON.stringify(value ?? null));
}

function resolveDataDir(dataDir: any = "") : any {
  return path.resolve(text(dataDir) || ServerConfig.getDataDir());
}

export function localSecretStorePaths({ dataDir = "" }: Record<string, any> = {}) : any {
  const resolvedDataDir: any = resolveDataDir(dataDir);
  const root: any = path.join(resolvedDataDir, SECRET_STORE_DIR);
  return {
    dataDir: resolvedDataDir,
    root,
    registryPath: path.join(root, REGISTRY_FILE),
    auditPath: path.join(root, AUDIT_FILE),
    valuesDir: path.join(root, VALUES_DIR),
    mutationLockPath: path.join(root, MUTATION_LOCK_FILE)
  };
}

export async function ensureLocalSecretPrivateDir(dir?: any) : Promise<any> {
  ensurePrivateDirSync(dir);
}

export async function readLocalSecretJson(filePath?: any, fallback?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return clone(fallback);
    throw error;
  }
}

export async function writeLocalSecretJson(filePath?: any, value?: any) : Promise<any> {
  await writePrivateFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendLocalSecretAudit(dataDir?: any, event?: any) : Promise<any> {
  const paths: any = localSecretStorePaths({ dataDir });
  await ensureLocalSecretPrivateDir(paths.root);
  let existing: any = "";
  try {
    existing = await fs.readFile(paths.auditPath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writePrivateFileAtomic(paths.auditPath, `${existing}${JSON.stringify(event)}\n`);
}

function delay(ms?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, ms));
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

async function reclaimAbandonedMutationLock(lockPath?: any) : Promise<any> {
  let stat: any;
  let owner: any;
  try {
    [stat, owner] = await Promise.all([
      fs.stat(lockPath),
      readLocalSecretJson(lockPath, null)
    ]);
  } catch (error: any) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
  const ownerPid: any = Number(owner?.pid || 0);
  const ageMs: any = Math.max(0, Date.now() - stat.mtimeMs);
  if (processIsAlive(ownerPid) && ageMs < MUTATION_LOCK_STALE_MS) {
    return false;
  }
  const abandonedPath: any = `${lockPath}.abandoned-${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, abandonedPath);
    await fs.unlink(abandonedPath).catch(() : any => {});
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
}

async function acquireMutationLock(dataDir: any = "") : Promise<any> {
  const paths: any = localSecretStorePaths({ dataDir });
  await ensureLocalSecretPrivateDir(paths.root);
  const token: any = crypto.randomUUID();
  const deadline: any = Date.now() + MUTATION_LOCK_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      const handle: any = await fs.open(paths.mutationLockPath, "wx", 0o600);
      let initialized: any = false;
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: nowIso() })}\n`, "utf8");
        await handle.sync();
        initialized = true;
      } finally {
        await handle.close();
        if (!initialized) {
          await fs.unlink(paths.mutationLockPath).catch(() : any => {});
        }
      }
      return { lockPath: paths.mutationLockPath, token };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (await reclaimAbandonedMutationLock(paths.mutationLockPath)) continue;
      await delay(15 + crypto.randomInt(35));
    }
  }
  const error: Error & Record<string, any> = new Error("Meshrix local secret store is busy; retry the operation.");
  error.code = "local_secret_store_busy";
  throw error;
}

async function mutationLockOwned(lock?: any) : Promise<any> {
  try {
    const owner: any = await readLocalSecretJson(lock.lockPath, null);
    return owner?.token === lock.token;
  } catch {
    return false;
  }
}

export async function assertLocalSecretMutationLockOwned(lock?: any) : Promise<any> {
  if (await mutationLockOwned(lock)) return;
  const error: Error & Record<string, any> = new Error("Meshrix local secret mutation lock ownership was lost.");
  error.code = "local_secret_store_lock_lost";
  throw error;
}

async function refreshMutationLock(lock?: any) : Promise<any> {
  if (!await mutationLockOwned(lock)) return;
  const now: any = new Date();
  await fs.utimes(lock.lockPath, now, now).catch(() : any => {});
}

async function releaseMutationLock(lock?: any) : Promise<any> {
  let owner: any;
  try {
    owner = await readLocalSecretJson(lock.lockPath, null);
  } catch {
    return;
  }
  if (owner?.token !== lock.token) return;
  const releasePath: any = `${lock.lockPath}.release-${lock.token}`;
  try {
    await fs.rename(lock.lockPath, releasePath);
    await fs.unlink(releasePath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function withLocalSecretMutationLock(dataDir?: any, callback?: any) : Promise<any> {
  const lock: any = await acquireMutationLock(dataDir);
  const heartbeat: any = setInterval(() : any => {
    void refreshMutationLock(lock);
  }, Math.floor(MUTATION_LOCK_STALE_MS / 3));
  heartbeat.unref?.();
  try {
    return await callback(lock);
  } finally {
    clearInterval(heartbeat);
    await releaseMutationLock(lock);
  }
}
