---
name: meshrix-js-agent-adaptation
description: Route Meshrix.js client configuration and compatibility questions to the matching agent reference and current MCP adapter owner. Distinguish vendor facts, implementation inventory, and verified qualification.
---

# Meshrix.js Agent Adaptation

Use this index for client-specific configuration or compatibility questions.
For a standard MCP connection, start with `$meshrix-js-downstream-mcp-client-access`;
loading unrelated agent histories or every target reference is unnecessary.

## Select the evidence

1. Identify the requested product form and operation. MCP configuration,
   conversation control, and history access are different capabilities.
2. Read only the matching target below and its relevant vendor source.
3. For a packaged adapter, read `plugins/agents/<target>/adapter.mjs` and the
   package README in the selected Meshrix.js repository.
4. Use `packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts`
   for installer coordinates and `docs/COMPATIBILITY.md` for qualification.
   The packaged catalog is not a client-product authorization gate.
5. Preserve existing authorization for the selected instance, client, and
   operation. A vendor document or an installed binary grants no access to
   personal data and does not authorize a client configuration mutation.

## Target references

| Task context | Reference |
| --- | --- |
| Codex configuration or integration | [codex](../meshrix-js-agent-target-codex/SKILL.md) |
| Claude Code configuration or integration | [claude-code](../meshrix-js-agent-target-claude-code/SKILL.md) |
| OpenClaw configuration or integration | [openclaw](../meshrix-js-agent-target-openclaw/SKILL.md) |
| OpenCode configuration or integration | [opencode](../meshrix-js-agent-target-opencode/SKILL.md) |
| Antigravity configuration or integration | [antigravity](../meshrix-js-agent-target-antigravity/SKILL.md) |
| Pi configuration or integration | [pi](../meshrix-js-agent-target-pi/SKILL.md) |
| Kimi MCP adapter configuration or integration | [kimi](../meshrix-js-agent-target-kimi/SKILL.md) |
| Kimi Code CLI configuration or integration | [kimi-code](../meshrix-js-agent-target-kimi-code/SKILL.md) |
| GitHub Copilot CLI configuration or integration | [copilot](../meshrix-js-agent-target-copilot/SKILL.md) |
| Cursor Agent CLI configuration or integration | [cursor](../meshrix-js-agent-target-cursor/SKILL.md) |
| Kilo Code configuration or integration | [kilo-code](../meshrix-js-agent-target-kilo-code/SKILL.md) |
| Hermes Agent configuration or integration | [hermes](../meshrix-js-agent-target-hermes/SKILL.md) |


The MCP target `kimi` is Kimi Code CLI; it must not be presented as a desktop
history adapter. For a client without a packaged adapter, use its standard
MCP support and the authorized connection workflow.

## Keep claims precise

Vendor facts, current implementation behavior, and named-client qualification
must be supported independently. A named path is not a guarantee that a file
exists on the current machine. An accepted file extension is not a database
schema. Missing evidence is not a verified absence. State any unverified scope
precisely and continue work that does not depend on it. Do not claim unsupported
conversation, history, or database behavior to complete an inventory.

The [source index](references/official-sources-and-gap-closure.md) records vendor
sources and verification dates. Update the affected facts and canonical entry
together; generate distribution and installation copies from those sources.
