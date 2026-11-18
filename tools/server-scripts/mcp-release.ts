import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MCP_NPM_PACKAGE_NAME,
  MCP_NPM_PACKAGE_VERSION
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter-constants.ts";
import {
  normalizeReleaseChannel,
  prepareMcpReleaseOutputDirectory,
  projectRoot,
  readJson,
  sha256,
  writeReleaseChecksumIndex
} from "./lib/mcp-release-common.ts";
import { loadPreparedReleaseSet } from "./publish-release-set.ts";
import {
  releaseGeneratedAtFromSourceDateEpoch,
  releaseManifest
} from "./lib/mcp-release-manifest.ts";
import { createPortableBundle, resolveBundledNodeVersion } from "./lib/mcp-release-portable.ts";
import { normalizeMcpPortableTargets } from "./lib/mcp-release-platforms.ts";

function parseArgs(argv?: any) : any {
  const valueArguments: any = new Set<any>([
    "channel",
    "lts-version",
    "node-version",
    "output-dir",
    "platforms",
    "source-date-epoch",
    "artifact-dir"
  ]);
  const args: Record<string, any> = {
    "output-dir": path.join(projectRoot, "build", "release", "mcp"),
    channel: "stable",
    platforms: null,
    json: false
  };
  for (let index: any = 0; index < argv.length; index += 1) {
    const item: any = argv[index];
    if (!item.startsWith("--")) {
      throw new Error("mcp_release_positional_argument_not_supported");
    }
    const keyValue: any = item.slice(2);
    const equalIndex: any = keyValue.indexOf("=");
    const key: any = equalIndex >= 0 ? keyValue.slice(0, equalIndex) : keyValue;
    const inlineValue: any = equalIndex >= 0 ? keyValue.slice(equalIndex + 1) : null;
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
    const next: any = argv[index + 1];
    const value: any = inlineValue !== null ? inlineValue : !next || next.startsWith("--") ? "" : next;
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

async function main() : Promise<any> {
  const args: any = parseArgs(process.argv.slice(2));
  if (args["node-version"] || args["lts-version"]) {
    throw new Error("node_runtime_version_override_not_supported");
  }
  if (!args["artifact-dir"]) {
    throw new Error("mcp_prepared_artifact_directory_required");
  }
  const channel: any = normalizeReleaseChannel(args.channel);
  const generatedAt: any = releaseGeneratedAtFromSourceDateEpoch(
    args["source-date-epoch"] || process.env.SOURCE_DATE_EPOCH
  );
  let outputDir: any = null;
  try {
    outputDir = await prepareMcpReleaseOutputDirectory(args["output-dir"]);
    const packageJson: any = await readJson(path.join(projectRoot, "package.json"));
    assert.equal(packageJson.name, MCP_NPM_PACKAGE_NAME);
    assert.equal(packageJson.version, MCP_NPM_PACKAGE_VERSION);
    const preparedReleaseSet: any = await loadPreparedReleaseSet({
      rootDir: projectRoot,
      artifactDirectory: path.resolve(args["artifact-dir"])
    });
    const rootArtifact: any = preparedReleaseSet.packages.find(
      ({ name }: Record<string, any>) : any => name === packageJson.name
    );
    assert.ok(rootArtifact, "mcp_prepared_root_artifact_missing");
    assert.equal(rootArtifact.version, packageJson.version, "mcp_prepared_root_version_mismatch");
    assert.match(rootArtifact.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u, "mcp_prepared_root_integrity_invalid");
    const tarballPath: any = path.join(outputDir, rootArtifact.filename);
    await fs.copyFile(rootArtifact.tarballPath, tarballPath);
    const packResult: any = { filename: rootArtifact.filename };
    const stat: any = await fs.stat(tarballPath);
    const checksum: any = await sha256(tarballPath);
    const portables: any[] = [];
    const targets: any = normalizeMcpPortableTargets(args.platforms);
    const bundledVersion: any = await resolveBundledNodeVersion();
    for (const target of targets) {
      const portable: any = await createPortableBundle({
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
    const manifest: any = releaseManifest({
      channel,
      packageJson,
      tarballName: packResult.filename,
      npmIntegrity: rootArtifact.integrity,
      checksum,
      sizeBytes: stat.size,
      portables,
      generatedAt
    });
    const manifestPath: any = path.join(outputDir, "meshrix-mcp-release.json");
    const latestPath: any = path.join(outputDir, "latest.json");
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(latestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const outputEntries: any = await fs.readdir(outputDir, { withFileTypes: true });
    if (outputEntries.some((entry?: any) : any => !entry.isFile())) {
      throw new Error("release_output_contains_non_file_entry");
    }
    const checksumIndex: any = await writeReleaseChecksumIndex(outputDir);
    const publicReleasePath: any = (value?: any) : any => path.relative(projectRoot, value).split(path.sep).join("/");

    const result: Record<string, any> = {
      ok: true,
      outputDir: publicReleasePath(outputDir),
      manifestPath: publicReleasePath(manifestPath),
      latestPath: publicReleasePath(latestPath),
      checksumFilePath: publicReleasePath(checksumIndex.checksumFilePath),
      checksumFileSha256: checksumIndex.checksumFileSha256,
      tarballPath: publicReleasePath(tarballPath),
      portableTarballs: portables.map((p?: any) : any => publicReleasePath(p.archivePath)),
      portableZips: portables.map((p?: any) : any => p.zipArchivePath).filter(Boolean).map(publicReleasePath),
      releaseFiles: manifest.publish.releaseFiles,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      npmIntegrity: rootArtifact.integrity,
      sha256: checksum,
      portableSha256: portables.map((p?: any) : any => p.sha256),
      installCommand: manifest.install.registryCommand
    };
    console.log(args.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  } catch (error: any) {
    if (outputDir) {
      await fs.rm(outputDir, { recursive: true, force: true }).catch(() : any => {});
    }
    throw error;
  }
}

main().catch((error?: any) : any => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
