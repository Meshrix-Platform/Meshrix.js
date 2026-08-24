---
name: meshrix-js-repository
description: Apply the Meshrix.js main product repository rules for server, console, protocol gateway, Operation Permission, security, storage, and acceptance work. Use for any change inside the repository, including its console, server, agents, capabilities, and protocol adapter subsystems.
---

# Meshrix.js Repository

Apply these rules to every task inside the Meshrix.js product repository.

## Repository Scope

- Own the server, console, protocol gateway, Operation Permission, security, storage, and canonical acceptance reducer.
- Treat client wire and lifecycle behavior as external to this repository.
- Treat every server-to-client boundary as a versioned protocol boundary. The
  Meshrix.js server implementation, internal dependencies, plans, tests, gates,
  and acceptance receipts must not import, discover, execute, or wait for any
  client repository, implementation, build, plan, test, report, or receipt.
  Verify server behavior with protocol-owned schemas, frozen wire corpora, and
  neutral mock peers; client adoption, UI, cache behavior, platform lifecycle,
  packaging, and product evidence are independently owned compatibility facts
  that cannot block or promote a server receipt.
- Keep optional parser, provider, and datastore implementations outside the
  main product repository.
- Use `npm test` before selecting validation tasks.

## Document Maintenance Gate

- Read `docs/README.md` and `docs/RUNBOOK.md` before changing documentation,
  repository asset layout, ignore rules, or release manifests.
- Read `docs/README.md` and `docs/RUNBOOK.md` before editing Meshrix.js technical
  documentation.
- Search existing docs first with `rg`; update the document that already owns the runtime feature, command, protocol, or configuration field.
- Keep docs tied to executable commands, configuration fields, protocol surfaces, or runtime behavior.
- Durable technical decisions must be recorded in the canonical public architecture, protocol, functionality, registry, or verifier source that owns the affected behavior.
- Before treating documentation work as ready, run `npm test` or record objective blocker evidence.

## Repo Local-Info Hygiene / Skill Local-Info Hygiene

- Before treating a change as commit-ready, run `npm run repo:local-info-hygiene`; it scans source, docs, fixtures, tests, and tools for real developer/server details and writes `build/reports/local-info-hygiene.json`.
- Clean real user names, workstation paths, private hosts, public endpoints, SSH/admin metadata, non-placeholder email domains, and provider IDs to placeholders such as `<repo-root>`, `<user-home>`, `<server-url>`, `<service-url>`, `<public-api-host>`, `<admin-host>`, `<input-file>`, and `<output-file>`.
- Authoritative Meshrix.js skills live only under `skills/`. Do not create
  copied or compatibility skill entry points. Skill examples use the same
  placeholders in prose, prompts, and bundled references.

## 智能体入口与上下文范围

- 根 `README.md` 和 `README.zh-CN.md` 是产品技术总览，默认不作为工程事实源；只有产品定位、公开说明或用户明确要求时才读取或修改。
- 工程任务优先从本技能、目标子系统对应小节、`docs/README.md` 或局部说明建立上下文。
- 代码修改先按任务路由缩小到一个子系统，再在候选目录内搜索；文档修改先看 `docs/README.md` 的索引和维护规则，再打开目标文档。
- `build/` 和 `node_modules/` 默认视为生成物或依赖缓存；只有任务明确指向或验证输出指向时再进入。
- 扩大到全仓库搜索前，先说明当前入口无法回答的问题，并尽量限定文件类型或目录前缀，减少无关上下文进入会话。
- 开始修改前先运行 `git status --short`，区分当前任务改动和用户已有改动；无关改动保持原样。
- 搜索优先使用 `rg` 或 `rg --files`，避免把整段生成物、大型历史报告或依赖目录读入上下文。

## 任务路由

