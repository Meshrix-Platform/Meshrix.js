import { constants as fsConstants } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createPluginDataSqliteFacade,
  isHostPluginDataResource,
  replacePluginDataSqliteCandidate
} from "./plugin-data-sqlite-capability.mjs";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const CAPABILITY_NAME = "PluginDataCapability";

function sanitizeOperationError(error) {
  const codeByFilesystemCode = new Map([
    ["ENOENT", "PLUGIN_DATA_NOT_FOUND"],
    ["EEXIST", "PLUGIN_DATA_ALREADY_EXISTS"],
    ["ENOTEMPTY", "PLUGIN_DATA_NOT_EMPTY"],
    ["EISDIR", "PLUGIN_DATA_TYPE_MISMATCH"],
    ["ENOTDIR", "PLUGIN_DATA_TYPE_MISMATCH"],
    ["ELOOP", "PLUGIN_DATA_BOUNDARY_REJECTED"],
    ["EACCES", "PLUGIN_DATA_ACCESS_REJECTED"],
    ["EPERM", "PLUGIN_DATA_ACCESS_REJECTED"]
  ]);
  const sanitized = new Error("Plugin data operation did not complete.");
  sanitized.name = "PluginDataOperationError";
  sanitized.code = codeByFilesystemCode.get(error?.code) || "PLUGIN_DATA_OPERATION_FAILED";
  return sanitized;
}

function normalizeRelativePath(value, { allowRoot = false } = {}) {
  if (typeof value !== "string") {
    throw new TypeError("Plugin data resource name must be a string.");
  }
  const input = value.trim();
  if (allowRoot && (input === "" || input === ".")) return [];
  if (!input || path.isAbsolute(input)) {
    throw new Error("Plugin data resource name must be relative.");
  }
  const segments = input.split(/[\\/]+/u);
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || isHostPluginDataResource(segment))) {
    throw new Error("Plugin data resource name contains an invalid segment.");
  }
  return segments;
}

