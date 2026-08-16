export const SYSTEM_ARCHITECTURE_MODULES = Object.freeze([
  Object.freeze({
    moduleId: "character-configuration",
    layerId: "platform-capabilities",
    moduleCategory: "core-capability",
    label: "角色配置",
    hydration: "essential",
    hydratable: false,
    functionItems: Object.freeze(["以 Tag 为基础语义", "组织、小组和角色继承自标签"]),
    childItems: Object.freeze([
      Object.freeze({ moduleId: "tag-management", label: "Tag Management", hydration: "essential", hydratable: false }),
      Object.freeze({ moduleId: "organization-management", label: "Organization Management", hydration: "optional", hydratable: true }),
      Object.freeze({ moduleId: "group-management", label: "Group Management", hydration: "optional", hydratable: true }),
      Object.freeze({ moduleId: "character-management", label: "Character Management", hydration: "optional", hydratable: true })
    ])
  }),
  Object.freeze({
    moduleId: "authentication-management",
    layerId: "platform-capabilities",
    moduleCategory: "core-capability",
    label: "认证管理",
    hydration: "essential",
    hydratable: false,
    functionItems: Object.freeze(["身份验证", "角色权限绑定", "认证切面装配"]),
    childItems: Object.freeze([
      Object.freeze({ moduleId: "credential-distribution", label: "Credential Distribution", hydration: "optional", hydratable: true }),
      Object.freeze({ moduleId: "authentication-aspect", label: "Authentication Aspect", hydration: "essential", hydratable: false }),
      Object.freeze({ moduleId: "identity-verification", label: "Identity Verification", hydration: "essential", hydratable: false }),
      Object.freeze({ moduleId: "character-permission-binding", label: "Character & Permission", hydration: "essential", hydratable: false })
    ])
  }),
  Object.freeze({
    moduleId: "communication-service",
    layerId: "platform-capabilities",
    moduleCategory: "core-capability",
    label: "通信服务",
    hydration: "optional",
    hydratable: true,
    functionItems: Object.freeze(["MCP Server Side", "agent client invocation boundary", "package-provided protocol adapters"]),
    childItems: Object.freeze([
      Object.freeze({ moduleId: "mcp-server-side", label: "MCP Server", hydration: "optional", hydratable: true })
    ])
  }),
  Object.freeze({
    moduleId: "workspace-governance",
    layerId: "platform-capabilities",
    moduleCategory: "core-capability",
    label: "协作治理",
    hydration: "optional",
    hydratable: true,
    functionItems: Object.freeze(["Issue 与 Proposal", "锁与继承", "共享授权", "保留策略与审计"])
  }),
  Object.freeze({
    moduleId: "strategy-management",
    layerId: "platform-capabilities",
    moduleCategory: "core-capability",
    label: "策略管理",
    hydration: "optional",
    hydratable: true,
    functionItems: Object.freeze(["流程策略", "调用策略", "路由策略"])
  }),
  Object.freeze({
    moduleId: "agent-capabilities",
    layerId: "platform-capabilities",
    moduleCategory: "core-capability",
    label: "智能体",
    hydration: "optional",
    hydratable: true,
    functionItems: Object.freeze(["临时上下文", "长期记忆", "模型网关", "模型库与智能体配置"])
  }),
  Object.freeze({
    moduleId: "gateway-governance",
    layerId: "application",
    moduleCategory: "application",
    label: "网关治理",
    hydration: "optional",
    hydratable: true,
    functionItems: Object.freeze(["上游 API 注册", "转发策略", "流控与审批"])
  }),
  Object.freeze({
    moduleId: "agent-workspace",
    layerId: "application",
    moduleCategory: "application",
    label: "Agent Workspace",
    hydration: "essential",
    hydratable: false,
    functionItems: Object.freeze(["受控工作空间文件", "StateCommit"])
  }),
  Object.freeze({
    moduleId: "tools-skills",
    layerId: "application",
    moduleCategory: "application",
    label: "通用工具与技能",
    hydration: "optional",
    hydratable: true,
    functionItems: Object.freeze(["工具管理", "技能管理", "toolset / grant", "策略与审计"])
  }),
  Object.freeze({
    moduleId: "upstream-service-aspect",
    layerId: "aspect",
    moduleCategory: "aspect",
    label: "平台能力切面",
    hydration: "optional",
    hydratable: true,
    functionItems: Object.freeze(["服务发现", "接口契约", "端点与密钥投影"])
  }),
  Object.freeze({
    moduleId: "downstream-client-aspect",
    layerId: "aspect",
    moduleCategory: "aspect",
    label: "下游客户端切面",
    hydration: "optional",
    hydratable: true,
    functionItems: Object.freeze(["客户端交互", "MCP Adapter Layer", "路由与能力投影"])
  }),
  Object.freeze({
    moduleId: "platform-application-service-aspect",
    layerId: "aspect",
    moduleCategory: "aspect",
    label: "平台应用服务切面",
    hydration: "optional",
    hydratable: true,
    functionItems: Object.freeze(["入口与请求合同", "Operation Surface", "协议映射", "投影合同"])
  }),
  Object.freeze({
    moduleId: "security",
    layerId: "foundation",
    moduleCategory: "foundation",
    label: "安全权限",
    hydration: "essential",
    hydratable: false,
    functionItems: Object.freeze(["身份与主体解析", "授权内核", "Capability Secret 映射内核", "访问控制策略", "审计与脱敏"])
  }),
  Object.freeze({
    moduleId: "module-management",
    layerId: "foundation",
    moduleCategory: "foundation",
    label: "模块管理",
    hydration: "essential",
    hydratable: false,
    functionItems: Object.freeze(["模块发现", "Mount 合同", "能力声明", "生命周期管理", "隔离与兼容"]),
    optionalFunctionItems: Object.freeze(["合同测试"])
  }),
  Object.freeze({
    moduleId: "composition-management",
    layerId: "foundation",
    moduleCategory: "foundation",
    label: "装配能力",
    hydration: "essential",
    hydratable: false,
    functionItems: Object.freeze(["独立部署依赖打包", "动态模块挂载", "启动装配撮合"])
  }),
  Object.freeze({
    moduleId: "data-structure-substrate",
    layerId: "foundation",
    moduleCategory: "foundation",
    label: "算法与数据结构底座",
    hydration: "essential",
    hydratable: false,
    functionItems: Object.freeze(["Checkpoint Tree Projection", "Graph / DAG Substrate", "Serialization Projection"]),
    optionalFunctionItems: Object.freeze(["Merkle Index Substrate", "Prefix / Range Index Substrate", "Diff / Merge Substrate"])
  }),
  Object.freeze({
    moduleId: "operation-proof-substrate",
    layerId: "foundation",
    moduleCategory: "foundation",
    label: "操作证明底座",
    hydration: "essential",
    hydratable: false,
    functionItems: Object.freeze(["Pactium lifecycle adapter", "Receipt verify/export", "Open-operation recovery", "Workspace proof projection"])
  }),
  Object.freeze({
    moduleId: "environment-compatibility",
    layerId: "foundation",
    moduleCategory: "foundation",
    label: "环境兼容性",
    hydration: "essential",
    hydratable: false,
    functionItems: Object.freeze(["环境画像", "操作系统适配", "路径与权限兼容"]),
    optionalFunctionItems: Object.freeze(["运行时桥接", "兼容垫片"])
  }),
  Object.freeze({
    moduleId: "resource-management",
    layerId: "foundation",
    moduleCategory: "foundation",
    label: "资源管理",
    hydration: "essential",
    hydratable: false,
    functionItems: Object.freeze([
      "文件系统",
      "内存管理",
      "进程管理",
      "数据库",
      "消息队列",
      "缓存管理",
      "运行时管理",
      "存储 Provider",
      "执行与状态原语"
    ]),
    optionalFunctionItems: Object.freeze(["Shell 管理", "终端管理"])
  }),
  Object.freeze({
    moduleId: "devops",
    layerId: "foundation",
    moduleCategory: "foundation",
    label: "运维基础",
    hydration: "essential",
    hydratable: false,
    functionItems: Object.freeze(["日志", "健康状态", "快照", "备份", "恢复编排"]),
    optionalFunctionItems: Object.freeze(["监控告警", "诊断", "运维任务"])
  })
]);
