# Changelog

All notable changes to Meshrix.js are recorded here.

## Unreleased

No unreleased changes.

## [0.0.1] - 2026-09-28

Prepared release candidate; public tags, artifacts, and deployment remain pending.

- Provides the Node.js Core server, Vue.js Web Console, and an independently embedded HTTP/stdio MCP gateway.
- Aligns modern MCP request metadata and HTTP mirrors with the 2026-07-28 protocol while retaining explicitly selected legacy upstream transports.
- Persists non-read execution intents and dispatch fences, preserves uncertain outcomes after interruption, and prevents automatic replay of a fenced invocation.
- Rechecks authorization at the final upstream send boundary and preserves caller-controlled cancellation and owned-resource cleanup.
- Uses canonical registry dependencies and unchanged package tarballs for consumer installation checks.
- Bundles first-party client-adapter components with `meshrix.js` while keeping each target action explicit. The repository root source declares MIT; third-party component licenses and notices remain applicable.
