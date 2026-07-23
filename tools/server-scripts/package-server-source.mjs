#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EDITION,
  collectPackagePlan,
  resolveFeatureRuntime
} from "../../packages/server-runtime/src/composition/features/feature-manifest.mjs";
import { scanPublicArtifact } from "./lib/public-artifact-boundary.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE_PACKAGE_MANIFEST = "lico-source-package-manifest.json";
const SOURCE_PACKAGE_ARCHIVE_SUFFIX = ".tar.gz";
const SOURCE_PACKAGE_CHECKSUM_SUFFIX = ".sha256";
const SOURCE_PACKAGE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SOURCE_PACKAGE_VERSION_PATTERN = /^[0-9A-Za-z]+(?:[.+-][0-9A-Za-z]+)*$/u;

export const DEFAULT_SERVER_SOURCE_PACKAGE_OUTPUT_DIRECTORY = "build/packages";

export const SOURCE_PACKAGE_ROOTS = Object.freeze([
  "packages",
  "plugins",
  "apps/server",
  "apps/console",
  "content",
  "tools",
  "docs/README.md",
  "docs/RUNBOOK.md",
  "docs/COMPATIBILITY.md",
  "docs/ENTITY-CONFIG-LAYOUT.md",
  "docs/architecture-overview.svg",
  "docs/banner.svg",
  "docs/logo.svg",
  "docs/architecture",
  "docs/adrs",
  "docs/examples",
  "docs/functionality",
  "docs/protocols"
]);

export const ROOT_SOURCE_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "Dockerfile",
  "docker-compose.yml",
  ".dockerignore",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  "README.md",
  "README.zh-CN.md",
  "PRODUCT.md",
  "LICENSE",
  "CHANGELOG.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md"
]);

const EXCLUDED_PATH_SEGMENTS = new Set([
  ".git",
  ".cache",
  ".dart_tool",
  ".gradle",
  "node_modules",
  "build",
  "dist",
  "coverage",
  "downloads",
  ".next",
  ".nuxt",
  "__pycache__",
  "output",
  "outputs",
  "reports",
  "target",
  "test-results"
]);
export const INTERNAL_SOURCE_PACKAGE_EXCLUDED_PATHS = Object.freeze([
  "docs/plans",
  "docs/reports"
]);

export function createPackagingPlan(args = {}) {
  const edition = String(args.edition || DEFAULT_EDITION).trim() || DEFAULT_EDITION;
  return {
    target: args.target || "portable-source",
    profile: args.profile || "public",
    includeConsole: args.console !== false,
    features: Array.isArray(args.features) ? normalizeStringList(args.features) : ["core", "gateway"],
    edition,
    featureProfile: args.featureProfile && typeof args.featureProfile === "object" && !Array.isArray(args.featureProfile)
      ? args.featureProfile
      : {},
    enableFeatures: normalizeStringList(args.enableFeatures),
    disableFeatures: normalizeStringList(args.disableFeatures),
    featureSurface: String(args.featureSurface || "all").trim() || "all"
  };
}

function normalizeRelativePath(value = "") {
  return String(value || "").split(path.sep).join("/").replace(/^\.\//u, "");
}

function normalizeStringList(value = []) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))];
}

function packageRemovePathMatches(relativePath = "", removePath = "") {
  const normalized = normalizeRelativePath(relativePath);
  const remove = normalizeRelativePath(removePath);
  return Boolean(remove && (normalized === remove || normalized.startsWith(`${remove}/`)));
}

function isRemovedByPackagePlan(relativePath = "", packageRemovePaths = []) {
  return packageRemovePaths.some((removePath) => packageRemovePathMatches(relativePath, removePath));
}

function shouldSkipRelativePath(relativePath = "", packageRemovePaths = []) {
  const normalized = normalizeRelativePath(relativePath);
  if (isRemovedByPackagePlan(normalized, packageRemovePaths)) {
    return true;
  }
  if (INTERNAL_SOURCE_PACKAGE_EXCLUDED_PATHS.some((excludedPath) =>
    normalized === excludedPath || normalized.startsWith(`${excludedPath}/`)
  )) {
    return true;
  }
  return normalized.split("/").some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment));
}

