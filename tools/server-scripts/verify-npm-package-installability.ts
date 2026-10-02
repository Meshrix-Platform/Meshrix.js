#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import semver from "semver";

import { npmCliArgs, resolveNpmCliInvocation } from "./lib/npm-cli-invocation.ts";
import { resolveCommandCandidate } from "../../packages/foundation/src/environment-compatibility/host-runtime.ts";
import { discoverLocalExecutionEnvironment } from "./lib/local-execution-environment.ts";
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
  "npm_package_private_workspace_missing",
  "npm_package_private_workspace_version_mismatch",
  "npm_package_public_release_set_invalid",
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
  "npm_package_consumer_qualification_failed",
  "npm_package_cache_location_invalid",
  "npm_package_consumer_report_missing",
  "npm_package_consumer_report_invalid",
  "npm_package_consumer_process_failed",
  "npm_package_docker_cli_missing",
  "npm_package_docker_cleanup_failed",
  "npm_package_registry_close_failed",
  "npm_package_install_lifecycle_failed",
  "npm_package_node_runtime_unsupported",
  "npm_package_npm_cli_unavailable"
]);
const argv: any = process.argv.slice(2);
let npmCli: ReturnType<typeof resolveNpmCliInvocation> | null = null;
let npmCliUnavailable = false;

function npmInvocation(): ReturnType<typeof resolveNpmCliInvocation> {
  if (npmCli) return npmCli;
  if (npmCliUnavailable) throw new Error("npm_package_npm_cli_unavailable");
  try {
    npmCli = resolveNpmCliInvocation();
  } catch {
    npmCliUnavailable = true;
    throw new Error("npm_package_npm_cli_unavailable");
  }
  return npmCli;
}

function argumentValue(name?: any) : any {
  const index: any = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : "";
}

function npmCommand() : any {
  return npmInvocation().command;
}

