#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = path.resolve(SCRIPT_DIR, "..");
const REPOSITORY_DIR = path.resolve(WORKSPACE_DIR, "../..");
const CARGO_MANIFEST = path.join(WORKSPACE_DIR, "Cargo.toml");
const README_TEMPLATE = path.join(WORKSPACE_DIR, "packaging", "linux", "README.md");
const FONT_LICENSE = path.join(WORKSPACE_DIR, "crates", "entry-gui", "assets", "fonts", "INTER-LICENSE.txt");
const SYSTEM_LICENSE_DIR = path.join(WORKSPACE_DIR, "packaging", "linux", "system-licenses");
const ROOT_LICENSE = path.join(REPOSITORY_DIR, "LICENSE");
const PACKAGE_MANIFEST_SCHEMA = 1;

const EXPECTED_ARTIFACTS = Object.freeze([
  Object.freeze({
    component: "cli-tui",
    arch: "x86_64",
    rustTarget: "x86_64-unknown-linux-musl",
    binaryPath: "bin/x86_64/meshrix-entry",
    libc: "musl",
    archiveProduct: "meshrix-entry",
    archiveBinary: "bin/meshrix-entry"
  }),
  Object.freeze({
    component: "cli-tui",
    arch: "aarch64",
    rustTarget: "aarch64-unknown-linux-musl",
    binaryPath: "bin/aarch64/meshrix-entry",
    libc: "musl",
    archiveProduct: "meshrix-entry",
    archiveBinary: "bin/meshrix-entry"
  }),
  Object.freeze({
    component: "gui",
    arch: "x86_64",
    rustTarget: "x86_64-unknown-linux-gnu",
    binaryPath: "bin/x86_64/meshrix-entry-gui",
    libc: "gnu",
    archiveProduct: "meshrix-entry-gui",
    archiveBinary: "bin/meshrix-entry-gui"
  }),
  Object.freeze({
    component: "gui",
    arch: "aarch64",
    rustTarget: "aarch64-unknown-linux-gnu",
    binaryPath: "bin/aarch64/meshrix-entry-gui",
    libc: "gnu",
    archiveProduct: "meshrix-entry-gui",
    archiveBinary: "bin/meshrix-entry-gui"
  })
]);

const LICENSE_FILE_NAME = /^(?:license|copying|notice|copyright)(?:[._-].*)?$/iu;
const RELATED_LICENSE_PACKAGES = Object.freeze({
  "libX11": Object.freeze(["libX11-common"]),
  "libX11-xcb": Object.freeze(["libX11-common"]),
  "libxkbcommon-x11": Object.freeze(["libxkbcommon"])
});
const RUNTIME_LICENSE_OVERRIDES = Object.freeze({
  "libxcb@1.13.1-1.el8": Object.freeze({
    name: "libxcb source",
    version: "1.13.1-2",
    license: "MIT",
    sourceUrl: "https://sources.debian.org/data/main/libx/libxcb/1.13.1-2/COPYING",
    files: Object.freeze([
      Object.freeze({ source: "libxcb-1.13.1.COPYING", name: "01-COPYING" }),
      Object.freeze({ source: "libxcb-1.13.1.SOURCE.md", name: "02-SOURCE.md" })
    ])
  })
});
const HOST_RUNTIME_LIBRARY = /^(?:ld-(?:linux|musl)[^/]*|libc\.so(?:\..*)?|libm\.so(?:\..*)?|libpthread\.so(?:\..*)?|libdl\.so(?:\..*)?|librt\.so(?:\..*)?|libanl\.so(?:\..*)?|libBrokenLocale\.so(?:\..*)?|libnss_[^/]+\.so(?:\..*)?|libthread_db\.so(?:\..*)?|libSegFault\.so(?:\..*)?|libmemusage\.so(?:\..*)?|libpcprofile\.so(?:\..*)?|libresolv\.so(?:\..*)?|libutil\.so(?:\..*)?|libcrypt\.so(?:\..*)?|libEGL(?:_[A-Za-z0-9_-]+)?\.so(?:\..*)?|libGL(?:X(?:_[A-Za-z0-9_-]+)?|dispatch)?\.so(?:\..*)?|libOpenGL\.so(?:\..*)?|libvulkan(?:_[A-Za-z0-9_-]+)?\.so(?:\..*)?|libdrm(?:_[A-Za-z0-9_-]+)?\.so(?:\..*)?|libgbm\.so(?:\..*)?|libnvidia[^/]*\.so(?:\..*)?|libcuda\.so(?:\..*)?|libnvoptix\.so(?:\..*)?|libOpenCL\.so(?:\..*)?)$/iu;
const BUNDLED_LIBRARY_RUNPATH = "$ORIGIN";

