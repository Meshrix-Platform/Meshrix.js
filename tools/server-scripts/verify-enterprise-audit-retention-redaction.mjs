#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createOperationAuditStore } from "../../packages/foundation/src/security/operation-audit.mjs";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeAndPublishSensitiveReport,
  sanitizeSensitiveError
} from "./lib/sensitive-report-scan.mjs";

const REPORT_PATH = "build/reports/enterprise-audit-retention-redaction.json";
const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const VERIFIER = "tools/server-scripts/verify-enterprise-audit-retention-redaction.mjs";
const COMMAND_ID = "enterprise-audit-retention-redaction";
const REPORT_SCHEMA_VERSION = "v0.0.1:observability:audit-retention-redaction-report-1";
const PLAN_FILE = "docs/plan/end-to-end-release/platform-foundation/runtime-observability-convergence/Plan.md";
const REQUIREMENTS = Object.freeze(["REQ-REL-003", "REQ-REL-009", "REQ-REL-010", "REQ-REL-011", "REQ-REL-024", "REQ-REL-025", "REQ-USP-013"]);
const SOURCE_FILES = Object.freeze([
  "packages/foundation/src/observability/sensitive-report-scan.mjs",
  "packages/foundation/src/security/operation-audit.mjs",
  VERIFIER
]);
const CAPABILITY_OPERATIONS = Object.freeze([
  ["operation-permission", "operation_permission.execute"],
  ["mcp", "operation_permission.mcp.request_authorization"],
  ["gateway", "gateway.forward"],
  ["workspace", "workspace.file.write"],
  ["external-services", "external_services.list"],
  ["tag-management", "tag_management.tags.list"],
  ["authorization", "auth.audit.export"],
  ["storage", "storage.backups.restore"],
  ["jobs", "jobs.create"],
  ["console", "production.health"]
]);

function oldIso(daysAgo) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

