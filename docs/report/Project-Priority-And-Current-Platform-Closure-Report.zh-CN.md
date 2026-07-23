# 项目功能优先级、实现进度与当前平台闭环报告

日期：2026-07-22

性质：本地临时工作报告。本文记录当前工作树、计划状态和局部验证结果，不是发布就绪声明，也不替代正式验收回执。

## 一、结论

当前最需要推进的不是 Windows，也不是继续扩展新功能，而是先完成下面三个连续闭环：

1. 修复当前 macOS 便携安装包的真实执行失败。目前这是当前平台唯一仍可复现的 Native Installer 功能阻断。
2. 在不扩展产品范围的前提下清理 Better Plan 通用状态 schema 债务，使历史回执和当前工具完全一致。
3. 正式完成 Native MCP Installer 的平台中立最终验收，再依次完成 Downstream MCP 的父级集成与最终验收。

Windows 安装分支仍是独立的 Windows 工作，不是上述 macOS 或平台中立闭环的阻塞项。项目专用结构验证、`verify:better-plan` 和 `plan:next` 在最终快照中均已恢复，且当前唯一可执行节点是平台中立的 Native Installer 最终验收节点，不是 Windows 节点。

当前工作树尚不具备整体提交条件。核查期间变更路径从 319 个继续增长；最后一次采样为 392 个路径，其中 286 个已跟踪修改、47 个删除、59 个未跟踪路径，已跟踪差异覆盖 333 个文件，约 32,822 行新增和 26,467 行删除。精确数量仍可能随并发改动变化，这些数字仅用于证明范围过大，不能作为 Git 候选清单。改动同时分布在 Console、Gateway、Protocol、Foundation、Server Runtime、计划、测试和发布工具等多个所有权面，不能作为一个可独立回滚的提交单元处理。

## 二、必须固化的“当前平台闭环”原则

### 2.1 判定规则

- 当前主机只对当前平台可执行路径、平台中立路径及其真实失败负责。
- 平台专属节点只能在相同平台上实现和验收，并以同平台 `evidence` 节点终止。
- 平台中立最终节点只能依赖平台中立前置节点，不得等待 Windows、Linux 或其他非当前平台回执。
- 非当前平台待办统一记为 `foreign-platform backlog` 或 `platform mismatch/deferred`，不能记为本地 blocker、全局 blocker 或当前提交 blocker。
- 只有用户明确选择“多平台发布”为本次闭环目标时，各平台发布证据才进入同一个发布验收范围；即使如此，仍应由各平台独立产出回执，再由发布聚合器消费，而不是让一个平台实现另一个平台的工作。

### 2.2 每个闭环的完成定义

一个当前平台闭环只有同时满足以下条件，才可进入提交候选：

1. 当前平台真实成功路径可执行。
2. 关键失败路径返回稳定、隐私安全且可恢复的错误。
3. 入口、调用方、配置、注册表、文档、测试、fixtures 和发布装配已同步。
4. 最小相关验证通过；完整回归只在全部预定闭环完成后运行一次。
5. Better Plan 节点和父级集成状态有效，回执不依赖其他平台。
6. 本地信息、敏感数据和 Git 候选门禁通过。

## 三、当前计划与代码快照

### 3.1 计划图概况

| 指标 | 当前值 | 判断 |
| --- | ---: | --- |
| Manifest 中的计划 | 36 | 34 个已接入依赖图，2 个为 Manifest-only 草案 |
| 活跃依赖图计划 | 34 | 当前正式执行图 |
| 活跃节点 | 308 | 268 个标记完成，40 个待完成 |
| 平台中立节点 | 276 | 当前平台和中立闭环的主要工作面 |
| Linux 节点 | 18 | 只能由 Linux 分支回执 |
| macOS 节点 | 7 | 当前平台分支已标记完成，但其当前代码证据已出现回归 |
| Windows 节点 | 7 | 其中 Native Installer 的 Windows 实现、最终验收及父级证据仍待办；不阻塞中立最终节点 |

活跃节点按能力域统计：

| 能力域 | 完成标记 | 待办 | 说明 |
| --- | ---: | ---: | --- |
| Platform Foundation | 116 | 0 | 节点标签全部完成，但当前工作树和 Better Plan schema 问题使这些标签不能单独作为现行验收依据 |
| Capability Runtime | 35 | 0 | 节点标签全部完成，但 Manifest 状态和若干回执字段已失配 |
| Gateway Distribution | 60 | 22 | 当前主交付链；包含 Native Installer、Downstream MCP 和流量韧性工作 |
| Operator Administration | 26 | 7 | Console Administration、Maintenance/Collaboration 尚未闭环 |
| Deployment | 10 | 4 | 平台中立 Server Kit 与最终验收待办；Linux 证据独立保留 |
| Release Acceptance | 4 | 2 | 两个待办均为 Linux 所有，不阻塞当前 macOS 或平台中立提交闭环 |
| End-To-End Release 根计划 | 17 | 5 | 等待 Gateway、Operator、Deployment 集成及最终归约 |

