---
name: meshrix-js-agent-target-pi
description: Locate Pi configuration facts and the current Meshrix.js MCP integration owner. Use for client setup or compatibility questions about this target.
---

# Agent target: Pi

## Vendor facts

- Vendor settings use `$HOME/.pi/agent/settings.json` globally and `.pi/settings.json` for a project. Session directory selection has separate CLI, environment, and settings precedence.
- RPC and session-file behavior need their own vendor or implementation evidence; installing the MCP extension does not qualify them.

Source: [vendor reference](https://pi.dev/docs/latest/settings). Verification date and claim rules live in
the [source index](../meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md).

## Meshrix.js integration

The current `plugins/agents/pi/adapter.mjs` installs a Pi extension and writes the selected connector configuration. `plugins/agents/pi/extension.mjs` owns that extension; this is a different boundary from the vendor settings file. Use the adapter's `client.configPath` when selecting connector storage.

Use `$meshrix-js-downstream-mcp-client-access` for the authorized connection
workflow. `docs/COMPATIBILITY.md` owns the evidence needed for a named client
qualification. A source adapter, vendor feature, or installed binary alone
does not establish that qualification.

For conversation control, history, or database questions, first locate the
current implementation and evidence for the requested capability. If they are
unavailable, state the unverified scope without inventing an absence guarantee
or expanding the task to implement it. Continue independent authorized work.
