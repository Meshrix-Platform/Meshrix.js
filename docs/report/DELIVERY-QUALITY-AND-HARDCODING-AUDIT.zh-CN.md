# LicoMesh 交付质量与硬编码问题审计报告

> 审计日期：2026-07-22
> 审计对象：当前工作区生产代码快照
> 报告性质：本地派单依据，不是发布材料
> 结论口径：下列条目均已在生产源码中确认，明确判定为“这里有问题”

## 1. 执行摘要

当前无法稳定交付，不是单一实现缺陷，而是三类问题叠加：

1. 安全与资源事实被硬编码兜底值替代，缺失身份或 workspace 时没有失败，而是生成看似有效的假事实。
2. 路由、模型供应商、领域枚举、文案和视觉规则存在多个事实源，修改一处无法保证其它入口同步。
3. 前端通过 DOM 后处理、页面私有样式和 JSON 导入绕过正式能力，形成“功能能跑，但不是完整产品闭环”的妥协实现。

本次共确认 **18 个问题族**：

| 优先级 | 数量 | 含义 |
| --- | ---: | --- |
| P0 | 2 | 可能污染身份审计或 workspace 资源边界，必须先修 |
| P1 | 11 | 已造成错误行为、能力缺口或高概率漂移，应在交付前修复 |
| P2 | 5 | 造成界面质量、维护成本或后续漂移，应按模块清理 |

## 2. 判定标准

本报告把下列情况判定为有问题的硬编码：

- 缺失配置、身份或资源范围时，代码填入一个看似真实的值继续运行。
- 同一业务事实由多个数组、`switch`、模板选项或字符串表分别维护。
- 前端使用源码文案、颜色、路径或客户端名称充当协议或配置事实。
- 正式 UI 没有覆盖后端已经支持的能力，要求用户改 JSON 或走旁路。
- 已抽取到公共包的实现仍在应用目录保留副本。

以下内容不作为问题：协议版本、错误码、算法常量、测试夹具、生成文件、示例配置、仅用于 `new URL()` 解析相对路径且不会发起网络请求的基准 URL，以及外观预设/设计令牌的正式定义源。

## 3. P0：必须优先修复

### SEC-HC-001：受治理操作的操作者身份可由调用方伪造，缺失时还会生成通用身份

**判定：这里有问题。**

证据：

- `packages/protocols/mcp/adapter/http-mcp-adapter-request-validation.mjs:110`：`operatorId` 优先读取请求载荷，再读取 grant 元数据，最后退化为 `"mcp-agent"`。
- `packages/server-runtime/src/composition/console-domain/operation-executors/shared.mjs:224`：只有 MCP/tool-grant 被锁定为认证身份；普通 Console 调用可让输入中的 `actorId`、`contributorId`、`reviewerId` 覆盖认证用户。
- `packages/server-runtime/src/composition/console-domain/operation-executors/workspace-contribution-executor.mjs:63`：提交、审核、发布、权限请求等记录使用上述可声明身份。
- `packages/server-runtime/src/composition/console-domain/operation-executors/runtime-admin-executors.mjs:351`：安全告警确认优先采用输入中的 `acknowledgedBy`，缺失时退化为 `"operator"`。
- `packages/foundation/src/security/security-alerts.mjs:366`：告警状态存储再次接受调用方提供的 actor，并以 `"operator"` 兜底。
- `packages/server-runtime/src/composition/devops/monitor-alerts.mjs:499`：监控告警状态转换同样以 `"operator"` 兜底。
- `packages/agents/src/workspace-contribution/package-validation.mjs:80`：贡献者、来源智能体和状态历史 actor 可退化为 `"anonymous"`。

影响：审计记录不能证明真实操作者；用户可以声明另一个操作者；多个真实主体会被合并为同一通用身份；安全事件追责、权限贷款和贡献治理证据失真。

修复边界：

1. MCP 操作者只允许来自已验证 grant/process identity，载荷中的身份只能作为 `declared*` 元数据。
2. Console 操作者只允许来自认证 session；贡献者、审核者、确认者不得从业务输入覆盖。
3. 缺少规范身份的受治理写操作必须返回类型化拒绝，不得填入 `anonymous`、`operator`、`mcp-agent`。

验收条件：

