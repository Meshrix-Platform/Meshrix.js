#!/usr/bin/env node

import { validatePublicBuildProvenance } from "../../apps/entry-native/tools/build-linux.mjs";
import { isSystemDylibPath, linkedLibraryEntries } from "../../apps/entry-native/tools/package-macos.mjs";
import { nativeTargets } from "../../apps/entry-native/tools/native-release-config.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NATIVE_ROOT = path.join(REPO_ROOT, "apps", "entry-native");
const BUILD_ROOT = path.join(NATIVE_ROOT, "dist", "macos");
const PACKAGE_ROOT = path.join(BUILD_ROOT, "packages");
const BUILD_MANIFEST = path.join(BUILD_ROOT, "build-manifest.json");
const PACKAGE_MANIFEST = path.join(PACKAGE_ROOT, "package-manifest.json");
// The verified artifact set is shared configuration: builders, packagers
// and verifiers all derive it from the same versioned registry.
const EXPECTED = Object.freeze(nativeTargets("macos").map((target: any) => Object.freeze({
  component: target.component,
  arch: target.arch,
  rustTarget: target.rustTarget,
  libc: target.libc,
  binary: target.archiveBinary,
  buildBinary: target.binaryPath
})));
const MACHO_ARCH_NAMES: any = Object.freeze({ aarch64: "arm64", x86_64: "x86_64" });
const SYNTHETIC_CUSTODY_SECRET = "0000000000000000000000000000000000000000000000000000000000000000";

function fail(code: any): never {
  throw new Error(code);
}