function assertSafeSourceRelativePath(relativePath = "") {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split("/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("source_package_source_path_invalid");
  }
  return normalized;
}

function displayPath(filePath = "", repoRoot = REPO_ROOT, externalLabel = "[external-output]") {
  const absolutePath = path.resolve(filePath);
  const absoluteRepoRoot = path.resolve(repoRoot);
  if (absolutePath === absoluteRepoRoot) {
    return ".";
  }
  if (absolutePath.startsWith(absoluteRepoRoot + path.sep)) {
    return normalizeRelativePath(path.relative(absoluteRepoRoot, absolutePath));
  }
  return `${externalLabel}/${path.basename(absolutePath)}`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectSourceFiles(sourcePath, relativePath, packageRemovePaths = [], files = []) {
  if (shouldSkipRelativePath(relativePath, packageRemovePaths)) {
    return files;
  }
  const normalizedRelativePath = assertSafeSourceRelativePath(relativePath);
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) {
    return files;
  }
  if (stat.isDirectory()) {
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelativePath = normalizeRelativePath(path.join(relativePath, entry.name));
      await collectSourceFiles(
        path.join(sourcePath, entry.name),
        childRelativePath,
        packageRemovePaths,
        files
      );
    }
    return files;
  }
  if (stat.isFile()) {
    files.push({
      sourcePath,
      relativePath: normalizedRelativePath
    });
  }
  return files;
}

async function ignoredSourcePaths(repoRoot, relativePaths = []) {
  if (relativePaths.length === 0) {
    return new Set();
  }
  if (!await exists(path.join(repoRoot, ".git"))) {
    return new Set();
  }
  const result = spawnSync(
    "git",
    ["check-ignore", "--no-index", "--stdin", "-z"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      input: relativePaths.join("\0") + "\0",
      maxBuffer: 64 * 1024 * 1024
    }
  );
  if (result.error || ![0, 1].includes(result.status)) {
    throw new Error("source_package_git_ignore_check_failed");
  }
  return new Set(
    String(result.stdout || "")
      .split("\0")
      .map(normalizeRelativePath)
      .filter(Boolean)
  );
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function resolveSourceRevision(repoRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true
  });
  const revision = String(result.stdout || "").trim();
  if (result.status !== 0 || !/^[a-f0-9]{40,64}$/u.test(revision)) {
    throw new Error("source_package_revision_unresolvable");
  }
  return revision;
}

async function copySourceFile(sourceFile, stagingPath, manifestEntries) {
  const targetPath = path.join(stagingPath, sourceFile.relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourceFile.sourcePath, targetPath);
  const stat = await fs.stat(targetPath);
  const sha256 = await sha256File(targetPath);
  manifestEntries.push({
    path: sourceFile.relativePath,
    bytes: stat.size,
    sha256
  });
  return stat.size;
}

async function prepareStagingPath(stagingPath) {
  const absoluteStagingPath = path.resolve(stagingPath);
  if (await exists(absoluteStagingPath)) {
    const stat = await fs.lstat(absoluteStagingPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("source_package_staging_path_invalid");
    }
    const entries = await fs.readdir(absoluteStagingPath);
    if (entries.length > 0) {
      throw new Error("source_package_staging_not_empty");
    }
  }
  await fs.mkdir(absoluteStagingPath, { recursive: true });
  return absoluteStagingPath;
}

export function createSourceFeaturePlan(packagingPlan = createPackagingPlan()) {
  const featureRuntime = resolveFeatureRuntime({
    edition: packagingPlan.edition || DEFAULT_EDITION,
    profile: packagingPlan.featureProfile || {},
    enableFeatures: packagingPlan.enableFeatures || [],
    disableFeatures: packagingPlan.disableFeatures || []
  });
  const packagePlan = collectPackagePlan(featureRuntime, {
    surface: packagingPlan.featureSurface || "all"
  });
  return { featureRuntime, packagePlan };
}

