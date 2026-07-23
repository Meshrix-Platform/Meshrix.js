# LicoMesh

LicoMesh 是开源、私有化部署的中转网关平台。它以 Node.js 服务端运行，负责转发服务端配置文件声明的上游服务，并向下游智能体客户端提供受治理的 MCP 入口。

当前状态：pre-release。源码可用和许可证状态独立于正式生产版本标签。

默认运行时自包含。元数据、raw objects、任务、设置、grant、审计记录和 checkpoint 存放在服务端数据目录。外部中间件和服务适配器作为面向特定部署集成的可选增强。

## 当前能力

| 领域 | 当前范围 |
| --- | --- |
| 上游服务转发 | 运维方通过服务端配置声明 HTTP 上游、受治理转发、策略预览、审批处理、审计和流控。 |
| 下游 MCP | 提供 discovery 和受治理的 gateway MCP 入口；operation 可见性由 grant 控制。 |
| Operation Permission | Operation 目录、operation group、grant、policy preview/evaluate、统一执行路径、审计记录和指标。 |
| 通用标签策略 | 面向 operation 和资源的通用标签，在 grant 或执行前进行 allow/deny 策略评估。 |
| 已验证插件 | 运维方显式安装并启用的单插件包，可通过公共插件契约贡献 operation、route、MCP tool、预编译控制台资产和状态机。 |
| 外部服务 Host | 已授权的插件 operation 可以调用显式配置的外部 HTTP 或 MCP 服务，插件不会获得凭据或传输层内部对象。 |
| 工作空间资产 | Core 提供工作空间元数据、文件、上传、checkpoint、授权、路径边界和受控执行 Host capability。 |
| 审计、审批、可观测 | 审批状态、operation audit、运行日志、trace metadata、健康检查和存储维护工具。 |
| 存储、任务、运行时 | 本地 metadata store、raw object storage、upload session、后台任务、settings、runtime composition 和 HTTP/RPC 接口。 |

## 部署

运行要求以 `package.json` 为准。当前 Node.js engine 范围是 `^22.0.0 || ^24.0.0`。

本地运行：

```bash
npm install
npm run dev
```

默认服务地址：

```text
http://127.0.0.1:7228
```

非开发模式运行：

```bash
npm run server:start
```

容器启动：

```bash
docker compose up -d
```

仓库内的 compose 文件默认在 loopback 上启动 API 服务，并把运行数据写入容器卷。该路径默认只提供 API；如需由服务端提供控制台页面，需要先构建控制台产物并使用 server `--with-ui` 路径。

## 运作

常用运行维护命令：

```bash
npm run server:doctor
npm run server:locate
npm run server:reconcile
npm run mcp:doctor
```

使用 `LICO_SERVER_DATA_DIR` 指定部署数据目录。服务监听地址和端口分别由 `LICO_SERVER_HOST`、`LICO_SERVER_PORT` 控制。

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| `apps/` | 服务端入口、控制台应用和 MCP gateway installer package。 |
| `packages/` | contracts、foundation、workspace、agents、capabilities、protocols、server runtime 和 UI console package。 |
| `tools/` | 服务端脚本、验证器、生成器和 registry 工具。 |
| `docs/` | 公开运行、架构、协议、兼容性和功能文档。 |
| `tests/` | 仓库验证套件。 |

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
npm run verify:private-deployment-open-platform-e2e
npm run verify:acceptance
```

## 许可证

GPL-3.0-or-later。参见 [LICENSE](LICENSE)。
