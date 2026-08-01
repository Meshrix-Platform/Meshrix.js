import fs from "node:fs/promises";
import path from "node:path";

import { reportPayloadDigest } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import { writePrivateFileAtomic } from "../../../packages/foundation/src/storage/private-file-atomic.ts";
import { assertNoSensitiveReportLeak } from "./sensitive-report-scan.ts";
import { requiredReportSpec } from "./required-report-validator.ts";

export const RELEASE_REPORT_PROVENANCE_SCHEMA: any =
  "v0.0.1:meshrix:release-evidence-report-provenance-1";

function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

export function buildReleaseReportOwnership(commands: any = []) : any {
  const owners: any = new Map<any, any>();
  for (const command of commands) {
    const commandId: any = String(command?.id || "").trim();
    if (!commandId) throw new Error("Release report owner command id is required.");
    for (const reportPath of uniqueStrings([
      command.report,
      ...(command.ownedReports || [])
    ])) {
      const previousOwner: any = owners.get(reportPath);
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
}: Record<string, any> = {}) : any {
  const owners: any = buildReleaseReportOwnership(commands);
  const required: any = uniqueStrings(requiredReportPaths).sort();
  const requiredSet: any = new Set<any>(required);
  const reasons: any[] = [];
  for (const reportPath of required) {
    if (!owners.has(reportPath)) reasons.push(`release-report-owner-missing:${reportPath}`);
    if (!requiredReportSpec(reportPath)) reasons.push(`release-report-spec-missing:${reportPath}`);
  }
  for (const reportPath of [...owners.keys()].sort()) {
    if (!requiredSet.has(reportPath)) reasons.push(`release-report-owner-extra:${reportPath}`);
  }
  if (reasons.length > 0) {
    const error: Error & Record<string, any> = new Error("Release report catalog closure is invalid.");
    error.code = "release_report_catalog_closure_invalid";
    error.reasons = reasons;
    throw error;
  }
  return Object.freeze({ owners, requiredReportPaths: Object.freeze(required) });
}

export function createReleaseEvidenceInventory({
  commands = [],
  requiredReportPaths = []
}: Record<string, any> = {}) : any {
  const closure: any = validateReleaseReportCatalogClosure({ commands, requiredReportPaths });
  return Object.freeze(closure.requiredReportPaths.map((reportPath?: any) : any => {
    const spec: any = requiredReportSpec(reportPath);
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

export function releaseEvidenceInventoryDigest(inventory: any = []) : any {
  return reportPayloadDigest({ inventory });
}

function reportWithoutReleaseProvenance(report?: any) : any {
  return Object.fromEntries(
    (Object.entries(report) as [string, any][]).filter(([key]: any[]) : any => key !== "releaseEvidenceProvenance")
  );
}

export function releaseEvidenceReportPayloadDigest(report: Record<string, any> = {}) : any {
  return reportPayloadDigest(reportWithoutReleaseProvenance(report));
}

export function expectedReleaseReportProvenance({ commandId, producer }: Record<string, any> = {}) : any {
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
}: Record<string, any> = {}) : Promise<any> {
  const { owners } = validateReleaseReportCatalogClosure({ commands, requiredReportPaths });
  const resultById: any = new Map<any, any>(results.map((result?: any) : any => [String(result?.id || ""), result]));
  const expectedByPath: any = new Map<any, any>();

  for (const reportPath of uniqueStrings(requiredReportPaths)) {
    const commandId: any = owners.get(reportPath) || "";
    const spec: any = requiredReportSpec(reportPath);
    if (!commandId) throw new Error(`Release report has no command owner: ${reportPath}`);
    if (!spec) throw new Error(`Release report has no registered specification: ${reportPath}`);
    const expected: any = expectedReleaseReportProvenance({
      commandId,
      producer: spec.verifier
    });
    expectedByPath.set(reportPath, expected);
    const result: any = resultById.get(commandId);
    if (!result || !["passed", "blocked"].includes(result.status)) continue;

    const filePath: any = path.join(repoRoot, ...reportPath.split("/"));
    let report: any;
    try {
      report = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error: any) {
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
      let priorSize: any = -1;
      for (let attempt: any = 0; attempt < 4; attempt += 1) {
        const size: any = Buffer.byteLength(JSON.stringify(report), "utf8");
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
