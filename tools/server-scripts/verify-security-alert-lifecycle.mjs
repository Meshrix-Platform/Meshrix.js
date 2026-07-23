#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSecurityAlertStore } from "../../packages/foundation/src/security/security-alerts.mjs";
import {
  alertLifecycleDefinition,
  createAlertRecord,
  transitionAlertRecord
} from "../../packages/foundation/src/observability/alert-service.mjs";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeAndPublishSensitiveReport
} from "./lib/sensitive-report-scan.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath = path.join(repoRoot, "build", "reports", "security-alert-lifecycle.json");
const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-security-alerts-"));
const VERIFIER = "tools/server-scripts/verify-security-alert-lifecycle.mjs";
const COMMAND_ID = "security-alert-lifecycle";
const REPORT_SCHEMA_VERSION = "v0.0.1:security:alert-lifecycle-report-1";
const PLAN_FILE = "docs/plan/end-to-end-release/platform-foundation/runtime-observability-convergence/Plan.md";
const REQUIREMENTS = Object.freeze(["REQ-REL-003", "REQ-REL-009", "REQ-REL-010", "REQ-REL-011", "REQ-REL-024", "REQ-REL-025", "REQ-USP-013"]);
const SOURCE_FILES = Object.freeze([
  "packages/foundation/src/observability/alert-service.mjs",
  "packages/foundation/src/observability/sensitive-report-scan.mjs",
  "packages/foundation/src/security/security-alerts.mjs",
  "packages/foundation/src/workflow/state-machine/definitions/alert.lifecycle.json",
  VERIFIER
]);

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function verifyLocalSecurityReportStatus() {
  const docsReportRoot = path.join(repoRoot, "docs", "report");
  const indexPath = path.join(docsReportRoot, "README.md");
  if (!await exists(indexPath)) {
    return {
      checked: false,
      reportCount: 0,
      staleStatusCount: 0
    };
  }
  const indexText = await fs.readFile(indexPath, "utf8");
  const rows = indexText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("| [") && line.includes("CS-DS-"));
  const staleStatuses = [];
  for (const row of rows) {
    const cells = row.split("|").map((cell) => cell.trim());
    const linkedFile = cells[1]?.match(/\(([^)]+)\)/u)?.[1] || "";
    const status = cells[4] || "";
    if (status !== "已修复") {
      staleStatuses.push({ file: linkedFile || "[index]", status });
      continue;
    }
    if (!linkedFile) continue;
    const reportText = await fs.readFile(path.join(docsReportRoot, linkedFile), "utf8");
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
const store = createSecurityAlertStore({ userDataPath });
try {
  const localSecurityReports = await verifyLocalSecurityReportStatus();
  const protectedTokenFixture = ["ock", "secret", "value", "must", "redact"].join("_");
  const alert = store.appendAlert({
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
    () => store.transitionAlert(alert.alertId, "archive", { actor: "verifier" }),
    (error) => error?.code === "ALERT_LIFECYCLE_INVALID_TRANSITION"
  );
  const ack = store.acknowledgeAlert({ alertId: alert.alertId, acknowledgedBy: "verifier" });
  assert.equal(ack.ok, true);
  assert.equal(ack.alert.lifecycleStatus, "acknowledged");
  const repeatedAck = store.acknowledgeAlert({ alertId: alert.alertId, acknowledgedBy: "verifier" });
  assert.equal(repeatedAck.alert.lifecycleRevision, ack.alert.lifecycleRevision);
  const exported = store.exportRedacted({ limit: 10 });
  assert.equal(exported.itemCount, 1);
  assert.equal(exported.reportLeakScan, true);
  assertReportProvenance(exported, {
    producer: "licomesh-core-security-alerts",
    commandId: "security_alerts.export",
    sourceRevision: store.protocolVersion
  });
  assert.equal(exported.jsonl.includes(protectedTokenFixture), false);
  assert.equal(exported.jsonl.includes("Bearer should-redact"), false);
  assert.equal(exported.jsonl.includes("grant_verifier"), false);
  assert.equal(exported.jsonl.includes("trace_verifier"), false);
  const prune = store.pruneAlerts({ retentionDays: 1 });
  assert.equal(prune.archived, 1);
  assert.equal(store.getAlert(alert.alertId).lifecycleStatus, "archived");

  const paths = Object.freeze({
    rule_loaded: [],
    firing: ["condition_matched"],
    acknowledged: ["condition_matched", "acknowledge"],
    resolved: ["condition_matched", "resolve"],
    suppressed: ["condition_matched", "suppress"],
    notification_failed: ["condition_matched", "notification_failed"],
    archived: ["condition_matched", "resolve", "archive"]
  });
  let legalTransitionCount = 0;
  let illegalTransitionCount = 0;
  let idempotentTransitionCount = 0;
  for (const entry of alertLifecycleDefinition().totalMatrix) {
    let current = createAlertRecord({
      alertId: `matrix-${entry.from}-${entry.event}`,
      ruleId: "matrix_rule",
      severity: "warning",
      title: "Lifecycle matrix verifier",
      source: "security_alert"
    }, { now: () => "2026-01-01T00:00:00.000Z" });
    for (const event of paths[entry.from]) {
      current = transitionAlertRecord(current, event, {
        actor: "verifier",
        now: () => "2026-01-01T00:00:00.000Z"
      });
    }
    if (entry.result === "illegal_transition") {
      assert.throws(
        () => transitionAlertRecord(current, entry.event, { actor: "verifier" }),
        (error) => error?.code === entry.errorCode
      );
      illegalTransitionCount += 1;
      continue;
    }
    const transitioned = transitionAlertRecord(current, entry.event, {
      actor: "verifier",
      now: () => "2026-01-01T00:00:01.000Z"
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

  const revision = await computeVerifierSourceRevision(repoRoot, SOURCE_FILES);
  const provenance = {
    producer: "licomesh-core-observability",
    commandId: COMMAND_ID,
    sourceRevision: revision
  };
  const reportInput = {
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
  const report = await finalizeAndPublishSensitiveReport(reportInput, {
    filePath: reportPath,
    schemaVersion: REPORT_SCHEMA_VERSION,
    verifier: VERIFIER,
    provenance,
    checkpointDigest: await computeVerifierSourceRevision(repoRoot, [PLAN_FILE]),
    requirements: REQUIREMENTS
  });
  assertNoSensitiveReportLeak(report, "security alert lifecycle report");
  assertReportProvenance(report, provenance);
  console.log("[security-alert-lifecycle] ok");
} finally {
  store.close();
  await fs.rm(userDataPath, { recursive: true, force: true });
}
