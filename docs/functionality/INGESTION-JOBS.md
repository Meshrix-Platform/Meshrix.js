# Ingestion And Jobs

Jobs and the work queue runtime store uploaded objects, structured payloads, execution status, and result records.

## Responsibilities

- Create jobs from direct payloads or completed upload sessions.
- Preserve checkpoint and upload-session receipts.
- Store job status and result records.
- Expose job read and maintenance operations through governed routes.

## Queue Ownership And Lifecycle

Server composition creates one `QueueApplicationPort` and registers the
platform-job and maintenance queue definitions before starting it. The port
owns the selected durable store, definition registry, worker runtime, fallback
coordination, dispatcher capacity, and background scheduling. Capability
providers receive queue-scoped facets; they do not create stores, dispatchers,
or recovery timers and cannot expose broker-native APIs.

Each facet binds its immutable queue-definition identity and structured scope.
Caller input cannot replace either binding. Work-item observation and mutation
revalidate both values inside the store transaction, and a cross-queue or
cross-scope identifier is treated as absent. SQLite and PostgreSQL expose the
same asynchronous application-port rejection semantics. A stable queue ID may
publish monotonic immutable definition versions under the same owner; labels
remain reserved to that queue identity and cannot transfer ownership.
Both durable stores reject a changed replay of an existing version, accept an
identical replay idempotently, and allow the same queue identity to retain its
label across later immutable versions.

Authorization scope and scheduling hierarchy are separate. A queue facet pins
the authorization scope for every operation, while each admitted item may bind
its real tenant, workspace, and project scheduling scope. The durable stores
include the authorization `scope_key` in every claim candidate query, index the
scheduling fields, and rotate deterministically across weighted priority,
tenant, workspace, and project partitions without a global in-memory sort.
Finite aging batches persistently promote work that has remained claimable, and
hierarchical lease reservations prevent a hot child partition from consuming
capacity reserved for an active underserved sibling. Empty priority classes do
not consume the candidate-visit budget, and fairness cursors are removed when
their authorization boundary has no nonterminal work.
The composition-owned application port serializes dispatch cycles across queue
definitions, rotates the first queue for each cycle, and enforces one
process-wide in-flight credit ceiling. Individual queue requests therefore
cannot bypass cross-queue capacity or permanently take the first dispatch slot.

The durable work lifecycle has exactly these states:

```text
queued -> running -> completed
  |         |
  |         +-> retry_wait -> queued
  |         +-> recovered -> running
  |         +-> failed -> recovered
  +------------> cancelled | expired
```

`completed`, `cancelled`, and `expired` are immutable terminal states. `failed`
requires an explicit recovery transition before it can be claimed again.
Admission records an absolute work-expiry
deadline. Claims and lease renewals cannot extend beyond that deadline, and a
late acknowledgement, retry, progress update, cancellation, or recovery cannot
replace `expired`. The default server policy expires work after seven days and
rejects requested lifetimes above thirty days.

Queue startup does not scan job projections or resubmit queued jobs. Durable
claim selects claimable `queued`, `retry_wait`, and `recovered` work directly;
expired leases are recovered transactionally. The SQLite and PostgreSQL
adapters preserve the same state, expiry, lease-fencing, fairness, replay, and
recovery contract. PostgreSQL claim and expiry sweeps use locked, bounded
batches so concurrent workers do not select the same work.

A running worker may persist a bounded checkpoint reference through the current
lease. The checkpoint contains only opaque `kind`, `ref`, `revision`, and digest
fields; paths, URLs, payloads, and arbitrary metadata are rejected. Writes use
both the lease fence and checkpoint sequence, exact replay is idempotent, and a
replacement lease receives the last committed checkpoint after retry or process
restart.

When external import processing is selected, the main server registers a
producer-only job facet. It can admit and inspect work but owns no handler or
dispatcher credit and therefore cannot claim or consume attempts. The external
import worker registers the consumer facet in its own process and is the sole
job handler owner for that deployment mode.

Dispatch checks cancellation before claim and gives every locally leased item
its own abort signal. Local cancellation signals the handler before committing
the durable queue terminal; handler timeout or cooperative interruption returns
the item through the current lease fence instead of waiting for lease expiry.

The governed recovery operation is `jobs.work_queue.recover_failed`. Successful
enqueue and the shared background scheduler request bounded dispatch
internally. Inspection, cancellation,
failed-work recovery, pause, resume, drain, expiry, and projection rebuild are
implemented through the queue-scoped application facet.

