# Reassembly Diagnostic Reference

Use the contract as a thinking aid for one independently understandable feature
or scenario. It is optional. The owning source, registries, tests, and reducers
remain technical authorities, and the checker never decides whether work may
start or finish.

## 1. When the artifact helps

Consider the contract when work crosses a package, protocol, composition,
ownership, data, or public-interface boundary; when a previous migration left
split authority; or when repeated rework suggests that consumers disagree about
the feature. Skip it for understood, local, reversible changes.

Copy `assets/reassembly-contract.template.json` into ignored process storage only when it
will sharpen a decision. Use `stage: plan` for a working hypothesis and
`stage: closure` for a retrospective closure assessment. Neither stage controls
Better Plan state.

## 2. Interpret the fields heuristically

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Integer `2`, the current diagnostic shape. |
| `stage` | `plan` or `closure`; descriptive only. |
| `repository` | Stable repository owner such as `core`, `client`, `plugins`, or `devkit`. |
| `feature` | Stable feature identifier. |
| `scenario` | One bounded outcome or decision under examination. |
| `authority` | Current and possibly superseded repository-relative source paths. |
| `surfaces` | Only the surface prompts useful to the current diagnosis. |
| `migration` | Temporary residue selectors and deliberately retained compatibility. |
| `verification` | Candidate catalog profiles, task IDs, and objective external blockers. |

The eight known surface IDs are a checklist of questions, not required fields:

| Surface | Question |
| --- | --- |
| `canonical-contract` | Which typed contract exposes the fact without leaking implementation internals? |
| `composition` | Where is it activated, owned, and closed? |
| `consumers` | Which runtime, protocol, CLI, API, UI, or downstream consumers rely on it? |
| `configuration` | Which explicit settings, exports, or deployment facts select it? |
| `registries-generated` | Which manifests, schemas, registries, or generated projections derive from it? |
| `tests` | Which focused checks prove the connected behavior? |
| `documentation` | Which factual architecture, protocol, or runbook references materially change? |
| `external-adapters` | Which independently owned adapters need their own compatibility work? |

Use `pending` for an open question, `verified` for a conclusion supported by
current paths, and `not-applicable` for a reasoned exclusion. Missing surfaces,
pending closure-stage questions, or an empty path are advisories, not blockers.

## 3. Authority and migration

Canonical paths should exist and superseded paths should be absent when the
closure claims a completed migration. The checker reports conflicts as
high-risk advisories because the artifact itself cannot know whether coexistence
is deliberate. Applicable repository migration rules still govern the actual
implementation.

Use residue selectors temporarily during a move, then remove one-off search
artifacts. If compatibility is deliberately retained, name it explicitly and
model it as a current supported contract. Do not call a migration complete while
silently depending on an old path.

## 4. Verification recommendations

Use catalog-owned profiles and task IDs; do not paste shell commands into the
contract.

- `changed` is a broad default recommendation for path-selected checks.
- `reassembly` is an optional Core-owned deep profile for Core package,
  composition, registry, or product-surface convergence.
- external client, plugins, sites, services, and other owners should select their own
  cataloged checks. Never require the Core profile merely because a contract is
  at `closure`.
- A declared blocker should identify an objective external dependency or missing
  authority. Ordinary uncertainty belongs in a surface reason or an advisory.

## 5. Read checker output

`node skills/meshrix-js-feature-reassembly/scripts/reassembly-cli.mjs check`
returns:

- `ok: false` only when the diagnostic artifact cannot be safely interpreted,
  such as invalid JSON, an unsupported schema, or an unsafe path;
- `advisories` for incomplete, contradictory, high-risk, or owner-mismatched
  declarations;
- `recommendation` as a concise next-step suggestion, never an authorization or
  readiness result.

The command exits successfully when the artifact is structurally safe even if
advisories remain. Decide whether each advisory matters to the accepted outcome,
then repair, reframe, defer, or record it. Do not redispatch an unchanged
advisory through the same loop.

## 6. Safe evidence

Use synthetic examples and repository-relative paths only. Do not place runtime
records, prompts, credentials, local paths, machine identity, personal data,
raw logs, or backend data in the contract. Publish only privacy-checked,
repository-owned receipts.
