# Capabilities Package

The capabilities package owns platform capabilities that expose governed operations to agents, operators, and protocol adapters.

## Responsibilities

- Operation Permission catalog, grants, policy, execution, audit, and metrics.
- Generic capability providers and governed plugin Host surfaces.
- Capability providers used by MCP, HTTP, RPC, and console workflows.

## Boundaries

- The permission primitive is an operation.
- MCP tools are protocol projections and do not define a separate permission model.
- `operation-permission-core` is the current Operation Permission execution core behind the provider boundary.

## Verification

```bash
npm test -- --suite domains.manifest
npm test
```
