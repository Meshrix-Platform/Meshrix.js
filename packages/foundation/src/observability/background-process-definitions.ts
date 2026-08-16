export const BACKGROUND_PROCESS_SCHEMA_VERSION: any = "v0.0.1:platform:background-process-schema-1";
export const IMPORT_PARSE_ACTIVE_STATUSES: any = new Set<any>(["queued", "running"]);
export const SAFE_PATH_SEGMENT_PATTERN: any = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const BACKGROUND_PROCESS_DEFINITIONS: any[] = [
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
];

export const SERVER_PROCESS_DEFINITIONS: any[] = [
  {
    role: "server-main",
    label: "Meshrix.js 服务端",
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
    description: "管理并按需拉起导入解析 Worker，持续写入后台进程状态。",
    processType: "daemon",
    responsibility: "管理后台 Worker 进程。",
    services: [],
    features: ["运维监控", "任务队列"],
    monitors: ["import-worker"],
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

const ROLE_FEATURE_IDS: Readonly<Record<string, any>> = Object.freeze({
  "import-worker": ["work-queue-core"]
});

function activeConsoleFeatureIdsFromEnv() : any {
  const explicit: any = String(process.env.MESHRIX_FEATURES || "").trim();
  if (!explicit) {
    return null;
  }
  return new Set<any>(explicit.split(",").map((item?: any) : any => item.trim()).filter(Boolean));
}

export function isRoleEnabledByFeatures(role: any = "") : any {
  const active: any = activeConsoleFeatureIdsFromEnv();
  if (!active) {
    return true;
  }
  const requiredAny: any = ROLE_FEATURE_IDS[role] || [];
  return requiredAny.length === 0 || requiredAny.some((featureId?: any) : any => active.has(featureId));
}
