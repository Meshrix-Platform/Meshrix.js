# Gateway

> **Meshrix.js trusted-forwarding requirements:** verifiable identity,
> non-amplifying authority, content integrity, and end-to-end traceability.
> [Governed Execution And Minimum Evidence](../architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md)
> owns their normative meaning.

The gateway is the upstream service forwarding boundary and the runtime consumer of authenticated, revisioned service publications after they pass the control-plane, security, and acceptance contracts below.

Optional first-party MCP client-adapter components ship with `meshrix.js` and are selected explicitly by the connector. Gateway embedding does not require those client integrations or their host applications.

## Current Runtime Status

Authenticated maintainers publish closed service commands through `/api/gateway/v1/services` and its service-specific replace, disable, remove, and republish routes. Runtime HTTP, RPC, MCP, and console surfaces expose discovery, audit, metrics, publication state, and governed forwarding from the accepted immutable snapshot.

The production composition binds the control-plane application service, canonical manifest compiler and writer, manifest observer, immutable gateway snapshot, Operation Permission catalog publication, scoped audience projection, and MCP catalog-delivery protocol. The console is a consumer of the public server API and is not a publication authority.

## Deployment Profiles And Edge Boundary

The self-contained Node.js listener is the implemented embedded profile. It
can accept HTTP directly for local, development, desktop-adjacent, and bounded
single-node deployments without requiring an external reverse proxy.

For production deployments, an operator may place an independently admitted
Nginx, Caddy, Envoy, or equivalent edge in front of Meshrix.js. The edge may own
TLS, HTTP protocol negotiation, connection reuse, coarse-grained rate limits,
load balancing, and standard edge observability. It does not parse Meshrix.js
governance semantics and cannot authorize an operation, mint or consume a
governed permit, resolve a credential, approve an action, or emit Meshrix.js
governance evidence.

Meshrix.js remains the semantic gateway in both profiles. It interprets HTTP,
JSON-RPC, and MCP contracts; resolves registered operations; applies
authentication, Operation Permission, tag, risk, approval, and traffic policy;
injects scoped credentials at the protected sink; manages protocol sessions;
and emits bounded redacted evidence. An external edge therefore augments the
Node.js runtime instead of replacing the application gateway.

The console can load a portable service document with kind
`meshrix.upstream-service` and schema version
`v0.0.1:upstream-service:portable-import-2`. The document contains only a
`serviceKey` and the complete service `descriptor`. File selection and validation
are local operations. Import loads the validated document into the editable
draft. The ordinary **Publish** action is the only submission path: it submits
the existing authenticated publishing command and then observes the accepted
publication until `server_published`, after which it runs the service health
check. Import never starts a service, installs a plugin, or embeds credential
material.

The Console observes an accepted publication with one view-owned, cancellable
observer per retained service id and accepted service revision. The observer
owns its status-query request and interval timer and has no attempt or business
deadline: a slow publication keeps observing until the retained revision
publishes. Unmount, navigation, selection change, explicit stop, or replacement
disposes the owned request and timer without cancelling the accepted server
publication, which keeps running. A status-query failure only interrupts the
observation and leaves the accepted state visible with an explicit resume
action; resuming queries the retained revision again and a stale observer
result never advances a newer selection. Only authoritative server facts settle
the projection: the retained revision reaching `server_published` advances to
the runtime health check, while the revision being superseded or removed is the
separate authoritative failure. An observation interruption, an authoritative
publication failure, and the independent runtime-health result are three
distinct projections.

Every HTTP or JSON-RPC operation now publishes an explicit `payloadTransport`
contract. The request representation is explicit; an HTTP operation may omit
the response representation to use governed native passthrough (an 8 MiB
bounded `opaque_stream` with an allowlisted response-header policy). Explicit
`structured_json`, `opaque_stream`, or `artifact` response settings remain
available when the caller needs them. `structured_json` retains bounded JSON validation and projection;
`opaque_stream` carries native HTTP bytes; `artifact_body` and
`artifact_multipart` resolve owner-bound upload, artifact, or workspace-file
references; and an
`artifact` response is committed privately and returned to MCP as a
`resource_link`. Files are not Base64-encoded by the gateway. The complete
file-conversion import example is
[file-parser-format-convert.upstream.json](../examples/file-parser-format-convert.upstream.json).
Import registers the already deployed service; it does not start the converter
or install a plugin. Publish assigns an opaque server-side service id
(`svc_…`); compiled capability and projected MCP tool ids derive from that id
(for example `cap:upstream:svc_…:convert` and `upstream.svc_….convert`), not
from the descriptor `serviceKey`, so grants bind to the id returned by the
publish response.

