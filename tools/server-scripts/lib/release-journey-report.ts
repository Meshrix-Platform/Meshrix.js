// Release journey report shaping and privacy hygiene.
//
// The gate report (build/reports/release-journey.json) carries only
// server-generated opaque ids, digests, byte counts, statuses, and durations.
// Local paths, account names, tokens, cookies, CSRF values, and any runtime
// secret are redaction needles; the report fails closed before writing if a
// needle survives. Mirrors the discipline of verify-upstream-fixture-transit.
import os from "node:os";

import {
  WINDOWS_LOCAL_PATH_PATTERN,
  redactReportText
} from "./sensitive-report-scan.ts";

export const RELEASE_JOURNEY_REPORT_PATH: any = "build/reports/release-journey.json";
export const RELEASE_JOURNEY_SCHEMA_VERSION: any = "v0.0.1:report:release-journey-1";

export const RELEASE_JOURNEY_STEPS: readonly any[] = Object.freeze([
  "preflight",
  "stack-build-up",
  "admin-bootstrap",
  "upstream-publish",
  "adapter-seed",
  "client-discovery",
  "connector-install-matrix",
  "binary-upload-matrix",
  "mcp-acceptance-matrix",
  "approval-branch",
  "artifact-fetch",
  "pdf-verify",
  "cleanup"
]);

export function createRedaction({ repoRoot = "", extraNeedles = [] }: Record<string, any> = {}) : any {
  const staticNeedles: any = [repoRoot, os.homedir(), process.cwd()].filter(Boolean);
  const secretNeedles: any = new Set<any>(extraNeedles.filter((value?: any) : any => String(value || "").length >= 4));
  function addNeedle(value?: any) : any {
    const text: any = String(value || "").trim();
    if (text.length >= 4) secretNeedles.add(text);
  }
  function redact(value: any = "") : any {
    let text: any = String(value || "");
    for (const needle of secretNeedles) {
      text = text.split(needle).join("[redacted-secret]");
    }
    return redactReportText(text, { dynamicNeedles: staticNeedles });
  }
  function assertNoLeak(serialized: any = "") : any {
    for (const needle of secretNeedles) {
      if (needle && serialized.includes(needle)) {
        throw new Error("Release journey verifier attempted to write a secret into its report.");
      }
    }
    if (
      (repoRoot && serialized.includes(repoRoot)) ||
      serialized.includes(os.homedir()) ||
      /(?:\/Users\/|\/private\/|\/var\/folders\/)[^\s"'`]+/u.test(serialized) ||
      WINDOWS_LOCAL_PATH_PATTERN.test(serialized)
    ) {
      throw new Error("Release journey verifier attempted to write a local path into its report.");
    }
  }
  return { addNeedle, redact, assertNoLeak };
}

export function stepReceipt(id?: any, { status = "passed", durationMs = 0, receipt = {}, error = null }: Record<string, any> = {}) : any {
  return {
    id,
    status,
    durationMs: Math.max(0, Math.round(durationMs)),
    receipt,
    ...(error
      ? {
          error: {
            code: String(error?.code || "release_journey_step_failed"),
            message: String(error?.message || error).slice(-800)
          }
        }
      : {})
  };
}

export function createReleaseJourneyReport({ verifier = "verify:release-journey", startedAt = new Date().toISOString() }: Record<string, any> = {}) : any {
  return {
    schemaVersion: RELEASE_JOURNEY_SCHEMA_VERSION,
    verifier,
    startedAt,
    generatedAt: "",
    finishedAt: "",
    releaseReady: false,
    environment: {},
    configuration: {},
    artifactPolicy: {},
    steps: [],
    visualEvidence: [],
    cleanup: { performed: false, details: [] },
    failure: null
  };
}

export function finalizeReleaseJourneyReport(report?: any, { assertNoLeak = () : any => {} }: Record<string, any> = {}) : any {
  const finishedAt: any = new Date().toISOString();
  report.generatedAt = report.generatedAt || finishedAt;
  report.finishedAt = report.finishedAt || finishedAt;
  const expectedStepIds: any = RELEASE_JOURNEY_STEPS.filter((id?: any) : any => id !== "cleanup");
  const actualStepIds: any = Array.isArray(report.steps)
    ? report.steps.map((step?: any) : any => step?.id)
    : [];
  const stepSet: any = new Set<any>(actualStepIds);
  const stepsComplete: any = (
    actualStepIds.length === expectedStepIds.length
    && stepSet.size === expectedStepIds.length
    && actualStepIds.every((id?: any, index?: any) : any => id === expectedStepIds[index])
    && report.steps.every(
      (step?: any) : any => (
        step?.status === "passed"
        && Number.isSafeInteger(step?.durationMs)
        && step.durationMs >= 0
      )
    )
  );
  const cleanupDetails: any = Array.isArray(report.cleanup?.details)
    ? report.cleanup.details
    : [];
  const cleanupDurationMs: any = Number.isSafeInteger(report.cleanup?.durationMs)
    ? report.cleanup.durationMs
    : 0;
  const cleanupComplete: any = (
    report.cleanup?.performed === true
    && cleanupDetails.length > 0
    && cleanupDurationMs >= 0
    && cleanupDetails.every(
      (detail?: any) : any => (
        detail?.status === "passed"
        && Number.isSafeInteger(detail?.durationMs)
        && detail.durationMs >= 0
      )
    )
    && cleanupDetails.some(
      (detail?: any) : any => String(detail?.id || "").startsWith("connector-uninstall")
    )
    && cleanupDetails.some((detail?: any) : any => detail?.id === "compose-down")
    && cleanupDetails.some((detail?: any) : any => detail?.id === "temp-workdir")
    && cleanupDetails.reduce((total?: any, detail?: any) : any => total + detail.durationMs, 0)
      === cleanupDurationMs
  );
  const startedAtMs: any = Date.parse(report.startedAt);
  const finishedAtMs: any = Date.parse(report.finishedAt);
  const totalDurationMs: any = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
    ? Math.max(0, finishedAtMs - startedAtMs)
    : 0;
  report.timing = {
    totalDurationMs,
    stepDurationMs: Array.isArray(report.steps)
      ? report.steps.reduce(
          (total?: any, step?: any) : any => total + (Number.isSafeInteger(step?.durationMs) ? step.durationMs : 0),
          0
        )
      : 0,
    cleanupDurationMs
  };
  report.releaseReady = (
    stepsComplete
    && cleanupComplete
    && Number.isFinite(startedAtMs)
    && Number.isFinite(finishedAtMs)
    && finishedAtMs >= startedAtMs
    && report.failure === null
  );
  const serialized: any = `${JSON.stringify(report, null, 2)}\n`;
  assertNoLeak(serialized);
  return { report, serialized };
}
