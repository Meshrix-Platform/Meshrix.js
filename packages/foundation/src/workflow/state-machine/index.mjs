import {
  validateStateMachineDefinition as coreValidate,
  validateExecutableStateMachineDefinition as coreValidateExec,
  transitionState,
  isTerminalStatus,
  listAllowedEvents as coreListAllowed,
  assertStateMachineDefinition,
  compileStateMachineDefinition,
  computeStateMachineDefinitionHash,
} from "./engine/state-machine-core.mjs";

import { transition as transitionFn, batchTransition } from "./transition.mjs";
import { replayTransitions as replayFn, detectTampering, verifyTransitionSequence } from "./replay.mjs";
import { assertInvariants as invariantsFn } from "./invariants.mjs";
import { exportStateMachineDocs as exportDocsFn } from "./export-docs.mjs";
export { loadDefinition, loadBuiltinDefinition, resolveDefinition, listBuiltinDefinitions, validateDefinition } from "./definition.mjs";
export { transition, isTransitionAllowed, listAllowedEvents, batchTransition } from "./transition.mjs";
export { replayTransitions, detectTampering, verifyTransitionSequence } from "./replay.mjs";
export { assertInvariants } from "./invariants.mjs";
export { exportStateMachineDocs } from "./export-docs.mjs";

export { ERROR_CODES, StateMachineError } from "./engine/state-machine-errors.mjs";
export { computeStateMachineDefinitionHash } from "./engine/state-machine-core.mjs";

/**
 * Create a state machine instance from a definition.
 *
 * @param {object} definition - State machine definition object
 * @returns {object} State machine instance
 */
export function createStateMachine(definition) {
  if (!definition) {
    throw new Error("State machine definition is required");
  }

  // Validate definition
  const validation = coreValidateExec(definition);
  if (!validation.ok) {
    throw new Error(
      `Invalid state machine definition: ${validation.errors.map((e) => e.message).join("; ")}`
    );
  }

  const definitionHash = computeStateMachineDefinitionHash(definition);

  /**
   * Execute a transition on this machine.
   *
   * @param {object} state - Current state: { entityId, currentStatus }
   * @param {string} event - Event to trigger
   * @param {object} [context] - Transition context
   * @returns {object} Transition result
   */
  function transition(state, event, context = {}) {
    return transitionFn({ machine: definition, state, event, context });
  }

  /**
   * Get the initial state.
   *
   * @returns {object}
   */
  function initialState() {
    return { currentStatus: definition.initialState };
  }

  /**
   * Check if a status is terminal.
   *
   * @param {string} statusId
   * @returns {boolean}
   */
  function isTerminal(statusId) {
    return isTerminalStatus(definition, statusId);
  }

  /**
   * List allowed events from a status.
   *
   * @param {string} statusId
   * @returns {string[]}
   */
  function listAllowed(statusId) {
    return coreListAllowed(definition, statusId);
  }

  /**
   * Replay a history of transitions on this machine.
   *
   * @param {object} options
   * @param {object} options.initialState
   * @param {Array} options.history
   * @returns {object}
   */
  function replay({ initialState: initState, history }) {
    return replayFn({ definition, initialState: initState, history });
  }

  /**
   * Assert invariants for this machine.
   *
   * @param {object} options
   * @param {object} options.state
   * @param {Array} [options.history]
   * @returns {object}
   */
  function checkInvariants({ state, history = [] }) {
    return invariantsFn({ definition, state, history });
  }

  /**
   * Export documentation for this machine.
   *
   * @returns {object}
   */
  function toDocs() {
    return exportDocsFn(definition);
  }

  return {
    definition,
    definitionHash,
    machineId: definition.machineId,
    initialState,
    transition,
    isTerminal,
    listAllowed,
    replay,
    checkInvariants,
    toDocs,
    computeDefinitionHash: () => definitionHash,
  };
}

/**
 * Validate a state machine definition (basic structural validation).
 * Delegates to the core engine's validation.
 *
 * @param {object} definition
 * @returns {{ ok: boolean, errors: Array<{ errorCode: string, message: string }> }}
 */
export function validateStateMachineDefinition(definition) {
  return coreValidate(definition);
}

/**
 * Full executable validation including guard registry check.
 *
 * @param {object} definition
 * @returns {{ ok: boolean, errors: Array<{ errorCode: string, message: string }> }}
 */
export function validateExecutableStateMachineDefinition(definition) {
  return coreValidateExec(definition);
}

/**
 * Assert-style validation that throws on invalid.
 *
 * @param {object} definition
 */
export function assertValidDefinition(definition) {
  assertStateMachineDefinition(definition);
}
