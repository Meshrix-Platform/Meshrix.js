import { transitionState as coreTransition } from "./engine/state-machine-core.ts";

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
export function transition({ machine, state, event, context = {} }: Record<string, any>) : any {
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
export function isTransitionAllowed(machine?: any, fromStatus?: any, eventType?: any) : any {
  if (!machine || !machine.totalMatrix) return false;

  const cell: any = machine.totalMatrix.find(
    (c?: any) : any => c.from === fromStatus && c.event === eventType
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
export function listAllowedEvents(machine?: any, fromStatus?: any) : any {
  if (!machine || !machine.totalMatrix) return [];

  return machine.totalMatrix
    .filter(
      (c?: any) : any =>
        c.from === fromStatus &&
        c.result !== "illegal_transition"
    )
    .map((c?: any) : any => c.event);
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
export function batchTransition({ machine, initialState, transitions }: Record<string, any>) : any {
  const results: any[] = [];
  let currentState: Record<string, any> = { ...initialState };

  for (const t of transitions) {
    const result: any = transition({
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

    if (result.ok && result.toStatus) {
      currentState = { ...currentState, currentStatus: result.toStatus };
    }
  }

  return { results, finalState: currentState, ok: results.every((r?: any) : any => r.ok) };
}
