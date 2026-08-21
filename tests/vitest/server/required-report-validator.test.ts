import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  REQUIRED_REPORT_REDUCERS,
  REQUIRED_REPORT_SPECS,
  requiredReportSpec,
  validateRequiredReport,
  validateRequiredReportSpecCoverage
} from "../../../tools/server-scripts/lib/required-report-validator.ts";
import {
  createAggregateReleaseEvidenceReadiness,
  createReleaseEvidenceReadiness
} from "../../../tools/server-scripts/lib/release-evidence-readiness.ts";
import {
  ACCEPTANCE_REQUIRED_REPORTS,
  PRIVATE_DEPLOYMENT_EVIDENCE_COMMANDS as PRIVATE_DEPLOYMENT_COMMANDS,
  PLATFORM_ACCEPTANCE_COMMANDS,
  aggregateChildReportLeakScan,
  createPlatformAcceptancePlan
} from "../../../tools/server-scripts/verify-platform-acceptance.ts";
import {
  PRIVATE_DEPLOYMENT_INTERNAL_PLATFORM_E2E_REPORT_PATH
} from "../../../tools/server-scripts/lib/private-deployment-internal-platform-e2e-catalog.ts";
import { reportPayloadDigest } from "../../../tools/server-scripts/lib/sensitive-report-scan.ts";
import {
  createReleaseEvidenceInventory,
  RELEASE_REPORT_PROVENANCE_SCHEMA,
  releaseEvidenceInventoryDigest,
  releaseEvidenceReportPayloadDigest,
  stampReleaseReportProvenance
} from "../../../tools/server-scripts/lib/release-report-provenance.ts";

const REPORT_PATH: any = "build/reports/repo-organization.json";
const GENERATED_AT: any = "2026-07-10T04:00:01.000Z";
const MINIMUM_TIMESTAMP_MS: any = Date.parse("2026-07-10T04:00:00.000Z");
const NOW_MS: any = Date.parse("2026-07-10T04:01:00.000Z");
const SYNTHETIC_LINUX_HOME_PATH: any = ["", "home", "example", "private-runtime.log"].join("/");
const POSIX_HOME_PLACEHOLDER: any = ["", "home", "<user>", "private-runtime.log"].join("/");
const DOCUMENTATION_PATH_URL: any = [
  "https://docs.example.test",
  "home",
  "example",
  "private-runtime.log"
].join("/");
const DOCUMENTATION_QUERY_URL: any = `https://docs.example.test/guide?path=${SYNTHETIC_LINUX_HOME_PATH}`;

function validReport(overrides: Record<string, any> = {}) : any {
  const spec: any = requiredReportSpec(REPORT_PATH);
  return {
    schemaVersion: spec.schemaVersion,
    verifier: spec.verifier,
    generatedAt: GENERATED_AT,
    summary: {
      releaseReady: true,
      reportLeakScan: true,
      policyContractVerified: true,
      lineCountGateStatus: "disabled",
      machineEnforcedRuleCount: 1,
      reviewOnlySignalCount: 1,
      sourceOrganizationDiscoveredFileCount: 3,
      sourceOrganizationAnalyzedFileCount: 2,
      sourceOrganizationUnsupportedFileCount: 1,
      sourceOrganizationParseFailureCount: 0,
      sourceOrganizationSplitCandidateCount: 1,
      sourceOrganizationMechanicalSplitCautionCount: 0,
      releaseBlockingFindingCount: 0,
      missingRequiredFileCount: 0
    },
    policy: {
      sourceOfTruth: "tools/registry/repo-layout.registry.json#repoOrganizationAudit.sourceFileOrganization",
      canonicalDocument: "docs/architecture/ARCHITECTURE.md#source-file-organization",
      lineCountGate: {
        status: "disabled",
        threshold: null,
        releaseBlocking: false,
        statement: "No numeric source-file line-count ceiling is used as an acceptance criterion."
      },
      decisionBasis: ["responsibility"],
      machineEnforcedRules: [{ id: "runnable_entrypoint_ownership", releaseBlocking: true }],
      delegatedGateIds: ["architecture.import-graph"],
      reviewOnlySignals: [{ id: "file_length", collectedByThisReport: false, releaseBlocking: false }],
      astAdvisory: {
        mode: "advisory",
        releaseBlocking: false,
        statement: "AST results require review."
      }
    },
    sourceOrganizationAnalysis: {
      mode: "advisory",
      releaseBlocking: false,
      status: "completed",
      engine: { id: "typescript-compiler-api", version: "fixture" },
      algorithm: { id: "fixture", complexity: "O(n)" },
      limitations: ["Automated analysis cannot prove a safe split."],
      selfTest: { passed: true },
      summary: {
        discoveredFileCount: 3,
        analyzedFileCount: 2,
        unsupportedFileCount: 1,
        parseFailureCount: 0,
        skippedProjectionFileCount: 0,
        splitCandidateCount: 1,
        mechanicalSplitCautionCount: 0,
        noStructuralSignalCount: 1,
        durationMs: 1
      },
      unsupportedByReason: { vue_template_bindings_not_modeled: 1 },
      splitCandidates: [{
        code: "independent_exported_behavior_components",
        severity: "advisory",
        releaseBlocking: false,
        file: "packages/example/src/candidate.ts"
      }],
      mechanicalSplitCautions: [],
      parseFailures: []
    },
    ...overrides
  };
}

