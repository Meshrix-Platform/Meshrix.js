# Real-Service Memory-Leak Gate

## Contents

- Scope and threat model
- Tool ownership and local cache
- Workload and sampling protocol
- Analysis and thresholds
- Evidence and cleanup
- Failure triage
- Meshrix.js reference implementation

## Scope and threat model

Run this gate after changes to long-lived processes, request or stream paths,
listeners, timers, queues, caches, registries, metrics, logs, audit trails,
persistence, schedulers, background workers, native bindings, or dependencies
that allocate memory. Test the production composition with isolated runtime
data. A unit test may prove a local invariant, but it cannot replace the
real-service gate.

Distinguish four failure classes:

1. managed-heap retention after collection;
2. profiler-observed live allocation growth;
3. external, native, array-buffer, or RSS growth;
4. unbounded logging or persistent-storage growth under the same load.

Do not declare a leak from one noisy sample. Do not declare safety from a flat
RSS value when retained heap or live allocations are growing.

## Tool ownership and local cache

Use a maintained profiler supported by the target runtime. Pin it in the
owning repository's manifest and lockfile so CI and local runs use the same
framework version. For the Node.js reference implementation, use
`@datadog/pprof` and the pprof allocation format.

Keep these surfaces separate:

- **Tool cache:** dependency-manager downloads, installed packages, compiled
  profiler bindings, and other reusable executable bits. Preserve them locally
  across runs. Do not run cache cleanup, pruning, verification/garbage-
  collection, or delete commands from the gate.
- **Diagnostic artifacts:** raw profiles, heap dumps, stacks, service data,
  readiness files, responses, and captured output. Never place them in the
  tool cache. Create them under one private per-run temporary root with a hard
  byte limit and remove that exact root after analysis.
- **Durable evidence:** one compact redacted report containing only the bounded
  measurements required to decide the gate. Replace it atomically instead of
  appending a history.

Cleanup code must hold the concrete path returned by the temporary-directory
creator. It must not derive a deletion target from an unresolved environment
variable, glob, workspace root, dependency directory, or user home.

## Workload and sampling protocol

1. Start the complete service as a child process with an isolated data root, an
   ephemeral port, bounded output capture, and a startup deadline.
2. Verify readiness through a private control channel or file. Do not persist
   the host, port, process ID, or readiness payload in the report.
3. Warm the service sufficiently to complete lazy module loading, connection
   setup, JIT compilation, and stable cache initialization.
4. Take a baseline only after warmup. When supported, perform multiple forced
   garbage-collection passes and yield between passes before every sample.
5. Run at least five equal measurement rounds. Keep round count, request count,
   concurrency, timeouts, and response-size handling explicitly bounded.
6. Validate the exact completed-operation count and expected status classes.
   Abort interpretation when the workload is incomplete or failed.
7. After each round, sample managed heap, RSS, external/native memory, array
   buffers, profiler live bytes, profiler live objects, log bytes and records,
   and persistent bytes and files that are meaningful for the service.
8. Stop the service with a bounded graceful deadline and a bounded forced-stop
   fallback. Always execute private-artifact cleanup; never clean the tool
   cache.

Choose representative work that exercises the changed long-lived path. Keep
request bodies synthetic and minimal. Consume response bodies so connection
reuse and allocation behavior match real clients, but do not retain responses.

## Analysis and thresholds

Compute non-negative end-to-end growth and a Theil-Sen slope over every pair of
post-warmup samples. With a small fixed round count, the quadratic pair set is
bounded and gives a median slope that resists one collection or scheduling
outlier better than a two-point comparison.

Gate managed heap and profiler live bytes with both:

- a maximum absolute retained-growth budget; and
- a maximum bytes-per-operation slope budget.

Also cap external/native growth, RSS growth, raw profile size, log byte and
record growth, persistent byte and file growth, startup time, sampling time,
request time, captured child output, and shutdown time. Store thresholds in one
immutable project policy rather than accepting caller-controlled unlimited
values.

Calibrate thresholds from repeatable clean baselines on the supported runtime,
then leave margin for normal allocator and collector noise. Tighten thresholds
when evidence supports it. Do not raise a limit merely to make a regression
pass; first identify the retaining owner and explain the legitimate bounded
state, if any.

## Evidence and cleanup

The durable report may contain:

- schema and verifier identifiers;
- profiler name, pinned version, and profile format;
- workload counts and finite concurrency;
- bounded baseline, final, growth, slope, and maximum measurements;
- stable violation codes and a final pass/fail boolean;
- a digest and byte count for a temporary raw profile;
- an explicit statement that the tool cache was preserved and the raw profile
  was not retained.

Do not record paths, hostnames, ports, process IDs, user names, environment
values, request or response bodies, stack frames, raw stdout or stderr, service
rows, tokens, credentials, or copied runtime payloads. Do not append reports per
run. Atomically replace one bounded report or let the workflow receipt retain
only its digest.

A raw failure profile may be retained only by a separate, explicit diagnostic
workflow with a privacy review, a hard size and age limit, restrictive file
permissions, a named owner, and a defined deletion time. It is never ordinary
test evidence and never belongs in the reusable tool cache.

## Failure triage

1. Fail with a stable reason code when the profiler cannot start, sample,
   encode, or stop. Do not fall back to a weaker claim.
2. Confirm workload integrity before examining growth.
3. Compare managed heap, profiler live allocation, external/native memory, and
   RSS trends to isolate the likely ownership layer.
4. Use a private bounded raw profile only when aggregate measurements cannot
   identify the retaining allocation family.
5. Fix the owner, rerun the targeted gate, and then run the smallest catalog
   regression closure that contains the release claim.

## Meshrix.js reference implementation

The executable reference is owned by Meshrix.js:

- `<meshrix>/tools/server-scripts/verify-runtime-memory-leaks.ts` starts the real service,
  drives repeated health traffic, samples each round, verifies disk and log
  growth, writes one compact report, and cleans the exact private run root.
- `<meshrix>/tools/server-scripts/lib/runtime-memory-profiler-preload.ts` owns forced-GC
  sampling and pprof encoding inside the service process.
- `<meshrix>/tools/server-scripts/lib/resource-discipline-analysis.ts` owns the bounded
  median and Theil-Sen calculations.
- `<meshrix>/tools/server-scripts/lib/resource-discipline-policy.ts` owns immutable
  thresholds and the preserve-local tool-cache policy.

Run it through the repository-local tooling `memory-leaks` workflow so task ownership, timeout,
resource locks, side effects, and report output remain cataloged.
