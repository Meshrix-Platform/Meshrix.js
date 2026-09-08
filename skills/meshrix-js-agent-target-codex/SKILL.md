---
name: meshrix-js-agent-target-codex
description: Locate Codex configuration facts and the current Meshrix.js MCP integration owner. Use for client setup or compatibility questions about this target.
---

# Agent target: Codex

## Vendor facts

- Vendor configuration is documented in the official config reference. The CLI command used by this adapter is `codex`; desktop packaging does not establish an MCP installation or a conversation-history reader.
- The official [Linux app documentation](https://learn.chatgpt.com/docs/linux/linux-app) now describes a Linux preview. This vendor availability does not qualify Meshrix.js on that platform.

Source: [vendor reference](https://developers.openai.com/codex/config-basic). Verification date and claim rules live in
the [source index](../meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md).

## Meshrix.js integration

The current `plugins/agents/codex/adapter.mjs` owns marketplace registration and `codex mcp` CLI installation, verification, and removal. It accepts the operator-selected `client.marketplaceRoot`. These operations do not implement App Server conversation control or history discovery.

Use `$meshrix-js-downstream-mcp-client-access` for the authorized connection
workflow. `docs/COMPATIBILITY.md` owns the evidence needed for a named client
qualification. A source adapter, vendor feature, or installed binary alone
does not establish that qualification.

For conversation control, history, or database questions, first locate the
current implementation and evidence for the requested capability. If they are
unavailable, state the unverified scope without inventing an absence guarantee
or expanding the task to implement it. Continue independent authorized work.
