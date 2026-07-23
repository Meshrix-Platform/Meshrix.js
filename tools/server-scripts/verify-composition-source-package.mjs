#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { scanPublicArtifact } from "./lib/public-artifact-boundary.mjs";
import { resolveServerSourcePackageIdentity } from "./package-server-source.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reportPath = path.join(repoRoot, "build", "reports", "composition-source-package.json");

function outputSummary(value = "") {
  const output = String(value || "");
  return {
    outputBytes: Buffer.byteLength(output),
    outputDigest: createHash("sha256").update(output).digest("hex").slice(0, 16)
  };
}

function runCommand(command, args = [], options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
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

function runNode(args = [], options = {}) {
  return runCommand(process.execPath, args, {
    ...options,
    commandId: options.commandId || String(args[0] || "node-script")
  });
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function validateArchiveEntries(listOutput, expectedRootName) {
  const entries = String(listOutput || "")
    .split(/\r?\n/gu)
    .filter(Boolean);
  if (entries.length === 0) throw new Error("composition_source_package_archive_empty");
  const normalizedEntries = [];
  const seen = new Set();
  for (const rawEntry of entries) {
    if (rawEntry.includes("\\") || /[\u0000-\u001f\u007f]/u.test(rawEntry)) {
      throw new Error("composition_source_package_archive_path_invalid");
    }
    const entry = rawEntry.replace(/\/+$/u, "");
    const segments = entry.split("/");
    if (
      !entry ||
      path.posix.isAbsolute(entry) ||
      segments.some((segment) => !segment || segment === "." || segment === "..") ||
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

async function assertExtractedTreeSafe(rootPath) {
  let fileCount = 0;
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const stat = await fs.lstat(entryPath);
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

async function countPackagedPlugins(sourceRoot) {
  const pluginRoot = path.join(sourceRoot, "plugins");
  const entries = await fs.readdir(pluginRoot, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPresent = await fs.access(path.join(pluginRoot, entry.name, "plugin.json"))
      .then(() => true, () => false);
    if (manifestPresent) count += 1;
  }
  return count;
}

function parseChecksumFile(text, expectedArchiveName) {
  const match = /^([a-f0-9]{64})  ([^\r\n]+)\r?\n$/u.exec(String(text || ""));
  if (!match || match[2] !== expectedArchiveName) {
    throw new Error("composition_source_package_checksum_invalid");
  }
  return match[1];
}

function failedArtifactScan() {
  const ruleId = "artifact_scan_failed";
  const relativePath = "artifact-root";
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

function assertNoReportLeak(report) {
  const text = JSON.stringify(report);
  if (text.includes(repoRoot) || text.includes(os.homedir())) {
    throw new Error("composition_source_package_report_local_path_leak");
  }
  if (/Bearer\s+(?!\[redacted\])\S+/u.test(text)) {
    throw new Error("composition_source_package_report_bearer_leak");
  }
}

function parseSafePackageCliReport(output) {
  const report = JSON.parse(output);
  const serialized = JSON.stringify(report);
  if (
    serialized.includes(repoRoot) ||
    serialized.includes(tempRoot) ||
    serialized.includes(os.homedir())
  ) {
    throw new Error("composition_source_package_cli_local_path_leak");
  }
  return report;
}

async function stageVerifierDependencyClosure(sourceRoot) {
  const installedModules = path.join(repoRoot, "node_modules");
  const stagedModules = path.join(sourceRoot, "node_modules");
  await fs.mkdir(stagedModules, { recursive: true });
  for (const entry of await fs.readdir(installedModules, { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name === "@lico") continue;
    await fs.symlink(path.join(installedModules, entry.name), path.join(stagedModules, entry.name), "junction");
  }
  const workspaceScope = path.join(stagedModules, "@lico");
  await fs.mkdir(workspaceScope, { recursive: true });
  for (const [name, relativeTarget] of Object.entries({
    agents: "packages/agents",
    capabilities: "packages/capabilities",
    console: "apps/console",
    contracts: "packages/contracts",
    foundation: "packages/foundation",
    protocols: "packages/protocols",
    server: "apps/server",
    "server-runtime": "packages/server-runtime",
    "ui-console": "packages/ui-console"
  })) {
    await fs.symlink(path.join(sourceRoot, relativeTarget), path.join(workspaceScope, name), "junction");
  }
}

async function verifyArtifactScannerContract() {
  const fixtureRoot = path.join(tempRoot, "artifact-scanner-contract");
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
  const scan = await scanPublicArtifact(fixtureRoot, {
    localNeedles: [repoRoot]
  });
  const ruleIds = [...new Set(scan.findings.map((finding) => finding.ruleId))].sort();
  const expectedRuleIds = [
    "github_credential",
    "local_absolute_path",
    "private_process_documentation",
    "text_file_scan_size_limit_exceeded"
  ];
  return {
    ok: scan.ok === false && expectedRuleIds.every((ruleId) => ruleIds.includes(ruleId)),
    scannedFileCount: scan.summary.scannedFileCount,
    findingCount: scan.summary.findingCount,
    ruleIds
  };
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lico-composition-source-package-"));
const packageOutputRoot = path.join(tempRoot, "packages");
const extractionRoot = path.join(tempRoot, "extracted");
const commands = [];
const packageIdentity = await resolveServerSourcePackageIdentity(repoRoot);
const archivePath = path.join(packageOutputRoot, packageIdentity.archiveName);
const checksumPath = path.join(packageOutputRoot, packageIdentity.checksumName);
let sourceRoot = null;
let manifest = null;
let sourceReport = null;
let packagedPluginRuntimeReport = null;
let artifactBoundaryScan = null;
let artifactScannerContract = null;
let packageCliReport = null;
let archiveEntryCount = 0;
let extractedFileCount = 0;
let packagedPluginCount = 0;
let archiveSha256 = "";
let archiveSizeBytes = 0;
let archiveChecksumReady = false;
let forceOutputPreserved = false;
let actualArchiveVerified = false;
let reproducibleArchiveReady = false;

try {
  artifactScannerContract = await verifyArtifactScannerContract();
  await fs.mkdir(path.join(packageOutputRoot, "preserved"), { recursive: true });
  await fs.writeFile(path.join(packageOutputRoot, "preserve.txt"), "preserve\n", "utf8");
  await fs.writeFile(path.join(packageOutputRoot, "preserved", "nested.txt"), "preserve\n", "utf8");
  await fs.writeFile(archivePath, "stale archive\n", "utf8");
  await fs.writeFile(checksumPath, "stale checksum\n", "utf8");
  const packageCommand = runNode([
    "tools/server-scripts/package-server-source.mjs",
    "--output-dir",
    packageOutputRoot,
    "--force"
  ], { commandId: "package-server-source-initial" });
  commands.push(packageCommand.receipt);
  if (packageCommand.receipt.status === "passed") {
    const initialPackageReport = parseSafePackageCliReport(packageCommand.stdout);
    const initialArchiveSha256 = await sha256File(archivePath);
    const repeatPackageCommand = runNode([
      "tools/server-scripts/package-server-source.mjs",
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
    const outputEntries = (await fs.readdir(packageOutputRoot)).sort();
    forceOutputPreserved = forceOutputPreserved && outputEntries.join("\0") === [
      packageIdentity.archiveName,
      packageIdentity.checksumName,
      "preserve.txt",
      "preserved"
    ].sort().join("\0");
    archiveSha256 ||= await sha256File(archivePath);
    archiveSizeBytes = (await fs.stat(archivePath)).size;
    const checksumSha256 = parseChecksumFile(
      await fs.readFile(checksumPath, "utf8"),
      packageIdentity.archiveName
    );
    archiveChecksumReady =
      checksumSha256 === archiveSha256 &&
      packageCliReport?.artifact?.sha256 === archiveSha256 &&
      packageCliReport?.artifactPath === `[external-output]/${packageIdentity.archiveName}` &&
      packageCliReport?.checksumPath === `[external-output]/${packageIdentity.checksumName}`;

    const listCommand = runCommand("tar", ["-tzf", archivePath], {
      commandId: "tar-list-server-source-package"
    });
    commands.push(listCommand.receipt);
    if (listCommand.receipt.status === "passed") {
      archiveEntryCount = validateArchiveEntries(listCommand.stdout, packageIdentity.rootName).length;
      await fs.mkdir(extractionRoot, { recursive: true });
      const extractCommand = runCommand("tar", ["-xzf", archivePath, "-C", extractionRoot], {
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
    manifest = await readJson(path.join(sourceRoot, "lico-source-package-manifest.json")).catch(() => null);
    packagedPluginCount = await countPackagedPlugins(sourceRoot).catch(() => 0);
    artifactBoundaryScan = await scanPublicArtifact(sourceRoot, {
      localNeedles: [repoRoot, tempRoot]
    }).catch(() => failedArtifactScan());
    const sourceVerifierCommand = runNode([
      "tools/server-scripts/verify-composition-source.mjs"
    ], { cwd: sourceRoot });
    commands.push(sourceVerifierCommand.receipt);
    sourceReport = await readJson(
      path.join(sourceRoot, "build", "reports", "composition-source.json")
    ).catch(() => null);
    await stageVerifierDependencyClosure(sourceRoot);
    const pluginVerifierCommand = runNode([
      "tools/server-scripts/verify-plugin-runtime.mjs"
    ], { cwd: sourceRoot });
    commands.push(pluginVerifierCommand.receipt);
    packagedPluginRuntimeReport = await readJson(
      path.join(sourceRoot, "build", "reports", "plugin-runtime.json")
    ).catch(() => null);
  }

  const failedCommands = commands.filter((command) => command.status !== "passed");
  const sourceReady = sourceReport?.summary?.compositionSourceAcceptanceReady === true;
  const packagedPluginRuntimeReady =
    packagedPluginRuntimeReport?.summary?.pluginRuntimeAcceptanceReady === true &&
    packagedPluginRuntimeReport?.summary?.everyCheckParticipates === true &&
    (packagedPluginCount === 0
      ? packagedPluginRuntimeReport?.summary?.executableSelectionReady === true
      : packagedPluginRuntimeReport?.summary?.physicalRemovalProofCount === packagedPluginCount);
  const artifactBoundaryReady = artifactBoundaryScan?.ok === true;
  const artifactScannerContractReady = artifactScannerContract?.ok === true;
  const pluginSourceRootReady =
    Array.isArray(manifest?.copiedRoots) &&
    manifest.copiedRoots.includes("plugins") &&
    packageCliReport?.source?.pluginSourceRootIncluded === true;
  const portableSourceTargetReady =
    manifest?.packagingPlan?.target === "portable-source" &&
    packageCliReport?.source?.target === "portable-source";
  const report = {
    schemaVersion: "v0.0.1:release:composition-source-package-report-1",
    generatedAt: new Date().toISOString(),
    verifier: "tools/server-scripts/verify-composition-source-package.mjs",
    sourceOfTruth: "tools/server-scripts/package-server-source.mjs",
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
            .filter((check) => check?.status !== "passed")
            .map((check) => ({ id: String(check?.id || ""), error: String(check?.error || "") }))
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
