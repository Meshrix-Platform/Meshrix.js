<div align="center">

<img src="docs/logo.svg" alt="" width="64" />

# Meshrix.js

**A self-hosted MCP gateway for your AI agents.**

Connect HTTP and MCP services, control tool access, and inspect calls from a web console.

[Quick start](#quick-start) · [Documentation](docs/README.md) · [简体中文](README.zh-CN.md)

</div>

## What you can do

| Capability | What you can do |
| --- | --- |
| **Connect services** | Give agents access to your HTTP and MCP services through one gateway. |
| **Control access** | Choose who can discover and call each tool, and require approval for sensitive actions. |
| **Inspect activity** | View service health, call records, logs, and errors in the web console. |
| **Manage files** | Upload and download workspace files, browse their history, and restore checkpoints. |
| **Add capabilities** | Install plugins for additional tools and service integrations. |

## Quick start

Try the pre-release from source. Requires Git, Node.js 24, and npm.

```bash
git clone --branch nightly --single-branch https://github.com/Meshrix-Platform/Meshrix.js.git
cd Meshrix.js
npm ci
npm run build
npm run server:start -- --with-ui --strict-port
```

Open the web console at **http://127.0.0.1:7228**.

[Local setup](docs/RUNBOOK.md#local-startup) · [Docker deployment](docs/RUNBOOK.md#container-startup) · [Connect an agent](docs/COMPATIBILITY.md)

---

[Contributing](CONTRIBUTING.md) · [Report a bug](https://github.com/Meshrix-Platform/Meshrix.js/issues) · [Security](SECURITY.md) · [MIT License](LICENSE)
