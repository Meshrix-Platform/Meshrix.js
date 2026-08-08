---
name: meshrix-js-ingestion-job-processing
description: Guide the Meshrix.js upload, ingestion, asynchronous job, queue, result, cancellation, and deletion-recovery capability flow. Use for upload sessions, canonical objects, job admission, worker leases, checkpoints, retries, results, or batch deletion.
---

# Meshrix.js Ingestion Job Processing

Read `docs/functionality/INGESTION-JOBS.md`. Distinguish raw upload completion from governed workspace materialization.

## Canonical transaction

1. Authenticate the owner and authorize upload or direct-payload ingestion with capacity and quota checks.
2. Create an owner-bound upload session. Append only at the current offset while enforcing chunk, object, byte, TTL, and concurrency limits.
3. On completion, stream into the canonical object store, verify size and digest, and persist a versioned consumption receipt before deleting staging data.
4. Create the job from a direct payload or completed receipt with an idempotency key and transactionally admit it to the canonical queue.
5. Lease work with fencing. Checkpoint progress, renew or expire the lease, enter bounded retry wait, and honor cancellation without accepting late completion.
6. Commit terminal state and durable result together. External processors are governed targets; the job domain does not own service publication.
7. Reauthorize every status, result, raw-object, and deletion request against the current owner and Grant.
8. Journal single or batch deletion before mutation, use bounded replay batches, and resume interrupted cleanup after restart.

## State and failure semantics

Keep the three state authorities distinct:

- The platform job owns user-visible admission, processing, cancellation, and terminal result state.
- The durable queue owns `pending`, `leased`, retry/dead-letter, and lease-fencing state.
- The queue monitor owns observation and recovery lifecycle; `recovered` is not a platform-job state.

Do not invent a merged state vocabulary. Any future convergence must migrate producers, consumers, persistence, tests, and documents in one pass rather than preserving parallel authorities, direct writes, random definition identities, or legacy aliases.

- Offset, digest, ownership, capacity, or receipt conflicts fail before job admission.
- A durable receipt makes staging deletion retryable; it does not prove workspace adoption.
- Fenced leases reject stale workers. Cancellation suppresses late success.
- Failed deletion remains journaled and recoverable; it cannot masquerade as deleted.

## Ownership and routing

The ingestion domain owns session and job lifecycle; canonical bytes, receipts, artifacts, and repair belong to `$meshrix-js-storage-operations`. Route authorization to `$meshrix-js-operation-permission`, security boundaries to `$meshrix-js-security-authorization`, and final evidence selection to `$meshrix-js-regression-planner`.

## Verification

Run `npm test` for the current baseline. Resumable offsets, digest mismatch, durable consumption, idempotent admission, lease fencing, retry, cancellation, restart recovery, terminal result atomicity, owner isolation, and bounded deletion replay remain capability-line acceptance requirements. Until a catalog-backed ingestion task proves that closure, report the result as partial evidence rather than capability-line readiness. Sanitize evidence through `$meshrix-js-privacy-evidence`.
