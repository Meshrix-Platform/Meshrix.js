#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_API_OPERATIONS } from "#meshrix/contracts/operations/operation-registry";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_REPORT_PATH: any = "build/reports/operation-permission-domain-model.json";
const SENSITIVE_REPORT_PATTERNS: readonly any[] = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\])/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{16,}\b|xox[baprs]-[A-Za-z0-9-]{16,}/u],
  ["runtime_id", /relay_session_[A-Za-z0-9_-]+|relay_turn_[A-Za-z0-9_-]+|delegated_mcp_[A-Za-z0-9_-]+|tool_exec_[A-Za-z0-9_-]+|pending_op_[A-Za-z0-9_-]+/u],
  ["grant_runtime_id", /grant_[a-z0-9]{6,}_[a-f0-9]{8,}/u]
]);

function parseArgs(argv?: any) : any {
  const options: Record<string, any> = {
    allowOpenGaps: false,
    report: DEFAULT_REPORT_PATH
  };
  for (let index: any = 0; index < argv.length; index += 1) {
    const arg: any = argv[index];
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

function takeValue(argv?: any, index?: any, flag?: any) : any {
  const value: any = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() : any {
  console.log(`Usage:
  node tools/server-scripts/verify-operation-permission-domain-model.ts
  node tools/server-scripts/verify-operation-permission-domain-model.ts --allow-open-gaps

Options:
  --allow-open-gaps  Write the report and exit 0 even when the domain model is not release-ready.
  --report <path>    Report JSON path. Defaults to ${DEFAULT_REPORT_PATH}.`);
}

function repoPath(...parts: any[]) : any {
  return path.join(repoRoot, ...parts);
}

async function readText(filePath?: any) : Promise<any> {
  return fs.readFile(filePath, "utf8");
}

async function readJson(relativeFile?: any) : Promise<any> {
  return JSON.parse(await readText(repoPath(relativeFile)));
}

async function verifyEntityConfigManifests() : Promise<any> {
  const expected: any[] = [
    ["packages/foundation/config/entity-config/tools/manifest.json", "meshrix.operation-permission.entities"],
    ["packages/foundation/config/entity-config/tools/toolsets/manifest.json", "meshrix.operation-permission.toolsets"],
    ["packages/foundation/config/entity-config/tools/scopes/manifest.json", "meshrix.operation-permission.scopes"],
    ["packages/foundation/config/entity-config/tools/profiles/manifest.json", "meshrix.operation-permission.profiles"]
  ];
  const manifests: any[] = [];
  for (const [file, expectedEntityType] of expected) {
    const manifest: any = await readJson(file);
    manifests.push({
      path: file,
      entityType: String(manifest.entityType || ""),
      expectedEntityType,
      ok: String(manifest.entityType || "") === expectedEntityType
    });
  }
  return {
    ok: manifests.every((manifest?: any) : any => manifest.ok),
    manifests
  };
}

function createFindings({ entityConfig }: Record<string, any>) : any {
  const findings: any[] = [];
  if (!entityConfig.ok) {
    findings.push({
      severity: "P0",
      code: "operation_permission_entity_config_invalid",
      message: "Entity config manifests must use current Operation Permission entity types.",
      manifests: entityConfig.manifests.filter((manifest?: any) : any => !manifest.ok)
    });
  }
  return findings;
}

function assertNoReportLeak(report?: any) : any {
  const text: any = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Operation Permission domain model report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

async function main() : Promise<any> {
  const options: any = parseArgs(process.argv.slice(2));
  const operationPermissionSignals: any = SERVER_API_OPERATIONS
    .filter((operation?: any) : any =>
      String(operation.id || "").startsWith("authorization.") ||
      String(operation.id || "").startsWith("tag_management.")
    )
    .map((operation?: any) : any => operation.id)
    .sort();
  const entityConfig: any = await verifyEntityConfigManifests();
  const findings: any = createFindings({ entityConfig });
  const blockingFindings: any = findings.filter((finding?: any) : any => ["P0", "P1"].includes(finding.severity));
  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:operation-permission:domain-model-audit-1",
    verifier: "tools/server-scripts/verify-operation-permission-domain-model.ts",
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

main().catch((error?: any) : any => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
