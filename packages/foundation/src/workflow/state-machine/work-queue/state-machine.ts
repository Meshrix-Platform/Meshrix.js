export const WORK_QUEUE_STATES: Readonly<Record<string, any>> = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  IN_DOUBT: "in_doubt",
  RETRY_WAIT: "retry_wait",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  RECOVERED: "recovered"
});

export const WORK_QUEUE_TERMINAL_STATES: readonly any[] = Object.freeze([
  WORK_QUEUE_STATES.COMPLETED,
  WORK_QUEUE_STATES.CANCELLED,
  WORK_QUEUE_STATES.EXPIRED
]);

export const WORK_QUEUE_SAFE_INTERVENTION_STATES: readonly any[] = Object.freeze([
  WORK_QUEUE_STATES.QUEUED,
  WORK_QUEUE_STATES.RETRY_WAIT,
  WORK_QUEUE_STATES.FAILED,
  WORK_QUEUE_STATES.RECOVERED,
  WORK_QUEUE_STATES.COMPLETED,
  WORK_QUEUE_STATES.CANCELLED,
  WORK_QUEUE_STATES.EXPIRED
]);

export const WORK_QUEUE_TRANSITIONS: Readonly<Record<string, any>> = Object.freeze({
  enqueue: Object.freeze({
    from: Object.freeze([null]),
    to: Object.freeze([WORK_QUEUE_STATES.QUEUED, WORK_QUEUE_STATES.RETRY_WAIT])
  }),
  retention_snapshot: Object.freeze({
    from: Object.freeze([null]),
    to: Object.freeze((Object.values(WORK_QUEUE_STATES) as any[]))
  }),
  claim: Object.freeze({
    from: Object.freeze([WORK_QUEUE_STATES.QUEUED, WORK_QUEUE_STATES.RECOVERED]),
    to: Object.freeze([WORK_QUEUE_STATES.RUNNING])
  }),
  progress: Object.freeze({
    from: Object.freeze([WORK_QUEUE_STATES.RUNNING]),
    to: Object.freeze([WORK_QUEUE_STATES.RUNNING]),
    leaseBound: true
  }),
  interrupt: Object.freeze({
    from: Object.freeze([WORK_QUEUE_STATES.RUNNING]),
    to: Object.freeze([WORK_QUEUE_STATES.IN_DOUBT]),
    leaseBound: true
  }),
  termination_acknowledged: Object.freeze({
    from: Object.freeze([WORK_QUEUE_STATES.IN_DOUBT]),
    to: Object.freeze([
      WORK_QUEUE_STATES.QUEUED,
      WORK_QUEUE_STATES.RETRY_WAIT,
      WORK_QUEUE_STATES.FAILED,
      WORK_QUEUE_STATES.COMPLETED
    ]),
    leaseBound: true
  }),
  complete: Object.freeze({
    from: Object.freeze([WORK_QUEUE_STATES.RUNNING]),
    to: Object.freeze([WORK_QUEUE_STATES.COMPLETED]),
    leaseBound: true
  }),
  retry: Object.freeze({
    from: Object.freeze([WORK_QUEUE_STATES.RUNNING]),
    to: Object.freeze([
      WORK_QUEUE_STATES.QUEUED,
      WORK_QUEUE_STATES.RETRY_WAIT,
      WORK_QUEUE_STATES.FAILED
    ]),
    leaseBound: true
  }),
  fail: Object.freeze({
    from: Object.freeze([
      WORK_QUEUE_STATES.QUEUED,
      WORK_QUEUE_STATES.RETRY_WAIT,
      WORK_QUEUE_STATES.RUNNING,
      WORK_QUEUE_STATES.IN_DOUBT,
      WORK_QUEUE_STATES.RECOVERED
    ]),
    to: Object.freeze([WORK_QUEUE_STATES.FAILED])
  }),
  recover: Object.freeze({
    from: Object.freeze([
      WORK_QUEUE_STATES.FAILED
    ]),
    to: Object.freeze([
      WORK_QUEUE_STATES.RECOVERED
    ])
  }),
  lease_expired: Object.freeze({
    from: Object.freeze([WORK_QUEUE_STATES.RUNNING]),
    to: Object.freeze([WORK_QUEUE_STATES.IN_DOUBT]),
    fallback: true
  }),
  delay_matured: Object.freeze({
    from: Object.freeze([WORK_QUEUE_STATES.RETRY_WAIT]),
    to: Object.freeze([WORK_QUEUE_STATES.QUEUED]),
    fallback: true
  }),
  cancel_running: Object.freeze({
    from: Object.freeze([WORK_QUEUE_STATES.RUNNING]),
    to: Object.freeze([WORK_QUEUE_STATES.CANCELLED]),
    leaseBound: true
  }),
  cancel: Object.freeze({
    from: Object.freeze([
      WORK_QUEUE_STATES.QUEUED,
      WORK_QUEUE_STATES.RETRY_WAIT,
      WORK_QUEUE_STATES.RUNNING,
      WORK_QUEUE_STATES.IN_DOUBT,
      WORK_QUEUE_STATES.RECOVERED
    ]),
    to: Object.freeze([WORK_QUEUE_STATES.CANCELLED])
  }),
  expire: Object.freeze({
    from: Object.freeze([
      WORK_QUEUE_STATES.QUEUED,
      WORK_QUEUE_STATES.RETRY_WAIT,
      WORK_QUEUE_STATES.RUNNING,
      WORK_QUEUE_STATES.IN_DOUBT,
      WORK_QUEUE_STATES.RECOVERED
    ]),
    to: Object.freeze([WORK_QUEUE_STATES.EXPIRED])
  }),
  requeue_recovered: Object.freeze({
    from: Object.freeze([WORK_QUEUE_STATES.RECOVERED]),
    to: Object.freeze([
      WORK_QUEUE_STATES.QUEUED,
      WORK_QUEUE_STATES.RETRY_WAIT,
      WORK_QUEUE_STATES.FAILED,
      WORK_QUEUE_STATES.CANCELLED
    ])
  })
});

