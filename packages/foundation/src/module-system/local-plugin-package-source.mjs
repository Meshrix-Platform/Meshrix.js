import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { createLocalPluginPackageSource } from "@lico/contracts/plugins/plugin-package-source";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function sanitize(message) {
  return String(message || "PLUGIN_PACKAGE_SOURCE_DENIED")
    .replace(/(?:\/Users\/|\/home\/|\/opt\/|\/var\/|\/private\/|\/tmp\/|\/var\/folders\/)[^\s"']+/gu, "<redacted-path>")
    .slice(0, 240);
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sourceKey(source) {
  return ["local_package", source.importRootId, source.relativePath, source.expectedDigest || ""].join("\0");
}

function assertRelativePath(relativePath) {
  const value = String(relativePath || "");
  if (!value || path.isAbsolute(value) || value.includes("\0")) {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: relative path is invalid");
  }
  const normalized = path.posix.normalize(value.split(path.sep).join("/"));
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: relative path escapes import root");
  }
  return normalized;
}

function isInsideRoot(rootReal, candidateReal) {
  const root = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  return candidateReal === rootReal || candidateReal.startsWith(root);
}

/**
 * Offline local-package acquisition for one prebuilt single-plugin archive.
 * Stops at the shared acquired-byte boundary; never stages or enables plugins.
 */
export function createLocalPluginPackageAcquisition({
  resolveImportRoot,
  maxBytes = DEFAULT_MAX_BYTES,
  openFile = defaultOpenFile,
  readFile = defaultReadFile,
  lstat = fs.lstat,
  realpath = fs.realpath
} = {}) {
  if (typeof resolveImportRoot !== "function") {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: import root resolver is required");
  }
  const inflight = new Map();

  async function acquireOnce(sourceInput, policy = {}, signal) {
    if (signal?.aborted) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: acquisition cancelled");
    }
    const source = createLocalPluginPackageSource(sourceInput);
    const relativePath = assertRelativePath(source.relativePath);
    const rootConfigured = await resolveImportRoot(source.importRootId);
    if (typeof rootConfigured !== "string" || rootConfigured.trim().length === 0) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: import root is not configured");
    }
    const rootReal = await realpath(path.resolve(rootConfigured));
    const candidate = path.resolve(rootReal, relativePath);
    if (!isInsideRoot(rootReal, candidate)) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: path escapes authorized import root");
    }

    const preStat = await lstat(candidate);
    if (preStat.isSymbolicLink()) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: symbolic links are not allowed");
    }
    if (!preStat.isFile()) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: target is not a regular file");
    }
    const budget = Number.isSafeInteger(policy.maxBytes) ? policy.maxBytes : maxBytes;
    if (preStat.size > budget) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: file exceeds byte budget");
    }
    // Reject world-writable or setuid/setgid modes as unsafe deployment modes.
    const mode = preStat.mode & 0o7777;
    if ((mode & 0o002) !== 0 || (mode & fsConstants.S_ISUID) !== 0 || (mode & fsConstants.S_ISGID) !== 0) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: file mode is unsafe");
    }

    const handle = await openFile(candidate);
    try {
      if (signal?.aborted) {
        throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: acquisition cancelled");
      }
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) {
        throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: opened target is not a regular file");
      }
      if (openedStat.ino !== preStat.ino || openedStat.dev !== preStat.dev) {
        throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: file was replaced during acquisition");
      }
      if (openedStat.size !== preStat.size) {
        throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: file size drifted during acquisition");
      }
      if (openedStat.size > budget) {
        throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: file exceeds byte budget");
      }
      const bytes = await readFile(handle, openedStat.size, signal);
      if (bytes.length !== openedStat.size) {
        throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: file read was truncated");
      }
      const archiveDigest = digest(bytes);
      if (source.expectedDigest && source.expectedDigest !== archiveDigest) {
        throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: acquired digest mismatch");
      }
      return Object.freeze({
        sourceKind: "local_package",
        archiveDigest,
        bytes,
        byteLength: bytes.length,
        metadata: Object.freeze({
          importRootId: source.importRootId,
          relativePath
        })
      });
    } finally {
      await handle.close().catch(() => {});
    }
  }

  return Object.freeze({
    id: "LocalPluginPackageAcquisition",

    async acquire(sourceInput, policy = {}, signal) {
      const source = createLocalPluginPackageSource(sourceInput);
      const key = sourceKey(source);
      if (inflight.has(key)) return inflight.get(key);
      const work = acquireOnce(source, policy, signal).finally(() => {
        if (inflight.get(key) === work) inflight.delete(key);
      });
      inflight.set(key, work);
      try {
        return await work;
      } catch (error) {
        const sanitized = sanitize(error?.message || error);
        const message = sanitized.startsWith("PLUGIN_PACKAGE_")
          ? sanitized
          : `PLUGIN_PACKAGE_SOURCE_DENIED: ${sanitized}`;
        const wrapped = new Error(message);
        wrapped.code = message.split(":")[0];
        throw wrapped;
      }
    }
  });
}

async function defaultOpenFile(candidate) {
  try {
    return await fs.open(candidate, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: symbolic links are not allowed");
    }
    throw error;
  }
}

async function defaultReadFile(handle, size, signal) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    if (signal?.aborted) {
      throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: acquisition cancelled");
    }
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return bytes.subarray(0, offset);
}

export async function acquireLocalPluginPackage(source, pathPolicy = {}, signal) {
  const acquisition = createLocalPluginPackageAcquisition(pathPolicy);
  return acquisition.acquire(source, pathPolicy, signal);
}
