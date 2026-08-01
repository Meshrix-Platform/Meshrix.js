#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPendingOperationRuntime } from "../../packages/capabilities/src/operation-permission-core/runtime-pending.ts";
import { createOperationPermissionStore } from "../../packages/capabilities/src/operation-permission-core/store.ts";

const REPORT_PATH: any = "build/reports/approval-governance.json";
const REQUIRED_TERMINALS: readonly any[] = Object.freeze([
  "approved",
  "denied",
  "cancelled",
  "expired",
  "payload_mismatch",
  "replayed"
]);

const SENSITIVE_REPORT_PATTERNS: readonly any[] = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\])/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{16,}\b|xox[baprs]-[A-Za-z0-9-]{16,}/u],
  ["runtime_id", /\b(?:grant_|pending_op|tool_exec|trace_)[A-Za-z0-9_-]{8,}\b/u]
]);

function assertNoLeak(value?: any, label: any = "payload") : any {
  const serialized: any = JSON.stringify(value);
  for (const [name, pattern] of SENSITIVE_REPORT_PATTERNS) {
    assert.equal(pattern.test(serialized), false, `${label} leaked ${name}`);
  }
}

function safeEvidence(value: Record<string, any> = {}) : any {
  return JSON.parse(JSON.stringify(value, (_?: any, child?: any) : any => {
    if (typeof child !== "string") return child;
    if (child.includes(os.homedir()) || child.includes("/var/folders")) {
      return "[redacted-local-path]";
    }
    if (/Bearer\s+\S+/i.test(child) || /meshrix_[a-z0-9_-]+=/i.test(child)) {
      return "[redacted-secret]";
    }
    if (/\b(?:grant_|pending_op|tool_exec|trace_)[A-Za-z0-9_-]{8,}\b/u.test(child)) {
      return "[redacted-runtime-id]";
    }
    return child;
  }));
}

function fixtureGrant() : any {
  return {
    id: "grant-approval-governance",
    enabled: true,
    revokedAt: "",
    projectionFingerprint: "sha256:approval-governance-verifier",
    policyIntegrity: { valid: true }
  };
}

function createPending(store?: any, suffix?: any, overrides: Record<string, any> = {}) : any {
  return store.createPendingOperation({
    pendingOperationId: `pending-${suffix}`,
    traceId: `trace-${suffix}`,
    toolExecutionId: `tool-exec-${suffix}`,
    toolId: "meshrix.gateway.forward",
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

async function proveTerminals(store?: any) : Promise<any> {
  const events: any[] = [];
  const executeCount: Record<string, any> = { value: 0 };
  store.getGrant = async () : Promise<any> => fixtureGrant();
  const runtime: any = createPendingOperationRuntime({
    store,
    executeTool: async () : Promise<any> => {
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
    publishEvent: async (channel?: any, payload: Record<string, any> = {}, meta: Record<string, any> = {}) : Promise<any> => {
      events.push({
        channel: String(channel || ""),
        type: String(meta.type || ""),
        status: String(payload.status || "")
      });
    },
    securityPermissions: null
  });

  const approvedPending: any = createPending(store, "approved");
  const approved: any = await runtime({
    pendingOperationId: approvedPending.pendingOperationId,
    resolution: "approved",
    resolvedBy: "verifier",
    reason: "approve terminal"
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.payload?.terminalOutcome, "approved");
  assert.equal(approved.payload?.pendingOperation?.status, "completed");
  assert.equal(executeCount.value, 1);

  const deniedPending: any = createPending(store, "denied");
  const denied: any = await runtime({
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

  const cancelledPending: any = createPending(store, "cancelled");
  const cancelled: any = await runtime({
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

  const expiredPending: any = createPending(store, "expired", {
    expiresAt: new Date(Date.now() - 60_000).toISOString()
  });
  const expiredLoaded: any = store.getPendingOperation(expiredPending.pendingOperationId);
  assert.equal(expiredLoaded?.status, "expired");
  assert.equal(expiredLoaded?.errorCode, "pending_operation_expired");

  const mismatchPending: any = createPending(store, "payload-mismatch");
  const mismatched: any = await runtime({
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

  const replaySource: any = createPending(store, "replayed");
  const first: any = await runtime({
    pendingOperationId: replaySource.pendingOperationId,
    resolution: "denied",
    resolvedBy: "verifier",
    reason: "seed terminal before replay"
  });
  assert.equal(first.ok, true);
  const replayed: any = await runtime({
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
    eventTypes: [...new Set<any>(events.map((entry?: any) : any => entry.type).filter(Boolean))].sort()
  };
}

async function main() : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-approval-governance-"));
  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:authorization:approval-governance-report-1",
    verifier: "tools/server-scripts/verify-approval-governance.ts",
    startedAt: new Date().toISOString(),
    algorithm: {
      requiredTerminals: REQUIRED_TERMINALS,
      sourceOfTruth: "packages/capabilities/src/operation-permission-core/runtime-pending.ts plus store-pending expiry"
    },
    terminalOutcomes: {},
    summary: {}
  };

  let store: any = null;
  try {
    store = createOperationPermissionStore({
      userDataPath,
      capabilityKeyProvider: { close() : any {} },
      capabilityBindingGuard: false
    });
    const evidence: any = await proveTerminals(store);
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
  } catch (error: any) {
    report.summary = {
      requiredTerminalCount: REQUIRED_TERMINALS.length,
      provedTerminalCount: (Object.values(report.terminalOutcomes || {}) as any[]).filter((entry?: any) : any => entry?.proved).length,
      releaseReady: false,
      reportLeakScan: false,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: String(error?.code || "")
    };
    report.finishedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true }).catch(() : any => {});
    await fs.writeFile(REPORT_PATH, `${JSON.stringify(safeEvidence(report), null, 2)}\n`, "utf8").catch(() : any => {});
    console.error(JSON.stringify(safeEvidence({
      ok: false,
      verifier: "tools/server-scripts/verify-approval-governance.ts",
      failure: {
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error)
      }
    }), null, 2));
    process.exitCode = 1;
  } finally {
    store?.close?.();
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
  }
}

await main();
