#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectCargoLicenseInventory, createArchive } from "./package-linux.mjs";
import { validatePublicBuildProvenance, publicDependencyEvidence } from "./build-linux.mjs";
import { nativeTargets } from "./native-release-config.mjs";
import { createHash } from "node:crypto";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = path.resolve(SCRIPT_DIR, "..");
const REPOSITORY_DIR = path.resolve(WORKSPACE_DIR, "../..");
const CARGO_MANIFEST = path.join(WORKSPACE_DIR, "Cargo.toml");
const README_TEMPLATE = path.join(WORKSPACE_DIR, "packaging", "macos", "README.md");
const FONT_LICENSE = path.join(WORKSPACE_DIR, "crates", "entry-gui", "assets", "fonts", "INTER-LICENSE.txt");
const ROOT_LICENSE = path.join(REPOSITORY_DIR, "LICENSE");
const PACKAGE_MANIFEST_SCHEMA = 1;

// The artifact set is shared configuration: builders, packagers and
// verifiers all derive it from the same versioned registry.
const EXPECTED_ARTIFACTS = Object.freeze(nativeTargets("macos").map((target) => Object.freeze({
  component: target.component,
  arch: target.arch,
  rustTarget: target.rustTarget,
  binaryPath: target.binaryPath,
  libc: target.libc,
  archiveProduct: target.archiveProduct,
  archiveBinary: target.archiveBinary
})));

// Thin client executables link absolute system dylib paths only. A raw entry
// must carry no `.`/`..` component and the normalized absolute path must sit
// under an exact system root, so `/usr/lib/../../tmp/x.dylib` cannot
// masquerade as a system library. An @rpath-style relative install name does
// not prove where it resolves, so packaging and artifact verification share
// this strict predicate.
const SYSTEM_DYLIB_ROOTS = Object.freeze(["/usr/lib/", "/System/Library/"]);
export function isSystemDylibPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return false;
  if (value.split("/").some((part) => part === "." || part === "..")) return false;
  return SYSTEM_DYLIB_ROOTS.some((root) => path.posix.normalize(value).startsWith(root));
}

// Parses `otool -L` output into the recorded dependency set. Only an exact
// self reference is excluded: a path that merely shares the executable's
// basename is still a dependency and must be validated against
// isSystemDylibPath rather than silently dropped.
export function linkedLibraryEntries(loadCommands, binaryPath) {
  const self = path.resolve(binaryPath);
  return [...new Set(loadCommands.split(/\r?\n/u)
    .map((line) => line.trim().match(/^([^\s(]+)\s+\(/u)?.[1])
    .filter((value) => typeof value === "string" && path.resolve(value) !== self))]
    .sort((left, right) => left.localeCompare(right));
}

function usage() {
  return [
    "Usage:",
    "  node apps/entry-native/tools/package-macos.mjs --input-dir <build-output> --output-dir <archive-output>",
    "",
    "The input directory must contain build-manifest.json from build-macos.mjs.",
    "Packaging requires lipo, otool and vtool from the host Xcode command-line tools."
  ].join("\n");
}

function parseArguments(args) {
  const result = { inputDir: null, outputDir: null, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--help" || option === "-h") {
      result.help = true;
      continue;
    }
    if (option !== "--input-dir" && option !== "--output-dir") {
      throw new Error("unexpected_argument");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("missing_option_value");
    index += 1;
    if (option === "--input-dir") result.inputDir = value;
    else result.outputDir = value;
  }
  if (!result.help && (!result.inputDir || !result.outputDir)) throw new Error("input_and_output_directories_required");
  return result;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeToken(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value)) {
    throw new Error(`invalid_${label}`);
  }
  return value;
}

function redactPaths(value) {
  return String(value)
    .replace(/(?:[A-Za-z]:[\\/][^\s"']+|\/(?:Users|home|private|tmp|var)\/[^\s"']+)/gu, "<path>")
    .replaceAll(REPOSITORY_DIR, "<repo-root>")
    .replaceAll(WORKSPACE_DIR, "<native-workspace>");
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", () => reject(new Error(`${command}_unavailable`)));
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.join(""), stderr: stderr.join("") });
        return;
      }
      const detail = redactPaths(stderr.join("").trim().split(/\r?\n/u).slice(-4).join(" "));
      reject(new Error(`${command}_failed_exit_${code}${detail ? `: ${detail}` : ""}`));
    });
  });
}

const MACHO_ARCH_NAMES = Object.freeze({ aarch64: "arm64", x86_64: "x86_64" });

