# Meshrix.js MCP Connector Runtime

This directory contains the Node.js MCP connector runtime used for protocol
functions such as API-Key-authenticated stdio proxy forwarding and verifier
coverage.

The runtime is part of the `meshrix.js` npm package. Its public command is the
root package's `meshrix-mcp` bin; generated client configuration selects that
bin explicitly with `npx --yes --package meshrix.js@<VERSION> meshrix-mcp`.
There is no separately installable connector npm package.

It is not the canonical user-device installer. User-device MCP search,
registration, batch install, interactive selection, and uninstall live in:

```text
packages/protocols/mcp/adapter/native-installer/
```

Canonical installer entrypoints:

```bash
packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.sh --target openclaw,codex,claude-code,antigravity,opencode,pi,kimi --json
packages/protocols/mcp/adapter/native-installer/meshrix-mcp-uninstall.sh --target openclaw,codex,claude-code,antigravity,opencode,pi,kimi
```

Windows uses PowerShell only:

```powershell
powershell -ExecutionPolicy Bypass -File .\packages\protocols\mcp\adapter\native-installer\meshrix-mcp-install.ps1 -Target openclaw,codex,claude-code,antigravity,opencode,pi,kimi -Json
powershell -ExecutionPolicy Bypass -File .\packages\protocols\mcp\adapter\native-installer\meshrix-mcp-uninstall.ps1 -Target openclaw,codex,claude-code,antigravity,opencode,pi,kimi
```

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

The runtime CLI remains available for internal verifiers and protocol runtime
commands:

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
