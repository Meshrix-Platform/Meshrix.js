# LicoMesh Product

This document explains what the LicoMesh framework does. It is a product-level overview, not a replacement for protocol, architecture, configuration, or verification documentation. Implementation facts remain owned by the responsibility documents, registries, and verifiers under `docs/`, `packages/`, and `tools/`.

## What LicoMesh Is

LicoMesh is an open-source, private-deployable agent gateway framework. It runs as a Node.js server and brings upstream services, agent clients, workspace assets, verified plugin packages, runtime jobs, audit, and operator controls into governed operation boundaries.

Its core role is to let operators configure services and capabilities inside their own deployment environment, then expose those capabilities safely to authorized users, the console, and agent clients through HTTP, RPC, MCP, and console surfaces.

## Problems It Solves

LicoMesh is built for teams that need privately deployed agent capabilities:

- Connect external upstream services through one server-side gateway instead of giving every agent direct service credentials.
- Represent MCP tools, console actions, service calls, file operations, plugin actions, and maintenance actions as governed operations.
- Evaluate authentication, authorization, Operation Permission, tag policy, risk policy, approval requirements, traffic controls, and audit before execution.
- Keep runtime data in the local server data directory by default, with external middleware and service adapters enabled only as explicit deployment integrations.
- Provide verifiable runtime behavior, boundaries, redaction, audit, and release evidence for private deployments.

## Core Capabilities

| Capability | Product role |
| --- | --- |
| Upstream service gateway | Declares external HTTP/MCP services through server-side configuration and exposes them as governed operation entry points. |
| Downstream MCP | Provides discovery and governed gateway MCP outlets to agent clients, with operation visibility controlled by grants. |
| Operation Permission | Manages the operation catalog, operation groups, scopes, grants, policy preview, approval, execution, audit, and metrics. |
| Universal tag policy | Applies one tag model to operations, resources, documents, agents, upstream services, workspaces, and organization objects. |
| Verified plugin runtime | Installs one-plugin bundles through a common validation, custody, activation, rollback, and contribution transaction boundary. |
| Plugin console assets | Serves digest-bound, precompiled browser assets only for an active verified plugin generation while Core retains route and authorization control. |
| External-service host | Executes operation-scoped HTTP or MCP requests for configured plugin service bindings without exposing credentials or transport internals. |
| Workspace assets | Manages workspace files, uploads, downloads, history, checkpoints, restores, and governed Host capabilities for optional plugins. |
| Agent Gateway | Calls configured model agents through the server proxy when enabled and configured, with routing health and call evidence. |
| Operations and observability | Provides runtime status, logs, health checks, jobs, storage maintenance, backup restore, audit queries, and release evidence entry points. |

## Downstream Agent Clients

At the product level, LicoMesh exposes governed downstream access to agent clients through MCP. The current documented downstream adapter target scope is OpenClaw, Codex, Claude Code, Antigravity, OpenCode, and Pi.

The protocol-level adapter scope, compatibility status, and verification requirements are maintained by `docs/protocols/PROTOCOLS.md`, `docs/COMPATIBILITY.md`, and the relevant functionality documents.

## Product Boundary

LicoMesh's product boundary is the server-side governance layer in a private deployment:

- It owns server configuration, operation exposure, permission decisions, execution dispatch, audit, metrics, runtime status, and evidence generation.
- It binds upstream service credentials through server-side configuration and local `secret://` references, and redacts public responses, audit records, and reports.
- It checks boundaries around workspaces, files, paths, uploads, execution entry points, and local runtime data.
- It is self-contained by default for private deployment. External databases, object stores, upstream services, model providers, and other middleware are explicit operator-configured integration points.

## What It Is Not

LicoMesh is not:

- A hosted SaaS platform. The default assumption is that operators run the server in their own environment.
- A model provider. Model calls execute through the gateway only after the relevant provider and feature are configured.
- A general source-code version control, release approval, or release-note system.
- A client cryptography implementation.
- A direct tool bypass around permissions. Any surface that can read, write, invoke an external service, mutate package lifecycle state, administer runtime state, or run maintenance actions should pass through the shared governance path.

## Current Status

The project is currently pre-release. Source availability, license status, and a tagged production release are separate states. Release or production readiness must be determined through the repository verification commands, release gates, and redacted evidence.

## Related Documents

- `README.md` and `README.zh-CN.md`: product technical overview and current capability summary.
- `docs/README.md`: public documentation index.
- `docs/architecture/ARCHITECTURE.md`: runtime layering, core flow, and deployment boundary.
- `docs/protocols/PROTOCOLS.md`: HTTP, RPC, MCP, plugin-package, and other Core protocol surfaces.
- `docs/functionality/`: current boundaries, responsibilities, and verification commands for each capability.
- `docs/RUNBOOK.md`: startup, operations, verification, and evidence handling.
