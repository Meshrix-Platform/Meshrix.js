# Gateway

The gateway is the upstream service forwarding boundary and the runtime consumer of authenticated, revisioned service publications after they pass the control-plane, security, and acceptance contracts below.

## Current Runtime Status

Authenticated maintainers publish closed service commands through `/api/gateway/v1/services` and its service-specific replace, disable, remove, and republish routes. Runtime HTTP, RPC, MCP, and console surfaces expose discovery, audit, metrics, publication state, and governed forwarding from the accepted immutable snapshot.

The production composition binds the control-plane application service, canonical manifest compiler and writer, manifest observer, immutable gateway snapshot, Operation Permission catalog publication, scoped audience projection, and MCP catalog-delivery protocol. The console is a consumer of the public server API and is not a publication authority.

## Deployment Profiles And Edge Boundary

The self-contained Node.js listener is the implemented embedded profile. It
can accept HTTP directly for local, development, desktop-adjacent, and bounded
private deployments without requiring an external reverse proxy.

For production deployments, an operator may place an independently admitted
Nginx, Caddy, Envoy, or equivalent edge in front of Meshrix. The edge may own
TLS, HTTP protocol negotiation, connection reuse, coarse-grained rate limits,
load balancing, and standard edge observability. It does not parse Meshrix
governance semantics and cannot authorize an operation, mint or consume a
governed permit, resolve a credential, approve an action, or emit Meshrix
governance evidence.

Meshrix remains the semantic gateway in both profiles. It interprets HTTP,
JSON-RPC, and MCP contracts; resolves registered operations; applies
authentication, Operation Permission, tag, risk, approval, and traffic policy;
injects scoped credentials at the protected sink; manages protocol sessions;
and emits bounded redacted evidence. An external edge therefore augments the
Node.js runtime instead of replacing the application gateway.

No separate Go data plane is currently implemented. Any future data-plane
service must be justified by representative load and saturation evidence,
preserve the language-independent gateway contracts, and consume the same
Core-minted governed permit at protected sinks. It cannot introduce a second
policy engine, authorization authority, service-publication authority, or
audit lifecycle.

The console can load a portable service document with kind
`meshrix.upstream-service` and schema version
`v0.0.1:upstream-service:portable-import-2`. The document contains only a
`serviceKey` and the complete service `descriptor`. File selection and validation
are local operations. Import loads the validated document into the editable
draft. The ordinary **Publish** action is the only submission path: it submits
the existing authenticated publishing command, waits for `server_published`,
and then runs the service health check. Import never starts a service, installs
a plugin, or embeds credential material.

Every HTTP or JSON-RPC operation now publishes an explicit `payloadTransport`
contract. `structured_json` retains bounded JSON validation and projection;
`opaque_stream` carries native HTTP bytes; `artifact_body` and
`artifact_multipart` resolve owner-bound upload, artifact, or workspace-file
references; and an
`artifact` response is committed privately and returned to MCP as a
`resource_link`. Files are not Base64-encoded by the gateway. The complete
file-conversion import example is
[file-parser-format-convert.upstream.json](../examples/file-parser-format-convert.upstream.json).
Import registers the already deployed service; it does not start the converter
or install a plugin.

## Upstream Service Publishing Contract

One governed transaction preserves safe forwarding behavior:

1. Authenticate the service developer and bind create, replace, disable, or republish to a server-owned service identity, maintainer authority, expected revision, and idempotency key.
2. Parse a closed, bounded publishing command for REST or JSON-RPC operations, explicit request and response representations, typed certificate and credential references, permissions, risk, approval, traffic policy, and allowed organization, team, role, grant, or other governed audiences.
3. Compile canonical manifest bytes without evaluating caller data as a path, filename, command, template, environment name, header name, expression, or configuration fragment.
4. Persist through a dedicated control-plane writer into a server-configured manifest root. The gateway identity has read and traverse access only, mutable runtime state uses another root, and publication uses durable staging and atomic replacement.
5. Treat filesystem events as invalidation hints, validate a complete manifest-set revision, build an immutable snapshot outside the request path, and atomically swap one reference without restarting the server. An invalid candidate leaves the last accepted snapshot authoritative.
6. Compile every enabled operation deterministically into Operation Permission and publish one catalog revision only when it identifies the same gateway manifest-set revision.
7. Recompute affected tag and grant visibility with deny precedence and discovery/execution parity, then emit revision-only invalidations to affected downstream partitions. Notifications contain no catalog, schema, credential, certificate, raw tag, or subject data.
8. Expose authenticated catalog pull, acknowledgement, disconnect, timeout, and reconnect fencing through the published protocol. A neutral protocol peer verifies these server semantics; consumer cache replacement is independently owned.

