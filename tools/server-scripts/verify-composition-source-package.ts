#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { scanPublicArtifact } from "./lib/public-artifact-boundary.ts";
import {
  AUTHORIZED_VENDORED_PACKAGE_ROOT,
  AUTHORIZED_VENDORED_TARBALL_PATTERN
} from "./lib/source-package-contract.ts";
import { resolveServerSourcePackageIdentity } from "./package-server-source.ts";

const repoRoot: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reportPath: any = path.join(repoRoot, "build", "reports", "composition-source-package.json");

function outputSummary(value: any = "") : any {
  const output: any = String(value || "");
  return {
    outputBytes: Buffer.byteLength(output),
    outputDigest: createHash("sha256").update(output).digest("hex").slice(0, 16)
  };
}

function runCommand(command?: any, args: any = [], options: Record<string, any> = {}) : any {
  const startedAt: any = Date.now();
  const result: any = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      COPYFILE_DISABLE: "1",
      ...(options.env || {})
    },
    maxBuffer: 64 * 1024 * 1024
  });
  return {
    receipt: {
      commandId: String(options.commandId || command),
      status: result.status === 0 ? "passed" : "failed",
      exitCode: result.status,
      durationMs: Date.now() - startedAt,
      ...outputSummary(String(result.stderr || "") + "\n" + String(result.stdout || ""))
    },
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

function runNode(args: any = [], options: Record<string, any> = {}) : any {
  return runCommand(process.execPath, args, {
    ...options,
    commandId: options.commandId || String(args[0] || "node-script")
  });
}

async function sha256File(filePath?: any) : Promise<any> {
  const hash: any = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readJson(filePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function validateArchiveEntries(listOutput?: any, expectedRootName?: any) : any {
  const entries: any = String(listOutput || "")
    .split(/\r?\n/gu)
    .filter(Boolean);
  if (entries.length === 0) throw new Error("composition_source_package_archive_empty");
  const normalizedEntries: any[] = [];
  const seen: any = new Set<any>();
  for (const rawEntry of entries) {
    if (rawEntry.includes("\\") || /[\u0000-\u001f\u007f]/u.test(rawEntry)) {
      throw new Error("composition_source_package_archive_path_invalid");
    }
    const entry: any = rawEntry.replace(/\/+$/u, "");
    const segments: any = entry.split("/");
    if (
      !entry ||
      path.posix.isAbsolute(entry) ||
      segments.some((segment?: any) : any => !segment || segment === "." || segment === "..") ||
      segments[0] !== expectedRootName ||
      seen.has(entry)
    ) {
      throw new Error("composition_source_package_archive_path_invalid");
    }
    seen.add(entry);
    normalizedEntries.push(entry);
  }
  if (!seen.has(expectedRootName)) {
    throw new Error("composition_source_package_archive_root_missing");
  }
  return normalizedEntries;
}

async function assertExtractedTreeSafe(rootPath?: any) : Promise<any> {
  let fileCount: any = 0;
  async function visit(directory?: any) : Promise<any> {
    const entries: any = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath: any = path.join(directory, entry.name);
      const stat: any = await fs.lstat(entryPath);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error("composition_source_package_extracted_entry_invalid");
      }
      if (stat.isDirectory()) await visit(entryPath);
      else fileCount += 1;
    }
  }
  await visit(rootPath);
  return fileCount;
}

async function countPackagedPlugins(sourceRoot?: any) : Promise<any> {
  const pluginRoot: any = path.join(sourceRoot, "plugins");
  const entries: any = await fs.readdir(pluginRoot, { withFileTypes: true });
  let count: any = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPresent: any = await fs.access(path.join(pluginRoot, entry.name, "plugin.json"))
      .then(() : any => true, () : any => false);
    if (manifestPresent) count += 1;
  }
  return count;
}

function parseChecksumFile(text?: any, expectedArchiveName?: any) : any {
  const match: any = /^([a-f0-9]{64})  ([^\r\n]+)\r?\n$/u.exec(String(text || ""));
  if (!match || match[2] !== expectedArchiveName) {
    throw new Error("composition_source_package_checksum_invalid");
  }
  return match[1];
}

