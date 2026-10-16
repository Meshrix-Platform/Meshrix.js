#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const toolsDir = path.dirname(scriptPath);
const nativeDir = path.resolve(toolsDir, "..");
const repoRoot = path.resolve(nativeDir, "../..");
const targetRoot = path.join(nativeDir, "target");
const buildRoot = path.join(targetRoot, "linux-build");
const sourceSnapshotRoot = path.join(buildRoot, "dependencies");
const cargoHome = path.join(buildRoot, "cargo-home");
const cargoTargetDir = path.join(buildRoot, "cargo-target");
const outputRoot = path.join(nativeDir, "dist", "linux");
const builderDir = path.join(toolsDir, "linux-builder");
const builderImage = "meshrix-entry-linux-builder:arm64";

function configuredSourcePath(environmentName, fallback) {
  const configured = process.env[environmentName];
  return configured ? path.resolve(repoRoot, configured) : fallback;
}

const dependencies = [
  {
    source: configuredSourcePath(
      "MESHRIX_A4AA_SOURCE",
      path.resolve(repoRoot, "../../Adapter-For-All-Agents"),
    ),
    snapshotName: "Adapter-For-All-Agents",
    packageName: "a4aa",
    environmentName: "MESHRIX_A4AA_SOURCE",
  },
  {
    source: configuredSourcePath(
      "MESHRIX_AWP_SOURCE",
      path.resolve(repoRoot, "../../Agents-With-Profiles"),
    ),
    snapshotName: "Agents-With-Profiles",
    packageName: "agents-with-profiles",
    environmentName: "MESHRIX_AWP_SOURCE",
  },
];

const targetMatrix = [
  {
    component: "cli-tui",
    arch: "x86_64",
    rustTarget: "x86_64-unknown-linux-musl",
    buildTarget: "x86_64-unknown-linux-musl",
    binaryName: "meshrix-entry",
    packageName: "meshrix-entry-cli",
    libc: "musl",
  },
  {
    component: "cli-tui",
    arch: "aarch64",
    rustTarget: "aarch64-unknown-linux-musl",
    buildTarget: "aarch64-unknown-linux-musl",
    binaryName: "meshrix-entry",
    packageName: "meshrix-entry-cli",
    libc: "musl",
  },
  {
    component: "gui",
    arch: "x86_64",
    rustTarget: "x86_64-unknown-linux-gnu",
    buildTarget: "x86_64-unknown-linux-gnu.2.28",
    binaryName: "meshrix-entry-gui",
    packageName: "meshrix-entry-gui",
    libc: "gnu",
  },
  {
    component: "gui",
    arch: "aarch64",
    rustTarget: "aarch64-unknown-linux-gnu",
    buildTarget: "aarch64-unknown-linux-gnu.2.28",
    binaryName: "meshrix-entry-gui",
    packageName: "meshrix-entry-gui",
    libc: "gnu",
  },
];

const sourceExclusions = new Set([
  ".git",
  ".cargo",
  "target",
  "dist",
  "node_modules",
]);

