// Single versioned source for the native build/release matrix: target
// definitions, builder images, toolchain pins. Builders, packagers and
// artifact verifiers all consume and validate this file — the same values
// must never live in two places.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(toolsDir, "native-release.config.json");

const CONFIG_SCHEMA = "meshrix-native-release-config-1";
const SHA256 = /^[a-f0-9]{64}$/;
const TARGET_FIELDS = ["component", "arch", "rustTarget", "packageName", "binaryName", "libc"];
const LIBC = new Set(["musl", "gnu", "system"]);

function fail(code) {
  throw new Error(code);
}

const freeze = (value) => Object.freeze(value);

function validateTargetSet(entries) {
  if (!Array.isArray(entries) || entries.length !== 4) fail("native_release_config_targets_incomplete");
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) fail("native_release_config_target_invalid");
    for (const field of TARGET_FIELDS) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) fail(`native_release_config_${field}_missing`);
    }
    if (!LIBC.has(entry.libc)) fail("native_release_config_libc_invalid");
    if (entry.buildTarget !== undefined && typeof entry.buildTarget !== "string") fail("native_release_config_build_target_invalid");
    const key = `${entry.component}${entry.arch}`;
    if (seen.has(key)) fail("native_release_config_target_duplicate");
    seen.add(key);
  }
  return entries;
}

function validateConfig(config) {
  if (typeof config !== "object" || config === null || config.schemaVersion !== CONFIG_SCHEMA) {
    fail("native_release_config_schema_invalid");
  }
  if (typeof config.targets !== "object" || config.targets === null) fail("native_release_config_targets_missing");
  validateTargetSet(config.targets.linux);
  validateTargetSet(config.targets.macos);

  const builders = config.linuxBuilders;
  if (typeof builders !== "object" || builders === null || Object.keys(builders).sort().join(",") !== "aarch64,x86_64") {
    fail("native_release_config_builders_incomplete");
  }
  for (const [arch, profile] of Object.entries(builders)) {
    if (typeof profile.platform !== "string" || !profile.platform.startsWith("linux/")) fail("native_release_config_platform_invalid");
    if (typeof profile.imageTag !== "string" || profile.imageTag.length === 0) fail("native_release_config_image_missing");
    if (typeof profile.base !== "string" || !profile.base.includes(`@sha256:`) || !SHA256.test(profile.base.split("@sha256:")[1] ?? "")) {
      fail("native_release_config_base_pin_invalid");
    }
    if (typeof profile.protocPackage !== "string" || !profile.protocPackage.includes(arch === "aarch64" ? "aarch" : "x86_64")) {
      fail("native_release_config_protoc_package_invalid");
    }
    if (!SHA256.test(profile.protocSha256 ?? "")) fail("native_release_config_protoc_pin_invalid");
  }

  const runtimeImages = config.runtimeImages;
  if (typeof runtimeImages !== "object" || runtimeImages === null) fail("native_release_config_runtime_images_missing");
  for (const [family, images] of Object.entries(runtimeImages)) {
    if (typeof images !== "object" || images === null || Object.keys(images).sort().join(",") !== "aarch64,x86_64") {
      fail("native_release_config_runtime_images_incomplete");
    }
    for (const image of Object.values(images)) {
      if (typeof image !== "string" || !image.includes("@sha256:") || !SHA256.test(image.split("@sha256:")[1] ?? "")) {
        fail("native_release_config_runtime_image_pin_invalid");
      }
    }
  }

  const protoc = config.macosProtoc;
  if (typeof protoc !== "object" || protoc === null) fail("native_release_config_macos_protoc_missing");
  if (typeof protoc.version !== "string" || !/^\d+\.\d+$/.test(protoc.version)) fail("native_release_config_protoc_version_invalid");
  if (typeof protoc.url !== "string" || !protoc.url.startsWith("https://")) fail("native_release_config_protoc_url_invalid");
  if (!SHA256.test(protoc.sha256 ?? "")) fail("native_release_config_protoc_sha256_invalid");

  return config;
}

const deepFreeze = (value) => {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

let cached;
export function loadNativeReleaseConfig() {
  if (!cached) {
    cached = deepFreeze(validateConfig(JSON.parse(readFileSync(configPath, "utf8"))));
  }
  return cached;
}

// Canonical targets plus the derived paths every consumer agreed on:
// binaries are laid out bin/<arch>/<name> in the build manifest and
// bin/<name> inside the release archive.
export function nativeTargets(platform) {
  const entries = loadNativeReleaseConfig().targets[platform];
  if (!entries) fail("native_release_platform_unknown");
  return freeze(entries.map((entry) => freeze({
    ...entry,
    buildTarget: entry.buildTarget ?? entry.rustTarget,
    binaryPath: `bin/${entry.arch}/${entry.binaryName}`,
    archiveProduct: entry.binaryName,
    archiveBinary: `bin/${entry.binaryName}`,
  })));
}
