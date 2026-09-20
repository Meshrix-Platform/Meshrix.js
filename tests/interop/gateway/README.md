# Gateway interoperability oracle

This directory is an independent protocol oracle for the gateway convergence plan. It
owns a neutral SDK peer, a separately encoded wire peer, payload, lifecycle and mutation
oracles, a runner, and its own self-test. It does not import Meshrix source, and it never
reaches into a candidate's internals: a candidate is only ever driven through its public
entry (a child process on stdio, or an HTTP endpoint).

Install and run it with:

```sh
npm ci --prefix tests/interop/gateway --ignore-scripts
node --test tests/interop/gateway/self-test.test.mjs
node tests/interop/gateway/run.mjs --mode reference --continue-on-failure
node tests/interop/gateway/run.mjs --mode meshrix --continue-on-failure
```

`MESHRIX_INTEROP_TRANSPORT=http` switches the reference profile from in-process dispatch
to real loopback HTTP. Both profiles produce eight real observations and both are part of
the declared acceptance.

## Candidate resolution

`--mode meshrix` resolves its candidate without ever inventing one:

1. `--config <path>`, else
2. `MESHRIX_INTEROP_CONFIG`, else
3. the in-repo default, `fixtures/fix-b-candidate.json`, which points at the frozen
   cross-Task candidate entry `tests/vitest/gateway/interop-candidate.mjs`.

The report records which of the three was used (`candidate.source`), the resolved config
path, and the launched command/args/cwd as `candidate.identity`. A configured endpoint is
never written into the report; an endpoint candidate records
`{transport:"http", endpointRedacted:true}` instead.

A candidate that never completes its handshake is reported as `not_run` for all eight
cases with a reason derived from what was observed (`candidate_startup_timeout`,
`candidate_process_exited`, `candidate_protocol_not_jsonrpc`, ...), and the run exits
non-zero. That is the declared CASE-O07 condition; it is never a disguised pass.

## The two observation profiles

The oracles assert different things depending on what a run can actually see.

- `upstream-observable` (reference peers). The framework owns the peer, so it can assert
  the neutral fixture's literal state tokens and inspect the upstream requests that were
  recorded at the peer.
- `public-entry` (any candidate). Only the public entry is visible. The asserted
  properties are the ones that hold for any correct candidate, and none of them are
  status-code recitals:
  - an input-required round is issued with an opaque token and presenting it back completes
    the call;
  - a **tampered** token must not complete, which is what proves the token is required and
    integrity-checked rather than echoed;
  - a revoked context is refused while the same call under an authorized context completes
    (the authorized clause is the control that stops a blanket-failing candidate from
    looking secure);
  - a refused call records no effect.

  A candidate's internal upstream requests are not observable from outside, so
  `upstreamObservable` is `false` and `upstreamRequests` stays empty. It is not filled
  with a synthesized request list.

## Bad proxies and self-test

Eight named bad proxies are applied to a real observation and each must be rejected by its
own exact reason. A mutation is only attributable when the benign control passes first: if
the base observation is already broken, the result is reported as
`observation_not_intact` rather than being counted as a caught proxy.

The self-test also carries negative controls that fail if an oracle degenerates: a
hand-written `pass` with no measured timing does not satisfy the slow-path oracle, an
already-broken base cannot produce an attributable rejection, and a degenerate candidate
observation must produce eight explicit non-rejections rather than a runner crash.

## Independent import boundary

`run.mjs` decides the boundary by import relation rather than by path spelling. For every
specifier in the tree it resolves what the specifier refers to: Node builtins and the
pinned dependencies are allowed, this package's own name is itself, and a private
`@meshrix/*` package, a bare `meshrix` package, a `#imports` alias, an undeclared package,
a `file:` hand-off, or a relative specifier that escapes this directory is a violation.
Matching only `packages/`-shaped strings previously missed `from '@meshrix/gateway'`.

## Complete-result encoding

The plan's normative wire skeleton spells a complete result flat
(`{resultType, content, structuredContent, _meta}`). A candidate may instead nest the tool
result under `value`. The adapter canonicalizes both and records which one it saw as
`candidate.encodings.complete`, so the deviation stays visible in the report rather than
being silently normalized away. Business-field fidelity is asserted on the real observed
payload in either case.

## Report

The report is JSON on stdout and can be copied with `--report`. It carries the candidate
identity and source, the specification/SDK/validator versions, the profile, the seed, the
total case count, each stable case id with `pass`/`fail`/`not_run` and a stable reason, the
control-flow outcome, and a resource-cleanup conclusion. Response bodies, credentials, and
configured endpoints never enter it.

Cleanup is measured, not asserted: every child process, socket and temporary directory the
run creates is registered and released, and the report distinguishes `created` from
outstanding `leaks`. A candidate child that had to be killed is reported as
`candidate_process_not_reaped`.

Exit status is `0` only when every case selected for this run genuinely passed, `2` when a
required case could not run, and `1` when a case failed. `--continue-on-failure` changes how
far a run gets and is reflected in `control`, but never changes what a case means.

## Neutral fixtures

`fixtures/neutral-candidate.mjs` (+ `.json`) is a framework-owned stdio candidate that
wraps the same neutral fixture the reference peers use. It exists so the meshrix profile -
candidate resolution, process launch, all eight cases, process reaping - can be proven
end to end without TASK-001 and without a product candidate.
`MESHRIX_INTEROP_CANDIDATE_VARIANT=drop-business-field` degrades it so the runner's failure
handling and `--continue-on-failure` control flow can be observed against a real process.

## Pinned versions and known limits

The pinned reference versions are `@modelcontextprotocol/sdk@1.29.0` and `ajv@8.20.0`. The
wire peer uses only Node's built-in HTTP and JSON APIs, so the SDK and wire encoders are
independent implementations of the same declared contract.

The SDK peer negotiates `2025-11-25` - the highest version the pinned SDK supports - while
the target profile is `2026-07-28`. Both negotiated versions are recorded in the report
rather than assumed equal, and the SDK request schemas are widened (`.loose()`) to accept
the MRTR `requestState`/`inputResponses` fields the pinned SDK does not yet model. Both
peers share the fixture definition, so CASE-O02 compares two independent transports and
serializers over one declared contract; it is not an independent derivation of the
business payload.
