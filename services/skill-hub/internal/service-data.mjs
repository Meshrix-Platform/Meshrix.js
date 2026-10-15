import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function boundaryError() {
  return Object.assign(new Error("Skill Hub service data boundary rejected."), {
    code: "SERVICE_DATA_BOUNDARY_REJECTED"
  });
}

function relativeResource(value) {
  const normalized = String(value || "").replace(/\\/gu, "/");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.includes("\0") ||
      normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw boundaryError();
  }
  return normalized;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" || !["EACCES", "EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export function createServiceData(root) {
  const dataRoot = path.resolve(String(root));
  const resolved = (resource) => path.join(dataRoot, ...relativeResource(resource).split("/"));
  let directoryTail = Promise.resolve();
  const pendingDirectorySync = new Set();

  function ensureDirectory(directory) {
    // A concurrent writer must not use a newly created ancestor before the
    // operation that created it has persisted its directory entry.
    const operation = directoryTail.then(async () => {
      const firstCreated = await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      if (firstCreated) {
        const stop = path.dirname(firstCreated);
        for (let current = directory; ; current = path.dirname(current)) {
          pendingDirectorySync.add(current);
          if (current === stop) break;
        }
      }
      for (const current of pendingDirectorySync) {
        await syncDirectory(current);
        pendingDirectorySync.delete(current);
      }
    });
    directoryTail = operation.catch(() => {});
    return operation;
  }

  function ensureParent(target) {
    return ensureDirectory(path.dirname(target));
  }

  async function writeFileAtomic(resource, value, encoding = "utf8") {
    const target = resolved(resource);
    await ensureParent(target);
    const temporary = `${target}.tmp-${crypto.randomUUID()}`;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), encoding);
    let temporaryCreated = false;
    try {
      const handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
      temporaryCreated = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      temporaryCreated = false;
      await syncDirectory(path.dirname(target));
    } catch (error) {
      if (temporaryCreated) {
        try { await unlink(temporary); } catch (cleanupError) {
          if (cleanupError?.code !== "ENOENT") throw new AggregateError([error, cleanupError], "Service data write and temporary cleanup failed.");
        }
      }
      throw error;
    }
  }

  return Object.freeze({
    root: dataRoot,
    async initialize() {
      await ensureDirectory(dataRoot);
    },
    async readFile(resource, encoding = "utf8") {
      try {
        return await readFile(resolved(resource), encoding || undefined);
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw Object.assign(new Error("Skill Hub service data record is absent."), {
            code: "SERVICE_DATA_NOT_FOUND"
          });
        }
        throw error;
      }
    },
    async openDatabase(resource) {
      const target = resolved(resource);
      await ensureParent(target);
      let createdHandle;
      try {
        createdHandle = await open(target, "wx", PRIVATE_FILE_MODE);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const facts = await lstat(target);
        if (!facts.isFile() || facts.isSymbolicLink()) throw boundaryError();
        await chmod(target, PRIVATE_FILE_MODE);
      } finally {
        await createdHandle?.close();
      }
      const database = new DatabaseSync(target, { allowExtension: false });
      try {
        database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA;");
        return database;
      } catch (error) {
        database.close();
        throw error;
      }
    },
    writeFile: writeFileAtomic,
    async relocateFile(sourceResource, targetResource) {
      const source = resolved(sourceResource);
      const target = resolved(targetResource);
      await ensureParent(target);
      try {
        await link(source, target);
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        if (error?.code !== "EEXIST") throw error;
        // Resume safely after a completed link and interrupted source removal.
        const [sourceFacts, targetFacts] = await Promise.all([lstat(source), lstat(target)]).catch((cause) => {
          if (cause?.code === "ENOENT") return [];
          throw cause;
        });
        if (!sourceFacts) return false;
        if (!sourceFacts.isFile() || sourceFacts.isSymbolicLink() ||
            !targetFacts.isFile() || targetFacts.isSymbolicLink()) {
          throw boundaryError();
        }
        if (sourceFacts.dev !== targetFacts.dev || sourceFacts.ino !== targetFacts.ino) {
          throw Object.assign(new Error("Registry ownership destination already exists."), {
            code: "skill_hub_registry_ownership_conflict"
          });
        }
      }
      await syncDirectory(path.dirname(target));
      try {
        await unlink(source);
      } catch (error) {
        // Another process may have completed the same idempotent relocation.
        if (error?.code !== "ENOENT") throw error;
      }
      await syncDirectory(path.dirname(source));
      return true;
    },
    async stat(resource) {
      try {
        const facts = await lstat(resolved(resource));
        return Object.freeze({ type: facts.isFile() ? "file" : "other", executable: (facts.mode & 0o111) !== 0 });
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw Object.assign(new Error("Skill Hub service data record is absent."), {
            code: "SERVICE_DATA_NOT_FOUND"
          });
        }
        throw error;
      }
    },
    async deleteFile(resource) {
      try {
        await unlink(resolved(resource));
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    },
    packageResource(digest) {
      if (!/^[a-f0-9]{64}$/u.test(String(digest || ""))) throw boundaryError();
      return `SkillHub/packages/${digest}.bundle`;
    }
  });
}
