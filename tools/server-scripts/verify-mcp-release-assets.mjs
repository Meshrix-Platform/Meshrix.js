#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBootstrapInstaller,
  releaseGeneratedAtFromSourceDateEpoch,
  releaseManifest
} from "./lib/mcp-release-manifest.mjs";
import { npmCliArgs, resolveNpmCliInvocation } from "./lib/npm-cli-invocation.mjs";
import {
  MCP_ASSET_PLATFORM_BY_PORTABLE_TARGET,
  MCP_RELEASE_TARGETS
} from "./lib/mcp-release-platforms.mjs";
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
} from "./lib/release-archive-inspection.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const connectorRoot = path.join(
  repoRoot,
  "packages",
  "protocols",
  "mcp",
  "adapter",
  "gateway-installer"
);
const nativeInstallerRoot = path.join(
  repoRoot,
  "packages",
  "protocols",
  "mcp",
  "adapter",
  "native-installer"
);
const nodeRuntimeLockPath = path.join(repoRoot, "tools", "release", "node-runtime.lock.json");
const expectedPlatforms = Object.freeze(
  MCP_RELEASE_TARGETS.map((target) => MCP_ASSET_PLATFORM_BY_PORTABLE_TARGET[target])
);
const platformRuntimeTargets = Object.freeze(Object.fromEntries(
  MCP_RELEASE_TARGETS.map((target) => [MCP_ASSET_PLATFORM_BY_PORTABLE_TARGET[target], target])
));
const zipPlatforms = new Set(expectedPlatforms.filter((platform) => !platform.startsWith("linux-")));
const outerReleaseFiles = new Set([
  "RELEASE_SHA256SUMS",
  "RELEASE_SHA256SUMS.sigstore.json"
]);
const sha256Pattern = /^[a-f0-9]{64}$/u;

function argumentValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function expectedConnectorFiles() {
  const fixed = ["package.json", "README.md", "LICENSE", "mcp-release-targets.mjs", "bin/meshrix-mcp.mjs"];
  return sorted([...fixed, ...await listFilesRecursively(connectorRoot, "lib")]);
}

function generatedPortableExecutables(platform) {
  const runtimeExecutableName = platform.startsWith("windows-") ? "node.exe" : "node";
  const commandScript = (scriptName, operation = "") => [
    "#!/usr/bin/env sh",
    "set -e",
    "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
    `\"$DIR/${scriptName}\"${operation ? ` ${operation}` : ""}`,
    "printf '\\nDone. Press Enter to close.'",
    "IFS= read -r _",
    ""
  ].join("\n");
  return new Map([
    ["meshrix-mcp", [
      "#!/usr/bin/env sh",
      "set -e",
      "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
      "export MESHRIX_MCP_CONNECTOR_COMMAND=\"$DIR/meshrix-mcp\"",
      `exec \"$DIR/runtime/${runtimeExecutableName}\" \"$DIR/app/bin/meshrix-mcp.mjs\" \"$@\"`,
      ""
    ].join("\n")],
    ["meshrix-mcp.ps1", [
      "$ErrorActionPreference = 'Stop'",
      "$DIR = Split-Path -Parent $MyInvocation.MyCommand.Path",
      "$env:MESHRIX_MCP_CONNECTOR_COMMAND = Join-Path $DIR 'meshrix-mcp.ps1'",
      `& (Join-Path $DIR 'runtime\\${runtimeExecutableName}') (Join-Path $DIR 'app\\bin\\meshrix-mcp.mjs') @args`,
      "exit $LASTEXITCODE",
      ""
    ].join("\r\n")],
    ["install.command", commandScript("meshrix-mcp-install.sh", "install")],
    ["uninstall.command", commandScript("meshrix-mcp-uninstall.sh")],
    ["doctor.command", commandScript("meshrix-mcp-install.sh", "doctor")]
  ]);
}

