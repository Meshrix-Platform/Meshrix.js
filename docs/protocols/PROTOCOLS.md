# Protocols

> **Meshrix.js trusted-forwarding requirements:** verifiable identity,
> non-amplifying authority, content integrity, and end-to-end traceability.
> [Governed Execution And Minimum Evidence](../architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md)
> owns their normative meaning.

Every protocol surface inherits [Governed Execution And Minimum
Evidence](../architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md). A
transport projection cannot weaken the permit or minimum-evidence boundary.

Protocol facts come from the operation registry and protocol packages under `packages/protocols/`.
Adapters own transport boundaries, negotiation, normalization, and protocol-local ports only.
Runtime state, domain behavior, sensitive payload stores, and authorization decisions are reached
through registered operations or explicit facades bound by `packages/server-runtime` composition.

## Surfaces

| Surface | Package root | Purpose |
| --- | --- | --- |
| HTTP | `packages/protocols/http/` | Server API, console API, gateway operations, upload sessions, jobs, and administration transport. |
| MCP | `packages/protocols/mcp/` | Downstream agent entry point. MCP tools are protocol projections of governed operations. |
| Agent Sync | `packages/protocols/agent-sync/` | Client and agent synchronization protocol contracts. |
| Downstream client aspect | `packages/protocols/downstream-client-aspect/` | Shared downstream MCP client protocol helpers. |
| Plugin package | [Plugin Package and Loading](PLUGIN-PACKAGE-AND-LOADING.md) | Closed one-plugin bundle admission, source-neutral acquisition, verified custody, and lifecycle contribution publication. |
| Plugin external service | Core Host contract plus upstream HTTP/MCP adapters | Operation-scoped, configured external-service invocation with authorization, bounded projection, cancellation, and sanitized errors. |
| Pubsub | `packages/protocols/pubsub/` | Runtime notifications for console and operator workflows. |
| Common | `packages/protocols/common/` | Shared protocol helpers used by the families above. |

Domain surfaces such as Strategy Management, Agent Gateway, and Maintenance Agent are not protocol
package roots. They remain in `packages/agents` or `packages/capabilities` and are exposed only through
HTTP or MCP as registered operations.

## Ownership

| Boundary | Current owner |
| --- | --- |
| HTTP and console transport | `packages/protocols/http/`, including controllers and response normalization. |
| MCP adapter and installer | `packages/protocols/mcp/`; Operation Permission visibility and grants arrive through the injected `toolSkillManagementProvider` port. |
| Checkpoint and upload transport | `packages/protocols/http/controllers/` for transport; server-runtime owns upload-session and job conversion state. |
| Console domain projections | `packages/ui-console/src/`; concrete providers are injected by server-runtime composition. |
| Storage operations | `packages/foundation/src/storage/` for storage contracts and providers; server-runtime owns server runtime state. |
| Cross-layer binding | `packages/server-runtime` only. |

There are no documentation-only protocol package roots for checkpoint, console, or storage. A protocol
directory owns executable transport or normalization code; runtime state and persistence remain with
their current domain owners. Protocol packages must not import `packages/agents`,
`packages/capabilities`, or `packages/server-runtime` internals.

## MCP Outlets

Core MCP outlets are:

- `meshrix.discovery`
- `meshrix.gateway`

Enabled verified plugins may contribute additional outlets declared by their
package manifests. Core does not define product-specific plugin outlets.

MCP discovery hides disabled plugin outlets and unauthorized operations and
refreshes after plugin, grant, or tag-policy changes. Visibility and denial decisions
come from Operation Permission and tag-policy evaluation on the injected provider port;
adapters never bypass that path.

Dynamic `upstream.*` tools are direct MCP tools rather than categorized outlets.
`meshrix.capabilities.list` may include their visible descriptors, but they do not
declare `mcpOutlet` and do not contribute to the categorized outlet summary.

### Upstream Payload Transit

Published operations choose one explicit request representation; HTTP operations
may omit the response representation when they want governed native passthrough.
Meshrix.js then applies the bounded opaque-stream response default, including the
response size limit and transport-header allowlist. JSON-RPC operations still
declare a structured response representation.
The native HTTP surface
`POST /api/gateway/v1/transit/:serviceId/:operationKey` is reserved for
`opaque_stream → opaque_stream` and preserves backpressure and content-coded
bytes. It authenticates and authorizes from headers before consuming the body;
`Expect: 100-continue` is terminated at Core and acknowledged only after those
checks. Structured operations continue through the bounded JSON forwarding
surface.

MCP and other JSON-only callers never embed file bytes in JSON by default. They
pass owner-bound `upload:`, `artifact:`, or `workspace:` references to a
declared raw or multipart mapping. A `workspace:<workspaceId>:<relativePath>`
reference resolves through the same owner-bound workspace access and
path-containment rules as `workspace.file.download`. File-like results are
committed as artifacts and projected as MCP `resource_link` content. The
authenticated
`GET|HEAD /api/gateway/v1/artifacts/:artifactId` route supports a single byte
range and never exposes a host path or storage-provider URL.

