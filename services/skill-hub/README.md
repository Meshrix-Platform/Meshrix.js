# Skill Hub Service

Skill Hub is an independently deployable HTTP service. It is the sole owner of
the skill contribution registry, package custody, lifecycle state, adoption,
permission relations, usage statistics, revocation, and rollback evidence.
Meshrix connects to it through the published upstream-service contract and the
default-disabled `skill-hub` adapter plugin.

The service does not import Meshrix runtime code. The adapter obtains a
digest-bound package from the service only for an authorized scan, build, or
execute operation, submits it to Meshrix controlled execution, and commits the
closed terminal outcome back to this service. The service never reports a
sandbox operation as successful without that outcome.

## API

- `GET /healthz` reports process health.
- `GET /readyz` reports service readiness and protocol version.
- `POST /v1/operations/<skill_hub.operation>` executes the versioned Skill Hub
  application contract. Transport success is HTTP 200; the response contains
  the application `statusCode` and bounded `body` so Meshrix can preserve
  domain failures across its governed upstream gateway.
- `GET /v1/events` opens the authenticated Skill Hub change stream. Successful
  lifecycle mutations append a bounded, persistent revision event. Consumers
  resume with `Last-Event-ID` or `?cursor=`. Events contain no request input,
  actor, workspace, package, credential, or command. A journal write failure is
  reported to its publisher; it does not expose an uncommitted event or block
  subsequent publications. A business operation that has already committed keeps
  its successful HTTP result if the catalog hint fails. The service logs only a
  fixed failure category and closes event subscribers. Meshrix invalidates the
  catalog after every successful event connection, including reconnection, so
  consumers recover from missing hints by rereading authoritative state without
  repeating the business operation.

Request bodies are bounded to 2 MiB. Skill packages are strict Base64 with a
decoded limit of 1 MiB. Package bytes and registry state are stored under
`SKILL_HUB_DATA_ROOT` with private modes. Application logs never contain
packages, request bodies, actor identifiers, or storage paths.
Each tenant/catalog partition has one SQLite registry database. The built-in
`node:sqlite` repository imports an existing JSON registry, including its full
audit history, in one transaction and then moves the unchanged JSON bytes to an
inactive `.legacy.json` archive. A restart after the import commit finishes an
interrupted archive move from the SQLite commit marker without rereading JSON.
The archive is never a runtime fallback: if SQLite is missing after archival,
the service fails closed with HTTP 503 and the operator must restore the database
from backup. Because SQLite and the JSON archive are separate files, deleting
SQLite in the narrow interval after import commit but before the archive move
can cause the still-active JSON source to be imported again. The service does
not accept operations for that partition until the move completes; preserve both
files during first startup. Mutations transactionally upsert only the changed
contribution and append its new audit events; read-only calls do not write
registry state, and statistics read event counts without copying audit payloads.
SQLite uses rollback journals with `synchronous=EXTRA`; file replacement syncs
both file bytes and directory entries where the platform supports directory sync.
These durability writes remain required even as redundant registry rewrites are
removed. Native Windows storage behavior and power-loss recovery require separate
environment qualification.
Package and asset files keep their private storage and integrity checks.
Local runs use the repository-supported Node releases (`>=22.19 <23` or
`>=24.3 <25`); the container image pins Node 24.16.
Asset manifests use the owning registry partition and complete contribution
identity. Identical contribution names across tenants and similar path-safe
spellings cannot overwrite each other's manifests. Historical standalone
assets are preserved; future lifecycle updates write within the owning partition.
Each new manifest uses its existing manifest hash as an immutable revision filename;
the registry transaction selects that revision only after the file is persisted.
A failed transaction therefore retains the previously committed manifest. Package
bundles can be shared by multiple contributions or tenants, so failed submissions
never delete their content-addressed bundle. Old manifest revisions and files left
unreferenced by failed mutations are retained, consuming disk space; cleanup must
account for every registry partition before removing any such file.

