#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATEWAY_INSTALLER_MANIFEST =
  "packages/protocols/mcp/adapter/gateway-installer/package.json";
const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
]);
const RELEASE_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;

export class ReleasePreparationError extends Error {
  constructor(code, message, findings = []) {
    super(message);
    this.name = "ReleasePreparationError";
    this.code = code;
    this.findings = findings;
  }
}

function releaseError(code, message, findings = []) {
  return new ReleasePreparationError(code, message, findings);
}

export function assertReleaseVersion(version) {
  const normalized = String(version || "").trim();
  if (!RELEASE_SEMVER_PATTERN.test(normalized)) {
    throw releaseError(
      "release_version_invalid",
      "Release version must be valid SemVer without build metadata."
    );
  }
  return normalized;
}

export function releaseVersionFromTag(tag) {
  const normalized = String(tag || "").trim();
  if (!normalized.startsWith("v")) {
    throw releaseError("release_tag_invalid", "Release tag must use the v<semver> form.");
  }
  const version = assertReleaseVersion(normalized.slice(1));
  if (normalized !== `v${version}`) {
    throw releaseError("release_tag_invalid", "Release tag must use the v<semver> form.");
  }
  return version;
}

function assertReleaseDate(value) {
  const normalized = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(normalized);
  if (!match) {
    throw releaseError("release_date_invalid", "Release date must use YYYY-MM-DD.");
  }
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw releaseError("release_date_invalid", "Release date must be a real calendar date.");
  }
  return normalized;
}

function currentReleaseDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeRepositoryPath(value, label) {
  const source = String(value || "").replace(/\\/gu, "/");
  const normalized = path.posix.normalize(source);
  if (
    !source ||
    path.posix.isAbsolute(source) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw releaseError("release_path_invalid", `${label} must stay inside the repository.`);
  }
  return normalized.replace(/^\.\//u, "");
}

async function readTextRecord(rootDir, relativePath) {
  const normalizedPath = normalizeRepositoryPath(relativePath, "Release file");
  const absolutePath = path.join(rootDir, normalizedPath);
  try {
    const [text, stat] = await Promise.all([
      fs.readFile(absolutePath, "utf8"),
      fs.stat(absolutePath)
    ]);
    return {
      relativePath: normalizedPath,
      absolutePath,
      text,
      mode: stat.mode & 0o777
    };
  } catch (error) {
    throw releaseError(
      "release_file_read_failed",
      `Unable to read ${normalizedPath} (${String(error?.code || "unknown")}).`
    );
  }
}

async function readJsonRecord(rootDir, relativePath) {
  const record = await readTextRecord(rootDir, relativePath);
  try {
    return { ...record, value: JSON.parse(record.text) };
  } catch {
    throw releaseError(
      "release_json_invalid",
      `${record.relativePath} must contain valid JSON.`
    );
  }
}

function manifestPathForWorkspace(workspace) {
  const directory = normalizeRepositoryPath(workspace, "Workspace path");
  return `${directory}/package.json`;
}

async function loadReleaseState(rootDir) {
  const rootPackage = await readJsonRecord(rootDir, "package.json");
  const workspaces = rootPackage.value.workspaces;
  if (!Array.isArray(workspaces) || workspaces.some((workspace) => typeof workspace !== "string")) {
    throw releaseError(
      "release_workspaces_invalid",
      "package.json workspaces must be an explicit string array."
    );
  }

  const workspaceDirectories = workspaces.map((workspace) =>
    normalizeRepositoryPath(workspace, "Workspace path")
  );
  const manifestPaths = [
    "package.json",
    ...workspaceDirectories.map(manifestPathForWorkspace),
    GATEWAY_INSTALLER_MANIFEST
  ];
  if (new Set(manifestPaths).size !== manifestPaths.length) {
    throw releaseError("release_manifest_duplicate", "Release manifest paths must be unique.");
  }

  const manifestRecords = new Map();
  for (const manifestPath of manifestPaths) {
    manifestRecords.set(manifestPath, await readJsonRecord(rootDir, manifestPath));
  }

  const workspaceRecords = workspaceDirectories.map((directory) => ({
    directory,
    manifestPath: manifestPathForWorkspace(directory),
    record: manifestRecords.get(manifestPathForWorkspace(directory))
  }));
  const internalNames = new Set();
  for (const workspace of workspaceRecords) {
    const name = String(workspace.record.value.name || "");
    if (!name.startsWith("@lico/")) {
      throw releaseError(
        "release_workspace_name_invalid",
        `${workspace.manifestPath} must declare an @lico/* package name.`
      );
    }
    if (internalNames.has(name)) {
      throw releaseError("release_workspace_name_duplicate", `Duplicate workspace name: ${name}.`);
    }
    internalNames.add(name);
    workspace.name = name;
  }

  return {
    rootDir,
    rootPackage,
    manifestRecords,
    workspaceRecords,
    internalNames,
    packageLock: await readJsonRecord(rootDir, "package-lock.json"),
    changelog: await readTextRecord(rootDir, "CHANGELOG.md")
  };
}

function cloneJson(value) {
  return structuredClone(value);
}

function synchronizeInternalDependencies(value, version) {
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = value?.[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith("@lico/")) dependencies[name] = version;
    }
  }
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function changelogHeadingPatterns(version) {
  const escapedVersion = escapedRegExp(version);
  return {
    any: new RegExp(`^## \\[${escapedVersion}\\](?:[ \\t].*)?$`, "gmu"),
    valid: new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "gmu")
  };
}

