# Changelog

All notable changes to Meshrix.js are recorded here.

## Unreleased

No unreleased changes.

## [0.1.0] - 2026-10-04

Initial release of the `meshrix.js` platform and `@meshrix/gateway` library.

- Provides the Node.js Core server, Vue.js Web Console, and an independently embedded HTTP/stdio MCP gateway.
- Aligns modern MCP request metadata and HTTP mirrors with the 2026-07-28 protocol while retaining explicitly selected legacy upstream transports.
- Persists non-read execution intents and dispatch fences, preserves uncertain outcomes after interruption, and prevents automatic replay of a fenced invocation.
- Rechecks authorization at the final upstream send boundary and preserves caller-controlled cancellation and owned-resource cleanup.
- Uses canonical registry dependencies and unchanged package tarballs for consumer installation checks.
- Bundles first-party client-adapter components with `meshrix.js` while keeping each target action explicit. The repository root source declares Apache-2.0; third-party component licenses and notices remain applicable.
- Publishes through one tag-driven npm workflow with standard authentication and retained sanitized diagnostics.
