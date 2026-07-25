import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ENVELOPE_SCHEMA = "meshrix.plugin-artifact-envelope/1";
const INSTALL_JOURNAL_SCHEMA = "meshrix.plugin-artifact-install-journal/1";
const REMOVAL_JOURNAL_SCHEMA = "meshrix.plugin-artifact-removal-journal/1";
const CURRENT_SCHEMA = "meshrix.plugin-artifact-current/1";
const TOMBSTONE_SCHEMA = "meshrix.plugin-artifact-tombstone/1";
const METADATA_FILE = "plugin-artifact.json";
const MAX_FILE_COUNT = 4096;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_DIRECTORY_DEPTH = 32;
const MAX_PATH_BYTES = 1024;
const MAX_PLUGIN_COUNT = 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;

function controlledError(code, message) {
  return Object.assign(new Error(message), { code });
}


function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function pluginId(value) {
  const normalized = String(value || "").trim();
  if (!PLUGIN_ID_PATTERN.test(normalized)) throw new TypeError("Plugin artifact scope requires a valid plugin id.");
  return normalized;
}

function generation(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError("Plugin artifact generation must be a positive safe integer.");
  }
  return normalized;
}

function requiredDigest(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!DIGEST_PATTERN.test(normalized)) throw new TypeError(`${label} must be a sha256 digest.`);
  return normalized;
}

export function pluginOwnerGenerationDigest({
  pluginId: rawPluginId,
  artifactDigest: rawArtifactDigest,
  generation: rawGeneration
} = {}) {
  const id = pluginId(rawPluginId);
  const artifactDigest = requiredDigest(rawArtifactDigest, "Plugin artifact owner digest");
  const artifactGeneration = generation(rawGeneration);
  return crypto.createHash("sha256").update(canonicalJson({
    schemaVersion: "meshrix.plugin-owner-generation/1",
    pluginId: id,
    artifactDigest,
    artifactGeneration
  })).digest("hex");
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().some((field, index) => field !== [...fields].sort()[index]) ||
      Object.keys(value).length !== fields.length) {
    throw controlledError("PLUGIN_ARTIFACT_RECORD_INVALID", `${label} is invalid.`);
  }
  return value;
}

function safeName(value) {
  const normalized = String(value || "").split(path.sep).join("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") ||
      Buffer.byteLength(normalized, "utf8") > MAX_PATH_BYTES ||
      normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw controlledError("PLUGIN_ARTIFACT_PATH_INVALID", "Plugin artifact contains an unsafe path.");
  }
  return normalized;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function ensureRealDirectory(directory, parent = null) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw controlledError("PLUGIN_ARTIFACT_ROOT_INVALID", "Plugin artifact root must be a real directory.");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw controlledError("PLUGIN_ARTIFACT_ROOT_PERMISSIONS", "Plugin artifact directories require owner-only permissions.");
  }
  const resolved = await fs.realpath(directory);
  if (parent) {
    const relative = path.relative(parent, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw controlledError("PLUGIN_ARTIFACT_ROOT_INVALID", "Plugin artifact directory escaped its root.");
    }
  }
  return resolved;
}

async function existingRealDirectory(directory) {
  const resolved = await fs.realpath(directory);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw controlledError("PLUGIN_ARTIFACT_CONTENT_INVALID", "Plugin artifact source must be a real directory.");
  }
  return resolved;
}

async function readBoundedJson(filePath, { missing = null } = {}) {
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_RECORD_BYTES) throw new Error("invalid_record");
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_RECORD_BYTES) throw new Error("invalid_record");
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return missing;
    throw controlledError("PLUGIN_ARTIFACT_RECORD_INVALID", "Plugin artifact record could not be read.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function durableJson(filePath, value, lifecycleStatePort) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.byteLength > MAX_RECORD_BYTES) throw new TypeError("Plugin artifact record exceeds its bounded size.");
  const temporary = `${filePath}.tmp-${crypto.randomUUID()}`;
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await lifecycleStatePort.assertExclusive();
    await fs.rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function regularFileBytes(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw controlledError("PLUGIN_ARTIFACT_CONTENT_INVALID", "Plugin artifact contains an invalid or oversized file.");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size || bytes.byteLength > MAX_FILE_BYTES) {
      throw controlledError("PLUGIN_ARTIFACT_CONTENT_CHANGED", "Plugin artifact content changed while it was inspected.");
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function inventory(root, relative = "", accumulator = { files: [], total: 0, directories: 0 }, depth = 0) {
  if (depth > MAX_DIRECTORY_DEPTH) throw controlledError("PLUGIN_ARTIFACT_CONTENT_OVERSIZED", "Plugin artifact directory depth exceeds its bound.");
  accumulator.directories += 1;
  if (accumulator.directories > MAX_FILE_COUNT) {
    throw controlledError("PLUGIN_ARTIFACT_CONTENT_OVERSIZED", "Plugin artifact directory count exceeds its bound.");
  }
  const directory = relative ? path.join(root, relative) : root;
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw controlledError("PLUGIN_ARTIFACT_CONTENT_INVALID", "Plugin artifact contains a non-directory content node.");
  }
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = safeName(relative ? `${relative}/${entry.name}` : entry.name);
    if (entry.isSymbolicLink()) {
      throw controlledError("PLUGIN_ARTIFACT_SYMLINK_DENIED", "Plugin artifacts cannot contain symbolic links.");
    }
    if (entry.isDirectory()) {
      await inventory(root, child, accumulator, depth + 1);
      continue;
    }
    if (!entry.isFile()) throw controlledError("PLUGIN_ARTIFACT_CONTENT_INVALID", "Plugin artifacts contain regular files only.");
    const bytes = await regularFileBytes(path.join(root, child));
    accumulator.total += bytes.byteLength;
    if (accumulator.files.length >= MAX_FILE_COUNT || accumulator.total > MAX_TOTAL_BYTES) {
      throw controlledError("PLUGIN_ARTIFACT_CONTENT_OVERSIZED", "Plugin artifact exceeds bounded inventory limits.");
    }
    accumulator.files.push(Object.freeze({ path: child, byteSize: bytes.byteLength, digest: digest(bytes) }));
  }
  return depth === 0 ? Object.freeze(accumulator.files) : accumulator.files;
}

