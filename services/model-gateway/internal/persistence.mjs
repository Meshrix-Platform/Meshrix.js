import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MODE_PRIVATE = 0o600;

export async function ensureDataRoot(dataRoot) {
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
}

export function createFileStore(dataRoot) {
  function target(relativePath) {
    if (typeof relativePath !== "string" || relativePath.length === 0 ||
        path.isAbsolute(relativePath) || relativePath.includes("..")) {
      throw new TypeError("Store path must be a safe relative path.");
    }
    return path.join(dataRoot, relativePath);
  }

  async function readJson(relativePath, fallback) {
    try {
      const bytes = await fs.readFile(target(relativePath));
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return fallback;
      throw error;
    }
  }

  async function writeJsonAtomic(relativePath, value) {
    const finalPath = target(relativePath);
    await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    const temporary = `${finalPath}.tmp-${crypto.randomUUID()}`;
    const handle = await fs.open(temporary, "w", MODE_PRIVATE);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, finalPath);
  }

  async function exists(relativePath) {
    try {
      await fs.access(target(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async function remove(relativePath) {
    await fs.rm(target(relativePath), { force: true });
  }

  return { readJson, writeJsonAtomic, exists, remove, dataRoot };
}
