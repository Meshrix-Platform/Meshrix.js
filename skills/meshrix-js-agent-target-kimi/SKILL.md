---
name: meshrix-js-agent-target-kimi
description: Locate Kimi MCP adapter configuration facts and the current Meshrix.js MCP integration owner. Use for client setup or compatibility questions about this target.
---

# Agent target: Kimi MCP adapter

## Vendor facts

- The Meshrix.js MCP target id `kimi` denotes Kimi Code CLI. It does not denote the Kimi desktop app or establish access to desktop app-state files.
- Use `$meshrix-js-agent-target-kimi-code` for the vendor CLI configuration reference.

Source: [vendor reference](https://moonshotai.github.io/kimi-code/en/configuration/config-files). Verification date and claim rules live in
the [source index](../meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md).

## Meshrix.js integration

The current `plugins/agents/kimi/adapter.mjs` identifies itself as Kimi CLI, invokes `kimi`, and maintains `mcp.json` under `KIMI_CODE_HOME` (default `$HOME/.kimi-code`). An explicit `client.configPath` overrides it. Keep this MCP adapter id when selecting the packaged installer.

Use `$meshrix-js-downstream-mcp-client-access` for the authorized connection
workflow. `docs/COMPATIBILITY.md` owns the evidence needed for a named client
qualification. A source adapter, vendor feature, or installed binary alone
does not establish that qualification.

For conversation control, history, or database questions, first locate the
current implementation and evidence for the requested capability. If they are
unavailable, state the unverified scope without inventing an absence guarantee
or expanding the task to implement it. Continue independent authorized work.