- 前端控制台任务从 `apps/console/` 开始，只打开相关的 `apps/console/components/`、`apps/console/views/`、`apps/console/lib/` 和样式文件。
- 服务端或运行时任务从 `packages/server-runtime/` 或 `apps/server/` 开始；domain 代码在 `packages/<domain>/` 下；只有涉及启动、挂载、运行行为或运维语义时再查阅 `docs/architecture/ARCHITECTURE.md`、`docs/functionality/SERVER-RUNTIME.md` 与 `docs/RUNBOOK.md`。
- 安全、授权、风险控制或本地 stdio 边界任务从 `packages/foundation/src/security/` 开始，再查阅 `docs/functionality/SECURITY-AUTHORIZATION.md`；授权实现使用 `$meshrix-js-security-authorization`，新增外部或不可信输入面、漏洞修复和可突破性审查使用 `$meshrix-js-security-boundary-audit`。
- MCP 用户设备安装任务从 `packages/protocols/mcp/adapter/native-installer/` 开始；MCP stdio proxy 或 process identity runtime 任务从 `packages/protocols/mcp/adapter/gateway-installer/` 开始。客户端实现细节不进入本仓库技能；Meshrix.js 安装契约仍是签名发现与连接器配置变更的权威。
- 架构、策略或治理类任务先看 `tools/registry/`，再打开与主题对应的核心文档。
- 开发者手册是 `$meshrix-js-developer-handbook`。用户手册是 `$meshrix-js-user-handbook`。不要把两份手册混在一次收口里。
- 发布制品形状和对外地址规范使用 `$meshrix-js-release-artifact-contract`。运行中的实例使用和外部对接使用 `$meshrix-js-instance-usage`。
- 测试任务先从失败测试或 verifier 本身开始；只有测试契约不清楚时再查阅 `docs/RUNBOOK.md`。
- Operation Permission 或网关操作任务从 `docs/functionality/GATEWAY.md` 和 `docs/functionality/OPERATION-PERMISSION.md` 开始；分别使用共享的 `$meshrix-js-operation-permission` 或 `$meshrix-js-protocol-gateway` 技能。
- 子系统规则见本技能的 Console、Server、Agents Domain、Capabilities Domain、Protocol Adapters 和 MCP Gateway Connector Runtime 小节；公开文档入口是 `docs/README.md`。

## 任务启动流程

- 开始工作时建议说明当前 worktree、目标子系统和计划写入范围；先应用本技能的仓库级规则，再查看目标子系统对应小节，没有对应小节时再读取最近的 README。
- 本仓库的跨计划执行选择只使用 `npm run plan:next`。主智能体应先按用户意图校正相关计划；该命令只授权执行叶子，不限制主智能体修复计划或计划工具。`planning_repair_required` 禁止派遣执行者，但不终止用户任务，控制权应返回主智能体。通用 Better Plan `next` 只理解单个 `Checkpoints.json` 的本地依赖，不能作为执行授权；不得启动缺少子计划最终回执、与当前主机平台不匹配或不属于 Meshrix.js `.git` 目标的节点。原生 Windows 主机资格节点仍须在对应主机上执行。离线交付和当前计划闭环只要虚拟机内是 Linux 即可完成：优先 Ubuntu，Debian 也可；macOS 操作主机在能到达该 Linux 虚拟机时可以闭环。原生 Linux、Ubuntu、Debian 和环境资格仍是之后必须完成的剩余工作。项目级功能验收仍是 `npm run verify:acceptance`。
- 如果任务需要跨子系统修改，建议切换到集成 worktree 或明确唯一负责人，再开始编辑。
- 涉及入口文件或文档索引调整时，运行 `npm test` 或对应的入口健康检查。

## 本地服务启动与实例复用

本地服务启动、实例复用、数据目录解析和对外源契约由 `$meshrix-js-instance-configuration` 与 `$meshrix-js-instance-usage` 承接。此处只保留仓库级约定：默认数据目录已有运行数据时复用该目录；默认端口被无关进程占用时停止并报告冲突，不要静默改用其它端口或另建数据目录；认证和运维命令必须使用与运行中服务完全相同的数据目录。

## 功能迁移自查与长期门禁

