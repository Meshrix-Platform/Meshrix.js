#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync: any = promisify(execFile);
const DEFAULT_INPUT_DIR: any = "build/release/mcp";
const DEFAULT_REPORT_PATH: any = "build/reports/mcp-final-release-asset.json";
const REPORT_SCHEMA: any = "v0.0.1:mcp:final-release-asset-report-1";
const RELEASE_PLATFORM: any = "macos-arm64";
const SHA256_PATTERN: any = /^[a-f0-9]{64}$/u;

function argumentValue(argv?: any, index?: any, option?: any) : any {
  const value: any = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`argument_missing:${option}`);
  return value;
}

export function parseFinalReleaseAssetArguments(argv?: any) : any {
  const options: Record<string, any> = {
    inputDir: DEFAULT_INPUT_DIR,
    reportPath: DEFAULT_REPORT_PATH
  };
  for (let index: any = 0; index < argv.length; index += 1) {
    const option: any = argv[index];
    if (option === "--input-dir") {
      options.inputDir = argumentValue(argv, index, option);
      index += 1;
    } else if (option === "--report-path") {
      options.reportPath = argumentValue(argv, index, option);
      index += 1;
    } else {
      throw new Error("mcp_final_release_asset_argument_unknown");
    }
  }
  return options;
}

export function assertMacArmHost(platform: any = process.platform, architecture: any = process.arch) : any {
  if (platform !== "darwin" || architecture !== "arm64") {
    throw new Error("mcp_final_release_asset_host_mismatch");
  }
}

export function parseReleaseChecksumIndex(text?: any) : any {
  const checksums: any = new Map<any, any>();
  for (const line of String(text || "").split(/\r?\n/u)) {
    if (!line) continue;
    const match: any = line.match(/^([a-f0-9]{64}) {2}([^\s\\\u0000-\u001f\u007f]+)$/u);
    if (!match || checksums.has(match[2])) {
      throw new Error("mcp_final_release_asset_checksum_index_invalid");
    }
    checksums.set(match[2], match[1]);
  }
  if (checksums.size === 0) throw new Error("mcp_final_release_asset_checksum_index_invalid");
  return checksums;
}

async function sha256(filePath?: any) : Promise<any> {
  const hash: any = crypto.createHash("sha256");
  const file: any = await fs.open(filePath, "r");
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

async function assertRegularFile(filePath?: any, code?: any) : Promise<any> {
  const stat: any = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(code);
  return stat;
}

async function assertExtractedTree(root?: any) : Promise<any> {
  const entries: any = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child: any = path.join(root, entry.name);
    const stat: any = await fs.lstat(child);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error("mcp_final_release_asset_extracted_entry_invalid");
    }
    if (stat.isDirectory()) await assertExtractedTree(child);
  }
}

async function runPortable(executable?: any, args?: any, isolatedRoot?: any) : Promise<any> {
  const home: any = path.join(isolatedRoot, "home");
  const temporaryDirectory: any = path.join(isolatedRoot, "tmp");
  await Promise.all([
    fs.mkdir(home, { recursive: true, mode: 0o700 }),
    fs.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 })
  ]);
  const result: any = await execFileAsync(executable, args, {
    cwd: path.dirname(executable),
    env: {
      PATH: process.env.PATH || "",
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      TMPDIR: temporaryDirectory,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      ANTIGRAVITY_MCP_CONFIG_ROOT: path.join(home, "antigravity"),
      MESHRIX_MCP_DISCOVERY_FILE: path.join(home, "discovery", "servers.json"),
      MESHRIX_MCP_TOKEN: "",
      MESHRIX_TOOL_TOKEN: ""
    },
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (String(result.stderr || "").trim()) {
    throw new Error("mcp_final_release_asset_unexpected_stderr");
  }
  return String(result.stdout || "");
}

function parseJsonOutput(text?: any, code?: any) : any {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(code);
  }
}