- 伪造 `actorId`、`operatorId`、`acknowledgedBy` 不会改变审计主体。
- 缺少认证主体的写操作失败关闭。
- 审计记录中的主体与 grant/session 绑定主体一致。
- 生产写路径不再存在上述三个通用身份兜底。

建议拆单：MCP 身份、Console/贡献身份、安全告警身份分别交给不同智能体，禁止同时修改同一文件。

### WS-HC-001：缺少 workspace 时静默落入 `"default"`

**判定：这里有问题。**

确认位置：

- `packages/protocols/http/controllers/system-controller.mjs:238`
- `packages/server-runtime/src/composition/console-domain/operation-executors/shared.mjs:260`
- `packages/agents/src/workspace-governance/index.mjs:106,366`
- `packages/agents/src/workspace-asset-registry/support.mjs:72`
- `packages/agents/src/workspace-contribution/package-validation.mjs:81`
- `packages/agents/src/workspace-contribution/stats-dashboard.mjs:52,95`
- `packages/agents/src/workspace-contribution/workspace-mapping.mjs:65,74`
- `packages/agents/src/workspace-contribution/contribution-core.mjs:98`
- `packages/foundation/src/security/security-permissions-provider.mjs:31,480,492`
- `packages/capabilities/src/operation-permission-core/store-audit.mjs:189,238`
- `packages/foundation/src/proof/proof-substrate/register.mjs:98`
- `packages/foundation/src/proof/proof-substrate/index.mjs:717,1381`
- `packages/server-runtime/src/composition/queued-job-workflow-provider.mjs:21`

项目当前计划本身已经把“不得使用 default workspace”列为约束，但生产路径仍广泛存在该兜底。

影响：遗漏 workspace 的请求会写入同一个共享命名空间；ACL、策略、证明、贡献、审计和统计可能跨 workspace 串数据；调用方错误被掩盖，表现为“功能成功但归属错误”。

修复边界：在 HTTP/RPC/Console 操作入口解析规范 workspace；从认证资源绑定或显式参数获得；缺失、无权或不一致时失败关闭。内部证明、权限和贡献模块只接收已验证 workspace，不再自行推断。

验收条件：

- 所有 workspace 写操作缺少 workspace 时返回类型化错误。
- workspace 必须与当前主体允许范围相交。
- 相同资源 ID 在两个 workspace 中不会发生策略、证明或统计串联。
- 上述生产文件不再用 `"default"` 代替缺失 workspace。

建议拆单：入口规范化、workspace 资产/治理、贡献系统、权限/证明四个独立闭环。

## 4. P1：交付前应修复

### MCP-HC-001：修复指引会虚构本地服务地址和 Codex 客户端目标

**判定：这里有问题。**

`packages/protocols/mcp/adapter/gateway-installer/lib/cli/guidance.mjs` 中：

- 安装命令默认 `target = "codex"`、`baseUrl = "http://127.0.0.1:7228"`。
- 未发现 Hub 时把缺失地址替换成本机地址，并生成可执行修复命令。
- 缺少 token 时默认选择 Codex。
- 非交互终端错误会生成针对 Codex 的卸载命令。
- doctor 和 candidate repair 再次补入同一本机地址。

影响：没有配置的环境会被描述成“本机已存在服务”；非 Codex 客户端可能收到 Codex 安装/卸载建议；用户复制命令后会修改错误目标。

修复：空配置保持为空；返回“需要选择服务/客户端”的类型化状态；只有经过发现或显式输入验证的 URL 才能进入命令；命令目标必须来自当前 candidate/manifest。

验收：无地址时指引中不出现 URL；非 Codex 目标绝不出现 Codex 命令；无目标时不生成卸载命令。

### MCP-HC-002：错误恢复依赖英文错误文案匹配

**判定：这里有问题。**

位置：`packages/protocols/mcp/adapter/gateway-installer/lib/cli/guidance.mjs:154`。

当前通过正则或 `includes()` 匹配 `unsupported install target`、`missing token`、`interactive mode requires a tty` 等自然语言，再推导错误码和修复命令。

影响：文案、大小写或本地化变化会改变控制流；同义错误可能落入错误修复分支；用户看到的文字被错误地当成协议。

修复：错误产生端返回稳定错误码和结构化上下文；指引层只按错误码分派；未知错误只能给安全诊断动作，不能猜测破坏性修复。

