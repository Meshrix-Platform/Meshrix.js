import { describe, it, expect } from "vitest";
import {
  buildReadinessReport,
  evaluateReadinessGuard
} from "../../../packages/foundation/src/observability/readiness-baseline/readiness-guard-evaluator.mjs";
import { READINESS_SCOPES } from "../../../packages/foundation/src/observability/readiness-baseline/readiness-scope-registry.mjs";

/**
 * Pure unit: simulate evaluateScopeEvidence semantics from
 * verify-production-readiness-baseline.mjs (updated for P0-B content validation).
 */
function evaluateScopeEvidence(scope, evidencePlan, commandResults, reportResults, commit, commandStartTimes = {}, reportValidators = {}, definitionsRegistry = []) {
  const plan = evidencePlan[scope.scopeId] || { requiredCommands: [], requiredReports: [], requiredFiles: [] };
  const actualEvidence = [];
  const failureReasons = [];

  for (const reqCmd of plan.requiredCommands) {
    const cmdKey = reqCmd.join(" ");
    const result = commandResults[cmdKey];
    if (!result) {
      failureReasons.push(`command_not_run: ${cmdKey}`);
      continue;
    }
    actualEvidence.push({
      command: cmdKey,
      exitCode: result.exitCode,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      elapsedMs: result.elapsedMs,
      generatedForCommit: commit
    });
    if (result.exitCode !== 0) {
      failureReasons.push(`command_failed(exitCode=${result.exitCode}): ${cmdKey}`);
    }
  }

  for (const reportPath of plan.requiredReports) {
    const reportData = reportResults[reportPath];
    if (!reportData || !reportData.exists) {
      failureReasons.push(`report_missing: ${reportPath}`);
      continue;
    }
    const validator = reportValidators[reportPath];
    if (validator) {
      const validation = validator(reportData.data || reportData);
      if (!validation.ok) {
        failureReasons.push(`report_failed(${validation.reason}): ${reportPath}`);
        continue;
      }
    }
    let fresh = false;
    const reportTimestamp = (reportData.data || reportData).generatedAt || reportData.generatedAt || null;
    if (reportTimestamp && Object.keys(commandStartTimes).length > 0) {
      for (const [, cmdStart] of Object.entries(commandStartTimes)) {
        if (reportTimestamp >= cmdStart) { fresh = true; break; }
      }
    } else {
      fresh = true;
    }
    if (!fresh) {
      failureReasons.push(`report_stale: ${reportPath}`);
      continue;
    }
    actualEvidence.push({
      reportPath,
      reportHash: reportData.hash || "sha256:fake",
      reportGeneratedAt: reportTimestamp,
      generatedForCommit: commit
    });
  }

  for (const filePath of (plan.requiredFiles || [])) {
    if (!reportResults[filePath] || !reportResults[filePath].exists) {
      failureReasons.push(`required_file_missing: ${filePath}`);
      continue;
    }
    const content = reportResults[filePath].content || "";
    if (definitionsRegistry.length > 0) {
      for (const machineId of definitionsRegistry) {
        if (!content.includes(machineId)) {
          failureReasons.push(`report_scope_mismatch: ${filePath} missing machine ${machineId}`);
          break;
        }
      }
    }
    actualEvidence.push({ filePath, generatedForCommit: commit });
  }

  const hasRequirements = plan.requiredCommands.length > 0 || plan.requiredReports.length > 0 || (plan.requiredFiles || []).length > 0;
  const verificationMode = hasRequirements
    ? (failureReasons.length === 0 ? "verified" : "failed")
    : "notRun";

  let status;
  if (scope.baselineV0_1Required) {
    status = failureReasons.length === 0 ? "passed" : "failed";
  } else {
    status = "not_in_baseline_v0_1";
  }

  return { status, verificationMode, actualEvidence, failureReasons };
}

function validateBaselineReadinessReport(report) {
  const errors = [];
  if (!report || typeof report !== "object") {
    return { ok: false, errors: ["Report is not a valid object."] };
  }
  if (!report.schemaVersion || report.schemaVersion !== "v0.0.1:schema:definition-1") {
    errors.push("Report missing or invalid schemaVersion.");
  }
  if (!report.reportType || report.reportType !== "v0.0.1:production-readiness:report-0.1") {
    errors.push("Report missing or invalid reportType.");
  }
  if (!report.runId || typeof report.runId !== "string") {
    errors.push("Report missing runId.");
  }
  if (!report.commit || typeof report.commit !== "string") {
    errors.push("Report missing commit.");
  }
  if (!Array.isArray(report.scopes)) {
    errors.push("Report missing scopes array.");
  }
  if (typeof report.baselineV0_1ClaimAllowed !== "boolean") {
    errors.push("Report missing baselineV0_1ClaimAllowed.");
  }
  if (!report.summary || typeof report.summary !== "object") {
    errors.push("Report missing summary.");
  }
  if (!report.guardResults || typeof report.guardResults !== "object") {
    errors.push("Report missing guardResults.");
  }
  return { ok: errors.length === 0, errors };
}