function run(command: any, args: any, options: any = {}) {
  return new Promise<any>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: any[] = [];
    const stderr: any[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", () => reject(new Error(`${command}_unavailable`)));
    child.once("close", (code, signal) => {
      resolve({
        code: code ?? 128,
        signal: signal ?? null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

async function checked(command: any, args: any, options: any = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) fail(`${options.failureCode ?? `${command}_failed`}:${result.code}`);
  return result.stdout;
}

function sortUnique(values: any[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function equalJson(left: any, right: any) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertStringArray(actual: any, expected: any, code: any) {
  if (!Array.isArray(actual) || !actual.every((value) => typeof value === "string")) fail(code);
  if (!equalJson(actual, sortUnique(actual))) fail(`${code}:not_sorted_unique`);
  if (!equalJson(actual, expected)) fail(`${code}:values_mismatch`);
}

function validateTarget(actual: any, expected: any, code: any) {
  if (!actual || typeof actual !== "object"
    || actual.component !== expected.component
    || actual.arch !== expected.arch
    || actual.rustTarget !== expected.rustTarget
    || actual.libc !== expected.libc) {
    fail(`${code}:target_mismatch`);
  }
}

async function validateBuildManifest(manifest: any) {
  // The manifest's provenance claims are checked against the real lockfile,
  // not trusted as recorded.
  const lockSha256 = createHash("sha256").update(await readFile(path.join(NATIVE_ROOT, "Cargo.lock"))).digest("hex");
  validatePublicBuildProvenance(manifest, { lockSha256 });
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== EXPECTED.length) {
    fail("build_manifest_invalid");
  }
  const builder = manifest.builder;
  if (!builder || builder.system !== "host-cargo"
    || !/^darwin\/(?:arm64|amd64)$/u.test(String(builder.platform ?? ""))
    || !/^(?:aarch64|x86_64)-apple-darwin$/u.test(String(builder.host ?? ""))) {
    fail("build_manifest_builder_metadata_invalid");
  }
  const seen = new Set();
  const entries = new Map();
  for (const expected of EXPECTED) {
    const matches = manifest.artifacts.filter((entry: any) => entry?.component === expected.component && entry?.arch === expected.arch);
    if (matches.length !== 1) fail("build_manifest_target_missing_or_duplicate");
    const entry = matches[0];
    validateTarget(entry, expected, "build_manifest");
    if (entry.binary !== expected.buildBinary || entry.buildSource !== "public-registry-locked") {
      fail("build_manifest_output_contract_mismatch");
    }
    seen.add(`${entry.component}\0${entry.arch}`);
    entries.set(`${entry.component}\0${entry.arch}`, Object.freeze({ ...expected, buildSource: entry.buildSource }));
  }
  if (seen.size !== EXPECTED.length) fail("build_manifest_incomplete");
  return entries;
}

function workspaceVersion(cargoToml: any) {
  const header = "[workspace.package]";
  const headerOffset = cargoToml.indexOf(header);
  if (headerOffset < 0) fail("native_workspace_version_missing");
  const remainder = cargoToml.slice(headerOffset + header.length).replace(/^\r?\n/u, "");
  const nextSection = remainder.search(/^\[[^\]]+\]\s*$/mu);
  const section = nextSection < 0 ? remainder : remainder.slice(0, nextSection);
  const version = section.match(/^version\s*=\s*"([^"]+)"\s*$/mu)?.[1];
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(version)) fail("native_workspace_version_missing");
  return version;
}

function packageName(entry: any, version: any) {
  const product = entry.component === "gui" ? "meshrix-entry-gui" : "meshrix-entry";
  return `${product}-${version}-macos-${entry.arch}.tar.gz`;
}

function archivePath(root: any, relative: any) {
  if (typeof relative !== "string" || relative.length === 0 || path.posix.isAbsolute(relative) || relative.includes("\\")) {
    fail("archive_path_invalid");
  }
  const parts = relative.split("/");
  if (parts.some((part: any) => part === ".." || part === "")) fail("archive_path_invalid");
  const resolved = path.resolve(root, ...parts);
  if (path.relative(root, resolved).startsWith("..") || path.isAbsolute(path.relative(root, resolved))) fail("archive_path_escape");
  return resolved;
}

function normalizeArchiveName(name: any) {
  let normalized = name.replace(/\/$/u, "");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.includes("\\")
    || normalized.split("/").some((part: any) => part === ".." || part === "")) {
    fail("archive_contains_unsafe_path");
  }
  return normalized;
}

async function listArchive(archive: any) {
  const names = (await checked("tar", ["-tzf", archive], { failureCode: "archive_listing_failed" }))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(normalizeArchiveName);
  if (new Set(names).size !== names.length) fail("archive_contains_duplicate_paths");
  return names;
}

async function inspectMachO(binary: any, expectedArch: any) {
  const expectedName = MACHO_ARCH_NAMES[expectedArch];
  const lipoInfo = await checked("lipo", ["-info", binary], { failureCode: "macho_inspection_failed" });
  const thin = lipoInfo.match(/Non-fat file:.*?architecture:\s*(\S+)\s*$/u)?.[1]
    ?? lipoInfo.match(/^Architectures in the fat file:.*?are:\s*(.+?)\s*$/u)?.[1];
  if (thin !== expectedName) fail(`macho_architecture_mismatch:${expectedArch}`);

  const loadCommands = await checked("otool", ["-L", binary], { failureCode: "macho_inspection_failed" });
  const linkedLibraries = linkedLibraryEntries(loadCommands, binary);
  if (linkedLibraries.some((library: any) => !isSystemDylibPath(library))) {
    fail(`non_system_dylib:${expectedArch}`);
  }

  const buildInfo = await checked("vtool", ["-show-build", binary], { failureCode: "macho_inspection_failed" });
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

function compareMachoMetadata(metadata: any, actual: any, code: any) {
  if (!metadata || typeof metadata !== "object") fail(`${code}:missing`);
  for (const field of ["format", "arch", "minimumMacOS", "sdk"]) {
    if (metadata[field] !== actual[field]) fail(`${code}:${field}_mismatch`);
  }
  assertStringArray(metadata.linkedLibraries, actual.linkedLibraries, `${code}:linkedLibraries`);
}

async function fileExists(file: any) {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function requireRegularFile(file: any, code: any) {
  const stat = await lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(code);
  return stat;
}

function assertNoLocalPaths(value: any, code: any) {
  const text = JSON.stringify(value);
  if (/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|[A-Za-z]:\\Users\\)/u.test(text)) {
    fail(code);
  }
}

async function filesBelow(directory: any) {
  if (!(await fileExists(directory))) return [];
  const result: any[] = [];
  async function visit(current: any) {
    for (const child of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, child.name);
      if (child.isDirectory()) await visit(file);
      else if (child.isFile()) result.push(file);
      else fail("license_tree_contains_non_regular_file");
    }
  }
  await visit(directory);
  return result;
}

async function verifyLicenses(root: any, entry: any, archiveNames: any, expected: any) {
  for (const required of [entry.binary, "README.md", "LICENSE", "artifact.json", "THIRD_PARTY_LICENSES.md"]) {
    if (!archiveNames.includes(required)) fail("archive_required_file_missing");
    await requireRegularFile(path.join(root, ...required.split("/")), "archive_required_file_not_regular");
  }
  const cargoLicenseFiles = await filesBelow(path.join(root, "licenses", "cargo"));
  const fontPath = "licenses/fonts/INTER-LICENSE.txt";
  const licenseText = await readFile(path.join(root, "THIRD_PARTY_LICENSES.md"), "utf8");
  if (licenseText.split(/\r?\n/u).filter((line) => /^- .+@.+ — /u.test(line)).length !== entry.dependencyPackageCount) {
    fail("cargo_dependency_license_index_count_mismatch");
  }
  if (cargoLicenseFiles.length !== entry.copiedDependencyLicenseFileCount) fail("cargo_license_file_count_mismatch");
  if (entry.packagesWithoutLicenseFileCount > entry.dependencyPackageCount) fail("cargo_license_missing_count_invalid");
  if (expected.component === "gui") {
    if (!archiveNames.includes(fontPath) || !licenseText.includes("SIL Open Font License 1.1")) fail("gui_font_license_missing");
  } else if (archiveNames.includes(fontPath)) {
    fail("cli_archive_contains_unneeded_font_license");
  }
  const repoLicense = path.join(REPO_ROOT, "LICENSE");
  const cmp = await run("cmp", ["-s", repoLicense, path.join(root, "LICENSE")]);
  if (cmp.code !== 0) fail("project_license_mismatch");
}

function assertArchiveFileSet(names: any, expected: any) {
  const rootFiles = new Set(["README.md", "LICENSE", "artifact.json", "THIRD_PARTY_LICENSES.md"]);
  const required = [expected.binary, ...rootFiles];
  const normalized = names.map((name: any) => name.replace(/\/$/u, ""));
  for (const file of required) {
    if (!normalized.includes(file)) fail("archive_required_entry_missing");
  }
  if (!normalized.some((name: any) => name === "licenses" || name.startsWith("licenses/"))) fail("archive_license_tree_missing");
  for (const name of normalized) {
    if (rootFiles.has(name) || name === expected.binary || name === "licenses" || name.startsWith("licenses/")) continue;
    if (name === "bin" || name === path.posix.dirname(expected.binary)) continue;
    fail("archive_contains_unexpected_entry");
  }
}

async function extractArchive(archive: any, output: any) {
  await mkdir(output, { recursive: true });
  await checked("tar", ["-xzf", archive, "-C", output, "--no-same-owner"], { failureCode: "archive_extraction_failed" });
  const root = await realpath(output);
  async function inspect(directory: any) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(file).catch(() => null);
        if (!target || (target !== root && !target.startsWith(`${root}${path.sep}`))) fail("archive_symlink_escape");
      } else if (entry.isDirectory()) {
        await inspect(file);
      } else if (!entry.isFile()) {
        fail("archive_contains_special_file");
      }
    }
  }
  await inspect(root);
}

