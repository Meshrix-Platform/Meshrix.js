import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as openpgp from "openpgp";
import { ServerConfig } from "#meshrix/server-config";
import {
  connectorRoot,
  PRIORITY_INSTALL_TARGET,
  projectRoot,
  readJson,
  run,
  sha256
} from "./mcp-release-common.mjs";
import { createReproduciblePortableArchives } from "./mcp-release-reproducible-archives.mjs";

const NODE_LEGAL_FILE_NAMES = Object.freeze([
  "LICENSE",
  "NOTICE",
  "NOTICE.txt",
  "THIRD_PARTY_NOTICES",
  "THIRD_PARTY_NOTICES.txt",
  "THIRD_PARTY_LICENSES",
  "THIRD_PARTY_LICENSES.txt"
]);
const NODE_RUNTIME_LOCK_PATH = path.join(projectRoot, "tools", "release", "node-runtime.lock.json");
const NODE_RUNTIME_LOCK_SCHEMA = "v1:node-runtime-release-lock";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OPENPGP_FINGERPRINT_PATTERN = /^[A-F0-9]{40}$/u;
const MAX_NODE_METADATA_BYTES = 1024 * 1024;
const MAX_NODE_RUNTIME_ARCHIVE_BYTES = 128 * 1024 * 1024;
const PINNED_DOWNLOAD_TIMEOUT_MS = 300000;
const PINNED_DOWNLOAD_RETRY_DELAYS_MS = Object.freeze([250, 750]);
let nodeRuntimeLockPromise = null;
const activePinnedDownloads = new Map();

function unixExecutableName(name) {
  return name;
}

async function writeExecutable(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o755);
  }
}

export function resolveNodeRuntimeCacheDirectory({
  environment = process.env,
  dataDir
} = {}) {
  const override = String(environment?.MESHRIX_MCP_NODE_RUNTIME_CACHE_DIR || "").trim();
  if (override) {
    return path.resolve(override);
  }

  const normalizedDataDir = String(
    dataDir === undefined ? ServerConfig.getDataDir() : dataDir || ""
  ).trim();
  if (!normalizedDataDir) {
    throw new Error("node_runtime_cache_data_directory_missing");
  }
  return path.join(path.resolve(normalizedDataDir), "cache", "mcp-node-runtime");
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileMatchesSha256(filePath, expectedSha256, expectedSizeBytes) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size !== expectedSizeBytes) {
      return false;
    }
    return await sha256(filePath) === expectedSha256;
  } catch {
    return false;
  }
}

function releaseBundlePlatform(target) {
  if (target === "linux-x64") {
    return "linux-x86_64";
  }
  return target;
}

function normalizeNodeVersion(version) {
  return String(version).trim().startsWith("v") ? String(version).trim() : `v${String(version).trim()}`;
}

