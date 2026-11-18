# Claude Code Agent Adapter

Bundled private component: `@meshrix/agent-claude-code-adapter` (`agent-claude-code`).

Writes a user-scoped `mcpServers.<name>` HTTP entry to `~/.claude.json` or the
selected `CLAUDE_CONFIG_DIR`/`client.configRoot`; `client.configPath` overrides it.
The entry contains `type: "http"`, `url`, and
`headers: { "X-Meshrix.js-Api-Key": "${SELECTED_ENV}" }`.

A dedicated environment-variable name must refer to the explicitly selected Meshrix
authorization. Claude Code deliberately does not expand some provider credential
names in remote headers; documented reserved examples are rejected. Missing variables
may remain unresolved in Claude Code, so configuration alone is not credential
readiness. No raw key is stored or read by the adapter.

Direct configuration updates preserve unrelated settings and avoid `mcp remove`,
which can delete native OAuth credentials. Removal affects only a matching selected
registration and never native authentication stores.

See the [shared contract](../client-adapter-kit/README.md) and
[official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).