The mutation API returns `publishing` after the durable candidate is accepted. Authenticated service reads expose a separate `publication` object: `server_published` appears only when the durable published snapshot and the gateway, catalog, audience, and protocol-delivery revision chain agree; its terminal facts include the source revision and digest plus the catalog, audience, and protocol revisions. It never asserts client adoption. A protocol timeout disconnects and fences the affected session without rolling back authoritative server publication.

The service-manifest authority is a private normalized SQLite index. A service
commit updates one service row, one version row, one content-addressed manifest
row when content is new, and one bounded idempotency row in a single immediate
transaction. It does not clone or sort all services, rebuild a generation
document, or serialize all prior request outcomes. Candidate state uses a
cryptographic transition-chain digest, so one service change updates the set
identity in constant work. Published state is a revision pointer over indexed
service-version intervals; acknowledgement does not copy the candidate set.

Idempotency outcomes retain at most 8,192 rows and 8 MiB by default and expire
after seven days. A new commit removes expired or oldest outcomes in a bounded
batch before admission, so reaching the window cannot permanently disable
publication. Candidate state may lead the published pointer by at most 256
changed revisions; further mutation is rejected until acknowledgement, bounding
version and manifest-blob growth. Acknowledgement deletes obsolete versions and
their now-unreferenced blobs through indexed bounded batches. The former
immutable-generation directory is imported once under a private cross-process
initialization lock, committed to SQLite, and removed; normal reads and writes
never enumerate or dual-read the retired layout.

Raw secrets and certificate material never enter the publishing command or manifest. Unknown or duplicate fields, prototype-mutating keys, unsafe targets or routes, control characters, excessive sizes or nesting, symlinks, non-regular files, mode or ownership mismatches, and caller-selected storage names fail closed before publication.

Configured `credentialRefs` resolve through the local `secret://` store at forwarding time. The gateway checks service, host, protocol, and required-scope metadata before applying secret material to HTTP headers or MCP headers/env, and generated reports must not contain raw credential values. A service descriptor may also include `tagPolicy`; governed services use the shared universal tag evaluator and fail closed when the tag store is unavailable.

Network forwarding is deny-by-default for loopback, link-local, private, and otherwise restricted address ranges. A descriptor may set `allowLocalNetwork` only to reach an intentionally configured loopback or private-network service. Link-local ranges, recognized cloud metadata endpoints, unspecified addresses, carrier-grade NAT, benchmark, multicast, and reserved ranges remain denied under that opt-in. DNS preflight rejects the entire request when any answer is denied or when resolution yields no valid IP address. HTTP health checks, ordinary HTTP forwarding, and MCP Streamable HTTP sessions use the same DNS preflight and pinned-address transport so the validated address cannot be replaced by a second DNS result during connection establishment. Redirects are not followed implicitly. Response admission checks declared length before reading and enforces the configured limit incrementally while streaming; an oversized stream is cancelled before any partial body is projected.

An MCP stdio upstream process receives only the portable execution baseline needed to start the configured command, descriptor-declared `mcp.env` values, and credential-reference environment bindings. It does not inherit unrelated server, provider, database, or operator environment variables. A service that needs an additional variable must declare that binding explicitly in its descriptor.

Each upstream gateway registry owns one bounded MCP session manager. The manager reuses an initialized session by service, transport configuration identity, and credential-reference revision without placing credential values in the pool key. Initialization is single-flight. Per-session and manager-wide concurrency limits reject excess work, idle and maximum-lifetime limits reclaim sessions, and a service configuration or credential revision change retires the prior generation without allowing a stale generation to reclaim that service scope. Registry shutdown closes all owned sessions.