function usage() {
  return [
    "Usage:",
    "  node apps/entry-native/tools/package-linux.mjs --input-dir <build-output> --output-dir <archive-output>",
    "",
    "The input directory must contain build-manifest.json from build-linux.mjs.",
    "Packaging requires readelf or llvm-readelf on PATH and Docker access to the declared local builder image.",
    "Set MESHRIX_READELF to select a nonstandard ELF reader."
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

async function selectReadelf() {
  const candidates = process.env.MESHRIX_READELF
    ? [process.env.MESHRIX_READELF]
    : ["readelf", "llvm-readelf"];
  for (const candidate of candidates) {
    try {
      await run(candidate, ["--version"], WORKSPACE_DIR);
      return candidate;
    } catch {
      // Try the next standard ELF inspection tool.
    }
  }
  throw new Error("readelf_or_llvm_readelf_required_for_linux_packaging");
}

function compareNumericVersions(left, right) {
  const leftParts = left.split("_").at(-1).split(".").map(Number);
  const rightParts = right.split("_").at(-1).split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function inspectElf(binaryPath, expectedArch, readelf) {
  const { stdout } = await run(readelf, [
    "--wide",
    "--file-header",
    "--program-headers",
    "--dynamic",
    "--version-info",
    binaryPath
  ], WORKSPACE_DIR);
  const elfClass = stdout.match(/^\s*Class:\s*(ELF\d+)\s*$/mu)?.[1] ?? null;
  const machineLine = stdout.match(/^\s*Machine:\s*(.+?)\s*$/mu)?.[1] ?? null;
  if (!elfClass || !machineLine) throw new Error("elf_header_facts_missing");
  const machine = /aarch64/iu.test(machineLine)
    ? "aarch64"
    : /x86-64|x86_64/iu.test(machineLine)
      ? "x86_64"
      : machineLine;
  if (machine !== expectedArch) throw new Error(`elf_architecture_mismatch:${expectedArch}`);

  const interpreter = stdout.match(/Requesting program interpreter:\s*([^\]\r\n]+)/u)?.[1]?.trim() ?? null;
  const neededLibraries = [...new Set([...stdout.matchAll(/Shared library:\s*\[([^\]]+)\]/gu)].map((match) => match[1]))]
    .sort((left, right) => left.localeCompare(right));
  const versionedRequirements = [...new Set([...stdout.matchAll(/\b((?:GLIBC|GLIBCXX|CXXABI|GCC)_\d+(?:\.\d+)+)\b/gu)].map((match) => match[1]))]
    .sort((left, right) => left.split("_")[0].localeCompare(right.split("_")[0]) || compareNumericVersions(left, right));
  const glibcRequirements = versionedRequirements.filter((version) => version.startsWith("GLIBC_"));
  const runpath = stdout.match(/Library runpath:\s*\[([^\]]*)\]/u)?.[1]
    ?? stdout.match(/Library rpath:\s*\[([^\]]*)\]/u)?.[1]
    ?? null;
  return Object.freeze({
    class: elfClass,
    machine,
    interpreter,
    neededLibraries: Object.freeze(neededLibraries),
    versionedRequirements: Object.freeze(versionedRequirements),
    highestGlibcRequirement: glibcRequirements.at(-1) ?? null,
    runpath
  });
}

function sourceDlopenCandidates(metadata, component) {
  if (component !== "gui") return Object.freeze([]);
  if (!metadata?.resolve?.nodes) throw new Error("target_cargo_feature_graph_missing");
  const packageNames = new Map((metadata.packages ?? []).map((pkg) => [pkg.id, pkg.name]));
  const featuresByPackage = new Map();
  for (const node of metadata.resolve?.nodes ?? []) {
    const name = packageNames.get(node.id);
    if (!name) continue;
    const features = featuresByPackage.get(name) ?? new Set();
    for (const feature of node.features ?? []) features.add(feature);
    featuresByPackage.set(name, features);
  }

  const candidates = new Set();
  if (featuresByPackage.has("glutin")) {
    candidates.add("libEGL.so.1");
    candidates.add("libGL.so.1");
  }
  if (featuresByPackage.get("glutin")?.has("glx")) candidates.add("libXrender.so.1");
  if (featuresByPackage.get("wayland-sys")?.has("dlopen")) {
    candidates.add("libwayland-client.so.0");
    candidates.add("libwayland-cursor.so.0");
    candidates.add("libwayland-egl.so.1");
  }
  if (featuresByPackage.has("xkbcommon-dl")) {
    candidates.add("libxkbcommon.so.0");
    if (featuresByPackage.get("xkbcommon-dl")?.has("x11")) candidates.add("libxkbcommon-x11.so.0");
  }
  if (featuresByPackage.get("winit")?.has("x11")) {
    candidates.add("libX11.so.6");
    candidates.add("libXcursor.so.1");
    candidates.add("libXi.so.6");
    candidates.add("libX11-xcb.so.1");
  }
  return Object.freeze([...candidates].sort((left, right) => left.localeCompare(right)));
}

function safeSoname(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+_.-]+\.so(?:\.[A-Za-z0-9+_.-]+)*$/u.test(value)) {
    throw new Error("elf_soname_invalid");
  }
  return value;
}

function sysrootLibraryDirectories(sysroot) {
  return ["usr/lib64", "lib64", "usr/lib", "lib"]
    .map((directory) => path.posix.join(sysroot, directory))
    .filter((directory, index, all) => all.indexOf(directory) === index);
}