功能迁移自查、迁移完成收口和长期门禁由 `$meshrix-js-migration-completion` 承接。此处只保留仓库级约定：功能改动按“功能优化 -> 全面迁移到新功能 -> 旧兼容移除”的顺序收口，不要只新增新入口后继续把普通调用链接到旧实现；功能、模块、文档、ADR 和计划命名不使用版本号或 `v2`/`version` 这类边界词。

## 可提交功能门禁

- 每完成一个新功能或功能改造后，立刻运行覆盖该功能及上下游适配的最小验证；验证通过后，该功能才可视为一个可独立提交、可回滚的完整单元。
- 上下游包括入口、调用方、API/CLI/UI、配置、注册表、数据迁移、文档、测试、fixtures、生成物和相关外部/平台适配；只验证功能自身而未验证上下游适配，不视为可提交。
- 提交前运行覆盖本次改动的最小验证和 `npm test`；非交互环境必须在回复或 PR 说明中列出已运行命令、客观阻断或后续验证命令。
- 无法验证时，必须在当前回复、PR 说明或 issue 中留下客观原因、所需环境/平台/凭据/协作者和后续验证命令；没有客观阻断说明时继续修到上下游通过。

## 用户配置真实性

- 用户配置不允许由代码指定缺省默认值。没有配置的情况下必须保持为空。
- 所有页面、接口、命令行和运行时模块必须反映用户的真实配置，不能用供应商模板、候选项、历史兼容值或推断值伪装成用户已配置内容。
- 候选模板只能用于“新增配置时可选择的类型”，不能进入功能绑定、模型下拉、运行时注册表或任何表示已配置状态的数据结构。
- 保存、加载、规范化、红acted 输出、迁移和兼容逻辑都必须遵守同一原则：空配置仍然是空配置，不允许自动补默认模型、默认供应商、默认智能体或默认绑定。

## 通用组件优先

- 页面上已经存在通用组件时，必须优先使用通用组件，不允许在局部页面重新实现一套样式、交互或状态管理。
- 新增可复用 UI 组件时，每个组件必须使用独立文件实现，并在 `apps/console/components/common.ts` 统一注册和导出；未登记在该入口的组件不能视为通用组件。
- 通用组件只能统一外观、交互和基础事件协议，不能接管功能数据源、自动补默认值或覆盖用户配置；选项、模型、路径、历史记录等数据仍由各自页面显式绑定。

## 代码文件组织

- 代码文件拆分遵循 `docs/architecture/ARCHITECTURE.md` 的 `Source File Organization`；行数不作为门禁或单独拆分理由。
- 默认在当前 feature root 内完成最小规模的职责提取；只有形成独立所有权、公共契约、生命周期、构建配置或依赖边界时才新增 feature root 或 package。
- 拆分必须降低耦合并保持依赖方向、状态所有权、公共 API、测试和性能边界；不得产生数字分片、阶段命名、透传碎片、循环依赖或旧兼容残留。
- 当拆分、包提取、所有权移动或协议解耦需要重新贯通组合根、注册表、调用方和验收表面时，使用 `$meshrix-js-architecture-reassembly`，不要在 Meshrix.js 仓库复制维护流程或辅助脚本。

## 智能体配置分层

- 智能体通用配置只负责远程模型连通性和基础身份；模块/功能参数必须放在 `moduleAgentProfiles` 这种专属夹层中。
- 功能选择智能体时必须尊重智能体的 `moduleAccess` 可见性；没有被授权给该功能的智能体不能出现在下拉选项里。
- 运行时调用智能体的加载顺序固定为：通用连接配置 -> 模块/功能专属参数 -> 会话/任务上下文。不能把会话记忆或功能依赖写回通用模型配置。

## 文档与使用说明风格

