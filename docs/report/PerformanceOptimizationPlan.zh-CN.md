# LicoMesh 性能治理与可观测压测方案

> 状态：本地临时工作报告。本文描述待实施设计、验证顺序和当前工具边界，不属于 Better Plan 权威文件或远端发布内容，也不构成已实现能力或平台发布就绪声明。

## 1. 目标与边界

本方案的目标不是给出脱离硬件、运行时和工作负载的单一 QPS 数字，而是建立一条可重复的性能治理闭环：

1. 使用合成数据和隔离运行目录启动全新服务进程；
2. 用与服务分离的驱动进程产生可声明的负载；
3. 同时观测请求、事件循环、CPU、内存、GC、队列、连接、存储和日志；
4. 将观测值归约成有边界、可比较、隐私安全的报告；
5. 先定位主要成本，再按独立功能闭环逐项优化；
6. 每项优化完成后执行局部回归，所有改动完成后只执行一次完整回归。

本方案不读取生产数据，不向外部服务发压，不保留请求或响应正文，不在报告中记录地址、端口、进程号、路径、租户、用户或凭据，也不从一次本地运行推导通用生产容量。

## 2. 当前判断

LicoMesh 已经具备较好的性能基础：路由使用 trie 和 Map，目录快照可缓存并原子替换；队列具有容量、公平、租约、背压和保留策略；SQLite 使用 WAL；日志、指标和报告正在形成明确的资源上限。

当前优先级最高的成本集中在四条热路径：

1. 网关成功和失败路径存在同步状态读取、合并和整文件重写；
2. HTTP 指标逐请求同步写入 SQLite；
3. DNS 固定的上游请求逐次创建和关闭连接调度器，无法充分复用连接；
4. 端点选择的虚拟权重循环可能把一次选择放大为与权重总和和端点数乘积相关的工作。

现有 MCP 压力脚本能够证明小规模请求完成和资源安全截止，但驱动、fixture 和服务处于同一进程，默认负载较小，并且没有用吞吐、P99、公平性或恢复时间作容量判定。因此它应被定义为压力冒烟，而不是容量认证。

## 3. 证据分层

| 证据 | 用途 | 必须观察 | 不允许声称 |
| --- | --- | --- | --- |
| 观测型冒烟 | 快速发现明显回归，验证探针和报告链路 | 完成数、错误、P50/P95、CPU、RSS、heap、ELU、事件循环延迟、GC | 生产容量、硬件无关 QPS、平台就绪 |
| 容量画像 | 找到声明环境中的持续容量和拐点 | 开环速率、P95/P99、调度迟滞、错误率、公平性、资源和队列等待 | 其他硬件或其他配置的容量 |
| 内存泄漏门禁 | 发现重复工作后的保留增长 | 强制 GC 后 heap、pprof live bytes、RSS、external、日志和磁盘斜率 | 仅凭一次 RSS 采样宣称无泄漏 |
| 故障画像 | 验证过载、慢端、失败和恢复行为 | 拒绝原因、重试放大、熔断、恢复时间、资源回落、清理 | 将预期拒绝误算为系统错误 |

四种证据分别生成报告。只有平台验收归约器能够组合它们；任一子报告都不能自行提升为发布就绪结论。

## 4. 压测与观测架构

```text
lico-dev workflow
  └─ 场景控制器
      ├─ 独立负载驱动进程
      ├─ 独立合成 fixture 进程
      ├─ 全新 LicoMesh 服务进程
      │   └─ 只发送数值聚合的运行时观测探针
      └─ 独立归约器
          └─ 有界、脱敏、原子替换的报告
```

### 4.1 负载驱动

容量画像采用开环调度：按目标到达时间发起请求，而不是等待上一批完成后继续。驱动同时设置最大在途数、最大请求数、最大时长、最大响应字节和单请求超时。超过在途上限时记录 `driver_overflow`，不得无限排队。

每个请求至少记录完成状态和延迟直方图；不得保留每次请求的原始对象数组。直方图使用固定精度和固定范围，并同时记录计划发送时间与实际发送时间的差值，从而暴露调度迟滞。完整容量实现需要像 Autocannon 一样关注 coordinated omission，并像 Fastify 的公开基准一样分离预热和正式测量轮次。

