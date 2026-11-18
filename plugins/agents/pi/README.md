# Pi Agent Adapter

Bundled private component: `@meshrix/agent-pi-adapter` (`agent-pi`).

Writes `mcpServers.<name>` in Pi's native `mcp.json`, containing `url` and
`headers: { "X-Meshrix.js-Api-Key": "${SELECTED_ENV}" }`. It honors
`client.configPath`, `client.configRoot` and `PI_CODING_AGENT_DIR`; the default is
`~/.pi/agent/mcp.json`. It does not install an extension or launch a local proxy.

Pi owns native MCP discovery, invocation, cancellation and tool exposure. The
adapter requires a Pi version with native `pi mcp add` support for detection. The
qualified reference format is Pi 1.3.0's environment-template header resolution and
Streamable HTTP transport, not legacy SSE. Names differing only in hyphens versus
underscores share a Pi tool namespace and cannot be installed together.

Only a matching registration is removed. Existing authentication stores, independent
assets, unrelated servers and policy fields are retained. Environment provisioning
and native connectivity remain separate from configuration success.

See the [shared contract](../client-adapter-kit/README.md) and the installed Pi
`docs/mcp.md` for native configuration semantics.
