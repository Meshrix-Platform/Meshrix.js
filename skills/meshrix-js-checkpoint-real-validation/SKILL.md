---
name: meshrix-js-checkpoint-real-validation
description: >-
  Design, implement, or run the Meshrix.js checkpoint-based Agent real-user
  validation workflow: one Rider uses a qualified real-surface driver to
  complete one continuous journey, records semantic checkpoint receipts, and
  hands a frozen failure to a clean-context Mechanic before a full candidate
  rerun. Meshrix.js Web Console routes use stable component targets in a real
  browser. Use for Agent-operated UI validation, not test-case matrices, unit
  tests, CI, functional acceptance, or environment qualification.
---

# Meshrix.js Checkpoint Real Validation

This skill owns the Agent-operated validation loop for one continuous Meshrix.js user journey. Checkpoints are semantic milestones inside that journey, not independent test cases. A journey passes only when one candidate completes every required checkpoint, in order, within one attempt.

It does not replace `$meshrix-js-platform-acceptance-workflow`, the automated `$meshrix-js-release-journey-producer`, or the environment-support claim owned by `$meshrix-js-real-machine-verification`.

## Load only the relevant references

- Read [references/protocol.md](references/protocol.md) when designing a route, running it, or classifying a stop.
- Read [references/web-surface-driver.md](references/web-surface-driver.md) when defining, implementing, qualifying, or using the default Meshrix.js Web Console driver.
- Also read [references/contracts.md](references/contracts.md) when defining persisted artifacts, Agent packets, or the deterministic reducer.
- Also read [references/implementation-blueprint.md](references/implementation-blueprint.md) when building or restructuring the runner.
- Read [references/meshrix-example.md](references/meshrix-example.md) for the initial Meshrix.js route or a concrete worked example.

Do not load every reference for an unrelated narrow task.

## Non-negotiable contract

1. One route expresses one user role, one business intent, one continuous state chain, and one final user value. Do not add side quests for coverage.
2. Each attempt has exactly one fresh Rider context. The Rider sees the route, observations returned by its qualified Surface Driver, and the current attempt only; it never sees source, repair details, historical hypotheses, or Mechanic conclusions.
3. Meshrix.js Console operations use a real browser and a qualified Web Surface Driver. The driver resolves one stable product-owned component or accessible semantic target and proves that it is visible. For an input action it also proves actionability, emits a real browser input event, and observes the resulting visible state. DOM inspection for target resolution is allowed; DOM mutation, application-internal calls, direct database writes, internal APIs, forced actionability bypasses, mocks, and simulators cannot establish a real-user pass.
4. The Rider records only predefined semantic checkpoints. Each receipt contains the declared surface, resolved component target, observable result, and privacy-safe evidence, never a source-code diagnosis.
5. A `product_bug`, `stuck`, or unsafe unknown freezes the current attempt immediately. Do not repair in flight, skip a checkpoint, or retry blindly.
6. A product failure goes to a new clean-context Mechanic. The Mechanic receives only the redacted Failure Packet, the route, and the authorized source scope; it does not receive the Rider's long transcript or prior diagnosis.
7. A product-code, runtime-configuration, build, or deployment change creates a new `candidate_id`. A route or expectation change creates a new `route_version`. Either change invalidates every earlier receipt.
8. After repair, start a new attempt with a new Rider at the route origin. Never combine green checkpoints from different attempts or candidates.
9. A deterministic Reducer computes the result. It accepts only one ordered, identity-consistent, evidence-complete attempt with no unresolved state.
10. Routes, evidence, packets, and reports must not contain secrets, personal identity, machine details, private paths, or backend runtime data. Hand credentials, authorization, and high-risk side effects to the user at the point of action.

## Deliverables

For route design, provide the persona, intent, starting state, ordered checkpoints, final value, authority handoffs, and stop policy. Do not expand the result into a test inventory.

For a run, produce one attempt ledger plus checkpoint receipts, a Failure Packet, or the final reducer result. If the real UI was not operated, do not claim a pass.

For implementation, build the smallest closed loop first: route loader, sequential state machine, provider-neutral Rider adapter, qualified Web Surface Driver, evidence recorder, failure handoff, Mechanic isolation, candidate transition, deterministic Reducer, and one-route HTML report. Computer Use is only an optional Surface Driver for a declared non-web boundary. Do not begin with a test-management platform, broad database, or coverage system.
