#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  npmCliArgs,
  parseNpmExactViewJson,
  parseNpmPackJson,
  resolveNpmCliInvocation
} from "./lib/npm-cli-invocation.ts";
import { assertReleaseVersion, resolveReleaseWorkspaceDirectories } from "./lib/release-metadata.ts";

const execFileAsync: any = promisify(execFile);
const OFFICIAL_NPM_REGISTRY: any = "https://registry.npmjs.org/";
export const PREPARED_RELEASE_SET_FILENAME: any = "meshrix-release-set.json";
const PREPARED_RELEASE_SET_SCHEMA: any = "meshrix.npm-release-set/v1";
const PREPARATION_OWNERSHIP_FILENAME: any = ".meshrix-release-set-preparation.json";
const PREPARATION_OWNERSHIP_SCHEMA: any = "meshrix.npm-release-set-preparation/v1";
const DEPENDENCY_FIELDS: readonly any[] = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
]);
const PACKAGE_NAME_PATTERN: any =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const INTEGRITY_PATTERN: any = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const MAX_COMMAND_OUTPUT_BYTES: any = 16 * 1024 * 1024;

export class ReleaseSetPublicationError extends Error {
  code: any;
  name: any;
  constructor(code?: any, message?: any) {
    super(message);
    this.name = "ReleaseSetPublicationError";
    this.code = code;
  }
}

function publicationError(code?: any, message?: any) : any {
  return new ReleaseSetPublicationError(code, message);
}

function normalizeReleaseVersion(value?: any) : any {
  try {
    return assertReleaseVersion(value);
  } catch {
    throw publicationError(
      "release_set_version_invalid",
      "Every release-set package must use the root release version."
    );
  }
}

function normalizePackageName(value?: any) : any {
  const name: any = String(value || "");
  if (!PACKAGE_NAME_PATTERN.test(name) || name.length > 214) {
    throw publicationError(
      "release_set_package_name_invalid",
      "Every release-set package must use a valid npm package name."
    );
  }
  return name;
}

async function readManifest(repositoryRoot?: any, directory?: any, { root = false }: Record<string, any> = {}) : Promise<any> {
  const manifestPath: any = root
    ? path.join(repositoryRoot, "package.json")
    : path.join(repositoryRoot, directory, "package.json");
  let manifest: any;
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

function internalDependencyNames(manifest?: any) : any {
  const names: any = new Set<any>();
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies: any = manifest?.[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith("@meshrix/")) names.add(name);
    }
  }
  return [...names].sort((left?: any, right?: any) : any => left.localeCompare(right));
}

function bundleDependencyNames(manifest?: any) : any {
  const current: any = manifest?.bundleDependencies;
  const legacy: any = manifest?.bundledDependencies;
  const declarations: any[] = [current, legacy].filter((value?: any) : any => value !== undefined);
  if (declarations.length === 0) return new Set<any>();
  if (declarations.some((value?: any) : any => !Array.isArray(value))) {
    throw publicationError(
      "release_set_bundle_dependencies_invalid",
      "Private first-party bundles must be declared as an explicit package-name array."
    );
  }

  const normalized: any[][] = declarations.map((value?: any) : any => value.map((name?: any) : any => {
    const packageName: any = normalizePackageName(name);
    if (!packageName.startsWith("@meshrix/")) {
      throw publicationError(
        "release_set_bundle_dependency_invalid",
        "Release products may bundle only declared private first-party packages."
      );
    }
    return packageName;
  }));
  const unique: any[] = [...new Set<any>(normalized[0])];
  if (
    unique.length !== normalized[0].length ||
    normalized.some((value: any[]) : any => (
      value.length !== unique.length || [...value].sort().join("\n") !== [...unique].sort().join("\n")
    ))
  ) {
    throw publicationError(
      "release_set_bundle_dependencies_invalid",
      "A release product must declare each private first-party bundle exactly once."
    );
  }
  return new Set<any>(unique);
}

function dependencyVersions(manifest?: any, dependencyName?: any) : any[] {
  return DEPENDENCY_FIELDS.flatMap((field?: any) : any[] => {
    const dependencies: any = manifest?.[field];
    return dependencies && typeof dependencies === "object" && !Array.isArray(dependencies) &&
      Object.hasOwn(dependencies, dependencyName)
      ? [{ field, version: dependencies[dependencyName] }]
      : [];
  });
}

function compareReadyPackages(left?: any, right?: any) : any {
  if (left.root !== right.root) return left.root ? 1 : -1;
  return left.name.localeCompare(right.name);
}

