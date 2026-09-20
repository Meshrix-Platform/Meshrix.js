# REVIEW-FIX-A handoff

This handoff covers F-04 through F-10, F-16, F-21, and F-22 from the dispatch. No Plan success claim is made. The existing worktree was preserved; no git add, commit, checkout, reset, push, tag, or publish command was run.

## Baseline and status delta

Baseline commands from the dispatch:

```text
$ git status --short | wc -l
113
$ git diff --stat | tail -3
 tsconfig.node.json                                 |    1 +
 vitest.config.ts                                   |    1 +
 87 files changed, 808 insertions(+), 9479 deletions(-)
```

Before this handoff was written, the status was:

```text
$ git status --short | wc -l
115
$ git diff --stat | tail -3
 tsconfig.node.json                                 |    1 +
 vitest.config.ts                                   |    1 +
 89 files changed, 832 insertions(+), 9504 deletions(-)
```

The two tracked-file additions to the status delta are the two modified upstream-gateway owner files. The gateway source, contracts gateway source, composition source, and gateway tests are under pre-existing untracked directories in the user's worktree. No unrelated paths were edited by this pass.

## Findings

### F-04 — injected resource/prompt ports bypassed enforcement

Before, reviewer resource-port probe:

```json
{"outcome":{"kind":"complete","value":"secret"},"calls":["read"]}
```

Changed `packages/gateway/src/gateway.ts:384-433`: resource, prompt, and completion ports now supply a protected sink to `#invokeInternal`, including policy, permit, admission, revalidation, and result normalization. Normalized `input_required` results remain eligible for continuation.

After:

```json
{"outcome":{"kind":"failure","origin":"policy","code":"always_deny","message":"denied","status":403,"effectOutcome":"not_started"},"calls":[]}
```

Residual gap: none in this dispatch scope.

### F-05 — upstream MCP hints determined effect class

Before, reviewer CASE-G01 observation: an upstream `readOnlyHint` flowed through projected `_meta.risk` into a route classified as `read`, allowing the destructive-approval decision to be skipped.

Changed `packages/agents/src/upstream-gateway/tool-projection.ts:59-125` to keep annotations as untrusted hints and derive the policy fact from the operator-configured `tools/call` operation. Changed `packages/server-runtime/src/composition/gateway-composition.ts:160-170` to read only the trusted `io.meshrix/gateway-policy.effectClass`; `meta.risk`, `tool.risk`, and annotations no longer classify the route. The policy is: absent/normal operator configuration defaults to `safe_write`; explicit `repair_write`/`destructive` requires approval; upstream hints cannot downgrade or upgrade it.

After, `tests/vitest/gateway/platform/platform.test.ts` raw result:

```text
✓ ... > uses operator risk for upstream routes and rebuilds the catalog without cross-subject residue
Test Files  1 passed (1)
Tests  2 passed (2)
```

The same test observes a `destructive` route for an upstream tool carrying `readOnlyHint: true` and receives `approval_required` before any sink call.

Residual gap: an upstream MCP tool without an operator policy fact is not granted a read route; the composition class is `unknown` and normal policy denies it until an operator classification exists.

### F-06 — normalized upstream state was lost

Before:

```json
{"firstKind":"input_required","secondKind":"complete"}
```

Changed `packages/gateway/src/gateway.ts:535-543` to seal `decoded.upstreamState` first, fall back to legacy `requestState` only when the normalized field is absent, and preserve the explicit absent marker.

After, present state:

```json
{"firstKind":"input_required","secondKind":"complete","restored":"normalized-state"}
```

The added absent-state test reports no `requestState` property on the second upstream request.

Residual gap: none in this dispatch scope.

### F-07 — fatal stateful-upstream failures did not mark context lost

Before:

```json
{"outcome":{"kind":"failure","origin":"transport","code":"upstream_process_exit","message":"process exited","status":500,"effectOutcome":"failed"},"state":"active"}
```