function failedArtifactScan() : any {
  const ruleId: any = "artifact_scan_failed";
  const relativePath: any = "artifact-root";
  return {
    schemaVersion: "v0.0.1:release:public-artifact-boundary-scan-1",
    ok: false,
    summary: {
      scannedFileCount: 0,
      scannedTextFileCount: 0,
      skippedBinaryOrOversizedFileCount: 0,
      localPathDetectorExcludedFileCount: 0,
      findingCount: 1,
      ruleFindingCounts: { [ruleId]: 1 }
    },
    findings: [{
      ruleId,
      relativePath,
      digest: createHash("sha256")
        .update(ruleId + "\0" + relativePath)
        .digest("hex")
        .slice(0, 16)
    }]
  };
}

function assertNoReportLeak(report?: any) : any {
  const text: any = JSON.stringify(report);
  if (text.includes(repoRoot) || text.includes(os.homedir())) {
    throw new Error("composition_source_package_report_local_path_leak");
  }
  if (/Bearer\s+(?!\[redacted\])\S+/u.test(text)) {
    throw new Error("composition_source_package_report_bearer_leak");
  }
}

function parseSafePackageCliReport(output?: any) : any {
  const report: any = JSON.parse(output);
  const serialized: any = JSON.stringify(report);
  if (
    serialized.includes(repoRoot) ||
    serialized.includes(tempRoot) ||
    serialized.includes(os.homedir())
  ) {
    throw new Error("composition_source_package_cli_local_path_leak");
  }
  return report;
}

