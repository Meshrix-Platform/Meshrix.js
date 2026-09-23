# Independent gateway interoperability oracle

Run on supported Node 24 with the package's own lock (`npm ci --prefix tests/interop/gateway --ignore-scripts`). This directory imports no Meshrix product module. `@modelcontextprotocol/sdk@1.29.0` negotiates **2025-11-25 only**; its legacy comparison does not certify modern MCP. The separately encoded raw HTTP/JSON-RPC peer in a **child process** tests the declared 2026-07-28 profile without legacy `initialize`, `notifications/initialized` or `Mcp-Session-Id`: modern clients use `server/discover` and per-request `_meta`/protocol headers. Legacy peers alone use initialize/session. Raw JSON-RPC envelopes, method-specific result fields, metadata placement, resultType, value wrappers, catalog output schemas, dynamic InputResponses and peer-owned effect records are checked before normalization. Neither an HTTP status nor an internally claimed effect constitutes evidence.

```sh
node --test tests/interop/gateway/self-test.test.mjs
node tests/interop/gateway/run.mjs --mode reference --continue-on-failure
node tests/interop/gateway/run.mjs --mode meshrix --config <private-run-config.json> --continue-on-failure --report <private-run-report.json>
```

`--mode meshrix` **requires** explicit `--config` or `MESHRIX_INTEROP_CONFIG`. No default source fixture or implicit candidate can satisfy an installed-product claim. `fixtures/neutral-http-candidate.json` is a framework-only control; `fixtures/fix-b-candidate.json` is an old **source smoke** fixture, not a release candidate. A legacy SDK peer is not evidence of a modern handshake. The runner does not read product source, `#imports`, checkout internals, or inject `AuthenticatedContext`.

## Public candidate input (contract v2)

A JSON config has exactly one entry, `endpoint` or `command` with optional `args`/`cwd`, and `candidateKind` equal to `standalone-packed-http`, `platform-default-http`, `legacy-packed-http` or `reference-fixture`. `protocolVersion` defaults to `2026-07-28` and may name a declared legacy version. Use isolated synthetic credentials in `authorization`; neither credentials nor addresses are written to reports. Optional `publicMapping:{"toolName":"...","resourceUri":"...","promptName":"..."}` declares the actual public names/URI; the peer ledger independently verifies that these reach the original synthetic upstream identity and only protocol URI locations may be mapped (business payload remains unchanged). The candidate must be provisioned through its **public** configuration/authentication to reach the synthetic upstream peer; this runner starts that peer on an ephemeral loopback port and passes `MESHRIX_INTEROP_PEER_ENDPOINT` to a command candidate's environment. A candidate command announces its actual HTTP entry by printing one line `{"interopEndpoint":"http://127.0.0.1:<port>/mcp"}` after it listens. It must handle modern server/discover without initialize/session, or legacy initialize/initialized for the declared legacy profile, then tools/resources/prompts list and request/continuation on that network endpoint; on SIGTERM it drains and exits. The parent reaps it, and a failed reaping fails cleanup. Endpoint-only configurations can exercise transport but **cannot prove the running artifact digest** and therefore cannot pass an installed-candidate identity check.

Packed profiles require `manifest` (a local path to JSON):

```json
{
  "schema": "meshrix.gateway-candidate-manifest/v1",
  "candidateKind": "standalone-packed-http",
  "commit": "<actual-candidate-revision>",
  "serverInfo": { "name": "<actual-discover-name>", "version": "<actual-discover-version>" },
  "artifacts": [{ "path": "<installed-entry-path>", "sha256": "<64-hex-file-digest>" }]
}
```

All declared files are read and hashed at invocation, an executed command argument or binary must match one listed artifact, and discovered serverInfo must match the manifest. Paths under this oracle are disallowed as product artifacts. Never enter a source script as an installed candidate. An external endpoint without an independently bindable executed entry is reported non-passing even if its serverInfo happens to match a claimed manifest. The report contains only candidate kind, commit, executed entry digest, the fact of runtime binding, protocol, named assertions, case status, and cleanup counters; no manifest path, executable path, endpoint, token, nonce, business payload or stderr. Profile claims require actual execution of each profile. A `reference-fixture` pass is **not** a product pass.

## Cases, mutations, and final gate

The self-test covers GC-066, GC-067, GC-069 through GC-073 with independent reference/process controls. It retains the original eight named mutants and adds ten precise counterexamples. A mutation is counted only if its intact live baseline passes and its own expected assertion rejects; explicit always-passing adjudicator injection proves that missed detection fails. The live HTTP proxy variants exercise encoding alias replay, empty permission/approval, dropped nonce answer, misplaced required metadata, resource value wrapping, unknown resultType, missing outputSchema, metadata and business fields. A process crash, timeout, unobserved effect, or absent candidate is `not_run`/`unobservable`, never a mutation kill. Each run owns its peer child, candidate child, ephemeral socket and report; concurrent runs never share mutable latest state.

The per-run `gc068` field stays `not_run` for reference controls and until an **external final original acceptance gate** combines the same actually installed candidate manifest across standalone and default-platform entries (and declared legacy profile). A single green per-profile result is partial product evidence, not GC-068 combined acceptance. If live authorization/approval facts cannot be supplied through a product's public configuration, do not translate this fixture's synthetic `_meta` control into a trusted context or claim GC-071 product coverage. Source smoke, package E2E, and product combined conformance remain separate.

`--continue-on-failure` preserves all case statuses and continues discovery. Exit 0 means the selected run's eight cases passed with complete cleanup, exit 1 means a named failure (possibly alongside not-run cases), and exit 2 means no assertion failure but required cases were not run. A successful framework fixture run still reports `productIntegration:not_run`, `gc068:not_run`. Reports are run-local and contain no mutable `latest` pointer. Unsupported profiles and unobservable upstream effects are non-passing; never infer no effect from HTTP 200/403.