async function assertArchiveSourceFile(archivePath, rootName, archiveRelativePath, sourcePath) {
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
  platform,
  appFiles,
  runtimeSource
}) {
  const rootName = `${packageName}-${packageVersion}-${platform}`;
  const tarName = `${rootName}.tar.gz`;
  const tarPath = path.join(inputDir, tarName);
  const tarArchive = await tarInventory(tarPath, rootName);
  const tarFiles = tarArchive.files;
  const relativeTarFiles = tarFiles.map((name) => name.slice(rootName.length + 1));
  const runtimeName = platform.startsWith("windows-") ? "runtime/node.exe" : "runtime/node";
  const allowedNodeLegalNames = new Set([
    "licenses/node/LICENSE",
    "licenses/node/NOTICE",
    "licenses/node/NOTICE.txt",
    "licenses/node/THIRD_PARTY_NOTICES",
    "licenses/node/THIRD_PARTY_NOTICES.txt",
    "licenses/node/THIRD_PARTY_LICENSES",
    "licenses/node/THIRD_PARTY_LICENSES.txt"
  ]);
  const fixedFiles = [
    "LICENSE",
    "THIRD_PARTY_NOTICES.txt",
    "README.txt",
    "meshrix-mcp",
    "meshrix-mcp.ps1",
    "install.command",
    "uninstall.command",
    "doctor.command",
    "meshrix-mcp-install.sh",
    "meshrix-mcp-uninstall.sh",
    "meshrix-mcp-install.ps1",
    "meshrix-mcp-uninstall.ps1",
    runtimeName,
    "licenses/node/NODE_RUNTIME.lock.json",
    ...appFiles.map((name) => `app/${name}`)
  ];
  const legalFiles = relativeTarFiles.filter((name) => allowedNodeLegalNames.has(name));
  assert.equal(legalFiles.includes("licenses/node/LICENSE"), true, "mcp_release_node_license_missing");
  const expectedRelativeFiles = [...fixedFiles, ...legalFiles];
  assertExactSet(relativeTarFiles, expectedRelativeFiles, "mcp_release_portable_file_set_mismatch");
  const expectedDirectories = new Set([rootName]);
  for (const relativeFile of expectedRelativeFiles) {
    let directory = path.posix.dirname(`${rootName}/${relativeFile}`);
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
  const executableFiles = new Set([
    "meshrix-mcp",
    "meshrix-mcp.ps1",
    "install.command",
    "uninstall.command",
    "doctor.command",
    "meshrix-mcp-install.sh",
    "meshrix-mcp-uninstall.sh",
    runtimeName,
    "app/bin/meshrix-mcp.mjs"
  ]);
  for (const directory of tarArchive.directories) {
    assert.equal(tarArchive.modes.get(directory), "drwxr-xr-x", `mcp_release_directory_mode_invalid:${directory}`);
  }
  for (const relativeFile of expectedRelativeFiles) {
    const expectedMode = executableFiles.has(relativeFile) ? "-rwxr-xr-x" : "-rw-r--r--";
    assert.equal(
      tarArchive.modes.get(`${rootName}/${relativeFile}`),
      expectedMode,
      `mcp_release_file_mode_invalid:${relativeFile}`
    );
  }

  for (const appFile of appFiles) {
    await assertArchiveSourceFile(
      tarPath,
      rootName,
      `app/${appFile}`,
      path.join(connectorRoot, appFile)
    );
  }
  await assertArchiveSourceFile(tarPath, rootName, "LICENSE", path.join(repoRoot, "LICENSE"));
  await assertArchiveSourceFile(
    tarPath,
    rootName,
    "licenses/node/NODE_RUNTIME.lock.json",
    nodeRuntimeLockPath
  );
  for (const scriptName of [
    "meshrix-mcp-install.sh",
    "meshrix-mcp-uninstall.sh",
    "meshrix-mcp-install.ps1",
    "meshrix-mcp-uninstall.ps1"
  ]) {
    await assertArchiveSourceFile(
      tarPath,
      rootName,
      scriptName,
      path.join(nativeInstallerRoot, scriptName)
    );
  }
  for (const [scriptName, expectedContent] of generatedPortableExecutables(platform)) {
    assert.deepEqual(
      await readTarEntry(tarPath, `${rootName}/${scriptName}`),
      Buffer.from(expectedContent, "utf8"),
      `mcp_release_generated_launcher_mismatch:${scriptName}`
    );
  }
  const portableRuntimeEntry = `${rootName}/${runtimeName}`;
  const runtimeReadCommand = runtimeSource.zip ? "unzip" : "tar";
  const runtimeReadArgs = runtimeSource.zip
    ? ["-p", runtimeSource.archivePath, runtimeSource.runtimeEntry]
    : ["-xOf", runtimeSource.archivePath, runtimeSource.runtimeEntry];
  assert.equal(
    await hashCommand("tar", ["-xOzf", tarPath, portableRuntimeEntry]),
    await hashCommand(runtimeReadCommand, runtimeReadArgs),
    `mcp_release_node_runtime_source_mismatch:${platform}`
  );
  assertExactSet(
    legalFiles.map((name) => path.posix.basename(name)),
    runtimeSource.legalEntries.keys(),
    `mcp_release_node_legal_file_set_mismatch:${platform}`
  );
  for (const portableLegalFile of legalFiles) {
    const legalName = path.posix.basename(portableLegalFile);
    const sourceEntry = runtimeSource.legalEntries.get(legalName);
    const sourceArgs = runtimeSource.zip
      ? ["-p", runtimeSource.archivePath, sourceEntry]
      : ["-xOf", runtimeSource.archivePath, sourceEntry];
    assert.equal(
      await hashCommand("tar", ["-xOzf", tarPath, `${rootName}/${portableLegalFile}`]),
      await hashCommand(runtimeReadCommand, sourceArgs),
      `mcp_release_node_legal_source_mismatch:${platform}:${legalName}`
    );
  }

  if (zipPlatforms.has(platform)) {
    const zipName = `${rootName}.zip`;
    const zipPath = path.join(inputDir, zipName);
    const zipArchive = await zipInventory(zipPath, rootName);
    const zipFiles = zipArchive.files;
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

function parseChecksumIndex(text) {
  const checksums = new Map();
  for (const line of String(text).split(/\r?\n/u)) {
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})  ([^\s/][^\s]*)$/u);
    assert.ok(match, "mcp_release_checksum_line_invalid");
    assert.equal(checksums.has(match[2]), false, "mcp_release_checksum_duplicate");
    checksums.set(match[2], match[1]);
  }
  assert.ok(checksums.size > 0, "mcp_release_checksum_empty");
  return checksums;
}

