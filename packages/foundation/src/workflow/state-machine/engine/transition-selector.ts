import { evaluateGuardSet } from "../guards/guard-evaluator.ts";

export { ERROR_CODES } from "./state-machine-errors.ts";

/**
 * Select a transition cell from matching cells, performing guard evaluation
 * and multi-cell disambiguation. Used by both transitionState() and
 * evaluateTransitionGuards().
 *
 * @param {object} definition - state machine definition
 * @param {object} input - transition input
 * @param {object} [options] - { guardEvaluator? }
 * @returns {{ ok, cell, guardResults, failedGuards, blockedBy, errorCode, message, allowedEvents, ambiguousCells }}
 */
export function selectTransitionCell(definition?: any, input?: any, options: Record<string, any> = {}) : any {
  const { entityId, currentStatus, eventType, actor, reason, metadata, operationId, traceId, auditId, checkpointNodeId, policyDecisionId, approvalId, now } = input;
  const guardEvaluator: any = options.guardEvaluator;

  const matchingCells: any = definition.totalMatrix.filter(
    (cell?: any) : any => cell.from === currentStatus && cell.event === eventType
  );

  if (matchingCells.length === 0) {
    return {
      ok: false,
      errorCode: "STATE_MACHINE_TRANSITION_NOT_ALLOWED",
      message: `Transition not defined for ${currentStatus} -> ${eventType}`,
      allowedEvents: listAllowedEventsInner(definition, currentStatus)
    };
  }

  if (matchingCells.length === 1) {
    const cell: any = matchingCells[0];
    if (cell.result === 'illegal_transition') {
      return {
        ok: false,
        cell,
        errorCode: cell.errorCode || "STATE_MACHINE_TRANSITION_NOT_ALLOWED",
        message: `Transition illegal: ${currentStatus} -> ${eventType}`,
        allowedEvents: listAllowedEventsInner(definition, currentStatus)
      };
    }

    const guardIds: any[] = [...(cell.guards || []), ...(cell.requiredGuards || [])];
    if (guardIds.length > 0) {
      const guardResults: any = evaluateCellGuards(cell, input, guardEvaluator);
      if (!guardResults.ok) {
        return { ...guardResults, errorCode: classifyGuardFailureForCode(guardResults), allowedEvents: listAllowedEventsInner(definition, currentStatus) };
      }
      return { ok: true, cell, guardResults: guardResults.guardResults };
    }

    return { ok: true, cell, guardResults: [] };
  }

  // Multi-cell disambiguation
  const eligibleCells: any = matchingCells.filter((cell?: any) : any => cell.result !== 'illegal_transition');

  if (eligibleCells.length === 0) {
    return {
      ok: false,
      errorCode: "STATE_MACHINE_TRANSITION_NOT_ALLOWED",
      message: `All transitions for ${currentStatus} -> ${eventType} are illegal.`,
      allowedEvents: listAllowedEventsInner(definition, currentStatus)
    };
  }

  const guardedCells: any = eligibleCells.filter((cell?: any) : any =>
    (cell.guards && cell.guards.length > 0) || (cell.requiredGuards && cell.requiredGuards.length > 0)
  );
  const unguardedCells: any = eligibleCells.filter((cell?: any) : any =>
    (!cell.guards || cell.guards.length === 0) && (!cell.requiredGuards || cell.requiredGuards.length === 0)
  );

  if (unguardedCells.length > 1) {
    return {
      ok: false,
      errorCode: "STATE_MACHINE_AMBIGUOUS_TRANSITION",
      message: `Ambiguous transition: ${unguardedCells.length} unguarded cells match ${currentStatus} -> ${eventType}.`
    };
  }

  if (unguardedCells.length === 1 && guardedCells.length === 0) {
    return { ok: true, cell: unguardedCells[0], guardResults: [] };
  }

  let passedCells: any[] = [];
  const allGuardResults: any[] = [];

  for (const cell of eligibleCells) {
    const gr: any = evaluateCellGuards(cell, input, guardEvaluator);
    allGuardResults.push({ cellId: `${cell.from}-${cell.event}-${cell.to || 'self'}`, guards: cell.guards, requiredGuards: cell.requiredGuards, result: gr });
    if (gr.ok) {
      passedCells.push(cell);
    }
  }

  if (passedCells.length === 0) {
    const allFailedGuards: any[] = [];
    for (const entry of allGuardResults) {
      allFailedGuards.push(...(entry.result.failedGuards || []));
    }
    const classification: any = classifyFailedGuardsForSelect(allFailedGuards, allGuardResults.flatMap((g?: any) : any => g.result.guardResults || []));
    if (classification.unknown.length > 0) {
      return {
        ok: false,
        errorCode: "STATE_MACHINE_GUARD_UNKNOWN",
        message: `Unknown guard(s): ${classification.unknown.join(', ')}.`,
        blockedBy: "guard",
        failedGuards: classification.unknown,
        allowedEvents: listAllowedEventsInner(definition, currentStatus),
        guardResults: guardSummaryInner(allGuardResults.flatMap((g?: any) : any => g.result.guardResults || []))
      };
    }
    if (classification.missingContext.length > 0) {
      return {
        ok: false,
        errorCode: "STATE_MACHINE_GUARD_CONTEXT_MISSING",
        message: `Missing guard context for: ${classification.missingContext.join(', ')}.`,
        blockedBy: "guard",
        failedGuards: classification.missingContext,
        allowedEvents: listAllowedEventsInner(definition, currentStatus),
        guardResults: guardSummaryInner(allGuardResults.flatMap((g?: any) : any => g.result.guardResults || []))
      };
    }
    return {
      ok: false,
      errorCode: "STATE_MACHINE_GUARD_BLOCKED",
      message: `All matching cells blocked by guards: ${allFailedGuards.join(', ')}.`,
      blockedBy: "guard",
      failedGuards: allFailedGuards,
      allowedEvents: listAllowedEventsInner(definition, currentStatus),
      guardResults: guardSummaryInner(allGuardResults.flatMap((g?: any) : any => g.result.guardResults || []))
    };
  }

  if (passedCells.length > 1) {
    return {
      ok: false,
      errorCode: "STATE_MACHINE_AMBIGUOUS_TRANSITION",
      message: `Ambiguous transition: ${passedCells.length} guarded cells pass for ${currentStatus} -> ${eventType}.`,
      ambiguousCells: passedCells.map((c?: any) : any => `${c.from}-${c.event}-${c.to || 'self'}`)
    };
  }

  return { ok: true, cell: passedCells[0], guardResults: allGuardResults.filter((g?: any) : any => g.result.ok).flatMap((g?: any) : any => g.result.guardResults || []) };
}

