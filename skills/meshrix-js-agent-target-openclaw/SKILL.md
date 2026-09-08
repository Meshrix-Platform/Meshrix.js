---
name: meshrix-js-agent-target-openclaw
description: Locate OpenClaw configuration facts and the current Meshrix.js MCP integration owner. Use for client setup or compatibility questions about this target.
---

# Agent target: OpenClaw

## Vendor facts

- Vendor configuration uses the optional JSON5 file `$HOME/.openclaw/openclaw.json`; `OPENCLAW_CONFIG_PATH` selects a different active file.
- An OpenClaw config path is not evidence of Meshrix.js history scanning, ACP attachment, or database-schema support.

Source: [vendor reference](https://docs.openclaw.ai/gateway/configuration). Verification date and claim rules live in
the [source index](../meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md).

## Meshrix.js integration

The current `plugins/agents/openclaw/adapter.mjs` uses the selected client CLI to inspect, set, and unset the named MCP entry. Follow its actual `mcp` command contract instead of editing guessed state files.

Use `$meshrix-js-downstream-mcp-client-access` for the authorized connection
workflow. `docs/COMPATIBILITY.md` owns the evidence needed for a named client
qualification. A source adapter, vendor feature, or installed binary alone
does not establish that qualification.

For conversation control, history, or database questions, first locate the
current implementation and evidence for the requested capability. If they are
unavailable, state the unverified scope without inventing an absence guarantee
or expanding the task to implement it. Continue independent authorized work.