export const WORK_QUEUE_STATE_MACHINE_PROOF_VERSION: any = "v0.0.1:workflow:work-queue-state-machine-proof-1";

export function isWorkQueueState(value?: any) : any {
  return (Object.values(WORK_QUEUE_STATES) as any[]).includes(value);
}

export function isTerminalWorkQueueState(value?: any) : any {
  return WORK_QUEUE_TERMINAL_STATES.includes(value);
}

export function isSafeInterventionState(value?: any) : any {
  return WORK_QUEUE_SAFE_INTERVENTION_STATES.includes(value);
}

export function getWorkQueueTransition(transition?: any) : any {
  return WORK_QUEUE_TRANSITIONS[String(transition || "")] || null;
}

export function getAllowedTargetStates({ transition, fromState }: Record<string, any>) : any {
  const definition: any = getWorkQueueTransition(transition);
  if (!definition || !definition.from.includes(fromState ?? null)) {
    return [];
  }
  return [...definition.to];
}

export function isLegalWorkQueueTransition({ transition, fromState = null, toState }: Record<string, any>) : any {
  const allowed: any = getAllowedTargetStates({ transition, fromState });
  return allowed.includes(toState);
}

export function assertLegalWorkQueueTransition({ transition, fromState = null, toState }: Record<string, any>) : any {
  if (isLegalWorkQueueTransition({ transition, fromState, toState })) {
    return true;
  }
  const fromLabel: any = fromState === null || fromState === undefined ? "none" : String(fromState);
  throw new Error(`Illegal work queue transition: ${transition} ${fromLabel} -> ${toState}`);
}

export function describeWorkQueueStateMachine() : any {
  return {
    states: (Object.values(WORK_QUEUE_STATES) as any[]),
    terminalStates: [...WORK_QUEUE_TERMINAL_STATES],
    safeInterventionStates: [...WORK_QUEUE_SAFE_INTERVENTION_STATES],
    transitions: Object.fromEntries(
      (Object.entries(WORK_QUEUE_TRANSITIONS) as [string, any][]).map(([name, definition]: any[]) : any => [
        name,
        {
          from: [...definition.from],
          to: [...definition.to],
          leaseBound: definition.leaseBound === true,
          fallback: definition.fallback === true
        }
      ])
    )
  };
}

