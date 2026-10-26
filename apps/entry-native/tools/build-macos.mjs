#!/usr/bin/env node

import { copyVerifiedBuildOutput, publicDependencyEvidence, stageWorkspace, validateToolchainMount } from "./build-linux.mjs";
import { loadNativeReleaseConfig, nativeTargets } from "./native-release-config.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const toolsDir = path.dirname(scriptPath);
const nativeDir = path.resolve(toolsDir, "..");
const repoRoot = path.resolve(nativeDir, "../..");
const targetRoot = path.join(nativeDir, "target");
const buildRoot = path.join(targetRoot, "macos-build");
const cargoTargetDir = path.join(buildRoot, "cargo-target");
const cargoHome = path.join(buildRoot, "cargo-home");
// protoc is a toolchain, not build state: it lives beside the writable
// build root so dependency code never holds a writable grant over the
// compiler it runs.
const protocRoot = path.join(targetRoot, "protoc-toolchain");
const outputRoot = path.join(nativeDir, "dist", "macos");

// Toolchain pins and the build matrix are shared configuration: every
// builder, packager and verifier validates and consumes the same file.
const PROTOC = loadNativeReleaseConfig().macosProtoc;

const HOST_ARCH_ALIASES = {
  arm64: "aarch64",
  x64: "x86_64",
};

const targetMatrix = nativeTargets("macos");

function printHelp() {
  process.stdout.write(
    [
      "Build the Meshrix Entry macOS CLI/TUI and GUI binaries for aarch64 and x86_64.",
      "",
      "Usage: node apps/entry-native/tools/build-macos.mjs",
      "",
      "The command compiles on the local macOS host with cargo and writes",
      "build-manifest.json plus the four binaries under apps/entry-native/dist/macos.",
      "Packaging is separate. Both Rust targets are installed through rustup when",
      "missing. Cargo dependencies resolve from crates.io exactly as pinned in",
      "apps/entry-native/Cargo.lock.",
      "",
    ].join("\n"),
  );
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} exited with ${signal ? `signal ${signal}` : `status ${code}`}`,
        ),
      );
    });
  });
}

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", () => reject(new Error(`${command}_unavailable`)));
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(
        new Error(
          `${command} exited with ${signal ? `signal ${signal}` : `status ${code}`}`,
        ),
      );
    });
  });
}

async function requirePath(filePath, description) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`build_output_missing:${description}`);
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`download_failed:${response.status ?? "no_response"}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await pipeline(response.body, createWriteStream(destination));
}

// A cached protoc is never trusted: it could have been replaced between
// runs. Every run re-verifies the pinned archive's digest and rebuilds the
// executable from it; a symlink or non-regular extracted file refuses.
async function ensureProtoc() {
  const extracted = path.join(protocRoot, `protoc-${PROTOC.version}`);
  const protocBinary = path.join(extracted, "bin", "protoc");
  const archive = path.join(protocRoot, `protoc-${PROTOC.version}-osx-universal_binary.zip`);
  try {
    await access(archive);
  } catch {
    await download(PROTOC.url, archive);
  }
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  if (digest !== PROTOC.sha256) throw new Error("protoc_archive_checksum_mismatch");
  await rm(extracted, { recursive: true, force: true });
  await mkdir(extracted, { recursive: true });
  await run("ditto", ["-x", "-k", archive, extracted]);
  const stat = await lstat(protocBinary).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error("protoc_extracted_binary_invalid");
  }
  await chmod(protocBinary, 0o755);
  return protocBinary;
}

// The protoc version is captured separately, inside the seatbelt profile:
// the rebuilt binary is never executed outside the sandbox.
async function hostEnvironment() {
  if (process.platform !== "darwin") {
    throw new Error("The macOS build requires a macOS host.");
  }
  const hostArch = HOST_ARCH_ALIASES[process.arch];
  if (!hostArch) {
    throw new Error(`The macOS build requires an aarch64 or x86_64 host; this host reports ${process.arch}.`);
  }
  const cargo = await capture("cargo", ["--version"]);
  const rustc = await capture("rustc", ["--version"]);
  return { hostArch, cargo, rustc };
}