export async function applyFeatureSourcePlan(stagingPath, packagingPlan = createPackagingPlan(), options = {}) {
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  const absoluteStagingPath = await prepareStagingPath(stagingPath);
  const { featureRuntime, packagePlan } = createSourceFeaturePlan(packagingPlan);
  const packageRemovePaths = packagePlan.removePaths || [];
  const manifestEntries = [];
  const copiedRoots = [];
  const sourceFiles = [];
  let copiedFileCount = 0;
  let totalBytes = 0;
  for (const relativePath of [...ROOT_SOURCE_FILES, ...SOURCE_PACKAGE_ROOTS]) {
    const sourcePath = path.join(repoRoot, relativePath);
    if (!await exists(sourcePath)) {
      continue;
    }
    const rootFiles = await collectSourceFiles(
      sourcePath,
      relativePath,
      packageRemovePaths
    );
    for (const sourceFile of rootFiles) {
      sourceFiles.push({
        ...sourceFile,
        publicRoot: relativePath
      });
    }
  }
  const ignoredPaths = await ignoredSourcePaths(
    repoRoot,
    sourceFiles.map((sourceFile) => sourceFile.relativePath)
  );
  for (const sourceFile of sourceFiles) {
    if (ignoredPaths.has(sourceFile.relativePath)) {
      continue;
    }
    totalBytes += await copySourceFile(sourceFile, absoluteStagingPath, manifestEntries);
    copiedFileCount += 1;
    if (!copiedRoots.includes(sourceFile.publicRoot)) {
      copiedRoots.push(sourceFile.publicRoot);
    }
  }
  manifestEntries.sort((left, right) => left.path.localeCompare(right.path));
  const packageHash = createHash("sha256");
  for (const entry of manifestEntries) {
    packageHash.update(`${entry.path}\0${entry.bytes}\0${entry.sha256}\n`);
  }
  const packageSha256 = packageHash.digest("hex");
  const manifest = {
    schemaVersion: "v0.0.1:release:source-package-manifest-4",
    sourceRevision: resolveSourceRevision(repoRoot),
    sourceTreeDigest: `sha256:${packageSha256}`,
    packagingPlan,
    sourceRoots: SOURCE_PACKAGE_ROOTS,
    rootFiles: ROOT_SOURCE_FILES,
    excludedPaths: INTERNAL_SOURCE_PACKAGE_EXCLUDED_PATHS,
    boundaryPolicy: {
      explicitPublicRoots: true,
      gitIgnoreAware: true,
      ignoredFileCount: ignoredPaths.size
    },
    featureRuntime: {
      edition: featureRuntime.edition,
      activeFeatureIds: featureRuntime.activeFeatureIds || [],
      disabledFeatureIds: featureRuntime.disabledFeatureIds || []
    },
    featurePackagePlan: {
      surface: packagePlan.surface,
      includePaths: packagePlan.includePaths || [],
      excludePaths: packagePlan.excludePaths || [],
      removePaths: packagePlan.removePaths || []
    },
    copiedRoots,
    copiedFileCount,
    totalBytes,
    packageSha256,
    files: manifestEntries
  };
  await fs.writeFile(
    path.join(absoluteStagingPath, SOURCE_PACKAGE_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return {
    ok: true,
    stagingPath: displayPath(absoluteStagingPath, repoRoot, "[staging-output]"),
    manifestPath: SOURCE_PACKAGE_MANIFEST,
    packagingPlan,
    sourceRoots: SOURCE_PACKAGE_ROOTS,
    rootFiles: ROOT_SOURCE_FILES,
    featureRuntime: manifest.featureRuntime,
    featurePackagePlan: manifest.featurePackagePlan,
    copiedFileCount,
    totalBytes,
    packageSha256: manifest.packageSha256
  };
}

export async function resolveServerSourcePackageIdentity(repoRoot = REPO_ROOT) {
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  const packageName = String(packageJson?.name || "").trim();
  const packageVersion = String(packageJson?.version || "").trim();
  if (!SOURCE_PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new Error("source_package_name_invalid");
  }
  if (!SOURCE_PACKAGE_VERSION_PATTERN.test(packageVersion)) {
    throw new Error("source_package_version_invalid");
  }
  const rootName = `${packageName}-server-source-${packageVersion}`;
  const archiveName = `${rootName}${SOURCE_PACKAGE_ARCHIVE_SUFFIX}`;
  return Object.freeze({
    packageName,
    packageVersion,
    rootName,
    archiveName,
    checksumName: `${archiveName}${SOURCE_PACKAGE_CHECKSUM_SUFFIX}`
  });
}

async function ensureOutputDirectory(outputDirectory) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const stat = await fs.lstat(outputDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("source_package_output_directory_invalid");
  }
}

async function validateArtifactTarget(targetPath, { force }) {
  try {
    const stat = await fs.lstat(targetPath);
    if (stat.isDirectory() || (!stat.isFile() && !stat.isSymbolicLink())) {
      throw new Error("source_package_artifact_target_invalid");
    }
    if (!force) {
      throw new Error("source_package_artifact_exists");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function publishGeneratedArtifacts({
  outputDirectory,
  generatedArchivePath,
  generatedChecksumPath,
  archivePath,
  checksumPath,
  force
}) {
  for (const targetPath of [archivePath, checksumPath]) {
    if (path.dirname(targetPath) !== outputDirectory) {
      throw new Error("source_package_artifact_target_out_of_scope");
    }
    await validateArtifactTarget(targetPath, { force });
  }
  if (force) {
    for (const targetPath of [archivePath, checksumPath]) {
      await fs.rm(targetPath, { force: true });
    }
  }
  const published = [];
  try {
    await fs.copyFile(generatedArchivePath, archivePath, fsConstants.COPYFILE_EXCL);
    published.push(archivePath);
    await fs.copyFile(generatedChecksumPath, checksumPath, fsConstants.COPYFILE_EXCL);
    published.push(checksumPath);
  } catch (error) {
    for (const targetPath of published) {
      await fs.rm(targetPath, { force: true });
    }
    if (error?.code === "EEXIST") {
      throw new Error("source_package_artifact_exists");
    }
    throw error;
  }
}

export async function createServerSourcePackage({
  repoRoot = REPO_ROOT,
  outputDirectory,
  force = false,
  packagingPlan = createPackagingPlan()
} = {}) {
  const absoluteRepoRoot = path.resolve(repoRoot);
  const absoluteOutputDirectory = path.resolve(
    outputDirectory || path.join(absoluteRepoRoot, DEFAULT_SERVER_SOURCE_PACKAGE_OUTPUT_DIRECTORY)
  );
  const identity = await resolveServerSourcePackageIdentity(absoluteRepoRoot);
  const archivePath = path.join(absoluteOutputDirectory, identity.archiveName);
  const checksumPath = path.join(absoluteOutputDirectory, identity.checksumName);
  await ensureOutputDirectory(absoluteOutputDirectory);
  await validateArtifactTarget(archivePath, { force });
  await validateArtifactTarget(checksumPath, { force });

  const workspacePrefix = path.join(absoluteOutputDirectory, ".licomesh-server-source-package-");
  const temporaryRoot = await fs.mkdtemp(workspacePrefix);
  const stagingRoot = path.join(temporaryRoot, identity.rootName);
  const generatedArchivePath = path.join(temporaryRoot, identity.archiveName);
  const generatedChecksumPath = path.join(temporaryRoot, identity.checksumName);
  try {
    const source = await applyFeatureSourcePlan(stagingRoot, packagingPlan, {
      repoRoot: absoluteRepoRoot
    });
    const artifactBoundaryScan = await scanPublicArtifact(stagingRoot, {
      localNeedles: [absoluteRepoRoot]
    });
    if (!artifactBoundaryScan.ok) {
      throw new Error("source_package_public_artifact_boundary_failed");
    }
    const { createReproduciblePortableArchives } = await import(
      "./lib/mcp-release-reproducible-archives.mjs"
    );
    await createReproduciblePortableArchives({
      stagingRoot,
      outputDir: temporaryRoot,
      archivePath: generatedArchivePath
    });
    const archiveSha256 = await sha256File(generatedArchivePath);
    const archiveStat = await fs.stat(generatedArchivePath);
    await fs.writeFile(
      generatedChecksumPath,
      `${archiveSha256}  ${identity.archiveName}\n`,
      { encoding: "utf8", mode: 0o644, flag: "wx" }
    );
    await publishGeneratedArtifacts({
      outputDirectory: absoluteOutputDirectory,
      generatedArchivePath,
      generatedChecksumPath,
      archivePath,
      checksumPath,
      force: force === true
    });
    return Object.freeze({
      schemaVersion: "v0.0.1:release:server-source-package-result-1",
      ok: true,
      dryRun: false,
      sourcePackage: true,
      outputDirectory: displayPath(absoluteOutputDirectory, absoluteRepoRoot),
      artifactPath: displayPath(archivePath, absoluteRepoRoot),
      checksumPath: displayPath(checksumPath, absoluteRepoRoot),
      artifact: {
        name: identity.archiveName,
        rootName: identity.rootName,
        sizeBytes: archiveStat.size,
        sha256: archiveSha256
      },
      checksum: {
        name: identity.checksumName,
        algorithm: "sha256",
        artifactName: identity.archiveName
      },
      source: {
        target: packagingPlan.target,
        copiedFileCount: source.copiedFileCount,
        totalBytes: source.totalBytes,
        packageSha256: source.packageSha256,
        pluginSourceRootIncluded: source.sourceRoots.includes("plugins")
      },
      publicArtifactBoundary: {
        ok: true,
        scannedFileCount: Number(artifactBoundaryScan.summary?.scannedFileCount || 0),
        findingCount: 0
      }
    });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("source_package_cli_option_value_missing");
  }
  return value;
}

function validateCliArgs(args) {
  const booleanOptions = new Set(["--dry-run", "--force"]);
  const valueOptions = new Set([
    "--output-dir",
    "--target",
    "--edition",
    "--enable-features",
    "--disable-features",
    "--without-features"
  ]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (seen.has(argument)) {
      throw new Error("source_package_cli_option_duplicate");
    }
    seen.add(argument);
    if (booleanOptions.has(argument)) continue;
    if (!valueOptions.has(argument)) {
      throw new Error("source_package_cli_argument_invalid");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("source_package_cli_option_value_missing");
    }
    index += 1;
  }
}

function publicErrorCode(error) {
  const candidate = String(error?.code || error?.message || "");
  return /^(?:source_package|portable_archive)_[a-z0-9_]+$/u.test(candidate)
    ? candidate
    : "source_package_failed";
}

async function main(args = process.argv.slice(2)) {
  validateCliArgs(args);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const outputDirectory = path.resolve(
    optionValue(args, "--output-dir") ||
    path.join(REPO_ROOT, DEFAULT_SERVER_SOURCE_PACKAGE_OUTPUT_DIRECTORY)
  );
  const plan = createPackagingPlan({
    target: optionValue(args, "--target"),
    edition: optionValue(args, "--edition"),
    enableFeatures: optionValue(args, "--enable-features"),
    disableFeatures: optionValue(args, "--without-features") || optionValue(args, "--disable-features")
  });
  if (!dryRun) {
    console.log(JSON.stringify(await createServerSourcePackage({
      repoRoot: REPO_ROOT,
      outputDirectory,
      force,
      packagingPlan: plan
    }), null, 2));
    return;
  }
  const identity = await resolveServerSourcePackageIdentity(REPO_ROOT);
  const { packagePlan } = createSourceFeaturePlan(plan);
  const report = {
    schemaVersion: "v0.0.1:release:server-source-package-result-1",
    ok: true,
    dryRun: true,
    sourcePackage: true,
    outputDirectory: displayPath(outputDirectory, REPO_ROOT),
    artifactPath: displayPath(path.join(outputDirectory, identity.archiveName), REPO_ROOT),
    checksumPath: displayPath(path.join(outputDirectory, identity.checksumName), REPO_ROOT),
    artifact: {
      name: identity.archiveName,
      rootName: identity.rootName
    },
    checksum: {
      name: identity.checksumName,
      algorithm: "sha256",
      artifactName: identity.archiveName
    },
    plan,
    featurePackagePlan: {
      surface: packagePlan.surface,
      includePathCount: packagePlan.includePaths.length,
      removePathCount: packagePlan.removePaths.length
    },
    sourceRoots: SOURCE_PACKAGE_ROOTS,
    excludedPaths: INTERNAL_SOURCE_PACKAGE_EXCLUDED_PATHS
  };
  console.log(JSON.stringify(report, null, 2));
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(JSON.stringify({
      schemaVersion: "v0.0.1:release:server-source-package-result-1",
      ok: false,
      errorCode: publicErrorCode(error)
    }));
    process.exitCode = 1;
  });
}
