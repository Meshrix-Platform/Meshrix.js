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
} from "../../../tools/server-scripts/lib/required-report-validator.mjs";
import {
  createAggregateReleaseEvidenceReadiness,
  createReleaseEvidenceReadiness
} from "../../../tools/server-scripts/lib/release-evidence-readiness.mjs";
import {
  ACCEPTANCE_REQUIRED_REPORTS,
  PRIVATE_DEPLOYMENT_EVIDENCE_COMMANDS as PRIVATE_DEPLOYMENT_COMMANDS,
  PLATFORM_ACCEPTANCE_COMMANDS,
  aggregateChildReportLeakScan,
  createPlatformAcceptancePlan
} from "../../../tools/server-scripts/verify-platform-acceptance.mjs";
import {
  PRIVATE_DEPLOYMENT_OPEN_PLATFORM_E2E_REPORT_PATH
} from "../../../tools/server-scripts/lib/private-deployment-open-platform-e2e-catalog.mjs";
import { reportPayloadDigest } from "../../../tools/server-scripts/lib/sensitive-report-scan.mjs";
import {
  createReleaseEvidenceInventory,
  RELEASE_REPORT_PROVENANCE_SCHEMA,
  releaseEvidenceInventoryDigest,
  releaseEvidenceReportPayloadDigest,
  stampReleaseReportProvenance
} from "../../../tools/server-scripts/lib/release-report-provenance.mjs";

const REPORT_PATH = "build/reports/repo-organization.json";
const GENERATED_AT = "2026-07-10T04:00:01.000Z";
const MINIMUM_TIMESTAMP_MS = Date.parse("2026-07-10T04:00:00.000Z");
const NOW_MS = Date.parse("2026-07-10T04:01:00.000Z");
const SYNTHETIC_LINUX_HOME_PATH = ["", "home", "example", "private-runtime.log"].join("/");
const POSIX_HOME_PLACEHOLDER = ["", "home", "<user>", "private-runtime.log"].join("/");
const DOCUMENTATION_PATH_URL = [
  "https://docs.example.test",
  "home",
  "example",
  "private-runtime.log"
].join("/");
const DOCUMENTATION_QUERY_URL = `https://docs.example.test/guide?path=${SYNTHETIC_LINUX_HOME_PATH}`;