function releaseHeadingCount(changelog, version) {
  const patterns = changelogHeadingPatterns(version);
  return {
    any: [...changelog.matchAll(patterns.any)].length,
    valid: [...changelog.matchAll(patterns.valid)].length
  };
}

function nextChangelog(text, version, date) {
  const counts = releaseHeadingCount(text, version);
  if (counts.valid === 1 && counts.any === 1) return text;
  if (counts.any > 0) {
    throw releaseError(
      "release_changelog_entry_invalid",
      `CHANGELOG.md has a malformed or duplicate ${version} release heading.`
    );
  }

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const unreleasedIndexes = lines
    .map((line, index) => line.trim() === "## Unreleased" ? index : -1)
    .filter((index) => index >= 0);
  if (unreleasedIndexes.length !== 1) {
    throw releaseError(
      "release_changelog_unreleased_invalid",
      "CHANGELOG.md must contain one ## Unreleased section."
    );
  }
  const start = unreleasedIndexes[0];
  let end = lines.findIndex((line, index) => index > start && /^##\s+/u.test(line));
  if (end < 0) end = lines.length;
  const existingBody = lines.slice(start + 1, end);
  while (existingBody[0]?.trim() === "") existingBody.shift();
  while (existingBody.at(-1)?.trim() === "") existingBody.pop();
  const normalizedBody = existingBody.join("\n").trim();
  const releaseBody = !normalizedBody || /^-?\s*No unreleased changes\.?$/iu.test(normalizedBody)
    ? ["- Synchronized package and lockfile metadata for this release."]
    : existingBody;
  const replacement = [
    "## Unreleased",
    "",
    "No unreleased changes.",
    "",
    `## [${version}] - ${date}`,
    "",
    ...releaseBody,
    ""
  ];
  lines.splice(start, end - start, ...replacement);
  return `${lines.join(newline).replace(/(?:\r?\n)*$/u, "")}${newline}`;
}

function addFinding(findings, pathName, code, detail) {
  findings.push({ path: pathName, code, detail });
}

function validateInternalDependencies({ value, relativePath }, version, internalNames, findings) {
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = value?.[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const [name, dependencyVersion] of Object.entries(dependencies)) {
      if (!name.startsWith("@lico/")) continue;
      if (!internalNames.has(name)) {
        addFinding(findings, relativePath, "release_internal_dependency_unknown", `${field}:${name}`);
      } else if (dependencyVersion !== version) {
        addFinding(findings, relativePath, "release_internal_dependency_version_mismatch", `${field}:${name}`);
      }
    }
  }
}

