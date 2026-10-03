# TASK-001 handoff

Status: focused acceptance passed.

Candidate: the delivered tree of commit `f50325271f1dbb1f7590492a5c370ce420db024c`
on branch `agent/mcp-gateway-protocol`. When this handoff was written the work was
still an uncommitted working tree; that statement described the tree before the
delivery changes landed and no longer identifies the candidate. The Designer
acceptance recorded that the pre-change tree was identical to baseline
`91e98202f7c416db3d1d59d771091ace4437048c`, and no reset, checkout, or baseline
replacement was performed.

## Nodes

NODE-P01 through NODE-P30 are implemented in the TASK-001 write set:

- P01–P06: baseline evidence, public contracts, standard schema boundary,
  payload ownership, tagged results, catalog snapshots, and reversible routing.
- P07–P10: modern upstream/downstream MCP, isolated legacy profiles, and
  encrypted MRTR continuation binding.
- P11–P19: policy, final permits, business context lifecycle, admission,
  subscriptions, resources/prompts, transit, configuration/credentials, and
  generic service events.
- P20–P23: embedded kernel composition, platform adapter, migration tool,
  gateway-only CLI, and installer package.
- P24–P26: deletion ledger, focused fault coverage, bounded benchmark tooling,
  and resource cleanup behavior. Existing upstream-publishing service files
  remain separately owned legacy platform assets; the TASK-001 candidate path
  does not import them.
- P27–P30: public documentation/examples, build/dist synchronization and
  package candidate workflow, canonical registry entries, and this handoff.

## Evidence

- `npm run vitest -- tests/vitest/gateway --maxWorkers=2` — 22 files / 46 tests passed.
- `npx tsc -p tsconfig.node.json --noEmit --pretty false` — passed.
- `npx tsc -p packages/gateway/tsconfig.json --noEmit --pretty false` — passed.
- `npm run verify:registry` — all registries and generated projections passed.
- `npm run build:node` — passed; gateway and installer dist outputs synchronized.
- Gateway and installer `npm pack --dry-run` checks passed after build; a clean
  temporary install/import smoke passed for the gateway package.
- `git diff --check` — passed.

## Bounded gaps

- Full repository regression and Reviewer were not started, as directed for
  this task; they belong to the later terminal acceptance flow.
- `tests/interop/gateway` was not written or modified. The repository-wide
  script-registry source-closure verifier was observed to fail on pre-existing
  dependency files under that out-of-scope tree; those files were preserved.
- No publish, push, tag, deployment, or external service invocation was run.
