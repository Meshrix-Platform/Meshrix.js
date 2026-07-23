import { REACHABLE_TRANSITION_RESULTS } from "../engine/state-machine-result-types.mjs";

function groupMatrixCells(totalMatrix) {
  const groups = new Map();
  for (const cell of totalMatrix) {
    const key = `${cell.from}::${cell.event}`;
    const cells = groups.get(key);
    if (cells) cells.push(cell);
    else groups.set(key, [cell]);
  }
  return groups;
}

export function assertMatrixTotality(definition) {
  const groups = groupMatrixCells(definition.totalMatrix);
  const missing = [];
  for (const state of definition.states) {
    for (const event of definition.events) {
      const key = `${state.id}::${event.id}`;
      if (!groups.has(key)) missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Matrix totality check failed. Missing ${missing.length} cells: ${missing.join(", ")}`);
  }

  for (const [key, cells] of groups) {
    if (cells.length === 1) continue;
    const illegal = cells.filter((cell) => cell.result === "illegal_transition");
    const executable = cells.filter((cell) => cell.result !== "illegal_transition");
    if (illegal.length > 1) {
      throw new Error(`Matrix cell ${key} contains duplicate illegal outcomes`);
    }
    const unguarded = executable.filter((cell) =>
      (cell.guards || []).length === 0 && (cell.requiredGuards || []).length === 0
    );
    if (unguarded.length > 0) {
      throw new Error(`Duplicate unguarded outcomes for ${key}; multiple executable outcomes require fully guarded disambiguation`);
    }
  }
}

export function assertReachability(definition) {
  const reachable = new Set([definition.initialState]);
  const queue = [definition.initialState];
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor++];
    for (const cell of definition.totalMatrix) {
      if (cell.from !== current || !REACHABLE_TRANSITION_RESULTS.includes(cell.result)) continue;
      const target = cell.to || current;
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  const unreachable = definition.states
    .filter((state) => !state.externalEntryState && !reachable.has(state.id))
    .map((state) => state.id);
  if (unreachable.length > 0) {
    throw new Error(`Reachability check failed. Unreachable states: ${unreachable.join(", ")}`);
  }
}

export function assertNonTerminalTransitions(definition) {
  for (const state of definition.states) {
    if (state.terminal || state.passiveState || state.waitingStateWithTimeout) continue;
    const hasOutgoing = definition.totalMatrix.some((cell) =>
      cell.from === state.id &&
      cell.to &&
      cell.to !== state.id &&
      cell.result !== "illegal_transition" &&
      cell.result !== "ignored_idempotent_event"
    );
    if (!hasOutgoing) {
      throw new Error(`Non-terminal state '${state.id}' must have an outgoing transition or be marked passive`);
    }
  }
}

export function assertTerminalSemantics(definition) {
  const eventById = new Map(definition.events.map((event) => [event.id, event]));
  const allowedTerminalEvents = new Set(definition.allowedTerminalEvents || []);
  for (const state of definition.states) {
    if (!state.terminal) continue;
    for (const cell of definition.totalMatrix.filter((candidate) => candidate.from === state.id)) {
      const allowed = cell.result === "illegal_transition" ||
        cell.result === "ignored_idempotent_event" ||
        eventById.get(cell.event)?.idempotent === true ||
        allowedTerminalEvents.has(cell.event) ||
        cell.allowedReopenTransition === true;
      if (!allowed) {
        throw new Error(`Terminal state '${state.id}' has invalid outgoing transition on '${cell.event}'`);
      }
    }
  }
}

export function assertIllegalTransitionErrorCodes(definition) {
  for (const cell of definition.totalMatrix) {
    if (cell.result === "illegal_transition" && !cell.errorCode) {
      throw new Error(`Illegal transition from '${cell.from}' on '${cell.event}' is missing 'errorCode'`);
    }
  }
}

export function assertCellReferences(definition) {
  const states = new Set(definition.states.map((state) => state.id));
  const events = new Set(definition.events.map((event) => event.id));
  for (const cell of definition.totalMatrix) {
    if (!states.has(cell.from)) {
      throw new Error(`Matrix cell references unknown state '${cell.from}' (from field)`);
    }
    if (!events.has(cell.event)) {
      throw new Error(`Matrix cell references unknown event '${cell.event}'`);
    }
    if (cell.to !== undefined && cell.to !== "" && !states.has(cell.to)) {
      throw new Error(`Matrix cell references unknown state '${cell.to}' (to field)`);
    }
  }
}

export function validateStateMachineTopology(definition) {
  const checks = [
    assertMatrixTotality,
    assertReachability,
    assertNonTerminalTransitions,
    assertTerminalSemantics,
    assertIllegalTransitionErrorCodes,
    assertCellReferences,
  ];
  const errors = [];
  for (const check of checks) {
    try {
      check(definition);
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { ok: errors.length === 0, errors };
}
