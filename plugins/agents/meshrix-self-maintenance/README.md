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
The directory includes `.meshrix-self-maintenance-owner.sqlite` for the live
process lock. Credential references resolve beneath its `credentials` directory. Each
credential record is a private JSON file containing only a bearer token.
One runtime process owns the storage root at a time. Startup acquires a
SQLite-held operating-system lock before configuration, journal, or queue
recovery; a competing process fails startup, and normal shutdown releases the
lock only after active work and persistence settle. Process termination releases
the OS lock for recovery. Keep the root on a filesystem that supports SQLite
locking and do not remove its owner database while the runtime is active.
Outbound requests use an Undici dispatcher with connection, header, and body
inactivity timeouts disabled. The HTTP clients forward any supplied
`AbortSignal`, and runtime shutdown waits for active requests and response bodies
to settle before it closes the dispatcher and releases storage ownership.
Service endpoints are explicit configuration targets with `model-gateway` and
`meshrix` kinds; changing a credential cannot retarget a request. Neither
secret material nor model prompts and results enter the run journal. Remote
targets require HTTPS; HTTP is accepted only for literal IPv4 or IPv6 loopback
development endpoints.

The artifact calls the standalone Model Gateway through its native HTTP API.
Model output is treated as an untrusted operation proposal and must match the pinned
runbook, operation allowlist, resource allowlist, workspace selectors, and run
budget before any Meshrix request is made. Accepted proposals call Meshrix only
through `/api/operation-permission/v1/execute` as the artifact's independently
authenticated external service principal. Meshrix retains current grant,
policy, approval, and final-sink authority.

Daily call and operation budgets are reserved durably in the private run journal
before outbound requests. A reservation is keyed by the scheduled run and
request position, so recovery does not count the same idempotent request twice;
an uncertain request still consumes its reservation. `maxCallsPerDay` counts
Model Gateway and Meshrix requests, while `maxCostUnitsPerDay` counts governed
Meshrix operation requests. UTC-day usage survives process restarts and config
revision replacement.

Run focused verification with:

```bash
npm --prefix plugins/agents/meshrix-self-maintenance test
node tools/server-scripts/verify-agent-self-maintenance-runtime.ts
```
