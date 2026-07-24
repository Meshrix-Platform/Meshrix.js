<div align="center">

<img src="docs/banner.svg" alt="Meshrix" width="100%" />

**Open-source, private-deployable agent gateway — upstream services in, governed MCP access out.**

[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-c9a96e?style=flat-square)](LICENSE)
[![Node.js ^22 || ^24](https://img.shields.io/badge/node-%5E22.0.0%20%7C%7C%20%5E24.0.0-4fc3f7?style=flat-square)](package.json)
[![Status: pre-release](https://img.shields.io/badge/status-pre--release-a78bfa?style=flat-square)](CHANGELOG.md)

[Website](https://meshrix.io) · [Overview](#overview) · [Quick Start](#quick-start) · [Architecture](#architecture) · [Documentation](docs/README.md) · [Runbook](docs/RUNBOOK.md) · **[简体中文](README.zh-CN.md)**

</div>

---

## Overview

Meshrix runs as a Node.js server that forwards server-configured upstream
services and exposes governed downstream MCP access for agent clients.
Operators declare services and capabilities inside their own environment;
every execution first passes authentication, authorization, Operation
Permission, tag policy, approval, and traffic controls — and leaves audit
evidence behind.

The default runtime is self-contained. Metadata, raw objects, jobs, settings,
grants, audit records, and checkpoints are stored under the server data
directory. External middleware and service adapters are optional extensions
for deployment-specific integrations.

> **Current state: pre-release.** Source availability and license status are
> separate from a tagged production release.

This English document is the normative project overview. See the
[Simplified Chinese localization](README.zh-CN.md).

## Core Capabilities

| Capability | What it provides |
| --- | --- |
| **Upstream service gateway** | Upstream forwarding for external HTTP/MCP services declared through server-side configuration and exposed as governed operation entry points. |
| **Downstream MCP** | Discovery and governed gateway MCP outlets for agent clients, with operation visibility controlled by grants. |
| **Operation Permission** | Operation catalog, groups, scopes, grants, policy preview, approval, mediated execution, audit, and metrics. |
| **Universal tag policy** | One tag model across operations, resources, documents, agents, upstream services, workspaces, and organization objects. |
| **Verified plugin runtime** | One-plugin bundles installed through a common validation, custody, activation, rollback, and contribution boundary. |
| **External-service host** | Executes operation-scoped HTTP/MCP requests for configured plugin service bindings — plugins never receive credentials or transport internals. |
| **Workspace assets** | Workspace files, uploads, downloads, history, checkpoints, restores, and governed Host capabilities for optional plugins. |
| **Agent Gateway** | Calls configured model agents through the server proxy, with routing health and call evidence. |
| **Operations & observability** | Runtime status, logs, health checks, jobs, storage maintenance, backup restore, audit queries, and release evidence. |

## Architecture

<div align="center">
  <img src="docs/architecture-overview.svg" alt="Meshrix architecture overview" width="680" />
</div>

Meshrix's product boundary is the server-side governance layer of a private
deployment: it owns configuration, operation exposure, permission decisions,
execution dispatch, audit, metrics, and evidence generation. See
[Architecture](docs/architecture/ARCHITECTURE.md) for package layering, core
flow, and deployment boundaries.

## Quick Start

Requires Node.js `^22.0.0 || ^24.0.0`.

**Local runtime**

```bash
npm install
npm run dev
```

The server listens on `http://127.0.0.1:7228` by default.

**Service mode**

```bash
npm run server:start
```

**Container**

```bash
docker compose up -d
```

The checked-in compose file starts the API server on loopback and stores
runtime data in a container volume. The compose path is API-only by default;
serving the console UI requires a built console bundle and the server
`--with-ui` path.

## Operate

```bash
npm run server:doctor
npm run server:locate
npm run server:reconcile
npm run mcp:doctor
```

| Variable | Purpose |
| --- | --- |
| `MESHRIX_SERVER_DATA_DIR` | Places runtime state in an explicit deployment directory. |
| `MESHRIX_SERVER_HOST` | Server listen address. |
| `MESHRIX_SERVER_PORT` | Server listen port. |

## Downstream Agent Clients

Agent clients connect through MCP discovery and governed gateway calls;
operation visibility is grant-controlled. The documented downstream adapter
target scope is OpenClaw, Codex, Claude Code, Antigravity, OpenCode, and Pi —
delivered as external `Meshrix-Plugins` adapter packages rather than Core
dependencies. See [Compatibility](docs/COMPATIBILITY.md) and
[Protocols](docs/protocols/PROTOCOLS.md) for the exact scope and status.

## Repository Layout

| Directory | Role |
| --- | --- |
| `apps/` | Server entry point, console app, and MCP gateway installer package. |
| `packages/` | Contracts, foundation, workspace, agents, capabilities, protocols, server runtime, and UI console packages. |
| `tools/` | Server scripts, verifiers, generators, and registry tooling. |
| `docs/` | Public runtime, architecture, protocol, compatibility, and feature documentation. |
| `tests/` | Repository verification suite. |

## Documentation

| Topic | Document |
| --- | --- |
| Product definition | [PRODUCT.md](PRODUCT.md) |
| Documentation index | [docs/README.md](docs/README.md) |
| Architecture | [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) |
| Protocols | [docs/protocols/PROTOCOLS.md](docs/protocols/PROTOCOLS.md) |
| Runtime operation | [docs/RUNBOOK.md](docs/RUNBOOK.md) |
| Compatibility | [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) |
| Capability documents | [docs/functionality/](docs/functionality/) |
| Examples | [docs/examples/README.md](docs/examples/README.md) |
| Decision records | [docs/adrs/README.md](docs/adrs/README.md) |

## Verification

Run the full local repository verification gate:

```bash
npm run verify
```

Focused commands:

```bash
npm run typecheck
npm run build
npm test
npm run verify:core-platform-surface-convergence
npm run verify:private-deployment-open-platform-e2e
npm run verify:acceptance
```

## Project

| Topic | Document |
| --- | --- |
| Contribution process | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Code of conduct | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |
| Security policy | [SECURITY.md](SECURITY.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

<div align="center">
  <sub>Meshrix — self-contained by default, built for private deployment.</sub>
</div>
