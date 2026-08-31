#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../../packages/contracts/src/serialization/canonical-json.ts";
import { discoverReleaseSet } from "./publish-release-set.ts";
import {
  ACCEPTANCE_REQUIRED_REPORTS,
  PLATFORM_ACCEPTANCE_COMMANDS,
} from "./lib/platform-acceptance-command-catalog.ts";
import {
  PLATFORM_ACCEPTANCE_PROFILES,
} from "./lib/platform-acceptance-contract.ts";
import {
  createReleaseEvidenceInventory,
  releaseEvidenceInventoryDigest,
} from "./lib/release-report-provenance.ts";

const execFileAsync: any = promisify(execFile);
const DEFAULT_REPO_ROOT: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RELEASE_DEFINITION_PATH: any = "tools/registry/release-definition.registry.json";
const PACKAGE_LOCK_PATH: any = "package-lock.json";
const SUPPORTED_PROFILE: any = "enterprise-single-node";
const SOURCE_REVISION_PATTERN: any = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN: any = /^[a-f0-9]{64}$/u;
const PREFIXED_SHA256_PATTERN: any = /^sha256:[a-f0-9]{64}$/u;
const PACKAGE_NAME_PATTERN: any =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const PACKAGE_VERSION_PATTERN: any =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const BUILDER_KEYS: readonly any[] = Object.freeze([
  "packageLockSha256",
  "releaseDefinitionSha256",
  "releasePackages",
  "reportInventoryDigest",
  "repositoryTreeDigest",
  "sourceRevision",
  "supportedProfiles",
]);
const CANDIDATE_KEYS: readonly any[] = Object.freeze([
  "candidate_digest",
  "package_lock_sha256",
  "release_definition_sha256",
  "release_package_inventory_sha256",
  "release_packages",
  "report_inventory_digest",
  "repository_tree_digest",
  "schema_version",
  "source_revision",
  "supported_profiles",
]);
const PACKAGE_KEYS: readonly any[] = Object.freeze([
  "manifest_path",
  "manifest_sha256",
  "name",
  "version",
]);

export const RELEASE_SOURCE_CANDIDATE_SCHEMA: any =
  "v0.0.1:meshrix:release-source-candidate-1";

function fail(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  throw error;
}

function compareText(left?: any, right?: any) : any {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameKeys(value?: any, expectedKeys?: any) : any {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort(compareText)) === JSON.stringify(expectedKeys)
  );
}

function sha256(value?: any) : any {
  return createHash("sha256").update(value).digest("hex");
}

function prefixedSha256(value?: any) : any {
  return `sha256:${sha256(value)}`;
}

function canonicalDigest(value?: any) : any {
  return sha256(canonicalJson(value));
}

function requireString(value?: any, pattern?: any, code?: any, message?: any) : any {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(code, message);
  }
  return value;
}

function normalizeManifestPath(value?: any) : any {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    fail(
      "release_candidate_release_packages_invalid",
      "Release package manifest paths must be repository-relative POSIX paths.",
    );
  }
  const normalized: any = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    path.posix.basename(normalized) !== "package.json"
  ) {
    fail(
      "release_candidate_release_packages_invalid",
      "Release package manifest paths must be safe canonical package.json paths.",
    );
  }
  return normalized;
}

function normalizeReleasePackage(value?: any) : any {
  if (!sameKeys(value, PACKAGE_KEYS)) {
    fail(
      "release_candidate_release_packages_invalid",
      "Release package entries must contain only canonical public package facts.",
    );
  }
  const manifestPath: any = normalizeManifestPath(value.manifest_path);
  const name: any = requireString(
    value.name,
    PACKAGE_NAME_PATTERN,
    "release_candidate_release_packages_invalid",
    "Release package names must be valid public npm package names.",
  );
  const version: any = requireString(
    value.version,
    PACKAGE_VERSION_PATTERN,
    "release_candidate_release_packages_invalid",
    "Release package versions must be canonical SemVer values.",
  );
  const manifestSha256: any = requireString(
    value.manifest_sha256,
    SHA256_PATTERN,
    "release_candidate_release_packages_invalid",
    "Release package manifest digests must be bare SHA-256 values.",
  );
  return Object.freeze({
    manifest_path: manifestPath,
    name,
    version,
    manifest_sha256: manifestSha256,
  });
}

