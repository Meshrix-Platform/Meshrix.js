import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { createHash } from "node:crypto";

export const PLUGIN_BUNDLE_MANIFEST_SCHEMA = "v0.0.1:meshrix:plugin-bundle-manifest-1";
export const PLUGIN_BUNDLE_MANIFEST_FILENAME = "plugin.bundle.json";

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;
const RELATIVE_FILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ALLOWED_FIELDS = new Set([
  "schemaVersion",
  "pluginId",
  "version",
  "label",
  "entrypoint",
  "files",
  "coreCompatibility",
  "dependencies",
  "configurationSchema",
  "permissions",
  "lifecycleHooks",
  "payloadDigest",
  "trust"
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`PLUGIN_PACKAGE_FORMAT_REJECTED: ${label} must be a non-empty string`);
  }
  return value.trim();
}


export function digestPluginBundleManifest(manifest) {
  return `sha256:${createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`;
}

export function normalizePluginBundleManifest(input) {
  if (!isPlainObject(input)) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: bundle manifest must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new Error(`PLUGIN_PACKAGE_FORMAT_REJECTED: unsupported field ${key}`);
    }
  }
  const schemaVersion = requireString(input.schemaVersion, "schemaVersion");
  if (schemaVersion !== PLUGIN_BUNDLE_MANIFEST_SCHEMA) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: unsupported schemaVersion");
  }
  const pluginId = requireString(input.pluginId, "pluginId");
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: pluginId is invalid");
  }
  const version = requireString(input.version, "version");
  const label = input.label === undefined ? pluginId : requireString(input.label, "label");
  const entrypoint = requireString(input.entrypoint, "entrypoint");
  if (!RELATIVE_FILE_PATTERN.test(entrypoint) || entrypoint.includes("..") || !entrypoint.endsWith(".mjs")) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: entrypoint must be a contained .mjs path");
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: files inventory is required");
  }
  const files = [];
  const seen = new Set();
  for (const entry of input.files) {
    if (!isPlainObject(entry)) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: file inventory entries must be objects");
    }
    const pathValue = requireString(entry.path, "files.path");
    if (!RELATIVE_FILE_PATTERN.test(pathValue) || pathValue.includes("..") || pathValue.startsWith("/")) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: file path escapes the bundle root");
    }
    if (seen.has(pathValue)) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: duplicate file inventory path");
    }
    seen.add(pathValue);
    const sha256 = requireString(entry.sha256, "files.sha256");
    if (!DIGEST_PATTERN.test(sha256)) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: file digest is invalid");
    }
    const size = entry.size;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: file size is invalid");
    }
    files.push(Object.freeze({ path: pathValue, sha256, size }));
  }
  if (!seen.has(entrypoint)) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: entrypoint missing from file inventory");
  }
  // The closed manifest is archive metadata, not a payload inventory member.
  if (seen.has(PLUGIN_BUNDLE_MANIFEST_FILENAME)) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: bundle manifest must not appear in payload inventory");
  }
  const dependencies = Array.isArray(input.dependencies) ? input.dependencies.map((dep) => {
    const id = requireString(dep, "dependencies[]");
    if (!PLUGIN_ID_PATTERN.test(id)) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: dependency id is invalid");
    }
    return id;
  }) : [];
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: duplicate dependency ids");
  }
  const coreCompatibility = input.coreCompatibility === undefined
    ? Object.freeze({})
    : (() => {
      if (!isPlainObject(input.coreCompatibility)) {
        throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: coreCompatibility must be an object");
      }
      const out = {};
      if (input.coreCompatibility.contractDigest !== undefined) {
        const digest = requireString(input.coreCompatibility.contractDigest, "coreCompatibility.contractDigest");
        if (!DIGEST_PATTERN.test(digest)) {
          throw new Error("PLUGIN_PACKAGE_COMPAT_REJECTED: coreCompatibility.contractDigest is invalid");
        }
        out.contractDigest = digest;
      }
      return Object.freeze(out);
    })();
  const configurationSchema = input.configurationSchema === undefined
    ? Object.freeze({})
    : (() => {
      if (!isPlainObject(input.configurationSchema)) {
        throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: configurationSchema must be an object");
      }
      return Object.freeze({ ...input.configurationSchema });
    })();
  const permissions = Array.isArray(input.permissions)
    ? Object.freeze(input.permissions.map((value) => requireString(value, "permissions[]")))
    : Object.freeze([]);
  const lifecycleHooks = Array.isArray(input.lifecycleHooks)
    ? Object.freeze(input.lifecycleHooks.map((value) => requireString(value, "lifecycleHooks[]")))
    : Object.freeze([]);
  const payloadDigest = requireString(input.payloadDigest, "payloadDigest");
  if (!DIGEST_PATTERN.test(payloadDigest)) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: payloadDigest is invalid");
  }
  const trust = (() => {
    if (!isPlainObject(input.trust)) {
      throw new Error("PLUGIN_PACKAGE_TRUST_REJECTED: trust evidence is required");
    }
    const algorithm = requireString(input.trust.algorithm, "trust.algorithm");
    if (algorithm !== "ed25519" && algorithm !== "configured-digest") {
      throw new Error("PLUGIN_PACKAGE_TRUST_REJECTED: unsupported trust algorithm");
    }
    const out = { algorithm };
    if (input.trust.publicKeyId !== undefined) {
      out.publicKeyId = requireString(input.trust.publicKeyId, "trust.publicKeyId");
    }
    if (input.trust.signature !== undefined) {
      out.signature = requireString(input.trust.signature, "trust.signature");
    }
    return Object.freeze(out);
  })();

  return Object.freeze({
    schemaVersion,
    pluginId,
    version,
    label,
    entrypoint,
    files: Object.freeze(files),
    coreCompatibility,
    dependencies: Object.freeze(dependencies),
    configurationSchema,
    permissions,
    lifecycleHooks,
    payloadDigest,
    trust
  });
}
