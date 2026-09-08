---
name: meshrix-js-agent-target-hermes
description: Locate Hermes Agent configuration facts and the current Meshrix.js MCP integration owner. Use for client setup or compatibility questions about this target.
---

# Agent target: Hermes Agent

## Vendor facts

- Use the vendor configuration reference for the selected profile. `HERMES_HOME` identifies Hermes state; it must not be confused with the real OS-user home used by external tools.
- Profile configuration does not establish a Meshrix.js ACP lane, remote VM transport, state.db schema, or conversation-history scanner.

Source: [vendor reference](https://hermes-agent.nousresearch.com/docs/user-guide/configuration). Verification date and claim rules live in
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
