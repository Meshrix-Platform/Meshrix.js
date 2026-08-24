---
name: meshrix-js-delivery-closure
description: Recover stalled Meshrix.js delivery and close a feature with a risk-proportionate heuristic workflow — diagnose, select a proportional depth, shape the closure, protect functional truth, classify findings, and close without looping. Use when a delivery is stuck, ambiguous, or needs a closure decision. Architecture reassembly diagnostics are owned by $meshrix-js-architecture-reassembly; frontend visual direction by $meshrix-js-frontend-visual-direction.
---

# Meshrix.js Delivery Closure

This skill owns **delivery closure decisions** for Meshrix.js features: the
risk-proportionate workflow that recovers stalled delivery and closes a
feature. Architecture reassembly diagnostics belong to
`$meshrix-js-architecture-reassembly`; frontend visual direction belongs to
`$meshrix-js-frontend-visual-direction`.

## Keep judgment with the agent

Use this skill as a decision aid, not an authorization system. Treat its
sequence, artifacts, reviewer roles, workflow profiles, and surface inventory as
defeasible defaults. Adapt or skip them when current evidence makes another route
more effective.

Preserve only these hard constraints:

- follow explicit user intent and applicable repository rules;
- protect security, privacy, authorization, data integrity, and protected resources;
- obtain authority before irreversible or externally visible side effects;
- keep evidence truthful: never substitute mocks, defaults, stale receipts, or screenshots for behavior they do not prove;
- when a selected closure claims that a migration is complete, migrate every owned consumer and remove the superseded implementation in that closure.

Before work that accesses a protected resource, causes an external or durable
side effect, or retains evidence, read
`docs/architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md` and apply its
bounded, non-bypass safety contract. Do not extend that contract to ordinary
local implementation work.

## Diagnose before prescribing

1. Reconcile the latest user request, current source, executable behavior, and
   relevant Better Plan state. A completed label or historical receipt is a
   clue, not truth.
2. Inspect the working tree read-only. Preserve unrelated work and group current
   changes by user-visible outcome and canonical fact owner.
3. Name one to three plausible closure candidates. Prefer the smallest outcome
   that delivers real value, but allow a broader closure when splitting it would
   create a false intermediate architecture or duplicate migration work.
4. Estimate four dimensions: consequence if wrong, uncertainty, cross-owner or
   cross-layer coupling, and reversibility. Record only the reasoning that would
   change the chosen route.
5. Select a depth. Change depth when evidence changes; do not restart merely
   because the initial estimate was imperfect.

## Select a proportional depth

| Depth | Typical signals | Useful aids | Usual closure evidence |
| --- | --- | --- | --- |
| Light | Local, understood, reversible; one owner; no contract or visual-language change | Direct implementation, a short acceptance note, focused tests | Changed behavior and the smallest relevant verifier |
| Standard | User-visible or cross-layer behavior; moderate ambiguity; several consumers | One bounded Better Plan Node, acceptance card, optional diagnostic contract, focused reviewer | Success path, material failures, focused regression, changed rendering when relevant |
| Deep | Security, protocol, data, ownership, package, irreversible migration, or a new visual direction | Explicit contract, alternatives, independent review, migration inventory, owner-specific workflow profile | End-to-end behavior, failure recovery, residue removal, independent audit, final owner reducer |

These are starting points, not eligibility rules. For example, a large but
mechanical rename can remain light or standard, while a five-line authorization
change can require deep treatment.

## Shape the closure

- One capability, one Better Plan Node, and one active integration candidate is
  the normal coordination default. Combine tightly coupled work when separate
  closures would be untestable or leave a misleading intermediate state.
- Keep a release spine from user entry to canonical execution, result or durable
  state, recovery, and audit. The spine may be shorter when some stages genuinely
  do not exist.
- Freeze only unrelated scope. Admit discoveries that are necessary to make the
  selected outcome truthful; defer optional improvements explicitly.
- Use Better Plan as lifecycle memory, not as a substitute for engineering
  judgment. Repair structural drift only when it affects the selected work.
- Ask the user when alternatives change product scope, brand direction,
  compatibility promises, cost, or irreversible behavior. Resolve ordinary
  implementation tradeoffs autonomously and state the rationale.

Read `references/delivery-closure-contract.md` when acceptance is ambiguous,
the change is standard or deep, delivery has already cycled through rework, or a
reviewer needs a shared decision frame. Use only the sections that reduce real
uncertainty.

## Protect functional truth

For each material behavior, identify the real actor and goal, truthful
preconditions, action, canonical result, visible projection, material failures,
recovery, and proof. A short note is enough when these are obvious. Use a full
acceptance card and independent review when uncertainty or consequence is high.

Do not silently weaken a user-visible outcome. Escalate a compromise when it
changes scope, hides a reachable defect, retains an unintended compatibility
path, or changes an irreversible promise. Otherwise choose the soundest local
tradeoff and continue.

## Close without looping

After focused verification, classify every remaining finding exactly once:

- **repair now** when it contradicts the selected outcome or a hard constraint;
- **reframe** when evidence shows that the closure boundary was wrong;
- **defer** when it is real but outside the accepted outcome;
- **external block** only when an objective dependency or missing authority
  prevents meaningful progress.

An unchanged finding must not trigger the same reviewer-executor cycle again.
After one failed repair attempt, change the approach, narrow the claim, collect
new evidence, or escalate the concrete decision. Do not call ordinary
uncertainty, optional polish, or a conservative tool advisory a blocker.

Close when the accepted outcome is implemented, its material risks are covered
with proportionate evidence, and no hard constraint is violated. Completeness
means reasonable assurance for the selected outcome, not proof that the entire
project is perfect.

## Golden rules: strong defaults

1. Latest user intent, current source, and executable behavior outrank process history.
2. Choose the smallest truthful closure, not mechanically the smallest diff.
3. Match ceremony and evidence to consequence, uncertainty, coupling, and reversibility.
4. Keep one canonical owner for each product fact and derive projections from it.
5. Prove the real success path and material failures without losing user input.
6. Reuse one coherent visual system; explore alternatives only where a decision is genuinely open.
7. Prefer focused verification during implementation and one owner-wide regression at final integration.
8. Permit documented deviation from any heuristic when another route better protects the outcome.

## Red lines: hard constraints

- Never lower or reinterpret an explicit user outcome merely to make the current implementation pass.
- Never present mocks, templates, defaults, stale values, cached labels, or fixtures as real configuration or successful execution.
- Never hide a reachable backend defect behind a disabled control, speculative readiness gate, or generic unavailable state.
- Never collapse a typed material failure into a misleading generic status or discard user input on failure.
- Never use screenshots, rendering, route navigation, or prose as proof of functional execution.
- Never discard, reset, or absorb unrelated work without authority.
- Never leave an old implementation, fallback, alias, compatibility format, test, or document after claiming its migration is complete.
- Never repeatedly run broad regression while bounded implementation is still changing.
- Never publish planning artifacts, raw evidence, runtime data, credentials, machine identity, personal data, or private paths.
- Never declare readiness from stale, partial, skipped, fabricated, or cross-owner evidence.

## Boundaries

Use `$meshrix-js-architecture-reassembly` for source splits, package or
ownership moves, protocol boundaries, and composition-root changes. Use
`$meshrix-js-frontend-visual-direction` for new visual languages or material
workflow resets. Use `$meshrix-js-migration-completion` when a selected closure
actually replaces a source, route, schema, name, or owner.
