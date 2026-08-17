import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { ServerConfig } from "@meshrix/foundation/config/server-config";
import { isJsonValue, type JsonValue } from "./types.ts";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const FILE_EXECUTE_BITS = 0o111;

export function dataRoot(userDataPath = ""): string {
  return userDataPath || ServerConfig.getDataDir();
}

export function storageRoot(userDataPath = ""): string {
  return path.resolve(dataRoot(userDataPath));
}

export function resolveStoragePathWithinRoot(
  userDataPath = "",
  relativePath = "",
): string {
  const rootPath = storageRoot(userDataPath);
  const rawPath = String(relativePath || "").trim();
  if (!rawPath || path.isAbsolute(rawPath) || rawPath.includes("\0")) {
    throw new Error("Storage path must be a non-empty relative path.");
  }
  return assertPathInsideRoot(rootPath, path.resolve(rootPath, rawPath))
    .resolvedTarget;
}

export function assertPathInsideRoot(
  rootPath = "",
  targetPath = "",
): { resolvedRoot: string; resolvedTarget: string; relative: string } {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Storage path is outside the server data directory.");
  }
  return { resolvedRoot, resolvedTarget, relative };
}

export function chmodSyncBestEffort(filePath: string, mode: number): void {
  if (process.platform === "win32") {
    return;
  }
  fsSync.chmodSync(filePath, mode);
}

export function ensurePrivateDirectory(dirPath: string): void {
  if (fsSync.existsSync(dirPath)) {
    const existing = fsSync.lstatSync(dirPath);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("Storage directory must be a real directory.");
    }
  } else {
    fsSync.mkdirSync(dirPath, { mode: PRIVATE_DIRECTORY_MODE });
  }
  chmodSyncBestEffort(dirPath, PRIVATE_DIRECTORY_MODE);
}

export function ensurePrivateDirectoryChain(
  rootPath: string,
  relativeDir = "",
): void {
  const resolvedRoot = path.resolve(rootPath);
  ensurePrivateDirectory(resolvedRoot);
  const normalized = String(relativeDir || "")
    .split(/[\\/]+/u)
    .filter(Boolean);
  let current = resolvedRoot;
  for (const segment of normalized) {
    if (segment === "." || segment === "..") {
      throw new Error("Storage directory segments must not traverse.");
    }
    current = path.join(current, segment);
    ensurePrivateDirectory(current);
  }
}

export function hardenStoredFile(filePath: string): void {
  const stat = fsSync.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Stored asset must be a regular file.");
  }
  chmodSyncBestEffort(filePath, PRIVATE_FILE_MODE);
  const hardened = fsSync.lstatSync(filePath);
  if ((hardened.mode & FILE_EXECUTE_BITS) !== 0) {
    throw new Error("Stored asset file retains executable permissions.");
  }
}

export function readJsonSync(filePath: string, fallback: JsonValue): JsonValue {
  try {
    const parsed: unknown = JSON.parse(fsSync.readFileSync(filePath, "utf8"));
    if (!isJsonValue(parsed))
      throw new TypeError("Stored JSON contains unsupported values.");
    return parsed;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return fallback;
    throw error;
  }
}

export function writeJsonSyncAtomic(
  filePath: string,
  value: JsonValue,
  { rootPath = "" }: { rootPath?: string } = {},
): void {
  if (rootPath) {
    const { relative } = assertPathInsideRoot(rootPath, filePath);
    ensurePrivateDirectoryChain(rootPath, path.dirname(relative));
  } else {
    fsSync.mkdirSync(path.dirname(filePath), {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    chmodSyncBestEffort(path.dirname(filePath), PRIVATE_DIRECTORY_MODE);
  }
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  fsSync.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  hardenStoredFile(tmpPath);
  fsSync.renameSync(tmpPath, filePath);
  hardenStoredFile(filePath);
}