async function copyTree(source, target) {
  await ensureRealDirectory(target, path.dirname(target));
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const name = safeName(entry.name);
    const from = path.join(source, name);
    const to = path.join(target, name);
    if (entry.isSymbolicLink()) throw controlledError("PLUGIN_ARTIFACT_SYMLINK_DENIED", "Plugin artifacts cannot contain symbolic links.");
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) {
      const bytes = await regularFileBytes(from);
      let handle;
      try {
        handle = await fs.open(to, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle?.close().catch(() => {});
      }
    } else throw controlledError("PLUGIN_ARTIFACT_CONTENT_INVALID", "Plugin artifacts contain regular files only.");
  }
  await syncDirectory(target);
}

async function durableFile(filePath, bytes) {
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  await syncDirectory(path.dirname(filePath));
}

async function sealTree(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await sealTree(target);
    else if (entry.isFile() && process.platform !== "win32") await fs.chmod(target, 0o400);
  }
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
}

async function makeWritableTree(directory) {
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeWritableTree(target);
    else if (entry.isFile() && process.platform !== "win32") await fs.chmod(target, 0o600);
  }
}

function normalizeDependencyClosure(value) {
  if (!Array.isArray(value)) throw new TypeError("Plugin artifact dependency closure must be an array.");
  const seen = new Set();
  return Object.freeze(value.map((entry) => {
    exactObject(entry, ["pluginId", "version", "artifactDigest", "generation"], "Plugin artifact dependency");
    const id = pluginId(entry.pluginId);
    if (seen.has(id)) throw new TypeError("Plugin artifact dependency closure contains duplicates.");
    seen.add(id);
    const version = String(entry.version || "").trim();
    if (!version) throw new TypeError("Plugin artifact dependency version is required.");
    return Object.freeze({
      pluginId: id,
      version,
      artifactDigest: requiredDigest(entry.artifactDigest, "Plugin artifact dependency digest"),
      generation: generation(entry.generation)
    });
  }).sort((left, right) => left.pluginId.localeCompare(right.pluginId)));
}

function unsignedEnvelope(envelope) {
  return Object.freeze({
    schemaVersion: envelope.schemaVersion,
    pluginId: envelope.pluginId,
    version: envelope.version,
    generation: envelope.generation,
    coreContractDigest: envelope.coreContractDigest,
    dependencyClosure: envelope.dependencyClosure,
    files: envelope.files
  });
}

function validateEnvelopeShape(value, expectedPluginId = "") {
  exactObject(value, [
    "schemaVersion", "pluginId", "version", "generation", "coreContractDigest",
    "dependencyClosure", "files", "artifactDigest", "signature"
  ], "Plugin artifact envelope");
  if (value.schemaVersion !== ENVELOPE_SCHEMA || pluginId(value.pluginId) !== (expectedPluginId || value.pluginId) ||
      !String(value.version || "").trim()) {
    throw controlledError("PLUGIN_ARTIFACT_IDENTITY_INVALID", "Plugin artifact identity is invalid.");
  }
  generation(value.generation);
  requiredDigest(value.coreContractDigest, "Plugin artifact Core contract digest");
  requiredDigest(value.artifactDigest, "Plugin artifact digest");
  normalizeDependencyClosure(value.dependencyClosure);
  if (!Array.isArray(value.files) || value.files.length > MAX_FILE_COUNT) {
    throw controlledError("PLUGIN_ARTIFACT_RECORD_INVALID", "Plugin artifact inventory is invalid.");
  }
  return value;
}

function trustedKey(trustedPublicKeys, keyId) {
  if (!trustedPublicKeys || typeof trustedPublicKeys !== "object" || Array.isArray(trustedPublicKeys)) return null;
  const key = trustedPublicKeys[keyId];
  if (!key) return null;
  try {
    return key.type === "public" ? key : crypto.createPublicKey({ key, format: "jwk" });
  } catch {
    return null;
  }
}