验收：修改错误文案不会改变恢复行为；所有已知分支有错误码表驱动测试；未知码不生成安装/卸载命令。

### MCP-HC-003：OrbStack/Docker 主机名和安全 Origin 策略散落在通用协议代码中

**判定：这里有问题。**

硬编码位置：

- `packages/protocols/mcp/adapter/http-mcp-adapter-request-validation.mjs:31`
- `packages/protocols/mcp/adapter/gateway-installer/lib/cli/device-config.mjs:37`
- `packages/protocols/mcp/adapter/gateway-installer/lib/cli/commands.mjs:45`
- `packages/protocols/mcp/adapter/gateway-installer/lib/cli/http-json-client.mjs:6`
- `packages/protocols/mcp/adapter/http-mcp-adapter-discovery.mjs:133`
- `packages/capabilities/src/skills/tool-skill-management-provider-local-mcp.mjs:432`
- `packages/protocols/mcp/adapter/gateway-installer/lib/cli/scan-remote.mjs:479`

影响：平台探测、URL 广告和安全允许列表不是同一事实源；增加或禁用虚拟化平台时容易只改一半；环境专用主机名直接进入通用 Origin 白名单。

修复：由环境适配器注册主机别名、发现地址和允许 Origin；安全层只消费经过验证的适配结果，不认识 OrbStack/Docker 字面量。

验收：OrbStack、Docker、无虚拟化三种配置有测试；未知主机拒绝；平台字面量只允许存在于对应适配器注册表。

### NAV-HC-001：Admin 路由注册表并不是实际单一事实源

**判定：这里有问题。**

虽然 `apps/console/router/admin-route-registry.mjs` 声称是唯一事实源，但以下信息仍被重复维护：

- `apps/console/composables/console-shell-route-controller.ts`：视图标题 `switch`。
- `apps/console/composables/console-defaults.ts`：`adminViewTitleMap`、`viewTitleMap`。
- `apps/console/composables/console-command-palette-controller.ts`：section 标签 `switch`。
- `apps/console/components/shell/side-nav/ConsoleSideNavAgentSection.vue`
- `apps/console/components/shell/side-nav/ConsoleSideNavIntegrationSection.vue`
- `apps/console/components/shell/side-nav/ConsoleSideNavOperationPermissionSection.vue`
- `apps/console/components/shell/side-nav/ConsoleSideNavSystemSection.vue`
- `apps/console/components/shell/side-nav/ConsoleSideNavVersionSection.vue`

已确认的实际错误：`ConsoleSideNavIntegrationSection.vue:16` 只依据 `upstreamServices` 决定整个 section 是否显示，但 section 内还包含权限不同的 `upstreamServicePublish`。仅有发布权限的用户可以访问路由，却看不到入口。

修复：注册表增加消息 key、导航排序、可见性和路径元数据；侧栏、命令面板、标题、面包屑和权限可见性全部派生。

验收：每个可访问注册路由恰好出现一次；仅有发布权限时发布入口可见；新增 route 不需要修改多个 `switch`/模板。

### NAV-HC-002：未知路由静默回退到 Storage 或首页

**判定：这里有问题。**

位置：`apps/console/router/routes.ts:65-88`。

`adminSectionToSlug()` 和 `slugToAdminView()` 对未知值返回 `storage`，`viewToPath()` 对未知视图返回 `/`。

影响：拼写错误、注册漂移和失效深链不会暴露，而是打开一个不相关页面；测试和用户都可能误判导航成功。

修复：未知值返回类型化 not-found/invalid-route；调用者显式决定是否导航；不得落到业务页面。

验收：未知 view/slug 展示明确 404 或拒绝导航；Storage 仅在显式请求时打开。

### MODEL-HC-001：模型供应商目录在前后端和运行时重复维护

**判定：这里有问题。**

重复位置：

- `packages/server-runtime/src/composition/platform-core/settings-defaults.mjs:6`
- `packages/agents/src/agent-gateway/policy-validation.mjs:12`
- `packages/agents/src/agent-gateway/model-probe/index.mjs:8`
- `packages/agents/src/agent-gateway/gateway-core.mjs:251`
- `apps/console/composables/console-defaults.ts:11`
- `apps/console/composables/console-model-utils.ts:66`
- `apps/console/types/app.ts:6`

