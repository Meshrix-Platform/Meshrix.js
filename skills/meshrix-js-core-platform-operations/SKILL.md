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

- `$meshrix-js-developer-handbook` for product, packaging, and published address-contract work.
- `$meshrix-js-user-handbook` for operating a published instance and connecting external services or agents.
- `$meshrix-js-release-artifact-contract` for the `runtime-ui` one-origin `/` plus `/api` address chapter.
- `$meshrix-js-instance-usage` for the operator connection chapter.
- `$meshrix-js-instance-configuration` for local instance configuration, signed plugin enablement, service restart, or health diagnosis.
- `$meshrix-js-upstream-service-publishing` for developer-to-client upstream service publication.
- `$meshrix-js-downstream-mcp-client-access` for local MCP installer, authorization, proxy access, refresh, or uninstall.
- `$meshrix-js-ingestion-job-processing` for upload, queue, job, result, cancellation, or deletion recovery.
- `$meshrix-js-workspace-governed-sharing` for workspace assets, governed sharing, Shared Space, or checkpoint recovery.
- `$meshrix-js-skill-hub-lifecycle` for skill contribution, review, publication, adoption, or revocation.
- The standalone Model Gateway Service documentation for configured model calls, provider routing, and circuit behavior.
- `$meshrix-js-strategy-management` for deterministic, non-mutating policy preview.
- The independently started Agent self-maintenance plugin for local maintenance scheduling and execution.
- `$meshrix-js-operations-observability` for telemetry, alerts, diagnostics, reports, and readiness evidence.
- `$meshrix-js-performance-load-testing` for bounded load, capacity, latency, saturation, and performance-regression evidence.
- `$meshrix-js-protocol-gateway` for downstream or upstream protocol boundaries.
- `$meshrix-js-operation-permission` for governed operation catalogs, grants, and policy.
- `$meshrix-js-security-authorization` for identity, authorization, secrets, or audit.
- `$meshrix-js-storage-operations` for storage, uploads, checkpoints, or repair.
- `$meshrix-js-platform-acceptance-workflow` for final readiness reduction.

Offline delivery and the current plan receipt may close on Linux inside a
virtual machine. Prefer Ubuntu; accept Debian. Native Linux and distribution
qualification remain remaining required work after the named Real-Machine
Verification Workflow. Project-level functional acceptance remains
`npm run verify:acceptance`.

Plan verification with `npm test` or the changed-file profile.
