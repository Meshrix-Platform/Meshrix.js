---
name: meshrix-js-operations-observability
description: Guide Meshrix.js health, diagnostics, metrics, traces, alerts, audit, repair evidence, and readiness-report production. Use for operational observability, alert lifecycle, bounded telemetry, report finalization, or production diagnosis.
---

# Meshrix.js Operations Observability

Read `docs/functionality/OPERATIONS-OBSERVABILITY.md`. Treat production health, a capability report, and platform release readiness as different claims.

## Canonical transaction

1. Classify incoming facts as mandatory governance receipts, material security
   anomalies, operational aggregates, or optional diagnostic telemetry.
2. Apply bounded queue, history, cache, label-cardinality, report-size, concurrency, CPU, memory, and duration budgets.
3. Keep one fixed-schema lifecycle receipt for every protected access or side
   effect. Aggregate routine success and denial by finite time buckets; sample,
   auto-expire, or shed diagnostic logs and traces.
4. Evaluate rules through one alert state machine covering firing, acknowledgement, suppression, notification failure, resolution, and archive.
5. Produce health, diagnostic, audit, execution-summary, and executive reports only from immutable snapshots.
6. Run every report through the shared finalizer for redaction, budget checks, provenance, and sensitive-information scanning.
7. Publish atomically and enforce deterministic retention through a bounded index.
8. Validate required reports independently for schema, producer, command run, source revision, digest consistency, and freshness.
9. Delegate the final release-readiness claim to the platform acceptance reducer.

For any change that can retain memory across repeated work, apply
`$meshrix-js-memory-leak-detection`; a bounded telemetry unit test is not a substitute
for its real-service gate.
Use `$meshrix-js-performance-load-testing` for load generation, runtime pressure
observation, latency percentiles, capacity profiles, and performance-regression
reduction; observability remains the owner of bounded telemetry facts.

## Boundaries and failure semantics

- Observability consumes domain facts; it does not reimplement authorization, storage, approval, or queue policy.
- Callers cannot choose high-cardinality labels. User, Grant, correlation, path, host, URL, payload, and raw runtime data stay out of metrics and public reports.
- Empty user alert, channel, and retention configuration remains empty.
- Over-budget optional telemetry is rejected, aggregated, or shed by documented
  policy without blocking the owning transaction. A protected operation whose
  mandatory governance receipt cannot be durably prepared fails closed before
  access or side effect.
- A child verifier cannot self-assert a leak scan or platform readiness.

## Ownership and routing

Observability owns bounded telemetry and report production. Route memory
retention verification to `$meshrix-js-memory-leak-detection`, repair execution to
`$meshrix-js-operation-permission`, storage repair to `$meshrix-js-storage-operations`,
evidence sanitation to `$meshrix-js-privacy-evidence`, and final readiness to
`$meshrix-js-platform-acceptance-workflow`.

## Verification

Run `npm test` for the current baseline. Every legal and illegal alert transition, label rejection, port-specific overload policy, cancellation, deterministic retention, atomic report publication, adversarial privacy samples, empty configuration, stale or forged reports, and child-report readiness overreach remain acceptance requirements. Until a catalog-backed observability task proves them together, capability-line readiness remains remaining required work. Use `$meshrix-js-regression-planner` for available evidence.
