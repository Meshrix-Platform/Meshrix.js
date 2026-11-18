# Meshrix Client Adapter Kit

The bundled first-party adapters configure native remote MCP. They do not install a
local proxy, start an Agent, resolve credentials, or establish connectivity.

## Request and result

The existing JSON-stdio actions remain `describe`, `scan`, `install`, `verify`, and
`uninstall`. A registration request contains:

```json
{
  "baseUrl": "https://gateway.example",
  "serverName": "work",
  "credentialRef": { "kind": "env", "name": "MESHRIX_WORK_KEY" },
  "client": { "command": "client-command" }
}
```

`client.configPath` or `client.configRoot` can select an isolated/native configuration
location. The server name identifies one endpoint and authorization reference. A
conflicting binding must use another name; registration never silently replaces it.
The endpoint is `<baseUrl>/mcp`. Remote URLs require HTTPS; HTTP is accepted only
for literal IPv4/IPv6 loopback development addresses. Embedded URL credentials,
queries and fragments are rejected. Environment names use `[A-Z_][A-Z0-9_]*`.

Adapters reject credential values and obsolete connector requests. Native headers
reference the selected environment variable as `X-Meshrix.js-Api-Key`; no Bearer,
OAuth issuer, client identity header or shared credential store is introduced.

`describe.nativeRegistration` states the target's qualified capability. `scan`
separates executable availability from configuration state. `verify` compares the
expected transport, endpoint and authentication reference, not just entry presence.
A successful install returns `status: "configured"`,
`credentialStatus: "external-reference-unverified"`, and `connectivity: "not-run"`.
Configuration does not provision that variable for later CLI or GUI launches.

## Native formats

| Target | Native remote entry | Selected reference |
| --- | --- | --- |
| Codex | `mcp_servers.<name>.url` | `env_http_headers` |
| Claude Code | `mcpServers.<name>`, `type: "http"` | `${NAME}` in headers |
| OpenCode | `mcp.<name>`, `type: "remote"`, `oauth: false` | `{env:NAME}` in headers |
| Pi | `mcpServers.<name>.url` | `${NAME}` in headers |
| OpenClaw | `mcp.servers.<name>`, `transport: "streamable-http"` | `${NAME}` in headers |
| Kimi Code | Remote transport exists | Bearer-only reference cannot authenticate this service |
| Antigravity | `serverUrl` remote transport exists | Protected static-key header reference is unqualified |

Kimi and Antigravity installs return `unsupported_protected_header_reference` before
configuration access. There is no plaintext or proxy fallback. Claude Code reserves
some provider credential variable names; use a dedicated name for the selected
Meshrix authorization, not a provider credential name.

## Ownership and cleanup

Install retains unrelated servers and existing enablement, permissions and other
policy fields. Only an exactly recognized former Meshrix proxy with the same
endpoint, target and variable reference may be converted in place. Uninstall
removes only a matching registration; external environment state, native auth
stores, optional proxy credential files and independent assets are preserved.
Codex's positively identified generated marketplace duplicate is disabled, not
re-created alongside the native registration; its independent assets are retained.

Focused verification: `npm run verify:local-client-adapters`. Fixture CLI tests
prove adapter behavior, not compatibility with every installed client version or
successful real-service authorization.