- 本项目文档必须保持严肃、冷静、务实、准确。
- 公开文档、规范文档、产品说明、功能说明、协议说明、运行说明和新增 Markdown 文档默认必须使用英文；只有文件名或目录明确标注为本地化版本（例如 `*.zh-CN.md`）或用户明确要求本地化内容时，才使用对应语言。
- 文档只记录技术事实、运行方式、配置字段、协议边界、验证命令、决策结果和剩余必做工作。当前做不到的能力写成之后必须完成的缺口，而不是永久不做。
- 不记录未验证的背景说明、来源解释、内部讨论过程、夸张表述或未落实承诺。
- 开源平台文档以企业私有化部署为前提，默认能力必须自包含；外部中间件只能写成可选增强或集成目标，不能写成基础运行依赖，除非代码和部署清单已经强制依赖。
- 能力缺口必须以可验证事实描述，并指向计划、代码路径或验证命令；不能用愿景描述替代实现状态，也不能把缺口写成项目明确拒绝。

## Remaining required work

A current gap is remaining required work. Record what is true today and keep
closing it. Do not freeze “we do not do this” or “we cannot do this” as a
durable Meshrix.js refusal. Fail-closed security invariants stay required until
a stronger replacement lands.

## Linux VM closure

Linux VM 内闭环交付、环境资格和真机验证由 `$meshrix-js-real-machine-verification` 承接。项目级功能验收仍是 `npm run verify:acceptance`，由 `$meshrix-js-platform-acceptance-workflow` 承接。

## 验证范围

- 迁移或重构行为改动在测试前先完成“功能迁移自查与长期门禁”要求；普通功能行为改动直接执行覆盖当前契约的最小上下游验证。
- 每个可提交功能单元必须完成最小上下游验证，并在提交前通过 `npm test` 或更具体的局部门禁。
- 优先运行覆盖当前改动范围的最小 verifier。
- 除非用户明确要求完整发布或 readiness 检查，否则不运行完整 `npm run server:verify`。
- `package.json` 脚本较多，优先查询所需脚本名和局部片段，避免把整份文件作为默认上下文。
- 涉及部署、运行时自举、镜像构建、外部服务启动、包管理器安装、平台依赖下载或生产入口配置的测试，必须在全新的容器环境中执行；本机环境检查只能标注为代码路径调试或非部署类快速验证。

## README.md 修改权限

- 除非用户明确要求，否则所有的文档改动都**不可以**修改项目根目录下的 README.md 文件。

## 提交前自检 (Pre-submission Self-Check)

- **可提交功能自检**：提交前必须确认本次功能单元完整、上下游已适配、最小验证已通过；无法验证的部分已有客观阻断文档和后续验证命令。
- **语气自检**：完成代码修改、文档更新或总结汇报前，回溯检查 UI 文案、日志、报错和 Markdown；把过强管控措辞改成平实、友善、可执行的表达。

## Console (apps/console)

### Scope

- Owns the Vue 3 + Element Plus management console in `apps/console/`.
- Keep UI work inside `apps/console/` unless the task explicitly changes a server API contract or shared build configuration.

### First Reads

- Start with the repository-wide rules in this skill, then this section.
- For route-level work, inspect `apps/console/router/` and the target file in `apps/console/views/`.
- For reusable UI, inspect `apps/console/components/common.ts` and the nearest component folder before adding new components.
- For API calls and frontend data contracts, inspect the relevant client under `apps/console/lib/`.

### Directory Routing

- `views/`: route-level pages.
- `components/`: reusable and feature components.
- `lib/`: typed API clients, browser helpers, and shared frontend utilities.
- `i18n/`: console localization and dynamic text handling.
- `styles/`: tokens, themes, layout, and feature styles.
- `router/`: route definitions and navigation boundaries.

### Verification

- Use `npm run typecheck --workspace @meshrix/console` for type safety.
- Use the specific frontend verifier when touching feature registry, architecture, cache storage, or production-health console behavior.
- Use browser checks only when layout, interaction, or rendering changed.

### Context Budget

- Keep searches under `apps/console/` first.
- Avoid loading all views or all styles; follow the route/component/lib path for the feature being changed.

## Server (apps/server)

### Scope

- Owns the Node.js control-plane process bootstrap under `apps/server/`.
- Keep runtime composition in `packages/server-runtime/` and shared platform behavior in the owning `packages/*` module.

### First Reads

- Start with the repository-wide rules in this skill, then this section.
- Use `packages/server-runtime/src/composition/` for startup and runtime assembly behavior.
- Use `packages/protocols/` for protocol boundary work.