function printHelp() {
  process.stdout.write(
    [
      "Build the Meshrix Entry Linux CLI/TUI and GUI binaries for x86_64 and aarch64.",
      "",
      "Usage: node apps/entry-native/tools/build-linux.mjs",
      "",
      "The command uses the local Linux Docker builder and writes build-manifest.json",
      "plus the four binaries under apps/entry-native/dist/linux. Packaging is separate.",
      "It snapshots local A4AA and AwP development sources. Override their default",
      "sibling directories with MESHRIX_A4AA_SOURCE and MESHRIX_AWP_SOURCE; relative",
      "paths are resolved from the Meshrix.js repository root.",
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

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"] });
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

async function prepareDependencySnapshot() {
  await rm(sourceSnapshotRoot, { recursive: true, force: true });
  await mkdir(sourceSnapshotRoot, { recursive: true });

  for (const dependency of dependencies) {
    const manifestPath = path.join(dependency.source, "Cargo.toml");
    await requirePath(manifestPath, dependency.snapshotName);
    const manifest = await readFile(manifestPath, "utf8");
    if (!new RegExp(`name\\s*=\\s*"${dependency.packageName}"`).test(manifest)) {
      throw new Error(
        `${dependency.environmentName} must refer to the ${dependency.packageName} Cargo package.`,
      );
    }
    const destination = path.join(sourceSnapshotRoot, dependency.snapshotName);
    await cp(dependency.source, destination, {
      recursive: true,
      dereference: true,
      filter: (sourcePath) => {
        const relativePath = path.relative(dependency.source, sourcePath);
        return !relativePath
          .split(path.sep)
          .filter(Boolean)
          .some((segment) => sourceExclusions.has(segment));
      },
    });
  }

  const config = [
    "[patch.crates-io]",
    'a4aa = { path = "/dependency-snapshot/Adapter-For-All-Agents" }',
    'a4aa-dialects = { path = "/dependency-snapshot/Adapter-For-All-Agents/crates/a4aa-dialects" }',
    '"agents-with-profiles" = { path = "/dependency-snapshot/Agents-With-Profiles" }',
    "",
  ].join("\n");
  await mkdir(cargoHome, { recursive: true });
  await writeFile(path.join(cargoHome, "config.toml"), config, "utf8");
}

async function dockerCapacity() {
  const details = await capture("docker", [
    "info",
    "--format",
    "{{.OSType}}|{{.Architecture}}|{{.NCPU}}|{{.MemTotal}}",
  ]);
  const [os, architecture, cpuText, memoryText] = details.split("|");
  if (os !== "linux" || !["aarch64", "arm64"].includes(architecture)) {
    throw new Error("The Linux build container must run on a native aarch64 Docker server.");
  }

  const cpus = Number.parseInt(cpuText, 10);
  const memoryBytes = Number.parseInt(memoryText, 10);
  if (!Number.isFinite(cpus) || cpus < 1 || !Number.isFinite(memoryBytes) || memoryBytes < 1) {
    throw new Error("Docker did not report usable CPU and memory capacity.");
  }

  const jobs = Math.max(1, Math.min(cpus, Math.floor(memoryBytes / (3.5 * 1024 ** 3))));
  return { cpus, memoryBytes, jobs };
}

async function buildBuilderImage() {
  await run("docker", [
    "build",
    "--platform=linux/arm64",
    "--file",
    path.join(builderDir, "Dockerfile"),
    "--tag",
    builderImage,
    builderDir,
  ]);
}

function builderCommand(jobs) {
  const cargoBuild = (target) =>
    `cargo zigbuild --manifest-path /workspace/apps/entry-native/Cargo.toml -p ${target.packageName} --release --locked --target ${target.buildTarget}`;
  const buildOrder = [
    targetMatrix.find((target) => target.component === "cli-tui" && target.arch === "aarch64"),
    targetMatrix.find((target) => target.component === "cli-tui" && target.arch === "x86_64"),
    targetMatrix.find((target) => target.component === "gui" && target.arch === "aarch64"),
    targetMatrix.find((target) => target.component === "gui" && target.arch === "x86_64"),
  ];
  const commands = buildOrder.map((target) => {
    if (target.component === "gui" && target.arch === "x86_64") {
      return `env PKG_CONFIG_ALLOW_CROSS=1 PKG_CONFIG_SYSROOT_DIR=/opt/meshrix-sysroot-x86_64 PKG_CONFIG_LIBDIR=/opt/meshrix-sysroot-x86_64/usr/lib64/pkgconfig:/opt/meshrix-sysroot-x86_64/usr/share/pkgconfig:/opt/meshrix-sysroot-x86_64/usr/lib/pkgconfig ${cargoBuild(target)}`;
    }
    return cargoBuild(target);
  });

  return `set -euo pipefail
mkdir -p "$HOME"
export CARGO_HOME=/workspace/apps/entry-native/target/linux-build/cargo-home
export CARGO_TARGET_DIR=/workspace/apps/entry-native/target/linux-build/cargo-target
export RUSTUP_HOME=/opt/rustup
export PATH=/opt/cargo/bin:/opt/python/cp313-cp313/bin:/usr/local/bin:/usr/bin:/bin
export CARGO_BUILD_JOBS=${jobs}
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS='-C link-arg=-Wl,-rpath,$ORIGIN/../lib'
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS='-C link-arg=-Wl,-rpath,$ORIGIN/../lib'
cd /tmp
${commands.join("\n")}
`;
}

async function buildAllTargets(jobs) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  const script = builderCommand(jobs);
  await run("docker", [
    "run",
    "--rm",
    "--platform=linux/arm64",
    "--user",
    `${uid}:${gid}`,
    "--workdir",
    "/tmp",
    "--env",
    "HOME=/tmp/build-home",
    "--volume",
    `${repoRoot}:/workspace:ro`,
    "--volume",
    `${targetRoot}:/workspace/apps/entry-native/target:rw`,
    "--volume",
    `${sourceSnapshotRoot}:/dependency-snapshot:ro`,
    builderImage,
    "/bin/bash",
    "-lc",
    script,
  ]);
}

async function stageOutputs(runId) {
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
    await copyFile(cargoBinary, stagedBinary);
    await chmod(stagedBinary, 0o755);

    artifacts.push({
      component: target.component,
      arch: target.arch,
      rustTarget: target.rustTarget,
      binary: relativeBinary,
      libc: target.libc,
      buildSource: "current-local-development-sources",
    });
  }

  await writeFile(
    path.join(stageRoot, "build-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        builder: {
          image: builderImage,
          platform: "linux/arm64",
          readelf: "/usr/bin/readelf",
          patchelf: "/usr/local/bin/patchelf",
          protoc: {
            version: "3.12.4",
            path: "/opt/protoc-3.12.4/bin/protoc",
          },
          sysroots: {
            aarch64: "/",
            x86_64: "/opt/meshrix-sysroot-x86_64",
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

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    printHelp();
    return;
  }
  if (args.length > 0) {
    throw new Error("This build entry does not accept options; use --help for usage.");
  }

  const capacity = await dockerCapacity();
  process.stdout.write(
    `Linux builder: native aarch64 Docker, ${capacity.cpus} CPUs, ${Math.floor(capacity.memoryBytes / 1024 ** 3)} GiB RAM, ${capacity.jobs} Cargo jobs.\n`,
  );

  await mkdir(targetRoot, { recursive: true });
  await prepareDependencySnapshot();
  await buildBuilderImage();
  await buildAllTargets(capacity.jobs);

  const runId = `${Date.now()}-${process.pid}`;
  const staged = await stageOutputs(runId);
  try {
    await publishOutputs(staged);
  } finally {
    await rm(staged.stageRoot, { recursive: true, force: true });
  }

  process.stdout.write(`Linux binaries and manifest written under ${path.relative(repoRoot, outputRoot)}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