async function inspectMachO(binaryPath, expectedArch) {
  const expectedName = MACHO_ARCH_NAMES[expectedArch];
  const { stdout: lipoInfo } = await run("lipo", ["-info", binaryPath], WORKSPACE_DIR);
  const thin = lipoInfo.match(/Non-fat file:.*?architecture:\s*(\S+)\s*$/mu)?.[1]
    ?? lipoInfo.match(/^Architectures in the fat file:.*?are:\s*(.+?)\s*$/mu)?.[1];
  if (thin !== expectedName) throw new Error(`macho_architecture_mismatch:${expectedArch}`);

  const { stdout: loadCommands } = await run("otool", ["-L", binaryPath], WORKSPACE_DIR);
  const linkedLibraries = linkedLibraryEntries(loadCommands, binaryPath);
  for (const library of linkedLibraries) {
    if (!isSystemDylibPath(library)) throw new Error(`non_system_dylib:${expectedArch}`);
  }

  const { stdout: buildInfo } = await run("vtool", ["-show-build", binaryPath], WORKSPACE_DIR);
  const minimumMacOS = buildInfo.match(/^\s*minos\s+(\S+)\s*$/mu)?.[1]
    ?? buildInfo.match(/\bminos\s+(\d+(?:\.\d+)+)\b/u)?.[1]
    ?? null;
  const sdk = buildInfo.match(/\bsdk\s+(\d+(?:\.\d+)+)\b/u)?.[1] ?? null;
  return Object.freeze({
    format: "Mach-O 64-bit",
    arch: expectedName,
    linkedLibraries: Object.freeze(linkedLibraries),
    minimumMacOS,
    sdk
  });
}

async function readJson(filePath, errorCode) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error(errorCode);
  }
}

function validateBuildManifest(value, expectedProvenance = {}) {
  validatePublicBuildProvenance(value, expectedProvenance);
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.artifacts)) {
    throw new Error("build_manifest_shape_invalid");
  }
  const builder = value.builder;
  if (!builder
    || builder.system !== "host-cargo"
    || !/^darwin\/(?:arm64|amd64)$/u.test(String(builder.platform ?? ""))
    || !/^(?:aarch64|x86_64)-apple-darwin$/u.test(String(builder.host ?? ""))) {
    throw new Error("build_manifest_builder_metadata_invalid");
  }
  if (value.artifacts.length !== EXPECTED_ARTIFACTS.length) {
    throw new Error("build_manifest_must_contain_four_targets");
  }
  const expected = new Map(EXPECTED_ARTIFACTS.map((entry) => [`${entry.component}\0${entry.arch}`, entry]));
  const seen = new Set();
  const binaries = new Set();
  const validated = [];
  for (const artifact of value.artifacts) {
    if (!artifact || typeof artifact !== "object") throw new Error("build_manifest_entry_invalid");
    const key = `${artifact.component}\0${artifact.arch}`;
    const expectedEntry = expected.get(key);
    if (!expectedEntry || seen.has(key)) throw new Error("build_manifest_target_unexpected_or_duplicate");
    if (artifact.rustTarget !== expectedEntry.rustTarget
      || typeof artifact.binary !== "string"
      || artifact.binary !== expectedEntry.binaryPath
      || artifact.libc !== expectedEntry.libc) {
      throw new Error(`build_manifest_target_contract_mismatch:${expectedEntry.component}:${expectedEntry.arch}`);
    }
    if (binaries.has(artifact.binary)) throw new Error("build_manifest_binary_path_duplicated");
    const buildSource = safeToken(artifact.buildSource, "build_source");
    if (buildSource !== "public-registry-locked") {
      throw new Error("build_manifest_source_qualification_unexpected");
    }
    seen.add(key);
    binaries.add(artifact.binary);
    validated.push(Object.freeze({ ...expectedEntry, binary: artifact.binary, buildSource }));
  }
  if (seen.size !== EXPECTED_ARTIFACTS.length) throw new Error("build_manifest_target_missing");
  return Object.freeze({ artifacts: Object.freeze(validated) });
}

async function locateBinary(inputRoot, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.includes("\\")) throw new Error("binary_path_must_be_relative_posix");
  const resolved = path.resolve(inputRoot, ...relativePath.split("/"));
  if (!isWithin(inputRoot, resolved)) throw new Error("binary_path_outside_input_directory");
  const file = await realpath(resolved).catch(() => null);
  if (!file || !isWithin(inputRoot, file)) throw new Error("binary_missing_or_outside_input_directory");
  const fileStat = await lstat(resolved);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("binary_must_be_regular_file");
  if ((fileStat.mode & 0o111) === 0) throw new Error("binary_not_executable");
  return file;
}