The stdio transport keeps one initialized child process for concurrent requests and routes replies by JSON-RPC id. The Streamable HTTP transport performs the MCP initialize/initialized lifecycle, sends the negotiated `MCP-Protocol-Version` and any issued `MCP-Session-Id` on subsequent requests, parses SSE incrementally so notifications may precede the matching result, rebuilds once after a session `404`, and uses `DELETE` for best-effort logical session shutdown. Its notification callbacks use one bounded sequential queue per session (`64` messages and `1 MiB`); overflow makes the upstream session fatal instead of creating unbounded callback work. Descriptor or credential headers cannot replace the required JSON `Content-Type`, JSON/SSE `Accept`, session, or protocol headers. The implemented negotiated protocol revision is `2025-06-18`; an upstream that selects a different revision is rejected.

The downstream `/mcp` SSE stream requires a valid MCP grant. It admits at most
`256` connections globally, `32` per direct remote address, and `16` per grant,
uses one shared heartbeat scheduler, and closes a consumer as soon as socket
backpressure or the `64 KiB` buffered-output ceiling is reached. The public
discovery and `HEAD` surfaces remain finite responses and do not reserve an SSE
connection.

The local secret writer accepts one explicit target contract containing `provider`, `family`, `authType`, `secretRef`, and a scope with `serviceId`, `scopes`, `allowedHosts`, and `allowedProtocols`. Missing scope fields are rejected instead of widened. When either allowed-target list is non-empty, resolution requires the actual host or protocol and denies a missing value; empty lists remain valid only for bindings such as local stdio that do not have a network target. Initialization only creates a new reference. Rotation preserves the complete target binding and uses the current `expectedRevision`; revocation also requires the current revision. Mutations are serialized across processes, publish a unique immutable value record, verify mutation-lock ownership, atomically replace the private registry pointer, and only then remove the superseded value. An interruption before the pointer swap leaves the previous value resolvable; an interruption after the swap leaves at most an orphan that the next locked mutation removes.

## Forwarding Path

### Governed control and data planes

This section specializes the project-wide [Governed Execution And Minimum
Evidence](../architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md) policy.

Structured JSON, opaque streams, multipart bodies, artifact references, MCP
sessions, and process transports have different data-plane adapters, but they
do not have different authorization models. Every forwarding and artifact path
must enter the canonical governance preparation lifecycle before body or
credential consumption and must present the same bound permit to the first
credential, private-artifact, network, process, artifact-write, or other
protected sink. A header check or controller-local policy call is not a
substitute for sink-side consumption.

Streaming authorization may finish before bulk bytes are read, but approval or
body-dependent policy must first stage a bounded, owner-bound artifact and bind
its digest into a fresh permit. Revalidation follows traffic-slot acquisition,
approval waits, retries, and session rebuilds. The lifecycle emits only compact
governance proof; byte transfer, routine success, ordinary denial, and
backpressure telemetry are counters or sampled diagnostics, not per-chunk or
per-request durable logs.

This section is a maintenance and readiness invariant. A representation adapter
that has not converged on the shared permit and proof lifecycle must remain
outside a release-ready claim even if its current controller authenticates and
authorizes the caller.

1. Resolve route and upstream operation.
2. Authenticate subject.
3. Evaluate Operation Permission, tag policy, risk policy, and approval requirements.
4. Apply the descriptor traffic policy through the gateway's token-bucket-with-concurrency control.
5. Redact secrets before logging or auditing.
6. Call the upstream service through the operation's explicit representation adapter.
7. For structured JSON, validate `responseSchema`, project `publicResponseFields`, and redact sensitive fields. For opaque HTTP, stream permitted headers and exact bytes. For an artifact response, commit it to owner-bound storage and expose only its resource metadata.
8. Emit audit and metrics.

Native HTTP callers use
`POST /api/gateway/v1/transit/:serviceId/:operationKey`; the request body and
response body are streams, not JSON envelopes. Query parameters are forwarded
as query parameters, while `path.<name>` values fill only path variables that
the published operation declares. The route strips caller authority,
credential, cookie, forwarding, hop-by-hop, and framing headers. It preserves
only the safe representation headers admitted by the operation contract.

