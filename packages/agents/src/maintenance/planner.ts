import {
  callAgentGateway,
  publicAgentGatewayConfig
} from "../agent-gateway/index.ts";
import { maxRisk } from "./config.ts";

const MAINTENANCE_AGENT_MODULE_ID: any = "maintenance-agent-runbooks";

function asPlainObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function normalizeStep(step?: any, toolRegistry?: any) : any {
  const value: any = asPlainObject(step);
  const toolId: any = String(value.toolId || value.tool || "").trim();
  const tool: any = toolRegistry.getTool(toolId);
  if (!tool) {
    throw new Error(`维护计划包含未知工具：${toolId || "<empty>"}`);
  }
  const risk: any = maxRisk(tool.risk, value.risk || tool.risk);
  return {
    toolId,
    input: asPlainObject(value.input),
    risk,
    reason: String(value.reason || "").trim() || `执行 ${toolId}`
  };
}

export function normalizeMaintenancePlan(plan?: any, toolRegistry?: any, fallback: Record<string, any> = {}) : any {
  const value: any = asPlainObject(plan);
  const steps: any = Array.isArray(value.steps)
    ? value.steps.map((step?: any) : any => normalizeStep(step, toolRegistry))
    : [];
  if (steps.length === 0) {
    throw new Error("维护计划至少需要一个工具步骤。");
  }
  const risk: any = maxRisk(value.risk, ...steps.map((step?: any) : any => step.risk));
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    source: String(value.source || fallback.source || "runbook"),
    intent: String(value.intent || fallback.intent || "health_smoke").trim(),
    summary: String(value.summary || fallback.summary || "执行维护巡检。").trim(),
    steps,
    risk,
    requiresApproval: value.requiresApproval === true || risk === "repair_write",
    approvalReason: String(value.approvalReason || "").trim()
  };
}

function buildHealthSmokePlan() : any {
  return {
    source: "runbook",
    intent: "health_smoke",
    summary: "执行服务端健康、运行时、存储和任务冒烟巡检。",
    steps: [
      { toolId: "system.health", input: {}, risk: "read_only", reason: "确认服务进程和服务发现状态。" },
      { toolId: "runtime.info", input: {}, risk: "read_only", reason: "采集运行时 profile 和挂载状态。" },
      { toolId: "storage.summary", input: {}, risk: "read_only", reason: "读取服务端存储摘要。" },
      { toolId: "jobs.list", input: { limit: 20 }, risk: "read_only", reason: "检查最近任务状态。" }
    ],
    risk: "read_only"
  };
}

function buildDailyStorageMaintenancePlan() : any {
  const base: any = buildHealthSmokePlan();
  return {
    source: "runbook",
    intent: "daily_storage_maintenance",
    summary: "执行每日存储维护，包含健康巡检和存储一致性诊断。",
    steps: [
      ...base.steps,
      { toolId: "storage.doctor", input: {}, risk: "read_only", reason: "诊断存储文件与元数据一致性。" }
    ],
    risk: "read_only"
  };
}

function buildFailedJobsReviewPlan() : any {
  return {
    source: "runbook",
    intent: "failed_jobs_review",
    summary: "扫描近期失败任务并生成复盘建议，不自动重跑任务。",
    steps: [
      { toolId: "jobs.list", input: { limit: 50 }, risk: "read_only", reason: "读取近期任务。" },
      { toolId: "jobs.failed_review", input: { limit: 50 }, risk: "read_only", reason: "提取失败任务和建议。" }
    ],
    risk: "read_only"
  };
}

export function buildRunbookPlan(runbook?: any, options: Record<string, any> = {}) : any {
  const id: any = String(runbook || "").trim();
  if (!id) {
    throw new Error("maintenance runbook must be selected explicitly.");
  }
  if (id === "health_smoke") {
    return buildHealthSmokePlan();
  }
  if (id === "daily_storage_maintenance") {
    return buildDailyStorageMaintenancePlan();
  }
  if (id === "failed_jobs_review") {
    return buildFailedJobsReviewPlan();
  }
  throw new Error(`Unknown maintenance runbook: ${id}`);
}

