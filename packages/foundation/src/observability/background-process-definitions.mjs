export const BACKGROUND_PROCESS_SCHEMA_VERSION = "v0.0.1:platform:background-process-schema-1";
export const IMPORT_PARSE_ACTIVE_STATUSES = new Set(["queued", "running"]);
export const MAINTENANCE_ACTIVE_STATUSES = new Set(["queued", "running"]);
export const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const AGENT_WORKER_SUPPORTED_PROVIDERS = new Set([
  "openai",
  "deepseek",
  "openrouter",
  "copilot",
  "local-model"
]);

export const BACKGROUND_PROCESS_DEFINITIONS = [
  {
    role: "import-worker",
    label: "导入解析 Worker",
    description: "轮询导入队列并执行解析、断点续传和入库。",
    processType: "service",
    responsibility: "运行导入解析队列服务。",
    services: ["导入解析队列", "断点续传恢复", "任务入库"],
    features: ["任务队列", "网关输入", "checkpoint 恢复"],
    monitors: ["import_parse_job 队列心跳", "checkpoint tree 更新"],
    alerts: ["queueInterrupted", "processNotRunning", "processStale", "processRestarted"]
  },
  {
    role: "maintenance-worker",
    label: "智能巡检 Worker",
    description: "调度智能巡检 runbook，恢复排队中的巡检运行，并写入审批和审计链路。",
    processType: "service",
    responsibility: "运行智能巡检调度服务。",
    services: ["智能巡检调度", "巡检 runbook", "审批与审计"],
    features: ["智能巡检", "任务队列"],
    monitors: ["maintenance-agent runs", "智能巡检队列"],
    alerts: ["processNotRunning", "processStale", "processRestarted"]
  },
  {
    role: "agent-worker",
    label: "智能体 Worker",
    description: "执行受控网关调用和智能体转发任务。",
    processType: "service",
    responsibility: "运行智能体任务服务。",
    services: ["智能体转发", "策略预览", "调用审计"],
    features: ["智能体", "网关治理"],
    monitors: ["agent task tick", "智能体运行状态"],
    alerts: ["processNotRunning", "processStale", "processRestarted"]
  }
];

export const SERVER_PROCESS_DEFINITIONS = [
  {
    role: "server-main",
    label: "LicoMesh 服务端",
    description: "承载控制台、HTTP API、JSON-RPC、CLI 转发和本地运行时的主服务进程。",
    processType: "service",
    responsibility: "运行服务端主调用面和控制台 API。",
    services: ["HTTP API", "JSON-RPC", "CLI 转发", "Server Console"],
    features: ["系统配置", "任务队列", "网关治理", "智能体", "运维监控"],
    monitors: ["进程存活", "请求入口"],
    alerts: ["processNotRunning", "processStale"]
  },
  {
    role: "background-supervisor",
    label: "后台 Worker 管理进程",
    description: "管理并按需拉起导入解析、智能巡检和智能体 Worker，持续写入后台进程状态。",
    processType: "daemon",
    responsibility: "管理后台 Worker 进程。",
    services: [],
    features: ["运维监控", "任务队列"],
    monitors: ["import-worker", "maintenance-worker", "agent-worker"],
    alerts: ["supervisorStopped", "processNotRunning", "processRestarted"]
  },
  {
    role: "system-inspection",
    label: "系统巡检",
    description: "由 Node.js 执行的系统巡检守护进程，负责写入后台告警状态。",
    processType: "daemon",
    responsibility: "巡检服务端进程和任务队列，生成运维报警。",
    services: [],
    features: ["运维监控", "报警", "任务队列恢复"],
    monitors: ["后台进程状态", "work-queue-observation 队列状态", "checkpoint/log 证据"],
    alerts: ["processNotRunning", "processStale", "queueInterrupted"]
  }
];

const ROLE_FEATURE_IDS = Object.freeze({
  "import-worker": ["work-queue-core"],
  "maintenance-worker": ["maintenance-agent-runbooks"],
  "agent-worker": ["agent-gateway", "gateway-governance"]
});

function activeConsoleFeatureIdsFromEnv() {
  const explicit = String(process.env.LICO_FEATURES || "").trim();
  if (!explicit) {
    return null;
  }
  return new Set(explicit.split(",").map((item) => item.trim()).filter(Boolean));
}

export function isRoleEnabledByFeatures(role = "") {
  const active = activeConsoleFeatureIdsFromEnv();
  if (!active) {
    return true;
  }
  const requiredAny = ROLE_FEATURE_IDS[role] || [];
  return requiredAny.length === 0 || requiredAny.some((featureId) => active.has(featureId));
}
