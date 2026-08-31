# Checkpoint Real-User Validation Protocol

## 1. Purpose

The validation unit is one real user completing one real goal, not a feature count. A route must fit one sentence:

> A named persona starts from a declared real-system state, crosses the required business-state transitions, and obtains an observable final value.

Checkpoints prove that the journey crossed meaningful states. They are not independent cases and do not reset the environment.

## 2. Core objects

- **Route**: the stable persona, intent, origin, destination, and ordered checkpoints.
- **Surface**: a declared user-facing product boundary and its qualified driver profile. Meshrix.js Console uses a real-browser `web-component` Surface by default.
- **Surface Driver**: the provider-neutral tool boundary that resolves declared components, emits real user-interface input, and returns bounded observations.
- **Candidate**: the product build, runtime configuration, and deployment combination under validation. Use an explicit label; content hashing is unnecessary.
- **Attempt**: one Rider's complete departure against one Route version and one Candidate.
- **Checkpoint**: a business milestone inside the journey, not a button-level step.
- **Receipt**: the Rider's observable checkpoint fact and evidence reference.
- **Failure Packet**: the minimum redacted facts preserved when an Attempt freezes.
- **Repair Result**: the Mechanic's evidence-backed classification, repair scope, risk, and candidate transition.
- **Reducer**: deterministic code that scans one Attempt and computes its result.

## 3. Role boundaries

### Orchestrator

The Orchestrator holds global state. It compiles the Route, performs preflight, creates isolated Agent contexts, freezes Attempts, coordinates authority handoffs, registers Candidate transitions, and invokes the Reducer. It does not click for the Rider or waive Reducer failures.

### Rider Agent

- Start one fresh Rider for each Attempt and use exactly one Rider during that Attempt.
- Give it only the Route Packet, Surface Driver tools, starting observation, and current Attempt identity.
- Operate Meshrix.js Console through the qualified Web Surface Driver and the normal user-visible path. The Rider may be any Agent capable of calling that driver; built-in Computer Use is not required.
- Allow the natural sequence of UI actions needed to reach the next checkpoint, but no side exploration.
- At a checkpoint, record the declared Surface, resolved component, visible result, and evidence without diagnosing source code.
- Use DOM or accessibility inspection only to resolve and observe product-owned components. Never mutate DOM or application state, call internal APIs or component methods, force actionability, write the database, or substitute a mock surface.

### Surface Driver

- Bind each Route Surface to a qualified driver profile before the Attempt starts.
- Resolve one declared stable component target and verify uniqueness and visibility. For an input action, also verify actionability, emit the normal input event, and re-observe fresh visible state.
- Return structured facts to the Rider; do not make journey or source-code judgments.
- Use [web-surface-driver.md](web-surface-driver.md) for the default Meshrix.js Console contract.
- A native driver, including Computer Use, is allowed only for an explicitly declared non-web segment such as a system file dialog or native external client.

### Mechanic Agent

- Start a new clean context for each repair cycle so Rider hypotheses and earlier diagnoses cannot anchor it.
- Give it only the Failure Packet, the applicable Route, and the source scope it is authorized to inspect.
- First classify the cause as product, route, or environment and support the conclusion with repository evidence.
- If the current task authorizes source changes, implement the smallest complete repair; otherwise return a Repair Result for an authorized executor.
- Never change an earlier Receipt, retroactively mark a failure as passed, or weaken expectations to hide a product defect.
- A product repair creates a new Candidate. A route correction creates a new Route version.

### Reducer

The Reducer is not an Agent. It evaluates structured identity, order, state, and evidence. It never infers an approximate pass from prose.

### User / authority holder

The user owns credentials, account authorization, external approval, and irreversible or high-risk side effects. The Rider pauses at those boundaries and resumes observation only after the user completes the protected action.

## 4. Route design

Write these four statements before adding checkpoints:

1. **Persona**: who is using the system.
2. **Intent**: what that persona is trying to accomplish.
3. **Start**: the exact screen, account state, and real dependencies at departure.
4. **Value**: the observable artifact or outcome the user must obtain.

Add checkpoints only where they prove a meaningful transition:

- an identity, organization, or authorization boundary has been established;
- a key business object was created or changed state;
- the journey crossed the boundary before or after a protected side effect;
- a real external dependency produced a verifiable effect;
- the final artifact can be opened or consumed by the real client; or
- audit, restart continuity, or recovery is part of the route's declared value.

Clicks, navigation, and field entry are normally road segments, not checkpoints. Every checkpoint must answer: "Which meaningful new state has the user or system reached?"

For every Web Console road segment, declare the Surface, target component, operation, and visible expectation. Prefer a stable product-owned `data-meshrix-id`, then accessible role and name, form label, and exact visible text. A target must resolve to exactly one visible and actionable component. Do not encode coordinates, generated CSS classes, DOM ancestry, or translated text when a stable component identifier exists.

## 5. Preflight

Preflight decides whether the Attempt may start. It is not journey evidence:

