# Meshrix.js MCP Connector Runtime

This directory owns the Node.js MCP installer and connector runtime: local
discovery, registration, target selection, explicit client configuration,
uninstall, diagnostics, and API-Key-authenticated stdio proxy forwarding.

The runtime is part of the `meshrix.js` npm package. Its public command is the
root package's `meshrix-mcp` bin; generated client configuration selects that
bin explicitly with `npx --yes --package meshrix.js@<VERSION> meshrix-mcp`.
There is no separately installable connector npm package.

Install the published package's Node command:

```bash
npx --yes --package meshrix.js@<VERSION> meshrix-mcp register
npx --yes --package meshrix.js@<VERSION> meshrix-mcp install --target auto --json
npx --yes --package meshrix.js@<VERSION> meshrix-mcp doctor --json
npx --yes --package meshrix.js@<VERSION> meshrix-mcp uninstall --target codex --json
```

The root package also exposes `meshrix-mcp` as its npm bin. In a portable
release archive, the `meshrix-mcp` launcher (or `meshrix-mcp.ps1` on Windows)
starts the sibling verified Node runtime and forwards the same subcommands.
There is no standalone shell or PowerShell installer implementation.

The seven supported targets use optional first-party client-adapter components bundled
with `meshrix.js` and included in the portable connector's declared runtime
closure. The connector resolves the selected component through standard Node
package resolution and invokes it only for an explicit target action. No adapter
is fetched from npm or installed into a separate cache, and scanning a host does
not change client configuration. Each component owns its target's command
discovery, configuration format, probes, and mutation behavior behind the bounded
JSON-stdio protocol.

The published target matrix currently covers local connector-managed clients
through a stdio proxy. The connector uses process-identity signing for local
integrity. OrbStack and remote-Linux direct HTTP registration remain remaining
qualification work; they currently fail before installation because those
locations are outside the published target matrix.

The source entry remains useful for development and focused verification:

```bash
node packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts proxy --target opencode
node packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts doctor --json
```

Install/config discovery is not proof that the real stdio proxy transport works;
proxy readiness is covered by the MCP proxy transport verifiers.

After a proxy request or artifact download is admitted, the connector applies
no implicit elapsed-time cutoff to its response headers or body; an explicit
caller-selected helper budget remains active. The `proxy` and
`fetch` commands cancel owned requests and subscriptions when their input ends,
the caller aborts, or the process receives SIGINT or SIGTERM. Artifact downloads
retain the existing size and digest checks and remove only their private partial
file when canceled or failed. Discovery and other control requests keep their
existing bounded timeouts. This describes the Meshrix connector runtime; it does
not qualify timeout behavior in third-party MCP clients or SDKs.
