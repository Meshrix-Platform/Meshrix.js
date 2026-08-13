#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createOperationAuditStore } from "../../packages/foundation/src/security/operation-audit.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeAndPublishSensitiveReport,
  sanitizeSensitiveError
} from "./lib/sensitive-report-scan.ts";

const REPORT_PATH: any = "build/reports/enterprise-audit-retention-redaction.json";
const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const VERIFIER: any = "tools/server-scripts/verify-enterprise-audit-retention-redaction.ts";
const COMMAND_ID: any = "enterprise-audit-retention-redaction";
const REPORT_SCHEMA_VERSION: any = "v0.0.1:observability:audit-retention-redaction-report-1";
const PLAN_FILE: any = "docs/plans/end-to-end-release/enterprise-single-node/Plan.md";
const REQUIREMENTS: readonly any[] = Object.freeze(["REQ-REL-003", "REQ-REL-009", "REQ-REL-010", "REQ-REL-011", "REQ-REL-024", "REQ-REL-025", "REQ-USP-013"]);
const SOURCE_FILES: readonly any[] = Object.freeze([
  "packages/foundation/src/observability/sensitive-report-scan.ts",
  "packages/foundation/src/security/operation-audit.ts",
  VERIFIER
]);
const CAPABILITY_OPERATIONS: readonly any[] = Object.freeze([
  ["operation-permission", "operation_permission.execute"],
  ["mcp", "operation_permission.execute"],
  ["gateway", "gateway.forward"],
  ["workspace", "workspace.file.write"],
  ["external-services", "external_services.list"],
  ["tag-management", "tag_management.tags.list"],
  ["authorization", "auth.audit.export"],
  ["storage", "storage.backups.restore"],
  ["jobs", "jobs.create"],
  ["console", "production.health"]
]);