The authenticated Host sends `x-meshrix-skill-hub-subject` with the opaque
subject reference injected into `meshrixContext.principal.subjectRef`. The
service verifies their equality. Before reading a body, it reserves service
capacity (256 operations / 16 MiB) and subject capacity (32 operations / 8 MiB).
Unknown-length bodies reserve the complete request bound. Exhausted capacity
returns a retryable HTTP 503 and allocates no registry or package. Capacity is
released when the operation completes, including failure or client disconnect.
Subjects sharing a network address have independent budgets. Admitted bodies
and queued operations run to completion and drain before shutdown; they have no
internal execution deadline.

Every operation request requires `Authorization: Bearer <token>`. Configure the
service with `SKILL_HUB_AUTH_TOKEN` (32–512 bytes), store the same value in the
Meshrix secret store, and add the resulting `secretRef` to the operator-owned
service publication. The portable example intentionally contains neither the
token nor a deployment-specific secret reference.
Bearer authentication does not encrypt the service connection. Keep private
Compose HTTP on its trusted internal network; use HTTPS for remote service
publication or terminate TLS at a trusted ingress before forwarding credentials.

Meshrix injects the versioned `meshrixContext` adapter field after plugin
validation. It contains stable service-scoped opaque subject and tenant
references plus, for commit phases only, a minimal sandbox or permission-grant
outcome. The service rejects missing, malformed, or phase-inconsistent
context. Raw identities, authorization booleans, policy
records, and Host receipts remain inside Meshrix.

The service independently revalidates workspace bindings before package
custody, registry mutation, adoption materialization, usage recording, or
permission processing. Submission, sandbox, download, and usage operations
require `workspaceId`; adoption and permission operations require
`targetWorkspaceId`. Global catalog reads may omit a workspace filter and do
not fabricate a `default` workspace in their response.

Meshrix Core owns this credentialed event connection. The Skill Hub plugin
receives only its opaque `serviceRef`; it never receives the service URL or
token.

## Historical registry ownership

Registry files are partitioned by the Host's tenant reference and catalog
workspace. Earlier workspace-only records contain no tenant authority; neither
a request identity nor a contribution's self-reported author can establish
ownership. The service preserves these assets and reports
`skill_hub_registry_ownership_required` (409) when that historical catalog has
no assigned tenant. Existing tenant-owned catalogs and unrelated partitions
remain available.

For a historical catalog whose complete ownership is established by the
operator, set `SKILL_HUB_REGISTRY_OWNERSHIP_FILE` to a private JSON file:

```json
[
  { "workspaceId": "default", "tenantRef": "<trusted-service-scoped-tenant-reference>" }
]
```

Each workspace may be assigned once. Startup relocates the existing JSON file
without rewriting its state or packages; the first registry open imports it
transactionally, then preserves its exact bytes at the inactive `.legacy.json`
archive path.
Repeating the same assignment after restart is harmless. A conflicting target
is never overwritten; both assets remain intact and only that assigned catalog
returns `skill_hub_registry_ownership_conflict` (409) pending reconciliation.
Other tenants and unrelated catalogs continue serving normally. A catalog containing records
from multiple tenants requires a verified record-level ownership decision;
assigning the complete catalog to its first requester would disclose other
tenants' data and is prohibited. Remove the assignment file setting after the
relocation completes.

## Run

```sh
npm test
PORT=8080 SKILL_HUB_DATA_ROOT=./data \
  SKILL_HUB_AUTH_TOKEN='<operator-supplied-token>' npm start
```

The service binds `127.0.0.1` by default (`HOST`); a non-loopback `HOST`
requires `SKILL_HUB_ALLOW_PUBLIC_BIND=1`. The service image sets both for
container networking.

Build and run the container:

```sh
docker build -t meshrix-skill-hub:local .
docker run --rm -p 127.0.0.1:18080:8080 \
  -v meshrix-skill-hub-data:/var/lib/skill-hub \
  meshrix-skill-hub:local
```

When Meshrix and the service share the Compose network, import
`docs/examples/skill-hub.upstream.json`, publish it, and put the returned
server-owned service id in the plugin configuration:

```json
{
  "enabled": true,
  "service": {
    "serviceRef": "svc_..."
  }
}
```
