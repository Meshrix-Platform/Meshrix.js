import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const definitionPath: any = "tools/registry/release-definition.registry.json";
const AGENT_PLUGIN_WORKSPACE_PATTERN: any = "plugins/agents/*";
const AGENT_PLUGIN_WORKSPACE_DIRECTORY: any = "plugins/agents";
const RELEASE_SEMVER_PATTERN: any =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;

export class ReleaseMetadataError extends Error {
  code: any;
  findings: any;
  name: any;
  constructor(code?: any, message?: any, findings: any = []) {
    super(message);
    this.name = "ReleaseMetadataError";
    this.code = code;
    this.findings = findings;
  }
}

function releaseMetadataError(code?: any, message?: any, findings: any = []) : any {
  return new ReleaseMetadataError(code, message, findings);
}

export function assertReleaseVersion(version?: any) : any {
  const normalized: any = String(version || "").trim();
  if (!RELEASE_SEMVER_PATTERN.test(normalized)) {
    throw releaseMetadataError(
      "release_version_invalid",
      "Release version must be valid SemVer without build metadata."
    );
  }
  return normalized;
}

export function releaseVersionFromTag(tag?: any) : any {
  const normalized: any = String(tag || "").trim();
  if (!normalized.startsWith("v")) {
    throw releaseMetadataError("release_tag_invalid", "Release tag must use the v<semver> form.");
  }
  const version: any = assertReleaseVersion(normalized.slice(1));
  if (normalized !== `v${version}`) {
    throw releaseMetadataError("release_tag_invalid", "Release tag must use the v<semver> form.");
  }
  return version;
}

export async function loadReleaseDefinition(rootDir: any = repoRoot) : Promise<any> {
  const text: any = await fs.readFile(path.join(rootDir, definitionPath), "utf8");
  return JSON.parse(text);
}

function normalizeRelativeDirectory(value?: any) : any {
  const source: any = String(value || "").replace(/\\/gu, "/");
  const normalized: any = path.posix.normalize(source).replace(/^\.\//u, "");
  if (
    !source ||
    path.posix.isAbsolute(source) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    /[*?{}[\]]/u.test(normalized)
  ) {
    throw releaseMetadataError(
      "release_set_workspace_path_invalid",
      "Release workspaces must be explicit repository-relative directories."
    );
  }
  return normalized;
}

async function containsPackageManifest(repositoryRoot?: any, directory?: any) : Promise<any> {
  try {
    return (await fs.stat(path.join(repositoryRoot, directory, "package.json"))).isFile();
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw releaseMetadataError(
      "release_set_manifest_invalid",
      "Every release-set directory must contain a readable package manifest."
    );
  }
}

export async function resolveReleaseWorkspaceDirectories({
  rootDir = process.cwd(),
  workspaces
}: Record<string, any> = {}) : Promise<any> {
  if (!Array.isArray(workspaces) || workspaces.some((workspace?: any) : any => typeof workspace !== "string")) {
    throw releaseMetadataError(
      "release_set_workspaces_invalid",
      "The root package must declare a workspace directory array."
    );
  }

  const repositoryRoot: any = path.resolve(rootDir);
  const directories: any[] = [];
  for (const workspace of workspaces) {
    if (workspace !== AGENT_PLUGIN_WORKSPACE_PATTERN) {
      directories.push(normalizeRelativeDirectory(workspace));
      continue;
    }

    let entries: any[];
    try {
      entries = await fs.readdir(path.join(repositoryRoot, AGENT_PLUGIN_WORKSPACE_DIRECTORY), {
        withFileTypes: true
      });
    } catch {
      throw releaseMetadataError(
        "release_set_workspace_path_invalid",
        "The agent plugin workspace boundary must resolve to repository package directories."
      );
    }
    const matches: any[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory: any = `${AGENT_PLUGIN_WORKSPACE_DIRECTORY}/${entry.name}`;
      if (await containsPackageManifest(repositoryRoot, directory)) matches.push(directory);
    }
    if (matches.length === 0) {
      throw releaseMetadataError(
        "release_set_workspace_path_invalid",
        "The agent plugin workspace boundary must resolve to repository package directories."
      );
    }
    directories.push(...matches.sort((left?: any, right?: any) : any => left.localeCompare(right)));
  }

  if (new Set<any>(directories).size !== directories.length) {
    throw releaseMetadataError(
      "release_set_workspace_duplicate",
      "Release-set package directories must be unique."
    );
  }
  return directories;
}
