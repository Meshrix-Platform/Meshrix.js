<div align="center">

<img src="docs/banner.svg" alt="Meshrix.js" width="100%" />

**用于构建受治理 HTTP 与 MCP 服务的开源 TypeScript 和 Node.js 框架。**

[![源码许可证：Apache-2.0](https://img.shields.io/badge/%E6%BA%90%E7%A0%81%E8%AE%B8%E5%8F%AF%E8%AF%81-Apache--2.0-c9a96e?style=flat-square)](LICENSE)
[![Node.js >=22.19.0 <23 || >=24.3.0 <25](https://img.shields.io/badge/node-%3E%3D22.19.0%20%3C23%20%7C%7C%20%3E%3D24.3.0%20%3C25-4fc3f7?style=flat-square)](package.json)
[![Status: pre-release](https://img.shields.io/badge/status-pre--release-a78bfa?style=flat-square)](CHANGELOG.md)

[概览](#概览) · [当前状态](docs/STATUS.md) · [快速开始](#快速开始) · [架构](#架构) · [文档](docs/README.md) · [运维手册](docs/RUNBOOK.md) · **[English](README.md)**

</div>

本文件是 [README.md](README.md) 的本地化版本。英文是本仓库文档的规范语言，简体中文为本地化语言版本；如有歧义，以英文规范版本为准。

> **核心可信转发要求：身份可验证、权限不放大、内容不篡改、过程可追溯。**
> 其规范含义由
> [Governed Execution And Minimum Evidence](docs/architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md)
> 统一定义。

---

## 概览

Meshrix.js 使用 Vue.js Web Console 与 Node.js 服务端。前后端分别维护，
通过版本化 HTTP 边界通信。服务端负责转发配置声明的上游服务，并向下游智能体
客户端提供受治理的 MCP 入口。运维方在自己的部署环境内声明服务与能力；每一次
执行都先通过认证、授权、Operation Permission、标签策略、审批与流控，并留下审计证据。

默认运行时自包含。元数据、raw objects、任务、设置、grant、审计记录和 checkpoint 存放在服务端数据目录。外部中间件和服务适配器作为面向特定部署集成的可选增强。

> **发布状态：pre-release。** 首个 npm 版本尚未发布。公开包必须从未修改的
> release tarball 安装，并针对确切候选验证后才能发布。下文源码检出命令
> 不代表 npm 包或部署环境已经通过验证。详见 [Status](docs/STATUS.md) 和
> [发布契约](docs/RUNBOOK.md#release-definition-and-publication)。

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

服务端运行时组合配置、operation 暴露、权限决策、执行调度、审计、指标与有界证据。控制台、HTTP API 与 MCP 入口共用一个公开 origin。包分层、核心流程与部署边界详见[架构文档](docs/architecture/ARCHITECTURE.md)。

## 快速开始

要求 Node.js `>=22.19.0 <23 || >=24.3.0 <25`。

**从源码检出运行**

```bash
npm ci
npm run dev
```

开发服务器默认监听 `http://127.0.0.1:7228`。

**安装首个 npm 版本**

```bash
npm install --global meshrix.js
meshrix-server --help
meshrix --help
```

这些 npm 命令描述发布后的使用路径。目前包尚未发布到公共 registry；首发前，
会从确切 release tarball 验证安装和启动。支持的 npm 产品只有 `meshrix.js` 与
`@meshrix/gateway`；控制台、连接器和第一方客户端适配器随 `meshrix.js` 提供，
其它工作区是内部实现边界，不单独发布为 npm 产品。

首发后，可从同一个 origin 启动打包的 Console 与服务端：

```bash
meshrix-server --with-ui --data-dir <server-data-dir>
```

默认监听地址为 `http://127.0.0.1:7228`；Console 位于 `/`，API 位于 `/api/`，
MCP 客户端使用同一 origin。要从 loopback 以外访问，必须配置 TLS 终止代理和
精确的 trusted-proxy 地址，详见[运行手册](docs/RUNBOOK.md#container-startup)。

**容器启动**

```bash
docker compose up -d
```

仓库内的 Compose 文件默认在 loopback 上启动 API，并将运行数据保存在容器卷中。
默认配置只提供 API；要提供 Console，必须使用构建好的 Console bundle 和
`--with-ui` 参数。公开访问时应配置 HTTPS 转发与 trusted-proxy 地址。Secret
Store 主密钥和 operation 证明签名密钥应分别保存在 Meshrix.js 数据目录与备份之外，
由部署环境单独管理。

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

客户端通过标准 MCP 协议和 operation grant 接入。可选客户端适配器独立打包并显式启用；
Core MCP 授权不依赖客户端产品名称。确切范围与状态见[兼容性](docs/COMPATIBILITY.md)与
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
| 框架范围与架构目标 | [PRODUCT.md](PRODUCT.md) |
| 领域词汇 | [CONTEXT.md](CONTEXT.md) |
| 当前状态 | [docs/STATUS.md](docs/STATUS.md) |
| 文档索引 | [docs/README.md](docs/README.md) |
| 架构 | [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) |
| 协议 | [docs/protocols/PROTOCOLS.md](docs/protocols/PROTOCOLS.md) |
| 运行运维 | [docs/RUNBOOK.md](docs/RUNBOOK.md) |
| 兼容性 | [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) |
| 发布状态 | [docs/releases/README.md](docs/releases/README.md) |
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
npm run verify:acceptance
```

发布流程还会在隔离消费者中安装每个目标 npm 包的确切、未修改 tarball。
源码检查通过本身不代表 npm 包或平台运行环境已通过验收。

## 项目

| 主题 | 文档 |
| --- | --- |
| 贡献流程 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 行为准则 | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |
| 安全策略 | [SECURITY.md](SECURITY.md) |
| 第三方声明 | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
| 变更日志 | [CHANGELOG.md](CHANGELOG.md) |

## 源码许可证

Meshrix.js 项目拥有的源码采用 Apache-2.0 许可证，详见 [LICENSE](LICENSE)。第三方依赖保留其 package
metadata 与[第三方声明](THIRD_PARTY_NOTICES.md)中列出的各自条款。

<div align="center">
  <sub>Meshrix.js —— 一个受治理的运行时，明确的扩展边界。</sub>
</div>

## 可嵌入 Gateway 内核

`@meshrix/gateway` 是独立的 programmable MCP gateway。它不要求 Console、
Agent、插件或 SkillHub 才能启动。符合协议的 MCP 客户端可以根据声明的协议
和授权能力连接，无需基于产品名称的身份 allowlist。现代 MCP 使用 `2026-07-28`，旧版本规则由隔离
适配器单独负责。实现与样例见 [Gateway 架构](docs/architecture/gateway.md)、
[协议边界](docs/protocols/gateway.md) 和 [Gateway 样例](docs/examples/gateway/README.md)。
