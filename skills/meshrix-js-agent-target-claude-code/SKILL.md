---
name: meshrix-js-agent-target-claude-code
description: Locate Claude Code configuration facts and the current Meshrix.js MCP integration owner. Use for client setup or compatibility questions about this target.
---

# Agent target: Claude Code

## Vendor facts

- Vendor settings use `$HOME/.claude/settings.json`, project `.claude/settings.json`, and project-local `.claude/settings.local.json`; managed settings have their own precedence.
- Settings-file documentation does not establish a transcript database, resume-picker behavior, or a Meshrix.js streaming-conversation implementation.

Source: [vendor reference](https://code.claude.com/docs/en/settings). Verification date and claim rules live in
the [source index](../meshrix-js-agent-adaptation/references/official-sources-and-gap-closure.md).

## Meshrix.js integration

The current `plugins/agents/claude-code/adapter.mjs` owns `claude mcp` installation, verification, and removal. Read the exact adapter before changing its command arguments; native conversation steering and transcript merging are separate capabilities requiring their own implementation evidence.

Use `$meshrix-js-downstream-mcp-client-access` for the authorized connection
workflow. `docs/COMPATIBILITY.md` owns the evidence needed for a named client
qualification. A source adapter, vendor feature, or installed binary alone
does not establish that qualification.

For conversation control, history, or database questions, first locate the
current implementation and evidence for the requested capability. If they are
unavailable, state the unverified scope without inventing an absence guarantee
or expanding the task to implement it. Continue independent authorized work.
