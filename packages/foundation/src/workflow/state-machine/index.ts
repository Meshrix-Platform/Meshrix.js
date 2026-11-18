import {
  validateStateMachineDefinition as coreValidate,
  validateExecutableStateMachineDefinition as coreValidateExec,
  isTerminalStatus,
  listAllowedEvents as coreListAllowed,
  assertStateMachineDefinition,
  computeStateMachineDefinitionHash,
} from "./engine/state-machine-core.ts";

import { transition as transitionFn } from "./transition.ts";
import { replayTransitions as replayFn } from "./replay.ts";
import { assertInvariants as invariantsFn } from "./invariants.ts";
import { exportStateMachineDocs as exportDocsFn } from "./export-docs.ts";
export {
  loadDefinition,
  loadBuiltinDefinition,
  resolveDefinition,
  listBuiltinDefinitions,
  validateDefinition,
} from "./definition.ts";
export {
  transition,
  isTransitionAllowed,
  listAllowedEvents,
  batchTransition,
} from "./transition.ts";
export {
  replayTransitions,
  detectTampering,
  verifyTransitionSequence,
} from "./replay.ts";
export { assertInvariants } from "./invariants.ts";
export { exportStateMachineDocs } from "./export-docs.ts";

export {
  ERROR_CODES,
  StateMachineError,
} from "./engine/state-machine-errors.ts";
export { computeStateMachineDefinitionHash } from "./engine/state-machine-core.ts";

type DataRecord = Record<string, unknown>;
interface StateMachineDefinition extends DataRecord {
  machineId: string;
  initialState: string;
  states: Array<{ id: string; terminal?: boolean }>;
  events: Array<{ id: string }>;
  totalMatrix: Array<{
    from: string;
    event: string;
    result: string;
    to?: string;
  }>;
  invariants?: string[];
}
interface StateContext extends DataRecord {
  entityId?: string;
  currentStatus?: string;
}
interface TransitionContext extends DataRecord {
  actor?: string;
  reason?: string;
  metadata?: DataRecord;
  operationId?: string;
  traceId?: string;
  auditId?: string;
  checkpointNodeId?: string;
  policyDecisionId?: string;
  approvalId?: string;
  now?: string | number | Date;
  guardContext?: DataRecord;
}
interface ValidationError {
  errorCode: string;
  message: string;
}
interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}
interface ReplayInput {
  initialState?: unknown;
  history?: unknown;
}
interface InvariantInput {
  state?: StateContext;
  history?: unknown[];
}
interface StateMachineFacade {
  definition: StateMachineDefinition;
  definitionHash: string;
  machineId: string;
  initialState(): { currentStatus: string };
  transition(
    state?: StateContext,
    event?: string,
    context?: TransitionContext,
  ): unknown;
  isTerminal(statusId?: string): boolean;
  listAllowed(statusId?: string): string[];
  replay(input: ReplayInput): unknown;
  checkInvariants(input: InvariantInput): unknown;
  toDocs(): unknown;
  computeDefinitionHash(): string;
}

function isRecord(value: unknown): value is DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function executableDefinition(value: unknown): StateMachineDefinition {
  if (
    !isRecord(value) ||
    typeof value.machineId !== "string" ||
    typeof value.initialState !== "string" ||
    !Array.isArray(value.states) ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.totalMatrix)
  ) {
    throw new TypeError("State machine definition is invalid");
  }
  return value as StateMachineDefinition;
}

/**
 * Create a state machine instance from a definition.
 *
 * @param {object} definition - State machine definition object
 * @returns {object} State machine instance
 */
export function createStateMachine(value?: unknown): StateMachineFacade {
  if (!value) {
    throw new Error("State machine definition is required");
  }
  const definition = executableDefinition(value);

  // Validate definition
  const validation: ValidationResult = coreValidateExec(definition);
  if (!validation.ok) {
    throw new Error(
      `Invalid state machine definition: ${validation.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const definitionHash: string = computeStateMachineDefinitionHash(definition);

  /**
   * Execute a transition on this machine.
   *
   * @param {object} state - Current state: { entityId, currentStatus }
   * @param {string} event - Event to trigger
   * @param {object} [context] - Transition context
   * @returns {object} Transition result
   */
  function transition(
    state?: StateContext,
    event?: string,
    context: TransitionContext = {},
  ) {
    if (!state) {
      return {
        ok: false,
        errorCode: "STATE_MACHINE_UNKNOWN_STATUS",
        message: "State context is required",
      };
    }
    if (!event) {
      return {
        ok: false,
        errorCode: "STATE_MACHINE_UNKNOWN_EVENT",
        message: "Event type is required",
      };
    }
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
  function isTerminal(statusId?: string): boolean {
    return isTerminalStatus(definition, statusId);
  }

  /**
   * List allowed events from a status.
   *
   * @param {string} statusId
   * @returns {string[]}
   */
  function listAllowed(statusId?: string): string[] {
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
  function replay({ initialState: initState, history }: ReplayInput) {
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
  function checkInvariants({ state, history = [] }: InvariantInput) {
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
export function validateStateMachineDefinition(
  definition?: unknown,
): ValidationResult {
  return coreValidate(definition);
}

/**
 * Full executable validation including guard registry check.
 *
 * @param {object} definition
 * @returns {{ ok: boolean, errors: Array<{ errorCode: string, message: string }> }}
 */
export function validateExecutableStateMachineDefinition(
  definition?: unknown,
): ValidationResult {
  return coreValidateExec(definition);
}

/**
 * Assert-style validation that throws on invalid.
 *
 * @param {object} definition
 */
export function assertValidDefinition(definition?: unknown): void {
  assertStateMachineDefinition(definition);
}
