#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPendingOperationRuntime } from "../../packages/capabilities/src/operation-permission-core/runtime-pending.mjs";
import { createOperationPermissionStore } from "../../packages/capabilities/src/operation-permission-core/store.mjs";

const REPORT_PATH = "build/reports/approval-governance.json";
const REQUIRED_TERMINALS = Object.freeze([
  "approved",
  "denied",
  "cancelled",
  "expired",
  "payload_mismatch",
  "replayed"
]);

const SENSITIVE_REPORT_PATTERNS = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\])/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{16,}\b|xox[baprs]-[A-Za-z0-9-]{16,}/u],
  ["runtime_id", /\b(?:grant_|pending_op|tool_exec|trace_)[A-Za-z0-9_-]{8,}\b/u]
]);

function assertNoLeak(value, label = "payload") {
  const serialized = JSON.stringify(value);
  for (const [name, pattern] of SENSITIVE_REPORT_PATTERNS) {
    assert.equal(pattern.test(serialized), false, `${label} leaked ${name}`);
  }
}

function safeEvidence(value = {}) {
  return JSON.parse(JSON.stringify(value, (_, child) => {
    if (typeof child !== "string") return child;
    if (child.includes(os.homedir()) || child.includes("/var/folders")) {
      return "[redacted-local-path]";
    }
    if (/Bearer\s+\S+/i.test(child) || /lico_[a-z0-9_-]+=/i.test(child)) {
      return "[redacted-secret]";
    }
    if (/\b(?:grant_|pending_op|tool_exec|trace_)[A-Za-z0-9_-]{8,}\b/u.test(child)) {
      return "[redacted-runtime-id]";
    }
    return child;
  }));
}

function fixtureGrant() {
  return {
    id: "grant-approval-governance",
    enabled: true,
    revokedAt: "",
    projectionFingerprint: "sha256:approval-governance-verifier",
    policyIntegrity: { valid: true }
  };
}

function createPending(store, suffix, overrides = {}) {
  return store.createPendingOperation({
    pendingOperationId: `pending-${suffix}`,
    traceId: `trace-${suffix}`,
    toolExecutionId: `tool-exec-${suffix}`,
    toolId: "lico.gateway.forward",
    toolVersion: "v1",
    toolsetIds: ["gateway"],
    operationId: "gateway.forward",
    risk: "repair_write",
    approvalScope: "gateway:write",
    requiredApproval: {},
    approvalLayers: [],
    grantId: "grant-approval-governance",
    reasonCode: "approval_required",
    riskReason: "Approval governance terminal verifier.",
    originalInput: {
      operationKey: "write",
      target: "alpha"
    },
    context: { transport: "verifier" },
    ...overrides
  });
}

