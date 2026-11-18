# Codex Agent Adapter

Bundled private component: `@meshrix/agent-codex-adapter` (`agent-codex`).

Configures `[mcp_servers.<name>]` in `$CODEX_HOME/config.toml` (default
`~/.codex/config.toml`), with `url` and
`env_http_headers = { "X-Meshrix.js-Api-Key" = "SELECTED_ENV" }`.
`client.configPath` and `client.configRoot` explicitly override the destination.
TOML is parsed structurally; unrelated settings and matching server policies remain.

Normal registration does not create a marketplace plugin. A positively identified
former generated `lico@meshrix-local` duplicate for the same binding is disabled,
without deleting plugin assets or unrelated marketplace state.

No raw key, Bearer credential, proxy process or credential store is installed.
Uninstall removes only a matching registration. Configuration, external credential
readiness and client connectivity are separate outcomes; see the
[shared contract](../client-adapter-kit/README.md).

Native format: [official Codex MCP documentation](https://developers.openai.com/codex/mcp/).