JSON-only callers first use the authenticated upload-session API and pass a
reference shaped as `upload:<sessionId>:<fileIndex>` to a projected artifact
argument. A file already held in a governed agent workspace may instead be
passed as `workspace:<workspaceId>:<relativePath>`; resolution reuses the
owner-bound workspace access check and workspace path-containment rules, so a
caller without read authority over that workspace file is denied and traversal
outside the workspace root fails closed. Successful artifact responses carry
an authenticated Core URI under
`GET /api/gateway/v1/artifacts/:artifactId`; `HEAD` and one RFC-style byte
range are supported. Ownership is checked on every resolve and download.

HTTP endpoint pools admit at most 64 configured endpoints, weight 100 for one
endpoint, and total weight 1,024; duplicate endpoint identities and invalid
weights fail publication. Runtime selection uses smooth weighted round robin.
One selection evaluates each enabled endpoint at most once, so the failure
path is `O(endpoint_count)` and does not iterate expanded weight slots.
Unavailable endpoints are reset out of the current-weight state, preventing
accumulated debt and a recovery burst. If all configured endpoints are
disabled, selection fails immediately instead of routing through an implicit
primary endpoint. The per-operation scheduler state contains one bounded
weight value per enabled endpoint and is removed with the service.

Caller cancellation is carried from the downstream MCP HTTP request or Operation Permission execution context through the console executor and gateway registry to the selected upstream transport. The downstream HTTP adapter correlates an authenticated cancellation by grant, verified client process identity, MCP session, per-proxy random correlation session, and JSON-RPC id; it aborts only the matching active request, ignores unknown or completed ids, and emits no JSON-RPC response for a cancelled request. The proxy correlation value is bounded, is used only inside the authenticated cancellation scope, and is not projected into responses or diagnostics. A cancelled in-flight upstream MCP request emits a best-effort `notifications/cancelled` message for its own JSON-RPC id and terminates only that request; initialization is not cancellation-notified. Timeout and caller cancellation use fixed public reasons and are reported separately as `504` and `499`. The traffic slot is released in the forwarding `finally` path, while other requests sharing the same upstream session continue independently.

The stdio proxy processes requests concurrently so a downstream cancellation notification can abort the matching HTTP forward without waiting for an earlier slow request to complete. Each proxy instance generates a random correlation session and sends it on every authenticated HTTP forward, preventing equal JSON-RPC ids from colliding across concurrent proxy processes that share one installed identity. Its parser and dispatcher enforce finite frame, input-buffer, active-request, and pending-work limits. Its stdout writer performs at most one underlying write before `drain`, bounds queued messages and bytes, waits for output drain during close, and stops input and active work when output capacity or the drain deadline is exceeded. Capacity rejection uses a fixed JSON-RPC error, ordinary notifications are best-effort at capacity, and an admitted request reserves enough work capacity for its own cancellation notification.

## Governance

Canonical gateway verification runs against the repository's self-contained upstream fixture service (`tools/server-scripts/upstream-fixture-service.mjs`). The fixture exposes the same forwarding surfaces a production upstream service would: a deterministic HTTP API (records, echo, identity, state probe) and an MCP server over stdio and HTTP transports. Current verifiers publish it through the authenticated control-plane contract and durable manifest authority, then bind credentials through runtime `secret://` references. The fixture returns redacted credential-arrival proof (hashes and presence flags) so evidence can confirm gateway-side injection without recording secret material. Reports record only redacted hashes, response sizes, audit flags, and embedded timestamps instead of account identifiers, credentials, or raw response bodies.

Server protocol conformance uses a neutral downstream peer generated from the MCP and catalog-delivery contracts. It exercises initialize, initialized notification, tools/list, governed tools/call, denied destructive call, cancellation, scoped invalidation, authenticated pull, acknowledgement, disconnect, and reconnect fencing without loading a connector or client implementation. Target-specific connector and client probes remain separate compatibility checks and cannot block or promote a server receipt.

Native downstream installation obtains a grant through the local device-authorization request, authenticated console approval, and one-time claim consumption flow. The installer never receives a console cookie or CSRF token, and it does not treat loopback location or process identity as authorization. A user may instead provide an already issued grant through standard input or a named environment variable. Uninstall notification uses an existing grant and does not mint a replacement credential when none is available.

