---
name: meshrix-js-agent-target-kimi-code
description: Locate Kimi Code CLI configuration facts and the current Meshrix.js MCP integration owner. Use for client setup or compatibility questions about this target.
---

# Agent target: Kimi Code CLI

## Vendor facts

- Vendor configuration uses `$KIMI_CODE_HOME/config.toml`, with the data directory defaulting to `$HOME/.kimi-code`. The CLI is distinct from Kimi desktop.
- For the packaged Meshrix.js MCP installer, use target id `kimi` and `$meshrix-js-agent-target-kimi`. The skill name `kimi-code` does not introduce another installer id or an ACP conversation implementation.

Source: [vendor reference](https://moonshotai.github.io/kimi-code/en/configuration/config-files). Verification date and claim rules live in
the [source index](../meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md).

## Meshrix.js integration

The packaged CLI adapter is owned by `plugins/agents/kimi/adapter.mjs`.

Use `$meshrix-js-downstream-mcp-client-access` for the authorized connection
workflow. `docs/COMPATIBILITY.md` owns the evidence needed for a named client
qualification. A source adapter, vendor feature, or installed binary alone
does not establish that qualification.

For conversation control, history, or database questions, first locate the
current implementation and evidence for the requested capability. If they are
unavailable, state the unverified scope without inventing an absence guarantee
or expanding the task to implement it. Continue independent authorized work.