Changed `packages/gateway/src/gateway.ts:512-556` to mark stateful handles lost on HTTP 404, fatal HTTP 5xx responses, protocol/transport failures, and thrown upstream failures before returning/cleaning up. Abort cancellation remains non-fatal.

After:

```json
{"outcome":{"kind":"failure","origin":"transport","code":"upstream_process_exit","message":"process exited","status":500,"effectOutcome":"failed"},"state":"context_lost"}
```

Residual policy gap: ordinary HTTP 4xx application errors are not automatically treated as state loss; stateful context loss is reserved for the fatal HTTP/transport/protocol classes above.

### F-08 — context handle ignored grant and credential generations

Before:

```json
{"outcome":{"kind":"complete","value":"ok","isError":false},"calls":1}
```

Changed `packages/gateway/src/gateway.ts:457-468` to bind handle use to current grant revision and credential generation in addition to tenant, principal, and route. The source contract records the optional current credential generation at `packages/contracts/src/gateway/index.ts:35-45`; runtime fallback uses platform metadata, grant facts, or auth generation.

After:

```json
{"outcome":{"kind":"failure","origin":"continuation","code":"context_binding_mismatch","message":"The business context is not bound to this request.","status":403,"effectOutcome":"not_started"},"calls":0}
```

Residual gap: hosts that do not expose a distinct credential generation intentionally fall back to `authGeneration`.

### F-09 — tombstones were unbounded and capacity was global

Before:

```json
{"other":"context_capacity_exceeded","retentionBudget":"undefined","states":["lost"]}
```

Changed `packages/gateway/src/context/index.ts:18-145` to partition active capacity by tenant/principal/route, add bounded terminal tombstones, implement `sweep()`, keep reclaimed handles permanently unknown, and expose `retentionBudget()`.

After:

```json
{"other":"context_capacity_exceeded","otherPartition":"active","budget":{"maxActivePerSubjectUpstream":1,"maxTombstones":1,"tombstoneRetentionMs":10,"retainedTombstones":1,"activePartitions":1},"removed":1,"old":"context_unknown"}
```

Residual gap: sweeping is demand-driven by store operations or an explicit `sweep()` call; this pass does not add a background timer.

### F-10 — external schemas were not validated on invocation

Before:

```json
{"outcome":{"kind":"complete","value":"ok","isError":false},"calls":1}
```

Changed `packages/gateway/src/catalog/index.ts:103-175` to compile and cache declared input/output schemas at catalog publish, and `packages/gateway/src/gateway.ts:476-480,545-550` to validate input before policy/sink and output after the sink with schema-origin and budget-specific failures.

After:

```json
{"outcome":{"kind":"failure","origin":"schema","code":"schema_validation_failed","message":"Input schema for schema does not satisfy its schema.","status":400,"effectOutcome":"not_started","details":{"phase":"input","errors":[{"instancePath":"","schemaPath":"#/required","keyword":"required","message":"must have required property 'id'","params":{"missingProperty":"id"}}]}},"calls":0}
```

The output-validation test also returns `origin: schema`, `code: schema_validation_failed`, and `effectOutcome: failed` after one sink call.

Residual gap: validation is enabled whenever a descriptor declares a schema; no separate output-validation opt-out policy existed in the dispatch contracts.

### F-16 — unknown assertion keywords were silently ignored

Before:

```json
{"compiled":true,"valid":true}
```

Changed `packages/gateway/src/schema/index.ts:109-142` to enable Ajv strict schema diagnostics and convert unknown keyword/vocabulary errors into a precise `schema_keyword_unsupported` error.

After:

```json
{"compiled":false,"code":"schema_keyword_unsupported","message":"External schema uses an unsupported JSON Schema keyword or vocabulary."}
```

Residual gap: none for unsupported assertion surfacing; standard 2020-12 annotation keywords remain handled by Ajv.

### F-21 — non-JSON-RPC HTTP errors left permits consumed

