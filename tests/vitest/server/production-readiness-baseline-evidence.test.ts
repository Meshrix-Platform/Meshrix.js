import { describe, it, expect } from "vitest";
import {
  buildReadinessReport,
  evaluateReadinessGuard
} from "../../../packages/foundation/src/observability/readiness-baseline/readiness-guard-evaluator.ts";
import { READINESS_SCOPES } from "../../../packages/foundation/src/observability/readiness-baseline/readiness-scope-registry.ts";

/**
 * Pure unit: simulate evaluateScopeEvidence semantics from
 * verify-production-readiness-baseline.ts (updated for P0-B content validation).
 */
function evaluateScopeEvidence(scope?: any, evidencePlan?: any, commandResults?: any, reportResults?: any, commit?: any, commandStartTimes: Record<string, any> = {}, reportValidators: Record<string, any> = {}, definitionsRegistry: any = []) : any {
  const plan: any = evidencePlan[scope.scopeId] || { requiredCommands: [], requiredReports: [], requiredFiles: [] };
  const actualEvidence: any[] = [];
  const failureReasons: any[] = [];

  for (const reqCmd of plan.requiredCommands) {
    const cmdKey: any = reqCmd.join(" ");
    const result: any = commandResults[cmdKey];
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
    const reportData: any = reportResults[reportPath];
    if (!reportData || !reportData.exists) {
      failureReasons.push(`report_missing: ${reportPath}`);
      continue;
    }
    const validator: any = reportValidators[reportPath];
    if (validator) {
      const validation: any = validator(reportData.data || reportData);
      if (!validation.ok) {
        failureReasons.push(`report_failed(${validation.reason}): ${reportPath}`);
        continue;
      }
    }
    let fresh: any = false;
    const reportTimestamp: any = (reportData.data || reportData).generatedAt || reportData.generatedAt || null;
    if (reportTimestamp && Object.keys(commandStartTimes).length > 0) {
      for (const [, cmdStart] of (Object.entries(commandStartTimes) as [string, any][])) {
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
    const content: any = reportResults[filePath].content || "";
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

  const hasRequirements: any = plan.requiredCommands.length > 0 || plan.requiredReports.length > 0 || (plan.requiredFiles || []).length > 0;
  const verificationMode: any = hasRequirements
    ? (failureReasons.length === 0 ? "verified" : "failed")
    : "notRun";

  let status: any;
  if (scope.baselineV0_1Required) {
    status = failureReasons.length === 0 ? "passed" : "failed";
  } else {
    status = "not_in_baseline_v0_1";
  }

  return { status, verificationMode, actualEvidence, failureReasons };
}

function validateBaselineReadinessReport(report?: any) : any {
  const errors: any[] = [];
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

function validateStateMachineReport(report?: any) : any {
  if (!report || typeof report !== "object") return { ok: false, reason: "report_missing_or_invalid" };
  if (report.ok !== true) return { ok: false, reason: "report_failed" };
  if (!Array.isArray(report.machines) || report.machines.length === 0) return { ok: false, reason: "report_no_machines" };
  const failedMachines: any = report.machines.filter((m?: any) : any => m.ok !== true);
  if (failedMachines.length > 0) return { ok: false, reason: "report_machine_failed", failedMachineIds: failedMachines.map((m?: any) : any => m.machineId) };
  return { ok: true, reason: "report_valid" };
}

const evidencePlan: Record<string, any> = {
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

describe("Baseline Evidence - evaluateScopeEvidence", () : any => {
  it("baseline scope passes when all required commands succeed and reports pass validation", () : any => {
    const commit: any = "abc123";
    const commandResults: Record<string, any> = {
      "test cmd state-machine-core": {
        exitCode: 0,
        startedAt: "2025-01-01T00:00:00Z",
        finishedAt: "2025-01-01T00:00:05Z",
        elapsedMs: 5000
      }
    };
    const reportResults: Record<string, any> = {
      "build/reports/state-machines/latest.json": {
        exists: true,
        hash: "sha256:abcdef",
        generatedAt: "2025-01-01T00:00:03Z",
        data: { ok: true, machines: [{ machineId: "test.v1", ok: true }] }
      }
    };
    const commandStartTimes: Record<string, any> = { "test cmd state-machine-core": "2025-01-01T00:00:00Z" };
    const reportValidators: Record<string, any> = { "build/reports/state-machines/latest.json": validateStateMachineReport };

    const scope: any = READINESS_SCOPES.getScope("state-machine-core");
    const result: any = evaluateScopeEvidence(scope, evidencePlan, commandResults, reportResults, commit, commandStartTimes, reportValidators);

    expect(result.status).toBe("passed");
    expect(result.verificationMode).toBe("verified");
    expect(result.failureReasons).toEqual([]);
  });

  it("state-machines/latest.json with ok:false causes scope to fail", () : any => {
    const commit: any = "abc123";
    const commandResults: Record<string, any> = {
      "test cmd state-machine-core": {
        exitCode: 0,
        startedAt: "2025-01-01T00:00:00Z",
        finishedAt: "2025-01-01T00:00:05Z",
        elapsedMs: 5000
      }
    };
    const reportResults: Record<string, any> = {
      "build/reports/state-machines/latest.json": {
        exists: true,
        hash: "sha256:abcdef",
        generatedAt: "2025-01-01T00:00:03Z",
        data: { ok: false, machines: [] }
      }
    };
    const commandStartTimes: Record<string, any> = { "test cmd state-machine-core": "2025-01-01T00:00:00Z" };
    const reportValidators: Record<string, any> = { "build/reports/state-machines/latest.json": validateStateMachineReport };

    const scope: any = READINESS_SCOPES.getScope("state-machine-core");
    const result: any = evaluateScopeEvidence(scope, evidencePlan, commandResults, reportResults, commit, commandStartTimes, reportValidators);

    expect(result.status).toBe("failed");
    expect(result.failureReasons.some((r?: any) : any => r.includes("report_failed"))).toBe(true);
  });

  it("report older than command start is stale and scope fails", () : any => {
    const commit: any = "abc123";
    const commandResults: Record<string, any> = {
      "test cmd state-machine-core": {
        exitCode: 0,
        startedAt: "2025-01-01T00:10:00Z",
        finishedAt: "2025-01-01T00:10:05Z",
        elapsedMs: 5000
      }
    };
    const reportResults: Record<string, any> = {
      "build/reports/state-machines/latest.json": {
        exists: true,
        hash: "sha256:abcdef",
        generatedAt: "2025-01-01T00:00:00Z",
        data: { ok: true, machines: [{ machineId: "test.v1", ok: true }] }
      }
    };
    const commandStartTimes: Record<string, any> = { "test cmd state-machine-core": "2025-01-01T00:10:00Z" };
    const reportValidators: Record<string, any> = { "build/reports/state-machines/latest.json": validateStateMachineReport };

    const scope: any = READINESS_SCOPES.getScope("state-machine-schema");
    const result: any = evaluateScopeEvidence(scope, evidencePlan, commandResults, reportResults, commit, commandStartTimes, reportValidators);

    expect(result.status).toBe("failed");
    expect(result.failureReasons.some((r?: any) : any => r.includes("report_stale"))).toBe(true);
  });

  it("scope must fail when required command exitCode is non-zero", () : any => {
    const commit: any = "abc123";
    const commandResults: Record<string, any> = {
      "test cmd state-machine-core": {
        exitCode: 1,
        startedAt: "2025-01-01T00:00:00Z",
        finishedAt: "2025-01-01T00:00:05Z",
        elapsedMs: 5000
      }
    };
    const reportResults: Record<string, any> = {
      "build/reports/state-machines/latest.json": {
        exists: true,
        hash: "sha256:abcdef",
        generatedAt: "2025-01-01T00:00:03Z",
        data: { ok: true, machines: [{ machineId: "test.v1", ok: true }] }
      }
    };
    const commandStartTimes: Record<string, any> = { "test cmd state-machine-core": "2025-01-01T00:00:00Z" };
    const reportValidators: Record<string, any> = { "build/reports/state-machines/latest.json": validateStateMachineReport };

    const scope: any = READINESS_SCOPES.getScope("state-machine-core");
    const result: any = evaluateScopeEvidence(scope, evidencePlan, commandResults, reportResults, commit, commandStartTimes, reportValidators);

    expect(result.status).toBe("failed");
    expect(result.verificationMode).toBe("failed");
    expect(result.failureReasons.some((r?: any) : any => r.startsWith("command_failed"))).toBe(true);
  });

  it("scope must fail when required report is missing", () : any => {
    const commit: any = "abc123";
    const commandResults: Record<string, any> = {};
    const reportResults: Record<string, any> = {
      "build/reports/state-machines/latest.json": { exists: false, hash: null, generatedAt: null }
    };
    const reportValidators: Record<string, any> = {};

    const scope: any = READINESS_SCOPES.getScope("state-machine-schema");
    const result: any = evaluateScopeEvidence(scope, evidencePlan, commandResults, reportResults, commit, {}, reportValidators);

    expect(result.status).toBe("failed");
    expect(result.failureReasons.some((r?: any) : any => r.startsWith("report_missing"))).toBe(true);
  });

  it("proof-artifacts with missing traceability file fails", () : any => {
    const commit: any = "abc123";
    const reportResults: Record<string, any> = {
      "build/reports/state-machines/latest.json": {
        exists: true,
        hash: "sha256:abcdef",
        generatedAt: "2025-01-01T00:00:03Z",
        data: { ok: true, machines: [{ machineId: "test.v1", ok: true }] }
      },
      "docs/STATE-MACHINE-TRACEABILITY.md": { exists: false }
    };

    const scope: any = READINESS_SCOPES.getScope("proof-artifacts");
    const result: any = evaluateScopeEvidence(scope, evidencePlan, {}, reportResults, commit, {}, {});

    expect(result.status).toBe("failed");
    expect(result.failureReasons.some((r?: any) : any => r.startsWith("required_file_missing"))).toBe(true);
  });

  it("failure reasons use specific codes", () : any => {
    const commit: any = "abc123";
    const commandResults: Record<string, any> = {
      "test cmd state-machine-core": { exitCode: 1, startedAt: "2025-01-01T00:00:00Z", finishedAt: "2025-01-01T00:00:05Z", elapsedMs: 5000 }
    };
    const reportResults: Record<string, any> = {
      "build/reports/state-machines/latest.json": {
        exists: true,
        hash: "sha256:def",
        data: { ok: false, generatedAt: "2025-01-01T00:00:00Z" }
      }
    };
    const commandStartTimes: Record<string, any> = { "test cmd state-machine-core": "2025-01-01T00:00:00Z" };
    const reportValidators: Record<string, any> = { "build/reports/state-machines/latest.json": validateStateMachineReport };

    const scope: any = READINESS_SCOPES.getScope("state-machine-core");
    const result: any = evaluateScopeEvidence(scope, evidencePlan, commandResults, reportResults, commit, commandStartTimes, reportValidators);

    expect(result.failureReasons.some((r?: any) : any => r.startsWith("command_failed"))).toBe(true);
    expect(result.failureReasons.some((r?: any) : any => r.startsWith("report_failed"))).toBe(true);
  });
});

describe("Baseline Evidence - validateBaselineReadinessReport", () : any => {
  it("accepts valid report with baselineV0_1ClaimAllowed", () : any => {
    const report: Record<string, any> = {
      schemaVersion: "v0.0.1:schema:definition-1",
      reportType: "v0.0.1:production-readiness:report-0.1",
      runId: "test-run",
      commit: "abc123",
      baselineV0_1ClaimAllowed: false,
      scopes: [],
      summary: {},
      guardResults: {}
    };
    const result: any = validateBaselineReadinessReport(report);
    expect(result.ok).toBe(true);
  });

  it("rejects report missing baselineV0_1ClaimAllowed", () : any => {
    const report: Record<string, any> = {
      schemaVersion: "v0.0.1:schema:definition-1",
      reportType: "v0.0.1:production-readiness:report-0.1",
      runId: "test-run",
      commit: "abc123",
      scopes: [],
      summary: {},
      guardResults: {}
    };
    const result: any = validateBaselineReadinessReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e?: any) : any => e.includes("baselineV0_1ClaimAllowed"))).toBe(true);
  });
});
