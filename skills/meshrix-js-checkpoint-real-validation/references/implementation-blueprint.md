# Minimum Implementation Blueprint

## 1. Initial product shape

Build a local, single-route, sequential runner first. Prefer TypeScript and Node.js for the core state machine and reporter. Drive Meshrix.js Console through a provider-neutral Web Surface Driver operating the published page in a real browser. The implementation stack may change; the route, driver, evidence, and context-isolation contracts may not.

A browser-control framework may implement the Web Surface Driver. DOM and accessibility inspection are allowed for component resolution and visible-state observation. DOM mutation, application-internal calls, direct API shortcuts, forced clicks, fixtures, and reconstructed pages cannot establish the real-user claim. Unit tests and a fake adapter may verify the runner itself, but their output can never mark Meshrix.js as having passed a real route.

## 2. Module boundaries

```text
route-loader       read and validate the Route
run-coordinator    sequential state machine, handoffs, and Agent lifecycle
rider-adapter      start a clean Rider and expose qualified Surface tools
web-surface-driver resolve stable components and drive the real browser
native-driver      optional adapter for a declared non-web route segment
evidence-store     persist redacted screenshots and relative references
failure-broker     freeze the Attempt and create a Failure Packet
mechanic-adapter   start a clean Mechanic with bounded input and authority
candidate-manager  register Candidate transitions and invalidate old Attempts
reducer            deterministically compute one Attempt result
html-reporter      render separate Attempt tracks, evidence, failure, and repair
```

Keep the core provider-neutral. Rider and Mechanic adapters translate protocol packets into the current Agent platform's task calls. Surface Drivers expose the same logical operations through MCP, JSON-RPC, stdio, or another bounded tool transport; no Agent brand appears in the Route schema.

## 3. State machine

```text
draft -> ready -> riding -> completed -> passed
                     |  \
                     |   -> blocked
                     -> frozen -> repairing -> candidate_changed -> ready
```

- Before `ready`, perform preflight only and emit no Receipt.
- During `riding`, accept only the next expected checkpoint.
- After `frozen`, reject ordinary Receipts.
- After `candidate_changed`, create a new Attempt; never return the old Attempt to `riding`.
- Only the Reducer writes `passed`.

## 4. Agent lifecycle

- Create one fresh Rider for every Attempt and retain it only for that Attempt's continuous UI state.
- Permit any Agent to be the Rider when it can call the bound qualified Surface Driver and interpret its bounded results. Built-in Computer Use is not a prerequisite.
- Create one fresh Mechanic for every repair cycle. Do not inject an earlier Mechanic conclusion as fact.
- Rider and Mechanic never message each other. Every transfer crosses the Orchestrator through a structured, redacted packet.
- The Orchestrator may retain global history but must not leak it into isolated role contexts.

## 5. Storage and scheduling

The first implementation uses Route YAML, Surface qualification JSON, Attempt JSON, event JSONL, screenshot files, and static HTML. Run one Route sequentially so multiple Agents cannot race on the same browser, account, or business object.

Consider cross-route concurrency only after independent Routes share no account, window, data, or side effect. Do not start with a queue platform or database.

Append events and register explicit version labels. Do not repeatedly hash the repository, screenshots, or environment; the build and deployment boundary declares the Candidate.

## 6. Web component contract

Meshrix.js owns stable semantic component identifiers at route landmarks and actions. Prefer `data-meshrix-id`, then accessible role and name, associated label, and exact visible text. Do not bind Routes to generated classes, DOM ancestry, coordinates, or localized copy when a stable identifier exists.

For every action, the Web Surface Driver performs one deterministic cycle:

```text
confirm declared origin
resolve exactly one target
prove visible
for input: prove enabled + hit-testable, then emit normal browser input
observe fresh expected component state
capture privacy-safe checkpoint evidence
```

Use [web-surface-driver.md](web-surface-driver.md) as the complete driver contract.

## 7. Side-effect safety

Compile each checkpoint with one side-effect level:

- `none`: continue normally.
- `reversible`: still freeze on failure; the Orchestrator decides cleanup or a new Attempt.
- `committing`: confirm authority before execution and never retry an uncertain result.

API Key issuance, payment, deletion, publication, external communication, and production restart require the platform's confirmation mechanism or a user handoff at the action boundary. The user enters secrets; the Rider never records them.

## 8. Minimum HTML report

- Show Route, Route version, current Candidate, and Reducer result at the top.
- Render each Attempt as a separate route with ordered checkpoints.
- Use only `pass`, `product_bug`, `stuck`, and `blocked` for checkpoint state.
- Link a failed checkpoint to its Failure Packet and Repair Result.
- Show the declared Surface, stable component target, resolution method, and actionability result without embedding raw DOM or browser state.
- Open a new visual route for every Candidate; never extend an old green track.
- Hide sensitive source evidence by default and let the user open local evidence deliberately.
- Label the output as a scoped real-user journey report, not the release manual owned by `$meshrix-js-html-report-contract`.

## 9. Delivery order

1. Fix the Route, Receipt, Failure Packet, and Repair Result contracts.
2. Implement the Reducer and state machine; verify identity, order, freeze, and invalidation with small in-memory cases.
3. Implement the Web Surface Driver contract, stable component target resolution, and driver qualification.
4. Implement file storage and the HTML report.
5. Connect one provider-neutral Rider through the driver tool transport and run one non-destructive real-browser route segment.
6. Add the Failure Broker, clean Mechanic, and Candidate transition.
7. Add an optional native Surface Driver only if the selected Route contains a non-web boundary.
8. Run the complete Meshrix.js golden route once after focused checks pass.

Use focused verification while implementing. Run the complete repository regression once only after every module is implemented and its focused checks pass.

## 10. Runner acceptance

The runner is complete only when these behaviors are observable:

- a Rider follows one Route and records semantic receipts;
- the same Route can run through any Agent adapter that supplies the qualified Web Surface Driver tool contract;
- the driver resolves one stable visible component, enforces actionability, emits real browser input, and observes fresh visible state;
- the Reducer rejects wrong order, mixed identity, and missing evidence;
- a failure freezes the Attempt immediately;
- a Mechanic receives a clean context and minimum redacted packet;
- a product change creates a new Candidate and Attempt;
- a new Rider starts from the origin;
- the report cannot combine green checkpoints across Candidates; and
- one complete new Attempt must pass before the runner emits the scoped success result.