Each configured HTTP or JSON-RPC operation is published once to downstream MCP
through its canonical Operation Permission projection. The registry's MCP
`tools/list` and `tools/call` route is reserved for tools discovered from an
upstream MCP service; it does not publish a second configured-operation tool.
Calls to configured operations execute the registered Operation Permission
operation and retain its final protected-sink permit at the upstream send. Their published
input schema is the complete declared request schema, and caller arguments stay unchanged
through validation, approval binding, and permit issuance; the registered executor maps
them once to the operation's body, query, or JSON-RPC parameters after admission. A service-level
MCP `tools/call` projection remains an internal authority record for discovered per-tool calls,
not a second generic public tool.

## Upstream Service Publishing Contract

One governed transaction preserves safe forwarding behavior:

1. Authenticate the service developer and bind create, replace, disable, or republish to a server-owned service identity, maintainer authority, expected revision, and idempotency key.
2. Parse a closed, bounded publishing command for REST or JSON-RPC operations, an explicit request representation and optional HTTP response representation, typed certificate and credential references, permissions, risk, approval, traffic policy, and allowed organization, team, role, grant, or other governed audiences.
3. Compile canonical manifest bytes without evaluating caller data as a path, filename, command, template, environment name, header name, expression, or configuration fragment.
4. Persist through a dedicated control-plane writer into a server-configured manifest root. The gateway identity has read and traverse access only, mutable runtime state uses another root, and publication uses durable staging and atomic replacement.
5. Treat filesystem events as invalidation hints, validate a complete manifest-set revision, build an immutable snapshot outside the request path, and atomically swap one reference without restarting the server. An invalid candidate leaves the last accepted snapshot authoritative.
6. Compile every enabled operation deterministically into Operation Permission and publish one catalog revision only when it identifies the same gateway manifest-set revision.
7. Recompute affected tag and grant visibility with deny precedence and discovery/execution parity, then emit revision-only invalidations to affected downstream partitions. Notifications contain no catalog, schema, credential, certificate, raw tag, or subject data.
8. Expose authenticated catalog pull, acknowledgement, disconnect, timeout, and reconnect fencing through the published protocol. A neutral protocol peer verifies these server semantics; consumer cache replacement is independently owned.

The mutation API returns `publishing` after the durable candidate is accepted. Authenticated service reads expose a separate `publication` object: `server_published` appears only when the durable published snapshot and the gateway, catalog, audience, and protocol-delivery revision chain agree; its terminal facts include the source revision and digest plus the catalog, audience, and protocol revisions. It never asserts client adoption. A protocol timeout disconnects and fences the affected session without rolling back authoritative server publication.

The public command, result, publication, summary, and detail shapes are defined once in `packages/contracts/src/upstream-service-publishing.ts`: the closed authorized command union (`create`, `replace`, `disable`, `remove`, `republish`), the accepted mutation receipt with its candidate publication, the published service list/detail responses, and the separate publication union. A durable service state is `publishing`, `disabled`, or `removed`; the `publication` object is `publishing` or `server_published`, and only `server_published` carries terminal source, catalog, audience, and protocol facts. The Agents publishing ingress keeps raw command parsing, closed-field, ownership, expected-revision, idempotency, and typed-reference validation; the server-runtime operation executor only shapes the request/result transport against the typed application, and the Console client and views consume the same types instead of maintaining their own publishing schema. A portable import document keeps its own `PortableUpstreamServiceImport` semantics and is not a publishing command.

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

In Console service publishing, **Service information → Allow loopback or private-network access** edits this existing descriptor permission. It is off for a new service and is never enabled automatically from its URL. Enable it only for an intentionally configured local/private upstream, then publish the change. Existing imports, service edits and browser drafts preserve the explicit choice. If a local MCP service is published but its concrete tools are unavailable, check this setting before retrying tool discovery; a broad client grant does not bypass the upstream network policy.