async function verifyArchive(entry: any, buildEntry: any, expected: any, version: any, tempRoot: any) {
  validateTarget(entry, expected, "package_manifest");
  const archiveNameValue = packageName(expected, version);
  if (entry.archive !== archiveNameValue || entry.binary !== expected.binary || entry.entrypoint !== `./${expected.binary}`
    || entry.buildSource !== buildEntry.buildSource || entry.artifactMetadata !== "artifact.json"
    || entry.readme !== "README.md" || entry.thirdPartyLicenses !== "THIRD_PARTY_LICENSES.md") {
    fail("package_manifest_entry_contract_mismatch");
  }
  for (const count of ["dependencyPackageCount", "copiedDependencyLicenseFileCount", "packagesWithoutLicenseFileCount"]) {
    if (!Number.isInteger(entry[count]) || entry[count] < 0) fail("package_license_inventory_metadata_invalid");
  }

  const archive = path.join(PACKAGE_ROOT, archiveNameValue);
  const archiveStat = await lstat(archive).catch(() => null);
  if (!archiveStat?.isFile() || archiveStat.isSymbolicLink()) fail("package_archive_missing_or_not_regular");
  const names = await listArchive(archive);
  assertArchiveFileSet(names, expected);
  const extracted = path.join(tempRoot, `${expected.component}-${expected.arch}`);
  await extractArchive(archive, extracted);
  await verifyLicenses(extracted, entry, names, expected);

  const buildBinary = path.resolve(BUILD_ROOT, ...buildEntry.buildBinary.split("/"));
  const archivedBinary = archivePath(extracted, expected.binary);
  const binaryStat = await lstat(buildBinary).catch(() => null);
  if (!binaryStat?.isFile() || binaryStat.isSymbolicLink() || (binaryStat.mode & 0o111) === 0) fail("build_binary_missing_or_not_executable");
  const archivedBinaryStat = await requireRegularFile(archivedBinary, "archive_entrypoint_must_be_raw_macho");
  if ((archivedBinaryStat.mode & 0o111) === 0) fail("archive_entrypoint_not_executable");
  const cmp = await run("cmp", ["-s", buildBinary, archivedBinary]);
  if (cmp.code !== 0) fail("archive_binary_differs_from_build_output");

  const actualMacho = await inspectMachO(archivedBinary, expected.arch);
  compareMachoMetadata(entry.macho, actualMacho, "package_manifest_macho_facts");
  const artifact = JSON.parse(await readFile(path.join(extracted, "artifact.json"), "utf8"));
  if (artifact.schemaVersion !== "meshrix-entry-macos-artifact-1" || artifact.version !== version
    || artifact.component !== expected.component || artifact.arch !== expected.arch
    || artifact.rustTarget !== expected.rustTarget || artifact.binary !== expected.binary
    || artifact.libc !== expected.libc || artifact.buildSource !== buildEntry.buildSource
    || !equalJson(artifact.macho, entry.macho)) fail("artifact_metadata_mismatch");
  assertNoLocalPaths(artifact, "artifact_metadata_contains_local_path");
  const readme = await readFile(path.join(extracted, "README.md"), "utf8");
  if (readme.includes("{{") || !readme.includes(actualMacho.arch)
    || !readme.includes(actualMacho.minimumMacOS ?? "none")) fail("archive_readme_macho_facts_incomplete");
  assertNoLocalPaths(readme, "archive_readme_contains_local_path");
  return Object.freeze({ entry, archive, extracted, binary: archivedBinary, macho: actualMacho });
}

