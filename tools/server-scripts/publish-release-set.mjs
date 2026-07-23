#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { npmCliArgs, resolveNpmCliInvocation } from "./lib/npm-cli-invocation.mjs";
import { assertReleaseVersion } from "./prepare-release.mjs";

const execFileAsync = promisify(execFile);
const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";
const GATEWAY_INSTALLER_DIRECTORY =
  "packages/protocols/mcp/adapter/gateway-installer";
const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
]);
const RAW_NPM_TOKEN_ENVIRONMENT_NAMES = Object.freeze([
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "NPM_CONFIG__AUTHTOKEN",
  "npm_config__authToken"
]);
const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const REGISTRY_SIGNATURE_KEY_PATTERN = /^SHA256:[A-Za-z0-9+/]+={0,2}$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const BUILD_METADATA_PATTERN = /^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/u;
const SLSA_PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;

export class ReleaseSetPublicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseSetPublicationError";
    this.code = code;
  }
}

function publicationError(code, message) {
  return new ReleaseSetPublicationError(code, message);
}

function normalizeReleaseVersion(value) {
  try {
    return assertReleaseVersion(value);
  } catch {
    throw publicationError(
      "release_set_version_invalid",
      "Every release-set package must use the root release version."
    );
  }
}

function normalizePackageName(value) {
  const name = String(value || "");
  if (!PACKAGE_NAME_PATTERN.test(name) || name.length > 214) {
    throw publicationError(
      "release_set_package_name_invalid",
      "Every release-set package must use a valid npm package name."
    );
  }
  return name;
}