async function startBuilderContainer(builder) {
  const { stdout } = await run("docker", [
    "run", "--detach", "--pull=never", "--platform", builder.platform,
    "--entrypoint", "/bin/sh", builder.image,
    "-c", "sleep infinity"
  ], WORKSPACE_DIR);
  const id = stdout.trim();
  if (!/^[a-f0-9]{12,64}$/iu.test(id)) throw new Error("builder_runtime_container_id_invalid");
  return id;
}

async function removeBuilderContainer(containerId) {
  if (!containerId) return;
  await run("docker", ["rm", "--force", containerId], WORKSPACE_DIR).catch(() => {});
}

async function copyFromBuilder(containerId, sourcePath, destinationPath) {
  await run("docker", ["cp", "--follow-link", `${containerId}:${sourcePath}`, destinationPath], WORKSPACE_DIR);
}

async function locateSystemLibrary(containerId, sysroot, soname, destinationPath) {
  for (const directory of sysrootLibraryDirectories(sysroot)) {
    const sourcePath = path.posix.join(directory, safeSoname(soname));
    try {
      await copyFromBuilder(containerId, sourcePath, destinationPath);
      const fileStat = await lstat(destinationPath).catch(() => null);
      if (fileStat?.isFile() && !fileStat.isSymbolicLink()) return sourcePath;
    } catch {
      // Continue through the target sysroot's standard library directories.
    }
  }
  return null;
}

function systemPackagePath(sysroot, sourcePath) {
  if (sysroot === "/") return sourcePath;
  const relative = path.posix.relative(sysroot, sourcePath);
  if (relative.startsWith("..") || path.posix.isAbsolute(relative)) throw new Error("runtime_library_outside_sysroot");
  return `/${relative}`;
}

function parseRuntimePackageMetadata(stdout) {
  const [name, version, license] = stdout.trim().split("|");
  if (!name || !version || !license) return null;
  return Object.freeze({
    name: safeToken(name, "runtime_package_name"),
    version: safeToken(version, "runtime_package_version"),
    license: license.replace(/\s+/gu, " ").trim()
  });
}

async function runtimePackageMetadata(containerId, sysroot, sourcePath) {
  const packagePath = systemPackagePath(sysroot, sourcePath);
  let result;
  try {
    result = await run("docker", [
      "exec", containerId, "rpm", `--root=${sysroot}`, "-qf",
      "--qf", "%{NAME}|%{VERSION}-%{RELEASE}|%{LICENSE}\\n",
      packagePath
    ], WORKSPACE_DIR);
  } catch {
    return null;
  }
  return parseRuntimePackageMetadata(result.stdout);
}

async function runtimePackageMetadataByName(containerId, sysroot, packageName) {
  let result;
  try {
    result = await run("docker", [
      "exec", containerId, "rpm", `--root=${sysroot}`, "-q",
      "--qf", "%{NAME}|%{VERSION}-%{RELEASE}|%{LICENSE}\\n",
      safeToken(packageName, "runtime_package_name")
    ], WORKSPACE_DIR);
  } catch {
    return null;
  }
  return parseRuntimePackageMetadata(result.stdout);
}

function listedPackagePath(sysroot, listedPath) {
  if (!path.posix.isAbsolute(listedPath) || listedPath.split("/").includes("..")) return null;
  if (sysroot === "/" || listedPath === sysroot || listedPath.startsWith(`${sysroot}/`)) return listedPath;
  return path.posix.join(sysroot, listedPath.replace(/^\/+/, ""));
}

async function runtimeLicensePaths(containerId, sysroot, packageName) {
  let result;
  try {
    result = await run("docker", ["exec", containerId, "rpm", `--root=${sysroot}`, "-ql", packageName], WORKSPACE_DIR);
  } catch {
    return [];
  }
  const candidates = [...new Set(result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((value) => {
    const basename = path.posix.basename(value);
    return value.includes("/share/licenses/") || LICENSE_FILE_NAME.test(basename);
  }))].sort((left, right) => left.localeCompare(right));
  const files = [];
  for (const candidate of candidates) {
    const sourcePath = listedPackagePath(sysroot, candidate);
    if (!sourcePath) continue;
    try {
      await run("docker", ["exec", containerId, "test", "-f", sourcePath], WORKSPACE_DIR);
      files.push(sourcePath);
    } catch {
      // RPM package listings include directories; only include license files.
    }
  }
  return files;
}

