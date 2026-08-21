#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSecurityAlertStore } from "../../packages/foundation/src/security/security-alerts.ts";
import {
  alertLifecycleDefinition,
  createAlertRecord,
  transitionAlertRecord
} from "../../packages/foundation/src/observability/alert-service.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeAndPublishSensitiveReport
} from "./lib/sensitive-report-scan.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath: any = path.join(repoRoot, "build", "reports", "security-alert-lifecycle.json");
const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-security-alerts-"));
const VERIFIER: any = "tools/server-scripts/verify-security-alert-lifecycle.ts";
const COMMAND_ID: any = "security-alert-lifecycle";
const REPORT_SCHEMA_VERSION: any = "v0.0.1:security:alert-lifecycle-report-1";
const REQUIREMENTS: readonly any[] = Object.freeze(["REQ-REL-003", "REQ-REL-009", "REQ-REL-010", "REQ-REL-011", "REQ-REL-024", "REQ-REL-025", "REQ-USP-013"]);
const SOURCE_FILES: readonly any[] = Object.freeze([
  "packages/foundation/src/observability/alert-service.ts",
  "packages/foundation/src/observability/sensitive-report-scan.ts",
  "packages/foundation/src/security/security-alerts.ts",
  "packages/foundation/src/workflow/state-machine/definitions/alert.lifecycle.json",
  VERIFIER
]);

async function exists(filePath?: any) : Promise<any> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function verifyLocalSecurityReportStatus() : Promise<any> {
  const docsReportRoot: any = path.join(repoRoot, "docs", "reports");
  const indexPath: any = path.join(docsReportRoot, "README.md");
  if (!await exists(indexPath)) {
    return {
      checked: false,
      reportCount: 0,
      staleStatusCount: 0
    };
  }
  const indexText: any = await fs.readFile(indexPath, "utf8");
  const rows: any = indexText
    .split(/\r?\n/u)
    .map((line?: any) : any => line.trim())
    .filter((line?: any) : any => line.startsWith("| [") && line.includes("CS-DS-"));
  const staleStatuses: any[] = [];
  for (const row of rows) {
    const cells: any = row.split("|").map((cell?: any) : any => cell.trim());
    const linkedFile: any = cells[1]?.match(/\(([^)]+)\)/u)?.[1] || "";
    const status: any = cells[4] || "";
    if (status !== "已修复") {
      staleStatuses.push({ file: linkedFile || "[index]", status });
      continue;
    }
    if (!linkedFile) continue;
    const reportText: any = await fs.readFile(path.join(docsReportRoot, linkedFile), "utf8");
    if (
      !/\|\s*当前状态\s*\|\s*已修复\s*\|/u.test(reportText) &&
      !/^>\s*当前状态.*已修复/mu.test(reportText) &&
      !/##\s*当前状态[\s\S]{0,160}已修复/u.test(reportText)
    ) {
      staleStatuses.push({ file: linkedFile, status: "single-report-status-missing" });
    }
  }
  assert.deepEqual(staleStatuses, [], "Local security reports must not retain unresolved or stale review statuses.");
  return {
    checked: true,
    reportCount: rows.length,
    staleStatusCount: staleStatuses.length
  };
}

