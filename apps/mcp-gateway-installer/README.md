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

## Private-endpoint profile

`private-endpoint serve --config FILE` runs the same governed gateway as the
user-controlled receiving endpoint of a private-relay route: it connects out to
the configured opaque relay over WebSocket, presents the endpoint admission,
and serves the paired entry's inner-channel JSON-RPC against the existing
upstream configuration. `private-endpoint check --config FILE` performs the
full offline validation (file reads, protocol fields, material parsing) without
opening a socket or contacting any peer, and prints one JSON summary line.

The endpoint configuration is JSON:

- `relay.url` — the relay WebSocket URL. `wss:` is required; `ws:` is accepted
  only for a literal loopback host. The session path is derived as
  `<url>/session/<tenantId>/<routeId>`.
- `relay.credential` — an `env:NAME` binding for the enrolled bearer token.
  Inline credentials are rejected and the value never appears in output.
- `endpoint` — `tenantId`, `deviceId`, `routeId`, `mode` (`personal` |
  `enterprise`), `admissionGeneration` (≥ 1), `revocationRevision` (≥ 0),
  plus the paired-entry trust fields: `pairedIdentityKey` (base64url SPKI),
  `pairedIdentityFingerprint` (the peer pin for the inner channel),
  `trustGeneration`, `endpointPrincipalRef`, `capabilityGrantRef`, and the
  optional `boundRecoveryKeyId`. `role` is fixed to `endpoint`.
- `innerTls` — `key` and `cert` as `file:PATH` (resolved relative to the
  config file) or `env:NAME` references. This is the TLS 1.3 identity the
  inner pinned mutual-TLS channel terminates on; the material never crosses
  the relay. `handshakeTimeoutMs` optionally bounds the inner handshake.
- `recovery.authorities` — enrolled recovery authority records
  (`recoveryKeyId`, `principalRef`, `publicKey`, `generation`); rotation
  stays staged per endpoint and pending entries remain visible in the state
  surface until acknowledged.
- `recovery.signingKey` — optional `file:`/`env:` private-key reference used
  for endpoint-side recovery acts.
- `gateway.configPath` — the existing gateway configuration file that
  declares upstream services; it is loaded with the same loader and policy
  as the gateway-only profiles.
- `reconnect` — optional `initialDelayMs`/`maxDelayMs` backoff bounds.
- `admin.listen` — optional loopback-only (`127.0.0.1`/`::1`) state listener
  exposing `GET /status`, `GET /healthz` and `GET /metrics`. The metrics
  route renders the same existing counters as `/status` (operations tracked,
  dropped outbound sends, restarts, session/reconnect state, revocation
  revisions, transport queue depth, peer inbox/outbox depths when the peer
  block is enabled) as a Prometheus `text/plain; version=0.0.4` exposition
  under the `meshrix_endpoint_*` names — counters and enum labels only, never
  payloads, identifiers, keys or credentials. `admin.token` optionally binds
  an `env:NAME` credential; when set, every admin route requires
  `Authorization: Bearer <token>` (401 otherwise). Endpoint administration is
  never published through the relay: control arrives only through this direct
  local surface or the authenticated inner channel.
- `peer` — optional peer-messaging block (`{ "enabled": true,
  "storageDir"?: PATH, "peerId"?: ID }`). `storageDir` defaults to
  `peer-state/` beside the config file (relative paths resolve there too)
  and holds the durable Signal crypto state plus the client
  outbox/inbox/cursor stores under owner-only permissions. `peerId`
  overrides the derived `peer:<tenantId>:<routeId>:<deviceId>` identity;
  it must satisfy the peer identifier contract. Absent or
  `enabled: false` means the peer stack is never started.

When `peer.enabled` is on and `admin.listen` is configured, the same
loopback listener exposes the endpoint operator peer surface —
`GET /peer/status`, `GET /peer/inbox?limit=`, `GET /peer/pair-safety?peerDeviceId=`,
`POST /peer/send` (`peerDeviceId` plus exactly one of `text` or
`plaintextBase64url`), `POST /peer/ack-outcome` (`messageId` plus an
`accepted_by_agent` / `completed` / `rejected` outcome), `POST /peer/sync`
and `POST /peer/reconcile`. With the block disabled every `/peer/` route
answers `404 peer_disabled`. Peer requests ride the single admitted relay
session — they are refused with `peer_channel_not_admitted` while the
session is down, never queued into a stale generation. Inbound messages
are durably recorded and surfaced through `/peer/inbox`; the runtime never
executes peer content, and an application outcome reaches the wire only
through an explicit `/peer/ack-outcome` call from a host that actually
consumed it. `peer.status` reports the learned retention policy, durable
cursor, outbox projections, inbox count and observed retention-gap
tombstones honestly — including `decryptError` evidence for envelopes that
cannot be decrypted — and `/peer/pair-safety` returns `null` evidence for
peers whose identity was never observed.

During `serve` the process writes one JSON state line per transition
(`profile: "private-endpoint"`), including the readiness transition once the
relay admits the session. The surface reports honest state only:

- `reachability` is `reachable` only while an admitted session and a live
  socket both exist; anything else reports `endpoint_unreachable`. New work
  is never queued while the endpoint is unreachable.
- `revocationPropagation` compares the locally staged revocation revision
  with the revision the relay acknowledged at admission: `applied`,
  `pending`, or `unknown` before the first admission. A local revocation is
  never claimed complete before remote acknowledgement.
- `recoveryAuthorities` lists each enrolled recovery key's staged state and
  generation.

Socket loss keeps the session cursors and reconnects through
`session-reconnect`; a retryable rejection re-presents with the
relay-expected revocation revision on a fresh session. `SIGTERM`/`SIGINT`
send `session-close`, terminate the transport and drain the gateway; a
non-retryable rejection, relay-issued `revoked` close, or a protocol-failure
close ends the run with the typed outcome instead of hanging. Already
dispatched in-flight work stays honestly uncertain — it is recoverable
through the peer's `operation-query`/`operation-status` channel, which
answers `not_started` only with typed evidence and reports
`dispatched_in_doubt`, `in_progress` or `status_unavailable` for work whose
outcome is unknown. No timer cuts off a healthy in-flight operation. The
existing gateway-only `serve`/`check`/`health`/`migrate` commands are
unchanged by this profile.
