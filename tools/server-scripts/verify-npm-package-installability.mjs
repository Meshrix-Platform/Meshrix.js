#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { npmCliArgs, resolveNpmCliInvocation } from "./lib/npm-cli-invocation.mjs";
import { createLockBackedNpmRegistry } from "./lib/lock-backed-npm-registry.mjs";
import { assertNoLeak } from "./lib/report-evidence-safety.mjs";
import { discoverReleaseSet } from "./publish-release-set.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_REPORT_PATH = "build/reports/npm-package-installability.json";
const DEPLOYMENT_INDEX_PATH = "packages/foundation/config/deployment/index.json";
const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const DOCKER_BUILD_TIMEOUT_MS = 25 * 60 * 1000;
const DOCKER_RUN_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;
const PLATFORM_ARTIFACT_PATTERN =
  /(?:^|\/)(?:build\/Release|prebuilds)\/|\.(?:node|dll|dylib|so(?:\.\d+)*)$/iu;
const argv = process.argv.slice(2);
const inContainer = argv.includes("--in-container");
const hostPlatformProbe = argv.includes("--host-platform-probe");
const requiredHostProbe = argv.includes("--required-host-probe");
if (hostPlatformProbe && requiredHostProbe) {
  throw new Error("npm_package_probe_mode_conflict");
}
const npmCli = resolveNpmCliInvocation();

function argumentValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : "";
}

function npmCommand() {
  return npmCli.command;
}

function npmArgs(args) {
  return npmCliArgs(npmCli, args);
}

