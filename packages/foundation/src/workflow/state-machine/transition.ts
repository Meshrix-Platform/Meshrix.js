import { transitionState as coreTransition } from "./engine/state-machine-core.ts";

interface MatrixCell {
  from: string;
  event: string;
  result: string;
  to?: string;
}

interface StateMachineDefinition {
  totalMatrix?: MatrixCell[];
  [key: string]: unknown;
}

interface StateContext {
  entityId?: string;
  currentStatus?: string;
  [key: string]: unknown;
}

interface TransitionContext {
  actor?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  operationId?: string;
  traceId?: string;
  auditId?: string;
  checkpointNodeId?: string;
  policyDecisionId?: string;
  approvalId?: string;
  now?: string | number | Date;
  guardContext?: Record<string, unknown>;
}

interface TransitionOptions {
  machine: StateMachineDefinition;
  state: StateContext;
  event: string;
  context?: TransitionContext;
}

/**
 * Execute a state transition on a state machine.
 *
 * @param {object} options
 * @param {object} options.machine - The state machine definition
 * @param {object} options.state - Current state context: { entityId, currentStatus }
 * @param {string} options.event - The event type to trigger
 * @param {object} [options.context] - Additional transition context
 * @returns {object} Transition result
 */
export function transition({ machine, state, event, context = {} }: TransitionOptions) {
  if (!machine) {
    return {
      ok: false,
      errorCode: "STATE_MACHINE_INVALID_DEFINITION",
      message: "Machine definition is required",
    };
  }

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

  const { entityId = "default", currentStatus } = state;
  const { actor = "system", reason = "", metadata = {} } = context;

  if (typeof currentStatus !== "string" || currentStatus.trim() === "") {
    return {
      ok: false,
      errorCode: "STATE_MACHINE_UNKNOWN_STATUS",
      message: "Current status is required",
    };
  }

  return coreTransition(machine, {
    entityId,
    currentStatus,
    eventType: event,
    actor,
    reason,
    metadata,
    operationId: context.operationId,
    traceId: context.traceId,
    auditId: context.auditId,
    checkpointNodeId: context.checkpointNodeId,
    policyDecisionId: context.policyDecisionId,
    approvalId: context.approvalId,
    now: context.now,
    guardContext: context.guardContext,
  });
}

/**
 * Check if a transition from a given status is valid for the given machine.
 *
 * @param {object} machine - State machine definition
 * @param {string} fromStatus - Current status
 * @param {string} eventType - Event to check
 * @returns {boolean}
 */
export function isTransitionAllowed(machine?: StateMachineDefinition, fromStatus?: string, eventType?: string): boolean {
  if (!machine || !machine.totalMatrix) return false;

  const cell = machine.totalMatrix.find(
    (candidate) => candidate.from === fromStatus && candidate.event === eventType
  );

  return cell
    ? cell.result !== "illegal_transition" && cell.result !== "ignored_idempotent_event"
    : false;
}

/**
 * List all allowed events from a given status.
 *
 * @param {object} machine - State machine definition
 * @param {string} fromStatus - Current status
 * @returns {string[]} Array of allowed event types
 */
export function listAllowedEvents(machine?: StateMachineDefinition, fromStatus?: string): string[] {
  if (!machine || !machine.totalMatrix) return [];

  return machine.totalMatrix
    .filter(
      (cell) =>
        cell.from === fromStatus &&
        cell.result !== "illegal_transition"
    )
    .map((cell) => cell.event);
}

/**
 * Execute a batch of transitions sequentially.
 *
 * @param {object} options
 * @param {object} options.machine - State machine definition
 * @param {object} options.initialState - Initial state context
 * @param {Array<{ event: string, context?: object }>} options.transitions - Transitions to execute
 * @returns {{ results: object[], finalState: object, ok: boolean }}
 */
export function batchTransition({ machine, initialState, transitions }: {
  machine: StateMachineDefinition;
  initialState: StateContext;
  transitions: readonly { event: string; context?: TransitionContext }[];
}) {
  const results: Array<Record<string, unknown>> = [];
  let currentState: StateContext = { ...initialState };

  for (const t of transitions) {
    const result = transition({
      machine,
      state: currentState,
      event: t.event,
      context: t.context,
    });

    results.push({
      event: t.event,
      fromStatus: currentState.currentStatus,
      toStatus: result.ok ? result.toStatus : currentState.currentStatus,
      ok: result.ok,
      result,
    });

    if (result.ok && typeof result.toStatus === "string" && result.toStatus) {
      currentState = { ...currentState, currentStatus: result.toStatus };
    }
  }

  return { results, finalState: currentState, ok: results.every((result) => result.ok === true) };
}