function validate(report: any = validReport()) : any {
  return validateRequiredReport(REPORT_PATH, JSON.stringify(report), {
    minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
    nowMs: NOW_MS
  });
}

describe("required report validator", () : any => {
  it("uses only the composition source-package capability acceptance field", () : any => {
    const reportPath: any = "build/reports/composition-source-package.json";
    const spec: any = requiredReportSpec(reportPath);
    expect(spec.readyFields).toEqual(["summary.compositionSourcePackageAcceptanceReady"]);
    const report: Record<string, any> = {
      schemaVersion: spec.schemaVersion,
      verifier: spec.verifier,
      generatedAt: GENERATED_AT,
      summary: {
        compositionSourcePackageAcceptanceReady: true,
        reportLeakScan: true
      }
    };
    expect(createReleaseEvidenceReadiness(reportPath, report)).toMatchObject({
      releaseReady: true,
      readyField: "summary.compositionSourcePackageAcceptanceReady",
      reasons: []
    });
  });

  it("registers every acceptance-required report and excludes the aggregate output", () : any => {
    const coverage: any = validateRequiredReportSpecCoverage(ACCEPTANCE_REQUIRED_REPORTS, {
      aggregateReportPath: "build/reports/platform-acceptance.json"
    });

    expect(Object.keys(REQUIRED_REPORT_SPECS)).toEqual(
      expect.arrayContaining(ACCEPTANCE_REQUIRED_REPORTS)
    );
    expect(coverage).toMatchObject({
      ok: true,
      requiredReportCount: ACCEPTANCE_REQUIRED_REPORTS.length,
      registeredReportCount: ACCEPTANCE_REQUIRED_REPORTS.length,
      reasons: []
    });
    expect(ACCEPTANCE_REQUIRED_REPORTS).not.toContain("build/reports/platform-acceptance.json");
  });

  it("projects one complete release provenance owner for every required report", () : any => {
    const plan: any = createPlatformAcceptancePlan(undefined, { selectedProfile: "enterprise-single-node" });
    expect(plan.releaseEvidenceInventory).toHaveLength(ACCEPTANCE_REQUIRED_REPORTS.length);
    expect(plan.releaseEvidenceInventory.every((entry?: any) : any =>
      entry.provenanceSchemaVersion === RELEASE_REPORT_PROVENANCE_SCHEMA &&
      Boolean(entry.ownerCommandId) &&
      Boolean(entry.producer)
    )).toBe(true);
    expect(new Set<any>(plan.releaseEvidenceInventory.map((entry?: any) : any => entry.reportPath)).size)
      .toBe(ACCEPTANCE_REQUIRED_REPORTS.length);
    expect(plan.releaseEvidenceInventoryDigest).toBe(
      releaseEvidenceInventoryDigest(plan.releaseEvidenceInventory)
    );
    expect(createReleaseEvidenceInventory({
      commands: PLATFORM_ACCEPTANCE_COMMANDS,
      requiredReportPaths: ACCEPTANCE_REQUIRED_REPORTS
    })).toEqual(plan.releaseEvidenceInventory);
  });

  it("rejects missing or mismatched generation provenance when an owner is required", () : any => {
    const expected: Record<string, any> = {
      schemaVersion: RELEASE_REPORT_PROVENANCE_SCHEMA,
      producer: requiredReportSpec(REPORT_PATH).verifier,
      commandId: "repo-organization"
    };
    const report: any = validReport({
      releaseEvidenceProvenance: {
        ...expected,
        recordedAt: GENERATED_AT
      }
    });
    report.releaseEvidenceProvenance.reportPayloadDigest =
      releaseEvidenceReportPayloadDigest(report);
    expect(validateRequiredReport(REPORT_PATH, report, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS,
      expectedReleaseEvidenceProvenance: expected
    })).toMatchObject({ accepted: true, reasons: [] });

    const missing: any = structuredClone(report);
    delete missing.releaseEvidenceProvenance;
    expect(validateRequiredReport(REPORT_PATH, missing, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS,
      expectedReleaseEvidenceProvenance: expected
    }).reasons).toContain("required-report-release-provenance-mismatch:commandId");

    const mismatched: any = structuredClone(report);
    mismatched.releaseEvidenceProvenance.commandId = "wrong-owner";
    expect(validateRequiredReport(REPORT_PATH, mismatched, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS,
      expectedReleaseEvidenceProvenance: expected
    }).reasons).toContain("required-report-release-provenance-mismatch:commandId");

    const tampered: any = structuredClone(report);
    tampered.summary.releaseReady = false;
    expect(validateRequiredReport(REPORT_PATH, tampered, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS,
      expectedReleaseEvidenceProvenance: expected
    }).reasons).toContain("required-report-release-provenance-payload-digest-mismatch");

    const stale: any = structuredClone(report);
    stale.releaseEvidenceProvenance.recordedAt = "2026-07-10T03:59:59.000Z";
    expect(validateRequiredReport(REPORT_PATH, stale, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS,
      expectedReleaseEvidenceProvenance: expected
    }).reasons).toContain("required-report-release-provenance-timestamp-stale");
  });

  it("stamps command-owned generation provenance and preserves payload integrity", async () : Promise<any> => {
    const repoRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-release-provenance-"));
    const reportPath: any = "build/reports/observability-runtime-acceptance.json";
    const spec: any = requiredReportSpec(reportPath);
    const report: Record<string, any> = {
      schemaVersion: spec.schemaVersion,
      verifier: spec.verifier,
      producer: spec.provenance.producer,
      commandId: spec.provenance.commandId,
      sourceRevision: "sha256:fixture-source-revision",
      generatedAt: GENERATED_AT,
      finishedAt: GENERATED_AT,
      reportOwner: spec.provenance.producer,
      checkpointDigest: `sha256:${"a".repeat(64)}`,
      requirements: ["REQ-REL-011"],
      privacyFinalization: {
        finalizer: "meshrix-core-observability",
        redactionApplied: true,
        privacyScanPassed: true,
        atomicPublication: true
      },
      resourceBudgets: {
        maxReportBytes: 1,
        maxScanDepth: 1,
        maxScanItems: 1
      },
      summary: { readyForReleaseReduction: true, reportLeakScan: true }
    };
    report.payloadDigest = reportPayloadDigest(report);
    const filePath: any = path.join(repoRoot, reportPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(report)}\n`, "utf8");
    try {
      const expectedByPath: any = await stampReleaseReportProvenance({
        repoRoot,
        commands: [{ id: "observability-runtime", report: reportPath }],
        results: [{ id: "observability-runtime", status: "passed" }],
        requiredReportPaths: [reportPath],
        recordedAt: GENERATED_AT
      });
      const stamped: any = JSON.parse(await fs.readFile(filePath, "utf8"));
      expect(validateRequiredReport(reportPath, stamped, {
        minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
        nowMs: NOW_MS,
        expectedReleaseEvidenceProvenance: expectedByPath.get(reportPath)
      })).toMatchObject({ accepted: true, reasons: [] });
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects observability reports that bypass the canonical finalization contract", () : any => {
    const reportPath: any = "build/reports/observability-runtime-acceptance.json";
    const spec: any = requiredReportSpec(reportPath);
    const report: Record<string, any> = {
      schemaVersion: spec.schemaVersion,
      verifier: spec.verifier,
      producer: spec.provenance.producer,
      commandId: spec.provenance.commandId,
      sourceRevision: "sha256:fixture-source-revision",
      generatedAt: GENERATED_AT,
      finishedAt: GENERATED_AT,
      summary: { readyForReleaseReduction: true, reportLeakScan: true }
    };
    report.payloadDigest = reportPayloadDigest(report);
    expect(validateRequiredReport(reportPath, report, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS
    }).reasons).toEqual(expect.arrayContaining([
      "required-report-finalization-owner-mismatch",
      "required-report-checkpoint-digest-invalid",
      "required-report-requirements-invalid",
      "required-report-privacy-finalization-invalid",
      "required-report-resource-budgets-invalid"
    ]));
  });

  it("rejects missing provenance and payload tampering for observability reports", () : any => {
    const observabilityReportPaths: any[] = [
      "build/reports/enterprise-audit-retention-redaction.json",
      "build/reports/enterprise-observability-coverage.json",
      "build/reports/observability-runtime-acceptance.json",
      "build/reports/observability-semantics.json",
      "build/reports/security-alert-lifecycle.json"
    ];
    for (const path of observabilityReportPaths) {
      expect(requiredReportSpec(path)?.readyFields).toEqual(["summary.readyForReleaseReduction"]);
    }
    const reportPath: any = "build/reports/observability-runtime-acceptance.json";
    const spec: any = requiredReportSpec(reportPath);
    const report: Record<string, any> = {
      schemaVersion: spec.schemaVersion,
      verifier: spec.verifier,
      producer: spec.provenance.producer,
      commandId: spec.provenance.commandId,
      sourceRevision: "sha256:fixture-source-revision",
      generatedAt: GENERATED_AT,
      finishedAt: GENERATED_AT,
      reportOwner: spec.provenance.producer,
      checkpointDigest: `sha256:${"c".repeat(64)}`,
      requirements: ["REQ-REL-011"],
      privacyFinalization: {
        finalizer: "meshrix-core-observability",
        redactionApplied: true,
        privacyScanPassed: true,
        atomicPublication: true
      },
      resourceBudgets: {
        maxReportBytes: 1,
        maxScanDepth: 1,
        maxScanItems: 1
      },
      summary: { readyForReleaseReduction: true, reportLeakScan: true }
    };
    report.payloadDigest = reportPayloadDigest(report);
    expect(validateRequiredReport(reportPath, report, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS
    })).toMatchObject({ accepted: true, reasons: [] });

    const tampered: any = structuredClone(report);
    tampered.summary.readyForReleaseReduction = false;
    expect(validateRequiredReport(reportPath, tampered, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS
    }).reasons).toContain("required-report-payload-digest-mismatch");

    const missingCommand: any = structuredClone(report);
    delete missingCommand.commandId;
    delete missingCommand.payloadDigest;
    missingCommand.payloadDigest = reportPayloadDigest(missingCommand);
    expect(validateRequiredReport(reportPath, missingCommand, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS
    }).reasons).toContain("required-report-provenance-mismatch");
  });

  it("rejects destructive provenance changes for upload workspace materialization evidence", () : any => {
    const reportPath: any = "build/reports/upload-workspace-materialization.json";
    const spec: any = requiredReportSpec(reportPath);
    const report: Record<string, any> = {
      schemaVersion: spec.schemaVersion,
      verifier: spec.verifier,
      producer: spec.provenance.producer,
      commandId: spec.provenance.commandId,
      sourceRevision: "sha256:fixture-source-revision",
      generatedAt: GENERATED_AT,
      finishedAt: GENERATED_AT,
      releaseReady: true,
      summary: { releaseReady: true, reportLeakScan: true }
    };
    report.payloadDigest = reportPayloadDigest(report);
    expect(validateRequiredReport(reportPath, report, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS
    })).toMatchObject({ accepted: true, reasons: [] });
    for (const field of ["producer", "commandId"]) {
      const tampered: any = structuredClone(report);
      tampered[field] = `wrong-${field}`;
      delete tampered.payloadDigest;
      tampered.payloadDigest = reportPayloadDigest(tampered);
      expect(validateRequiredReport(reportPath, tampered, {
        minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
        nowMs: NOW_MS
      }).reasons).toContain("required-report-provenance-mismatch");
    }
  });

  it("assigns nested producers for reports absent during plan-only execution", () : any => {
    expect(PRIVATE_DEPLOYMENT_COMMANDS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        report: "build/reports/deployment-container-flow.json"
      })
    ]));
    expect(PLATFORM_ACCEPTANCE_COMMANDS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        report: "build/reports/observability-runtime-acceptance.json"
      }),
      expect.objectContaining({
        report: "build/reports/production-readiness-gates.json"
      }),
      expect.objectContaining({
        report: PRIVATE_DEPLOYMENT_INTERNAL_PLATFORM_E2E_REPORT_PATH
      })
    ]));
  });

  it("accepts raw JSON only when its exact schema, verifier, timestamp and leak flag match", () : any => {
    const validation: any = validate();

    expect(validation).toMatchObject({
      registered: true,
      accepted: true,
      reportLeakScan: true,
      sensitiveLeakScanPassed: true,
      embeddedReportLeakScanPassed: true,
      reducer: REQUIRED_REPORT_REDUCERS.REPO_ORGANIZATION,
      readyField: "summary.releaseReady",
      reasons: []
    });
  });

  it("fails closed for an unregistered report path", () : any => {
    const validation: any = validateRequiredReport(
      "build/reports/not-registered.json",
      JSON.stringify(validReport()),
      { minimumTimestampMs: MINIMUM_TIMESTAMP_MS, nowMs: NOW_MS }
    );
    const readiness: any = createReleaseEvidenceReadiness(
      "build/reports/not-registered.json",
      validReport(),
      { minimumTimestampMs: MINIMUM_TIMESTAMP_MS, nowMs: NOW_MS }
    );

    expect(validation).toMatchObject({
      registered: false,
      accepted: false,
      reportLeakScan: false,
      report: null,
      reasons: ["required-report-spec-unregistered"]
    });
    expect(readiness).toMatchObject({
      releaseReady: false,
      reportLeakScan: false,
      requiredReportValidationPassed: false,
      reasons: ["required-report-spec-unregistered"]
    });
  });

  it.each([
    ["schema mismatch", { schemaVersion: "wrong-schema" }, "required-report-schema-version-mismatch"],
    ["verifier mismatch", { verifier: "wrong-verifier" }, "required-report-verifier-mismatch"],
    ["missing timestamp", { generatedAt: undefined }, "required-report-timestamp-missing-or-invalid"],
    ["stale timestamp", { generatedAt: "2026-07-10T03:59:59.000Z" }, "required-report-timestamp-stale"]
  ])("rejects %s", (_label?: any, overrides?: any, reason?: any) : any => {
    const validation: any = validate(validReport(overrides));

    expect(validation.accepted).toBe(false);
    expect(validation.report).toBeNull();
    expect(validation.reasons).toContain(reason);
  });

  it.each([
    ["blocked dependency", {
      dependencies: {
        producer: { status: "blocked" }
      }
    }, "required-report-explicit-not-ready:dependencies.producer.status:blocked"],
    ["missing production evidence", {
      dependencies: {
        producer: {
          status: "missing",
          acceptedAsProductionEvidence: false
        }
      }
    }, "required-report-production-evidence-rejected:dependencies.producer.acceptedAsProductionEvidence"],
    ["stale summary state", {
      summary: {
        ...validReport().summary,
        liveStatus: "stale"
      }
    }, "required-report-explicit-not-ready:summary.liveStatus:stale"]
  ])("does not let a true ready field override %s", (_label?: any, overrides?: any, reason?: any) : any => {
    const validation: any = validate(validReport(overrides));
    const readiness: any = createReleaseEvidenceReadiness(REPORT_PATH, validReport(overrides), {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reasons).toContain(reason);
    expect(readiness.releaseReady).toBe(false);
    expect(readiness.reasons).toContain(reason);
  });

  it("registers structural audits with a scoped structural signal instead of a release-ready field", () : any => {
    expect(requiredReportSpec("build/reports/core-platform-gap-audit.json").readyFields)
      .toEqual(["summary.structuralCoverageReady"]);
    expect(requiredReportSpec("build/reports/core-platform-surface-convergence.json").readyFields)
      .toEqual(["summary.structuralCoverageReady"]);
  });

  it.each([
    ["missing", {}],
    ["false", { reportLeakScan: false }]
  ])("rejects a %s embedded report leak scan", (_label?: any, summaryOverride?: any) : any => {
    const report: any = validReport({
      summary: {
        releaseReady: true,
        ...summaryOverride
      }
    });
    const validation: any = validate(report);

    expect(validation.accepted).toBe(false);
    expect(validation.reportLeakScan).toBe(false);
    expect(validation.reasons).toContain("required-report-leak-scan-not-passed");
  });

  it("scans the full child report before reduction without returning sensitive content", () : any => {
    const bearerMaterial: any = ["Bearer", "fixture-auth-material"].join(" ");
    const validation: any = validate(validReport({ nestedEvidence: { detail: bearerMaterial } }));

    expect(validation.accepted).toBe(false);
    expect(validation.reportLeakScan).toBe(false);
    expect(validation.report).toBeNull();
    expect(validation.reasons).toContain("required-report-sensitive-data-detected");
    expect(JSON.stringify(validation)).not.toContain(bearerMaterial);
  });

  it("rejects a synthetic Linux home path before required-report reduction", () : any => {
    const report: any = validReport({ diagnostic: SYNTHETIC_LINUX_HOME_PATH });
    const validation: any = validate(report);
    const readiness: any = createReleaseEvidenceReadiness(
      REPORT_PATH,
      JSON.stringify(report),
      { minimumTimestampMs: MINIMUM_TIMESTAMP_MS, nowMs: NOW_MS }
    );

    expect(validation.accepted).toBe(false);
    expect(validation.sensitiveLeakScanPassed).toBe(false);
    expect(validation.reasons).toContain("required-report-sensitive-data-detected");
    expect(readiness.releaseReady).toBe(false);
    expect(readiness.requiredReportValidationPassed).toBe(false);
  });

  it.each([
    ["canonical placeholder", "<user-home>/private-runtime.log"],
    ["POSIX placeholder", POSIX_HOME_PLACEHOLDER],
    ["documentation URL", DOCUMENTATION_PATH_URL],
    ["documentation URL query", DOCUMENTATION_QUERY_URL]
  ])("does not treat a %s as a local-path leak", (_label?: any, diagnostic?: any) : any => {
    const validation: any = validate(validReport({ diagnostic }));

    expect(validation.accepted).toBe(true);
    expect(validation.sensitiveLeakScanPassed).toBe(true);
  });

  it("does not confuse escaped assertion newlines with Windows drive paths", () : any => {
    const ordinaryAssertion: any = "Expected values to be strictly equal:\n\nfalse !== true\n";
    const validation: any = validate(validReport({ failure: { message: ordinaryAssertion } }));

    expect(validation.accepted).toBe(true);
    expect(validation.sensitiveLeakScanPassed).toBe(true);

    const windowsPath: any = ["C:", "Users", "example", "secret.json"].join("\\");
    const rejected: any = validate(validReport({ failure: { message: windowsPath } }));
    expect(rejected.accepted).toBe(false);
    expect(rejected.reasons).toContain("required-report-sensitive-data-detected");
  });

  it("rejects conflicting ready aliases before reducer selection", () : any => {
    const validation: any = validate(validReport({ releaseReady: false }));

    expect(validation.accepted).toBe(false);
    expect(validation.reasons).toContain("required-report-ready-field-conflict");
  });

  it("passes validated evidence to the exact registered reducer", () : any => {
    const readiness: any = createReleaseEvidenceReadiness(
      REPORT_PATH,
      JSON.stringify(validReport()),
      { minimumTimestampMs: MINIMUM_TIMESTAMP_MS, nowMs: NOW_MS }
    );

    expect(readiness).toMatchObject({
      releaseReady: true,
      reportLeakScan: true,
      requiredReportValidationPassed: true,
      reducerSourceOfTruth: REQUIRED_REPORT_REDUCERS.REPO_ORGANIZATION,
      readyField: "summary.releaseReady",
      reasons: []
    });
  });

  it("enforces the organization policy while keeping AST candidates non-blocking", () : any => {
    const options: Record<string, any> = { minimumTimestampMs: MINIMUM_TIMESTAMP_MS, nowMs: NOW_MS };
    const ready: any = createReleaseEvidenceReadiness(REPORT_PATH, validReport(), options);
    expect(ready).toMatchObject({ releaseReady: true, reasons: [] });

    const lineGateEnabled: any = structuredClone(validReport());
    lineGateEnabled.policy.lineCountGate.status = "enabled";
    expect(createReleaseEvidenceReadiness(REPORT_PATH, lineGateEnabled, options).reasons)
      .toContain("repo-organization-line-count-gate-not-disabled");

    const wrongCanonical: any = structuredClone(validReport());
    wrongCanonical.policy.canonicalDocument = "docs/architecture/OTHER.md#source-file-organization";
    expect(createReleaseEvidenceReadiness(REPORT_PATH, wrongCanonical, options).reasons)
      .toContain("repo-organization-canonical-document-mismatch");

    const blockingAst: any = structuredClone(validReport());
    blockingAst.sourceOrganizationAnalysis.releaseBlocking = true;
    expect(createReleaseEvidenceReadiness(REPORT_PATH, blockingAst, options).reasons)
      .toContain("repo-organization-ast-analysis-not-advisory");

    const mismatchedCount: any = structuredClone(validReport());
    mismatchedCount.sourceOrganizationAnalysis.summary.splitCandidateCount = 2;
    expect(createReleaseEvidenceReadiness(REPORT_PATH, mismatchedCount, options).reasons)
      .toContain("repo-organization-ast-candidate-count-mismatch");
  });
});

describe("aggregate report leak reduction", () : any => {
  it("requires explicit execution and exact non-negative integer counters", () : any => {
    const base: Record<string, any> = {
      allCommandsExecuted: true,
      failedCommandCount: 0,
      failedCommands: [],
      missingEvidenceCount: 0,
      missingEvidence: [],
      reportLeakScan: true
    };

    expect(createAggregateReleaseEvidenceReadiness(base).releaseReady).toBe(true);
    expect(createAggregateReleaseEvidenceReadiness({
      ...base,
      allCommandsExecuted: undefined
    }).reasons).toContain("aggregate-commands-not-fully-executed");
    for (const invalidCount of [undefined, "0", -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(createAggregateReleaseEvidenceReadiness({
        ...base,
        failedCommandCount: invalidCount
      }).reasons).toContain("aggregate-failed-command-count-invalid");
      expect(createAggregateReleaseEvidenceReadiness({
        ...base,
        missingEvidenceCount: invalidCount
      }).reasons).toContain("aggregate-missing-evidence-count-invalid");
    }
  });

  it("requires counters to match their evidence arrays", () : any => {
    const result: any = createAggregateReleaseEvidenceReadiness({
      allCommandsExecuted: true,
      failedCommandCount: 0,
      failedCommands: ["failed-command"],
      missingEvidenceCount: 0,
      missingEvidence: ["missing-report"],
      reportLeakScan: true
    });

    expect(result.releaseReady).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "aggregate-failed-command-count-mismatch:0:1",
      "aggregate-missing-evidence-count-mismatch:0:1"
    ]));
  });

  it("fails closed when reportLeakScan is false or missing", () : any => {
    expect(createAggregateReleaseEvidenceReadiness({
      allCommandsExecuted: true,
      failedCommandCount: 0,
      missingEvidenceCount: 0,
      reportLeakScan: false
    }).releaseReady).toBe(false);
    expect(createAggregateReleaseEvidenceReadiness({
      allCommandsExecuted: true,
      failedCommandCount: 0,
      missingEvidenceCount: 0
    }).releaseReady).toBe(false);
  });

  it("derives aggregate leak safety from every required child result", () : any => {
    const requiredReports: any[] = ["one.json", "two.json"];
    const safeEvidence: Record<string, any> = {
      "one.json": { validationPassed: true, reportLeakScan: true },
      "two.json": { validationPassed: true, reportLeakScan: true }
    };

    expect(aggregateChildReportLeakScan({
      requiredReports,
      reportEvidence: safeEvidence,
      missingReports: []
    })).toBe(true);
    expect(aggregateChildReportLeakScan({
      requiredReports,
      reportEvidence: {
        ...safeEvidence,
        "two.json": { validationPassed: true, reportLeakScan: false }
      },
      missingReports: []
    })).toBe(false);
    expect(aggregateChildReportLeakScan({
      requiredReports,
      reportEvidence: safeEvidence,
      missingReports: ["two.json"]
    })).toBe(false);
  });

  it("keeps the production leak-scan call bound to missingReports, not evidence-state reduction", async () : Promise<any> => {
    const source: any = await fs.readFile(
      path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "../../../tools/server-scripts/verify-platform-acceptance.ts"
      ),
      "utf8"
    );
    const callMatch: any = source.match(
      /aggregateChildReportLeakScan\(\{\s*requiredReports:\s*ACCEPTANCE_REQUIRED_REPORTS,\s*reportEvidence,\s*missingReports\s*\}\)/u
    );
    expect(callMatch).not.toBeNull();
    expect(source).not.toMatch(/aggregateChildReportLeakScan\(\s*evidenceStateReduction/u);
    expect(source).not.toMatch(/aggregateChildReportLeakScan\(\s*ACCEPTANCE_REQUIRED_REPORTS\s*,\s*reportEvidence\s*,\s*evidenceStateReduction/u);
  });
});

describe("platform acceptance foundation ownership", () : any => {
  it("runs the public foundation gate once and declares its child report locks", () : any => {
    const commandIds: any = PLATFORM_ACCEPTANCE_COMMANDS.map((command?: any) : any => command.id);
    const foundation: any = PLATFORM_ACCEPTANCE_COMMANDS.find((command?: any) : any => command.id === "foundation-tests");

    expect(commandIds).not.toContain("hygiene");
    expect(commandIds).not.toContain("script-registry");
    expect(foundation).toMatchObject({
      command: "npm",
      args: ["test"],
      exclusive: true
    });
    expect(foundation.resourceLocks).toEqual(expect.arrayContaining([
      "report:build/test-reports/latest.json",
      "report:build/reports/local-info-hygiene.json",
      "report:build/reports/script-registry.json"
    ]));
  });

  it("creates a sanitized plan with canonical rather than host-derived parallelism", () : any => {
    const plan: any = createPlatformAcceptancePlan(undefined, { selectedProfile: "enterprise-single-node" });
    const serialized: any = JSON.stringify(plan);

    expect(plan.status).toBe("planned");
    expect(plan.summary.reportLeakScan).toBe(true);
    expect(serialized).not.toContain("hostParallelism");
    expect(plan.declaredWorstCaseEstimate).toMatchObject({ maxParallel: 4 });
    expect(plan.declaredJobBudgetMs).toBeGreaterThan(
      plan.declaredWorstCaseEstimate.timeoutMs
    );
  });

  it("gates portable MCP assembly on pinned Node runtime supply-chain evidence", () : any => {
    const supplyChain: any = PLATFORM_ACCEPTANCE_COMMANDS.find((command?: any) : any => command.id === "node-runtime-supply-chain");
    const portableAssembly: any = PLATFORM_ACCEPTANCE_COMMANDS.find((command?: any) : any => command.id === "mcp-release-portable-assembly");

    expect(supplyChain).toMatchObject({
      acceptanceLayer: "downstream-gateway",
      report: "build/reports/node-runtime-supply-chain.json"
    });
    expect(portableAssembly.dependsOn).toContain("node-runtime-supply-chain");
    expect(ACCEPTANCE_REQUIRED_REPORTS).toContain("build/reports/node-runtime-supply-chain.json");
    expect(requiredReportSpec("build/reports/node-runtime-supply-chain.json")).toMatchObject({
      schemaVersion: "v1:node-runtime-supply-chain-report",
      verifier: "tools/server-scripts/verify-node-runtime-supply-chain.ts"
    });
  });

  it("requires a clean-installable host-neutral npm release set", () : any => {
    const packageInstallability: any = PLATFORM_ACCEPTANCE_COMMANDS.find(
      (command?: any) : any => command.id === "npm-package-installability"
    );

    expect(packageInstallability).toMatchObject({
      acceptanceLayer: "foundation",
      report: "build/reports/npm-package-installability.json"
    });
    expect(ACCEPTANCE_REQUIRED_REPORTS).toContain(
      "build/reports/npm-package-installability.json"
    );
    expect(requiredReportSpec("build/reports/npm-package-installability.json")).toMatchObject({
      schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
      verifier: "tools/server-scripts/verify-npm-package-installability.ts",
      reducer: REQUIRED_REPORT_REDUCERS.NPM_PACKAGE_INSTALLABILITY
    });

    const packageReport: Record<string, any> = {
      schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
      verifier: "tools/server-scripts/verify-npm-package-installability.ts",
      generatedAt: GENERATED_AT,
      finishedAt: GENERATED_AT,
      tests: [
        { name: "root package declares the complete version-locked workspace release set", status: "passed", evidence: {} },
        { name: "release-set tarballs are source-portable and exclude host artifacts", status: "passed", evidence: {} },
        {
          name: "clean consumer install runs the packaged CLI",
          status: "passed",
          evidence: {
            lockBackedRegistryMirror: true,
            mirroredPackageCount: 1,
            mirroredArtifactCount: 1,
            publicServerCliHelp: true
          }
        },
        {
          name: "installed framework starts and serves its default health contracts",
          status: "passed",
          evidence: { publicServerBin: true }
        }
      ],
      summary: {
        testCount: 4,
        failedCount: 0,
        releaseReady: true,
        reportLeakScan: true,
        freshContainer: true,
        supplementaryHostProbe: false
      }
    };
    const options: Record<string, any> = { minimumTimestampMs: MINIMUM_TIMESTAMP_MS, nowMs: NOW_MS };
    expect(createReleaseEvidenceReadiness(
      "build/reports/npm-package-installability.json",
      packageReport,
      options
    ).releaseReady).toBe(true);
    expect(createReleaseEvidenceReadiness(
      "build/reports/npm-package-installability.json",
      {
        ...packageReport,
        summary: {
          ...packageReport.summary,
          freshContainer: false,
          supplementaryHostProbe: true
        }
      },
      options
    )).toMatchObject({
      releaseReady: false,
      reasons: expect.arrayContaining(["npm-package-fresh-container-authority-missing"])
    });
  });

  it("rejects npm installability summaries with invalid or inconsistent counters", () : any => {
    const packageReport: Record<string, any> = {
      schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
      verifier: "tools/server-scripts/verify-npm-package-installability.ts",
      generatedAt: GENERATED_AT,
      finishedAt: GENERATED_AT,
      tests: [
        { name: "root package declares the complete version-locked workspace release set", status: "passed" },
        { name: "release-set tarballs are source-portable and exclude host artifacts", status: "passed" },
        {
          name: "clean consumer install runs the packaged CLI",
          status: "passed",
          evidence: {
            lockBackedRegistryMirror: true,
            mirroredPackageCount: 1,
            mirroredArtifactCount: 1,
            publicServerCliHelp: true
          }
        },
        {
          name: "installed framework starts and serves its default health contracts",
          status: "passed",
          evidence: { publicServerBin: true }
        }
      ],
      summary: {
        testCount: 4,
        failedCount: 0,
        releaseReady: true,
        reportLeakScan: true,
        freshContainer: true,
        supplementaryHostProbe: false
      }
    };
    const options: Record<string, any> = { minimumTimestampMs: MINIMUM_TIMESTAMP_MS, nowMs: NOW_MS };
    const readiness: any = (report?: any) : any => createReleaseEvidenceReadiness(
      "build/reports/npm-package-installability.json",
      report,
      options
    );

    expect(readiness({
      ...packageReport,
      summary: { ...packageReport.summary, testCount: "4", failedCount: 0.5 }
    }).reasons).toEqual(expect.arrayContaining([
      "npm-package-test-count-invalid",
      "npm-package-failed-count-invalid"
    ]));
    expect(readiness({
      ...packageReport,
      summary: { ...packageReport.summary, testCount: 3 }
    }).reasons).toContain("npm-package-test-count-mismatch:3:4");
    expect(readiness({
      ...packageReport,
      tests: packageReport.tests.map((test?: any, index?: any) : any => index === 0
        ? { ...test, status: "failed" }
        : test)
    }).reasons).toEqual(expect.arrayContaining([
      "npm-package-failed-count-mismatch:0:1",
      "npm-package-test-status-not-passed:1"
    ]));
  });

  it("requires exactly the four unique npm installability tests", () : any => {
    const packageReport: Record<string, any> = {
      schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
      verifier: "tools/server-scripts/verify-npm-package-installability.ts",
      generatedAt: GENERATED_AT,
      finishedAt: GENERATED_AT,
      tests: [
        { name: "root package declares the complete version-locked workspace release set", status: "passed" },
        { name: "release-set tarballs are source-portable and exclude host artifacts", status: "passed" },
        {
          name: "clean consumer install runs the packaged CLI",
          status: "passed",
          evidence: {
            lockBackedRegistryMirror: true,
            mirroredPackageCount: 1,
            mirroredArtifactCount: 1,
            publicServerCliHelp: true
          }
        },
        {
          name: "installed framework starts and serves its default health contracts",
          status: "passed",
          evidence: { publicServerBin: true }
        }
      ],
      summary: {
        testCount: 4,
        failedCount: 0,
        releaseReady: true,
        reportLeakScan: true,
        freshContainer: true,
        supplementaryHostProbe: false
      }
    };
    const options: Record<string, any> = { minimumTimestampMs: MINIMUM_TIMESTAMP_MS, nowMs: NOW_MS };
    const readiness: any = (tests?: any) : any => createReleaseEvidenceReadiness(
      "build/reports/npm-package-installability.json",
      { ...packageReport, tests },
      options
    );
    const duplicateTests: any = packageReport.tests.map((test?: any, index?: any) : any => index === 3
      ? { ...packageReport.tests[2] }
      : test);
    const renamedTests: any = packageReport.tests.map((test?: any, index?: any) : any => index === 0
      ? { ...test, name: `${test.name} (supplemental)` }
      : test);

    expect(readiness(duplicateTests).reasons).toEqual(expect.arrayContaining([
      "npm-package-test-name-duplicate",
      "npm-package-test-name-set-mismatch"
    ]));
    expect(readiness(renamedTests).reasons).toContain("npm-package-test-name-set-mismatch");
  });

  it("requires npm installability evidence from the public server entrypoints", () : any => {
    const packageReport: Record<string, any> = {
      schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
      verifier: "tools/server-scripts/verify-npm-package-installability.ts",
      generatedAt: GENERATED_AT,
      finishedAt: GENERATED_AT,
      tests: [
        { name: "root package declares the complete version-locked workspace release set", status: "passed" },
        { name: "release-set tarballs are source-portable and exclude host artifacts", status: "passed" },
        {
          name: "clean consumer install runs the packaged CLI",
          status: "passed",
          evidence: {
            lockBackedRegistryMirror: true,
            mirroredPackageCount: 1,
            mirroredArtifactCount: 1,
            publicServerCliHelp: false
          }
        },
        {
          name: "installed framework starts and serves its default health contracts",
          status: "passed",
          evidence: { publicServerBin: false }
        }
      ],
      summary: {
        testCount: 4,
        failedCount: 0,
        releaseReady: true,
        reportLeakScan: true,
        freshContainer: true,
        supplementaryHostProbe: false
      }
    };

    expect(createReleaseEvidenceReadiness(
      "build/reports/npm-package-installability.json",
      packageReport,
      { minimumTimestampMs: MINIMUM_TIMESTAMP_MS, nowMs: NOW_MS }
    ).reasons).toContain("npm-package-public-server-entry-missing");
  });
});
