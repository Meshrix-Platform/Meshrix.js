# Changelog

All notable changes to Meshrix.js are recorded here.

## Unreleased

- Adds encrypted online-only Peer forwarding between paired devices with
  device-local delivery custody. The relay does not persist business
  messages or signed delivery receipts; offline work remains pending on
  the sender until the paired device reconnects.
- Adds recoverable application events and an SQLite-backed Skill Hub
  registry.
- Adds the account lifecycle and security baseline: registration,
  authentication methods, recovery and revocation, OAuth password
  enrollment, and current-session validation before exchange.
- Adds Console operational visibility: built-in traffic views, standard
  metrics export and optional persistence consistent with the current
  Peer semantics.
- Adds self-hosted enterprise recording governance: recording categories,
  organizational custody and consistent failure semantics.
- Adds governed gateway consumption through CLI scenarios and tenant
  routing.
- Adds the installed desktop entry applications (`entry-gui` on Tauri and
  the `entry-native` crates).
- Moves the hosted account, private relay and public gateway deployment
  to a private operations repository. This repository keeps the public
  protocol contracts under `packages/contracts/`.
- Publishes through npm Trusted Publishing instead of a stored token, and
  adds the `@meshrix/mcp-kernel` package scaffold with the portable
  kernel RFC.

## [0.1.0] - 2026-10-04

Initial release of the `meshrix.js` platform and `@meshrix/gateway` library.

- Provides the Node.js Core server, Vue.js Web Console, and an independently embedded HTTP/stdio MCP gateway.
- Aligns modern MCP request metadata and HTTP mirrors with the 2026-07-28 protocol while retaining explicitly selected legacy upstream transports.
- Persists non-read execution intents and dispatch fences, preserves uncertain outcomes after interruption, and prevents automatic replay of a fenced invocation.
- Rechecks authorization at the final upstream send boundary and preserves caller-controlled cancellation and owned-resource cleanup.
- Uses canonical registry dependencies and unchanged package tarballs for consumer installation checks.
- Bundles first-party client-adapter components with `meshrix.js` while keeping each target action explicit. The repository root source declares Apache-2.0; third-party component licenses and notices remain applicable.
- Publishes through one tag-driven npm workflow with standard authentication and retained sanitized diagnostics.