export function buildWorkQueueTransitionMatrix() : any {
  const states: any = (Object.values(WORK_QUEUE_STATES) as any[]);
  const events: any = Object.keys(WORK_QUEUE_TRANSITIONS);
  return states.flatMap((fromState?: any) : any =>
    events.map((transition?: any) : any => {
      const allowedTargets: any = getAllowedTargetStates({ transition, fromState });
      return Object.freeze({
        fromState,
        transition,
        legal: allowedTargets.length > 0,
        toStates: Object.freeze(allowedTargets)
      });
    })
  );
}

export function verifyWorkQueueStateMachineProof() : any {
  const errors: any[] = [];
  const states: any = (Object.values(WORK_QUEUE_STATES) as any[]);
  const events: any = Object.keys(WORK_QUEUE_TRANSITIONS);
  const matrix: any = buildWorkQueueTransitionMatrix();
  const matrixKeys: any = new Set<any>(matrix.map((cell?: any) : any => `${cell.fromState}:${cell.transition}`));

  for (const state of states) {
    for (const event of events) {
      if (!matrixKeys.has(`${state}:${event}`)) {
        errors.push(`Missing state machine matrix cell: ${state} x ${event}`);
      }
    }
  }

  for (const terminalState of WORK_QUEUE_TERMINAL_STATES) {
    const legalTerminalExits: any = matrix.filter((cell?: any) : any => cell.fromState === terminalState && cell.legal);
    if (legalTerminalExits.length > 0) {
      errors.push(`Terminal state has legal exits: ${terminalState}`);
    }
  }

  for (const state of states) {
    if (isTerminalWorkQueueState(state)) {
      continue;
    }
    const legalOutgoing: any = matrix.filter((cell?: any) : any => cell.fromState === state && cell.legal);
    if (legalOutgoing.length === 0) {
      errors.push(`Non-terminal state has no legal outgoing transitions: ${state}`);
    }
  }

  for (const cell of matrix) {
    if (!cell.legal && cell.toStates.length !== 0) {
      errors.push(`Illegal matrix cell exposes target states: ${cell.fromState} x ${cell.transition}`);
    }
    for (const toState of cell.toStates) {
      try {
        assertLegalWorkQueueTransition({
          transition: cell.transition,
          fromState: cell.fromState,
          toState
        });
      } catch (error: any) {
        errors.push(error.message);
      }
    }
  }

  return {
    ok: errors.length === 0,
    version: WORK_QUEUE_STATE_MACHINE_PROOF_VERSION,
    matrixCells: matrix.length,
    states: states.length,
    events: events.length,
    errors,
    matrix
  };
}

export function verifyWorkQueueStateMachine() : any {
  const errors: any[] = [];
  const states: any = new Set<any>((Object.values(WORK_QUEUE_STATES) as any[]));

  for (const terminalState of WORK_QUEUE_TERMINAL_STATES) {
    if (!states.has(terminalState)) {
      errors.push(`Unknown terminal state: ${terminalState}`);
    }
  }

  for (const safeState of WORK_QUEUE_SAFE_INTERVENTION_STATES) {
    if (!states.has(safeState)) {
      errors.push(`Unknown safe intervention state: ${safeState}`);
    }
  }

  for (const [name, definition] of (Object.entries(WORK_QUEUE_TRANSITIONS) as [string, any][])) {
    if (!Array.isArray(definition.from) || definition.from.length === 0) {
      errors.push(`Transition ${name} has no from states.`);
    }
    if (!Array.isArray(definition.to) || definition.to.length === 0) {
      errors.push(`Transition ${name} has no target states.`);
    }
    for (const fromState of definition.from) {
      if (fromState !== null && !states.has(fromState)) {
        errors.push(`Transition ${name} has unknown from state ${fromState}.`);
      }
      if (isTerminalWorkQueueState(fromState)) {
        errors.push(`Transition ${name} leaves terminal state ${fromState}.`);
      }
    }
    for (const toState of definition.to) {
      if (!states.has(toState)) {
        errors.push(`Transition ${name} has unknown target state ${toState}.`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    machine: describeWorkQueueStateMachine(),
    proof: verifyWorkQueueStateMachineProof()
  };
}