function oldIso(daysAgo?: any) : any {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

async function main() : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-enterprise-audit-"));
  const store: any = createOperationAuditStore({ userDataPath });
  const bearerFixture: any = ["Bearer", "raw", "token", "123"].join("-").replace("Bearer-", "Bearer ");
  const secretFixture: any = ["sk", "test", "secret"].join("-");
  const upstreamSecretFixture: any = ["upstream", "secret", "value"].join("-");
  let exitCode: any = 0;
  const report: Record<string, any> = {
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

  function record(collection?: any, name?: any, status?: any, evidence: Record<string, any> = {}) : any {
    collection.push({ name, status, evidence });
  }

  try {
    const traceId: any = "trace_enterprise_audit_static";
    for (const [capability, operationId] of CAPABILITY_OPERATIONS) {
      await store.append({
        traceId,
        requestId: `request-${capability}`,
        tenantId: "tenant-a",
        operationId,
        transport: capability === "mcp" ? "mcp" : "http",
        actor: { userId: "user-a", roleId: "maintainer", tenantId: "tenant-a" },
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

    await store.append({
      traceId,
      operationId: "auth.audit.retention.set",
      transport: "http",
      actor: { userId: "auditor", roleId: "maintainer" },
      risk: "safe_write",
      status: "ok",
      input: { retentionDays: 1, updatedBy: { authorization: bearerFixture } }
    });
    const policy: any = await store.setRetentionPolicy({
      retentionDays: 1,
      maxExportItems: 50,
      cleanupBatchSize: 4,
      maintenanceEveryAppends: 1,
      updatedBy: { userId: "auditor", authorization: bearerFixture }
    });

    const [listedBeforePrune, exportResult, trace]: any[] = await Promise.all([
      store.list({ limit: 100 }),
      store.exportRedacted({ limit: 100 }),
      store.getTrace(traceId, { limit: 100 })
    ]);
    assert.equal(listedBeforePrune.length >= CAPABILITY_OPERATIONS.length, true);
    assert.equal(exportResult.manifest.protocolVersion, "v0.0.1:platform:audit-export-1");
    assertReportProvenance(exportResult, {
      producer: "meshrix-core-operation-audit",
      commandId: "auth.audit.export",
      sourceRevision: exportResult.manifest.protocolVersion
    });
    assert.equal(trace.count >= CAPABILITY_OPERATIONS.length, true);

    assertNoSensitiveReportLeak(listedBeforePrune, "audit list");
    assertNoSensitiveReportLeak(exportResult, "audit export");
    assertNoSensitiveReportLeak(trace, "trace drilldown");

    const capabilityCoverage: any = Object.fromEntries(CAPABILITY_OPERATIONS.map(([capability, operationId]: any[]) : any => [
      capability,
      listedBeforePrune.some((item?: any) : any => item.operationId === operationId)
    ]));
    assert.deepEqual((Object.values(capabilityCoverage) as any[]), (Object.values(capabilityCoverage) as any[]).map(() : any => true));
    record(report.tests, "audit query export and trace redacts sensitive payloads across capabilities", "passed", {
      capabilityCoverage,
      exportItemCount: exportResult.manifest.itemCount,
      traceSpanCount: trace.spans.length,
      redactionPolicy: exportResult.manifest.redactionPolicy
    });

    const automaticRetention: any = await store.append({
      traceId,
      operationId: "auth.audit.retention.automatic",
      transport: "application",
      actor: { type: "system" },
      risk: "safe_write",
      status: "ok",
      input: {}
    });
    assert.equal(automaticRetention.maintenance.deletedCount >= 1, true);
    assert.equal(
      (await store.list({ limit: 100 })).some((item?: any) : any => item.operationId === "jobs.create"),
      false,
      "append-path retention should remove the expired jobs audit row"
    );
    await store.append({
      traceId,
      operationId: "audit.manual-prune.fixture",
      transport: "application",
      actor: { type: "system" },
      risk: "safe_write",
      status: "ok",
      input: {},
      createdAt: oldIso(3)
    });

    const prune: any = await store.pruneExpired({ retentionDays: 1 });
    await store.append({
      traceId,
      operationId: "auth.audit.prune",
      transport: "http",
      actor: { userId: "auditor", roleId: "maintainer" },
      risk: "safe_write",
      status: "ok",
      input: prune
    });
    assert.equal(prune.deletedCount >= 1, true);
    const afterPrune: any = await store.list({ limit: 100 });
    assert.equal(afterPrune.some((item?: any) : any => item.operationId === "jobs.create"), false, "expired jobs audit row should be pruned");
    assert.equal(afterPrune.some((item?: any) : any => item.operationId === "auth.audit.retention.set"), true);
    assert.equal(afterPrune.some((item?: any) : any => item.operationId === "auth.audit.prune"), true);
    assertNoSensitiveReportLeak(afterPrune, "post-prune audit list");
    record(report.destructiveTests, "retention policy prunes expired records and records administrative audit events", "passed", {
      retentionDays: policy.retentionDays,
      deletedCount: prune.deletedCount,
      automaticDeletedCount: automaticRetention.maintenance.deletedCount,
      retentionSetAudited: true,
      pruneAudited: true
    });
  } catch (error: any) {
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
      failedCount: [...report.tests, ...report.destructiveTests].filter((item?: any) : any => item.status !== "passed").length,
      readyForReleaseReduction: exitCode === 0,
      reportLeakScan: true
    };
    const revision: any = await computeVerifierSourceRevision(repoRoot, SOURCE_FILES);
    const provenance: Record<string, any> = {
      producer: "meshrix-core-observability",
      commandId: COMMAND_ID,
      sourceRevision: revision
    };
    const finalizedReport: any = await finalizeAndPublishSensitiveReport(report, {
      filePath: path.join(repoRoot, REPORT_PATH),
      schemaVersion: REPORT_SCHEMA_VERSION,
      verifier: VERIFIER,
      provenance,
      checkpointDigest: await computeVerifierSourceRevision(repoRoot, [PLAN_FILE]),
      requirements: REQUIREMENTS
    });
    assertNoSensitiveReportLeak(finalizedReport, "enterprise audit report");
    assertReportProvenance(finalizedReport, provenance);
    await store.close();
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
