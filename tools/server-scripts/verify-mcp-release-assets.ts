#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  releaseGeneratedAtFromSourceDateEpoch,
  releaseManifest
} from "./lib/mcp-release-manifest.ts";
import { packageManifestFromTarball } from "./lib/lock-backed-npm-registry.ts";
import { MCP_PORTABLE_ASSET_PREFIX } from "./lib/mcp-release-common.ts";
import { loadPortableUndiciDependency } from "./lib/mcp-release-portable.ts";
import {
  MCP_ASSET_PLATFORM_BY_PORTABLE_TARGET,
  MCP_RELEASE_TARGETS
} from "./lib/mcp-release-platforms.ts";
import {
  assertExactSet,
  hashCommand,
  listFilesRecursively,
  readTarEntry,
  runArchiveCommand as run,
  sha256,
  sorted,
  tarInventory,
  validateArchiveNames,
  zipInventory
} from "./lib/release-archive-inspection.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const connectorRoot: any = path.join(
  repoRoot,
  "packages",
  "protocols",
  "mcp",
  "adapter",
  "gateway-installer"
);
const foundationSourceRoot: any = path.join(repoRoot, "packages", "foundation", "src");
const nodeRuntimeLockPath: any = path.join(repoRoot, "tools", "release", "node-runtime.lock.json");
const expectedPlatforms: any = Object.freeze(
  MCP_RELEASE_TARGETS.map((target?: any) : any => MCP_ASSET_PLATFORM_BY_PORTABLE_TARGET[target])
);
const platformRuntimeTargets: any = Object.freeze(Object.fromEntries(
  MCP_RELEASE_TARGETS.map((target?: any) : any => [MCP_ASSET_PLATFORM_BY_PORTABLE_TARGET[target], target])
));
const zipPlatforms: any = new Set<any>(expectedPlatforms.filter((platform?: any) : any => !platform.startsWith("linux-")));
const outerReleaseFiles: any = new Set<any>([
  "RELEASE_SHA256SUMS",
  "RELEASE_SHA256SUMS.sigstore.json"
]);
const sha256Pattern: any = /^[a-f0-9]{64}$/u;

