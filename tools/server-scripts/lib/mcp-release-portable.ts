import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as openpgp from "openpgp";
import { ServerConfig } from "#meshrix/server-config";
import { MCP_CLIENT_TARGETS } from "../../../packages/protocols/mcp/adapter/mcp-release-targets.ts";
import {
  connectorRoot,
  MCP_PORTABLE_ASSET_PREFIX,
  PRIORITY_INSTALL_TARGET,
  projectRoot,
  readJson,
  run,
  sha256
} from "./mcp-release-common.ts";
import { createReproduciblePortableArchives } from "./mcp-release-reproducible-archives.ts";
import { resolveReleaseWorkspaceDirectories } from "./release-metadata.ts";
import { listFilesRecursively } from "./release-archive-inspection.ts";

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

export async function loadPortableUndiciDependency(rootPackageJson: any = null) : Promise<any> {
  const packageJson: any = rootPackageJson || await readJson(path.join(projectRoot, "package.json"));
  const packageLock: any = await readJson(path.join(projectRoot, "package-lock.json"));
  const installedRoot: any = path.join(projectRoot, "node_modules", "undici");
  const installedPackage: any = await readJson(path.join(installedRoot, "package.json"));
  const rootManifestSpec: any = packageJson.dependencies?.undici;
  const lockRootSpec: any = packageLock.packages?.[""]?.dependencies?.undici;
  const lockEntry: any = packageLock.packages?.["node_modules/undici"];
  if (
    typeof rootManifestSpec !== "string"
    || rootManifestSpec !== lockRootSpec
    || installedPackage.name !== "undici"
    || installedPackage.version !== lockEntry?.version
    || !/^sha512-[A-Za-z0-9+/]+=*$/u.test(String(lockEntry?.integrity || ""))
    || Object.keys(installedPackage.dependencies || {}).length > 0
    || Object.keys(installedPackage.optionalDependencies || {}).length > 0
  ) {
    throw new Error("portable_undici_dependency_not_lock_backed");
  }
  const packageFiles: any[] = await listFilesRecursively(installedRoot);
  const files: any[] = packageFiles.filter((file?: any) : any => (
    file === "LICENSE"
    || file === "index.js"
    || file === "index-fetch.js"
    || file === "lib/web/fetch/LICENSE"
    || (file.startsWith("lib/") && file.endsWith(".js"))
  ));
  if (!files.includes("LICENSE") || !files.includes("index.js") || !files.includes("index-fetch.js")) {
    throw new Error("portable_undici_runtime_or_license_missing");
  }
  return {
    sourceRoot: installedRoot,
    packageJson: installedPackage,
    portablePackageJson: {
      name: installedPackage.name,
      version: installedPackage.version,
      main: "index.js"
    },
    files
  };
}

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