function npmArgs(args?: any) : any {
  return npmCliArgs(npmInvocation(), args);
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

async function checkNativeToolchain(nodeEngine: string): Promise<Record<string, any>> {
  if (!semver.validRange(nodeEngine)) {
    return { status: "not_run", reasonCode: "npm_package_node_engine_contract_missing" };
  }
  if (!semver.satisfies(process.version, nodeEngine)) {
    return { status: "not_run", reasonCode: "npm_package_node_runtime_unsupported" };
  }
  try {
    const result = await execFileAsync(npmCommand(), npmArgs(["--version"]), {
      cwd: process.cwd(), encoding: "utf8", maxBuffer: 4096, windowsHide: true,
      env: selectedHostEnvironment()
    });
    const npmVersion = semver.valid(String(result.stdout || "").trim());
    if (!npmVersion) return { status: "not_run", reasonCode: "npm_package_npm_cli_unavailable" };
    return { status: "passed", nodeVersion: semver.clean(process.version), npmVersion };
  } catch {
    return { status: "not_run", reasonCode: "npm_package_npm_cli_unavailable" };
  }
}


const NPM_INSTALLABILITY_TEST_NAMES = Object.freeze([
  "root package declares the complete version-locked workspace release set",
  "release-set tarballs are source-portable and exclude host artifacts",
  "clean consumer install runs the packaged CLI",
  "installed framework starts and serves its default health contracts"
]);
const CONSUMER_TEST_NAMES = NPM_INSTALLABILITY_TEST_NAMES.slice(2);
const VERIFIER_TOOL_NAMES = Object.freeze([
  "typescript", "@types/node", "vite", "@vitejs/plugin-vue", "vue-tsc", "@playwright/test"
]);

function selectedNpmEnvironment(home: string, temporary: string, cache: string, userConfig: string): NodeJS.ProcessEnv {
  return {
    ...selectedHostEnvironment(),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    npm_config_userconfig: userConfig,
    npm_config_cache: cache,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "false",
    npm_config_jobs: "1",
    MAKEFLAGS: "-j1",
    CFLAGS: "-O1 -g0",
    CXXFLAGS: "-O1 -g0",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    NODE_OPTIONS: ""
  };
}

async function resolveNpmCacheRoot(userConfig: string): Promise<string> {
  const configured = String(process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || "").trim();
  if (configured) return path.resolve(configured);
  const home = os.homedir();
  const env = {
    ...selectedHostEnvironment(),
    HOME: home,
    USERPROFILE: home,
    npm_config_userconfig: userConfig,
    npm_config_audit: "false",
    npm_config_fund: "false"
  };
  const result = await execFileAsync(npmCommand(), npmArgs(["config", "get", "cache"]), {
    cwd: process.cwd(), encoding: "utf8", maxBuffer: 4096, windowsHide: true, env
  });
  const cacheRoot = String(result.stdout || "").trim();
  assert.ok(cacheRoot && path.isAbsolute(cacheRoot), "npm_package_cache_location_invalid");
  return cacheRoot;
}

async function dockerExecutablePath(): Promise<string> {
  const candidate = resolveCommandCandidate("docker", {
    env: process.env, platform: process.platform, includeDefaultLocalBin: false
  });
  assert.ok(candidate.found && candidate.path, "npm_package_docker_cli_missing");
  return candidate.path;
}

function normalizedConsumerFailures(observed: any, packageNames: string[]): Record<string, any>[] {
  return (Array.isArray(observed?.failures) ? observed.failures : []).map((failure: any) => {
    const index = Number.isInteger(failure?.failurePackageIndex)
      && failure.failurePackageIndex >= 0
      && failure.failurePackageIndex < packageNames.length
      ? failure.failurePackageIndex
      : null;
    return {
      failureStage: NPM_PACKAGE_CONSUMER_FAILURE_STAGES.has(failure?.failureStage) ? failure.failureStage : "container_runtime",
      errorCode: NPM_PACKAGE_CONSUMER_FAILURE_CODES.has(failure?.errorCode) ? failure.errorCode : "npm_package_consumer_failed",
      packageIndex: index,
      ...(index === null ? {} : { packageName: packageNames[index] })
    };
  });
}

function safeConsumerDetails(observed: any): Record<string, any> {
  return {
    runtime: observed.runtime,
    consumers: observed.consumers,
    cli: observed.cli,
    server: observed.server,
    sqlite: observed.sqlite,
    migrations: observed.migrations,
    offlineRestore: observed.offlineRestore,
    schemaWorker: observed.schemaWorker,
    mcp: observed.mcp,
    browser: observed.browser
  };
}

function validateConsumerObservation(observed: any, target: Record<string, any>, packageNames: string[]): Record<string, any> {
  assert.ok(observed && typeof observed === "object", "npm_package_consumer_report_missing");
  assert.equal(observed.runtime?.platform, String(target.platform).split("/")[0], "npm_package_consumer_platform_mismatch");
  assert.equal(observed.runtime?.architecture, String(target.platform).split("/")[1], "npm_package_consumer_architecture_mismatch");
  assert.ok(semver.validRange(target.nodeEngine), "npm_package_node_engine_contract_missing");
  assert.ok(semver.satisfies(observed.runtime?.nodeVersion, target.nodeEngine), "npm_package_node_runtime_unsupported");
  assert.ok(semver.valid(observed.runtime?.npmVersion), "npm_package_npm_cli_unavailable");
  if (observed.summary?.success !== true) {
    return {
      status: "failed",
      reasonCode: "npm_package_consumer_qualification_failed",
      evidence: {
        failures: normalizedConsumerFailures(observed, packageNames),
        completedConsumerCount: Number.isInteger(observed.summary?.packageCount) ? observed.summary.packageCount : 0
      }
    };
  }

  const consumers = Array.isArray(observed.consumers) ? observed.consumers : [];
  assert.equal(observed.summary.packageCount, packageNames.length, "npm_package_consumer_package_count_mismatch");
  assert.equal(consumers.length, packageNames.length, "npm_package_consumer_package_count_mismatch");
  assert.equal(observed.summary.normalInstallLifecycles, true, "npm_package_install_lifecycle_failed");
  assert.equal(observed.summary.allConsumersPackageOnly, true, "npm_package_consumer_package_count_mismatch");
  assert.ok(Number.isInteger(observed.summary.allRuntimeExports) && observed.summary.allRuntimeExports > 0, "npm_package_runtime_assertion_failed");
  assert.ok(Number.isInteger(observed.summary.allTypeExports) && observed.summary.allTypeExports > 0, "npm_package_runtime_assertion_failed");

  const root = consumers.find((consumer: any) => consumer.consumerKind === "platform");
  const gateway = consumers.find((consumer: any) => consumer.consumerKind === "gateway");
  assert.ok(root && gateway, "npm_package_consumer_package_count_mismatch");
  assert.equal(root.installLifecycleCompleted, true, "npm_package_install_lifecycle_failed");
  assert.equal(gateway.installLifecycleCompleted, true, "npm_package_install_lifecycle_failed");
  assert.equal(root.moduleIdentity?.sharedRegistry, true, "npm_package_module_identity_mismatch");
  assert.equal(gateway.embeddedExamples?.executed, 3, "npm_package_gateway_embed_failed");
  assert.equal(observed.cli?.adapterDescribeCount, 7, "npm_package_adapter_cli_describe_failed");
  for (const key of ["help", "offlineInterfaceCatalog", "serverHelp", "mcpHelp", "mcpVersion", "explicitRootPackageBin", "publicServerBin"]) {
    assert.equal(observed.cli?.[key], true, "npm_package_cli_help_failed");
  }
  assert.equal(observed.mcp?.standardDiscovery, true, "npm_package_mcp_proxy_failed");
  assert.equal(observed.mcp?.signedPeerVerified, true, "npm_package_mcp_proxy_failed");
  assert.equal(observed.mcp?.representativeProxyCall, true, "npm_package_mcp_proxy_failed");
  assert.equal(observed.mcp?.credentialForwardedFromEnvironment, true, "npm_package_mcp_proxy_failed");
  assert.equal(observed.mcp?.processClosedCleanly, true, "npm_package_mcp_proxy_failed");
  assert.equal(observed.browser?.bundledUi?.interaction, true, "npm_package_ui_browser_error");
  assert.equal(observed.server?.packagedServerStarted, true, "npm_package_server_startup_smoke_failed");
  assert.equal(observed.server?.health, true, "npm_package_server_health_failed");
  assert.equal(observed.server?.bootstrap, true, "npm_package_server_bootstrap_failed");
  assert.equal(observed.server?.sameOrigin, true, "npm_package_console_cross_origin_asset");
  assert.equal(observed.sqlite?.insertSelectRoundTrip, true, "npm_package_runtime_native_storage_failed");
  assert.equal(observed.migrations?.appliedVersionsAreIdempotent, true, "npm_package_runtime_assertion_failed");
  assert.equal(observed.offlineRestore?.applyVerified, true, "npm_package_installed_restore_apply_failed");
  assert.equal(observed.schemaWorker?.validAndInvalidPayloadsChecked, true, "npm_package_consumer_failed");
  assert.equal(observed.schemaWorker?.workerClosed, true, "npm_package_consumer_failed");

  return {
    status: "passed",
    evidence: {
      consumerCount: consumers.length,
      normalInstallLifecycles: true,
      allConsumersPackageOnly: true,
      allRuntimeExports: observed.summary.allRuntimeExports,
      allTypeExports: observed.summary.allTypeExports,
      runtime: observed.runtime,
      npmVersion: observed.runtime.npmVersion,
      statefulModuleIdentity: true,
      gatewayExamples: gateway.embeddedExamples.executed,
      installedAdapterDescriptions: observed.cli.adapterDescribeCount,
      installedCli: true,
      publicServerCliHelp: true,
      publicServerBin: true,
      installedMcpProxy: true,
      uiBrowserInteraction: true,
      serverStartedAndStopped: true,
      defaultHealthAndBootstrap: true,
      consoleAssetsSameOrigin: true,
      sqliteRoundTrip: true,
      packagedMigrations: true,
      installedOfflineRestore: true,
      installedSchemaWorker: true,
      consumer: safeConsumerDetails(observed)
    }
  };
}

function dockerCommandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DOCKER_DEFAULT_PLATFORM;
  return env;
}