async function main() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-enterprise-audit-"));
  const store = createOperationAuditStore({ userDataPath });
  const bearerFixture = ["Bearer", "raw", "token", "123"].join("-").replace("Bearer-", "Bearer ");
  const secretFixture = ["sk", "test", "secret"].join("-");
  const upstreamSecretFixture = ["upstream", "secret", "value"].join("-");
  let exitCode = 0;
  const report = {
    schemaVersion: "v0.0.1:observability:audit-retention-redaction-report-1",
    generatedAt: new Date().toISOString(),
    verifier: VERIFIER,
    algorithm: {
      realStore: "Create a real SQLite-backed Operation Audit store in a temporary data directory.",
      redaction: "Append audit records with raw tokens, prompts, file content, upstream secrets, local paths, and runtime ids, then verify list/export/trace outputs are redacted.",
      retention: "Set a retention policy, prune an expired audit row, and verify retention/prune administration operations are themselves present in the audit timeline.",
      coverage: "Require audit records for Operation Permission, MCP, gateway, workspace, external services, tag management, authorization, storage, jobs, and console operations."
    },
    tests: [],
    destructiveTests: [],
    summary: {}
  };

  function record(collection, name, status, evidence = {}) {
    collection.push({ name, status, evidence });
  }

  try {
    const traceId = "trace_enterprise_audit_static";
    for (const [capability, operationId] of CAPABILITY_OPERATIONS) {
      store.append({
        traceId,
        requestId: `request-${capability}`,
        tenantId: "tenant-a",
        operationId,
        transport: capability === "mcp" ? "mcp" : "http",
        actor: { userId: "user-a", roleId: "admin", tenantId: "tenant-a" },
        risk: operationId.includes("restore") || operationId.includes("publish") ? "repair_write" : "safe_write",
        readOnly: false,
        status: capability === "gateway" ? "denied" : "ok",
        durationMs: 3,
        input: {
          authorization: bearerFixture,
          apiKey: secretFixture,
          upstreamSecret: upstreamSecretFixture,
          prompt: "raw prompt body",
          fileContent: "private file content",
          sourcePath: path.join(userDataPath, "private", "document.txt"),
          runtimeId: "grant_abcd12_deadbeef",
          pendingOperationId: "pending_op_deadbeef",
          publicOperationId: operationId
        },
        output: {
          ok: true,
          fileContent: "private file content"
        },
        error: `failed at ${path.join(userDataPath, "private", "error.log")}`,
        createdAt: capability === "jobs" ? oldIso(3) : new Date().toISOString()
      });
    }

    store.append({
      traceId,
      operationId: "auth.audit.retention.set",
      transport: "http",
      actor: { userId: "auditor", roleId: "admin" },
      risk: "safe_write",
      status: "ok",
      input: { retentionDays: 1, updatedBy: { authorization: bearerFixture } }
    });
    const policy = store.setRetentionPolicy({
      retentionDays: 1,
      maxExportItems: 50,
      updatedBy: { userId: "auditor", authorization: bearerFixture }
    });

    const listedBeforePrune = store.list({ limit: 100 });
    const exportResult = store.exportRedacted({ limit: 100 });
    const trace = store.getTrace(traceId, { limit: 100 });
    assert.equal(listedBeforePrune.length >= CAPABILITY_OPERATIONS.length, true);
    assert.equal(exportResult.manifest.protocolVersion, "v0.0.1:platform:audit-export-1");
    assertReportProvenance(exportResult, {
      producer: "licomesh-core-operation-audit",
      commandId: "auth.audit.export",
      sourceRevision: exportResult.manifest.protocolVersion
    });
    assert.equal(trace.count >= CAPABILITY_OPERATIONS.length, true);

    assertNoSensitiveReportLeak(listedBeforePrune, "audit list");
    assertNoSensitiveReportLeak(exportResult, "audit export");
    assertNoSensitiveReportLeak(trace, "trace drilldown");

    const capabilityCoverage = Object.fromEntries(CAPABILITY_OPERATIONS.map(([capability, operationId]) => [
      capability,
      listedBeforePrune.some((item) => item.operationId === operationId)
    ]));
    assert.deepEqual(Object.values(capabilityCoverage), Object.values(capabilityCoverage).map(() => true));
    record(report.tests, "audit query export and trace redacts sensitive payloads across capabilities", "passed", {
      capabilityCoverage,
      exportItemCount: exportResult.manifest.itemCount,
      traceSpanCount: trace.spans.length,
      redactionPolicy: exportResult.manifest.redactionPolicy
    });

    const prune = store.pruneExpired({ retentionDays: 1 });
    store.append({
      traceId,
      operationId: "auth.audit.prune",
      transport: "http",
      actor: { userId: "auditor", roleId: "admin" },
      risk: "safe_write",
      status: "ok",
      input: prune
    });
    assert.equal(prune.deletedCount >= 1, true);
    const afterPrune = store.list({ limit: 100 });
    assert.equal(afterPrune.some((item) => item.operationId === "jobs.create"), false, "expired jobs audit row should be pruned");
    assert.equal(afterPrune.some((item) => item.operationId === "auth.audit.retention.set"), true);
    assert.equal(afterPrune.some((item) => item.operationId === "auth.audit.prune"), true);
    assertNoSensitiveReportLeak(afterPrune, "post-prune audit list");
    record(report.destructiveTests, "retention policy prunes expired records and records administrative audit events", "passed", {
      retentionDays: policy.retentionDays,
      deletedCount: prune.deletedCount,
      retentionSetAudited: true,
      pruneAudited: true
    });
  } catch (error) {
    exitCode = 1;
    record(report.destructiveTests, "enterprise audit retention redaction verifier failed", "failed", {
      errorName: error instanceof Error ? error.name : typeof error,
      message: sanitizeSensitiveError(error).replace(userDataPath, "[redacted]")
    });
  } finally {
    report.finishedAt = new Date().toISOString();
    report.summary = {
      testCount: report.tests.length,
      destructiveTestCount: report.destructiveTests.length,
      failedCount: [...report.tests, ...report.destructiveTests].filter((item) => item.status !== "passed").length,
      readyForReleaseReduction: exitCode === 0,
      reportLeakScan: true
    };
    const revision = await computeVerifierSourceRevision(repoRoot, SOURCE_FILES);
    const provenance = {
      producer: "licomesh-core-observability",
      commandId: COMMAND_ID,
      sourceRevision: revision
    };
    const finalizedReport = await finalizeAndPublishSensitiveReport(report, {
      filePath: path.join(repoRoot, REPORT_PATH),
      schemaVersion: REPORT_SCHEMA_VERSION,
      verifier: VERIFIER,
      provenance,
      checkpointDigest: await computeVerifierSourceRevision(repoRoot, [PLAN_FILE]),
      requirements: REQUIREMENTS
    });
    assertNoSensitiveReportLeak(finalizedReport, "enterprise audit report");
    assertReportProvenance(finalizedReport, provenance);
    store.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }

  if (exitCode !== 0) {
    console.error(`[enterprise-audit-retention-redaction] report=${REPORT_PATH}`);
    process.exit(exitCode);
  }
  console.log(`[enterprise-audit-retention-redaction] report=${REPORT_PATH}`);
  console.log("[enterprise-audit-retention-redaction] readyForReleaseReduction=true");
}

await main();
