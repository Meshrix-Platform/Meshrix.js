# Agent Collaboration

Core collaboration covers governed downstream MCP access, agent workspaces, session history, and generic delegated child-operation bindings. Product-specific collaboration transports are external plugin responsibilities.

## Responsibilities

- Expose registered MCP operations only to authorized agents.
- Keep workspace access inside the authenticated subject, tenant, and workspace boundary.
- Bind delegated child calls to a current parent grant and exact session, turn, subject, target, workspace, operation, and trace context.
- Record redacted operation history, audit, and metrics without persisting bearer credentials.
- Keep external client implementations and optional plugin runtimes outside Core build and startup. First-party client-adapter components ship with `meshrix.js` and act only through the declared client protocol after explicit selection.

## Adapter Target Scope

The downstream MCP target catalog is OpenClaw, Codex, Claude Code, Antigravity,
OpenCode, Pi, and Kimi CLI. Their optional first-party adapter components ship
inside `meshrix.js`, while the client applications remain independent external
products. The connector invokes a selected component only for an explicit
install, verify, or uninstall action.

## Verification

```bash
npm run server:verify:protocol-boundary
npm test -- --suite domains.manifest
npm test
```