async function stageVerifierDependencyClosure(sourceRoot?: any) : Promise<any> {
  const installedModules: any = path.join(repoRoot, "node_modules");
  const stagedModules: any = path.join(sourceRoot, "node_modules");
  await fs.mkdir(stagedModules, { recursive: true });
  for (const entry of await fs.readdir(installedModules, { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name === "@meshrix") continue;
    await fs.symlink(path.join(installedModules, entry.name), path.join(stagedModules, entry.name), "junction");
  }
  const workspaceScope: any = path.join(stagedModules, "@meshrix");
  await fs.mkdir(workspaceScope, { recursive: true });
  for (const [name, relativeTarget] of (Object.entries({
    agents: "packages/agents",
    capabilities: "packages/capabilities",
    console: "apps/console",
    contracts: "packages/contracts",
    foundation: "packages/foundation",
    protocols: "packages/protocols",
    server: "apps/server",
    "server-runtime": "packages/server-runtime",
    "ui-console": "packages/ui-console"
  }) as [string, any][])) {
    await fs.symlink(path.join(sourceRoot, relativeTarget), path.join(workspaceScope, name), "junction");
  }
}

async function verifyArtifactScannerContract() : Promise<any> {
  const fixtureRoot: any = path.join(tempRoot, "artifact-scanner-contract");
  await fs.mkdir(path.join(fixtureRoot, "docs", "plans"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, "docs", "plans", "private.md"),
    "private process fixture\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(fixtureRoot, "payload.txt"),
    ["gh" + "p_" + "A".repeat(36), repoRoot].join("\n") + "\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(fixtureRoot, "oversized.txt"),
    "x".repeat(8 * 1024 * 1024 + 1),
    "utf8"
  );
  const scan: any = await scanPublicArtifact(fixtureRoot, {
    localNeedles: [repoRoot]
  });
  const ruleIds: any = [...new Set<any>(scan.findings.map((finding?: any) : any => finding.ruleId))].sort();
  const expectedRuleIds: any[] = [
    "github_credential",
    "local_absolute_path",
    "private_process_documentation",
    "text_file_scan_size_limit_exceeded"
  ];
  return {
    ok: scan.ok === false && expectedRuleIds.every((ruleId?: any) : any => ruleIds.includes(ruleId)),
    scannedFileCount: scan.summary.scannedFileCount,
    findingCount: scan.summary.findingCount,
    ruleIds
  };
}

const tempRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-composition-source-package-"));
const packageOutputRoot: any = path.join(tempRoot, "packages");
const extractionRoot: any = path.join(tempRoot, "extracted");
const commands: any[] = [];
const packageIdentity: any = await resolveServerSourcePackageIdentity(repoRoot);
const archivePath: any = path.join(packageOutputRoot, packageIdentity.archiveName);
const checksumPath: any = path.join(packageOutputRoot, packageIdentity.checksumName);
let sourceRoot: any = null;
let manifest: any = null;
let sourceReport: any = null;
let packagedPluginRuntimeReport: any = null;
let artifactBoundaryScan: any = null;
let artifactScannerContract: any = null;
let packageCliReport: any = null;
let archiveEntryCount: any = 0;
let extractedFileCount: any = 0;
let packagedPluginCount: any = 0;
let archiveSha256: any = "";
let archiveSizeBytes: any = 0;
let archiveChecksumReady: any = false;
let forceOutputPreserved: any = false;
let actualArchiveVerified: any = false;
let reproducibleArchiveReady: any = false;

try {
  artifactScannerContract = await verifyArtifactScannerContract();
  await fs.mkdir(path.join(packageOutputRoot, "preserved"), { recursive: true });
  await fs.writeFile(path.join(packageOutputRoot, "preserve.txt"), "preserve\n", "utf8");
  await fs.writeFile(path.join(packageOutputRoot, "preserved", "nested.txt"), "preserve\n", "utf8");
  await fs.writeFile(archivePath, "stale archive\n", "utf8");
  await fs.writeFile(checksumPath, "stale checksum\n", "utf8");
  const packageCommand: any = runNode([
    "tools/server-scripts/package-server-source.ts",
    "--output-dir",
    packageOutputRoot,
    "--force"
  ], { commandId: "package-server-source-initial" });
  commands.push(packageCommand.receipt);
  if (packageCommand.receipt.status === "passed") {
    const initialPackageReport: any = parseSafePackageCliReport(packageCommand.stdout);
    const initialArchiveSha256: any = await sha256File(archivePath);
    const repeatPackageCommand: any = runNode([
      "tools/server-scripts/package-server-source.ts",
      "--output-dir",
      packageOutputRoot,
      "--force"
    ], { commandId: "package-server-source-repeat" });
    commands.push(repeatPackageCommand.receipt);
    if (repeatPackageCommand.receipt.status === "passed") {
      packageCliReport = parseSafePackageCliReport(repeatPackageCommand.stdout);
      archiveSha256 = await sha256File(archivePath);
      reproducibleArchiveReady =
        initialArchiveSha256 === archiveSha256 &&
        initialPackageReport?.artifact?.sha256 === archiveSha256 &&
        initialPackageReport?.source?.packageSha256 === packageCliReport?.source?.packageSha256;
    }
    forceOutputPreserved =
      await fs.readFile(path.join(packageOutputRoot, "preserve.txt"), "utf8") === "preserve\n" &&
      await fs.readFile(path.join(packageOutputRoot, "preserved", "nested.txt"), "utf8") === "preserve\n";
    const outputEntries: any = (await fs.readdir(packageOutputRoot)).sort();
    forceOutputPreserved = forceOutputPreserved && outputEntries.join("\0") === [
      packageIdentity.archiveName,
      packageIdentity.checksumName,
      "preserve.txt",
      "preserved"
    ].sort().join("\0");
    archiveSha256 ||= await sha256File(archivePath);
    archiveSizeBytes = (await fs.stat(archivePath)).size;
    const checksumSha256: any = parseChecksumFile(
      await fs.readFile(checksumPath, "utf8"),
      packageIdentity.archiveName
    );
    archiveChecksumReady =
      checksumSha256 === archiveSha256 &&
      packageCliReport?.artifact?.sha256 === archiveSha256 &&
      packageCliReport?.artifactPath === `[external-output]/${packageIdentity.archiveName}` &&
      packageCliReport?.checksumPath === `[external-output]/${packageIdentity.checksumName}`;

    const listCommand: any = runCommand("tar", ["-tzf", archivePath], {
      commandId: "tar-list-server-source-package"
    });
    commands.push(listCommand.receipt);
    if (listCommand.receipt.status === "passed") {
      archiveEntryCount = validateArchiveEntries(listCommand.stdout, packageIdentity.rootName).length;
      await fs.mkdir(extractionRoot, { recursive: true });
      const extractCommand: any = runCommand("tar", ["-xzf", archivePath, "-C", extractionRoot], {
        commandId: "tar-extract-server-source-package"
      });
      commands.push(extractCommand.receipt);
      if (extractCommand.receipt.status === "passed") {
        sourceRoot = path.join(extractionRoot, packageIdentity.rootName);
        extractedFileCount = await assertExtractedTreeSafe(sourceRoot);
        actualArchiveVerified = extractedFileCount > 0 && archiveEntryCount > extractedFileCount;
      }
    }
  }
  if (sourceRoot && actualArchiveVerified) {
    manifest = await readJson(path.join(sourceRoot, "meshrix-source-package-manifest.json")).catch(() : any => null);
    packagedPluginCount = await countPackagedPlugins(sourceRoot).catch(() : any => 0);
    artifactBoundaryScan = await scanPublicArtifact(sourceRoot, {
      localNeedles: [repoRoot, tempRoot]
    }).catch(() : any => failedArtifactScan());
    const sourceVerifierCommand: any = runNode([
      "tools/server-scripts/verify-composition-source.ts"
    ], { cwd: sourceRoot });
    commands.push(sourceVerifierCommand.receipt);
    sourceReport = await readJson(
      path.join(sourceRoot, "build", "reports", "composition-source.json")
    ).catch(() : any => null);
    await stageVerifierDependencyClosure(sourceRoot);
    const pluginVerifierCommand: any = runNode([
      "tools/server-scripts/verify-plugin-runtime.ts"
    ], { cwd: sourceRoot });
    commands.push(pluginVerifierCommand.receipt);
    packagedPluginRuntimeReport = await readJson(
      path.join(sourceRoot, "build", "reports", "plugin-runtime.json")
    ).catch(() : any => null);
  }

  const failedCommands: any = commands.filter((command?: any) : any => command.status !== "passed");
  const sourceReady: any = sourceReport?.summary?.compositionSourceAcceptanceReady === true;
  const packagedPluginRuntimeReady: any =
    packagedPluginRuntimeReport?.summary?.pluginRuntimeAcceptanceReady === true &&
    packagedPluginRuntimeReport?.summary?.everyCheckParticipates === true &&
    (packagedPluginCount === 0
      ? packagedPluginRuntimeReport?.summary?.executableSelectionReady === true
      : packagedPluginRuntimeReport?.summary?.physicalRemovalProofCount === packagedPluginCount);
  const artifactBoundaryReady: any = artifactBoundaryScan?.ok === true;
  const artifactScannerContractReady: any = artifactScannerContract?.ok === true;
  const pluginSourceRootReady: any =
    Array.isArray(manifest?.copiedRoots) &&
    manifest.copiedRoots.includes("plugins") &&
    packageCliReport?.source?.pluginSourceRootIncluded === true;
  const vendoredSourceRootReady: any =
    Array.isArray(manifest?.copiedRoots) &&
    manifest.copiedRoots.includes(AUTHORIZED_VENDORED_PACKAGE_ROOT) &&
    Array.isArray(manifest?.files) &&
    manifest.files.some((entry?: any) : any =>
      AUTHORIZED_VENDORED_TARBALL_PATTERN.test(String(entry?.path || ""))
    ) &&
    packageCliReport?.source?.vendoredSourceRootIncluded === true &&
    packageCliReport?.source?.authorizedVendoredTarballIncluded === true;
  const portableSourceTargetReady: any =
    manifest?.packagingPlan?.target === "portable-source" &&
    packageCliReport?.source?.target === "portable-source";
  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:release:composition-source-package-report-1",
    generatedAt: new Date().toISOString(),
    verifier: "tools/server-scripts/verify-composition-source-package.ts",
    sourceOfTruth: "tools/server-scripts/package-server-source.ts",
    commands,
    sourceArchive: archiveSha256
      ? {
          artifactName: packageIdentity.archiveName,
          checksumName: packageIdentity.checksumName,
          sizeBytes: archiveSizeBytes,
          sha256: archiveSha256,
          reproducibleAcrossTwoBuilds: reproducibleArchiveReady,
          entryCount: archiveEntryCount,
          extractedFileCount
        }
      : null,
    artifactBoundaryScan,
    artifactScannerContract,
    sourceVerifierSummary: sourceReport
      ? {
          compositionSourceAcceptanceReady:
            sourceReport.summary?.compositionSourceAcceptanceReady === true,
          findingCount: Number(sourceReport.summary?.findingCount || 0),
          licenseBoundaryReady: sourceReport.summary?.licenseBoundaryReady === true,
          dockerBoundaryReady: sourceReport.summary?.dockerBoundaryReady === true,
          internalDocumentationExcluded:
            sourceReport.summary?.internalDocumentationExcluded === true
        }
      : null,
    packagedPluginRuntimeSummary: packagedPluginRuntimeReport
      ? {
          pluginRuntimeAcceptanceReady:
            packagedPluginRuntimeReport.summary?.pluginRuntimeAcceptanceReady === true,
          everyCheckParticipates:
            packagedPluginRuntimeReport.summary?.everyCheckParticipates === true,
          physicalRemovalProofCount:
            Number(packagedPluginRuntimeReport.summary?.physicalRemovalProofCount || 0),
          packagedPluginCount,
          checkCount: Number(packagedPluginRuntimeReport.summary?.checkCount || 0),
          failedCount: Number(packagedPluginRuntimeReport.summary?.failedCount || 0),
          failedChecks: (packagedPluginRuntimeReport.checks || [])
            .filter((check?: any) : any => check?.status !== "passed")
            .map((check?: any) : any => ({ id: String(check?.id || ""), error: String(check?.error || "") }))
        }
      : null,
    packagedVerifierDependencyClosure: {
      mode: "staged-source-with-installed-lockfile-dependencies",
      workspacePackagesResolveInsideStagedSource: true,
      verifierEntryOnlyCopy: false
    },
    summary: {
      compositionSourcePackageAcceptanceReady:
        failedCommands.length === 0 &&
        actualArchiveVerified &&
        archiveChecksumReady &&
        reproducibleArchiveReady &&
        forceOutputPreserved &&
        pluginSourceRootReady &&
        vendoredSourceRootReady &&
        portableSourceTargetReady &&
        sourceReady &&
        packagedPluginRuntimeReady &&
        artifactBoundaryReady &&
        artifactScannerContractReady,
      reportLeakScan: true,
      commandCount: commands.length,
      failedCommandCount: failedCommands.length,
      copiedFileCount: Number(manifest?.copiedFileCount || 0),
      totalBytes: Number(manifest?.totalBytes || 0),
      sourcePackageHashPresent: Boolean(manifest?.packageSha256),
      actualArchiveVerified,
      archiveChecksumReady,
      reproducibleArchiveReady,
      forceOutputPreserved,
      pluginSourceRootReady,
      vendoredSourceRootReady,
      portableSourceTargetReady,
      packagedPluginCount,
      sourceVerifierReady: sourceReady,
      packagedExplicitEmptyPluginSelectionReady: packagedPluginRuntimeReady,
      publicArtifactBoundaryReady: artifactBoundaryReady,
      publicArtifactFindingCount: Number(artifactBoundaryScan?.summary?.findingCount || 0),
      artifactScannerContractReady
    }
  };
  assertNoReportLeak(report);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(
    "[composition-source-package] compositionSourcePackageAcceptanceReady=" +
    report.summary.compositionSourcePackageAcceptanceReady +
    " report=build/reports/composition-source-package.json"
  );
  if (!report.summary.compositionSourcePackageAcceptanceReady) {
    process.exitCode = 1;
  }
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