### 3.2 当前计划权威与 schema 债务

项目专用计划执行权威在最终快照中有效：

- `algorithmic-resource-discipline` 已恢复为包含 11 个全量 `pending` 节点的 Manifest-only 草案。
- `authorization-enforcement-convergence` 也是全量 `pending` 草案。两个草案均未接入 `DependencyMap.json`，因此不会参与当前执行图，也不会阻塞当前平台。
- 项目结构验证通过：34 个活跃计划、36 个 Manifest 计划、2 个草案、308 个活跃节点均可被完整归约。
- 项目 `verify:better-plan` 通过，20 个结构自变异案例全部按预期被拒绝。
- `plan:next` 在 macOS 上只有 1 个 eligible 节点，唯一选择 Native Installer 平台中立最终节点 191；8 个平台不匹配候选被延后而不是记为阻塞。
- Better Plan `next-action` 已返回 `dispatch_acceptance_designer`，说明节点 191 可以进入正式验收生命周期。

计划工作区仍存在一类独立的通用 schema 迁移债务：`manifest_tool validate` 检查 37 个状态文件、356 个项目，报告 51 个问题。问题类别包括两个终态计划的 Manifest 状态未同步、历史 acceptance/regression 回执缺少内容指纹和合同摘要、旧字段残留、缺少 evidence refs、非实现节点错误挂载 acceptance、Deployment 设计所有权冲突，以及新草案中两个 design decision 字段不符合通用 schema。

这些问题当前没有让项目选择器错误等待 Windows，也没有阻止节点 191 进入下一动作，但在整个 Better Plan 工作区被视为干净、可迁移、可提交之前必须闭环。因此，308 个节点中的“完成”仍只能视为计划标签快照，不能自动证明当前工作树已重新验收。

### 3.3 当前平台规则实现状态

当前平台隔离语义已经进入计划工具和测试：

- 平台中立最终节点只归约平台中立路径。
- 平台子计划向父计划返回同平台 `evidence`，不再返回平台中立 `implementation`。
- 平台专属本地依赖不得指向不同平台或平台中立节点。
- Manifest-only 计划只有在计划和全部节点均为 `pending` 时才可作为未接图草案存在。
- Native Installer 的 Windows 分支保持 Windows 终端分支；平台中立最终节点只依赖平台中立前置节点。

相关 focused test 当前为 57/57 通过，结构验证通过，20/20 自变异案例通过，`plan:next` 唯一选择平台中立节点 191。这组结果共同证明“非当前平台只延后、不阻塞当前平台”的规则已经进入项目执行权威。

### 3.4 Native MCP Installer 当前状态

计划状态：

- Native Installer 本地计划为 7/9 节点完成。
- Windows 父级证据节点和平台中立最终节点仍待办。
- 平台中立最终节点只依赖平台中立实现节点，不依赖 Windows 证据；其 9 条验收标准均未勾选，尚未建立自动验收生命周期。
- Downstream MCP 为 5/7 节点完成，仍需完成 Native Installer 回执集成和 Downstream MCP 最终验收。

当前代码验证：

| 验证面 | 结果 | 解释 |
| --- | --- | --- |
| 计划平台隔离 focused test | 通过，57/57 | Windows 不再被解释为当前平台阻塞项 |
| MCP process identity credential store | 通过，5/5 | 当前平台凭据存储、显式文件回退和 Linux 容器验证路径保持有效 |
| 便携发布包装配 | 失败 | 归档能构建、复现和解压，但最终原生入口执行时，归档中的 `mcp-identity.mjs` 引用了未随包提供的 `@lico/contracts` |
| Installer convergence verifier | 通过 | 11 个 installer lifecycle、外部 adapter、doctor、签名握手和隐私输出检查通过 |
| Release target scope verifier | 通过 | 5 个 public metadata、release target、discovery、initialize 和 CLI scope 检查通过 |
| 项目计划结构验证 | 通过 | 当前平台只有节点 191 eligible；外平台候选被延后 |
| 通用 Better Plan 状态验证 | 失败，51 个问题 | 属于历史回执和 schema 迁移债务，不是 Windows 或当前平台工具链阻断 |

这意味着 macOS 节点的历史完成标签仍被最终归档执行失败实质性失效。其他 Native Installer focused verifier 已恢复，应只修复归档依赖闭合并重新跑完整的局部矩阵，然后进入平台中立最终验收，不能仅修改计划标签来宣告完成。

### 3.5 其他能力域实现进度