export function topologicallyOrderReleaseSet(packages?: any, {
  privatePackages = [],
  version
}: Record<string, any> = {}) : any {
  const byName: any = new Map<any, any>();
  for (const packageRecord of packages) {
    if (byName.has(packageRecord.name)) {
      throw publicationError(
        "release_set_package_name_duplicate",
        "Release-set package names must be unique."
      );
    }
    byName.set(packageRecord.name, packageRecord);
  }

  const privateByName: any = new Map<any, any>();
  for (const packageRecord of privatePackages) {
    if (privateByName.has(packageRecord.name) || byName.has(packageRecord.name)) {
      throw publicationError(
        "release_set_package_name_duplicate",
        "Workspace package names must be unique across public and private packages."
      );
    }
    privateByName.set(packageRecord.name, packageRecord);
  }

  const rootPackage: any = packages.find(({ root }: Record<string, any>) : any => root);
  const releaseVersion: any = version || rootPackage?.version;
  const bundleNamesByPackage: any = new Map<any, any>();
  for (const packageRecord of packages) {
    const bundleNames: any = bundleDependencyNames(packageRecord.manifest);
    bundleNamesByPackage.set(packageRecord.name, bundleNames);

    const runtimeDependencies: any = new Set<any>([
      ...Object.keys(packageRecord.manifest?.dependencies || {}),
      ...Object.keys(packageRecord.manifest?.optionalDependencies || {})
    ]);
    for (const dependencyName of bundleNames) {
      const privatePackage: any = privateByName.get(dependencyName);
      if (!privatePackage || privatePackage.manifest?.private !== true) {
        throw publicationError(
          "release_set_bundle_dependency_missing",
          "Every declared first-party bundle must resolve to a private workspace package."
        );
      }
      if (!runtimeDependencies.has(dependencyName)) {
        throw publicationError(
          "release_set_bundle_dependency_invalid",
          "A private bundle must also be a direct runtime or optional dependency of its product."
        );
      }
      const privateVersion: any = normalizeReleaseVersion(privatePackage.manifest.version);
      if (releaseVersion && privateVersion !== releaseVersion) {
        throw publicationError(
          "release_set_internal_dependency_invalid",
          "Every bundled private first-party package must match the release version."
        );
      }
    }
  }

  const dependents: any = new Map<any, any>([...byName.keys()].map((name?: any) : any => [name, new Set<any>()]));
  const indegree: any = new Map<any, any>([...byName.keys()].map((name?: any) : any => [name, 0]));
  for (const packageRecord of packages) {
    for (const dependencyName of internalDependencyNames(packageRecord.manifest)) {
      const privatePackage: any = privateByName.get(dependencyName);
      const bundleNames: any = bundleNamesByPackage.get(packageRecord.name);
      const versions: any[] = dependencyVersions(packageRecord.manifest, dependencyName);
      if (releaseVersion && versions.some(({ version: dependencyVersion }: Record<string, any>) : any => (
        dependencyVersion !== releaseVersion
      ))) {
        throw publicationError(
          "release_set_internal_dependency_invalid",
          "Internal @meshrix dependencies must be locked to the release version."
        );
      }
      if (!byName.has(dependencyName) && !bundleNames.has(dependencyName)) {
        throw publicationError(
          "release_set_internal_dependency_missing",
          "Every private first-party runtime dependency must be explicitly bundled by its public product."
        );
      }
      if (!byName.has(dependencyName) && !privatePackage) {
        throw publicationError(
          "release_set_internal_dependency_missing",
          "Every bundled first-party dependency must resolve to a private workspace package."
        );
      }
      if (!byName.has(dependencyName) && privatePackage.manifest?.private !== true) {
        throw publicationError(
          "release_set_internal_dependency_invalid",
          "A first-party bundle may not replace an independently public workspace package."
        );
      }
      if (byName.has(dependencyName) && !dependents.get(dependencyName).has(packageRecord.name)) {
        dependents.get(dependencyName).add(packageRecord.name);
        indegree.set(packageRecord.name, indegree.get(packageRecord.name) + 1);
      }
    }
  }

  const ready: any = packages
    .filter(({ name }: Record<string, any>) : any => indegree.get(name) === 0)
    .sort(compareReadyPackages);
  const ordered: any[] = [];
  while (ready.length > 0) {
    const current: any = ready.shift();
    ordered.push(current);
    for (const dependentName of [...dependents.get(current.name)].sort()) {
      const nextIndegree: any = indegree.get(dependentName) - 1;
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

export async function discoverReleaseSet({ rootDir = process.cwd() }: Record<string, any> = {}) : Promise<any> {
  const repositoryRoot: any = path.resolve(rootDir);
  const rootPackage: any = await readManifest(repositoryRoot, ".", { root: true });
  const version: any = normalizeReleaseVersion(rootPackage.manifest.version);
  const workspaceDirectories: any = await resolveReleaseWorkspaceDirectories({
    rootDir: repositoryRoot,
    workspaces: rootPackage.manifest.workspaces
  });
  const candidates: any[] = [];
  const privatePackages: any[] = [];
  for (const directory of workspaceDirectories) {
    const packageRecord: any = await readManifest(repositoryRoot, directory);
    if (packageRecord.manifest.private === true) {
      privatePackages.push({ ...packageRecord, version: packageRecord.manifest.version });
      continue;
    }
    const packageVersion: any = normalizeReleaseVersion(packageRecord.manifest.version);
    if (packageVersion !== version) {
      throw publicationError(
        "release_set_version_mismatch",
        "Every public workspace package must match the root release version."
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

  const ordered: any = topologicallyOrderReleaseSet(candidates, { privatePackages, version });

  return { repositoryRoot, version, packages: ordered, privatePackages };
}

export function releaseTagForVersion(version?: any) : any {
  const normalized: any = normalizeReleaseVersion(version);
  return normalized.split("+", 1)[0].includes("-") ? "next" : "latest";
}

function normalizeRequestedTag(version?: any, requestedTag?: any) : any {
  const expected: any = releaseTagForVersion(version);
  const normalized: any = requestedTag === undefined ? expected : String(requestedTag);
  if (!new Set<any>(["latest", "next"]).has(normalized) || normalized !== expected) {
    throw publicationError(
      "release_set_tag_invalid",
      "The npm dist-tag must be latest for stable releases and next for prereleases."
    );
  }
  return normalized;
}

export function createNpmRunner({
  environment = process.env,
  exec = execFileAsync
}: Record<string, any> = {}) : any {
  const invocation: any = resolveNpmCliInvocation({ env: environment });
  return async (args: any, { cwd }: Record<string, any> = {}) : Promise<any> => {
    const publishing: any = args[0] === "publish";
    try {
      const result: any = await exec(
        invocation.command,
        npmCliArgs(invocation, args),
        {
          cwd,
          encoding: "utf8",
          env: { ...environment },
          maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
          windowsHide: true
        }
      );
      return {
        exitCode: 0,
        stdout: publishing ? "" : result.stdout || "",
        stderr: publishing ? "" : result.stderr || ""
      };
    } catch (error: any) {
      return {
        exitCode: typeof error?.code === "number" ? error.code : 1,
        stdout: publishing ? "" : String(error?.stdout || ""),
        stderr: publishing ? "" : String(error?.stderr || "")
      };
    }
  };
}

function assertSuccessfulResult(result?: any, code?: any, message?: any) : any {
  if (!result || result.exitCode !== 0) throw publicationError(code, message);
  return result;
}

function parsePackArtifact(stdout?: any, packageRecord?: any, expectedBundles?: any[]) : any {
  let artifacts: any;
  try {
    artifacts = parseNpmPackJson(stdout);
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
  const artifact: any = artifacts[0];
  const filename: any = String(artifact?.filename || "");
  const integrity: any = String(artifact?.integrity || "");
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
  if (expectedBundles && expectedBundles.some((name?: any) : any => (
    !Array.isArray(artifact.bundled) || !artifact.bundled.includes(name)
  ))) {
    throw publicationError(
      "release_set_pack_bundle_missing",
      "npm pack did not include every declared private first-party bundle."
    );
  }
  return { filename, integrity };
}

function parsePackFilePaths(stdout?: any, packageRecord?: any) : any[] {
  let artifacts: any;
  try {
    artifacts = parseNpmPackJson(stdout);
  } catch {
    throw publicationError(
      "release_set_bundle_file_list_invalid",
      "npm pack did not return a valid package file list."
    );
  }
  const artifact: any = artifacts?.[0];
  if (
    artifacts.length !== 1 ||
    artifact?.name !== packageRecord.name ||
    artifact?.version !== packageRecord.version ||
    !Array.isArray(artifact.files)
  ) {
    throw publicationError(
      "release_set_bundle_file_list_invalid",
      "npm pack did not return a valid package file list."
    );
  }

  const paths: any[] = [];
  const seen: any = new Set<any>();
  for (const file of artifact.files) {
    const rawPath: any = String(file?.path || "").replace(/\\/gu, "/");
    const relativePath: any = path.posix.normalize(rawPath);
    if (
      !rawPath ||
      path.posix.isAbsolute(rawPath) ||
      relativePath !== rawPath ||
      relativePath === "." ||
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      relativePath.split("/").includes("node_modules") ||
      seen.has(relativePath)
    ) {
      throw publicationError(
        "release_set_bundle_file_list_invalid",
        "npm pack returned an unsafe or duplicate package file path."
      );
    }
    seen.add(relativePath);
    paths.push(relativePath);
  }
  if (!seen.has("package.json")) {
    throw publicationError(
      "release_set_bundle_file_list_invalid",
      "npm pack did not include the required package manifest."
    );
  }
  return paths;
}

async function copyNpmPackageFiles(packageRecord?: any, destination?: any, commandDirectory?: any, runner?: any) : Promise<any> {
  const sourceDirectory: any = path.resolve(packageRecord.absoluteDirectory);
  const listing: any = assertSuccessfulResult(
    await runner(
      ["pack", "--dry-run", "--json", "--ignore-scripts", sourceDirectory],
      { cwd: commandDirectory }
    ),
    "release_set_bundle_file_list_failed",
    "A declared private bundle could not be inspected with npm pack."
  );
  const filePaths: any[] = parsePackFilePaths(listing.stdout, packageRecord);
  await fs.mkdir(destination, { recursive: true });
  for (const filePath of filePaths) {
    const sourcePath: any = path.resolve(sourceDirectory, ...filePath.split("/"));
    const relativeSource: any = path.relative(sourceDirectory, sourcePath);
    if (
      !relativeSource ||
      relativeSource.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeSource)
    ) {
      throw publicationError(
        "release_set_bundle_file_list_invalid",
        "npm pack returned a file outside the declared package."
      );
    }
    const targetPath: any = path.join(destination, ...filePath.split("/"));
    let sourceStat: any;
    try {
      sourceStat = await fs.lstat(sourcePath);
    } catch {
      throw publicationError(
        "release_set_bundle_source_file_missing",
        "A file selected by npm pack is missing from the declared package."
      );
    }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw publicationError(
        "release_set_bundle_source_file_invalid",
        "npm pack selected a package entry that is not a regular file."
      );
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
    await fs.chmod(targetPath, sourceStat.mode & 0o777);
  }
}

async function prepareLeafPackageDirectory(
  packageRecord?: any,
  privatePackages: any[] = [],
  commandDirectory?: any,
  runner?: any
) : Promise<any> {
  const privateByName: any = new Map<any, any>(privatePackages.map((record?: any) : any => [record.name, record]));
  const bundleNames: any[] = [...bundleDependencyNames(packageRecord.manifest)];
  const stagingDirectory: any = path.join(commandDirectory, `leaf-${packageRecord.name.replace(/[^a-z0-9-]+/giu, "-")}`);
  await copyNpmPackageFiles(packageRecord, stagingDirectory, commandDirectory, runner);
  for (const bundleName of bundleNames) {
    const bundleRecord: any = privateByName.get(bundleName);
    if (!bundleRecord || bundleRecord.manifest?.private !== true) {
      throw publicationError(
        "release_set_bundle_dependency_missing",
        "Every declared private bundle must resolve to its private workspace source."
      );
    }
    const bundleDirectory: any = path.join(stagingDirectory, "node_modules", ...bundleName.split("/"));
    await copyNpmPackageFiles(bundleRecord, bundleDirectory, commandDirectory, runner);
  }
  return { directory: stagingDirectory, bundleNames };
}

async function packReleaseSet(
  packages?: any,
  packDirectory?: any,
  commandDirectory?: any,
  runner?: any,
  createdTarballs: any[] = [],
  privatePackages: any[] = []
) : Promise<any> {
  const packed: any[] = [];
  for (const packageRecord of packages) {
    const leafDirectory: any = !packageRecord.root && bundleDependencyNames(packageRecord.manifest).size > 0
      ? await prepareLeafPackageDirectory(packageRecord, privatePackages, commandDirectory, runner)
      : null;
    const result: any = assertSuccessfulResult(
      await runner(
        leafDirectory
          ? [
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            packDirectory
          ]
          : [
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            packDirectory,
            packageRecord.absoluteDirectory
          ],
        { cwd: leafDirectory?.directory || commandDirectory }
      ),
      "release_set_pack_failed",
      "A release-set package could not be packed."
    );
    const artifact: any = parsePackArtifact(result.stdout, packageRecord, leafDirectory?.bundleNames);
    const tarballPath: any = path.join(packDirectory, artifact.filename);
    createdTarballs.push(tarballPath);
    let tarballStat: any;
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

async function ensureArtifactDirectory(artifactDirectory?: any) : Promise<any> {
  if (!artifactDirectory) {
    throw publicationError(
      "release_set_artifact_directory_missing",
      "An explicit prepared-artifact directory is required."
    );
  }
  const resolved: any = path.resolve(artifactDirectory);
  try {
    await fs.mkdir(resolved, { recursive: true });
  } catch {
    throw publicationError(
      "release_set_artifact_directory_invalid",
      "The prepared-artifact directory could not be opened."
    );
  }
  let stat: any;
  try {
    stat = await fs.lstat(resolved);
  } catch {
    throw publicationError(
      "release_set_artifact_directory_invalid",
      "The prepared-artifact directory could not be opened."
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw publicationError(
      "release_set_artifact_directory_invalid",
      "The prepared-artifact path must be a directory."
    );
  }
  return resolved;
}

async function sha512IntegrityForFile(filePath?: any) : Promise<any> {
  const hash: any = createHash("sha512");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return `sha512-${hash.digest("base64")}`;
}

function hasExactObjectKeys(value?: any, expected: any[] = []) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual: any[] = Object.keys(value).sort();
  const required: any[] = [...expected].sort();
  return actual.length === expected.length && actual.every((key?: any, index?: any) : any => (
    key === required[index]
  ));
}

function preparedArchiveFilename(name?: any, version?: any) : any {
  return `${String(name).replace(/^@/u, "").replace(/\//gu, "-")}-${version}.tgz`;
}

function expectedPreparedRows(releaseSet?: any, version: any = releaseSet?.version) : any[] {
  return releaseSet.packages.map(({ name }: Record<string, any>) : any => ({
    name,
    version,
    filename: preparedArchiveFilename(name, version)
  }));
}

function validOwnedArtifactRows(value?: any, releaseSet?: any, version?: any, { integrity = false } = {}) : any {
  const expected: any[] = expectedPreparedRows(releaseSet, version);
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  return value.every((row: any, index: number) : any => {
    const keys: string[] = integrity
      ? ["name", "version", "filename", "integrity"]
      : ["name", "version", "filename"];
    return hasExactObjectKeys(row, keys) &&
      row.name === expected[index].name &&
      row.version === expected[index].version &&
      row.filename === expected[index].filename &&
      (!integrity || INTEGRITY_PATTERN.test(String(row.integrity || "")));
  });
}

function isOwnedVersion(value?: any) : any {
  try {
    return assertReleaseVersion(value) === value;
  } catch {
    return false;
  }
}

function isCanonicalReleaseTag(version?: any, tag?: any) : any {
  try {
    return normalizeRequestedTag(version, tag) === tag;
  } catch {
    return false;
  }
}

function validPreparationMarker(marker?: any, releaseSet?: any) : any {
  if (
    !hasExactObjectKeys(marker, ["schemaVersion", "version", "tag", "processId", "packages"]) ||
    marker.schemaVersion !== PREPARATION_OWNERSHIP_SCHEMA ||
    !isOwnedVersion(marker.version) ||
    !Number.isSafeInteger(marker.processId) ||
    marker.processId < 1 ||
    !isCanonicalReleaseTag(marker.version, marker.tag)
  ) {
    return false;
  }
  return validOwnedArtifactRows(marker.packages, releaseSet, marker.version);
}

function validPreparedOwnershipManifest(manifest?: any, releaseSet?: any) : any {
  if (
    !hasExactObjectKeys(manifest, ["schemaVersion", "version", "tag", "packages"]) ||
    manifest.schemaVersion !== PREPARED_RELEASE_SET_SCHEMA ||
    !isOwnedVersion(manifest.version) ||
    !isCanonicalReleaseTag(manifest.version, manifest.tag)
  ) {
    return false;
  }
  return validOwnedArtifactRows(manifest.packages, releaseSet, manifest.version, { integrity: true });
}

async function readRegularJsonFile(directory?: any, filename?: any) : Promise<any> {
  const filePath: any = path.join(directory, filename);
  let stat: any;
  try {
    stat = await fs.lstat(filePath);
  } catch {
    return { exists: false, value: null };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { exists: true, value: null };
  try {
    return { exists: true, value: JSON.parse(await fs.readFile(filePath, "utf8")) };
  } catch {
    return { exists: true, value: null };
  }
}

async function removeOwnedPreparationFiles(directory?: any, releaseSet?: any) : Promise<any> {
  const entries: string[] = await fs.readdir(directory);
  if (entries.length === 0) return;

  const markerFile: any = await readRegularJsonFile(directory, PREPARATION_OWNERSHIP_FILENAME);
  const manifestFile: any = await readRegularJsonFile(directory, PREPARED_RELEASE_SET_FILENAME);
  const marker: any = markerFile.value;
  const manifest: any = manifestFile.value;
  const markerOwned: any = markerFile.exists && validPreparationMarker(marker, releaseSet);
  const manifestOwned: any = manifestFile.exists && validPreparedOwnershipManifest(manifest, releaseSet);
  if (markerOwned && isProcessRunning(marker.processId)) {
    throw publicationError(
      "release_set_preparation_in_progress",
      "Another release-set preparation still owns this artifact directory."
    );
  }
  if (!markerOwned && !manifestOwned) {
    throw publicationError(
      "release_set_artifact_directory_not_empty",
      "A non-empty artifact directory can be rebuilt only when its release-set output is identifiable."
    );
  }
  if (markerOwned && manifestOwned && (
    marker.version !== manifest.version ||
    marker.tag !== manifest.tag ||
    marker.packages.some((row: any, index: number) : any => (
      row.name !== manifest.packages[index]?.name ||
      row.version !== manifest.packages[index]?.version ||
      row.filename !== manifest.packages[index]?.filename
    ))
  )) {
    throw publicationError(
      "release_set_artifact_directory_not_empty",
      "A non-empty artifact directory contains conflicting release-set ownership records."
    );
  }

  const ownedRows: any[] = markerOwned ? marker.packages : manifest.packages;
  const ownedNames: any = new Set<any>([
    PREPARED_RELEASE_SET_FILENAME,
    ...(markerOwned ? [PREPARATION_OWNERSHIP_FILENAME] : []),
    ...ownedRows.map(({ filename }: Record<string, any>) : any => filename)
  ]);
  if (entries.some((entry?: any) : any => !ownedNames.has(entry))) {
    throw publicationError(
      "release_set_artifact_directory_not_empty",
      "A non-empty artifact directory contains files outside the prepared release set."
    );
  }
  for (const entry of entries) {
    const filePath: any = path.join(directory, entry);
    const stat: any = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw publicationError(
        "release_set_artifact_directory_not_empty",
        "A release-set output path is not a regular file and cannot be safely rebuilt."
      );
    }
  }

  await Promise.all(entries.map((entry?: any) : Promise<any> => fs.rm(path.join(directory, entry))));
}

async function removeOwnedRegularFile(directory?: any, filename?: any) : Promise<any> {
  const filePath: any = path.join(directory, filename);
  try {
    const stat: any = await fs.lstat(filePath);
    if (stat.isFile() && !stat.isSymbolicLink()) await fs.rm(filePath);
  } catch {
    return;
  }
}

function isProcessRunning(processId?: any) : any {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}

async function writePreparationMarker(directory?: any, releaseSet?: any, tag?: any) : Promise<any> {
  const markerPath: any = path.join(directory, PREPARATION_OWNERSHIP_FILENAME);
  const marker: any = {
    schemaVersion: PREPARATION_OWNERSHIP_SCHEMA,
    version: releaseSet.version,
    tag,
    processId: process.pid,
    packages: expectedPreparedRows(releaseSet)
  };
  const handle: any = await fs.open(markerPath, "wx", 0o600);
  let writeError: any = null;
  try {
    await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
  } catch (error) {
    writeError = error;
  } finally {
    await handle.close();
  }
  if (writeError) {
    await removeOwnedRegularFile(directory, PREPARATION_OWNERSHIP_FILENAME);
    throw writeError;
  }
}

function validatePreparedArtifactRow(row?: any, packageRecord?: any) : any {
  if (!hasExactObjectKeys(row, ["name", "version", "filename", "integrity"])) {
    throw publicationError(
      "release_set_prepared_manifest_invalid",
      "The prepared release manifest contains an invalid package record."
    );
  }
  if (
    row.name !== packageRecord.name ||
    row.version !== packageRecord.version ||
    !PACKAGE_NAME_PATTERN.test(String(row.name || "")) ||
    !INTEGRITY_PATTERN.test(String(row.integrity || ""))
  ) {
    throw publicationError(
      "release_set_prepared_manifest_mismatch",
      "The prepared release manifest does not match the canonical release set."
    );
  }
  const filename: any = String(row.filename || "");
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    path.isAbsolute(filename) ||
    filename.includes("/") ||
    filename.includes("\\") ||
    !filename.endsWith(".tgz")
  ) {
    throw publicationError(
      "release_set_prepared_archive_invalid",
      "Prepared release archives must use relative tarball filenames."
    );
  }
  return { filename, integrity: row.integrity };
}

async function assertPreparedArchiveIntegrity(packageRecord?: any) : Promise<any> {
  let archiveStat: any;
  try {
    archiveStat = await fs.lstat(packageRecord.tarballPath);
  } catch {
    throw publicationError(
      "release_set_tarball_missing",
      "A prepared release archive is missing."
    );
  }
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
    throw publicationError(
      "release_set_prepared_archive_invalid",
      "Prepared release archives must be regular files."
    );
  }
  let actualIntegrity: any;
  try {
    actualIntegrity = await sha512IntegrityForFile(packageRecord.tarballPath);
  } catch {
    throw publicationError(
      "release_set_prepared_archive_invalid",
      "A prepared release archive could not be read."
    );
  }
  if (actualIntegrity !== packageRecord.integrity) {
    throw publicationError(
      "release_set_prepared_archive_integrity_mismatch",
      "A prepared release archive does not match npm's recorded integrity."
    );
  }
}

export interface PreparedReleaseArtifact {
  name: string;
  version: string;
  filename: string;
  integrity: string;
  tarballPath: string;
  [key: string]: any;
}

export interface PreparedReleaseSet {
  repositoryRoot: string;
  artifactDirectory: string;
  version: string;
  tag: string;
  packages: PreparedReleaseArtifact[];
}

export async function prepareReleaseSet({
  rootDir = process.cwd(),
  artifactDirectory,
  tag: requestedTag,
  runner,
  environment = process.env
}: Record<string, any> = {}) : Promise<any> {
  const releaseSet: any = await discoverReleaseSet({ rootDir });
  const tag: any = normalizeRequestedTag(releaseSet.version, requestedTag);
  const destination: any = await ensureArtifactDirectory(artifactDirectory);
  // Explicit preparation always packs current source/build inputs. A valid archive
  // proves its own bytes, not freshness against an unpublished source revision.
  const manifestPath: any = path.join(destination, PREPARED_RELEASE_SET_FILENAME);
  let commandDirectory: any = null;
  let preparationMarkerWritten: any = false;
  try {
    await removeOwnedPreparationFiles(destination, releaseSet);
    await writePreparationMarker(destination, releaseSet, tag);
    preparationMarkerWritten = true;
    const commandRunner: any = runner || createNpmRunner({ environment });
    commandDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-npm-prepare-"));
    const packed: any = await packReleaseSet(
      releaseSet.packages,
      destination,
      commandDirectory,
      commandRunner,
      [],
      releaseSet.privatePackages
    );
    const expectedRows: any[] = expectedPreparedRows(releaseSet);
    if (packed.some((packageRecord: any, index: number) : any => (
      packageRecord.filename !== expectedRows[index]?.filename
    ))) {
      throw publicationError(
        "release_set_pack_artifact_invalid",
        "npm pack returned a filename outside the owned release-set output."
      );
    }
    const outputEntries: string[] = await fs.readdir(destination);
    const expectedEntries: any = new Set<any>([
      PREPARATION_OWNERSHIP_FILENAME,
      ...expectedRows.map(({ filename }: Record<string, any>) : any => filename)
    ]);
    if (outputEntries.some((entry?: any) : any => !expectedEntries.has(entry))) {
      throw publicationError(
        "release_set_artifact_directory_not_empty",
        "npm pack wrote files outside the owned release-set output."
      );
    }
    for (const packageRecord of packed) {
      if (await sha512IntegrityForFile(packageRecord.tarballPath) !== packageRecord.integrity) {
        throw publicationError(
          "release_set_pack_integrity_mismatch",
          "An npm pack archive does not match its reported integrity."
        );
      }
    }
    const manifest: any = {
      schemaVersion: PREPARED_RELEASE_SET_SCHEMA,
      version: releaseSet.version,
      tag,
      packages: packed.map(({ name, version, filename, integrity }: Record<string, any>) : any => ({
        name,
        version,
        filename,
        integrity
      }))
    };
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    const prepared: any = await loadPreparedReleaseSet({ rootDir, artifactDirectory: destination });
    await removeOwnedRegularFile(destination, PREPARATION_OWNERSHIP_FILENAME);
    return {
      ok: true,
      prepared: true,
      version: releaseSet.version,
      tag,
      packageCount: prepared.packages.length,
      packages: prepared.packages.map(({ name, version, filename, integrity }: Record<string, any>) : any => ({
        name,
        version,
        filename,
        integrity
      }))
    };
  } catch (error) {
    if (preparationMarkerWritten) {
      await Promise.all([
        ...expectedPreparedRows(releaseSet).map(({ filename }: Record<string, any>) : Promise<any> => (
          removeOwnedRegularFile(destination, filename)
        )),
        removeOwnedRegularFile(destination, PREPARED_RELEASE_SET_FILENAME),
        removeOwnedRegularFile(destination, PREPARATION_OWNERSHIP_FILENAME)
      ].map((cleanup: Promise<any>) : Promise<any> => cleanup.catch(() : any => undefined)));
    }
    if (error instanceof ReleaseSetPublicationError) throw error;
    throw publicationError(
      "release_set_preparation_failed",
      "The release-set artifacts could not be prepared."
    );
  } finally {
    if (commandDirectory) await fs.rm(commandDirectory, { recursive: true, force: true });
  }
}

export async function loadPreparedReleaseSet({
  rootDir = process.cwd(),
  artifactDirectory
}: Record<string, any> = {}) : Promise<PreparedReleaseSet> {
  const releaseSet: any = await discoverReleaseSet({ rootDir });
  const directory: any = await ensureArtifactDirectory(artifactDirectory);
  const manifestPath: any = path.join(directory, PREPARED_RELEASE_SET_FILENAME);
  let manifest: any;
  try {
    const manifestStat: any = await fs.lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("manifest_not_regular");
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    throw publicationError(
      "release_set_prepared_manifest_missing",
      "A valid prepared release-set manifest is required."
    );
  }
  if (
    !hasExactObjectKeys(manifest, ["schemaVersion", "version", "tag", "packages"]) ||
    manifest.schemaVersion !== PREPARED_RELEASE_SET_SCHEMA ||
    manifest.version !== releaseSet.version ||
    normalizeRequestedTag(releaseSet.version, manifest.tag) !== manifest.tag ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length !== releaseSet.packages.length
  ) {
    throw publicationError(
      "release_set_prepared_manifest_mismatch",
      "The prepared release manifest does not match the canonical release set."
    );
  }

  const filenames: any = new Set<any>();
  const packages: PreparedReleaseArtifact[] = [];
  for (let index = 0; index < releaseSet.packages.length; index += 1) {
    const packageRecord: any = releaseSet.packages[index];
    const artifact: any = validatePreparedArtifactRow(manifest.packages[index], packageRecord);
    if (filenames.has(artifact.filename)) {
      throw publicationError(
        "release_set_prepared_archive_duplicate",
        "Prepared release archives must have unique filenames."
      );
    }
    filenames.add(artifact.filename);
    const tarballPath: any = path.join(directory, artifact.filename);
    const preparedPackage: any = {
      ...packageRecord,
      ...artifact,
      tarballPath
    };
    await assertPreparedArchiveIntegrity(preparedPackage);
    packages.push(preparedPackage);
  }

  return {
    repositoryRoot: releaseSet.repositoryRoot,
    artifactDirectory: directory,
    version: releaseSet.version,
    tag: manifest.tag,
    packages
  };
}

function registryVersionMissing(result?: any) : any {
  const output: any = `${String(result?.stdout || "")}\n${String(result?.stderr || "")}`;
  return /(?:\bE404\b|404\s+Not\s+Found)/iu.test(output);
}

async function queryPublishedIntegrity(packageRecord?: any, runner?: any, commandDirectory?: any) : Promise<any> {
  const result: any = await runner(
    [
      "view",
      `${packageRecord.name}@${packageRecord.version}`,
      "dist.integrity",
      "--json",
      "--registry",
      OFFICIAL_NPM_REGISTRY
    ],
    { cwd: commandDirectory }
  );
  if (result?.exitCode !== 0) {
    if (registryVersionMissing(result)) return null;
    throw publicationError(
      "release_set_registry_query_failed",
      "The npm registry package-version check did not complete successfully."
    );
  }
  try {
    const integrity: any = parseNpmExactViewJson(result.stdout);
    if (typeof integrity !== "string" || !INTEGRITY_PATTERN.test(integrity)) throw new Error();
    return integrity;
  } catch {
    throw publicationError(
      "release_set_registry_integrity_invalid",
      "The npm registry returned an invalid package integrity value."
    );
  }
}

function preflightPackagePublication(packageRecord?: any, publishedIntegrity?: any) : any {
  if (publishedIntegrity !== null && publishedIntegrity !== packageRecord.integrity) {
    throw publicationError(
      "release_set_registry_integrity_mismatch",
      "An immutable npm package version already exists with different content."
    );
  }
  return { action: publishedIntegrity === null ? "publish" : "skip" };
}

async function publishTarball(packageRecord?: any, tag?: any, runner?: any, commandDirectory?: any) : Promise<any> {
  assertSuccessfulResult(
    await runner(
      [
        "publish",
        packageRecord.tarballPath,
        "--access",
        "public",
        "--tag",
        tag,
        "--ignore-scripts",
        "--registry",
        OFFICIAL_NPM_REGISTRY
      ],
      { cwd: commandDirectory }
    ),
    "release_set_publish_failed",
    "A release-set tarball could not be published."
  );
}

export async function publishReleaseSet({
  rootDir = process.cwd(),
  artifactDirectory,
  runner,
  environment = process.env
}: Record<string, any> = {}) : Promise<any> {
  const prepared: any = await loadPreparedReleaseSet({ rootDir, artifactDirectory });
  const tag: any = prepared.tag;
  const commandRunner: any = runner || createNpmRunner({ environment });
  const commandDirectory: any = prepared.repositoryRoot;
  const publishedIntegrities: any[] = await Promise.all(
    prepared.packages.map((packageRecord?: any) : any => (
      queryPublishedIntegrity(packageRecord, commandRunner, commandDirectory)
    ))
  );
  const plans: any[] = prepared.packages.map((packageRecord?: any, index?: any) : any => (
    preflightPackagePublication(packageRecord, publishedIntegrities[index])
  ));

  // Hash again after the registry check so publication consumes the same bytes
  // that the prepared manifest recorded, even if a file changed during the check.
  for (const packageRecord of prepared.packages) {
    await assertPreparedArchiveIntegrity(packageRecord);
  }

  const packages: any[] = [];
  for (const [index, packageRecord] of prepared.packages.entries()) {
    const action: any = plans[index].action === "publish" ? "published" : "skipped";
    if (action === "published") {
      await publishTarball(packageRecord, tag, commandRunner, commandDirectory);
    }
    packages.push({
      name: packageRecord.name,
      version: packageRecord.version,
      integrity: packageRecord.integrity,
      action
    });
  }

  return {
    ok: true,
    version: prepared.version,
    tag,
    packageCount: packages.length,
    packages
  };
}

function optionValue(args?: any, index?: any, option?: any) : any {
  const value: any = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw publicationError("release_set_argument_missing", `${option} requires a value.`);
  }
  return value;
}

export function parsePublishArguments(argv?: any) : any {
  let prepare: any = false;
  let artifactDirectory: any;
  let help: any = false;
  for (let index: any = 0; index < argv.length; index += 1) {
    const argument: any = argv[index];
    if (argument === "--prepare") {
      prepare = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--artifact-dir") {
      artifactDirectory = optionValue(argv, index, "--artifact-dir");
      index += 1;
    } else if (argument.startsWith("--artifact-dir=")) {
      artifactDirectory = argument.slice("--artifact-dir=".length);
    } else {
      throw publicationError(
        "release_set_argument_unknown",
        "Only --prepare and --artifact-dir are supported."
      );
    }
  }
  if (!help && !artifactDirectory) {
    throw publicationError("release_set_argument_missing", "--artifact-dir is required.");
  }
  return { prepare, artifactDirectory, help };
}

function usage() : any {
  return [
    "Usage:",
    "  npm run release:publish-npm -- --prepare --artifact-dir DIR",
    "  npm run release:publish-npm -- --artifact-dir DIR",
    "",
    "Preparation writes the exact npm tarballs and a meshrix-release-set.json manifest. Publication uses npm's configured authentication, checks existing versions against the prepared archive integrity, then publishes missing archives."
  ].join("\n");
}

async function main() : Promise<any> {
  const options: any = parsePublishArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result: any = options.prepare
    ? await prepareReleaseSet(options)
    : await publishReleaseSet(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error?: any) : any => {
    const normalized: any = error instanceof ReleaseSetPublicationError
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