async function copyRuntimeLicensePackage(containerId, sysroot, sourcePath, scratchDir, packageCache) {
  const metadata = await runtimePackageMetadata(containerId, sysroot, sourcePath);
  if (!metadata) return null;
  const cacheKey = `${metadata.name}@${metadata.version}`;
  if (packageCache.has(cacheKey)) return packageCache.get(cacheKey);
  const licenseSources = [];
  const licenseFiles = [];
  let bundleable = !/\b(?:proprietary|non[- ]free|unfree|commercial|restricted)\b/iu.test(metadata.license);
  const licensePackageNames = [metadata.name, ...(RELATED_LICENSE_PACKAGES[metadata.name] ?? [])];
  for (const licensePackageName of licensePackageNames) {
    if (!bundleable) break;
    const sourcePackage = licensePackageName === metadata.name
      ? metadata
      : await runtimePackageMetadataByName(containerId, sysroot, licensePackageName);
    if (!sourcePackage || sourcePackage.license !== metadata.license) continue;
    const licensePaths = await runtimeLicensePaths(containerId, sysroot, sourcePackage.name);
    if (licensePaths.length === 0) continue;

    const sourceFiles = [];
    for (const [index, licensePath] of licensePaths.entries()) {
      const fileName = `${String(index + 1).padStart(2, "0")}-${path.posix.basename(licensePath)}`;
      const packageDirName = `${sourcePackage.name}-${sourcePackage.version}`;
      const relativePath = path.posix.join("licenses", "system", packageDirName, fileName);
      const destination = path.join(scratchDir, ...relativePath.split("/"));
      try {
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFromBuilder(containerId, licensePath, destination);
        const fileStat = await lstat(destination);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("runtime_license_file_invalid");
        sourceFiles.push(Object.freeze({
          sourcePath: destination,
          relativePath,
          sourcePackage: `${sourcePackage.name}@${sourcePackage.version}`
        }));
      } catch {
        bundleable = false;
        sourceFiles.length = 0;
        break;
      }
    }
    if (!bundleable) break;
    if (sourceFiles.length > 0) {
      licenseSources.push(Object.freeze({
        name: sourcePackage.name,
        version: sourcePackage.version,
        license: sourcePackage.license
      }));
      licenseFiles.push(...sourceFiles);
      break;
    }
  }

  if (bundleable && licenseFiles.length === 0) {
    const override = RUNTIME_LICENSE_OVERRIDES[cacheKey];
    if (override && metadata.license === override.license) {
      const sourceFiles = [];
      try {
        for (const file of override.files) {
          const sourcePath = path.join(SYSTEM_LICENSE_DIR, file.source);
          const sourceStat = await lstat(sourcePath);
          if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("runtime_source_license_invalid");
          const relativePath = path.posix.join("licenses", "system", `${metadata.name}-${metadata.version}`, file.name);
          const destination = path.join(scratchDir, ...relativePath.split("/"));
          await mkdir(path.dirname(destination), { recursive: true });
          await cp(sourcePath, destination);
          sourceFiles.push(Object.freeze({
            sourcePath: destination,
            relativePath,
            sourcePackage: `${override.name}@${override.version}`
          }));
        }
        if (sourceFiles.length > 0) {
          licenseSources.push(Object.freeze({
            name: override.name,
            version: override.version,
            license: override.license,
            sourceUrl: override.sourceUrl,
            sourceNotice: sourceFiles.find((file) => file.relativePath.endsWith("02-SOURCE.md"))?.relativePath ?? null
          }));
          licenseFiles.push(...sourceFiles);
        }
      } catch {
        bundleable = false;
        licenseSources.length = 0;
        licenseFiles.length = 0;
      }
    }
  }

  bundleable = bundleable && licenseFiles.length > 0;
  if (!bundleable) {
    licenseSources.length = 0;
    licenseFiles.length = 0;
  }
  const result = Object.freeze({
    name: metadata.name,
    version: metadata.version,
    license: metadata.license,
    bundleable,
    licenseSources: Object.freeze(licenseSources),
    licenseFiles: Object.freeze(licenseFiles)
  });
  packageCache.set(cacheKey, result);
  return result;
}

async function patchBundledLibrary(containerId, patcherPath, sourceSystemPath, containerPath, destinationPath, expectedArch, readelf) {
  await run("docker", ["exec", "--user", "0", containerId, "cp", "-L", sourceSystemPath, containerPath], WORKSPACE_DIR);
  await run("docker", ["exec", "--user", "0", containerId, patcherPath, "--set-rpath", BUNDLED_LIBRARY_RUNPATH, containerPath], WORKSPACE_DIR);
  await run("docker", ["cp", `${containerId}:${containerPath}`, destinationPath], WORKSPACE_DIR);
  const elf = await inspectElf(destinationPath, expectedArch, readelf);
  if (!elf.runpath?.split(":").includes(BUNDLED_LIBRARY_RUNPATH)) {
    throw new Error("bundled_library_origin_runpath_missing");
  }
  return elf;
}