#### Gateway Distribution

Gateway Distribution 是当前最大的未闭环能力域。其主计划有 21 个节点，仅 5 个标记完成；全域仍有 22 个活跃待办。Upstream Service Publishing 子计划本身为 21/21 完成，Downstream MCP 和后续流量韧性主链仍未归约。

工作树已经出现 payload transit、artifact transit、multipart stream、bounded stream、性能观察和多项 Gateway 测试实现，但这些改动尚未通过对应节点的独立验收，不能因为代码存在就标记为完成。

#### Platform Foundation 与资源治理

现有活跃 Platform Foundation 节点全部标记完成，但当前工作树又新增了两个未接图草案：

- `authorization-enforcement-convergence`：安全重要性最高，但当前仍是单一大范围待办，必须先拆成可独立验收的授权执行面，不能作为一个巨型实现节点直接接入。
- `algorithmic-resource-discipline`：包含 11 个全量待办节点，当前合法地保持为未接图草案。其代码面横跨状态队列、JSONL、Merkle、上传、Checkpoint、Event Bus、Job、Grant、Model Routing 和资源验证，不适合作为当前安装器闭环的一部分。

#### Capability Runtime

Capability Runtime 的 35 个节点全部标记完成，但父计划和 Plugin Runtime 的 Manifest 状态仍是 `in_progress`，同时多份 acceptance/regression 回执不符合当前 Better Plan schema。应按当前事实同步计划状态和回执，而不是把这些问题当作功能实现阻塞扩散到当前平台任务。

#### Operator Administration

Operator Administration 为 26/33 节点完成，剩余 7 个节点集中在 Console Administration、Maintenance/Collaboration 及父级集成。当前 Console 相关工作树有 32 个变更路径，说明实现已经展开，但尚未形成单一可验收 UI/运营场景。

#### Deployment 与 Release Acceptance

Deployment 为 10/14 节点完成。平台中立 Server Kit 和 Deployment 最终验收仍待办；Linux 容器证据和 Linux release acceptance 保持同平台终端分支。它们不应阻塞当前 macOS 功能提交，但会在未来明确执行 Linux 发布验收时进入相应范围。

## 四、功能重要性排序

这里的“重要性”描述产品和架构风险，不等于当前应立即切换的执行顺序。

| 重要性 | 功能域 | 原因 |
| --- | --- | --- |
| S0 | 授权、Operation Permission、受治理执行与最小证据 | 决定所有受保护读取和副作用是否可信；任何真实绕过都是发布阻断 |
| S0 | Gateway Distribution、Downstream MCP、Upstream Service Publishing | 是客户端接入、工具调用、服务发布和受控转发的核心数据面，也是当前主交付链 |
| S1 | Deployment、Server Kit、Release Acceptance | 决定用户是否能可靠安装、启动、诊断、升级和验证交付物 |
| S1 | 状态、存储、作业与算法资源治理 | 决定长期运行中的正确性、内存、队列、持久化和恢复上界 |
| S2 | Observability、告警、证据归约 | 决定故障可诊断性和发布证据可信度，但不能替代真实功能执行 |
| S2 | Console Administration | 决定运维能力是否可发现、可操作、错误是否能正确恢复 |
| S3 | Maintenance Agent 与 Collaboration | 重要但依赖前述授权、状态、Gateway 和运维事实先稳定 |
| S4 | 非当前操作系统支持 | 必须完成，但只在匹配平台上独立推进，不作为当前平台闭环前置条件 |

## 五、从现在开始的执行优先级

### P0-A：修复当前 macOS Native Installer 真实执行路径

目标是让最终归档在干净解压目录中可直接执行，而不是只证明文件被复制。

建议动作：

1. 为 `mcp-identity.mjs` 选择唯一的便携依赖策略：将 canonical JSON 实现作为完整发布依赖随包闭合，或在协议身份模块中使用不依赖工作区包的协议本地实现。不能留下“开发工作区可解析、最终归档不可解析”的中间态。
2. 检查 canonical JSON 迁移的所有 producer、consumer 和发布装配，移除任何工作区可见但归档不可用的半迁移入口。
3. 重新运行四个 Native Installer 声明 verifier、focused tests、local-info hygiene 和隐私检查。
4. 确认文档、package metadata、归档 inventory、可执行权限和当前命令入口完全一致。

完成条件：当前平台归档真实入口通过，四个能力 verifier 均能产出有效、隐私安全的回执。

### P0-B：迁移 Better Plan 通用状态 schema

目标是清理计划数据，不改变产品范围，也不重新打开已完成能力。

建议动作：

