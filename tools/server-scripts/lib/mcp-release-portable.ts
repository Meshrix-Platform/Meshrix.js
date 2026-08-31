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
} from "./mcp-release-common.ts";
import { createReproduciblePortableArchives } from "./mcp-release-reproducible-archives.ts";

const NODE_LEGAL_FILE_NAMES: readonly any[] = Object.freeze([
  "LICENSE",
  "NOTICE",
  "NOTICE.txt",
  "THIRD_PARTY_NOTICES",
  "THIRD_PARTY_NOTICES.txt",
  "THIRD_PARTY_LICENSES",
  "THIRD_PARTY_LICENSES.txt"
]);
const NODE_RUNTIME_LOCK_PATH: any = path.join(projectRoot, "tools", "release", "node-runtime.lock.json");
const NODE_RUNTIME_LOCK_SCHEMA: any = "v1:node-runtime-release-lock";
const SHA256_PATTERN: any = /^[a-f0-9]{64}$/u;
const OPENPGP_FINGERPRINT_PATTERN: any = /^[A-F0-9]{40}$/u;
const MAX_NODE_METADATA_BYTES: any = 1024 * 1024;
const MAX_NODE_RUNTIME_ARCHIVE_BYTES: any = 128 * 1024 * 1024;
const PINNED_DOWNLOAD_TIMEOUT_MS: any = 300000;
const PINNED_DOWNLOAD_RETRY_DELAYS_MS: readonly any[] = Object.freeze([250, 750]);
const PINNED_DOWNLOAD_RETRY_HTTP_STATUSES: ReadonlySet<number> = new Set<any>([
  408,
  425,
  429,
  500,
  502,
  503,
  504
]);
let nodeRuntimeLockPromise: any = null;
const activePinnedDownloads: any = new Map<any, any>();

function unixExecutableName(name?: any) : any {
  return name;
}

async function writeExecutable(filePath?: any, content?: any) : Promise<any> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o755);
  }
}

export function resolveNodeRuntimeCacheDirectory({
  environment = process.env,
  dataDir
}: Record<string, any> = {}) : any {
  const override: any = String(environment?.MESHRIX_MCP_NODE_RUNTIME_CACHE_DIR || "").trim();
  if (override) {
    return path.resolve(override);
  }

  const normalizedDataDir: any = String(
    dataDir === undefined ? ServerConfig.getDataDir() : dataDir || ""
  ).trim();
  if (!normalizedDataDir) {
    throw new Error("node_runtime_cache_data_directory_missing");
  }
  return path.join(path.resolve(normalizedDataDir), "cache", "mcp-node-runtime");
}

function sha256Buffer(value?: any) : any {
  return createHash("sha256").update(value).digest("hex");
}

async function fileMatchesSha256(filePath?: any, expectedSha256?: any, expectedSizeBytes?: any) : Promise<any> {
  try {
    const stat: any = await fs.stat(filePath);
    if (!stat.isFile() || stat.size !== expectedSizeBytes) {
      return false;
    }
    return await sha256(filePath) === expectedSha256;
  } catch {
    return false;
  }
}

function releaseBundlePlatform(target?: any) : any {
  if (target === "linux-x64") {
    return "linux-x86_64";
  }
  return target;
}

function normalizeNodeVersion(version?: any) : any {
  return String(version).trim().startsWith("v") ? String(version).trim() : `v${String(version).trim()}`;
}

