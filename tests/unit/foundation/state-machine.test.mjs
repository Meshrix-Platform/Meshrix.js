#!/usr/bin/env node
/**
 * State Machine Engine -- Unit Tests
 *
 * Tests:
 *   1. valid transition executes
 *   2. invalid transition rejected
 *   3. guard false blocks transition
 *   4. action output recorded
 *   5. replay deterministic
 *   6. history tamper detected
 *   7. invariant failure reported
 *   8. docs export generates valid metadata
 *   9. operation narrow lifecycle definition loads
 *  10. public definition helpers execute
 *  11. replay rejects incomplete state and evidence
 *  12. sequence verification enforces guards
 *
 * Run: node tests/unit/foundation/state-machine.test.mjs
 */

import { createStateMachine, listBuiltinDefinitions, validateDefinition, validateStateMachineDefinition, validateExecutableStateMachineDefinition } from "../../../packages/foundation/src/workflow/state-machine/index.mjs";
import { transition } from "../../../packages/foundation/src/workflow/state-machine/transition.mjs";
import { replayTransitions, detectTampering, verifyTransitionSequence } from "../../../packages/foundation/src/workflow/state-machine/replay.mjs";
import { assertInvariants } from "../../../packages/foundation/src/workflow/state-machine/invariants.mjs";
import { exportStateMachineDocs } from "../../../packages/foundation/src/workflow/state-machine/export-docs.mjs";
import { resolveDefinition, loadDefinition } from "../../../packages/foundation/src/workflow/state-machine/definition.mjs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Simple test definition ─────────────────────────────────────────

const SIMPLE_MACHINE = {
  machineId: "test.simple-flow",
  entityType: "test_entity",
  version: "fixture.lifecycle.1",
  description: "Simple test flow",
  initialState: "open",
  states: [
    { id: "open" },
    { id: "processing" },
    { id: "closed", terminal: true },
  ],
  events: [
    { id: "test.start", riskLevel: "low" },
    { id: "test.complete", riskLevel: "low" },
    { id: "test.close", riskLevel: "low" },
  ],
  totalMatrix: [
    { from: "open", event: "test.start", result: "legal_transition", to: "processing" },
    { from: "open", event: "test.complete", result: "illegal_transition", errorCode: "TEST_INVALID_FROM_OPEN" },
    { from: "open", event: "test.close", result: "legal_transition", to: "closed" },
    { from: "processing", event: "test.start", result: "ignored_idempotent_event" },
    { from: "processing", event: "test.complete", result: "legal_transition", to: "closed" },
    { from: "processing", event: "test.close", result: "legal_transition", to: "closed" },
    { from: "closed", event: "test.start", result: "illegal_transition", errorCode: "TEST_CLOSED_TERMINAL" },
    { from: "closed", event: "test.complete", result: "illegal_transition", errorCode: "TEST_CLOSED_TERMINAL" },
    { from: "closed", event: "test.close", result: "ignored_idempotent_event" },
  ],
  invariants: ["SM-TEST-001", "SM-TEST-002"],
  proofObligations: ["PO-TEST-001"],
};

const GUARDED_MACHINE = {
  machineId: "test.guarded-flow",
  entityType: "test_entity",
  version: "fixture.guarded-lifecycle.1",
  description: "Flow with guards",
  initialState: "pending",
  states: [
    { id: "pending" },
    { id: "approved" },
    { id: "rejected", terminal: true },
  ],
  events: [
    { id: "test.approve", riskLevel: "low" },
    { id: "test.reject", riskLevel: "low" },
    { id: "test.rerun", riskLevel: "low" },
  ],
  totalMatrix: [
    { from: "pending", event: "test.approve", result: "legal_transition", to: "approved" },
    { from: "pending", event: "test.reject", result: "legal_transition", to: "rejected" },
    { from: "pending", event: "test.rerun", result: "legal_transition", to: "pending" },
    { from: "approved", event: "test.approve", result: "ignored_idempotent_event" },
    { from: "approved", event: "test.reject", result: "legal_transition", to: "rejected" },
    { from: "approved", event: "test.rerun", result: "legal_transition", to: "pending", guards: ["require_admin"] },
    { from: "rejected", event: "test.approve", result: "illegal_transition", errorCode: "TEST_REJECTED" },
    { from: "rejected", event: "test.reject", result: "ignored_idempotent_event" },
    { from: "rejected", event: "test.rerun", result: "illegal_transition", errorCode: "TEST_REJECTED" },
  ],
  invariants: [],
  proofObligations: [],
};

