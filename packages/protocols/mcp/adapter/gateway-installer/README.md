# Meshrix.js MCP Connector Runtime

This directory contains the Node.js MCP connector runtime used for protocol
functions such as API-Key-authenticated stdio proxy forwarding and verifier
coverage.

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

Supported targets are supplied by pinned operator-provided client-adapter packages. Core retains only the target catalog, adapter protocol, package integrity/cache policy, API Key input, proxy, and local lifecycle transaction. Client commands, configuration formats, probes, and mutations remain remaining work in the operator-supplied adapter packages.

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
