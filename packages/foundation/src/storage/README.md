# Meshrix.js Storage

`packages/foundation/src/storage` owns storage provider contracts, object metadata projections, backup and restore primitives, adapter contracts, and serialized storage state coordination.

The module exposes storage primitives to higher layers without leaking backend-native APIs. Runtime composition selects the concrete storage provider and supplies it through the platform boundary.

File-backed object retries verify the physical regular file with a streaming
SHA-256 and byte count before accepting persisted metadata or an existing
destination. Missing, changed, unsafe, or same-size corrupted files fail
closed instead of being reported as an idempotent success.
Buffered objects use the same private staging boundary: a new `0600` temporary
file is opened exclusively below a verified `0700` directory, synchronized,
atomically renamed, and followed by synchronization of the destination and
staging directories before metadata is recorded. Existing destinations are
opened without following symbolic links and must match the expected bytes.

Core surfaces:

- storage provider and adapter contracts;
- object metadata and normalized storage records;
- backup catalog, listing, creation, explicit retention, restore preview, and restore execution primitives;
- state coordination helpers for serialized writes;
- serialized state coordination for durable store operations;
- report and diagnostics readers for storage-backed runtime checks.

Backup and restore responsibilities are separated by authority. `backup-contract.ts`
owns protocol constants and normalized identifiers, `storage-file-safety.ts` owns
opened-file and filesystem-boundary checks, `backup-manifest.ts` owns manifest
validation and catalog reconstruction, `backup-query.ts` owns indexed listing,
and `backup-snapshot.ts` owns coherent snapshot publication. Restore verification
and deterministic planning are read-only in `restore-plan.ts`;
`restore-report.ts` projects preview and terminal evidence, and
`restore-transaction-records.ts` maps verified actions to durable transaction
records. Offline locking, transaction execution, and receipt publication are
owned by `restore-execution.ts`, with durable journal application and startup
recovery in `restore-transaction.ts`.

Serialized state mutations are admitted through one per-key lane. A mutation
that exceeds its observation deadline aborts its cooperative signal, rejects
queued and newly submitted work with a stable fenced error, and keeps the lane
fail-closed until the original task reaches a terminal state. This prevents a
late writer from overlapping a retry while ensuring callers do not wait
indefinitely behind an indeterminate mutation.

Atomic state-file replacement uses a private `0600` temporary file in a
private `0700` parent directory. The temporary file is synchronized before
rename and the parent directory is synchronized after rename. Only
platform-declared unsupported Windows directory-sync errors are tolerated;
other synchronization failures are surfaced instead of reporting durability.

Checkpoint projection mutations serialize the complete read-modify-write
operation through the shared per-data-directory mutation lane and Pactium core
compound transaction. Tree/index projection and Pactium evidence therefore
commit or roll back together, and concurrent runtime instances cannot lose
sibling nodes or tree ids. Persistent checkpoint and state-commit mutations
require the SQLite backend; the JSON backend remains available for non-atomic
debugging/storage primitives but is rejected for these durable compound
capabilities. In-memory Pactium storage remains a test-only, non-durable path.

Merkle event, state-root, and LSM session aggregates clear persistent caches
before read-modify-write and serialize through the same data-directory lane.
SQLite then provides the cross-process writer transaction, so concurrent event
appends, distinct-key state commits, and session creation retain every accepted
mutation. JSONL state uses `0700` directory ancestry and `0600` regular files,
removes only an unterminated tail before the next append, synchronizes the file,
and synchronizes its parent directory before acknowledging the record.

Meshrix.js Pactium runtimes close storage only when they created it. Closure is
asynchronous and idempotent, drains Pactium core mutations, and releases the
selected persistent SQLite port. Direct checkpoint projection calls create a
scoped runtime and close it in `finally`; injected runtimes remain caller-owned.
Every persistent Meshrix.js Pactium runtime also holds the shared storage-runtime
lease. Runtimes in one process share that lease by reference count, and the
underlying lease remains active until the final runtime closes. A runtime in
another process therefore prevents confirmed restore through the same offline
maintenance boundary as the server storage kernel.

Backup creation builds one unpublished staging tree, identifies SQLite from
the file path independently of its capability category, and snapshots every
`.sqlite`, `.sqlite3`, and `.db` file through the SQLite online backup API.
This includes nested authentication databases and the Pactium database. It copies each regular file once
while checking that the source remains stable for the complete snapshot
interval, and verifies the actual staged destination by size and SHA-256. The
manifest is written only after every staged file passes verification, then the
staged directory tree is synchronized from its leaves to its root and the
complete backup directory is published with one atomic rename followed by a
parent-directory synchronization. SQLite WAL,
shared-memory, and rollback-journal sidecars are never copied as independent
backup files. Governed symbolic links, FIFOs, sockets, devices, and other
non-regular filesystem artifacts are unsupported and fail the backup or full
replacement restore without following or deleting the artifact.

