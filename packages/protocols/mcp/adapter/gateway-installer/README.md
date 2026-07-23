# LicoMesh MCP Connector Runtime

This directory contains the Node.js MCP connector runtime used for protocol
functions such as stdio proxy forwarding, process-identity signing, credential
store checks, and verifier coverage.

It is not the canonical user-device installer. User-device MCP search,
registration, batch install, interactive selection, and uninstall live in:

```text
packages/protocols/mcp/adapter/native-installer/
```

Canonical installer entrypoints:

```bash
packages/protocols/mcp/adapter/native-installer/lico-mcp-install.sh --target openclaw,codex,claude-code,antigravity,opencode,pi --json
packages/protocols/mcp/adapter/native-installer/lico-mcp-uninstall.sh --target openclaw,codex,claude-code,antigravity,opencode,pi
```

Windows uses PowerShell only:

```powershell
powershell -ExecutionPolicy Bypass -File .\packages\protocols\mcp\adapter\native-installer\lico-mcp-install.ps1 -Target openclaw,codex,claude-code,antigravity,opencode,pi -Json
powershell -ExecutionPolicy Bypass -File .\packages\protocols\mcp\adapter\native-installer\lico-mcp-uninstall.ps1 -Target openclaw,codex,claude-code,antigravity,opencode,pi
```

Supported targets are supplied by pinned client-adapter packages published from LicoMesh-Plugins. Core retains only the target catalog, adapter protocol, package integrity/cache policy, authorization, credential, proxy, and lifecycle transaction. Client commands, configuration formats, probes, and mutations are not implemented in Core.

The published target matrix supports these clients through a local connector
process. OrbStack and remote-Linux direct HTTP registration are rejected before
device authorization because those modes cannot send the required process
identity signature.

The runtime CLI remains available for internal verifiers and protocol runtime
commands:

```bash
node packages/protocols/mcp/adapter/gateway-installer/bin/lico-mcp.mjs proxy --target opencode
node packages/protocols/mcp/adapter/gateway-installer/bin/lico-mcp.mjs doctor --json
```

Install/config discovery is not proof that the real stdio proxy transport works;
proxy readiness is covered by the MCP proxy transport verifiers.