function normalizeReleasePackages(value?: any) : any {
  if (!Array.isArray(value) || value.length === 0) {
    fail(
      "release_candidate_release_packages_invalid",
      "The release candidate requires at least one public package.",
    );
  }
  const packages: any = value
    .map(normalizeReleasePackage)
    .sort((left?: any, right?: any) : any => (
      compareText(left.manifest_path, right.manifest_path) ||
      compareText(left.name, right.name)
    ));
  const paths: any = new Set<any>();
  const names: any = new Set<any>();
  for (const packageRecord of packages) {
    if (paths.has(packageRecord.manifest_path) || names.has(packageRecord.name)) {
      fail(
        "release_candidate_release_packages_invalid",
        "Release package manifest paths and names must be unique.",
      );
    }
    paths.add(packageRecord.manifest_path);
    names.add(packageRecord.name);
  }
  return Object.freeze(packages);
}

function normalizeSupportedProfiles(value?: any) : any {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    value[0] !== SUPPORTED_PROFILE
  ) {
    fail(
      "release_candidate_supported_profiles_invalid",
      "The release candidate supports exactly enterprise-single-node.",
    );
  }
  return Object.freeze([SUPPORTED_PROFILE]);
}

function candidateFacts({
  sourceRevision,
  repositoryTreeDigest,
  releaseDefinitionSha256,
  packageLockSha256,
  releasePackages,
  releasePackageInventorySha256,
  supportedProfiles,
  reportInventoryDigest,
}: Record<string, any>) : any {
  return {
    schema_version: RELEASE_SOURCE_CANDIDATE_SCHEMA,
    source_revision: sourceRevision,
    repository_tree_digest: repositoryTreeDigest,
    release_definition_sha256: releaseDefinitionSha256,
    package_lock_sha256: packageLockSha256,
    release_packages: releasePackages,
    release_package_inventory_sha256: releasePackageInventorySha256,
    supported_profiles: supportedProfiles,
    report_inventory_digest: reportInventoryDigest,
  };
}

export function buildReleaseCandidateIdentity(input?: any) : any {
  if (!sameKeys(input, BUILDER_KEYS)) {
    fail(
      "release_candidate_input_invalid",
      "Release candidate construction requires the exact canonical input fields.",
    );
  }
  const sourceRevision: any = requireString(
    input.sourceRevision,
    SOURCE_REVISION_PATTERN,
    "release_candidate_source_revision_invalid",
    "Release candidate sourceRevision must be a Git SHA-1 commit identity.",
  );
  const repositoryTreeDigest: any = requireString(
    input.repositoryTreeDigest,
    PREFIXED_SHA256_PATTERN,
    "release_candidate_repository_tree_digest_invalid",
    "Release candidate repositoryTreeDigest must be a prefixed SHA-256 digest.",
  );
  const releaseDefinitionSha256: any = requireString(
    input.releaseDefinitionSha256,
    PREFIXED_SHA256_PATTERN,
    "release_candidate_release_definition_sha256_invalid",
    "Release candidate releaseDefinitionSha256 must be a prefixed SHA-256 digest.",
  );
  const packageLockSha256: any = requireString(
    input.packageLockSha256,
    PREFIXED_SHA256_PATTERN,
    "release_candidate_package_lock_sha256_invalid",
    "Release candidate packageLockSha256 must be a prefixed SHA-256 digest.",
  );
  const reportInventoryDigest: any = requireString(
    input.reportInventoryDigest,
    PREFIXED_SHA256_PATTERN,
    "release_candidate_report_inventory_digest_invalid",
    "Release candidate reportInventoryDigest must be a prefixed SHA-256 digest.",
  );
  const releasePackages: any = normalizeReleasePackages(input.releasePackages);
  const supportedProfiles: any = normalizeSupportedProfiles(input.supportedProfiles);
  const releasePackageInventorySha256: any = canonicalDigest(releasePackages);
  const facts: any = candidateFacts({
    sourceRevision,
    repositoryTreeDigest,
    releaseDefinitionSha256,
    packageLockSha256,
    releasePackages,
    releasePackageInventorySha256,
    supportedProfiles,
    reportInventoryDigest,
  });
  return Object.freeze({
    ...facts,
    candidate_digest: canonicalDigest(facts),
  });
}

