import { evaluateGuardSet } from "../guards/guard-evaluator.ts";
import type {
  GuardEvaluator, GuardResult, JsonRecord, StateMachineDefinition, TransitionCell, TransitionInput
} from "./state-machine-result-types.ts";

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
export interface SelectionResult extends JsonRecord {
  ok: boolean; cell?: TransitionCell; guardResults?: GuardResult[]; failedGuards?: string[];
  blockedBy?: string; errorCode?: string; message?: string; allowedEvents?: string[]; ambiguousCells?: string[];
}
interface CellGuardResult { ok: boolean; guardResults: GuardResult[]; failedGuards: string[]; blockedBy?: "guard" }
interface GuardClassification { unknown: string[]; missingContext: string[]; blocked: string[] }
interface EvaluatedCell { cellId: string; guards?: string[]; requiredGuards?: string[]; result: CellGuardResult }

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function definitionFrom(value: unknown): StateMachineDefinition | null {
  const candidate = record(value);
  if (!candidate || !Array.isArray(candidate.totalMatrix)) return null;
  if (!candidate.totalMatrix.every((value) => {
    const cell = record(value);
    return cell && typeof cell.from === "string" && typeof cell.event === "string" && typeof cell.result === "string";
  })) return null;
  return candidate as unknown as StateMachineDefinition;
}

function inputFrom(value: unknown): TransitionInput | null {
  const candidate = record(value);
  if (!candidate || typeof candidate.currentStatus !== "string" || typeof candidate.eventType !== "string") return null;
  return candidate as unknown as TransitionInput;
}

function guardResultsFrom(value: unknown): GuardResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const result = record(item);
    return result && typeof result.guardId === "string" && typeof result.ok === "boolean"
      ? [{ ...result, guardId: result.guardId, ok: result.ok, ...(typeof result.reason === "string" ? { reason: result.reason } : {}) }]
      : [];
  });
}