同一组 provider ID、标签、能力和传输分支分别存在于集合、数组、类型和 `switch` 中。

修复：建立一个可导出的 provider contract/registry，包含 ID、标签 key、能力、凭据模式和传输族；服务端验证、探测和前端选项从它派生。

验收：新增 provider 只需一次注册；客户端与服务端对同一 provider 集合做契约测试；不再存在重复 ID 列表和标签 `switch`。

### I18N-HC-001：Console 使用 DOM 后处理翻译，源码文案本身被当成 key

**判定：这里有问题。**

证据：

- `apps/console/i18n/console-dom-localizer.ts:45-160` 遍历文本节点和属性，并用全局 `MutationObserver` 监听整个 `document.body`。
- `apps/console/i18n/console-text-localizer.ts:32-96` 依赖完整句子映射、片段替换、正则和中文字符检测。
- `apps/console/composables/console-shell-preferences.ts:281` 在 Shell 中全局安装该机制。
- 当前 148 个 Vue 文件中有 107 个包含中文源码文本；i18n 目录扫描命中约 1,208 行 phrase/pattern 数据。

影响：改一句文案就可能让翻译静默失效；动态文本可能被部分误译；首屏会先渲染再改 DOM；ARIA、placeholder 和可见文本可能短暂或永久不一致；全局观察器增加运行时成本。

修复：使用稳定、类型化消息 key 在渲染时翻译；动态值用参数插值；构建时检查缺失 key。迁移完成后一次性删除 DOM localizer、phrase/segment/pattern 兼容层，不能长期双轨。

验收：不再监听 DOM 做翻译；所有可见文案和可访问性属性使用消息 key；中英文渲染快照通过；缺少 key 时构建或测试失败。

受影响文件清单见附录 A。

### UX-FUNC-001：上游服务发布 UI 明确没有覆盖后端已支持的完整能力

**判定：这里有问题，而且这是功能妥协，不只是文案问题。**

后端契约 `packages/contracts/src/upstream-service-publishing.mjs:23-34` 支持：

- 请求：`structured_json`、`opaque_stream`、`artifact_body`、`artifact_multipart`
- 响应：`structured_json`、`opaque_stream`、`artifact`

但 `apps/console/views/admin/upstream-service-publish/PublishServiceForm.vue:223-255` 只提供前两种，并在第 190 行明确要求 artifact mapping 使用 Service JSON import。

影响：产品宣称支持的能力无法通过正式 UI 完成；用户被迫绕过表单直接编辑 JSON；校验、帮助、可发现性和错误反馈退化。

修复：为 artifact body、multipart part、artifact response 提供结构化编辑器和契约校验，不要求用户手写 JSON。

验收：所有契约模式都能从 UI 创建、编辑、回读和重新发布；导入 JSON 只是可选入口，不是完成功能的必经旁路。

### CONTRACT-HC-001：领域枚举在模板、服务端和宽泛类型中重复定义

**判定：这里有问题。**

证据：

- Tag kind 在 `packages/server-runtime/src/state/tag-management-codec.mjs:7` 私有集合中定义，又在 `apps/console/views/admin/tag-management/TagEditorForm.vue:83` 逐项写死。
- 上游协议、HTTP method、risk 和 representation 在发布表单中逐项写死，与契约校验分离。
- `apps/console/types/app.ts` 把 `AppView`、`AdminView`、`CloudProvider` 最终都放宽为 `string`，编译器无法检查注册表覆盖。

影响：服务端增加枚举后 UI 不会自动出现；UI 可构造服务端拒绝值；所谓类型检查不能发现拼写和遗漏。

修复：枚举由 contracts 导出，前端用派生的只读定义和标签 key；开放扩展必须使用显式贡献接口，不能用 `| string` 消除类型约束。

验收：新增 tag kind/provider/view/representation 时，漏接 UI 会编译或测试失败；前后端枚举集合一致。

### UI-HC-001：生产组件绕过主题令牌直接写颜色和阴影

**判定：这里有问题。**

确认文件：

