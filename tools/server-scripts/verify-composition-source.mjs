#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  INTERNAL_SOURCE_PACKAGE_EXCLUDED_PATHS,
  ROOT_SOURCE_FILES,
  SOURCE_PACKAGE_ROOTS
} from "./package-server-source.mjs";
import { scanPublicArtifact } from "./lib/public-artifact-boundary.mjs";

const sourceRoot = process.cwd();
const reportPath = path.join(sourceRoot, "build", "reports", "composition-source.json");
const manifestPath = path.join(sourceRoot, "lico-source-package-manifest.json");
const KEY_SYNTAX_FILES = Object.freeze([
  "tools/server-scripts/start-server.mjs",
  "tools/server-scripts/package-server-source.mjs",
  "tools/server-scripts/verify-platform-acceptance.mjs",
  "tools/server-scripts/verify-composition-source-package.mjs",
  "tools/server-scripts/verify-composition-source.mjs",
  "tools/server-scripts/lib/public-artifact-boundary.mjs",
  "tools/scripts/package-script-registry.mjs"
]);
const PROHIBITED_PACKAGE_PATHS = Object.freeze([
  ".git",
  "node_modules",
  "build/acceptance-evidence",
  "build/reports/script-registry.json",
  ...INTERNAL_SOURCE_PACKAGE_EXCLUDED_PATHS
]);
const REQUIRED_DOCKERIGNORE_ENTRIES = Object.freeze([
  ".cache",
  "**/.cache",
  "docs/plans",
  "docs/reports",
  "**/downloads",
  "packages/capabilities/runtime-modules/knowledge/runtime/jre",
  "packages/capabilities/runtime-modules/knowledge/tika",
  "packages/capabilities/runtime-modules/knowledge/ocr/runtime"
]);
const SENSITIVE_PATTERNS = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\])\S+/u],
  ["secret_token", /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9._-]{8,}\b/u]
]);

