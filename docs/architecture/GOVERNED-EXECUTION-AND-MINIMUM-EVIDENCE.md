# Governed Execution And Minimum Evidence

## Status And Scope

This document is the canonical Core maintenance and release-readiness policy
for protected access, side effects, and their evidence. Every maintainer-facing
document, Better Plan node, workflow, protocol projection, runtime path, and
generated documentation projection under `docs/` inherits this policy. A more
specific contract may strengthen it but must not weaken or bypass it.

This is an acceptance invariant, not a blanket statement that every existing
runtime path has completed the migration. A path that does not meet it remains
non-converged and must stay outside a release-readiness claim.

## Existential Invariant

> No governed permit, no protected access, no side effect.

A route name, transport, internal caller, loopback address, generic system
identity, approval record, successful preflight, cached allow decision, or
boolean skip is not execution authority. Only the canonical governance
authority may mint a short-lived, audience-bound, single-use permit for the
exact principal, registered operation, concrete resource, determining policy
and grant revisions, approval, request digest, deadline, and effect class.

The first protected sink validates and consumes that permit before it reads a
secret or private resource, launches a process or plugin Host call, submits a
job, sends the first network byte, resolves a credential, or makes a durable
change. Ingress checks remain defense in depth and cannot replace sink-side
enforcement.

## One Lifecycle Across Every Surface

Buffered, streaming, asynchronous, queue, retry, recovery, maintenance,
plugin, HTTP, RPC, MCP, console, and process paths use one logical lifecycle:

1. **Prepare:** authenticate, resolve the registered operation and concrete
   resource, evaluate current policy, risk and approval, reserve bounded
   capacity, and prepare mandatory minimum evidence.
2. **Permit:** mint the immutable permit only after all required facts and the
   evidence intent are ready.
3. **Enforce:** revalidate after waits, locks, approvals, queues, retries,
   recovery, target materialization, or generation changes; the sink consumes
   the exact permit before the protected action.
4. **Settle:** record one bounded terminal outcome, release reservations in
   `finally`, and expose only stable reason classes, counts, timings, and
   irreversible correlations.

For a remote effect that cannot share a local transaction, use a durable intent
plus idempotency or an outbox-style protocol. A crash between effect and
settlement remains explicitly `in_doubt`; it is never rewritten as confirmed
success and never authorizes a blind retry.

## Minimum-Sufficient Evidence

Evidence is selected by value, not verbosity:

| Class | Retention | Pressure behavior |
| --- | --- | --- |
| Governance lifecycle proof | Keep 100% for the configured objective in one compact logical lifecycle | Failure to prepare denies before the protected action |
| Material security anomaly | Keep one compact event with bounded deduplication | Preserve the anomaly without protected content |
| Operational telemetry | Aggregate by finite operation, outcome, reason, risk, and time bucket | Shed and increment one bounded loss counter |
| Diagnostic logs, traces, and profiles | Sample, byte-bound, time-bound, local, and auto-expire | Shed without blocking the owning transaction |
| Raw protected content | Never retain as evidence or telemetry | Reject before enqueue or serialization |

Routine success, ordinary denial, retry, public-health, and byte-transfer facts
must have zero unbounded per-request durable growth. They belong in bounded
aggregates, not one durable row per request or chunk. A governance proof must
not be shadowed by separate request, decision, start, finish, response, trace,
and audit copies.

## Compact Proof Contract

Use a fixed schema and finite vocabularies. Retain only facts that an
acceptance test, investigation, recovery action, or explicit policy obligation
can name:

- schema and registered operation identifiers;
- permit, decision, request, or idempotency digests;
- irreversible subject and resource correlations only when required;
- effect class, risk class, decision, terminal outcome, and stable reason;
- determining policy, grant, credential, approval, catalog, or plugin
  revisions or digests;
- prepare and terminal time, a duration bucket, and bounded byte or item
  counts;
- cancellation, recovery, or `in_doubt` state when applicable.

Never retain a raw identity, resource value, path, URL, host, header, query,
request, response, prompt, result, model output, exception string, stack,
command, environment, credential, token, ciphertext, plaintext, or backend
runtime row. The permit itself must not be stored as reusable authority.

## Initial Engineering Targets

Until representative measurements justify stricter values, use these as
acceptance targets rather than claims about current implementation or operator
configuration:

- p95 receipt payload at or below 512 bytes;
- p95 on-disk amplification, including indexes, at or below 1 KiB per terminal
  governed lifecycle;
- bounded memory proportional to active concurrency and fixed buffers, never
  payload size or lifetime request count;
- a 100,000-event quick storage gate and a 1,000,000-event release
  characterization for the selected storage engine.

Every retained stream has record-size, byte-size, age, cardinality, queue,
concurrency, and cleanup-work bounds. Redaction, value admission, filtering,
and sampling happen before enqueue and batching.

Mandatory capacity is sized from measured amplification, not JSON length:

```text
required capacity >= peak protected operations per second
                   * retention seconds
                   * measured p99 on-disk amplification
                   * safety factor
```

Optional telemetry is shed at its budget. Unexpired mandatory proof is never
silently evicted: affected protected operations apply backpressure or fail
closed until governed archival, pruning, or repair succeeds. Empty operator
retention configuration remains empty; a hard safety ceiling does not pretend
that a production retention objective was configured.

## Delivery And Verification

Implementation is owned by the Better Plan workspace
[`authorization-enforcement-convergence`](../plan/end-to-end-release/platform-foundation/authorization-enforcement-convergence/Plan.md).
Migrate one independently acceptable surface at a time and update ingress,
dispatcher, sink, cancellation, evidence, tests, registry, and documentation
together. Remove the superseded path in the same closure.

A completed surface proves:

1. direct sink invocation without a valid exact permit fails before access or
   effect;
2. allow, deny, revoke, expiry, replay, stale revision, approval wait,
   cancellation, timeout, retry, recovery, stream, and target substitution
   have stable outcomes and zero unintended effects;
3. crash injection before prepare, before effect, after effect, and during
   settlement yields a recoverable terminal or `in_doubt` state;
4. full, read-only, corrupt, delayed, or unavailable evidence storage fails
   closed only for mandatory proof, while optional telemetry sheds;
5. retention convergence, amplification, aggregate cardinality, queue bounds,
   CPU, latency, and retained memory are measured at representative volume;
6. adversarial protected values are absent from receipts, metrics, reports,
   shared output, and diagnostics.

## Design References

These sources are design references, not runtime dependencies:

- [NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final) and
  [NIST SP 800-162](https://csrc.nist.gov/pubs/sp/800/162/upd2/final) for
  decision/enforcement separation and least-privilege attribute policy;
- [NIST SP 800-92](https://csrc.nist.gov/pubs/sp/800/92/final) for the complete
  log generation, transport, storage, retention, and disposal lifecycle;
- [OPA decision logs](https://www.openpolicyagent.org/docs/management-decision-logs)
  for masking, selective dropping, bounded upload, and rate limiting;
- [Kubernetes auditing](https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/)
  for policy-selected audit depth and omission of low-value stages;
- [OpenTelemetry log data](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
  for separating structured correlation from free-form log bodies;
- [OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
  for excluding credentials, tokens, secrets, and sensitive personal data.