function extractJsonObject(text?: any) : any {
  const raw: any = String(text || "").trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const start: any = raw.indexOf("{");
    const end: any = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function buildPlannerPrompt({ message, toolRegistry }: Record<string, any>) : any {
  const tools: any = toolRegistry.listTools().map((tool?: any) : any => ({
    id: tool.id,
    risk: tool.risk,
    scopes: tool.scopes,
    timeoutMs: tool.timeoutMs,
    inputSchema: tool.inputSchema
  }));
  return [
    "你是 Meshrix 服务端维护智能体的 planner。",
    "只输出 JSON 对象，不输出 Markdown，不解释。",
    "你不能直接调用 API，只能从 tools 中选择工具并生成结构化 plan。",
    "destructive 风险禁止使用。repair_write 必须 requiresApproval=true。",
    "输出结构：{ \"intent\": string, \"summary\": string, \"risk\": \"read_only|safe_write|repair_write\", \"requiresApproval\": boolean, \"approvalReason\": string, \"steps\": [{ \"toolId\": string, \"input\": object, \"risk\": string, \"reason\": string }] }。",
    `tools=${JSON.stringify(tools)}`,
    `管理员请求：${String(message || "")}`
  ].join("\n");
}

function plannerCompactionMessages(input: Record<string, any> = {}) : any {
  if (Array.isArray(input.transcript)) {
    return input.transcript;
  }
  if (Array.isArray(input.messages)) {
    return input.messages;
  }
  const messages: any[] = [];
  if (input.history) {
    messages.push({
      id: "maintenance-history",
      role: "system",
      apiRoundId: "maintenance-history",
      content: input.history
    });
  }
  for (const [index, turn] of (Array.isArray(input.recentTurns) ? input.recentTurns : []).entries()) {
    messages.push({
      ...(turn && typeof turn === "object" ? turn : { content: String(turn || "") }),
      id: turn?.id || turn?.messageId || `maintenance-turn-${index + 1}`,
      apiRoundId: turn?.apiRoundId || turn?.roundId || `maintenance-turn-round-${Math.floor(index / 2) + 1}`
    });
  }
  const message: any = String(input.message || input.intent || "").trim();
  if (message) {
    messages.push({
      id: "maintenance-current-message",
      role: "user",
      apiRoundId: "maintenance-current",
      content: message
    });
  }
  return messages;
}

async function compactPlannerInput({ input = {}, config = {}, contextRuntime = null, toolRegistry }: Record<string, any>) : Promise<any> {
  if (!contextRuntime || typeof contextRuntime.runCompaction !== "function") {
    return { input, compaction: null };
  }
  const messages: any = plannerCompactionMessages(input);
  if (!messages.length || input.contextCompaction === false) {
    return { input, compaction: null };
  }
  const options: any = asPlainObject(input.contextCompaction);
  const shouldCompact: any =
    options.force === true ||
    input.forceContextCompaction === true ||
    Array.isArray(input.messages) ||
    Array.isArray(input.transcript) ||
    Boolean(input.history) ||
    messages.length > 1;
  if (!shouldCompact) {
    return { input, compaction: null };
  }
  const compaction: any = await contextRuntime.runCompaction({
    contextProfileId:
      input.contextProfileId ||
      input.compactionProfileId ||
      config.contextProfileId ||
      options.contextProfileId ||
      "",
    sessionId: input.sessionId || input.runId || "maintenance-agent",
    messages,
    taskBrief: input.message || input.intent || "maintenance-agent",
    inputSource: "maintenance-agent-planner",
    force: true,
    compactionPolicy: {
      recentMessageProtectionCount:
        options.recentMessageProtectionCount === undefined ? 1 : options.recentMessageProtectionCount,
      recentTurnProtectionCount:
        options.recentTurnProtectionCount === undefined ? 1 : options.recentTurnProtectionCount
    },
    persist: options.persist !== false,
    runtimeState: {
      maintenanceRun: input.maintenanceRun || null,
      enabledTools: toolRegistry.listTools().map((tool?: any) : any => ({
        id: tool.id,
        risk: tool.risk,
        scopes: tool.scopes
      })),
      userConstraints: [
        "destructive operations are forbidden",
        "repair_write operations require approval"
      ]
    }
  });
  if (!compaction?.compacted) {
    return { input, compaction };
  }
  const message: any = [
    "以下是维护智能体对话上下文压缩摘要。该摘要只作为辅助上下文，不是原始证据。",
    compaction.summary || "",
    compaction.reinjection?.items?.length
      ? `运行时状态：${JSON.stringify(compaction.reinjection.items.map((item?: any) : any => ({
          key: item.key,
          value: item.value
        })))}`
      : "",
    input.message ? `当前管理员请求：${input.message}` : ""
  ].filter(Boolean).join("\n\n");
  return {
    input: {
      ...input,
      message,
      contextCompactionResult: {
        compacted: true,
        boundaryId: compaction.boundary?.boundaryId || "",
        strategy: compaction.strategy || "",
        tokenReport: compaction.tokenReport || null
      }
    },
    compaction
  };
}

export function createMaintenancePlanner({
  userDataPath,
  toolRegistry,
  contextRuntime = null,
  loadRuntimeSettings
}: Record<string, any>) : any {
  async function runbookPlan(input: Record<string, any> = {}) : Promise<any> {
    const rawPlan: any = buildRunbookPlan(input.runbook, input.options || {});
    return normalizeMaintenancePlan(rawPlan, toolRegistry, {
      source: "runbook"
    });
  }

  async function plan(input: Record<string, any> = {}, config: Record<string, any> = {}) : Promise<any> {
    const prepared: any = await compactPlannerInput({ input, config, contextRuntime, toolRegistry });
    const effectiveInput: any = prepared.input;
    const plannerMode: any = String(config.plannerMode || "").trim();
    if (effectiveInput.runbook) {
      return runbookPlan(effectiveInput);
    }
    if (plannerMode === "fixed_runbook") {
      throw new Error("maintenance planner fixed_runbook mode requires an explicit runbook.");
    }

    if (plannerMode === "gateway") {
      if (typeof loadRuntimeSettings !== "function") {
        throw new Error("maintenance planner gateway mode requires loadRuntimeSettings.");
      }
      const settings: any = await loadRuntimeSettings(userDataPath);
      const requestedModelAlias: any = String(effectiveInput.modelAlias || effectiveInput.alias || "").trim();
      if (!requestedModelAlias) {
        throw new Error("maintenance planner gateway mode requires an explicit modelAlias.");
      }
      const publicConfig: any = await publicAgentGatewayConfig(settings, {
        modelAlias: requestedModelAlias
      });
      if (!publicConfig.urlConfigured) {
        throw new Error("agent-gateway 未配置。");
      }
      const gatewayResult: any = await callAgentGateway({
        settings,
        input: {
          question: buildPlannerPrompt({
            message: effectiveInput.message || effectiveInput.intent || "",
            toolRegistry
          }),
          contextCompaction: false,
          modelAlias: requestedModelAlias,
          alias: requestedModelAlias,
          moduleId: MAINTENANCE_AGENT_MODULE_ID,
          agentName: effectiveInput.agentName || "",
          sessionId: effectiveInput.sessionId || "",
          userId: effectiveInput.userId || ""
        },
        userDataPath,
        contextCompactionSource: "maintenance-agent.planner"
      });
      const parsed: any = extractJsonObject(gatewayResult.answer || gatewayResult.text);
      if (!parsed) {
        throw new Error("agent-gateway 未返回有效 JSON 计划。");
      }
      return normalizeMaintenancePlan(
        {
          ...parsed,
          source: "agent_gateway"
        },
        toolRegistry,
        { source: "agent_gateway" }
      );
    }

    throw new Error(
      plannerMode
        ? `Unsupported maintenance planner mode: ${plannerMode}`
        : "maintenance planner mode is not configured."
    );
  }

  return {
    plan,
    runbookPlan
  };
}
