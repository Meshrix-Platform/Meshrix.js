# TASK-001 old-chain deletion handoff

Status: focused deletion complete. The default HTTP MCP endpoint uses the
platform gateway composition and modern downstream adapter; the former
internal MCP transport and agent pipeline are no longer present.

## Removed

- The old HTTP MCP transport barrel, request/session/in-flight state,
  validation, reply, upstream projection, discovery, protocol, response, and
  tools modules under `packages/protocols/mcp/adapter/`.
- `packages/server-runtime/src/composition/agent-mcp-gateway-pipeline.ts`.
- The acceptance verifier and tests whose contract was the deleted internal
  pipeline: `gateway-boundary-final.ts`, its acceptance test, and the old
  pipeline/model-boundary test files.
- Old server tests that directly exercised the deleted handler and helper
  modules; focused modern downstream, cancellation, API-key, header, and
  catalog tests now cover the live boundary.

## Preserved isolation

- `packages/protocols/mcp/legacy/` remains a separately packaged compatibility
  adapter and is not imported by the default `/mcp` path.
- The modern upstream adapter, `packages/protocols/mcp/adapter/gateway.ts`,
  installer/client-wire modules, and protocol constants remain available for
  their independent contracts.
- `gateway-channel-router.ts` remains because console channel selection and
  plugin lifecycle administration still use it; it is not the HTTP MCP
  execution chain.
- Notification state remains injected through the neutral
  `packages/protocols/mcp/notifications.ts` port and server composition.

## Verification

- `npm run vitest -- tests/vitest/gateway --maxWorkers=2` — 24 files / 51 tests passed.
- `npm run vitest -- tests/vitest/server/catalog-convergence-partitions.test.ts --maxWorkers=1` — 1 file / 9 tests passed.
- `npx tsc -p tsconfig.node.json --noEmit --pretty false` — passed.
- `npx tsc -p packages/gateway/tsconfig.json --noEmit --pretty false` — passed.
- `npx tsc -p tsconfig.tests.json --noEmit --pretty false` — passed.
- `npm run verify:registry` — passed.
- `NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-protocol-boundary.ts` — passed.
- `NODE_OPTIONS=--conditions=source node tools/verifiers/downstream-mcp-completeness-audit.ts` — 221 operations / 0 findings.
- `NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-operation-permission-tag-governance-audit.ts` — 8 tag operations / audit ready.
- `NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-communication-service.ts` — passed.
- `NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-core-platform-surface-convergence.ts` — passed.
- `git diff --check` — passed.

The one-time absence proof across live MCP serving and adapter sources was:

```text
if rg -n "handleMeshrixMcpHttpRequest|agentMcpGatewayPipeline|createAgentMcpGatewayPipeline|executeUpstreamToolViaGatewayForward" apps/server/runtime packages/server-runtime/src/composition packages/protocols/mcp/adapter; then ...; else ...; fi
legacy execution symbols absent from live serving and adapter sources
```

## Known environment-limited checks

- The focused server diagnostic retained the host's loopback `127.0.0.1`
  `EPERM` restriction for socket-based fixture/artifact tests.
- SQLite-backed artifact tests retain the pre-existing `better-sqlite3`
  native-module ABI mismatch (`NODE_MODULE_VERSION 137` versus runtime `147`).
- These checks were recorded as non-green environment limitations, not claimed
  as repaired.

No full repository regression or Reviewer was started. No files were staged;
no commit, push, tag, publish, deployment, or external service action was
performed. This handoff does not claim overall Plan success.