function requireCandidateField(candidate?: any, field?: any) : any {
  if (!Object.hasOwn(candidate, field)) {
    fail(
      `release_candidate_${field}_missing`,
      `Release candidate field ${field} is required.`,
    );
  }
}

export function validateReleaseCandidateIdentity(candidate?: any) : any {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    fail("release_candidate_invalid", "Release candidate must be an object.");
  }
  for (const field of CANDIDATE_KEYS) requireCandidateField(candidate, field);
  if (!sameKeys(candidate, CANDIDATE_KEYS)) {
    fail(
      "release_candidate_candidate_digest_invalid",
      "Release candidate contains fields outside its candidate_digest authority.",
    );
  }
  if (candidate.schema_version !== RELEASE_SOURCE_CANDIDATE_SCHEMA) {
    fail(
      "release_candidate_schema_version_invalid",
      "Release candidate schema_version is invalid.",
    );
  }
  requireString(
    candidate.source_revision,
    SOURCE_REVISION_PATTERN,
    "release_candidate_source_revision_invalid",
    "Release candidate source_revision is invalid.",
  );
  requireString(
    candidate.repository_tree_digest,
    PREFIXED_SHA256_PATTERN,
    "release_candidate_repository_tree_digest_invalid",
    "Release candidate repository_tree_digest is invalid.",
  );
  requireString(
    candidate.release_definition_sha256,
    PREFIXED_SHA256_PATTERN,
    "release_candidate_release_definition_sha256_invalid",
    "Release candidate release_definition_sha256 is invalid.",
  );
  requireString(
    candidate.package_lock_sha256,
    PREFIXED_SHA256_PATTERN,
    "release_candidate_package_lock_sha256_invalid",
    "Release candidate package_lock_sha256 is invalid.",
  );
  requireString(
    candidate.report_inventory_digest,
    PREFIXED_SHA256_PATTERN,
    "release_candidate_report_inventory_digest_invalid",
    "Release candidate report_inventory_digest is invalid.",
  );
  requireString(
    candidate.release_package_inventory_sha256,
    SHA256_PATTERN,
    "release_candidate_release_packages_invalid",
    "Release candidate release package inventory digest is invalid.",
  );
  requireString(
    candidate.candidate_digest,
    SHA256_PATTERN,
    "release_candidate_candidate_digest_invalid",
    "Release candidate candidate_digest is invalid.",
  );
  const releasePackages: any = normalizeReleasePackages(candidate.release_packages);
  if (canonicalJson(releasePackages) !== canonicalJson(candidate.release_packages)) {
    fail(
      "release_candidate_release_packages_invalid",
      "Release candidate release_packages are not in canonical order.",
    );
  }
  const releasePackageInventorySha256: any = canonicalDigest(releasePackages);
  if (candidate.release_package_inventory_sha256 !== releasePackageInventorySha256) {
    fail(
      "release_candidate_release_packages_invalid",
      "Release candidate release_packages do not match their inventory digest.",
    );
  }
  const supportedProfiles: any = normalizeSupportedProfiles(candidate.supported_profiles);
  const facts: any = candidateFacts({
    sourceRevision: candidate.source_revision,
    repositoryTreeDigest: candidate.repository_tree_digest,
    releaseDefinitionSha256: candidate.release_definition_sha256,
    packageLockSha256: candidate.package_lock_sha256,
    releasePackages,
    releasePackageInventorySha256,
    supportedProfiles,
    reportInventoryDigest: candidate.report_inventory_digest,
  });
  if (candidate.candidate_digest !== canonicalDigest(facts)) {
    fail(
      "release_candidate_candidate_digest_invalid",
      "Release candidate candidate_digest does not match its canonical facts.",
    );
  }
  return Object.freeze({
    ...facts,
    candidate_digest: candidate.candidate_digest,
  });
}