async function rosettaAvailable() {
  const result = await run("/usr/bin/arch", ["-x86_64", "/usr/bin/true"]);
  return result.code === 0;
}

async function probeCommandFor(arch: any, hostArch: any, translated: any) {
  if (arch === hostArch) return null;
  if (arch === "x86_64" && hostArch === "aarch64" && translated) return ["-x86_64"];
  return "unavailable";
}

async function writableState(tempRoot: any, name: any) {
  const state = path.join(tempRoot, name);
  await mkdir(path.join(state, "home"), { recursive: true });
  await mkdir(path.join(state, "data"), { recursive: true });
  await chmod(state, 0o777);
  await chmod(path.join(state, "home"), 0o777);
  await chmod(path.join(state, "data"), 0o777);
  return state;
}

// Every probe runs with a sanitized allowlist environment: temporary
// HOME/data paths and a minimal PATH. The verifier's ambient environment
// never reaches an artifact under test.
function probeEnv(stateRoot: any, tmpDir: any) {
  const environment: any = {
    PATH: stateRoot ? "/__no_installed_agents__" : "/usr/bin:/bin",
    HOME: stateRoot ? `${stateRoot}/home` : tmpDir,
    TMPDIR: tmpDir
  };
  if (stateRoot) {
    environment.MESHRIX_ENTRY_DATA_DIR = `${stateRoot}/data`;
    environment.MESHRIX_CUSTODY = "file";
    environment.MESHRIX_CUSTODY_SECRET = SYNTHETIC_CUSTODY_SECRET;
  }
  return environment;
}

