<div align="center">

<img src="docs/banner.svg" alt="Meshrix.js" width="100%" />

**内部维护、私有化部署的智能体网关 —— 上游服务由此进，受治理的 MCP 访问由此出。**

[![License: MIT](https://img.shields.io/badge/license-MIT-c9a96e?style=flat-square)](LICENSE)
[![Node.js ^22 || ^24](https://img.shields.io/badge/node-%5E22.0.0%20%7C%7C%20%5E24.0.0-4fc3f7?style=flat-square)](package.json)
[![Status: pre-release](https://img.shields.io/badge/status-pre--release-a78bfa?style=flat-square)](CHANGELOG.md)

[概览](#概览) · [当前状态](docs/STATUS.md) · [产品路线](docs/WHATS-NEXT.md) · [快速开始](#快速开始) · [架构](#架构) · [文档](docs/README.md) · [运维手册](docs/RUNBOOK.md) · **[English](README.md)**

</div>

本文件是 [README.md](README.md) 的本地化版本。英文是本仓库文档的规范语言，简体中文为本地化语言版本；如有歧义，以英文规范版本为准。

> **核心可信转发要求：身份可验证、权限不放大、内容不篡改、过程可追溯。**
> 其规范含义由
> [Governed Execution And Minimum Evidence](docs/architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md)
> 统一定义。

> **当前目标：** Meshrix.js 正通过四条必需工作流闭环一个企业单节点功能候选，详见
> [What's Next](docs/WHATS-NEXT.md)。开始规划、实现或评审项目工作前，请先查看该文档。

---

## 概览

Meshrix.js 使用 Vue.js Web Console 与 Node.js 服务端。前后端分别维护，
通过版本化 HTTP 边界通信。服务端负责转发配置声明的上游服务，并向下游智能体
客户端提供受治理的 MCP 入口。运维方在自己的部署环境内声明服务与能力；每一次
执行都先通过认证、授权、Operation Permission、标签策略、审批与流控，并留下审计证据。

默认运行时自包含。元数据、raw objects、任务、设置、grant、审计记录和 checkpoint 存放在服务端数据目录。外部中间件和服务适配器作为面向特定部署集成的可选增强。

> **当前状态：pre-release。** 源码可用、实现、验证、各发布渠道、环境支持与托管
> 运营是彼此独立的事实。规范状态见 [Status](docs/STATUS.md)。

Meshrix.js 将强制的功能验收与可选的环境声明严格分开。
`npm run verify:acceptance` 是 Functional Release Gate（功能完整有效发布门禁），
必须在发布前通过。通过门禁的不可变候选版本可以继续运行
`npm run verify:real-machine -- ...`；这一可重复执行的 Real-Machine
Verification Workflow（真机验证工作流）只为一个确切系统或部署建立
Environment Support Claim（环境支持声明）。真机是否可用、是否执行或执行失败，
都不会阻断或改变功能验收结果。完整契约见
[发布定义](docs/RUNBOOK.md#release-definition-and-publication)。

本文是规范性[英文项目概览](README.md)的简体中文本地化版本。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| **上游服务网关** | 上游服务转发：通过服务端配置声明外部 HTTP/MCP 服务，并以受治理的 operation 入口对外暴露。 |
| **下游 MCP** | 面向智能体客户端的 discovery 与受治理 gateway MCP 出口；operation 可见性由 grant 控制。 |
| **Operation Permission** | Operation 目录、operation group、scope、grant、策略预览、审批、统一执行路径、审计与指标。 |
| **通用标签策略** | 同一套标签模型覆盖 operation、资源、文档、智能体、上游服务、工作空间与组织对象。 |
| **已验证插件运行时** | 单插件包经由统一的验证、接管、激活、回滚与贡献事务边界完成安装。 |
| **外部服务 Host** | 为已配置的插件服务绑定执行 operation 级 HTTP/MCP 请求——插件不会获得凭据或传输层内部对象。 |
| **工作空间资产** | 工作空间文件、上传、下载、历史、checkpoint、恢复，以及面向可选插件的受治理 Host capability。 |
| **Agent Gateway** | 通过服务端代理调用已配置的模型智能体，具备路由健康状态与调用证据。 |
| **运维与可观测** | 运行状态、日志、健康检查、后台任务、存储维护、备份恢复、审计查询与发布证据。 |

## 架构

<div align="center">
  <img src="docs/architecture-overview.svg" alt="Meshrix.js architecture overview" width="680" />
</div>

Meshrix.js 的产品边界是私有化部署中的服务端治理层：它拥有配置、operation 暴露、权限决策、执行调度、审计、指标与证据生成。包分层、核心流程与部署边界详见[架构文档](docs/architecture/ARCHITECTURE.md)。

## 快速开始

要求 Node.js `^22.0.0 || ^24.0.0`。

**本地运行**

```bash
npm install
npm run dev
```

服务默认监听 `http://127.0.0.1:7228`。

**服务模式**

```bash
npm run server:start
```

**容器启动**

```bash
docker compose up -d
```

仓库内的 compose 文件默认在 loopback 上启动 API 服务，并把运行数据写入容器卷。该路径默认只提供 API；如需由服务端提供控制台页面，需要先构建控制台产物并使用 server `--with-ui` 路径。

云上生产部署需要把 `docker-compose.enterprise.yml` 与基础文件叠加使用，并提供摘要固定的镜像、HTTPS 公网基准 URL、反向代理的精确来源 IP、独立备份挂载、独立托管的 32 字节本地 Secret Store 主密钥，以及另一份不同的 32 字节操作证据签名密钥。具体命令见[生产容器运行手册](docs/RUNBOOK.md#container-startup)；缺少任一安全输入时生产叠加层会失效关闭。

## 运维

```bash
npm run server:doctor
npm run server:locate
npm run server:reconcile
npm run mcp:doctor
```

| 变量 | 用途 |
| --- | --- |
| `MESHRIX_SERVER_DATA_DIR` | 指定部署数据目录存放运行状态。 |
| `MESHRIX_SERVER_HOST` | 服务监听地址。 |
| `MESHRIX_SERVER_PORT` | 服务监听端口。 |
| `MESHRIX_PUBLIC_BASE_URL` | 由管理员 TLS 反向代理对外公布的 HTTPS URL。 |
| `MESHRIX_TRUSTED_PROXIES` | 管理员 TLS 反向代理访问 Meshrix.js 时使用的精确来源 IP 列表。 |
| `MESHRIX_LOCAL_SECRET_MASTER_KEY_SOURCE` | 生产 Secret Store 密钥的绝对宿主机路径；不得放入 Meshrix.js 数据或备份卷。 |
| `MESHRIX_OPERATION_PROOF_SIGNER_SECRET_SOURCE` | 独立的生产证据签名密钥绝对宿主机路径；不得与 Secret Store 主密钥相同，也不得放入数据或备份卷。 |

## 下游智能体客户端

智能体客户端通过 MCP discovery 与受治理的 gateway 调用接入；operation 可见性
由 grant 控制。仓库内已实现 OpenClaw、Codex、Claude Code、Antigravity、
OpenCode、Kimi 和 Pi 适配器；适配器必须由运维方显式启用，运行时不会从其它源码
仓库发现或加载实现。确切范围与状态见[兼容性](docs/COMPATIBILITY.md)与
[协议](docs/protocols/PROTOCOLS.md)文档。

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| `apps/` | 服务端入口、控制台应用和 MCP gateway installer package。 |
| `packages/` | contracts、foundation、workspace、agents、capabilities、protocols、server runtime 和 UI console package。 |
| `services/` | 仓库内服务实现，包括格式转换服务。 |
| `plugins/` | 仓库内运行时插件、客户端适配器、manifest 与 schema。 |
| `tools/` | 服务端脚本、验证器、生成器和 registry 工具。 |
| `docs/` | 公开运行、架构、协议、兼容性和功能文档。 |
| `tests/` | 仓库验证套件。 |

## 文档

| 主题 | 文档 |
| --- | --- |
| 产品闭环路线 | [docs/WHATS-NEXT.md](docs/WHATS-NEXT.md) |
| 产品目标与边界 | [PRODUCT.md](PRODUCT.md) |
| 领域词汇 | [CONTEXT.md](CONTEXT.md) |
| 当前状态 | [docs/STATUS.md](docs/STATUS.md) |
| 文档索引 | [docs/README.md](docs/README.md) |
| 架构 | [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) |
| 协议 | [docs/protocols/PROTOCOLS.md](docs/protocols/PROTOCOLS.md) |
| 运行运维 | [docs/RUNBOOK.md](docs/RUNBOOK.md) |
| 兼容性 | [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) |
| 能力文档 | [docs/functionality/](docs/functionality/) |
| 示例 | [docs/examples/README.md](docs/examples/README.md) |
| 决策记录 | [docs/adrs/README.md](docs/adrs/README.md) |

## 验证

运行完整本地仓库验证门禁：

```bash
npm run verify
```

聚焦命令：

```bash
npm run typecheck
npm run build
npm test
npm run verify:core-platform-surface-convergence
npm run verify:private-deployment-internal-platform-e2e
npm run verify:acceptance
```

## 项目

| 主题 | 文档 |
| --- | --- |
| 贡献流程 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 行为准则 | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |
| 安全策略 | [SECURITY.md](SECURITY.md) |
| 变更日志 | [CHANGELOG.md](CHANGELOG.md) |

## 许可证

MIT。参见 [LICENSE](LICENSE)。

<div align="center">
  <sub>Meshrix.js —— 默认自包含，为私有化部署而生。</sub>
</div>
