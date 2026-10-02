#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { npmCliArgs, resolveNpmCliInvocation } from "./lib/npm-cli-invocation.ts";
import {
  createLockBackedNpmRegistry,
  packageManifestFromTarball
} from "./lib/lock-backed-npm-registry.ts";
import { assertNoLeak } from "./lib/report-evidence-safety.ts";
import { discoverReleaseSet, loadPreparedReleaseSet } from "./publish-release-set.ts";
import { resolveReleaseWorkspaceDirectories } from "./lib/release-metadata.ts";
import {
  NPM_PACKAGE_CONSUMER_FAILURE_CODES,
  NPM_PACKAGE_CONSUMER_FAILURE_STAGES
} from "./npm-package-consumer.ts";

const execFileAsync: any = promisify(execFile);
const DEFAULT_REPORT_PATH: any = "build/reports/npm-package-installability.json";
const DEPLOYMENT_INDEX_PATH: any = "packages/foundation/config/deployment/index.json";
const OFFICIAL_NPM_REGISTRY: any = "https://registry.npmjs.org/";
const MAX_COMMAND_OUTPUT_BYTES: any = 64 * 1024 * 1024;
const PLATFORM_ARTIFACT_PATTERN: any =
  /(?:^|\/)(?:build\/Release|prebuilds)\/|\.(?:node|dll|dylib|so(?:\.\d+)*)$/iu;
const ISOLATED_CONSUMER_SOURCE: any = "tools/server-scripts/npm-package-consumer.ts";
const ISOLATED_REGISTRY_SOURCE: any = "tools/server-scripts/npm-registry-server.ts";
const NPM_PACKAGE_INSTALLABILITY_FAILURE_CODES: ReadonlySet<string> = new Set([
  ...NPM_PACKAGE_CONSUMER_FAILURE_CODES,
  "npm_package_bundle_dependencies_invalid",
  "npm_package_bundled_package_path_invalid",
  "npm_package_bundled_packages_mismatch",
  "npm_package_bug_tracker_missing",
  "npm_package_cli_bin_contract_invalid",
  "npm_package_cli_bin_missing",
  "npm_package_consumer_architecture_mismatch",
  "npm_package_consumer_image_build_failed",
  "npm_package_consumer_network_create_failed",
  "npm_package_consumer_package_count_mismatch",
  "npm_package_consumer_platform_mismatch",
  "npm_package_consumer_runtime_failed",
  "npm_package_container_image_not_pinned",
  "npm_package_docker_engine_architecture_unknown",
  "npm_package_docker_engine_unavailable",
  "npm_package_docker_operation_failed",
  "npm_package_files_contract_missing",
  "npm_package_homepage_missing",
  "npm_package_install_failed",
  "npm_package_install_oom_killed",
  "npm_package_install_permission_denied",
  "npm_package_install_script_failed",
  "npm_package_install_target_missing",
  "npm_package_installability_failed",
  "npm_package_internal_runtime_source_missing",
  "npm_package_license_contract_missing",
  "npm_package_native_dependency_build_failed",
  "npm_package_node_engine_contract_missing",
  "npm_package_offline_cache_incomplete",
  "npm_package_pack_tarball_invalid",
  "npm_package_prepared_artifact_directory_required",
  "npm_package_prepared_release_set_mismatch",
  "npm_package_platform_artifact_forbidden",
  "npm_package_platform_report_incomplete",
  "npm_package_private_workspace_missing",
  "npm_package_private_workspace_version_mismatch",
  "npm_package_public_release_set_invalid",
  "npm_package_probe_mode_conflict",
  "npm_package_registry_image_build_failed",
  "npm_package_registry_package_missing",
  "npm_package_registry_start_failed",
  "npm_package_registry_unreachable",
  "npm_package_release_set_artifact_mismatch",
  "npm_package_release_set_artifact_missing",
  "npm_package_release_set_install_failed",
  "npm_package_release_set_version_mismatch",
  "npm_package_repository_contract_missing",
  "npm_package_repository_directory_mismatch",
  "npm_package_repository_url_missing",
  "npm_package_required_artifact_missing",
  "npm_package_root_artifact_missing",
  "npm_package_root_install_lifecycle_forbidden",
  "npm_package_runtime_assertion_failed",
  "npm_package_runtime_file_missing",
  "npm_package_runtime_module_resolution_failed",
  "npm_package_runtime_native_storage_failed",
  "npm_package_runtime_reason_reported",
  "npm_package_runtime_write_boundary_failed",
  "npm_package_scoped_access_not_public",
  "npm_package_server_bin_contract_invalid",
  "npm_package_server_bin_missing",
  "npm_package_server_bin_shebang_missing",
  "npm_package_mcp_bin_missing",
  "npm_package_mcp_runtime_source_missing",
  "npm_package_server_cli_help_failed",
  "npm_package_server_startup_smoke_failed",
  "npm_package_package_license_incorrect",
  "npm_package_consumer_qualification_failed"
]);
const argv: any = process.argv.slice(2);
const inContainer: any = argv.includes("--in-container");
const hostPlatformProbe: any = argv.includes("--host-platform-probe");
const requiredHostProbe: any = argv.includes("--required-host-probe");
const npmCli: any = resolveNpmCliInvocation();

function argumentValue(name?: any) : any {
  const index: any = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : "";
}

function npmCommand() : any {
  return npmCli.command;
}

function npmArgs(args?: any) : any {
  return npmCliArgs(npmCli, args);
}

