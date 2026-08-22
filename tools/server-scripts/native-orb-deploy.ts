#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MACHINE_PATTERN: any = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/u;
const REVISION_PATTERN: any = /^[0-9a-f]{40}$/u;
const UNIT_PATTERN: any = /^[a-zA-Z0-9_.@-]+\.service$/u;
const RUNTIME_ID_PATTERN: any = /^\d+\.\d+\.\d+:\d+$/u;

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

function fail(code?: any, message?: any) : never {
  const error: Error & Record<string, any> = new Error(String(message || code));
  error.code = code;
  throw error;
}

export function parseNativeOrbDeploymentArgs(argv?: any) : any {
  const args: any[] = Array.isArray(argv) ? argv.map(String) : [];
  let machine: any = "";
  let publicOrigin: any = "";
  for (let indexValue: any = 0; indexValue < args.length; indexValue += 1) {
    const argument: any = args[indexValue];
    if (argument === "--machine") {
      machine = String(args[indexValue + 1] || "");
      indexValue += 1;
      continue;
    }
    if (argument === "--origin") {
      publicOrigin = String(args[indexValue + 1] || "");
      indexValue += 1;
      continue;
    }
    fail("native_orb_argument_unknown", "Use --machine and --origin.");
  }
  if (!MACHINE_PATTERN.test(machine)) {
    fail("native_orb_machine_invalid", "OrbStack machine is required.");
  }
  let origin: any;
  try {
    origin = new URL(publicOrigin);
  } catch {
    fail("native_orb_origin_invalid", "A complete public origin is required.");
  }
  if (
    !["http:", "https:"].includes(origin.protocol)
    || origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
    || origin.port !== "7228"
  ) {
    fail("native_orb_origin_invalid", "The public origin must use port 7228 without credentials or a path.");
  }
  return Object.freeze({ machine, publicOrigin: origin.origin });
}

