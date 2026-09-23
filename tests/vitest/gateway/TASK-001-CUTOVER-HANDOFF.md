# TASK-001 cutover handoff

Status: focused cutover complete; the default HTTP MCP serving path no longer
uses the old internal execution chain.

## Cutover

- `apps/server/runtime/http-server-routes.ts` now parses `/mcp` JSON and
  delegates it to the injected `platformMcpGatewayAdapter`.
- `packages/server-runtime/src/composition/http-application-assembly.ts`
  constructs, starts, and closes `createPlatformMcpGateway`; the former
  `agentMcpGatewayPipeline` is no longer composed into the HTTP server.
- `packages/server-runtime/src/composition/gateway-composition.ts` binds the
  platform stores to `@meshrix/gateway` and its modern downstream MCP adapter.
- The communication-service manifest and verifier now identify
  `packages/protocols/mcp/modern-downstream/index.ts` as the current MCP
  service module.

The one-time serving-wiring proof was:

```text
if rg -n "handleMeshrixMcpHttpRequest|agentMcpGatewayPipeline|createAgentMcpGatewayPipeline|executeUpstreamToolViaGatewayForward" apps/server/runtime packages/server-runtime/src/composition/http-application-assembly.ts packages/server-runtime/src/composition/gateway-composition.ts; then ...; else ...; fi
legacy execution symbols absent from live serving wiring
```

## Protocol isolation

The current default path is the `2026-07-28` modern downstream adapter. Modern
upstream requests remain request-level. The versioned compatibility adapter in
`packages/protocols/mcp/legacy/` remains isolated for the declared legacy MCP
versions and session semantics. Discovery and handshake helpers now live under
`packages/protocols/mcp/modern-downstream/`; the default path does not import
the retired historical request transport or business execution helpers.

## Evidence

- `npm run vitest -- tests/vitest/gateway --maxWorkers=2` — 23 files / 48 tests passed.
- `npm run vitest -- tests/vitest/server/http-request-abort-propagation.test.ts --maxWorkers=1` — 1 file / 3 tests passed.
- `npx tsc -p tsconfig.node.json --noEmit --pretty false` — passed.
- `npx tsc -p packages/gateway/tsconfig.json --noEmit --pretty false` — passed.
- `npx tsc -p tsconfig.tests.json --noEmit --pretty false` — passed.
- `NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-communication-service.ts` — passed.
- `npm run verify:docs` — passed.
- `git diff --check` — passed.

The broader diagnostic command
`npm run vitest -- tests/vitest/server/http-request-abort-propagation.test.ts tests/vitest/server/upstream-artifact-transit.test.ts tests/vitest/server/mcp-tools-list-pagination.test.ts --maxWorkers=2`
exposed the same two environment failures recorded in the deletion handoff:

- SQLite-backed artifact setup reached a pre-existing `better-sqlite3`
  native-module ABI mismatch (`NODE_MODULE_VERSION 137` vs the current
  runtime's `147`).
- Socket-backed fixture/artifact setup was rejected by the host's loopback
  `127.0.0.1` listener with `EPERM`.

Those failures were not treated as green and were not repaired in this
cutover. The focused cutover ingress test is self-contained and does not bind
a socket or open SQLite.

## Remaining gaps

- The full repository regression and Reviewer were not started, as directed.
- No add, commit, push, tag, publish, deployment, or external service action
  was performed.
- The deletion-specific focused results and retained compatibility boundary are
  recorded in `TASK-001-DELETION-HANDOFF.md`; no historical adapter consumer
  remains in live source.

This handoff does not claim overall Plan success or full repository acceptance.