// Probes run deny-by-default: the seatbelt profile grants reads only to the
// extracted artifact, system runtime paths and the device files dyld needs,
// writes only to the probe's temporary state, and no network at all. A
// compromised artifact cannot read the invoking user's files or transmit
// anything, even though it executes as that user.
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function probeSandboxProfile(binaryDir: any, cwd: any, stateRoot: any, tmpdir: any) {
  const q = (value: any) => JSON.stringify(value);
  const writable = [`(subpath ${q(tmpdir)})`];
  if (stateRoot) writable.push(`(subpath ${q(stateRoot)})`);
  return `(version 1)
(deny default)
(allow process*)
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.DirectoryService.libinfo_v1")
  (global-name "com.apple.logd")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center"))
(allow sysctl*)
(allow signal)
(allow file-read-metadata)
(allow file-read*
  (subpath "/usr")
  (subpath "/System")
  (subpath "/Library/Apple")
  (subpath ${q(binaryDir)})
  (subpath ${q(cwd)})
  (literal "/")
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/random")
  (literal "/dev/urandom"))
(allow file-map-executable
  (subpath "/usr")
  (subpath "/System")
  (subpath "/Library/Apple")
  (subpath ${q(binaryDir)}))
(allow file-read* file-write* ${writable.join(" ")})
(deny network*)`;
}

async function runtimeProbe(binary: any, archPrefix: any, stateRoot: any, args: any, cwd: any, tmpDir: any) {
  const realBinary = await realpath(binary);
  const realCwd = await realpath(cwd);
  const realState = stateRoot ? await realpath(stateRoot) : null;
  const realTmp = await realpath(tmpDir);
  const profile = probeSandboxProfile(path.dirname(realBinary), realCwd, realState, realTmp);
  const inner = archPrefix ? ["/usr/bin/arch", ...archPrefix, realBinary, ...args] : [realBinary, ...args];
  const result = await run(SANDBOX_EXEC, ["-p", profile, ...inner], { cwd: realCwd, env: probeEnv(realState ?? stateRoot, realTmp) });
  if (result.code !== 0) fail(`runtime_binary_probe_failed:${result.code}`);
  return result.stdout;
}

function parseJsonOutput(output: any, code: any) {
  try {
    return JSON.parse(output);
  } catch {
    fail(code);
  }
}

async function verifyRuntime(probes: any, hostArch: any, translated: any, version: any, tempRoot: any) {
  const probeTmp = path.join(tempRoot, "probe-tmp");
  await mkdir(probeTmp, { recursive: true });
  const modes = new Set();
  for (const probe of probes) {
    const { entry, extracted, binary } = probe;
    const expected: any = EXPECTED.find((item: any) => item.component === entry.component && item.arch === entry.arch);
    const prefix = await probeCommandFor(expected.arch, hostArch, translated);
    const mode = prefix === "unavailable" ? "not-run" : prefix ? "translated" : "native";
    modes.add(`${expected.arch}:${mode}`);
    if (mode === "not-run") {
      process.stdout.write(`SKIP ${expected.arch} ${expected.component} runtime probes: no executable environment on this host\n`);
      continue;
    }

    const relativeBinary = path.relative(extracted, binary).split(path.sep).join("/");
    if (expected.component === "cli-tui") {
      const help = await runtimeProbe(binary, prefix, null, ["--help"], extracted, probeTmp);
      const cliVersion = await runtimeProbe(binary, prefix, null, ["--version"], extracted, probeTmp);
      if (!help.includes("Usage: meshrix-entry") || !cliVersion.includes(`meshrix-entry ${version}`)) {
        fail("cli_metadata_probe_mismatch");
      }
      const profileState = await writableState(tempRoot, `${expected.arch}-profiles-${process.pid}`);
      try {
        const profilesOutput = await runtimeProbe(binary, prefix, profileState, ["profiles"], extracted, probeTmp);
        const profiles = parseJsonOutput(profilesOutput, "cli_profiles_output_invalid");
        if (!Array.isArray(profiles.profiles) || profiles.profiles.length !== 0) fail("cli_empty_profiles_probe_failed");
      } finally {
        await rm(profileState, { recursive: true, force: true });
      }
      const cardsState = await writableState(tempRoot, `${expected.arch}-cards-${process.pid}`);
      try {
        const cardsOutput = await runtimeProbe(binary, prefix, cardsState, ["agent-cards"], extracted, probeTmp);
        const cards = parseJsonOutput(cardsOutput, "cli_agent_cards_output_invalid");
        if (!Array.isArray(cards.cards)) fail("cli_agent_cards_probe_failed");
      } finally {
        await rm(cardsState, { recursive: true, force: true });
      }
      process.stdout.write(`PASS ${expected.arch} CLI/TUI (${mode}): --help, --version, empty profiles, read-only agent-cards\n`);
    } else {
      const help = await runtimeProbe(binary, prefix, null, ["--help"], extracted, probeTmp);
      const guiVersion = await runtimeProbe(binary, prefix, null, ["--version"], extracted, probeTmp);
      if (!help.includes("Usage: meshrix-entry-gui") || !/meshrix-entry-gui \d+\.\d+\.\d+/u.test(guiVersion)) {
        fail("gui_metadata_probe_mismatch");
      }
      process.stdout.write(`PASS ${expected.arch} GUI metadata fast path (${mode}); display not opened\n`);
      process.stdout.write(`  linkedLibraries=[${entry.macho.linkedLibraries.join(", ")}] minos=${entry.macho.minimumMacOS ?? "none"}\n`);
    }
  }
  return [...modes].sort();
}