async function runConsumerProcess({
  repoRoot, workRoot, target, registry, planPath, mirroredPackageCount, mirroredArtifactCount, dockerCommand
}: Record<string, any>): Promise<Record<string, any>> {
  const targetName = target.kind === "native" ? "native" : "local-docker";
  const directory = path.join(workRoot, "consumer-" + targetName);
  const home = path.join(directory, "home");
  const temporary = path.join(directory, "tmp");
  const data = path.join(directory, "data");
  const codex = path.join(directory, "codex");
  const cache = path.join(directory, "npm-cache");
  const userConfig = path.join(directory, "npmrc");
  const evidenceDirectory = path.join(directory, "evidence");
  const consumerReportPath = path.join(evidenceDirectory, "consumer-report.json");
  await Promise.all([home, temporary, data, codex, cache, evidenceDirectory].map((entry: string) => fs.mkdir(entry, { recursive: true })));
  await fs.writeFile(userConfig, "", "utf8");

  const chromiumExecutable = target.kind === "local_docker"
    ? "/usr/bin/chromium"
    : resolveCommandCandidate(["chromium", "chromium-browser", "google-chrome", "chrome"], {
        env: process.env, platform: process.platform, includeDefaultLocalBin: false
      }).path;
  const environment: NodeJS.ProcessEnv = {
    ...selectedNpmEnvironment(home, temporary, cache, userConfig),
    CODEX_HOME: codex,
    MESHRIX_USER_DATA_DIR: data,
    MESHRIX_NPM_REGISTRY: registry,
    MESHRIX_NPM_PLAN: planPath,
    MESHRIX_NPM_REPORT: consumerReportPath,
    MESHRIX_NPM_PLATFORM: target.platform,
    ...(chromiumExecutable ? { MESHRIX_CHROMIUM_EXECUTABLE: chromiumExecutable } : {})
  };

  let processFailed = false;
  try {
    if (target.kind === "local_docker") {
      await execFileAsync(dockerCommand, [
        "run", "--rm", "--platform", target.platform, "--network", target.networkName,
        "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--shm-size=1g",
        "--tmpfs", "/tmp:rw,exec,nosuid,size=4096m",
        "--env", "HOME=/tmp/home", "--env", "TMPDIR=/tmp", "--env", "MESHRIX_USER_DATA_DIR=/tmp/meshrix-data",
        "--env", "CODEX_HOME=/tmp/codex-home", "--env", "npm_config_userconfig=/tmp/home/.npmrc",
        "--env", "npm_config_cache=/tmp/npm-cache", "--env", "npm_config_nodedir=/usr/local",
        "--env", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
        "--env", "MESHRIX_CHROMIUM_EXECUTABLE=/usr/bin/chromium",
        "--env", "MESHRIX_NPM_REGISTRY=http://meshrix-registry:4873/",
        "--env", "MESHRIX_NPM_PLAN=/input/consumer-plan.json",
        "--env", "MESHRIX_NPM_REPORT=/evidence/consumer-report.json",
        "--env", "MESHRIX_NPM_PLATFORM=" + target.platform,
        "--mount", "type=bind,src=" + target.inputDirectory + ",dst=/input,readonly",
        "--mount", "type=bind,src=" + evidenceDirectory + ",dst=/evidence",
        target.imageTag, "node", "/opt/meshrix/npm-package-consumer.js"
      ], {
        cwd: repoRoot, encoding: "utf8", maxBuffer: MAX_COMMAND_OUTPUT_BYTES, windowsHide: true, env: dockerCommandEnvironment()
      });
    } else {
      await execFileAsync(process.execPath, [path.join(repoRoot, "dist/tools/server-scripts/npm-package-consumer.js")], {
        cwd: repoRoot, encoding: "utf8", maxBuffer: MAX_COMMAND_OUTPUT_BYTES, windowsHide: true,
        env: {
          ...environment,
          npm_config_registry: registry,
          npm_config_audit: "false",
          npm_config_fund: "false",
          npm_config_ignore_scripts: "false"
        }
      });
    }
  } catch {
    processFailed = true;
  }

  let observed: any;
  try {
    observed = JSON.parse(await fs.readFile(consumerReportPath, "utf8"));
  } catch {
    const code = processFailed ? "npm_package_consumer_report_missing" : "npm_package_consumer_report_invalid";
    return { status: "failed", reasonCode: code, evidence: { failures: [{ failureStage: "consumer_report_validation", errorCode: code }] } };
  }

  try {
    assertNoLeak(observed, "npm package consumer target evidence");
    if (processFailed && observed.summary?.success === true) throw new Error("npm_package_consumer_process_failed");
    const validation = validateConsumerObservation(observed, target, target.packageNames);
    if (validation.status !== "passed") return validation;
    return {
      ...validation,
      evidence: {
        ...validation.evidence, runtime: observed.runtime, npmVersion: observed.runtime?.npmVersion,
        lockBackedRegistryMirror: true, mirroredPackageCount, mirroredArtifactCount
      }
    };
  } catch (error: unknown) {
    const code = failureCode(error);
    return {
      status: "failed",
      reasonCode: code,
      evidence: {
        failures: [{ failureStage: "consumer_report_validation", errorCode: code }],
        completedConsumerCount: Number.isInteger(observed.summary?.packageCount) ? observed.summary.packageCount : 0,
        lockBackedRegistryMirror: true, mirroredPackageCount, mirroredArtifactCount
      }
    };
  }
}

