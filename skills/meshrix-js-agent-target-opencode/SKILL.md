---
name: meshrix-js-agent-target-opencode
description: Locate OpenCode configuration facts and the current Meshrix.js MCP integration owner. Use for client setup or compatibility questions about this target.
---

# Agent target: OpenCode

## Vendor facts

- Vendor global configuration uses `$HOME/.config/opencode/opencode.json`; JSONC is supported. Project `opencode.json` has its own scope and precedence.
- The existence of an OpenCode server API does not establish a Meshrix.js conversation or history adapter.

Source: [vendor reference](https://opencode.ai/docs/config). Verification date and claim rules live in
the [source index](../meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md).

## Meshrix.js integration

The current `plugins/agents/opencode/adapter.mjs` defaults to `$HOME/.config/opencode/opencode.jsonc`, accepts `client.configPath`, and maintains the named `mcp` entry. Select the active configuration explicitly when it differs from that adapter default.

Use `$meshrix-js-downstream-mcp-client-access` for the authorized connection
workflow. `docs/COMPATIBILITY.md` owns the evidence needed for a named client
qualification. A source adapter, vendor feature, or installed binary alone
does not establish that qualification.

For conversation control, history, or database questions, first locate the
current implementation and evidence for the requested capability. If they are
unavailable, state the unverified scope without inventing an absence guarantee
or expanding the task to implement it. Continue independent authorized work.
