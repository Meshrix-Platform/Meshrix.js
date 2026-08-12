import crypto from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
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

export function createServiceData(root) {
  const dataRoot = path.resolve(String(root));
  const resolved = (resource) => path.join(dataRoot, ...relativeResource(resource).split("/"));

  async function ensureParent(target) {
    await mkdir(path.dirname(target), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }

  async function writeFileAtomic(resource, value, encoding = "utf8") {
    const target = resolved(resource);
    await ensureParent(target);
    const temporary = `${target}.tmp-${crypto.randomUUID()}`;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), encoding);
    const handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  }

  return Object.freeze({
    root: dataRoot,
    async initialize() {
      await mkdir(dataRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
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
    writeFile: writeFileAtomic,
    async stat(resource) {
      try {
        const facts = await stat(resolved(resource));
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