async function canonicalRepositoryRoot(repoRoot?: any) : Promise<any> {
  try {
    return await fs.realpath(path.resolve(repoRoot || DEFAULT_REPO_ROOT));
  } catch {
    fail(
      "release_candidate_repository_invalid",
      "Release candidate repository root is unavailable.",
    );
  }
}

async function git(repoRoot?: any, args?: any, { binary = false }: Record<string, any> = {}) : Promise<any> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      encoding: binary ? "buffer" : "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    fail(
      "release_candidate_git_invalid",
      "Release candidate Git evidence is unavailable.",
    );
  }
}

async function currentSourceRevision(repoRoot?: any) : Promise<any> {
  const revision: any = String(
    await git(repoRoot, ["rev-parse", "--verify", "HEAD"]),
  ).trim();
  return requireString(
    revision,
    SOURCE_REVISION_PATTERN,
    "release_candidate_source_revision_invalid",
    "Release candidate HEAD must resolve to a Git SHA-1 commit identity.",
  );
}

export async function assertCandidateWorktreeClean({
  repoRoot = DEFAULT_REPO_ROOT,
}: Record<string, any> = {}) : Promise<any> {
  return assertCandidateWorktreeCleanWithWorkerPolicy({ repoRoot, acceptanceWorker: false });
}

async function assertCandidateWorktreeCleanWithWorkerPolicy({
  repoRoot = DEFAULT_REPO_ROOT,
  acceptanceWorker = false,
}: Record<string, any> = {}) : Promise<any> {
  const repositoryRoot: any = await canonicalRepositoryRoot(repoRoot);
  const discoveredRoot: any = String(
    await git(repositoryRoot, ["rev-parse", "--show-toplevel"]),
  ).trim();
  let canonicalDiscoveredRoot: any;
  try {
    canonicalDiscoveredRoot = await fs.realpath(discoveredRoot);
  } catch {
    fail(
      "release_candidate_repository_invalid",
      "Release candidate Git root is unavailable.",
    );
  }
  if (canonicalDiscoveredRoot !== repositoryRoot) {
    fail(
      "release_candidate_repository_invalid",
      "Release candidate creation must run against the repository root.",
    );
  }
  const status: any = await git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ], { binary: true });
  if (status.length !== 0) {
    const entries: any[] = Buffer.from(status).toString("utf8").split("\0").filter(Boolean);
    const untrackedIgnoredOnly: any = entries.length > 0 &&
      entries.every((entry?: any) : any => String(entry).startsWith("!! "));
    const generatedBuildOnly: any = entries.length > 0 &&
      entries.every((entry?: any) : any => String(entry).startsWith("?? build/"));
    const workerCandidateOnly: any = entries.length > 0 &&
      entries.every((entry?: any) : any => {
        const text: any = String(entry);
        return text.startsWith("!! ") || text.startsWith("?? build/") || text.startsWith("?? .cache/");
      });
    if (untrackedIgnoredOnly || generatedBuildOnly || workerCandidateOnly) {
      if (process.env.MESHRIX_ACCEPTANCE_GENERATION_WORKER === "1") {
        console.error(`release_candidate_generated_evidence_only=${generatedBuildOnly ? "build" : workerCandidateOnly ? "worker" : "ignored"}:${JSON.stringify(entries).slice(0, 1000)}`);
      }
      return currentSourceRevision(repositoryRoot);
    }
    fail(
      "candidate_worktree_not_clean",
      "candidate_worktree_not_clean: release candidate creation requires a clean worktree.",
    );
  }
  return currentSourceRevision(repositoryRoot);
}