Before:

```json
{"outcome":{"kind":"failure","origin":"peer","code":"upstream_http_502","message":"Upstream returned an HTTP failure.","status":502,"effectOutcome":"unknown"},"mark":0}
```

Changed `packages/gateway/src/gateway.ts:518-524` to transition the consumed permit through `markOutcomeUnknown` before returning the non-JSON-RPC HTTP failure.

After:

```json
{"outcome":{"kind":"failure","origin":"peer","code":"upstream_http_502","message":"Upstream returned an HTTP failure.","status":502,"effectOutcome":"unknown"},"mark":1}
```

Residual gap: custom permit ports that omit the contract's optional `markOutcomeUnknown` hook cannot expose an external transition; the built-in authority and tested injected authority both transition it.

### F-22 — platform catalog accumulated descriptors and route collisions

Before, reviewer observation: `descriptorsByRoute` retained entries across subject syncs and `upstream:tool:${name}` allowed similarly named tools from different services to last-write-wins.

Changed `packages/server-runtime/src/composition/gateway-composition.ts:160-170,374-423` to include service identity in upstream route/revision refs and rebuild the published descriptor set from the current sync's visible routes. The platform test publishes two same-named tools from different services, verifies two distinct routes, then removes one and verifies the snapshot contains only the remaining route.

After:

```text
✓ ... > uses operator risk for upstream routes and rebuilds the catalog without cross-subject residue
Test Files  1 passed (1)
Tests  2 passed (2)
```

Residual gap: a duplicate name repeated by the same service in one upstream listing still follows the existing last-entry normalization; cross-service route collisions are separated by service identity.

## Verification commands and raw results

Final gateway regression (run once after all repairs):

```text
$ npm run vitest -- tests/vitest/gateway --maxWorkers=2
Test Files  24 passed (24)
Tests  62 passed (62)
```

Node typecheck:

```text
$ npx tsc -p tsconfig.node.json --noEmit --pretty false
[no output; exit 0]
```

Focused owner tests:

```text
$ npm run vitest -- tests/vitest/gateway/resources-prompts/resources-prompts.test.ts tests/vitest/gateway/continuations/continuations.test.ts tests/vitest/gateway/faults/faults.test.ts tests/vitest/gateway/baseline/baseline.test.ts tests/vitest/gateway/schema/schema.test.ts tests/vitest/gateway/platform/platform.test.ts --maxWorkers=2
Test Files  6 passed (6)
Tests  26 passed (26)
```

Focused server tests for the changed agent/schema/composition boundary:

```text
$ npm run vitest -- tests/vitest/server/mcp-tool-schema-adapter.test.ts tests/vitest/server/runtime-refactor-routing-mcp-discovery.test.ts tests/vitest/server/upstream-audience-projection.test.ts --maxWorkers=2 --reporter=verbose
Test Files  2 failed | 1 passed (3)
Tests  2 failed | 27 passed (29)
Error: better-sqlite3 was compiled with NODE_MODULE_VERSION 137; this Node runtime requires 147.
```

The two failures are the known environment-only SQLite ABI failures; all non-SQLite tests in that selected scope passed. No rebuild or out-of-scope repair was attempted.

Whitespace:

```text
$ git diff --check
[no output; exit 0]
```

The requested diagnostic form with `--continue-on-failure` was also attempted. Current Vitest rejects it during argument parsing (`CACError: Unknown option --continueOnFailure`), so the actual dispatch command was run without that unsupported flag; Vitest's default `bail=0` completed the full gateway scope.

## Not fixed here

- `apps/**` and `tests/interop/gateway/**` were not edited, as required by the write set.
- Reviewer findings outside this dispatch (pack/install closure, candidate pinning and Plan lifecycle, notification/subscription capability, stray peer files, independent-runner strength, and host-limited diagnostics) remain for their owning dispatches.
- Existing unrelated working-tree changes and untracked gateway convergence assets remain untouched.
