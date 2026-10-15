/**
 * Stage the Node service, its native Signal runtime closure and trusted public
 * service origins into the Tauri resource directory.
 *
 * Tauri sets TAURI_ENV_TARGET_TRIPLE before running beforeBuildCommand, so a
 * cross-target package receives the matching libsignal prebuild. Direct local
 * invocations may omit it and use the current Node platform.
 */
import { createRequire } from "node:module";
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureBundledNodeRuntime, NODE_RUNTIME_VERSION } from "./node-runtime.mjs";
import { parseReleaseServiceInputs } from "./release-service-config.mjs";

const require = createRequire(import.meta.url);
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const resourceRoot = join(appRoot, "src-tauri", "resources", "service");
const serviceBundle = join(appRoot, "dist", "service", "entry-service.mjs");

const NATIVE_PREBUILDS = Object.freeze({
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "aarch64-pc-windows-msvc": "win32-arm64",
  "x86_64-pc-windows-msvc": "win32-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
  "x86_64-unknown-linux-gnu": "linux-x64"
});

function hostTriple() {
  const platform = process.platform;
  const architecture = process.arch;
  if (platform === "darwin" && architecture === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && architecture === "x64") return "x86_64-apple-darwin";
  if (platform === "win32" && architecture === "arm64") return "aarch64-pc-windows-msvc";
  if (platform === "win32" && architecture === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "linux" && architecture === "arm64") return "aarch64-unknown-linux-gnu";
  if (platform === "linux" && architecture === "x64") return "x86_64-unknown-linux-gnu";
  throw new Error("The current build host has no supported Signal native prebuild.");
}

function copyPackageDirectory(source, destination) {
  statSync(source, { throwIfNoEntry: true });
  cpSync(source, destination, { recursive: true, dereference: true });
}

if (!existsSync(serviceBundle) || !statSync(serviceBundle).isFile()) {
  throw new Error("Build the Meshrix Entry service before staging the Tauri resources.");
}

const { accountOrigin, relayService } = parseReleaseServiceInputs({
  accountOrigin: process.env.MESHRIX_ACCOUNT_ORIGIN,
  relayService: process.env.MESHRIX_RELAY_SERVICE
});
const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE?.trim() || hostTriple();
const nativeSubdir = NATIVE_PREBUILDS[targetTriple];
if (!nativeSubdir) throw new Error("The selected Tauri target has no supported Signal native prebuild.");

await ensureBundledNodeRuntime({
  targetTriple,
  binariesDirectory: join(appRoot, "src-tauri", "binaries")
});

const nativeEntry = require.resolve("@signalapp/libsignal-client");
const nativeRoot = resolve(dirname(nativeEntry), "..");
const nativePrebuild = join(nativeRoot, "prebuilds", nativeSubdir, "@signalapp+libsignal-client.node");
if (!existsSync(nativePrebuild) || !statSync(nativePrebuild).isFile()) {
  throw new Error("The selected Tauri target's Signal native prebuild is unavailable.");
}
const nodeGypEntry = require.resolve("node-gyp-build", { paths: [nativeRoot] });
const nodeGypRoot = dirname(nodeGypEntry);

const signalTarget = join(resourceRoot, "node_modules", "@signalapp", "libsignal-client");
const prebuildTarget = join(signalTarget, "prebuilds", nativeSubdir);
const nodeGypTarget = join(resourceRoot, "node_modules", "node-gyp-build");

mkdirSync(resourceRoot, { recursive: true });
rmSync(signalTarget, { recursive: true, force: true });
rmSync(nodeGypTarget, { recursive: true, force: true });
mkdirSync(signalTarget, { recursive: true });
mkdirSync(prebuildTarget, { recursive: true });
copyFileSync(serviceBundle, join(resourceRoot, "entry-service.mjs"));
copyPackageDirectory(join(nativeRoot, "dist"), join(signalTarget, "dist"));
copyFileSync(join(nativeRoot, "package.json"), join(signalTarget, "package.json"));
copyFileSync(join(nativeRoot, "zkgroup.js"), join(signalTarget, "zkgroup.js"));
copyFileSync(nativePrebuild, join(prebuildTarget, "@signalapp+libsignal-client.node"));
copyPackageDirectory(nodeGypRoot, nodeGypTarget);

const serviceConfig = {
  schemaVersion: "meshrix-entry-service-config-1",
  accountOrigin,
  relayService
};
writeFileSync(join(resourceRoot, "service-config.json"), `${JSON.stringify(serviceConfig, null, 2)}\n`, { mode: 0o644 });

// Fail staging if a previous package target left additional native binaries
// that would silently inflate or misconfigure this artifact.
const packageDocument = JSON.parse(readFileSync(join(signalTarget, "package.json"), "utf8"));
if (packageDocument.name !== "@signalapp/libsignal-client") {
  throw new Error("The staged Signal runtime package is malformed.");
}

console.log(`Staged Meshrix Entry service resources for ${targetTriple} with Node.js ${NODE_RUNTIME_VERSION} and the selected Signal runtime.`);
