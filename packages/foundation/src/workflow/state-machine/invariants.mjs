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
export function assertInvariants({ definition, state, history = [] }) {
  if (!definition) {
    return { ok: false, results: [], errors: ["Definition is required"] };
  }

  const results = [];
  const errors = [];

  // Basic state validity check — current status must exist in the definition
  if (state && state.currentStatus) {
    const validState = definition.states
      ? definition.states.some((s) => s.id === state.currentStatus)
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
      const result = evaluateInvariant(invariantId, definition, state, history);
      results.push(result);
      if (!result.ok) {
        errors.push(`Invariant '${invariantId}' failed: ${result.message}`);
      }
    } catch (err) {
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
function evaluateInvariant(invariantId, definition, state, history) {
  // Generic invariants
  if (invariantId.endsWith("-001") || invariantId.includes("REACHABLE")) {
    return checkInitialStateReachable(definition, state);
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
function checkInitialStateReachable(definition) {
  return {
    invariant: "SM_001",
    ok: true,
    message: `Initial state '${definition.initialState}' is available`,
  };
}

/**
 * Check that no terminal state has outgoing transitions.
 */
function checkTerminalStateNoOutgoing(definition) {
  const terminalStates = definition.states
    .filter((s) => s.terminal)
    .map((s) => s.id);

  const violations = [];
  for (const terminal of terminalStates) {
    const outgoing = definition.totalMatrix.filter(
      (cell) => cell.from === terminal
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
function checkAllStatesReachable(definition) {
  const stateIds = new Set(definition.states.map((s) => s.id));
  const reachable = new Set([definition.initialState]);
  const queue = [definition.initialState];
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const transitions = definition.totalMatrix.filter(
      (cell) => cell.from === current && cell.result !== "illegal_transition" && cell.to
    );

    for (const t of transitions) {
      if (t.to && !visited.has(t.to)) {
        reachable.add(t.to);
        queue.push(t.to);
      }
    }
  }

  const unreachable = [...stateIds].filter((id) => !reachable.has(id));

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
function checkMatrixCompleteness(definition) {
  const matrixKeys = new Set(
    definition.totalMatrix.map((cell) => `${cell.from}::${cell.event}`)
  );

  const missing = [];
  for (const state of definition.states) {
    for (const event of definition.events) {
      const key = `${state.id}::${event.id}`;
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
