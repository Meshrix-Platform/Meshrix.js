/**
 * Generate structured documentation metadata from a state machine definition.
 *
 * @param {object} definition - State machine definition
 * @returns {object} Documentation metadata
 */
export function exportStateMachineDocs(definition?: any) : any {
  if (!definition) {
    throw new Error("Definition is required");
  }

  return {
    machineId: definition.machineId,
    entityType: definition.entityType,
    version: definition.version,
    description: definition.description || "",
    initialState: definition.initialState,
    stateCount: (definition.states || []).length,
    eventCount: (definition.events || []).length,
    matrixCellCount: (definition.totalMatrix || []).length,
    guardCount: countGuards(definition),
    invariantCount: (definition.invariants || []).length,
    proofObligationCount: (definition.proofObligations || []).length,
    states: generateStateDocs(definition),
    events: generateEventDocs(definition),
    transitionTable: generateTransitionTable(definition),
    stateDiagram: generateStateDiagramSummary(definition),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Generate documentation for each state.
 *
 * @param {object} definition
 * @returns {Array<{ id: string, isInitial: boolean, isTerminal: boolean, incomingEvents: string[], outgoingEvents: string[] }>}
 */
function generateStateDocs(definition?: any) : any {
  const states: any = definition.states || [];

  return states.map((state?: any) : any => {
    const incomingEvents: any = (definition.totalMatrix || [])
      .filter(
        (cell?: any) : any =>
          cell.to === state.id && cell.result !== "illegal_transition"
      )
      .map((cell?: any) : any => cell.event);

    const outgoingEvents: any = (definition.totalMatrix || [])
      .filter(
        (cell?: any) : any =>
          cell.from === state.id && cell.result !== "illegal_transition"
      )
      .map((cell?: any) : any => cell.event);

    return {
      id: state.id,
      isInitial: state.id === definition.initialState,
      isTerminal: !!state.terminal,
      incomingEvents: [...new Set<any>(incomingEvents)],
      outgoingEvents: [...new Set<any>(outgoingEvents)],
    };
  });
}

/**
 * Generate documentation for each event.
 *
 * @param {object} definition
 * @returns {Array<{ id: string, riskLevel: string, allowedFrom: string[], guardCount: number }>}
 */
function generateEventDocs(definition?: any) : any {
  const events: any = definition.events || [];

  return events.map((event?: any) : any => {
    const cells: any = (definition.totalMatrix || []).filter(
      (cell?: any) : any => cell.event === event.id && cell.result !== "illegal_transition"
    );

    const allowedFrom: any = cells.map((cell?: any) : any => cell.from);
    const guardCount: any = cells.reduce(
      (sum?: any, cell?: any) : any => sum + (cell.guards || []).length + (cell.requiredGuards || []).length,
      0
    );

    return {
      id: event.id,
      riskLevel: event.riskLevel || "low",
      allowedFrom: [...new Set<any>(allowedFrom)],
      guardCount,
    };
  });
}

/**
 * Generate a transition table (matrix) documentation.
 *
 * @param {object} definition
 * @returns {object} Transition table with rows and columns
 */
function generateTransitionTable(definition?: any) : any {
  const states: any = (definition.states || []).map((s?: any) : any => s.id);
  const events: any = (definition.events || []).map((e?: any) : any => e.id);
  const matrix: any = definition.totalMatrix || [];

  const rows: any = states.map((fromState?: any) : any => {
    const row: Record<string, any> = { from: fromState };
    for (const event of events) {
      const cell: any = matrix.find(
        (c?: any) : any => c.from === fromState && c.event === event
      );
      if (cell) {
        row[event] = {
          result: cell.result,
          to: cell.to || "",
          guards: cell.guards || [],
          requiredGuards: cell.requiredGuards || [],
        };
      }
    }
    return row;
  });

  return {
    states,
    events,
    rows,
    cellCount: matrix.length,
  };
}

/**
 * Generate a summary of the state diagram for documentation.
 *
 * @param {object} definition
 * @returns {object} State diagram summary
 */
function generateStateDiagramSummary(definition?: any) : any {
  const states: any = definition.states || [];

  const initialState: any = definition.initialState;
  const terminalStates: any = states.filter((s?: any) : any => s.terminal).map((s?: any) : any => s.id);

  // Extract transitions as edges
  const edges: any = (definition.totalMatrix || [])
    .filter((cell?: any) : any => cell.to && cell.result !== "illegal_transition")
    .map((cell?: any) : any => ({
      from: cell.from,
      to: cell.to,
      event: cell.event,
      result: cell.result,
    }));

  return {
    initialState,
    terminalStates,
    stateCount: states.length,
    edgeCount: edges.length,
    edges,
  };
}

/**
 * Count distinct guards used across all matrix cells.
 *
 * @param {object} definition
 * @returns {number}
 */
function countGuards(definition?: any) : any {
  const guardSet: any = new Set<any>();
  for (const cell of definition.totalMatrix || []) {
    for (const g of cell.guards || []) {
      guardSet.add(g);
    }
    for (const g of cell.requiredGuards || []) {
      guardSet.add(g);
    }
  }
  return guardSet.size;
}