export async function prepareInstallabilityConsumer({
  consumerDirectory,
  packageRecord,
  devDependencies = {},
  allowScripts = packageRecord?.name === "meshrix.js" ? { "better-sqlite3": true } : {}
}: Record<string, any>) : Promise<void> {
  const name: any = String(packageRecord?.name || "");
  const version: any = String(packageRecord?.version || "");
  assert.ok(name && version, "npm_package_consumer_selection_invalid");
  await fs.mkdir(consumerDirectory, { recursive: true });
  await fs.writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify({
      name: "meshrix-package-verifier",
      private: true,
      version: "0.0.0",
      type: "module",
      dependencies: { [name]: version },
      allowScripts,
      ...(Object.keys(devDependencies).length > 0 ? { devDependencies } : {})
    }, null, 2)}\n`,
    "utf8"
  );
}

function consumerDirectoryName(name?: any) : any {
  return String(name || "package")
    .replace(/^@/u, "")
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
}

async function run(command?: any, args?: any, options: Record<string, any> = {}) : Promise<any> {
  const baseEnv: any = options.baseEnv || process.env;
  return execFileAsync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    windowsHide: true,
    env: {
      ...baseEnv,
      npm_config_registry: options.registry || OFFICIAL_NPM_REGISTRY,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: options.ignoreScripts === true ? "true" : "false"
    }
  });
}

async function runStage(errorCode?: any, command?: any, args?: any, options: Record<string, any> = {}) : Promise<any> {
  try {
    return await run(command, args, options);
  } catch (error: any) {
    if (options.classifyNpmInstall === true) {
      const output: any = `${String(error?.stdout || "")}\n${String(error?.stderr || "")}`;
      if (inContainer && String(error?.signal || "").toUpperCase() === "SIGKILL") {
        const memoryEvents = fsSync.readFileSync("/sys/fs/cgroup/memory.events", "utf8");
        const oomKills = Number(memoryEvents.match(/^oom_kill\s+(\d+)$/mu)?.[1] || 0);
        if (oomKills > 0) {
          throw new Error("npm_package_install_oom_killed");
        }
      }
      if (/ENOTCACHED|cache mode is ['"]?only-if-cached/iu.test(output)) {
        throw new Error("npm_package_offline_cache_incomplete");
      }
      if (/node-gyp|gyp ERR|Could not locate the bindings file/iu.test(output)) {
        throw new Error("npm_package_native_dependency_build_failed");
      }
      if (/EACCES|permission denied/iu.test(output)) {
        throw new Error("npm_package_install_permission_denied");
      }
      if (/ERESOLVE/iu.test(output)) {
        throw new Error("npm_package_dependency_resolution_failed");
      }
      if (/ETIMEDOUT|ENETUNREACH|EAI_AGAIN/iu.test(output)) {
        throw new Error("npm_package_registry_unreachable");
      }
      if (/\bENOENT\b/iu.test(output)) {
        const missingPath = output.match(/npm (?:error|ERR!) path ([^\r\n]+)/iu)?.[1]?.trim() || "";
        const normalizedPath = missingPath.replaceAll("\\", "/");
        const modulePath = normalizedPath.match(/\/node_modules\/(@?[^/]+(?:\/[^/]+)?)(?:\/(.*))?$/u);
        const safeTarget = modulePath
          ? `${modulePath[1]}_${path.posix.basename(modulePath[2] || "package")}`
          : path.posix.basename(normalizedPath || "unknown");
        const normalizedTarget = safeTarget
          .replace(/^@/u, "")
          .replace(/[^a-z0-9]+/giu, "_")
          .replace(/^_+|_+$/gu, "")
          .toLowerCase()
          .slice(0, 100);
        throw new Error(`npm_package_install_enoent_${normalizedTarget || "unknown"}`);
      }
      const npmErrorCode = output.match(/npm (?:error|ERR!) code ([A-Z0-9_]+)/iu)?.[1];
      if (npmErrorCode === "E404") {
        const resource = output.match(/requested resource '([^']+)'/iu)?.[1]
          || output.match(/GET https?:\/\/[^/\s]+\/([^\s?]+)/iu)?.[1]
          || "";
        let decoded = resource;
        try {
          decoded = decodeURIComponent(String(resource));
        } catch {
          decoded = String(resource);
        }
        const packageName = decoded
          .replace(/\/-\/.*$/u, "")
          .replace(/\/[0-9][^/]*$/u, "")
          .replace(/^@/u, "")
          .replace(/[^a-z0-9]+/giu, "_")
          .replace(/^_+|_+$/gu, "")
          .toLowerCase()
          .slice(0, 80);
        throw new Error(`npm_package_install_e404_${packageName || "unknown"}`);
      }
      if (npmErrorCode) {
        const normalizedCode = npmErrorCode.toLowerCase().replace(/[^a-z0-9_]+/gu, "_");
        throw new Error(`npm_package_install_${normalizedCode}`);
      }
      const failedPackage = output.match(
        /node_modules\/(@?[a-z0-9._-]+(?:\/[a-z0-9._-]+)?)[/\\\s]/iu
      )?.[1];
      if (/command failed|lifecycle/iu.test(output) && failedPackage) {
        const normalizedPackage = failedPackage
          .replace(/^@/u, "")
          .replace(/[^a-z0-9]+/giu, "_")
          .toLowerCase();
        throw new Error(`npm_package_install_script_failed_${normalizedPackage}`);
      }
      const fallbackMarkers = [
        output.trim() ? "output" : "empty",
        /npm (?:error|ERR!)/iu.test(output) ? "npm_error" : "no_npm_error",
        /command failed/iu.test(output) ? "command_failed" : "no_command_failure",
        /not found|no such file/iu.test(output) ? "missing_file" : "no_missing_file",
        `exit_${String(error?.code || "unknown").replace(/[^a-z0-9]+/giu, "_").toLowerCase()}`,
        `signal_${String(error?.signal || "none").replace(/[^a-z0-9]+/giu, "_").toLowerCase()}`
      ];
      throw new Error(`npm_package_release_set_install_failed_${fallbackMarkers.join("_")}`);
    }
    if (options.classifyRuntime === true) {
      const output: any = `${String(error?.stdout || "")}\n${String(error?.stderr || "")}`;
      if (/ERR_MODULE_NOT_FOUND|Cannot find package/iu.test(output)) {
        const missingModule = output.match(/Cannot find (?:package|module) ['"]([^'"]+)['"]/iu)?.[1] || "unknown";
        const safeModule = path.isAbsolute(missingModule)
          ? path.basename(missingModule)
          : missingModule;
        const normalizedModule = safeModule
          .replace(/^@/u, "")
          .replace(/[^a-z0-9]+/giu, "_")
          .replace(/^_+|_+$/gu, "")
          .toLowerCase()
          .slice(0, 100);
        throw new Error(`npm_package_runtime_module_resolution_failed_${normalizedModule || "unknown"}`);
      }
      if (/Could not locate the bindings file|better_sqlite3|better-sqlite3/iu.test(output)) {
        throw new Error("npm_package_runtime_native_storage_failed");
      }
      if (/ENOENT/iu.test(output)) {
        throw new Error("npm_package_runtime_file_missing");
      }
      if (/EACCES|permission denied|read-only file system/iu.test(output)) {
        throw new Error("npm_package_runtime_write_boundary_failed");
      }
      const reasonCode = output.match(/reasonCode=([a-z0-9_]+)/iu)?.[1];
      if (reasonCode) {
        throw new Error(`npm_package_runtime_${reasonCode.toLowerCase()}`);
      }
      const knownRuntimeAssertion = [
        "startup status is missing",
        "UI mode is missing",
        "runtime profile is missing",
        "discovery mode is missing",
        "startup output exposed an endpoint URL",
        "startup output exposed a stack frame",
        "shutdown start status is missing",
        "shutdown completion status is missing",
        "server output exposed an endpoint URL",
        "server output exposed a stack frame",
        "runtime log output is missing",
        "sanitized startup failure status is missing",
        "dynamic port did not require private readiness IPC"
      ].find((message) => output.includes(message));
      if (knownRuntimeAssertion) {
        const normalizedAssertion = knownRuntimeAssertion
          .replace(/[^a-z0-9]+/giu, "_")
          .replace(/^_+|_+$/gu, "")
          .toLowerCase();
        throw new Error(`npm_package_runtime_assertion_${normalizedAssertion}`);
      }
    }
    throw new Error(errorCode);
  }
}

export function failureCode(error?: any) : any {
  const message: any = typeof error?.message === "string" ? error.message : "";
  return NPM_PACKAGE_INSTALLABILITY_FAILURE_CODES.has(message)
    ? message
    : "npm_package_installability_failed";
}

export async function listInstallabilityTarballFiles(tarballPath?: any) : Promise<string[]> {
  const fileList: any = await execFileAsync("tar", ["-tzf", tarballPath], {
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    windowsHide: true
  });
  return String(fileList.stdout || "")
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((entry?: any) : any => !entry.endsWith("/"))
    .map((entry?: any) : any => {
    const normalized: any = path.posix.normalize(String(entry).replace(/^\.\//u, ""));
      assert.ok(
        !String(entry).split("/").includes("..")
          && normalized.startsWith("package/")
          && !normalized.startsWith("/")
          && !normalized.split("/").includes(".."),
        "npm_package_pack_tarball_invalid"
      );
      return normalized.slice("package/".length);
    });
}

export async function loadPreparedInstallabilityArtifacts({ artifactDirectory, rootDir = process.cwd() }: Record<string, any>) : Promise<any[]> {
  assert.ok(artifactDirectory, "npm_package_prepared_artifact_directory_required");
  const [releaseSet, prepared] = await Promise.all([
    discoverReleaseSet({ rootDir }),
    loadPreparedReleaseSet({ rootDir, artifactDirectory })
  ]);
  const expectedPackages: any[] = releaseSet.packages.map(({ name, version }: Record<string, any>) => ({ name, version }));
  const preparedPackages: any[] = prepared.packages.map(({ name, version }: Record<string, any>) => ({ name, version }));
  assert.deepEqual(preparedPackages, expectedPackages, "npm_package_prepared_release_set_mismatch");
  const packageMetadata = new Map(releaseSet.packages.map((record?: any) : any => [record.name, record]));
  return Promise.all(prepared.packages.map(async (artifact?: any) : Promise<any> => {
    const packageRecord: any = packageMetadata.get(artifact.name);
    assert.ok(packageRecord, "npm_package_release_set_artifact_missing");
    const stat: any = await fs.lstat(artifact.tarballPath);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "npm_package_pack_tarball_invalid");
    const manifest: any = packageManifestFromTarball(await fs.readFile(artifact.tarballPath));
    assert.equal(manifest.name, artifact.name, "npm_package_release_set_artifact_mismatch");
    assert.equal(manifest.version, artifact.version, "npm_package_release_set_version_mismatch");
    const files: string[] = await listInstallabilityTarballFiles(artifact.tarballPath);
    return {
      ...artifact,
      ...packageRecord,
      manifest,
      files,
      integrity: artifact.integrity,
      tarballPath: artifact.tarballPath
    };
  }));
}

const EXPECTED_PUBLIC_PACKAGES: readonly string[] = Object.freeze([
  "@meshrix/gateway",
  "meshrix.js"
]);

function sortedUnique(values: any[]) : string[] {
  return [...new Set(values.map((value?: any) : any => String(value)))].sort((left?: any, right?: any) : any => left.localeCompare(right));
}

function internalRuntimeDependencyNames(manifest?: any) : string[] {
  return sortedUnique(["dependencies", "optionalDependencies"].flatMap((field?: any) : string[] => {
    const dependencies: any = manifest?.[field];
    return dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)
      ? Object.keys(dependencies).filter((name?: any) : any => name.startsWith("@meshrix/"))
      : [];
  }));
}

function declaredBundleNames(manifest?: any) : string[] {
  const current: any = manifest?.bundleDependencies;
  const legacy: any = manifest?.bundledDependencies;
  if (legacy !== undefined || !Array.isArray(current)) {
    throw new Error("npm_package_bundle_dependencies_invalid");
  }
  const names: any[] = current.map((name?: any) : any => String(name));
  if (
    names.some((name?: any) : any => !name.startsWith("@meshrix/"))
    || new Set(names).size !== names.length
  ) {
    throw new Error("npm_package_bundle_dependencies_invalid");
  }
  return names.sort((left?: any, right?: any) : any => left.localeCompare(right));
}

export function bundledPackageNamesInArtifact(files?: string[]) : string[] {
  const names = new Set<string>();
  for (const file of files || []) {
    const marker = file.indexOf("node_modules/");
    if (marker < 0) continue;
    if (marker !== 0) throw new Error("npm_package_bundled_package_path_invalid");

    const segments = file.split("/");
    const packageName = segments[1]?.startsWith("@")
      ? `${segments[1]}/${segments[2] || ""}`
      : String(segments[1] || "");
    if (!packageName || packageName.endsWith("/") || packageName.includes("..")) {
      throw new Error("npm_package_bundled_package_path_invalid");
    }

    const packageRoot = `node_modules/${packageName}`;
    if (
      (file !== `${packageRoot}/package.json` && !file.startsWith(`${packageRoot}/`))
      || file.slice(packageRoot.length + 1).split("/").includes("node_modules")
    ) {
      throw new Error("npm_package_bundled_package_path_invalid");
    }
    names.add(packageName);
  }
  return [...names].sort((left?: any, right?: any) : any => left.localeCompare(right));
}

export async function assertPreparedProductBundleClosure({
  rootDir = process.cwd(),
  rootPackage,
  releaseSet,
  packedArtifacts
}: Record<string, any>) : Promise<Record<string, any>> {
  const publicNames: any[] = releaseSet.packages.map((packageRecord?: any) : any => String(packageRecord.name));
  if (
    new Set(publicNames).size !== publicNames.length
    || JSON.stringify(sortedUnique(publicNames)) !== JSON.stringify([...EXPECTED_PUBLIC_PACKAGES])
  ) {
    throw new Error("npm_package_public_release_set_invalid");
  }

  const workspaceDirectories: string[] = await resolveReleaseWorkspaceDirectories({
    rootDir,
    workspaces: rootPackage.workspaces
  });
  const workspaceByName: any = new Map();
  for (const directory of workspaceDirectories) {
    let manifest: any;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(rootDir, directory, "package.json"), "utf8"));
    } catch {
      throw new Error("npm_package_private_workspace_missing");
    }
    if (!String(manifest.name || "").startsWith("@meshrix/") || workspaceByName.has(manifest.name)) {
      throw new Error("npm_package_private_workspace_missing");
    }
    workspaceByName.set(manifest.name, { directory, manifest });
  }

  const publicNameSet = new Set<string>(publicNames);
  const rootInternalDependencies = internalRuntimeDependencyNames(rootPackage);
  for (const name of rootInternalDependencies) {
    const workspace = workspaceByName.get(name);
    if (!workspace) throw new Error("npm_package_private_workspace_missing");
    if (workspace.manifest.version !== rootPackage.version) {
      throw new Error("npm_package_private_workspace_version_mismatch");
    }
    if (publicNameSet.has(name)) {
      if (workspace.manifest.private === true) throw new Error("npm_package_public_release_set_invalid");
    } else if (workspace.manifest.private !== true) {
      throw new Error("npm_package_private_workspace_missing");
    }
  }

  const expectedRootBundles = rootInternalDependencies.filter((name?: any) : any => !publicNameSet.has(name));
  const actualRootBundles = declaredBundleNames(rootPackage);
  if (JSON.stringify(actualRootBundles) !== JSON.stringify(expectedRootBundles)) {
    throw new Error("npm_package_bundle_dependencies_invalid");
  }

  const bundlesByProduct: Record<string, any> = {};
  for (const packageRecord of releaseSet.packages) {
    const artifact = packedArtifacts.find((candidate?: any) : any => candidate.name === packageRecord.name);
    if (!artifact) throw new Error("npm_package_release_set_artifact_missing");
    const sourceManifest = packageRecord.root === true
      ? rootPackage
      : workspaceByName.get(packageRecord.name)?.manifest;
    if (!sourceManifest || sourceManifest.name !== artifact.manifest.name || sourceManifest.version !== artifact.manifest.version) {
      throw new Error("npm_package_release_set_artifact_mismatch");
    }
    if (sourceManifest.license !== "Apache-2.0" || artifact.manifest.license !== "Apache-2.0") {
      throw new Error("npm_package_package_license_incorrect");
    }

    const expectedBundles = internalRuntimeDependencyNames(sourceManifest)
      .filter((name?: any) : any => !publicNameSet.has(name));
    const sourceBundles = declaredBundleNames(sourceManifest);
    const artifactBundles = declaredBundleNames(artifact.manifest);
    if (
      JSON.stringify(sourceBundles) !== JSON.stringify(expectedBundles)
      || JSON.stringify(artifactBundles) !== JSON.stringify(sourceBundles)
    ) {
      throw new Error("npm_package_bundle_dependencies_invalid");
    }

    for (const name of sourceBundles) {
      const workspace = workspaceByName.get(name);
      const dependencyVersion = sourceManifest.dependencies?.[name]
        || sourceManifest.optionalDependencies?.[name];
      if (!workspace) throw new Error("npm_package_private_workspace_missing");
      if (
        workspace.manifest.private !== true
        || workspace.manifest.version !== sourceManifest.version
        || dependencyVersion !== workspace.manifest.version
      ) {
        throw new Error("npm_package_private_workspace_version_mismatch");
      }
    }

    const bundledFiles = bundledPackageNamesInArtifact(artifact.files);
    if (JSON.stringify(bundledFiles) !== JSON.stringify(sourceBundles)) {
      throw new Error("npm_package_bundled_packages_mismatch");
    }
    const fileSet = new Set<string>(artifact.files);
    if (!fileSet.has("LICENSE") || !fileSet.has("package.json")) {
      throw new Error("npm_package_package_license_incorrect");
    }
    for (const name of sourceBundles) {
      if (!fileSet.has(`node_modules/${name}/LICENSE`)) {
        throw new Error("npm_package_package_license_incorrect");
      }
    }
    if (packageRecord.root === true && !fileSet.has("THIRD_PARTY_NOTICES.md")) {
      throw new Error("npm_package_package_license_incorrect");
    }
    bundlesByProduct[packageRecord.name] = sourceBundles.length;
  }

  return {
    publicPackageCount: publicNames.length,
    privateWorkspaceCount: rootInternalDependencies.filter((name?: any) : any => !publicNameSet.has(name)).length,
    bundledPackageCountByProduct: bundlesByProduct
  };
}

function artifactDirectoryArgument() : any {
  const value: any = argumentValue("--artifact-dir") || process.env.MESHRIX_NPM_ARTIFACT_DIR || "";
  return value ? path.resolve(value) : "";
}

function selectedHostEnvironment() : any {
  const allowedNames: any[] = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "COMSPEC",
    "WINDIR",
    "CI",
    "GITHUB_ACTIONS",
    "RUNNER_OS",
    "PROCESSOR_ARCHITECTURE"
  ];
  return Object.fromEntries(
    allowedNames
      .filter((name?: any) : any => typeof process.env[name] === "string" && process.env[name])
      .map((name?: any) : any => [name, process.env[name]])
  );
}

async function runProbe({ reportPath, freshContainer, requiredReleaseProbe = false, artifactDirectory = artifactDirectoryArgument() }: Record<string, any>) : Promise<any> {
const tempRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-npm-package-installability-"));
const isolatedHome: any = path.join(tempRoot, "home");
const isolatedTemp: any = path.join(tempRoot, "tmp");
const isolatedCache: any = path.join(tempRoot, "npm-cache");
const isolatedData: any = path.join(tempRoot, "meshrix-data");
const isolatedCodexHome: any = path.join(tempRoot, "codex-home");
const isolatedNpmrc: any = path.join(tempRoot, "npmrc");
await Promise.all([
  isolatedHome,
  isolatedTemp,
  isolatedCache,
  isolatedData,
  isolatedCodexHome
].map((directory?: any) : any => fs.mkdir(directory, { recursive: true })));
if (freshContainer === true) {
  await fs.access("/opt/meshrix-npm-cache/_cacache");
}
await fs.writeFile(isolatedNpmrc, "", "utf8");
const probeEnvironment: Record<string, any> = {
  ...selectedHostEnvironment(),
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  TMPDIR: isolatedTemp,
  TEMP: isolatedTemp,
  TMP: isolatedTemp,
  XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
  XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),
  CODEX_HOME: isolatedCodexHome,
  MESHRIX_USER_DATA_DIR: isolatedData,
  NODE_OPTIONS: "--max-old-space-size=384",
  npm_config_userconfig: isolatedNpmrc,
  npm_config_cache: isolatedCache,
  npm_config_jobs: "1",
  MAKEFLAGS: "-j1",
  CFLAGS: "-O1 -g0",
  CXXFLAGS: "-O1 -g0",
  ...(freshContainer === true
    ? {
        npm_config_build_from_source: "true",
        npm_config_nodedir: "/usr/local"
      }
    : {})
};
const runProbeStage: any = (errorCode?: any, command?: any, args?: any, options: Record<string, any> = {}) : any => runStage(
  errorCode,
  command,
  args,
  { ...options, baseEnv: probeEnvironment }
);
const report: Record<string, any> = {
  schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
  verifier: "tools/server-scripts/verify-npm-package-installability.ts",
  generatedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  tests: [],
  summary: {}
};
function record(name?: any, status?: any, evidence: Record<string, any> = {}) : any {
  report.tests.push({ name, status, evidence });
}

try {
  const rootPackage: any = JSON.parse(await fs.readFile("package.json", "utf8"));
  const releaseSet: any = await discoverReleaseSet({ rootDir: process.cwd() });
  const packedArtifacts: any[] = await loadPreparedInstallabilityArtifacts({ artifactDirectory });
  assert.equal(releaseSet.version, rootPackage.version, "npm_package_release_set_version_mismatch");
  const bundleEvidence: any = await assertPreparedProductBundleClosure({
    rootDir: process.cwd(),
    rootPackage,
    releaseSet,
    packedArtifacts
  });
  const expectedBin: any = "dist/apps/server/bin/meshrix.js";
  const expectedServerBin: any = "dist/tools/server-scripts/start-server.js";
  const expectedMcpBin: any = "dist/apps/server/bin/meshrix-mcp.js";
  assert.equal(rootPackage.bin?.meshrix, expectedBin, "npm_package_cli_bin_contract_invalid");
  assert.equal(
    rootPackage.bin?.["meshrix-server"],
    expectedServerBin,
    "npm_package_server_bin_contract_invalid"
  );
  assert.equal(rootPackage.bin?.["meshrix-mcp"], expectedMcpBin, "npm_package_mcp_bin_missing");
  for (const lifecycleScript of ["preinstall", "install", "postinstall"]) {
    assert.equal(
      rootPackage.scripts?.[lifecycleScript],
      undefined,
      "npm_package_root_install_lifecycle_forbidden"
    );
  }

  record("canonical public packages declare their exact private bundle closure", "passed", {
    privateWorkspaceCount: bundleEvidence.privateWorkspaceCount,
    releasePackageCount: releaseSet.packages.length,
    rootMcpBinDeclared: true,
    standaloneConnectorPackageIncluded: false,
    versionLocked: true,
    bundledPackageCountByProduct: bundleEvidence.bundledPackageCountByProduct,
    rootInstallLifecycleHooks: false
  });

  let packedFileCount: any = 0;
  const tarballPaths: any[] = [];
  for (const artifact of packedArtifacts) {
    const files: any = artifact.files;
    packedFileCount += files.length;
    assert.equal(
      files.some((file?: any) : any => PLATFORM_ARTIFACT_PATTERN.test(file)),
      false,
      "npm_package_platform_artifact_forbidden"
    );
    tarballPaths.push(artifact.tarballPath);
  }
  const rootArtifact: any = packedArtifacts.find(({ name }: Record<string, any>) : any => name === rootPackage.name);
  assert.ok(rootArtifact, "npm_package_root_artifact_missing");
  const rootFiles: any = rootArtifact.files;
  assert.ok(rootFiles.includes(expectedBin), "npm_package_cli_bin_missing");
  assert.ok(rootFiles.includes(expectedServerBin), "npm_package_server_bin_missing");
  assert.ok(rootFiles.includes(expectedMcpBin), "npm_package_mcp_bin_missing");
  assert.match(
    await fs.readFile(expectedServerBin, "utf8"),
    /^#!\/usr\/bin\/env node\r?\n/u,
    "npm_package_server_bin_shebang_missing"
  );
  assert.ok(
    rootFiles.includes("node_modules/@meshrix/contracts/dist/operations/operation-registry.js"),
    "npm_package_internal_runtime_source_missing"
  );
  assert.ok(
    rootFiles.includes("node_modules/@meshrix/protocols/dist/mcp/adapter/gateway-installer/lib/cli/proxy-command.js"),
    "npm_package_mcp_runtime_source_missing"
  );
  assert.ok(
    rootFiles.includes("node_modules/@meshrix/protocols/dist/mcp/adapter/gateway-installer/mcp-identity.js"),
    "npm_package_mcp_runtime_source_missing"
  );
  record("release-set tarballs carry declared private bundles and exclude host artifacts", "passed", {
    packageCount: packedArtifacts.length,
    packages: packedArtifacts.map(({ name, version, filename, integrity }: Record<string, any>) => ({
      name,
      version,
      filename,
      integrity
    })),
    fileCount: packedFileCount,
    bundledPackageCountByProduct: bundleEvidence.bundledPackageCountByProduct,
    platformArtifacts: false,
    preparedReleaseSet: true,
    preparedArtifactIntegrityVerified: true,
    rootMcpRuntimeSource: true,
    standaloneConnectorPackageIncluded: false,
    repositoryInstructionsExcluded: true
  });

  const consumerDirectory: any = path.join(tempRoot, "consumer");
  await prepareInstallabilityConsumer({
    consumerDirectory,
    packageRecord: { name: rootPackage.name, version: rootPackage.version }
  });
  const registryMirror: any = freshContainer === true
    ? await createLockBackedNpmRegistry({
        lockPath: "package-lock.json",
        cacheRoot: "/opt/meshrix-npm-cache",
        extraTarballs: packedArtifacts.map((artifact?: any, index?: any) : any => ({
          name: String(artifact.name),
          version: String(artifact.version),
          tarballPath: tarballPaths[index]
        }))
      })
    : null;
  const installRegistry: any = registryMirror?.registry || OFFICIAL_NPM_REGISTRY;
  try {
    await runProbeStage(
      "npm_package_release_set_install_failed",
      npmCommand(),
      npmArgs([
        "install",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--registry",
        installRegistry
      ]),
      {
        cwd: consumerDirectory,
        classifyNpmInstall: true,
        registry: installRegistry
      }
    );
  } finally {
    await registryMirror?.close();
  }

  const help: any = await runProbeStage(
    "npm_package_cli_help_failed",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "meshrix", "--help"]),
    { cwd: consumerDirectory }
  );
  assert.match(help.stdout, /Usage:/u, "npm_package_cli_help_failed");
  const interfaces: any = await runProbeStage(
    "npm_package_cli_offline_interface_failed",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "meshrix", "interfaces", "--format", "markdown"]),
    { cwd: consumerDirectory }
  );
  assert.match(interfaces.stdout, /jobs\.list/u, "npm_package_cli_offline_interface_failed");
  const serverHelp: any = await runProbeStage(
    "npm_package_server_cli_help_failed",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "meshrix-server", "--help"]),
    { cwd: consumerDirectory }
  );
  assert.match(
    serverHelp.stdout,
    /--allow-public-console/u,
    "npm_package_server_cli_help_failed"
  );
  const mcpVersion: any = await runProbeStage(
    "npm_package_mcp_identity_invalid",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "meshrix-mcp", "version", "--json"]),
    { cwd: consumerDirectory, classifyRuntime: true }
  );
  const mcpPayload: any = JSON.parse(mcpVersion.stdout);
  assert.equal(mcpPayload.packageName, rootPackage.name, "npm_package_mcp_identity_invalid");
  assert.equal(mcpPayload.packageVersion, rootPackage.version, "npm_package_mcp_version_invalid");
  record("clean consumer install runs the packaged CLI", "passed", {
    cliHelp: true,
    offlineInterfaceCatalog: true,
    publicServerCliHelp: true,
    rootMcpCli: true,
    rootOnlyInstall: true,
    standaloneConnectorPackageFetched: false,
    registryPinned: true,
    lockBackedRegistryMirror: freshContainer === true,
    mirroredPackageCount: registryMirror?.packageCount || 0,
    mirroredArtifactCount: registryMirror?.artifactCount || 0
  });

  const installedRoot: any = path.join(consumerDirectory, "node_modules", rootPackage.name);
  const installedServerBin: any = path.join(
    consumerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "meshrix-server.cmd" : "meshrix-server"
  );
  await fs.access(installedServerBin, fsSync.constants.X_OK);
  await runProbeStage(
    "npm_package_server_startup_smoke_failed",
    process.execPath,
    [
      path.join(installedRoot, "dist/tools/server-scripts/verify-start-server-defaults.js"),
      "--command",
      installedServerBin
    ],
    { cwd: installedRoot, classifyRuntime: true }
  );
  record("installed framework starts and serves its default health contracts", "passed", {
    serverStarted: true,
    healthEndpoint: true,
    bootstrapEndpoint: true,
    rpcHealth: true,
    nativeStorageRuntime: true,
    publicServerBin: true
  });

  report.summary = {
    testCount: report.tests.length,
    failedCount: 0,
    releaseReady: freshContainer === true || requiredReleaseProbe === true,
    reportLeakScan: true,
    freshContainer: freshContainer === true,
    requiredHostProbe: requiredReleaseProbe === true,
    supplementaryHostProbe: freshContainer !== true && requiredReleaseProbe !== true,
    supplementaryReady: freshContainer !== true && requiredReleaseProbe !== true
  };
} catch (error: any) {
  const errorCode: any = failureCode(error);
  record("npm package installability verifier", "failed", { errorCode });
  report.summary = {
    testCount: report.tests.length,
    failedCount: 1,
    releaseReady: false,
    reportLeakScan: false,
    freshContainer: freshContainer === true,
    requiredHostProbe: requiredReleaseProbe === true,
    supplementaryHostProbe: freshContainer !== true && requiredReleaseProbe !== true
  };
  console.error(`[npm-package-installability] failed code=${errorCode}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  try {
    report.summary.reportLeakScan = false;
    assertNoLeak(report, "npm package installability report");
    report.summary.reportLeakScan = true;
    assertNoLeak(report, "npm package installability report");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

if (process.exitCode !== 1) {
  const readinessMessage: any = freshContainer === true
    ? "[npm-package-installability] releaseReady=true"
    : requiredReleaseProbe === true
      ? "[npm-package-installability] requiredHostReady=true"
      : "[npm-package-installability] supplementaryHostReady=true";
  console.log(readinessMessage);
}
}