function manifestPathForReleasePackage(packageRecord?: any) : any {
  return packageRecord.directory === "."
    ? "package.json"
    : `${packageRecord.directory}/package.json`;
}

function canonicalReportInventoryDigest() : any {
  const profiles: any = Object.keys(PLATFORM_ACCEPTANCE_PROFILES).sort(compareText);
  if (
    profiles.length !== 1 ||
    profiles[0] !== SUPPORTED_PROFILE
  ) {
    fail(
      "release_candidate_supported_profiles_invalid",
      "Platform acceptance must register exactly enterprise-single-node.",
    );
  }
  const inventory: any = createReleaseEvidenceInventory({
    commands: PLATFORM_ACCEPTANCE_COMMANDS,
    requiredReportPaths: ACCEPTANCE_REQUIRED_REPORTS,
  });
  return releaseEvidenceInventoryDigest(inventory);
}

export async function createReleaseCandidateIdentity({
  repoRoot = DEFAULT_REPO_ROOT,
}: Record<string, any> = {}) : Promise<any> {
  const repositoryRoot: any = await canonicalRepositoryRoot(repoRoot);
  const sourceRevision: any = await assertCandidateWorktreeCleanWithWorkerPolicy({
    repoRoot: repositoryRoot,
    acceptanceWorker: true,
  });
  const [{ stdout: repositoryTree }, releaseDefinition, packageLock, releaseSet] =
    await Promise.all([
      execFileAsync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "buffer",
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      }).catch(() : any => fail(
        "release_candidate_git_invalid",
        "Release candidate repository tree is unavailable.",
      )),
      fs.readFile(path.join(repositoryRoot, RELEASE_DEFINITION_PATH)),
      fs.readFile(path.join(repositoryRoot, PACKAGE_LOCK_PATH)),
      discoverReleaseSet({ rootDir: repositoryRoot }),
    ]);
  const releasePackages: any = await Promise.all(
    releaseSet.packages.map(async (packageRecord?: any) : Promise<any> => {
      const manifestPath: any = manifestPathForReleasePackage(packageRecord);
      const manifestBytes: any = await fs.readFile(path.join(repositoryRoot, manifestPath));
      return {
        manifest_path: manifestPath,
        name: packageRecord.name,
        version: packageRecord.version,
        manifest_sha256: sha256(manifestBytes),
      };
    }),
  );
  const finalSourceRevision: any = await assertCandidateWorktreeCleanWithWorkerPolicy({
    repoRoot: repositoryRoot,
    acceptanceWorker: true,
  });
  if (sourceRevision !== finalSourceRevision) {
    fail(
      "release_candidate_source_changed",
      "Release candidate source changed during identity construction.",
    );
  }
  return buildReleaseCandidateIdentity({
    sourceRevision,
    repositoryTreeDigest: prefixedSha256(repositoryTree),
    releaseDefinitionSha256: prefixedSha256(releaseDefinition),
    packageLockSha256: prefixedSha256(packageLock),
    releasePackages,
    supportedProfiles: [SUPPORTED_PROFILE],
    reportInventoryDigest: canonicalReportInventoryDigest(),
  });
}

export async function loadReleaseCandidateIdentity(candidatePath?: any) : Promise<any> {
  let parsed: any;
  try {
    parsed = JSON.parse(await fs.readFile(candidatePath, "utf8"));
  } catch {
    fail(
      "release_candidate_file_invalid",
      "Release candidate file is unavailable or invalid.",
    );
  }
  return validateReleaseCandidateIdentity(parsed);
}

function assertOutputWithinRepository(repoRoot?: any, outputPath?: any) : any {
  const relative: any = path.relative(repoRoot, outputPath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(
      "release_candidate_output_path_invalid",
      "Release candidate output must be a repository-relative file.",
    );
  }
}

