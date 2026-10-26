#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants, existsSync, realpathSync } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadNativeReleaseConfig, nativeTargets } from "./native-release-config.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const toolsDir = path.dirname(scriptPath);
const nativeDir = path.resolve(toolsDir, "..");
const repoRoot = path.resolve(nativeDir, "../..");
const targetRoot = path.join(nativeDir, "target");
const buildRoot = path.join(targetRoot, "linux-build");
const cargoHome = path.join(buildRoot, "public-cargo-home");
const cargoTargetDir = path.join(buildRoot, "cargo-target");
const outputRoot = path.join(nativeDir, "dist", "linux");
const builderDir = path.join(toolsDir, "linux-builder");

const DOCKER_ARCH_ALIASES = {
  aarch64: "aarch64",
  arm64: "aarch64",
  x86_64: "x86_64",
  amd64: "x86_64",
};

// The build matrix and toolchain pins are shared configuration: every
// builder, packager and verifier validates and consumes the same file.
const BUILDER_PROFILES = loadNativeReleaseConfig().linuxBuilders;

const crossSysroot = (arch) => `/opt/meshrix-sysroot-${arch}`;

const targetMatrix = nativeTargets("linux");

function printHelp() {
  process.stdout.write(
    [
      "Build the Meshrix Entry Linux CLI/TUI and GUI binaries for x86_64 and aarch64.",
      "",
      "Usage: node apps/entry-native/tools/build-linux.mjs [--host]",
      "",
      "--host builds both binaries for the current Linux GNU host using public locked",
      "dependencies. Requires Rust/Cargo, a C compiler, protoc and GUI development",
      "libraries (pkg-config, X11/Wayland, xkbcommon, OpenGL/EGL). Writes",
      "dist/linux-host; these are host-linked outputs, NOT portable release archives.",
      "",
      "Without --host, the command uses the local Linux Docker builder and writes",
      "build-manifest.json plus the four binaries under apps/entry-native/dist/linux.",
      "Packaging is separate. The Docker daemon must be local and Linux on either",
      "aarch64 or x86_64; the builder image follows the daemon's native architecture.",
      "Both modes consume the same public registry dependencies and committed Cargo.lock.",
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
    const child = spawn(command, args, { cwd: options.cwd ?? repoRoot, env: options.env ?? process.env, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
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
    throw new Error(`${description} is unavailable: ${filePath}`);
  }
}

function dockerEndpointIsLocal(endpoint) {
  const value = String(endpoint ?? "").trim();
  if (/^(?:unix|npipe):\/\//iu.test(value)) return true;
  if (!/^tcp:\/\//iu.test(value)) return false;
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Docker CLI precedence is DOCKER_CONTEXT > DOCKER_HOST > current context.
// Validate the endpoint the CLI will actually use, not just one variable.
export async function requireLocalDockerContext({ environment = process.env, inspect = capture } = {}) {
  const dockerContext = String(environment.DOCKER_CONTEXT ?? "").trim();
  if (dockerContext) {
    const inspected = await inspect("docker", [
      "context",
      "inspect",
      "--format",
      "{{json .Endpoints.docker.Host}}",
      dockerContext,
    ]);
    if (!dockerEndpointIsLocal(JSON.parse(inspected))) {
      throw new Error("The Linux build requires a local Docker context; DOCKER_CONTEXT selects a remote endpoint.");
    }
    return;
  }
  const configuredHost = String(environment.DOCKER_HOST ?? "").trim();
  if (configuredHost) {
    if (!dockerEndpointIsLocal(configuredHost)) {
      throw new Error("The Linux build requires a local Docker daemon; DOCKER_HOST points at a remote endpoint.");
    }
    return;
  }
  const context = (await inspect("docker", ["context", "show"])).trim();
  const inspected = await inspect("docker", [
    "context",
    "inspect",
    "--format",
    "{{json .Endpoints.docker.Host}}",
    context,
  ]);
  const host = JSON.parse(inspected);
  if (!dockerEndpointIsLocal(host)) {
    throw new Error("The Linux build requires a local Docker context; the selected context is remote.");
  }
}

async function dockerCapacity() {
  const details = await capture("docker", [
    "info",
    "--format",
    "{{.OSType}}|{{.Architecture}}|{{.NCPU}}|{{.MemTotal}}",
  ]);
  const [os, rawArchitecture, cpuText, memoryText] = details.split("|");
  const hostArch = DOCKER_ARCH_ALIASES[String(rawArchitecture ?? "").trim().toLowerCase()];
  if (os !== "linux" || !hostArch) {
    throw new Error(
      `The Linux build requires a Linux Docker daemon on aarch64 or x86_64; this daemon reports ${os}/${rawArchitecture}.`,
    );
  }

  const cpus = Number.parseInt(cpuText, 10);
  const memoryBytes = Number.parseInt(memoryText, 10);
  if (!Number.isFinite(cpus) || cpus < 1 || !Number.isFinite(memoryBytes) || memoryBytes < 1) {
    throw new Error("Docker did not report usable CPU and memory capacity.");
  }

  const jobs = Math.max(1, Math.min(cpus, Math.floor(memoryBytes / (3.5 * 1024 ** 3))));
  return { cpus, memoryBytes, jobs, hostArch, profile: BUILDER_PROFILES[hostArch] };
}

async function buildBuilderImage(profile, crossArch) {
  await run("docker", [
    "build",
    `--platform=${profile.platform}`,
    "--file",
    path.join(builderDir, "Dockerfile"),
    "--build-arg",
    `MANYLINUX_IMAGE=${profile.base}`,
    "--build-arg",
    `CROSS_ARCH=${crossArch}`,
    "--build-arg",
    `PROTOC_PACKAGE=${profile.protocPackage}`,
    "--build-arg",
    `PROTOC_SHA256=${profile.protocSha256}`,
    "--tag",
    profile.imageTag,
    builderDir,
  ]);
}

// Writable build state mounts at its own top-level path: a nested rw bind
// under the read-only /workspace mount is not reliably established by every
// Docker setup.
const containerEnvironment = (jobs) => `set -euo pipefail
mkdir -p "$HOME"
export CARGO_HOME=/build-state/public-cargo-home
export CARGO_TARGET_DIR=/build-state/cargo-target
export RUSTUP_HOME=/opt/rustup
export PATH=/opt/cargo/bin:/opt/python/cp313-cp313/bin:/usr/local/bin:/usr/bin:/bin
export CARGO_BUILD_JOBS=${jobs}
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS='-C link-arg=-Wl,-rpath,$ORIGIN/../lib'
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS='-C link-arg=-Wl,-rpath,$ORIGIN/../lib'
cd /tmp
`;

// `cargo fetch` only downloads the locked crates and executes no dependency
// code, so it is the single phase that may use the container's network.
export function fetchCommand(jobs) {
  return `${containerEnvironment(jobs)}
cargo fetch --manifest-path /workspace/apps/entry-native/Cargo.toml --locked
`;
}

// Third-party build scripts and proc macros run here. The container for this
// phase is started with --network=none and the builds are --offline, so
// dependency code cannot fetch new inputs or transmit staged contents.
export function builderCommand(jobs, hostArch) {
  const cargoBuild = (target) =>
    `cargo zigbuild --manifest-path /workspace/apps/entry-native/Cargo.toml -p ${target.packageName} --release --locked --offline --target ${target.buildTarget}`;
  const buildOrder = [
    targetMatrix.find((target) => target.component === "cli-tui" && target.arch === "aarch64"),
    targetMatrix.find((target) => target.component === "cli-tui" && target.arch === "x86_64"),
    targetMatrix.find((target) => target.component === "gui" && target.arch === "aarch64"),
    targetMatrix.find((target) => target.component === "gui" && target.arch === "x86_64"),
  ];
  const commands = buildOrder.map((target) => {
    if (target.component === "gui" && target.arch !== hostArch) {
      const sysroot = crossSysroot(target.arch);
      return `env PKG_CONFIG_ALLOW_CROSS=1 PKG_CONFIG_SYSROOT_DIR=${sysroot} PKG_CONFIG_LIBDIR=${sysroot}/usr/lib64/pkgconfig:${sysroot}/usr/share/pkgconfig:${sysroot}/usr/lib/pkgconfig ${cargoBuild(target)}`;
    }
    return cargoBuild(target);
  });

  return `${containerEnvironment(jobs)}
cargo metadata --manifest-path /workspace/apps/entry-native/Cargo.toml --locked --offline --format-version 1 > /build-state/public-dependencies.json
${commands.join("\n")}
`;
}

// Dependency code builds a copy of the tracked native workspace only.
// Mounting the full working tree would let third-party build code read
// ignored files, other lanes and any local-only data present in the
// checkout. The macOS builder stages the shared `assets/` tree the same way.
export async function stageWorkspace(stageDir, pathspec = ["apps/entry-native"], rootDir = repoRoot) {
  const realRoot = await realpath(rootDir);
  const listing = await capture("git", ["ls-files", "-z", "--", ...pathspec], { cwd: rootDir });
  for (const relative of listing.split("\0").filter(Boolean)) {
    const source = path.join(rootDir, relative);
    const destination = path.join(stageDir, relative);
    try {
      // A tracked path beneath a replaced symlinked directory, or a tracked
      // symlink itself, could import untracked host files into the
      // sandbox-visible stage — every ancestor must be a real directory,
      // the leaf a regular file inside the canonical repository root, and
      // the opened descriptor validated without following a swapped link.
      const parts = relative.split("/");
      let cursor = rootDir;
      for (const [index, part] of parts.entries()) {
        cursor = path.join(cursor, part);
        const stat = await lstat(cursor);
        if (stat.isSymbolicLink()) throw new Error(`staged_source_symlink:${relative}`);
        if (index === parts.length - 1 && !stat.isFile()) {
          throw new Error(`staged_source_not_regular:${relative}`);
        }
      }
      if (!(await realpath(source)).startsWith(`${realRoot}${path.sep}`)) {
        throw new Error(`staged_source_escapes_repo:${relative}`);
      }
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile()) {
          throw new Error(`staged_source_not_regular:${relative}`);
        }
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, await handle.readFile());
      } finally {
        await handle.close();
      }
    } catch (error) {
      // A tracked path deleted in the worktree is legitimately absent.
      if (error.code !== "ENOENT") throw error;
    }
  }
}

// Dependency build scripts control what sits at an expected output path, and
// staging runs outside their sandbox — so a planted symlink to a host file
// would be copied into the release pipeline. The staged copy proves it reads
// a regular file confined to the Cargo target tree: lstat rejects the link
// itself, realpath confines the canonical path, and O_NOFOLLOW + fstat on
// the opened descriptor closes the check/use race.
export async function copyVerifiedBuildOutput(source, destination, confinementRoot) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("build_output_not_a_regular_file");
  }
  const realSource = await realpath(source);
  const realRoot = await realpath(confinementRoot);
  if (!realSource.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("build_output_escapes_target_dir");
  }
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error("build_output_not_a_regular_file");
    }
    await writeFile(destination, await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function buildAllTargets(jobs, profile, hostArch, workspaceStage) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  const dockerRun = (script, network) => run("docker", [
    "run",
    "--rm",
    `--platform=${profile.platform}`,
    "--user",
    `${uid}:${gid}`,
    "--workdir",
    "/tmp",
    "--env",
    "HOME=/tmp/build-home",
    "--volume",
    `${workspaceStage}:/workspace:ro`,
    "--volume",
    `${buildRoot}:/build-state:rw`,
    ...network,
    profile.imageTag,
    "/bin/bash",
    "-lc",
    script,
  ]);
  // Downloading the locked crates executes no dependency code; compilation
  // then runs in a second container with no network interface at all.
  await dockerRun(fetchCommand(jobs), []);
  await dockerRun(builderCommand(jobs, hostArch), ["--network=none"]);
}

async function stageOutputs(runId, profile, hostArch, publicDependencies) {
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
          image: profile.imageTag,
          platform: profile.platform,
          readelf: "/usr/bin/readelf",
          patchelf: "/usr/local/bin/patchelf",
          protoc: {
            version: "3.12.4",
            path: "/opt/protoc-3.12.4/bin/protoc",
          },
          sysroots: {
            aarch64: hostArch === "aarch64" ? "/" : crossSysroot("aarch64"),
            x86_64: hostArch === "x86_64" ? "/" : crossSysroot("x86_64"),
          },
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
  const backupBin = path.join(outputRoot, ".bin-previous-linux-build");
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

export function nativeHostTarget(rustcDetails, platform = process.platform, arch = process.arch) {
  if (platform !== "linux" || !["x64", "arm64"].includes(arch)) {
    throw new Error("--host requires a native Linux x86_64 or aarch64 machine.");
  }
  const expected = `${arch === "x64" ? "x86_64" : "aarch64"}-unknown-linux-gnu`;
  const actual = rustcDetails.match(/^host: (.+)$/m)?.[1]?.trim();
  if (actual !== expected) {
    throw new Error(`--host requires the native GNU Rust host ${expected}; observed ${actual || "unknown"}.`);
  }
  return expected;
}

export function publicDependencyEvidence(metadata) {
  return ["a4aa", "a4aa-dialects", "agents-with-profiles"].map((name) => {
    const matches = metadata.packages.filter((item) => item.name === name);
    if (matches.length !== 1 || matches[0].source !== "registry+https://github.com/rust-lang/crates.io-index") {
      throw new Error(`--host requires one public registry dependency for ${name}; remove development-source patches.`);
    }
    return { name, version: matches[0].version, source: matches[0].source };
  });
}

// Shared provenance contract for the builder, packager and artifact verifier.
// Callers holding the real lockfile or fresh metadata pass them as `expected`
// so a stale or fabricated manifest cannot qualify a packaged artifact.
export function validatePublicBuildProvenance(manifest, expected = {}) {
  if (!/^[a-f0-9]{64}$/.test(manifest?.lockSha256 || "")) {
    throw new Error("build_manifest_lock_hash_invalid");
  }
  if (expected.lockSha256 !== undefined && manifest.lockSha256 !== expected.lockSha256) {
    throw new Error("build_manifest_lock_hash_mismatch");
  }
  const dependencies = publicDependencyEvidence({ packages: manifest.dependencies || [] });
  if (expected.dependencies !== undefined) {
    const tuple = (list) => JSON.stringify(list.map((d) => [d.name, d.version, d.source]));
    if (tuple(dependencies) !== tuple(expected.dependencies)) {
      throw new Error("build_manifest_dependencies_mismatch");
    }
  }
  return dependencies;
}

// `cargo build` executes third-party build scripts and proc macros. The host
// path passes only this allowlist plus an isolated CARGO_HOME and a dedicated
// build HOME, so ambient credentials and the invoking user's home directory
// never reach dependency code.
const HOST_BUILD_ENV_PASSTHROUGH = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "CC",
  "CXX",
  "CFLAGS",
  "CXXFLAGS",
  "LDFLAGS",
  "RUSTFLAGS",
  "PROTOC",
  "PKG_CONFIG_PATH",
  "PKG_CONFIG_LIBDIR",
  "PKG_CONFIG_SYSROOT_DIR",
  "CARGO_BUILD_JOBS",
];

function hostBuildEnvironment(environment) {
  const env = {};
  for (const key of HOST_BUILD_ENV_PASSTHROUGH) {
    if (environment[key]) env[key] = environment[key];
  }
  env.TMPDIR ??= os.tmpdir();
  // rustup proxies need the toolchain directory; a default install records it
  // under the real home, so derive RUSTUP_HOME from there without exporting
  // the home directory itself.
  if (!env.RUSTUP_HOME && environment.HOME && existsSync(path.join(environment.HOME, ".rustup"))) {
    env.RUSTUP_HOME = path.join(environment.HOME, ".rustup");
  }
  return env;
}

// `cargo fetch` downloads the locked crates without running dependency code.
// Compilation then runs `--offline` and requires a real filesystem sandbox:
// with `bwrap` the build sees only the staged tracked workspace, the
// toolchain and dedicated build state, in fully unshared namespaces with no
// network. Without it the host build refuses — executing third-party build
// scripts and proc macros with the caller's filesystem and network reach is
// exactly what the default Docker path exists to prevent.
// Toolchain mounts are the only host paths dependency build code can see.
// A mount that equals or contains the invoking user's home — or any path
// inside the home outside the standard rustup/cargo roots — would silently
// undo the filesystem boundary, so such mounts refuse outright.
export function validateToolchainMount(dir, label = "toolchain", home = os.homedir()) {
  const real = realpathSync(dir);
  const realHome = home ? realpathSync(home) : null;
  if (!realHome) return real;
  const towardHome = path.relative(real, realHome);
  if (towardHome === "" || (!towardHome.startsWith("..") && !path.isAbsolute(towardHome))) {
    throw new Error(`${label} mount is the invoking user's home or an ancestor of it; refusing to expose it to build code`);
  }
  if (real.startsWith(realHome + path.sep)) {
    const relative = path.relative(realHome, real);
    const allowed = [".rustup", ".cargo"].some((root) => relative === root || relative.startsWith(root + path.sep));
    if (!allowed) {
      throw new Error(`${label} mount sits inside the invoking user's home outside the rustup/cargo roots; refusing`);
    }
  }
  return real;
}

function hostSandboxCommand({ stageDir, stateDir, jobs, rustTarget, toolchainDirs }) {
  const roBinds = ["/usr", "/bin", "/lib", "/lib64", "/etc"]
    .flatMap((source) => (existsSync(source) ? ["--ro-bind", source, source] : []));
  const toolchainBinds = [...new Set(toolchainDirs.filter((dir) => dir && existsSync(dir)))]
    .map((dir) => validateToolchainMount(dir))
    .flatMap((dir) => ["--ro-bind", dir, dir]);
  const pathDirs = [...new Set(toolchainDirs.filter(Boolean))];
  return ["bwrap",
    "--unshare-all", "--die-with-parent", "--new-session",
    "--ro-bind", stageDir, "/workspace",
    "--bind", stateDir, "/build",
    ...roBinds,
    ...toolchainBinds,
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--setenv", "HOME", "/build/home",
    "--setenv", "CARGO_HOME", "/build/cargo-home",
    "--setenv", "CARGO_TARGET_DIR", "/build/cargo-target",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PATH", `${pathDirs.join(":")}:/usr/local/bin:/usr/bin:/bin`,
    "--setenv", "CARGO_BUILD_JOBS", jobs,
    "--chdir", "/workspace/apps/entry-native",
    "--",
    "cargo", "build", "--release", "--locked", "--offline", "--bins", "--target", rustTarget,
  ];
}

// This host build is intentionally separate from portable release qualification:
// native GNU outputs do not promise a musl CLI or the container's glibc 2.28 floor.
export async function buildNativeHost({
  workspace = nativeDir,
  platform = process.platform,
  arch = process.arch,
  environment = process.env,
  execute = run,
  inspect = capture,
} = {}) {
  const buildEnv = hostBuildEnvironment(environment);
  const sandboxRoot = path.join(workspace, "target", "linux-host-sandbox");
  const stageDir = path.join(sandboxRoot, "workspace");
  const stateDir = path.join(sandboxRoot, "build");
  await rm(sandboxRoot, { recursive: true, force: true });
  // HOME and CARGO_HOME live inside the sandbox state so the fetched crates
  // are exactly what the sealed build can read.
  buildEnv.HOME = path.join(stateDir, "home");
  buildEnv.CARGO_HOME = path.join(stateDir, "cargo-home");
  await mkdir(buildEnv.HOME, { recursive: true });
  await mkdir(buildEnv.CARGO_HOME, { recursive: true });
  const inspectionOptions = { cwd: workspace, env: buildEnv };
  const rustc = await inspect("rustc", ["--version", "--verbose"], inspectionOptions);
  const rustTarget = nativeHostTarget(rustc, platform, arch);
  const cargo = await inspect("cargo", ["--version"], inspectionOptions);
  const protoc = await inspect(buildEnv.PROTOC || "protoc", ["--version"], inspectionOptions);
  await inspect(buildEnv.CC || "cc", ["--version"], inspectionOptions);
  await inspect("pkg-config", ["--version"], inspectionOptions);
  const toolchainDir = async (command) => {
    try {
      const resolved = await inspect("readlink", ["-f", await inspect("which", [command], inspectionOptions)], inspectionOptions);
      return path.dirname(resolved.trim());
    } catch {
      return null;
    }
  };
  const metadata = JSON.parse(await inspect("cargo", ["metadata", "--locked", "--format-version", "1"], { cwd: workspace, env: buildEnv }));
  const publicDependencies = publicDependencyEvidence(metadata);
  const hostTargetDir = path.join(stateDir, "cargo-target");
  const destination = path.join(workspace, "dist", "linux-host");
  const jobs = environment.CARGO_BUILD_JOBS || String(Math.max(1, Math.min(os.availableParallelism(), Math.floor(os.totalmem() / (3.5 * 1024 ** 3)))));
  // The sandbox requirement is checked before fetching: a host build that
  // cannot isolate dependency code must not proceed at all.
  try {
    await inspect("bwrap", ["--version"], inspectionOptions);
  } catch {
    throw new Error(
      "host build requires a filesystem and network sandbox for third-party build code: install bubblewrap (bwrap), or use the default Docker build which already provides it",
    );
  }
  await mkdir(stageDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await stageWorkspace(stageDir);
  await execute("cargo", ["fetch", "--locked"], { cwd: workspace, env: buildEnv });
  const command = hostSandboxCommand({
    stageDir,
    stateDir,
    jobs,
    rustTarget,
    toolchainDirs: [
      await toolchainDir("cargo"),
      await toolchainDir("rustc"),
      buildEnv.PROTOC?.includes(path.sep) ? path.dirname(buildEnv.PROTOC) : null,
      buildEnv.RUSTUP_HOME ?? null,
    ],
  });
  await execute(command[0], command.slice(1), { cwd: workspace, env: buildEnv });
  const stage = path.join(hostTargetDir, `stage-${process.pid}-${Date.now()}`);
  const binaries = ["meshrix-entry", "meshrix-entry-gui"];
  await mkdir(stage, { recursive: true });
  try {
    for (const binary of binaries) {
      await copyVerifiedBuildOutput(path.join(hostTargetDir, rustTarget, "release", binary), path.join(stage, binary), hostTargetDir);
      await chmod(path.join(stage, binary), 0o755);
    }
    const manifest = {
      schemaVersion: "meshrix-native-host-build-1",
      qualification: "native-host-only",
      rustTarget,
      libc: "gnu",
      portableArchiveQualified: false,
      toolchain: { rustc: rustc.split("\n")[0], cargo, protoc },
      lockSha256: createHash("sha256").update(await readFile(path.join(workspace, "Cargo.lock"))).digest("hex"),
      dependencies: publicDependencies,
      binaries,
    };
    await writeFile(path.join(stage, "host-build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await mkdir(path.dirname(destination), { recursive: true });
    // Only replace previous host-build outputs after both new binaries exist.
    const backup = `${destination}.previous`;
    await rm(backup, { recursive: true, force: true });
    let backedUp = false;
    try {
      try { await rename(destination, backup); backedUp = true; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await rename(stage, destination);
    } catch (error) {
      if (backedUp) await rename(backup, destination);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    return { destination, manifest };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    printHelp();
    return;
  }
  if (args.length === 1 && args[0] === "--host") {
    const result = await buildNativeHost();
    process.stdout.write(`Native host binaries written under ${path.relative(repoRoot, result.destination)}. Not portable archive qualification.\n`);
    return;
  }
  if (args.length > 0) {
    throw new Error("Unsupported build options; use --help for usage.");
  }

  await requireLocalDockerContext();
  const capacity = await dockerCapacity();
  const { hostArch, profile } = capacity;
  const crossArch = hostArch === "aarch64" ? "x86_64" : "aarch64";
  process.stdout.write(
    `Linux builder: local ${hostArch} Docker (${profile.platform}), ${capacity.cpus} CPUs, ${Math.floor(capacity.memoryBytes / 1024 ** 3)} GiB RAM, ${capacity.jobs} Cargo jobs; cross sysroot for ${crossArch}.\n`,
  );

  await mkdir(targetRoot, { recursive: true });
  await mkdir(cargoHome, { recursive: true });
  await buildBuilderImage(profile, crossArch);
  const workspaceStage = await mkdtemp(path.join(os.tmpdir(), "meshrix-linux-workspace-"));
  try {
    await stageWorkspace(workspaceStage);
    await buildAllTargets(capacity.jobs, profile, hostArch, workspaceStage);
  } finally {
    await rm(workspaceStage, { recursive: true, force: true });
  }

  const runId = `${Date.now()}-${process.pid}`;
  const publicDependencies = publicDependencyEvidence(JSON.parse(await readFile(path.join(buildRoot, "public-dependencies.json"), "utf8")));
  const staged = await stageOutputs(runId, profile, hostArch, publicDependencies);
  try {
    await publishOutputs(staged);
  } finally {
    await rm(staged.stageRoot, { recursive: true, force: true });
  }

  process.stdout.write(`Linux binaries and manifest written under ${path.relative(repoRoot, outputRoot)}.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
