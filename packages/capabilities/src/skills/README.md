# Operation Permission Provider Boundary

`capabilities/skills` hosts the provider used by MCP adapters and console workflows to reach governed capability operations.

The provider exposes catalog discovery, grants, policy, local MCP grant issuance, workspace reference projection, output sanitization, audit, metrics, and operation execution.

`tool-skill-management-provider.mjs` is the Operation Permission provider boundary. MCP adapters and console workflows must use the provider boundary instead of directly touching registry, store, runtime, or router internals.

Execution internals live under `capabilities/operation-permission-core` and are reached only through the provider boundary.
