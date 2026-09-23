<div align="center">

<img src="docs/logo.svg" alt="" width="64" />

# Meshrix.js

**为你的智能体自部署一个 MCP 网关。**

接入 HTTP 和 MCP 服务，在 Web 控制台管理工具权限、查看调用记录。

[快速开始](#快速开始) · [使用文档](docs/README.md) · [English](README.md)

</div>

## 你可以做什么

| 能力 | 用途 |
| --- | --- |
| **接入服务** | 让智能体通过同一个网关调用你的 HTTP 和 MCP 服务。 |
| **控制权限** | 决定谁能发现和调用哪些工具，为敏感操作设置审批。 |
| **查看调用** | 在控制台查看服务状态、调用记录、日志和错误。 |
| **管理文件** | 上传、下载工作空间文件，查看历史并恢复检查点。 |
| **扩展能力** | 安装插件，增加工具和服务集成。 |

## 快速开始

从源码试用预发布版本（pre-release）。需要 Git、Node.js 24 和 npm。

```bash
git clone --branch nightly --single-branch https://github.com/Meshrix-Platform/Meshrix.js.git
cd Meshrix.js
npm ci
npm run build
npm run server:start -- --with-ui --strict-port
```

打开 Web 控制台：**http://127.0.0.1:7228**。

[本地配置](docs/RUNBOOK.md#local-startup) · [Docker 部署](docs/RUNBOOK.md#container-startup) · [接入智能体](docs/COMPATIBILITY.md)

---

[参与贡献](CONTRIBUTING.md) · [反馈问题](https://github.com/Meshrix-Platform/Meshrix.js/issues) · [安全](SECURITY.md) · [MIT 许可证](LICENSE)