The connector-managed downstream adapter target set is OpenClaw, Codex, Claude Code, Antigravity, OpenCode, Pi, and Kimi CLI. The catalog pins external packages from Meshrix-Plugins; all client commands, configuration formats, probes, installation code, and compatibility evidence live there. Core owns only package verification/cache, the bounded adapter process protocol, authorization, credentials, proxying, and rollback.

Destructive fixture tools stay hidden from downstream projection. The approval verifier first proves that the pending call produced no upstream side effect, then resolves the shared pending operation and requires exactly one credential-bound upstream MCP call. Repeated approval is rejected without replay, while rejection and expiry leave the upstream hit count unchanged. The dedicated readiness reducer rejects reports that contain only `pending_approval` without the resume, exactly-once, no-side-effect, audit-correlation, and credential-binding evidence.

Other upstream services use the same descriptor and operation policy model. A live external HTTPS compatibility probe remains available as an explicitly optional check (`MESHRIX_UPSTREAM_EXTERNAL_COMPAT=1 npm run verify:upstream-gateway-external`); it is excluded from default and container gates.

## Response Policy

HTTP, JSON-RPC, and MCP operations may declare a JSON `responseSchema`, `publicResponseFields`, and `sensitiveBodyFields` on each operation descriptor. Any configured schema, public-field projection, or sensitive-field filter requires a structured JSON response; a non-JSON or malformed response is rejected before public output instead of falling back to opaque text. For MCP, the policy applies to `structuredContent` or JSON text before public projection, and configured filtering rejects opaque text blocks. A configured schema must also validate before forwarding. Public responses contain only the declared dotted JSON paths after configured and known credential-like fields are redacted. Raw upstream MCP error text is not copied into public errors or persisted audit payloads.

## Verification Evidence

The upstream gateway E2E verifier publishes local fixture services through the durable manifest writer and writes scoped secret-store records before startup. It then runs health and policy preview, forwards through HTTP/RPC/MCP, records audit and metrics, exercises approval and traffic controls, and runs destructive input coverage. Traffic evidence covers both token bucket exhaustion and `maxConcurrent` in-flight rejection on the same governed forwarding path used by HTTP, RPC, console, and MCP callers.

The upstream fixture transit verifier (`npm run verify:upstream-fixture-transit`) registers the self-contained fixture twice — once as a REST/HTTP external service with `responseSchema` and `publicResponseFields`, once as an MCP service over stdio with an HTTP-transport variant — then proves REST forwarding, MCP tool projection and transit, `state.increment` followed by `state.probe` in the same initialized stdio session, secret-store credential injection on both header and env paths, identity-proof redaction, downstream tool visibility, and denial paths (missing scope, destructive without approval). The managed-session transport tests additionally cover concurrent id routing, SSE notification/result interleaving, session headers and `404` rebuilding, cancellation without side effects, slot release, and isolation of a concurrent peer request.

The downstream agent tool-loop and connector installation verifiers exercise independently released adapter compatibility. They may validate a real `meshrix-mcp proxy` or locally installed target, but their reports are outside the server acceptance DAG. Server cancellation and downstream protocol readiness are instead proven through the neutral protocol peer against `/mcp`, Operation Permission, the gateway registry, and the deterministic upstream fixture.

The fixture service can also be started standalone for manual inspection:

```bash
node tools/server-scripts/upstream-fixture-service.mjs --mode http --port 0
node tools/server-scripts/upstream-fixture-service.mjs --mode mcp-stdio
```

## Verification

The commands below are separated by ownership. `verify:upstream-service-publishing` is the canonical positive server gate and writes the recomputable required report at `build/reports/upstream-service-publishing.json`.

```bash
npm run verify:upstream-gateway
npm run verify:upstream-service-publishing
npm run verify:upstream-fixture-transit
npm run verify:console-gateway-mcp-workflows
npx vitest run tests/vitest/server/http-mcp-adapter-cancellation.test.mjs tests/vitest/server/mcp-sse-admission.test.mjs tests/vitest/server/upstream-mcp-session-manager.test.mjs tests/vitest/server/upstream-gateway-session-cancellation.test.mjs tests/vitest/server/mcp-proxy-cancellation.test.mjs
npm test -- --suite domains.manifest
npm test
```

Connector and client compatibility checks, including downstream agent tool loops, install refresh, and proxy transport, are independently owned. They are not server verification commands and cannot block or promote server readiness.
