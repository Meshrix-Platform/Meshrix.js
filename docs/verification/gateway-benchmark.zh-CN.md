# 可选 Node 网关基准工具

[English](gateway-benchmark.md)。独立私有工具位于兄弟仓库的
`Meshrix.js-Benchmark/packages/node-benchmark`，不是 Meshrix.js 产品工作区、
根依赖、部署阶段或发布门槛。先在独立包目录运行
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
HTTP 请求到完整响应校验，未返回或超时不补造样本。标准初始负载上限
每秒 100 次、并发不超过 16，只是有界观测，不是最大吞吐量、性能 SLO 或
既有百分比门槛。逐轮直连/网关差异不能当作纯网关服务耗时。

报告仅保留非识别性的硬件可用量与汇总统计；实际频率、物理核、独占配额
未知，不记录地址、端口、凭据、原始载荷、子进程日志或私有路径。错误及强制
清理、观察缺口均应保持限定。`test:gateway-benchmark` 检查独立包和短真实
网关流程；`test:gateway-benchmark:distribution` 检查实际构建、npm/source
工件。最终镜像与 runtime-ui 的文件和保留层必须从已提交候选实际检查，
不能仅凭文件规则或 Dockerfile 作证。以上结论不替代独立 PR 验收审查。
