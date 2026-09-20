# TASK-002 handoff

## Nodes

NODE-I01 through NODE-I12 are implemented under this directory:

- I01: local package, lockfile, configuration contract, and standalone import boundary.
- I02: official SDK peer, independent wire peer, neutral tool/resource/prompt fixtures, MRTR state, and effect observations.
- I03: Ajv 2020-12 schema vectors plus business JSON and byte-fidelity oracle.
- I04: continuation, requestState restoration, authorization, revocation-effect, and context-isolation observations.
- I05: eight named bad proxies with exact rejection reasons and mutation self-test.
- I06: `reference` and `meshrix` runner modes that consume a candidate only through public entries.
- I07: deterministic reference profile, measured cleanup accounting, stable seed/version metadata, and redacted reports.
- I08: focused self-test and this handoff.
- I09: in-repo default candidate resolution and candidate-bound execution of all eight cases.
- I10: runner control semantics, import-relation boundary, and real slow-path observations.
- I11: loopback HTTP interoperability profile with real observations.
- I12: stable case ids, honest statuses, and this handoff.

## Closure changes in this pass

- `--mode meshrix` with no `--config` and no `MESHRIX_INTEROP_CONFIG` no longer reports
  `candidate_config_missing`. The runner resolves the in-repo default candidate
  (`fixtures/fix-b-candidate.json` -> the frozen cross-Task entry
  `tests/vitest/gateway/interop-candidate.mjs`), launches it, and computes all eight cases
  against it. The previous run could not execute its configured command and hard-coded
  five of the eight candidate cases as `not_run`.
- `evaluateMutant` no longer throws on a candidate observation that lacks a usable payload.
  The `TypeError` from `mutants/drop-business-field.mjs` that previously escaped the runner
  as a whole-run `runner_failed` is now an explicit per-case failure.
- The nine literal `{complete:true, childProcesses:0, sockets:0, temporaryDirectories:0}`
  cleanup constants are replaced by a ledger that records every child process, socket and
  temporary directory the run creates and releases, distinguishing `created` from `leaks`.
- `--continue-on-failure` is now exercised against a real process, not only parsed.
- The import scan decides by import relation: `@meshrix/gateway`, `#meshrix/...`, a bare
  `meshrix` package, an undeclared package, a `file:` dependency, and a relative specifier
  escaping this directory are all violations. The previous scan matched only `packages/`,
  `apps/` and `plugins/` path shapes.
- CASE-O06 previously fed `{status:'pass'}` into a predicate that only rejected
  `not_run`/`timeout`. It now requires a measured round trip (`observed`, `elapsedMs`,
  `minimumDelayMs`) and rejects a hand-written pass or one too fast to have crossed the
  delay. The loopback HTTP profile now observes the slow path for real instead of reporting
  `slow_good_path_peer_not_configured`.
- A candidate reached through its public entry is evaluated with profile-appropriate
  oracles: the neutral fixture's literal state tokens are not available from outside, so the
  asserted properties are an issued-and-enforced state token (a tampered token must not
  complete), refusal under a revoked context with the authorized call completing as the
  control, and no effect on a refused call. The adapter's synthesized `upstreamRequests` and
  its `resultType === 'denied' ? [] : [{}]` effect guess are gone.
- `fixtures/neutral-candidate.mjs` is a framework-owned stdio candidate so the meshrix
  profile can be proven end to end without TASK-001.

## Focused verification (raw results)

| Command | Result |
| --- | --- |
| `npm ci --prefix tests/interop/gateway --ignore-scripts` | exit 0 |
| `node --test tests/interop/gateway/self-test.test.mjs` | exit 0 - 15 tests, 15 pass, 0 fail, 0 skipped |
| `node tests/interop/gateway/run.mjs --mode reference --continue-on-failure` | exit 0 - 8 pass |
| `MESHRIX_INTEROP_TRANSPORT=http node tests/interop/gateway/run.mjs --mode reference --continue-on-failure` | exit 0 - 8 pass, 2 sockets created and released, CASE-O06 observed over `node:http-jsonrpc` at 17 ms against a 15 ms delay |
| `node tests/interop/gateway/run.mjs --mode meshrix --continue-on-failure` | exit 0 - 8 pass, `candidate.source=default-in-repo`, launched, `candidate.identity.args` contains `tests/vitest/gateway/interop-candidate.mjs` |
| `... --mode meshrix --config fixtures/neutral-candidate.json` | exit 0 - 8 pass, 1 child created and reaped, `encodings.complete=structured-content` |
| `MESHRIX_INTEROP_CONFIG=<absent> ... --mode meshrix` | exit 2 - 8 `not_run`, `candidate.launched=false` |
| broken-candidate variant, with and without `--continue-on-failure` | 3 executed / 5 `stopped_after_failure` versus 8 executed / 0 skipped; identical status and reason for every case executed in both |

No case in any run above carries a hard-coded `not_run`, and no `not_run` in the meshrix
run is caused by the runner itself.

## Candidate binding status

- The runner is bound to the frozen in-repo default candidate path, and every run records
  `candidate.source`, `candidate.configPath`, and the launched `candidate.identity`.
- The eight cases now execute against that candidate and currently pass.
- The candidate is **not** pinned to an artifact: `candidate.commit` and
  `candidate.artifactDigest` are `null` because no commit or digest was supplied to this
  task. Binding a run to a reproducible candidate artifact, and deciding whether the
  product subset is in scope for this framework's qualification, remain authorized
  operational actions outside this task.
- `public-entry` cases assert public-entry-observable invariants. They do not and cannot
  show that a candidate's internal upstream state was restored at an internal observation
  point; that property is asserted only for the reference peers, which the framework owns.

## Observation to carry forward

The candidate emits a complete result as `{resultType:"complete", value:{...}}`. The plan's
normative wire skeleton (`docs/plans/meshrix-gateway-convergence/fixtures/mrtr-wire-sequence.json`)
and the neutral fixture spell the same result flat, with the business payload under
`structuredContent`. The adapter canonicalizes both encodings and records which it observed
as `candidate.encodings.complete`; the current in-repo candidate reports `value`.

This is recorded, not silently normalized away: business-field fidelity is asserted on the
real observed payload either way, but the envelope spelling differs from the plan's
normative skeleton. Whether the product should emit the flat envelope is a TASK-001/product
decision, not one this framework should settle by refusing to read the candidate.

## Not run

- The complete `npm run verify:acceptance` regression. It belongs to the native main after
  both tasks are terminal and is explicitly out of this task's focused scope.
- Reviewer, publication, and release evidence.
- OCI, extra-OS and TLS qualification profiles, which `specs/09` makes separate declared
  profiles.

This handoff claims the independent framework's own focused acceptance only. It does not
claim product acceptance, full regression, review, publication, or release evidence, and it
does not claim that the product subset is bound or that a candidate artifact is fixed.