function validateNodeRuntimeLock(lock) {
  if (lock?.schemaVersion !== NODE_RUNTIME_LOCK_SCHEMA || !/^v\d+\.\d+\.\d+$/u.test(lock?.version || "")) {
    throw new Error("node_runtime_lock_invalid");
  }
  if (lock.distributionBaseUrl !== "https://nodejs.org/dist") {
    throw new Error("node_runtime_lock_untrusted_distribution");
  }
  if (lock.checksumsFile !== "SHASUMS256.txt" || lock.signatureFile !== "SHASUMS256.txt.sig") {
    throw new Error("node_runtime_lock_metadata_names_invalid");
  }
  for (const digest of [lock.checksumsSha256, lock.signatureSha256, lock.signer?.publicKeySha256]) {
    if (!SHA256_PATTERN.test(String(digest || ""))) {
      throw new Error("node_runtime_lock_invalid_digest");
    }
  }
  for (const sizeBytes of [
    lock.checksumsSizeBytes,
    lock.signatureSizeBytes,
    lock.signer?.publicKeySizeBytes
  ]) {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_NODE_METADATA_BYTES) {
      throw new Error("node_runtime_lock_invalid_metadata_size");
    }
  }
  if (!OPENPGP_FINGERPRINT_PATTERN.test(String(lock.signer?.fingerprint || ""))) {
    throw new Error("node_runtime_lock_invalid_signer");
  }
  if (!/^[a-f0-9]{40}$/u.test(String(lock.signer?.releaseKeysCommit || ""))) {
    throw new Error("node_runtime_lock_invalid_release_keys_commit");
  }
  let keyUrl;
  try {
    keyUrl = new URL(String(lock.signer?.publicKeyUrl || ""));
  } catch {
    throw new Error("node_runtime_lock_untrusted_signer_key");
  }
  if (
    keyUrl.protocol !== "https:"
    || keyUrl.hostname !== "raw.githubusercontent.com"
    || keyUrl.port
    || keyUrl.username
    || keyUrl.password
    || keyUrl.search
    || keyUrl.hash
  ) {
    throw new Error("node_runtime_lock_untrusted_signer_key");
  }
  if (keyUrl.pathname !== `/nodejs/release-keys/${lock.signer.releaseKeysCommit}/keys/${lock.signer.fingerprint}.asc`) {
    throw new Error("node_runtime_lock_unpinned_signer_key");
  }
  const targets = Object.entries(lock.targets || {});
  if (targets.length === 0) {
    throw new Error("node_runtime_lock_targets_missing");
  }
  for (const [target, descriptor] of targets) {
    if (!/^(?:macos|linux|windows)-(?:x64|arm64)$/u.test(target) ||
        !/^[A-Za-z0-9._-]+$/u.test(String(descriptor?.filename || "")) ||
        !String(descriptor.filename).includes(lock.version) ||
        !SHA256_PATTERN.test(String(descriptor?.sha256 || "")) ||
        !Number.isSafeInteger(descriptor?.sizeBytes) ||
        descriptor.sizeBytes <= 0 ||
        descriptor.sizeBytes > MAX_NODE_RUNTIME_ARCHIVE_BYTES) {
      throw new Error("node_runtime_lock_target_invalid");
    }
  }
  return Object.freeze(lock);
}

export async function loadNodeRuntimeLock() {
  nodeRuntimeLockPromise ||= readJson(NODE_RUNTIME_LOCK_PATH).then(validateNodeRuntimeLock);
  return nodeRuntimeLockPromise;
}

export async function resolveBundledNodeVersion(explicitVersion = "") {
  const lock = await loadNodeRuntimeLock();
  if (typeof explicitVersion === "string" && explicitVersion.trim() &&
      normalizeNodeVersion(explicitVersion) !== lock.version) {
    throw new Error("node_runtime_version_not_locked");
  }
  return lock.version;
}

async function collectNodeLegalFiles(distributionRoot) {
  const legalFiles = [];
  for (const filename of NODE_LEGAL_FILE_NAMES) {
    const sourcePath = path.join(distributionRoot, filename);
    const stat = await fs.stat(sourcePath).catch(() => null);
    if (stat?.isFile()) {
      legalFiles.push({ filename, sourcePath });
    }
  }
  if (!legalFiles.some((file) => file.filename === "LICENSE")) {
    throw new Error("node_runtime_license_missing");
  }
  return legalFiles;
}

async function normalizeNodeRuntimeSource(runtimeSource = {}) {
  const executablePath = path.resolve(String(runtimeSource.executablePath || ""));
  const distributionRoot = path.resolve(String(runtimeSource.distributionRoot || ""));
  const executableStat = await fs.stat(executablePath).catch(() => null);
  const distributionStat = await fs.stat(distributionRoot).catch(() => null);
  if (!executableStat?.isFile() || !distributionStat?.isDirectory()) {
    throw new Error("node_runtime_source_invalid");
  }
  return {
    executablePath,
    distributionRoot,
    legalFiles: await collectNodeLegalFiles(distributionRoot)
  };
}

function normalizePinnedDownloadContract(url, destination, expectedSha256, expectedSizeBytes) {
  let parsedUrl;
  try {
    parsedUrl = new URL(String(url || ""));
  } catch {
    throw new Error("node_runtime_pinned_download_contract_invalid");
  }
  if (
    parsedUrl.protocol !== "https:"
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.search
    || parsedUrl.hash
    || parsedUrl.port
    || !SHA256_PATTERN.test(String(expectedSha256 || ""))
    || !Number.isSafeInteger(expectedSizeBytes)
    || expectedSizeBytes <= 0
    || expectedSizeBytes > MAX_NODE_RUNTIME_ARCHIVE_BYTES
  ) {
    throw new Error("node_runtime_pinned_download_contract_invalid");
  }
  return {
    url: parsedUrl.href,
    destination: path.resolve(destination),
    expectedSha256,
    expectedSizeBytes
  };
}