An MCP stdio upstream process receives only the portable execution baseline needed to start the configured command, descriptor-declared `mcp.env` values, and credential-reference environment bindings. It does not inherit unrelated server, provider, database, or operator environment variables. A service that needs an additional variable must declare that binding explicitly in its descriptor.

Each upstream gateway registry owns one bounded MCP session manager. The supported execution isolation scope is the trusted governance principal plus grant. Meshrix.js does not isolate conversations by TCP connection or child process; different business contexts under the same principal need an explicit business handle. Discovery and health sessions are ephemeral: they reuse an initialized transport by service, purpose, and credential-reference revision, and idle or maximum-lifetime limits may reclaim them. Execution sessions are stateful: effective state is held across idle and maximum-lifetime timers and is not LRU-evicted to admit another caller. Missing trusted principal or grant identity fails closed instead of opening a shared empty-principal session. If an upstream stateful context disappears, that call returns an explicit state-loss error and does not replay the business operation; the same logical session cannot silently become a new upstream context. Only a new lifecycle boundary may rebuild: a newer service or credential generation, an explicit scope retirement, grant or API-key rotation or revocation, or a service disable, republish, delete, or credential-generation change. Those service events still retire every `svc:<serviceId>:…` scope. Grant token rotation, grant revoke or delete, and API-key rotate or revoke reuse the owning audience-refresh notification, match the event identity against the session grant or principal so the ordinary API-key path is not skipped, refuse reuse of the retired execution session, and reclaim it after in-flight requests drain. When execution sessions fill capacity, rejecting a new caller is an explicit capacity failure; existing callers keep their state and a small reserved ephemeral channel remains for catalog refresh and health. A state-lost logical session keeps consuming that execution ownership until an explicit release or a newer generation; the manager does not TTL- or LRU-forget the loss to admit another caller. Failed capacity admission does not leave scope metadata. Per-session and manager-wide concurrency limits reject excess work. Registry shutdown closes all owned sessions. Shared HTTP and stdio `tools/list` follow opaque upstream cursors exactly, including whitespace, until the catalog is complete; an invalid typed or repeated cursor fails closed instead of returning a partial catalog. Advertised MCP `inputSchema` is enforced on governed execution, including `$ref` siblings and local JSON Pointer escaping, while control-plane closed schemas stay strict.

The Agents upstream-gateway feature consumes a narrow domain-owned schema port
for synchronous budget inspection and isolated input validation; the
composition root injects the Gateway-backed implementation, and Agents never
imports Gateway internals or kernel error types. A registry owns one injected
port for its lifetime: the Gateway-backed port reuses one lazily started,
bounded Worker pool for schema calls, and registry shutdown closes that pool
after active work settles. Worker module/Ajv initialization completes before a
schema job begins its execution budget; hostile schema compilation and value
validation remain inside the isolated Worker and the existing execution budget.
Caller cancellation propagates through the port and releases the affected job.

The registry factory and its public methods are typed by
`packages/agents/src/upstream-gateway/registry-types.ts`: options are explicit
per port, and the mutable runtime state is single-owned and modeled — the
service map, the public tool-prefix index, the projected-operation route
targets, MCP tool cache records, refresh flights with their waiter sets,
config-preparation controllers, skill-hub subscriptions, endpoint traffic
buckets, cursors and circuits. Manifest snapshot commits narrow the incoming
snapshot before replacing those maps and return a typed diff; the durable
runtime WAL is a discriminated `seed`/`delta` record with a typed audit/metric
state. Unknown caller or provider input stays `unknown` until the existing
normalization accepts it.

This session manager is a server-side gateway transport, not a Meshrix MCP
client product or an unmanaged connection API. Streamable HTTP sessions require
the gateway to inject its managed egress transport; there is no native `fetch`
fallback. Therefore upstream MCP forwarding uses the same DNS pinning,
restricted-address denial, redirect handling, and administrator-controlled
local-network policy as the rest of the gateway, and a construction path that
omits that transport fails closed before opening a connection.