### Upstream Catalog Invalidation

The publishing protocol uses catalog-change messages as scoped invalidation signals, not catalog replication. After a gateway snapshot and Operation Permission catalog commit agree, the tag and grant projection identifies affected authenticated partitions. The downstream gateway sends only revisions and a fixed reason to connections that negotiated list-change support; it does not send operation schemas, raw tags, subjects, certificate or credential references, or catalog contents.

Compatible downstream consumers may compare the revision, perform an authenticated catalog list, validate the response, and replace their own cache partition. That consumer behavior is outside Core ownership. A stale consumer cache never authorizes execution because the server re-evaluates the current catalog and policy.

The published protocol is the complete server-client boundary. Core owns only server-side schema, negotiation, authentication, authorization, scoped notification, pull, acknowledgement, disconnect, and reconnect-fence semantics. Core plans, source, tests, gates, and receipts must not depend on a client repository, implementation, build, plan, test, report, or receipt. Server conformance is proven with protocol-owned schemas, frozen wire corpora, and neutral mock peers. Client adoption is independently verified by each client owner and cannot block or promote a server receipt.

### Downstream update subscriptions

Downstream HTTP MCP uses protocol version `2026-07-28`. A connector that has
explicitly persisted `autoUpdate: true` opens one authenticated
`subscriptions/listen` POST stream and requests a closed notification set:
tool-list invalidation, Skill Hub catalog invalidation, and Meshrix connector
update availability. A false or absent preference opens no stream.

Skill Hub exposes its own authenticated, cursor-resumable event stream. Core's
external-service gateway owns that connection and credential, reduces each
event to a revision and operation id, and publishes it to authenticated MCP
subscriptions. Notifications trigger catalog refresh; neither Core nor the
connector executes commands carried by a notification. The removed GET `/mcp`
SSE registration and query-string capability negotiation are not supported.

## Delegated MCP Child Calls

Targets that call Meshrix.js MCP on behalf of a parent operation use a `delegated-mcp-child` grant. The MCP request carries the canonical child binding in `delegatedMcp.childOperation` or `delegatedChildOperation`, or through the corresponding headers:

- `X-Meshrix.js-Delegated-Mcp-Grant-Id`
- `X-Meshrix.js-Delegated-Session-Id`
- `X-Meshrix.js-Delegated-Turn-Id`
- `X-Meshrix.js-Delegated-Subject-Id`
- `X-Meshrix.js-Delegated-Target-Id`
- `X-Meshrix.js-Delegated-Workspace-Id`
- `X-Meshrix.js-Delegated-Parent-Operation-Id`
- `X-Meshrix.js-Delegated-Trace-Id`

The MCP adapter compares every request binding field with the authenticated grant metadata. A missing or mismatched field returns `delegated_child_operation_binding_mismatch` before operation dispatch. The bound workspace from the delegated grant takes precedence over a caller-supplied MCP envelope workspace. The execution context and audit projection use only generic delegated-child field names.

## Adapter Target Scope

The internal platform downstream adapter target scope is OpenClaw, Codex, Claude Code, Antigravity, OpenCode, Pi, and Kimi CLI. Their implementations and compatibility evidence are explicit operator-supplied artifacts; Core owns only the bounded JSON-stdio adapter protocol and its security boundary.

MCP user-device installation begins at platform-native launchers: macOS and Linux
use `meshrix-mcp-install.sh`, and Windows uses `meshrix-mcp-install.ps1` only. The
launchers validate arguments and delegate to the bundled connector, which is
the single implementation of signed discovery, grants, local client search,
batch and interactive installation, configuration, and uninstall.

## Governance

Every protocol surface that can cause a protected read, write, external-service
call, package lifecycle action, or administration action passes the same
Operation Permission and tag-policy path. Protocol adapters use shared
permission semantics through injected ports and registered operations.
Buffered, streaming, multipart, artifact, MCP, asynchronous, and process
adapters must present the resulting bound execution permit to the first
protected sink. A transport-local check, header, internal caller, or route name
is not independent authority.

Protocol telemetry records bounded transfer counts, stable outcomes, and
irreversible correlations only when required. It does not persist bodies,
headers, paths, identities, chunks, prompts, results, or one routine success
record per request. A protocol path without sink-side permit consumption and
the mandatory compact lifecycle proof is non-converged and fails the
Functional Release Gate.

Plugin package admission binds each contribution to the verified plugin identity, artifact digest, and active generation. The external-service Host accepts only the exact operation reference and configured service binding selected by Core after current authorization. It returns a bounded, sanitized projection and never exposes credentials or transport internals to plugin code.

## Verification

```bash
npm run server:verify:protocol-boundary
npm run vitest -- tests/vitest/server/plugin-mcp-outlet-visibility.test.ts
npm run verify:plugin-bundle-protocol
npm run verify:plugin-runtime
npm test -- --suite domains.manifest
npm run server:verify:strategy-management
npm run server:verify:agent-gateway
npm run server:verify:model-routing
npm run server:verify:agent-management
npm run server:verify:maintenance-agent
npm test
```
