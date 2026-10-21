# Meshrix.js MCP Connector Runtime

This directory owns the Node.js MCP installer and connector runtime: local
discovery, registration, target selection, explicit client configuration,
uninstall, diagnostics, and API-Key-authenticated stdio proxy forwarding.

The runtime is part of the `meshrix.js` npm package. Its public command is the
root package's `meshrix-mcp` bin. Native registration writes a remote endpoint
and protected environment reference, not an executable command. The local installer
and optional proxy are not required for subsequent native client connections.
There is no separately installable connector npm package.

Install the published package's Node command:

```bash
npx --yes --package meshrix.js@<VERSION> meshrix-mcp register
npx --yes --package meshrix.js@<VERSION> meshrix-mcp install --target auto --url https://gateway.example --server-name work --token-env MESHRIX_WORK_KEY --json
npx --yes --package meshrix.js@<VERSION> meshrix-mcp doctor --token-env MESHRIX_WORK_KEY --json
npx --yes --package meshrix.js@<VERSION> meshrix-mcp uninstall --target codex --url https://gateway.example --server-name work --token-env MESHRIX_WORK_KEY --json
```

The root package also exposes `meshrix-mcp` as its npm bin. In a portable
release archive, the `meshrix-mcp` launcher (or `meshrix-mcp.ps1` on Windows)
starts the sibling verified Node runtime and forwards the same subcommands.
There is no standalone shell or PowerShell installer implementation.

The seven target descriptors use optional first-party client-adapter components bundled
with `meshrix.js` and included in the portable connector's declared runtime
closure. The connector resolves the selected component through standard Node
package resolution and invokes it only for an explicit target action. No adapter
is fetched from npm or installed into a separate cache, and scanning a host does
not change client configuration. Each component owns its target's command
discovery, configuration format, probes, and mutation behavior behind the bounded
JSON-stdio protocol.

Codex, Claude Code, OpenCode, Pi and OpenClaw support native remote registration
using `X-Meshrix.js-Api-Key` environment references. Kimi Code's bearer-only reference
and Antigravity's unqualified protected-header reference fail before mutation.
OpenClaw aliases are not qualified. Remote registration is not remote configuration
management: only local client configuration locations are supported.

Use a distinct `--server-name` for a different endpoint or authorization reference.
`--client-config` or `--client-config-root` selects an explicit configuration
location for exactly one target. Conflicts fail rather than replacing user settings. Install reports configuration,
external credential readiness and native connectivity separately; the client must
receive the selected variable securely at launch. `--token-stdin` cannot establish
persistent client state and is rejected for native installation. Native uninstall
preserves external variables, native authentication stores, optional proxy credentials
and independent assets. See [the native registration architecture](../../../../../docs/architecture/MCP-NATIVE-INSTALLER.md)
for the complete contract.

The source entry remains useful for development and focused verification:

```bash
node packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts proxy --target opencode
node packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts doctor --json
```

Install/config discovery is not proof that the real stdio proxy transport works;
proxy readiness is covered by the MCP proxy transport verifiers.

The shared proxy serves the MCP `2025-11-25` tools profile over stdio.
It handles `initialize` and `notifications/initialized` locally, independently
of the upstream HTTP protocol version. Unsupported requested versions receive
the connector's supported version for the client to accept or reject. This
behavior is the same for every client product. Tool requests retain the modern
HTTP metadata, authentication, authorization and cancellation path. Local
initialization does not establish upstream availability or access; clients
must successfully list or call tools to establish those facts.

After a proxy request or artifact download is admitted, the connector applies
no implicit elapsed-time cutoff to its response headers or body; an explicit
caller-selected helper budget remains active. The `proxy` and
`fetch` commands cancel owned requests and subscriptions when their input ends,
the caller aborts, or the process receives SIGINT or SIGTERM. Artifact downloads
retain the existing size and digest checks and remove only their private partial
file when canceled or failed. Discovery and other control requests keep their
existing bounded timeouts. This describes the Meshrix connector runtime; it does
not qualify timeout behavior in third-party MCP clients or SDKs.
