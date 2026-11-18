# OpenCode Agent Adapter

Bundled private component: `@meshrix/agent-opencode-adapter` (`agent-opencode`).

Configures `mcp.<name>` with `type: "remote"`, `url`, `oauth: false`, and
`headers: { "X-Meshrix.js-Api-Key": "{env:SELECTED_ENV}" }`. Explicit static-key
authentication must not silently initiate an OAuth flow.

The adapter honors `client.configPath`, `OPENCODE_CONFIG`, `client.configRoot` and
`XDG_CONFIG_HOME`; otherwise it uses the OpenCode configuration directory. Existing
`opencode.json` or `opencode.jsonc` is used. If both exist, select an explicit path
rather than relying on ambiguous precedence. JSONC is parsed without changing string
contents; a changed file is serialized as JSON, retaining settings but not comments.

Missing environment variables resolve to empty strings in OpenCode. The adapter does
not provision variables or establish connectivity. It preserves unrelated servers,
policies and native credentials; conflicting bindings fail. See the
[shared contract](../client-adapter-kit/README.md),
[remote MCP documentation](https://opencode.ai/docs/mcp-servers/) and
[configuration references](https://opencode.ai/docs/config/#variables).