- `apps/console/components/FeatureToggle.vue:71,95`
- `apps/console/components/upload/UploadSplitButton.vue:95-96,159`
- `apps/console/components/agent-model-option-bar/AgentModelOptionBar.css:31-106`
- `apps/console/components/workspaces/WorkspaceExpandedDetail.css:190-246`
- `apps/console/views/admin/tag-management/TagEditorForm.vue:235-236`
- `apps/console/views/admin/context-management/ContextPresetModal.vue:73,88`
- `apps/console/components/ConfigFloatingPanel.vue:132`
- `apps/console/views/WorkspacesView.vue:325,340`
- `apps/console/views/admin/UpstreamGatewayView.vue:163-301`
- `apps/console/components/HistorySessionPanel.css:6-22`
- `apps/console/styles/reset.css:57`
- `apps/console/styles/components/dashboard-alerts.css:583,591`
- `apps/console/styles/views/gateway-assistant/trace-results.css:91`

影响：主题切换不完整；不同页面的 danger/success/focus/backdrop 不一致；视觉修改需要全仓搜索；暗色模式存在对比度漂移。

修复：把语义颜色、焦点环、遮罩、阴影、mono font 全部映射到现有 token；缺失 token 在正式令牌源补充，组件不得自建 fallback palette。

验收：除外观预设、正式 token 文件和品牌插画外，产品组件不再出现原始 hex/rgb/rgba；浅色和暗色视觉回归通过。

### UI-HC-002：页面私有 Modal 缺少统一可访问行为，并残留复制的无效 CSS

**判定：这里有问题。**

- `ContextPresetModal.vue` 自己实现 overlay 和 form，但没有 `role="dialog"`、`aria-modal`、焦点进入/返回、Tab 焦点约束和 Escape 关闭。
- `WorkspacesView.vue:322-349` 保留了一整套 `.lico-modal*` 和动画 CSS，但模板中没有对应节点，是复制后遗留的死代码。
- 项目已经存在具有基本对话框语义的 `ConfigFloatingPanel.vue` 和 `ConsoleConfirmDialog.vue`，但交互规范没有被复用。

影响：键盘和读屏用户无法可靠操作；不同弹层的关闭、焦点和视觉行为不一致；死 CSS 掩盖实际所有权。

修复：建立共享 dialog/form-dialog primitive；迁移 ContextPreset；删除 Workspaces 死 CSS；焦点管理只由 primitive 负责。

验收：dialog 语义、Escape、焦点进入/返回和 Tab 循环测试通过；不再存在页面私有 `.lico-modal*` 实现。

## 5. P2：按模块清理

### UI-HC-003：品牌 Logo SVG 在三个组件中复制

**判定：这里有问题。**

位置：

- `apps/console/views/LandingView.vue`
- `apps/console/components/shell/ConsoleAuthGate.vue`
- `apps/console/components/shell/side-nav/ConsoleSideNavBrand.vue`

同一轨道/渐变结构和颜色被复制，且 Landing 与 Shell 已出现变体漂移。应提取共享品牌组件或资产，只把尺寸/变体作为参数。

验收：品牌几何只有一个源；各场景使用明确 variant；修改品牌不需要编辑多个模板。

### UI-HC-004：等宽字体栈在 16 个样式位置重复

**判定：这里有问题。**

确认文件：

- `apps/console/components/agent-model-option-bar/AgentModelOptionBar.css`
- `apps/console/styles/element-plus-overrides.css`
- `apps/console/styles/views/drawer-path-dialogs/path-picker-controls.css`
- `apps/console/styles/views/drawer-path-dialogs/drawer-settings.css`
- `apps/console/styles/views/admin-maintenance/chunking-list-detail.css`
- `apps/console/styles/views/admin-maintenance/chunking-block-editor.css`
- `apps/console/styles/views/admin-maintenance/chunking-shell.css`
- `apps/console/components/shell/ConsoleTopbar.vue`
- `apps/console/styles/components/model-library.css`
- `apps/console/styles/layout/canvas-topbar-status.css`
- `apps/console/styles/components/tables-forms.css`
- `apps/console/components/admin/authorization-governance/AuthorizationGovernanceCard.css`
- `apps/console/styles/views/admin-runtime-tools/monitor-maintenance.css`
- `apps/console/styles/views/admin-runtime-tools/permission-cards.css`
- `apps/console/styles/features/tables.css`

不同写法已出现。统一改为 `var(--font-mono)`，字体栈只允许在 token 源定义。

### UI-HC-005：静态布局仍使用模板内联样式

**判定：这里有问题。**

位置：