export function selectTransitionCell(definitionValue?: unknown, inputValue?: unknown, options: { guardEvaluator?: GuardEvaluator } = {}): SelectionResult {
  const definition = definitionFrom(definitionValue);
  const input = inputFrom(inputValue);
  if (!definition || !input) return { ok: false, errorCode: "STATE_MACHINE_INVALID_INPUT", message: "State machine definition or transition input is invalid." };
  const { currentStatus, eventType } = input;
  const guardEvaluator = options.guardEvaluator;

  const matchingCells = definition.totalMatrix.filter(
    (cell) => cell.from === currentStatus && cell.event === eventType
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
    const cell = matchingCells[0];
    if (cell.result === 'illegal_transition') {
      return {
        ok: false,
        cell,
        errorCode: cell.errorCode || "STATE_MACHINE_TRANSITION_NOT_ALLOWED",
        message: `Transition illegal: ${currentStatus} -> ${eventType}`,
        allowedEvents: listAllowedEventsInner(definition, currentStatus)
      };
    }

    const guardIds = [...(cell.guards || []), ...(cell.requiredGuards || [])];
    if (guardIds.length > 0) {
      const guardResults = evaluateCellGuards(cell, input, guardEvaluator);
      if (!guardResults.ok) {
        return { ...guardResults, errorCode: classifyGuardFailureForCode(guardResults), allowedEvents: listAllowedEventsInner(definition, currentStatus) };
      }
      return { ok: true, cell, guardResults: guardResults.guardResults };
    }

    return { ok: true, cell, guardResults: [] };
  }

  // Multi-cell disambiguation
  const eligibleCells = matchingCells.filter((cell) => cell.result !== 'illegal_transition');

  if (eligibleCells.length === 0) {
    return {
      ok: false,
      errorCode: "STATE_MACHINE_TRANSITION_NOT_ALLOWED",
      message: `All transitions for ${currentStatus} -> ${eventType} are illegal.`,
      allowedEvents: listAllowedEventsInner(definition, currentStatus)
    };
  }

  const guardedCells = eligibleCells.filter((cell) =>
    (cell.guards && cell.guards.length > 0) || (cell.requiredGuards && cell.requiredGuards.length > 0)
  );
  const unguardedCells = eligibleCells.filter((cell) =>
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

  const passedCells: TransitionCell[] = [];
  const allGuardResults: EvaluatedCell[] = [];

  for (const cell of eligibleCells) {
    const gr = evaluateCellGuards(cell, input, guardEvaluator);
    allGuardResults.push({ cellId: `${cell.from}-${cell.event}-${cell.to || 'self'}`, guards: cell.guards, requiredGuards: cell.requiredGuards, result: gr });
    if (gr.ok) {
      passedCells.push(cell);
    }
  }

  if (passedCells.length === 0) {
    const allFailedGuards: string[] = [];
    for (const entry of allGuardResults) {
      allFailedGuards.push(...(entry.result.failedGuards || []));
    }
    const flattenedGuardResults = allGuardResults.flatMap((entry) => entry.result.guardResults);
    const classification = classifyFailedGuardsForSelect(allFailedGuards, flattenedGuardResults);
    if (classification.unknown.length > 0) {
      return {
        ok: false,
        errorCode: "STATE_MACHINE_GUARD_UNKNOWN",
        message: `Unknown guard(s): ${classification.unknown.join(', ')}.`,
        blockedBy: "guard",
        failedGuards: classification.unknown,
        allowedEvents: listAllowedEventsInner(definition, currentStatus),
        guardResults: guardSummaryInner(flattenedGuardResults)
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
        guardResults: guardSummaryInner(flattenedGuardResults)
      };
    }
    return {
      ok: false,
      errorCode: "STATE_MACHINE_GUARD_BLOCKED",
      message: `All matching cells blocked by guards: ${allFailedGuards.join(', ')}.`,
      blockedBy: "guard",
      failedGuards: allFailedGuards,
      allowedEvents: listAllowedEventsInner(definition, currentStatus),
      guardResults: guardSummaryInner(flattenedGuardResults)
    };
  }

  if (passedCells.length > 1) {
    return {
      ok: false,
      errorCode: "STATE_MACHINE_AMBIGUOUS_TRANSITION",
      message: `Ambiguous transition: ${passedCells.length} guarded cells pass for ${currentStatus} -> ${eventType}.`,
      ambiguousCells: passedCells.map((cell) => `${cell.from}-${cell.event}-${cell.to || 'self'}`)
    };
  }

  return { ok: true, cell: passedCells[0], guardResults: allGuardResults.filter((entry) => entry.result.ok).flatMap((entry) => entry.result.guardResults) };
}

function evaluateCellGuards(cell: TransitionCell, input: TransitionInput, guardEvaluator?: GuardEvaluator): CellGuardResult {
  const guardIds = [...(cell.guards || []), ...(cell.requiredGuards || [])];
  if (guardIds.length === 0) {
    return { ok: true, guardResults: [], failedGuards: [], blockedBy: undefined };
  }

  const context = input.guardContext || {};
  let guardResults: GuardResult[];
  if (guardEvaluator) {
    guardResults = guardResultsFrom(guardEvaluator(guardIds, context));
  } else {
    guardResults = guardResultsFrom(evaluateGuardSet(guardIds, context));
  }

  const failed = guardResults.filter((result) => !result.ok);
  return {
    ok: failed.length === 0,
    guardResults,
    failedGuards: failed.map((result) => result.guardId),
    blockedBy: failed.length > 0 ? "guard" : undefined
  };
}

function classifyFailedGuardsForSelect(_failedGuardIds: string[] = [], guardResults: GuardResult[] = []): GuardClassification {
  const result: GuardClassification = { unknown: [], missingContext: [], blocked: [] };
  for (const g of guardResults) {
    if (g.ok) continue;
    if (g.reason === 'unknown_guard') result.unknown.push(g.guardId);
    else if (g.reason === 'missing_context') result.missingContext.push(g.guardId);
    else result.blocked.push(g.guardId);
  }
  return result;
}

function classifyGuardFailureForCode(guardResult?: CellGuardResult): string {
  if (!guardResult || !guardResult.guardResults) return "STATE_MACHINE_GUARD_BLOCKED";
  const guardResults = guardResult.guardResults || [];
  for (const g of guardResults) {
    if (g.ok) continue;
    if (g.reason === 'unknown_guard' || g.reason === 'no_runtime_predicate') return "STATE_MACHINE_GUARD_UNKNOWN";
    if (g.reason === 'missing_context') return "STATE_MACHINE_GUARD_CONTEXT_MISSING";
  }
  return "STATE_MACHINE_GUARD_BLOCKED";
}

function guardSummaryInner(guardResults: GuardResult[] = []): GuardResult[] | undefined {
  if (!guardResults || guardResults.length === 0) return undefined;
  return guardResults.map((result) => ({
    guardId: result.guardId,
    ok: result.ok,
    reason: result.reason
  }));
}

function listAllowedEventsInner(definition: StateMachineDefinition, currentStatus: string): string[] {
  return definition.totalMatrix
    .filter((cell) => cell.from === currentStatus && cell.result !== 'illegal_transition')
    .map((cell) => cell.event);
}

/**
 * Evaluate guards for a specific transition without executing it.
 * Uses selectTransitionCell() for consistent selection behaviour.
 *
 * @returns {{ ok, guardResults, failedGuards, blockedBy, reason, message }}
 */
export function evaluateTransitionGuardsForValidatedDefinition(definition: unknown, fromStatus: unknown, eventType: unknown, context: JsonRecord = {}) {
  const input: JsonRecord = {
    currentStatus: fromStatus,
    eventType,
    guardContext: context
  };

  const result = selectTransitionCell(definition, input);

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
