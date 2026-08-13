import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildProductionHealthReport } from "./report-reader.ts";
import {
  OBSERVABILITY_BUDGETS,
  createBoundedSnapshotCache,
  createBoundedWorkQueue,
  throwIfObservabilityAborted
} from "./observability-budgets.ts";
import { finalizeSensitiveReport } from "./sensitive-report-scan.ts";
import { ServerConfig } from "#meshrix/server-config";
import {
  atomicWriteFile,
  queueStateMutation,
  stateFileKey,
  waitForStateIdle
} from "../storage/state-coordinator.ts";

export const EXECUTIVE_REPORT_PROTOCOL_VERSION: any = "v0.0.1:platform:executive-report-1";

const STORE_FILE: any = path.join("executive-reports", "reports.json");

function nowIso() : any {
  return new Date().toISOString();
}

function asObject(value?: any, fallback: Record<string, any> | null = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function asArray(value?: any) : any {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function text(value?: any) : any {
  return String(value ?? "").trim();
}

function number(value?: any, fallback: any = 0) : any {
  const parsed: any = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}


function stableId(prefix?: any, value?: any) : any {
  return `${prefix}_${crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 18)}`;
}

async function readJson(filePath?: any, fallback?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath?: any, value?: any) : Promise<any> {
  const directory: any = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function storePath(userDataPath: any = "") : any {
  return path.join(userDataPath || ServerConfig.getDataDir(), STORE_FILE);
}

function normalizeContributionReport(report: Record<string, any> = {}) : any {
  const source: any = asObject(report);
  const topReusableAssets: any = asArray(source.topReusableAssets);
  const highDemandRestrictedAssets: any = asArray(source.highDemandRestrictedAssets);
  const rollbackHotspots: any = asArray(source.rollbackHotspots);
  const underMaintainedAssets: any = asArray(source.underMaintainedAssets);
  return {
    reportId: text(source.reportId || ""),
    workspaceId: text(source.workspaceId || ""),
    timeRange: text(source.timeRange || "all"),
    acceptedCount: number(source.acceptedCount, 0),
    usageCount: number(source.usageCount, 0),
    uniqueWorkspaceAdoptions: number(source.uniqueWorkspaceAdoptions, 0),
    permissionRequestCount: number(source.permissionFlowBreakdown?.requested ?? source.permissionRequestCount, 0),
    permissionGrantCount: number(source.permissionFlowBreakdown?.granted ?? source.permissionGrantCount, 0),
    rollbackCount: number(source.rollbackCount, 0),
    assetContributionScore: number(source.assetContributionScore, 0),
    assetTypeBreakdown: asObject(source.assetTypeBreakdown),
    contributorBreakdown: asObject(source.contributorBreakdown),
    permissionFlowBreakdown: asObject(source.permissionFlowBreakdown),
    topReusableAssets,
    highDemandRestrictedAssets,
    rollbackHotspots,
    underMaintainedAssets
  };
}

function aggregateContributionReports(reports: any = []) : any {
  const normalized: any = asArray(reports).map(normalizeContributionReport);
  const mergedTypeBreakdown: Record<string, any> = {};
  const mergedContributorBreakdown: Record<string, any> = {};
  for (const report of normalized) {
    for (const [key, value] of (Object.entries(report.assetTypeBreakdown || {}) as [string, any][])) {
      mergedTypeBreakdown[key] = number(mergedTypeBreakdown[key], 0) + number(value, 0);
    }
    for (const [key, value] of (Object.entries(report.contributorBreakdown || {}) as [string, any][])) {
      mergedContributorBreakdown[key] = number(mergedContributorBreakdown[key], 0) + number(value, 0);
    }
  }
  const topReusableAssets: any = normalized
    .flatMap((report?: any) : any => report.topReusableAssets)
    .sort((left?: any, right?: any) : any => number(right.rankScore, 0) - number(left.rankScore, 0))
    .slice(0, 10);
  return {
    reportCount: normalized.length,
    workspaceCount: new Set<any>(normalized.map((report?: any) : any => report.workspaceId).filter(Boolean)).size,
    acceptedCount: normalized.reduce((sum?: any, report?: any) : any => sum + report.acceptedCount, 0),
    usageCount: normalized.reduce((sum?: any, report?: any) : any => sum + report.usageCount, 0),
    uniqueWorkspaceAdoptions: normalized.reduce((sum?: any, report?: any) : any => sum + report.uniqueWorkspaceAdoptions, 0),
    permissionRequestCount: normalized.reduce((sum?: any, report?: any) : any => sum + report.permissionRequestCount, 0),
    permissionGrantCount: normalized.reduce((sum?: any, report?: any) : any => sum + report.permissionGrantCount, 0),
    rollbackCount: normalized.reduce((sum?: any, report?: any) : any => sum + report.rollbackCount, 0),
    assetContributionScore: normalized.reduce((sum?: any, report?: any) : any => sum + report.assetContributionScore, 0),
    assetTypeBreakdown: mergedTypeBreakdown,
    contributorBreakdown: mergedContributorBreakdown,
    topReusableAssets,
    highDemandRestrictedAssets: normalized.flatMap((report?: any) : any => report.highDemandRestrictedAssets).slice(0, 20),
    rollbackHotspots: normalized.flatMap((report?: any) : any => report.rollbackHotspots).slice(0, 20),
    underMaintainedAssets: normalized.flatMap((report?: any) : any => report.underMaintainedAssets).slice(0, 20)
  };
}

function normalizeCapacity(input: Record<string, any> = {}) : any {
  const source: any = asObject(input);
  return {
    benchmarkCount: asArray(source.benchmarks || source.reports).length,
    latestStatus: text(source.latestStatus || source.status || ""),
    capacityProfile: text(source.capacityProfile || source.profileId || source.profile || ""),
    ingestDocuments: number(source.ingestDocuments ?? source.ingest?.documentCount, 0),
    searchP95Ms: number(source.searchP95Ms ?? source.search?.p95Ms, 0),
    qps: number(source.qps ?? source.search?.qps, 0),
    estimatedCostUsd: number(source.estimatedCostUsd ?? source.cost?.estimatedUsd, 0),
    failures: asArray(source.failures)
  };
}

function normalizeEvaluation(input: Record<string, any> = {}) : any {
  const source: any = asObject(input);
  return {
    runCount: number(source.runCount, asArray(source.runs).length),
    passRate: number(source.passRate, 0),
    ragScore: number(source.ragScore, 0),
    synthesisScore: number(source.synthesisScore, 0),
    agentTaskSuccessRate: number(source.agentTaskSuccessRate, 0),
    unsupportedClaimCount: number(source.unsupportedClaimCount, 0),
    regressions: asArray(source.regressions)
  };
}

function normalizeTrace(input: Record<string, any> = {}) : any {
  const source: any = asObject(input);
  return {
    spanCount: number(source.spanCount, 0),
    redactionFailures: number(source.redactionFailures, 0),
    deniedRequests: number(source.deniedRequests, 0),
    highRiskToolCalls: number(source.highRiskToolCalls, 0),
    costUsd: number(source.costUsd, 0)
  };
}

function healthRisks(health: Record<string, any> = {}) : any {
  return asArray(health.gates)
    .filter((gate?: any) : any => text(gate.status) !== "pass")
    .map((gate?: any) : any => ({
      type: "production_gate",
      severity: gate.blockerLevel === "P0" ? "critical" : "warning",
      id: gate.id,
      title: gate.title,
      status: gate.status,
      nextStep: gate.nextStep
    }));
}

function assetRisks(assetValue: Record<string, any> = {}) : any {
  const risks: any[] = [];
  for (const asset of asArray(assetValue.highDemandRestrictedAssets)) {
    risks.push({
      type: "high_demand_restricted_asset",
      severity: "warning",
      id: text(asset.contributionId || asset.assetId || asset.title),
      title: text(asset.title || "restricted asset"),
      nextStep: "review_access_policy"
    });
  }
  for (const asset of asArray(assetValue.rollbackHotspots)) {
    risks.push({
      type: "rollback_hotspot",
      severity: "warning",
      id: text(asset.contributionId || asset.assetId || asset.title),
      title: text(asset.title || "rollback hotspot"),
      nextStep: "review_quality_or_deprecate"
    });
  }
  return risks;
}

function keyFindings({ health, assetValue, evaluation, capacity, trace }: Record<string, any>) : any {
  const findings: any[] = [];
  findings.push(`production_status:${text(health.status || "missing")}`);
  findings.push(`asset_value_score:${assetValue.assetContributionScore}`);
  findings.push(`asset_usage:${assetValue.usageCount}`);
  if (assetValue.permissionRequestCount > assetValue.permissionGrantCount) {
    findings.push("permission_demand_exceeds_grants");
  }
  if (assetValue.rollbackCount > 0) {
    findings.push("asset_rollbacks_present");
  }
  if (evaluation.regressions.length > 0 || evaluation.unsupportedClaimCount > 0) {
    findings.push("quality_regression_or_unsupported_claims");
  }
  if (capacity.failures.length > 0) {
    findings.push("capacity_failures_present");
  }
  if (trace.redactionFailures > 0 || trace.highRiskToolCalls > 0) {
    findings.push("trace_security_attention_required");
  }
  return findings;
}

export async function buildExecutiveReport(input: Record<string, any> = {}) : Promise<any> {
  throwIfObservabilityAborted(input.signal);
  const generatedAt: any = text(input.generatedAt || nowIso());
  const health: any = input.productionHealth || await buildProductionHealthReport({
    repoRoot: input.repoRoot,
    reportRoot: input.reportRoot
  });
  const assetValue: any = aggregateContributionReports(input.contributionReports || input.assetContributionReports || []);
  const capacity: any = normalizeCapacity(input.capacity || input.capacitySummary);
  const evaluation: any = normalizeEvaluation(input.evaluation || input.evaluationSummary);
  const trace: any = normalizeTrace(input.trace || input.traceSummary);
  const risks: any = [
    ...healthRisks(health),
    ...assetRisks(assetValue)
  ].slice(0, 30);
  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: EXECUTIVE_REPORT_PROTOCOL_VERSION,
    reportId: text(input.reportId || stableId("executive_report", {
      generatedAt,
      productionRunId: health.latestReport?.runId || "",
      assetValue
    })),
    generatedAt,
    timeRange: text(input.timeRange || "all"),
    status: risks.some((risk?: any) : any => risk.severity === "critical") ? "blocked" : text(health.status || "unknown"),
    executiveSummary: {
      headline: text(input.headline || "Meshrix.js executive report"),
      keyFindings: keyFindings({ health, assetValue, evaluation, capacity, trace }),
      recommendedDecisions: risks.slice(0, 5).map((risk?: any) : any => ({
        riskType: risk.type,
        targetId: risk.id,
        decision: risk.nextStep
      }))
    },
    productionReadiness: {
      status: text(health.status || "missing"),
      latestRunId: text(health.latestReport?.runId || ""),
      blockedP0: number(health.summary?.blockedP0, 0),
      failedGates: asArray(health.gates).filter((gate?: any) : any => text(gate.status) !== "pass").map((gate?: any) : any => gate.id),
      missingCoverage: asArray(health.coverage?.missing)
    },
    assetValue,
    qualityAndEvaluation: evaluation,
    capacityAndCost: capacity,
    traceAndSecurity: trace,
    risks,
    sourceRefs: {
      productionHealthReport: text(health.latestReport?.reportPath || ""),
      contributionReportIds: asArray(input.contributionReports || input.assetContributionReports).map((report?: any) : any => text(report.reportId)).filter(Boolean)
    }
  };
  return finalizeSensitiveReport(report, {
    signal: input.signal,
    provenance: {
      producer: "meshrix-core-observability",
      commandId: "executive-report.generate",
      sourceRevision: EXECUTIVE_REPORT_PROTOCOL_VERSION
    }
  });
}

export function createExecutiveReportStore({ userDataPath = "" }: Record<string, any> = {}) : any {
  const filePath: any = storePath(userDataPath);
  const mutationKey: any = stateFileKey(filePath);
  const reportCache: any = createBoundedSnapshotCache({ maxEntries: OBSERVABILITY_BUDGETS.maxReports });
  const reportQueue: any = createBoundedWorkQueue();

  async function readStore() : Promise<any> {
    return await readJson(filePath, {
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: EXECUTIVE_REPORT_PROTOCOL_VERSION,
      updatedAt: "",
      reports: []
    });
  }

  async function writeStore(store?: any) : Promise<any> {
    const next: Record<string, any> = {
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: EXECUTIVE_REPORT_PROTOCOL_VERSION,
      updatedAt: nowIso(),
      reports: asArray(store.reports)
    };
    await writeJson(filePath, next);
    return next;
  }

  return {
    protocolVersion: EXECUTIVE_REPORT_PROTOCOL_VERSION,
    async list() : Promise<any> {
      await waitForStateIdle(mutationKey);
      const store: any = await readStore();
      for (const report of asArray(store.reports)) reportCache.set(text(report.reportId), report);
      return {
        schemaVersion: "v0.0.1:schema:definition-1",
        protocolVersion: EXECUTIVE_REPORT_PROTOCOL_VERSION,
        updatedAt: text(store.updatedAt || ""),
        reports: asArray(store.reports).slice().sort((left?: any, right?: any) : any => text(right.generatedAt).localeCompare(text(left.generatedAt)))
      };
    },
    async generate(input: Record<string, any> = {}) : Promise<any> {
      return reportQueue.run(() : any => queueStateMutation(mutationKey, async () : Promise<any> => {
        throwIfObservabilityAborted(input.signal);
        const store: any = await readStore();
        const report: any = await buildExecutiveReport(input);
        const reports: any = [
          report,
          ...asArray(store.reports).filter((item?: any) : any => text(item.reportId) !== report.reportId)
        ].slice(0, OBSERVABILITY_BUDGETS.maxReports);
        throwIfObservabilityAborted(input.signal);
        await writeStore({ reports });
        reportCache.set(text(report.reportId), report);
        return report;
      }), { signal: input.signal });
    },
    async get(reportId: any = "") : Promise<any> {
      const cacheKey: any = text(reportId);
      const cached: any = reportCache.get(cacheKey);
      if (cached) return cached;
      await waitForStateIdle(mutationKey);
      const store: any = await readStore();
      const report: any = asArray(store.reports).find((item?: any) : any => text(item.reportId) === cacheKey) || null;
      if (report) reportCache.set(cacheKey, report);
      return report;
    },
    observabilityBudgets() : any {
      return Object.freeze({ queue: reportQueue.snapshot(), cache: reportCache.snapshot() });
    }
  };
}