- `apps/console/components/workspaces/detail/WorkspaceParentPanel.vue:33`
- `apps/console/components/admin/storage/StorageSessionCard.vue:28`
- `apps/console/components/workspaces/detail/WorkspaceSharePanel.vue:35`
- `apps/console/components/WorkspaceFileTree.vue:125`
- `apps/console/components/admin/ops-monitor/OpsMonitorAlertsPanel.vue:28`

这些是静态视觉规则，不是运行时计算，应迁入语义 class/token。进度宽度、树缩进、拖拽尺寸等真正动态样式不在本问题范围内。

### UI-HC-006：配置输入提示写死本机地址

**判定：这里有问题，但只是文案/引导层问题，不等同于运行时默认值。**

位置：

- `apps/console/views/admin/upstream-service-publish/PublishServiceForm.vue:173`
- `apps/console/components/shell/service-discovery/ConsoleServerAddressRow.vue:101`
- `apps/console/components/admin/modules/RuntimeModulesPanel.vue:53`

影响：示例会随端口、拓扑和部署方式漂移，并暗示本机地址是推荐配置。应从产品级 example/metadata 派生，或使用不指向真实环境的中性示例域名。

### MIG-HC-001：公共 UI 包抽取后仍保留应用侧重复实现

**判定：这里有问题。**

- `apps/console/lib/browser-downloads.ts` 与 `packages/ui-console/src/browser-downloads.ts` 当前实现完全重复，并被不同调用链分别引用。
- `apps/console/lib/browser-window.ts` 复制了 `packages/ui-console/src/browser-window.ts` 的基础函数后又追加应用函数。

影响：公共包和应用的浏览器行为可能分别修复、分别漂移；这属于未完成迁移，不应长期保留兼容副本。

修复：公共包拥有基础浏览器能力；应用只保留真正的 Console 专属封装并直接导入公共实现；一次迁移后删除副本。

验收：基础函数和下载逻辑只有一个实现源；不存在双路径测试或兼容 re-export 门禁。

## 6. 推荐派单顺序

| 顺序 | 派单闭环 | 主要问题 | 建议验收范围 |
| ---: | --- | --- | --- |
| 1 | MCP 操作者身份 | SEC-HC-001A | MCP envelope + grant 身份聚焦测试 |
| 2 | Console/告警操作者身份 | SEC-HC-001B | 告警确认、贡献写操作身份测试 |
| 3 | workspace 入口失败关闭 | WS-HC-001A | HTTP/RPC/Console workspace 边界测试 |
| 4 | workspace 内部事实去默认值 | WS-HC-001B | 资产、贡献、权限、证明按模块分别验收 |
| 5 | MCP 指引结构化错误 | MCP-HC-001/002 | guidance 表驱动测试 |
| 6 | MCP 环境主机适配器 | MCP-HC-003 | 三种环境矩阵测试 |
| 7 | 路由注册表真正收口 | NAV-HC-001/002 | route registry + 权限可见性测试 |
| 8 | 模型 provider 契约收口 | MODEL-HC-001 | client/server contract test |
| 9 | 上游发布 UI 能力补齐 | UX-FUNC-001 | 全模式表单端到端测试 |
| 10 | 领域枚举和类型收口 | CONTRACT-HC-001 | 编译检查 + 契约覆盖测试 |
| 11 | i18n 完整迁移 | I18N-HC-001 | 双语渲染 + 缺 key 检查 |
| 12 | Dialog 与视觉令牌 | UI-HC-001/002 | 组件测试 + 浅/深色视觉回归 |
| 13 | 视觉与迁移残留清理 | P2 条目 | lint/build + 局部视觉检查 |

不要让两个智能体同时修改这些冲突热点：

- `http-mcp-adapter-request-validation.mjs`
- `gateway-installer/lib/cli/guidance.mjs`
- `console-defaults.ts`
- `console-shell-route-controller.ts`
- `shared.mjs`（Console domain operation executors）

## 7. 派单黄金规则与红线

黄金规则：

1. 一个业务事实只能有一个规范 owner，其它层派生或消费。
2. 缺失事实保持缺失；必须配置的字段缺失时返回类型化错误。
3. 认证身份、资源范围和权限只来自已验证上下文，不来自业务载荷声明。
4. 每个任务只闭环一个最小可独立验收的模块/场景，先跑聚焦测试。
5. 完成全部相关改动后再跑一次全量回归，过程中不反复全量测试。
6. 涉及迁移时一次性删除旧实现和兼容副本，不以“双轨可运行”冒充完成。

