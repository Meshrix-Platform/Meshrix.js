#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReleaseDefinition } from "./verify-release-definition.ts";

const GATEWAY_INSTALLER_MANIFEST: any =
  "packages/protocols/mcp/adapter/gateway-installer/package.json";
const DEPENDENCY_FIELDS: readonly any[] = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
]);
const RELEASE_SEMVER_PATTERN: any =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;

export class ReleasePreparationError extends Error {
  code: any;
  findings: any;
  name: any;
  constructor(code?: any, message?: any, findings: any = []) {
    super(message);
    this.name = "ReleasePreparationError";
    this.code = code;
    this.findings = findings;
  }
}

function releaseError(code?: any, message?: any, findings: any = []) : any {
  return new ReleasePreparationError(code, message, findings);
}

export function assertReleaseVersion(version?: any) : any {
  const normalized: any = String(version || "").trim();
  if (!RELEASE_SEMVER_PATTERN.test(normalized)) {
    throw releaseError(
      "release_version_invalid",
      "Release version must be valid SemVer without build metadata."
    );
  }
  return normalized;
}

export function releaseVersionFromTag(tag?: any) : any {
  const normalized: any = String(tag || "").trim();
  if (!normalized.startsWith("v")) {
    throw releaseError("release_tag_invalid", "Release tag must use the v<semver> form.");
  }
  const version: any = assertReleaseVersion(normalized.slice(1));
  if (normalized !== `v${version}`) {
    throw releaseError("release_tag_invalid", "Release tag must use the v<semver> form.");
  }
  return version;
}

function assertReleaseDate(value?: any) : any {
  const normalized: any = String(value || "").trim();
  const match: any = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(normalized);
  if (!match) {
    throw releaseError("release_date_invalid", "Release date must use YYYY-MM-DD.");
  }
  const date: any = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw releaseError("release_date_invalid", "Release date must be a real calendar date.");
  }
  return normalized;
}

function currentReleaseDate() : any {
  return new Date().toISOString().slice(0, 10);
}

function normalizeRepositoryPath(value?: any, label?: any) : any {
  const source: any = String(value || "").replace(/\\/gu, "/");
  const normalized: any = path.posix.normalize(source);
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

async function readTextRecord(rootDir?: any, relativePath?: any) : Promise<any> {
  const normalizedPath: any = normalizeRepositoryPath(relativePath, "Release file");
  const absolutePath: any = path.join(rootDir, normalizedPath);
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
  } catch (error: any) {
    throw releaseError(
      "release_file_read_failed",
      `Unable to read ${normalizedPath} (${String(error?.code || "unknown")}).`
    );
  }
}

async function readJsonRecord(rootDir?: any, relativePath?: any) : Promise<any> {
  const record: any = await readTextRecord(rootDir, relativePath);
  try {
    return { ...record, value: JSON.parse(record.text) };
  } catch {
    throw releaseError(
      "release_json_invalid",
      `${record.relativePath} must contain valid JSON.`
    );
  }
}

function manifestPathForWorkspace(workspace?: any) : any {
  const directory: any = normalizeRepositoryPath(workspace, "Workspace path");
  return `${directory}/package.json`;
}

