# LicoMesh

LicoMesh is an open-source, private-deployable agent gateway. It runs
as a Node.js server that forwards server-configured upstream services and exposes
governed downstream MCP access for agent clients.

Current state: pre-release. Source availability and license status are separate
from a tagged production release.

The default runtime is self-contained. Metadata, raw objects, jobs, settings,
grants, audit records, and checkpoints are stored under the server data
directory. External middleware and service adapters are optional extensions for
deployment-specific integrations.

## Current Capabilities

| Area | Current scope |
| --- | --- |
| Upstream forwarding | Operator-configured HTTP upstreams, governed forwarding, policy preview, approval handling, audit, and traffic controls. |
| Downstream MCP | MCP entry points for discovery and governed gateway calls. Operation visibility is grant-controlled. |
| Operation Permission | Operation catalog, operation groups, grants, policy preview/evaluate, mediated execution, audit records, and metrics. |
| Tag policy | Generic tags for operations and resources, with allow/deny policy evaluation before grant or execution. |
| Verified plugins | Explicitly installed and enabled single-plugin packages can contribute operations, routes, MCP tools, precompiled console assets, and state machines through the public plugin contract. |
| External-service host | Authorized plugin operations can use configured external HTTP or MCP services without receiving credentials or transport internals. |
| Workspace assets | Core workspace metadata, files, uploads, checkpoints, authorization, path boundaries, and controlled execution host capabilities. |
| Audit and observability | Approval state, operation audit, runtime logs, trace metadata, health checks, and storage maintenance utilities. |
| Storage, jobs, runtime | Local metadata store, raw object storage, upload sessions, background jobs, settings, runtime composition, and HTTP/RPC surfaces. |

## Deployment

Requirements are declared in `package.json`. The current Node.js engine range is
`^22.0.0 || ^24.0.0`.

Local runtime:

```bash
npm install
npm run dev
```

Default server URL:

```text
http://127.0.0.1:7228
```

Non-development runtime:

```bash
npm run server:start
```

Container startup:

```bash
docker compose up -d
```

The checked-in compose file starts the API server on loopback and stores runtime
data in a container volume. The compose path is API-only by default; serving the
console UI requires a built console bundle and the server `--with-ui` path.

## Operation

Useful runtime commands:

```bash
npm run server:doctor
npm run server:locate
npm run server:reconcile
npm run mcp:doctor
```

Set `LICO_SERVER_DATA_DIR` to place runtime state in an explicit deployment
directory. Server host and port are controlled by `LICO_SERVER_HOST` and
`LICO_SERVER_PORT`.

## Repository Layout

| Directory | Role |
| --- | --- |
| `apps/` | Server entry point, console app, and MCP gateway installer package. |
| `packages/` | Contracts, foundation, workspace, agents, capabilities, protocols, server runtime, and UI console packages. |
| `tools/` | Server scripts, verifiers, generators, and registry tooling. |
| `docs/` | Public runtime, architecture, protocol, compatibility, and feature documentation. |
| `tests/` | Repository verification suite. |

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

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
