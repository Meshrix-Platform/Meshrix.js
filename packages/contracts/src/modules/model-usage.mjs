export const MODEL_USAGE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "gatewayRouting",
    label: "网关路由智能体",
    designedModule: "服务网关路由",
    description: "辅助选择上游服务、工具授权和转发策略。",
    requiresIntelligence: false,
    alertRequired: false
  }),
  Object.freeze({
    id: "trafficGovernance",
    label: "流量治理智能体",
    designedModule: "限流与审批建议",
    description: "辅助解释工具调用流量、审批和运行风险。",
    requiresIntelligence: true,
    alertRequired: true
  }),
  Object.freeze({
    id: "agentTools",
    label: "智能体工具调用",
    designedModule: "工具调用权限模块",
    description: "智能体可使用服务端工具的权限范围，不需要单独绑定智能体。",
    requiresIntelligence: false,
    alertRequired: false
  }),
  Object.freeze({
    id: "maintenance-agent-runbooks",
    label: "智能巡检",
    designedModule: "维护代理运行手册",
    description: "维护代理 gateway planner 的模型、模块画像和依赖上下文。",
    requiresIntelligence: false,
    alertRequired: false
  })
]);

export const MODEL_USAGE_DEFINITION_IDS = Object.freeze(
  MODEL_USAGE_DEFINITIONS.map((definition) => definition.id)
);