async function verifyEnvelope({ contentRoot, envelopePath, trustedPublicKeys, expectedPluginId = "" }) {
  if (!trustedPublicKeys || typeof trustedPublicKeys !== "object" || Object.keys(trustedPublicKeys).length === 0) {
    throw controlledError("PLUGIN_ARTIFACT_TRUST_EMPTY", "Plugin artifact trust is not configured.");
  }
  const envelope = validateEnvelopeShape(await readBoundedJson(envelopePath), expectedPluginId);
  const actualFiles = await inventory(contentRoot);
  if (canonicalJson(actualFiles) !== canonicalJson(envelope.files)) {
    throw controlledError("PLUGIN_ARTIFACT_TAMPERED", "Plugin artifact content does not match its signed inventory.");
  }
  const expectedDigest = digest(canonicalJson(unsignedEnvelope(envelope)));
  if (expectedDigest !== envelope.artifactDigest) {
    throw controlledError("PLUGIN_ARTIFACT_BINDING_INVALID", "Plugin artifact digest binding is invalid.");
  }
  const signature = exactObject(envelope.signature, [
    "algorithm", "payloadEncoding", "keyId", "payloadDigest", "contextDigest", "signedEnvelope", "value"
  ], "Plugin artifact signature");
  const key = trustedKey(trustedPublicKeys, signature.keyId);
  if (!key || signature.algorithm !== "ed25519" || signature.payloadEncoding !== "sha256-digest-utf8" ||
      signature.payloadDigest !== expectedDigest) {
    throw controlledError("PLUGIN_ARTIFACT_TRUST_DENIED", "Plugin artifact signer is not trusted.");
  }
  const context = Object.freeze({
    pluginId: envelope.pluginId,
    version: envelope.version,
    artifactDigest: expectedDigest,
    generation: envelope.generation,
    coreContractDigest: envelope.coreContractDigest,
    dependencyClosure: envelope.dependencyClosure
  });
  const expectedSignedEnvelope = Object.freeze({
    purpose: `plugin-artifact.${envelope.pluginId}.bundle`,
    payloadDigest: expectedDigest,
    contextDigest: digest(canonicalJson(context))
  });
  if (canonicalJson(signature.signedEnvelope) !== canonicalJson(expectedSignedEnvelope) ||
      !crypto.verify(null, Buffer.from(canonicalJson(expectedSignedEnvelope)), key, Buffer.from(String(signature.value || ""), "base64url"))) {
    throw controlledError("PLUGIN_ARTIFACT_SIGNATURE_INVALID", "Plugin artifact signature is invalid.");
  }
  return Object.freeze({ envelope: Object.freeze(envelope), contentRoot });
}

function validateLifecyclePort(port, expectedPluginId) {
  if (port?.id !== "PluginLifecycleStatePort" || port.pluginId !== expectedPluginId ||
      typeof port.runExclusive !== "function" || typeof port.assertExclusive !== "function") {
    throw new TypeError("Plugin artifact mutation requires the matching Host lifecycle state authority.");
  }
  return port;
}

function currentRecord(value, expectedPluginId) {
  exactObject(value, ["schemaVersion", "pluginId", "version", "generation", "artifactDigest", "keyId"], "Plugin artifact current record");
  if (value.schemaVersion !== CURRENT_SCHEMA || value.pluginId !== expectedPluginId) {
    throw controlledError("PLUGIN_ARTIFACT_CURRENT_INVALID", "Plugin artifact current record is invalid.");
  }
  generation(value.generation);
  requiredDigest(value.artifactDigest, "Plugin artifact current digest");
  return Object.freeze(value);
}