async function collectRuntimeDependencies(artifact, builder, readelf, containerState, tempRoot) {
  const scratchDir = path.join(tempRoot, `runtime-${artifact.arch}`);
  const bundled = new Set();
  const host = new Set();
  const hostLibraryFacts = new Map();
  const bundledFiles = [];
  const bundledFilePaths = new Set();
  const addBundledFile = (file) => {
    if (bundledFilePaths.has(file.relativePath)) return;
    bundledFilePaths.add(file.relativePath);
    bundledFiles.push(file);
  };
  const bundledFacts = [];
  const packageCache = new Map();
  const runtimePackages = new Map();
  const bundledVersionedRequirements = new Set();
  const binaryElf = artifact.elf;

  if (artifact.component !== "gui") {
    for (const soname of binaryElf.neededLibraries) host.add(safeSoname(soname));
    return Object.freeze({
      elf: Object.freeze({
        ...binaryElf,
        bundledLibraries: Object.freeze([]),
        hostLibraries: Object.freeze([...host].sort((left, right) => left.localeCompare(right))),
        hostLibraryFacts: Object.freeze([]),
        bundledVersionedRequirements: Object.freeze([]),
        packageHighestGlibcRequirement: binaryElf.highestGlibcRequirement,
        hostDisplay: null,
        hostGpu: null,
        bundledLibraryFacts: Object.freeze([])
      }),
      files: Object.freeze([]),
      packages: Object.freeze([])
    });
  }

  await mkdir(path.join(scratchDir, "lib"), { recursive: true });
  const pending = [...new Set([...binaryElf.neededLibraries, ...binaryElf.dlopenCandidates])];
  const visited = new Set();
  let patchIndex = 0;
  const sysroot = builder.sysroots[artifact.arch];

  while (pending.length > 0) {
    const soname = safeSoname(pending.shift());
    if (visited.has(soname)) continue;
    visited.add(soname);
    if (HOST_RUNTIME_LIBRARY.test(soname)) {
      host.add(soname);
      continue;
    }

    if (!containerState.id) containerState.id = await startBuilderContainer(builder);
    const containerId = containerState.id;
    const localSource = path.join(scratchDir, "lib", soname);
    const systemSource = await locateSystemLibrary(containerId, sysroot, soname, localSource);
    if (!systemSource) {
      host.add(soname);
      continue;
    }

    const systemElf = await inspectElf(localSource, artifact.arch, readelf);
    const runtimePackage = await copyRuntimeLicensePackage(
      containerId,
      sysroot,
      systemSource,
      scratchDir,
      packageCache
    );
    if (!runtimePackage?.bundleable) {
      host.add(soname);
      if (runtimePackage) {
        hostLibraryFacts.set(soname, Object.freeze({
          soname,
          packageName: runtimePackage.name,
          packageVersion: runtimePackage.version,
          license: runtimePackage.license
        }));
      }
      for (const dependency of systemElf.neededLibraries) pending.push(dependency);
      continue;
    }

    patchIndex += 1;
    const patchedPath = path.join(scratchDir, "lib", `${soname}.patched-${patchIndex}`);
    const containerPatchPath = `/tmp/meshrix-runtime-${artifact.arch}-${patchIndex}-${soname}`;
    const patchedElf = await patchBundledLibrary(
      containerId,
      builder.patchelf,
      systemSource,
      containerPatchPath,
      patchedPath,
      artifact.arch,
      readelf
    );
    await rename(patchedPath, localSource);
    bundled.add(soname);
    addBundledFile(Object.freeze({ sourcePath: localSource, relativePath: `lib/${soname}` }));
    const packageKey = `${runtimePackage.name}@${runtimePackage.version}`;
    if (!runtimePackages.has(packageKey)) {
      runtimePackages.set(packageKey, runtimePackage);
      for (const license of runtimePackage.licenseFiles) addBundledFile(license);
    }
    for (const dependency of patchedElf.neededLibraries) pending.push(dependency);
    for (const version of patchedElf.versionedRequirements) {
      if (version.startsWith("GLIBC_")) bundledVersionedRequirements.add(version);
    }
    bundledFacts.push(Object.freeze({
      soname,
      path: `lib/${soname}`,
      class: patchedElf.class,
      machine: patchedElf.machine,
      interpreter: patchedElf.interpreter,
      neededLibraries: patchedElf.neededLibraries,
      versionedRequirements: patchedElf.versionedRequirements,
      highestGlibcRequirement: patchedElf.highestGlibcRequirement,
      runpath: patchedElf.runpath,
      licensePackage: `${runtimePackage.name}@${runtimePackage.version}`,
      licenseSources: runtimePackage.licenseSources
    }));
  }

  const allGlibcRequirements = [
    binaryElf.highestGlibcRequirement,
    ...bundledFacts.map((fact) => fact.highestGlibcRequirement)
  ].filter(Boolean);
  allGlibcRequirements.sort(compareNumericVersions);
  return Object.freeze({
    elf: Object.freeze({
      ...binaryElf,
      bundledLibraries: Object.freeze([...bundled].sort((left, right) => left.localeCompare(right))),
      hostLibraries: Object.freeze([...host].sort((left, right) => left.localeCompare(right))),
      hostLibraryFacts: Object.freeze([...hostLibraryFacts.values()].sort((left, right) => left.soname.localeCompare(right.soname))),
      bundledVersionedRequirements: Object.freeze([...bundledVersionedRequirements].sort(compareNumericVersions)),
      packageHighestGlibcRequirement: allGlibcRequirements.at(-1) ?? null,
      hostDisplay: "An X11 server or Wayland compositor and display-session sockets are provided by the host.",
      hostGpu: "Kernel graphics support and compatible vendor GPU drivers remain host-provided; driver libraries are not bundled.",
      bundledLibraryFacts: Object.freeze(bundledFacts)
    }),
    files: Object.freeze(bundledFiles),
    packages: Object.freeze([...runtimePackages.values()].sort((left, right) => left.name.localeCompare(right.name)))
  });
}

