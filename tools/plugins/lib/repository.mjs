import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const buildRoot = path.join(repoRoot, "build");
export const stagedRoot = path.join(buildRoot, "staged");
export const packagesRoot = path.join(buildRoot, "packages");
export const registryPath = path.join(repoRoot, "plugins", "registry", "plugins.json");
export const coreHostContractPath = path.join(repoRoot, "plugins", "core-host-contract.json");

export const RUNTIME_PLUGIN_SCHEMA = "v0.0.1:plugin:manifest-1";
export const CATALOG_PLUGIN_SCHEMA = "v0.0.1:schema:meshrix-plugin-manifest-1";
export const PLUGIN_REGISTRY_SCHEMA = "v0.0.1:schema:meshrix-plugins-registry-2";
export const CATALOG_PLUGIN_KIND = "meshrix.plugin.manifest";

export function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function sanitizeError(error) {
  return String(error?.message || error || "repository operation failed")
    .replace(/(?:\/Users\/|\/home\/|\/private\/|\/var\/)[^\s"']+/gu, "<redacted-path>")
    .replace(/[A-Za-z]:\\[^\s"']+/gu, "<redacted-path>")
    .slice(0, 320);
}

export async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON at ${path.relative(repoRoot, filePath)}: ${sanitizeError(error)}`);
  }
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function walkFiles(root, {
  include = () => true,
  excludeDirectory = () => false
} = {}) {
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${relative}`);
      if (entry.isDirectory()) {
        if (excludeDirectory(relative)) continue;
        await visit(absolute);
      } else if (entry.isFile() && include(relative)) {
        files.push({ absolute, relative });
      } else if (!entry.isFile()) {
        throw new Error(`Unsupported filesystem entry: ${relative}`);
      }
    }
  }
  await visit(root);
  return files;
}

export function runtimePluginEntries(registry) {
  return Object.freeze((registry?.plugins || [])
    .filter((entry) => entry.release === true && entry.runtime === true)
    .sort((left, right) => left.id.localeCompare(right.id)));
}

export async function loadRuntimePluginEntries() {
  return runtimePluginEntries(await readJson(registryPath));
}

export function releaseSourceIncluded(relative) {
  const normalized = String(relative || "").replace(/\\/gu, "/");
  if (!normalized || normalized === "plugin.bundle.json") return false;
  if (normalized.startsWith("tests/") || normalized.startsWith("test/") || normalized.startsWith("fixtures/")) return false;
  if (normalized.startsWith("console-source/") || normalized.includes("/__snapshots__/")) return false;
  if (/\.(?:vue|ts|tsx|map)$/u.test(normalized)) return false;
  return true;
}