async function cargoMetadataFor(target) {
  const result = await run("cargo", [
    "metadata",
    "--format-version", "1",
    "--locked",
    "--filter-platform", target,
    "--manifest-path", CARGO_MANIFEST
  ], WORKSPACE_DIR);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("cargo_metadata_json_invalid");
  }
}

async function cargoMetadata() {
  const targets = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin"
  ];
  const byTarget = {};
  for (const target of targets) byTarget[target] = await cargoMetadataFor(target);
  const packages = new Map();
  const workspaceMembers = new Set();
  for (const target of targets) {
    const metadata = byTarget[target];
    for (const pkg of metadata.packages ?? []) packages.set(pkg.id, pkg);
    for (const member of metadata.workspace_members ?? []) workspaceMembers.add(member);
  }
  return Object.freeze({
    packages: Object.freeze([...packages.values()]),
    workspace_members: Object.freeze([...workspaceMembers]),
    targetMetadata: Object.freeze(byTarget)
  });
}

function nativeVersion(metadata) {
  const wanted = new Set(["meshrix-entry-cli", "meshrix-entry-gui"]);
  const versions = new Set(metadata.packages
    .filter((item) => wanted.has(item.name))
    .map((item) => item.version));
  if (versions.size !== 1 || metadata.packages.filter((item) => wanted.has(item.name)).length !== 2) {
    throw new Error("native_workspace_version_missing_or_inconsistent");
  }
  return safeToken([...versions][0], "native_version");
}

function packageReadme(template, artifact, version) {
  const substitutions = {
    "{{version}}": version,
    "{{component}}": artifact.component,
    "{{arch}}": artifact.arch,
    "{{rustTarget}}": artifact.rustTarget,
    "{{libc}}": artifact.libc,
    "{{buildSource}}": artifact.buildSource,
    "{{binary}}": artifact.archiveBinary,
    "{{machoArch}}": artifact.macho.arch,
    "{{machoMinimumMacOS}}": artifact.macho.minimumMacOS ?? "none",
    "{{machoLinkedLibraries}}": artifact.macho.linkedLibraries.join(", ") || "none"
  };
  let result = template;
  for (const [key, value] of Object.entries(substitutions)) result = result.replaceAll(key, value);
  if (/\{\{[^}]+\}\}/u.test(result)) throw new Error("macos_package_readme_template_unresolved");
  return result;
}

function packageArtifactMetadata(artifact, version) {
  return Object.freeze({
    schemaVersion: "meshrix-entry-macos-artifact-1",
    version,
    component: artifact.component,
    arch: artifact.arch,
    rustTarget: artifact.rustTarget,
    binary: artifact.archiveBinary,
    libc: artifact.libc,
    buildSource: artifact.buildSource,
    macho: artifact.macho
  });
}