async function ensureRustTargets() {
  const installed = new Set(
    (await capture("rustup", ["target", "list", "--installed"]))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missing = targetMatrix
    .map((target) => target.rustTarget)
    .filter((rustTarget, index, all) => all.indexOf(rustTarget) === index && !installed.has(rustTarget));
  for (const rustTarget of missing) {
    await run("rustup", ["target", "add", rustTarget]);
  }
}

// `cargo build` executes third-party build scripts and proc macros. The child
// receives an allowlisted environment, an isolated CARGO_HOME and a dedicated
// build HOME, so host credentials and the invoking user's home directory
// never reach dependency code.
const CARGO_ENV_PASSTHROUGH = [
  "PATH",
  "LANG",
  "LC_ALL",
  "DEVELOPER_DIR",
  "SDKROOT",
  "RUSTUP_HOME",
  "CC",
  "CXX",
  "CFLAGS",
  "CXXFLAGS",
  "LDFLAGS",
  "RUSTFLAGS",
];

const buildHome = path.join(buildRoot, "build-home");
const buildTmp = path.join(buildRoot, "build-tmp");
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function cargoEnvironment(protocBinary) {
  const env = { TMPDIR: buildTmp };
  for (const key of CARGO_ENV_PASSTHROUGH) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.CARGO_HOME = cargoHome;
  env.CARGO_TARGET_DIR = cargoTargetDir;
  env.HOME = buildHome;
  env.PROTOC = protocBinary;
  // rustup proxies need the toolchain directory; a default install records it
  // under the real home, so derive RUSTUP_HOME from there without exporting
  // the home directory itself.
  if (!env.RUSTUP_HOME && process.env.HOME && existsSync(path.join(process.env.HOME, ".rustup"))) {
    env.RUSTUP_HOME = path.join(process.env.HOME, ".rustup");
  }
  return env;
}

// `cargo build` executes third-party build scripts and proc macros. The
// network is therefore used only by `cargo fetch`, which downloads the
// locked crates without running dependency code; compilation then runs
// `--offline` inside this deny-by-default seatbelt profile. Dependency code
// gets no network and can read only the toolchain, the workspace and the
// dedicated build state — never the invoking user's home or other files.
async function cargoSandboxProfile(env, stagedSourceDir) {
  const q = (value) => JSON.stringify(value);
  const realBuildRoot = await realpath(buildRoot);
  const readable = [
    `(subpath "/usr")`,
    `(subpath "/bin")`,
    `(subpath "/System")`,
    // The broad /Library tree would expose host services and per-user
    // caches; system frameworks under /Library/Apple plus the validated
    // toolchain directories below are all the compiler needs.
    `(subpath "/Library/Apple")`,
    // clang's xcselect machinery reads the agreed-license record; that one
    // plist is the only /Library/Preferences entry the toolchain needs.
    `(literal "/Library/Preferences/com.apple.dt.Xcode.plist")`,
    `(subpath "/private/etc")`,
    `(subpath ${q(await realpath(stagedSourceDir))})`,
    `(subpath ${q(realBuildRoot)})`,
    `(subpath ${q(await realpath(protocRoot))})`,
    `(literal "/")`,
    `(literal "/dev/null")`,
    `(literal "/dev/zero")`,
    `(literal "/dev/random")`,
    `(literal "/dev/urandom")`,
  ];
  // Toolchain proxies and the selected Xcode developer directory can live
  // outside the workspace (rustup shims, homebrew, Xcode.app). Each resolved
  // location is validated: a path that is or contains the invoking user's
  // home refuses rather than extending the sandbox's read scope over it.
  const toolchainDirs = new Set();
  const addToolchainDir = (dir) => toolchainDirs.add(validateToolchainMount(dir));
  for (const tool of ["cargo", "rustc"]) {
    const resolved = await capture("/usr/bin/which", [tool], { env }).catch(() => null);
    if (resolved) addToolchainDir(path.dirname(await realpath(resolved.trim())));
  }
  if (env.RUSTUP_HOME) addToolchainDir(env.RUSTUP_HOME);
  const developerDir = await capture("xcode-select", ["-p"]).catch(() => null);
  if (developerDir) {
    const realDev = await realpath(developerDir.trim()).catch(() => developerDir.trim());
    // clang dlopens frameworks that live next to Developer/ inside the
    // .app bundle (Contents/SharedFrameworks), so the grant is the bundle.
    const bundle = realDev.match(/^.+?\.app(?=\/|$)/);
    addToolchainDir(bundle ? bundle[0] : realDev);
  }
  // xcrun writes its SDK cache into the per-user Darwin temp directory even
  // when TMPDIR is redirected; that one basename is the only write allowed
  // outside the dedicated build state.
  const darwinTemp = await realpath(os.tmpdir()).catch(() => os.tmpdir());
  const escapedTemp = darwinTemp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const xcrunCache = `(regex ${q(`^${escapedTemp}/xcrun_db-[^/]*$`)})`;
  readable.push(xcrunCache);
  for (const dir of toolchainDirs) readable.push(`(subpath ${q(dir)})`);
  const executable = readable.filter((entry) => entry.startsWith("(subpath"));
  return `(version 1)
(deny default)
(allow process*)
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.DirectoryService.libinfo_v1")
  (global-name "com.apple.logd")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.CoreServices.coreservicesd")
  (global-name "com.apple.coreservices.launchservicesd")
  (global-name "com.apple.trustd")
  (global-name "com.apple.securityd"))
(allow sysctl*)
(allow signal)
(allow file-read-metadata)
(allow file-read*
${readable.map((entry) => `  ${entry}`).join("\n")})
(allow file-map-executable
${executable.map((entry) => `  ${entry}`).join("\n")})
(allow file-read* file-write*
  (subpath ${q(realBuildRoot)})
  ${xcrunCache}
  (literal "/dev/null"))
(deny network*)`;
}

async function sandboxed(profile, command, args, options = {}) {
  await run(SANDBOX_EXEC, ["-p", profile, command, ...args], options);
}

async function sandboxedCapture(profile, command, args, options = {}) {
  return capture(SANDBOX_EXEC, ["-p", profile, command, ...args], options);
}

async function buildAllTargets(env, profile, stagedNativeDir) {
  const buildOrder = [
    targetMatrix.find((target) => target.component === "cli-tui" && target.arch === "aarch64"),
    targetMatrix.find((target) => target.component === "cli-tui" && target.arch === "x86_64"),
    targetMatrix.find((target) => target.component === "gui" && target.arch === "aarch64"),
    targetMatrix.find((target) => target.component === "gui" && target.arch === "x86_64"),
  ];
  for (const target of buildOrder) {
    await sandboxed(profile, "cargo", [
      "build",
      "--manifest-path", path.join(stagedNativeDir, "Cargo.toml"),
      "-p", target.packageName,
      "--release",
      "--locked",
      "--offline",
      "--target", target.rustTarget,
    ], { env, cwd: stagedNativeDir });
  }
}

async function stageOutputs(runId, environment, publicDependencies) {
  const stageRoot = path.join(buildRoot, `stage-${runId}`);
  const stagedBin = path.join(stageRoot, "bin");
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stagedBin, { recursive: true });

  const artifacts = [];
  for (const target of targetMatrix) {
    const cargoBinary = path.join(
      cargoTargetDir,
      target.rustTarget,
      "release",
      target.binaryName,
    );
    await requirePath(cargoBinary, `${target.rustTarget} build output`);

    const relativeBinary = path.posix.join("bin", target.arch, target.binaryName);
    const stagedBinary = path.join(stageRoot, ...relativeBinary.split("/"));
    await mkdir(path.dirname(stagedBinary), { recursive: true });
    await copyVerifiedBuildOutput(cargoBinary, stagedBinary, cargoTargetDir);
    await chmod(stagedBinary, 0o755);

    artifacts.push({
      component: target.component,
      arch: target.arch,
      rustTarget: target.rustTarget,
      binary: relativeBinary,
      libc: target.libc,
      buildSource: "public-registry-locked",
    });
  }

  await writeFile(
    path.join(stageRoot, "build-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        lockSha256: createHash("sha256").update(await readFile(path.join(nativeDir, "Cargo.lock"))).digest("hex"),
        dependencies: publicDependencies,
        builder: {
          system: "host-cargo",
          platform: `darwin/${environment.hostArch === "aarch64" ? "arm64" : "amd64"}`,
          host: `${environment.hostArch}-apple-darwin`,
          cargo: environment.cargo,
          rustc: environment.rustc,
          protoc: environment.protoc,
        },
        artifacts,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { stageRoot, stagedBin };
}

async function publishOutputs({ stageRoot, stagedBin }) {
  await mkdir(outputRoot, { recursive: true });
  const currentBin = path.join(outputRoot, "bin");
  const backupBin = path.join(outputRoot, ".bin-previous-macos-build");
  const stagedManifest = path.join(stageRoot, "build-manifest.json");
  const manifest = path.join(outputRoot, "build-manifest.json");
  let backedUp = false;

  await rm(backupBin, { recursive: true, force: true });
  try {
    try {
      await access(currentBin);
      await rename(currentBin, backupBin);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    await rename(stagedBin, currentBin);
    await rename(stagedManifest, manifest);
    await rm(backupBin, { recursive: true, force: true });
  } catch (error) {
    await rm(currentBin, { recursive: true, force: true });
    if (backedUp) await rename(backupBin, currentBin);
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    printHelp();
    return;
  }
  if (args.length > 0) {
    throw new Error("This build entry does not accept options; use --help for usage.");
  }

  const protocBinary = await ensureProtoc();
  const environment = await hostEnvironment();

  await ensureRustTargets();
  await mkdir(targetRoot, { recursive: true });
  await mkdir(buildHome, { recursive: true });
  await mkdir(buildTmp, { recursive: true });
  // Dependency code sees only tracked sources: the staged copy excludes
  // ignored paths such as target/, dist/ and local-only files. The GUI build
  // script also reads the shared assets/ tree, so it is staged alongside.
  // The stage lives outside the repository because Cargo merges .cargo
  // configuration from every ancestor of its working directory — a stage
  // inside the checkout would silently inherit the real tree's config.
  const stagedRoot = await mkdtemp(path.join(os.tmpdir(), "meshrix-macos-src-"));
  const stagedSourceDir = path.join(stagedRoot, "src");
  const stagedNativeDir = path.join(stagedSourceDir, "apps", "entry-native");
  const env = cargoEnvironment(protocBinary);
  // `cc` resolves the SDK by spawning xcrun, which writes a cache under the
  // per-user temp directory and dlopens Xcode frameworks — neither fits the
  // sealed profile. Resolving SDKROOT outside keeps clang on a pure
  // toolchain path inside the sandbox.
  if (!env.SDKROOT) {
    const sdkroot = await capture("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { env }).catch(() => "");
    if (sdkroot.trim()) env.SDKROOT = sdkroot.trim();
  }
  try {
    await mkdir(stagedSourceDir, { recursive: true });
    await stageWorkspace(stagedSourceDir, ["apps/entry-native", "assets"]);
    // Download the locked crates first: fetching executes no dependency
    // code, so it is the only phase allowed to use the network. Everything
    // after this line runs offline inside the seatbelt profile.
    await run("cargo", ["fetch", "--locked"], { cwd: stagedNativeDir, env });
    const profile = await cargoSandboxProfile(env, stagedSourceDir);
    // The rebuilt protoc runs its first --version inside the sandbox too —
    // the executable never runs outside the sealed profile.
    environment.protoc = await sandboxedCapture(profile, protocBinary, ["--version"]);
    process.stdout.write(
      `macOS builder: local ${environment.hostArch} host (${environment.rustc}, ${environment.protoc}); targets aarch64-apple-darwin and x86_64-apple-darwin.\n`,
    );
    await buildAllTargets(env, profile, stagedNativeDir);

    const runId = `${Date.now()}-${process.pid}`;
    const publicDependencies = publicDependencyEvidence(JSON.parse(await sandboxedCapture(profile, "cargo", ["metadata", "--locked", "--offline", "--format-version", "1"], { cwd: stagedNativeDir, env })));
    const staged = await stageOutputs(runId, environment, publicDependencies);
    try {
      await publishOutputs(staged);
    } finally {
      await rm(staged.stageRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(stagedRoot, { recursive: true, force: true });
  }

  process.stdout.write(`macOS binaries and manifest written under ${path.relative(repoRoot, outputRoot)}.\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "native_macos_build_failed";
  process.stderr.write(`${message.replace(/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/)[^\s]+/gu, "<path>")}\n`);
  process.exitCode = 1;
});
