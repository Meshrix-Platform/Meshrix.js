# Gateway-only profile

`@meshrix/mcp-gateway-installer` is the small embedded gateway command. It
uses the public `@meshrix/gateway` contract and does not start the Web Console,
plugins, agents, or optional services.

The installed `meshrix-gateway` command accepts `check [--config FILE]` for
offline configuration validation, or `serve [--config FILE]` to discover
declared upstream MCP services, publish their tools/resources/prompts and start
an HTTP MCP endpoint. `serve --transport stdio` instead serves newline-framed
JSON-RPC on standard input/output, without printing operational text to stdout;
EOF or SIGTERM/SIGINT closes owned sessions. If a signal arrives while a reply is
blocked by stdout backpressure, the CLI drops that undeliverable reply after cleanup.
HTTP `serve` writes one JSON readiness line containing
`interopEndpoint` after the listener is available; on SIGTERM/SIGINT it stops
accepting new HTTP connections, closes active subscription streams, drains
in-flight gateway work and releases its owned resources. `check` starts no
listener or peer. No Docker, account credentials, paid model or Web Console is
required for the local profile.
Active upstream HTTP and stdio calls follow their caller or owning gateway
cancellation signal; they have no separate fixed per-call elapsed-time limit.

Authorized non-read calls use the configured Meshrix.js server data root for a
private SQLite execution-intent ledger shared by HTTP and stdio. The ledger is
opened lazily, so read-only calls do not create persistence files. It records a
prepared intent before upstream dispatch and a conservative dispatch fence
before the final authority check and send. Completed peer success or error is
recorded when the response is valid; a lost response, interrupted dispatch,
invalid result, or input-required pause remains fenced as uncertain. Opening the
ledger for a later non-read operation classifies a prior dispatch fence as
`in_doubt`; startup and later calls never resend that intent. A later explicit client call is a new
intent: this is not exactly-once delivery across arbitrary client retries, and
the gateway does not provide a public receipt or resume workflow. Only one
process may own the ledger data root at a time; configure
`MESHRIX_SERVER_DATA_DIR` to select a dedicated location when needed.

`migrate preview --input FILE` reports a content-digest `sourceRevision` and
redacted changes without writing. `migrate apply --input FILE
--expected-revision DIGEST` performs the original owner's locked compare-and-
swap and preserves the earliest `.backup`, its content-addressed object and
immutable source/target receipt. `migrate restore --input FILE
--expected-revision CURRENT_DIGEST --backup-revision ORIGINAL_DIGEST` verifies
both byte digests before restoring that backup. The installed CLI packages the
same original migration implementation, not a second migration algorithm.

The local profile only listens on `127.0.0.1` and connects either to literal
loopback `http:` upstreams or an explicitly configured owned stdio child.
Stdio service configuration declares `transport: "stdio"`, `command`, bounded
string `args`, and optional `envBindings` containing only `env:VARIABLE_NAME`
references; ambient credentials are not implicitly passed to the child.
Remote targets or public listeners are rejected by default rather than
implicitly opening access without authentication, credential binding and
egress authorization. The optional JSON config has `profile: "local"`,
`listen: { "host": "127.0.0.1", "port": 0 }`, and `services` containing entries
with `serviceId`, `baseUrl`, optional `protocolVersion`, and optional
`authorization` in `env:VARIABLE_NAME` form; inline secrets are rejected. The local listener issues explicit grants only for the
discovered routes. An operator must also declare each executable tool's
`toolRisk` by its upstream name (`read`, `safe_write`, or `destructive`);
undeclared tools remain listed but cannot execute, and upstream annotations
never supply a permission class. Destructive actions still require verified approval and
therefore remain denied in this profile; production policy and credential
stores must be injected by a separate host. A local integration harness may
provide a synthetic peer through `MESHRIX_INTEROP_PEER_ENDPOINT` and a synthetic
upstream token through `MESHRIX_INTEROP_UPSTREAM_AUTHORIZATION`; these variables
never authorize remote endpoints or alter the Core deployment result.

An opt-in `profile: "remote"` requires `remoteAuth.bearerToken`,
`remoteAuth.tlsCert`, and `remoteAuth.tlsKey` as `env:VARIABLE_NAME` bindings,
plus explicit `remoteAuth.allowedServiceIds`. Its listener is HTTPS and checks
Bearer authorization even for health probes; no downstream product catalog is
needed. Each remote upstream must use `https:` and list its exact hostname in
`allowedHosts`; DNS/address policy is rechecked and pinned per request, and
redirects are not followed. The local HTTP listener accepts a present `Origin`
only when it matches the actual `http://127.0.0.1:<bound-port>` endpoint. A
remote listener accepts present origins only from the optional
`remoteAuth.allowedOrigins` list of HTTP or HTTPS origins, compared by
normalized scheme, hostname, and effective port. Allowed origins omit paths,
queries, fragments, and credentials. Missing `Origin` remains valid for
non-browser MCP clients; an invalid or unlisted present value receives HTTP 403
before request parsing or dispatch. The gateway never derives origin trust from
`Host` or forwarded headers. This setting validates origins and does not
configure CORS. A local TLS test may explicitly set
`allowLoopbackUpstreams: true`; it is false by default. Remote stdio children
are not supported, and inline secrets or unclassified tool effects remain
rejected. This is a configured profile, not permission to deploy it or contact
a real external provider in a local acceptance run.