function strictChildPath(parentPath?: any, candidatePath?: any) : boolean {
  const relative: any = path.relative(parentPath, candidatePath);
  return Boolean(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function declaredPortablePackageFiles(manifest?: any) : any[] {
  if (!Array.isArray(manifest?.files) || manifest.files.length === 0) {
    throw new Error("portable_adapter_file_manifest_missing");
  }
  const files: any[] = [...new Set<any>(manifest.files)];
  if (files.length !== manifest.files.length || files.some((relativeFile?: any) : any => (
    typeof relativeFile !== "string"
    || !relativeFile
    || relativeFile.includes("\\")
    || path.posix.isAbsolute(relativeFile)
    || path.posix.normalize(relativeFile) !== relativeFile
    || relativeFile.split("/").some((part?: any) : any => !part || part === "." || part === "..")
    || /[*?{}[\]]/u.test(relativeFile)
  ))) {
    throw new Error("portable_adapter_file_manifest_invalid");
  }
  return files.sort((left?: any, right?: any) : any => left.localeCompare(right));
}

async function loadPortableClientAdapterClosure(rootPackageJson?: any) : Promise<any> {
  const workspaceDirectories: any[] = await resolveReleaseWorkspaceDirectories({
    rootDir: projectRoot,
    workspaces: rootPackageJson.workspaces
  });
  const workspacePackages: any = new Map<any, any>();
  for (const directory of workspaceDirectories) {
    const packageJsonPath: any = path.join(projectRoot, directory, "package.json");
    const manifest: any = await readJson(packageJsonPath);
    if (typeof manifest.name !== "string" || workspacePackages.has(manifest.name)) {
      throw new Error("portable_workspace_package_identity_invalid");
    }
    workspacePackages.set(manifest.name, {
      directory,
      packageJsonPath,
      manifest
    });
  }

  const bundledNames: any = new Set<any>(
    rootPackageJson.bundleDependencies || rootPackageJson.bundledDependencies || []
  );
  const componentPackages: any = new Map<any, any>();
  const pendingPackages: any[] = [];
  const rootDependencies: any = {
    ...(rootPackageJson.dependencies || {}),
    ...(rootPackageJson.optionalDependencies || {})
  };

  function requirePrivateBundle(packageName?: any, expectedVersion?: any) : any {
    const workspacePackage: any = workspacePackages.get(packageName);
    if (!workspacePackage || workspacePackage.manifest.private !== true) {
      throw new Error("portable_adapter_workspace_package_not_private");
    }
    if (
      !bundledNames.has(packageName)
      || rootDependencies[packageName] !== workspacePackage.manifest.version
      || (expectedVersion && expectedVersion !== workspacePackage.manifest.version)
    ) {
      throw new Error("portable_adapter_root_bundle_identity_mismatch");
    }
    if (workspacePackage.manifest.license !== rootPackageJson.license) {
      throw new Error("portable_adapter_license_mismatch");
    }
    if (!componentPackages.has(packageName)) {
      const packageFiles: any[] = declaredPortablePackageFiles(workspacePackage.manifest);
      componentPackages.set(packageName, {
        ...workspacePackage,
        files: packageFiles
      });
      pendingPackages.push(packageName);
    }
    return workspacePackage.manifest;
  }

  for (const target of MCP_CLIENT_TARGETS) {
    const adapter: any = target.adapter;
    if (!adapter || typeof adapter.packageName !== "string" || typeof adapter.entrypoint !== "string") {
      throw new Error("portable_adapter_target_catalog_invalid");
    }
    const manifest: any = requirePrivateBundle(adapter.packageName, adapter.version);
    if (!manifest.files.includes(adapter.entrypoint)) {
      throw new Error("portable_adapter_entrypoint_not_declared");
    }
  }

  for (let cursor = 0; cursor < pendingPackages.length; cursor += 1) {
    const packageName: any = pendingPackages[cursor];
    const manifest: any = componentPackages.get(packageName).manifest;
    const unsupportedDependencies: any[] = [
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.optionalDependencies || {})
    ];
    if (unsupportedDependencies.length > 0) {
      throw new Error("portable_adapter_external_runtime_dependency_requires_locked_closure");
    }
    for (const [peerName, peerVersion] of Object.entries(manifest.peerDependencies || {}) as [string, any][]) {
      if (manifest.peerDependenciesMeta?.[peerName]?.optional === true) continue;
      const peerManifest: any = requirePrivateBundle(peerName, peerVersion);
      if (!peerManifest) throw new Error("portable_adapter_required_peer_unavailable");
    }
  }

  const packageNames: any[] = [...componentPackages.keys()].sort((left?: any, right?: any) : any => left.localeCompare(right));
  const dependencies: Record<string, any> = {};
  for (const packageName of packageNames) {
    dependencies[packageName] = componentPackages.get(packageName).manifest.version;
  }
  return {
    packages: packageNames.map((packageName?: any) : any => componentPackages.get(packageName)),
    dependencies
  };
}

async function copyPortableClientAdapterClosure({ appRoot, closure }: Record<string, any> = {}) : Promise<any> {
  const nodeModulesRoot: any = path.join(appRoot, "node_modules");
  for (const workspacePackage of closure.packages) {
    const sourceRoot: any = path.join(projectRoot, workspacePackage.directory);
    const sourceRootReal: any = await fs.realpath(sourceRoot);
    const rootStat: any = await fs.lstat(sourceRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("portable_adapter_workspace_source_invalid");
    }
    const packageDestination: any = path.join(nodeModulesRoot, ...workspacePackage.manifest.name.split("/"));
    await fs.mkdir(packageDestination, { recursive: true });
    await fs.copyFile(workspacePackage.packageJsonPath, path.join(packageDestination, "package.json"));
    for (const relativeFile of workspacePackage.files) {
      const sourceFile: any = path.join(sourceRoot, ...relativeFile.split("/"));
      const sourceStat: any = await fs.lstat(sourceFile).catch(() : any => null);
      const sourceReal: any = await fs.realpath(sourceFile).catch(() : any => "");
      if (
        !sourceStat?.isFile()
        || sourceStat.isSymbolicLink()
        || !strictChildPath(sourceRootReal, sourceReal)
      ) {
        throw new Error("portable_adapter_declared_file_unavailable");
      }
      const destinationFile: any = path.join(packageDestination, ...relativeFile.split("/"));
      await fs.mkdir(path.dirname(destinationFile), { recursive: true });
      await fs.copyFile(sourceFile, destinationFile);
    }
  }
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
  const rootName: any = `${MCP_PORTABLE_ASSET_PREFIX}-${packageJson.version}-${platform}`;
  const stagingRoot: any = path.join(outputDir, rootName);
  const appRoot: any = path.join(stagingRoot, "app");
  const runtimeRoot: any = path.join(stagingRoot, "runtime");
  const runtimeExecutableName: any = platform.startsWith("windows") ? "node.exe" : "node";
  const runtimePath: any = path.join(runtimeRoot, runtimeExecutableName);
  const undiciDependency: any = await loadPortableUndiciDependency(packageJson);
  const adapterClosure: any = await loadPortableClientAdapterClosure(packageJson);
  const portableUndiciRoot: any = path.join(appRoot, "node_modules", "undici");
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
    private: true,
    name: packageJson.name,
    version: packageJson.version,
    type: "module",
    dependencies: Object.fromEntries(Object.entries({
      undici: undiciDependency.packageJson.version,
      ...adapterClosure.dependencies
    }).sort(([left], [right]) : any => String(left).localeCompare(String(right)))),
    imports: {
      "#meshrix/foundation/environment-compatibility/index": "./vendor/foundation/environment-compatibility/index.ts",
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
  await copyPortableClientAdapterClosure({ appRoot, closure: adapterClosure });
  await fs.copyFile(path.join(connectorRoot, "README.md"), path.join(appRoot, "README.md"));
  await fs.copyFile(path.join(connectorRoot, "LICENSE"), path.join(appRoot, "LICENSE"));
  for (const relativeFile of undiciDependency.files) {
    const sourceFile: any = path.join(undiciDependency.sourceRoot, relativeFile);
    const destinationFile: any = path.join(portableUndiciRoot, relativeFile);
    await fs.mkdir(path.dirname(destinationFile), { recursive: true });
    await fs.copyFile(sourceFile, destinationFile);
  }
  await fs.writeFile(
    path.join(portableUndiciRoot, "package.json"),
    `${JSON.stringify(undiciDependency.portablePackageJson, null, 2)}\n`,
    "utf8"
  );
  await fs.copyFile(
    path.join(projectRoot, "packages", "protocols", "mcp", "adapter", "mcp-release-targets.ts"),
    path.join(appRoot, "mcp-release-targets.ts")
  );
  await fs.mkdir(path.join(appRoot, "gateway-installer"), { recursive: true });
  await fs.copyFile(
    path.join(connectorRoot, "mcp-release-targets.ts"),
    path.join(appRoot, "gateway-installer", "mcp-release-targets.ts")
  );
  await fs.copyFile(
    path.join(projectRoot, "packages", "protocols", "mcp", "adapter", "http-mcp-adapter-constants.ts"),
    path.join(appRoot, "http-mcp-adapter-constants.ts")
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
  await fs.cp(
    path.join(projectRoot, "packages", "foundation", "src", "environment-compatibility"),
    path.join(appRoot, "vendor", "foundation", "environment-compatibility"),
    { recursive: true }
  );
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
    path.join(projectRoot, "packages", "protocols", "mcp", "adapter", "http-mcp-adapter-client-wire.ts"),
    path.join(portableProtocolsRoot, "mcp", "adapter", "http-mcp-adapter-client-wire.ts")
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
  const nodeLegalRoot: any = path.join(stagingRoot, "licenses", "node");
  await fs.mkdir(nodeLegalRoot, { recursive: true });
  for (const legalFile of resolvedNodeRuntime.legalFiles) {
    await fs.copyFile(legalFile.sourcePath, path.join(nodeLegalRoot, legalFile.filename));
  }
  await fs.copyFile(NODE_RUNTIME_LOCK_PATH, path.join(nodeLegalRoot, "NODE_RUNTIME.lock.json"));
  await fs.writeFile(path.join(stagingRoot, "THIRD_PARTY_NOTICES.txt"), [
    "Third-Party Notices",
    "",
    `Undici ${undiciDependency.packageJson.version} runtime is bundled under app/node_modules/undici/ and is licensed under the MIT License.`,
    "The package license and fetch implementation notice are preserved at app/node_modules/undici/LICENSE and app/node_modules/undici/lib/web/fetch/LICENSE.",
    "",
    "First-party MCP adapter components and client-adapter-kit are included under app/node_modules/@meshrix/.",
    "Their declared package files and manifests are covered by the Apache-2.0 project license at LICENSE and app/LICENSE.",
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
  const usageLines: any = windowsBundle
    ? [
        "Register the local shared hub:",
        "  powershell -ExecutionPolicy Bypass -File .\\meshrix-mcp.ps1 register",
        "",
        "Connect detected clients:",
        "  powershell -ExecutionPolicy Bypass -File .\\meshrix-mcp.ps1 install --target auto --json",
        "",
        "Uninstall a client:",
        "  powershell -ExecutionPolicy Bypass -File .\\meshrix-mcp.ps1 uninstall --target codex --json"
      ]
    : [
        "Command-line hub registration:",
        "  ./meshrix-mcp register",
        "",
        "Discover the local shared hub:",
        "  ./meshrix-mcp discover-local --json",
        "",
        "Connect clients interactively:",
        "  ./meshrix-mcp install",
        "",
        "Connect every detected client from a script:",
        "  ./meshrix-mcp install --target auto --json",
        "",
        "Connect a known client from a script:",
        "  ./meshrix-mcp install --target codex --json",
        "",
        "Connect the priority agent clients from a script:",
        `  ./meshrix-mcp install --target ${PRIORITY_INSTALL_TARGET} --json`,
        "",
        "Use --token-stdin only when installing with a pre-issued custom grant token:",
        "  printf '%s\\n' '<issued-token>' | ./meshrix-mcp install --target auto --token-stdin --json",
        "",
        "Uninstall:",
        "  ./meshrix-mcp uninstall --target codex --json",
        "",
        "Uninstall priority clients from a script:",
        `  ./meshrix-mcp uninstall --target ${PRIORITY_INSTALL_TARGET} --json`
      ];
  await fs.writeFile(path.join(stagingRoot, "README.txt"), [
    "Meshrix.js MCP Connector Portable Package",
    "",
    "This package includes its own Node.js runtime. The target machine does not need Node.js, npm, npx, or a package manager.",
    "",
    "Licenses:",
    "  Meshrix.js: LICENSE",
    `  Undici ${undiciDependency.packageJson.version} (MIT): app/node_modules/undici/LICENSE and app/node_modules/undici/lib/web/fetch/LICENSE`,
    "  Node.js and bundled Node.js notices: licenses/node/",
    "  Third-party notice index: THIRD_PARTY_NOTICES.txt",
    "",
    ...usageLines,
    "",
    "The connector scans local Meshrix.js candidates and verifies the MCP identity signature before using a URL.",
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
    undiciVersion: undiciDependency.packageJson.version,
    undiciLicensePaths: [
      "app/node_modules/undici/LICENSE",
      "app/node_modules/undici/lib/web/fetch/LICENSE"
    ],
    clientAdapterPackages: adapterClosure.packages.map((workspacePackage?: any) : any => workspacePackage.manifest.name),
    nodeRuntimeLockPath: "licenses/node/NODE_RUNTIME.lock.json",
    nodeLegalFiles: resolvedNodeRuntime.legalFiles.map((file?: any) : any =>
      "licenses/node/" + file.filename
    )
  };
  await fs.rm(stagingRoot, { recursive: true, force: true });
  return result;
}