The legacy stdio transport keeps one initialized child process for concurrent requests and routes replies by JSON-RPC id. The legacy Streamable HTTP session transport performs the MCP initialize/initialized lifecycle, sends the negotiated `MCP-Protocol-Version` and any issued `MCP-Session-Id` on subsequent requests, parses SSE incrementally so notifications may precede the matching result, and uses `DELETE` for best-effort logical session shutdown. An ephemeral session may rebuild once after a session `404`; a stateful execution session returns state loss instead of replaying the call or opening a silent replacement context. Its notification callbacks use one bounded sequential queue per session (`64` messages and `1 MiB`); overflow makes the upstream session fatal instead of creating unbounded callback work. Descriptor or credential headers cannot replace the required JSON `Content-Type`, JSON/SSE `Accept`, session, or protocol headers. At the transport boundary, an explicitly configured positive integer `mcp.timeoutMs` applies to initialization and each MCP business request (`tools/list`, `tools/call`, `resources/read`, `prompts/get`, and `completion/complete`); a positive integer per-call `requestOptions.timeoutMs` overrides it for that request. Explicit budgets must be whole milliseconds within the runtime timer range (1 through 2,147,483,647); invalid values are rejected instead of rounded, clamped, or replaced by an implicit deadline. If neither is supplied, the transport adds no business-request deadline, so caller cancellation or owning-session closure controls settlement. When a higher-level owner already applies the request budget through its cancellation signal, that owner explicitly supplies the internal `requestOptions.timeoutMs: null` marker and the manager forwards it so the session does not restart the budget. A normal cancellation signal without that marker continues to use configured `mcp.timeoutMs`; null is not a nullable descriptor setting. Initialization uses its configured budget or a separate 30-second setup fallback, while HTTP control notifications retain an independently bounded budget. Higher-level configuration normalization determines which explicit budget and cancellation signal reach this session manager. Meshrix's legacy upstream session transport supports `2025-03-26`, `2025-06-18` (the default), and `2025-11-25`. Separately, the platform's modern upstream HTTP path uses `server/discover` followed by `tools/list` for `2026-07-28` through the same configured pinned-DNS transport and credentials, without initialize/session handshakes. Catalog publication waits for a complete valid list across opaque cursors under the shared 64-page, 4,096-tool, and 8 MiB limits; malformed pages, invalid or repeated cursors, failed discovery, and cancellation never publish or cache a partial list. The existing registry cache, single-flight refresh, and independent waiter cancellation remain in force. Modern upstream stdio is not configured and returns an explicit unsupported-transport failure.

Projected upstream business operations have no platform-imposed elapsed-time
deadline when neither the operation nor the MCP service configures a positive
request budget. Omitted budgets remain absent through normalization, catalog
projection, and `executeTool`; caller cancellation or owned registry shutdown
controls settlement. An explicitly configured positive operation timeout or
`mcp.timeoutMs` remains effective. MCP initialization, health checks, and
control notifications keep their separate setup or maintenance budgets and do
not become business-operation defaults. Admission retains its FIFO and bounded
capacity. A caller-supplied absolute queue deadline takes precedence over a
configured operator queue budget; when both are absent, queue waiting has no
elapsed-time deadline, and an expired waiter is checked again before dispatch.

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

For a published discovered upstream MCP `tools/call` classified as effectful, the
platform records an operation intent against the exact consumed execution permit
before execution-time credential resolution, call-scoped discovery, or session
setup; the earlier read-only catalog projection does not create an effect intent.
At the selected
transport boundary it records a durable dispatch-admission receipt, then performs
the current protected-sink check immediately before HTTP fetch or stdio write.
The HTTP check runs after DNS admission; the stdio check runs after write-queue
admission. Discovery, initialize handshakes, and read-only requests do not consume
the effect's dispatch fence. The kernel records success or a known tool failure
only after decoding and output-policy validation. A dispatch with a lost,
malformed, or nonterminal response remains `in_doubt`; the same fenced invocation
is not automatically resent after session recovery. A new explicit client call
creates a new permit and intent, so this boundary does not claim exactly-once
execution across arbitrary client retries.

Streaming authorization may finish before bulk bytes are read, but approval or
body-dependent policy must first stage a bounded, owner-bound artifact and bind
its digest into a fresh permit. Revalidation follows traffic-slot acquisition,
approval waits, retries, and session rebuilds. The lifecycle emits only compact
governance proof; byte transfer, routine success, ordinary denial, and
backpressure telemetry are counters or sampled diagnostics, not per-chunk or
per-request durable logs.

This section is a maintenance and Functional Release Gate invariant. A
representation adapter that has not converged on the shared permit and proof
lifecycle fails the gate even if its current controller authenticates and
authorizes the caller.

