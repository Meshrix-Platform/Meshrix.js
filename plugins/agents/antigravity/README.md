# Antigravity Agent Adapter

Bundled private component: `@meshrix/agent-antigravity-adapter` (`agent-antigravity`).

Antigravity documents remote `mcpServers.<name>` entries with `serverUrl` and
headers, not `url` or `httpUrl`. Its current documented configuration location is
`~/.gemini/config/mcp_config.json`; `client.configPath`/`client.configRoot` may select
another location explicitly.

A protected reference for the selected static key in `X-Meshrix.js-Api-Key` has not
been qualified. Native install therefore returns
`unsupported_protected_header_reference` before configuration access. It does not
guess interpolation syntax or substitute plaintext, Google ADC, OAuth, another
identity, or a local proxy. Scan/verify cannot claim supported native configuration.

Removal only affects an exactly identified former generated proxy for the same
binding in the explicitly selected file; credentials and unrelated entries remain.
The former configuration location is not scanned or migrated implicitly.

See the [shared contract](../client-adapter-kit/README.md) and
[official MCP documentation](https://antigravity.google/docs/mcp).
