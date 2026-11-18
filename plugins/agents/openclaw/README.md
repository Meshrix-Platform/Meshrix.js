# OpenClaw Agent Adapter

Bundled private component: `@meshrix/agent-openclaw-adapter` (`agent-openclaw`).

Configures `mcp.servers.<name>` with `url`, `transport: "streamable-http"`, and
`headers: { "X-Meshrix.js-Api-Key": "${SELECTED_ENV}" }`. Omitting the transport
would select SSE. The qualified OpenClaw 2026.9.4 header schema accepts scalar
values, not generic SecretRef objects. `ironclaw` and `zeroclaw` are not qualified
aliases and are not selected by this adapter.

The adapter reads authored definitions with `mcp show --json`, and writes one merged
entry using `config set --batch-file` with a private temporary file removed in
`finally`. Existing unrelated settings are not passed on the command line. Explicit
`client.configPath`/`client.configRoot` map to OpenClaw's configuration/state overrides.

Uninstall first verifies the binding and rejects OAuth/conflicting entries before
`mcp unset`; it does not remove independent native credentials. No Agent, connection
probe, local proxy or persistent environment provisioner is launched.

See the [shared contract](../client-adapter-kit/README.md),
[registry documentation](https://docs.openclaw.ai/cli/mcp/registry) and
[transport documentation](https://docs.openclaw.ai/cli/mcp/transports).