1. 同步两个“全部节点已终态但 Manifest 仍为 `in_progress`”的计划状态。
2. 将历史 acceptance/regression 回执迁移到当前 schema，补齐内容指纹、合同摘要和 evidence refs，移除旧字段。
3. 解决错误的 acceptance 挂载、Deployment 设计所有权冲突，以及草案 design decision 的非标准字段。
4. 保持两个 Manifest-only 草案全量 `pending`，不把 schema 清理变成新功能执行。
5. 在通用 `manifest_tool validate` 通过后，重新确认项目结构验证、`verify:better-plan`、20 个自变异案例和 `plan:next` 仍然通过。

完成条件：通用和项目专用计划验证同时通过，且当前平台仍唯一选择节点 191。

### P0-C：正式关闭 Native Installer 与 Downstream MCP

按一个生命周期完成平台中立最终节点的 acceptance design、review、focused regression 和只读 audit。完成后依次归约 Downstream MCP 的父级集成节点和最终验收节点。

Windows 的实现、验收和父级证据继续保持 Windows 终端分支，不进入这个闭环的 prerequisites。

### P1：沿 Gateway Distribution 主链逐项闭环

保持现有依赖顺序，不并行扩大同一工作树：

1. 归约 Downstream MCP 与 Upstream Service Publishing 子计划回执。
2. 完整请求/响应生命周期容量。
3. Downstream MCP 身份与批量成本绑定。
4. Operation Permission 使用量、速率和并发配额原子预留。
5. 公平突发平滑、负载丢弃和高频 telemetry 去持久化。
6. DNS 固定连接复用、统一 endpoint admission、受限 failover。
7. Agent Gateway 强制流量保护。
8. 任意受治理 HTTP 内容的原生流与 owner-bound artifact transit。
9. 慢消费者隔离、流上界、容量与故障 profile。
10. Gateway Distribution 最终验收。

每完成一个节点，只运行其 focused verifier；全部 Gateway 节点稳定后再运行一次 Gateway owner-wide regression。

### P2：拆分并接入安全与资源治理草案

- 将 `authorization-enforcement-convergence` 按受保护 sink 或一个可观察用户场景拆分，避免单节点横跨全部授权执行面。
- 将 `algorithmic-resource-discipline` 按队列、持久化、图结构、作业投影和模型路由等独立事实所有者逐项完成。
- 只有在当前节点实现、调用方、迁移清理、focused test 和回执都完成后，才进入下一个节点。

如果在其他闭环中发现真实授权绕过、无界内存增长或数据完整性风险，该具体缺陷立即提升为 P0；这不等于把整个草案提升为当前平台的总阻塞项。

### P3：平台中立 Deployment 与 Operator Administration

先完成可验证 Server Kit、统一生命周期和隐私安全诊断，再完成平台中立 Deployment 最终验收。之后以一个真实运营场景为单位关闭 Console Administration，再关闭 Maintenance/Collaboration。

Linux container 和 Linux release acceptance 在 Linux 上单独验收；它们只影响 Linux 发布声明，不影响当前 macOS 功能提交。

### P4：匹配平台上的 OS 专属支持

Windows 和后续其他 OS 工作只在对应平台上执行。每个平台独立提交实现、测试和回执；不得要求当前平台模拟完成另一平台的产品证据。

## 六、提交与推送前的收口策略

当前数百个路径必须先按闭环拆成清晰候选，禁止整体打包提交。建议至少形成以下独立候选：

1. 计划平台隔离与 Better Plan 通用 schema 清理。
2. Native Installer 当前 macOS 归档闭环。
3. Downstream MCP 父级归约。
4. Gateway payload/capacity/forwarding 各自的最小独立闭环。
5. Authorization convergence 的独立安全闭环。
6. Algorithmic resource discipline 的逐所有者闭环。
7. Server Kit / Deployment 闭环。
8. Console Administration 和 Maintenance/Collaboration 的独立场景闭环。

每个候选必须满足：

- 只包含该闭环必要路径；不吸收其他用户或智能体改动。
- focused test 和局部 verifier 通过。
- 计划状态、回执和代码事实一致。
- 迁移没有旧入口、旧 fallback 或半迁移符号残留。
- Git 候选隐私、本地信息、hooks 和 repository residue 门禁通过。

所有预定闭环完成后再运行一次完整回归。完整回归通过、候选文件集复核完成并获得明确发布授权后，才能提交和推送。

## 七、下一步唯一建议

立即冻结范围，只处理“macOS Native Installer 真实归档修复 + Better Plan schema 清理 + Native Installer/Downstream MCP 正式验收”这一条连续主线。完成并形成可独立提交候选之前，不开始 Windows、不接入两个大型草案，也不继续扩展 Console、Deployment 或 Gateway 后续节点。

这条路线最符合当前项目需要：先把当前平台能做完的事情真正做完，使代码、计划、测试、回执和提交边界同时闭合，然后再进入下一个功能域。