## Processing Boundary

Jobs store execution status and result records. External processing may use a published upstream service and submit normalized results through governed operations. An upstream operation becomes a processing target only after the gateway snapshot, Operation Permission catalog, audience projection, and protocol-delivery revisions agree. Jobs do not own service publication, manifest mutation, permission projection, or client adoption.

A job created only from an `uploadSessionId` consumes every staged file through
the canonical storage provider before the worker starts. Persistence streams the
file into `storage_objects` while verifying its SHA-256 digest and byte size,
then records object ownership and issues the versioned upload-consumption
receipt. Staging is removed only after that receipt is durable; a persistence or
receipt failure leaves staging available for retry.

Platform-job queue admission uses a deterministic work-item identity derived
from the durable job identity. Provider startup scans queued job projections in
bounded, cursor-ordered pages and repeats enqueue with the same identity. This
repairs a persistence-before-enqueue crash and a lost enqueue acknowledgement
without creating a second work item; durable queue state remains the execution
authority.

Queue `failed` and `expired` terminals are projected back into the separate
platform-job authority through an idempotent terminal callback. Provider startup
also reconciles retained terminal work so a process interruption between the
queue commit and job projection cannot leave a user-visible job queued or
running indefinitely.

Completed job metadata and results commit in one atomic terminal envelope. The
metadata file is a recoverable projection of that envelope: startup repairs an
interrupted projection write from the terminal envelope and does not resubmit
the completed job.

Job history is indexed by the private `jobs/jobs.sqlite` projection. Active
memory contains only `queued` and `running` jobs; terminal history is read by a
stable `(created_at_ms,id)` keyset cursor and is never loaded into the process
as one collection. Owner, workspace, status, checkpoint, work-item, manifest,
and version-family indexes serve their corresponding lookups. Status and byte
counters are maintained by SQLite triggers, so admission and list summaries do
not rescan job directories or deserialize all historical JSON.

The projection admits at most 100,000 records, 10,000 active records, 64 MiB of
serialized metadata, 256 KiB for one metadata record, 64 MiB for one payload,
256 MiB for one result, and 8 GiB of payload-plus-result artifacts. Terminal
records expire after 30 days. Admission and each maintenance tick remove at
most 64 expired or over-capacity terminal records, journal the exact directory
deletion before removing the projection, and keep pending-deletion bytes
charged until physical cleanup succeeds. Prepared payload/result writes are
also byte-reserved in the same SQLite authority, which prevents concurrent
processes from over-admitting storage during an interrupted replace.

Startup and refresh paths read only the indexed projection and never enumerate
job-history directories. The artifact journal repairs interrupted publishes and
deletes in bounded batches without scanning historical jobs. Artifact hashing
uses 64 KiB chunks and validates the configured byte limit before retaining
content.

`jobs.cancel` is the governed user-visible cancellation operation for queued or
running jobs. It first cancels the deterministic durable work item, waits for an
external worker lease to leave the running projection when required, and only
then commits the job's immutable `cancelled` status. Cancellation retains input,
checkpoint, and result artifacts; deletion remains a separate operation. A
repeated cancellation of a terminal job returns its existing terminal snapshot.

Governed workspace materialization binds the completed upload receipt digest,
authenticated subject, target workspace, operation, expected workspace
revision, and file mutation into one idempotency identity. Authorization and
hard policy run before approval. The worker then submits the governed job,
captures target preimages, applies mutations through the canonical workspace
port as one batch state transaction, records its checkpoint, verifies the
resulting revision, and appends
redacted audit and proof references. The durable job result is committed only
after those stages succeed. Any failure after the first mutation restores all
preimages in reverse order and verifies the original workspace content
revision before the attempt may be retried.

Materialization admission persists its transaction record before queue
admission. Every replay of a non-completed record repeats the canonical queue
enqueue with the same request reference and dedupe key. This closes both queue
backpressure and lost-acknowledgement windows without duplicating workspace
effects; a completed replay returns its result without creating new work.
Admission copies each completed upload file sequentially into private immutable
transaction custody while verifying the receipt byte size and SHA-256 digest.
SQLite stores only the request, digest, byte count, and private custody
reference; it never stores the file as a BLOB. Queue execution and restart
recovery consume opaque read handles over that custody, so upload-session expiry
or staging cleanup cannot change an admitted request. The workspace transaction
reads and validates one bounded file at a time without Base64 conversion or
session-wide file buffers. The request projection, queue payload, audit, proof,
and public result contain only bounded digests and references, never retained
file bytes or custody paths.

