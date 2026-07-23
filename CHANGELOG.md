# Changelog

This file records user-visible release changes.

## Unreleased

- Replaced the uniform two-event operation-proof policy with explicit `full`,
  `receipt`, `on-change`, and reasoned `excluded` profiles; read-only success
  paths now use one terminal receipt, and stable console-state reads write
  nothing after Pactium atomically confirms an unchanged projection digest.
- Removed LicoMesh proof-entry shadow storage and persisted raw request,
  response, policy, and workspace-effect bodies; ledger facts and critical
  evidence now retain domain-separated commitments and necessary references.
- Upgraded the proof substrate to Pactium 0.5.0 with normalized runtime state,
  compact proof-material tables, compressed SQLite BLOB storage, and
  conservative derived-index garbage collection.
- Replaced unauthenticated loopback MCP grant issuance with an expiring,
  console-approved device-authorization flow bound to targets, permissions, and
  client process keys, with one-time claim consumption and rollback on failure.
- Persisted connector grant credentials in the private process-identity store,
  made interrupted claim consumption replay-safe, isolated per-device grant
  revocation, and made multi-target uninstall notify each credential issuer.
- Bounded HTTP rate-limit state, aggregated saturated high-cardinality traffic,
  and accepted forwarded client IP chains only from explicitly trusted proxies.
- Made standalone persistent Pactium runtimes participate in the shared,
  reference-counted storage lifecycle lease so confirmed restore remains
  offline until the final runtime closes.
- Made backup and full replacement restore fail closed on governed symbolic
  links, FIFOs, sockets, devices, and other non-regular filesystem artifacts.
- Made buffered object persistence use private exclusive staging, durable
  file synchronization, atomic publication, and parent-directory synchronization.
- Made persisted job corruption fail closed or remain visible as a failed job,
  and made failed JobManager close attempts retryable after repair.

## [0.0.1] - 2026-07-11

- Added canonical atomic package-release preparation and tag-state validation across workspace manifests, internal dependencies, package-lock entries, and the changelog.
- Added complete npm package-topology publication with all-package registry preflight, monotonic dist-tags, OIDC provenance, registry-signature verification, and resumable postcondition checks.
- Updated the exact Pactium dependency to `pactium@0.4.1` and delegated an unset storage backend to Pactium's canonical automatic selection policy.
- Added canonical upload-session persistence, storage object ownership, deletion-journal recovery, and atomic backup/restore with SQLite online backup and rollback.
- Added private, crash-safe upload staging with serialized chunk admission and complete zero-byte object handling.
- Added physical object retry verification, stale maintenance-lease recovery, SQLite sidecar-safe restore, and serialized Pactium checkpoint projections.
- Added replacement restore semantics, startup reconciliation of durable restore transactions, power-loss-safe backup publication, and ordered rollback preservation.
- Rejected malformed restore path filters, bound lifecycle leases to process-start identity, and synchronized complete nested restore directory chains.
- Made checkpoint and Merkle state mutations transactional with their Pactium evidence, serialized cross-runtime aggregate updates, and gated durable compound state on SQLite.
- Made JSONL state private and power-loss durable with torn-tail recovery and complete directory-entry synchronization.
- Hardened HTTP admission, request capacity, outbound DNS pinning, local-network boundaries, response projection, runtime logging, console audit projection, and capability-binding recovery.
- Hardened concurrent Console Auth lockout, authenticated and capacity-bounded MCP SSE sessions, sequential upstream notifications, and fail-closed state-mutation timeout fencing.
- Made queued-job startup recovery exhaustive across bounded batches and asynchronous store implementations.
- Made JobManager shutdown idempotent while leaving durable queue state and observation under the queue application port.
- Compiled operation routes through the canonical indexed matcher with strict encoded-path normalization and bounded parameters.
- Made the portable MCP connector package self-contained and limited release artifacts to the verified current-host target.
- Added deterministic release manifests, exact container platform verification, resumable Sigstore asset reuse, and delayed public GitHub Release exposure until npm publication succeeds.
- Documented the open platform boundary for private deployment.
- Documented Operation Permission as the target permission boundary for governed operations.
- Documented verified plugin packages, upstream forwarding, workspace assets, audit, approval, observability, and runtime deployment as open platform capabilities.
- Moved the OpenClaw, Codex, Claude Code, Antigravity, OpenCode, and Pi client-specific adapters and compatibility ownership to independently packaged LicoMesh-Plugins artifacts; Core now retains only the generic adapter protocol, verified cache, authorization, credentials, proxy, and rollback boundary.