async function readJson(filePath, errorCode) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error(errorCode);
  }
}

function validateBuildManifest(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.artifacts)) {
    throw new Error("build_manifest_shape_invalid");
  }
  const builder = value.builder;
  if (!builder
    || typeof builder.image !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(builder.image)
    || !/^linux\/(?:arm64|amd64)$/u.test(builder.platform)
    || typeof builder.readelf !== "string"
    || !path.posix.isAbsolute(builder.readelf)
    || typeof builder.patchelf !== "string"
    || !path.posix.isAbsolute(builder.patchelf)
    || !builder.sysroots
    || typeof builder.sysroots !== "object") {
    throw new Error("build_manifest_builder_metadata_invalid");
  }
  const sysroots = {};
  for (const arch of ["x86_64", "aarch64"]) {
    const sysroot = builder.sysroots[arch];
    if (typeof sysroot !== "string" || !path.posix.isAbsolute(sysroot) || sysroot.split("/").includes("..")) {
      throw new Error("build_manifest_sysroot_path_invalid");
    }
    sysroots[arch] = sysroot;
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
    if (buildSource !== "current-local-development-sources") {
      throw new Error("build_manifest_source_qualification_unexpected");
    }
    seen.add(key);
    binaries.add(artifact.binary);
    validated.push(Object.freeze({ ...expectedEntry, binary: artifact.binary, buildSource }));
  }
  if (seen.size !== EXPECTED_ARTIFACTS.length) throw new Error("build_manifest_target_missing");
  return Object.freeze({
    artifacts: Object.freeze(validated),
    builder: Object.freeze({
      image: builder.image,
      platform: builder.platform,
      readelf: builder.readelf,
      patchelf: builder.patchelf,
      sysroots: Object.freeze(sysroots)
    })
  });
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
    "--offline",
    "--filter-platform", target,
    "--manifest-path", "Cargo.toml"
  ], WORKSPACE_DIR);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("cargo_metadata_json_invalid");
  }
}