function collectReleaseFindings(state, version) {
  const findings = [];
  for (const record of state.manifestRecords.values()) {
    if (record.value.version !== version) {
      addFinding(findings, record.relativePath, "release_manifest_version_mismatch", "version");
    }
    validateInternalDependencies(record, version, state.internalNames, findings);
  }

  const lock = state.packageLock.value;
  if (lock.version !== version) {
    addFinding(findings, "package-lock.json", "release_lock_version_mismatch", "version");
  }
  const lockPackages = lock.packages;
  if (!lockPackages || typeof lockPackages !== "object" || Array.isArray(lockPackages)) {
    addFinding(findings, "package-lock.json", "release_lock_packages_missing", "packages");
  } else {
    const rootLock = lockPackages[""];
    if (!rootLock || rootLock.version !== version) {
      addFinding(findings, "package-lock.json", "release_lock_root_version_mismatch", "packages['']");
    }
    if (rootLock) {
      const rootWorkspaces = Array.isArray(rootLock.workspaces) ? rootLock.workspaces : [];
      const packageWorkspaces = state.workspaceRecords.map(({ directory }) => directory);
      if (JSON.stringify(rootWorkspaces) !== JSON.stringify(packageWorkspaces)) {
        addFinding(findings, "package-lock.json", "release_lock_workspaces_mismatch", "packages[''].workspaces");
      }
    }

    for (const [lockPath, entry] of Object.entries(lockPackages)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      validateInternalDependencies(
        { value: entry, relativePath: `package-lock.json#packages/${lockPath || "<root>"}` },
        version,
        state.internalNames,
        findings
      );
    }

    for (const workspace of state.workspaceRecords) {
      const workspaceEntry = lockPackages[workspace.directory];
      if (!workspaceEntry || workspaceEntry.version !== version) {
        addFinding(
          findings,
          "package-lock.json",
          "release_lock_workspace_version_mismatch",
          workspace.directory
        );
      }
      const nodeModulePath = `node_modules/${workspace.name}`;
      const nodeModuleEntry = lockPackages[nodeModulePath];
      if (!nodeModuleEntry) {
        addFinding(findings, "package-lock.json", "release_lock_node_module_missing", nodeModulePath);
      } else if (nodeModuleEntry.link === true) {
        if (nodeModuleEntry.resolved !== workspace.directory) {
          addFinding(findings, "package-lock.json", "release_lock_node_module_link_mismatch", nodeModulePath);
        }
      } else if (nodeModuleEntry.version !== version) {
        addFinding(findings, "package-lock.json", "release_lock_node_module_version_mismatch", nodeModulePath);
      }
    }
  }

  const headingCounts = releaseHeadingCount(state.changelog.text, version);
  if (headingCounts.any !== 1 || headingCounts.valid !== 1) {
    addFinding(findings, "CHANGELOG.md", "release_changelog_entry_missing", version);
  }
  return findings;
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function createDesiredFiles(state, version, date) {
  const desiredFiles = new Map();
  for (const record of state.manifestRecords.values()) {
    const next = cloneJson(record.value);
    next.version = version;
    synchronizeInternalDependencies(next, version);
    desiredFiles.set(record.relativePath, {
      ...record,
      value: next,
      desiredText: formatJson(next)
    });
  }

  const lock = cloneJson(state.packageLock.value);
  lock.version = version;
  if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    throw releaseError("release_lock_packages_missing", "package-lock.json must contain packages.");
  }
  if (!lock.packages[""]) {
    throw releaseError("release_lock_root_missing", "package-lock.json must contain a root package entry.");
  }
  lock.packages[""].version = version;
  lock.packages[""].workspaces = state.workspaceRecords.map(({ directory }) => directory);
  for (const entry of Object.values(lock.packages)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      synchronizeInternalDependencies(entry, version);
    }
  }
  for (const workspace of state.workspaceRecords) {
    const workspaceEntry = lock.packages[workspace.directory];
    if (!workspaceEntry) {
      throw releaseError(
        "release_lock_workspace_missing",
        `package-lock.json is missing ${workspace.directory}.`
      );
    }
    workspaceEntry.version = version;
    const nodeModuleEntry = lock.packages[`node_modules/${workspace.name}`];
    if (!nodeModuleEntry) {
      throw releaseError(
        "release_lock_node_module_missing",
        `package-lock.json is missing node_modules/${workspace.name}.`
      );
    }
    if (nodeModuleEntry.link !== true && typeof nodeModuleEntry.version === "string") {
      nodeModuleEntry.version = version;
    }
  }
  desiredFiles.set("package-lock.json", {
    ...state.packageLock,
    value: lock,
    desiredText: formatJson(lock)
  });
  desiredFiles.set("CHANGELOG.md", {
    ...state.changelog,
    desiredText: nextChangelog(state.changelog.text, version, date)
  });
  return desiredFiles;
}

async function writePreparedFiles(desiredFiles) {
  const token = `${process.pid}-${randomUUID()}`;
  const changes = [...desiredFiles.values()]
    .filter((record) => record.text !== record.desiredText)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const prepared = [];
  const committed = [];

  try {
    for (const record of changes) {
      const temporaryPath = `${record.absolutePath}.release-${token}.tmp`;
      await fs.writeFile(temporaryPath, record.desiredText, {
        encoding: "utf8",
        flag: "wx",
        mode: record.mode || 0o644
      });
      prepared.push({ ...record, temporaryPath });
    }
    for (const record of prepared) {
      const current = await fs.readFile(record.absolutePath, "utf8");
      if (current !== record.text) {
        throw releaseError(
          "release_concurrent_change",
          `${record.relativePath} changed while preparing the release.`
        );
      }
    }
    for (const record of prepared) {
      await fs.rename(record.temporaryPath, record.absolutePath);
      committed.push(record);
    }
    return changes.map(({ relativePath }) => relativePath);
  } catch (error) {
    let rollbackFailed = false;
    for (const record of committed.reverse()) {
      const rollbackPath = `${record.absolutePath}.release-${token}.rollback`;
      try {
        await fs.writeFile(rollbackPath, record.text, {
          encoding: "utf8",
          flag: "wx",
          mode: record.mode || 0o644
        });
        await fs.rename(rollbackPath, record.absolutePath);
      } catch {
        rollbackFailed = true;
        await fs.rm(rollbackPath, { force: true }).catch(() => {});
      }
    }
    if (rollbackFailed) {
      throw releaseError(
        "release_atomic_rollback_failed",
        "Release preparation could not restore every source file."
      );
    }
    if (error instanceof ReleasePreparationError) throw error;
    throw releaseError("release_atomic_write_failed", "Release preparation could not commit its file set.");
  } finally {
    await Promise.all(
      prepared.map(({ temporaryPath }) => fs.rm(temporaryPath, { force: true }).catch(() => {}))
    );
  }
}

