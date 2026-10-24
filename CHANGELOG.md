# Changelog

All notable changes to Meshrix.js are recorded here.

## Unreleased

No unreleased changes.

## [0.3.0] - 2026-10-24

- Moves the state-commit event log to Pactium 0.8.4's digest-shaped event
  records. Events persist `payloadHash` inside the hashed record while the
  caller-authorized plaintext payload lives in a Meshrix-owned sidecar keyed
  by `eventHash`; `getEvent`/`listEvents` re-attach it and verify the digest
  before use, and `verifyCommit` binds commit payloads through the
  chain-anchored digest. Pre-digest event records keep their inline payload.
- Pins `pactium` to `0.8.4`, inheriting its phantom-record write-order fix,
  stricter canonical value handling, signed-head hardening, and
  partition-read segment caching.

## [0.2.0] - 2026-10-15

Prepared source candidate; not yet published. The npm products remain
`meshrix.js` and `@meshrix/gateway`. Native client qualification is separate
from npm qualification. Public native source builds require matching
distributable A4AA and AwP dependencies.

- Adds encrypted Peer communication, device-local delivery custody,
  recoverable application events and an SQLite-backed Skill Hub registry.
  Offline work stays on the sending device; receipt processing and execution
  reservations prevent automatic replay of completed operations.
- Consolidates the installed client on Rust with egui and ratatui. Removes
  the Tauri client and its exclusive build, dependency and test paths while
  preserving shared components, source assets and user data.
- Adds Linux x86_64 and aarch64 build targets for standalone musl CLI/TUI
  executables and X11/Wayland GUI portable archives. Native artifact checks
  remain independent of server and npm verification.
- Moves native Agent adaptation to A4AA and behavior profiles to AwP.
  Available Agents are separate from saved configuration; enrollment and
  named-profile creation are explicit GUI and CLI actions. Meshrix retains
  authorization, secret-reference resolution and durable task state.
- Integrates Antigravity through the maintained A4AA descriptor. Model,
  effort and execution-mode controls follow the adapter's actual support;
  unsupported settings fail before prompt reservation. Headless Antigravity
  does not provide interactive per-tool approval.
- Preserves ACP streamed replies in the final Peer result, separates model
  and effort overrides, and aligns the Rust and TypeScript request digest
  projections. Restart and receipt tests cover the current format.
- Adds self-hosted recording policies, recursive field redaction, enforced
  retention and explicit recording failure behavior. Recording storage is
  organization-controlled local storage, not an independent encryption boundary.
- Adds Console traffic views and metrics export, bounds metrics ingestion
  and history, and reports degraded persistence instead of healthy status.
- Hardens upstream credential origin binding, authorization and public error
  projections, scopes event delivery to its grants, and bounds schema pattern
  evaluation with RE2.
- Publishes npm archives through Trusted Publishing and improves artifact
  installation checks and retained failure diagnostics.

## [0.1.0] - 2026-10-04

Initial release of the `meshrix.js` platform and `@meshrix/gateway` library.

- Provides the Node.js Core server, Vue.js Web Console, and an independently embedded HTTP/stdio MCP gateway.
- Aligns modern MCP request metadata and HTTP mirrors with the 2026-07-28 protocol while retaining explicitly selected legacy upstream transports.
- Persists non-read execution intents and dispatch fences, preserves uncertain outcomes after interruption, and prevents automatic replay of a fenced invocation.
- Rechecks authorization at the final upstream send boundary and preserves caller-controlled cancellation and owned-resource cleanup.
- Uses canonical registry dependencies and unchanged package tarballs for consumer installation checks.
- Bundles first-party client-adapter components with `meshrix.js` while keeping each target action explicit. The repository root source declares Apache-2.0; third-party component licenses and notices remain applicable.
- Publishes through one tag-driven npm workflow with standard authentication and retained sanitized diagnostics.