function runOrb({
  machine,
  args = [],
  translatePaths = false,
  timeout = 60_000,
  allowFailure = false,
  code = "native_orb_command_failed",
}: Record<string, any> = {}) : any {
  const orbArgs: any[] = ["-m", machine];
  if (translatePaths === true) orbArgs.push("-p");
  orbArgs.push(...args.map(String));
  const result: any = spawnSync("orb", orbArgs, {
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (allowFailure !== true && result.status !== 0) {
    fail(code, "Native OrbStack deployment command failed.");
  }
  return result;
}

function orbText(machine?: any, args?: any, options?: any) : any {
  return String(runOrb({ machine, args, ...options }).stdout || "").trim();
}

function gitHead(repoRoot?: any) : any {
  const result: any = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
  const revision: any = String(result.stdout || "").trim();
  if (result.status !== 0 || !REVISION_PATTERN.test(revision)) {
    fail("native_orb_candidate_invalid", "Current candidate is unavailable.");
  }
  return revision;
}

export function resolveServiceNodeExecutable(execStart?: any) : any {
  const match: any = String(execStart || "").match(/(?:^|\{\s*)path=([^ ;]+)\s*;/u);
  const executable: any = String(match?.[1] || "");
  if (!path.posix.isAbsolute(executable) || path.posix.basename(executable) !== "node") {
    fail("native_orb_service_node_invalid", "Native service must use an absolute Node.js executable.");
  }
  return executable;
}

function candidateArchive(repoRoot?: any, sourceRevision?: any) : any {
  const cacheRoot: any = path.join(os.homedir(), ".cache", "meshrix-js", "native-orb-deploy");
  const archivePath: any = path.join(cacheRoot, `${sourceRevision}.tar`);
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  if (fs.existsSync(archivePath)) return Object.freeze({ archivePath, resumed: true });
  const temporary: any = `${archivePath}.${process.pid}.tmp`;
  const result: any = spawnSync("git", [
    "archive",
    "--format=tar",
    "-o",
    temporary,
    sourceRevision,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    fs.rmSync(temporary, { force: true });
    fail("native_orb_archive_failed", "Candidate archive failed.");
  }
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, archivePath);
  return Object.freeze({ archivePath, resumed: false });
}

function writeRemoteFile(machine?: any, filePath?: any, contents?: any) : any {
  const encoded: any = Buffer.from(String(contents), "utf8").toString("base64");
  runOrb({
    machine,
    args: [
      "sh",
      "-lc",
      "umask 077; printf %s \"$1\" | base64 -d > \"$2\"",
      "meshrix-write-file",
      encoded,
      filePath,
    ],
    timeout: 30_000,
    code: "native_orb_service_write_failed",
  });
}

async function probeOrigin(publicOrigin?: any) : Promise<any> {
  try {
    const health: any = await fetch(`${publicOrigin}/api/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    const root: any = await fetch(`${publicOrigin}/`, {
      signal: AbortSignal.timeout(5000),
    });
    const body: any = await root.text();
    return Object.freeze({
      healthOk: health.ok === true,
      consoleOk: root.ok === true
        && /html/iu.test(String(root.headers.get("content-type") || ""))
        && /<!doctype html|<html/iu.test(body),
      healthz: Number(health.status),
      console: Number(root.status),
    });
  } catch {
    return Object.freeze({ healthOk: false, consoleOk: false, healthz: 0, console: 0 });
  }
}

export async function deployNativeOrbCandidate({
  machine,
  publicOrigin,
  repoRoot = repoRootFromMeta(),
}: Record<string, any> = {}) : Promise<any> {
  const parsed: any = parseNativeOrbDeploymentArgs([
    "--machine",
    machine,
    "--origin",
    publicOrigin,
  ]);
  const sourceRevision: any = gitHead(repoRoot);
  const stages: any[] = [];
  const complete: any = (id?: any, resumed = false) : any => {
    stages.push(Object.freeze({ id, status: resumed ? "resumed" : "completed" }));
  };

  const distribution: any = orbText(parsed.machine, [
    "sh",
    "-lc",
    ". /etc/os-release; printf %s \"$ID\"",
  ], { timeout: 15_000 });
  if (!["ubuntu", "debian"].includes(distribution)) {
    fail("native_orb_distribution_unsupported", "Target VM must use Ubuntu or Debian.");
  }
  const unit: any = orbText(parsed.machine, [
    "sh",
    "-lc",
    "systemctl --user list-unit-files --type=service --no-legend | awk 'tolower($1) ~ /meshrix/ {print $1; exit}'",
  ], { timeout: 15_000 });
  if (!UNIT_PATTERN.test(unit)) {
    fail("native_orb_service_missing", "Existing native Meshrix.js service is unavailable.");
  }
  const currentWorkingDirectory: any = orbText(parsed.machine, [
    "systemctl",
    "--user",
    "show",
    unit,
    "-p",
    "WorkingDirectory",
    "--value",
  ], { timeout: 15_000 });
  const fragmentPath: any = orbText(parsed.machine, [
    "systemctl",
    "--user",
    "show",
    unit,
    "-p",
    "FragmentPath",
    "--value",
  ], { timeout: 15_000 });
  const originalWorkingDirectory: any = orbText(parsed.machine, [
    "sh",
    "-lc",
    [
      "raw=$(sed -n 's/^WorkingDirectory=//p' \"$1\" | tail -n 1)",
      "case \"$raw\" in %h/*) suffix=${raw#%h/}; printf %s \"$HOME/$suffix\";; /*) printf %s \"$raw\";; esac",
    ].join("; "),
    "meshrix-original-working-directory",
    fragmentPath,
  ], { timeout: 15_000 });
  const currentExecStart: any = orbText(parsed.machine, [
    "systemctl",
    "--user",
    "show",
    unit,
    "-p",
    "ExecStart",
    "--value",
  ], { timeout: 15_000 });
  const serviceNode: any = resolveServiceNodeExecutable(currentExecStart);
  const serviceNodeDirectory: any = path.posix.dirname(serviceNode);
  const serviceNpmCli: any = orbText(parsed.machine, [
    "sh",
    "-lc",
    [
      "prefix=$(dirname \"$(dirname \"$1\")\")",
      "for candidate in \"$prefix/lib/node_modules/npm/bin/npm-cli.js\" /usr/share/nodejs/npm/bin/npm-cli.js; do",
      "  if test -f \"$candidate\"; then readlink -f \"$candidate\"; exit 0; fi",
      "done",
      "exit 1",
    ].join("\n"),
    "meshrix-service-npm",
    serviceNode,
  ], { timeout: 15_000, code: "native_orb_node_unavailable" });
  const nodeReady: any = runOrb({
    machine: parsed.machine,
    args: [
      serviceNode,
      "-e",
      "const [major,minor]=process.versions.node.split('.').map(Number);process.exit((major===22&&minor>=18)||(major===24&&minor>=3)||major>24?0:1)",
    ],
    allowFailure: true,
    timeout: 15_000,
  }).status === 0;
  const npmReady: any = runOrb({
    machine: parsed.machine,
    args: [serviceNode, serviceNpmCli, "--version"],
    allowFailure: true,
    timeout: 15_000,
  }).status === 0;
  const runtimeId: any = orbText(parsed.machine, [
    serviceNode,
    "-p",
    "process.versions.node+':'+process.versions.modules",
  ], { timeout: 15_000, code: "native_orb_node_unavailable" });
  if (!nodeReady || !npmReady || !RUNTIME_ID_PATTERN.test(runtimeId)) {
    fail("native_orb_node_unavailable", "The service Node.js toolchain is unavailable or unsupported.");
  }
  complete("runtime", true);

  const releaseParent: any = path.posix.join(
    path.posix.dirname(originalWorkingDirectory),
    "releases",
  );
  const dropInDirectory: any = orbText(parsed.machine, [
    "sh",
    "-lc",
    "printf %s \"$HOME/.config/systemd/user/$1.d\"",
    "meshrix-drop-in",
    unit,
  ], { timeout: 15_000 });
  if (
    !originalWorkingDirectory
    || originalWorkingDirectory === "/"
    || originalWorkingDirectory === path.posix.dirname(originalWorkingDirectory)
    || currentExecStart.includes(currentWorkingDirectory)
    || (
      currentWorkingDirectory !== originalWorkingDirectory
      && !currentWorkingDirectory.startsWith(`${releaseParent}/`)
    )
  ) {
    fail("native_orb_service_layout_unsupported", "Native service must use a working-directory-relative command.");
  }
  if (!/--with-ui|start:console|start-all/u.test(currentExecStart)) {
    fail("native_orb_console_mode_required", "Native service must serve the Web Console.");
  }
  const existingProgramValid: any = runOrb({
    machine: parsed.machine,
    args: [
      "node",
      "-e",
      "const p=require(process.argv[1]);process.exit(p.name==='meshrix.js'?0:1)",
      path.posix.join(originalWorkingDirectory, "package.json"),
    ],
    allowFailure: true,
    timeout: 15_000,
  }).status === 0;
  if (!existingProgramValid) {
    fail("native_orb_previous_program_unverified", "Previous program directory is not a verified Meshrix.js source tree.");
  }

  const archive: any = candidateArchive(repoRoot, sourceRevision);
  complete("candidate", archive.resumed === true);
  const translatedArchive: any = orbText(parsed.machine, ["readlink", "-f", archive.archivePath], {
    translatePaths: true,
    timeout: 15_000,
  });
  const markerPath: any = path.posix.join(originalWorkingDirectory, ".meshrix-source-revision");
  const sourceReady: any = orbText(parsed.machine, [
    "sh",
    "-lc",
    `test -f "$1" && test "$(cat "$1")" = "$2" && test -f "$3/package.json" && printf ready`,
    "meshrix-release-check",
    markerPath,
    sourceRevision,
    originalWorkingDirectory,
  ], { allowFailure: true, timeout: 15_000 }) === "ready";
  if (!sourceReady) {
    runOrb({
      machine: parsed.machine,
      args: ["systemctl", "--user", "stop", unit],
      timeout: 120_000,
      code: "native_orb_previous_service_stop_failed",
    });
    runOrb({
      machine: parsed.machine,
      args: ["rm", "-rf", originalWorkingDirectory, releaseParent],
      timeout: 60_000,
      code: "native_orb_release_prepare_failed",
    });
    runOrb({
      machine: parsed.machine,
      args: ["install", "-d", "-m", "0700", originalWorkingDirectory],
      timeout: 30_000,
      code: "native_orb_release_prepare_failed",
    });
    runOrb({
      machine: parsed.machine,
      args: ["tar", "-xf", translatedArchive, "-C", originalWorkingDirectory],
      timeout: 120_000,
      code: "native_orb_transfer_failed",
    });
    writeRemoteFile(parsed.machine, markerPath, `${sourceRevision}\n`);
  }
  complete("transfer", sourceReady);

  const dependencyMarker: any = path.posix.join(originalWorkingDirectory, ".meshrix-dependencies-ready");
  const toolchainState: any = `${sourceRevision}:${runtimeId}`;
  const dependenciesReady: any = orbText(parsed.machine, [
    "sh",
    "-lc",
    `test -f "$1" && test "$(cat "$1")" = "$2" && test -d "$3/node_modules" && printf ready`,
    "meshrix-dependencies-check",
    dependencyMarker,
    toolchainState,
    originalWorkingDirectory,
  ], { allowFailure: true, timeout: 15_000 }) === "ready";
  if (!dependenciesReady) {
    runOrb({
      machine: parsed.machine,
      args: [
        "sh",
        "-lc",
        "export PATH=\"$1:$PATH\"; cd \"$2\" && exec \"$3\" \"$4\" ci --no-audit --no-fund",
        "meshrix-dependencies",
        serviceNodeDirectory,
        originalWorkingDirectory,
        serviceNode,
        serviceNpmCli,
      ],
      timeout: 1_200_000,
      code: "native_orb_dependency_install_failed",
    });
    writeRemoteFile(parsed.machine, dependencyMarker, `${toolchainState}\n`);
  }
  complete("dependencies", dependenciesReady);

  const buildMarker: any = path.posix.join(originalWorkingDirectory, ".meshrix-build-ready");
  const buildReady: any = dependenciesReady && orbText(parsed.machine, [
    "sh",
    "-lc",
    `test -f "$1" && test "$(cat "$1")" = "$2" && test -f "$3/build/dist/index.html" && printf ready`,
    "meshrix-build-check",
    buildMarker,
    toolchainState,
    originalWorkingDirectory,
  ], { allowFailure: true, timeout: 15_000 }) === "ready";
  if (!buildReady) {
    runOrb({
      machine: parsed.machine,
      args: [
        "sh",
        "-lc",
        "export PATH=\"$1:$PATH\"; cd \"$2\" && exec \"$3\" \"$4\" run build",
        "meshrix-build",
        serviceNodeDirectory,
        originalWorkingDirectory,
        serviceNode,
        serviceNpmCli,
      ],
      timeout: 1_200_000,
      code: "native_orb_build_failed",
    });
    writeRemoteFile(parsed.machine, buildMarker, `${toolchainState}\n`);
  }
  complete("build", buildReady);

  const nativeRuntimeReady: any = runOrb({
    machine: parsed.machine,
    args: [
      "sh",
      "-lc",
      "export PATH=\"$1:$PATH\"; cd \"$2\" && exec \"$3\" -e 'const D=require(\"better-sqlite3\");const db=new D(\":memory:\");db.close()'",
      "meshrix-native-runtime",
      serviceNodeDirectory,
      originalWorkingDirectory,
      serviceNode,
    ],
    allowFailure: true,
    timeout: 15_000,
  }).status === 0;
  if (!nativeRuntimeReady) {
    fail("native_orb_native_runtime_incompatible", "Native dependencies do not match the service Node.js runtime.");
  }
  complete("native-runtime", false);

  runOrb({
    machine: parsed.machine,
    args: ["install", "-d", "-m", "0700", dropInDirectory],
    timeout: 30_000,
    code: "native_orb_service_write_failed",
  });
  writeRemoteFile(
    parsed.machine,
    path.posix.join(dropInDirectory, "20-native-orb-origin.conf"),
    [
      "[Service]",
      `Environment=\"MESHRIX_BOOTSTRAP_URL=${parsed.publicOrigin}\"`,
      `Environment=\"MESHRIX_ADVERTISED_BASE_URL=${parsed.publicOrigin}\"`,
      `Environment=\"MESHRIX_ACTIVE_SERVICE_URL=${parsed.publicOrigin}\"`,
      "",
    ].join("\n"),
  );
  complete("configure", false);

  runOrb({ machine: parsed.machine, args: ["systemctl", "--user", "daemon-reload"] });
  runOrb({ machine: parsed.machine, args: ["systemctl", "--user", "enable", unit] });
  runOrb({
    machine: parsed.machine,
    args: ["systemctl", "--user", "restart", unit],
    timeout: 120_000,
    code: "native_orb_activation_failed",
  });
  complete("activate", false);

  let probe: any = await probeOrigin(parsed.publicOrigin);
  for (let attempt: any = 0; attempt < 30 && (!probe.healthOk || !probe.consoleOk); attempt += 1) {
    await new Promise((resolve?: any) : any => setTimeout(resolve, 1000));
    probe = await probeOrigin(parsed.publicOrigin);
  }
  if (!probe.healthOk || !probe.consoleOk) {
    fail("native_orb_verification_failed", "Native Meshrix.js instance did not become healthy.");
  }
  const activeWorkingDirectory: any = orbText(parsed.machine, [
    "systemctl",
    "--user",
    "show",
    unit,
    "-p",
    "WorkingDirectory",
    "--value",
  ], { timeout: 15_000 });
  if (activeWorkingDirectory !== originalWorkingDirectory) {
    fail("native_orb_candidate_activation_mismatch", "Native service did not activate the current candidate.");
  }
  complete("verify", false);

  return Object.freeze({
    ok: true,
    candidate: sourceRevision.slice(0, 12),
    url: "<server-url>",
    healthz: probe.healthz,
    console: probe.console,
    stages: Object.freeze(stages),
  });
}

const invokedDirectly: any = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let parsed: any;
  try {
    parsed = parseNativeOrbDeploymentArgs(process.argv.slice(2));
  } catch (error: any) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "native_orb_argument_invalid" })}\n`);
    process.exitCode = 1;
  }
  if (parsed) {
    deployNativeOrbCandidate(parsed).then((result?: any) : any => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch((error?: any) : any => {
      process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "native_orb_deployment_failed" })}\n`);
      process.exitCode = 1;
    });
  }
}
