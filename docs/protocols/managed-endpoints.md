# Managed Endpoint Protocol

> Contract source: `packages/contracts/src/managed-endpoints.ts`
> (`@meshrix/contracts/managed-endpoints`) and
> `packages/contracts/src/operations/managed-endpoint-operation-definitions.ts`.

This document describes `meshrix.managed-endpoint/1`, the wire contract
between an organization's Meshrix server and its managed endpoints — devices
the organization owns and governs collectively, such as member workstations
and shared test machines.

Meshrix is one protocol with two implementations. The JavaScript
implementation in this repository is the open-source upstream authority for
the wire contract; the Go implementation is a fully independent private
downstream that adopts the same protocol revision. Neither implementation
may drift the contract; a semantic change lands here first, under a new
protocol revision, before either implementation ships it.

## Roles and credential classes

- **Member**: an authenticated organization actor (console session or scoped
  API key). Member operations run through ordinary Operation Permission with
  `endpoints:read` / `endpoints:execute` / `endpoints:approve` /
  `endpoints:manage` scopes.
- **Worker**: a managed endpoint's device runtime. Worker operations
  authenticate exclusively through the device credential; a member session
  is never accepted on the worker surface, and a device credential is never
  accepted on the member surface.
- **Enrollment token** (`met_…`): one-time, time-bounded (24h) bootstrap
  secret issued by a member with `endpoints:manage`. It authorizes exactly
  one enrollment exchange and is never persisted by the device after use.
- **Device credential** (`mdc_…`): long-lived per-device identity minted
  locally by the device runtime before enrollment. The server stores only
  its hash. Revocation replaces the credential's generation, not the
  endpoint record.

Credential classes are disjoint by construction: different prefixes,
different verifiers, different audiences. No operation accepts one where
another is expected.

## Endpoint lifecycle

An endpoint record is `{ endpointId, tenantId, organizationId, label, kind,
state, generation, allowedCapabilityIds, publishedCapabilities,
publishedWorkspaces }`.

- `kind`: `workstation` (a member's own machine that joins collective
  governance) or `shared` (organization-owned capacity such as a test
  machine). The kind is descriptive metadata for routing and policy; it is
  not an authorization class.
- `state`: `pending` (created, enrollment token outstanding) → `active`
  (enrolled) → `revoked` (terminal). Transitions are one-directional.
- `generation` increments on every capability-list or credential-affecting
  mutation. Worker operations validate the exact generation they enrolled
  under; a stale generation fails closed, which makes revocation effective
  on the next worker call without requiring a push channel.
- `allowedCapabilityIds` scopes which published capabilities members may
  dispatch to this endpoint. Publishing a capability makes it visible;
  allowing it makes it dispatchable. The two lists are separate on purpose.

## Capability declaration standard

Endpoints declare what they can execute; the contract owns the declaration
shape so declarations stay uniform, extensible and maintainable across both
implementations and across device runtimes.

```
ManagedCapability = {
  capabilityId: string   // pattern ^[a-z0-9][a-z0-9._:-]{0,127}$
  label: string          // ≤160 chars, human-facing
  kind: "command" | "agent"
  inputSchema: object    // closed JSON Schema, ≤16KiB
  revision: integer ≥1
}
```

Rules for the schema standard:

- `inputSchema` is a **closed** JSON Schema (`additionalProperties: false`
  at every object level). The server compiles it once per published
  revision and validates every task input against it before admission.
- `revision` is the compatibility gate. An assignment pins
  `capabilityRevision`; a worker executing under an older revision must
  refuse or upgrade — silent shape drift is a contract violation.
- `kind` selects the execution class, not the payload. `command` runs a
  configured local command template; `agent` drives a device-side agent
  adapter (A4AA profile) whose input schema is the standard agent-task
  shape published by the device.
- Extension fields (e.g. `outputSchema`, `streamHints`, `riskClass`,
  `executorHints`) may be added in later protocol revisions following the
  same closed-schema rule: unknown fields are rejected, never ignored.
