import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeCapabilityBindingGuardStatus,
  describeCapabilityKernelStatus
} from "../security/authorization/capability-kernel-status.ts";
import { finalizeSensitiveReport } from "./sensitive-report-scan.ts";

export const PRODUCTION_HEALTH_REPORT_TYPE: any = "v0.0.1:platform:production-health-1";
export const PRODUCTION_READINESS_REPORT_TYPE: any = "v0.0.1:platform:production-readiness-1";
export const DEFAULT_PRODUCTION_READINESS_REPORT_ROOT: any = "build/reports/production-readiness";

const defaultRepoRoot: any = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const PRODUCTION_HEALTH_PROVENANCE: Readonly<Record<string, any>> = Object.freeze({
  producer: "meshrix-core-observability",
  commandId: "production-health.read",
  sourceRevision: PRODUCTION_HEALTH_REPORT_TYPE
});

function finalizeProductionHealthReport(report?: any) : any {
  return finalizeSensitiveReport(report, { provenance: PRODUCTION_HEALTH_PROVENANCE });
}

const SECTION_DEFINITIONS: any[] = [
  {
    id: "readiness",
    label: "生产准入",
    description: "架构、网关注册、UI smoke 和离线包能否支撑发版。",
    gateIds: ["architecture", "version-registry", "version-naming", "gateway-registration", "ui-smoke", "offline-license"]
  },
  {
    id: "gatewayGovernance",
    label: "网关治理",
    description: "上游注册、策略预览、审批流和流量控制是否持续达标。",
    gateIds: ["gateway-registration", "policy-preview", "approval-workflow", "traffic-control"]
  },
  {
    id: "agentRuntime",
    label: "智能体运行时",
    description: "会话线程、长任务工作流和终端贡献资产治理是否闭环。",
    gateIds: ["session-thread", "durable-workflow", "workspace-contribution-governance"]
  },
  {
    id: "security",
    label: "权限安全",
    description: "网关授权、工具授权、Capability Kernel 和控制台安全边界是否有效。",
    gateIds: ["gateway-access", "tool-permission", "capability-kernel-security"]
  },
  {
    id: "observability",
    label: "可观测性",
    description: "内部 Trace、运行时日志和脱敏链路是否可用于问题定位。",
    gateIds: ["trace-observability"]
  },
  {
    id: "continuity",
    label: "连续性",
    description: "备份恢复、Checkpoint、升级迁移和配置迁移是否可演练。",
    gateIds: ["backup-restore", "upgrade-migration"]
  }
];

function resolveReportRoot(repoRoot: any = defaultRepoRoot, reportRoot: any = DEFAULT_PRODUCTION_READINESS_REPORT_ROOT) : any {
  return path.isAbsolute(reportRoot) ? reportRoot : path.resolve(repoRoot, reportRoot);
}

