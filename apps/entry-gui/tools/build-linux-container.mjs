import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NODE_RUNTIME_VERSION, nodeRuntimeTarget } from "./node-runtime.mjs";
import { parseReleaseServiceInputs } from "./release-service-config.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(appRoot, "../..");
const builderContext = join(appRoot, "tools", "linux-builder");
const dockerfile = join(builderContext, "Dockerfile");
const releaseDefinition = JSON.parse(readFileSync(join(repositoryRoot, "tools/registry/release-definition.registry.json"), "utf8"));
const appPackage = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
const rustVersion = "1.95.0";

function serviceInputs() {
  return parseReleaseServiceInputs({
    accountOrigin: process.env.MESHRIX_ACCOUNT_ORIGIN,
    relayService: process.env.MESHRIX_RELAY_SERVICE
  });
}

function docker(command, args, options = {}) {
  const result = spawnSync("docker", [command, ...args], {
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true
  });
  if (result.error) throw new Error("Docker is required to build the Linux package.");
  if (result.status !== 0) throw new Error(`Docker ${command} failed with exit status ${result.status ?? "unknown"}.`);
  return options.capture ? result.stdout.trim() : "";
}

function dockerNativePlatform() {
  const identity = docker("info", ["--format", "{{.OSType}}/{{.Architecture}}"], { capture: true });
  if (!identity.startsWith("linux/")) throw new Error("The available Docker engine is not a Linux builder.");
  const architecture = identity.slice("linux/".length).toLowerCase();
  if (architecture === "aarch64" || architecture === "arm64") {
    return "linux/arm64";
  }
  if (architecture === "x86_64" || architecture === "amd64") {
    return "linux/amd64";
  }
  throw new Error("The Docker engine architecture has no pinned Linux Entry runtime.");
}

function requestedArchitecture() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--architecture");
  const value = index < 0 ? "native" : args[index + 1];
  if (!new Set(["native", "arm64", "x86_64"]).has(value)) {
    throw new Error("Use --architecture native, arm64 or x86_64.");
  }
  return value;
}

function targetForArchitecture(architecture, nativePlatform) {
  const platform = architecture === "native"
    ? nativePlatform
    : architecture === "arm64" ? "linux/arm64" : "linux/amd64";
  const triple = platform === "linux/arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  return { platform, triple, emulated: platform !== nativePlatform };
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const inputs = serviceInputs();
const target = targetForArchitecture(requestedArchitecture(), dockerNativePlatform());
const nodeVersion = releaseDefinition.github?.nodeVersion;
const npmVersion = releaseDefinition.github?.npmCliVersion;
if (typeof nodeVersion !== "string" || typeof npmVersion !== "string") {
  throw new Error("The canonical release definition does not pin the Linux build runtime.");
}
if (nodeVersion !== NODE_RUNTIME_VERSION) {
  throw new Error("The bundled Node sidecar pin must match the canonical release runtime version.");
}
const linuxRuntime = nodeRuntimeTarget(target.triple);
if (typeof appPackage.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(appPackage.version)) {
  throw new Error("The installed client package version is invalid.");
}

const builderTag = `meshrix-entry-linux-builder:node-${nodeVersion}-npm-${npmVersion}-rust-${rustVersion}`;
const dependencyVolume = `meshrix-entry-node-modules-${randomUUID().replace(/-/gu, "")}`;
let volumeCreated = false;
const startedAt = Date.now();

try {
  if (target.emulated) {
    const machine = docker("run", [
      "--rm", "--platform", target.platform, "ubuntu:22.04", "uname", "-m"
    ], { capture: true });
    const expectedMachine = target.platform === "linux/arm64" ? "aarch64" : "x86_64";
    if (machine !== expectedMachine) throw new Error("Docker architecture emulation did not start the requested Linux target.");
  }
  docker("build", [
    "--platform", target.platform,
    "--build-arg", `NODE_VERSION=${nodeVersion}`,
    "--build-arg", `NPM_VERSION=${npmVersion}`,
    "--build-arg", `RUST_VERSION=${rustVersion}`,
    "--build-arg", `NODE_RUNTIME_ARTIFACT=${linuxRuntime.artifact}`,
    "--build-arg", `NODE_RUNTIME_ARCHIVE_SHA256=${linuxRuntime.downloadSha256}`,
    "--file", dockerfile,
    "--tag", builderTag,
    builderContext
  ]);
  docker("volume", ["create", dependencyVolume]);
  volumeCreated = true;
  docker("run", [
    "--rm",
    "--platform", target.platform,
    "--workdir", "/workspace",
    "--volume", `${repositoryRoot}:/workspace`,
    "--volume", `${dependencyVolume}:/workspace/node_modules`,
    "--env", `MESHRIX_ACCOUNT_ORIGIN=${inputs.accountOrigin}`,
    "--env", `MESHRIX_RELAY_SERVICE=${inputs.relayService}`,
    builderTag
  ]);

  const bundleRoot = join(appRoot, "src-tauri", "target", target.triple, "release", "bundle");
  const formats = new Map([["deb", ".deb"], ["rpm", ".rpm"], ["appimage", ".appimage"]]);
  const artifacts = [];
  for (const [format, extension] of formats) {
    const bundleDirectory = join(bundleRoot, format);
    const found = readdirSync(bundleDirectory)
      .filter((name) => name.toLowerCase().endsWith(extension))
      .map((name) => ({ name, path: join(bundleDirectory, name) }))
      .filter((artifact) => statSync(artifact.path).mtimeMs >= startedAt);
    if (found.length !== 1) {
      throw new Error(`The native Linux build did not produce exactly one fresh ${format} package.`);
    }
    artifacts.push(found[0]);
  }
  for (const artifact of artifacts) {
    const digest = await sha256(artifact.path);
    process.stdout.write(`Built ${artifact.name} for ${target.triple} (${target.emulated ? "emulated" : "native"}; sha256 ${digest}).\n`);
  }
} finally {
  if (volumeCreated) {
    try { docker("volume", ["rm", dependencyVolume], { capture: true }); } catch { /* retain Docker's original build result */ }
  }
}
