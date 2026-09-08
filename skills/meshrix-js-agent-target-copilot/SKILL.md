---
name: meshrix-js-agent-target-copilot
description: Locate GitHub Copilot CLI configuration facts and the current Meshrix.js MCP integration owner. Use for client setup or compatibility questions about this target.
---

# Agent target: GitHub Copilot CLI

## Vendor facts

- Vendor configuration uses `$COPILOT_HOME/settings.json` (JSONC), with `COPILOT_HOME` defaulting to `$HOME/.copilot`. The vendor directory inventory names `session-store.db` for cross-session data.
- That named database is a vendor fact. It does not establish a Meshrix.js SQLite reader, table mapping, ACP conversation lane, or editor-history integration.

Source: [vendor reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference). Verification date and claim rules live in
the [source index](../meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md).

## Meshrix.js integration

This target has no entry in the current packaged MCP adapter catalog at
`packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts`.
That is an installer inventory fact, not a ban on standard MCP access.

Use `$meshrix-js-downstream-mcp-client-access` for the authorized connection
workflow. `docs/COMPATIBILITY.md` owns the evidence needed for a named client
qualification. A source adapter, vendor feature, or installed binary alone
does not establish that qualification.

For conversation control, history, or database questions, first locate the
current implementation and evidence for the requested capability. If they are
unavailable, state the unverified scope without inventing an absence guarantee
or expanding the task to implement it. Continue independent authorized work.