async function loadReleaseState(rootDir?: any) : Promise<any> {
  const rootPackage: any = await readJsonRecord(rootDir, "package.json");
  const workspaces: any = rootPackage.value.workspaces;
  if (!Array.isArray(workspaces) || workspaces.some((workspace?: any) : any => typeof workspace !== "string")) {
    throw releaseError(
      "release_workspaces_invalid",
      "package.json workspaces must be an explicit string array."
    );
  }

  const workspaceDirectories: any = workspaces.map((workspace?: any) : any =>
    normalizeRepositoryPath(workspace, "Workspace path")
  );
  const manifestPaths: any[] = [
    "package.json",
    ...workspaceDirectories.map(manifestPathForWorkspace),
    GATEWAY_INSTALLER_MANIFEST
  ];
  if (new Set<any>(manifestPaths).size !== manifestPaths.length) {
    throw releaseError("release_manifest_duplicate", "Release manifest paths must be unique.");
  }

  const manifestRecords: any = new Map<any, any>();
  for (const manifestPath of manifestPaths) {
    manifestRecords.set(manifestPath, await readJsonRecord(rootDir, manifestPath));
  }

  const workspaceRecords: any = workspaceDirectories.map((directory?: any) : any => ({
    directory,
    manifestPath: manifestPathForWorkspace(directory),
    record: manifestRecords.get(manifestPathForWorkspace(directory))
  }));
  const internalNames: any = new Set<any>();
  for (const workspace of workspaceRecords) {
    const name: any = String(workspace.record.value.name || "");
    if (!name.startsWith("@meshrix/")) {
      throw releaseError(
        "release_workspace_name_invalid",
        `${workspace.manifestPath} must declare an @meshrix/* package name.`
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

function cloneJson(value?: any) : any {
  return structuredClone(value);
}

function synchronizeInternalDependencies(value?: any, version?: any) : any {
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies: any = value?.[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith("@meshrix/")) dependencies[name] = version;
    }
  }
}

function escapedRegExp(value?: any) : any {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function changelogHeadingPatterns(version?: any) : any {
  const escapedVersion: any = escapedRegExp(version);
  return {
    any: new RegExp(`^## \\[${escapedVersion}\\](?:[ \\t].*)?$`, "gmu"),
    valid: new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "gmu")
  };
}

function releaseHeadingCount(changelog?: any, version?: any) : any {
  const patterns: any = changelogHeadingPatterns(version);
  return {
    any: [...changelog.matchAll(patterns.any)].length,
    valid: [...changelog.matchAll(patterns.valid)].length
  };
}

function nextChangelog(text?: any, version?: any, date?: any) : any {
  const counts: any = releaseHeadingCount(text, version);
  if (counts.valid === 1 && counts.any === 1) return text;
  if (counts.any > 0) {
    throw releaseError(
      "release_changelog_entry_invalid",
      `CHANGELOG.md has a malformed or duplicate ${version} release heading.`
    );
  }

  const newline: any = text.includes("\r\n") ? "\r\n" : "\n";
  const lines: any = text.split(/\r?\n/u);
  const unreleasedIndexes: any = lines
    .map((line?: any, index?: any) : any => line.trim() === "## Unreleased" ? index : -1)
    .filter((index?: any) : any => index >= 0);
  if (unreleasedIndexes.length !== 1) {
    throw releaseError(
      "release_changelog_unreleased_invalid",
      "CHANGELOG.md must contain one ## Unreleased section."
    );
  }
  const start: any = unreleasedIndexes[0];
  let end: any = lines.findIndex((line?: any, index?: any) : any => index > start && /^##\s+/u.test(line));
  if (end < 0) end = lines.length;
  const existingBody: any = lines.slice(start + 1, end);
  while (existingBody[0]?.trim() === "") existingBody.shift();
  while (existingBody.at(-1)?.trim() === "") existingBody.pop();
  const normalizedBody: any = existingBody.join("\n").trim();
  const releaseBody: any = !normalizedBody || /^-?\s*No unreleased changes\.?$/iu.test(normalizedBody)
    ? ["- Synchronized package and lockfile metadata for this release."]
    : existingBody;
  const replacement: any[] = [
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

function addFinding(findings?: any, pathName?: any, code?: any, detail?: any) : any {
  findings.push({ path: pathName, code, detail });
}

function validateInternalDependencies({ value, relativePath }: Record<string, any>, version?: any, internalNames?: any, findings?: any) : any {
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies: any = value?.[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const [name, dependencyVersion] of (Object.entries(dependencies) as [string, any][])) {
      if (!name.startsWith("@meshrix/")) continue;
      if (!internalNames.has(name)) {
        addFinding(findings, relativePath, "release_internal_dependency_unknown", `${field}:${name}`);
      } else if (dependencyVersion !== version) {
        addFinding(findings, relativePath, "release_internal_dependency_version_mismatch", `${field}:${name}`);
      }
    }
  }
}

function collectReleaseFindings(state?: any, version?: any) : any {
  const findings: any[] = [];
  for (const record of state.manifestRecords.values()) {
    if (record.value.version !== version) {
      addFinding(findings, record.relativePath, "release_manifest_version_mismatch", "version");
    }
    validateInternalDependencies(record, version, state.internalNames, findings);
  }

  const lock: any = state.packageLock.value;
  if (lock.version !== version) {
    addFinding(findings, "package-lock.json", "release_lock_version_mismatch", "version");
  }
  const lockPackages: any = lock.packages;
  if (!lockPackages || typeof lockPackages !== "object" || Array.isArray(lockPackages)) {
    addFinding(findings, "package-lock.json", "release_lock_packages_missing", "packages");
  } else {
    const rootLock: any = lockPackages[""];
    if (!rootLock || rootLock.version !== version) {
      addFinding(findings, "package-lock.json", "release_lock_root_version_mismatch", "packages['']");
    }
    if (rootLock) {
      const rootWorkspaces: any = Array.isArray(rootLock.workspaces) ? rootLock.workspaces : [];
      const packageWorkspaces: any = state.workspaceRecords.map(({ directory }: Record<string, any>) : any => directory);
      if (JSON.stringify(rootWorkspaces) !== JSON.stringify(packageWorkspaces)) {
        addFinding(findings, "package-lock.json", "release_lock_workspaces_mismatch", "packages[''].workspaces");
      }
    }

    for (const [lockPath, entry] of (Object.entries(lockPackages) as [string, any][])) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      validateInternalDependencies(
        { value: entry, relativePath: `package-lock.json#packages/${lockPath || "<root>"}` },
        version,
        state.internalNames,
        findings
      );
    }

    for (const workspace of state.workspaceRecords) {
      const workspaceEntry: any = lockPackages[workspace.directory];
      if (!workspaceEntry || workspaceEntry.version !== version) {
        addFinding(
          findings,
          "package-lock.json",
          "release_lock_workspace_version_mismatch",
          workspace.directory
        );
      }
      const nodeModulePath: any = `node_modules/${workspace.name}`;
      const nodeModuleEntry: any = lockPackages[nodeModulePath];
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

  const headingCounts: any = releaseHeadingCount(state.changelog.text, version);
  if (headingCounts.any !== 1 || headingCounts.valid !== 1) {
    addFinding(findings, "CHANGELOG.md", "release_changelog_entry_missing", version);
  }
  return findings;
}

function formatJson(value?: any) : any {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function createDesiredFiles(state?: any, version?: any, date?: any) : any {
  const desiredFiles: any = new Map<any, any>();
  for (const record of state.manifestRecords.values()) {
    const next: any = cloneJson(record.value);
    next.version = version;
    synchronizeInternalDependencies(next, version);
    desiredFiles.set(record.relativePath, {
      ...record,
      value: next,
      desiredText: formatJson(next)
    });
  }

  const lock: any = cloneJson(state.packageLock.value);
  lock.version = version;
  if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    throw releaseError("release_lock_packages_missing", "package-lock.json must contain packages.");
  }
  if (!lock.packages[""]) {
    throw releaseError("release_lock_root_missing", "package-lock.json must contain a root package entry.");
  }
  lock.packages[""].version = version;
  lock.packages[""].workspaces = state.workspaceRecords.map(({ directory }: Record<string, any>) : any => directory);
  for (const entry of (Object.values(lock.packages) as any[])) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      synchronizeInternalDependencies(entry, version);
    }
  }
  for (const workspace of state.workspaceRecords) {
    const workspaceEntry: any = lock.packages[workspace.directory];
    if (!workspaceEntry) {
      throw releaseError(
        "release_lock_workspace_missing",
        `package-lock.json is missing ${workspace.directory}.`
      );
    }
    workspaceEntry.version = version;
    const nodeModuleEntry: any = lock.packages[`node_modules/${workspace.name}`];
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

async function writePreparedFiles(desiredFiles?: any) : Promise<any> {
  const token: any = `${process.pid}-${randomUUID()}`;
  const changes: any = [...desiredFiles.values()]
    .filter((record?: any) : any => record.text !== record.desiredText)
    .sort((left?: any, right?: any) : any => left.relativePath.localeCompare(right.relativePath));
  const prepared: any[] = [];
  const committed: any[] = [];

  try {
    for (const record of changes) {
      const temporaryPath: any = `${record.absolutePath}.release-${token}.tmp`;
      await fs.writeFile(temporaryPath, record.desiredText, {
        encoding: "utf8",
        flag: "wx",
        mode: record.mode || 0o644
      });
      prepared.push({ ...record, temporaryPath });
    }
    for (const record of prepared) {
      const current: any = await fs.readFile(record.absolutePath, "utf8");
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
    return changes.map(({ relativePath }: Record<string, any>) : any => relativePath);
  } catch (error: any) {
    let rollbackFailed: any = false;
    for (const record of committed.reverse()) {
      const rollbackPath: any = `${record.absolutePath}.release-${token}.rollback`;
      try {
        await fs.writeFile(rollbackPath, record.text, {
          encoding: "utf8",
          flag: "wx",
          mode: record.mode || 0o644
        });
        await fs.rename(rollbackPath, record.absolutePath);
      } catch {
        rollbackFailed = true;
        await fs.rm(rollbackPath, { force: true }).catch(() : any => {});
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
      prepared.map(({ temporaryPath }: Record<string, any>) : any => fs.rm(temporaryPath, { force: true }).catch(() : any => {}))
    );
  }
}

function assertReleaseState(state?: any, version?: any) : any {
  const findings: any = collectReleaseFindings(state, version);
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
}: Record<string, any> = {}) : Promise<any> {
  const definition: any = await loadReleaseDefinition(path.resolve(rootDir)).catch(() : any => null);
  const definedVersion: any = definition?.release?.version;
  const normalizedVersion: any = assertReleaseVersion(version || definedVersion);
  if (definedVersion && normalizedVersion !== definedVersion) {
    throw releaseError(
      "release_definition_version_mismatch",
      "Requested version must match tools/registry/release-definition.registry.json."
    );
  }
  const normalizedDate: any = assertReleaseDate(date);
  const resolvedRoot: any = path.resolve(rootDir);
  const state: any = await loadReleaseState(resolvedRoot);
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

  const desiredFiles: any = createDesiredFiles(state, normalizedVersion, normalizedDate);
  const desiredState: Record<string, any> = {
    ...state,
    manifestRecords: new Map<any, any>(
      [...state.manifestRecords.keys()].map((manifestPath?: any) : any => [
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
  const changedFiles: any = await writePreparedFiles(desiredFiles);
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

function usage() : any {
  return [
    "Usage:",
    "  npm run release:prepare",
    "  npm run release:prepare -- --check",
    "  npm run release:prepare -- --check --tag v<semver>",
    "",
    "Options:",
    "  --check       Validate without writing files.",
    "  --tag TAG     Validate that a v-prefixed tag matches the release definition.",
    "  --date DATE   Use YYYY-MM-DD for a newly created changelog entry.",
    "  --help        Show this help."
  ].join("\n");
}

function optionValue(args?: any, index?: any, option?: any) : any {
  const value: any = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw releaseError("release_argument_missing", `${option} requires a value.`);
  }
  return value;
}

export function parseReleaseArguments(argv?: any) : any {
  const args: any[] = [...argv];
  let check: any = false;
  let version: any = "";
  let tag: any = "";
  let date: any = currentReleaseDate();
  let help: any = false;
  for (let index: any = 0; index < args.length; index += 1) {
    const argument: any = args[index];
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
  const resolvedVersion: any = tag ? releaseVersionFromTag(tag) : (version ? assertReleaseVersion(version) : "");
  return { help: false, check, version: resolvedVersion, date: assertReleaseDate(date) };
}

async function main() : Promise<any> {
  const options: any = parseReleaseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result: any = await prepareRelease(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error?: any) : any => {
    const normalized: any = error instanceof ReleasePreparationError
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