function normalizeRelativeDirectory(value) {
  const source = String(value || "").replace(/\\/gu, "/");
  const normalized = path.posix.normalize(source).replace(/^\.\//u, "");
  if (
    !source ||
    path.posix.isAbsolute(source) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    /[*?{}[\]]/u.test(normalized)
  ) {
    throw publicationError(
      "release_set_workspace_path_invalid",
      "Release workspaces must be explicit repository-relative directories."
    );
  }
  return normalized;
}

async function readManifest(repositoryRoot, directory, { root = false } = {}) {
  const manifestPath = root
    ? path.join(repositoryRoot, "package.json")
    : path.join(repositoryRoot, directory, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    throw publicationError(
      "release_set_manifest_invalid",
      "Every release-set directory must contain a valid package manifest."
    );
  }
  return {
    directory: root ? "." : directory,
    absoluteDirectory: root ? repositoryRoot : path.join(repositoryRoot, directory),
    manifest,
    name: normalizePackageName(manifest.name),
    root
  };
}

function internalDependencyNames(manifest) {
  const names = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest?.[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith("@lico/")) names.add(name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function compareReadyPackages(left, right) {
  if (left.root !== right.root) return left.root ? 1 : -1;
  return left.name.localeCompare(right.name);
}

export function topologicallyOrderReleaseSet(packages) {
  const byName = new Map();
  for (const packageRecord of packages) {
    if (byName.has(packageRecord.name)) {
      throw publicationError(
        "release_set_package_name_duplicate",
        "Release-set package names must be unique."
      );
    }
    byName.set(packageRecord.name, packageRecord);
  }

  const dependents = new Map([...byName.keys()].map((name) => [name, new Set()]));
  const indegree = new Map([...byName.keys()].map((name) => [name, 0]));
  for (const packageRecord of packages) {
    for (const dependencyName of internalDependencyNames(packageRecord.manifest)) {
      if (!byName.has(dependencyName)) {
        throw publicationError(
          "release_set_internal_dependency_missing",
          "Every internal @lico dependency must be part of the public release set."
        );
      }
      if (!dependents.get(dependencyName).has(packageRecord.name)) {
        dependents.get(dependencyName).add(packageRecord.name);
        indegree.set(packageRecord.name, indegree.get(packageRecord.name) + 1);
      }
    }
  }

  const ready = packages
    .filter(({ name }) => indegree.get(name) === 0)
    .sort(compareReadyPackages);
  const ordered = [];
  while (ready.length > 0) {
    const current = ready.shift();
    ordered.push(current);
    for (const dependentName of [...dependents.get(current.name)].sort()) {
      const nextIndegree = indegree.get(dependentName) - 1;
      indegree.set(dependentName, nextIndegree);
      if (nextIndegree === 0) {
        ready.push(byName.get(dependentName));
        ready.sort(compareReadyPackages);
      }
    }
  }

  if (ordered.length !== packages.length) {
    throw publicationError(
      "release_set_dependency_cycle",
      "The public release set contains an internal dependency cycle."
    );
  }
  if (!ordered.at(-1)?.root) {
    throw publicationError(
      "release_set_root_order_invalid",
      "The root framework package must be published last."
    );
  }
  return ordered;
}

export async function discoverReleaseSet({ rootDir = process.cwd() } = {}) {
  const repositoryRoot = path.resolve(rootDir);
  const rootPackage = await readManifest(repositoryRoot, ".", { root: true });
  const version = normalizeReleaseVersion(rootPackage.manifest.version);
  const workspaces = rootPackage.manifest.workspaces;
  if (!Array.isArray(workspaces) || workspaces.some((workspace) => typeof workspace !== "string")) {
    throw publicationError(
      "release_set_workspaces_invalid",
      "The root package must declare an explicit workspace directory array."
    );
  }

  const workspaceDirectories = workspaces.map(normalizeRelativeDirectory);
  const candidateDirectories = [...workspaceDirectories, GATEWAY_INSTALLER_DIRECTORY];
  if (new Set(candidateDirectories).size !== candidateDirectories.length) {
    throw publicationError(
      "release_set_workspace_duplicate",
      "Release-set package directories must be unique."
    );
  }

  const candidates = [];
  for (const directory of candidateDirectories) {
    const packageRecord = await readManifest(repositoryRoot, directory);
    if (packageRecord.manifest.private === true) continue;
    const packageVersion = normalizeReleaseVersion(packageRecord.manifest.version);
    if (packageVersion !== version) {
      throw publicationError(
        "release_set_version_mismatch",
        "Every public workspace and connector package must match the root release version."
      );
    }
    candidates.push({ ...packageRecord, version: packageVersion });
  }

  if (rootPackage.manifest.private === true) {
    throw publicationError(
      "release_set_root_private",
      "The root framework package must remain publishable."
    );
  }
  candidates.push({ ...rootPackage, version });

  const ordered = topologicallyOrderReleaseSet(candidates);
  const releaseNames = new Set(ordered.map(({ name }) => name));
  for (const packageRecord of ordered) {
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = packageRecord.manifest?.[field];
      if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
        continue;
      }
      for (const [dependencyName, dependencyVersion] of Object.entries(dependencies)) {
        if (!dependencyName.startsWith("@lico/")) continue;
        if (!releaseNames.has(dependencyName) || dependencyVersion !== version) {
          throw publicationError(
            "release_set_internal_dependency_invalid",
            "Internal @lico dependencies must be present and locked to the release version."
          );
        }
      }
    }
  }

  return { repositoryRoot, version, packages: ordered };
}

export function releaseTagForVersion(version) {
  const normalized = normalizeReleaseVersion(version);
  return normalized.split("+", 1)[0].includes("-") ? "next" : "latest";
}

function parseComparableVersion(value) {
  const normalized = String(value || "").trim();
  const versionParts = normalized.split("+");
  if (
    versionParts.length > 2 ||
    (versionParts.length === 2 && !BUILD_METADATA_PATTERN.test(versionParts[1]))
  ) {
    throw new Error("registry_version_invalid");
  }
  const withoutBuildMetadata = versionParts[0];
  const validated = assertReleaseVersion(withoutBuildMetadata);
  const prereleaseOffset = validated.indexOf("-");
  const core = prereleaseOffset < 0 ? validated : validated.slice(0, prereleaseOffset);
  const prerelease = prereleaseOffset < 0 ? null : validated.slice(prereleaseOffset + 1);
  return {
    normalized,
    core: core.split("."),
    prerelease: prerelease === null ? null : prerelease.split(".")
  };
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function comparePrereleaseIdentifiers(left, right) {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return compareNumericIdentifiers(left, right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareReleaseVersions(leftValue, rightValue) {
  let left;
  let right;
  try {
    left = parseComparableVersion(leftValue);
    right = parseComparableVersion(rightValue);
  } catch {
    throw publicationError(
      "release_set_registry_tag_version_invalid",
      "The npm registry returned an invalid dist-tag version."
    );
  }
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifiers(left.core[index], right.core[index]);
    if (comparison !== 0) return comparison;
  }
  if (left.prerelease === null || right.prerelease === null) {
    if (left.prerelease === right.prerelease) return 0;
    return left.prerelease === null ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const comparison = comparePrereleaseIdentifiers(
      left.prerelease[index],
      right.prerelease[index]
    );
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function normalizeRequestedTag(version, requestedTag) {
  const expected = releaseTagForVersion(version);
  const normalized = requestedTag === undefined ? expected : String(requestedTag);
  if (!new Set(["latest", "next"]).has(normalized) || normalized !== expected) {
    throw publicationError(
      "release_set_tag_invalid",
      "The npm dist-tag must be latest for stable releases and next for prereleases."
    );
  }
  return normalized;
}

function assertNoRawNpmToken(environment) {
  if (RAW_NPM_TOKEN_ENVIRONMENT_NAMES.some((name) => environment?.[name])) {
    throw publicationError(
      "release_set_raw_npm_token_forbidden",
      "npm publication must use GitHub OIDC trusted publishing without a raw npm token."
    );
  }
}

export function createNpmRunner({ environment = process.env } = {}) {
  const invocation = resolveNpmCliInvocation({ env: environment });
  return async (args, { cwd }) => {
    try {
      const result = await execFileAsync(
        invocation.command,
        npmCliArgs(invocation, args),
        {
          cwd,
          encoding: "utf8",
          env: environment,
          maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
          timeout: COMMAND_TIMEOUT_MS,
          windowsHide: true
        }
      );
      return { exitCode: 0, stdout: result.stdout || "", stderr: result.stderr || "" };
    } catch (error) {
      return {
        exitCode: typeof error?.code === "number" ? error.code : 1,
        stdout: String(error?.stdout || ""),
        stderr: String(error?.stderr || "")
      };
    }
  };
}

function assertSuccessfulResult(result, code, message) {
  if (!result || result.exitCode !== 0) throw publicationError(code, message);
  return result;
}

function parsePackArtifact(stdout, packageRecord) {
  let artifacts;
  try {
    artifacts = JSON.parse(String(stdout || ""));
  } catch {
    throw publicationError(
      "release_set_pack_output_invalid",
      "npm pack must return one JSON artifact record."
    );
  }
  if (!Array.isArray(artifacts) || artifacts.length !== 1) {
    throw publicationError(
      "release_set_pack_output_invalid",
      "npm pack must return one JSON artifact record."
    );
  }
  const artifact = artifacts[0];
  const filename = String(artifact?.filename || "");
  const integrity = String(artifact?.integrity || "");
  if (
    artifact?.name !== packageRecord.name ||
    artifact?.version !== packageRecord.version ||
    !filename ||
    filename !== path.basename(filename) ||
    !filename.endsWith(".tgz") ||
    !INTEGRITY_PATTERN.test(integrity)
  ) {
    throw publicationError(
      "release_set_pack_artifact_invalid",
      "npm pack returned package metadata that does not match the release set."
    );
  }
  return { filename, integrity };
}

async function packReleaseSet(packages, packDirectory, runner) {
  const packed = [];
  for (const packageRecord of packages) {
    const result = assertSuccessfulResult(
      await runner(
        ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
        { cwd: packageRecord.absoluteDirectory }
      ),
      "release_set_pack_failed",
      "A release-set package could not be packed."
    );
    const artifact = parsePackArtifact(result.stdout, packageRecord);
    const tarballPath = path.join(packDirectory, artifact.filename);
    let tarballStat;
    try {
      tarballStat = await fs.lstat(tarballPath);
    } catch {
      throw publicationError(
        "release_set_tarball_missing",
        "npm pack did not create the declared release tarball."
      );
    }
    if (!tarballStat.isFile() || tarballStat.isSymbolicLink()) {
      throw publicationError(
        "release_set_tarball_invalid",
        "Release tarballs must be regular files."
      );
    }
    packed.push({ ...packageRecord, ...artifact, tarballPath });
  }
  return packed;
}

function registryVersionMissing(result) {
  const output = `${String(result?.stdout || "")}\n${String(result?.stderr || "")}`;
  return /(?:\bE404\b|404\s+Not\s+Found)/iu.test(output);
}

function parseRegistryJson(result, code, message) {
  try {
    return JSON.parse(String(result.stdout || ""));
  } catch {
    throw publicationError(code, message);
  }
}

function hasValidRegistrySignatures(signatures) {
  return Array.isArray(signatures) && signatures.length > 0 && signatures.every((signature) => (
    signature &&
    typeof signature === "object" &&
    REGISTRY_SIGNATURE_KEY_PATTERN.test(String(signature.keyid || "")) &&
    BASE64_PATTERN.test(String(signature.sig || ""))
  ));
}

function hasValidProvenanceAttestation(attestations, packageRecord) {
  if (
    !attestations ||
    typeof attestations !== "object" ||
    Array.isArray(attestations) ||
    attestations?.provenance?.predicateType !== SLSA_PROVENANCE_PREDICATE
  ) {
    return false;
  }
  let attestationUrl;
  try {
    attestationUrl = new URL(String(attestations.url || ""));
  } catch {
    return false;
  }
  if (
    attestationUrl.origin !== new URL(OFFICIAL_NPM_REGISTRY).origin ||
    attestationUrl.username ||
    attestationUrl.password ||
    attestationUrl.search ||
    attestationUrl.hash
  ) {
    return false;
  }
  const prefix = "/-/npm/v1/attestations/";
  if (!attestationUrl.pathname.startsWith(prefix)) return false;
  try {
    return decodeURIComponent(attestationUrl.pathname.slice(prefix.length)) ===
      `${packageRecord.name}@${packageRecord.version}`;
  } catch {
    return false;
  }
}

function validatePublishedDistribution(distribution, packageRecord) {
  if (!distribution || typeof distribution !== "object" || Array.isArray(distribution)) {
    throw publicationError(
      "release_set_registry_distribution_invalid",
      "The npm registry returned invalid package distribution metadata."
    );
  }
  const integrity = String(distribution.integrity || "");
  if (!INTEGRITY_PATTERN.test(integrity)) {
    throw publicationError(
      "release_set_registry_integrity_invalid",
      "The npm registry returned an invalid integrity value."
    );
  }
  if (!hasValidRegistrySignatures(distribution.signatures)) {
    throw publicationError(
      "release_set_registry_signature_missing",
      "Every published release-set version must carry a valid npm registry signature record."
    );
  }
  if (!hasValidProvenanceAttestation(distribution.attestations, packageRecord)) {
    throw publicationError(
      "release_set_registry_provenance_missing",
      "Every published release-set version must carry an npm provenance attestation."
    );
  }
  return { integrity };
}

async function queryPublishedDistribution(packageRecord, runner) {
  const result = await runner(
    [
      "view",
      `${packageRecord.name}@${packageRecord.version}`,
      "dist",
      "--json",
      "--registry",
      OFFICIAL_NPM_REGISTRY
    ],
    { cwd: packageRecord.absoluteDirectory }
  );
  if (result?.exitCode !== 0) {
    if (registryVersionMissing(result)) return null;
    throw publicationError(
      "release_set_registry_query_failed",
      "The npm registry version check did not complete successfully."
    );
  }
  return validatePublishedDistribution(
    parseRegistryJson(
      result,
      "release_set_registry_distribution_invalid",
      "The npm registry returned invalid package distribution metadata."
    ),
    packageRecord
  );
}

async function queryPublishedTag(packageRecord, tag, runner) {
  const result = await runner(
    [
      "view",
      packageRecord.name,
      "dist-tags",
      "--json",
      "--registry",
      OFFICIAL_NPM_REGISTRY
    ],
    { cwd: packageRecord.absoluteDirectory }
  );
  if (result?.exitCode !== 0) {
    if (registryVersionMissing(result)) return null;
    throw publicationError(
      "release_set_registry_query_failed",
      "The npm registry dist-tag check did not complete successfully."
    );
  }
  const tags = parseRegistryJson(
    result,
    "release_set_registry_tags_invalid",
    "The npm registry returned invalid dist-tag metadata."
  );
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) {
    throw publicationError(
      "release_set_registry_tags_invalid",
      "The npm registry returned invalid dist-tag metadata."
    );
  }
  const taggedVersion = tags[tag];
  if (taggedVersion === undefined) return null;
  try {
    return parseComparableVersion(taggedVersion).normalized;
  } catch {
    throw publicationError(
      "release_set_registry_tag_version_invalid",
      "The npm registry returned an invalid dist-tag version."
    );
  }
}

async function queryRegistryState(packageRecord, tag, runner) {
  const [distribution, taggedVersion] = await Promise.all([
    queryPublishedDistribution(packageRecord, runner),
    queryPublishedTag(packageRecord, tag, runner)
  ]);
  return { distribution, taggedVersion };
}

function preflightPackagePublication(packageRecord, registryState) {
  const { distribution, taggedVersion } = registryState;
  if (distribution !== null && distribution.integrity !== packageRecord.integrity) {
    throw publicationError(
      "release_set_registry_integrity_mismatch",
      "An immutable npm package version already exists with different content."
    );
  }
  const tagComparison = taggedVersion === null
    ? null
    : compareReleaseVersions(taggedVersion, packageRecord.version);
  if (distribution !== null) {
    if (tagComparison === null || tagComparison < 0) {
      throw publicationError(
        "release_set_registry_tag_repair_required",
        "An existing release-set version requires a dist-tag repair that OIDC publication cannot perform."
      );
    }
    return {
      action: "skipped",
      expectedTaggedVersion: taggedVersion
    };
  }
  if (tagComparison !== null && tagComparison >= 0) {
    throw publicationError(
      tagComparison > 0
        ? "release_set_registry_tag_regression"
        : "release_set_registry_state_inconsistent",
      tagComparison > 0
        ? "Publishing this release would regress the npm dist-tag."
        : "The npm dist-tag names a version that is missing from the registry."
    );
  }
  return {
    action: "publish",
    expectedTaggedVersion: packageRecord.version
  };
}

function verifyPostPublicationState(packageRecord, plan, state) {
  if (state.distribution === null) {
    throw publicationError(
      "release_set_registry_post_publish_missing",
      "The published release-set version is missing from the npm registry."
    );
  }
  if (state.distribution.integrity !== packageRecord.integrity) {
    throw publicationError(
      "release_set_registry_integrity_mismatch",
      "An immutable npm package version already exists with different content."
    );
  }
  if (state.taggedVersion !== plan.expectedTaggedVersion) {
    throw publicationError(
      "release_set_registry_tag_postcondition_failed",
      "The npm dist-tag does not match the verified monotonic publication plan."
    );
  }
}

async function publishTarball(packageRecord, tag, runner) {
  assertSuccessfulResult(
    await runner(
      [
        "publish",
        packageRecord.tarballPath,
        "--provenance",
        "--access",
        "public",
        "--tag",
        tag,
        "--ignore-scripts",
        "--registry",
        OFFICIAL_NPM_REGISTRY
      ],
      { cwd: packageRecord.absoluteDirectory }
    ),
    "release_set_publish_failed",
    "A release-set tarball could not be published."
  );
}

async function verifyPublishedPackageSignatures(packages, temporaryRoot, runner) {
  const auditDirectory = path.join(temporaryRoot, "registry-signature-audit");
  await fs.mkdir(auditDirectory);
  const dependencies = Object.fromEntries(
    packages.map(({ name, version }) => [name, version])
  );
  await fs.writeFile(
    path.join(auditDirectory, "package.json"),
    `${JSON.stringify({
      name: "licomesh-release-set-signature-audit",
      version: "0.0.0",
      private: true,
      dependencies
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  assertSuccessfulResult(
    await runner(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--omit=optional",
        "--registry",
        OFFICIAL_NPM_REGISTRY
      ],
      { cwd: auditDirectory }
    ),
    "release_set_registry_audit_install_failed",
    "The published release set could not be installed for signature verification."
  );
  assertSuccessfulResult(
    await runner(
      [
        "audit",
        "signatures",
        "--json",
        "--include-attestations",
        "--omit=optional",
        "--registry",
        OFFICIAL_NPM_REGISTRY
      ],
      { cwd: auditDirectory }
    ),
    "release_set_registry_signature_audit_failed",
    "npm could not cryptographically verify the published release-set signatures and provenance."
  );
}

export async function publishReleaseSet({
  rootDir = process.cwd(),
  dryRun = false,
  preflight = false,
  tag: requestedTag,
  runner,
  environment = process.env
} = {}) {
  if (dryRun && preflight) {
    throw publicationError(
      "release_set_argument_conflict",
      "--dry-run and --preflight cannot be used together."
    );
  }
  const releaseSet = await discoverReleaseSet({ rootDir });
  const tag = normalizeRequestedTag(releaseSet.version, requestedTag);
  if (!dryRun && !preflight) assertNoRawNpmToken(environment);
  const commandRunner = runner || createNpmRunner({ environment });
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lico-npm-release-set-"));
  const packDirectory = path.join(temporaryRoot, "tarballs");
  await fs.mkdir(packDirectory);

  try {
    const packed = await packReleaseSet(releaseSet.packages, packDirectory, commandRunner);
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        version: releaseSet.version,
        tag,
        packageCount: packed.length,
        packages: packed.map(({ name, version, integrity }) => ({
          name,
          version,
          integrity,
          action: "planned"
        }))
      };
    }

    const preflightStates = await Promise.all(
      packed.map((packageRecord) => queryRegistryState(packageRecord, tag, commandRunner))
    );
    const plans = packed.map((packageRecord, index) => (
      preflightPackagePublication(packageRecord, preflightStates[index])
    ));
    if (preflight) {
      return {
        ok: true,
        dryRun: false,
        preflight: true,
        version: releaseSet.version,
        tag,
        packageCount: packed.length,
        packages: packed.map((packageRecord, index) => ({
          name: packageRecord.name,
          version: packageRecord.version,
          integrity: packageRecord.integrity,
          action: plans[index].action
        }))
      };
    }

    for (let index = 0; index < packed.length; index += 1) {
      if (plans[index].action === "publish") {
        await publishTarball(packed[index], tag, commandRunner);
      }
    }

    const verifiedStates = await Promise.all(
      packed.map((packageRecord) => queryRegistryState(packageRecord, tag, commandRunner))
    );
    const packages = packed.map((packageRecord, index) => {
      verifyPostPublicationState(packageRecord, plans[index], verifiedStates[index]);
      return {
        name: packageRecord.name,
        version: packageRecord.version,
        integrity: packageRecord.integrity,
        action: plans[index].action === "publish" ? "published" : "skipped"
      };
    });
    await verifyPublishedPackageSignatures(packed, temporaryRoot, commandRunner);
    return {
      ok: true,
      dryRun: false,
      version: releaseSet.version,
      tag,
      packageCount: packages.length,
      packages
    };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function optionValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw publicationError("release_set_argument_missing", `${option} requires a value.`);
  }
  return value;
}

export function parsePublishArguments(argv) {
  let dryRun = false;
  let preflight = false;
  let tag;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--preflight") {
      preflight = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--tag") {
      tag = optionValue(argv, index, "--tag");
      index += 1;
    } else if (argument.startsWith("--tag=")) {
      tag = argument.slice("--tag=".length);
    } else {
      throw publicationError(
        "release_set_argument_unknown",
        "Only --dry-run, --preflight, and --tag latest|next are supported."
      );
    }
  }
  if (dryRun && preflight) {
    throw publicationError(
      "release_set_argument_conflict",
      "--dry-run and --preflight cannot be used together."
    );
  }
  return { dryRun, preflight, tag, help };
}

function usage() {
  return [
    "Usage:",
    "  npm run release:publish-npm",
    "  npm run release:publish-npm -- --dry-run",
    "  npm run release:publish-npm -- --preflight",
    "  npm run release:publish-npm -- --tag latest|next",
    "",
    "Stable versions use latest; prereleases use next. --dry-run packs locally without registry access. --preflight reads the registry without publishing."
  ].join("\n");
}

async function main() {
  const options = parsePublishArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await publishReleaseSet(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    const normalized = error instanceof ReleaseSetPublicationError
      ? error
      : publicationError("release_set_publish_failed", "The npm release set was not published.");
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: normalized.code,
      message: normalized.message
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