async function cargoMetadata() {
  const targets = [
    "x86_64-unknown-linux-musl",
    "aarch64-unknown-linux-musl",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu"
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

async function collectCargoLicenseInventory(metadata) {
  const workspaceMembers = new Set(metadata.workspace_members ?? []);
  const dependencyPackages = metadata.packages
    .filter((item) => !workspaceMembers.has(item.id))
    .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
  const indexLines = [
    "# Cargo dependency license inventory",
    "",
    "License texts are copied from the package sources resolved by Cargo metadata.",
    "The inventory may include target-conditional crates that are not linked by this artifact.",
    ""
  ];
  const files = [];
  let copied = 0;
  let packagesWithoutLicenseFile = 0;

  for (const dependency of dependencyPackages) {
    const manifestPath = dependency.manifest_path;
    if (typeof manifestPath !== "string") throw new Error("cargo_package_manifest_missing");
    const packageDir = await realpath(path.dirname(manifestPath)).catch(() => null);
    if (!packageDir) throw new Error(`cargo_license_directory_unavailable:${safeToken(dependency.name, "package_name")}`);
    const candidatePaths = new Map();
    if (typeof dependency.license_file === "string" && dependency.license_file.length > 0) {
      if (path.isAbsolute(dependency.license_file)) throw new Error("cargo_license_path_must_be_package_relative");
      const declaredPath = path.resolve(packageDir, dependency.license_file);
      if (!isWithin(packageDir, declaredPath)) throw new Error("cargo_license_path_outside_package");
      candidatePaths.set(declaredPath, { root: packageDir, name: path.basename(declaredPath) });
    }
    let entries = [];
    try {
      entries = await readdir(packageDir, { withFileTypes: true });
    } catch {
      throw new Error(`cargo_license_directory_unavailable:${safeToken(dependency.name, "package_name")}`);
    }
    for (const entry of entries) {
      if (entry.isFile() && LICENSE_FILE_NAME.test(entry.name)) {
        candidatePaths.set(path.join(packageDir, entry.name), { root: packageDir, name: entry.name });
      }
    }

    // These dependencies keep their original notices outside the crate root.
    // Use only their known source layout, never an arbitrary ancestor search.
    if (dependency.name === "epaint_default_fonts") {
      for (const name of ["Hack-Regular.txt", "emoji-icon-font-mit-license.txt", "OFL.txt", "UFL.txt"]) {
        candidatePaths.set(path.join(packageDir, "fonts", name), {
          root: packageDir,
          name: `fonts/${name}`
        });
      }
    }
    const a4aaWorkspaceCrate = dependency.source == null && dependency.name.startsWith("a4aa-");
    const signalWorkspaceCrate = dependency.source?.startsWith("git+https://github.com/signalapp/libsignal.git")
      && ["libsignal-core", "libsignal-debug", "libsignal-protocol", "signal-crypto"].includes(dependency.name);
    if (a4aaWorkspaceCrate || signalWorkspaceCrate) {
      const workspaceRoot = await realpath(path.resolve(packageDir, "../.."));
      const workspaceManifest = await readFile(path.join(workspaceRoot, "Cargo.toml"), "utf8");
      if (!/^\[workspace\]\s*$/mu.test(workspaceManifest)) throw new Error("dependency_license_workspace_missing");
      candidatePaths.set(path.join(workspaceRoot, "LICENSE"), {
        root: workspaceRoot,
        name: "workspace-LICENSE"
      });
    }

    const copiedPaths = [];
    const dependencyDirName = `${safeToken(dependency.name, "package_name")}-${safeToken(dependency.version, "package_version")}`;
    for (const [sourcePath, source] of candidatePaths) {
      const sourceRealPath = await realpath(sourcePath).catch(() => null);
      if (!sourceRealPath || !isWithin(source.root, sourceRealPath)) throw new Error("cargo_license_source_missing_or_outside_root");
      const sourceStat = await lstat(sourcePath).catch(() => null);
      if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) throw new Error("cargo_license_source_not_regular");
      const relativePath = path.posix.join("licenses", "cargo", dependencyDirName, source.name);
      files.push(Object.freeze({ sourcePath: sourceRealPath, relativePath }));
      copiedPaths.push(relativePath);
      copied += 1;
    }

    const declaredLicense = typeof dependency.license === "string" && dependency.license.length > 0
      ? dependency.license.replace(/\s+/gu, " ").trim()
      : "license-file declaration";
    indexLines.push(`- ${dependency.name}@${dependency.version} — ${declaredLicense}`);
    if (copiedPaths.length > 0) {
      for (const licensePath of copiedPaths) indexLines.push(`  - ${licensePath}`);
    } else {
      packagesWithoutLicenseFile += 1;
      indexLines.push("  - No standalone license file was present in the Cargo package source.");
    }
  }

  return Object.freeze({
    dependencyPackages: dependencyPackages.length,
    copiedLicenseFiles: copied,
    packagesWithoutLicenseFile,
    files: Object.freeze(files),
    indexLines: Object.freeze(indexLines)
  });
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
    "{{elfMachine}}": artifact.elf.machine,
    "{{elfClass}}": artifact.elf.class,
    "{{elfInterpreter}}": artifact.elf.interpreter ?? "none",
    "{{elfNeededLibraries}}": artifact.elf.neededLibraries.join(", ") || "none",
    "{{elfDlopenCandidates}}": artifact.elf.dlopenCandidates.join(", ") || "none",
    "{{elfBundledLibraries}}": artifact.elf.bundledLibraries.join(", ") || "none",
    "{{elfHostLibraries}}": artifact.elf.hostLibraries.join(", ") || "none",
    "{{elfVersionedRequirements}}": artifact.elf.versionedRequirements.join(", ") || "none",
    "{{elfHighestGlibcRequirement}}": artifact.elf.highestGlibcRequirement ?? "none",
    "{{elfPackageGlibcRequirement}}": artifact.elf.packageHighestGlibcRequirement ?? "none",
    "{{hostDisplay}}": artifact.elf.hostDisplay ?? "none",
    "{{hostGpu}}": artifact.elf.hostGpu ?? "none",
    "{{elfRunpath}}": artifact.elf.runpath ?? "none"
  };
  let result = template;
  for (const [key, value] of Object.entries(substitutions)) result = result.replaceAll(key, value);
  if (/\{\{[^}]+\}\}/u.test(result)) throw new Error("linux_package_readme_template_unresolved");
  return result;
}

function packageArtifactMetadata(artifact, version) {
  return Object.freeze({
    schemaVersion: "meshrix-entry-linux-artifact-1",
    version,
    component: artifact.component,
    arch: artifact.arch,
    rustTarget: artifact.rustTarget,
    binary: artifact.archiveBinary,
    libc: artifact.libc,
    buildSource: artifact.buildSource,
    elf: artifact.elf,
    runtimePackages: (artifact.runtimePackages ?? []).map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      licenseSources: pkg.licenseSources,
      licenseFiles: pkg.licenseFiles.map((file) => ({
        path: file.relativePath,
        sourcePackage: file.sourcePackage
      }))
    }))
  });
}