// ── Helpers ────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function assert(condition, label) {
  if (condition) { passCount++; console.log(`  PASS: ${label}`); }
  else { failCount++; console.error(`  FAIL: ${label}`); }
}

function assertStrictEqual(actual, expected, label) {
  const ok = actual === expected;
  if (ok) { passCount++; console.log(`  PASS: ${label}`); }
  else { failCount++; console.error(`  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// ── Test 1: Valid transition executes ─────────────────────────────

function testValidTransitionExecutes() {
  console.log("\n[Test 1] Valid transition executes");

  const machine = createStateMachine(SIMPLE_MACHINE);

  // Transition from open to processing via test.start
  const state = { entityId: "entity-1", currentStatus: "open" };
  const result = machine.transition(state, "test.start");

  assert(result.ok === true, "valid transition returns ok");
  assert(result.fromStatus === "open", "transition from open");
  assert(result.toStatus === "processing", "transition to processing");
  assert(result.eventType === "test.start", "event type recorded");
  assert(result.machineId === "test.simple-flow", "machineId set");
  assert(result.entityId === "entity-1", "entityId preserved");
  assert(result.transitionRecord !== undefined, "transition record created");
  assert(result.transitionRecord.fromStatus === "open", "record shows from");
  assert(result.transitionRecord.toStatus === "processing", "record shows to");
  assert(result.transitionRecord.eventType === "test.start", "record shows event");
}

// ── Test 2: Invalid transition rejected ───────────────────────────

function testInvalidTransitionRejected() {
  console.log("\n[Test 2] Invalid transition rejected");

  const machine = createStateMachine(SIMPLE_MACHINE);

  // Trying to complete from open should be illegal
  const state = { entityId: "entity-2", currentStatus: "open" };
  const result = machine.transition(state, "test.complete");

  assert(result.ok === false, "invalid transition returns ok=false");
  assert(result.errorCode !== undefined, "error code provided");
  assert(result.message !== undefined, "error message provided");
  assert(result.allowedEvents !== undefined, "allowed events listed");
  assert(Array.isArray(result.allowedEvents), "allowedEvents is array");
  assert(result.allowedEvents.includes("test.start"), "test.start is allowed from open");
  assert(result.allowedEvents.includes("test.close"), "test.close is allowed from open");
  assert(!result.allowedEvents.includes("test.complete"), "test.complete is NOT allowed from open");
}

// ── Test 3: Guard false blocks transition ─────────────────────────

function testGuardFalseBlocksTransition() {
  console.log("\n[Test 3] Guard false blocks transition");

  const machine = createStateMachine(GUARDED_MACHINE);

  // Transition from approved to pending via test.rerun with guard require_admin
  // Without admin context, this should fail depending on how the guard evaluator handles it
  const state = { entityId: "entity-3", currentStatus: "approved" };

  // The guard require_admin requires subjectPermissions context
  // Without it, the guard evaluator in guard-evaluator.mjs should return missing_context
  const result = machine.transition(state, "test.rerun");

  // The result depends on whether the engine considers guards as blocking or just advisory
  // In our simple transition wrapper, we delegate to the core engine which evaluates guards
  // and returns ok=false if guards are not satisfied
  const resultWithAdmin = machine.transition(state, "test.rerun", {
    actor: "admin-user",
    guardContext: {
      subjectPermissions: { admin: true, roles: ["admin"] },
    },
  });

  // Without proper guard context, the transition should be blocked
  assert(result.ok === false || result.errorCode !== undefined,
    "transition without guard context is blocked");

  // With admin context it should succeed
  assert(resultWithAdmin.ok === true || resultWithAdmin.toStatus === "pending",
    "transition with admin guard context can proceed");
}

// ── Test 4: Action output recorded ────────────────────────────────

function testActionOutputRecorded() {
  console.log("\n[Test 4] Action output recorded");

  const machine = createStateMachine(SIMPLE_MACHINE);

  const state = { entityId: "entity-4", currentStatus: "open" };
  const result = machine.transition(state, "test.start", {
    actor: "test-user",
    reason: "testing transition recording",
    metadata: { customField: "custom-value" },
    operationId: "op-12345",
    traceId: "trace-abc",
  });

  assert(result.ok === true, "transition succeeds");
  assert(result.transitionRecord.actor === "test-user", "transition record captures actor");
  assert(result.transitionRecord.reason === "testing transition recording", "transition record captures reason");
  assert(result.transitionRecord.operationId === "op-12345", "transition record captures operationId");
  assert(result.transitionRecord.traceId === "trace-abc", "transition record captures traceId");
  assert(result.transitionRecord.metadata !== undefined, "transition record has metadata");
}

// ── Test 5: Replay deterministic ──────────────────────────────────

function testReplayDeterministic() {
  console.log("\n[Test 5] Replay deterministic");

  const history = [
    { event: "test.start", context: { actor: "system", reason: "begin" } },
    { event: "test.complete", context: { actor: "system", reason: "finish" } },
  ];

  const result = replayTransitions({
    definition: SIMPLE_MACHINE,
    initialState: { entityId: "entity-5", currentStatus: "open" },
    history,
  });

  assert(result.ok === true, "replay succeeded");
  assert(result.states.length === 3, "3 states recorded (initial + 2 transitions)");
  assert(result.finalState.currentStatus === "closed", "replay ends in closed state");
  assert(result.errors.length === 0, "no errors during replay");

  // Verify state sequence
  assert(result.states[0].currentStatus === "open", "initial state is open");
  assert(result.states[1].currentStatus === "processing", "after first transition: processing");
  assert(result.states[2].currentStatus === "closed", "after second transition: closed");

  // Replay again -- should produce identical results
  const result2 = replayTransitions({
    definition: SIMPLE_MACHINE,
    initialState: { entityId: "entity-5", currentStatus: "open" },
    history,
  });

  assert(result2.ok === true, "second replay succeeded");
  assert(result2.finalState.currentStatus === result.finalState.currentStatus,
    "deterministic: both replays end in same state");
  assert(result2.states.length === result.states.length,
    "deterministic: both replays produce same number of states");
}

// ── Test 6: History tamper detected ───────────────────────────────

function testHistoryTamperDetected() {
  console.log("\n[Test 6] History tamper detected");

  // Build a clean hash-chained history with correct hashes
  function hashEntry(event, previousHash, context = {}) {
    const canonical = JSON.stringify({ event, previousHash, context });
    const hash = crypto.createHash("sha256").update(canonical).digest("hex");
    return { event, previousHash, context, hash };
  }

  const entry0 = hashEntry("test.start", "", { actor: "system" });
  const entry1 = hashEntry("test.complete", entry0.hash, { actor: "system" });

  const cleanHistory = [entry0, entry1];

  const cleanResult = detectTampering(SIMPLE_MACHINE, cleanHistory);
  assert(cleanResult.tampered === false, "clean history not tampered");
  assert(cleanResult.errors.length === 0, "no errors for clean history");

  // Tampered history (wrong previousHash)
  const tamperedHistory = [
    hashEntry("test.start", "", { actor: "system" }),
    { ...hashEntry("test.complete", entry0.hash, { actor: "system" }), previousHash: "0000000000000000000000000000000000000000000000000000000000000000" },
  ];

  const tamperResult = detectTampering(SIMPLE_MACHINE, tamperedHistory);
  assert(tamperResult.tampered === true, "tampered history detected");
  assert(tamperResult.errors.length > 0, "errors reported for tampered history");

  // Verify transition sequence
  const seqValid = verifyTransitionSequence(SIMPLE_MACHINE, [
    { event: "test.start" },
    { event: "test.complete" },
  ]);
  assert(seqValid.valid, "valid transition sequence verified");

  const seqInvalid = verifyTransitionSequence(SIMPLE_MACHINE, [
    { event: "test.complete" },
  ]);
  assert(!seqInvalid.valid, "invalid transition sequence fails verification");
}

// ── Test 7: Invariant failure reported ────────────────────────────

function testInvariantFailureReported() {
  console.log("\n[Test 7] Invariant failure reported");

  const machine = createStateMachine(SIMPLE_MACHINE);

  // No invariants should fail for simple flow
  const state = { entityId: "entity-7", currentStatus: "open" };
  const result = machine.checkInvariants({ state });

  assert(result.ok === true, "invariants pass for valid state");
  assert(Array.isArray(result.results), "invariants returns results array");

  // Check with an invalid state (not in machine)
  const invalidState = { entityId: "entity-7", currentStatus: "non_existent_state" };
  const invalidResult = machine.checkInvariants({ state: invalidState });
  assert(invalidResult.ok === false, "invalid state fails invariants");
  assert(invariantResultContainsStatus(invalidResult, "non_existent_state"),
    "error mentions the invalid state");

  const unsupported = assertInvariants({
    definition: { ...SIMPLE_MACHINE, invariants: ["MUST-ENFORCE-DOMAIN-RULE"] },
    state,
  });
  assert(unsupported.ok === false, "unknown invariant fails closed");
  assert(unsupported.errors.some((error) => error.includes("no registered evaluator")),
    "unknown invariant reports the missing evaluator");

  // Check terminal state invariant
  const badMachine = {
    ...SIMPLE_MACHINE,
    machineId: "test.bad-terminal",
    invariants: ["SM-TEST-002"], // Terminal state check
    states: [
      { id: "open" },
      { id: "closed", terminal: true },
    ],
    totalMatrix: [
      { from: "open", event: "test.start", result: "legal_transition", to: "closed" },
      { from: "closed", event: "test.start", result: "legal_transition", to: "open" }, // Terminal has outgoing
    ],
  };

  const badResult = assertInvariants({
    definition: badMachine,
    state: { currentStatus: "closed" },
  });
  assert(!badResult.ok, "terminal state with outgoing transitions fails invariant");
}

function invariantResultContainsStatus(result, status) {
  return result.errors.some(e => e.includes(status));
}

// ── Test 8: Docs export generates valid metadata ──────────────────

function testDocsExportGeneratesValidMetadata() {
  console.log("\n[Test 8] Docs export generates valid metadata");

  const docs = exportStateMachineDocs(SIMPLE_MACHINE);

  assert(docs.machineId === "test.simple-flow", "docs include machineId");
  assert(docs.initialState === "open", "docs include initialState");
  assert(docs.stateCount === 3, "docs include correct state count");
  assert(docs.eventCount === 3, "docs include correct event count");
  assert(docs.matrixCellCount === 9, "docs include correct matrix cell count");
  assert(docs.guardCount === 0, "docs include guard count (0)");
  assert(docs.invariantCount === 2, "docs include invariant count");
  assert(docs.proofObligationCount === 1, "docs include proof obligation count");
  assert(Array.isArray(docs.states), "docs includes states array");
  assert(Array.isArray(docs.events), "docs includes events array");
  assert(docs.transitionTable !== undefined, "docs includes transition table");
  assert(docs.stateDiagram !== undefined, "docs includes state diagram");
  assert(docs.generatedAt !== undefined, "docs includes generation timestamp");

  // Verify state docs
  const openState = docs.states.find(s => s.id === "open");
  assert(openState !== undefined, "open state documented");
  assert(openState.isInitial === true, "open is marked as initial");
  assert(openState.outgoingEvents.length === 2, "open has 2 outgoing events");
  assert(openState.outgoingEvents.includes("test.start"), "open allows test.start");
  assert(openState.outgoingEvents.includes("test.close"), "open allows test.close");

  const closedState = docs.states.find(s => s.id === "closed");
  assert(closedState !== undefined, "closed state documented");
  assert(closedState.isTerminal === true, "closed is marked as terminal");

  // Verify state diagram
  assert(docs.stateDiagram.initialState === "open", "state diagram shows initial state");
  assert(docs.stateDiagram.terminalStates.includes("closed"), "state diagram lists terminal states");
  assert(docs.stateDiagram.edgeCount > 0, "state diagram has edges");

  // Guarded machine docs
  const guardedDocs = exportStateMachineDocs(GUARDED_MACHINE);
  assert(guardedDocs.guardCount === 1, "guarded machine detects 1 unique guard");
  assert(guardedDocs.matrixCellCount === 9, "guarded machine matrix cell count correct");
}

// ── Test 9: Operation narrow lifecycle definition loads ─

async function testOperationNarrowDefinitionLoads() {
  console.log("\n[Test 9] Operation narrow lifecycle definition loads");

  const defPath = resolve(
    __dirname,
    "../../../packages/foundation/src/workflow/state-machine/definitions/operation.narrow.json"
  );

  const definition = loadDefinition(defPath);

  assert(definition !== null, "definition loaded from file");
  assert(definition.machineId === "operation.narrow", "correct machineId");
  assert(definition.initialState === "received", "correct initialState");
  assert(Array.isArray(definition.states), "states is array");
  assert(definition.states.length === 10, "10 states in operation narrow lifecycle");
  assert(Array.isArray(definition.events), "events is array");
  assert(definition.events.length === 9, "9 events in operation narrow lifecycle");
  assert(Array.isArray(definition.totalMatrix), "totalMatrix is array");

  // Validate the definition
  const validation = validateStateMachineDefinition(definition);
  assert(validation.ok === true, "operation narrow definition validates");

  // Create state machine from it
  const machine = createStateMachine(definition);
  assert(machine !== null, "state machine created from operation definition");
  assert(machine.machineId === "operation.narrow", "machine ID preserved");

  // Execute a valid transition
  const state = machine.initialState();
  assert(state.currentStatus === "received", "initial state is received");

  const result = machine.transition(state, "operation.normalize");
  assert(result.ok === true, "valid transition received -> normalized");
  assert(result.toStatus === "normalized", "transitioned to normalized");
}

function testPublicDefinitionHelpersExecute() {
  console.log("\n[Test 10] Public definition helpers execute");

  const definitions = listBuiltinDefinitions();
  assert(Array.isArray(definitions), "built-in definitions are listed");
  assert(definitions.includes("operation.narrow"), "operation narrow is discoverable");

  const valid = validateDefinition(SIMPLE_MACHINE);
  assert(valid.ok === true, "public validation accepts a valid definition");
  const invalid = validateDefinition({});
  assert(invalid.ok === false, "public validation rejects an invalid definition");
}

function testReplayRejectsIncompleteStateAndEvidence() {
  console.log("\n[Test 11] Replay rejects incomplete state and evidence");

  const missingState = replayTransitions({
    definition: SIMPLE_MACHINE,
    initialState: { entityId: "entity-missing-status" },
    history: [{ event: "test.start" }],
  });
  assert(missingState.ok === false, "replay rejects a missing current status");
  assert(missingState.errors[0]?.errorCode === "STATE_MACHINE_UNKNOWN_STATUS", "replay reports unknown status");

  const incompleteChain = detectTampering(SIMPLE_MACHINE, [
    { event: "test.start", context: { actor: "system" } },
  ]);
  assert(incompleteChain.tampered === true, "hashless history is not accepted as intact");
  assert(incompleteChain.verifiedCount === 0, "hashless history is not counted as verified");
}

function testSequenceVerificationEnforcesGuards() {
  console.log("\n[Test 12] Sequence verification enforces guards");

  const blocked = verifyTransitionSequence(GUARDED_MACHINE, [
    { event: "test.approve" },
    { event: "test.rerun" },
  ]);
  assert(blocked.valid === false, "guarded sequence is rejected without guard context");

  const allowed = verifyTransitionSequence(GUARDED_MACHINE, [
    { event: "test.approve" },
    {
      event: "test.rerun",
      context: { guardContext: { subjectPermissions: { admin: true, roles: ["admin"] } } },
    },
  ]);
  assert(allowed.valid === true, "guarded sequence succeeds with valid guard context");
  assert(allowed.stateSequence.at(-1) === "pending", "guarded sequence advances through the selected transition");
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("=== State Machine Unit Tests ===\n");

  testValidTransitionExecutes();
  testInvalidTransitionRejected();
  testGuardFalseBlocksTransition();
  testActionOutputRecorded();
  testReplayDeterministic();
  testHistoryTamperDetected();
  testInvariantFailureReported();
  testDocsExportGeneratesValidMetadata();
  await testOperationNarrowDefinitionLoads();
  testPublicDefinitionHelpersExecute();
  testReplayRejectsIncompleteStateAndEvidence();
  testSequenceVerificationEnforcesGuards();

  console.log(`\n--- Results: ${passCount} passed, ${failCount} failed ---\n`);

  if (failCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exitCode = 1;
});