async function downloadPinnedFileOnce(contract, fetchImpl) {
  const { url, destination, expectedSha256, expectedSizeBytes } = contract;
  if (await fileMatchesSha256(destination, expectedSha256, expectedSizeBytes)) {
    return destination;
  }
  await fs.rm(destination, { force: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.download`;
  try {
    const response = await fetchImpl(url, {
      redirect: "error",
      headers: { "Accept-Encoding": "identity" },
      signal: AbortSignal.timeout(PINNED_DOWNLOAD_TIMEOUT_MS)
    });
    if (response.status !== 200 || !response.body || response.redirected === true) {
      throw new Error("node_runtime_pinned_download_failed");
    }
    const contentLength = response.headers?.get?.("content-length");
    if (contentLength !== null && contentLength !== undefined) {
      if (!/^\d+$/u.test(contentLength) || Number(contentLength) !== expectedSizeBytes) {
        throw new Error("node_runtime_download_size_mismatch");
      }
    }

    let receivedBytes = 0;
    const byteLimit = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > expectedSizeBytes) {
          callback(new Error("node_runtime_download_size_limit_exceeded"));
          return;
        }
        callback(null, chunk);
      }
    });
    await pipeline(
      response.body,
      byteLimit,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 })
    );
    if (receivedBytes !== expectedSizeBytes) {
      throw new Error("node_runtime_download_size_mismatch");
    }
    if (!await fileMatchesSha256(temporary, expectedSha256, expectedSizeBytes)) {
      throw new Error("node_runtime_download_digest_mismatch");
    }
    try {
      await fs.link(temporary, destination);
      await fs.rm(temporary, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST" || !await fileMatchesSha256(
        destination,
        expectedSha256,
        expectedSizeBytes
      )) {
        throw error;
      }
      await fs.rm(temporary, { force: true });
    }
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return destination;
}

function isRetryablePinnedDownloadError(error) {
  const code = String(error?.code || "").toUpperCase();
  if ([
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET"
  ].includes(code)) {
    return true;
  }
  return (
    ["AbortError", "TimeoutError", "TypeError"].includes(String(error?.name || ""))
    && /fetch failed|network|timeout|aborted/iu.test(String(error?.message || ""))
  );
}

export async function downloadPinnedFile(
  url,
  destination,
  expectedSha256,
  expectedSizeBytes,
  { fetchImpl = globalThis.fetch } = {}
) {
  const contract = normalizePinnedDownloadContract(
    url,
    destination,
    expectedSha256,
    expectedSizeBytes
  );
  const active = activePinnedDownloads.get(contract.destination);
  if (active) {
    if (
      active.url !== contract.url
      || active.expectedSha256 !== contract.expectedSha256
      || active.expectedSizeBytes !== contract.expectedSizeBytes
    ) {
      throw new Error("node_runtime_concurrent_download_contract_mismatch");
    }
    return active.promise;
  }
  const promise = (async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await downloadPinnedFileOnce(contract, fetchImpl);
      } catch (error) {
        const delayMs = PINNED_DOWNLOAD_RETRY_DELAYS_MS[attempt];
        if (!isRetryablePinnedDownloadError(error) || delayMs === undefined) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  })()
    .finally(() => activePinnedDownloads.delete(contract.destination));
  activePinnedDownloads.set(contract.destination, { ...contract, promise });
  return promise;
}

function parseSignedNodeChecksums(text) {
  const checksums = new Map();
  for (const line of String(text || "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-f0-9]{64})\s+([^\s\u0000-\u001f]+)$/u);
    const filename = String(match?.[2] || "");
    if (!match || filename.startsWith("/") || filename.split("/").includes("..") || checksums.has(filename)) {
      throw new Error("node_runtime_signed_checksums_invalid");
    }
    checksums.set(filename, match[1]);
  }
  return checksums;
}

export function verifyNodeRuntimeSignedChecksums({ lock, checksumsText } = {}) {
  const validatedLock = validateNodeRuntimeLock(lock);
  if (sha256Buffer(Buffer.from(String(checksumsText || ""), "utf8")) !== validatedLock.checksumsSha256) {
    throw new Error("node_runtime_checksums_digest_mismatch");
  }
  const signedChecksums = parseSignedNodeChecksums(checksumsText);
  for (const descriptor of Object.values(validatedLock.targets)) {
    if (signedChecksums.get(descriptor.filename) !== descriptor.sha256) {
      throw new Error("node_runtime_target_not_authenticated_by_signed_checksums");
    }
  }
  return true;
}

export async function verifyNodeReleaseSignature({ lock, checksumsPath, signaturePath, keyPath }) {
  try {
    const [armoredKey, checksums, detachedSignature] = await Promise.all([
      fs.readFile(keyPath, "utf8"),
      fs.readFile(checksumsPath),
      fs.readFile(signaturePath)
    ]);
    const verificationKey = await openpgp.readKey({ armoredKey });
    if (String(verificationKey.getFingerprint() || "").toUpperCase() !== lock.signer.fingerprint) {
      throw new Error("node_runtime_signature_signer_mismatch");
    }
    const message = await openpgp.createMessage({ binary: new Uint8Array(checksums) });
    const signature = await openpgp.readSignature({
      binarySignature: new Uint8Array(detachedSignature)
    });
    const verification = await openpgp.verify({
      message,
      signature,
      verificationKeys: verificationKey
    });
    if (verification.signatures.length !== 1) {
      throw new Error("node_runtime_signature_invalid");
    }
    await verification.signatures[0].verified;
  } catch (error) {
    if (String(error?.message || "").startsWith("node_runtime_signature_")) {
      throw error;
    }
    throw new Error("node_runtime_signature_invalid");
  }
}

async function authenticateNodeRelease(lock, outputDir) {
  const cacheDir = resolveNodeRuntimeCacheDirectory();
  await fs.mkdir(cacheDir, { recursive: true });
  const releaseBaseUrl = `${lock.distributionBaseUrl}/${lock.version}`;
  const checksumsPath = await downloadPinnedFile(
    `${releaseBaseUrl}/${lock.checksumsFile}`,
    path.join(cacheDir, `${lock.version}-${lock.checksumsFile}`),
    lock.checksumsSha256,
    lock.checksumsSizeBytes
  );
  const signaturePath = await downloadPinnedFile(
    `${releaseBaseUrl}/${lock.signatureFile}`,
    path.join(cacheDir, `${lock.version}-${lock.signatureFile}`),
    lock.signatureSha256,
    lock.signatureSizeBytes
  );
  const keyPath = await downloadPinnedFile(
    lock.signer.publicKeyUrl,
    path.join(cacheDir, `${lock.signer.fingerprint}.asc`),
    lock.signer.publicKeySha256,
    lock.signer.publicKeySizeBytes
  );
  const checksumsText = await fs.readFile(checksumsPath, "utf8");
  verifyNodeRuntimeSignedChecksums({ lock, checksumsText });
  await verifyNodeReleaseSignature({ lock, checksumsPath, signaturePath, keyPath });
}

export async function verifyPinnedNodeRuntimeRelease({ outputDir }) {
  const lock = await loadNodeRuntimeLock();
  await fs.mkdir(outputDir, { recursive: true });
  await authenticateNodeRelease(lock, outputDir);
  return {
    version: lock.version,
    signerFingerprint: lock.signer.fingerprint,
    releaseKeysCommit: lock.signer.releaseKeysCommit,
    targetCount: Object.keys(lock.targets).length,
    signatureVerified: true,
    signedChecksumsVerified: true
  };
}

async function downloadNodeRuntime(version, target, outputDir) {
  const lock = await loadNodeRuntimeLock();
  if (normalizeNodeVersion(version) !== lock.version) {
    throw new Error("node_runtime_version_not_locked");
  }
  const descriptor = lock.targets[target];
  if (!descriptor) {
    throw new Error("node_runtime_target_not_locked");
  }
  await authenticateNodeRelease(lock, outputDir);
  const cacheDir = resolveNodeRuntimeCacheDirectory();
  const archivePath = await downloadPinnedFile(
    `${lock.distributionBaseUrl}/${lock.version}/${descriptor.filename}`,
    path.join(cacheDir, descriptor.filename),
    descriptor.sha256,
    descriptor.sizeBytes
  );

  const extractDir = path.join(outputDir, `extracted-${target}`);
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.mkdir(extractDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    await run("unzip", ["-q", archivePath, "-d", extractDir]);
    const nodeRoot = path.basename(descriptor.filename, ".zip");
    return normalizeNodeRuntimeSource({
      executablePath: path.join(extractDir, nodeRoot, "node.exe"),
      distributionRoot: path.join(extractDir, nodeRoot)
    });
  }
  await run("tar", ["-xf", archivePath, "-C", extractDir, "--strip-components=1"]);

  return normalizeNodeRuntimeSource({
    executablePath: path.join(extractDir, "bin", "node"),
    distributionRoot: extractDir
  });
}

export async function createPortableBundle({
  outputDir,
  packageJson,
  target,
  bundledVersion,
  nodeRuntime = null
}) {
  const lockedVersion = await resolveBundledNodeVersion(bundledVersion);
  const runtimeLock = await loadNodeRuntimeLock();
  if (!runtimeLock.targets[target]) {
    throw new Error("node_runtime_target_not_locked");
  }
  const platform = releaseBundlePlatform(target);
  const windowsBundle = platform.startsWith("windows");
  const macosBundle = platform.startsWith("macos");
  const rootName = `${packageJson.name}-${packageJson.version}-${platform}`;
  const stagingRoot = path.join(outputDir, rootName);
  const appRoot = path.join(stagingRoot, "app");
  const runtimeRoot = path.join(stagingRoot, "runtime");
  const runtimeExecutableName = platform.startsWith("windows") ? "node.exe" : "node";
  const runtimePath = path.join(runtimeRoot, runtimeExecutableName);
  const generateZip = !platform.startsWith("linux");
  const archiveName = `${rootName}.tar.gz`;
  const archivePath = path.join(outputDir, archiveName);
  const zipArchiveName = generateZip ? `${rootName}.zip` : null;
  const zipArchivePath = zipArchiveName ? path.join(outputDir, zipArchiveName) : null;

  await fs.rm(stagingRoot, { recursive: true, force: true });
  await fs.rm(archivePath, { force: true });
  if (zipArchivePath) {
    await fs.rm(zipArchivePath, { force: true });
  }
  await fs.mkdir(path.join(appRoot, "bin"), { recursive: true });
  await fs.mkdir(runtimeRoot, { recursive: true });
  const resolvedNodeRuntime = nodeRuntime
    ? await normalizeNodeRuntimeSource(nodeRuntime)
    : await downloadNodeRuntime(lockedVersion, target, outputDir);
  await fs.copyFile(resolvedNodeRuntime.executablePath, runtimePath);
  await fs.chmod(runtimePath, 0o755);
  await fs.copyFile(path.join(projectRoot, "LICENSE"), path.join(stagingRoot, "LICENSE"));
  const portablePackageJson = {
    ...packageJson,
    imports: {
      ...packageJson.imports,
      "#meshrix/contracts/*": "./vendor/contracts/*.mjs"
    }
  };
  await fs.writeFile(
    path.join(stagingRoot, "package.json"),
    `${JSON.stringify({
      private: true,
      type: "module",
      imports: {
        "#meshrix/contracts/*": "./app/vendor/contracts/*.mjs"
      }
    }, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(appRoot, "package.json"),
    `${JSON.stringify(portablePackageJson, null, 2)}\n`,
    "utf8"
  );
  await fs.copyFile(path.join(connectorRoot, "README.md"), path.join(appRoot, "README.md"));
  await fs.copyFile(path.join(connectorRoot, "LICENSE"), path.join(appRoot, "LICENSE"));
  await fs.copyFile(
    path.join(connectorRoot, "mcp-release-targets.mjs"),
    path.join(appRoot, "mcp-release-targets.mjs")
  );
  await fs.copyFile(
    path.join(connectorRoot, "mcp-identity.mjs"),
    path.join(appRoot, "mcp-identity.mjs")
  );
  await fs.copyFile(
    path.join(connectorRoot, "mcp-identity.mjs"),
    path.join(stagingRoot, "mcp-identity.mjs")
  );
  await fs.copyFile(
    path.join(connectorRoot, "bin", "meshrix-mcp.mjs"),
    path.join(appRoot, "bin", "meshrix-mcp.mjs")
  );
  await fs.cp(path.join(connectorRoot, "lib"), path.join(appRoot, "lib"), { recursive: true });
  const portableContractsRoot = path.join(appRoot, "vendor", "contracts");
  await fs.mkdir(portableContractsRoot, { recursive: true });
  await fs.copyFile(
    path.join(projectRoot, "packages", "contracts", "src", "mcp-catalog-delivery.mjs"),
    path.join(portableContractsRoot, "mcp-catalog-delivery.mjs")
  );
  const contractsSourceRoot = path.join(projectRoot, "packages", "contracts");
  const contractsPackage = await readJson(path.join(contractsSourceRoot, "package.json"));
  if (packageJson.dependencies?.[contractsPackage.name] !== contractsPackage.version) {
    throw new Error("portable_contracts_dependency_version_mismatch");
  }
  const portableCanonicalJsonPath = path.join(
    portableContractsRoot,
    "serialization",
    "canonical-json.mjs"
  );
  await fs.mkdir(path.dirname(portableCanonicalJsonPath), { recursive: true });
  await fs.copyFile(
    path.join(contractsSourceRoot, "src", "serialization", "canonical-json.mjs"),
    portableCanonicalJsonPath
  );
  const nativeInstallerRoot = path.join(connectorRoot, "..", "native-installer");
  const nativeInstallerFiles = windowsBundle
    ? ["meshrix-mcp-install.ps1", "meshrix-mcp-uninstall.ps1"]
    : ["meshrix-mcp-install.sh", "meshrix-mcp-uninstall.sh"];
  for (const filename of nativeInstallerFiles) {
    const destination = path.join(stagingRoot, filename);
    await fs.copyFile(path.join(nativeInstallerRoot, filename), destination);
    if (filename.endsWith(".sh") && process.platform !== "win32") {
      await fs.chmod(destination, 0o755);
    }
  }
  const nodeLegalRoot = path.join(stagingRoot, "licenses", "node");
  await fs.mkdir(nodeLegalRoot, { recursive: true });
  for (const legalFile of resolvedNodeRuntime.legalFiles) {
    await fs.copyFile(legalFile.sourcePath, path.join(nodeLegalRoot, legalFile.filename));
  }
  await fs.copyFile(NODE_RUNTIME_LOCK_PATH, path.join(nodeLegalRoot, "NODE_RUNTIME.lock.json"));
  await fs.writeFile(path.join(stagingRoot, "THIRD_PARTY_NOTICES.txt"), [
    "Third-Party Notices",
    "",
    "This portable distribution bundles Node.js " + lockedVersion + ".",
    "The runtime version, official archive checksum, signed checksum manifest,",
    "OpenPGP signer fingerprint, and pinned Node.js release-key revision are",
    "recorded in licenses/node/NODE_RUNTIME.lock.json.",
    "The exact Node.js license and any notice files present in the selected",
    "Node.js distribution are preserved under licenses/node/.",
    ""
  ].join("\n"));

  if (windowsBundle) {
    await writeExecutable(path.join(stagingRoot, "meshrix-mcp.ps1"), [
      "$ErrorActionPreference = 'Stop'",
      "$DIR = Split-Path -Parent $MyInvocation.MyCommand.Path",
      "$env:MESHRIX_MCP_CONNECTOR_COMMAND = Join-Path $DIR 'meshrix-mcp.ps1'",
      `& (Join-Path $DIR 'runtime\\${runtimeExecutableName}') (Join-Path $DIR 'app\\bin\\meshrix-mcp.mjs') @args`,
      "exit $LASTEXITCODE",
      ""
    ].join("\r\n"));
  } else {
    await writeExecutable(path.join(stagingRoot, "meshrix-mcp"), [
      "#!/usr/bin/env sh",
      "set -e",
      "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
      "export MESHRIX_MCP_CONNECTOR_COMMAND=\"$DIR/meshrix-mcp\"",
      `exec "$DIR/runtime/${runtimeExecutableName}" "$DIR/app/bin/meshrix-mcp.mjs" "$@"`,
      ""
    ].join("\n"));
  }
  if (macosBundle) {
    await writeExecutable(path.join(stagingRoot, "install.command"), [
      "#!/usr/bin/env sh",
      "set -e",
      "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
      "\"$DIR/meshrix-mcp-install.sh\" install",
      "printf '\\nDone. Press Enter to close.'",
      "IFS= read -r _",
      ""
    ].join("\n"));
    await writeExecutable(path.join(stagingRoot, "uninstall.command"), [
      "#!/usr/bin/env sh",
      "set -e",
      "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
      "\"$DIR/meshrix-mcp-uninstall.sh\"",
      "printf '\\nDone. Press Enter to close.'",
      "IFS= read -r _",
      ""
    ].join("\n"));
    await writeExecutable(path.join(stagingRoot, "doctor.command"), [
      "#!/usr/bin/env sh",
      "set -e",
      "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
      "\"$DIR/meshrix-mcp-install.sh\" doctor",
      "printf '\\nDone. Press Enter to close.'",
      "IFS= read -r _",
      ""
    ].join("\n"));
  }
  const usageLines = windowsBundle
    ? [
        "Windows PowerShell install:",
        "  powershell -ExecutionPolicy Bypass -File .\\meshrix-mcp-install.ps1 -Command install -Target auto -Json",
        "",
        "Windows PowerShell uninstall:",
        `  powershell -ExecutionPolicy Bypass -File .\\meshrix-mcp-uninstall.ps1 -Target ${PRIORITY_INSTALL_TARGET} -Json`
      ]
    : [
        "Command-line hub registration:",
        "  ./meshrix-mcp-install.sh register",
        "",
        "Discover the local shared hub:",
        "  ./meshrix-mcp-install.sh discover-local --json",
        "",
        "Connect clients interactively:",
        "  ./meshrix-mcp-install.sh install",
        "",
        "Connect every detected client from a script:",
        "  ./meshrix-mcp-install.sh install --target auto --json",
        "",
        "Connect a known client from a script:",
        "  ./meshrix-mcp-install.sh install --target <client> --json",
        "",
        "Connect the priority agent clients from a script:",
        `  ./meshrix-mcp-install.sh install --target ${PRIORITY_INSTALL_TARGET} --json`,
        "",
        "Use --token-stdin only when installing with a pre-issued custom grant token:",
        "  printf '%s\\n' '<issued-token>' | ./meshrix-mcp-install.sh install --target auto --token-stdin --json",
        "",
        "Uninstall:",
        "  ./meshrix-mcp-uninstall.sh",
        "",
        "Uninstall priority clients from a script:",
        `  ./meshrix-mcp-uninstall.sh --target ${PRIORITY_INSTALL_TARGET}`
      ];
  await fs.writeFile(path.join(stagingRoot, "README.txt"), [
    "Meshrix MCP Connector Portable Package",
    "",
    "This package includes its own Node.js runtime. The target machine does not need Node.js, npm, npx, or a package manager.",
    "",
    "Licenses:",
    "  Meshrix: LICENSE",
    "  Node.js and bundled Node.js notices: licenses/node/",
    "  Third-party notice index: THIRD_PARTY_NOTICES.txt",
    "",
    ...usageLines,
    "",
    "The connector scans local Meshrix candidates and verifies the MCP identity signature before using a URL.",
    ...(macosBundle ? [
      "",
      "macOS double-click flow:",
      "  Open install.command, choose one or more clients. The connector requests a local Meshrix grant automatically."
    ] : []),
    "",
    `Platform: ${platform}`,
    `Connector: ${packageJson.name}@${packageJson.version}`,
    `Bundled Node: ${lockedVersion}`,
    ""
  ].join("\n"));

  await createReproduciblePortableArchives({
    stagingRoot,
    outputDir,
    archivePath,
    zipArchivePath
  });
  const stat = await fs.stat(archivePath);
  let zipSha256 = null;
  let zipSizeBytes = null;
  if (zipArchivePath) {
    const zipStat = await fs.stat(zipArchivePath);
    zipSha256 = await sha256(zipArchivePath);
    zipSizeBytes = zipStat.size;
  }
  const result = {
    platform,
    archiveName,
    archivePath,
    sha256: await sha256(archivePath),
    sizeBytes: stat.size,
    zipArchiveName,
    zipArchivePath,
    zipSha256,
    zipSizeBytes,
    rootName,
    executable: windowsBundle ? "meshrix-mcp.ps1" : unixExecutableName("meshrix-mcp"),
    includesNodeRuntime: true,
    bundledNodeVersion: lockedVersion,
    projectLicensePath: "LICENSE",
    connectorLicensePath: "app/LICENSE",
    thirdPartyNoticesPath: "THIRD_PARTY_NOTICES.txt",
    nodeRuntimeLockPath: "licenses/node/NODE_RUNTIME.lock.json",
    nodeLegalFiles: resolvedNodeRuntime.legalFiles.map((file) =>
      "licenses/node/" + file.filename
    )
  };
  await fs.rm(stagingRoot, { recursive: true, force: true });
  return result;
}