Restore preview verifies the manifest structure and the size and SHA-256 of
every selected backup file before classifying target changes. A restore without
path filters is a replacement of governed mutable storage: files absent from
the selected backup are quarantined in the same rollback transaction and
removed at commit. A path-filtered restore is an explicit overlay and does not
remove files outside or newly added within the selected prefixes. A non-array
path filter is rejected and can never fall back to replacement semantics.
Confirmed restore
is an offline maintenance operation: an active storage runtime is rejected with
`storage_restore_runtime_active`. The apply path copies all selected files into
an isolated staging tree, revalidates targets, moves current files and SQLite
sidecars into rollback storage, atomically installs the staged files, verifies
the installed bytes and SQLite integrity, removes verification sidecars, and
retains rollback state until the restore receipt content and commit phase are
durable. The transaction journal is published before the first target rename.
When a current generation is moved to rollback storage, the rollback name is
synchronized before deletion of the source name is synchronized. Every newly
created ancestor from the storage root through the rollback or install parent
is synchronized before the file rename, so an
interruption can retain both names but cannot durably lose the only prior copy.
Runtime startup reconciles it before creating or opening ordinary storage:
transactions below the commit point roll back to the complete prior generation,
while transactions above the commit point finish publishing the durable receipt.
A byte-identical
SQLite main file is still classified as mutable when a WAL, shared-memory, or
rollback-journal sidecar exists, so post-backup recovery state cannot survive a
confirmed restore. Any failure before finalization restores the full pre-restore
file state.

Usable backup manifests are projected into a rebuildable, digest-revisioned
catalog under the backup root. Backup publication and committed retention
rebuild this index from validated manifests. Runtime startup also reconciles
interrupted retention journals and rebuilds the catalog before opening ordinary
storage, so a crash between authoritative directory publication and index
replacement cannot leave listing state permanently stale. Retention remains
unconfigured when no policy is supplied. A configured policy requires explicit
confirmation at the registered operation boundary, preserves at least one
generation, respects protected backup identities, and records only redacted
counts and digest prefixes.

Backup creation performs a conservative `statfs` capacity preflight before the
first snapshot file is created. The reservation includes the estimated source
bytes and the larger of 64 MiB or ten percent free-space safety margin. Files
are processed with concurrency one. Regular files use filesystem copy-on-write
cloning when supported and retain the verified streaming-copy fallback;
SQLite generations seed the online backup from the latest snapshot through a
reflink so only rewritten pages allocate new blocks on capable filesystems.
Configured retention runs under the same cross-process maintenance lock before
the create lifecycle returns. Abandoned unpublished staging directories are
removed in bounded startup batches and are never catalog-visible.

The storage maintenance coordinator enforces owner-level absolute limits before
constructing a queue or tracker: at most 1,000,000 files or cleanup items,
4 TiB accounted bytes, 1,024 queued mutations, 24 hours, and a 16 MiB working
buffer. Per-root mutation concurrency is exactly one. Queue slot allocation is
limited to 64 KiB, and the queue-depth × buffer product is limited to 1 GiB.
Individual and product overflow is rejected before `FixedRingDeque` allocates
its backing array; caller budgets may be lower but cannot raise these limits.

Durable service manifests use typed references and opaque service identities.
The writer commits row-local service, version, blob, and idempotency changes in
one normalized SQLite transaction, advances the compare-and-swap candidate
pointer, and retains only a bounded unpublished revision interval. Published
snapshot hydration is an explicit indexed read; commits do not clone or sort
the complete service set. Readers receive immutable snapshots and never receive
local storage paths or credential material.

Runtime startup removes a maintenance lease only when its private lock file is
stable, structurally verifiable, and its PID plus hashed process-instance identity
prove that the owning process terminated. Leases record the exact provider used
for Linux proc metadata, POSIX process start time, Windows process creation time,
or the current Node process time origin. Providers are never mixed during
comparison. A
Node time-origin fallback is only compared inside its owning process; another live
process cannot be mistaken for stale ownership when operating-system metadata is
unavailable. PID reuse is treated as stale ownership, while unavailable foreign
metadata fails closed. Active
maintenance remains `storage_maintenance_active`; malformed, changed, or
otherwise unverifiable ownership fails closed with
`storage_maintenance_state_unknown`.

Alternative storage adapters must preserve the public storage primitives instead of exposing backend-native APIs to upper layers.
