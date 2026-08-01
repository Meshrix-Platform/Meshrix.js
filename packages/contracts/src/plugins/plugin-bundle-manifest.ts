import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { createHash } from "node:crypto";

export const PLUGIN_BUNDLE_MANIFEST_SCHEMA: any = "v0.0.1:meshrix:plugin-bundle-manifest-1";
export const PLUGIN_BUNDLE_MANIFEST_FILENAME: any = "plugin.bundle.json";

const PLUGIN_ID_PATTERN: any = /^[a-z][a-z0-9-]*$/u;
const RELATIVE_FILE_PATTERN: any = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u;
const DIGEST_PATTERN: any = /^sha256:[a-f0-9]{64}$/u;
const ALLOWED_FIELDS: any = new Set<any>([
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

function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireString(value?: any, label?: any) : any {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`PLUGIN_PACKAGE_FORMAT_REJECTED: ${label} must be a non-empty string`);
  }
  return value.trim();
}


export function digestPluginBundleManifest(manifest?: any) : any {
  return `sha256:${createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`;
}

export function normalizePluginBundleManifest(input?: any) : any {
  if (!isPlainObject(input)) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: bundle manifest must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new Error(`PLUGIN_PACKAGE_FORMAT_REJECTED: unsupported field ${key}`);
    }
  }
  const schemaVersion: any = requireString(input.schemaVersion, "schemaVersion");
  if (schemaVersion !== PLUGIN_BUNDLE_MANIFEST_SCHEMA) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: unsupported schemaVersion");
  }
  const pluginId: any = requireString(input.pluginId, "pluginId");
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: pluginId is invalid");
  }
  const version: any = requireString(input.version, "version");
  const label: any = input.label === undefined ? pluginId : requireString(input.label, "label");
  const entrypoint: any = requireString(input.entrypoint, "entrypoint");
  if (!RELATIVE_FILE_PATTERN.test(entrypoint) || entrypoint.includes("..") || !entrypoint.endsWith(".ts")) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: entrypoint must be a contained .ts path");
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: files inventory is required");
  }
  const files: any[] = [];
  const seen: any = new Set<any>();
  for (const entry of input.files) {
    if (!isPlainObject(entry)) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: file inventory entries must be objects");
    }
    const pathValue: any = requireString(entry.path, "files.path");
    if (!RELATIVE_FILE_PATTERN.test(pathValue) || pathValue.includes("..") || pathValue.startsWith("/")) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: file path escapes the bundle root");
    }
    if (seen.has(pathValue)) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: duplicate file inventory path");
    }
    seen.add(pathValue);
    const sha256: any = requireString(entry.sha256, "files.sha256");
    if (!DIGEST_PATTERN.test(sha256)) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: file digest is invalid");
    }
    const size: any = entry.size;
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
  const dependencies: any = Array.isArray(input.dependencies) ? input.dependencies.map((dep?: any) : any => {
    const id: any = requireString(dep, "dependencies[]");
    if (!PLUGIN_ID_PATTERN.test(id)) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: dependency id is invalid");
    }
    return id;
  }) : [];
  if (new Set<any>(dependencies).size !== dependencies.length) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: duplicate dependency ids");
  }
  const coreCompatibility: any = input.coreCompatibility === undefined
    ? Object.freeze({})
    : (() : any => {
      if (!isPlainObject(input.coreCompatibility)) {
        throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: coreCompatibility must be an object");
      }
      const out: Record<string, any> = {};
      if (input.coreCompatibility.contractDigest !== undefined) {
        const digest: any = requireString(input.coreCompatibility.contractDigest, "coreCompatibility.contractDigest");
        if (!DIGEST_PATTERN.test(digest)) {
          throw new Error("PLUGIN_PACKAGE_COMPAT_REJECTED: coreCompatibility.contractDigest is invalid");
        }
        out.contractDigest = digest;
      }
      return Object.freeze(out);
    })();
  const configurationSchema: any = input.configurationSchema === undefined
    ? Object.freeze({})
    : (() : any => {
      if (!isPlainObject(input.configurationSchema)) {
        throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: configurationSchema must be an object");
      }
      return Object.freeze({ ...input.configurationSchema });
    })();
  const permissions: any = Array.isArray(input.permissions)
    ? Object.freeze(input.permissions.map((value?: any) : any => requireString(value, "permissions[]")))
    : Object.freeze([]);
  const lifecycleHooks: any = Array.isArray(input.lifecycleHooks)
    ? Object.freeze(input.lifecycleHooks.map((value?: any) : any => requireString(value, "lifecycleHooks[]")))
    : Object.freeze([]);
  const payloadDigest: any = requireString(input.payloadDigest, "payloadDigest");
  if (!DIGEST_PATTERN.test(payloadDigest)) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: payloadDigest is invalid");
  }
  const trust: any = (() : any => {
    if (!isPlainObject(input.trust)) {
      throw new Error("PLUGIN_PACKAGE_TRUST_REJECTED: trust evidence is required");
    }
    const algorithm: any = requireString(input.trust.algorithm, "trust.algorithm");
    if (algorithm !== "ed25519" && algorithm !== "configured-digest") {
      throw new Error("PLUGIN_PACKAGE_TRUST_REJECTED: unsupported trust algorithm");
    }
    const out: Record<string, any> = { algorithm };
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