async function runNativeTarget({
  repoRoot, workRoot, target, packedArtifacts, consumerPlanPath
}: Record<string, any>): Promise<Record<string, any>> {
  let registry: any = null;
  let result: Record<string, any>;
  try {
    const toolchain = await checkNativeToolchain(target.nodeEngine);
    if (toolchain.status !== "passed") return toolchain;
    const userConfig = path.join(workRoot, "native-registry.npmrc");
    await fs.writeFile(userConfig, "", "utf8");
    const cacheRoot = await resolveNpmCacheRoot(userConfig);
    registry = await createLockBackedNpmRegistry({
      lockPath: path.join(repoRoot, "package-lock.json"), cacheRoot,
      extraTarballs: packedArtifacts.map((artifact: any) => ({
        name: String(artifact.name), version: String(artifact.version), tarballPath: artifact.tarballPath
      }))
    });
    result = await runConsumerProcess({
      repoRoot, workRoot, target, registry: registry.registry, planPath: consumerPlanPath,
      mirroredPackageCount: registry.packageCount, mirroredArtifactCount: registry.artifactCount
    });
    result = { ...result, evidence: { ...result.evidence, toolchain: { nodeVersion: toolchain.nodeVersion, npmVersion: toolchain.npmVersion } } };
  } catch (error: unknown) {
    const code = failureCode(error);
    result = { status: "failed", reasonCode: code, evidence: { failures: [{ failureStage: "npm_install", errorCode: code }] } };
  } finally {
    if (registry) {
      try {
        await registry.close();
      } catch {
        result = { status: "failed", reasonCode: "npm_package_registry_close_failed",
          evidence: { failures: [{ failureStage: "container_runtime", errorCode: "npm_package_registry_close_failed" }] } };
      }
    }
  }
  return result!;
}