async function stageArtifact(artifact, version, binaryPath, readmeTemplate, licenseInventory, runtimeInventory, tempRoot) {
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
  for (const runtimeFile of runtimeInventory.files) {
    const destination = path.join(stagingDir, ...runtimeFile.relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(runtimeFile.sourcePath, destination);
    if (runtimeFile.relativePath.startsWith("lib/")) await chmod(destination, 0o755);
  }
  if (runtimeInventory.packages.length > 0) {
    indexLines.push("", "## Bundled Linux runtime libraries");
    for (const runtimePackage of runtimeInventory.packages) {
      indexLines.push(``, `- ${runtimePackage.name}@${runtimePackage.version} — ${runtimePackage.license || "license-file declaration"}`);
      for (const source of runtimePackage.licenseSources) {
        const sourceReference = source.sourceUrl ? `; source: ${source.sourceUrl}` : "";
        const sourceNotice = source.sourceNotice ? `; see \`${source.sourceNotice}\`` : "";
        indexLines.push(`  - License text source: ${source.name}@${source.version} (${source.license})${sourceReference}${sourceNotice}`);
      }
      for (const license of runtimePackage.licenseFiles) {
        indexLines.push(`  - ${license.relativePath} (from ${license.sourcePackage})`);
      }
    }
  }
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
  return `${artifact.archiveProduct}-${version}-linux-${artifact.arch}-${artifact.libc}.tar.gz`;
}

async function createArchive(stagingDir, destination, binaryPath) {
  const entries = [
    path.posix.dirname(binaryPath),
    "README.md",
    "LICENSE",
    "artifact.json",
    "THIRD_PARTY_LICENSES.md",
    "licenses"
  ];
  if (await lstat(path.join(stagingDir, "lib")).then((result) => result.isDirectory()).catch(() => false)) {
    entries.push("lib");
  }
  const output = await run("tar", [
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--no-xattrs",
    "-czf", destination,
    "-C", stagingDir,
    ...entries
  ], stagingDir, { ...process.env, COPYFILE_DISABLE: "1" });
  if (output.stderr.trim().length > 0) {
    const warning = redactPaths(output.stderr.trim());
    if (warning.length > 0) process.stderr.write(`${warning}\n`);
  }
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
  const { artifacts, builder } = validateBuildManifest(buildManifest);
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
  const readelf = await selectReadelf();
  const tempRoot = await mkdtemp(path.join(outputRoot, ".meshrix-linux-package-"));
  const packageEntries = [];
  const stagedArchives = [];
  const containerState = { id: null };
  try {
    for (const artifact of artifacts) {
      const binaryPath = binaries.get(`${artifact.component}\0${artifact.arch}`);
      const measuredElf = await inspectElf(binaryPath, artifact.arch, readelf);
      const initialElf = Object.freeze({
        ...measuredElf,
        dlopenCandidates: sourceDlopenCandidates(metadata.targetMetadata[artifact.rustTarget], artifact.component)
      });
      const initialArtifact = Object.freeze({ ...artifact, elf: initialElf });
      const runtimeInventory = await collectRuntimeDependencies(
        initialArtifact,
        builder,
        readelf,
        containerState,
        tempRoot
      );
      const packageArtifact = Object.freeze({
        ...artifact,
        elf: runtimeInventory.elf,
        runtimePackages: runtimeInventory.packages
      });
      const staged = await stageArtifact(
        packageArtifact,
        version,
        binaryPath,
        readmeTemplate,
        licenseInventory,
        runtimeInventory,
        tempRoot
      );
      const archive = archiveName(packageArtifact, version);
      const stagedArchive = path.join(tempRoot, archive);
      await createArchive(staged.stagingDir, stagedArchive, packageArtifact.archiveBinary);
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
        elf: packageArtifact.elf,
        artifactMetadata: "artifact.json",
        readme: "README.md",
        thirdPartyLicenses: "THIRD_PARTY_LICENSES.md",
        dependencyPackageCount: staged.licenses.dependencyPackages,
        copiedDependencyLicenseFileCount: staged.licenses.copiedLicenseFiles,
        packagesWithoutLicenseFileCount: staged.licenses.packagesWithoutLicenseFile,
        runtimeLibraryPackageCount: runtimeInventory.packages.length,
        copiedRuntimeLicenseFileCount: new Set(runtimeInventory.packages.flatMap((pkg) => pkg.licenseFiles.map((file) => file.relativePath))).size,
        runtimePackages: packageArtifact.runtimePackages.map((pkg) => ({
          name: pkg.name,
          version: pkg.version,
          license: pkg.license,
          licenseSources: pkg.licenseSources,
          licenseFiles: pkg.licenseFiles.map((file) => ({
            path: file.relativePath,
            sourcePackage: file.sourcePackage
          }))
        })),
        ...(packageArtifact.component === "gui" ? {
          hostRuntimeNotice: `${packageArtifact.elf.hostDisplay} ${packageArtifact.elf.hostGpu} Host library requirements left outside the archive: ${packageArtifact.elf.hostLibraries.join(", ") || "none"}. Highest package GLIBC symbol version: ${packageArtifact.elf.packageHighestGlibcRequirement ?? "none"}.`
        } : {})
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
    await removeBuilderContainer(containerState.id);
    await rm(tempRoot, { recursive: true, force: true });
  }

  for (const entry of packageEntries) process.stdout.write(`${entry.archive}\n`);
  process.stdout.write(`package-manifest.json (${packageEntries.length} artifacts)\n`);
}

export { cargoMetadata, collectCargoLicenseInventory, createArchive };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${redactPaths(error instanceof Error ? error.message : "linux_package_failed")}\n`);
    process.exitCode = 1;
  });
}
