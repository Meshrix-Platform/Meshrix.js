import {
  validateStateMachineDefinition as coreValidate,
  validateExecutableStateMachineDefinition as coreValidateExec,
  transitionState,
  isTerminalStatus,
  listAllowedEvents as coreListAllowed,
  assertStateMachineDefinition,
  compileStateMachineDefinition,
  computeStateMachineDefinitionHash,
} from "./engine/state-machine-core.ts";

import { transition as transitionFn, batchTransition } from "./transition.ts";
import { replayTransitions as replayFn, detectTampering, verifyTransitionSequence } from "./replay.ts";
import { assertInvariants as invariantsFn } from "./invariants.ts";
import { exportStateMachineDocs as exportDocsFn } from "./export-docs.ts";
export { loadDefinition, loadBuiltinDefinition, resolveDefinition, listBuiltinDefinitions, validateDefinition } from "./definition.ts";
export { transition, isTransitionAllowed, listAllowedEvents, batchTransition } from "./transition.ts";
export { replayTransitions, detectTampering, verifyTransitionSequence } from "./replay.ts";
export { assertInvariants } from "./invariants.ts";
export { exportStateMachineDocs } from "./export-docs.ts";

export { ERROR_CODES, StateMachineError } from "./engine/state-machine-errors.ts";
export { computeStateMachineDefinitionHash } from "./engine/state-machine-core.ts";

/**
 * Create a state machine instance from a definition.
 *
 * @param {object} definition - State machine definition object
 * @returns {object} State machine instance
 */
export function createStateMachine(definition?: any) : any {
  if (!definition) {
    throw new Error("State machine definition is required");
  }

  // Validate definition
  const validation: any = coreValidateExec(definition);
  if (!validation.ok) {
    throw new Error(
      `Invalid state machine definition: ${validation.errors.map((e?: any) : any => e.message).join("; ")}`
    );
  }

  const definitionHash: any = computeStateMachineDefinitionHash(definition);

  /**
   * Execute a transition on this machine.
   *
   * @param {object} state - Current state: { entityId, currentStatus }
   * @param {string} event - Event to trigger
   * @param {object} [context] - Transition context
   * @returns {object} Transition result
   */
  function transition(state?: any, event?: any, context: Record<string, any> = {}) : any {
    return transitionFn({ machine: definition, state, event, context });
  }

  /**
   * Get the initial state.
   *
   * @returns {object}
   */
  function initialState() : any {
    return { currentStatus: definition.initialState };
  }

  /**
   * Check if a status is terminal.
   *
   * @param {string} statusId
   * @returns {boolean}
   */
  function isTerminal(statusId?: any) : any {
    return isTerminalStatus(definition, statusId);
  }

  /**
   * List allowed events from a status.
   *
   * @param {string} statusId
   * @returns {string[]}
   */
  function listAllowed(statusId?: any) : any {
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
  function replay({ initialState: initState, history }: Record<string, any>) : any {
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
  function checkInvariants({ state, history = [] }: Record<string, any>) : any {
    return invariantsFn({ definition, state, history });
  }

  /**
   * Export documentation for this machine.
   *
   * @returns {object}
   */
  function toDocs() : any {
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
    computeDefinitionHash: () : any => definitionHash,
  };
}

/**
 * Validate a state machine definition (basic structural validation).
 * Delegates to the core engine's validation.
 *
 * @param {object} definition
 * @returns {{ ok: boolean, errors: Array<{ errorCode: string, message: string }> }}
 */
export function validateStateMachineDefinition(definition?: any) : any {
  return coreValidate(definition);
}

/**
 * Full executable validation including guard registry check.
 *
 * @param {object} definition
 * @returns {{ ok: boolean, errors: Array<{ errorCode: string, message: string }> }}
 */
export function validateExecutableStateMachineDefinition(definition?: any) : any {
  return coreValidateExec(definition);
}

/**
 * Assert-style validation that throws on invalid.
 *
 * @param {object} definition
 */
export function assertValidDefinition(definition?: any) : any {
  assertStateMachineDefinition(definition);
}