async function exists(relativePath) {
  try {
    await fs.access(path.join(sourceRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readText(relativePath) {
  return fs.readFile(path.join(sourceRoot, relativePath), "utf8");
}

function isCompleteGpl3Text(text = "") {
  const value = String(text || "").replace(/\r\n/gu, "\n");
  return value.length > 30000 &&
    value.includes("GNU GENERAL PUBLIC LICENSE") &&
    value.includes("Version 3, 29 June 2007") &&
    value.includes("17. Interpretation of Sections 15 and 16.") &&
    value.includes("END OF TERMS AND CONDITIONS");
}

async function sha256File(relativePath) {
  const content = await fs.readFile(path.join(sourceRoot, relativePath));
  return createHash("sha256").update(content).digest("hex");
}

function assertNoLeak(report) {
  const text = JSON.stringify(report);
  assert.equal(text.includes(sourceRoot), false, "composition source report leaked source root");
  assert.equal(text.includes(os.homedir()), false, "composition source report leaked home path");
  for (const [kind, pattern] of SENSITIVE_PATTERNS) {
    assert.equal(pattern.test(text), false, `composition source report leaked ${kind}`);
  }
}

function syntaxCheck(relativePath) {
  const result = spawnSync(process.execPath, ["--check", relativePath], {
    cwd: sourceRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return {
    file: relativePath,
    ok: result.status === 0
  };
}

const findings = [];
const manifest = await readJson(manifestPath).catch((error) => {
  findings.push({
    code: "manifest_unreadable",
    detail: "lico-source-package-manifest.json",
    errorCode: String(error?.code || "invalid_json")
  });
  return null;
});

if (manifest) {
  if (manifest.schemaVersion !== "v0.0.1:release:source-package-manifest-4") {
    findings.push({ code: "manifest_schema_mismatch", detail: String(manifest.schemaVersion || "") });
  }
  for (const root of SOURCE_PACKAGE_ROOTS) {
    if (!await exists(root)) {
      findings.push({ code: "source_root_missing", detail: root });
    }
  }
  for (const rootFile of ROOT_SOURCE_FILES.filter((file) => manifest.rootFiles?.includes(file))) {
    if (!await exists(rootFile)) {
      findings.push({ code: "root_file_missing", detail: rootFile });
    }
  }
  const fileEntries = Array.isArray(manifest.files) ? manifest.files : [];
  if (fileEntries.length === 0) {
    findings.push({ code: "manifest_files_empty", detail: "files" });
  }
  for (const excludedPath of INTERNAL_SOURCE_PACKAGE_EXCLUDED_PATHS) {
    if (!Array.isArray(manifest.excludedPaths) || !manifest.excludedPaths.includes(excludedPath)) {
      findings.push({ code: "manifest_excluded_path_missing", detail: excludedPath });
    }
  }
  for (const entry of fileEntries) {
    if (!entry.path || entry.path.startsWith("/") || entry.path.split("/").includes("..")) {
      findings.push({ code: "manifest_file_path_unsafe", detail: String(entry.path || "") });
      continue;
    }
    if (INTERNAL_SOURCE_PACKAGE_EXCLUDED_PATHS.some((excludedPath) =>
      entry.path === excludedPath || entry.path.startsWith(`${excludedPath}/`)
    )) {
      findings.push({ code: "manifest_internal_doc_path_present", detail: entry.path });
      continue;
    }
    if (!await exists(entry.path)) {
      findings.push({ code: "manifest_file_missing", detail: entry.path });
      continue;
    }
    const actualHash = await sha256File(entry.path);
    if (actualHash !== entry.sha256) {
      findings.push({ code: "manifest_file_hash_mismatch", detail: entry.path });
    }
  }
  for (const removedPath of manifest.featurePackagePlan?.removePaths || []) {
    if (await exists(removedPath)) {
      findings.push({ code: "feature_removed_package_path_present", detail: removedPath });
    }
    if (fileEntries.some((entry) => entry.path === removedPath || entry.path.startsWith(`${removedPath}/`))) {
      findings.push({ code: "feature_removed_manifest_entry_present", detail: removedPath });
    }
  }
}

const rootLicense = await readText("LICENSE").catch(() => "");
const connectorLicense = await readText(
  "packages/protocols/mcp/adapter/gateway-installer/LICENSE"
).catch(() => "");
if (!isCompleteGpl3Text(rootLicense)) {
  findings.push({ code: "root_gpl_license_incomplete", detail: "LICENSE" });
}
if (!isCompleteGpl3Text(connectorLicense)) {
  findings.push({
    code: "connector_gpl_license_incomplete",
    detail: "packages/protocols/mcp/adapter/gateway-installer/LICENSE"
  });
}
if (rootLicense && connectorLicense && rootLicense !== connectorLicense) {
  findings.push({
    code: "connector_gpl_license_mismatch",
    detail: "packages/protocols/mcp/adapter/gateway-installer/LICENSE"
  });
}
const dockerfile = await readText("Dockerfile").catch(() => "");
const dockerLicenseCopyCount = (dockerfile.match(/^COPY[^\n]*\bLICENSE\b[^\n]*$/gmu) || []).length;
if (dockerLicenseCopyCount < 2) {
  findings.push({ code: "docker_license_copy_missing", detail: "Dockerfile" });
}
const dockerignore = await readText(".dockerignore").catch(() => "");
const dockerignoreEntries = new Set(
  dockerignore
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
);
for (const requiredEntry of REQUIRED_DOCKERIGNORE_ENTRIES) {
  if (!dockerignoreEntries.has(requiredEntry)) {
    findings.push({
      code: "dockerignore_public_boundary_entry_missing",
      detail: ".dockerignore",
      ruleId: requiredEntry
    });
  }
}

for (const relativePath of PROHIBITED_PACKAGE_PATHS) {
  if (await exists(relativePath)) {
    findings.push({ code: "prohibited_package_path_present", detail: relativePath });
  }
}

const syntaxChecks = KEY_SYNTAX_FILES.map(syntaxCheck);
for (const check of syntaxChecks) {
  if (!check.ok) {
    findings.push({ code: "syntax_check_failed", detail: check.file });
  }
}

let artifactBoundaryScan = null;
try {
  artifactBoundaryScan = await scanPublicArtifact(sourceRoot, {
    localNeedles: [sourceRoot]
  });
  for (const finding of artifactBoundaryScan.findings) {
    findings.push({
      code: "public_artifact_boundary_violation",
      detail: finding.relativePath,
      ruleId: finding.ruleId,
      digest: finding.digest,
      ...(finding.line ? { line: finding.line } : {})
    });
  }
} catch (error) {
  findings.push({
    code: "public_artifact_boundary_scan_failed",
    detail: "artifact-root",
    errorCode: String(error?.code || "scan_failed")
  });
}

const report = {
  schemaVersion: "v0.0.1:release:composition-source-report-2",
  generatedAt: new Date().toISOString(),
  verifier: "tools/server-scripts/verify-composition-source.mjs",
  sourceOfTruth: "tools/server-scripts/package-server-source.mjs",
  summary: {
    compositionSourceAcceptanceReady: findings.length === 0,
    reportLeakScan: true,
    copiedFileCount: Number(manifest?.copiedFileCount || 0),
    totalBytes: Number(manifest?.totalBytes || 0),
    featureRemovedPathCount: Number(manifest?.featurePackagePlan?.removePaths?.length || 0),
    findingCount: findings.length,
    syntaxCheckCount: syntaxChecks.length,
    publicArtifactBoundaryReady: artifactBoundaryScan?.ok === true,
    publicArtifactScannedFileCount: Number(artifactBoundaryScan?.summary?.scannedFileCount || 0),
    publicArtifactScannedTextFileCount: Number(artifactBoundaryScan?.summary?.scannedTextFileCount || 0),
    licenseBoundaryReady: !findings.some((finding) =>
      String(finding.code || "").includes("gpl_license") ||
      finding.code === "docker_license_copy_missing"
    ),
    dockerBoundaryReady: !findings.some((finding) =>
      finding.code === "docker_license_copy_missing" ||
      finding.code === "dockerignore_public_boundary_entry_missing"
    ),
    internalDocumentationExcluded: INTERNAL_SOURCE_PACKAGE_EXCLUDED_PATHS.every((relativePath) =>
      !findings.some((finding) => {
        const detail = String(finding.detail || "");
        return detail === relativePath || detail.startsWith(relativePath + "/");
      })
    )
  },
  syntaxChecks: syntaxChecks.map((check) => ({ file: check.file, ok: check.ok })),
  artifactBoundaryScan: artifactBoundaryScan
    ? {
        schemaVersion: artifactBoundaryScan.schemaVersion,
        summary: artifactBoundaryScan.summary,
        findings: artifactBoundaryScan.findings
      }
    : null,
  findings
};
assertNoLeak(report);
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`[composition-source] compositionSourceAcceptanceReady=${report.summary.compositionSourceAcceptanceReady} report=build/reports/composition-source.json`);
if (!report.summary.compositionSourceAcceptanceReady) {
  process.exitCode = 1;
}