export async function createPluginArtifactAuthority({
  artifactRoot,
  trustedPublicKeys,
  artifactSigner,
  secretRef,
  coreContractDigest,
  faultInjector = null
} = {}) {
  if (typeof artifactRoot !== "string" || !artifactRoot.trim()) {
    throw new TypeError("Plugin artifact authority requires an explicit canonical artifact root.");
  }
  if (!trustedPublicKeys || typeof trustedPublicKeys !== "object" || Array.isArray(trustedPublicKeys)) {
    throw new TypeError("Plugin artifact trust configuration must be an object.");
  }
  const boundCoreContractDigest = requiredDigest(coreContractDigest, "Plugin artifact Core contract digest");
  const root = await ensureRealDirectory(path.resolve(artifactRoot));
  const bundlesRoot = await ensureRealDirectory(path.join(root, "bundles"), root);
  const installedRoot = await ensureRealDirectory(path.join(root, "installed"), root);
  const currentRoot = await ensureRealDirectory(path.join(root, "current"), root);
  const tombstoneRoot = await ensureRealDirectory(path.join(root, "tombstones"), root);
  const fault = async (phase) => { if (typeof faultInjector === "function") await faultInjector(phase); };

  async function verifyInstalledContent(record) {
    const id = pluginId(record.pluginId);
    const contentRoot = path.join(installedRoot, id, String(record.generation), "content");
    const envelopePath = path.join(installedRoot, id, String(record.generation), METADATA_FILE);
    const verified = await verifyEnvelope({ contentRoot, envelopePath, trustedPublicKeys, expectedPluginId: id });
    if (verified.envelope.artifactDigest !== record.artifactDigest ||
        verified.envelope.generation !== record.generation || verified.envelope.version !== record.version ||
        verified.envelope.signature.keyId !== record.keyId ||
        verified.envelope.coreContractDigest !== boundCoreContractDigest) {
      throw controlledError("PLUGIN_ARTIFACT_CURRENT_MISMATCH", "Plugin artifact current record does not match immutable content.");
    }
    return Object.freeze({
      pluginId: id,
      version: record.version,
      generation: record.generation,
      artifactDigest: record.artifactDigest,
      keyId: record.keyId,
      coreContractDigest: verified.envelope.coreContractDigest,
      dependencyClosure: verified.envelope.dependencyClosure,
      contentRoot
    });
  }

  function installedSnapshot(record, verified) {
    const facts = Object.freeze({
      pluginId: record.pluginId,
      version: record.version,
      generation: record.generation,
      artifactDigest: record.artifactDigest,
      keyId: record.keyId
    });
    return Object.freeze({
      ...facts,
      coreContractDigest: verified.coreContractDigest,
      dependencyClosure: verified.dependencyClosure,
      async verify() {
        const verified = await verifyInstalledContent(record);
        return Object.freeze({
          ...facts,
          coreContractDigest: verified.coreContractDigest,
          dependencyClosure: verified.dependencyClosure
        });
      },
      async readManifest() {
        const verified = await verifyInstalledContent(record);
        return readBoundedJson(path.join(verified.contentRoot, "plugin.json"));
      },
      async readFile(filePath) {
        const verified = await verifyInstalledContent(record);
        const relative = safeName(String(filePath || "").replace(/^\.\//u, ""));
        const candidate = path.join(verified.contentRoot, relative);
        const bytes = await regularFileBytes(candidate);
        const resolved = await fs.realpath(candidate);
        const within = path.relative(verified.contentRoot, resolved);
        if (!within || within.startsWith("..") || path.isAbsolute(within)) {
          throw controlledError("PLUGIN_ARTIFACT_PATH_INVALID", "Plugin artifact file escaped immutable content.");
        }
        return Buffer.from(bytes);
      },
      async resolveRuntimeModule(modulePath) {
        const verified = await verifyInstalledContent(record);
        const relative = safeName(String(modulePath || "").replace(/^\.\//u, ""));
        const candidate = path.join(verified.contentRoot, relative);
        const bytes = await regularFileBytes(candidate);
        if (bytes.byteLength < 1) throw controlledError("PLUGIN_ARTIFACT_CONTENT_INVALID", "Plugin runtime module is empty.");
        const resolved = await fs.realpath(candidate);
        const within = path.relative(verified.contentRoot, resolved);
        if (!within || within.startsWith("..") || path.isAbsolute(within)) {
          throw controlledError("PLUGIN_ARTIFACT_PATH_INVALID", "Plugin runtime module escaped immutable content.");
        }
        return pathToFileURL(resolved);
      }
    });
  }

  async function loadCurrent(id) {
    const value = await readBoundedJson(path.join(currentRoot, `${pluginId(id)}.json`));
    if (!value) return null;
    return currentRecord(value, id);
  }

  function forPlugin({ pluginId: rawPluginId, lifecycleStatePort } = {}) {
    const id = pluginId(rawPluginId);
    const statePort = validateLifecyclePort(lifecycleStatePort, id);
    const bundlePluginRoot = path.join(bundlesRoot, id);
    const installedPluginRoot = path.join(installedRoot, id);
    const currentPath = path.join(currentRoot, `${id}.json`);

    async function retireSupersededCode(keepGeneration, keepDigest) {
      for (const entry of await fs.readdir(installedPluginRoot, { withFileTypes: true })) {
        if (entry.name === String(keepGeneration)) continue;
        const retired = path.join(installedPluginRoot, entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw controlledError("PLUGIN_ARTIFACT_CONTENT_INVALID", "Installed artifact namespace is invalid.");
        await makeWritableTree(retired);
        await fs.rm(retired, { recursive: true, force: false });
      }
      for (const entry of await fs.readdir(bundlePluginRoot, { withFileTypes: true })) {
        if (entry.name === keepDigest.slice(7)) continue;
        const retired = path.join(bundlePluginRoot, entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw controlledError("PLUGIN_ARTIFACT_CONTENT_INVALID", "Artifact bundle namespace is invalid.");
        await makeWritableTree(retired);
        await fs.rm(retired, { recursive: true, force: false });
      }
      await Promise.all([syncDirectory(installedPluginRoot), syncDirectory(bundlePluginRoot)]);
    }

    return Object.freeze({
      id: "PluginArtifactAuthorityPort",
      pluginId: id,
      async publish({ sourceRoot, version, generation: rawGeneration, dependencyClosure = [] } = {}) {
        if (Object.keys(trustedPublicKeys).length === 0) {
          throw controlledError("PLUGIN_ARTIFACT_TRUST_EMPTY", "Plugin artifact trust is not configured.");
        }
        if (artifactSigner?.id !== "ArtifactSignerPort" || typeof artifactSigner.sign !== "function" || !String(secretRef || "").trim()) {
          throw controlledError("PLUGIN_ARTIFACT_SIGNER_UNAVAILABLE", "Plugin artifact signer is unavailable.");
        }
        const artifactGeneration = generation(rawGeneration);
        const dependencies = normalizeDependencyClosure(dependencyClosure);
        if (typeof sourceRoot !== "string" || !sourceRoot.trim()) throw new TypeError("Plugin artifact source root is required.");
        const source = await existingRealDirectory(path.resolve(sourceRoot));
        const rawManifest = await readBoundedJson(path.join(source, "plugin.json"));
        if (rawManifest?.id !== id || String(rawManifest?.version || "").trim() !== String(version || "").trim() ||
            canonicalJson([...(rawManifest?.dependencies || [])].sort()) !== canonicalJson(dependencies.map((entry) => entry.pluginId))) {
          throw controlledError("PLUGIN_ARTIFACT_MANIFEST_MISMATCH", "Plugin artifact manifest does not match its Host scope or dependency closure.");
        }
        const runtimeModule = safeName(String(rawManifest?.runtime?.module || "").replace(/^\.\//u, ""));
        if (!runtimeModule.endsWith(".mjs")) {
          throw controlledError("PLUGIN_ARTIFACT_CONTENT_INVALID", "Plugin artifact runtime module must be an ECMAScript module.");
        }
        const files = await inventory(source);
        if (!files.some((entry) => entry.path === "plugin.json") || !files.some((entry) => entry.path === runtimeModule)) {
          throw controlledError("PLUGIN_ARTIFACT_CONTENT_INVALID", "Plugin artifact requires its declared runtime module.");
        }
        const unsigned = Object.freeze({
          schemaVersion: ENVELOPE_SCHEMA,
          pluginId: id,
          version: String(version).trim(),
          generation: artifactGeneration,
          coreContractDigest: boundCoreContractDigest,
          dependencyClosure: dependencies,
          files
        });
        const artifactDigest = digest(canonicalJson(unsigned));
        const context = Object.freeze({
          pluginId: id,
          version: unsigned.version,
          artifactDigest,
          generation: artifactGeneration,
          coreContractDigest: boundCoreContractDigest,
          dependencyClosure: dependencies
        });
        const signed = await artifactSigner.sign({
          secretRef: String(secretRef).trim(),
          purpose: `plugin-artifact.${id}.bundle`,
          payloadDigest: artifactDigest,
          context
        });
        if (signed?.ok !== true || signed.payloadDigest !== artifactDigest) {
          throw controlledError("PLUGIN_ARTIFACT_SIGNING_FAILED", "Plugin artifact signing failed.");
        }
        const envelope = Object.freeze({
          ...unsigned,
          artifactDigest,
          signature: Object.freeze({
            algorithm: signed.algorithm,
            payloadEncoding: signed.payloadEncoding,
            keyId: signed.keyId,
            payloadDigest: signed.payloadDigest,
            contextDigest: signed.contextDigest,
            signedEnvelope: signed.signedEnvelope,
            value: signed.signature
          })
        });
        const pluginBundles = await ensureRealDirectory(bundlePluginRoot, bundlesRoot);
        const target = path.join(pluginBundles, artifactDigest.slice("sha256:".length));
        const staging = path.join(pluginBundles, `.publish-${crypto.randomUUID()}`);
        await fs.mkdir(staging, { mode: 0o700 });
        try {
          await copyTree(source, path.join(staging, "content"));
          await durableFile(path.join(staging, METADATA_FILE), Buffer.from(canonicalJson(envelope)));
          await verifyEnvelope({ contentRoot: path.join(staging, "content"), envelopePath: path.join(staging, METADATA_FILE), trustedPublicKeys, expectedPluginId: id });
          await sealTree(staging);
          const pendingEntries = await fs.readdir(pluginBundles, { withFileTypes: true });
          if (pendingEntries.length > 2) {
            throw controlledError("PLUGIN_ARTIFACT_PENDING_BUNDLE_INVALID", "Plugin artifact pending bundle namespace is invalid.");
          }
          for (const entry of pendingEntries) {
            if (entry.name === path.basename(staging)) continue;
            const retired = path.join(pluginBundles, entry.name);
            if (!entry.isDirectory() || entry.isSymbolicLink()) {
              throw controlledError("PLUGIN_ARTIFACT_PENDING_BUNDLE_INVALID", "Plugin artifact pending bundle namespace is invalid.");
            }
            await makeWritableTree(retired);
            await fs.rm(retired, { recursive: true, force: false });
          }
          try {
            await fs.rename(staging, target);
            await syncDirectory(pluginBundles);
          } catch (error) {
            if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
            await verifyEnvelope({ contentRoot: path.join(target, "content"), envelopePath: path.join(target, METADATA_FILE), trustedPublicKeys, expectedPluginId: id });
          }
          return Object.freeze({ artifactDigest, generation: artifactGeneration, version: unsigned.version });
        } finally {
          await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
        }
      },
      async install({ artifactDigest: rawDigest, generation: rawGeneration, operation = "install", expectedCurrent = null } = {}) {
        const expectedDigest = requiredDigest(rawDigest, "Plugin artifact install digest");
        const expectedGeneration = generation(rawGeneration);
        if (!["install", "update", "reinstall"].includes(operation)) throw new TypeError("Plugin artifact install operation is invalid.");
        return statePort.runExclusive(async () => {
          const currentBefore = await loadCurrent(id);
          const ledgerBefore = await statePort.readRecord("ledger");
          const expectedPrevious = expectedCurrent && typeof expectedCurrent === "object"
            ? { artifactDigest: requiredDigest(expectedCurrent.artifactDigest, "Expected current artifact digest"), generation: generation(expectedCurrent.generation) }
            : null;
          const latestTombstone = await readBoundedJson(path.join(tombstoneRoot, `${id}.json`));
          if (latestTombstone) {
            exactObject(latestTombstone, ["schemaVersion", "pluginId", "generation", "artifactDigest", "removed"], "Plugin artifact tombstone");
          }
          const priorInstallJournal = await statePort.readRecord("artifact-install-journal");
          const highWater = Math.max(0, currentBefore?.generation || 0, Number(priorInstallJournal?.generation || 0), Number(latestTombstone?.generation || 0));
          const derivedOperation = !currentBefore && !ledgerBefore && highWater === 0
            ? "install"
            : currentBefore && ledgerBefore?.state === "inactive"
              ? "update"
              : !currentBefore && ledgerBefore?.state === "uninstalled"
                ? "reinstall"
                : "invalid";
          if (operation !== derivedOperation) {
            throw controlledError("PLUGIN_ARTIFACT_INSTALL_STATE_INVALID", "Plugin artifact operation does not match durable lifecycle state.");
          }
          if (operation === "install" && expectedPrevious) {
            throw controlledError("PLUGIN_ARTIFACT_INSTALL_STATE_INVALID", "Initial plugin artifact install requires an empty lifecycle.");
          }
          if (operation === "update" && (!expectedPrevious ||
              currentBefore.artifactDigest !== expectedPrevious.artifactDigest || currentBefore.generation !== expectedPrevious.generation ||
              expectedGeneration <= highWater)) {
            throw controlledError("PLUGIN_ARTIFACT_INSTALL_CAS_FAILED", "Plugin artifact update does not match the stopped current generation.");
          }
          if (operation === "reinstall" && (currentBefore || ledgerBefore?.state !== "uninstalled" || !expectedPrevious ||
              expectedGeneration <= highWater)) {
            throw controlledError("PLUGIN_ARTIFACT_INSTALL_CAS_FAILED", "Plugin artifact reinstall does not match the uninstalled generation.");
          }
          if (operation === "reinstall" && (!latestTombstone || latestTombstone.generation !== expectedPrevious.generation ||
              latestTombstone.artifactDigest !== expectedPrevious.artifactDigest || latestTombstone.removed !== true)) {
            throw controlledError("PLUGIN_ARTIFACT_INSTALL_CAS_FAILED", "Plugin artifact reinstall tombstone is unavailable.");
          }
          const transactionId = crypto.randomUUID();
          const bundle = path.join(bundlePluginRoot, expectedDigest.slice("sha256:".length));
          const verifiedBundle = await verifyEnvelope({
            contentRoot: path.join(bundle, "content"),
            envelopePath: path.join(bundle, METADATA_FILE),
            trustedPublicKeys,
            expectedPluginId: id
          });
          if (verifiedBundle.envelope.artifactDigest !== expectedDigest || verifiedBundle.envelope.generation !== expectedGeneration ||
              verifiedBundle.envelope.coreContractDigest !== boundCoreContractDigest) {
            throw controlledError("PLUGIN_ARTIFACT_INSTALL_MISMATCH", "Plugin artifact install request does not match its signed bundle.");
          }
          const pluginInstallRoot = await ensureRealDirectory(installedPluginRoot, installedRoot);
          const target = path.join(pluginInstallRoot, String(expectedGeneration));
          const staging = path.join(pluginInstallRoot, `.install-${transactionId}`);
          const journal = {
            schemaVersion: INSTALL_JOURNAL_SCHEMA,
            recordType: "artifact_install",
            pluginId: id,
            transactionId,
            operation,
            artifactDigest: expectedDigest,
            generation: expectedGeneration,
            previousArtifactDigest: expectedPrevious?.artifactDigest || "",
            previousGeneration: expectedPrevious?.generation || 0,
            phase: "prepared"
          };
          await statePort.writeRecord("artifact-install-journal", journal);
          await copyTree(bundle, staging);
          await verifyEnvelope({ contentRoot: path.join(staging, "content"), envelopePath: path.join(staging, METADATA_FILE), trustedPublicKeys, expectedPluginId: id });
          await sealTree(staging);
          await fault("install:staged");
          await statePort.assertExclusive();
          try {
            await fs.rename(staging, target);
          } catch (error) {
            if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
            const existing = await verifyEnvelope({ contentRoot: path.join(target, "content"), envelopePath: path.join(target, METADATA_FILE), trustedPublicKeys, expectedPluginId: id });
            if (existing.envelope.artifactDigest !== expectedDigest) throw controlledError("PLUGIN_ARTIFACT_GENERATION_CONFLICT", "Plugin artifact generation is already occupied.");
          }
          await syncDirectory(pluginInstallRoot);
          await statePort.writeRecord("artifact-install-journal", { ...journal, phase: "content_published" });
          await fault("install:content-published");
          const current = Object.freeze({
            schemaVersion: CURRENT_SCHEMA,
            pluginId: id,
            version: verifiedBundle.envelope.version,
            generation: expectedGeneration,
            artifactDigest: expectedDigest,
            keyId: verifiedBundle.envelope.signature.keyId
          });
          await durableJson(currentPath, current, statePort);
          if (operation === "update") {
            await retireSupersededCode(expectedGeneration, expectedDigest);
          }
          await statePort.writeRecord("ledger", {
            schemaVersion: "meshrix.plugin-lifecycle-ledger/1",
            pluginId: id,
            state: "active",
            operation: "",
            idempotencyKey: "",
            requestDigest: "",
            generation: Math.max(expectedGeneration, Number(ledgerBefore?.generation || 0))
          });
          await statePort.writeRecord("artifact-install-journal", { ...journal, phase: "completed" });
          await fault("install:completed");
          return Object.freeze({ ok: true, installed: true, ...current });
        });
      },
      async recoverInstall() {
        return statePort.runExclusive(async () => {
          const journal = await statePort.readRecord("artifact-install-journal");
          if (!journal || journal.phase === "completed") return Object.freeze({ ok: true, recovered: false });
          exactObject(journal, ["schemaVersion", "recordType", "pluginId", "transactionId", "operation", "artifactDigest", "generation", "previousArtifactDigest", "previousGeneration", "phase"], "Plugin artifact install journal");
          if (journal.schemaVersion !== INSTALL_JOURNAL_SCHEMA || journal.recordType !== "artifact_install" || journal.pluginId !== id ||
              !["prepared", "content_published"].includes(journal.phase)) {
            throw controlledError("PLUGIN_ARTIFACT_INSTALL_JOURNAL_INVALID", "Plugin artifact install journal is invalid.");
          }
          const target = path.join(installedPluginRoot, String(generation(journal.generation)));
          try {
            await fs.lstat(target);
          } catch (error) {
            if (error?.code !== "ENOENT" || journal.phase !== "prepared") throw error;
            const bundle = path.join(bundlePluginRoot, String(journal.artifactDigest).slice("sha256:".length));
            const staging = path.join(installedPluginRoot, `.recover-install-${journal.transactionId}`);
            await fs.rm(path.join(installedPluginRoot, `.install-${journal.transactionId}`), { recursive: true, force: true });
            await fs.rm(staging, { recursive: true, force: true });
            await copyTree(bundle, staging);
            await verifyEnvelope({ contentRoot: path.join(staging, "content"), envelopePath: path.join(staging, METADATA_FILE), trustedPublicKeys, expectedPluginId: id });
            await sealTree(staging);
            await statePort.assertExclusive();
            await fs.rename(staging, target);
            await syncDirectory(installedPluginRoot);
          }
          const verified = await verifyEnvelope({ contentRoot: path.join(target, "content"), envelopePath: path.join(target, METADATA_FILE), trustedPublicKeys, expectedPluginId: id });
          if (verified.envelope.artifactDigest !== journal.artifactDigest) throw controlledError("PLUGIN_ARTIFACT_INSTALL_MISMATCH", "Recovered plugin artifact does not match its journal.");
          const current = Object.freeze({ schemaVersion: CURRENT_SCHEMA, pluginId: id, version: verified.envelope.version,
            generation: verified.envelope.generation, artifactDigest: verified.envelope.artifactDigest, keyId: verified.envelope.signature.keyId });
          await durableJson(currentPath, current, statePort);
          if (journal.operation === "update") await retireSupersededCode(current.generation, current.artifactDigest);
          await statePort.writeRecord("ledger", {
            schemaVersion: "meshrix.plugin-lifecycle-ledger/1", pluginId: id, state: "active", operation: "",
            idempotencyKey: "", requestDigest: "", generation: Math.max(current.generation, Number((await statePort.readRecord("ledger"))?.generation || 0))
          });
          await statePort.writeRecord("artifact-install-journal", { ...journal, phase: "completed" });
          return Object.freeze({ ok: true, recovered: true, ...current });
        });
      },
      async remove({ expectedArtifactDigest, expectedGeneration } = {}) {
        const expectedDigest = requiredDigest(expectedArtifactDigest, "Plugin artifact removal digest");
        const expectedArtifactGeneration = generation(expectedGeneration);
        return statePort.runExclusive(async () => {
          const tombstonePath = path.join(tombstoneRoot, `${id}.json`);
          const existingTombstone = await readBoundedJson(tombstonePath);
          const current = await loadCurrent(id);
          if (existingTombstone) {
            exactObject(existingTombstone, ["schemaVersion", "pluginId", "generation", "artifactDigest", "removed"], "Plugin artifact tombstone");
            if (existingTombstone.schemaVersion !== TOMBSTONE_SCHEMA || existingTombstone.pluginId !== id || existingTombstone.removed !== true) {
              throw controlledError("PLUGIN_ARTIFACT_TOMBSTONE_INVALID", "Plugin artifact tombstone is invalid.");
            }
            if (existingTombstone.generation === expectedArtifactGeneration && existingTombstone.artifactDigest === expectedDigest) {
              if (!current) return Object.freeze({ ok: true, removed: true, replayed: true });
              throw controlledError("PLUGIN_ARTIFACT_REMOVAL_MISMATCH", "A newer plugin artifact generation is installed.");
            }
          }
          if (!current) throw controlledError("PLUGIN_ARTIFACT_ABSENT_UNPROVEN", "Plugin artifact absence has no matching removal tombstone.");
          if (current.generation !== expectedArtifactGeneration || current.artifactDigest !== expectedDigest) {
            throw controlledError("PLUGIN_ARTIFACT_REMOVAL_MISMATCH", "Plugin artifact removal expectation does not match the installed generation.");
          }
          const journal = Object.freeze({ schemaVersion: REMOVAL_JOURNAL_SCHEMA, recordType: "artifact_removal", pluginId: id,
            artifactDigest: expectedDigest, generation: expectedArtifactGeneration, phase: "prepared" });
          await statePort.writeRecord("artifact-removal-journal", journal);
          const target = path.join(installedPluginRoot, String(expectedArtifactGeneration));
          const verified = await verifyEnvelope({ contentRoot: path.join(target, "content"), envelopePath: path.join(target, METADATA_FILE), trustedPublicKeys, expectedPluginId: id });
          if (verified.envelope.artifactDigest !== expectedDigest) throw controlledError("PLUGIN_ARTIFACT_REMOVAL_MISMATCH", "Plugin artifact target does not match the removal expectation.");
          await statePort.assertExclusive();
          await makeWritableTree(installedPluginRoot);
          await fs.rm(installedPluginRoot, { recursive: true, force: false });
          try {
            await makeWritableTree(bundlePluginRoot);
            await fs.rm(bundlePluginRoot, { recursive: true, force: false });
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
          await Promise.all([syncDirectory(installedRoot), syncDirectory(bundlesRoot)]);
          await statePort.writeRecord("artifact-removal-journal", { ...journal, phase: "content_removed" });
          await fault("remove:content-removed");
          await statePort.assertExclusive();
          await fs.rm(currentPath, { force: false });
          await syncDirectory(currentRoot);
          const tombstone = Object.freeze({ schemaVersion: TOMBSTONE_SCHEMA, pluginId: id, generation: expectedArtifactGeneration,
            artifactDigest: expectedDigest, removed: true });
          await durableJson(tombstonePath, tombstone, statePort);
          await statePort.writeRecord("artifact-removal-journal", { ...journal, phase: "completed" });
          return Object.freeze({ ok: true, removed: true, replayed: false });
        });
      },
      async recoverRemoval() {
        return statePort.runExclusive(async () => {
          const journal = await statePort.readRecord("artifact-removal-journal");
          if (!journal || journal.phase === "completed") return Object.freeze({ ok: true, recovered: false });
          exactObject(journal, ["schemaVersion", "recordType", "pluginId", "artifactDigest", "generation", "phase"], "Plugin artifact removal journal");
          if (journal.schemaVersion !== REMOVAL_JOURNAL_SCHEMA || journal.recordType !== "artifact_removal" || journal.pluginId !== id ||
              !["prepared", "content_removed"].includes(journal.phase)) {
            throw controlledError("PLUGIN_ARTIFACT_REMOVAL_JOURNAL_INVALID", "Plugin artifact removal journal is invalid.");
          }
          const expectedDigest = requiredDigest(journal.artifactDigest, "Plugin artifact removal digest");
          const expectedGeneration = generation(journal.generation);
          const target = path.join(installedPluginRoot, String(expectedGeneration));
          let targetPresent = false;
          try {
            await fs.lstat(target);
            targetPresent = true;
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
          if (targetPresent) {
            const verified = await verifyEnvelope({ contentRoot: path.join(target, "content"), envelopePath: path.join(target, METADATA_FILE), trustedPublicKeys, expectedPluginId: id });
            if (verified.envelope.artifactDigest !== expectedDigest) {
              throw controlledError("PLUGIN_ARTIFACT_REMOVAL_MISMATCH", "Recovered plugin artifact does not match its removal journal.");
            }
            await statePort.assertExclusive();
            await makeWritableTree(installedPluginRoot);
            await fs.rm(installedPluginRoot, { recursive: true, force: false });
            try {
              await makeWritableTree(bundlePluginRoot);
              await fs.rm(bundlePluginRoot, { recursive: true, force: false });
            } catch (error) {
              if (error?.code !== "ENOENT") throw error;
            }
            await Promise.all([syncDirectory(installedRoot), syncDirectory(bundlesRoot)]);
            await statePort.writeRecord("artifact-removal-journal", { ...journal, phase: "content_removed" });
          }
          if (!targetPresent) {
            try {
              await fs.lstat(installedPluginRoot);
              await makeWritableTree(installedPluginRoot);
              await fs.rm(installedPluginRoot, { recursive: true, force: false });
              await syncDirectory(installedRoot);
            } catch (error) {
              if (error?.code !== "ENOENT") throw error;
            }
            try {
              await fs.lstat(bundlePluginRoot);
              await makeWritableTree(bundlePluginRoot);
              await fs.rm(bundlePluginRoot, { recursive: true, force: false });
              await syncDirectory(bundlesRoot);
            } catch (error) {
              if (error?.code !== "ENOENT") throw error;
            }
          }
          const current = await loadCurrent(id);
          if (current && (current.generation !== expectedGeneration || current.artifactDigest !== expectedDigest)) {
            throw controlledError("PLUGIN_ARTIFACT_REMOVAL_MISMATCH", "Plugin artifact current generation changed during recovery.");
          }
          if (current) {
            await statePort.assertExclusive();
            await fs.rm(currentPath, { force: false });
            await syncDirectory(currentRoot);
          }
          const tombstonePath = path.join(tombstoneRoot, `${id}.json`);
          await durableJson(tombstonePath, { schemaVersion: TOMBSTONE_SCHEMA, pluginId: id, generation: expectedGeneration,
            artifactDigest: expectedDigest, removed: true }, statePort);
          await statePort.writeRecord("artifact-removal-journal", { ...journal, phase: "completed" });
          return Object.freeze({ ok: true, recovered: true, removed: true });
        });
      },
      async loadSnapshot() {
        const record = await loadCurrent(id);
        if (!record) return null;
        const verified = await verifyInstalledContent(record);
        return installedSnapshot(record, verified);
      }
    });
  }

  return Object.freeze({
    id: "PluginArtifactAuthority",
    forPlugin,
    async discover() {
      const entries = await fs.readdir(currentRoot, { withFileTypes: true });
      if (entries.length > MAX_PLUGIN_COUNT) throw controlledError("PLUGIN_ARTIFACT_CATALOG_OVERSIZED", "Plugin artifact catalog exceeds its bound.");
      const snapshots = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isSymbolicLink()) throw controlledError("PLUGIN_ARTIFACT_SYMLINK_DENIED", "Plugin artifact current records cannot be symbolic links.");
        if (!entry.isFile() || !entry.name.endsWith(".json")) throw controlledError("PLUGIN_ARTIFACT_RECORD_INVALID", "Plugin artifact current root contains an unsupported entry.");
        const id = pluginId(entry.name.slice(0, -5));
        const record = currentRecord(await readBoundedJson(path.join(currentRoot, entry.name)), id);
        const verified = await verifyInstalledContent(record);
        snapshots.push(installedSnapshot(record, verified));
      }
      return Object.freeze(snapshots);
    }
  });
}

export const PLUGIN_ARTIFACT_METADATA_FILE = METADATA_FILE;
export const PLUGIN_ARTIFACT_ENVELOPE_SCHEMA = ENVELOPE_SCHEMA;