function validateStateMachineReport(report) {
  if (!report || typeof report !== "object") return { ok: false, reason: "report_missing_or_invalid" };
  if (report.ok !== true) return { ok: false, reason: "report_failed" };
  if (!Array.isArray(report.machines) || report.machines.length === 0) return { ok: false, reason: "report_no_machines" };
  const failedMachines = report.machines.filter(m => m.ok !== true);
  if (failedMachines.length > 0) return { ok: false, reason: "report_machine_failed", failedMachineIds: failedMachines.map(m => m.machineId) };
  return { ok: true, reason: "report_valid" };
}

const evidencePlan = {
  "state-machine-core": {
    requiredCommands: [["test", "cmd", "state-machine-core"]],
    requiredReports: ["build/reports/state-machines/latest.json"]
  },
  "state-machine-schema": {
    requiredCommands: [],
    requiredReports: ["build/reports/state-machines/latest.json"]
  },
  "production-readiness-baseline": {
    requiredCommands: [["test", "cmd", "baseline-self-test"]],
    requiredReports: []
  },
  "docs-config-consistency": {
    requiredCommands: [["test", "cmd", "docs-governance"]],
    requiredReports: []
  },
  "proof-artifacts": {
    requiredCommands: [],
    requiredReports: ["build/reports/state-machines/latest.json"],
    requiredFiles: ["docs/STATE-MACHINE-TRACEABILITY.md"]
  }
};

