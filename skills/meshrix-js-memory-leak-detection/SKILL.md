---
name: meshrix-js-memory-leak-detection
description: Design, implement, and run bounded real-service memory-leak verification with a maintained allocation profiler, repeated post-warmup load, forced-GC sampling where supported, robust growth analysis, privacy-safe evidence, and strict cache/artifact separation. Use whenever a long-lived service, request path, listener, queue, cache, logger, persistence loop, scheduler, native binding, or dependency may retain memory across repeated work.
---

# Meshrix.js Memory Leak Detection

Treat memory-leak verification as a release gate, not an optional diagnostic.
Read [the real-service gate reference](references/real-service-memory-gate.md)
before designing, changing, or interpreting a gate.

## Required workflow

1. Resolve the owning repository and load its repository skill before editing.
2. Reuse the repository-owned real-service gate when one exists. Do not replace
   it with a mocked component test, one RSS reading, or a hand-written loop.
3. Warm the complete service, apply repeated representative work in bounded
   rounds, force garbage collection between samples when the runtime supports
   it, and measure both runtime memory and profiler-observed live allocations.
4. Reject incomplete or failed load before interpreting memory. Evaluate both
   absolute retained growth and a robust per-operation slope over all rounds.
5. Measure log and persistent-storage growth during the same workload so a
   memory fix cannot move unbounded growth to disk.
6. Retain only a compact redacted report. Use `$meshrix-js-privacy-evidence` before
   sharing any diagnostic evidence and `$meshrix-js-regression-planner` for the final
   claim-specific regression closure.

## Cache and artifact boundary

- Pin the professional profiler in the owning repository's dependency lock.
- Preserve the installed profiler and dependency-manager tool caches locally
  across runs. A leak gate must never delete, prune, or repurpose those caches.
- Keep heap profiles, dumps, stacks, service data, readiness state, responses,
  and captured process output out of the tool cache. They are diagnostic
  artifacts and remain private, size-bounded, and temporary by default.
- Clean only the exact per-run temporary root created by the gate. Never target
  a dependency cache, installation root, workspace root, home directory, or an
  unresolved path.

## Meshrix.js executable example

Plan and run the catalog-backed real-service gate:

```sh
npm run server:verify:memory-leaks
npm run server:verify:memory-leaks
```

The explicit side-effect authorization covers the isolated service and its
private runtime data. It does not authorize deleting the profiler installation
or local package cache. A profiler startup or sampling failure fails closed;
never silently downgrade to RSS-only evidence.
