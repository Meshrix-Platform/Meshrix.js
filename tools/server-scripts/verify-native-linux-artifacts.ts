#!/usr/bin/env node

import { validatePublicBuildProvenance } from "../../apps/entry-native/tools/build-linux.mjs";
import { loadNativeReleaseConfig, nativeTargets } from "../../apps/entry-native/tools/native-release-config.mjs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NATIVE_ROOT = path.join(REPO_ROOT, "apps", "entry-native");
const BUILD_ROOT = path.join(NATIVE_ROOT, "dist", "linux");
const PACKAGE_ROOT = path.join(BUILD_ROOT, "packages");
const BUILD_MANIFEST = path.join(BUILD_ROOT, "build-manifest.json");
const PACKAGE_MANIFEST = path.join(PACKAGE_ROOT, "package-manifest.json");
// The verified artifact set and runtime qualification images are shared
// configuration: builders, packagers and verifiers all derive them from the
// same versioned registry.
const EXPECTED = Object.freeze(nativeTargets("linux").map((target: any) => Object.freeze({
  component: target.component,
  arch: target.arch,
  rustTarget: target.rustTarget,
  libc: target.libc,
  binary: target.archiveBinary,
  buildBinary: target.binaryPath
})));
const RELEASE_CONFIG = loadNativeReleaseConfig();
const ALPINE_IMAGES: any = RELEASE_CONFIG.runtimeImages.alpine;
const MANYLINUX_IMAGES: any = Object.freeze({
  x86_64: RELEASE_CONFIG.linuxBuilders.x86_64.base,
  aarch64: RELEASE_CONFIG.linuxBuilders.aarch64.base
});
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

function compareAbiVersions(left: any, right: any) {
  return left.split("_")[0].localeCompare(right.split("_")[0]) || compareVersions(left, right);
}

function sortUniqueVersions(values: any[]) {
  return [...new Set(values)].sort(compareAbiVersions);
}

function compareVersions(left: any, right: any) {
  const leftParts = left.split("_").at(-1).split(".").map(Number);
  const rightParts = right.split("_").at(-1).split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function highestVersion(values: any[], prefix: any) {
  return values.filter((value) => value.startsWith(prefix)).sort(compareVersions).at(-1) ?? null;
}

async function findReadelf() {
  const candidates = process.env.MESHRIX_READELF
    ? [process.env.MESHRIX_READELF]
    : ["readelf", "llvm-readelf"];
  for (const candidate of candidates) {
    try {
      const result = await run(candidate, ["--version"]);
      if (result.code === 0) return candidate;
    } catch {
      // Try the next standard ELF inspection tool.
    }
  }
  fail("readelf_or_llvm_readelf_required");
}

async function inspectElf(binary: any, readelf: any, expectedArch: any) {
  const output = await checked(readelf, [
    "--wide", "--file-header", "--program-headers", "--dynamic", "--version-info", binary
  ], { failureCode: "elf_inspection_failed" });
  const elfClass = output.match(/^\s*Class:\s*(ELF\d+)\s*$/mu)?.[1] ?? null;
  const machineDescription = output.match(/^\s*Machine:\s*(.+?)\s*$/mu)?.[1] ?? "";
  const machine = /aarch64/iu.test(machineDescription)
    ? "aarch64"
    : /x86-64|x86_64/iu.test(machineDescription)
      ? "x86_64"
      : machineDescription;
  if (elfClass !== "ELF64" || machine !== expectedArch) fail(`elf_header_mismatch:${expectedArch}`);

  const interpreter = output.match(/Requesting program interpreter:\s*([^\]\r\n]+)/u)?.[1]?.trim() ?? null;
  const neededLibraries = sortUnique([...output.matchAll(/Shared library:\s*\[([^\]]+)\]/gu)].map((match) => match[1]));
  const versionedRequirements = sortUniqueVersions([...output.matchAll(/\b((?:GLIBC|GLIBCXX|CXXABI|GCC)_\d+(?:\.\d+)+)\b/gu)].map((match) => match[1]));
  const runpathMatch = output.match(/\(RUNPATH\).*?Library runpath:\s*\[([^\]]*)\]/u);
  const rpathMatch = output.match(/\(RPATH\).*?Library rpath:\s*\[([^\]]*)\]/u);
  const runpath = runpathMatch?.[1] ?? rpathMatch?.[1] ?? null;
  return Object.freeze({
    class: elfClass,
    machine,
    interpreter,
    neededLibraries,
    versionedRequirements,
    highestGlibcRequirement: highestVersion(versionedRequirements, "GLIBC_"),
    runpath,
    runpathKind: runpathMatch ? "RUNPATH" : rpathMatch ? "RPATH" : null
  });
}

