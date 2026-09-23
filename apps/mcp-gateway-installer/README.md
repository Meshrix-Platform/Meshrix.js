# Gateway-only profile

`@meshrix/mcp-gateway-installer` is the small embedded gateway command. It
uses the public `@meshrix/gateway` contract and does not start the Web Console,
plugins, agents, or optional services.

The installed `meshrix-gateway` command accepts `check [--config FILE]` for
offline configuration validation, or `serve [--config FILE]` to discover
declared upstream MCP services, publish their tools/resources/prompts and start
an HTTP MCP endpoint. `serve --transport stdio` instead serves newline-framed
JSON-RPC on standard input/output, without printing operational text to stdout;
EOF or SIGTERM closes owned sessions. HTTP `serve` writes one JSON readiness line containing
`interopEndpoint` after the listener is available; it remains active until
SIGTERM/SIGINT, then drains and releases its owned ports. `check` starts no
listener or peer. No Docker, account credentials, paid model or Web Console is
required for the local profile.

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
redirects are not followed. A local TLS test may explicitly set
`allowLoopbackUpstreams: true`; it is false by default. Remote stdio children
are not supported, and inline secrets or unclassified tool effects remain
rejected. This is a configured profile, not permission to deploy it or contact
a real external provider in a local acceptance run.