Materialization custody admits at most 256 files, 64 MiB per file, and 512 MiB
per request. It retains at most 4,096 requests and 8 GiB of input bytes, limits
active custody for one subject scope to 2 GiB, and rejects admission when active
or protected recovery records occupy the capacity. Four queue workers and
single-file reads bound simultaneously resident custody content to 256 MiB.
Capacity counters are maintained transactionally instead of scanning all
custody rows. One admission removes at most 32 eligible terminal requests,
oldest first; terminal custody expires after seven days, and private custody
directories are removed sequentially. The production adapter does not expose
partial per-file state roots: it commits all target files through the shared
workspace batch transaction, whose content-addressed preimage and state
checkpoint provide compensation and restart evidence.

`jobs.upload_workspace_materialization_cancel` is the authenticated cancellation
surface for an admitted request. It verifies the original subject binding,
signals the canonical queue worker, and lets a running transaction retain its
fence until target preimages have been restored. A queued or compensated request
then enters the immutable `cancelled` transaction state and cannot be resubmitted;
cross-subject requests receive the same unavailable response as missing records.

## Upload Admission And Retention

Upload sessions apply server-owned safety ceilings before creating checkpoint
or staging-file side effects. A declaration is rejected when it exceeds 256
files, 512 MiB for one file, 2 GiB for one session, or 64 KiB of serialized
source metadata for one file. Chunk requests are limited to 8 MiB at the HTTP
boundary before request-body buffering and are checked again by the session
store.

The upload-session directory contains a private SQLite admission index. A
short `BEGIN IMMEDIATE` transaction serializes admission across server
processes, limits one owner-and-tenant scope to eight active sessions, and
limits the deployment to 4,096 retained sessions. These values are server
safety ceilings and do not populate or infer user configuration.

Every admission has a 24-hour absolute expiry. New admission removes at most
32 expired index entries and their staging/checkpoint artifacts per request;
the expiry index avoids directory scans. Reads, chunk writes, receipt
construction, and file resolution reject expired sessions. Completion updates
the durable index so completed sessions no longer consume active-session
capacity, while explicit deletion removes both the index record and staging
artifacts.

Raw downloads, job deletion, and batch deletion resolve the same object and
ownership records. A raw download completes the current owner and job access
decision before opening the object file, then pipes a bounded file stream to
the response with dispatch cancellation propagated to the stream. One server
instance admits at most 32 concurrent raw-object streams and rejects excess
downloads before opening another file. It does not materialize the complete
object as an HTTP-controller buffer. Deletion writes its recovery journal
before removing metadata or object files. Storage doctor, locate, and reconcile
read only the canonical object, ownership, and deletion-journal tables,
including on a fresh database; interrupted deletion resumes from that journal
instead of leaving an untracked object.

Job and batch deletion enter through the job workflow provider. The provider
cancels the deterministic durable work item first. When execution belongs to an
external worker, deletion waits until lease loss has removed the running job
projection; a bounded timeout retains all job and object artifacts for a safe
retry instead of deleting underneath an active worker.

Queue inspection, failed-work recovery, and projection rebuild operations await
both the SQLite and asynchronous PostgreSQL contracts before returning their
receipts. Their verifier reports contain command provenance, source revision,
payload digest, and leak-scan results. These reports prove only their registered
verification coverage; project functional acceptance remains the
responsibility of the Functional Release Gate.

## Verification

```bash
npm test -- --suite domains.manifest
npm test -- --suite foundation.storage-object-lifecycle
npm test -- --suite runtime.job-work-queue-recovery
npx vitest run tests/vitest/server/upload-session-store.test.ts tests/vitest/server/http-request-body-admission.test.ts tests/vitest/server/workflow-event-checkpoint.test.ts tests/vitest/server/job-pipeline-upload-session-persistence.test.ts
node tools/server-scripts/verify-work-queue-conformance.ts
node tools/server-scripts/verify-work-queue-process-restart.ts
node tools/server-scripts/verify-job-work-queue.ts
node tools/server-scripts/verify-upload-workspace-materialization.ts
npm test
```
