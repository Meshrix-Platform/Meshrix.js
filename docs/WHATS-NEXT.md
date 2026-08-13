# What's Next: Efficient Agent–Service Collaboration

The only current Meshrix.js outcome is one **enterprise single-node functional
candidate led by Agent-to-MCP Service interaction efficiency**. It is not a
release publication, environment support statement, execution receipt, or
replacement for the machine-readable local Plan in `docs/plans/`.

## Primary objective

Meshrix.js will make Agent interaction with an MCP Service behave more like a
person editing a shared document:

1. open a governed Service Working Set once;
2. keep a private authorization-partitioned local view;
3. read and edit locally without repeating unchanged catalogs, schemas, or
   Resources;
4. submit at most one bounded Change Set per dirty Agent turn;
5. receive a compact acknowledgement and changed Resource identities;
6. subscribe to relevant deltas; and
7. rebase typed changes or resume from a Cursor or authorized Snapshot.

Core-managed state may use atomic Change Sets and deterministic conflict
handling. Arbitrary external or irreversible effects remain explicit governed
Commands. They are never silently retried or treated as mergeable document
edits.

The named future warm-profile targets are zero unchanged schema bytes, zero
remote reads for valid cache hits, zero apply calls for clean turns, at most one
Change Set call for dirty turns, at least 60% fewer model-visible calls, and at
least 70% fewer model-context and wire bytes than the equivalent frozen legacy
scenario. These are acceptance targets, not current measurements or capacity
claims.

## Required closures

| Closure | Required result |
| --- | --- |
| Interaction cost baseline | Equivalent cold, warm, dirty-turn, reconnect, conflict, revocation, and side-effect workloads with privacy-safe counters. |
| Service collaboration contract | Standards-compatible MCP Resources, private cache policy, subscriptions, stable identities, Change Sets, Cursors, Snapshots, conflicts, and current authorization. |
| Connector Working View | Confirmed and optimistic state, bounded cache, Inbox and Outbox, invalidation, acknowledgement, backpressure, and resynchronization. |
| Core state and effects | One Change Set authority for Core-managed state; separate explicit Effect Commands for external side effects. |
| Workspace reference migration | Shared Workspace editing uses the new model and removes per-file model loops and former online writers. |
| Efficiency evidence | The exact named profile either passes every reduction, privacy, safety, and recovery threshold or remains non-certifying with a finite reason. |
| Remaining release work | Plugin Console isolation, governed enterprise operations and recovery, disconnected dual-architecture delivery, and one functional acceptance. |

Implemented capacity and concurrency changes are substrate for this Plan, not a
separate current Plan. Historical Plans and receipts do not promote the current
candidate.

## Deferred until candidate acceptance

- Native Linux host qualification for named amd64 and arm64 systems.
- macOS, Windows, and other client-platform qualification.
- Public-cloud and independent clean-host recovery qualification.
- Multi-node availability, forwarding, federation, hosted operation, and
  concrete third-party provider support.