- Capability ids are namespaced by convention (`<domain>.<verb>…`); the
  contract does not allocate namespaces, but device runtimes must not
  squat on the `meshrix.*` prefix reserved for platform operations.

## Workspace declarations

Workspaces are declarative: the device declares them public, the server
broadcasts them, callers reference them by logical name.

```
ManagedWorkspace = {
  workspaceId: string    // pattern ^[a-z0-9][a-z0-9._:-]{0,127}$
  label: string          // ≤160 chars, human-facing
  hint?: object          // closed JSON, ≤4KiB, optional metadata
}
```

- The worker catalog carries `workspaces` alongside `capabilities`;
  publishing is one atomic call. The server stores declarations on the
  endpoint record and exposes them to members as `publishedWorkspaces`,
  alongside `publishedCapabilities`.
- A declaration is a name, not a path. Physical resolution happens
  on the device only — paths, mounts and layout never leave the device.
- Task inputs reference `workspaceId` logically; routing treats an
  unavailable workspace as ineligible, same as an undeclared capability.

## Task lifecycle

All mutations are replay-safe. `requestId` idempotently identifies a
submission; `leaseId`+`leaseSeq` fence every worker mutation.

```
member:  endpoints.tasks.submit ──► queued (per-endpoint queue)
worker:  endpoints.worker.poll ──► assignment{taskId, leaseId, leaseSeq,
                                             capabilityId, capabilityRevision, input}
worker:  endpoints.worker.start ──► {authorized, cancelRequested}
worker:  endpoints.worker.event ──► structured timeline events (see Events)
worker:  endpoints.worker.permission ──► member approval (endpoints:approve)
worker:  endpoints.worker.complete ──► {state, result, errorCode?}
member:  endpoints.tasks.get / .events / .cancel / .permission
```

- **Queue authority**: the server-side work queue is the sole task
  lifecycle authority. One queue definition per endpoint; `batchSize ≤8`,
  `waitMs ≤60s`, `leaseTimeoutMs` 5s–300s. A worker polls only for itself.
- **Lease fencing**: start/event/permission/complete all carry the
  assignment's `leaseId` and monotonically increasing `leaseSeq`. A
  mutation under a stale lease is rejected; outcome states
  `succeeded|failed|cancelled|unknown` are terminal and the first settled
  outcome wins.
- **Unknown outcome**: a worker that cannot determine whether a task
  settled reports `unknown` — the server never replays a task's side
  effects on the worker's behalf and never applies an arbitrary execution
  deadline.
- **Cancellation**: `tasks.cancel` is observed by the worker at poll and
  start; a worker that already terminated reports the observed terminal
  state rather than merely acknowledging the cancel request.
- **Permission prompts**: worker-raised prompts create member-visible
  approval records (`endpoints.tasks.permission`,
  `endpoints:approve` scope). Poll responses acknowledge processed
  permission ids so devices never see a stale prompt twice.

## Endpoint routing

`endpoints.tasks.submit` accepts an optional `endpointId`:

- Present: the task is pinned to that endpoint; the server still verifies
  the endpoint is `active`, same-organization, and allows the capability.
- Absent: the server matches `capabilityId` across active endpoints whose
  `allowedCapabilityIds` and published catalog cover the request, then
  selects one. Selection order is an implementation detail; the contract
  requires only that a dispatchable endpoint is chosen or the submission
  fails with `managed_no_eligible_endpoint`.

Routing expresses *eligibility*, not placement optimization. Hard
constraints beyond the capability match (e.g. `kind: shared`) belong to
the requesting member's endpointId choice or to later protocol revisions.

## Events

Every task owns one structured timeline, separate from the byte log.
`worker.event` is the single worker entry point:

```jsonc
{ "taskId": "...", "leaseId": "...", "leaseSeq": 7,
  "events": [
    { "seq": 41, "kind": "agent.runtime", "at": "...", "payload": { ... } }
  ] }
```