async function verifyReproducibleConnectorTarball(inputDir, expectedName, expectedDigest) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-release-repack-"));
  try {
    const npmCli = resolveNpmCliInvocation();
    const { stdout } = await run(
      npmCli.command,
      npmCliArgs(npmCli, ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary]),
      {
        cwd: connectorRoot,
        env: {
          PATH: process.env.PATH || "",
          HOME: temporary,
          USERPROFILE: temporary,
          npm_config_cache: path.join(temporary, "npm-cache"),
          npm_config_userconfig: path.join(temporary, "empty-npmrc"),
          npm_config_audit: "false",
          npm_config_fund: "false"
        }
      }
    );
    const [packed] = JSON.parse(stdout);
    assert.equal(packed?.filename, expectedName, "mcp_release_connector_tarball_name_mismatch");
    assert.equal(
      await sha256(path.join(temporary, expectedName)),
      expectedDigest,
      "mcp_release_connector_tarball_not_reproducible"
    );
    assert.equal(
      await sha256(path.join(inputDir, expectedName)),
      expectedDigest,
      "mcp_release_connector_tarball_digest_mismatch"
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function verifyNodeRuntimeSourceEvidence(sourceDir, nodeRuntimeLock) {
  const expectedSourceDir = path.join(repoRoot, "build", "release", "node-runtime-source");
  assert.equal(sourceDir, expectedSourceDir, "node_runtime_source_evidence_out_of_scope");
  const sourceStat = await fs.lstat(sourceDir);
  assert.equal(sourceStat.isDirectory() && !sourceStat.isSymbolicLink(), true, "node_runtime_source_evidence_invalid");
  const embeddedLock = await fs.readFile(path.join(sourceDir, "NODE_RUNTIME.lock.json"));
  assert.deepEqual(embeddedLock, await fs.readFile(nodeRuntimeLockPath), "node_runtime_source_lock_mismatch");
  const descriptors = MCP_RELEASE_TARGETS.map((target) => {
    const descriptor = nodeRuntimeLock.targets?.[target];
    assert.ok(descriptor, "node_runtime_source_target_missing");
    return descriptor;
  });
  const expectedFiles = ["NODE_RUNTIME.lock.json", ...descriptors.map(({ filename }) => filename)];
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  assert.equal(entries.every((entry) => entry.isFile() && !entry.isSymbolicLink()), true, "node_runtime_source_entry_invalid");
  assertExactSet(entries.map(({ name }) => name), expectedFiles, "node_runtime_source_file_set_mismatch");
  for (const descriptor of descriptors) {
    const sourcePath = path.join(sourceDir, descriptor.filename);
    const stat = await fs.stat(sourcePath);
    assert.equal(stat.size, descriptor.sizeBytes, "node_runtime_source_size_mismatch");
    assert.equal(await sha256(sourcePath), descriptor.sha256, "node_runtime_source_digest_mismatch");
  }

  const result = new Map();
  for (const platform of expectedPlatforms) {
    const target = platformRuntimeTargets[platform];
    const descriptor = nodeRuntimeLock.targets[target];
    assert.ok(descriptor, "node_runtime_source_target_missing");
    const archivePath = path.join(sourceDir, descriptor.filename);
    const zip = descriptor.filename.endsWith(".zip");
    const rootName = descriptor.filename.replace(zip ? /\.zip$/u : /\.tar\.xz$/u, "");
    const { stdout } = await run(zip ? "unzip" : "tar", zip
      ? ["-Z1", archivePath]
      : ["-tf", archivePath]);
    const names = stdout.split(/\r?\n/u).filter(Boolean);
    validateArchiveNames(names, rootName, "node_runtime_source_archive");
    const legalEntries = new Map();
    for (const name of names) {
      const relative = name.startsWith(`${rootName}/`) ? name.slice(rootName.length + 1) : "";
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
  connectorPackage,
  nodeRuntimeLock,
  checksumIndex,
  channel,
  generatedAt
}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-release-manifest-"));
  try {
    const bootstrap = await createBootstrapInstaller({ outputDir: temporary, packageJson: connectorPackage });
    const portables = [];
    for (const platform of expectedPlatforms) {
      const rootName = `${connectorPackage.name}-${connectorPackage.version}-${platform}`;
      const archiveName = `${rootName}.tar.gz`;
      const archivePath = path.join(inputDir, archiveName);
      const archiveStat = await fs.stat(archivePath);
      const zipArchiveName = zipPlatforms.has(platform) ? `${rootName}.zip` : null;
      const zipArchivePath = zipArchiveName ? path.join(inputDir, zipArchiveName) : null;
      const zipStat = zipArchivePath ? await fs.stat(zipArchivePath) : null;
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
        executable: "meshrix-mcp",
        includesNodeRuntime: true,
        bundledNodeVersion: nodeRuntimeLock.version,
        projectLicensePath: "LICENSE",
        connectorLicensePath: "app/LICENSE",
        thirdPartyNoticesPath: "THIRD_PARTY_NOTICES.txt",
        nodeRuntimeLockPath: "licenses/node/NODE_RUNTIME.lock.json",
        nodeLegalFiles: ["licenses/node/LICENSE"]
      });
    }
    const connectorTarball = `${connectorPackage.name}-${connectorPackage.version}.tgz`;
    const tarballPath = path.join(inputDir, connectorTarball);
    const expected = releaseManifest({
      channel,
      packageJson: connectorPackage,
      tarballName: connectorTarball,
      tarballPath,
      checksum: checksumIndex.get(connectorTarball),
      sizeBytes: (await fs.stat(tarballPath)).size,
      portables,
      bootstrap,
      generatedAt
    });
    return expected;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const inputDir = path.resolve(argumentValue("--input-dir", "build/release/mcp"));
  const nodeRuntimeSourceDir = path.resolve(argumentValue(
    "--node-runtime-source-dir",
    "build/release/node-runtime-source"
  ));
  const expectedChannel = argumentValue("--expected-channel", "stable");
  const expectedSourceDateEpoch = argumentValue(
    "--expected-source-date-epoch",
    process.env.SOURCE_DATE_EPOCH || ""
  );
  const expectedGeneratedAt = expectedSourceDateEpoch
    ? releaseGeneratedAtFromSourceDateEpoch(expectedSourceDateEpoch)
    : "";
  assert.equal(/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/u.test(expectedChannel), true, "mcp_release_expected_channel_invalid");
  const expectedInputDir = path.join(repoRoot, "build", "release", "mcp");
  assert.equal(inputDir, expectedInputDir, "mcp_release_input_directory_out_of_scope");
  for (const boundary of [
    path.join(repoRoot, "build"),
    path.join(repoRoot, "build", "release"),
    expectedInputDir
  ]) {
    const stat = await fs.lstat(boundary);
    assert.equal(stat.isSymbolicLink(), false, "mcp_release_input_ancestor_symlink_rejected");
    assert.equal(stat.isDirectory(), true, "mcp_release_input_ancestor_not_directory");
  }
  assert.equal(
    await fs.realpath(inputDir),
    await fs.realpath(expectedInputDir),
    "mcp_release_input_realpath_out_of_scope"
  );
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  assert.equal(entries.length > 0, true, "mcp_release_assets_missing");
  assert.equal(
    entries.every((entry) => (
      entry.isFile()
      && !entry.isSymbolicLink()
      && !/[\s\\\u0000-\u001f\u007f]/u.test(entry.name)
    )),
    true,
    "mcp_release_asset_entry_invalid"
  );
  const actualFiles = sorted(entries.map((entry) => entry.name));
  const [manifestText, latestText, packageText, nodeRuntimeLockText] = await Promise.all([
    fs.readFile(path.join(inputDir, "meshrix-mcp-release.json"), "utf8"),
    fs.readFile(path.join(inputDir, "latest.json"), "utf8"),
    fs.readFile(path.join(connectorRoot, "package.json"), "utf8"),
    fs.readFile(nodeRuntimeLockPath, "utf8")
  ]);
  assert.equal(latestText, manifestText, "mcp_release_latest_manifest_mismatch");
  const manifest = JSON.parse(manifestText);
  assert.equal(
    manifestText,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "mcp_release_manifest_not_unique_canonical_json"
  );
  const connectorPackage = JSON.parse(packageText);
  const nodeRuntimeLock = JSON.parse(nodeRuntimeLockText);
  const runtimeSources = await verifyNodeRuntimeSourceEvidence(nodeRuntimeSourceDir, nodeRuntimeLock);
  assert.equal(manifest.channel, expectedChannel, "mcp_release_channel_invalid");
  if (expectedGeneratedAt) {
    assert.equal(
      manifest.generatedAt,
      expectedGeneratedAt,
      "mcp_release_source_date_epoch_mismatch"
    );
  }
  assert.equal(manifest.connector?.packageName, connectorPackage.name, "mcp_release_package_name_mismatch");
  assert.equal(manifest.connector?.packageVersion, connectorPackage.version, "mcp_release_version_mismatch");
  assert.equal(manifest.portable?.includesNodeRuntime, true, "mcp_release_node_runtime_missing");
  assert.equal(
    manifest.portable?.bundledNodeVersion,
    nodeRuntimeLock.version,
    "mcp_release_node_runtime_version_mismatch"
  );

  const declaredFiles = manifest.publish?.releaseFiles;
  assert.equal(Array.isArray(declaredFiles), true, "mcp_release_file_manifest_missing");
  assert.equal(new Set(declaredFiles).size, declaredFiles.length, "mcp_release_file_manifest_duplicate");
  const canonicalConnectorTarball = `${connectorPackage.name}-${connectorPackage.version}.tgz`;
  const canonicalPortableTarballs = expectedPlatforms.map((platform) =>
    `${connectorPackage.name}-${connectorPackage.version}-${platform}.tar.gz`
  );
  const canonicalPortableZips = expectedPlatforms
    .filter((platform) => zipPlatforms.has(platform))
    .map((platform) => `${connectorPackage.name}-${connectorPackage.version}-${platform}.zip`);
  const canonicalBootstrapFiles = [
    "meshrix-mcp-install.sh",
    "meshrix-mcp-uninstall.sh",
    "meshrix-mcp-install.zh-CN.sh",
    "meshrix-mcp-uninstall.zh-CN.sh",
    "meshrix-mcp-install.ps1",
    "meshrix-mcp-uninstall.ps1"
  ];
  assertExactSet(declaredFiles, [
    canonicalConnectorTarball,
    ...canonicalPortableTarballs,
    ...canonicalPortableZips,
    ...canonicalBootstrapFiles,
    "SHA256SUMS",
    "RELEASE_SHA256SUMS",
    "RELEASE_SHA256SUMS.sigstore.json",
    "meshrix-mcp-release.json",
    "latest.json"
  ], "mcp_release_declared_asset_set_mismatch");
  const expectedFiles = declaredFiles.filter((name) => !outerReleaseFiles.has(name));
  assertExactSet(actualFiles, expectedFiles, "mcp_release_exact_asset_set_mismatch");

  const checksumIndex = parseChecksumIndex(await fs.readFile(path.join(inputDir, "SHA256SUMS"), "utf8"));
  assertExactSet(
    checksumIndex.keys(),
    actualFiles.filter((name) => name !== "SHA256SUMS"),
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
  const canonicalManifest = await buildCanonicalManifest({
      inputDir,
      connectorPackage,
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

  const connectorTarball = manifest.connector.tarball;
  assert.equal(connectorTarball, canonicalConnectorTarball, "mcp_release_connector_tarball_name_mismatch");
  assert.equal(
    manifest.connector.sha256,
    checksumIndex.get(connectorTarball),
    "mcp_release_connector_manifest_digest_mismatch"
  );
  const connectorStat = await fs.stat(path.join(inputDir, connectorTarball));
  assert.equal(connectorStat.size, manifest.connector.sizeBytes, "mcp_release_connector_size_mismatch");
  await verifyReproducibleConnectorTarball(inputDir, connectorTarball, manifest.connector.sha256);

  const bootstrapSources = [
    { assetName: manifest.bootstrap?.scriptName, sourceName: "meshrix-mcp-install.sh", digest: manifest.bootstrap?.sha256 },
    { assetName: manifest.bootstrap?.uninstallScriptName, sourceName: "meshrix-mcp-uninstall.sh", digest: manifest.bootstrap?.uninstallSha256 },
    { assetName: manifest.bootstrap?.localized?.zhCN?.scriptName, sourceName: "meshrix-mcp-install.sh", digest: manifest.bootstrap?.localized?.zhCN?.sha256 },
    { assetName: manifest.bootstrap?.localized?.zhCN?.uninstallScriptName, sourceName: "meshrix-mcp-uninstall.sh", digest: manifest.bootstrap?.localized?.zhCN?.uninstallSha256 },
    { assetName: manifest.bootstrap?.windows?.scriptName, sourceName: "meshrix-mcp-install.ps1", digest: manifest.bootstrap?.windows?.sha256 },
    { assetName: manifest.bootstrap?.windows?.uninstallScriptName, sourceName: "meshrix-mcp-uninstall.ps1", digest: manifest.bootstrap?.windows?.uninstallSha256 }
  ];
  assertExactSet(
    bootstrapSources.map(({ assetName }) => assetName),
    canonicalBootstrapFiles,
    "mcp_release_bootstrap_manifest_invalid"
  );
  for (const { assetName, sourceName, digest } of bootstrapSources) {
    assert.ok(assetName, "mcp_release_bootstrap_asset_missing");
    assert.equal(digest, checksumIndex.get(assetName), `mcp_release_bootstrap_digest_mismatch:${assetName}`);
    assert.deepEqual(
      await fs.readFile(path.join(inputDir, assetName)),
      await fs.readFile(path.join(nativeInstallerRoot, sourceName)),
      `mcp_release_bootstrap_source_mismatch:${assetName}`
    );
  }

  const appFiles = await expectedConnectorFiles();
  const portableTarballs = [];
  for (const platform of expectedPlatforms) {
    portableTarballs.push(await verifyPortableArchive({
      inputDir,
      packageName: connectorPackage.name,
      packageVersion: connectorPackage.version,
      platform,
      appFiles,
      runtimeSource: runtimeSources.get(platform)
    }));
  }
  assert.equal(
    manifest.portable.tarball,
    portableTarballs[0],
    "mcp_release_preferred_portable_mismatch"
  );
  assert.equal(
    manifest.portable.sha256,
    checksumIndex.get(portableTarballs[0]),
    "mcp_release_preferred_portable_digest_mismatch"
  );
  const preferredStat = await fs.stat(path.join(inputDir, portableTarballs[0]));
  assert.equal(preferredStat.size, manifest.portable.sizeBytes, "mcp_release_preferred_portable_size_mismatch");

  console.log(JSON.stringify({
    ok: true,
    assetCount: actualFiles.length,
    portableTargetCount: expectedPlatforms.length,
    exactAssetSet: true,
    connectorTarballReproducible: true,
    archiveSourceConvergence: true,
    archiveTarZipConvergence: true
  }));
}

const invokedAsMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsMain) {
  main().catch((error) => {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  });
}

export {
  hashCommand,
  parseChecksumIndex,
  validateArchiveNames
};