function toRelativePath(filePath?: any, repoRoot: any = defaultRepoRoot) : any {
  const relative: any = path.relative(repoRoot, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}

async function safeReadDir(dir?: any) : Promise<any> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readJsonFile(filePath?: any) : Promise<any> {
  const raw: any = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function normalizeCommand(command: Record<string, any> = {}) : any {
  return {
    command: String(command.command || ""),
    exitCode: Number(command.exitCode ?? 0),
    timedOut: Boolean(command.timedOut),
    elapsedMs: Number(command.elapsedMs || 0)
  };
}

function normalizeGate(gate: Record<string, any> = {}) : any {
  const commands: any = Array.isArray(gate.commands) ? gate.commands.map(normalizeCommand) : [];
  const failedCommands: any = commands.filter((command?: any) : any => command.exitCode !== 0 || command.timedOut);
  return {
    id: String(gate.id || ""),
    title: String(gate.title || gate.id || ""),
    status: String(gate.status || "unknown"),
    blockerLevel: String(gate.blockerLevel || ""),
    owner: String(gate.owner || ""),
    coverage: Array.isArray(gate.coverage) ? gate.coverage.map(String) : [],
    evidencePath: String(gate.evidencePath || ""),
    nextStep: String(gate.nextStep || ""),
    commands,
    commandSummary: {
      total: commands.length,
      failed: failedCommands.length,
      timedOut: commands.filter((command?: any) : any => command.timedOut).length,
      elapsedMs: commands.reduce((total?: any, command?: any) : any => total + command.elapsedMs, 0)
    }
  };
}

function statusWeight(status?: any) : any {
  if (status === "fail" || status === "timeout" || status === "blocked") return 4;
  if (status === "missing") return 3;
  if (status === "warning" || status === "partial") return 2;
  if (status === "pass") return 1;
  return 0;
}

function worstStatus(statuses: any = []) : any {
  const ordered: any = statuses.filter(Boolean).sort((left?: any, right?: any) : any => statusWeight(right) - statusWeight(left));
  return ordered[0] || "missing";
}

function gateTone(status?: any) : any {
  if (status === "pass") return "success";
  if (status === "timeout" || status === "fail" || status === "blocked") return "danger";
  if (status === "missing" || status === "partial" || status === "warning") return "warning";
  return "neutral";
}

function buildSections(gates: any = []) : any {
  const byGateId: any = new Map<any, any>(gates.map((gate?: any) : any => [gate.id, gate]));
  return SECTION_DEFINITIONS.map((definition?: any) : any => {
    const sectionGates: any = definition.gateIds.map((gateId?: any) : any => byGateId.get(gateId)).filter(Boolean);
    const missingGateIds: any = definition.gateIds.filter((gateId?: any) : any => !byGateId.has(gateId));
    const status: any = sectionGates.length ? worstStatus(sectionGates.map((gate?: any) : any => gate.status)) : "missing";
    const failed: any = sectionGates.filter((gate?: any) : any => gate.status !== "pass");
    return {
      ...definition,
      status: missingGateIds.length > 0 && status === "pass" ? "partial" : status,
      tone: gateTone(missingGateIds.length > 0 && status === "pass" ? "partial" : status),
      passed: sectionGates.filter((gate?: any) : any => gate.status === "pass").length,
      total: definition.gateIds.length,
      missingGateIds,
      gates: sectionGates.map((gate?: any) : any => ({
        id: gate.id,
        title: gate.title,
        status: gate.status,
        tone: gateTone(gate.status),
        blockerLevel: gate.blockerLevel,
        nextStep: gate.nextStep,
        evidencePath: gate.evidencePath
      })),
      nextSteps: failed.map((gate?: any) : any => gate.nextStep).filter(Boolean).slice(0, 3)
    };
  });
}

function normalizeReport(report: Record<string, any> = {}, reportPath: any = "", repoRoot: any = defaultRepoRoot) : any {
  const gates: any = Array.isArray(report.gates) ? report.gates.map(normalizeGate) : [];
  const coverage: any = report.coverage && typeof report.coverage === "object" ? report.coverage : {};
  return {
    schemaVersion: String(report.schemaVersion || "v0.0.1:schema:definition-1"),
    reportType: String(report.reportType || PRODUCTION_READINESS_REPORT_TYPE),
    runId: String(report.runId || path.basename(path.dirname(reportPath)) || ""),
    generatedAt: String(report.generatedAt || ""),
    mode: String(report.mode || ""),
    reportPath: reportPath ? toRelativePath(reportPath, repoRoot) : "",
    markdownPath: reportPath ? toRelativePath(path.join(path.dirname(reportPath), "report.md"), repoRoot) : "",
    repoRoot: String(report.repoRoot || repoRoot),
    git: {
      branch: String(report.git?.branch || ""),
      commit: String(report.git?.commit || ""),
      dirtyFileCount: Number(report.git?.dirtyFileCount || 0)
    },
    overallStatus: String(report.overallStatus || "unknown"),
    productionClaimAllowed: Boolean(report.productionClaimAllowed),
    releaseClaim: String(report.releaseClaim || (report.productionClaimAllowed ? "production-ready" : "blocked-by-production-readiness-gate")),
    summary: {
      pass: Number(report.summary?.pass || 0),
      fail: Number(report.summary?.fail || 0),
      timeout: Number(report.summary?.timeout || 0),
      blockedP0: Number(report.summary?.blockedP0 || 0)
    },
    coverage: {
      required: Array.isArray(coverage.required) ? coverage.required.map(String) : [],
      byRequirement: coverage.byRequirement && typeof coverage.byRequirement === "object" ? coverage.byRequirement : {},
      missing: Array.isArray(coverage.missing) ? coverage.missing.map(String) : []
    },
    gates
  };
}

async function listReportCandidates({ repoRoot = defaultRepoRoot, reportRoot = DEFAULT_PRODUCTION_READINESS_REPORT_ROOT }: Record<string, any> = {}) : Promise<any> {
  const absoluteRoot: any = resolveReportRoot(repoRoot, reportRoot);
  const entries: any = await safeReadDir(absoluteRoot);
  const candidates: any[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const reportPath: any = path.join(absoluteRoot, entry.name, "report.json");
    try {
      const stat: any = await fs.stat(reportPath);
      candidates.push({
        runId: entry.name,
        reportPath,
        mtimeMs: stat.mtimeMs
      });
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return { absoluteRoot, candidates };
}

export async function readProductionReadinessReports(options: Record<string, any> = {}) : Promise<any> {
  const repoRoot: any = options.repoRoot || defaultRepoRoot;
  const { absoluteRoot, candidates } = await listReportCandidates(options);
  const reports: any[] = [];
  for (const candidate of candidates) {
    try {
      const report: any = normalizeReport(await readJsonFile(candidate.reportPath), candidate.reportPath, repoRoot);
      reports.push({
        ...report,
        discoveredRunId: candidate.runId,
        discoveredMtimeMs: candidate.mtimeMs
      });
    } catch (error: any) {
      reports.push({
        schemaVersion: "v0.0.1:schema:definition-1",
        reportType: PRODUCTION_READINESS_REPORT_TYPE,
        runId: candidate.runId,
        generatedAt: "",
        mode: "",
        reportPath: toRelativePath(candidate.reportPath, repoRoot),
        markdownPath: "",
        repoRoot,
        git: { branch: "", commit: "", dirtyFileCount: 0 },
        overallStatus: "fail",
        productionClaimAllowed: false,
        releaseClaim: "blocked-by-report-read-error",
        summary: { pass: 0, fail: 1, timeout: 0, blockedP0: 1 },
        coverage: { required: [], byRequirement: {}, missing: [] },
        gates: [],
        readError: error instanceof Error ? error.message : String(error),
        discoveredRunId: candidate.runId,
        discoveredMtimeMs: candidate.mtimeMs
      });
    }
  }
  reports.sort((left?: any, right?: any) : any => {
    const leftTime: any = Date.parse(left.generatedAt || "") || left.discoveredMtimeMs || 0;
    const rightTime: any = Date.parse(right.generatedAt || "") || right.discoveredMtimeMs || 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return String(right.runId || "").localeCompare(String(left.runId || ""));
  });
  return {
    reportRoot: toRelativePath(absoluteRoot, repoRoot),
    absoluteReportRoot: absoluteRoot,
    reports
  };
}

function missingHealth(reportRoot?: any, capabilityKernel: any = null, capabilityBindingGuard: any = null) : any {
  return finalizeProductionHealthReport({
    schemaVersion: "v0.0.1:schema:definition-1",
    reportType: PRODUCTION_HEALTH_REPORT_TYPE,
    generatedAt: new Date().toISOString(),
    status: "missing",
    tone: "warning",
    reportRoot,
    latestReport: null,
    summary: { pass: 0, fail: 0, timeout: 0, blockedP0: 0 },
    coverage: { required: [], missing: [] },
    capabilityKernel,
    capabilityBindingGuard,
    sections: buildSections([]),
    gates: [],
    actions: [
      {
        id: "run-production-readiness",
        label: "生成生产准入报告",
        command: "node tools/server-scripts/production-readiness-gate.ts"
      }
    ]
  });
}

export async function buildProductionHealthReport(options: Record<string, any> = {}) : Promise<any> {
  const repoRoot: any = options.repoRoot || defaultRepoRoot;
  const { reportRoot, reports } = await readProductionReadinessReports({ ...options, repoRoot });
  const capabilityKernel: any = await describeCapabilityKernelStatus({
    userDataPath: options.userDataPath || options.dataDir || "",
    backend: options.capabilityKernelBackend || "",
    alias: options.capabilityKernelAlias || ""
  });
  const capabilityBindingGuard: any = await describeCapabilityBindingGuardStatus({
    userDataPath: options.userDataPath || options.dataDir || "",
    backend: options.capabilityBindingBackend || "",
    alias: options.capabilityBindingAlias || ""
  });
  if (reports.length === 0) {
    return missingHealth(reportRoot, capabilityKernel, capabilityBindingGuard);
  }
  const latest: any = reports.find((report?: any) : any => report.mode !== "quick") || reports[0];
  const status: any = latest.readError ? "fail" : latest.overallStatus || "unknown";
  const gates: any = latest.gates.map((gate?: any) : any => ({
    ...gate,
    tone: gateTone(gate.status)
  }));
  return finalizeProductionHealthReport({
    schemaVersion: "v0.0.1:schema:definition-1",
    reportType: PRODUCTION_HEALTH_REPORT_TYPE,
    generatedAt: new Date().toISOString(),
    status,
    tone: gateTone(status),
    reportRoot,
    latestReport: {
      reportType: latest.reportType,
      runId: latest.runId,
      generatedAt: latest.generatedAt,
      mode: latest.mode,
      reportPath: latest.reportPath,
      markdownPath: latest.markdownPath,
      readError: latest.readError || "",
      overallStatus: latest.overallStatus,
      productionClaimAllowed: latest.productionClaimAllowed,
      releaseClaim: latest.releaseClaim,
      git: latest.git
    },
    summary: latest.summary,
    coverage: {
      required: latest.coverage.required,
      missing: latest.coverage.missing
    },
    capabilityKernel,
    capabilityBindingGuard,
    sections: buildSections(gates),
    gates,
    history: reports.slice(0, 8).map((report?: any) : any => ({
      runId: report.runId,
      generatedAt: report.generatedAt,
      status: report.readError ? "fail" : report.overallStatus,
      mode: report.mode,
      reportPath: report.reportPath
    })),
    actions: [
      {
        id: "refresh-report",
        label: "重新执行完整生产准入",
        command: "node tools/server-scripts/production-readiness-gate.ts"
      },
      {
        id: "quick-report",
        label: "执行快速生产准入",
        command: "node tools/server-scripts/production-readiness-gate.ts"
      }
    ]
  });
}
