---
name: meshrix-js-core-platform-operations
description: Maintain Meshrix.js core-owned server, console, platform capability, gateway, runtime, configuration, and acceptance behavior. Use for changes in the core repository that are not optional plugin implementations or client-owned behavior.
---

# Meshrix.js Core Platform Operations

## Keep the boundary

Treat the core repository as owner of the server, console, protocol gateway, platform policies, Operation Permission, authorization, storage contracts, and the canonical acceptance reducer.

Keep optional document parsers, providers, datastores, adapters, desktop or
mobile clients, native bridges, and client configuration outside the default
runtime. Accept them only through explicit versioned contracts.

Protect the Core existential invariant across every owner: only one canonical
authority may mint a governed execution permit, every protected sink must
consume it, and one compact lifecycle receipt must cover the decision and
terminal effect. A protocol, streaming, queue, plugin, maintenance, or internal
service path may specialize data transfer, but it may not specialize policy.

## Work from current facts

Run `git status --short` and inspect the core source that owns the behavior. Avoid copying command maps into documentation or skills; executable commands belong in `workflows/catalog.json`.

Route specialized work to:

- `$meshrix-js-instance-configuration` for local instance startup, runtime configuration, signed plugin enablement, service restart, health diagnosis, or agent connector setup.
- `$meshrix-js-upstream-service-publishing` for developer-to-client upstream service publication.
- `$meshrix-js-downstream-mcp-client-access` for local MCP installer, authorization, proxy access, refresh, or uninstall.
- `$meshrix-js-ingestion-job-processing` for upload, queue, job, result, cancellation, or deletion recovery.
- `$meshrix-js-workspace-governed-sharing` for workspace assets, governed sharing, Shared Space, or checkpoint recovery.
- `$meshrix-js-skill-hub-lifecycle` for skill contribution, review, publication, adoption, or revocation.
- `$meshrix-js-agent-gateway-model-routing` for configured model calls, provider routing, and circuit behavior.
- `$meshrix-js-strategy-management` for deterministic, non-mutating policy preview.
- `$meshrix-js-maintenance-agent-automation` for governed maintenance plans, approval, scheduling, and execution.
- `$meshrix-js-operations-observability` for telemetry, alerts, diagnostics, reports, and readiness evidence.
- `$meshrix-js-performance-load-testing` for bounded load, capacity, latency, saturation, and performance-regression evidence.
- `$meshrix-js-protocol-gateway` for downstream or upstream protocol boundaries.
- `$meshrix-js-operation-permission` for governed operation catalogs, grants, and policy.
- `$meshrix-js-security-authorization` for identity, authorization, secrets, or audit.
- `$meshrix-js-storage-operations` for storage, uploads, checkpoints, or repair.
- `$meshrix-js-platform-acceptance-workflow` for final readiness reduction.

Plan verification with `npm test` or the changed-file profile.