1. Resolve route and upstream operation.
2. Authenticate subject.
3. Evaluate Operation Permission, tag policy, risk policy, and approval requirements.
4. Apply the descriptor traffic policy through the gateway's token-bucket-with-concurrency control.
5. Redact secrets before logging or auditing.
6. Call the upstream service through the operation's explicit representation adapter.
7. By default, pass the upstream response through without implicit redaction, field projection, or response reconstruction. If an operation explicitly configures `responseSchema`, `publicResponseFields`, or `sensitiveBodyFields`, apply that policy before public output. For opaque HTTP, stream permitted headers and exact bytes. For an artifact response, commit it to owner-bound storage and expose only its resource metadata.
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
The upload-session create, read, and raw-chunk routes require the dedicated
`uploads:write` scope. The grantable `meshrix.uploads.write` toolset is
`safe_write`; native file upload does not grant the repair-capable Jobs write
surface.

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

Caller cancellation is carried from the downstream MCP HTTP request or Operation Permission execution context through the console executor and gateway registry to the selected upstream transport. HTTP cancel is the current request's response-stream or parent-signal abort; it does not scan other POSTs by JSON-RPC id, grant, process, session, or proxy-session header. The stdio connector aborts only its local dispatcher AbortController for that in-flight request and does not POST `notifications/cancelled` to the HTTP adapter. Standard MCP clients need no proxy session header. A cancelled in-flight upstream MCP request emits a best-effort `notifications/cancelled` message for its own upstream JSON-RPC id and terminates only that request; initialization is not cancellation-notified. Timeout and caller cancellation use fixed public reasons and are reported separately as `504` and `499`. The traffic slot is released in the forwarding `finally` path, while other requests sharing the same upstream session continue independently.

Downstream HTTP MCP is the declared Streamable HTTP revision `2026-07-28`. Ordinary success results include `resultType: "complete"`. Discover advertises `supportedVersions` and server identity in `_meta["io.modelcontextprotocol/serverInfo"]`. Every JSON-RPC request carries `params._meta["io.modelcontextprotocol/protocolVersion"]` and an object-valued `params._meta["io.modelcontextprotocol/clientCapabilities"]`. HTTP requests also carry matching `MCP-Protocol-Version` and `Mcp-Method` headers, plus `Mcp-Name` for name-bearing methods. The standalone stdio adapter enforces the same body metadata without requiring HTTP mirror headers. Authorization-scoped `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`, and successful `resources/read` results carry `ttlMs: 0` and `cacheScope: "private"`. HTTP notifications receive an empty `202` acknowledgement; stdio emits no notification reply. HTTP POST accepts exactly one JSON-RPC message; a batch is rejected before authorization or execution. Modern `initialize` is not a downstream method. The published and offline standalone connectors share `http-mcp-adapter-client-wire` through package exports and portable vendor assembly; they do not import the server protocol owner. Standard MCP clients authenticate by capability and do not need a private identity or proxy-session header. Upstream forwarding has two implemented paths: modern HTTP performs `server/discover`, complete `tools/list` pagination, and governed `tools/call` at `2026-07-28` without initialize/session state, while the stateful/ephemeral initialize/session transport above is legacy `2025-06-18`; modern upstream stdio is not configured. New support fields, standard-client admission, and configured business response policy remain in force.

The stdio connector dispatches concurrent local requests. Cancellation is that request's local AbortController; it does not POST `notifications/cancelled` and does not use a proxy-session header as a cross-request cancellation key. A connector-generated proxy session is optional correlation for connector-managed identity only. Its parser and dispatcher enforce finite frame, input-buffer, active-request, and pending-work limits. Its stdout writer performs at most one underlying write before `drain`, bounds queued messages and bytes, waits for output drain during close, and stops input and active work when output capacity or the drain deadline is exceeded. Capacity rejection uses a fixed JSON-RPC error, ordinary notifications are best-effort at capacity, and an admitted request reserves enough work capacity for its own local cancellation.

## Governance

Canonical gateway verification runs against the repository's self-contained upstream fixture service (`tools/server-scripts/upstream-fixture-service.ts`). The fixture exposes the same forwarding surfaces a production upstream service would: a deterministic HTTP API (records, echo, identity, state probe) and an MCP server over stdio and HTTP transports. Current verifiers publish it through the authenticated control-plane contract and durable manifest authority, then bind credentials through runtime `secret://` references. The fixture returns redacted credential-arrival proof (hashes and presence flags) so evidence can confirm gateway-side injection without recording secret material. Reports record only redacted hashes, response sizes, audit flags, and embedded timestamps instead of account identifiers, credentials, or raw response bodies.

