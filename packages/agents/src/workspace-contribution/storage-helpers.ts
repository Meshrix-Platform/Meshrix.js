import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { ServerConfig } from "@meshrix/foundation/config/server-config";

export const PRIVATE_DIRECTORY_MODE: any = 0o700;
export const PRIVATE_FILE_MODE: any = 0o600;
export const FILE_EXECUTE_BITS: any = 0o111;

export function dataRoot(userDataPath: any = "") : any {
  return userDataPath || ServerConfig.getDataDir();
}

export function storageRoot(userDataPath: any = "") : any {
  return path.resolve(dataRoot(userDataPath));
}

export function resolveStoragePathWithinRoot(userDataPath: any = "", relativePath: any = "") : any {
  const rootPath: any = storageRoot(userDataPath);
  const rawPath: any = String(relativePath || "").trim();
  if (!rawPath || path.isAbsolute(rawPath) || rawPath.includes("\0")) {
    throw new Error("Storage path must be a non-empty relative path.");
  }
  return assertPathInsideRoot(rootPath, path.resolve(rootPath, rawPath)).resolvedTarget;
}

export function assertPathInsideRoot(rootPath?: any, targetPath?: any) : any {
  const resolvedRoot: any = path.resolve(rootPath);
  const resolvedTarget: any = path.resolve(targetPath);
  const relative: any = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Storage path is outside the server data directory.");
  }
  return { resolvedRoot, resolvedTarget, relative };
}

export function chmodSyncBestEffort(filePath?: any, mode?: any) : any {
  if (process.platform === "win32") {
    return;
  }
  fsSync.chmodSync(filePath, mode);
}

export function ensurePrivateDirectory(dirPath?: any) : any {
  if (fsSync.existsSync(dirPath)) {
    const existing: any = fsSync.lstatSync(dirPath);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("Storage directory must be a real directory.");
    }
  } else {
    fsSync.mkdirSync(dirPath, { mode: PRIVATE_DIRECTORY_MODE });
  }
  chmodSyncBestEffort(dirPath, PRIVATE_DIRECTORY_MODE);
}

export function ensurePrivateDirectoryChain(rootPath?: any, relativeDir: any = "") : any {
  const resolvedRoot: any = path.resolve(rootPath);
  ensurePrivateDirectory(resolvedRoot);
  const normalized: any = String(relativeDir || "").split(/[\\/]+/u).filter(Boolean);
  let current: any = resolvedRoot;
  for (const segment of normalized) {
    if (segment === "." || segment === "..") {
      throw new Error("Storage directory segments must not traverse.");
    }
    current = path.join(current, segment);
    ensurePrivateDirectory(current);
  }
}

export function hardenStoredFile(filePath?: any) : any {
  const stat: any = fsSync.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Stored asset must be a regular file.");
  }
  chmodSyncBestEffort(filePath, PRIVATE_FILE_MODE);
  const hardened: any = fsSync.lstatSync(filePath);
  if ((hardened.mode & FILE_EXECUTE_BITS) !== 0) {
    throw new Error("Stored asset file retains executable permissions.");
  }
}

export function readJsonSync(filePath?: any, fallback?: any) : any {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export function writeJsonSyncAtomic(filePath?: any, value?: any, { rootPath = "" }: Record<string, any> = {}) : any {
  if (rootPath) {
    const { relative } = assertPathInsideRoot(rootPath, filePath);
    ensurePrivateDirectoryChain(rootPath, path.dirname(relative));
  } else {
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSyncBestEffort(path.dirname(filePath), PRIVATE_DIRECTORY_MODE);
  }
  const tmpPath: any = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  fsSync.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  hardenStoredFile(tmpPath);
  fsSync.renameSync(tmpPath, filePath);
  hardenStoredFile(filePath);
}
