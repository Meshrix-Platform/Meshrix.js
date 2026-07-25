import fs from "node:fs/promises";
import path from "node:path";

import { reportPayloadDigest } from "../../../packages/foundation/src/observability/sensitive-report-scan.mjs";
import { writePrivateFileAtomic } from "../../../packages/foundation/src/storage/private-file-atomic.mjs";
import { assertNoSensitiveReportLeak } from "./sensitive-report-scan.mjs";
import { requiredReportSpec } from "./required-report-validator.mjs";

export const RELEASE_REPORT_PROVENANCE_SCHEMA =
  "v0.0.1:meshrix:release-evidence-report-provenance-1";

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function buildReleaseReportOwnership(commands = []) {
  const owners = new Map();
  for (const command of commands) {
    const commandId = String(command?.id || "").trim();
    if (!commandId) throw new Error("Release report owner command id is required.");
    for (const reportPath of uniqueStrings([
      command.report,
      ...(command.ownedReports || [])
    ])) {
      const previousOwner = owners.get(reportPath);
      if (previousOwner && previousOwner !== commandId) {
        throw new Error(`Release report has multiple command owners: ${reportPath}`);
      }
      owners.set(reportPath, commandId);
    }
  }
  return owners;
}

export function validateReleaseReportCatalogClosure({
  commands = [],
  requiredReportPaths = []
} = {}) {
  const owners = buildReleaseReportOwnership(commands);
  const required = uniqueStrings(requiredReportPaths).sort();
  const requiredSet = new Set(required);
  const reasons = [];
  for (const reportPath of required) {
    if (!owners.has(reportPath)) reasons.push(`release-report-owner-missing:${reportPath}`);
    if (!requiredReportSpec(reportPath)) reasons.push(`release-report-spec-missing:${reportPath}`);
  }
  for (const reportPath of [...owners.keys()].sort()) {
    if (!requiredSet.has(reportPath)) reasons.push(`release-report-owner-extra:${reportPath}`);
  }
  if (reasons.length > 0) {
    const error = new Error("Release report catalog closure is invalid.");
    error.code = "release_report_catalog_closure_invalid";
    error.reasons = reasons;
    throw error;
  }
  return Object.freeze({ owners, requiredReportPaths: Object.freeze(required) });
}

export function createReleaseEvidenceInventory({
  commands = [],
  requiredReportPaths = []
} = {}) {
  const closure = validateReleaseReportCatalogClosure({ commands, requiredReportPaths });
  return Object.freeze(closure.requiredReportPaths.map((reportPath) => {
    const spec = requiredReportSpec(reportPath);
    return Object.freeze({
      reportPath,
      ownerCommandId: closure.owners.get(reportPath),
      producer: spec.verifier,
      reportSchemaVersion: spec.schemaVersion,
      timestampField: spec.timestampField,
      reportLeakScanField: spec.reportLeakScanField,
      reducer: spec.reducer,
      provenanceSchemaVersion: RELEASE_REPORT_PROVENANCE_SCHEMA
    });
  }));
}

export function releaseEvidenceInventoryDigest(inventory = []) {
  return reportPayloadDigest({ inventory });
}

function reportWithoutReleaseProvenance(report) {
  return Object.fromEntries(
    Object.entries(report).filter(([key]) => key !== "releaseEvidenceProvenance")
  );
}

export function releaseEvidenceReportPayloadDigest(report = {}) {
  return reportPayloadDigest(reportWithoutReleaseProvenance(report));
}

export function expectedReleaseReportProvenance({ commandId, producer } = {}) {
  return Object.freeze({
    schemaVersion: RELEASE_REPORT_PROVENANCE_SCHEMA,
    commandId: String(commandId || "").trim(),
    producer: String(producer || "").trim()
  });
}

export async function stampReleaseReportProvenance({
  repoRoot,
  commands = [],
  results = [],
  requiredReportPaths = [],
  recordedAt = new Date().toISOString()
} = {}) {
  const { owners } = validateReleaseReportCatalogClosure({ commands, requiredReportPaths });
  const resultById = new Map(results.map((result) => [String(result?.id || ""), result]));
  const expectedByPath = new Map();

  for (const reportPath of uniqueStrings(requiredReportPaths)) {
    const commandId = owners.get(reportPath) || "";
    const spec = requiredReportSpec(reportPath);
    if (!commandId) throw new Error(`Release report has no command owner: ${reportPath}`);
    if (!spec) throw new Error(`Release report has no registered specification: ${reportPath}`);
    const expected = expectedReleaseReportProvenance({
      commandId,
      producer: spec.verifier
    });
    expectedByPath.set(reportPath, expected);
    const result = resultById.get(commandId);
    if (!result || !["passed", "blocked"].includes(result.status)) continue;

    const filePath = path.join(repoRoot, ...reportPath.split("/"));
    let report;
    try {
      report = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      throw new Error(`Release report must be a JSON object: ${reportPath}`);
    }

    report.releaseEvidenceProvenance = {
      ...expected,
      recordedAt,
      reportPayloadDigest: releaseEvidenceReportPayloadDigest(report)
    };
    if (report.resourceBudgets && Number.isFinite(Number(report.resourceBudgets.reportBytes))) {
      let priorSize = -1;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const size = Buffer.byteLength(JSON.stringify(report), "utf8");
        report.resourceBudgets.reportBytes = size;
        if (typeof report.payloadDigest === "string" && report.payloadDigest) {
          report.payloadDigest = reportPayloadDigest(report);
        }
        report.releaseEvidenceProvenance.reportPayloadDigest = releaseEvidenceReportPayloadDigest(report);
        if (size === priorSize) break;
        priorSize = size;
      }
    } else if (typeof report.payloadDigest === "string" && report.payloadDigest) {
      report.payloadDigest = reportPayloadDigest(report);
    }
    assertNoSensitiveReportLeak(report, `release report ${reportPath}`);
    await writePrivateFileAtomic(filePath, `${JSON.stringify(report, null, 2)}\n`);
  }

  return expectedByPath;
}
