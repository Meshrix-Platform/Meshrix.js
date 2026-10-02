<div align="center">

<img src="docs/logo.svg" alt="" width="64" />

# Meshrix.js

**An open-source TypeScript framework for governed HTTP and MCP services.**

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

Requires Node.js `>=22.19.0 <23 || >=24.3.0 <25`. The first npm release is still in preparation; see [current status](docs/STATUS.md).

The supported npm installation after publication is:

```bash
npm install --global meshrix.js
meshrix-server --with-ui --data-dir <server-data-dir>
```

The package includes the Console, `meshrix`, `meshrix-server`, `meshrix-mcp`, and optional first-party client-adapter components. No separate connector package is required. Services and clients use the same origin; external access requires the TLS and trusted-proxy configuration in the [runbook](docs/RUNBOOK.md#container-startup).

To try the current source before publication:

[Download and extract the source](https://github.com/Meshrix-Platform/Meshrix.js/archive/refs/heads/nightly.zip) (pre-release). With Node.js 24 and npm installed, run from the project directory:

```bash
node tools/start.mjs
```

Open the web console at **http://127.0.0.1:7228**.

[Local setup](docs/RUNBOOK.md#local-startup) · [Docker deployment](docs/RUNBOOK.md#container-startup) · [Connect an agent](docs/COMPATIBILITY.md)

## Embed the Gateway

`@meshrix/gateway` provides the standalone typed Gateway API for Node applications, without the full platform runtime. All other workspaces are private implementation components. See the [Gateway examples](docs/examples/gateway/README.md), [architecture](docs/architecture/ARCHITECTURE.md), and [developer guide](docs/development/README.md).

---

[Contributing](CONTRIBUTING.md) · [Report a bug](https://github.com/Meshrix-Platform/Meshrix.js/issues) · [Security](SECURITY.md) · [Apache-2.0 License](LICENSE)