async function proveTerminals(store) {
  const events = [];
  const executeCount = { value: 0 };
  store.getGrant = async () => fixtureGrant();
  const runtime = createPendingOperationRuntime({
    store,
    executeTool: async () => {
      executeCount.value += 1;
      return {
        ok: true,
        status: 200,
        payload: {
          schemaVersion: "v0.0.1:schema:definition-1",
          toolExecutionId: "tool-exec-approved-resume",
          status: "completed"
        }
      };
    },
    publishEvent: async (channel, payload = {}, meta = {}) => {
      events.push({
        channel: String(channel || ""),
        type: String(meta.type || ""),
        status: String(payload.status || "")
      });
    },
    securityPermissions: null
  });

  const approvedPending = createPending(store, "approved");
  const approved = await runtime({
    pendingOperationId: approvedPending.pendingOperationId,
    resolution: "approved",
    resolvedBy: "verifier",
    reason: "approve terminal"
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.payload?.terminalOutcome, "approved");
  assert.equal(approved.payload?.pendingOperation?.status, "completed");
  assert.equal(executeCount.value, 1);

  const deniedPending = createPending(store, "denied");
  const denied = await runtime({
    pendingOperationId: deniedPending.pendingOperationId,
    resolution: "denied",
    resolvedBy: "verifier",
    reason: "deny terminal"
  });
  assert.equal(denied.ok, true);
  assert.equal(denied.payload?.terminalOutcome, "denied");
  assert.equal(denied.payload?.status, "denied");
  assert.equal(denied.payload?.pendingOperation?.status, "rejected");
  assert.equal(executeCount.value, 1);

  const cancelledPending = createPending(store, "cancelled");
  const cancelled = await runtime({
    pendingOperationId: cancelledPending.pendingOperationId,
    resolution: "cancelled",
    resolvedBy: "verifier",
    reason: "cancel terminal"
  });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.payload?.terminalOutcome, "cancelled");
  assert.equal(cancelled.payload?.status, "cancelled");
  assert.equal(cancelled.payload?.pendingOperation?.status, "cancelled");
  assert.equal(executeCount.value, 1);

  const expiredPending = createPending(store, "expired", {
    expiresAt: new Date(Date.now() - 60_000).toISOString()
  });
  const expiredLoaded = store.getPendingOperation(expiredPending.pendingOperationId);
  assert.equal(expiredLoaded?.status, "expired");
  assert.equal(expiredLoaded?.errorCode, "pending_operation_expired");

  const mismatchPending = createPending(store, "payload-mismatch");
  const mismatched = await runtime({
    pendingOperationId: mismatchPending.pendingOperationId,
    resolution: "approved",
    resolvedBy: "verifier",
    reason: "payload mismatch terminal",
    resumeInput: {
      operationKey: "write",
      target: "tampered"
    }
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.status, 409);
  assert.equal(mismatched.payload?.terminalOutcome, "payload_mismatch");
  assert.equal(mismatched.payload?.status, "payload_mismatch");
  assert.equal(mismatched.payload?.pendingOperation?.status, "payload_mismatch");
  assert.equal(executeCount.value, 1);

  const replaySource = createPending(store, "replayed");
  const first = await runtime({
    pendingOperationId: replaySource.pendingOperationId,
    resolution: "denied",
    resolvedBy: "verifier",
    reason: "seed terminal before replay"
  });
  assert.equal(first.ok, true);
  const replayed = await runtime({
    pendingOperationId: replaySource.pendingOperationId,
    resolution: "approved",
    resolvedBy: "verifier",
    reason: "replay terminal"
  });
  assert.equal(replayed.ok, false);
  assert.equal(replayed.status, 409);
  assert.equal(replayed.payload?.terminalOutcome, "replayed");
  assert.equal(replayed.payload?.status, "replayed");
  assert.equal(replayed.payload?.priorStatus, "rejected");
  assert.equal(executeCount.value, 1);

  return {
    approved: {
      proved: true,
      status: approved.payload?.pendingOperation?.status || "",
      terminalOutcome: approved.payload.terminalOutcome,
      sideEffectCount: executeCount.value
    },
    denied: {
      proved: true,
      status: denied.payload.status,
      terminalOutcome: denied.payload.terminalOutcome,
      storedStatus: denied.payload.pendingOperation.status
    },
    cancelled: {
      proved: true,
      status: cancelled.payload.status,
      terminalOutcome: cancelled.payload.terminalOutcome,
      storedStatus: cancelled.payload.pendingOperation.status
    },
    expired: {
      proved: true,
      status: expiredLoaded.status,
      terminalOutcome: "expired",
      errorCode: expiredLoaded.errorCode
    },
    payload_mismatch: {
      proved: true,
      status: mismatched.payload.status,
      terminalOutcome: mismatched.payload.terminalOutcome,
      storedStatus: mismatched.payload.pendingOperation.status,
      errorCode: mismatched.payload.error?.code || ""
    },
    replayed: {
      proved: true,
      status: replayed.payload.status,
      terminalOutcome: replayed.payload.terminalOutcome,
      priorStatus: replayed.payload.priorStatus,
      errorCode: replayed.payload.error?.code || ""
    },
    eventTypes: [...new Set(events.map((entry) => entry.type).filter(Boolean))].sort()
  };
}

async function main() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-approval-governance-"));
  const report = {
    schemaVersion: "v0.0.1:authorization:approval-governance-report-1",
    verifier: "tools/server-scripts/verify-approval-governance.mjs",
    startedAt: new Date().toISOString(),
    algorithm: {
      requiredTerminals: REQUIRED_TERMINALS,
      sourceOfTruth: "packages/capabilities/src/operation-permission-core/runtime-pending.mjs plus store-pending expiry"
    },
    terminalOutcomes: {},
    summary: {}
  };

  let store = null;
  try {
    store = createOperationPermissionStore({
      userDataPath,
      capabilityKeyProvider: { close() {} },
      capabilityBindingGuard: false
    });
    const evidence = await proveTerminals(store);
    report.terminalOutcomes = safeEvidence(evidence);
    for (const terminal of REQUIRED_TERMINALS) {
      assert.equal(evidence[terminal]?.proved, true, `${terminal} must be proved`);
      assert.equal(
        JSON.stringify(evidence).includes(`"${terminal}"`) ||
          JSON.stringify(evidence[terminal]).includes(terminal),
        true,
        `${terminal} must appear in report evidence`
      );
    }
    report.summary = {
      requiredTerminalCount: REQUIRED_TERMINALS.length,
      provedTerminalCount: REQUIRED_TERMINALS.length,
      releaseReady: true,
      reportLeakScan: false
    };
    assertNoLeak(report, "approval governance report");
    report.summary.reportLeakScan = true;
    assertNoLeak(report, "approval governance report");
    report.finishedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      ok: true,
      report: REPORT_PATH,
      provedTerminals: REQUIRED_TERMINALS
    }));
  } catch (error) {
    report.summary = {
      requiredTerminalCount: REQUIRED_TERMINALS.length,
      provedTerminalCount: Object.values(report.terminalOutcomes || {}).filter((entry) => entry?.proved).length,
      releaseReady: false,
      reportLeakScan: false,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: String(error?.code || "")
    };
    report.finishedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true }).catch(() => {});
    await fs.writeFile(REPORT_PATH, `${JSON.stringify(safeEvidence(report), null, 2)}\n`, "utf8").catch(() => {});
    console.error(JSON.stringify(safeEvidence({
      ok: false,
      verifier: "tools/server-scripts/verify-approval-governance.mjs",
      failure: {
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error)
      }
    }), null, 2));
    process.exitCode = 1;
  } finally {
    store?.close?.();
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