function equalJson(left: any, right: any) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertStringArray(actual: any, expected: any, code: any) {
  if (!Array.isArray(actual) || !actual.every((value) => typeof value === "string")) fail(code);
  if (!equalJson(actual, sortUnique(actual))) fail(`${code}:not_sorted_unique`);
  if (!equalJson(actual, expected)) fail(`${code}:values_mismatch`);
}

function assertVersionArray(actual: any, expected: any, code: any) {
  if (!Array.isArray(actual) || !actual.every((value) => typeof value === "string")) fail(code);
  if (!equalJson(actual, sortUniqueVersions(actual))) fail(`${code}:not_sorted_unique`);
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

function requireLinuxDisplayFeatures(cargoToml: any) {
  const eframe = cargoToml.match(/^eframe\s*=\s*\{([^}]*)\}/mu)?.[1] ?? "";
  const featureText = eframe.match(/features\s*=\s*\[([^\]]*)\]/u)?.[1] ?? "";
  const features = new Set([...featureText.matchAll(/"([^"]+)"/gu)].map((match) => match[1]));
  if (!features.has("x11") || !features.has("wayland")) fail("gui_linux_display_features_missing");
}

function packageName(entry: any, version: any) {
  const product = entry.component === "gui" ? "meshrix-entry-gui" : "meshrix-entry";
  return `${product}-${version}-linux-${entry.arch}-${entry.libc}.tar.gz`;
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

function compareElfMetadata(metadata: any, actual: any, expected: any, code: any, sharedLibrary = false) {
  if (!metadata || typeof metadata !== "object") fail(`${code}:missing`);
  for (const field of ["class", "machine", "interpreter", "highestGlibcRequirement", "runpath"]) {
    if (metadata[field] !== actual[field]) fail(`${code}:${field}_mismatch`);
  }
  assertStringArray(metadata.neededLibraries, actual.neededLibraries, `${code}:neededLibraries`);
  assertVersionArray(metadata.versionedRequirements, actual.versionedRequirements, `${code}:versionedRequirements`);
  if (expected.libc === "musl") {
    if (actual.interpreter !== null || actual.neededLibraries.length !== 0 || actual.versionedRequirements.length !== 0) {
      fail(`${code}:musl_binary_not_static`);
    }
  } else {
    if (sharedLibrary) {
      if (actual.interpreter !== null) fail(`${code}:shared_library_has_interpreter`);
    } else {
      const expectedInterpreter = expected.arch === "x86_64"
        ? "/lib64/ld-linux-x86-64.so.2"
        : "/lib/ld-linux-aarch64.so.1";
      if (actual.interpreter !== expectedInterpreter) fail(`${code}:gnu_interpreter_mismatch`);
    }
    if (actual.highestGlibcRequirement && compareVersions(actual.highestGlibcRequirement, "GLIBC_2.28") > 0) {
      fail(`${code}:glibc_floor_exceeds_2_28`);
    }
  }
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

async function verifyBundleClosure(root: any, entry: any, expected: any, readelf: any) {
  const elf = entry.elf;
  if (expected.component !== "gui") {
    if (elf.bundledLibraries?.length || elf.hostLibraries?.length || elf.bundledLibraryFacts?.length) {
      fail("musl_cli_must_not_declare_dynamic_bundle");
    }
    return;
  }
  if (!Array.isArray(elf.bundledLibraries) || !Array.isArray(elf.hostLibraries) || !Array.isArray(elf.bundledLibraryFacts)) {
    fail("gui_runtime_closure_metadata_missing");
  }
  if (typeof elf.hostDisplay !== "string" || !elf.hostDisplay.trim()
    || typeof elf.hostGpu !== "string" || !elf.hostGpu.trim()) fail("gui_host_runtime_requirements_missing");
  assertStringArray(elf.bundledLibraries, sortUnique(elf.bundledLibraries), "gui_bundled_library_list");
  assertStringArray(elf.hostLibraries, sortUnique(elf.hostLibraries), "gui_host_library_list");
  assertStringArray(elf.dlopenCandidates, sortUnique(elf.dlopenCandidates ?? []), "gui_dlopen_candidate_list");
  if (elf.bundledLibraries.some((name: any) => elf.hostLibraries.includes(name))) fail("gui_library_classification_overlap");
  const bundled = new Set(elf.bundledLibraries);
  const host = new Set(elf.hostLibraries);
  const dlopenCandidates = new Set(elf.dlopenCandidates);
  for (const candidate of dlopenCandidates) {
    if (!bundled.has(candidate) && !host.has(candidate)) fail("source_confirmed_dlopen_dependency_unclassified");
  }
  const isOrdinaryDisplayClientLibrary = (name: any) => /^(?:libwayland-(?:client|cursor|egl)|libxkbcommon(?:-x11)?|libX[^/]+|libxcb(?:-[^/]+)?)\.so/u.test(name);
  if ([...host].some(isOrdinaryDisplayClientLibrary)) fail("ordinary_display_client_library_not_bundled");
  if ([...dlopenCandidates].some((name) => isOrdinaryDisplayClientLibrary(name) && !bundled.has(name))) {
    fail("ordinary_dlopen_display_library_not_bundled");
  }
  const inspected = new Map();
  const queue = [...entry.elf.neededLibraries, ...elf.bundledLibraries.filter((name: any) => dlopenCandidates.has(name))];
  const visited = new Set();
  const discoveredHost = new Set();
  for (const candidate of dlopenCandidates) {
    if (!bundled.has(candidate)) discoveredHost.add(candidate);
  }

  while (queue.length > 0) {
    const soname = queue.shift();
    if (visited.has(soname)) continue;
    visited.add(soname);
    if (!bundled.has(soname)) {
      discoveredHost.add(soname);
      continue;
    }
    const file = path.join(root, "lib", soname);
    if (!(await fileExists(file))) fail("declared_bundled_library_missing");
    const actualPath = await realpath(file).catch(() => null);
    const libRoot = await realpath(path.join(root, "lib")).catch(() => null);
    if (!actualPath || !libRoot || !actualPath.startsWith(`${libRoot}${path.sep}`)) fail("bundled_library_path_escape");
    const stat = await lstat(file);
    const resolvedStat = await lstat(actualPath);
    if ((!stat.isFile() && !stat.isSymbolicLink()) || !resolvedStat.isFile()) fail("bundled_library_not_regular_file");
    const actual = await inspectElf(file, readelf, expected.arch);
    if (!actual.runpath || actual.runpathKind !== "RUNPATH" || !actual.runpath.split(":").includes("$ORIGIN")) {
      fail("bundled_library_origin_runpath_missing");
    }
    inspected.set(soname, actual);
    for (const dependency of actual.neededLibraries) queue.push(dependency);
  }

  if (!equalJson(sortUnique([...discoveredHost]), sortUnique([...host]))) fail("gui_host_dependency_closure_mismatch");
  if (!equalJson(sortUnique([...visited].filter((name) => bundled.has(name))), sortUnique([...bundled]))) {
    fail("gui_bundle_contains_unreachable_library");
  }
  const factsByName = new Map<any, any>(elf.bundledLibraryFacts.map((fact: any): [any, any] => [fact?.soname, fact]));
  if (factsByName.size !== bundled.size) fail("bundled_library_facts_count_mismatch");
  for (const [soname, actual] of inspected) {
    const fact = factsByName.get(soname);
    if (!fact || fact.path !== `lib/${soname}`) fail("bundled_library_facts_path_mismatch");
    compareElfMetadata(fact, actual, expected, "bundled_library_elf_facts", true);
    if (fact.runpath !== "$ORIGIN") fail("bundled_library_runpath_metadata_mismatch");
  }
  const bundledVersions = sortUniqueVersions([...inspected.values()]
    .flatMap((facts) => facts.versionedRequirements)
    .filter((version) => version.startsWith("GLIBC_")));
  assertVersionArray(elf.bundledVersionedRequirements, bundledVersions, "gui_bundled_versioned_requirements");
  const packageVersions = sortUnique([...entry.elf.versionedRequirements, ...bundledVersions]);
  if (elf.packageHighestGlibcRequirement !== highestVersion(packageVersions, "GLIBC_")) {
    fail("gui_package_glibc_floor_metadata_mismatch");
  }
  if (elf.packageHighestGlibcRequirement && compareVersions(elf.packageHighestGlibcRequirement, "GLIBC_2.28") > 0) {
    fail("gui_package_glibc_floor_exceeds_2_28");
  }
  await verifyRuntimePackageLicenses(root, entry, factsByName);
}

async function verifyRuntimePackageLicenses(root: any, entry: any, factsByName: any) {
  if (!Array.isArray(entry.runtimePackages)) fail("gui_runtime_package_inventory_missing");
  const packages = new Map();
  const libraryPackages = new Set([...factsByName.values()].map((fact) => fact.licensePackage));
  const licensePaths = new Set();
  const notice = await readFile(path.join(root, "THIRD_PARTY_LICENSES.md"), "utf8");
  for (const runtimePackage of entry.runtimePackages) {
    if (!runtimePackage || typeof runtimePackage.name !== "string" || !runtimePackage.name
      || typeof runtimePackage.version !== "string" || !runtimePackage.version
      || typeof runtimePackage.license !== "string" || !runtimePackage.license.trim()
      || !Array.isArray(runtimePackage.licenseSources) || runtimePackage.licenseSources.length === 0
      || !Array.isArray(runtimePackage.licenseFiles) || runtimePackage.licenseFiles.length === 0) {
      fail("gui_runtime_package_license_record_invalid");
    }
    const id = `${runtimePackage.name}@${runtimePackage.version}`;
    if (packages.has(id)) fail("gui_runtime_package_duplicate");
    packages.set(id, runtimePackage);
    if (!notice.includes(id) || !notice.includes(runtimePackage.license)) fail("gui_runtime_package_missing_from_notice");
    const sources = new Set();
    for (const source of runtimePackage.licenseSources) {
      if (!source || typeof source.name !== "string" || !source.name
        || typeof source.version !== "string" || !source.version
        || typeof source.license !== "string" || !source.license.trim()) {
        fail("gui_runtime_license_source_invalid");
      }
      const sourceId = `${source.name}@${source.version}`;
      sources.add(sourceId);
      if (source.sourceUrl) {
        let parsed: any;
        try { parsed = new URL(source.sourceUrl); } catch { fail("gui_runtime_license_source_url_invalid"); }
        if (parsed.protocol !== "https:" || !parsed.hostname) fail("gui_runtime_license_source_url_invalid");
      }
      if (source.sourceNotice) {
        const sourceNoticeFile = archivePath(root, source.sourceNotice);
        await requireRegularFile(sourceNoticeFile, "gui_runtime_license_source_notice_missing");
        if (!notice.includes(source.sourceNotice)) fail("gui_runtime_license_source_notice_unindexed");
      }
    }
    for (const licenseFile of runtimePackage.licenseFiles) {
      if (!licenseFile || typeof licenseFile.path !== "string" || typeof licenseFile.sourcePackage !== "string"
        || !sources.has(licenseFile.sourcePackage)) fail("gui_runtime_license_file_record_invalid");
      const relative = licenseFile.path;
      const file = archivePath(root, relative);
      await requireRegularFile(file, "gui_runtime_license_file_missing");
      if (!notice.includes(relative)) fail("gui_runtime_license_path_missing_from_notice");
      licensePaths.add(relative);
    }
  }
  for (const fact of factsByName.values()) {
    if (typeof fact.licensePackage !== "string" || !packages.has(fact.licensePackage)) {
      fail("bundled_library_license_package_unresolved");
    }
    if (!equalJson(fact.licenseSources, packages.get(fact.licensePackage).licenseSources)) {
      fail("bundled_library_license_sources_mismatch");
    }
  }
  if (libraryPackages.size !== packages.size || [...packages.keys()].some((id) => !libraryPackages.has(id))) {
    fail("gui_runtime_package_inventory_mismatch");
  }
  if (entry.runtimeLibraryPackageCount !== packages.size || entry.copiedRuntimeLicenseFileCount !== licensePaths.size) {
    fail("gui_runtime_package_license_count_mismatch");
  }
}

function assertNoLocalPaths(value: any, code: any) {
  const text = JSON.stringify(value);
  if (/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|\/dependency-snapshot\/|[A-Za-z]:\\Users\\)/u.test(text)) {
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
  const cargoLicenseIndex = licenseText.split(/\r?\n## Bundled Linux runtime libraries(?:\r?\n|$)/u, 1)[0];
  if (cargoLicenseIndex.split(/\r?\n/u).filter((line) => /^- .+@.+ — /u.test(line)).length !== entry.dependencyPackageCount) {
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
  if (expected.component === "gui") required.push("lib");
  const normalized = names.map((name: any) => name.replace(/\/$/u, ""));
  for (const file of required) {
    if (!normalized.includes(file) && file !== "lib") fail("archive_required_entry_missing");
  }
  if (!normalized.some((name: any) => name === "licenses" || name.startsWith("licenses/"))) fail("archive_license_tree_missing");
  for (const name of normalized) {
    if (rootFiles.has(name) || name === expected.binary || name === "licenses" || name.startsWith("licenses/")) continue;
    if (name === "bin" || name === path.posix.dirname(expected.binary) || (expected.component === "gui" && (name === "lib" || name.startsWith("lib/")))) continue;
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

async function verifyArchive(entry: any, buildEntry: any, expected: any, version: any, readelf: any, tempRoot: any) {
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
  const archivedBinaryStat = await requireRegularFile(archivedBinary, "archive_entrypoint_must_be_raw_elf");
  if ((archivedBinaryStat.mode & 0o111) === 0) fail("archive_entrypoint_not_executable");
  const cmp = await run("cmp", ["-s", buildBinary, archivedBinary]);
  if (cmp.code !== 0) fail("archive_binary_differs_from_build_output");

  const actualElf = await inspectElf(archivedBinary, readelf, expected.arch);
  compareElfMetadata(entry.elf, actualElf, expected, "package_manifest_elf_facts");
  const artifact = JSON.parse(await readFile(path.join(extracted, "artifact.json"), "utf8"));
  if (artifact.schemaVersion !== "meshrix-entry-linux-artifact-1" || artifact.version !== version
    || artifact.component !== expected.component || artifact.arch !== expected.arch
    || artifact.rustTarget !== expected.rustTarget || artifact.binary !== expected.binary
    || artifact.libc !== expected.libc || artifact.buildSource !== buildEntry.buildSource
    || !equalJson(artifact.elf, entry.elf)
    || !equalJson(artifact.runtimePackages, entry.runtimePackages)) fail("artifact_metadata_mismatch");
  assertNoLocalPaths(artifact, "artifact_metadata_contains_local_path");
  const readme = await readFile(path.join(extracted, "README.md"), "utf8");
  if (readme.includes("{{") || !readme.includes(actualElf.machine)
    || !readme.includes(actualElf.highestGlibcRequirement ?? "none")
    || !readme.includes(actualElf.runpath ?? "none")) fail("archive_readme_elf_facts_incomplete");
  assertNoLocalPaths(readme, "archive_readme_contains_local_path");
  await verifyBundleClosure(extracted, entry, expected, readelf);
  return Object.freeze({ entry, archive, extracted, binary: archivedBinary, elf: actualElf });
}

function dockerPlatform(arch: any) {
  return arch === "x86_64" ? "linux/amd64" : "linux/arm64";
}

async function dockerLocalContext() {
  if (process.env.DOCKER_HOST && !/^(?:unix|npipe):\/\//u.test(process.env.DOCKER_HOST)) fail("remote_docker_host_not_allowed");
  const context = (await checked("docker", ["context", "show"], { failureCode: "docker_context_unavailable" })).trim();
  const contextJson = JSON.parse(await checked("docker", ["context", "inspect", context], { failureCode: "docker_context_inspect_failed" }));
  const host = contextJson[0]?.Endpoints?.docker?.Host;
  if (typeof host !== "string" || !/^(?:unix|npipe):\/\//u.test(host)) fail("remote_docker_context_not_allowed");
  const info = (await checked("docker", ["info", "--format", "{{.OSType}}|{{.Architecture}}"], { failureCode: "docker_info_unavailable" })).trim().split("|");
  const daemonArch = /^(?:aarch64|arm64)$/iu.test(info[1]) ? "aarch64"
    : /^(?:x86_64|amd64|x86_64)$/iu.test(info[1]) ? "x86_64" : null;
  if (info[0] !== "linux" || !daemonArch) fail("docker_linux_architecture_unavailable");
  return Object.freeze({ daemonArch, daemonDescription: info[1] });
}

function executionMode(targetArch: any, daemonArch: any) {
  if (targetArch !== daemonArch) return "emulated-container";
  return process.platform === "linux" ? "native-linux-host" : "native-ISA-virtualized-container";
}

function runtimeImage(component: any, arch: any) {
  return component === "cli-tui" ? ALPINE_IMAGES[arch] : MANYLINUX_IMAGES[arch];
}

async function probeContainerArchitecture(image: any, arch: any, component: any) {
  const command = component === "cli-tui" ? "/bin/uname" : "/usr/bin/uname";
  const output = await checked("docker", [
    "run", "--rm", "--pull=never", "--network=none", `--platform=${dockerPlatform(arch)}`,
    "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--entrypoint", command, image, "-m"
  ], { failureCode: "runtime_container_probe_failed" });
  const expected = arch === "x86_64" ? /^(?:x86_64|x86-64)$/iu : /^(?:aarch64|arm64)$/iu;
  if (!expected.test(output.trim())) fail("runtime_container_architecture_mismatch");
}

async function inspectRuntimeImage(image: any, arch: any) {
  const inspect = () => checked("docker", [
    "image", "inspect", "--format", "{{.Os}}|{{.Architecture}}|{{.Id}}", image
  ], { failureCode: "runtime_image_missing" });
  let output;
  try {
    output = (await inspect()).trim();
  } catch (error: any) {
    if (!String(error?.message ?? "").includes("runtime_image_missing")) throw error;
    // Probe images are build-host prerequisites; fetch the pinned reference
    // once instead of failing on a clean Docker daemon. Probe containers
    // still run with --pull=never and no network.
    await checked("docker", ["pull", image], { failureCode: "runtime_image_pull_failed" });
    output = (await inspect()).trim();
  }
  const parts = output.split("|");
  const expected = arch === "x86_64" ? /^(?:amd64|x86_64)$/iu : /^(?:arm64|aarch64)$/iu;
  if (parts[0] !== "linux" || !expected.test(parts[1] ?? "") || !/^sha256:[a-f0-9]{64}$/u.test(parts[2] ?? "")) {
    fail("runtime_image_architecture_mismatch");
  }
  return parts[2];
}

async function runtimeRun(image: any, arch: any, bundleRoot: any, stateRoot: any, binary: any, args: any, env: any = []) {
  const dockerArgs = [
    "run", "--rm", "--pull=never", "--network=none", `--platform=${dockerPlatform(arch)}`,
    "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--workdir", "/qualify",
    "--volume", `${bundleRoot}:/qualify:ro`,
    "--entrypoint", `/qualify/${binary}`
  ];
  if (stateRoot) {
    dockerArgs.push("--volume", `${stateRoot}:/state:rw`);
    for (const [key, value] of [
      ["HOME", "/state/home"],
      ["PATH", "/__no_installed_agents__"],
      ["MESHRIX_ENTRY_DATA_DIR", "/state/data"],
      ["MESHRIX_CUSTODY", "file"],
      ["MESHRIX_CUSTODY_SECRET", SYNTHETIC_CUSTODY_SECRET],
      ...env
    ]) dockerArgs.push("--env", `${key}=${value}`);
  }
  dockerArgs.push(image, ...args);
  const result = await run("docker", dockerArgs);
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

async function writableState(tempRoot: any, name: any) {
  const state = path.join(tempRoot, name);
  await mkdir(path.join(state, "home"), { recursive: true });
  await mkdir(path.join(state, "data"), { recursive: true });
  await chmod(state, 0o777);
  await chmod(path.join(state, "home"), 0o777);
  await chmod(path.join(state, "data"), 0o777);
  return state;
}

// Probe binaries run as nobody (65534) and create state entries only they
// can read. The host-side cleanup cannot traverse those directories, so a
// root cleanup pass inside the same pinned image restores traversal before
// the host removes the scratch tree.
async function resetStatePermissions(image: any, arch: any, stateRoot: any) {
  await checked("docker", [
    "run", "--rm", "--pull=never", "--network=none", `--platform=${dockerPlatform(arch)}`,
    "--read-only", "--user=0:0", "--cap-drop=ALL", "--cap-add=DAC_OVERRIDE", "--cap-add=FOWNER", "--security-opt=no-new-privileges",
    "--volume", `${stateRoot}:/state:rw`,
    "--entrypoint", "/bin/chmod",
    image, "-R", "a+rwX", "/state"
  ], { failureCode: "runtime_state_cleanup_failed" });
}

async function verifyRuntime(probes: any, daemon: any, version: any, tempRoot: any) {
  const modes = new Set();
  for (const probe of probes) {
    const { entry, extracted, binary, elf } = probe;
    const expected: any = EXPECTED.find((item) => item.component === entry.component && item.arch === entry.arch);
    const image = runtimeImage(expected.component, expected.arch);
    const mode = executionMode(expected.arch, daemon.daemonArch);
    modes.add(mode);
    const imageId = await inspectRuntimeImage(image, expected.arch);
    await probeContainerArchitecture(image, expected.arch, expected.component);

    const relativeBinary = path.relative(extracted, binary).split(path.sep).join("/");
    if (expected.component === "cli-tui") {
      const help = await runtimeRun(image, expected.arch, extracted, null, relativeBinary, ["--help"]);
      const cliVersion = await runtimeRun(image, expected.arch, extracted, null, relativeBinary, ["--version"]);
      if (!help.includes("Usage: meshrix-entry") || !cliVersion.includes(`meshrix-entry ${version}`)) {
        fail("cli_metadata_probe_mismatch");
      }
      const profileState = await writableState(tempRoot, `${expected.arch}-profiles-${process.pid}`);
      try {
        const profilesOutput = await runtimeRun(image, expected.arch, extracted, profileState, relativeBinary, ["profiles"]);
        const profiles = parseJsonOutput(profilesOutput, "cli_profiles_output_invalid");
        if (!Array.isArray(profiles.profiles) || profiles.profiles.length !== 0) fail("cli_empty_profiles_probe_failed");
      } finally {
        await resetStatePermissions(image, expected.arch, profileState);
        await rm(profileState, { recursive: true, force: true });
      }
      const cardsState = await writableState(tempRoot, `${expected.arch}-cards-${process.pid}`);
      try {
        const cardsOutput = await runtimeRun(image, expected.arch, extracted, cardsState, relativeBinary, ["agent-cards"]);
        const cards = parseJsonOutput(cardsOutput, "cli_agent_cards_output_invalid");
        if (!Array.isArray(cards.cards)) fail("cli_agent_cards_probe_failed");
      } finally {
        await resetStatePermissions(image, expected.arch, cardsState);
        await rm(cardsState, { recursive: true, force: true });
      }
      process.stdout.write(`PASS ${expected.arch} static CLI/TUI (${mode}, ${imageId}): --help, --version, empty profiles, read-only agent-cards\n`);
    } else {
      if (elf.runpath !== "$ORIGIN/../lib" || elf.runpathKind !== "RUNPATH") fail("gui_origin_runpath_missing");
      const help = await runtimeRun(image, expected.arch, extracted, null, relativeBinary, ["--help"]);
      const version = await runtimeRun(image, expected.arch, extracted, null, relativeBinary, ["--version"]);
      if (!help.includes("Usage: meshrix-entry-gui") || !/meshrix-entry-gui \d+\.\d+\.\d+/u.test(version)) {
        fail("gui_metadata_probe_mismatch");
      }
      process.stdout.write(`PASS ${expected.arch} GNU GUI metadata fast path (${mode}, ${imageId}); display not opened\n`);
      process.stdout.write(`  DT_NEEDED=[${entry.elf.neededLibraries.join(", ")}] GLIBC=${entry.elf.packageHighestGlibcRequirement ?? "none"} RUNPATH=${entry.elf.runpath ?? "none"} bundled=[${entry.elf.bundledLibraries.join(", ")}] host=[${entry.elf.hostLibraries.join(", ")}] dlopen=[${entry.elf.dlopenCandidates.join(", ")}]\n`);
    }
  }
  return sortUnique([...modes]);
}

async function main() {
  if (!new Set(["darwin", "linux"]).has(process.platform)) fail("linux_artifact_profile_host_not_supported");
  const nativeCargo = await readFile(path.join(NATIVE_ROOT, "Cargo.toml"), "utf8");
  const version = workspaceVersion(nativeCargo);
  requireLinuxDisplayFeatures(nativeCargo);
  const buildManifest = JSON.parse(await readFile(BUILD_MANIFEST, "utf8"));
  const buildEntries = await validateBuildManifest(buildManifest);
  const packageManifest = JSON.parse(await readFile(PACKAGE_MANIFEST, "utf8"));
  if (!packageManifest || packageManifest.schemaVersion !== 1 || packageManifest.version !== version
    || !Array.isArray(packageManifest.artifacts) || packageManifest.artifacts.length !== EXPECTED.length) {
    fail("package_manifest_invalid");
  }
  assertNoLocalPaths(packageManifest, "package_manifest_contains_local_path");
  const readelf = await findReadelf();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "meshrix-linux-artifact-check-"));
  try {
    const probes: any[] = [];
    for (const expected of EXPECTED) {
      const buildEntry = buildEntries.get(`${expected.component}\0${expected.arch}`);
      const entries = packageManifest.artifacts.filter((entry: any) => entry?.component === expected.component && entry?.arch === expected.arch);
      if (entries.length !== 1) fail("package_manifest_target_missing_or_duplicate");
      probes.push(await verifyArchive(entries[0], buildEntry, expected, version, readelf, tempRoot));
    }
    const daemon = await dockerLocalContext();
    const modes = await verifyRuntime(probes, daemon, version, tempRoot);
    process.stdout.write(`PASS four Linux client archives; native workspace version ${version}; runtime architecture ${daemon.daemonDescription}; execution modes ${modes.join(", ")}\n`);
    process.stdout.write("Qualification used isolated local containers with networking disabled; no Agent process, conversation, display or user data was accessed.\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "native_linux_artifact_check_failed";
  process.stderr.write(`${message.replace(/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/)[^\s]+/gu, "<path>")}\n`);
  process.exitCode = 1;
});