async function runDockerTarget({
  repoRoot, workRoot, target, rootPackage, releaseSet, inputDirectory, consumerPlanPath
}: Record<string, any>): Promise<Record<string, any>> {
  let dockerCommand = "";
  let networkCreated = false;
  let registryStarted = false;
  let cleanupFailed = false;
  const suffix = String(process.pid) + "-" + String(Date.now());
  const networkName = "meshrix-npm-" + suffix;
  const registryContainerName = networkName + "-registry";
  const registryImage = "meshrix-npm-registry:" + suffix;
  const consumerImage = "meshrix-npm-consumer:" + suffix;
  const imageTags = [registryImage, consumerImage];
  let result: Record<string, any> = { status: "failed", reasonCode: "npm_package_docker_operation_failed", evidence: {} };
  const docker = async (args: string[], errorCode: string): Promise<any> => {
    try {
      return await execFileAsync(dockerCommand, args, {
        cwd: repoRoot, encoding: "utf8", maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        windowsHide: true, env: dockerCommandEnvironment()
      });
    } catch { throw new Error(errorCode); }
  };

  try {
    dockerCommand = await dockerExecutablePath();
    const deploymentIndex = JSON.parse(await fs.readFile(path.join(repoRoot, DEPLOYMENT_INDEX_PATH), "utf8"));
    const nodeImage = String(deploymentIndex?.dockerPresets?.baseImages?.mainService || "");
    assert.match(nodeImage, /^docker\.io\/library\/node:\d+\.\d+\.\d+-[a-z0-9.-]+@sha256:[a-f0-9]{64}$/u, "npm_package_container_image_not_pinned");
    await docker(["build", "--platform", target.platform, "--quiet", "--target", "npm-package-registry", "--tag", registryImage,
      "--build-arg", "NODE_BASE_IMAGE=" + nodeImage, "--build-arg", "NPM_REGISTRY=" + OFFICIAL_NPM_REGISTRY,
      "--file", "Dockerfile", "."], "npm_package_registry_image_build_failed");
    await docker(["build", "--platform", target.platform, "--quiet", "--target", "npm-package-consumer", "--tag", consumerImage,
      "--build-arg", "NODE_BASE_IMAGE=" + nodeImage, "--file", "Dockerfile", "."], "npm_package_consumer_image_build_failed");
    await docker(["network", "create", "--internal", networkName], "npm_package_consumer_network_create_failed");
    networkCreated = true;
    await docker(["run", "--detach", "--rm", "--name", registryContainerName, "--network", networkName,
      "--network-alias", "meshrix-registry", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--tmpfs", "/tmp:rw,nosuid,size=64m",
      "--mount", "type=bind,src=" + target.artifactDirectory + ",dst=/artifacts,readonly",
      "--mount", "type=bind,src=" + inputDirectory + ",dst=/input,readonly",
      registryImage, "node", "dist/tools/server-scripts/npm-registry-server.js", "--artifacts", "/input/registry-artifacts.json"
    ], "npm_package_registry_start_failed");
    registryStarted = true;

    const packageUrl = "http://127.0.0.1:4873/" + encodeURIComponent(rootPackage.name) + "/" + encodeURIComponent(rootPackage.version);
    for (;;) {
      const readiness = await docker(["exec", registryContainerName, "node", "--input-type=module", "--eval",
        "const response = await fetch(" + JSON.stringify(packageUrl) + "); if (!response.ok) process.exit(1);"
      ], "npm_package_registry_unreachable").catch(() => null);
      if (readiness) break;
      const state = String((await docker(["inspect", "--format", "{{.State.Running}}", registryContainerName], "npm_package_registry_start_failed")).stdout || "").trim();
      assert.equal(state, "true", "npm_package_registry_start_failed");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const registryLog = String((await docker(["logs", registryContainerName], "npm_package_registry_start_failed")).stdout || "")
      .split(/\r?\n/u).filter(Boolean).map((line: string) => { try { return JSON.parse(line); } catch { return null; } })
      .find((entry: any) => entry?.status === "ready");
    assert.ok(Number.isInteger(registryLog?.packageCount) && registryLog.packageCount > 0, "npm_package_registry_start_failed");
    assert.ok(Number.isInteger(registryLog?.artifactCount) && registryLog.artifactCount > 0, "npm_package_registry_start_failed");

    result = await runConsumerProcess({
      repoRoot, workRoot,
      target: { ...target, kind: "local_docker", networkName, imageTag: consumerImage, inputDirectory,
        packageNames: releaseSet.packages.map((entry: any) => entry.name) },
      registry: "http://meshrix-registry:4873/", planPath: consumerPlanPath,
      mirroredPackageCount: registryLog.packageCount, mirroredArtifactCount: registryLog.artifactCount, dockerCommand
    });
  } catch (error: unknown) {
    const code = failureCode(error);
    result = { status: "failed", reasonCode: code, evidence: { failures: [{ failureStage: "container_runtime", errorCode: code }] } };
  } finally {
    if (dockerCommand) {
      const cleanup = async (args: string[]) => {
        try {
          await execFileAsync(dockerCommand, args, {
            cwd: repoRoot, encoding: "utf8", maxBuffer: 4096, windowsHide: true, env: dockerCommandEnvironment()
          });
        } catch { cleanupFailed = true; }
      };
      if (registryStarted) await cleanup(["rm", "--force", registryContainerName]);
      if (networkCreated) await cleanup(["network", "rm", networkName]);
      await cleanup(["image", "rm", "--force", ...imageTags]);
    }
  }
  if (cleanupFailed) return {
    status: "failed", reasonCode: "npm_package_docker_cleanup_failed",
    evidence: { ...result.evidence, cleanupFailed: true }
  };
  return result;
}

function targetForTest(target: Record<string, any>, observation: Record<string, any>, evidenceKind: "cli" | "runtime"): Record<string, any> {
  if (observation.status === "not_run") return {
    kind: target.kind,
    ...(target.platform ? { platform: target.platform } : {}),
    status: "not_run", reasonCode: observation.reasonCode
  };
  const evidence = observation.evidence || {};
  return {
    kind: target.kind, platform: target.platform, status: observation.status,
    ...(observation.reasonCode ? { reasonCode: observation.reasonCode } : {}),
    evidence: evidenceKind === "cli" ? {
      consumerCount: evidence.consumerCount || evidence.completedConsumerCount || 0,
      normalInstallLifecycles: evidence.normalInstallLifecycles === true,
      allConsumersPackageOnly: evidence.allConsumersPackageOnly === true,
      allRuntimeExports: evidence.allRuntimeExports || 0,
      allTypeExports: evidence.allTypeExports || 0,
      statefulModuleIdentity: evidence.statefulModuleIdentity === true,
      gatewayExamples: evidence.gatewayExamples || 0,
      installedAdapterDescriptions: evidence.installedAdapterDescriptions || 0,
      installedCli: evidence.installedCli === true,
      publicServerCliHelp: evidence.publicServerCliHelp === true,
      publicServerBin: evidence.publicServerBin === true,
      installedMcpProxy: evidence.installedMcpProxy === true,
      uiBrowserInteraction: evidence.uiBrowserInteraction === true,
      lockBackedRegistryMirror: evidence.lockBackedRegistryMirror === true,
      mirroredPackageCount: evidence.mirroredPackageCount || 0,
      mirroredArtifactCount: evidence.mirroredArtifactCount || 0,
      failures: evidence.failures || [],
      runtime: evidence.runtime || {},
      npmVersion: evidence.npmVersion || evidence.toolchain?.npmVersion || "",
      consumer: evidence.consumer || {}
    } : {
      serverStartedAndStopped: evidence.serverStartedAndStopped === true,
      defaultHealthAndBootstrap: evidence.defaultHealthAndBootstrap === true,
      consoleAssetsSameOrigin: evidence.consoleAssetsSameOrigin === true,
      sqliteRoundTrip: evidence.sqliteRoundTrip === true,
      packagedMigrations: evidence.packagedMigrations === true,
      installedOfflineRestore: evidence.installedOfflineRestore === true,
      installedSchemaWorker: evidence.installedSchemaWorker === true,
      publicServerBin: evidence.publicServerBin === true,
      failures: evidence.failures || [],
      runtime: evidence.runtime || {},
      npmVersion: evidence.npmVersion || evidence.toolchain?.npmVersion || "",
      consumer: evidence.consumer || {}
    }
  };
}

async function runInstallabilityQualification({ reportPath, artifactDirectory }: Record<string, any>): Promise<void> {
  const repoRoot = process.cwd();
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-npm-package-qualification-"));
  const inputDirectory = path.join(workRoot, "input");
  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
    verifier: "tools/server-scripts/verify-npm-package-installability.ts",
    generatedAt: new Date().toISOString(), startedAt: new Date().toISOString(), tests: [], summary: {}
  };
  let selectedTargets: any[] = [];
  let dockerUnavailableReason = "";
  let sourceChecksPassed = false;
  let sourceFailure = "";

  try {
    const environment = await discoverLocalExecutionEnvironment();
    report.environment = environment;
    selectedTargets = [{ kind: "native", platform: environment.native.platform }];
    if (environment.docker.status === "available") selectedTargets.push({ kind: "local_docker", platform: environment.docker.platform });
    else dockerUnavailableReason = environment.docker.reasonCode;

    assert.ok(artifactDirectory, "npm_package_prepared_artifact_directory_required");
    await fs.mkdir(inputDirectory, { recursive: true });
    for (const source of [ISOLATED_CONSUMER_SOURCE, ISOLATED_REGISTRY_SOURCE]) {
      await fs.access(path.join(repoRoot, source));
      await fs.access(path.join(repoRoot, "dist", source.replace(/\.ts$/u, ".js")));
    }
    const rootPackage = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
    const nodeEngine = String(rootPackage.engines?.node || "");
    assert.ok(semver.validRange(nodeEngine), "npm_package_node_engine_contract_missing");
    const lockfile = JSON.parse(await fs.readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
    const releaseSet = await discoverReleaseSet({ rootDir: repoRoot });
    const packedArtifacts = await loadPreparedInstallabilityArtifacts({ artifactDirectory, rootDir: repoRoot });
    assert.equal(releaseSet.version, rootPackage.version, "npm_package_release_set_version_mismatch");
    const bundleEvidence = await assertPreparedProductBundleClosure({ rootDir: repoRoot, rootPackage, releaseSet, packedArtifacts });

    const expectedBin = "dist/apps/server/bin/meshrix.js";
    const expectedServerBin = "dist/tools/server-scripts/start-server.js";
    const expectedMcpBin = "dist/apps/server/bin/meshrix-mcp.js";
    assert.equal(rootPackage.bin?.meshrix, expectedBin, "npm_package_cli_bin_contract_invalid");
    assert.equal(rootPackage.bin?.["meshrix-server"], expectedServerBin, "npm_package_server_bin_contract_invalid");
    assert.equal(rootPackage.bin?.["meshrix-mcp"], expectedMcpBin, "npm_package_mcp_bin_missing");
    for (const lifecycleScript of ["preinstall", "install", "postinstall"]) {
      assert.equal(rootPackage.scripts?.[lifecycleScript], undefined, "npm_package_root_install_lifecycle_forbidden");
    }

    const candidate = {
      version: releaseSet.version,
      artifacts: packedArtifacts.map(({ name, version, filename, integrity }: Record<string, any>) => ({ name, version, filename, integrity }))
    };
    report.candidate = candidate;
    const rootArtifact = packedArtifacts.find(({ name }: Record<string, any>) => name === rootPackage.name);
    assert.ok(rootArtifact, "npm_package_root_artifact_missing");
    assert.match(await fs.readFile(path.join(repoRoot, expectedServerBin), "utf8"),
      /^#!\/usr\/bin\/env node\r?\n/u, "npm_package_server_bin_shebang_missing");
    assert.match(await fs.readFile(path.join(repoRoot, expectedMcpBin), "utf8"),
      /^#!\/usr\/bin\/env node\r?\n/u, "npm_package_server_bin_shebang_missing");

    let packedFileCount = 0;
    for (const artifact of packedArtifacts) {
      packedFileCount += artifact.files.length;
      assert.equal(artifact.files.some((file: string) => PLATFORM_ARTIFACT_PATTERN.test(file)), false, "npm_package_platform_artifact_forbidden");
    }
    const rootFiles = rootArtifact.files;
    for (const file of [
      expectedBin, expectedServerBin, expectedMcpBin,
      "node_modules/@meshrix/contracts/dist/operations/operation-registry.js",
      "node_modules/@meshrix/protocols/dist/mcp/adapter/gateway-installer/lib/cli/proxy-command.js",
      "node_modules/@meshrix/protocols/dist/mcp/adapter/gateway-installer/mcp-identity.js",
      "build/dist/index.html"
    ]) assert.ok(rootFiles.includes(file), "npm_package_required_artifact_missing");

    const packagePlan: any[] = [];
    for (const packageRecord of releaseSet.packages) {
      const artifact = packedArtifacts.find((entry: any) => entry.name === packageRecord.name);
      assert.ok(artifact, "npm_package_release_set_artifact_missing");
      const manifest = artifact.manifest;
      assert.equal(manifest.name, packageRecord.name, "npm_package_release_set_artifact_mismatch");
      assert.equal(manifest.version, packageRecord.version, "npm_package_release_set_version_mismatch");
      assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, "npm_package_files_contract_missing");
      assert.ok(manifest.license, "npm_package_license_contract_missing");
      assert.ok(manifest.engines?.node, "npm_package_node_engine_contract_missing");
      assert.equal(manifest.repository?.type, "git", "npm_package_repository_contract_missing");
      assert.ok(manifest.repository?.url, "npm_package_repository_url_missing");
      assert.ok(manifest.homepage, "npm_package_homepage_missing");
      assert.ok(manifest.bugs?.url, "npm_package_bug_tracker_missing");
      if (!packageRecord.root) assert.equal(manifest.repository?.directory, packageRecord.directory, "npm_package_repository_directory_mismatch");
      if (manifest.name.startsWith("@meshrix/")) assert.equal(manifest.publishConfig?.access, "public", "npm_package_scoped_access_not_public");
      packagePlan.push({ name: manifest.name, version: manifest.version, root: packageRecord.root === true, manifest });
    }

    const registryArtifacts = packedArtifacts.map((artifact: any) => ({
      name: String(artifact.name), version: String(artifact.version),
      tarballPath: path.posix.join("/artifacts", String(artifact.filename))
    }));
    await fs.writeFile(path.join(inputDirectory, "registry-artifacts.json"), JSON.stringify({ artifacts: registryArtifacts }, null, 2) + "\n");
    const verifierTools = Object.fromEntries(VERIFIER_TOOL_NAMES.map((name: string) => {
      const version = lockfile.packages?.["node_modules/" + name]?.version;
      assert.ok(version, "npm_package_locked_verifier_tool_missing_" + consumerDirectoryName(name));
      return [name, version];
    }));
    await fs.cp(path.join(repoRoot, "docs/examples/gateway"), path.join(inputDirectory, "gateway-examples"), { recursive: true });
    const consumerPlanPath = path.join(inputDirectory, "consumer-plan.json");
    await fs.writeFile(consumerPlanPath, JSON.stringify({ packages: packagePlan, verifierTools }, null, 2) + "\n");

    report.tests.push({ name: NPM_INSTALLABILITY_TEST_NAMES[0], status: "passed", evidence: {
      privateWorkspaceCount: bundleEvidence.privateWorkspaceCount,
      releasePackageCount: releaseSet.packages.length, rootMcpBinDeclared: true, rootPublicServerBinDeclared: true,
      standaloneConnectorPackageIncluded: false, versionLocked: true,
      bundledPackageCountByProduct: bundleEvidence.bundledPackageCountByProduct, rootInstallLifecycleHooks: false
    } });
    report.tests.push({ name: NPM_INSTALLABILITY_TEST_NAMES[1], status: "passed", evidence: {
      packageCount: packedArtifacts.length, packages: candidate.artifacts, fileCount: packedFileCount,
      bundledPackageCountByProduct: bundleEvidence.bundledPackageCountByProduct, platformArtifacts: false,
      preparedReleaseSet: true, preparedArtifactIntegrityVerified: true, rootMcpRuntimeSource: true,
      standaloneConnectorPackageIncluded: false, consoleBuildAssets: true, repositoryInstructionsExcluded: true, packedOnce: true
    } });
    sourceChecksPassed = true;

    const packageNames = releaseSet.packages.map((entry: any) => entry.name);
    const targetInputs = selectedTargets.map((target: any) => ({ ...target, nodeEngine, packageNames, artifactDirectory }));
    const targetResults = new Map<string, Record<string, any>>();
    for (const target of targetInputs) {
      const observation = target.kind === "native"
        ? await runNativeTarget({ repoRoot, workRoot, target, packedArtifacts, consumerPlanPath })
        : await runDockerTarget({ repoRoot, workRoot, target, rootPackage, releaseSet, inputDirectory, consumerPlanPath });
      targetResults.set(target.kind, observation);
    }

    const targetRows = [
      ...targetInputs.map((target: any) => ({ target, observation: targetResults.get(target.kind) })),
      ...(dockerUnavailableReason ? [{
        target: { kind: "local_docker", status: "not_run", reasonCode: dockerUnavailableReason },
        observation: { status: "not_run", reasonCode: dockerUnavailableReason }
      }] : [])
    ];
    for (const name of CONSUMER_TEST_NAMES) {
      const type = name === CONSUMER_TEST_NAMES[0] ? "cli" : "runtime";
      const targets = targetRows.map(({ target, observation }: any) => targetForTest(target, observation, type));
      const passed = targetInputs.every((target: any) => targetResults.get(target.kind)?.status === "passed");
      report.tests.push({ name, status: passed ? "passed" : "failed", evidence: { targets } });
    }

    const qualifiedPlatforms = targetInputs
      .filter((target: any) => CONSUMER_TEST_NAMES.every((name: string) => {
        const test = report.tests.find((entry: any) => entry.name === name);
        return test?.evidence?.targets?.some((entry: any) =>
          entry.kind === target.kind && entry.platform === target.platform && entry.status === "passed"
        ) === true;
      }))
      .map(({ kind, platform }: any) => ({ kind, platform }))
      .sort((left: any, right: any) => `${left.kind}/${left.platform}`.localeCompare(`${right.kind}/${right.platform}`));
    report.summary = {
      testCount: report.tests.length,
      failedCount: report.tests.filter((test: any) => test.status === "failed").length,
      releaseReady: sourceChecksPassed && qualifiedPlatforms.length > 0
        && targetInputs.every((target: any) => targetResults.get(target.kind)?.status === "passed"),
      qualifiedPlatforms,
      reportLeakScan: true
    };
  } catch (error: unknown) {
    sourceFailure = failureCode(error);
    for (const name of NPM_INSTALLABILITY_TEST_NAMES) {
      if (report.tests.some((test: any) => test.name === name)) continue;
      if (CONSUMER_TEST_NAMES.includes(name)) {
        const targets: Record<string, any>[] = selectedTargets.map((target: any) => ({
          kind: target.kind, platform: target.platform, status: "not_run",
          reasonCode: "npm_package_qualification_precondition_failed"
        }));
        if (dockerUnavailableReason) targets.push({ kind: "local_docker", status: "not_run", reasonCode: dockerUnavailableReason });
        report.tests.push({ name, status: "failed", evidence: { errorCode: sourceFailure, targets } });
      } else {
        report.tests.push({ name, status: "failed", evidence: { errorCode: sourceFailure } });
      }
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    try {
      report.summary = {
        ...report.summary,
        testCount: report.tests.length,
        failedCount: report.tests.filter((test: any) => test.status === "failed").length,
        releaseReady: report.summary?.releaseReady === true && sourceFailure === "",
        reportLeakScan: false
      };
      assertNoLeak(report, "npm package installability report");
      report.summary.reportLeakScan = true;
      const finalPath = path.resolve(reportPath || DEFAULT_REPORT_PATH);
      await fs.mkdir(path.dirname(finalPath), { recursive: true });
      await fs.writeFile(finalPath, JSON.stringify(report, null, 2) + "\n");
    } finally {
      await fs.rm(workRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  }

  if (report.summary.releaseReady === true) {
    console.log("[npm-package-installability] releaseReady=true qualifiedPlatforms=" + report.summary.qualifiedPlatforms
      .map((target: any) => `${target.kind}:${target.platform}`).join(","));
  } else {
    process.exitCode = 1;
    console.error("[npm-package-installability] failed code=" + (sourceFailure || "npm_package_consumer_qualification_failed"));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runInstallabilityQualification({
    reportPath: argumentValue("--report-path") || DEFAULT_REPORT_PATH,
    artifactDirectory: artifactDirectoryArgument()
  });
}
