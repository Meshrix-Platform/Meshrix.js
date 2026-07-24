import { defineArchitectureNodeFacts } from "./manifest-node-facts-support.mjs";

export const RUNTIME_ARCHITECTURE_NODE_FACTS = Object.freeze([
  ...defineArchitectureNodeFacts("application", "application", [
    {
      moduleId: "gateway-governance",
      label: "网关治理",
      hydration: "optional",
      hydratable: true,
      functionItems: ["upstream API registry", "policy preview", "approval and audit"]
    },
    {
      moduleId: "agent-workspace",
      label: "Agent Workspace",
      featureId: "agent-workspace-core",
      hydration: "essential",
      hydratable: false,
      functionItems: ["受控工作空间文件", "StateCommit"]
    },
    {
      moduleId: "tools-skills",
      label: "通用工具与技能",
      hydration: "optional",
      hydratable: true,
      functionItems: ["工具管理", "技能管理", "toolset / grant", "策略与审计"]
    },
    {
      moduleId: "capabilities/operation-permission-core",
      parentModuleId: "tools-skills",
      label: "工具管理",
      hydration: "optional",
      hydratable: true,
      functionItems: ["toolset / grant", "策略与审计"]
    },
    {
      moduleId: "capabilities/skills",
      parentModuleId: "tools-skills",
      label: "技能管理",
      hydration: "optional",
      hydratable: true,
      functionItems: ["Tool/Skill provider", "skill registry / profile"]
    }
  ]),
  ...defineArchitectureNodeFacts("aspect", "aspect", [
    {
      moduleId: "upstream-service-aspect",
      label: "平台能力切面",
      hydration: "optional",
      hydratable: true,
      functionItems: ["服务发现", "接口契约", "端点与密钥投影"]
    },
    {
      moduleId: "upstream-service-discovery",
      parentModuleId: "upstream-service-aspect",
      label: "服务发现",
      hydration: "optional",
      hydratable: true,
      functionItems: ["外部服务注册表", "服务快照投影"]
    },
    {
      moduleId: "upstream-provider-contract",
      parentModuleId: "upstream-service-aspect",
      label: "接口契约",
      hydration: "optional",
      hydratable: true,
      functionItems: ["provider contract", "协议能力描述"]
    },
    {
      moduleId: "upstream-endpoint-secretref",
      parentModuleId: "upstream-service-aspect",
      label: "端点与密钥投影",
      hydration: "optional",
      hydratable: true,
      functionItems: ["配置引用", "secretRef only"]
    },
    {
      moduleId: "downstream-client-aspect",
      label: "下游客户端切面",
      hydration: "optional",
      hydratable: true,
      functionItems: ["客户端交互", "MCP Adapter Layer", "路由与能力投影"]
    },
    {
      moduleId: "client-interaction-surface",
      parentModuleId: "downstream-client-aspect",
      label: "客户端交互",
      hydration: "optional",
      hydratable: true,
      functionItems: ["MCP request intake", "客户端能力投影"]
    },
    {
      moduleId: "mcp-adapter-layer",
      parentModuleId: "downstream-client-aspect",
      label: "MCP Adapter Layer",
      hydration: "optional",
      hydratable: true,
      functionItems: ["framework MCP catalog", "route: mcp-server-side"]
    },
    {
      moduleId: "downstream-route-intent",
      parentModuleId: "downstream-client-aspect",
      label: "路由与能力投影",
      hydration: "optional",
      hydratable: true,
      functionItems: ["协议请求翻译", "能力目录 / secretRef 投影"]
    },
    {
      moduleId: "platform-application-service-aspect",
      label: "平台应用服务切面",
      hydration: "optional",
      hydratable: true,
      functionItems: ["入口与请求合同", "Operation Surface", "协议映射", "投影合同"]
    },
    {
      moduleId: "application-entry-contract",
      parentModuleId: "platform-application-service-aspect",
      label: "入口与请求合同",
      hydration: "optional",
      hydratable: true,
      functionItems: ["服务入口收口", "请求归一化"]
    },
    {
      moduleId: "operation-surface",
      parentModuleId: "platform-application-service-aspect",
      label: "Operation Surface",
      hydration: "optional",
      hydratable: true,
      functionItems: ["operation manifest", "Operation Registry"]
    },
    {
      moduleId: "protocol-interface-binding",
      parentModuleId: "platform-application-service-aspect",
      label: "协议映射",
      hydration: "optional",
      hydratable: true,
      functionItems: ["interface catalog", "HTTP / RPC / CLI 映射"]
    },
    {
      moduleId: "platform-projection-contracts",
      parentModuleId: "platform-application-service-aspect",
      label: "投影合同",
      hydration: "optional",
      hydratable: true,
      functionItems: ["character tag projection", "auth aspect / secret distribution"]
    }
  ]),
  ...defineArchitectureNodeFacts("foundation", "foundation", [
    {
      moduleId: "security",
      label: "安全权限",
      hydration: "essential",
      hydratable: false,
      functionItems: ["身份与主体解析", "授权内核", "Capability Secret 映射内核", "访问控制策略", "审计与脱敏"]
    },
    {
      moduleId: "identity-subject",
      parentModuleId: "security",
      label: "身份与主体解析",
      hydration: "essential",
      hydratable: false,
      functionItems: ["subject resolution", "session / token 验证"]
    },
    {
      moduleId: "authorization-kernel",
      parentModuleId: "security",
      label: "授权内核",
      hydration: "essential",
      hydratable: false,
      functionItems: ["capability decision", "tenant / resource policy"]
    },
    {
      moduleId: "capability-secret-binding",
      parentModuleId: "security",
      label: "Capability Secret 映射内核",
      hydration: "essential",
      hydratable: false,
      functionItems: ["capability 到 secretRef 绑定", "grant materialization", "不负责密钥分发"]
    },
    {
      moduleId: "access-policy",
      parentModuleId: "security",
      label: "访问控制策略",
      hydration: "essential",
      hydratable: false,
      functionItems: ["risk boundary", "workspace asset policy"]
    },
    {
      moduleId: "audit-redaction",
      parentModuleId: "security",
      label: "审计与脱敏",
      hydration: "essential",
      hydratable: false,
      functionItems: ["denied audit", "trace / export redaction"]
    },
    {
      moduleId: "module-management",
      label: "模块管理",
      hydration: "essential",
      hydratable: false,
      functionItems: ["模块发现", "Mount 合同", "能力声明", "生命周期管理", "隔离与兼容"]
    },
    {
      moduleId: "module-discovery",
      parentModuleId: "module-management",
      label: "模块发现",
      hydration: "essential",
      hydratable: false,
      functionItems: ["module descriptor", "mount manifest 扫描"]
    },
    {
      moduleId: "mount-contract",
      parentModuleId: "module-management",
      label: "Mount 合同",
      hydration: "essential",
      hydratable: false,
      functionItems: ["provider interface", "runtime capability shape"]
    },
    {
      moduleId: "capability-manifest",
      parentModuleId: "module-management",
      label: "能力声明",
      hydration: "essential",
      hydratable: false,
      functionItems: ["capability metadata", "version / risk profile"]
    },
    {
      moduleId: "module-lifecycle",
      parentModuleId: "module-management",
      label: "生命周期管理",
      hydration: "essential",
      hydratable: false,
      functionItems: ["load / unload", "reload / close hooks"]
    },
    {
      moduleId: "module-isolation",
      parentModuleId: "module-management",
      label: "隔离与兼容",
      hydration: "essential",
      hydratable: false,
      functionItems: ["adapter boundary", "compat profile"]
    },
    {
      moduleId: "contract-test",
      parentModuleId: "module-management",
      label: "合同测试",
      hydration: "optional",
      hydratable: true,
      functionItems: ["shape validation", "sample execution"]
    },
    {
      moduleId: "composition-management",
      label: "装配能力",
      hydration: "essential",
      hydratable: false,
      functionItems: ["独立部署依赖打包", "动态模块挂载", "启动装配撮合"]
    },
    {
      moduleId: "deployment-dependency-package",
      parentModuleId: "composition-management",
      label: "独立部署依赖打包",
      hydration: "essential",
      hydratable: false,
      functionItems: ["dependency contract", "platform core + app bundle", "bootstrap package manifest", "core preset"]
    },
    {
      moduleId: "dynamic-module-mount",
      parentModuleId: "composition-management",
      label: "动态模块挂载",
      hydration: "essential",
      hydratable: false,
      functionItems: ["hot load / hot switch", "hot unload / dependency detach", "provider rebinding"]
    },
    {
      moduleId: "startup-composition",
      parentModuleId: "composition-management",
      label: "启动装配撮合",
      hydration: "essential",
      hydratable: false,
      functionItems: ["composition graph", "provider / feature binding", "fallback resolution / health gate"]
    },
    {
      moduleId: "data-structure-substrate",
      label: "算法与数据结构底座",
      hydration: "essential",
      hydratable: false,
      functionItems: ["Checkpoint Tree Projection", "Graph / DAG Substrate", "Serialization Projection"]
    },
    {
      moduleId: "checkpoint-tree-projection",
      parentModuleId: "data-structure-substrate",
      label: "Checkpoint Tree Projection",
      hydration: "essential",
      hydratable: false,
      functionItems: ["版本节点", "restore reference"]
    },
    {
      moduleId: "merkle-index-substrate",
      parentModuleId: "data-structure-substrate",
      label: "Merkle Index Substrate",
      hydration: "optional",
      hydratable: true,
      functionItems: ["content hash", "integrity proof"]
    },
    {
      moduleId: "range-index-substrate",
      parentModuleId: "data-structure-substrate",
      label: "Prefix / Range Index Substrate",
      hydration: "optional",
      hydratable: true,
      functionItems: ["ordered lookup", "range scan primitive"]
    },
    {
      moduleId: "graph-dag-substrate",
      parentModuleId: "data-structure-substrate",
      label: "Graph / DAG Substrate",
      hydration: "essential",
      hydratable: false,
      functionItems: ["dependency graph", "topology traversal"]
    },
    {
      moduleId: "diff-merge-substrate",
      parentModuleId: "data-structure-substrate",
      label: "Diff / Merge Substrate",
      hydration: "optional",
      hydratable: true,
      functionItems: ["change comparison", "conflict primitive"]
    },
    {
      moduleId: "serialization-projection",
      parentModuleId: "data-structure-substrate",
      label: "Serialization Projection",
      hydration: "essential",
      hydratable: false,
      functionItems: ["stable schema", "read model projection"]
    },
    {
      moduleId: "operation-proof-substrate",
      label: "操作证明底座",
      hydration: "essential",
      hydratable: false,
      functionItems: ["Pactium lifecycle adapter", "Receipt verify/export", "Open-operation recovery", "Workspace proof projection"]
    },
    {
      moduleId: "proof-lifecycle-authoring",
      parentModuleId: "operation-proof-substrate",
      label: "Proof Lifecycle Authoring",
      hydration: "essential",
      hydratable: false,
      functionItems: ["begin / finish / denied outcome", "dispatcher-owned lifecycle"]
    },
    {
      moduleId: "receipt-verification-export",
      parentModuleId: "operation-proof-substrate",
      label: "Receipt Verify & Export",
      hydration: "essential",
      hydratable: false,
      functionItems: ["verifyReceipt / verifyBundle", "authorized Proof Bundle Export"]
    },
    {
      moduleId: "proof-recovery-projection",
      parentModuleId: "operation-proof-substrate",
      label: "Recovery & Workspace Projection",
      hydration: "essential",
      hydratable: false,
      functionItems: ["open-operation recovery plan", "workspace membership proof"]
    },
    {
      moduleId: "environment-compatibility",
      label: "环境兼容性",
      hydration: "essential",
      hydratable: false,
      functionItems: ["环境画像", "操作系统适配", "路径与权限兼容"]
    },
    {
      moduleId: "environment-profile",
      parentModuleId: "environment-compatibility",
      label: "环境画像",
      hydration: "essential",
      hydratable: false,
      functionItems: ["host facts", "runtime capability baseline"]
    },
    {
      moduleId: "os-adapter",
      parentModuleId: "environment-compatibility",
      label: "操作系统适配",
      hydration: "essential",
      hydratable: false,
      functionItems: ["OS capability probe", "system API bridge"]
    },
    {
      moduleId: "path-permission-adapter",
      parentModuleId: "environment-compatibility",
      label: "路径与权限兼容",
      hydration: "essential",
      hydratable: false,
      functionItems: ["path convention", "permission model mapping"]
    },
    {
      moduleId: "runtime-bridge",
      parentModuleId: "environment-compatibility",
      label: "运行时桥接",
      hydration: "optional",
      hydratable: true,
      functionItems: ["language runtime bridge", "native boundary adapter"]
    },
    {
      moduleId: "resource-management",
      label: "资源管理",
      hydration: "essential",
      hydratable: false,
      functionItems: ["文件系统", "内存管理", "进程管理", "数据库", "消息队列", "缓存管理", "运行时管理", "存储 Provider", "执行与状态原语"]
    },
    {
      moduleId: "filesystem-management",
      parentModuleId: "resource-management",
      label: "文件系统",
      hydration: "essential",
      hydratable: false,
      functionItems: ["数据目录 / 路径治理", "原子写入 / watcher 可卸载"]
    },
    {
      moduleId: "memory-management",
      parentModuleId: "resource-management",
      label: "内存管理",
      hydration: "essential",
      hydratable: false,
      functionItems: ["预算 / 背压 / OOM 防护", "profiler 可卸载"]
    },
    {
      moduleId: "process-management",
      parentModuleId: "resource-management",
      label: "进程管理",
      hydration: "essential",
      hydratable: false,
      functionItems: ["生命周期 / 退出清理", "worker pool 可卸载"]
    },
    {
      moduleId: "shell-management",
      parentModuleId: "resource-management",
      label: "Shell 管理",
      hydration: "optional",
      hydratable: true,
      functionItems: ["受控执行合同", "shell provider 可卸载"]
    },
    {
      moduleId: "terminal-management",
      parentModuleId: "resource-management",
      label: "终端管理",
      hydration: "optional",
      hydratable: true,
      functionItems: ["terminal session 合同", "PTY / UI 可卸载"]
    },
    {
      moduleId: "database-management",
      parentModuleId: "resource-management",
      label: "数据库",
      hydration: "essential",
      hydratable: false,
      functionItems: ["最小 metadata / audit store", "SQLite / Postgres 可替换"]
    },
    {
      moduleId: "message-queue-management",
      parentModuleId: "resource-management",
      label: "消息队列",
      hydration: "essential",
      hydratable: false,
      functionItems: ["最小后台队列 / 回执", "外部 broker 可卸载"]
    },
    {
      moduleId: "cache-management",
      parentModuleId: "resource-management",
      label: "缓存管理",
      hydration: "essential",
      hydratable: false,
      functionItems: ["TTL / 热点缓存", "Redis 可卸载"]
    },
    {
      moduleId: "runtime-management",
      parentModuleId: "resource-management",
      label: "运行时管理",
      hydration: "essential",
      hydratable: false,
      functionItems: ["profile / feature binding", "runtime provider 可解绑"]
    },
    {
      moduleId: "storage-provider",
      parentModuleId: "resource-management",
      label: "存储 Provider",
      hydration: "essential",
      hydratable: false,
      functionItems: ["metadata repository", "object store / storage doctor"]
    },
    {
      moduleId: "execution-state-primitives",
      parentModuleId: "resource-management",
      label: "执行与状态原语",
      hydration: "essential",
      hydratable: false,
      functionItems: ["并发锁 / 执行排队", "状态锁 / 收敛原语"]
    },
    {
      moduleId: "devops",
      label: "运维基础",
      hydration: "essential",
      hydratable: false,
      functionItems: ["日志", "健康状态", "快照", "备份", "恢复编排"]
    },
    {
      moduleId: "logging",
      parentModuleId: "devops",
      label: "日志",
      hydration: "essential",
      hydratable: false,
      functionItems: ["runtime log", "structured event"]
    },
    {
      moduleId: "health-status",
      parentModuleId: "devops",
      label: "健康状态",
      hydration: "essential",
      hydratable: false,
      functionItems: ["health probe", "readiness summary"]
    },
    {
      moduleId: "monitoring-alerting",
      parentModuleId: "devops",
      label: "监控告警",
      hydration: "optional",
      hydratable: true,
      functionItems: ["metrics / alert rule", "queue monitor"]
    },
    {
      moduleId: "snapshot",
      parentModuleId: "devops",
      label: "快照",
      hydration: "essential",
      hydratable: false,
      functionItems: ["snapshot contract", "snapshot inventory"]
    },
    {
      moduleId: "backup",
      parentModuleId: "devops",
      label: "备份",
      hydration: "essential",
      hydratable: false,
      functionItems: ["backup plan", "retention policy"]
    },
    {
      moduleId: "restore-orchestration",
      parentModuleId: "devops",
      label: "恢复编排",
      hydration: "essential",
      hydratable: false,
      functionItems: ["restore plan", "drill / verification"]
    },
    {
      moduleId: "diagnostics",
      parentModuleId: "devops",
      label: "诊断",
      hydration: "optional",
      hydratable: true,
      functionItems: ["runtime doctor", "repair report"]
    },
    {
      moduleId: "maintenance-runner",
      parentModuleId: "devops",
      label: "运维任务",
      hydration: "optional",
      hydratable: true,
      functionItems: ["scheduled job", "runbook execution"]
    }
  ])
]);
