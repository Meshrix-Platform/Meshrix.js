# Agent Collaboration

Core collaboration covers governed downstream MCP access, agent workspaces, session history, and generic delegated child-operation bindings. Product-specific collaboration transports are external plugin responsibilities.

## Responsibilities

- Expose registered MCP operations only to authorized agents.
- Keep workspace access inside the authenticated subject, tenant, and workspace boundary.
- Bind delegated child calls to a current parent grant and exact session, turn, subject, target, workspace, operation, and trace context.
- Record redacted operation history, audit, and metrics without persisting bearer credentials.
- Keep client implementations and external plugin runtimes outside Core build, startup, and release evidence.

## Adapter Target Scope

The documented downstream MCP adapter target scope is OpenClaw, Codex, Claude Code, Antigravity, OpenCode, Pi, and Kimi CLI. Client-specific adapters are loaded from pinned Meshrix-Plugins packages and are not Core modules.

## Verification

```bash
npm run server:verify:protocol-boundary
npm test -- --suite domains.manifest
npm test
```