async function secureDirectory(directory, parentRealPath, label) {
  try {
    await fsPromises.mkdir(directory, { recursive: false, mode: DIRECTORY_MODE });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = await fsPromises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
  if (process.platform !== "win32") {
    await fsPromises.chmod(directory, DIRECTORY_MODE);
    const secured = await fsPromises.lstat(directory);
    if ((secured.mode & 0o777) !== DIRECTORY_MODE) {
      throw new Error(`${label} permissions could not be restricted.`);
    }
  }
  const realPath = await fsPromises.realpath(directory);
  const relative = path.relative(parentRealPath, realPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} resolves outside its assigned directory.`);
  }
  return realPath;
}

async function resolveDirectory(root, segments, { create = false } = {}) {
  let current = root;
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    if (create) {
      current = await secureDirectory(candidate, current, "Plugin data directory");
      continue;
    }
    const stat = await fsPromises.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Plugin data resource parent must be a real directory.");
    }
    const resolved = await fsPromises.realpath(candidate);
    const relative = path.relative(current, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Plugin data resource resolves outside its assigned directory.");
    }
    current = resolved;
  }
  return current;
}

async function resolveEntry(root, value, { createParents = false } = {}) {
  const segments = normalizeRelativePath(value);
  const parent = await resolveDirectory(root, segments.slice(0, -1), { create: createParents });
  return { parent, target: path.join(parent, segments.at(-1)) };
}

async function assertRealEntry(target) {
  const stat = await fsPromises.lstat(target);
  if (stat.isSymbolicLink()) throw new Error("Plugin data resources cannot be symbolic links.");
  return stat;
}

async function openFileNoFollow(target, flags, mode = FILE_MODE) {
  return fsPromises.open(target, flags | (fsConstants.O_NOFOLLOW || 0), mode);
}

function defineCapabilityMethods(capability, root) {
  const methods = {
    async readFile(resourceName, options) {
      const { target } = await resolveEntry(root, resourceName);
      const stat = await assertRealEntry(target);
      if (!stat.isFile()) throw new Error("Plugin data resource must be a regular file.");
      const handle = await openFileNoFollow(target, fsConstants.O_RDONLY);
      try {
        return await handle.readFile(options);
      } finally {
        await handle.close();
      }
    },
    async writeFile(resourceName, data, options = {}) {
      const { parent, target } = await resolveEntry(root, resourceName, { createParents: true });
      const temporary = path.join(parent, `.write-${randomUUID()}`);
      let handle;
      try {
        handle = await openFileNoFollow(
          temporary,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
          FILE_MODE
        );
        await handle.writeFile(data, options);
        await handle.sync();
        await handle.close();
        handle = null;
        if (process.platform !== "win32") await fsPromises.chmod(temporary, FILE_MODE);
        try {
          await assertRealEntry(target);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        await fsPromises.rename(temporary, target);
      } finally {
        if (handle) await handle.close().catch(() => {});
        await fsPromises.rm(temporary, { force: true }).catch(() => {});
      }
    },
    async makeDirectory(resourceName) {
      const segments = normalizeRelativePath(resourceName);
      await resolveDirectory(root, segments, { create: true });
    },
    async list(resourceName = ".") {
      const segments = normalizeRelativePath(resourceName, { allowRoot: true });
      const directory = await resolveDirectory(root, segments);
      return (await fsPromises.readdir(directory)).filter((name) => !isHostPluginDataResource(name)).sort();
    },
    async stat(resourceName) {
      const { target } = await resolveEntry(root, resourceName);
      const stat = await assertRealEntry(target);
      return Object.freeze({
        type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
        size: stat.size,
        modifiedAtMs: stat.mtimeMs,
        executable: process.platform !== "win32" && (stat.mode & 0o111) !== 0
      });
    },
    async remove(resourceName, { recursive = false } = {}) {
      const { target } = await resolveEntry(root, resourceName);
      const stat = await assertRealEntry(target);
      if (stat.isDirectory() && !recursive) {
        await fsPromises.rmdir(target);
      } else {
        await fsPromises.rm(target, { recursive: Boolean(recursive), force: false });
      }
    },
    async move(sourceName, targetName) {
      const source = await resolveEntry(root, sourceName);
      const target = await resolveEntry(root, targetName, { createParents: true });
      await assertRealEntry(source.target);
      try {
        await assertRealEntry(target.target);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await fsPromises.rename(source.target, target.target);
    },
    async scope(resourceName) {
      const segments = normalizeRelativePath(resourceName);
      const scopedRoot = await resolveDirectory(root, segments, { create: true });
      return createPluginDataCapabilityFromRoot(scopedRoot);
    }
  };
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(capability, name, {
      async value(...args) {
        try {
          return await method(...args);
        } catch (error) {
          throw sanitizeOperationError(error);
        }
      },
      enumerable: false,
      configurable: false,
      writable: false
    });
  }
}

function createPluginDataCapabilityFromRoot(root) {
  const capability = Object.create(null);
  Object.defineProperty(capability, Symbol.toStringTag, {
    value: CAPABILITY_NAME,
    enumerable: false
  });
  Object.defineProperty(capability, Symbol.toPrimitive, {
    value() {
      throw new TypeError("Plugin data capabilities cannot be converted to primitive values.");
    },
    enumerable: false
  });
  defineCapabilityMethods(capability, root);
  Object.defineProperty(capability, "openSqlite", {
    value() {
      try { return createPluginDataSqliteFacade(root); } catch (error) { throw sanitizeOperationError(error); }
    },
    enumerable: false,
    configurable: false,
    writable: false
  });
  Object.defineProperty(capability, "replaceSqliteCandidate", {
    value(candidateImage, validateCandidate) {
      try {
        return replacePluginDataSqliteCandidate(root, candidateImage, validateCandidate);
      } catch (error) {
        throw sanitizeOperationError(error);
      }
    },
    enumerable: false,
    configurable: false,
    writable: false
  });
  return Object.freeze(capability);
}

export async function createPluginDataCapability(pluginRoot) {
  const candidate = path.resolve(pluginRoot);
  const candidateStat = await fsPromises.lstat(candidate);
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
    throw new Error("Plugin data capability root must be a real directory.");
  }
  const resolved = await fsPromises.realpath(candidate);
  const stat = await fsPromises.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Plugin data capability root must be a real directory.");
  }
  return createPluginDataCapabilityFromRoot(resolved);
}