红线：

- 禁止以 `default`、`anonymous`、`operator`、`mcp-agent` 填补受治理事实。
- 禁止未知 route 回退到真实业务页面。
- 禁止依赖自然语言错误文案做控制流。
- 禁止把可见文案本身当 i18n key，禁止 DOM 后处理翻译。
- 禁止在组件中建立第二套颜色、阴影、字体或路由/provider 枚举。
- 禁止用“高级功能请改 JSON”代替正式产品能力。
- 禁止修复一个事实源时保留旧事实源长期兼容。

## 附录 A：当前含中文源码文本的 Vue 文件

下面是 I18N-HC-001 的完整文件级扫描清单。清单表示文件需要人工迁移审查；其中少量中文可能位于非可见代码，但不能因此跳过文件检查。

```text
apps/console/components/AgentModelOptionBar.vue
apps/console/components/BridgeDownloadButton.vue
apps/console/components/BrowseSelectButton.vue
apps/console/components/ConfigFloatingPanel.vue
apps/console/components/ConfigListSummaryBubble.vue
apps/console/components/ConsoleConfirmDialog.vue
apps/console/components/ConsoleEmptyState.vue
apps/console/components/ConsoleToastHost.vue
apps/console/components/FeatureToggle.vue
apps/console/components/HelpTooltip.vue
apps/console/components/HistorySessionPanel.vue
apps/console/components/JsonConfigFileEditor.vue
apps/console/components/ScopeSelector.vue
apps/console/components/SegmentedProgressBar.vue
apps/console/components/SegmentedToggle.vue
apps/console/components/UploadFileListCard.vue
apps/console/components/WorkspaceFileTree.vue
apps/console/components/admin/AuthorizationGovernanceCard.vue
apps/console/components/admin/agent-config/AgentInvocationSettingsPanel.vue
apps/console/components/admin/agent-config/AgentModelAccessPanel.vue
apps/console/components/admin/agent-config/AgentModelBindingsPanel.vue
apps/console/components/admin/agent-config/AgentModelEntryCard.vue
apps/console/components/admin/agent-config/AgentModelEntryHeader.vue
apps/console/components/admin/agent-config/AgentModelEntrySummaryActions.vue
apps/console/components/admin/agent-config/AgentModelLibraryPanel.vue
apps/console/components/admin/agent-config/AgentModelPromptPanel.vue
apps/console/components/admin/agent-config/AgentModelProviderFields.vue
apps/console/components/admin/authorization-governance/AuthorizationGovernanceEditor.vue
apps/console/components/admin/maintenance-agent/MaintenanceAgentActionGrid.vue
apps/console/components/admin/maintenance-agent/MaintenanceAgentPolicyPanel.vue
apps/console/components/admin/maintenance-agent/MaintenanceAgentRunDetail.vue
apps/console/components/admin/maintenance-agent/MaintenanceAgentRunList.vue
apps/console/components/admin/maintenance-agent/MaintenanceAgentSummaryCard.vue
apps/console/components/admin/modules/RuntimeModuleConfigItem.vue
apps/console/components/admin/modules/RuntimeModulesPanel.vue
apps/console/components/admin/operation-permission/GrantToolRulePanel.vue
apps/console/components/admin/operation-permission/ToolGrantCreateCard.vue
apps/console/components/admin/operation-permission/ToolGrantListCard.vue
apps/console/components/admin/operation-permission/ToolPolicyPreviewPanel.vue
apps/console/components/admin/ops-monitor/OpsMonitorAlertsPanel.vue
apps/console/components/admin/ops-monitor/OpsMonitorProcessTable.vue
apps/console/components/admin/ops-monitor/OpsMonitorSummaryCard.vue
apps/console/components/admin/production-health/ProductionCoverageWarning.vue
apps/console/components/admin/production-health/ProductionGateTable.vue
apps/console/components/admin/production-health/ProductionHealthBottomGrid.vue
apps/console/components/admin/production-health/ProductionHealthHeroCard.vue
apps/console/components/admin/production-health/ProductionSectionGrid.vue
apps/console/components/admin/storage/StorageDiscoveryCard.vue
apps/console/components/admin/storage/StorageOverviewCard.vue
apps/console/components/admin/storage/StorageRuntimeCard.vue
apps/console/components/admin/storage/StorageSessionCard.vue
apps/console/components/admin/version-release/VersionReleaseBaselineCard.vue
apps/console/components/admin/version-release/VersionReleaseReadinessCard.vue
apps/console/components/approval/ApprovalFlowCardList.vue
apps/console/components/dashboard/DashboardPluginCard.vue
apps/console/components/shell/ConsoleAuthGate.vue
apps/console/components/shell/ConsoleAuthUsersPanel.vue
apps/console/components/shell/ConsoleCommandPalette.vue
apps/console/components/shell/ConsoleRuntimeModulesPanel.vue
apps/console/components/shell/ConsoleServiceDiscoveryPanel.vue
apps/console/components/shell/ConsoleSideNav.vue
apps/console/components/shell/ConsoleTopbar.vue
apps/console/components/shell/ServerPathPickerDialog.vue
apps/console/components/shell/service-discovery/ConsoleServerAddressRow.vue
apps/console/components/shell/side-nav/ConsoleSideNavBrand.vue
apps/console/components/shell/side-nav/ConsoleSideNavDirectory.vue
apps/console/components/shell/side-nav/ConsoleSideNavFooter.vue
apps/console/components/shell/side-nav/ConsoleSideNavLink.vue
apps/console/components/upload/UploadFileListRow.vue
apps/console/components/upload/UploadSplitButton.vue
apps/console/components/workspaces/WorkspaceCheckpointPanel.vue
apps/console/components/workspaces/WorkspaceDeleteAction.vue
apps/console/components/workspaces/WorkspaceDetailPanel.vue
apps/console/components/workspaces/WorkspaceExpandedOverview.vue
apps/console/components/workspaces/WorkspaceResolvedProfilePanel.vue
apps/console/components/workspaces/detail/WorkspaceAssetPanel.vue
apps/console/components/workspaces/detail/WorkspaceCreatePanel.vue
apps/console/components/workspaces/detail/WorkspaceParentPanel.vue
apps/console/components/workspaces/detail/WorkspaceProfilePanel.vue
apps/console/components/workspaces/detail/WorkspaceSharePanel.vue
apps/console/views/ApprovalFlowView.vue
apps/console/views/DashboardView.vue
apps/console/views/WorkspacesView.vue
apps/console/views/admin/AgentAssignmentView.vue
apps/console/views/admin/ContextManagementView.vue
apps/console/views/admin/JobsView.vue
apps/console/views/admin/LogsView.vue
apps/console/views/admin/OperationPermissionView.vue
apps/console/views/admin/StrategyManagementView.vue
apps/console/views/admin/TagManagementView.vue
apps/console/views/admin/ToolsView.vue
apps/console/views/admin/UpstreamGatewayView.vue
apps/console/views/admin/VersionAssemblyView.vue
apps/console/views/admin/context-management/ContextBuildRecordCard.vue
apps/console/views/admin/context-management/ContextPresetListCard.vue
apps/console/views/admin/context-management/ContextPresetModal.vue
apps/console/views/admin/context-management/ContextPreviewPanel.vue
apps/console/views/admin/tag-management/TagAuditList.vue
apps/console/views/admin/tag-management/TagEditorForm.vue
apps/console/views/admin/tag-management/TagProjectionCard.vue
apps/console/views/admin/tag-management/TagTreePanel.vue
apps/console/views/admin/tools/ToolAuditCard.vue
apps/console/views/admin/tools/ToolCatalogDetailPane.vue
apps/console/views/admin/tools/ToolCatalogIndexPane.vue
apps/console/views/admin/tools/ToolCatalogSearch.vue
apps/console/views/admin/tools/ToolGovernancePanel.vue
apps/console/views/admin/tools/ToolUsageStatsCard.vue
```

## 8. 关闭报告的条件

本报告不能通过“相关测试存在”或“主要流程可运行”关闭。只有当对应问题的生产实现、重复事实源、旧兼容路径和验收证据全部闭环时，才可逐项标记完成。任何仍需手工 JSON、隐式默认值、文案匹配或 DOM 后处理才能工作的功能，都不算完成。