### Directory Routing

- `bin/`: executable server entry points.
- `runtime/`: HTTP server bootstrap and process lifecycle.
- `packages/server-runtime/`: runtime providers, composition, jobs, state, and app-facing orchestration.
- `packages/foundation/`: storage, security, workflow, observability, proof, and module-system primitives.

### Verification

- Prefer the narrowest `server:verify:*` or registry profile that matches the changed behavior.
- Run `npm run server:verify:architecture-graph` after changing package boundaries, registry facts, or canonical source roots.

### Context Budget

- Avoid generated runtime downloads, `build/`, `node_modules/`, and local data directories unless a failing command explicitly points there.

## Agents Domain (packages/agents)

This section adds rules for the agents domain on top of the repository-wide rules.

This domain package is organized by executable feature root. Every direct child of `src/` must be registered in `manifest.module.json#sourceOwnership` with its exact file count and at least one executable suite from `tools/registry/tests.registry.json`. Do not add empty layer directories or placeholder test trees.

### Testing

- Keep package-focused tests in the repository test tree and register the executable suite.
- Run `npm test -- --suite domains.manifest` after changing source ownership or dependencies.

## Capabilities Domain (packages/capabilities)

This section adds rules for the capabilities domain on top of the repository-wide rules.

This domain package is organized by executable feature root. Every direct child of `src/` must be registered in `manifest.module.json#sourceOwnership` with its exact file count and at least one executable suite from `tools/registry/tests.registry.json`. Do not add empty layer directories or placeholder test trees.

The canonical Operation Permission runtime and its domain-owned stores remain cohesive in `src/operation-permission-core/`; grant, pending, audit, policy, and metrics state are part of the feature rather than generic infrastructure.

### Testing

- Keep package-focused tests in the repository test tree and register the executable suite.
- Run `npm test -- --suite domains.manifest` after changing source ownership or dependencies.

## Protocol Adapters (packages/protocols)

This section adds rules for protocol adapters on top of the repository-wide rules.

Own transport, negotiation, normalization, and protocol-local ports only. Reach domain behavior and authorization through registered operations or composition-injected facades. Do not import `packages/agents`, `packages/capabilities`, or `packages/server-runtime` internals.

### Testing

- Run `npm run server:verify:protocol-boundary` after protocol import or port changes.
- Run MCP outlet visibility and Operation Permission suites when adapter authorization changes.

## MCP Gateway Connector Runtime (packages/protocols/mcp/adapter/gateway-installer)

### Scope

- Owns the Meshrix.js Server MCP Gateway connector runtime under `packages/protocols/mcp/adapter/gateway-installer/`.
- User-device installer scripts live under `packages/protocols/mcp/adapter/native-installer/`.
- Keep runtime proxy and process-identity changes inside this directory unless server MCP discovery or release packaging must be updated together.

### First Reads

- Start with the repository-wide rules in this skill, then this section.
- Read `packages/protocols/mcp/adapter/gateway-installer/README.md` for runtime connector boundaries.
- Read `packages/protocols/mcp/adapter/native-installer/README.md` for user-facing install and registration behavior.
- Inspect `packages/protocols/mcp/adapter/gateway-installer/package.json` for connector package metadata.
- Inspect `packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts` for CLI behavior.
- Use `docs/RUNBOOK.md` only for install workflow or troubleshooting docs.

### Directory Routing

- `bin/`: executable runtime connector entry points.
- `packages/protocols/mcp/adapter/gateway-installer/package.json`: package metadata, bin mapping, and release surface.
- `packages/protocols/mcp/adapter/native-installer/`: canonical install guidance and scripts shared with users.

### Verification

- Prefer `npm run mcp:doctor` or a specific MCP verifier when the changed path maps to one of those flows.
- For server-side MCP discovery changes, coordinate with the server worktree instead of changing both worktrees independently.

### Context Budget

- Avoid reading server MCP internals until the connector boundary requires it.
- Keep native install docs and connector runtime behavior aligned, but do not load unrelated operational docs by default.
