# Skill Hub Adapter

Skill Hub is a default-disabled Meshrix adapter for the independently deployed
Skill Hub HTTP service. The plugin owns no registry, package, lifecycle, usage,
or permission state. Activation requires one operator-published `serviceRef`:

```json
{
  "enabled": true,
  "service": {
    "serviceRef": "svc_...",
    "timeoutMs": 30000
  }
}
```

The adapter preserves the stable `skill_hub.*` HTTP, RPC, and MCP operation
surface while all application calls cross the governed external-service Host
port. Meshrix binds the fixed service and operation, rechecks current Operation
Permission authority, applies egress policy, binds a stable service-scoped
opaque subject and tenant reference, and performs one HTTP request. Raw actor
identity, authorization state, policy decisions, and Host receipts never cross
the service boundary.

Workspace-affecting calls use explicit resource bindings. Submission, sandbox,
download, and usage calls require `workspaceId`; adoption and permission calls
require `targetWorkspaceId`. Missing, empty, malformed, or legacy fallback
fields are rejected before the adapter invokes the external-service Host port.
Global search, list, detail, statistics, and leaderboard reads remain available
without a workspace filter.

For scan, build, and execute, the service first returns the current package
with its digest and a closed sandbox request. The adapter verifies the digest,
provides the package to Core controlled execution without a host-process
fallback, and commits only a closed terminal outcome projection to the service.
Permission grants similarly use a prepare/commit exchange around the narrow
`operationPermissionGrant.recordPluginGrant` Host port; the service receives
only an opaque recorded-outcome reference.

The service package, deployment image, API documentation, and focused tests
live under `services/skill-hub`. Import
`docs/examples/skill-hub.upstream.json` to publish a running instance.
