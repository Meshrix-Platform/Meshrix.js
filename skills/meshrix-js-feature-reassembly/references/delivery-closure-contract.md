# Delivery Closure Heuristics

Use this reference to reduce ambiguity inside the selected Better Plan
lifecycle. It is a menu, not a form that must be completed. Keep any working
artifact local and non-public; map durable facts into the Node's existing
fields instead of creating a second product authority.

## 1. Select only useful detail

Start with a one-sentence outcome and add detail only where it changes design,
implementation, verification, or scope. A light closure may need no artifact.
A standard closure usually needs the acceptance card. A deep closure may also
need the failure matrix, visual contract, migration inventory, and independent
review.

Useful boundary prompts:

- Who receives what observable value?
- Which repository and component own the decisive facts?
- What is deliberately outside this closure?
- Would splitting or combining work leave a truthful, independently testable state?
- What evidence would materially change the completion decision?

Broad titles such as "finish everything" or "make production ready" are a sign
to reframe, not an automatic rejection. Replace them with an observable outcome
when possible.

## 2. Functional acceptance card

Use the fields that expose uncertainty:

| Prompt | Useful content |
| --- | --- |
| Actor and goal | Real user or operator and the outcome they need |
| Preconditions | Real configuration, authorization, resources, and starting state |
| Action | User action and public API, protocol, or command it invokes |
| Canonical result | Executor, side effect, returned or persisted state, terminal status |
| Visible result | UI or client projection derived from that same result |
| Material failures | Stable failure meaning, retryability, recovery, and preserved input |
| Proof | Smallest verifier and privacy-safe evidence that support the claim |
| Non-goals | Explicitly deferred outcomes and adjacent findings |

Do not enumerate every theoretical failure. Build a failure matrix only for
stages whose failure is reachable and material to the user or system:

| Stage | Injected condition | Stable meaning | Retryable | Recovery | Input state | Proof |
| --- | --- | --- | --- | --- | --- | --- |
| Example material stage | Synthetic failure | Specific code or typed result | yes/no | Explicit action | preserved/unchanged | Focused assertion |

## 3. Visual decision frame

Use this section for a new visual language, an unresolved product direction, or
a material workflow reset. For ordinary UI changes, point to the existing
approved system and continue.

Consider:

- representative roles such as shell, primary task, and dense failure state;
- whether one clear direction is enough or alternatives would expose a real decision;
- who owns the choice: the user for brand or product-intent changes, the agent for ordinary design tradeoffs;
- shared typography, density, grid, semantic colors, controls, motion, responsive widths, and accessibility;
- empty, loading, denied, conflict, failure, retry, partial-result, and success states that are actually reachable;
- the smallest visual comparison that proves consistency.

A screenshot may support a visual claim but never a functional claim.

## 4. Better Plan mapping

Use Better Plan as lifecycle memory:

- put the outcome, boundaries, canonical owners, meaningful constraints,
  non-goals, and migration obligations in `description`;
- give each acceptance criterion one observable claim and a proportionate proof source;
- put only focused proof in implementation-node regression commands;
- keep owner-wide or repository-wide validation in the final integration lifecycle;
- keep Evidence for redacted provenance and Architecture for durable ownership or interface decisions.

One capability per Node is a good default. Combine inseparable work when separate
Nodes would be untestable or would preserve a knowingly false intermediate
state. Split a Node when outcomes can be accepted independently and doing so
reduces integration risk.

## 5. Review and evidence depth

Choose review effort from risk rather than stage names:

- **Light:** self-review plus a focused test is usually sufficient.
- **Standard:** consider a fresh acceptance review when criteria are ambiguous,
  compromises have recurred, or several layers must agree.
- **Deep:** use independent acceptance review and a thin final audit for
  authorization, protocol, data, ownership, irreversible migration, or an
  expensive visual-direction decision.

A review finding is advice until it identifies a hard constraint, a contradiction
with the accepted outcome, or objective evidence that the claim is false. The
executor may resolve ordinary tradeoffs without returning to the user. Escalate
only decisions that change product scope, compatibility promises, irreversible
behavior, cost, or brand direction.

## 6. Closure and anti-loop rule

Before closing, ask:

- Does the current implementation satisfy the accepted observable outcome?
- Are material success and failure paths covered with proportionate evidence?
- Does any remaining finding violate a hard constraint or make the claim false?
- Are deferred findings clearly outside the selected outcome?

Classify each finding as repair, reframe, defer, or external block. The same
unchanged finding cannot send the work through the same lifecycle twice. A new
cycle requires new evidence, a changed implementation approach, or a changed
claim. Incomplete optional sections, missing ceremony, or a conservative
diagnostic advisory do not prevent closure.
