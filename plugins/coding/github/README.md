# GitHub Connector

Plugin ID: `coding-github`

Version: `0.0.1`

Status: `stable`

The GitHub Connector is a default-disabled runtime plugin. It contributes eight
GitHub REST operations, two read-only GitHub MCP forwarding operations, eleven
Codespace provider operations, and three GitHub-hosted skill installer
operations.

## Boundary

The plugin has no network client and does not read environment credentials. A
governed operation can reach GitHub only through the operation-scoped
`externalService` Host port. The Host resolves the selected service, endpoint,
request mapping, headers, and `secretRef` after checking the current Operation
Permission decision. The plugin supplies only its own operation ID and a
schema-checked input object.

The GitHub Release plugin-package acquisition source remains a Core facility.
This plugin does not download, install, or update Meshrix plugin packages.

## Configuration

Empty configuration and `{ "enabled": false }` publish no contributions. Full
activation is explicit and closed:

```json
{
  "enabled": true,
  "modules": {
    "rest": true,
    "mcp": true,
    "codespaces": true,
    "skillInstaller": true
  },
  "services": {
    "rest": {
      "serviceRef": "operator-rest-binding",
      "timeoutMs": 30000
    },
    "mcp": {
      "serviceRef": "operator-mcp-binding",
      "timeoutMs": 60000
    }
  }
}
```

The service references must name operator-published services governed by the
current grant. There is no configurable token, organization, repository,
endpoint, or fallback binding. Credential material remains in the
operator-published Host service behind a `secretRef` and never enters the
plugin package or configuration snapshot. The bundled descriptors define only
the closed endpoint, service-binding, and credential requirements; they contain
no endpoint, service reference, or credential reference value.

## Operations

- REST covers repository metadata and contents, ref comparison, pull requests,
  reviews, issue comments, and Actions workflow runs.
- MCP exposes `github.mcp.tools.list` and `github.mcp.tools.call`. The bundled
  MCP descriptor enforces read-only mode.
- Codespace covers provider discovery, repository status, trees, files, diffs,
  change preparation and upload, review actions, and review-status sync.
- The skill installer plans, applies, and rolls back a GitHub-hosted source.
  Only digest-bound lifecycle records are written through `pluginData`.

Every non-read operation requires an idempotency key. Duplicate in-flight
requests share one Host call, and the runtime keeps a bounded result cache.
Pagination and rate-limit metadata use bounded public projections.

## Security and lifecycle

- Import and validation do not open sockets or resolve credentials.
- Missing, stale, or denied Operation Permission governance fails before the
  Host port is called.
- Request fields are allowlisted, payloads are bounded, and credential-like
  input is rejected.
- Host failures are reduced to stable error codes; raw errors, headers, service
  configuration, and credentials are never returned.
- Cancellation uses the operation signal. Timeout enforcement belongs to the
  trusted Host request boundary.
- Closing stops new work, waits for every Host request to settle, flushes the
  plugin-local mutation queue, and releases the bounded idempotency state.