function assertReleaseState(state, version) {
  const findings = collectReleaseFindings(state, version);
  if (findings.length > 0) {
    throw releaseError(
      "release_state_mismatch",
      `Release state does not match ${version}.`,
      findings
    );
  }
}

export async function prepareRelease({
  rootDir = process.cwd(),
  version,
  check = false,
  date = currentReleaseDate()
} = {}) {
  const normalizedVersion = assertReleaseVersion(version);
  const normalizedDate = assertReleaseDate(date);
  const resolvedRoot = path.resolve(rootDir);
  const state = await loadReleaseState(resolvedRoot);
  if (check) {
    assertReleaseState(state, normalizedVersion);
    return {
      ok: true,
      checked: "release-package-version",
      mode: "check",
      version: normalizedVersion,
      manifestCount: state.manifestRecords.size,
      workspaceCount: state.workspaceRecords.length,
      changedFiles: []
    };
  }

  const desiredFiles = createDesiredFiles(state, normalizedVersion, normalizedDate);
  const desiredState = {
    ...state,
    manifestRecords: new Map(
      [...state.manifestRecords.keys()].map((manifestPath) => [
        manifestPath,
        desiredFiles.get(manifestPath)
      ])
    ),
    packageLock: desiredFiles.get("package-lock.json"),
    changelog: {
      ...state.changelog,
      text: desiredFiles.get("CHANGELOG.md").desiredText
    }
  };
  assertReleaseState(desiredState, normalizedVersion);
  const changedFiles = await writePreparedFiles(desiredFiles);
  assertReleaseState(await loadReleaseState(resolvedRoot), normalizedVersion);
  return {
    ok: true,
    checked: "release-package-version",
    mode: "write",
    version: normalizedVersion,
    manifestCount: state.manifestRecords.size,
    workspaceCount: state.workspaceRecords.length,
    changedFiles
  };
}

function usage() {
  return [
    "Usage:",
    "  npm run release:prepare -- <semver>",
    "  npm run release:prepare -- --check <semver>",
    "  npm run release:prepare -- --check --tag v<semver>",
    "",
    "Options:",
    "  --check       Validate without writing files.",
    "  --tag TAG     Validate a v-prefixed release tag and use its version.",
    "  --date DATE   Use YYYY-MM-DD for a newly created changelog entry.",
    "  --help        Show this help."
  ].join("\n");
}

function optionValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw releaseError("release_argument_missing", `${option} requires a value.`);
  }
  return value;
}

export function parseReleaseArguments(argv) {
  const args = [...argv];
  let check = false;
  let version = "";
  let tag = "";
  let date = currentReleaseDate();
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      check = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--tag") {
      tag = optionValue(args, index, "--tag");
      index += 1;
    } else if (argument.startsWith("--tag=")) {
      tag = argument.slice("--tag=".length);
    } else if (argument === "--date") {
      date = optionValue(args, index, "--date");
      index += 1;
    } else if (argument.startsWith("--date=")) {
      date = argument.slice("--date=".length);
    } else if (argument.startsWith("-")) {
      throw releaseError("release_argument_unknown", `Unknown option: ${argument}.`);
    } else if (version) {
      throw releaseError("release_argument_duplicate", "Only one release version may be provided.");
    } else {
      version = argument;
    }
  }
  if (help) return { help: true, check, version: "", date };
  if (tag && version) {
    throw releaseError("release_argument_conflict", "Use either a version or --tag, not both.");
  }
  const resolvedVersion = tag ? releaseVersionFromTag(tag) : assertReleaseVersion(version);
  return { help: false, check, version: resolvedVersion, date: assertReleaseDate(date) };
}

async function main() {
  const options = parseReleaseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await prepareRelease(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    const normalized = error instanceof ReleasePreparationError
      ? error
      : releaseError("release_prepare_failed", "Release preparation failed.");
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: normalized.code,
      message: normalized.message,
      findings: normalized.findings
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
