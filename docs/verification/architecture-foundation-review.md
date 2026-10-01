# Architecture and maintenance foundation review

The current source implementation is accepted for the architecture and maintenance
foundation milestone. It is **not an open-source release qualification**. This
review covers source ownership, production wiring, typed boundaries, lifecycle
behavior, maintenance workflow and deterministic engineering evidence. It does not
claim a real Agent workflow, production-data acceptance, a performance result or
publication readiness.

## Independent corrections

The review reproduced two public error-projection bypasses: a frozen object shaped
like an internal Gateway failure could pass through unchanged, and an authentication
error code could disclose arbitrary snake-case diagnostic text. Both boundaries now
project through the canonical public failure vocabulary, with synthetic regressions
against the actual Gateway and MCP adapter.

Materialization now connects concrete production ports to its model, runtime,
SQLite schema and transaction store. Unknown stored data is validated through the
existing model before it becomes a durable state. Shutdown closes admission, joins
admitted API work, drains owned queue execution and then closes owned storage.
Concurrent callers share the shutdown barrier; a bounded drain observation retains
ownership and permits retry. Borrowed capability security providers are preserved
through constructor failure and normal shutdown; locally created resources are
closed once, including shared-provider cases.

The dependency analyzer classifies each import occurrence using the TypeScript AST,
so a type-only import and a lazy import of the same module remain distinct. Actual
runtime cycles, package facades, declared dependencies and layer constraints use the
existing graph authority. Three existing bounded Gateway process/worker owners and
the current MCP final-effect target contract are now accurately registered.

Long-lived Better Plan workspaces are retained. Dependency automation checks actual
repository review authority, unresolved change requests, the latest applicable CI
results and the expected merge revision. Its shell workflow has eleven deterministic
scenarios. Package verification and source assembly share the existing private-source
exclusion policy; the independent benchmark entry remains excluded from public
artifacts. Integration and Console fixtures now follow the implemented contracts.

## Verification and limits

The independent diagnostic exercised 43 test files: 421 tests passed and seven
failed. Two failures reproduced the projection defects; five came from obsolete
integration fixtures. All seven received owning repairs and passing focused checks.

After source review and focused repair, the full `core-public` regression ran once
on `ce9f019`: **30 suites completed, 25 passed and five failed; none were skipped or
timed out**. The original failed result is retained in
[the regression snapshot](regression.html) and the local JSON receipt
`build/test-reports/architecture-foundation-review.json`. It is not relabeled green.
The five failing suites were then closed through their affected checks:

| Original failing suite | Cause | Corrective verification |
| --- | --- | --- |
| `registry.version-governance` | Unregistered MCP contract, graph token drift, negative type-fixture token | Version governance passed. |
| `repo.script-registry` | Canonical private-source exclusion ignored; synthetic credential text findings | Registry and package/source contracts passed; source hygiene passed. |
| `regression.frontend-functional` | Stale count of advanced configuration editors | Named-field form test passed; the affected publication view test also passed. |
| `regression.backend-server-shard-a` | Unregistered bounded execution owners; incorrect constructor cleanup expectation | Execution-boundary and constructor ownership tests passed, including real late-construction failures. |
| `regression.backend-server-shard-b` | Same execution-owner registration; weak types in the extracted schema/store | Controlled sandbox passed; materialization and type-remainder checks passed: 82 tests. |

The affected post-regression files passed across these focused runs: six files in
the repair diagnostic, two constructor/source-contract files (20 tests), and two
materialization/type-remainder files (82 tests). Unaffected successful suite results
were retained. Node and test type checks and the Node build passed again after the
final runtime changes; the unchanged Web build and types retain their full-run pass.
This is a complete failure-discovery run plus focused closure evidence, not a second
all-green full-profile run.

The final resolved graph contains 1,485 source nodes and 3,669 edges: 3,309 static
runtime, 336 type-only and 24 dynamic internal edges. It reports zero runtime
cycles, unresolved imports, facade violations, dependency violations or exceptions.
The two declared production entry roots reach 522 nodes. These counts describe the
reviewed source; the canonical generated graph remains the fact source.

## Privacy findings

No actual secret, personal information or service runtime data was needed for these
checks. Source privacy and secret-hygiene scans passed. The individual findings were:

| File and line | Rule or boundary | Redacted content/category | Assessment and impact | Resolution |
| --- | --- | --- | --- | --- |
| `packages/gateway/src/gateway.ts:131` | Public error projection | Synthetic private diagnostic inside a frozen failure-shaped object | Reproduced disclosure path; no claim that a real secret was previously disclosed. A port could supply untrusted failure fields. | Removed the trust shortcut; canonical projection and regression pass. |
| `packages/protocols/mcp/modern-downstream/index.ts:484` | Authentication refusal projection | Synthetic private diagnostic encoded as a snake-case code | Reproduced disclosure path; lexical validity did not establish public authority. | Require membership in the canonical public failure vocabulary. |
| `tests/vitest/console/upstream-service-publish-view.test.ts:836` | `bearer_credential` artifact scan | Two synthetic credential-shaped field mutations | False positive for actual credential leakage: test-local rejection inputs, with no external secret source. Their rejection behavior remains required. | Generate an explicit synthetic marker; owning tests and package scan pass. |
| `tests/vitest/gateway/closure/cli-remote.test.ts:66` | `bearer_credential` artifact scan | Synthetic local TLS-peer credential | False positive for actual credential leakage: one test-generated value is shared by the local configured server and request. | Use one explicit synthetic credential producer for both sides; local TLS test and package scan pass. |

## Remaining release evidence

The shared programme still owns later delivery outlines: unmodified artifact
installation and both supported Linux architectures; a production-owned stopped
instance recovery entry and interrupted-restore evidence; current-candidate backend,
Console and standard MCP behavior under the designated live acceptance Agent;
semantically equivalent benchmark workloads and measured latency, throughput,
memory and cleanup; and final release provenance, dependency, privacy and support
qualification. Earlier-candidate functional or performance observations do not
establish these claims for this source revision.

Task commits are integrated locally. Remote Draft PR delivery has not been performed;
push and publication remain separate authorization boundaries. The inherited Gateway
inventory is preserved as historical input and is not promoted into current acceptance.
