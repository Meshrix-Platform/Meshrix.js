import type { RiskControlBoundary, RiskControlEnvironment, RiskControlObject } from "../types.ts";

export const RISK_CONTROL_MODEL_VERSION = "v1:m1.d2.l1.c1.r1";
export const RISK_CONTROL_DSL_VERSION = "v1:d2";

export const RISK_CONTROL_BOUNDARY_IDS = Object.freeze({
  CLIENT_MCP_INGRESS: "client-mcp-ingress",
  SERVER_API_EGRESS: "server-api-egress",
  PLATFORM_SELF: "platform-self"
});

export const RISK_CONTROL_ENVIRONMENT_IDS = Object.freeze({
  TERMINAL_AGENT: "terminal-agent",
  PLATFORM_RUNTIME: "platform-runtime",
  APPLICATION_SERVER: "application-server"
});

export const RISK_CONTROL_OBJECT_IDS = Object.freeze({
  IDENTITY_ADMISSION_AUTHENTICATION: "identity-admission-authentication",
  PERMISSION_BEHAVIOR_POLICY: "permission-behavior-policy",
  DATA_STATE_SEMANTICS: "data-state-semantics",
  TRAFFIC_RESOURCE_MANAGEMENT: "traffic-resource-management",
  AUDIT_FACT_VERIFICATION: "audit-fact-verification"
});

export const RISK_CONTROL_OBJECT_ORDER: readonly string[] = Object.freeze([
  RISK_CONTROL_OBJECT_IDS.IDENTITY_ADMISSION_AUTHENTICATION,
  RISK_CONTROL_OBJECT_IDS.PERMISSION_BEHAVIOR_POLICY,
  RISK_CONTROL_OBJECT_IDS.DATA_STATE_SEMANTICS,
  RISK_CONTROL_OBJECT_IDS.TRAFFIC_RESOURCE_MANAGEMENT,
  RISK_CONTROL_OBJECT_IDS.AUDIT_FACT_VERIFICATION
]);

export const RISK_CONTROL_GATES: readonly string[] = Object.freeze([
  "admit",
  "bind",
  "authorize",
  "approve",
  "execute",
  "audit-recover"
]);

export const RISK_CONTROL_DEFINITION_STATES: readonly string[] = Object.freeze([
  "draft",
  "candidate",
  "active",
  "deprecated",
  "superseded",
  "retired"
]);

export const RISK_CONTROL_BOUNDARIES: readonly RiskControlBoundary[] = Object.freeze([
  {
    id: RISK_CONTROL_BOUNDARY_IDS.CLIENT_MCP_INGRESS,
    label: "客户端 MCP 入口",
    fromEnvironmentId: RISK_CONTROL_ENVIRONMENT_IDS.TERMINAL_AGENT,
    toEnvironmentId: RISK_CONTROL_ENVIRONMENT_IDS.PLATFORM_RUNTIME,
    riskOwner: "platform-runtime",
    trustAssumption: "终端智能体是部分可信或不可信环境；通过客户端 MCP 入口进入平台运行时的声明必须被重新验证。"
  },
  {
    id: RISK_CONTROL_BOUNDARY_IDS.SERVER_API_EGRESS,
    label: "服务端 API 出口",
    fromEnvironmentId: RISK_CONTROL_ENVIRONMENT_IDS.PLATFORM_RUNTIME,
    toEnvironmentId: RISK_CONTROL_ENVIRONMENT_IDS.APPLICATION_SERVER,
    riskOwner: "platform-runtime",
    trustAssumption: "应用服务器是平台运行时管控之外的系统；服务端 API 出口返回的状态必须被校验、归一化、登记和审计。"
  },
  {
    id: RISK_CONTROL_BOUNDARY_IDS.PLATFORM_SELF,
    label: "平台自治理",
    fromEnvironmentId: RISK_CONTROL_ENVIRONMENT_IDS.PLATFORM_RUNTIME,
    toEnvironmentId: RISK_CONTROL_ENVIRONMENT_IDS.PLATFORM_RUNTIME,
    riskOwner: "platform-runtime",
    trustAssumption: "平台内部控制点也必须注册、验证和审计；内部路径不能绕过风控事实源。"
  }
]);

export const RISK_CONTROL_ENVIRONMENTS: readonly RiskControlEnvironment[] = Object.freeze([
  {
    id: RISK_CONTROL_ENVIRONMENT_IDS.TERMINAL_AGENT,
    label: "终端智能体",
    role: "平台运行时之外、通过客户端 MCP 入口主动发起操作的一侧。"
  },
  {
    id: RISK_CONTROL_ENVIRONMENT_IDS.PLATFORM_RUNTIME,
    label: "平台运行时",
    role: "风控执行中心，负责 Operation、Capability 裁决、状态提交、审计证据和恢复事实。"
  },
  {
    id: RISK_CONTROL_ENVIRONMENT_IDS.APPLICATION_SERVER,
    label: "应用服务器",
    role: "平台运行时之外、通过服务端 API 出口被调用、写入、同步或回调的一侧。"
  }
]);

export const RISK_CONTROL_OBJECTS: readonly RiskControlObject[] = Object.freeze([
  {
    id: RISK_CONTROL_OBJECT_IDS.IDENTITY_ADMISSION_AUTHENTICATION,
    label: "身份与准入认证",
    question: "谁或什么可以进入边界，身份是否可信。",
    outcome: "建立终端智能体、用户、设备、provider account、凭据和租户映射的可信上下文。"
  },
  {
    id: RISK_CONTROL_OBJECT_IDS.PERMISSION_BEHAVIOR_POLICY,
    label: "权限与行为策略",
    question: "允许做什么、禁止做什么、需要什么确认。",
    outcome: "把身份上下文、请求意图、Capability、资源范围、风险级别和外部副作用统一到执行前裁决。"
  },
  {
    id: RISK_CONTROL_OBJECT_IDS.DATA_STATE_SEMANTICS,
    label: "数据与状态语义",
    question: "数据是什么状态、是否真的保存、是否只是引用、是否可以恢复。",
    outcome: "防止把 queued、cached、projected、contractVerified 误说成 archived、committed 或 synced。"
  },
  {
    id: RISK_CONTROL_OBJECT_IDS.TRAFFIC_RESOURCE_MANAGEMENT,
    label: "流量与资源管理",
    question: "能用多少、什么时候用、失败后如何退避。",
    outcome: "保护平台运行时、终端智能体、应用服务器、预算和用户体验。"
  },
  {
    id: RISK_CONTROL_OBJECT_IDS.AUDIT_FACT_VERIFICATION,
    label: "审计与事实验证",
    question: "事后如何证明、如何复查、如何追踪责任。",
    outcome: "让每个跨边界行为都可解释、可复查、可统计，并能关联到对应状态变化。"
  }
]);

export function knownRiskControlBoundaryIds(): Set<string> {
  return new Set(RISK_CONTROL_BOUNDARIES.map((entry) => entry.id));
}

export function knownRiskControlEnvironmentIds(): Set<string> {
  return new Set(RISK_CONTROL_ENVIRONMENTS.map((entry) => entry.id));
}

export function knownRiskControlObjectIds(): Set<string> {
  return new Set(RISK_CONTROL_OBJECTS.map((entry) => entry.id));
}