Server protocol conformance uses a neutral downstream peer generated from the MCP and catalog-delivery contracts. It exercises `server/discover`, tools/list, governed tools/call, denied destructive call, request-lifetime cancellation, scoped invalidation, authenticated pull, acknowledgement, disconnect, and reconnect fencing without loading a connector or client implementation. Target-specific connector and client probes remain separate compatibility checks and cannot block or promote a server receipt.

Native downstream installation requires an administrator-issued scoped API Key supplied through the documented environment variable or protected standard input. The connector validates the key before I/O, stores only the environment-variable reference, and sends only `X-Meshrix.js-Api-Key`. The server authenticates the workload before catalog projection and routes every permitted call through canonical Operation Permission; optional pending-operation approval remains a separate post-authentication control. Local uninstall removes connector-managed configuration without a credential or server request.

Eligible API Key issuers receive current upstream MCP tool facts from `/api/operation-permission/v1/api-keys/issuer-scopes`. Each fact identifies one tool by service ID and public name and includes its capability, scopes, toolsets, and risk. A key policy grants only the exact discovered tool capabilities selected in the Console. The service-level `tools/call` Operation Permission record remains the internal execution authority; selecting that record or its toolset does not grant every discovered tool from the service. Discovery is reported as available, partial, or unavailable. Only confirmed tools are selectable; stale selections block issuance until removed or replaced by a current identity, and tools published after issuance remain outside that key’s capability set.

The connector-managed downstream adapter target set is OpenClaw, Codex, Claude Code, Antigravity, OpenCode, Pi, and Kimi CLI. First-party adapter components are private modules bundled with `meshrix.js`; the connector resolves them from the installed root package and invokes them only for an explicit target action. Each component owns its client commands, configuration format, probes, and target-specific mutation behavior behind the bounded JSON-stdio contract. The connector owns target selection, authorization, credential custody, proxying, and install/uninstall orchestration. Client applications remain independent external products.

The pre-release format-convert compatibility fixture projects one external
`POST /v1/convert` route as
`convert-require-approval-debug` and `convert-full-access-debug`. The first
waits for an Operation Permission approval receipt. The second skips only that
wait; it still requires the same Grant, capability, scope, risk, audience,
service, owner, execution permit, audit, and protected-sink checks. These are
diagnostic operation identities for the acceptance fixture, not a general
production recommendation to duplicate operation names.

Destructive fixture tools stay hidden from downstream projection. The approval
verifier first proves that the pending call produced no upstream side effect,
then resolves the shared pending operation and requires exactly one
credential-bound upstream MCP call. Repeated approval is rejected without
replay, while rejection and expiry leave the upstream hit count unchanged. The
dedicated functional reducer rejects reports that contain only
`pending_approval` without the resume, exactly-once, no-side-effect,
audit-correlation, and credential-binding evidence.

Other upstream services use the same descriptor and operation policy model. A live external HTTPS compatibility probe remains available as an explicitly optional check (`MESHRIX_UPSTREAM_EXTERNAL_COMPAT=1 npm run verify:upstream-gateway-external`); it is excluded from default and container gates.

## Response Policy

HTTP, JSON-RPC, and MCP operations may declare a JSON `responseSchema`, `publicResponseFields`, and `sensitiveBodyFields` on each operation descriptor. With none of those fields configured, the gateway does not redact, project, or reconstruct the upstream result; structured callers still receive the normal protocol envelope, while native HTTP transit preserves the upstream response bytes. Any explicitly configured schema, public-field projection, or sensitive-field filter requires a structured JSON response; a non-JSON or malformed response is rejected before public output instead of falling back to opaque text. For MCP, the policy applies to `structuredContent` or JSON text before public projection, and configured filtering rejects opaque text blocks. A configured schema must also validate before forwarding. Public responses contain only the declared dotted JSON paths after configured fields are redacted. Raw upstream MCP error text is not copied into public errors or persisted audit payloads.

## Verification Evidence

