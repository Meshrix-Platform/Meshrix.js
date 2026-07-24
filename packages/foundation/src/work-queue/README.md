# Meshrix Work Queue

`packages/foundation/src/work-queue` owns the platform infrastructure queue primitive.

The module provides:

- finite queue state machine;
- full state x event matrix proof;
- unified queue time source;
- queue-owned UUIDv7 identity generation;
- queue definition normalization helpers;
- in-memory Queue Definition Registry for trusted ids and versions;
- SQLite WAL store adapter with transition journal plus projection;
- the canonical `queued`, `running`, `retry_wait`, `completed`, `failed`,
  `cancelled`, `expired`, and `recovered` durable lifecycle;
- lease-fenced claim, completion, retry, progress, cancellation, expiry, and
  failed-work recovery primitives;
- absolute work-expiry deadlines that bound claim and lease renewal;
- automatic lease renewal, lease-loss cancellation, and a finite server-owned
  handler duration ceiling before any terminal transition;
- automatic delayed retry and transactional expired-lease recovery;
- fallback coordination that resolves into the canonical lifecycle;
- Queue Worker Runtime for upper-layer handlers;
- push dispatcher that performs durable claim before handler dispatch;
- queue control for pause, resume, and drain;
- unified background write aspect;
- conformance and deterministic randomized smoke tests.

The module must not depend on application capabilities. Server composition owns
one `QueueApplicationPort` for the durable store, registry, worker runtime,
dispatcher, and background lifecycle. Platform job and maintenance providers
register queue definitions and handlers through queue-scoped facets instead of
creating infrastructure instances or scanning job projections at startup.

The default local deployment uses `better-sqlite3` with WAL under
`<userDataPath>/work-queue/work-queue.sqlite`. The PostgreSQL adapter preserves
the same application contract and uses transactional locked batches for claims
and expiry sweeps. Neither adapter exposes broker-native APIs to capability
providers.