Normative properties:

- **Server-owned envelope, capability-owned vocabulary.** `seq`, `kind`,
  `at`, `payload` are the protocol envelope; `payload` is a closed JSON
  value bounded per event (16 KiB). `kind` is a namespaced string —
  `task.*` is reserved for protocol lifecycle, `agent.*`/`command.*` and
  further namespaces are declared by the capability's schema. New event
  kinds evolve through the capability schema, not the protocol.
- **Worker-owned sequence.** `seq` is assigned by the device, ≥1, strictly
  increasing within a batch and above the stored tail. There is exactly
  one sequence authority per task — the server never injects into it.
- **Durable and bounded.** Accepted events append to the task's event
  timeline (≤256 entries per task). They persist server-side and are
  replayable at any time — online or not. This is the deliberate
  asymmetry against the log stream: events are the small durable truth;
  the byte log is the bulk volatile one.
- **Member reads.** `endpoints.tasks.events` accepts `after=<seq>` and
  returns the stored tail, then optionally long-polls (`wait` seconds)
  for live continuation. Replay plus live follow is one read path.
- **Batched and lease-fenced.** Up to 64 events per call under the
  assignment's lease tuple. An empty batch is the keepalive form: the
  call still validates the lease tuple and renews the lease without
  touching the bounded timeline — silence must not spend timeline
  entries on liveness.
- **Permissions stay separate.** A permission request is a stateful
  resolution object, not a timeline event — `worker.permission` and
  `endpoints.tasks.permission` remain the channel; the permission record
  itself is the audit.

## Log streaming

Log custody lives at the device. The endpoint's durable journal is the
sole persistent authority for execution output; the server is a control
console that forwards links and orchestrates control — it does not retain
bulk log storage or backups.

Consequences, all normative:

1. **Device-required reads.** Reading task output — live or historical —
  requires the device online. A log request against an offline device
  fails with `device_offline`; the server never serves a cached or
  synthesized transcript.
2. **Zero-copy relay.** During execution the worker pushes opaque
  byte frames (sequence number + byte chunk) to the server; the server
  forwards them to attached members without parsing, re-encoding or
  durably persisting them. Server-side buffering is a bounded flow-control
  window only — a relay artifact, not a copy.
3. **Events are not output.** `worker.event` carries the structured
  lifecycle timeline. Full-fidelity output is always the stream —
  never event payloads.
4. **On-demand replay.** A member requesting log ranges outside the live
  window triggers a `worker.log.fetch` through the worker channel; the
  device replays the requested segment from its journal over the same
  relay path. There is no server-side transcript to fall back to.

Wire primitives: `worker.log.append` (device→server→member during
execution), `endpoints.tasks.stream` (member pull with offset resume),
`worker.log.fetch` (server→device replay request). Frame contents are
byte-opaque; the contract bounds frame size and journal retention but
never interprets bytes.

## Agent dispatch payloads

Agent-kind capabilities execute against device-resolved configuration.
Task inputs carry **logical references only**: profile/binding names,
declared workspace ids, repository references, model selectors. The
device resolves credentials, provider settings, workspace paths and
environment locally through its own custody and adapter registry.

Literal secrets never cross the boundary in either direction. A task that
cannot run without a credential the device does not hold is rejected at
admission — it must not be "fixed" by shipping the secret.

## Server persistence boundary

The server persists lifecycle facts only: endpoint and device records,
credential hashes, capability catalogs, task assignments, leases,
permission records, key events, final results (≤256KiB) and receipts.
Execution output, intermediate transcripts and device-local state are not
server data. Organization isolation applies to every persisted fact:
tenant and organization identity derive from authenticated authority,
never from request fields.

## Versioning

`MANAGED_ENDPOINT_PROTOCOL = "meshrix.managed-endpoint/1"`. Assignments
carry the protocol tag; a worker receiving another revision refuses the
assignment. Additive changes within a revision follow the closed-object
rule; semantic changes require a new revision adopted by both
implementations.