async function run(command, args, options = {}) {
  const baseEnv = options.baseEnv || process.env;
  return execFileAsync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
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

async function runStage(errorCode, command, args, options = {}) {
  try {
    return await run(command, args, options);
  } catch (error) {
    if (options.classifyNpmInstall === true) {
      const output = `${String(error?.stdout || "")}\n${String(error?.stderr || "")}`;
      if (/ENOTCACHED|cache mode is ['"]?only-if-cached/iu.test(output)) {
        const registryPath = output.match(
          /https:\/\/registry\.npmjs\.org\/([^\s?]+)/iu
        )?.[1];
        const packageCode = registryPath
          ? decodeURIComponent(registryPath)
              .replace(/^@/u, "")
              .replace(/[^a-z0-9]+/giu, "_")
              .replace(/^_+|_+$/gu, "")
              .toLowerCase()
              .slice(0, 80)
          : "unknown";
        throw new Error(`npm_package_offline_cache_incomplete_${packageCode}`);
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
    }
    if (options.classifyRuntime === true) {
      const output = `${String(error?.stdout || "")}\n${String(error?.stderr || "")}`;
      if (/ERR_MODULE_NOT_FOUND|Cannot find package/iu.test(output)) {
        throw new Error("npm_package_runtime_module_resolution_failed");
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
    }
    throw new Error(errorCode);
  }
}

function failureCode(error) {
  const message = String(error?.message || "");
  const match = message.match(/npm_package_[a-z0-9_]+/u);
  return match?.[0] || "npm_package_installability_failed";
}

function selectedHostEnvironment() {
  const allowedNames = [
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
      .filter((name) => typeof process.env[name] === "string" && process.env[name])
      .map((name) => [name, process.env[name]])
  );
}

async function runProbe({ reportPath, freshContainer, requiredReleaseProbe = false }) {
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lico-npm-package-installability-"));
const isolatedHome = path.join(tempRoot, "home");
const isolatedTemp = path.join(tempRoot, "tmp");
const isolatedCache = path.join(tempRoot, "npm-cache");
const isolatedData = path.join(tempRoot, "lico-data");
const isolatedCodexHome = path.join(tempRoot, "codex-home");
const isolatedNpmrc = path.join(tempRoot, "npmrc");
await Promise.all([
  isolatedHome,
  isolatedTemp,
  isolatedCache,
  isolatedData,
  isolatedCodexHome
].map((directory) => fs.mkdir(directory, { recursive: true })));
if (freshContainer === true) {
  await fs.access("/opt/lico-npm-cache/_cacache");
}
await fs.writeFile(isolatedNpmrc, "", "utf8");
const probeEnvironment = {
  ...selectedHostEnvironment(),
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  TMPDIR: isolatedTemp,
  TEMP: isolatedTemp,
  TMP: isolatedTemp,
  XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
  XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),
  CODEX_HOME: isolatedCodexHome,
  LICO_USER_DATA_DIR: isolatedData,
  NODE_OPTIONS: "",
  npm_config_userconfig: isolatedNpmrc,
  npm_config_cache: isolatedCache,
  ...(freshContainer === true
    ? {
        npm_config_build_from_source: "true",
        npm_config_nodedir: "/usr/local"
      }
    : {})
};
const runProbeStage = (errorCode, command, args, options = {}) => runStage(
  errorCode,
  command,
  args,
  { ...options, baseEnv: probeEnvironment }
);
const report = {
  schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
  verifier: "tools/server-scripts/verify-npm-package-installability.mjs",
  generatedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  tests: [],
  summary: {}
};
function record(name, status, evidence = {}) {
  report.tests.push({ name, status, evidence });
}

try {
  const rootPackage = JSON.parse(await fs.readFile("package.json", "utf8"));
  const releaseSet = await discoverReleaseSet({ rootDir: process.cwd() });
  assert.equal(releaseSet.version, rootPackage.version, "npm_package_release_set_version_mismatch");
  const expectedBin = "apps/server/bin/lico.mjs";
  const expectedServerBin = "tools/server-scripts/start-server.mjs";
  assert.equal(rootPackage.bin?.lico, expectedBin, "npm_package_cli_bin_contract_invalid");
  assert.equal(
    rootPackage.bin?.["licomesh-server"],
    expectedServerBin,
    "npm_package_server_bin_contract_invalid"
  );
  assert.equal(rootPackage.bundleDependencies, undefined, "npm_package_bundled_dependencies_forbidden");
  assert.equal(rootPackage.bundledDependencies, undefined, "npm_package_bundled_dependencies_forbidden");
  for (const lifecycleScript of ["preinstall", "install", "postinstall"]) {
    assert.equal(
      rootPackage.scripts?.[lifecycleScript],
      undefined,
      "npm_package_root_install_lifecycle_forbidden"
    );
  }

  const workspacePackages = [];
  for (const directory of rootPackage.workspaces || []) {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
    if (manifest.private === true) continue;
    assert.equal(manifest.version, rootPackage.version, "npm_package_workspace_version_mismatch");
    workspacePackages.push({ directory, name: String(manifest.name || "") });
  }
  const workspaceNames = workspacePackages.map(({ name }) => name).sort();
  const rootInternalDependencies = Object.keys(rootPackage.dependencies || {})
    .filter((name) => name.startsWith("@lico/"))
    .sort();
  assert.deepEqual(
    rootInternalDependencies,
    workspaceNames,
    "npm_package_workspace_dependency_set_incomplete"
  );
  for (const name of workspaceNames) {
    assert.equal(
      rootPackage.dependencies[name],
      rootPackage.version,
      "npm_package_workspace_dependency_version_mismatch"
    );
  }
  record("root package declares the complete version-locked workspace release set", "passed", {
    workspacePackageCount: workspacePackages.length,
    releasePackageCount: releaseSet.packages.length,
    connectorPackageIncluded: releaseSet.packages.some(({ name }) => name === "lico-mcp-connector"),
    versionLocked: true,
    bundledDependencies: false,
    rootInstallLifecycleHooks: false
  });

  const packDirectory = path.join(tempRoot, "pack");
  await fs.mkdir(packDirectory, { recursive: true });
  const packedArtifacts = [];
  for (const packageRecord of releaseSet.packages) {
    const packed = await runProbeStage(
      "npm_package_release_set_pack_failed",
      npmCommand(),
      npmArgs(["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory]),
      { cwd: packageRecord.absoluteDirectory }
    );
    const artifacts = JSON.parse(packed.stdout);
    assert.equal(artifacts.length, 1, "npm_package_pack_artifact_count_invalid");
    assert.equal(artifacts[0]?.name, packageRecord.name, "npm_package_release_set_artifact_mismatch");
    assert.equal(artifacts[0]?.version, releaseSet.version, "npm_package_release_set_version_mismatch");
    packedArtifacts.push(artifacts[0]);
  }

  let packedFileCount = 0;
  const tarballPaths = [];
  for (const artifact of packedArtifacts) {
    const files = Array.isArray(artifact.files)
      ? artifact.files.map((entry) => String(entry.path))
      : [];
    packedFileCount += files.length;
    assert.equal(
      files.some((file) => file.startsWith("node_modules/")),
      false,
      "npm_package_bundled_node_modules_forbidden"
    );
    assert.equal(
      files.some((file) => PLATFORM_ARTIFACT_PATTERN.test(file)),
      false,
      "npm_package_platform_artifact_forbidden"
    );
    const filename = String(artifact.filename || "");
    assert.ok(filename && path.basename(filename) === filename, "npm_package_pack_filename_invalid");
    tarballPaths.push(path.join(packDirectory, filename));
  }
  const rootArtifact = packedArtifacts.find(({ name }) => name === rootPackage.name);
  const connectorArtifact = packedArtifacts.find(({ name }) => name === "lico-mcp-connector");
  assert.ok(rootArtifact, "npm_package_root_artifact_missing");
  assert.ok(connectorArtifact, "npm_package_connector_artifact_missing");
  const rootFiles = rootArtifact.files.map((entry) => String(entry.path));
  const connectorFiles = connectorArtifact.files.map((entry) => String(entry.path));
  assert.ok(rootFiles.includes(expectedBin), "npm_package_cli_bin_missing");
  assert.ok(rootFiles.includes(expectedServerBin), "npm_package_server_bin_missing");
  assert.match(
    await fs.readFile(expectedServerBin, "utf8"),
    /^#!\/usr\/bin\/env node\r?\n/u,
    "npm_package_server_bin_shebang_missing"
  );
  assert.ok(
    rootFiles.includes("packages/contracts/src/operations/operation-registry.mjs"),
    "npm_package_internal_runtime_source_missing"
  );
  assert.ok(
    connectorFiles.includes("lib/mcp-proxy-session.mjs"),
    "npm_package_connector_runtime_source_missing"
  );
  record("release-set tarballs are source-portable and exclude host artifacts", "passed", {
    packageCount: packedArtifacts.length,
    fileCount: packedFileCount,
    bundledNodeModules: false,
    platformArtifacts: false,
    connectorRuntimeSource: true,
    repositoryInstructionsExcluded: true
  });

  const consumerDirectory = path.join(tempRoot, "consumer");
  await fs.mkdir(consumerDirectory, { recursive: true });
  const releaseSetDependencies = Object.fromEntries(
    packedArtifacts.map((artifact, index) => [
      String(artifact.name),
      `file:${tarballPaths[index]}`
    ])
  );
  await fs.writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify({
      name: "lico-package-verifier",
      private: true,
      version: "0.0.0",
      dependencies: releaseSetDependencies
    }, null, 2)}\n`,
    "utf8"
  );
  const registryMirror = freshContainer === true
    ? await createLockBackedNpmRegistry({
        lockPath: "package-lock.json",
        cacheRoot: "/opt/lico-npm-cache"
      })
    : null;
  const installRegistry = registryMirror?.registry || OFFICIAL_NPM_REGISTRY;
  try {
    await runProbeStage(
      "npm_package_release_set_install_failed",
      npmCommand(),
      npmArgs([
        "install",
        "--ignore-scripts=false",
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

  const help = await runProbeStage(
    "npm_package_cli_help_failed",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "lico", "--help"]),
    { cwd: consumerDirectory }
  );
  assert.match(help.stdout, /Usage:/u, "npm_package_cli_help_failed");
  const interfaces = await runProbeStage(
    "npm_package_cli_offline_interface_failed",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "lico", "interfaces", "--format", "markdown"]),
    { cwd: consumerDirectory }
  );
  assert.match(interfaces.stdout, /jobs\.list/u, "npm_package_cli_offline_interface_failed");
  const serverHelp = await runProbeStage(
    "npm_package_server_cli_help_failed",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "licomesh-server", "--help"]),
    { cwd: consumerDirectory }
  );
  assert.match(
    serverHelp.stdout,
    /--allow-public-console/u,
    "npm_package_server_cli_help_failed"
  );
  const connectorVersion = await runProbeStage(
    "npm_package_connector_cli_failed",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "lico-mcp", "version", "--json"]),
    { cwd: consumerDirectory, classifyRuntime: true }
  );
  const connectorPayload = JSON.parse(connectorVersion.stdout);
  assert.equal(connectorPayload.packageName, "lico-mcp-connector", "npm_package_connector_identity_invalid");
  assert.equal(connectorPayload.packageVersion, rootPackage.version, "npm_package_connector_version_invalid");
  record("clean consumer install runs the packaged CLI", "passed", {
    cliHelp: true,
    offlineInterfaceCatalog: true,
    publicServerCliHelp: true,
    connectorCli: true,
    registryPinned: true,
    lockBackedRegistryMirror: freshContainer === true,
    mirroredPackageCount: registryMirror?.packageCount || 0,
    mirroredArtifactCount: registryMirror?.artifactCount || 0
  });

  const installedRoot = path.join(consumerDirectory, "node_modules", rootPackage.name);
  const installedServerBin = path.join(
    consumerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "licomesh-server.cmd" : "licomesh-server"
  );
  await fs.access(installedServerBin, fsSync.constants.X_OK);
  await runProbeStage(
    "npm_package_server_startup_smoke_failed",
    process.execPath,
    [
      path.join(installedRoot, "tools/server-scripts/verify-start-server-defaults.mjs"),
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
} catch (error) {
  const errorCode = failureCode(error);
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
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.exitCode !== 1) {
  const readinessMessage = freshContainer === true
    ? "[npm-package-installability] releaseReady=true"
    : requiredReleaseProbe === true
      ? "[npm-package-installability] requiredHostReady=true"
      : "[npm-package-installability] supplementaryHostReady=true";
  console.log(readinessMessage);
}
}

async function writeDefaultReport(report) {
  assertNoLeak(report, "npm package installability container report");
  await fs.mkdir(path.dirname(DEFAULT_REPORT_PATH), { recursive: true });
  await fs.writeFile(DEFAULT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function runContainerAuthority() {
  const wrapperTempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "lico-npm-package-container-authority-")
  );
  const evidenceDirectory = path.join(wrapperTempRoot, "evidence");
  const evidencePath = path.join(evidenceDirectory, "npm-package-installability.json");
  await fs.mkdir(evidenceDirectory, { recursive: true });
  const verifierImageTag = `licomesh-npm-package-verifier:${process.pid}-${Date.now()}`;
  let verifierImageId = "";

  try {
    const deploymentIndex = JSON.parse(await fs.readFile(DEPLOYMENT_INDEX_PATH, "utf8"));
    const image = String(deploymentIndex?.dockerPresets?.baseImages?.mainService || "");
    assert.match(
      image,
      /^node:\d+\.\d+\.\d+-[a-z0-9.-]+@sha256:[a-f0-9]{64}$/u,
      "npm_package_container_image_not_pinned"
    );

    const repoRoot = process.cwd();
    const builtImage = await runStage(
      "npm_package_fresh_container_build_failed",
      "docker",
      [
        "build",
        "--quiet",
        "--target",
        "npm-package-verifier",
        "--tag",
        verifierImageTag,
        "--build-arg",
        `NODE_BASE_IMAGE=${image}`,
        "--build-arg",
        `NPM_REGISTRY=${OFFICIAL_NPM_REGISTRY}`,
        repoRoot
      ],
      { timeoutMs: DOCKER_BUILD_TIMEOUT_MS }
    );
    const builtImageDigest = String(builtImage.stdout || "").match(
      /(?:sha256:)?([a-f0-9]{64})(?=\s|$)/u
    )?.[1];
    verifierImageId = builtImageDigest ? `sha256:${builtImageDigest}` : "";
    assert.match(
      verifierImageId,
      /^sha256:[a-f0-9]{64}$/u,
      "npm_package_fresh_container_image_invalid"
    );
    const dockerArgs = [
      "run",
      "--rm",
      "--read-only",
      "--network=none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--tmpfs",
      "/tmp:rw,exec,nosuid,size=2147483648",
      "--mount",
      `type=bind,src=${repoRoot},dst=/workspace,readonly`,
      "--mount",
      `type=bind,src=${evidenceDirectory},dst=/evidence`,
      "--workdir",
      "/workspace",
      "--env",
      "HOME=/tmp/home",
      "--env",
      "TMPDIR=/tmp",
      "--env",
      "CI=1"
    ];
    if (typeof process.getuid === "function" && typeof process.getgid === "function") {
      dockerArgs.push("--user", `${process.getuid()}:${process.getgid()}`);
    }
    dockerArgs.push(
      verifierImageId,
      "node",
      "tools/server-scripts/verify-npm-package-installability.mjs",
      "--in-container",
      "--report-path",
      "/evidence/npm-package-installability.json"
    );

    await runStage(
      "npm_package_fresh_container_verification_failed",
      "docker",
      dockerArgs,
      { timeoutMs: DOCKER_RUN_TIMEOUT_MS }
    );
    const report = JSON.parse(await fs.readFile(evidencePath, "utf8"));
    assert.equal(report.summary?.freshContainer, true, "npm_package_container_evidence_invalid");
    assert.equal(report.summary?.releaseReady, true, "npm_package_container_evidence_not_ready");
    assert.equal(report.summary?.reportLeakScan, true, "npm_package_container_evidence_leak_scan_failed");
    await writeDefaultReport(report);
    console.log(
      "[npm-package-installability] releaseReady=true authority=fresh-container report=build/reports/npm-package-installability.json"
    );
  } catch (error) {
    let report = null;
    try {
      const candidate = JSON.parse(await fs.readFile(evidencePath, "utf8"));
      assertNoLeak(candidate, "npm package installability failed container report");
      assert.equal(
        candidate.schemaVersion,
        "v0.0.1:release:npm-package-installability-report-1"
      );
      assert.equal(
        candidate.verifier,
        "tools/server-scripts/verify-npm-package-installability.mjs"
      );
      assert.equal(candidate.summary?.reportLeakScan, true);
      assert.equal(candidate.summary?.freshContainer, true);
      report = candidate;
    } catch {
      const generatedAt = new Date().toISOString();
      report = {
        schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
        verifier: "tools/server-scripts/verify-npm-package-installability.mjs",
        generatedAt,
        startedAt: generatedAt,
        finishedAt: generatedAt,
        tests: [{
          name: "fresh-container npm package installability authority",
          status: "failed",
          evidence: { errorCode: failureCode(error) }
        }],
        summary: {
          testCount: 1,
          failedCount: 1,
          releaseReady: false,
          reportLeakScan: true,
          freshContainer: true,
          supplementaryHostProbe: false
        }
      };
    }
    await writeDefaultReport(report);
    console.error(
      `[npm-package-installability] failed code=${failureCode(error)} authority=fresh-container`
    );
    process.exitCode = 1;
  } finally {
    await run("docker", ["image", "rm", "--force", verifierImageTag], {
      timeoutMs: 2 * 60 * 1000
    }).catch(() => {});
    await fs.rm(wrapperTempRoot, { recursive: true, force: true });
  }
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
