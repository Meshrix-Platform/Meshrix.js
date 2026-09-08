---
name: meshrix-js-agent-target-cursor
description: Locate Cursor Agent CLI configuration facts and the current Meshrix.js MCP integration owner. Use for client setup or compatibility questions about this target.
---

# Agent target: Cursor Agent CLI

## Vendor facts

- Vendor CLI configuration uses `$HOME/.cursor/cli-config.json` on macOS/Linux and `%USERPROFILE%/.cursor/cli-config.json` on Windows; project configuration is `.cursor/cli.json`. `CURSOR_CONFIG_DIR` and the documented XDG location can override the global location.
- IDE chat, in-app Agent UI, and Agent CLI are distinct task contexts. These configuration facts do not establish database tables, history merging, or cross-form resume compatibility. Verify the specific form and client version before making such a claim.

Source: [vendor reference](https://cursor.com/docs/cli/reference/configuration). Verification date and claim rules live in
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