function validReport(overrides = {}) {
  const spec = requiredReportSpec(REPORT_PATH);
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

function validate(report = validReport()) {
  return validateRequiredReport(REPORT_PATH, JSON.stringify(report), {
    minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
    nowMs: NOW_MS
  });
}

describe("required report validator", () => {
  it("uses only the composition source-package capability acceptance field", () => {
    const reportPath = "build/reports/composition-source-package.json";
    const spec = requiredReportSpec(reportPath);
    expect(spec.readyFields).toEqual(["summary.compositionSourcePackageAcceptanceReady"]);
    const report = {
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

  it("registers every acceptance-required report and excludes the aggregate output", () => {
    const coverage = validateRequiredReportSpecCoverage(ACCEPTANCE_REQUIRED_REPORTS, {
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

  it("projects one complete release provenance owner for every required report", () => {
    const plan = createPlatformAcceptancePlan(undefined, { selectedProfile: "core" });
    expect(plan.releaseEvidenceInventory).toHaveLength(ACCEPTANCE_REQUIRED_REPORTS.length);
    expect(plan.releaseEvidenceInventory.every((entry) =>
      entry.provenanceSchemaVersion === RELEASE_REPORT_PROVENANCE_SCHEMA &&
      Boolean(entry.ownerCommandId) &&
      Boolean(entry.producer)
    )).toBe(true);
    expect(new Set(plan.releaseEvidenceInventory.map((entry) => entry.reportPath)).size)
      .toBe(ACCEPTANCE_REQUIRED_REPORTS.length);
    expect(plan.releaseEvidenceInventoryDigest).toBe(
      releaseEvidenceInventoryDigest(plan.releaseEvidenceInventory)
    );
    expect(createReleaseEvidenceInventory({
      commands: PLATFORM_ACCEPTANCE_COMMANDS,
      requiredReportPaths: ACCEPTANCE_REQUIRED_REPORTS
    })).toEqual(plan.releaseEvidenceInventory);
  });

  it("rejects missing or mismatched generation provenance when an owner is required", () => {
    const expected = {
      schemaVersion: RELEASE_REPORT_PROVENANCE_SCHEMA,
      producer: requiredReportSpec(REPORT_PATH).verifier,
      commandId: "repo-organization"
    };
    const report = validReport({
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

    const missing = structuredClone(report);
    delete missing.releaseEvidenceProvenance;
    expect(validateRequiredReport(REPORT_PATH, missing, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS,
      expectedReleaseEvidenceProvenance: expected
    }).reasons).toContain("required-report-release-provenance-mismatch:commandId");

    const mismatched = structuredClone(report);
    mismatched.releaseEvidenceProvenance.commandId = "wrong-owner";
    expect(validateRequiredReport(REPORT_PATH, mismatched, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS,
      expectedReleaseEvidenceProvenance: expected
    }).reasons).toContain("required-report-release-provenance-mismatch:commandId");

    const tampered = structuredClone(report);
    tampered.summary.releaseReady = false;
    expect(validateRequiredReport(REPORT_PATH, tampered, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS,
      expectedReleaseEvidenceProvenance: expected
    }).reasons).toContain("required-report-release-provenance-payload-digest-mismatch");

    const stale = structuredClone(report);
    stale.releaseEvidenceProvenance.recordedAt = "2026-07-10T03:59:59.000Z";
    expect(validateRequiredReport(REPORT_PATH, stale, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS,
      expectedReleaseEvidenceProvenance: expected
    }).reasons).toContain("required-report-release-provenance-timestamp-stale");
  });

  it("stamps command-owned generation provenance and preserves payload integrity", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "licomesh-release-provenance-"));
    const reportPath = "build/reports/observability-runtime-acceptance.json";
    const spec = requiredReportSpec(reportPath);
    const report = {
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
        finalizer: "licomesh-core-observability",
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
    const filePath = path.join(repoRoot, reportPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(report)}\n`, "utf8");
    try {
      const expectedByPath = await stampReleaseReportProvenance({
        repoRoot,
        commands: [{ id: "observability-runtime", report: reportPath }],
        results: [{ id: "observability-runtime", status: "passed" }],
        requiredReportPaths: [reportPath],
        recordedAt: GENERATED_AT
      });
      const stamped = JSON.parse(await fs.readFile(filePath, "utf8"));
      expect(validateRequiredReport(reportPath, stamped, {
        minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
        nowMs: NOW_MS,
        expectedReleaseEvidenceProvenance: expectedByPath.get(reportPath)
      })).toMatchObject({ accepted: true, reasons: [] });
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects observability reports that bypass the canonical finalization contract", () => {
    const reportPath = "build/reports/observability-runtime-acceptance.json";
    const spec = requiredReportSpec(reportPath);
    const report = {
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

  it("rejects missing provenance and payload tampering for observability reports", () => {
    const observabilityReportPaths = [
      "build/reports/enterprise-audit-retention-redaction.json",
      "build/reports/enterprise-observability-coverage.json",
      "build/reports/observability-runtime-acceptance.json",
      "build/reports/observability-semantics.json",
      "build/reports/security-alert-lifecycle.json"
    ];
    for (const path of observabilityReportPaths) {
      expect(requiredReportSpec(path)?.readyFields).toEqual(["summary.readyForReleaseReduction"]);
    }
    const reportPath = "build/reports/observability-runtime-acceptance.json";
    const spec = requiredReportSpec(reportPath);
    const report = {
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
        finalizer: "licomesh-core-observability",
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

    const tampered = structuredClone(report);
    tampered.summary.readyForReleaseReduction = false;
    expect(validateRequiredReport(reportPath, tampered, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS
    }).reasons).toContain("required-report-payload-digest-mismatch");

    const missingCommand = structuredClone(report);
    delete missingCommand.commandId;
    delete missingCommand.payloadDigest;
    missingCommand.payloadDigest = reportPayloadDigest(missingCommand);
    expect(validateRequiredReport(reportPath, missingCommand, {
      minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
      nowMs: NOW_MS
    }).reasons).toContain("required-report-provenance-mismatch");
  });

  it("rejects destructive provenance changes for upload workspace materialization evidence", () => {
    const reportPath = "build/reports/upload-workspace-materialization.json";
    const spec = requiredReportSpec(reportPath);
    const report = {
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
      const tampered = structuredClone(report);
      tampered[field] = `wrong-${field}`;
      delete tampered.payloadDigest;
      tampered.payloadDigest = reportPayloadDigest(tampered);
      expect(validateRequiredReport(reportPath, tampered, {
        minimumTimestampMs: MINIMUM_TIMESTAMP_MS,
        nowMs: NOW_MS
      }).reasons).toContain("required-report-provenance-mismatch");
    }
  });

  it("assigns nested producers for reports absent during plan-only execution", () => {
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
        report: PRIVATE_DEPLOYMENT_OPEN_PLATFORM_E2E_REPORT_PATH
      })
    ]));
  });

  it("accepts raw JSON only when its exact schema, verifier, timestamp and leak flag match", () => {
    const validation = validate();

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

  it("fails closed for an unregistered report path", () => {
    const validation = validateRequiredReport(
      "build/reports/not-registered.json",
      JSON.stringify(validReport()),
      { minimumTimestampMs: MINIMUM_TIMESTAMP_MS, nowMs: NOW_MS }
    );
    const readiness = createReleaseEvidenceReadiness(
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
  ])("rejects %s", (_label, overrides, reason) => {
    const validation = validate(validReport(overrides));

    expect(validation.accepted).toBe(false);
    expect(validation.report).toBeNull();
    expect(validation.reasons).toContain(reason);
  });

  it.each([
    ["missing", {}],
    ["false", { reportLeakScan: false }]
  ])("rejects a %s embedded report leak scan", (_label, summaryOverride) => {
    const report = validReport({
      summary: {
        releaseReady: true,
        ...summaryOverride
      }
    });
    const validation = validate(report);

    expect(validation.accepted).toBe(false);
    expect(validation.reportLeakScan).toBe(false);
    expect(validation.reasons).toContain("required-report-leak-scan-not-passed");
  });

  it("scans the full child report before reduction without returning sensitive content", () => {
    const bearerMaterial = ["Bearer", "fixture-auth-material"].join(" ");
    const validation = validate(validReport({ nestedEvidence: { detail: bearerMaterial } }));

    expect(validation.accepted).toBe(false);
    expect(validation.reportLeakScan).toBe(false);
    expect(validation.report).toBeNull();
    expect(validation.reasons).toContain("required-report-sensitive-data-detected");
    expect(JSON.stringify(validation)).not.toContain(bearerMaterial);
  });

  it("rejects a synthetic Linux home path before required-report reduction", () => {
    const report = validReport({ diagnostic: SYNTHETIC_LINUX_HOME_PATH });
    const validation = validate(report);
    const readiness = createReleaseEvidenceReadiness(
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
  ])("does not treat a %s as a local-path leak", (_label, diagnostic) => {
    const validation = validate(validReport({ diagnostic }));

    expect(validation.accepted).toBe(true);
    expect(validation.sensitiveLeakScanPassed).toBe(true);
  });

  it("does not confuse escaped assertion newlines with Windows drive paths", () => {
    const ordinaryAssertion = "Expected values to be strictly equal:\n\nfalse !== true\n";
    const validation = validate(validReport({ failure: { message: ordinaryAssertion } }));

    expect(validation.accepted).toBe(true);
    expect(validation.sensitiveLeakScanPassed).toBe(true);

    const windowsPath = ["C:", "Users", "example", "secret.json"].join("\\");
    const rejected = validate(validReport({ failure: { message: windowsPath } }));
    expect(rejected.accepted).toBe(false);
    expect(rejected.reasons).toContain("required-report-sensitive-data-detected");
  });

  it("rejects conflicting ready aliases before reducer selection", () => {
    const validation = validate(validReport({ releaseReady: false }));

    expect(validation.accepted).toBe(false);
    expect(validation.reasons).toContain("required-report-ready-field-conflict");
  });

  it("passes validated evidence to the exact registered reducer", () => {
    const readiness = createReleaseEvidenceReadiness(
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

  it("enforces the organization policy while keeping AST candidates non-blocking", () => {
    const options = { minimumTimestampMs: MINIMUM_TIMESTAMP_MS, nowMs: NOW_MS };
    const ready = createReleaseEvidenceReadiness(REPORT_PATH, validReport(), options);
    expect(ready).toMatchObject({ releaseReady: true, reasons: [] });

    const lineGateEnabled = structuredClone(validReport());
    lineGateEnabled.policy.lineCountGate.status = "enabled";
    expect(createReleaseEvidenceReadiness(REPORT_PATH, lineGateEnabled, options).reasons)
      .toContain("repo-organization-line-count-gate-not-disabled");

    const wrongCanonical = structuredClone(validReport());
    wrongCanonical.policy.canonicalDocument = "docs/architecture/OTHER.md#source-file-organization";
    expect(createReleaseEvidenceReadiness(REPORT_PATH, wrongCanonical, options).reasons)
      .toContain("repo-organization-canonical-document-mismatch");

    const blockingAst = structuredClone(validReport());
    blockingAst.sourceOrganizationAnalysis.releaseBlocking = true;
    expect(createReleaseEvidenceReadiness(REPORT_PATH, blockingAst, options).reasons)
      .toContain("repo-organization-ast-analysis-not-advisory");

    const mismatchedCount = structuredClone(validReport());
    mismatchedCount.sourceOrganizationAnalysis.summary.splitCandidateCount = 2;
    expect(createReleaseEvidenceReadiness(REPORT_PATH, mismatchedCount, options).reasons)
      .toContain("repo-organization-ast-candidate-count-mismatch");
  });
});

describe("aggregate report leak reduction", () => {
  it("requires explicit execution and exact non-negative integer counters", () => {
    const base = {
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

  it("requires counters to match their evidence arrays", () => {
    const result = createAggregateReleaseEvidenceReadiness({
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

  it("fails closed when reportLeakScan is false or missing", () => {
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

  it("derives aggregate leak safety from every required child result", () => {
    const requiredReports = ["one.json", "two.json"];
    const safeEvidence = {
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

  it("keeps the production leak-scan call bound to missingReports, not evidence-state reduction", async () => {
    const source = await fs.readFile(
      path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "../../../tools/server-scripts/verify-platform-acceptance.mjs"
      ),
      "utf8"
    );
    const callMatch = source.match(
      /aggregateChildReportLeakScan\(\{\s*requiredReports:\s*ACCEPTANCE_REQUIRED_REPORTS,\s*reportEvidence,\s*missingReports\s*\}\)/u
    );
    expect(callMatch).not.toBeNull();
    expect(source).not.toMatch(/aggregateChildReportLeakScan\(\s*evidenceStateReduction/u);
    expect(source).not.toMatch(/aggregateChildReportLeakScan\(\s*ACCEPTANCE_REQUIRED_REPORTS\s*,\s*reportEvidence\s*,\s*evidenceStateReduction/u);
  });
});

describe("platform acceptance foundation ownership", () => {
  it("runs the public foundation gate once and declares its child report locks", () => {
    const commandIds = PLATFORM_ACCEPTANCE_COMMANDS.map((command) => command.id);
    const foundation = PLATFORM_ACCEPTANCE_COMMANDS.find((command) => command.id === "foundation-tests");

    expect(commandIds).not.toContain("hygiene");
    expect(commandIds).not.toContain("script-registry");
    expect(foundation).toMatchObject({ command: "npm", args: ["test"] });
    expect(foundation.resourceLocks).toEqual(expect.arrayContaining([
      "report:build/test-reports/latest.json",
      "report:build/reports/local-info-hygiene.json",
      "report:build/reports/script-registry.json"
    ]));
  });

  it("creates a sanitized plan with canonical rather than host-derived parallelism", () => {
    const plan = createPlatformAcceptancePlan(undefined, { selectedProfile: "core" });
    const serialized = JSON.stringify(plan);

    expect(plan.status).toBe("planned");
    expect(plan.summary.reportLeakScan).toBe(true);
    expect(serialized).not.toContain("hostParallelism");
    expect(plan.declaredWorstCaseEstimate).toMatchObject({ maxParallel: 4 });
    expect(plan.declaredJobBudgetMs).toBeGreaterThan(
      plan.declaredWorstCaseEstimate.timeoutMs
    );
  });

  it("gates portable MCP assembly on pinned Node runtime supply-chain evidence", () => {
    const supplyChain = PLATFORM_ACCEPTANCE_COMMANDS.find((command) => command.id === "node-runtime-supply-chain");
    const portableAssembly = PLATFORM_ACCEPTANCE_COMMANDS.find((command) => command.id === "mcp-release-portable-assembly");

    expect(supplyChain).toMatchObject({
      acceptanceLayer: "downstream-gateway",
      report: "build/reports/node-runtime-supply-chain.json"
    });
    expect(portableAssembly.dependsOn).toContain("node-runtime-supply-chain");
    expect(ACCEPTANCE_REQUIRED_REPORTS).toContain("build/reports/node-runtime-supply-chain.json");
    expect(requiredReportSpec("build/reports/node-runtime-supply-chain.json")).toMatchObject({
      schemaVersion: "v1:node-runtime-supply-chain-report",
      verifier: "tools/server-scripts/verify-node-runtime-supply-chain.mjs"
    });
  });

  it("requires a clean-installable host-neutral npm release set", () => {
    const packageInstallability = PLATFORM_ACCEPTANCE_COMMANDS.find(
      (command) => command.id === "npm-package-installability"
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
      verifier: "tools/server-scripts/verify-npm-package-installability.mjs",
      reducer: REQUIRED_REPORT_REDUCERS.NPM_PACKAGE_INSTALLABILITY
    });

    const packageReport = {
      schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
      verifier: "tools/server-scripts/verify-npm-package-installability.mjs",
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
    const options = { minimumTimestampMs: MINIMUM_TIMESTAMP_MS, nowMs: NOW_MS };
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

  it("rejects npm installability summaries with invalid or inconsistent counters", () => {
    const packageReport = {
      schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
      verifier: "tools/server-scripts/verify-npm-package-installability.mjs",
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
    const options = { minimumTimestampMs: MINIMUM_TIMESTAMP_MS, nowMs: NOW_MS };
    const readiness = (report) => createReleaseEvidenceReadiness(
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
      tests: packageReport.tests.map((test, index) => index === 0
        ? { ...test, status: "failed" }
        : test)
    }).reasons).toEqual(expect.arrayContaining([
      "npm-package-failed-count-mismatch:0:1",
      "npm-package-test-status-not-passed:1"
    ]));
  });

  it("requires exactly the four unique npm installability tests", () => {
    const packageReport = {
      schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
      verifier: "tools/server-scripts/verify-npm-package-installability.mjs",
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
    const options = { minimumTimestampMs: MINIMUM_TIMESTAMP_MS, nowMs: NOW_MS };
    const readiness = (tests) => createReleaseEvidenceReadiness(
      "build/reports/npm-package-installability.json",
      { ...packageReport, tests },
      options
    );
    const duplicateTests = packageReport.tests.map((test, index) => index === 3
      ? { ...packageReport.tests[2] }
      : test);
    const renamedTests = packageReport.tests.map((test, index) => index === 0
      ? { ...test, name: `${test.name} (supplemental)` }
      : test);

    expect(readiness(duplicateTests).reasons).toEqual(expect.arrayContaining([
      "npm-package-test-name-duplicate",
      "npm-package-test-name-set-mismatch"
    ]));
    expect(readiness(renamedTests).reasons).toContain("npm-package-test-name-set-mismatch");
  });

  it("requires npm installability evidence from the public server entrypoints", () => {
    const packageReport = {
      schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
      verifier: "tools/server-scripts/verify-npm-package-installability.mjs",
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