async function writeCandidateOnce({ repoRoot, output, candidate }: Record<string, any>) : Promise<any> {
  const outputPath: any = path.resolve(repoRoot, output);
  assertOutputWithinRepository(repoRoot, outputPath);
  const parentPath: any = path.dirname(outputPath);
  await fs.mkdir(parentPath, { recursive: true, mode: 0o700 });
  let canonicalParent: any;
  try {
    canonicalParent = await fs.realpath(parentPath);
  } catch {
    fail(
      "release_candidate_output_path_invalid",
      "Release candidate output directory is unavailable.",
    );
  }
  assertOutputWithinRepository(repoRoot, path.join(canonicalParent, path.basename(outputPath)));
  const temporaryPath: any = path.join(
    canonicalParent,
    `.${path.basename(outputPath)}.${randomUUID()}.tmp`,
  );
  let handle: any;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch {
    await handle?.close().catch(() : any => {});
    handle = undefined;
    await fs.unlink(temporaryPath).catch(() : any => {});
    fail(
      "release_candidate_output_write_failed",
      "Release candidate output could not be staged.",
    );
  } finally {
    await handle?.close().catch(() : any => {});
  }
  try {
    await fs.link(temporaryPath, outputPath);
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      fail(
        "release_candidate_output_exists",
        "Release candidate output already exists.",
      );
    }
    fail(
      "release_candidate_output_write_failed",
      "Release candidate output could not be published.",
    );
  } finally {
    await fs.unlink(temporaryPath).catch(() : any => {});
  }
}

function parseBoundaryArgs(argv?: any) : any {
  if (argv.length === 0) return Object.freeze({ output: "" });
  if (argv.length === 2 && argv[0] === "--output" && String(argv[1] || "").trim()) {
    return Object.freeze({ output: String(argv[1]) });
  }
  fail(
    "release_candidate_argument_invalid",
    "Release candidate verifier accepts only --output <repository-relative-path>.",
  );
}

export async function verifyReleaseCandidateIdentityBoundary({
  repoRoot = DEFAULT_REPO_ROOT,
  argv = [],
}: Record<string, any> = {}) : Promise<any> {
  const { output } = parseBoundaryArgs(argv);
  if (!output) {
    const reportInventoryDigest: any = canonicalReportInventoryDigest();
    const candidate: any = buildReleaseCandidateIdentity({
      sourceRevision: "0".repeat(40),
      repositoryTreeDigest: `sha256:${"1".repeat(64)}`,
      releaseDefinitionSha256: `sha256:${"2".repeat(64)}`,
      packageLockSha256: `sha256:${"3".repeat(64)}`,
      releasePackages: [{
        manifest_path: "package.json",
        name: "meshrix",
        version: "0.0.1",
        manifest_sha256: "4".repeat(64),
      }],
      supportedProfiles: [SUPPORTED_PROFILE],
      reportInventoryDigest,
    });
    validateReleaseCandidateIdentity(candidate);
    return Object.freeze({
      ok: true,
      schema_version: RELEASE_SOURCE_CANDIDATE_SCHEMA,
      supported_profiles: Object.freeze([SUPPORTED_PROFILE]),
      report_inventory_digest: reportInventoryDigest,
    });
  }
  const repositoryRoot: any = await canonicalRepositoryRoot(repoRoot);
  const candidate: any = await createReleaseCandidateIdentity({
    repoRoot: repositoryRoot,
  });
  await writeCandidateOnce({
    repoRoot: repositoryRoot,
    output,
    candidate,
  });
  return Object.freeze({
    ok: true,
    schema_version: RELEASE_SOURCE_CANDIDATE_SCHEMA,
    candidate_digest: candidate.candidate_digest,
  });
}

async function main() : Promise<any> {
  const result: any = await verifyReleaseCandidateIdentityBoundary({
    repoRoot: DEFAULT_REPO_ROOT,
    argv: process.argv.slice(2),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain: any =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error?: any) : any => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "release_candidate_identity_invalid",
    })}\n`);
    process.exitCode = 1;
  });
}
