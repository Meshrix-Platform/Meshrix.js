---
name: meshrix-js-agent-target-antigravity
description: Locate Antigravity configuration facts and the current Meshrix.js MCP integration owner. Use for client setup or compatibility questions about this target.
---

# Agent target: Antigravity

## Vendor facts

- Vendor MCP configuration uses `$HOME/.gemini/config/mcp_config.json` globally or `.agents/mcp_config.json` in the selected workspace.
- IDE and CLI MCP configuration are vendor capabilities; they do not establish a Meshrix.js Hook conversation bridge or a history-store schema.

Source: [vendor reference](https://antigravity.google/docs/mcp). Verification date and claim rules live in
the [source index](../meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md).

## Meshrix.js integration

The current `plugins/agents/antigravity/adapter.mjs` accepts `client.configPath` or `client.configRoot`. Its fallback is `$HOME/.gemini/antigravity/mcp_config.json`, which differs from the current vendor global path. Pass the selected active file explicitly when installing into a current client; do not write an alternate configuration merely because a fallback exists.

Use `$meshrix-js-downstream-mcp-client-access` for the authorized connection
workflow. `docs/COMPATIBILITY.md` owns the evidence needed for a named client
qualification. A source adapter, vendor feature, or installed binary alone
does not establish that qualification.

For conversation control, history, or database questions, first locate the
current implementation and evidence for the requested capability. If they are
unavailable, state the unverified scope without inventing an absence guarantee
or expanding the task to implement it. Continue independent authorized work.
