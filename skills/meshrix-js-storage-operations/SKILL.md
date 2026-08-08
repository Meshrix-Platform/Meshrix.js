---
name: meshrix-js-storage-operations
description: Inspect, repair, or change Meshrix.js core storage, upload sessions, checkpoints, raw objects, metadata, job artifacts, exports, and reconciliation behavior. Use for storage integrity, resume semantics, or controlled repair work.
---

# Meshrix.js Storage Operations

## Diagnose before mutation

Identify the canonical metadata and object ownership first. Compare upload session state, committed offsets, object digests, job identity, and persisted artifacts without dumping raw contents.

Prefer linear indexing by stable IDs, streaming hashes and transfers, bounded concurrency, buffer reuse, explicit timeouts, and exponential backoff with jitter. Avoid repeated scans or per-chunk full-buffer allocation.

## Separate plans from writes

Use read-only inspection and dry-run reconciliation first. Treat repair, rebuild, export, upload, and runtime-data access as side effects.

Run `npm test` before execution. Invoke any runtime-data or destructive task only with `--allow-side-effects` and explicit task scope.

Report counts, stable object or job IDs, digest prefixes, and outcomes. Do not report local paths, filenames containing personal data, raw documents, or database rows.
