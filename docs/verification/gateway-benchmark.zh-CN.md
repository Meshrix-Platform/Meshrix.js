# 可选 Node 网关基准工具

[English](gateway-benchmark.md)。独立私有工具位于兄弟仓库的
`Meshrix.js-Benchmark/packages/node-benchmark`，不是 Meshrix.js 产品工作区、
根依赖、部署阶段或发布门槛。

## 强制顺序：先确认 Meshrix 可用，再做基准与性能优化

必须先取得**同一候选、相关运行配置**下的真实功能证据：

1. 真实后端通过受支持入口启动、就绪，并完成一个代表性授权操作。
2. 在浏览器中打开真实 Console，确认资源、认证、渲染正常；实际执行一个访问
   同一后端的 UI 操作，并看到正确结果。只检查页面 HTTP 200 不算通过。
3. 用标准 MCP 客户端，经真实 Meshrix 请求可控上游，确认协议与结果正确。
4. 确认服务结算、关闭正常；记录候选、配置、检查、观察结果及脱敏证据位置，
   分别标明 passed / failed / not_run / blocked。

构建、类型检查、健康接口、Mock 测试、工具自测、npm／归档检查及镜像构建，
都不能替代这些证据。仅运行源 CLI 也不能证明 Console 与后端可用；独立工具仓库
和 `fixture` 名称不构成例外。证据缺失、失败或过期时，暂停基准开发／验证、
负载实验和性能优化，先在授权范围内诊断或修复功能。影响启动、前后端接线、
协议或配置的变更须重新取得受影响的功能证据；不能与依赖它的性能工作并行。

这是一项执行前置规则，不表示 benchmark CLI 已自动检查前端。它不要求每步
重跑全量回归；完整回归与终审仍位于功能验证、获准的性能工作之后。详见
[仓库规则](../../AGENTS.md#functional-availability-before-benchmarking-and-optimization)。
只有满足此前置条件，才可继续下面的工具安装、验证和实验流程。

## 开发侧显式安装与使用

先在独立包目录运行
`npm pack --json --ignore-scripts --pack-destination <本地工件目录>`；再在
Meshrix.js 根目录明确安装
`npm install --prefix .cache/gateway-benchmark --save-dev --ignore-scripts --no-audit --no-fund
<本地工件目录>/meshrix-node-benchmark-0.1.0.tgz`。该前缀被忽略，不修改产品
根锁文件。`npm run gateway:benchmark -- --help` 不装载工具；默认运行只给
`evaluated:false` 计划视图，绝不伪造延迟。仅 `npm run gateway:benchmark --
--evaluate --profile standard --output build/reports/gateway-benchmark.json`
进行标准实验。

标准实验需产品可执行输入无脏改动、两仓已提交，并通过环境变量
`MESHRIX_BENCHMARK_TOOL_COMMIT=<独立包的40位提交号>` 提供打包版本出处；
禁止把未提交源码测量标成已提交标准结果。缺包会在启动子进程之前失败，
不会从兄弟源码回退或自动安装。`fixture` 只用于极短的正确性检查。

生成器、原样启动的网关 CLI 和模拟上游在独立进程中交换现代 MCP 消息；
直连和经网关均校验动态回复及独立上游效果。源 CLI 单一只读工具场景不等于
已安装产品或完整平台验收。预定到达是有限、按单调时钟等间隔的：调度错过
计为生成器损失，并发满计为客户端预算损失；没有补发积压。成功 RTT 从创建
HTTP 请求到完整接收响应，随后校验通过才纳入统计；校验耗时不计入 RTT，
未返回或超时不补造样本。标准初始负载上限
每秒 100 次、并发不超过 16，只是有界观测，不是最大吞吐量、性能 SLO 或
既有百分比门槛。逐轮直连/网关差异不能当作纯网关服务耗时。

报告仅保留非识别性的硬件可用量与汇总统计；实际频率、物理核、独占配额
未知，不记录地址、端口、凭据、原始载荷、子进程日志或私有路径。错误及强制
清理、观察缺口均应保持限定。`test:gateway-benchmark` 检查独立包和短真实
网关流程；`test:gateway-benchmark:distribution` 检查实际构建、npm/source
工件。最终镜像与 runtime-ui 的文件和保留层必须从已提交候选实际检查，
不能仅凭文件规则或 Dockerfile 作证。以上结论不替代独立 PR 验收审查。
