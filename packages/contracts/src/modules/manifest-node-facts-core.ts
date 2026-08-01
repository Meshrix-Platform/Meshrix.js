import { defineArchitectureNodeFacts } from "./manifest-node-facts-support.ts";

export const CORE_ARCHITECTURE_NODE_FACTS: readonly any[] = Object.freeze([
  ...defineArchitectureNodeFacts("appearance", "appearance", [
    {
      moduleId: "appearance-control-panel",
      label: "外观层",
      hydration: "optional",
      hydratable: true,
      functionItems: ["控制面板展示网关、工作空间、审批和系统管理界面", "只通过应用层或切面层入口调用能力"]
    }
  ]),
  ...defineArchitectureNodeFacts("platform-capabilities", "core-capability", [
    {
      moduleId: "character-configuration",
      label: "角色配置",
      hydration: "essential",
      hydratable: false,
      functionItems: ["以 Tag 为基础语义", "组织、小组和角色继承自标签"]
    },
    {
      moduleId: "tag-management",
      parentModuleId: "character-configuration",
      label: "Tag Management",
      hydration: "essential",
      hydratable: false,
      functionItems: ["tag hierarchy", "scope prerequisite", "custom tag"]
    },
    {
      moduleId: "organization-management",
      parentModuleId: "character-configuration",
      label: "Organization Management",
      hydration: "optional",
      hydratable: true,
      functionItems: ["Inherited from Tag", "organization scope tag"]
    },
    {
      moduleId: "group-management",
      parentModuleId: "character-configuration",
      label: "Group Management",
      hydration: "optional",
      hydratable: true,
      functionItems: ["Inherited from Tag", "group scope tag"]
    },
    {
      moduleId: "character-management",
      parentModuleId: "character-configuration",
      label: "Character Management",
      hydration: "optional",
      hydratable: true,
      functionItems: ["Inherited from Tag", "character tag projection"]
    },
    {
      moduleId: "authentication-management",
      label: "认证管理",
      hydration: "essential",
      hydratable: false,
      functionItems: ["身份验证", "角色权限绑定", "认证切面装配"]
    },
    {
      moduleId: "credential-distribution",
      parentModuleId: "authentication-management",
      label: "Credential Distribution",
      hydration: "optional",
      hydratable: true,
      functionItems: ["client credential projection", "MCP credential projection", "secretRef only"]
    },
    {
      moduleId: "credential-to-meshrix-client",
      parentModuleId: "credential-distribution",
      label: "To Meshrix Client",
      hydration: "optional",
      hydratable: true,
      functionItems: ["client credential projection", "secretRef only"]
    },
    {
      moduleId: "credential-to-agent-mcp",
      parentModuleId: "credential-distribution",
      label: "To Agent MCP",
      hydration: "optional",
      hydratable: true,
      functionItems: ["MCP credential projection", "capability scoped"]
    },
    {
      moduleId: "authentication-aspect",
      parentModuleId: "authentication-management",
      label: "Authentication Aspect",
      hydration: "essential",
      hydratable: false,
      functionItems: ["identity proof", "session validation", "调用安全内核裁决"]
    },
    {
      moduleId: "identity-verification",
      parentModuleId: "authentication-aspect",
      label: "Identity Verification",
      hydration: "essential",
      hydratable: false,
      functionItems: ["identity proof", "session validation"]
    },
    {
      moduleId: "character-permission-binding",
      parentModuleId: "authentication-aspect",
      label: "Character & Permission",
      hydration: "essential",
      hydratable: false,
      functionItems: ["Credential & Capability", "调用安全内核裁决"]
    },
    {
      moduleId: "communication-service",
      label: "通信服务",
      hydration: "optional",
      hydratable: true,
      functionItems: ["MCP Server Side", "agent client invocation boundary", "package-provided protocol adapters"]
    },
    {
      moduleId: "mcp-server-side",
      parentModuleId: "communication-service",
      label: "MCP Server",
      hydration: "optional",
      hydratable: true,
      functionItems: ["tools/list and tools/call", "Operation Permission projection", "agent client invocation boundary"]
    },
    {
      moduleId: "workspace-governance",
      label: "协作治理",
      hydration: "optional",
      hydratable: true,
      functionItems: ["Issue 与 Proposal", "锁与继承", "共享授权", "保留策略与审计"]
    },
    {
      moduleId: "workspace-proposals",
      parentModuleId: "workspace-governance",
      label: "Issue & Proposal",
      hydration: "optional",
      hydratable: true,
      functionItems: ["create / review / apply decision", "不直接改写 canonical state"]
    },
    {
      moduleId: "workspace-lock-inheritance",
      parentModuleId: "workspace-governance",
      label: "Lock & Inheritance",
      hydration: "optional",
      hydratable: true,
      functionItems: ["workspace lock", "policy / profile / source inheritance"]
    },
    {
      moduleId: "workspace-policy-share",
      parentModuleId: "workspace-governance",
      label: "Policy & Share Grant",
      hydration: "optional",
      hydratable: true,
      functionItems: ["dataClass / clearance", "external collaborator / share grant"]
    },
    {
      moduleId: "workspace-retention-audit",
      parentModuleId: "workspace-governance",
      label: "Retention & Audit",
      hydration: "optional",
      hydratable: true,
      functionItems: ["retention / legalHold", "cross-project copy approval"]
    },
    {
      moduleId: "strategy-management",
      label: "策略管理",
      hydration: "optional",
      hydratable: true,
      functionItems: ["流程策略", "调用策略", "路由策略"]
    },
    {
      moduleId: "workflow-policy",
      parentModuleId: "strategy-management",
      label: "流程策略",
      hydration: "optional",
      hydratable: true,
      functionItems: ["处理流程选择", "人工确认门禁"]
    },
    {
      moduleId: "agent-policy",
      parentModuleId: "strategy-management",
      label: "调用策略",
      hydration: "optional",
      hydratable: true,
      functionItems: ["模型路由", "工具调用约束"]
    },
    {
      moduleId: "route-policy",
      parentModuleId: "strategy-management",
      label: "路由策略",
      hydration: "optional",
      hydratable: true,
      functionItems: ["平台能力切面路由", "下游客户端切面路由", "内部能力 / endpointRef"]
    },
    {
      moduleId: "agent-capabilities",
      label: "智能体",
      hydration: "optional",
      hydratable: true,
      functionItems: ["临时上下文", "长期记忆", "模型网关", "模型库与智能体配置"]
    },
    {
      moduleId: "agent-context",
      parentModuleId: "agent-capabilities",
      label: "上下文（临时）",
      hydration: "optional",
      hydratable: true,
      functionItems: ["临时上下文", "会话压缩"]
    },
    {
      moduleId: "agent-memory",
      parentModuleId: "agent-capabilities",
      label: "记忆（长期）",
      hydration: "optional",
      hydratable: true,
      functionItems: ["长期上下文", "contentRefs"]
    },
    {
      moduleId: "agent-gateway",
      parentModuleId: "agent-capabilities",
      label: "模型网关",
      hydration: "optional",
      hydratable: true,
      functionItems: ["alias / provider / model resolution", "degraded routing chain / rate limit", "budget / circuit breaker / ledger"]
    },
    {
      moduleId: "model-routing",
      parentModuleId: "agent-gateway",
      label: "Model Routing",
      hydration: "optional",
      hydratable: true,
      functionItems: ["degraded routing chain / rate limit", "budget / circuit breaker / ledger"]
    },
    {
      moduleId: "model-probe",
      parentModuleId: "agent-gateway",
      label: "Model Probe",
      hydration: "optional",
      hydratable: true,
      functionItems: ["connectivity probe", "latency / status / configured check"]
    },
    {
      moduleId: "agent-gateway-call",
      parentModuleId: "agent-gateway",
      label: "Provider Registry & Call",
      hydration: "optional",
      hydratable: true,
      functionItems: ["alias / provider / model resolution", "configured upstream forwarding"]
    },
    {
      moduleId: "agent-configs",
      parentModuleId: "agent-capabilities",
      label: "基础配置",
      hydration: "optional",
      hydratable: true,
      functionItems: ["manifest load / normalize / persist", "model library", "gateway defaults and profiles"]
    },
    {
      moduleId: "config-registry",
      parentModuleId: "agent-configs",
      label: "Config Registry",
      hydration: "optional",
      hydratable: true,
      functionItems: ["generation validate / atomic pointer commit", "redacted public projection"]
    },
    {
      moduleId: "model-list",
      parentModuleId: "agent-configs",
      label: "Model Library",
      hydration: "optional",
      hydratable: true,
      functionItems: ["provider / model / endpoint config", "encrypted credential references only"]
    },
    {
      moduleId: "agent-list",
      parentModuleId: "agent-configs",
      label: "Gateway Agents",
      hydration: "optional",
      hydratable: true,
      functionItems: ["agent alias / prompt / plugin list", "explicit module visibility"]
    },
    {
      moduleId: "agent-defaults",
      parentModuleId: "agent-configs",
      label: "Defaults & Profiles",
      hydration: "optional",
      hydratable: true,
      functionItems: ["timeout / parameters / system prompt", "context profile binding"]
    }
  ])
]);