async function stageArtifact(artifact, version, binaryPath, readmeTemplate, licenseInventory, tempRoot) {
  const stagingDir = path.join(tempRoot, `${artifact.archiveProduct}-${artifact.arch}`);
  await mkdir(stagingDir, { recursive: true });
  const binaryDestination = path.join(stagingDir, ...artifact.archiveBinary.split("/"));
  await mkdir(path.dirname(binaryDestination), { recursive: true });
  await cp(binaryPath, binaryDestination);
  await chmod(binaryDestination, 0o755);
  await cp(ROOT_LICENSE, path.join(stagingDir, "LICENSE"));
  await writeFile(path.join(stagingDir, "README.md"), packageReadme(readmeTemplate, artifact, version), "utf8");
  await writeFile(path.join(stagingDir, "artifact.json"), `${JSON.stringify(packageArtifactMetadata(artifact, version), null, 2)}\n`, "utf8");
  for (const license of licenseInventory.files) {
    const destination = path.join(stagingDir, ...license.relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(license.sourcePath, destination);
  }
  const indexLines = [...licenseInventory.indexLines];
  if (artifact.component === "gui") {
    const fontLicensePath = path.join(stagingDir, "licenses", "fonts", "INTER-LICENSE.txt");
    await mkdir(path.dirname(fontLicensePath), { recursive: true });
    await cp(FONT_LICENSE, fontLicensePath);
    indexLines.push("", "## Bundled font assets", "", "- Inter fonts — SIL Open Font License 1.1; see `licenses/fonts/INTER-LICENSE.txt`.");
  }
  await writeFile(path.join(stagingDir, "THIRD_PARTY_LICENSES.md"), `${indexLines.join("\n")}\n`, "utf8");
  return Object.freeze({
    stagingDir,
    licenses: Object.freeze({
      dependencyPackages: licenseInventory.dependencyPackages,
      copiedLicenseFiles: licenseInventory.copiedLicenseFiles,
      packagesWithoutLicenseFile: licenseInventory.packagesWithoutLicenseFile
    })
  });
}

function archiveName(artifact, version) {
  return `${artifact.archiveProduct}-${version}-macos-${artifact.arch}.tar.gz`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const inputRoot = await realpath(path.resolve(process.cwd(), options.inputDir)).catch(() => null);
  if (!inputRoot) throw new Error("input_directory_unavailable");
  const outputRoot = path.resolve(process.cwd(), options.outputDir);
  await mkdir(outputRoot, { recursive: true });

  const buildManifest = await readJson(path.join(inputRoot, "build-manifest.json"), "build_manifest_json_invalid");
  // The manifest's provenance claims are checked against the real lockfile
  // and fresh metadata, not trusted as recorded.
  const expectedProvenance = {
    lockSha256: createHash("sha256").update(await readFile(path.join(WORKSPACE_DIR, "Cargo.lock"))).digest("hex"),
    dependencies: publicDependencyEvidence(JSON.parse((await run("cargo", ["metadata", "--format-version", "1", "--locked", "--manifest-path", CARGO_MANIFEST], WORKSPACE_DIR)).stdout))
  };
  const { artifacts } = validateBuildManifest(buildManifest, expectedProvenance);
  const binaries = new Map();
  const binaryFiles = new Set();
  for (const artifact of artifacts) {
    const binaryPath = await locateBinary(inputRoot, artifact.binary);
    if (binaryFiles.has(binaryPath)) throw new Error("build_manifest_targets_share_binary_path");
    binaryFiles.add(binaryPath);
    binaries.set(`${artifact.component}\0${artifact.arch}`, binaryPath);
  }

  const metadata = await cargoMetadata();
  const version = nativeVersion(metadata);
  const readmeTemplate = await readFile(README_TEMPLATE, "utf8");
  const licenseInventory = await collectCargoLicenseInventory(metadata);
  const tempRoot = await mkdtemp(path.join(outputRoot, ".meshrix-macos-package-"));
  const packageEntries = [];
  const stagedArchives = [];
  try {
    for (const artifact of artifacts) {
      const binaryPath = binaries.get(`${artifact.component}\0${artifact.arch}`);
      const macho = await inspectMachO(binaryPath, artifact.arch);
      const packageArtifact = Object.freeze({ ...artifact, macho });
      const staged = await stageArtifact(
        packageArtifact,
        version,
        binaryPath,
        readmeTemplate,
        licenseInventory,
        tempRoot
      );
      const archive = archiveName(packageArtifact, version);
      const stagedArchive = path.join(tempRoot, archive);
      await createArchive(staged.stagingDir, stagedArchive);
      stagedArchives.push({ stagedArchive, finalArchive: path.join(outputRoot, archive) });
      packageEntries.push(Object.freeze({
        archive,
        component: packageArtifact.component,
        arch: packageArtifact.arch,
        rustTarget: packageArtifact.rustTarget,
        binary: packageArtifact.archiveBinary,
        libc: packageArtifact.libc,
        buildSource: packageArtifact.buildSource,
        entrypoint: `./${packageArtifact.archiveBinary}`,
        macho: packageArtifact.macho,
        artifactMetadata: "artifact.json",
        readme: "README.md",
        thirdPartyLicenses: "THIRD_PARTY_LICENSES.md",
        dependencyPackageCount: staged.licenses.dependencyPackages,
        copiedDependencyLicenseFileCount: staged.licenses.copiedLicenseFiles,
        packagesWithoutLicenseFileCount: staged.licenses.packagesWithoutLicenseFile
      }));
    }

    for (const archive of stagedArchives) await rename(archive.stagedArchive, archive.finalArchive);
    const packageManifest = {
      schemaVersion: PACKAGE_MANIFEST_SCHEMA,
      version,
      artifacts: packageEntries
    };
    const manifestTemp = path.join(tempRoot, "package-manifest.json");
    await writeFile(manifestTemp, `${JSON.stringify(packageManifest, null, 2)}\n`, "utf8");
    await rename(manifestTemp, path.join(outputRoot, "package-manifest.json"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  for (const entry of packageEntries) process.stdout.write(`${entry.archive}\n`);
  process.stdout.write(`package-manifest.json (${packageEntries.length} artifacts)\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${redactPaths(error instanceof Error ? error.message : "macos_package_failed")}\n`);
    process.exitCode = 1;
  });
}
