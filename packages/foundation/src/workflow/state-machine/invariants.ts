/**
 * Assert invariants for a state machine definition given current state and history.
 *
 * Invariants are named checks defined in the definition's `invariants` array.
 * Each invariant must pass for the machine state to be considered valid.
 *
 * @param {object} options
 * @param {object} options.definition - State machine definition
 * @param {object} options.state - Current state: { entityId, currentStatus }
 * @param {Array} [options.history] - Transition history
 * @returns {{ ok: boolean, results: Array<{ invariant: string, ok: boolean, message: string }>, errors: string[] }}
 */
export function assertInvariants({ definition, state, history = [] }: Record<string, any>) : any {
  if (!definition) {
    return { ok: false, results: [], errors: ["Definition is required"] };
  }

  const results: any[] = [];
  const errors: any[] = [];

  // Basic state validity check — current status must exist in the definition
  if (state && state.currentStatus) {
    const validState: any = definition.states
      ? definition.states.some((s?: any) : any => s.id === state.currentStatus)
      : false;
    if (!validState) {
      errors.push(
        `Current status '${state.currentStatus}' is not a valid state in definition '${definition.machineId}'`
      );
    }
  }

  // No invariants defined — only basic check applies
  if (!Array.isArray(definition.invariants) || definition.invariants.length === 0) {
    return { ok: errors.length === 0, results, errors };
  }

  for (const invariantId of definition.invariants) {
    try {
      const result: any = evaluateInvariant(invariantId, definition, state, history);
      results.push(result);
      if (!result.ok) {
        errors.push(`Invariant '${invariantId}' failed: ${result.message}`);
      }
    } catch (err: any) {
      results.push({
        invariant: invariantId,
        ok: false,
        message: `Invariant evaluation error: ${err.message}`,
      });
      errors.push(`Invariant '${invariantId}' evaluation error: ${err.message}`);
    }
  }

  return {
    ok: errors.length === 0,
    results,
    errors,
  };
}

/**

/**
 * Evaluate a single invariant by ID.
 *
 * Built-in invariants:
 * - SM-{machine}-001: Initial state must be reachable
 * - SM-{machine}-002: Terminal states must not have outgoing transitions
 * - SM-{machine}-003: All states must be reachable from initial state
 * - SM-{machine}-004: All events must be defined for all states
 *
 * @param {string} invariantId
 * @param {object} definition
 * @param {object} state
 * @param {Array} history
 * @returns {{ invariant: string, ok: boolean, message: string }}
 */
function evaluateInvariant(invariantId?: any, definition?: any, state?: any, history?: any) : any {
  // Generic invariants
  if (invariantId.endsWith("-001") || invariantId.includes("REACHABLE")) {
    return checkInitialStateReachable(definition);
  }
  if (invariantId.endsWith("-002") || invariantId.includes("TERMINAL")) {
    return checkTerminalStateNoOutgoing(definition);
  }
  if (invariantId.endsWith("-003") || invariantId.includes("REACHABILITY")) {
    return checkAllStatesReachable(definition);
  }
  if (invariantId.endsWith("-004") || invariantId.includes("COMPLETENESS")) {
    return checkMatrixCompleteness(definition);
  }

  return {
    invariant: invariantId,
    ok: false,
    message: `Invariant '${invariantId}' has no registered evaluator`,
  };
}

/**
 * Check that the initial state is reachable (trivially true for initial state).
 */
function checkInitialStateReachable(definition?: any) : any {
  return {
    invariant: "SM_001",
    ok: true,
    message: `Initial state '${definition.initialState}' is available`,
  };
}

/**
 * Check that no terminal state has outgoing transitions.
 */
function checkTerminalStateNoOutgoing(definition?: any) : any {
  const terminalStates: any = definition.states
    .filter((s?: any) : any => s.terminal)
    .map((s?: any) : any => s.id);

  const violations: any[] = [];
  for (const terminal of terminalStates) {
    const outgoing: any = definition.totalMatrix.filter(
      (cell?: any) : any => cell.from === terminal
        && cell.result !== "illegal_transition"
        && cell.result !== "ignored_idempotent_event"
    );
    if (outgoing.length > 0) {
      violations.push(
        `Terminal state '${terminal}' has ${outgoing.length} non-illegal outgoing transitions`
      );
    }
  }

  if (violations.length > 0) {
    return {
      invariant: "SM_002",
      ok: false,
      message: violations.join("; "),
    };
  }

  return {
    invariant: "SM_002",
    ok: true,
    message: "All terminal states have no outgoing transitions",
  };
}

/**
 * Check that all states are reachable from the initial state via BFS.
 */
function checkAllStatesReachable(definition?: any) : any {
  const stateIds: any = new Set<any>(definition.states.map((s?: any) : any => s.id));
  const reachable: any = new Set<any>([definition.initialState]);
  const queue: any[] = [definition.initialState];
  const visited: any = new Set<any>();

  while (queue.length > 0) {
    const current: any = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const transitions: any = definition.totalMatrix.filter(
      (cell?: any) : any => cell.from === current && cell.result !== "illegal_transition" && cell.to
    );

    for (const t of transitions) {
      if (t.to && !visited.has(t.to)) {
        reachable.add(t.to);
        queue.push(t.to);
      }
    }
  }

  const unreachable: any = [...stateIds].filter((id?: any) : any => !reachable.has(id));

  if (unreachable.length > 0) {
    return {
      invariant: "SM_003",
      ok: false,
      message: `States not reachable from '${definition.initialState}': ${unreachable.join(", ")}`,
    };
  }

  return {
    invariant: "SM_003",
    ok: true,
    message: `All ${stateIds.size} states reachable from '${definition.initialState}'`,
  };
}

/**
 * Check that all state-event combinations have a matrix entry.
 */
function checkMatrixCompleteness(definition?: any) : any {
  const matrixKeys: any = new Set<any>(
    definition.totalMatrix.map((cell?: any) : any => `${cell.from}::${cell.event}`)
  );

  const missing: any[] = [];
  for (const state of definition.states) {
    for (const event of definition.events) {
      const key: any = `${state.id}::${event.id}`;
      if (!matrixKeys.has(key)) {
        missing.push(key);
      }
    }
  }

  if (missing.length > 0) {
    return {
      invariant: "SM_004",
      ok: false,
      message: `Missing matrix entries for: ${missing.join(", ")}`,
    };
  }

  return {
    invariant: "SM_004",
    ok: true,
    message: `Total matrix is complete (${matrixKeys.size} entries)`,
  };
}