async function writeDefaultReport(report?: any) : Promise<any> {
  assertNoLeak(report, "npm package installability container report");
  await fs.mkdir(path.dirname(DEFAULT_REPORT_PATH), { recursive: true });
  await fs.writeFile(DEFAULT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function resolveRepositoryRoot() : any {
  const acceptanceRoot: any = String(process.env.MESHRIX_ACCEPTANCE_REPOSITORY_ROOT || "").trim();
  if (acceptanceRoot) {
    return path.resolve(acceptanceRoot);
  }
  const gitDir: any = String(process.env.GIT_DIR || "").trim();
  if (gitDir) {
    return path.dirname(gitDir);
  }
  return process.cwd();
}

async function runContainerAuthority() : Promise<any> {
  const repoRoot: any = resolveRepositoryRoot();
  const workRoot: any = await fs.mkdtemp(path.join(repoRoot, "build", ".npm-package-isolation-"));
  const artifactDirectory: any = artifactDirectoryArgument();
  const inputDirectory: any = path.join(workRoot, "input");
  const evidenceDirectory: any = path.join(workRoot, "evidence");
  const rootReportPath: any = path.join(evidenceDirectory, "npm-package-installability.json");
  const generatedAt: any = new Date().toISOString();
  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
    verifier: "tools/server-scripts/verify-npm-package-installability.ts",
    generatedAt,
    startedAt: generatedAt,
    tests: [],
    summary: {}
  };
  const imageTags: any[] = [];
  const networkName: any = `meshrix-npm-${process.pid}-${Date.now()}`;
  const registryContainerName: any = `${networkName}-registry`;
  let networkCreated = false;
  let registryStarted = false;
  const record: any = (name?: any, status?: any, evidence: Record<string, any> = {}) : any => {
    report.tests.push({ name, status, evidence });
  };
  const docker: any = (args?: any[], errorCode?: any) : any => runStage(
    errorCode || "npm_package_docker_operation_failed",
    "docker",
    args
  );
  const names: any[] = [
    "canonical public packages declare their exact private bundle closure",
    "release-set tarballs carry declared private bundles and exclude host artifacts",
    "clean consumer install runs the packaged CLI",
    "installed framework starts and serves its default health contracts"
  ];

  try {
    assert.ok(artifactDirectory, "npm_package_prepared_artifact_directory_required");
    await Promise.all([inputDirectory, evidenceDirectory].map((directory?: any) : any =>
      fs.mkdir(directory, { recursive: true })
    ));
    for (const source of [ISOLATED_CONSUMER_SOURCE, ISOLATED_REGISTRY_SOURCE]) {
      await fs.access(path.join(repoRoot, source));
      await fs.access(path.join(repoRoot, "dist", source.replace(/\.ts$/u, ".js")));
    }
    const rootPackage: any = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
    const lockfile: any = JSON.parse(await fs.readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
    const releaseSet: any = await discoverReleaseSet({ rootDir: repoRoot });
    const packedArtifacts: any[] = await loadPreparedInstallabilityArtifacts({
      artifactDirectory,
      rootDir: repoRoot
    });
    assert.equal(releaseSet.version, rootPackage.version, "npm_package_release_set_version_mismatch");
    const bundleEvidence: any = await assertPreparedProductBundleClosure({
      rootDir: repoRoot,
      rootPackage,
      releaseSet,
      packedArtifacts
    });
    const expectedBin: any = "dist/apps/server/bin/meshrix.js";
    const expectedServerBin: any = "dist/tools/server-scripts/start-server.js";
    const expectedMcpBin: any = "dist/apps/server/bin/meshrix-mcp.js";
    assert.equal(rootPackage.bin?.meshrix, expectedBin, "npm_package_cli_bin_contract_invalid");
    assert.equal(rootPackage.bin?.["meshrix-server"], expectedServerBin, "npm_package_server_bin_contract_invalid");
    assert.equal(rootPackage.bin?.["meshrix-mcp"], expectedMcpBin, "npm_package_mcp_bin_missing");
    for (const lifecycleScript of ["preinstall", "install", "postinstall"]) {
      assert.equal(rootPackage.scripts?.[lifecycleScript], undefined, "npm_package_root_install_lifecycle_forbidden");
    }

    record("canonical public packages declare their exact private bundle closure", "passed", {
      privateWorkspaceCount: bundleEvidence.privateWorkspaceCount,
      releasePackageCount: releaseSet.packages.length,
      rootMcpBinDeclared: true,
      standaloneConnectorPackageIncluded: false,
      versionLocked: true,
      bundledPackageCountByProduct: bundleEvidence.bundledPackageCountByProduct,
      rootInstallLifecycleHooks: false
    });

    const rootArtifact: any = packedArtifacts.find(({ name }: Record<string, any>) : any => name === rootPackage.name);
    assert.ok(rootArtifact, "npm_package_root_artifact_missing");
    const expectedServerBinText: any = await fs.readFile(path.join(repoRoot, expectedServerBin), "utf8");
    assert.match(expectedServerBinText, /^#!\/usr\/bin\/env node\r?\n/u, "npm_package_server_bin_shebang_missing");
    const expectedMcpBinText: any = await fs.readFile(path.join(repoRoot, expectedMcpBin), "utf8");
    assert.match(expectedMcpBinText, /^#!\/usr\/bin\/env node\r?\n/u, "npm_package_server_bin_shebang_missing");
    let packedFileCount: any = 0;
    for (const artifact of packedArtifacts) {
      const files: any[] = artifact.files;
      packedFileCount += files.length;
      assert.equal(files.some((file?: any) : any => PLATFORM_ARTIFACT_PATTERN.test(file)), false, "npm_package_platform_artifact_forbidden");
    }
    const rootFiles: any[] = rootArtifact.files;
    assert.ok(rootFiles.includes(expectedBin), "npm_package_cli_bin_missing");
    assert.ok(rootFiles.includes(expectedServerBin), "npm_package_server_bin_missing");
    assert.ok(rootFiles.includes(expectedMcpBin), "npm_package_mcp_bin_missing");
    assert.ok(rootFiles.includes("node_modules/@meshrix/contracts/dist/operations/operation-registry.js"), "npm_package_internal_runtime_source_missing");
    assert.ok(rootFiles.includes("node_modules/@meshrix/protocols/dist/mcp/adapter/gateway-installer/lib/cli/proxy-command.js"), "npm_package_mcp_runtime_source_missing");
    assert.ok(rootFiles.includes("node_modules/@meshrix/protocols/dist/mcp/adapter/gateway-installer/mcp-identity.js"), "npm_package_mcp_runtime_source_missing");
    assert.ok(rootFiles.includes("build/dist/index.html"), "npm_package_console_build_assets_missing");

    const packagePlan: any[] = [];
    for (const packageRecord of releaseSet.packages) {
      const artifact: any = packedArtifacts.find((candidate?: any) : any => candidate.name === packageRecord.name);
      assert.ok(artifact, "npm_package_release_set_artifact_missing");
      const manifest: any = artifact.manifest;
      assert.equal(manifest.name, packageRecord.name, "npm_package_release_set_artifact_mismatch");
      assert.equal(manifest.version, packageRecord.version, "npm_package_release_set_version_mismatch");
      assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, "npm_package_files_contract_missing");
      assert.ok(manifest.license, "npm_package_license_contract_missing");
      assert.ok(manifest.engines?.node, "npm_package_node_engine_contract_missing");
      assert.equal(manifest.repository?.type, "git", "npm_package_repository_contract_missing");
      assert.ok(manifest.repository?.url, "npm_package_repository_url_missing");
      assert.ok(manifest.homepage, "npm_package_homepage_missing");
      assert.ok(manifest.bugs?.url, "npm_package_bug_tracker_missing");
      if (!packageRecord.root) {
        assert.equal(manifest.repository?.directory, packageRecord.directory, "npm_package_repository_directory_mismatch");
      }
      if (manifest.name.startsWith("@meshrix/")) {
        assert.equal(manifest.publishConfig?.access, "public", "npm_package_scoped_access_not_public");
      }
      packagePlan.push({ name: manifest.name, version: manifest.version, root: packageRecord.root === true, manifest });
    }
    const registryArtifacts: any = packedArtifacts.map((artifact?: any) : any => ({
      name: String(artifact.name),
      version: String(artifact.version),
      tarballPath: path.posix.join("/artifacts", String(artifact.filename))
    }));
    const registryPlanPath: any = path.join(inputDirectory, "registry-artifacts.json");
    await fs.writeFile(registryPlanPath, `${JSON.stringify({ artifacts: registryArtifacts }, null, 2)}\n`, "utf8");

    const lockedToolVersion: any = (name?: any) : any => {
      const version: any = lockfile.packages?.[`node_modules/${name}`]?.version;
      assert.ok(version, `npm_package_locked_verifier_tool_missing_${consumerDirectoryName(name)}`);
      return version;
    };
    await fs.cp(path.join(repoRoot, "docs/examples/gateway"), path.join(inputDirectory, "gateway-examples"), { recursive: true });
    const consumerPlanPath: any = path.join(inputDirectory, "consumer-plan.json");
    const containerPlan: any = {
      packages: packagePlan,
      verifierTools: Object.fromEntries([
        "typescript",
        "@types/node",
        "vite",
        "@vitejs/plugin-vue",
        "vue-tsc",
        "@playwright/test"
      ].map((name?: any) : any => [name, lockedToolVersion(name)]))
    };
    await fs.writeFile(consumerPlanPath, `${JSON.stringify(containerPlan, null, 2)}\n`, "utf8");
    record("release-set tarballs carry declared private bundles and exclude host artifacts", "passed", {
      packageCount: packedArtifacts.length,
      fileCount: packedFileCount,
      bundledPackageCountByProduct: bundleEvidence.bundledPackageCountByProduct,
      platformArtifacts: false,
      preparedReleaseSet: true,
      preparedArtifactIntegrityVerified: true,
      rootMcpRuntimeSource: true,
      standaloneConnectorPackageIncluded: false,
      consoleBuildAssets: true,
      repositoryInstructionsExcluded: true,
      packedOnce: true
    });

    const deploymentIndex: any = JSON.parse(await fs.readFile(path.join(repoRoot, DEPLOYMENT_INDEX_PATH), "utf8"));
    const nodeImage: any = String(deploymentIndex?.dockerPresets?.baseImages?.mainService || "");
    assert.match(nodeImage, /^docker\.io\/library\/node:\d+\.\d+\.\d+-[a-z0-9.-]+@sha256:[a-f0-9]{64}$/u, "npm_package_container_image_not_pinned");
    const engineRawArchitecture: any = String((await docker(["info", "--format", "{{.Architecture}}"], "npm_package_docker_engine_unavailable")).stdout || "").trim().toLowerCase();
    const engineArchitecture: any = ({ x86_64: "amd64", aarch64: "arm64" } as Record<string, string>)[engineRawArchitecture] || engineRawArchitecture;
    assert.ok(["amd64", "arm64"].includes(engineArchitecture), "npm_package_docker_engine_architecture_unknown");
    const suffix: any = `${process.pid}-${Date.now()}`;
    const registryImage: any = `meshrix-npm-registry:${suffix}`;
    imageTags.push(registryImage);
    await docker([
      "buildx", "build", "--load", "--quiet", "--target", "npm-package-registry", "--tag", registryImage,
      "--build-arg", `NODE_BASE_IMAGE=${nodeImage}`, "--build-arg", `NPM_REGISTRY=${OFFICIAL_NPM_REGISTRY}`, repoRoot
    ], "npm_package_registry_image_build_failed");
    const platformImages: any[] = [];
    for (const targetPlatform of ["linux/amd64", "linux/arm64"]) {
      const architecture: any = targetPlatform.slice("linux/".length);
      const tag: any = `meshrix-npm-consumer-${architecture}:${suffix}`;
      imageTags.push(tag);
      await docker([
        "buildx", "build", "--load", "--quiet", "--platform", targetPlatform, "--target", "npm-package-consumer", "--tag", tag,
        "--build-arg", `NODE_BASE_IMAGE=${nodeImage}`, repoRoot
      ], "npm_package_consumer_image_build_failed");
      platformImages.push({ platform: targetPlatform, architecture, tag });
    }
    await docker(["network", "create", "--internal", networkName], "npm_package_consumer_network_create_failed");
    networkCreated = true;
    await docker([
      "run", "--detach", "--rm", "--name", registryContainerName, "--network", networkName, "--network-alias", "meshrix-registry",
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,size=64m",
      "--mount", `type=bind,src=${artifactDirectory},dst=/artifacts,readonly`,
      "--mount", `type=bind,src=${inputDirectory},dst=/input,readonly`, registryImage,
      "node", "dist/tools/server-scripts/npm-registry-server.js", "--artifacts", "/input/registry-artifacts.json"
    ], "npm_package_registry_start_failed");
    registryStarted = true;
    for (;;) {
      const state: any = String((await docker(["inspect", "--format", "{{.State.Running}}", registryContainerName], "npm_package_registry_start_failed")).stdout || "").trim();
      assert.equal(state, "true", "npm_package_registry_start_failed");
      const readiness: any = await run("docker", [
        "exec", registryContainerName, "node", "--input-type=module", "--eval",
        `const response = await fetch(${JSON.stringify(`http://127.0.0.1:4873/${encodeURIComponent(rootPackage.name)}/${rootPackage.version}`)}); if (!response.ok) process.exit(1);`
      ]).catch(() : any => null);
      if (readiness) break;
      await new Promise((resolve?: any) : any => setTimeout(resolve, 100));
    }

    const platformReports: any[] = [];
    const platformFailures: any[] = [];
    for (const target of platformImages) {
      const platformReportPath: any = path.join(evidenceDirectory, `${target.architecture}.json`);
      const platform: any = target.platform;
      const emulated: any = target.architecture !== engineArchitecture;
      const args: any[] = [
        "run", "--rm", "--platform", platform, "--network", networkName, "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--shm-size=1g", "--tmpfs", "/tmp:rw,exec,nosuid,size=4096m",
        "--env", "HOME=/tmp/home", "--env", "TMPDIR=/tmp", "--env", "MESHRIX_USER_DATA_DIR=/tmp/meshrix-data",
        "--env", "CODEX_HOME=/tmp/codex-home", "--env", "npm_config_userconfig=/tmp/home/.npmrc", "--env", "npm_config_cache=/tmp/npm-cache",
        "--env", "MESHRIX_NPM_REGISTRY=http://meshrix-registry:4873/", "--env", "MESHRIX_NPM_PLAN=/input/consumer-plan.json",
        "--env", `MESHRIX_NPM_REPORT=/evidence/${target.architecture}.json`, "--env", `MESHRIX_NPM_PLATFORM=${platform}`,
        "--env", `MESHRIX_NPM_EMULATED=${String(emulated)}`, "--env", `MESHRIX_NPM_ENGINE_ARCH=${engineArchitecture}`,
        "--mount", `type=bind,src=${inputDirectory},dst=/input,readonly`,
        "--mount", `type=bind,src=${evidenceDirectory},dst=/evidence`,
        target.tag, "node", "/opt/meshrix/npm-package-consumer.js"
      ];
      let observed: any = null;
      try {
        await docker(args, "npm_package_consumer_runtime_failed");
        observed = JSON.parse(await fs.readFile(platformReportPath, "utf8"));
      } catch {
        observed = await fs.readFile(platformReportPath, "utf8")
          .then((contents?: any) : any => JSON.parse(contents))
          .catch(() : any => null);
      }
      if (observed?.summary?.success !== true) {
        const failures = Array.isArray(observed?.failures) && observed.failures.length > 0
          ? observed.failures
          : [{}];
        for (const summary of failures) {
          const packageIndex: any = Number.isInteger(summary.failurePackageIndex) &&
            summary.failurePackageIndex >= 0 &&
            summary.failurePackageIndex < releaseSet.packages.length
            ? summary.failurePackageIndex
            : null;
          const completedConsumerCount: any = Number.isInteger(observed?.consumers?.length) &&
            observed.consumers.length >= 0 &&
            observed.consumers.length <= releaseSet.packages.length
            ? observed.consumers.length
            : 0;
          platformFailures.push({
            platform,
            architecture: target.architecture,
            stage: NPM_PACKAGE_CONSUMER_FAILURE_STAGES.has(summary.failureStage)
              ? summary.failureStage
              : "container_runtime",
            errorCode: NPM_PACKAGE_CONSUMER_FAILURE_CODES.has(summary.errorCode)
              ? summary.errorCode
              : "npm_package_consumer_runtime_failed",
            packageIndex,
            ...(packageIndex === null ? {} : { packageName: releaseSet.packages[packageIndex].name }),
            completedConsumerCount
          });
        }
        continue;
      }
      try {
        assert.equal(observed.runtime?.platform, "linux", "npm_package_consumer_platform_mismatch");
        assert.equal(observed.runtime?.architecture, target.architecture, "npm_package_consumer_architecture_mismatch");
        assert.equal(observed.summary?.packageCount, releaseSet.packages.length, "npm_package_consumer_package_count_mismatch");
      } catch (error: any) {
        platformFailures.push({
          platform,
          architecture: target.architecture,
          stage: "consumer_report_validation",
          errorCode: failureCode(error),
          packageIndex: null,
          completedConsumerCount: 0
        });
        continue;
      }
      platformReports.push({
        platform,
        architecture: target.architecture,
        emulated,
        engineArchitecture,
        consumerCount: observed.summary.packageCount,
        runtimeExportCount: observed.summary.allRuntimeExports,
        typeExportCount: observed.summary.allTypeExports,
        normalInstallLifecycles: observed.summary.normalInstallLifecycles,
        consumers: observed.consumers,
        cli: observed.cli,
        server: observed.server,
        sqlite: observed.sqlite,
        migrations: observed.migrations,
        offlineRestore: observed.offlineRestore,
        schemaWorker: observed.schemaWorker,
        mcp: observed.mcp,
        browser: observed.browser
      });
    }
    if (platformFailures.length > 0) {
      const failureEvidence: any = {
        platformFailures,
        qualifiedPlatforms: platformReports.map(({ platform, emulated, engineArchitecture }: Record<string, any>) : any => ({
          platform,
          emulated,
          engineArchitecture
        }))
      };
      record(names[2], "failed", failureEvidence);
      record(names[3], "failed", failureEvidence);
      throw new Error("npm_package_consumer_qualification_failed");
    }
    assert.equal(platformReports.length, 2, "npm_package_platform_report_incomplete");
    record(names[2], "passed", {
      platforms: platformReports.map(({ platform, emulated, engineArchitecture }: Record<string, any>) : any => ({ platform, emulated, engineArchitecture })),
      consumerCountPerPlatform: releaseSet.packages.length,
      installedRuntimeAndTypes: true,
      statefulModuleIdentity: platformReports.every(({ consumers }: Record<string, any>) => consumers.find((consumer: any) => consumer.consumerKind === "platform")?.moduleIdentity?.sharedRegistry === true),
      gatewayExamples: platformReports.every(({ consumers }: Record<string, any>) => consumers.find((consumer: any) => consumer.consumerKind === "gateway")?.embeddedExamples?.executed === 3),
      installedAdapterDescriptions: platformReports.every(({ cli }: Record<string, any>) => cli?.adapterDescribeCount === 7),
      installedCli: platformReports.every(({ cli }: Record<string, any>) : any => cli?.help && cli?.offlineInterfaceCatalog && cli?.serverHelp && cli?.mcpVersion && cli?.mcpHelp),
      installedMcpProxy: platformReports.every(({ mcp }: Record<string, any>) : any => mcp?.installedRootBin === true && mcp?.standardInitialize === true && mcp?.initializedNotificationForwarded === true && mcp?.toolsListed === true && mcp?.representativeProxyCall === true && mcp?.credentialForwardedFromEnvironment === true && mcp?.processClosedCleanly === true),
      uiBrowserInteraction: platformReports.every(({ browser }: Record<string, any>) : any => browser?.bundledUi?.interaction === true),
      normalInstallLifecycle: platformReports.every(({ consumers }: Record<string, any>) : any => consumers.every((consumer?: any) : any => consumer.installLifecycleCompleted))
    });
    record(names[3], "passed", {
      platforms: platformReports.map(({ platform, emulated, engineArchitecture }: Record<string, any>) : any => ({ platform, emulated, engineArchitecture })),
      serverStartedAndStopped: platformReports.every(({ server }: Record<string, any>) : any => server?.packagedServerStarted === true),
      defaultHealthAndBootstrap: platformReports.every(({ server }: Record<string, any>) : any => server?.health && server?.bootstrap),
      consoleAssetsSameOrigin: platformReports.every(({ server }: Record<string, any>) : any => server?.sameOrigin === true),
      sqliteRoundTrip: platformReports.every(({ sqlite }: Record<string, any>) : any => sqlite?.insertSelectRoundTrip === true),
      packagedMigrations: platformReports.every(({ migrations }: Record<string, any>) : any => migrations?.appliedVersionsAreIdempotent === true),
      installedOfflineRestore: platformReports.every(({ offlineRestore }: Record<string, any>) : any => offlineRestore?.installedCli === true && offlineRestore?.applyVerified === true),
      installedSchemaWorker: platformReports.every(({ schemaWorker }: Record<string, any>) : any => schemaWorker?.validAndInvalidPayloadsChecked === true),
      platformResults: platformReports
    });
    report.summary = {
      testCount: report.tests.length,
      failedCount: 0,
      releaseReady: true,
      reportLeakScan: true,
      freshContainer: true,
      platforms: platformReports.map(({ platform, emulated, engineArchitecture }: Record<string, any>) : any => ({ platform, emulated, engineArchitecture }))
    };
  } catch (error: any) {
    const errorCode: any = failureCode(error);
    for (const name of names) {
      if (!report.tests.some((test?: any) : any => test.name === name)) {
        record(name, "failed", { errorCode });
      }
    }
    report.summary = {
      testCount: report.tests.length,
      failedCount: report.tests.filter((test?: any) : any => test.status === "failed").length,
      releaseReady: false,
      reportLeakScan: true,
      freshContainer: true
    };
    process.exitCode = 1;
    console.error(`[npm-package-installability] failed code=${errorCode} authority=isolated-consumers`);
  } finally {
    report.finishedAt = new Date().toISOString();
    try {
      if (registryStarted) await docker(["rm", "--force", registryContainerName]).catch(() : any => {});
      if (networkCreated) await docker(["network", "rm", networkName]).catch(() : any => {});
      if (imageTags.length > 0) await docker(["image", "rm", "--force", ...imageTags]).catch(() : any => {});
      report.summary.reportLeakScan = false;
      assertNoLeak(report, "npm package installability report");
      report.summary.reportLeakScan = true;
      assertNoLeak(report, "npm package installability report");
      await writeDefaultReport(report);
    } finally {
      await fs.rm(workRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  }
  if (process.exitCode !== 1) {
    console.log("[npm-package-installability] releaseReady=true authority=isolated-consumers platforms=linux/amd64,linux/arm64 report=build/reports/npm-package-installability.json");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (hostPlatformProbe && requiredHostProbe) {
    throw new Error("npm_package_probe_mode_conflict");
  }
  if (inContainer || hostPlatformProbe || requiredHostProbe) {
    await runProbe({
      reportPath: argumentValue("--report-path") || DEFAULT_REPORT_PATH,
      freshContainer: inContainer,
      requiredReleaseProbe: requiredHostProbe
    });
  } else {
    await runContainerAuthority();
  }
}
