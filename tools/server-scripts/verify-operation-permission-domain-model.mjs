#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_API_OPERATIONS } from "#meshrix/contracts/operations/operation-registry";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_REPORT_PATH = "build/reports/operation-permission-domain-model.json";
const SENSITIVE_REPORT_PATTERNS = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\])/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{16,}\b|xox[baprs]-[A-Za-z0-9-]{16,}/u],
  ["runtime_id", /relay_session_[A-Za-z0-9_-]+|relay_turn_[A-Za-z0-9_-]+|delegated_mcp_[A-Za-z0-9_-]+|tool_exec_[A-Za-z0-9_-]+|pending_op_[A-Za-z0-9_-]+/u],
  ["grant_runtime_id", /grant_[a-z0-9]{6,}_[a-f0-9]{8,}/u]
]);

function parseArgs(argv) {
  const options = {
    allowOpenGaps: false,
    report: DEFAULT_REPORT_PATH
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-open-gaps") {
      options.allowOpenGaps = true;
      continue;
    }
    if (arg === "--report") {
      options.report = takeValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function takeValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage:
  node tools/server-scripts/verify-operation-permission-domain-model.mjs
  node tools/server-scripts/verify-operation-permission-domain-model.mjs --allow-open-gaps

Options:
  --allow-open-gaps  Write the report and exit 0 even when the domain model is not release-ready.
  --report <path>    Report JSON path. Defaults to ${DEFAULT_REPORT_PATH}.`);
}

function repoPath(...parts) {
  return path.join(repoRoot, ...parts);
}

async function readText(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function readJson(relativeFile) {
  return JSON.parse(await readText(repoPath(relativeFile)));
}

async function verifyEntityConfigManifests() {
  const expected = [
    ["packages/foundation/config/entity-config/tools/manifest.json", "meshrix.operation-permission.entities"],
    ["packages/foundation/config/entity-config/tools/toolsets/manifest.json", "meshrix.operation-permission.toolsets"],
    ["packages/foundation/config/entity-config/tools/scopes/manifest.json", "meshrix.operation-permission.scopes"],
    ["packages/foundation/config/entity-config/tools/profiles/manifest.json", "meshrix.operation-permission.profiles"]
  ];
  const manifests = [];
  for (const [file, expectedEntityType] of expected) {
    const manifest = await readJson(file);
    manifests.push({
      path: file,
      entityType: String(manifest.entityType || ""),
      expectedEntityType,
      ok: String(manifest.entityType || "") === expectedEntityType
    });
  }
  return {
    ok: manifests.every((manifest) => manifest.ok),
    manifests
  };
}

function createFindings({ entityConfig }) {
  const findings = [];
  if (!entityConfig.ok) {
    findings.push({
      severity: "P0",
      code: "operation_permission_entity_config_invalid",
      message: "Entity config manifests must use current Operation Permission entity types.",
      manifests: entityConfig.manifests.filter((manifest) => !manifest.ok)
    });
  }
  return findings;
}

function assertNoReportLeak(report) {
  const text = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Operation Permission domain model report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const operationPermissionSignals = SERVER_API_OPERATIONS
    .filter((operation) =>
      String(operation.id || "").startsWith("authorization.") ||
      String(operation.id || "").startsWith("tag_management.")
    )
    .map((operation) => operation.id)
    .sort();
  const entityConfig = await verifyEntityConfigManifests();
  const findings = createFindings({ entityConfig });
  const blockingFindings = findings.filter((finding) => ["P0", "P1"].includes(finding.severity));
  const report = {
    schemaVersion: "v0.0.1:operation-permission:domain-model-audit-1",
    verifier: "tools/server-scripts/verify-operation-permission-domain-model.mjs",
    generatedAt: new Date().toISOString(),
    auditReady: true,
    releaseReady: blockingFindings.length === 0,
    operationPermissionSignals,
    entityConfig,
    findings,
    currentChecks: {
      operationPermissionEntityConfigValid: entityConfig.ok,
      reportLeakScan: true
    }
  };
  assertNoReportLeak(report);
  await fs.mkdir(repoPath(path.dirname(options.report)), { recursive: true });
  await fs.writeFile(repoPath(options.report), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`[operation-permission-domain-model] report=${options.report}`);
  console.log(`[operation-permission-domain-model] findings=${findings.length} releaseReady=${report.releaseReady}`);
  if (!report.releaseReady && !options.allowOpenGaps) {
    for (const finding of findings.slice(0, 12)) {
      console.error(`- ${finding.severity} ${finding.code}: ${finding.message}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
