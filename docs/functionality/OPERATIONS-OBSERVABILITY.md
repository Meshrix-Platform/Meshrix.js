# Operations And Observability

Operations and observability provide health, diagnostics, storage repair, backup and restore, audit query, alerts, metrics, traces, production health, and release evidence.

## Priority Zero Resource Discipline (天字号第一标准)

This is the repository's highest-priority, non-negotiable runtime standard. A
feature is not complete or release-ready merely because it is functionally
correct. It must also prove that its memory and persistent footprint remain
bounded under repeated real use. Unbounded logging, metrics, events, queues,
caches, or history are release blockers.

The following rules are mandatory:

1. **Value admission before recording.** Persist a record only when it is needed
   for security accountability, correctness diagnosis, recovery, an actionable
   capacity decision, or durable business evidence. Routine success is not
   evidence and MUST NOT be persisted per request. Repeated denials, retries,
   probes, and equivalent failures must be deduplicated, sampled, or aggregated.
2. **Every resource has more than one bound.** Every log, metric, event stream,
   audit history, queue, cache, and in-memory index must define appropriate
   record-size, byte-size, cardinality, and age limits, with automatic eviction
   or compaction. Configuration may lower a default; it must not remove the hard
   ceiling. Append-only storage without automatic retention is forbidden.
3. **Store evidence, not payload copies.** Prefer counters, bounded summaries,
   reason codes, byte lengths, irreversible digests, and the most recent useful
   state. Payloads, request bodies, stack dumps, complete snapshots, and repeated
   equivalent records are not retained unless they are the minimum evidence
   required for a specific failure or recovery contract.
4. **Bound work before allocation.** Runtime code uses bounded queues, bounded
   maps, tail reads, streaming scans, top-K selection, and incremental or atomic
   compaction. A caller-controlled collection must not be cloned, sorted, read,
   or serialized in full when a bounded operation can answer the request.
5. **Memory-leak verification is mandatory.** Changes to long-lived services,
   caches, listeners, queues, logging, persistence, scheduling, or request paths
   must pass the real-service memory gate. The gate warms the complete service,
   applies repeated load, forces garbage collection between rounds, measures a
   robust retained-heap slope, and samples live allocations with
   `@datadog/pprof`. A single RSS reading or a mocked component test is not
   memory-leak evidence.
6. **Diagnostic artifacts are bounded and temporary by default.** Passing runs
   retain only a compact redacted result. Raw heap profiles and load-test data
   stay in a private temporary directory and are deleted after analysis. A raw
   failure profile may be retained only through an explicit diagnostic workflow
   with a byte cap and privacy review.
7. **Reusable tools are cache state, never diagnostic storage.** Pinned profiler
   packages, compiled bindings, and dependency-manager artifacts remain in the
   local tool cache across runs and must not be deleted by the gate. Profiles,
   dumps, service data, readiness state, responses, and captured output must
   never be written into that cache.

No review waiver can permit an unbounded resource path. If the value of a record
cannot be stated, or its retention and capacity bounds cannot be demonstrated,
the record is not admitted.

## Minimum Evidence Policy

This section applies the project-wide [Governed Execution And Minimum
Evidence](../architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md) policy to
operations and observability.

Evidence is admitted by value, not by verbosity:

| Class | Persistence | Failure policy |
| --- | --- | --- |
| Governance lifecycle proof | Keep every protected access or side effect for the configured objective using a fixed, compact schema | Failure to prepare denies before the protected boundary; post-effect settlement failure remains `in_doubt` |
| Material security anomaly | Keep one compact event with bounded deduplication | Preserve the anomaly without payload or identity copies |
| Operational telemetry | Aggregate by finite operation, outcome, reason, risk, and time bucket | Shed under pressure and increment one bounded loss counter |
| Diagnostic logs, traces, and profiles | Sample, byte-bound, time-bound, local, and auto-expiring | Shed without blocking the owning transaction |

A governance lifecycle contains only the operation, effect and risk classes,
decision and terminal reason, determining revision or digest facts, bounded
counts and timing, and irreversible subject, resource, permit, or idempotency
correlations when investigation or recovery needs them. It never contains a
raw request, response, prompt, result, identity, resource value, path, URL,
header, command, exception, credential, ciphertext, plaintext, or backend
runtime row.

An immutable proof ledger may use one bounded Intent and one bounded Outcome;
a mutable store may prepare and settle one row. Both forms represent one
logical lifecycle and must not be shadowed by request, decision, start, finish,
and response log copies. Routine successes and ordinary denials have zero
unbounded per-request durable growth.

Every stream has record, byte, age, cardinality, queue, concurrency, and cleanup
bounds. Optional telemetry is filtered or sampled before batching. Mandatory
unexpired proof is never silently evicted to satisfy a byte limit: the affected
protected operations apply backpressure or fail closed until governed archive,
prune, or capacity repair succeeds. Empty operator retention configuration
remains empty; hard runtime safety ceilings do not pretend that a production
retention objective was configured.

## Responsibilities

- Report runtime health and readiness.
- Diagnose storage, metadata, job, upload, and checkpoint state.
- Provide backup, restore preview, restore execution, and reconcile operations where implemented.
- Query, export, prune, and retain audit records under policy.
- Emit metrics for success, denial, approval, traffic control, latency, and runtime failures.
- Generate bounded executive reports, project production-health state, and run the system-inspection cycle.
- Redact secrets and private runtime data from reports.

## Runtime Contracts

Alert state is owned by the canonical seven-state lifecycle: `rule_loaded`,
`firing`, `acknowledged`, `resolved`, `suppressed`, `notification_failed`, and
`archived`. Monitor cycles and lifecycle mutations serialize on the same state
file. Runtime projections expose immutable snapshots and do not introduce a
second status authority.

Metric families register fixed vocabularies for family, status, reason, and
stage before emission. Registration rejects invalid or oversized vocabularies,
bucket sets, and series limits. Emission rejects unknown dimensions and unsafe
accumulator growth. Monitor-cycle metrics use only fixed lifecycle and outcome
values; runtime identifiers, paths, payloads, and user configuration are not
metric dimensions. Missing observability configuration remains unconfigured and
does not inherit provider or template defaults.

Required observability reports use the shared finalization and publication
pipeline. The pipeline validates schema and verifier ownership, enforces report
and scan budgets, redacts sensitive fields, performs the privacy scan, binds the
producer command and source revision, and publishes through a private temporary
file followed by atomic replacement. Reports also bind the current Plan
contract digest, covered requirement identifiers, privacy outcome, and finite
resource budgets. The required-report validator independently rejects reports
that omit or contradict these fields.

## Operational Evidence

Operational reports are redacted and intended for health checks, audits, and Core release validation. External plugin-product reports are separately owned facts; Core reports and acceptance do not consume them.

The upstream-service-publishing command traverses the production publishing flow and writes a required server report. The platform acceptance reducer recomputes readiness from authenticated mutation, durable publication, runtime snapshot, Operation Permission, scoped audience, and protocol-side delivery facts observed with a neutral peer; it rejects forged summaries, counters, revisions, stale source, unknown fields, privacy violations, and resource-budget breaches. Client implementation or adoption facts are separate compatibility evidence and cannot block or promote that report. A report summary or generic gateway health report alone cannot establish publication readiness.

## Verification

```bash
npm run server:verify:resource-discipline
npm test
npm run verify:enterprise-observability-coverage
npm run verify:enterprise-audit-retention-redaction
node tools/server-scripts/verify-observability-runtime-acceptance.mjs
npm test -- --suite domains.manifest
npm run server:doctor
```
