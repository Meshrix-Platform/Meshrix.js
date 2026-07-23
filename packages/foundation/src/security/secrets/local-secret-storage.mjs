import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ServerConfig } from "#lico/server-config";
import {
  ensurePrivateDir as ensurePrivateDirSync,
  writePrivateFileAtomic
} from "../../storage/private-file-atomic.mjs";

const SECRET_STORE_DIR = "secrets";
const REGISTRY_FILE = "registry.json";
const AUDIT_FILE = "audit.jsonl";
const VALUES_DIR = "values";
const MUTATION_LOCK_FILE = ".mutation.lock";
const MUTATION_LOCK_WAIT_MS = 10_000;
const MUTATION_LOCK_STALE_MS = 30_000;

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return String(value ?? "").trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function resolveDataDir(dataDir = "") {
  return path.resolve(text(dataDir) || ServerConfig.getDataDir());
}

export function localSecretStorePaths({ dataDir = "" } = {}) {
  const resolvedDataDir = resolveDataDir(dataDir);
  const root = path.join(resolvedDataDir, SECRET_STORE_DIR);
  return {
    dataDir: resolvedDataDir,
    root,
    registryPath: path.join(root, REGISTRY_FILE),
    auditPath: path.join(root, AUDIT_FILE),
    valuesDir: path.join(root, VALUES_DIR),
    mutationLockPath: path.join(root, MUTATION_LOCK_FILE)
  };
}

export async function ensureLocalSecretPrivateDir(dir) {
  ensurePrivateDirSync(dir);
}

export async function readLocalSecretJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return clone(fallback);
    throw error;
  }
}

export async function writeLocalSecretJson(filePath, value) {
  await writePrivateFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendLocalSecretAudit(dataDir, event) {
  const paths = localSecretStorePaths({ dataDir });
  await ensureLocalSecretPrivateDir(paths.root);
  let existing = "";
  try {
    existing = await fs.readFile(paths.auditPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writePrivateFileAtomic(paths.auditPath, `${existing}${JSON.stringify(event)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function reclaimAbandonedMutationLock(lockPath) {
  let stat;
  let owner;
  try {
    [stat, owner] = await Promise.all([
      fs.stat(lockPath),
      readLocalSecretJson(lockPath, null)
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
  const ownerPid = Number(owner?.pid || 0);
  const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
  if (processIsAlive(ownerPid) && ageMs < MUTATION_LOCK_STALE_MS) {
    return false;
  }
  const abandonedPath = `${lockPath}.abandoned-${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, abandonedPath);
    await fs.unlink(abandonedPath).catch(() => {});
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
}

async function acquireMutationLock(dataDir = "") {
  const paths = localSecretStorePaths({ dataDir });
  await ensureLocalSecretPrivateDir(paths.root);
  const token = crypto.randomUUID();
  const deadline = Date.now() + MUTATION_LOCK_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      const handle = await fs.open(paths.mutationLockPath, "wx", 0o600);
      let initialized = false;
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: nowIso() })}\n`, "utf8");
        await handle.sync();
        initialized = true;
      } finally {
        await handle.close();
        if (!initialized) {
          await fs.unlink(paths.mutationLockPath).catch(() => {});
        }
      }
      return { lockPath: paths.mutationLockPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await reclaimAbandonedMutationLock(paths.mutationLockPath)) continue;
      await delay(15 + crypto.randomInt(35));
    }
  }
  const error = new Error("LicoMesh local secret store is busy; retry the operation.");
  error.code = "local_secret_store_busy";
  throw error;
}

async function mutationLockOwned(lock) {
  try {
    const owner = await readLocalSecretJson(lock.lockPath, null);
    return owner?.token === lock.token;
  } catch {
    return false;
  }
}

export async function assertLocalSecretMutationLockOwned(lock) {
  if (await mutationLockOwned(lock)) return;
  const error = new Error("LicoMesh local secret mutation lock ownership was lost.");
  error.code = "local_secret_store_lock_lost";
  throw error;
}

async function refreshMutationLock(lock) {
  if (!await mutationLockOwned(lock)) return;
  const now = new Date();
  await fs.utimes(lock.lockPath, now, now).catch(() => {});
}

async function releaseMutationLock(lock) {
  let owner;
  try {
    owner = await readLocalSecretJson(lock.lockPath, null);
  } catch {
    return;
  }
  if (owner?.token !== lock.token) return;
  const releasePath = `${lock.lockPath}.release-${lock.token}`;
  try {
    await fs.rename(lock.lockPath, releasePath);
    await fs.unlink(releasePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function withLocalSecretMutationLock(dataDir, callback) {
  const lock = await acquireMutationLock(dataDir);
  const heartbeat = setInterval(() => {
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