describe("Baseline Evidence - evaluateScopeEvidence", () => {
  it("baseline scope passes when all required commands succeed and reports pass validation", () => {
    const commit = "abc123";
    const commandResults = {
      "test cmd state-machine-core": {
        exitCode: 0,
        startedAt: "2025-01-01T00:00:00Z",
        finishedAt: "2025-01-01T00:00:05Z",
        elapsedMs: 5000
      }
    };
    const reportResults = {
      "build/reports/state-machines/latest.json": {
        exists: true,
        hash: "sha256:abcdef",
        generatedAt: "2025-01-01T00:00:03Z",
        data: { ok: true, machines: [{ machineId: "test.v1", ok: true }] }
      }
    };
    const commandStartTimes = { "test cmd state-machine-core": "2025-01-01T00:00:00Z" };
    const reportValidators = { "build/reports/state-machines/latest.json": validateStateMachineReport };

    const scope = READINESS_SCOPES.getScope("state-machine-core");
    const result = evaluateScopeEvidence(scope, evidencePlan, commandResults, reportResults, commit, commandStartTimes, reportValidators);

    expect(result.status).toBe("passed");
    expect(result.verificationMode).toBe("verified");
    expect(result.failureReasons).toEqual([]);
  });

  it("state-machines/latest.json with ok:false causes scope to fail", () => {
    const commit = "abc123";
    const commandResults = {
      "test cmd state-machine-core": {
        exitCode: 0,
        startedAt: "2025-01-01T00:00:00Z",
        finishedAt: "2025-01-01T00:00:05Z",
        elapsedMs: 5000
      }
    };
    const reportResults = {
      "build/reports/state-machines/latest.json": {
        exists: true,
        hash: "sha256:abcdef",
        generatedAt: "2025-01-01T00:00:03Z",
        data: { ok: false, machines: [] }
      }
    };
    const commandStartTimes = { "test cmd state-machine-core": "2025-01-01T00:00:00Z" };
    const reportValidators = { "build/reports/state-machines/latest.json": validateStateMachineReport };

    const scope = READINESS_SCOPES.getScope("state-machine-core");
    const result = evaluateScopeEvidence(scope, evidencePlan, commandResults, reportResults, commit, commandStartTimes, reportValidators);

    expect(result.status).toBe("failed");
    expect(result.failureReasons.some(r => r.includes("report_failed"))).toBe(true);
  });

  it("report older than command start is stale and scope fails", () => {
    const commit = "abc123";
    const commandResults = {
      "test cmd state-machine-core": {
        exitCode: 0,
        startedAt: "2025-01-01T00:10:00Z",
        finishedAt: "2025-01-01T00:10:05Z",
        elapsedMs: 5000
      }
    };
    const reportResults = {
      "build/reports/state-machines/latest.json": {
        exists: true,
        hash: "sha256:abcdef",
        generatedAt: "2025-01-01T00:00:00Z",
        data: { ok: true, machines: [{ machineId: "test.v1", ok: true }] }
      }
    };
    const commandStartTimes = { "test cmd state-machine-core": "2025-01-01T00:10:00Z" };
    const reportValidators = { "build/reports/state-machines/latest.json": validateStateMachineReport };

    const scope = READINESS_SCOPES.getScope("state-machine-schema");
    const result = evaluateScopeEvidence(scope, evidencePlan, commandResults, reportResults, commit, commandStartTimes, reportValidators);

    expect(result.status).toBe("failed");
    expect(result.failureReasons.some(r => r.includes("report_stale"))).toBe(true);
  });

  it("scope must fail when required command exitCode is non-zero", () => {
    const commit = "abc123";
    const commandResults = {
      "test cmd state-machine-core": {
        exitCode: 1,
        startedAt: "2025-01-01T00:00:00Z",
        finishedAt: "2025-01-01T00:00:05Z",
        elapsedMs: 5000
      }
    };
    const reportResults = {
      "build/reports/state-machines/latest.json": {
        exists: true,
        hash: "sha256:abcdef",
        generatedAt: "2025-01-01T00:00:03Z",
        data: { ok: true, machines: [{ machineId: "test.v1", ok: true }] }
      }
    };
    const commandStartTimes = { "test cmd state-machine-core": "2025-01-01T00:00:00Z" };
    const reportValidators = { "build/reports/state-machines/latest.json": validateStateMachineReport };

    const scope = READINESS_SCOPES.getScope("state-machine-core");
    const result = evaluateScopeEvidence(scope, evidencePlan, commandResults, reportResults, commit, commandStartTimes, reportValidators);

    expect(result.status).toBe("failed");
    expect(result.verificationMode).toBe("failed");
    expect(result.failureReasons.some(r => r.startsWith("command_failed"))).toBe(true);
  });

  it("scope must fail when required report is missing", () => {
    const commit = "abc123";
    const commandResults = {};
    const reportResults = {
      "build/reports/state-machines/latest.json": { exists: false, hash: null, generatedAt: null }
    };
    const reportValidators = {};

    const scope = READINESS_SCOPES.getScope("state-machine-schema");
    const result = evaluateScopeEvidence(scope, evidencePlan, commandResults, reportResults, commit, {}, reportValidators);

    expect(result.status).toBe("failed");
    expect(result.failureReasons.some(r => r.startsWith("report_missing"))).toBe(true);
  });

  it("proof-artifacts with missing traceability file fails", () => {
    const commit = "abc123";
    const reportResults = {
      "build/reports/state-machines/latest.json": {
        exists: true,
        hash: "sha256:abcdef",
        generatedAt: "2025-01-01T00:00:03Z",
        data: { ok: true, machines: [{ machineId: "test.v1", ok: true }] }
      },
      "docs/STATE-MACHINE-TRACEABILITY.md": { exists: false }
    };

    const scope = READINESS_SCOPES.getScope("proof-artifacts");
    const result = evaluateScopeEvidence(scope, evidencePlan, {}, reportResults, commit, {}, {});

    expect(result.status).toBe("failed");
    expect(result.failureReasons.some(r => r.startsWith("required_file_missing"))).toBe(true);
  });

  it("failure reasons use specific codes", () => {
    const commit = "abc123";
    const commandResults = {
      "test cmd state-machine-core": { exitCode: 1, startedAt: "2025-01-01T00:00:00Z", finishedAt: "2025-01-01T00:00:05Z", elapsedMs: 5000 }
    };
    const reportResults = {
      "build/reports/state-machines/latest.json": {
        exists: true,
        hash: "sha256:def",
        data: { ok: false, generatedAt: "2025-01-01T00:00:00Z" }
      }
    };
    const commandStartTimes = { "test cmd state-machine-core": "2025-01-01T00:00:00Z" };
    const reportValidators = { "build/reports/state-machines/latest.json": validateStateMachineReport };

    const scope = READINESS_SCOPES.getScope("state-machine-core");
    const result = evaluateScopeEvidence(scope, evidencePlan, commandResults, reportResults, commit, commandStartTimes, reportValidators);

    expect(result.failureReasons.some(r => r.startsWith("command_failed"))).toBe(true);
    expect(result.failureReasons.some(r => r.startsWith("report_failed"))).toBe(true);
  });
});

describe("Baseline Evidence - validateBaselineReadinessReport", () => {
  it("accepts valid report with baselineV0_1ClaimAllowed", () => {
    const report = {
      schemaVersion: "v0.0.1:schema:definition-1",
      reportType: "v0.0.1:production-readiness:report-0.1",
      runId: "test-run",
      commit: "abc123",
      baselineV0_1ClaimAllowed: false,
      scopes: [],
      summary: {},
      guardResults: {}
    };
    const result = validateBaselineReadinessReport(report);
    expect(result.ok).toBe(true);
  });

  it("rejects report missing baselineV0_1ClaimAllowed", () => {
    const report = {
      schemaVersion: "v0.0.1:schema:definition-1",
      reportType: "v0.0.1:production-readiness:report-0.1",
      runId: "test-run",
      commit: "abc123",
      scopes: [],
      summary: {},
      guardResults: {}
    };
    const result = validateBaselineReadinessReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes("baselineV0_1ClaimAllowed"))).toBe(true);
  });
});