参考：

- [Node.js perf_hooks](https://nodejs.org/api/perf_hooks.html)
- [Autocannon](https://github.com/mcollina/autocannon)
- [Fastify benchmarks](https://github.com/fastify/benchmarks)

### 4.2 服务端运行时探针

探针通过 Node 预加载模块进入被测进程，通过私有 IPC 仅发送有界数值快照：

- `monitorEventLoopDelay`：P50、P95、P99、最大值；
- `eventLoopUtilization`：区间利用率和峰值；
- `process.cpuUsage`：区间 CPU/墙钟比；
- `process.memoryUsage`：RSS、heapUsed、external、arrayBuffers；
- `PerformanceObserver('gc')`：GC 次数、总时长和最大时长；
- 采样覆盖率、丢弃采样数和探针自身错误码。

探针按固定间隔重置区间直方图，父进程只保留固定数量的聚合样本。探针不得发送堆栈、环境变量、URL、路径、进程号或业务内容。

### 4.3 领域观测

容量画像最终还需要接入以下低基数指标：

- 遥测缓冲：当前深度、批量大小、刷新耗时、聚合数、丢弃数；
- 传输池：活动连接、空闲连接、等待租约、复用命中、DNS generation 淘汰；
- 端点选择：选择次数、在途数、拒绝原因、熔断状态、恢复探测；
- SQLite：事务批量、写入耗时、busy 次数、WAL 大小和 checkpoint 耗时；
- 队列：排队深度、等待 P95/P99、租约超时、公平性和背压拒绝；
- 日志与持久化：字节增长、记录增长、文件增长和压缩耗时。

所有标签必须来自固定词汇表。请求 ID、路径、主机、URL、用户、租户、Grant、payload 和异常正文不得成为指标标签。

## 5. SLO 与比较方法

每个性能配置必须声明运行时版本、逻辑 CPU 数、内存等级、场景、并发、目标速率、预热时长、测量时长和功能配置，但公开报告只保留不含机器身份的有限环境分类。

判定顺序固定为：

1. **工作负载完整性**：计划请求数、完成数、预期状态和 fixture 命中必须一致；
2. **安全截止**：RSS、CPU、事件循环延迟、输出和持续时间超过硬上限立即停止；
3. **场景语义**：正常场景无意外失败；过载场景必须以稳定原因拒绝；故障场景不得重试放大；
4. **延迟和吞吐**：在声明速率下检查 P95/P99、调度迟滞和有效吞吐；
5. **公平性**：比较租户或流量类别的服务份额、等待时间和拒绝比例；
6. **资源回落**：停止负载后，队列、连接、heap、日志和磁盘必须回到有界状态；
7. **相对回归**：只在相同环境分类和相同配置间比较，报告绝对值和相对变化。

初次引入工具时，只把工作负载完整性、观测覆盖和资源安全作为硬门禁。吞吐和 P99 阈值必须来自多轮干净基线的校准，不能为了让失败通过而临时提高。

## 6. 热路径解决方案

### 6.1 有界网关遥测

将安全审计和性能遥测拆成两条不同可靠性链路：

- 安全审计保留可靠、可追责的持久化语义，但对重复事件做稳定去重和保留控制；
- 普通成功计数、延迟和流控结果进入预注册的低基数聚合器，不逐请求写文件或数据库；
- 计数器和直方图按固定 key 预分配，热路径更新为 O(1)，避免复制、排序和 JSON 序列化；
- 少量必须保留的离散事件进入固定容量环形缓冲；
- 单一刷新器按“最大批量或最长等待时间”触发，用 prepared statements 在一个事务中提交；
- 同一时刻只允许一个 flush，失败采用有界退避；缓冲满时按类型聚合或丢弃普通遥测，绝不阻塞业务请求；
- 报告 `accepted`、`aggregated`、`shed` 和 `flush_failed`，从而让遥测丢弃本身可见。

迁移必须一次完成：所有调用方切换到新端口后，删除旧的逐请求 runtime JSON 读写、逐请求指标插入、兼容入口和对应文档。

### 6.2 DNS 固定连接池

使用一个有界的 leased transport pool 代替逐请求 Agent：

- key 由 origin、DNS address-set generation、TLS policy identity 和非秘密 credential scope identity 组成；
- entry 状态为 `active`、`retiring`、`closed`，并维护租约数、最近使用时间和创建 generation；
- DNS 集合或 TLS 策略改变时，旧 entry 进入 `retiring`，不再接收新租约，现有请求完成后关闭；
- 使用固定最大 entry 数、每 origin 最大连接数、最大等待者数、空闲 TTL 和关闭期限；
- 池满时先淘汰无租约的 LRU entry；没有安全淘汰对象时快速返回稳定的容量错误；
- 取消、超时和流关闭从一个 terminal path 归还租约，防止双重释放。

连接复用不能弱化现有 SSRF、全地址 DNS 审查、地址固定、TLS 和凭据隔离。Undici 的 Dispatcher/Agent/Pool 模型用于对照其连接复用与背压语义。[Undici Dispatcher](https://github.com/nodejs/undici/blob/main/docs/docs/api/Dispatcher.md)

### 6.3 有界端点选择器

把当前按虚拟权重展开的选择逻辑迁移为一个共享 forwarding snapshot：

- 端点存入紧凑不可变数组；配置更新在请求外编译并原子替换；
- 静态权重轮转使用 smooth weighted round-robin，每次 O(N)，复杂度不受权重数值放大；
- 需要负载反馈时使用 weighted least-request 或 power-of-two choices，并维护每端点在途数；
- affinity 使用有容量和 TTL 的缓存，miss 时重新计算，不复制整份端点集合；
- admission、选择、在途计数、结果分类、熔断和恢复共用一个状态所有者；
- authorization、schema、credential、cancellation 和已提交写请求失败不得自动重试。

Envoy 的 least-request 设计可作为 active-request bias 和有效权重缓存的对照实现。[Envoy least request](https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/load_balancing_policies/least_request/v3/least_request.proto)

### 6.4 SQLite 写入边界

SQLite 保留为单机默认实现，但将高频遥测写入移出 Node 主事件循环：

- 通过单一 writer worker 接收有界批量；
- 复用 prepared statements，在一个事务中写一批聚合记录；
- 读取继续使用短事务，禁止在网络等待期间持有事务；
- 观测 busy、事务时长、WAL 字节和 checkpoint；
- 设置批量、队列、WAL、checkpoint 和关闭期限；
- 多副本或持续写争用场景切换到现有 PostgreSQL 适配，而不是继续提高本地并发上限。

SQLite WAL 允许读写并发，但仍只有一个 writer；checkpoint 也会影响延迟，因此必须把这些边界纳入容量画像。[SQLite WAL](https://sqlite.org/wal.html)

### 6.5 内存、日志与磁盘

现有 real-service memory gate 继续作为独立发布门禁：完整服务预热后执行至少五轮代表性工作，支持时强制 GC，并同时检查 heap、pprof live allocations、external、RSS、日志和持久化增长。

当前健康检查负载只能证明基础运行时。后续分别添加网关转发、队列周转、事件总线、上传流和插件启停场景；每个场景都使用同一 profiler 和 Theil-Sen 斜率归约器，避免为不同模块维护互相矛盾的泄漏判定。

### 6.6 Console 性能

Console 保留现有路由懒加载和分包，并补充两个独立门禁：

- 构建门禁：入口 chunk、共享 vendor 和单路由 chunk 的压缩后大小预算；
- 浏览器门禁：固定设备档位下的 LCP、INP、CLS 和长任务预算。

前端性能证据不得与服务端容量报告混合；只有两者各自通过后才能形成完整用户体验结论。

## 7. 场景矩阵

| 场景 | 负载形态 | 主要判定 |
| --- | --- | --- |
| sustained | 逐级提高固定到达率并保持 | 有效吞吐、P95/P99、ELU、CPU、RSS、队列 |
| burst | 基线后短时高峰再回落 | admission、恢复时间、资源回落 |
| noisy-neighbor | 两个身份不同比例争用 | 服务份额、等待和拒绝公平性 |
| slow-client | 限速读取或长时间不消费 | 在途上限、流背压、清理 |
| oversized | 边界内外的请求和响应 | 早期拒绝、无大对象保留 |
| upstream-failure | 连接失败、超时、错误响应 | 分类、熔断、无重试放大 |
| restart | 负载中受控重启 | 租约回收、恢复时间、无重复提交 |
| shared-quota | 多副本共享预算 | 原子配额、全局公平、局部突发边界 |

## 8. 分阶段实施

| 阶段 | 独立闭环 | 主要交付 | 局部验证 |
| --- | --- | --- | --- |
| T0 | 可观测压测入口 | `lico-performance-load-testing` 技能、观测型 MCP 冒烟、工作流注册 | reducer 单测、探针 IPC 测试、工作流 doctor |
| T1 | 遥测移出热路径 | 有界聚合器、批量 writer、完整旧路径删除 | 缓冲溢出、批量、关闭、失败恢复测试 |
| T2 | 连接复用 | DNS/TLS 感知 leased pool | 复用、DNS 变化、池满、取消、关闭测试 |
| T3 | 选择与 admission 收敛 | 共享 forwarding snapshot 和有界选择器 | 权重、公平、复杂度、在途和迁移测试 |
| T4 | 存储写入边界 | SQLite writer worker 和规模切换规则 | busy、WAL、checkpoint、批量和关闭测试 |
| T5 | 容量与故障画像 | 独立驱动、fresh server、完整场景矩阵和 reducer | `gateway.capacity` 聚焦套件 |
| T6 | Console 性能预算 | bundle 与 Web Vitals 门禁 | 构建预算和浏览器性能测试 |

每个阶段只修改本阶段拥有的模块，完成上下游迁移并通过局部验证后再开始下一阶段。T5 完成前，T0 的结果始终标记为 `observed_smoke`，不得标记为 `capacity_certified`。

## 9. 本轮新增工具的使用契约

本轮先交付 T0，使后续开发能够直接执行：

```sh
lico-dev workflow plan performance-observed
lico-dev workflow run performance-observed --allow-side-effects

lico-dev workflow plan memory-leaks
lico-dev workflow run memory-leaks --allow-side-effects
```

`performance-observed` 启动一个父级观测器，在不修改现有 MCP 压力脚本的前提下，将它放入独立子进程并注入运行时探针。结果包含现有阶段完成、吞吐和 P50/P95，以及进程级 CPU、内存、ELU、事件循环延迟和 GC 聚合。由于服务、fixture 和负载驱动仍在该子进程内，报告明确记录 `capacityCertified: false`。

该入口用于快速对比改动前后和验证观测链路，不替代 T5 的独立容量画像。

## 10. 验收条件

T0 完成必须同时满足：

1. 技能能够从“压测、容量、P99、ELU、性能回归”等请求触发；
2. 工作流计划阶段只读，并明确要求 `runtime-data` 授权；
3. 观测探针只发送固定 schema 的有界数值数据；
4. 父进程限制样本数、子进程输出、执行时长和报告字节；
5. 子进程失败、超时、观测缺失、工作负载不完整或资源截止都会使报告失败；
6. 报告原子替换，不包含路径、地址、端口、进程号、token 或请求内容；
7. 报告声明它是观测型冒烟并且 `capacityCertified` 为 `false`；
8. Core 局部测试、Devkit 技能 doctor、工作流测试、技能锁和 Better Plan 校验通过。

## 11. 风险与回退

- 探针本身会消耗少量 CPU；报告必须记录采样间隔和覆盖率，并通过无探针对照量化开销。
- GC PerformanceObserver 的可用性取决于 Node 运行时；不支持时必须给出稳定原因，不能静默伪造零值。
- 观测型冒烟包含驱动成本，不能拿它确定服务器容量；T5 必须使用独立进程边界。
- 任一优化若改变授权、重试、审计或流语义，应首先回退该独立阶段，而不是保留双实现兼容层。
- 原始性能数据和失败剖析只存在于每次运行的私有临时目录，普通运行结束时删除；工具依赖缓存不得被清理。