function evaluateCellGuards(cell?: any, input?: any, guardEvaluator?: any) : any {
  const guardIds: any[] = [...(cell.guards || []), ...(cell.requiredGuards || [])];
  if (guardIds.length === 0) {
    return { ok: true, guardResults: [], failedGuards: [], blockedBy: undefined };
  }

  const context: any = input.guardContext || {};
  let guardResults: any;
  if (guardEvaluator) {
    guardResults = guardEvaluator(guardIds, context);
  } else {
    guardResults = evaluateGuardSet(guardIds, context);
  }

  const failed: any = guardResults.filter((r?: any) : any => !r.ok);
  return {
    ok: failed.length === 0,
    guardResults,
    failedGuards: failed.map((r?: any) : any => r.guardId),
    blockedBy: failed.length > 0 ? "guard" : undefined
  };
}

function classifyFailedGuardsForSelect(failedGuardIds?: any, guardResults?: any) : any {
  const result: Record<string, any> = { unknown: [], missingContext: [], blocked: [] };
  for (const g of guardResults || []) {
    if (g.ok) continue;
    if (g.reason === 'unknown_guard') result.unknown.push(g.guardId);
    else if (g.reason === 'missing_context') result.missingContext.push(g.guardId);
    else result.blocked.push(g.guardId);
  }
  return result;
}

function classifyGuardFailureForCode(guardResult?: any) : any {
  if (!guardResult || !guardResult.guardResults) return "STATE_MACHINE_GUARD_BLOCKED";
  const guardResults: any = guardResult.guardResults || [];
  for (const g of guardResults) {
    if (g.ok) continue;
    if (g.reason === 'unknown_guard' || g.reason === 'no_runtime_predicate') return "STATE_MACHINE_GUARD_UNKNOWN";
    if (g.reason === 'missing_context') return "STATE_MACHINE_GUARD_CONTEXT_MISSING";
  }
  return "STATE_MACHINE_GUARD_BLOCKED";
}

function guardSummaryInner(guardResults?: any) : any {
  if (!guardResults || guardResults.length === 0) return undefined;
  return guardResults.map((r?: any) : any => ({
    guardId: r.guardId,
    ok: r.ok,
    reason: r.reason
  }));
}

function listAllowedEventsInner(definition?: any, currentStatus?: any) : any {
  return definition.totalMatrix
    .filter((cell?: any) : any => cell.from === currentStatus && cell.result !== 'illegal_transition')
    .map((cell?: any) : any => cell.event);
}

/**
 * Evaluate guards for a specific transition without executing it.
 * Uses selectTransitionCell() for consistent selection behaviour.
 *
 * @returns {{ ok, guardResults, failedGuards, blockedBy, reason, message }}
 */
export function evaluateTransitionGuardsForValidatedDefinition(definition?: any, fromStatus?: any, eventType?: any, context: Record<string, any> = {}) : any {
  const input: Record<string, any> = {
    currentStatus: fromStatus,
    eventType,
    guardContext: context
  };

  const result: any = selectTransitionCell(definition, input);

  if (!result.ok) {
    return {
      ok: false,
      guardResults: result.guardResults,
      failedGuards: result.failedGuards,
      blockedBy: result.blockedBy,
      reason: result.errorCode
        ? result.errorCode.replace(/^STATE_MACHINE_/, '').toLowerCase()
        : "select_failed",
      message: result.message
    };
  }

  return {
    ok: true,
    guardResults: result.guardResults || []
  };
}
