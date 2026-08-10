# OpenCode Agent Adapter

Plugin ID: `agent-opencode`

Status: `stable`

Package: `@meshrix/agent-opencode-adapter`

Group: `agents`

OpenCode MCP client adapter with JSON-stdio discovery, installation, verification, and removal.

## Boundary

This repository-local optional adapter integrates only through public Meshrix
extension boundaries.

## Meshrix Integration

- target agent peer plugin configuration

## Security

- Use `secretRef` for credentials.
- Do not commit provider runtime data, local operator paths, private endpoints, or token plaintext.
- Agent-facing operations must be exposed through Operation Permission v1 after policy review.
