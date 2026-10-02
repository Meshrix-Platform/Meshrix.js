# Antigravity Agent Adapter

Plugin ID: `agent-antigravity`

Status: `stable`

Internal component: `@meshrix/agent-antigravity-adapter`

Group: `agents`

This private first-party module is bundled with `meshrix.js` and included in
the portable connector runtime. Both consumers use standard Node package
resolution and invoke it only for an explicit target action.

Antigravity MCP client adapter with JSON-stdio discovery, installation, verification, and removal.

## Boundary

This repository-local optional adapter integrates only through public Meshrix
extension boundaries.

## Meshrix Integration

- target agent peer plugin configuration

## Security

- Use `secretRef` for credentials.
- Do not commit provider runtime data, local operator paths, private endpoints, or token plaintext.
- Agent-facing operations must be exposed through Operation Permission v1 after policy review.
