import { REACHABLE_TRANSITION_RESULTS } from "../engine/state-machine-result-types.ts";

function groupMatrixCells(totalMatrix?: any) : any {
  const groups: any = new Map<any, any>();
  for (const cell of totalMatrix) {
    const key: any = `${cell.from}::${cell.event}`;
    const cells: any = groups.get(key);
    if (cells) cells.push(cell);
    else groups.set(key, [cell]);
  }
  return groups;
}

export function assertMatrixTotality(definition?: any) : any {
  const groups: any = groupMatrixCells(definition.totalMatrix);
  const missing: any[] = [];
  for (const state of definition.states) {
    for (const event of definition.events) {
      const key: any = `${state.id}::${event.id}`;
      if (!groups.has(key)) missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Matrix totality check failed. Missing ${missing.length} cells: ${missing.join(", ")}`);
  }

  for (const [key, cells] of groups) {
    if (cells.length === 1) continue;
    const illegal: any = cells.filter((cell?: any) : any => cell.result === "illegal_transition");
    const executable: any = cells.filter((cell?: any) : any => cell.result !== "illegal_transition");
    if (illegal.length > 1) {
      throw new Error(`Matrix cell ${key} contains duplicate illegal outcomes`);
    }
    const unguarded: any = executable.filter((cell?: any) : any =>
      (cell.guards || []).length === 0 && (cell.requiredGuards || []).length === 0
    );
    if (unguarded.length > 0) {
      throw new Error(`Duplicate unguarded outcomes for ${key}; multiple executable outcomes require fully guarded disambiguation`);
    }
  }
}

export function assertReachability(definition?: any) : any {
  const reachable: any = new Set<any>([definition.initialState]);
  const queue: any[] = [definition.initialState];
  let cursor: any = 0;
  while (cursor < queue.length) {
    const current: any = queue[cursor++];
    for (const cell of definition.totalMatrix) {
      if (cell.from !== current || !REACHABLE_TRANSITION_RESULTS.includes(cell.result)) continue;
      const target: any = cell.to || current;
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  const unreachable: any = definition.states
    .filter((state?: any) : any => !state.externalEntryState && !reachable.has(state.id))
    .map((state?: any) : any => state.id);
  if (unreachable.length > 0) {
    throw new Error(`Reachability check failed. Unreachable states: ${unreachable.join(", ")}`);
  }
}

export function assertNonTerminalTransitions(definition?: any) : any {
  for (const state of definition.states) {
    if (state.terminal || state.passiveState || state.waitingStateWithTimeout) continue;
    const hasOutgoing: any = definition.totalMatrix.some((cell?: any) : any =>
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

export function assertTerminalSemantics(definition?: any) : any {
  const eventById: any = new Map<any, any>(definition.events.map((event?: any) : any => [event.id, event]));
  const allowedTerminalEvents: any = new Set<any>(definition.allowedTerminalEvents || []);
  for (const state of definition.states) {
    if (!state.terminal) continue;
    for (const cell of definition.totalMatrix.filter((candidate?: any) : any => candidate.from === state.id)) {
      const allowed: any = cell.result === "illegal_transition" ||
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

export function assertIllegalTransitionErrorCodes(definition?: any) : any {
  for (const cell of definition.totalMatrix) {
    if (cell.result === "illegal_transition" && !cell.errorCode) {
      throw new Error(`Illegal transition from '${cell.from}' on '${cell.event}' is missing 'errorCode'`);
    }
  }
}

export function assertCellReferences(definition?: any) : any {
  const states: any = new Set<any>(definition.states.map((state?: any) : any => state.id));
  const events: any = new Set<any>(definition.events.map((event?: any) : any => event.id));
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

export function validateStateMachineTopology(definition?: any) : any {
  const checks: any[] = [
    assertMatrixTotality,
    assertReachability,
    assertNonTerminalTransitions,
    assertTerminalSemantics,
    assertIllegalTransitionErrorCodes,
    assertCellReferences,
  ];
  const errors: any[] = [];
  for (const check of checks) {
    try {
      check(definition);
    } catch (error: any) {
      errors.push(error.message);
    }
  }
  return { ok: errors.length === 0, errors };
}