export async function verifyFinalReleaseAsset({ inputDir, reportPath }: Record<string, any>) : Promise<any> {
  assertMacArmHost();
  const inputRoot: any = path.resolve(inputDir);
  const inputStat: any = await fs.lstat(inputRoot);
  if (!inputStat.isDirectory() || inputStat.isSymbolicLink()) {
    throw new Error("mcp_final_release_asset_input_invalid");
  }
  const manifestPath: any = path.join(inputRoot, "meshrix-mcp-release.json");
  const checksumPath: any = path.join(inputRoot, "SHA256SUMS");
  await Promise.all([
    assertRegularFile(manifestPath, "mcp_final_release_asset_manifest_invalid"),
    assertRegularFile(checksumPath, "mcp_final_release_asset_checksum_index_invalid")
  ]);
  const [manifestText, checksumText] = await Promise.all([
    fs.readFile(manifestPath, "utf8"),
    fs.readFile(checksumPath, "utf8")
  ]);
  const manifest: any = parseJsonOutput(manifestText, "mcp_final_release_asset_manifest_invalid");
  const portable: any = manifest.portable;
  const connector: any = manifest.connector;
  if (
    portable?.currentPlatform !== RELEASE_PLATFORM
    || portable?.includesNodeRuntime !== true
    || portable?.requiresInstalledNode !== false
    || portable?.executable !== "meshrix-mcp"
    || !/^v\d+\.\d+\.\d+$/u.test(String(portable?.bundledNodeVersion || ""))
    || typeof connector?.packageName !== "string"
    || typeof connector?.packageVersion !== "string"
  ) {
    throw new Error("mcp_final_release_asset_manifest_semantics_invalid");
  }
  const archiveName: any = `${connector.packageName}-${connector.packageVersion}-${RELEASE_PLATFORM}.tar.gz`;
  if (
    portable.tarball !== archiveName
    || portable.installArchive !== archiveName
    || !SHA256_PATTERN.test(String(portable.sha256 || ""))
    || portable.installArchiveSha256 !== portable.sha256
  ) {
    throw new Error("mcp_final_release_asset_archive_coordinate_invalid");
  }
  const checksums: any = parseReleaseChecksumIndex(checksumText);
  const archivePath: any = path.join(inputRoot, archiveName);
  const archiveStat: any = await assertRegularFile(
    archivePath,
    "mcp_final_release_asset_archive_invalid"
  );
  const archiveDigest: any = await sha256(archivePath);
  if (
    archiveDigest !== portable.sha256
    || archiveDigest !== checksums.get(archiveName)
    || archiveStat.size !== portable.sizeBytes
    || archiveStat.size !== portable.installArchiveSizeBytes
  ) {
    throw new Error("mcp_final_release_asset_archive_digest_mismatch");
  }

  const temporaryRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-final-release-asset-"));
  try {
    const extractRoot: any = path.join(temporaryRoot, "extract");
    await fs.mkdir(extractRoot, { mode: 0o700 });
    await execFileAsync("tar", ["-xzf", archivePath, "-C", extractRoot], {
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024
    });
    const extractedEntries: any = await fs.readdir(extractRoot, { withFileTypes: true });
    const rootName: any = archiveName.slice(0, -".tar.gz".length);
    if (
      extractedEntries.length !== 1
      || !extractedEntries[0].isDirectory()
      || extractedEntries[0].name !== rootName
    ) {
      throw new Error("mcp_final_release_asset_archive_root_invalid");
    }
    const portableRoot: any = path.join(extractRoot, rootName);
    await assertExtractedTree(portableRoot);
    const executable: any = path.join(portableRoot, portable.executable);
    const installer: any = path.join(portableRoot, "meshrix-mcp-install.sh");
    const runtime: any = path.join(portableRoot, "runtime", "node");
    for (const filePath of [executable, installer, runtime]) {
      const stat: any = await assertRegularFile(filePath, "mcp_final_release_asset_executable_invalid");
      if ((stat.mode & 0o111) === 0) throw new Error("mcp_final_release_asset_executable_invalid");
    }

    const runtimeVersion: any = (await runPortable(runtime, ["--version"], temporaryRoot)).trim();
    if (runtimeVersion !== portable.bundledNodeVersion) {
      throw new Error("mcp_final_release_asset_runtime_version_mismatch");
    }
    const versionPayload: any = parseJsonOutput(
      await runPortable(executable, ["version", "--json"], temporaryRoot),
      "mcp_final_release_asset_version_output_invalid"
    );
    const installerPayload: any = parseJsonOutput(
      await runPortable(installer, ["version", "--json"], temporaryRoot),
      "mcp_final_release_asset_installer_output_invalid"
    );
    for (const payload of [versionPayload, installerPayload]) {
      if (
        payload.packageName !== connector.packageName
        || payload.packageVersion !== connector.packageVersion
        || payload.stableToolName !== manifest.stableToolName
      ) {
        throw new Error("mcp_final_release_asset_identity_mismatch");
      }
    }
    const scanPayload: any = parseJsonOutput(
      await runPortable(executable, ["scan", "--json", "--no-scan"], temporaryRoot),
      "mcp_final_release_asset_scan_output_invalid"
    );
    if (
      scanPayload.ok !== true
      || !Array.isArray(scanPayload.candidates)
      || scanPayload.candidates.length === 0
      || !scanPayload.candidates.every((candidate?: any) : any => (
        typeof candidate?.target === "string" && candidate.installed === false
      ))
    ) {
      throw new Error("mcp_final_release_asset_scan_semantics_invalid");
    }

    const report: Record<string, any> = {
      schemaVersion: REPORT_SCHEMA,
      verifier: "tools/server-scripts/verify-mcp-final-release-asset.ts",
      host: { platform: "darwin", architecture: "arm64" },
      asset: {
        name: archiveName,
        sha256: archiveDigest,
        sizeBytes: archiveStat.size,
        platform: RELEASE_PLATFORM
      },
      connector: {
        packageName: connector.packageName,
        packageVersion: connector.packageVersion,
        stableToolName: manifest.stableToolName,
        bundledNodeVersion: runtimeVersion
      },
      probes: {
        launcherVersion: true,
        installerDelegation: true,
        noScanCandidateCount: scanPayload.candidates.length,
        installedCandidateCount: 0
      },
      releaseReady: true
    };
    const outputPath: any = path.resolve(reportPath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    return report;
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() : Promise<any> {
  const options: any = parseFinalReleaseAssetArguments(process.argv.slice(2));
  const report: any = await verifyFinalReleaseAsset(options);
  process.stdout.write(`${JSON.stringify({
    ok: report.releaseReady,
    platform: report.asset.platform,
    packageVersion: report.connector.packageVersion,
    bundledNodeVersion: report.connector.bundledNodeVersion
  })}\n`);
}

const isMain: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error?: any) : any => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: String(error?.message || "mcp_final_release_asset_failed")
    })}\n`);
    process.exitCode = 1;
  });
}