- Candidate, Route version, and a non-sensitive environment label are registered.
- Every declared Surface is bound to a qualified driver profile; the Meshrix.js Console binding controls a real browser at the declared origin.
- The real Meshrix.js page, real client, real dependency, and privacy-safe sample are ready.
- The visible starting state matches the Route.
- Credential and authorization handoff points are declared.
- Side-effecting actions and their repeat behavior are declared.
- The evidence destination is writable and cannot capture secrets or personal data.

A failed preflight remains `not_started` and must not emit checkpoint Receipts.

## 6. One ride

1. The Orchestrator creates an Attempt and a new Rider context.
2. The Rider uses the bound driver to confirm the declared origin and starting component, then follows the single Route.
3. For each web operation, the driver resolves one target and proves visibility. For an input action, it also proves actionability and emits a real browser input event. It then observes the declared result from fresh state.
4. At each checkpoint, the Rider submits one Receipt containing driver facts and evidence; the Orchestrator verifies that it matches the next expected checkpoint.
5. A `pass` Receipt advances the cursor.
6. Any other status freezes or blocks the Attempt. No later ordinary pass Receipt may be appended.
7. After every required checkpoint passes, the Reducer computes the Attempt result.
8. Only a Reducer pass authorizes the scoped journey claim and final HTML report.

## 7. Stop statuses

| Status | Meaning | Action |
| --- | --- | --- |
| `pass` | The expected business state is visible and evidence is sufficient. | Continue to the next checkpoint. |
| `product_bug` | Product behavior clearly contradicts the Route expectation. | Freeze, create a Failure Packet, and start a clean Mechanic. |
| `stuck` | The Rider cannot classify product failure versus route or operation ambiguity, including a component target that resolves more than once. | Freeze and ask the Orchestrator or user to classify; do not guess a repair. |
| `blocked` | Credential, authority, qualified Surface Driver, browser origin, real dependency, or starting state is missing. | Pause for the responsible authority; do not consume a repair cycle. |

Treat an unknown committed side effect, possible duplicate transaction, or security warning as `blocked` and hand it to the user immediately. Never retry automatically.

## 8. Repair and departure again

For a product failure:

1. Freeze the Attempt and preserve only privacy-safe evidence for the last pass and the failing checkpoint.
2. Give a new Mechanic only the Failure Packet, Route, and authorized source scope.
3. The Mechanic diagnoses and completes the authorized minimal repair, then returns a Repair Result.
4. Register a new Candidate and close the old Attempt. Its Receipts remain historical but have no acceptance value.
5. Create a new Attempt and fresh Rider at the first checkpoint.

If the Route was wrong, do not pretend the product was repaired. Increment `route_version` and start a new Attempt.

After a purely external block is removed, resume at the current checkpoint only when Candidate, Route, environment identity, and all committed side effects are unchanged and the Route explicitly allows resumption. Otherwise depart again from the origin.

Declare a repair-cycle budget. Three cycles is the default recommendation. When the budget is exhausted, stop and report the established cause and remaining risk for user decision. Do not replace explicit state with an arbitrary time timeout.

## 9. Deterministic pass rule

The Reducer returns `pass` only when all conditions hold:

- every Receipt has the same `attempt_id`, `candidate_id`, `route_id`, and `route_version`;
- every required checkpoint appears exactly once and in Route order;
- every Receipt names a declared Surface, qualified driver profile, and Route-matching component target;
- every web action records one unique actionable component and a satisfied fresh-state expectation;
- every required Receipt is `pass` and contains its required evidence reference;
- the Attempt was not frozen, blocked, or left uncertain;
- no checkpoint was skipped and no Receipt came from another Attempt; and
- the final checkpoint proves the Route's declared user value.

Do not use majority votes, pass percentages, or accumulated progress from old Candidates.

## 10. Privacy, evidence, and authority

- Default evidence is one post-checkpoint UI screenshot plus the declared Surface, stable target identity, resolution method, actionability result, and short visible observation. Do not retain every pointer action.
- Pause capture before credential entry and let the user complete it. Resume only on a non-sensitive authenticated state.
- Use repository-relative or opaque references. Do not retain machine paths, account identity, tokens, cookies, or backend runtime data.
- Do not persist raw DOM snapshots, full accessibility trees, browser profiles, or request payloads as evidence.
- A Failure Packet records action, expectation, and observation only. It excludes the Rider's code hypotheses.
- Local diagnostic logs do not enter packets or final reports. If separately authorized, retain only a minimum redacted local reference.
- Mark payment, deletion, publication, external communication, restart, and other production changes in the Route and obtain confirmation at the action boundary.

## 11. Reporting

Render each Attempt separately with its Candidate, Route version, terminal state, ordered checkpoint track, evidence entry points, failure, and linked Repair Result.

Never draw old green checkpoints into a new Candidate's route. The overall status is only the latest valid Attempt's Reducer result and remains a scoped real-user-journey claim, not functional completeness, release readiness, or environment qualification.