await fs.mkdir(path.dirname(reportPath), { recursive: true });
const store: any = createSecurityAlertStore({ userDataPath });
try {
  const localSecurityReports: any = await verifyLocalSecurityReportStatus();
  const protectedTokenFixture: any = ["ock", "secret", "value", "must", "redact"].join("_");
  const alert: any = store.appendAlert({
    category: "mcp_client_identity",
    severity: "critical",
    reasonCode: "process_identity_signature_invalid",
    title: "Verifier alert",
    actorRef: "opencode",
    subjectRef: "grant_verifier",
    resourceRef: "mcp.request",
    sourceIp: "127.0.0.1",
    traceId: "trace_verifier",
    details: {
      token: protectedTokenFixture,
      authorization: "Bearer should-redact",
      nested: { apiKey: "secret" }
    },
    createdAt: "2000-01-01T00:00:00.000Z"
  });
  assert.equal(alert.details.token, "[redacted]");
  assert.equal(alert.details.authorization, "[redacted]");
  assert.equal(alert.details.nested.apiKey, "[redacted]");
  assert.notEqual(alert.actorRef, "opencode");
  assert.notEqual(alert.subjectRef, "grant_verifier");
  assert.notEqual(alert.sourceIp, "127.0.0.1");
  assert.notEqual(alert.traceId, "trace_verifier");
  assert.equal(alert.lifecycleStatus, "firing");
  assert.equal(alert.lifecycleHistory[0]?.fromStatus, "rule_loaded");
  assert.equal(store.listAlerts({ limit: 10 }).length, 1);
  assert.throws(
    () : any => store.transitionAlert(alert.alertId, "archive", { actor: "verifier" }),
    (error?: any) : any => error?.code === "ALERT_LIFECYCLE_INVALID_TRANSITION"
  );
  const ack: any = store.acknowledgeAlert({ alertId: alert.alertId, acknowledgedBy: "verifier" });
  assert.equal(ack.ok, true);
  assert.equal(ack.alert.lifecycleStatus, "acknowledged");
  const repeatedAck: any = store.acknowledgeAlert({ alertId: alert.alertId, acknowledgedBy: "verifier" });
  assert.equal(repeatedAck.alert.lifecycleRevision, ack.alert.lifecycleRevision);
  const exported: any = store.exportRedacted({ limit: 10 });
  assert.equal(exported.itemCount, 1);
  assert.equal(exported.reportLeakScan, true);
  assertReportProvenance(exported, {
    producer: "meshrix-core-security-alerts",
    commandId: "security_alerts.export",
    sourceRevision: store.protocolVersion
  });
  assert.equal(exported.jsonl.includes(protectedTokenFixture), false);
  assert.equal(exported.jsonl.includes("Bearer should-redact"), false);
  assert.equal(exported.jsonl.includes("grant_verifier"), false);
  assert.equal(exported.jsonl.includes("trace_verifier"), false);
  const prune: any = store.pruneAlerts({ retentionDays: 1 });
  assert.equal(prune.archived, 1);
  assert.equal(store.getAlert(alert.alertId).lifecycleStatus, "archived");

  const paths: Readonly<Record<string, any>> = Object.freeze({
    rule_loaded: [],
    firing: ["condition_matched"],
    acknowledged: ["condition_matched", "acknowledge"],
    resolved: ["condition_matched", "resolve"],
    suppressed: ["condition_matched", "suppress"],
    notification_failed: ["condition_matched", "notification_failed"],
    archived: ["condition_matched", "resolve", "archive"]
  });
  let legalTransitionCount: any = 0;
  let illegalTransitionCount: any = 0;
  let idempotentTransitionCount: any = 0;
  for (const entry of alertLifecycleDefinition().totalMatrix) {
    let current: any = createAlertRecord({
      alertId: `matrix-${entry.from}-${entry.event}`,
      ruleId: "matrix_rule",
      severity: "warning",
      title: "Lifecycle matrix verifier",
      source: "security_alert"
    }, { now: () : any => "2026-01-01T00:00:00.000Z" });
    for (const event of paths[entry.from]) {
      current = transitionAlertRecord(current, event, {
        actor: "verifier",
        now: () : any => "2026-01-01T00:00:00.000Z"
      });
    }
    if (entry.result === "illegal_transition") {
      assert.throws(
        () : any => transitionAlertRecord(current, entry.event, { actor: "verifier" }),
        (error?: any) : any => error?.code === entry.errorCode
      );
      illegalTransitionCount += 1;
      continue;
    }
    const transitioned: any = transitionAlertRecord(current, entry.event, {
      actor: "verifier",
      now: () : any => "2026-01-01T00:00:01.000Z"
    });
    if (entry.result === "ignored_idempotent_event") {
      assert.equal(transitioned.lifecycleStatus, entry.from);
      assert.equal(transitioned.lastLifecycleEventIdempotent, true);
      idempotentTransitionCount += 1;
    } else {
      assert.equal(transitioned.lifecycleStatus, entry.to);
      legalTransitionCount += 1;
    }
  }

  const revision: any = await computeVerifierSourceRevision(repoRoot, SOURCE_FILES);
  const provenance: Record<string, any> = {
    producer: "meshrix-core-observability",
    commandId: COMMAND_ID,
    sourceRevision: revision
  };
  const reportInput: Record<string, any> = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    verifier: VERIFIER,
    summary: {
      readyForReleaseReduction: true,
      alertsCreated: 1,
      alertsArchived: prune.archived,
      legalTransitionCount,
      illegalTransitionCount,
      idempotentTransitionCount,
      localSecurityReportStatusChecked: localSecurityReports.checked,
      localSecurityReportCount: localSecurityReports.reportCount,
      localSecurityReportStaleStatusCount: localSecurityReports.staleStatusCount
    }
  };
  const report: any = await finalizeAndPublishSensitiveReport(reportInput, {
    filePath: reportPath,
    schemaVersion: REPORT_SCHEMA_VERSION,
    verifier: VERIFIER,
    provenance,
    checkpointDigest: revision,
    requirements: REQUIREMENTS
  });
  assertNoSensitiveReportLeak(report, "security alert lifecycle report");
  assertReportProvenance(report, provenance);
  console.log("[security-alert-lifecycle] ok");
} finally {
  store.close();
  await fs.rm(userDataPath, { recursive: true, force: true });
}
