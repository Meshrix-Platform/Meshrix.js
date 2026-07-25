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
} from "./sensitive-report-scan.mjs";

export const RELEASE_JOURNEY_REPORT_PATH = "build/reports/release-journey.json";
export const RELEASE_JOURNEY_SCHEMA_VERSION = "v0.0.1:report:release-journey-1";

export const RELEASE_JOURNEY_STEPS = Object.freeze([
  "preflight",
  "stack-build-up",
  "admin-bootstrap",
  "upstream-publish",
  "adapter-seed",
  "connector-install",
  "mcp-journey",
  "artifact-fetch",
  "pdf-verify",
  "cleanup"
]);

export function createRedaction({ repoRoot = "", extraNeedles = [] } = {}) {
  const staticNeedles = [repoRoot, os.homedir(), process.cwd()].filter(Boolean);
  const secretNeedles = new Set(extraNeedles.filter((value) => String(value || "").length >= 4));
  function addNeedle(value) {
    const text = String(value || "").trim();
    if (text.length >= 4) secretNeedles.add(text);
  }
  function redact(value = "") {
    let text = String(value || "");
    for (const needle of secretNeedles) {
      text = text.split(needle).join("[redacted-secret]");
    }
    return redactReportText(text, { dynamicNeedles: staticNeedles });
  }
  function assertNoLeak(serialized = "") {
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

export function stepReceipt(id, { status = "passed", durationMs = 0, receipt = {}, error = null } = {}) {
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

export function createReleaseJourneyReport({ verifier = "verify:release-journey", startedAt = new Date().toISOString() } = {}) {
  return {
    schemaVersion: RELEASE_JOURNEY_SCHEMA_VERSION,
    verifier,
    startedAt,
    generatedAt: "",
    finishedAt: "",
    releaseReady: false,
    environment: {},
    steps: [],
    cleanup: { performed: false, details: [] },
    failure: null
  };
}

export function finalizeReleaseJourneyReport(report, { assertNoLeak = () => {} } = {}) {
  const finishedAt = new Date().toISOString();
  report.generatedAt = report.generatedAt || finishedAt;
  report.finishedAt = report.finishedAt || finishedAt;
  const failed = report.steps.some((step) => step.status === "failed");
  const cleanupFailed = (report.cleanup?.details || []).some((detail) => detail.status === "failed");
  report.releaseReady = !failed && !cleanupFailed && report.failure === null;
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  assertNoLeak(serialized);
  return { report, serialized };
}