async function main() {
  if (process.platform !== "darwin") fail("macos_artifact_profile_host_not_supported");
  const hostArch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  if (!hostArch) fail("macos_artifact_host_architecture_unsupported");
  await requireRegularFile(SANDBOX_EXEC, "probe_sandbox_exec_unavailable");
  const nativeCargo = await readFile(path.join(NATIVE_ROOT, "Cargo.toml"), "utf8");
  const version = workspaceVersion(nativeCargo);
  const buildManifest = JSON.parse(await readFile(BUILD_MANIFEST, "utf8"));
  const buildEntries = await validateBuildManifest(buildManifest);
  const packageManifest = JSON.parse(await readFile(PACKAGE_MANIFEST, "utf8"));
  if (!packageManifest || packageManifest.schemaVersion !== 1 || packageManifest.version !== version
    || !Array.isArray(packageManifest.artifacts) || packageManifest.artifacts.length !== EXPECTED.length) {
    fail("package_manifest_invalid");
  }
  assertNoLocalPaths(packageManifest, "package_manifest_contains_local_path");
  const translated = hostArch === "aarch64" ? await rosettaAvailable() : false;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "meshrix-macos-artifact-check-"));
  try {
    const probes: any[] = [];
    for (const expected of EXPECTED) {
      const buildEntry = buildEntries.get(`${expected.component}\0${expected.arch}`);
      const entries = packageManifest.artifacts.filter((entry: any) => entry?.component === expected.component && entry?.arch === expected.arch);
      if (entries.length !== 1) fail("package_manifest_target_missing_or_duplicate");
      probes.push(await verifyArchive(entries[0], buildEntry, expected, version, tempRoot));
    }
    // The release uploads this same package directory after verification, so
    // re-hash every archive after the probes: the deny-by-default sandbox
    // already prevents artifact writes outside temporary state, and this
    // digest check proves the published bytes are unchanged.
    const archiveDigests = new Map();
    for (const probe of probes) {
      archiveDigests.set(probe.archive, createHash("sha256").update(await readFile(probe.archive)).digest("hex"));
    }
    const modes = await verifyRuntime(probes, hostArch, translated, version, tempRoot);
    for (const probe of probes) {
      const digest = createHash("sha256").update(await readFile(probe.archive)).digest("hex");
      if (digest !== archiveDigests.get(probe.archive)) fail("package_archive_modified_during_probes");
    }
    process.stdout.write(`PASS four macOS client archives; native workspace version ${version}; probe modes ${modes.join(", ")}\n`);
    process.stdout.write("Qualification ran sandboxed local probes (network denied) with synthetic custody state; no Agent process, conversation, display or user data was accessed.\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "native_macos_artifact_check_failed";
  process.stderr.write(`${message.replace(/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/)[^\s]+/gu, "<path>")}\n`);
  process.exitCode = 1;
});