function argumentValue(name?: any, fallback: any = "") : any {
  const index: any = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function expectedConnectorFiles() : Promise<any> {
  const fixed: any[] = ["README.md", "LICENSE", "mcp-release-targets.ts", "mcp-identity.ts", "bin/meshrix-mcp.ts"];
  const undici: any = await loadPortableUndiciDependency();
  return {
    files: sorted([
      ...fixed,
      ...await listFilesRecursively(connectorRoot, "lib"),
      ...(await listFilesRecursively(foundationSourceRoot, "environment-compatibility"))
        .map((file?: any) : any => `vendor/foundation/${file}`),
      ...undici.files.map((file?: any) : any => `node_modules/undici/${file}`)
    ]),
    undiciManifest: undici.portablePackageJson
  };
}

function generatedPortableExecutables(platform?: any) : any {
  const runtimeExecutableName: any = platform.startsWith("windows-") ? "node.exe" : "node";
  const windowsTarget: any = platform.startsWith("windows-");
  return new Map<any, any>(windowsTarget
    ? [["meshrix-mcp.ps1", [
        "$ErrorActionPreference = 'Stop'",
        "$DIR = Split-Path -Parent $MyInvocation.MyCommand.Path",
        "$env:MESHRIX_MCP_CONNECTOR_COMMAND = Join-Path $DIR 'meshrix-mcp.ps1'",
        `& (Join-Path $DIR 'runtime\\${runtimeExecutableName}') (Join-Path $DIR 'app\\bin\\meshrix-mcp.ts') @args`,
        "exit $LASTEXITCODE",
        ""
      ].join("\r\n")]]
    : [["meshrix-mcp", [
      "#!/usr/bin/env sh",
      "set -e",
      "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
      "export MESHRIX_MCP_CONNECTOR_COMMAND=\"$DIR/meshrix-mcp\"",
      `exec \"$DIR/runtime/${runtimeExecutableName}\" \"$DIR/app/bin/meshrix-mcp.ts\" \"$@\"`,
      ""
    ].join("\n")]]);
}

async function assertArchiveSourceFile(archivePath?: any, rootName?: any, archiveRelativePath?: any, sourcePath?: any) : Promise<any> {
  const [archived, source] = await Promise.all([
    readTarEntry(archivePath, `${rootName}/${archiveRelativePath}`),
    fs.readFile(sourcePath)
  ]);
  assert.deepEqual(archived, source, `mcp_release_archive_source_mismatch:${archiveRelativePath}`);
}

async function verifyPortableArchive({
  inputDir,
  packageName,
  packageVersion,
  rootPackage,
  platform,
  appFiles,
  undiciManifest,
  runtimeSource
}: Record<string, any>) : Promise<any> {
  const rootName: any = `${packageName}-${packageVersion}-${platform}`;
  const tarName: any = `${rootName}.tar.gz`;
  const tarPath: any = path.join(inputDir, tarName);
  const tarArchive: any = await tarInventory(tarPath, rootName);
  const tarFiles: any = tarArchive.files;
  const relativeTarFiles: any = tarFiles.map((name?: any) : any => name.slice(rootName.length + 1));
  const runtimeName: any = platform.startsWith("windows-") ? "runtime/node.exe" : "runtime/node";
  const allowedNodeLegalNames: any = new Set<any>([
    "licenses/node/LICENSE",
    "licenses/node/NOTICE",
    "licenses/node/NOTICE.txt",
    "licenses/node/THIRD_PARTY_NOTICES",
    "licenses/node/THIRD_PARTY_NOTICES.txt",
    "licenses/node/THIRD_PARTY_LICENSES",
    "licenses/node/THIRD_PARTY_LICENSES.txt"
  ]);
  const fixedFiles: any[] = [
    "LICENSE",
    "THIRD_PARTY_NOTICES.txt",
    "README.txt",
    platform.startsWith("windows-") ? "meshrix-mcp.ps1" : "meshrix-mcp",
    "app/package.json",
    "app/node_modules/undici/package.json",
    runtimeName,
    "licenses/node/NODE_RUNTIME.lock.json",
    ...appFiles.map((name?: any) : any => `app/${name}`)
  ];
  const legalFiles: any = relativeTarFiles.filter((name?: any) : any => allowedNodeLegalNames.has(name));
  assert.equal(legalFiles.includes("licenses/node/LICENSE"), true, "mcp_release_node_license_missing");
  const expectedRelativeFiles: any[] = [...fixedFiles, ...legalFiles];
  assertExactSet(relativeTarFiles, expectedRelativeFiles, "mcp_release_portable_file_set_mismatch");
  const expectedDirectories: any = new Set<any>([rootName]);
  for (const relativeFile of expectedRelativeFiles) {
    let directory: any = path.posix.dirname(`${rootName}/${relativeFile}`);
    while (directory !== "." && !expectedDirectories.has(directory)) {
      expectedDirectories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  assertExactSet(
    tarArchive.directories,
    expectedDirectories,
    "mcp_release_portable_directory_set_mismatch"
  );
  const executableFiles: any = new Set<any>([
    platform.startsWith("windows-") ? "meshrix-mcp.ps1" : "meshrix-mcp",
    runtimeName,
    "app/bin/meshrix-mcp.ts"
  ]);
  for (const directory of tarArchive.directories) {
    assert.equal(tarArchive.modes.get(directory), "drwxr-xr-x", `mcp_release_directory_mode_invalid:${directory}`);
  }
  for (const relativeFile of expectedRelativeFiles) {
    const expectedMode: any = executableFiles.has(relativeFile) ? "-rwxr-xr-x" : "-rw-r--r--";
    assert.equal(
      tarArchive.modes.get(`${rootName}/${relativeFile}`),
      expectedMode,
      `mcp_release_file_mode_invalid:${relativeFile}`
    );
  }

  for (const appFile of appFiles) {
    const isUndiciFile: any = appFile.startsWith("node_modules/undici/");
    const isFoundationFile: any = appFile.startsWith("vendor/foundation/");
    const appFileSourceRoot: any = isUndiciFile
      ? path.join(repoRoot, "node_modules", "undici")
      : isFoundationFile ? foundationSourceRoot : connectorRoot;
    const sourceRelativePath: any = isUndiciFile
      ? appFile.slice("node_modules/undici/".length)
      : isFoundationFile ? appFile.slice("vendor/foundation/".length) : appFile;
    await assertArchiveSourceFile(
      tarPath,
      rootName,
      `app/${appFile}`,
      path.join(appFileSourceRoot, sourceRelativePath)
    );
  }
  const portablePackageManifest: Record<string, any> = {
    private: true,
    name: rootPackage.name,
    version: rootPackage.version,
    type: "module",
    dependencies: {
      undici: undiciManifest.version
    },
    imports: {
      "#meshrix/foundation/environment-compatibility/index": "./vendor/foundation/environment-compatibility/index.ts",
      "#meshrix/contracts/*": "./vendor/contracts/*.ts",
      "#meshrix/protocols/*": "./vendor/protocols/*.ts"
    }
  };
  assert.deepEqual(
    await readTarEntry(tarPath, `${rootName}/app/package.json`),
    Buffer.from(`${JSON.stringify(portablePackageManifest, null, 2)}\n`, "utf8"),
    "mcp_release_portable_package_manifest_mismatch"
  );
  assert.deepEqual(
    await readTarEntry(tarPath, `${rootName}/app/node_modules/undici/package.json`),
    Buffer.from(`${JSON.stringify(undiciManifest, null, 2)}\n`, "utf8"),
    "mcp_release_portable_undici_manifest_mismatch"
  );
  await assertArchiveSourceFile(tarPath, rootName, "LICENSE", path.join(repoRoot, "LICENSE"));
  await assertArchiveSourceFile(
    tarPath,
    rootName,
    "licenses/node/NODE_RUNTIME.lock.json",
    nodeRuntimeLockPath
  );
  for (const [scriptName, expectedContent] of generatedPortableExecutables(platform)) {
    assert.deepEqual(
      await readTarEntry(tarPath, `${rootName}/${scriptName}`),
      Buffer.from(expectedContent, "utf8"),
      `mcp_release_generated_launcher_mismatch:${scriptName}`
    );
  }
  const portableRuntimeEntry: any = `${rootName}/${runtimeName}`;
  const runtimeReadCommand: any = runtimeSource.zip ? "unzip" : "tar";
  const runtimeReadArgs: any = runtimeSource.zip
    ? ["-p", runtimeSource.archivePath, runtimeSource.runtimeEntry]
    : ["-xOf", runtimeSource.archivePath, runtimeSource.runtimeEntry];
  assert.equal(
    await hashCommand("tar", ["-xOzf", tarPath, portableRuntimeEntry]),
    await hashCommand(runtimeReadCommand, runtimeReadArgs),
    `mcp_release_node_runtime_source_mismatch:${platform}`
  );
  assertExactSet(
    legalFiles.map((name?: any) : any => path.posix.basename(name)),
    runtimeSource.legalEntries.keys(),
    `mcp_release_node_legal_file_set_mismatch:${platform}`
  );
  for (const portableLegalFile of legalFiles) {
    const legalName: any = path.posix.basename(portableLegalFile);
    const sourceEntry: any = runtimeSource.legalEntries.get(legalName);
    const sourceArgs: any = runtimeSource.zip
      ? ["-p", runtimeSource.archivePath, sourceEntry]
      : ["-xOf", runtimeSource.archivePath, sourceEntry];
    assert.equal(
      await hashCommand("tar", ["-xOzf", tarPath, `${rootName}/${portableLegalFile}`]),
      await hashCommand(runtimeReadCommand, sourceArgs),
      `mcp_release_node_legal_source_mismatch:${platform}:${legalName}`
    );
  }

  if (zipPlatforms.has(platform)) {
    const zipName: any = `${rootName}.zip`;
    const zipPath: any = path.join(inputDir, zipName);
    const zipArchive: any = await zipInventory(zipPath, rootName);
    const zipFiles: any = zipArchive.files;
    assertExactSet(zipFiles, tarFiles, "mcp_release_tar_zip_file_set_mismatch");
    assertExactSet(
      zipArchive.directories,
      tarArchive.directories,
      "mcp_release_tar_zip_directory_set_mismatch"
    );
    for (const [entryName, mode] of tarArchive.modes) {
      assert.equal(zipArchive.modes.get(entryName), mode, `mcp_release_tar_zip_mode_mismatch:${entryName}`);
    }
    for (const entryName of tarFiles) {
      const [tarDigest, zipDigest] = await Promise.all([
        hashCommand("tar", ["-xOzf", tarPath, entryName]),
        hashCommand("unzip", ["-p", zipPath, entryName])
      ]);
      assert.equal(tarDigest, zipDigest, `mcp_release_tar_zip_content_mismatch:${entryName}`);
    }
  }
  return tarName;
}

function parseChecksumIndex(text?: any) : any {
  const checksums: any = new Map<any, any>();
  for (const line of String(text).split(/\r?\n/u)) {
    if (!line) continue;
    const match: any = line.match(/^([a-f0-9]{64})  ([^\s/][^\s]*)$/u);
    assert.ok(match, "mcp_release_checksum_line_invalid");
    assert.equal(checksums.has(match[2]), false, "mcp_release_checksum_duplicate");
    checksums.set(match[2], match[1]);
  }
  assert.ok(checksums.size > 0, "mcp_release_checksum_empty");
  return checksums;
}

async function verifyPreparedRootTarball({ inputDir, expectedName, expectedDigest, expectedIntegrity, rootPackage }: Record<string, any>) : Promise<any> {
  const tarballPath: any = path.join(inputDir, expectedName);
  const bytes: any = await fs.readFile(tarballPath);
  const packageManifest: any = packageManifestFromTarball(bytes);
  assert.equal(await sha256(tarballPath), expectedDigest, "mcp_release_root_tarball_digest_mismatch");
  assert.equal(
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    expectedIntegrity,
    "mcp_release_root_tarball_integrity_mismatch"
  );
  assert.equal(packageManifest.name, rootPackage.name, "mcp_release_root_tarball_name_mismatch");
  assert.equal(packageManifest.version, rootPackage.version, "mcp_release_root_tarball_version_mismatch");
  assert.equal(packageManifest.bin?.["meshrix-mcp"], rootPackage.bin?.["meshrix-mcp"], "mcp_release_root_tarball_mcp_bin_mismatch");
  const archive: any = await run("tar", ["-tzf", tarballPath]);
  const files: any[] = String(archive.stdout).split(/\r?\n/u).filter(Boolean);
  assert.equal(
    files.includes(`package/${rootPackage.bin?.["meshrix-mcp"]}`),
    true,
    "mcp_release_root_tarball_mcp_bin_missing"
  );
  assert.equal(files.some((name?: any) : any => name.startsWith("package/node_modules/")), false, "mcp_release_root_tarball_bundles_node_modules");
  return true;
}

async function verifyNodeRuntimeSourceEvidence(sourceDir?: any, nodeRuntimeLock?: any) : Promise<any> {
  const expectedSourceDir: any = path.join(repoRoot, "build", "release", "node-runtime-source");
  assert.equal(sourceDir, expectedSourceDir, "node_runtime_source_evidence_out_of_scope");
  const sourceStat: any = await fs.lstat(sourceDir);
  assert.equal(sourceStat.isDirectory() && !sourceStat.isSymbolicLink(), true, "node_runtime_source_evidence_invalid");
  const embeddedLock: any = await fs.readFile(path.join(sourceDir, "NODE_RUNTIME.lock.json"));
  assert.deepEqual(embeddedLock, await fs.readFile(nodeRuntimeLockPath), "node_runtime_source_lock_mismatch");
  const descriptors: any = MCP_RELEASE_TARGETS.map((target?: any) : any => {
    const descriptor: any = nodeRuntimeLock.targets?.[target];
    assert.ok(descriptor, "node_runtime_source_target_missing");
    return descriptor;
  });
  const expectedFiles: any[] = ["NODE_RUNTIME.lock.json", ...descriptors.map(({ filename }: Record<string, any>) : any => filename)];
  const entries: any = await fs.readdir(sourceDir, { withFileTypes: true });
  assert.equal(entries.every((entry?: any) : any => entry.isFile() && !entry.isSymbolicLink()), true, "node_runtime_source_entry_invalid");
  assertExactSet(entries.map(({ name }: Record<string, any>) : any => name), expectedFiles, "node_runtime_source_file_set_mismatch");
  for (const descriptor of descriptors) {
    const sourcePath: any = path.join(sourceDir, descriptor.filename);
    const stat: any = await fs.stat(sourcePath);
    assert.equal(stat.size, descriptor.sizeBytes, "node_runtime_source_size_mismatch");
    assert.equal(await sha256(sourcePath), descriptor.sha256, "node_runtime_source_digest_mismatch");
  }

  const result: any = new Map<any, any>();
  for (const platform of expectedPlatforms) {
    const target: any = platformRuntimeTargets[platform];
    const descriptor: any = nodeRuntimeLock.targets[target];
    assert.ok(descriptor, "node_runtime_source_target_missing");
    const archivePath: any = path.join(sourceDir, descriptor.filename);
    const zip: any = descriptor.filename.endsWith(".zip");
    const rootName: any = descriptor.filename.replace(zip ? /\.zip$/u : /\.tar\.xz$/u, "");
    const { stdout } = await run(zip ? "unzip" : "tar", zip
      ? ["-Z1", archivePath]
      : ["-tf", archivePath]);
    const names: any = stdout.split(/\r?\n/u).filter(Boolean);
    validateArchiveNames(names, rootName, "node_runtime_source_archive");
    const legalEntries: any = new Map<any, any>();
    for (const name of names) {
      const relative: any = name.startsWith(`${rootName}/`) ? name.slice(rootName.length + 1) : "";
      if (/^(?:LICENSE|NOTICE(?:\.txt)?|THIRD_PARTY_(?:NOTICES|LICENSES)(?:\.txt)?)$/u.test(relative)) {
        legalEntries.set(relative, name);
      }
    }
    assert.equal(legalEntries.has("LICENSE"), true, "node_runtime_source_license_missing");
    result.set(platform, {
      archivePath,
      zip,
      runtimeEntry: `${rootName}/${zip ? "node.exe" : "bin/node"}`,
      legalEntries
    });
  }
  return result;
}

async function buildCanonicalManifest({
  inputDir,
  rootPackage,
  npmIntegrity,
  nodeRuntimeLock,
  checksumIndex,
  channel,
  generatedAt
}: Record<string, any>) : Promise<any> {
  const portables: any[] = [];
  for (const platform of expectedPlatforms) {
      const rootName: any = `${MCP_PORTABLE_ASSET_PREFIX}-${rootPackage.version}-${platform}`;
      const archiveName: any = `${rootName}.tar.gz`;
      const archivePath: any = path.join(inputDir, archiveName);
      const archiveStat: any = await fs.stat(archivePath);
      const zipArchiveName: any = zipPlatforms.has(platform) ? `${rootName}.zip` : null;
      const zipArchivePath: any = zipArchiveName ? path.join(inputDir, zipArchiveName) : null;
      const zipStat: any = zipArchivePath ? await fs.stat(zipArchivePath) : null;
      portables.push({
        platform,
        archiveName,
        archivePath,
        sha256: checksumIndex.get(archiveName),
        sizeBytes: archiveStat.size,
        zipArchiveName,
        zipArchivePath,
        zipSha256: zipArchiveName ? checksumIndex.get(zipArchiveName) : null,
        zipSizeBytes: zipStat?.size ?? null,
        rootName,
        executable: platform.startsWith("windows-") ? "meshrix-mcp.ps1" : "meshrix-mcp",
        includesNodeRuntime: true,
        bundledNodeVersion: nodeRuntimeLock.version,
        projectLicensePath: "LICENSE",
        connectorLicensePath: "app/LICENSE",
        thirdPartyNoticesPath: "THIRD_PARTY_NOTICES.txt",
        nodeRuntimeLockPath: "licenses/node/NODE_RUNTIME.lock.json",
        nodeLegalFiles: ["licenses/node/LICENSE"]
      });
  }
  const rootTarball: any = `${rootPackage.name}-${rootPackage.version}.tgz`;
  const tarballPath: any = path.join(inputDir, rootTarball);
  return releaseManifest({
    channel,
    packageJson: rootPackage,
    tarballName: rootTarball,
    npmIntegrity,
    checksum: checksumIndex.get(rootTarball),
    sizeBytes: (await fs.stat(tarballPath)).size,
    portables,
    generatedAt
  });
}

async function main() : Promise<any> {
  const inputDir: any = path.resolve(argumentValue("--input-dir", "build/release/mcp"));
  const nodeRuntimeSourceDir: any = path.resolve(argumentValue(
    "--node-runtime-source-dir",
    "build/release/node-runtime-source"
  ));
  const expectedChannel: any = argumentValue("--expected-channel", "stable");
  const expectedSourceDateEpoch: any = argumentValue(
    "--expected-source-date-epoch",
    process.env.SOURCE_DATE_EPOCH || ""
  );
  const expectedGeneratedAt: any = expectedSourceDateEpoch
    ? releaseGeneratedAtFromSourceDateEpoch(expectedSourceDateEpoch)
    : "";
  assert.equal(/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/u.test(expectedChannel), true, "mcp_release_expected_channel_invalid");
  const expectedInputDir: any = path.join(repoRoot, "build", "release", "mcp");
  assert.equal(inputDir, expectedInputDir, "mcp_release_input_directory_out_of_scope");
  for (const boundary of [
    path.join(repoRoot, "build"),
    path.join(repoRoot, "build", "release"),
    expectedInputDir
  ]) {
    const stat: any = await fs.lstat(boundary);
    assert.equal(stat.isSymbolicLink(), false, "mcp_release_input_ancestor_symlink_rejected");
    assert.equal(stat.isDirectory(), true, "mcp_release_input_ancestor_not_directory");
  }
  assert.equal(
    await fs.realpath(inputDir),
    await fs.realpath(expectedInputDir),
    "mcp_release_input_realpath_out_of_scope"
  );
  const entries: any = await fs.readdir(inputDir, { withFileTypes: true });
  assert.equal(entries.length > 0, true, "mcp_release_assets_missing");
  assert.equal(
    entries.every((entry?: any) : any => (
      entry.isFile()
      && !entry.isSymbolicLink()
      && !/[\s\\\u0000-\u001f\u007f]/u.test(entry.name)
    )),
    true,
    "mcp_release_asset_entry_invalid"
  );
  const actualFiles: any = sorted(entries.map((entry?: any) : any => entry.name));
  const [manifestText, latestText, packageText, nodeRuntimeLockText] = await Promise.all([
    fs.readFile(path.join(inputDir, "meshrix-mcp-release.json"), "utf8"),
    fs.readFile(path.join(inputDir, "latest.json"), "utf8"),
    fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
    fs.readFile(nodeRuntimeLockPath, "utf8")
  ]);
  assert.equal(latestText, manifestText, "mcp_release_latest_manifest_mismatch");
  const manifest: any = JSON.parse(manifestText);
  assert.equal(
    manifestText,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "mcp_release_manifest_not_unique_canonical_json"
  );
  const rootPackage: any = JSON.parse(packageText);
  const nodeRuntimeLock: any = JSON.parse(nodeRuntimeLockText);
  const runtimeSources: any = await verifyNodeRuntimeSourceEvidence(nodeRuntimeSourceDir, nodeRuntimeLock);
  assert.equal(manifest.channel, expectedChannel, "mcp_release_channel_invalid");
  if (expectedGeneratedAt) {
    assert.equal(
      manifest.generatedAt,
      expectedGeneratedAt,
      "mcp_release_source_date_epoch_mismatch"
    );
  }
  assert.equal(manifest.connector?.packageName, rootPackage.name, "mcp_release_package_name_mismatch");
  assert.equal(manifest.connector?.packageVersion, rootPackage.version, "mcp_release_version_mismatch");
  const portableArtifacts: any[] = manifest.portable?.artifacts;
  assert.equal(Array.isArray(portableArtifacts), true, "mcp_release_portable_artifacts_missing");
  assert.deepEqual(
    portableArtifacts.map(({ platform }: Record<string, any>) => platform),
    expectedPlatforms,
    "mcp_release_portable_platform_set_mismatch"
  );
  assert.equal(portableArtifacts.every((artifact?: any) : any => (
    artifact.includesNodeRuntime === true
    && artifact.bundledNodeVersion === nodeRuntimeLock.version
    && artifact.launcher === (artifact.platform.startsWith("windows-") ? "meshrix-mcp.ps1" : "meshrix-mcp")
  )), true, "mcp_release_portable_runtime_or_launcher_invalid");

  const declaredFiles: any = manifest.publish?.releaseFiles;
  assert.equal(Array.isArray(declaredFiles), true, "mcp_release_file_manifest_missing");
  assert.equal(new Set<any>(declaredFiles).size, declaredFiles.length, "mcp_release_file_manifest_duplicate");
  const canonicalRootTarball: any = `${rootPackage.name}-${rootPackage.version}.tgz`;
  const canonicalPortableTarballs: any = expectedPlatforms.map((platform?: any) : any =>
    `${MCP_PORTABLE_ASSET_PREFIX}-${rootPackage.version}-${platform}.tar.gz`
  );
  const canonicalPortableZips: any = expectedPlatforms
    .filter((platform?: any) : any => zipPlatforms.has(platform))
    .map((platform?: any) : any => `${MCP_PORTABLE_ASSET_PREFIX}-${rootPackage.version}-${platform}.zip`);
  assertExactSet(declaredFiles, [
    canonicalRootTarball,
    ...canonicalPortableTarballs,
    ...canonicalPortableZips,
    "SHA256SUMS",
    "RELEASE_SHA256SUMS",
    "RELEASE_SHA256SUMS.sigstore.json",
    "meshrix-mcp-release.json",
    "latest.json"
  ], "mcp_release_declared_asset_set_mismatch");
  const expectedFiles: any = declaredFiles.filter((name?: any) : any => !outerReleaseFiles.has(name));
  assertExactSet(actualFiles, expectedFiles, "mcp_release_exact_asset_set_mismatch");

  const checksumIndex: any = parseChecksumIndex(await fs.readFile(path.join(inputDir, "SHA256SUMS"), "utf8"));
  assertExactSet(
    checksumIndex.keys(),
    actualFiles.filter((name?: any) : any => name !== "SHA256SUMS"),
    "mcp_release_checksum_asset_set_mismatch"
  );
  for (const [name, digest] of checksumIndex) {
    assert.equal(await sha256(path.join(inputDir, name)), digest, `mcp_release_asset_digest_mismatch:${name}`);
  }
  assert.equal(
    new Date(manifest.generatedAt).toISOString(),
    manifest.generatedAt,
    "mcp_release_generated_at_invalid"
  );
  const canonicalManifest: any = await buildCanonicalManifest({
      inputDir,
      rootPackage,
      npmIntegrity: manifest.connector?.npmIntegrity,
      nodeRuntimeLock,
      checksumIndex,
      channel: expectedChannel,
      generatedAt: manifest.generatedAt
    });
  assert.equal(
    manifestText,
    `${JSON.stringify(canonicalManifest, null, 2)}\n`,
    "mcp_release_manifest_not_canonical"
  );

  const rootTarball: any = manifest.connector.tarball;
  assert.equal(rootTarball, canonicalRootTarball, "mcp_release_root_tarball_name_mismatch");
  assert.equal(
    manifest.connector.sha256,
    checksumIndex.get(rootTarball),
    "mcp_release_root_manifest_digest_mismatch"
  );
  const rootStat: any = await fs.stat(path.join(inputDir, rootTarball));
  assert.equal(rootStat.size, manifest.connector.sizeBytes, "mcp_release_root_tarball_size_mismatch");
  await verifyPreparedRootTarball({
    inputDir,
    expectedName: rootTarball,
    expectedDigest: manifest.connector.sha256,
    expectedIntegrity: manifest.connector.npmIntegrity,
    rootPackage
  });

  const portableApp: any = await expectedConnectorFiles();
  const portableTarballs: any[] = [];
  for (const platform of expectedPlatforms) {
    portableTarballs.push(await verifyPortableArchive({
      inputDir,
      packageName: MCP_PORTABLE_ASSET_PREFIX,
      packageVersion: rootPackage.version,
      rootPackage,
      platform,
      appFiles: portableApp.files,
      undiciManifest: portableApp.undiciManifest,
      runtimeSource: runtimeSources.get(platform)
    }));
  }
  for (const platform of expectedPlatforms) {
    const artifact = portableArtifacts.find((entry?: any) : any => entry.platform === platform);
    const archiveName = `${MCP_PORTABLE_ASSET_PREFIX}-${rootPackage.version}-${platform}.tar.gz`;
    const archiveStat = await fs.stat(path.join(inputDir, archiveName));
    assert.equal(artifact.archive, archiveName, `mcp_release_portable_archive_mismatch:${platform}`);
    assert.equal(artifact.sha256, checksumIndex.get(archiveName), `mcp_release_portable_digest_mismatch:${platform}`);
    assert.equal(artifact.sizeBytes, archiveStat.size, `mcp_release_portable_size_mismatch:${platform}`);
  }

  console.log(JSON.stringify({
    ok: true,
    assetCount: actualFiles.length,
    portableTargetCount: expectedPlatforms.length,
    exactAssetSet: true,
    preparedRootTarballIntegrityValid: true,
    archiveSourceConvergence: true,
    archiveTarZipConvergence: true
  }));
}

const invokedAsMain: any = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsMain) {
  main().catch((error?: any) : any => {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  });
}

export {
  hashCommand,
  parseChecksumIndex,
  validateArchiveNames
};
