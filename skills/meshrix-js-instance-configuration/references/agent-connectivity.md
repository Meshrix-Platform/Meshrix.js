# Agent and Gateway Configuration

## Select the direction

| Data flow | Canonical owner |
| --- | --- |
| Host command or stdio service into Meshrix.js | `$meshrix-js-upstream-service-publishing` |
| Meshrix.js MCP catalog into a local agent | `$meshrix-js-downstream-mcp-client-access` |
| Shared workspace assets or skills between agents | `$meshrix-js-workspace-governed-sharing` and `$meshrix-js-skill-hub-lifecycle` |

Do not copy a host credential into a container merely to make a host-owned
command reachable. Keep the command and its credential custody on the host and
publish only the governed stdio service through Meshrix.js. External agents
and clients connect to `<server-url>`, not to a second backend port. See
`$meshrix-js-instance-usage`.

## Publish a host stdio service

1. Confirm the exact executable, fixed arguments, working boundary, operation
   catalog, and intended audience. Treat user input as data, never as command,
   path, template, or environment syntax.
2. Register the service through the authenticated upstream publication path.
   Keep publication, Operation Permission grants, and downstream connector
   installation as separate transactions.
3. For a host `gh` bridge, let the host `gh` process keep its existing CLI
   authentication. Never export its token, auth store, process environment, or
   response payload into Meshrix.js configuration or the consumer container.
4. Grant only the explicitly requested operations and audience. A prior broad
   authorization is not a default for a future deployment.
5. Verify publication health, projected operations, protected invocation, and
   final effect with bounded receipts. Do not expose command output as health
   evidence.

## Install downstream MCP access

1. Use the signed Meshrix MCP connector and its supported target catalog.
2. Supply the strict Console-issued `mxak1` API Key through the documented
   environment variable or protected standard input, never through arguments.
3. After the target configuration passes, persist the key only in the Core
   connector's private, target-and-server-scoped credential store. Client
   configuration contains connector metadata, not the key.
4. Let the proxy resolve that credential at runtime unless the operator
   supplies an explicit temporary override. Send it only as
   `X-Meshrix.js-Api-Key` to the bound server.
5. Verify target installation, connector metadata, protected `tools/list`, one
   authorized call, refresh behavior, and uninstall cleanup without printing
   the key or a fingerprint.
6. Remove the matching stored credential during successful uninstall. If
   adapter cleanup fails, surface the failure and retain the credential for a
   controlled repair instead of claiming cleanup.

Use `docs/architecture/MCP-NATIVE-INSTALLER.md` and
`packages/protocols/mcp/adapter/gateway-installer/lib/cli/credential-store.ts`
as the current persistence contract.

## Supported Agent MCP targets

1. Resolve the target only from
   `packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts`.
   Treat that catalog as the release allowlist; do not embed a second fixed
   target list in this skill.
2. Load the matching `meshrix-js-agent-target-<target>` skill when one exists
   and use it only for target-specific discovery, configuration layout, and
   lifecycle behavior. Keep the connector protocol, credential custody, and
   cache contract target-neutral.
3. Keep provider API Keys and native session data in the Agent's own custody.
   Meshrix.js receives only connector metadata and its scoped MCP credential.
4. Seed an isolated adapter cache through `seedClientAdapterCache` or
   `seedClientAdapterCaches` in
   `tools/server-scripts/lib/release-journey-adapter.ts`. Require the exact
   trusted package coordinate, shared adapter kit, adapter package, complete
   recursive runtime dependency closure, deterministic tree digest, and a
   successful canonical descriptor probe before installation.
5. Fail a missing dependency, coordinate mismatch, unsupported target, invalid
   descriptor, or incomplete cache. Do not fall back to a host package tree or
   treat detection of the native Agent binary as adapter readiness.

For Agent MCP credential changes, run the focused API-Key-only installer and
credential tests selected by `npm test` or the test registry. For cache changes,
cover the supported target catalog or the changed adapter coordinate; a
single-Agent cache fixture is only a target regression, not proof of the
generic cache contract. Never use a real provider key or live Agent history as
test evidence.
