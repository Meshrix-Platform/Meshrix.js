# Kimi CLI Agent Adapter

Plugin ID: `agent-kimi`

Status: `stable`

Package: `@meshrix/agent-kimi-adapter`

Group: `agents`

Kimi CLI MCP client adapter with JSON-stdio discovery, installation, verification, and removal.
Installs the connector proxy as a stdio entry in the Kimi CLI user-level `mcp.json`
(`$KIMI_CODE_HOME/mcp.json` or `~/.kimi-code/mcp.json`).

## Boundary

This repository-local optional adapter integrates only through public Meshrix
extension boundaries.

## Meshrix Integration

- target agent peer plugin configuration

## Security

- Use `secretRef` for credentials.
- Do not commit provider runtime data, local operator paths, private endpoints, or token plaintext.
- Agent-facing operations must be exposed through Operation Permission v1 after policy review.
