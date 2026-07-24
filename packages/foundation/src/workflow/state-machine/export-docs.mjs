/**
 * Generate structured documentation metadata from a state machine definition.
 *
 * @param {object} definition - State machine definition
 * @returns {object} Documentation metadata
 */
export function exportStateMachineDocs(definition) {
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
function generateStateDocs(definition) {
  const states = definition.states || [];

  return states.map((state) => {
    const incomingEvents = (definition.totalMatrix || [])
      .filter(
        (cell) =>
          cell.to === state.id && cell.result !== "illegal_transition"
      )
      .map((cell) => cell.event);

    const outgoingEvents = (definition.totalMatrix || [])
      .filter(
        (cell) =>
          cell.from === state.id && cell.result !== "illegal_transition"
      )
      .map((cell) => cell.event);

    return {
      id: state.id,
      isInitial: state.id === definition.initialState,
      isTerminal: !!state.terminal,
      incomingEvents: [...new Set(incomingEvents)],
      outgoingEvents: [...new Set(outgoingEvents)],
    };
  });
}

/**
 * Generate documentation for each event.
 *
 * @param {object} definition
 * @returns {Array<{ id: string, riskLevel: string, allowedFrom: string[], guardCount: number }>}
 */
function generateEventDocs(definition) {
  const events = definition.events || [];

  return events.map((event) => {
    const cells = (definition.totalMatrix || []).filter(
      (cell) => cell.event === event.id && cell.result !== "illegal_transition"
    );

    const allowedFrom = cells.map((cell) => cell.from);
    const guardCount = cells.reduce(
      (sum, cell) => sum + (cell.guards || []).length + (cell.requiredGuards || []).length,
      0
    );

    return {
      id: event.id,
      riskLevel: event.riskLevel || "low",
      allowedFrom: [...new Set(allowedFrom)],
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
function generateTransitionTable(definition) {
  const states = (definition.states || []).map((s) => s.id);
  const events = (definition.events || []).map((e) => e.id);
  const matrix = definition.totalMatrix || [];

  const rows = states.map((fromState) => {
    const row = { from: fromState };
    for (const event of events) {
      const cell = matrix.find(
        (c) => c.from === fromState && c.event === event
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
function generateStateDiagramSummary(definition) {
  const states = definition.states || [];

  const initialState = definition.initialState;
  const terminalStates = states.filter((s) => s.terminal).map((s) => s.id);

  // Extract transitions as edges
  const edges = (definition.totalMatrix || [])
    .filter((cell) => cell.to && cell.result !== "illegal_transition")
    .map((cell) => ({
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
function countGuards(definition) {
  const guardSet = new Set();
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
