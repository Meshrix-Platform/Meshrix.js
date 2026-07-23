import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MCP_CONNECTOR_PACKAGE_NAME,
  MCP_CONNECTOR_VERSION
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter-constants.mjs";
import {
  connectorRoot,
  normalizeReleaseChannel,
  prepareMcpReleaseOutputDirectory,
  projectRoot,
  readJson,
  run,
  sha256,
  writeReleaseChecksumIndex
} from "./lib/mcp-release-common.mjs";
import {
  createBootstrapInstaller,
  releaseGeneratedAtFromSourceDateEpoch,
  releaseManifest
} from "./lib/mcp-release-manifest.mjs";
import { createPortableBundle, resolveBundledNodeVersion } from "./lib/mcp-release-portable.mjs";
import { normalizeMcpPortableTargets } from "./lib/mcp-release-platforms.mjs";

function parseArgs(argv) {
  const valueArguments = new Set([
    "channel",
    "lts-version",
    "node-version",
    "output-dir",
    "platforms",
    "source-date-epoch"
  ]);
  const args = {
    "output-dir": path.join(projectRoot, "build", "release", "mcp"),
    channel: "stable",
    platforms: null,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      throw new Error("mcp_release_positional_argument_not_supported");
    }
    const keyValue = item.slice(2);
    const equalIndex = keyValue.indexOf("=");
    const key = equalIndex >= 0 ? keyValue.slice(0, equalIndex) : keyValue;
    const inlineValue = equalIndex >= 0 ? keyValue.slice(equalIndex + 1) : null;
    if (key === "json") {
      if (inlineValue !== null) {
        throw new Error("mcp_release_flag_value_not_supported");
      }
      args.json = true;
      continue;
    }
    if (!valueArguments.has(key)) {
      throw new Error("mcp_release_unknown_argument");
    }
    const next = argv[index + 1];
    const value = inlineValue !== null ? inlineValue : !next || next.startsWith("--") ? "" : next;
    if (!value) {
      throw new Error("mcp_release_argument_value_required");
    }
    if (inlineValue === null) {
      index += 1;
    }
    args[key] = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["node-version"] || args["lts-version"]) {
    throw new Error("node_runtime_version_override_not_supported");
  }
  const channel = normalizeReleaseChannel(args.channel);
  const generatedAt = releaseGeneratedAtFromSourceDateEpoch(
    args["source-date-epoch"] || process.env.SOURCE_DATE_EPOCH
  );
  let outputDir = null;
  try {
    outputDir = await prepareMcpReleaseOutputDirectory(args["output-dir"]);
    const packageJson = await readJson(path.join(connectorRoot, "package.json"));
  assert.equal(packageJson.name, MCP_CONNECTOR_PACKAGE_NAME);
  assert.equal(packageJson.version, MCP_CONNECTOR_VERSION);

  const pack = await run("npm", ["pack", "--json", "--pack-destination", outputDir], {
    cwd: connectorRoot
  });
  const packResult = JSON.parse(pack.stdout || "[]")[0];
  if (!packResult?.filename) {
    throw new Error("npm pack did not return a tarball filename.");
  }
  const tarballPath = path.join(outputDir, packResult.filename);
  const stat = await fs.stat(tarballPath);
  const checksum = await sha256(tarballPath);
  const portables = [];
  const targets = normalizeMcpPortableTargets(args.platforms);
  const bundledVersion = await resolveBundledNodeVersion();
  for (const target of targets) {
    const portable = await createPortableBundle({
      outputDir,
      packageJson,
      target,
      bundledVersion
    });
    portables.push(portable);
    await Promise.all([
      fs.rm(path.join(outputDir, portable.rootName), { recursive: true, force: true }),
      fs.rm(path.join(outputDir, `extracted-${target}`), { recursive: true, force: true })
    ]);
  }
  const bootstrap = await createBootstrapInstaller({
    outputDir,
    packageJson,
    tarballName: packResult.filename,
    tarballSha256: checksum,
    portables
  });
  const manifest = releaseManifest({
    channel,
    packageJson,
    tarballName: packResult.filename,
    tarballPath,
    checksum,
    sizeBytes: stat.size,
    portables,
    bootstrap,
    generatedAt
  });
  const manifestPath = path.join(outputDir, "lico-mcp-release.json");
  const latestPath = path.join(outputDir, "latest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(latestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const outputEntries = await fs.readdir(outputDir, { withFileTypes: true });
  if (outputEntries.some((entry) => !entry.isFile())) {
    throw new Error("release_output_contains_non_file_entry");
  }
  const checksumIndex = await writeReleaseChecksumIndex(outputDir);
  const publicReleasePath = (value) => path.relative(projectRoot, value).split(path.sep).join("/");

  const result = {
    ok: true,
    outputDir: publicReleasePath(outputDir),
    manifestPath: publicReleasePath(manifestPath),
    latestPath: publicReleasePath(latestPath),
    checksumFilePath: publicReleasePath(checksumIndex.checksumFilePath),
    checksumFileSha256: checksumIndex.checksumFileSha256,
    bootstrapInstallerPath: publicReleasePath(bootstrap.scriptPath),
    tarballPath: publicReleasePath(tarballPath),
    portableTarballs: portables.map((p) => publicReleasePath(p.archivePath)),
    portableZips: portables.map((p) => p.zipArchivePath).filter(Boolean).map(publicReleasePath),
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    sha256: checksum,
    portableSha256: portables.map(p => p.sha256),
    portableZipSha256: portables.map((p) => p.zipSha256).filter(Boolean),
    bootstrapInstallerSha256: bootstrap.sha256,
    bootstrapUninstallerPath: publicReleasePath(bootstrap.uninstallScriptPath),
    bootstrapUninstallerSha256: bootstrap.uninstallSha256,
    bootstrapInstallerZhCNPath: publicReleasePath(bootstrap.localized.zhCN.scriptPath),
    bootstrapInstallerZhCNSha256: bootstrap.localized.zhCN.sha256,
    bootstrapUninstallerZhCNPath: publicReleasePath(bootstrap.localized.zhCN.uninstallScriptPath),
    bootstrapUninstallerZhCNSha256: bootstrap.localized.zhCN.uninstallSha256,
    githubOneLineCommand: bootstrap.oneLineCommand,
    githubOneLineClientInstallJsonCommand: bootstrap.oneLineClientInstallJsonCommand,
    githubOneLineUninstallCommand: bootstrap.oneLineUninstallCommand,
    githubOneLineAutoInstallCommand: bootstrap.oneLineAutoInstallCommand,
    githubOneLinePriorityInstallCommand: bootstrap.oneLinePriorityInstallCommand,
    githubOneLineCommandZhCN: bootstrap.localized.zhCN.oneLineCommand,
    githubOneLineClientInstallJsonCommandZhCN: bootstrap.localized.zhCN.oneLineClientInstallJsonCommand,
    githubOneLineAutoInstallCommandZhCN: bootstrap.localized.zhCN.oneLineAutoInstallCommand,
    githubOneLinePriorityInstallCommandZhCN: bootstrap.localized.zhCN.oneLinePriorityInstallCommand,
    githubOneLineUninstallCommandZhCN: bootstrap.localized.zhCN.oneLineUninstallCommand,
    oneCommandInstall: bootstrap.oneLineCommand,
    oneCommandInstallZhCN: bootstrap.localized.zhCN.oneLineCommand,
    oneCommandClientInstallJson: bootstrap.oneLineClientInstallJsonCommand,
    oneCommandClientInstallJsonZhCN: bootstrap.localized.zhCN.oneLineClientInstallJsonCommand,
    oneCommandAutoInstall: bootstrap.oneLineAutoInstallCommand,
    oneCommandAutoInstallZhCN: bootstrap.localized.zhCN.oneLineAutoInstallCommand,
    oneCommandPriorityInstall: bootstrap.oneLinePriorityInstallCommand,
    oneCommandPriorityInstallZhCN: bootstrap.localized.zhCN.oneLinePriorityInstallCommand,
    oneCommandUninstall: bootstrap.oneLineUninstallCommand,
    oneCommandUninstallZhCN: bootstrap.localized.zhCN.oneLineUninstallCommand,
    installCommand: manifest.install.registryCommand
  };
    console.log(args.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  } catch (error) {
    if (outputDir) {
      await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