The upstream gateway E2E verifier publishes local fixture services through the durable manifest writer and writes scoped secret-store records before startup. It then runs health and policy preview, forwards through HTTP/RPC/MCP, records audit and metrics, exercises approval and traffic controls, and runs destructive input coverage. Traffic evidence covers both token bucket exhaustion and `maxConcurrent` in-flight rejection on the same governed forwarding path used by HTTP, RPC, console, and MCP callers.

The upstream fixture transit verifier (`npm run verify:upstream-fixture-transit`) registers the self-contained fixture twice — once as a REST/HTTP external service with `responseSchema` and `publicResponseFields`, once as an MCP service over stdio with an HTTP-transport variant — then proves REST forwarding, MCP tool projection and transit, `state.increment` followed by `state.probe` in the same initialized stdio session, secret-store credential injection on both header and env paths, identity-proof redaction, downstream tool visibility, and denial paths (missing scope, destructive without approval). The managed-session transport tests additionally cover concurrent id routing, SSE notification/result interleaving, session headers and `404` rebuilding, cancellation without side effects, slot release, and isolation of a concurrent peer request.

The downstream agent tool-loop and connector installation verifiers exercise
the first-party adapter components shipped in `meshrix.js` and the selected
external client's compatibility. They may validate a real `meshrix-mcp proxy`
or locally installed target, but their reports are outside the server
functional DAG. Server cancellation and downstream protocol
behavior are instead proven through the neutral protocol peer against `/mcp`,
Operation Permission, the gateway registry, and the deterministic upstream
fixture.

The fixture service can also be started standalone for manual inspection:

```bash
node tools/server-scripts/upstream-fixture-service.ts --mode http --port 0
node tools/server-scripts/upstream-fixture-service.ts --mode mcp-stdio
```

## Verification

The commands below are separated by ownership.
`verify:upstream-service-publishing` is the canonical positive server gate. One
run writes the recomputable authority report at
`build/reports/upstream-service-publishing.json`. The mandatory pre-release
skill then runs the isolated external-service and downstream-agent journey and
writes `build/reports/upstream-service-publishing.html`. The report records the
exact safe startup, native upload-session, raw binary chunk, owner-bound
`upload:` reference, and connector configuration, then embeds ten digest-bound
screenshots captured from the real Meshrix.js Web Console: authenticated
publishing, basic configuration, operation configuration, published runtime
health, tool catalog projection, pending Token authorization, completed Token
authorization, pending operation approval, completed operation approval, and
the downstream MCP call matrix. It also records the complete seven-target
catalog and requires installation, upload, tools/list, both debug calls, and
cleanup to pass for every detected local target; missing local commands remain
`not_detected`. Simulation is forbidden whenever any supported local client is
detected. When and only when all seven clients are `not_detected`, the journey
uses one explicitly labelled `mcp-simulator` fallback and reports it as
protocol-path evidence rather than client compatibility. Its connector
bootstrap also proves that unrelated workspace
authority is not amplified: one expected `meshrix.agentWorkspace.list`
`missing_capabilities` denial is required per real or simulated execution target and is reported
separately from the two successful conversion branches. Synthetic pages,
receipt cards, and DOM-only snapshots are not evidence. The offline report includes
English and Simplified Chinese copy with a right-aligned language switch. It
is local-only under Git-ignored `build/`; synthetic fixture and generated
platform identifiers remain visible while credentials and protected identities
remain protected. The report identifies the operation `maxBytes` value as a
single multipart request-envelope bound, separate from the external service's
file-size budget and from any global Meshrix.js upload policy:

```bash
npm run verify:upstream-gateway
npm run verify:upstream-service-publishing
npm run verify:release-journey -- --image-name <local-image>
npm run verify:upstream-fixture-transit
npm run verify:console-gateway-mcp-workflows
npx vitest run tests/vitest/server/http-mcp-adapter-cancellation.test.ts tests/vitest/server/mcp-sse-admission.test.ts tests/vitest/server/upstream-mcp-session-manager.test.ts tests/vitest/server/upstream-gateway-session-cancellation.test.ts tests/vitest/server/mcp-proxy-cancellation.test.ts
npm test -- --suite domains.manifest
npm test
```

Connector and client compatibility checks, including downstream agent tool
loops, install refresh, and proxy transport, are independently owned. They are
not server functional verification commands and cannot block or promote the
Functional Release Gate.
