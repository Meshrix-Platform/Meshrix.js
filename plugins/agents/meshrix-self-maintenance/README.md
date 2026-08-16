# Agent Self-Maintenance

This package is a separately started Node.js client-peer artifact. It is not
loaded by Meshrix and does not register a route, operation, RPC, MCP server,
Console entry, Host capability, listener, or runtime contribution.

The process reads one fixed configuration snapshot at
`/etc/meshrix-self-maintenance/config.json`. Embedders and tests may supply a
different path to the runtime constructor; the executable accepts no behavior
control through arguments, environment variables, standard input, HTTP, or
RPC. A missing file is inert. An unreadable, in-place-mutated, or schema-invalid
file stops new admission. A replacement inode containing a new valid revision
is the only way to change scheduling or policy. Work already running remains
pinned to its admitted revision and drains normally.

Private state is stored separately under `/var/lib/meshrix-self-maintenance`.
Credential references resolve beneath its `credentials` directory. Each
credential record is a private JSON file containing only a bearer token.
Service endpoints are explicit configuration targets with `model-gateway` and
`meshrix` kinds; changing a credential cannot retarget a request. Neither
secret material nor model prompts and results enter the run journal.

The artifact calls the standalone Model Gateway directly over HTTP. Model
output is treated as an untrusted operation proposal and must match the pinned
runbook, operation allowlist, resource allowlist, workspace selectors, and run
budget before any Meshrix request is made. Accepted proposals call Meshrix only
through `/api/operation-permission/v1/execute` as the artifact's independently
authenticated external service principal. Meshrix retains current grant,
policy, approval, and final-sink authority.

Run focused verification with:

```bash
npm --prefix plugins/agents/meshrix-self-maintenance test
node tools/server-scripts/verify-agent-self-maintenance-runtime.ts
```