function hasExactKeys(value?: any, keys: readonly string[] = []) : boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function validateNodeRuntimeLock(lock?: any) : any {
  if (!hasExactKeys(lock, [
    "schemaVersion",
    "version",
    "distributionBaseUrl",
    "checksumsFile",
    "checksumsSha256",
    "checksumsSizeBytes",
    "signatureFile",
    "signatureSha256",
    "signatureSizeBytes",
    "signer",
    "targets",
  ]) || lock?.schemaVersion !== NODE_RUNTIME_LOCK_SCHEMA || !/^v\d+\.\d+\.\d+$/u.test(lock?.version || "")) {
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
  if (!hasExactKeys(lock.signer, [
    "fingerprint",
    "releaseKeysCommit",
    "publicKeyUrl",
    "publicKeySha256",
    "publicKeySizeBytes",
  ]) || !OPENPGP_FINGERPRINT_PATTERN.test(String(lock.signer?.fingerprint || ""))) {
    throw new Error("node_runtime_lock_invalid_signer");
  }
  if (!/^[a-f0-9]{40}$/u.test(String(lock.signer?.releaseKeysCommit || ""))) {
    throw new Error("node_runtime_lock_invalid_release_keys_commit");
  }
  let keyUrl: any;
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
  const targets: any = (Object.entries(lock.targets || {}) as [string, any][]);
  if (targets.length === 0) {
    throw new Error("node_runtime_lock_targets_missing");
  }
  for (const [target, descriptor] of targets) {
    if (!/^(?:macos|linux|windows)-(?:x64|arm64)$/u.test(target) ||
        !hasExactKeys(descriptor, ["filename", "sha256", "sizeBytes"]) ||
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

export async function loadNodeRuntimeLock() : Promise<any> {
  nodeRuntimeLockPromise ||= readJson(NODE_RUNTIME_LOCK_PATH).then(validateNodeRuntimeLock);
  return nodeRuntimeLockPromise;
}

export async function resolveBundledNodeVersion(explicitVersion: any = "") : Promise<any> {
  const lock: any = await loadNodeRuntimeLock();
  if (typeof explicitVersion === "string" && explicitVersion.trim() &&
      normalizeNodeVersion(explicitVersion) !== lock.version) {
    throw new Error("node_runtime_version_not_locked");
  }
  return lock.version;
}

async function collectNodeLegalFiles(distributionRoot?: any) : Promise<any> {
  const legalFiles: any[] = [];
  for (const filename of NODE_LEGAL_FILE_NAMES) {
    const sourcePath: any = path.join(distributionRoot, filename);
    const stat: any = await fs.stat(sourcePath).catch(() : any => null);
    if (stat?.isFile()) {
      legalFiles.push({ filename, sourcePath });
    }
  }
  if (!legalFiles.some((file?: any) : any => file.filename === "LICENSE")) {
    throw new Error("node_runtime_license_missing");
  }
  return legalFiles;
}

async function normalizeNodeRuntimeSource(runtimeSource: Record<string, any> = {}) : Promise<any> {
  const executablePath: any = path.resolve(String(runtimeSource.executablePath || ""));
  const distributionRoot: any = path.resolve(String(runtimeSource.distributionRoot || ""));
  const executableStat: any = await fs.stat(executablePath).catch(() : any => null);
  const distributionStat: any = await fs.stat(distributionRoot).catch(() : any => null);
  if (!executableStat?.isFile() || !distributionStat?.isDirectory()) {
    throw new Error("node_runtime_source_invalid");
  }
  return {
    executablePath,
    distributionRoot,
    legalFiles: await collectNodeLegalFiles(distributionRoot)
  };
}

function normalizePinnedDownloadContract(url?: any, destination?: any, expectedSha256?: any, expectedSizeBytes?: any) : any {
  let parsedUrl: any;
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

async function downloadPinnedFileOnce(contract?: any, fetchImpl?: any) : Promise<any> {
  const { url, destination, expectedSha256, expectedSizeBytes } = contract;
  if (await fileMatchesSha256(destination, expectedSha256, expectedSizeBytes)) {
    return destination;
  }
  await fs.rm(destination, { force: true });
  const temporary: any = `${destination}.${process.pid}.${randomUUID()}.download`;
  try {
    const response: any = await fetchImpl(url, {
      redirect: "error",
      headers: { "Accept-Encoding": "identity" },
      signal: AbortSignal.timeout(PINNED_DOWNLOAD_TIMEOUT_MS)
    });
    if (response.status !== 200 || !response.body || response.redirected === true) {
      const error: Error & Record<string, any> = new Error("node_runtime_pinned_download_failed");
      if (PINNED_DOWNLOAD_RETRY_HTTP_STATUSES.has(response.status)) {
        error.code = "NODE_RUNTIME_TRANSIENT_HTTP_STATUS";
      }
      throw error;
    }
    const contentLength: any = response.headers?.get?.("content-length");
    if (contentLength !== null && contentLength !== undefined) {
      if (!/^\d+$/u.test(contentLength) || Number(contentLength) !== expectedSizeBytes) {
        throw new Error("node_runtime_download_size_mismatch");
      }
    }

    let receivedBytes: any = 0;
    const byteLimit: any = new Transform({
      transform(chunk?: any, _encoding?: any, callback?: any) : any {
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
    } catch (error: any) {
      if (error?.code !== "EEXIST" || !await fileMatchesSha256(
        destination,
        expectedSha256,
        expectedSizeBytes
      )) {
        throw error;
      }
      await fs.rm(temporary, { force: true });
    }
  } catch (error: any) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return destination;
}

function isRetryablePinnedDownloadError(error?: any) : any {
  const code: any = String(error?.code || "").toUpperCase();
  if ([
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    "NODE_RUNTIME_TRANSIENT_HTTP_STATUS"
  ].includes(code)) {
    return true;
  }
  return (
    ["AbortError", "TimeoutError", "TypeError"].includes(String(error?.name || ""))
    && /fetch failed|network|timeout|aborted/iu.test(String(error?.message || ""))
  );
}

export async function downloadPinnedFile(
  url?: any,
  destination?: any,
  expectedSha256?: any,
  expectedSizeBytes?: any,
  { fetchImpl = globalThis.fetch }: Record<string, any> = {}
) : Promise<any> {
  const contract: any = normalizePinnedDownloadContract(
    url,
    destination,
    expectedSha256,
    expectedSizeBytes
  );
  const active: any = activePinnedDownloads.get(contract.destination);
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
  const promise: any = (async () : Promise<any> => {
    for (let attempt: any = 0; ; attempt += 1) {
      try {
        return await downloadPinnedFileOnce(contract, fetchImpl);
      } catch (error: any) {
        const delayMs: any = PINNED_DOWNLOAD_RETRY_DELAYS_MS[attempt];
        if (!isRetryablePinnedDownloadError(error) || delayMs === undefined) {
          throw error;
        }
        await new Promise((resolve?: any) : any => setTimeout(resolve, delayMs));
      }
    }
  })()
    .finally(() : any => activePinnedDownloads.delete(contract.destination));
  activePinnedDownloads.set(contract.destination, { ...contract, promise });
  return promise;
}

function parseSignedNodeChecksums(text?: any) : any {
  const checksums: any = new Map<any, any>();
  for (const line of String(text || "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match: any = line.match(/^([a-f0-9]{64})\s+([^\s\u0000-\u001f]+)$/u);
    const filename: any = String(match?.[2] || "");
    if (!match || filename.startsWith("/") || filename.split("/").includes("..") || checksums.has(filename)) {
      throw new Error("node_runtime_signed_checksums_invalid");
    }
    checksums.set(filename, match[1]);
  }
  return checksums;
}

export function verifyNodeRuntimeSignedChecksums({ lock, checksumsText }: Record<string, any> = {}) : any {
  const validatedLock: any = validateNodeRuntimeLock(lock);
  if (sha256Buffer(Buffer.from(String(checksumsText || ""), "utf8")) !== validatedLock.checksumsSha256) {
    throw new Error("node_runtime_checksums_digest_mismatch");
  }
  const signedChecksums: any = parseSignedNodeChecksums(checksumsText);
  for (const descriptor of (Object.values(validatedLock.targets) as any[])) {
    if (signedChecksums.get(descriptor.filename) !== descriptor.sha256) {
      throw new Error("node_runtime_target_not_authenticated_by_signed_checksums");
    }
  }
  return true;
}

export async function verifyNodeReleaseSignature({ lock, checksumsPath, signaturePath, keyPath }: Record<string, any>) : Promise<any> {
  try {
    const [armoredKey, checksums, detachedSignature] = await Promise.all([
      fs.readFile(keyPath, "utf8"),
      fs.readFile(checksumsPath),
      fs.readFile(signaturePath)
    ]);
    const verificationKey: any = await openpgp.readKey({ armoredKey });
    if (String(verificationKey.getFingerprint() || "").toUpperCase() !== lock.signer.fingerprint) {
      throw new Error("node_runtime_signature_signer_mismatch");
    }
    const message: any = await openpgp.createMessage({ binary: new Uint8Array(checksums) });
    const signature: any = await openpgp.readSignature({
      binarySignature: new Uint8Array(detachedSignature)
    });
    const verification: any = await openpgp.verify({
      message,
      signature,
      verificationKeys: verificationKey
    });
    if (verification.signatures.length !== 1) {
      throw new Error("node_runtime_signature_invalid");
    }
    await verification.signatures[0].verified;
  } catch (error: any) {
    if (String(error?.message || "").startsWith("node_runtime_signature_")) {
      throw error;
    }
    throw new Error("node_runtime_signature_invalid");
  }
}

async function authenticateNodeRelease(lock?: any, outputDir?: any) : Promise<any> {
  const cacheDir: any = resolveNodeRuntimeCacheDirectory();
  await fs.mkdir(cacheDir, { recursive: true });
  const releaseBaseUrl: any = `${lock.distributionBaseUrl}/${lock.version}`;
  const checksumsPath: any = await downloadPinnedFile(
    `${releaseBaseUrl}/${lock.checksumsFile}`,
    path.join(cacheDir, `${lock.version}-${lock.checksumsFile}`),
    lock.checksumsSha256,
    lock.checksumsSizeBytes
  );
  const signaturePath: any = await downloadPinnedFile(
    `${releaseBaseUrl}/${lock.signatureFile}`,
    path.join(cacheDir, `${lock.version}-${lock.signatureFile}`),
    lock.signatureSha256,
    lock.signatureSizeBytes
  );
  const keyPath: any = await downloadPinnedFile(
    lock.signer.publicKeyUrl,
    path.join(cacheDir, `${lock.signer.fingerprint}.asc`),
    lock.signer.publicKeySha256,
    lock.signer.publicKeySizeBytes
  );
  const checksumsText: any = await fs.readFile(checksumsPath, "utf8");
  verifyNodeRuntimeSignedChecksums({ lock, checksumsText });
  await verifyNodeReleaseSignature({ lock, checksumsPath, signaturePath, keyPath });
}

export async function verifyPinnedNodeRuntimeRelease({ outputDir }: Record<string, any>) : Promise<any> {
  const lock: any = await loadNodeRuntimeLock();
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

async function downloadNodeRuntime(version?: any, target?: any, outputDir?: any) : Promise<any> {
  const lock: any = await loadNodeRuntimeLock();
  if (normalizeNodeVersion(version) !== lock.version) {
    throw new Error("node_runtime_version_not_locked");
  }
  const descriptor: any = lock.targets[target];
  if (!descriptor) {
    throw new Error("node_runtime_target_not_locked");
  }
  await authenticateNodeRelease(lock, outputDir);
  const cacheDir: any = resolveNodeRuntimeCacheDirectory();
  const archivePath: any = await downloadPinnedFile(
    `${lock.distributionBaseUrl}/${lock.version}/${descriptor.filename}`,
    path.join(cacheDir, descriptor.filename),
    descriptor.sha256,
    descriptor.sizeBytes
  );

  const extractDir: any = path.join(outputDir, `extracted-${target}`);
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.mkdir(extractDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    await run("unzip", ["-q", archivePath, "-d", extractDir]);
    const nodeRoot: any = path.basename(descriptor.filename, ".zip");
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
}: Record<string, any>) : Promise<any> {
  const lockedVersion: any = await resolveBundledNodeVersion(bundledVersion);
  const runtimeLock: any = await loadNodeRuntimeLock();
  if (!runtimeLock.targets[target]) {
    throw new Error("node_runtime_target_not_locked");
  }
  const platform: any = releaseBundlePlatform(target);
  const windowsBundle: any = platform.startsWith("windows");
  const macosBundle: any = platform.startsWith("macos");
  const rootName: any = `${packageJson.name}-${packageJson.version}-${platform}`;
  const stagingRoot: any = path.join(outputDir, rootName);
  const appRoot: any = path.join(stagingRoot, "app");
  const runtimeRoot: any = path.join(stagingRoot, "runtime");
  const runtimeExecutableName: any = platform.startsWith("windows") ? "node.exe" : "node";
  const runtimePath: any = path.join(runtimeRoot, runtimeExecutableName);
  const generateZip: any = !platform.startsWith("linux");
  const archiveName: any = `${rootName}.tar.gz`;
  const archivePath: any = path.join(outputDir, archiveName);
  const zipArchiveName: any = generateZip ? `${rootName}.zip` : null;
  const zipArchivePath: any = zipArchiveName ? path.join(outputDir, zipArchiveName) : null;

  await fs.rm(stagingRoot, { recursive: true, force: true });
  await fs.rm(archivePath, { force: true });
  if (zipArchivePath) {
    await fs.rm(zipArchivePath, { force: true });
  }
  await fs.mkdir(path.join(appRoot, "bin"), { recursive: true });
  await fs.mkdir(runtimeRoot, { recursive: true });
  const resolvedNodeRuntime: any = nodeRuntime
    ? await normalizeNodeRuntimeSource(nodeRuntime)
    : await downloadNodeRuntime(lockedVersion, target, outputDir);
  await fs.copyFile(resolvedNodeRuntime.executablePath, runtimePath);
  await fs.chmod(runtimePath, 0o755);
  await fs.copyFile(path.join(projectRoot, "LICENSE"), path.join(stagingRoot, "LICENSE"));
  const portablePackageJson: Record<string, any> = {
    ...packageJson,
    imports: {
      "#meshrix/contracts/*": "./vendor/contracts/*.ts",
      "#meshrix/protocols/*": "./vendor/protocols/*.ts"
    }
  };
  await fs.writeFile(
    path.join(stagingRoot, "package.json"),
    `${JSON.stringify({
      private: true,
      type: "module",
      imports: {
        "#meshrix/contracts/*": "./app/vendor/contracts/*.ts",
        "#meshrix/protocols/*": "./app/vendor/protocols/*.ts"
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
    path.join(connectorRoot, "mcp-release-targets.ts"),
    path.join(appRoot, "mcp-release-targets.ts")
  );
  await fs.copyFile(
    path.join(connectorRoot, "mcp-identity.ts"),
    path.join(appRoot, "mcp-identity.ts")
  );
  await fs.copyFile(
    path.join(connectorRoot, "mcp-identity.ts"),
    path.join(stagingRoot, "mcp-identity.ts")
  );
  await fs.copyFile(
    path.join(connectorRoot, "bin", "meshrix-mcp.ts"),
    path.join(appRoot, "bin", "meshrix-mcp.ts")
  );
  await fs.cp(path.join(connectorRoot, "lib"), path.join(appRoot, "lib"), { recursive: true });
  const portableContractsRoot: any = path.join(appRoot, "vendor", "contracts");
  await fs.mkdir(portableContractsRoot, { recursive: true });
  await fs.copyFile(
    path.join(projectRoot, "packages", "contracts", "src", "mcp-catalog-delivery.ts"),
    path.join(portableContractsRoot, "mcp-catalog-delivery.ts")
  );
  const contractsSourceRoot: any = path.join(projectRoot, "packages", "contracts");
  const contractsPackage: any = await readJson(path.join(contractsSourceRoot, "package.json"));
  if (packageJson.dependencies?.[contractsPackage.name] !== contractsPackage.version) {
    throw new Error("portable_contracts_dependency_version_mismatch");
  }
  const portableCanonicalJsonPath: any = path.join(
    portableContractsRoot,
    "serialization",
    "canonical-json.ts"
  );
  await fs.mkdir(path.dirname(portableCanonicalJsonPath), { recursive: true });
  await fs.copyFile(
    path.join(contractsSourceRoot, "src", "serialization", "canonical-json.ts"),
    portableCanonicalJsonPath
  );
  await fs.copyFile(
    path.join(contractsSourceRoot, "src", "service-collaboration-contract.ts"),
    path.join(portableContractsRoot, "service-collaboration-contract.ts")
  );
  const portableProtocolsRoot: any = path.join(appRoot, "vendor", "protocols");
  await fs.mkdir(path.join(portableProtocolsRoot, "mcp", "adapter"), { recursive: true });
  await fs.copyFile(
    path.join(projectRoot, "packages", "protocols", "mcp", "adapter", "http-mcp-adapter-constants.ts"),
    path.join(portableProtocolsRoot, "mcp", "adapter", "http-mcp-adapter-constants.ts")
  );
  await fs.copyFile(
    path.join(projectRoot, "packages", "protocols", "mcp", "adapter", "mcp-release-targets.ts"),
    path.join(portableProtocolsRoot, "mcp", "adapter", "mcp-release-targets.ts")
  );
  await fs.mkdir(path.join(portableProtocolsRoot, "mcp", "adapter", "gateway-installer"), { recursive: true });
  await fs.copyFile(
    path.join(projectRoot, "packages", "protocols", "mcp", "adapter", "gateway-installer", "mcp-release-targets.ts"),
    path.join(portableProtocolsRoot, "mcp", "adapter", "gateway-installer", "mcp-release-targets.ts")
  );
  const nativeInstallerRoot: any = path.join(connectorRoot, "..", "native-installer");
  const nativeInstallerFiles: any = windowsBundle
    ? ["meshrix-mcp-install.ps1", "meshrix-mcp-uninstall.ps1"]
    : ["meshrix-mcp-install.sh", "meshrix-mcp-uninstall.sh"];
  for (const filename of nativeInstallerFiles) {
    const destination: any = path.join(stagingRoot, filename);
    await fs.copyFile(path.join(nativeInstallerRoot, filename), destination);
    if (filename.endsWith(".sh") && process.platform !== "win32") {
      await fs.chmod(destination, 0o755);
    }
  }
  const nodeLegalRoot: any = path.join(stagingRoot, "licenses", "node");
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
      `& (Join-Path $DIR 'runtime\\${runtimeExecutableName}') (Join-Path $DIR 'app\\bin\\meshrix-mcp.ts') @args`,
      "exit $LASTEXITCODE",
      ""
    ].join("\r\n"));
  } else {
    await writeExecutable(path.join(stagingRoot, "meshrix-mcp"), [
      "#!/usr/bin/env sh",
      "set -e",
      "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
      "export MESHRIX_MCP_CONNECTOR_COMMAND=\"$DIR/meshrix-mcp\"",
      `exec "$DIR/runtime/${runtimeExecutableName}" "$DIR/app/bin/meshrix-mcp.ts" "$@"`,
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
  const usageLines: any = windowsBundle
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
    "Meshrix.js MCP Connector Portable Package",
    "",
    "This package includes its own Node.js runtime. The target machine does not need Node.js, npm, npx, or a package manager.",
    "",
    "Licenses:",
    "  Meshrix.js: LICENSE",
    "  Node.js and bundled Node.js notices: licenses/node/",
    "  Third-party notice index: THIRD_PARTY_NOTICES.txt",
    "",
    ...usageLines,
    "",
    "The connector scans local Meshrix.js candidates and verifies the MCP identity signature before using a URL.",
    ...(macosBundle ? [
      "",
      "macOS double-click flow:",
      "  Open install.command, choose one or more clients. The connector requests a local Meshrix.js grant automatically."
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
  const stat: any = await fs.stat(archivePath);
  let zipSha256: any = null;
  let zipSizeBytes: any = null;
  if (zipArchivePath) {
    const zipStat: any = await fs.stat(zipArchivePath);
    zipSha256 = await sha256(zipArchivePath);
    zipSizeBytes = zipStat.size;
  }
  const result: Record<string, any> = {
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
    nodeLegalFiles: resolvedNodeRuntime.legalFiles.map((file?: any) : any =>
      "licenses/node/" + file.filename
    )
  };
  await fs.rm(stagingRoot, { recursive: true, force: true });
  return result;
}
