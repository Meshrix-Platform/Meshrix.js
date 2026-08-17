import { createHash } from "node:crypto";
import { transition } from "./transition.ts";

type DataRecord = Record<string, unknown>;
interface StateMachineDefinition extends DataRecord {
  initialState: string;
}
interface ReplayState extends DataRecord {
  currentStatus?: string;
}
interface HistoryEntry extends DataRecord {
  event: string;
  context?: DataRecord;
}
interface ReplayOptions {
  definition?: unknown;
  initialState?: unknown;
  history?: unknown;
}
interface ReplayError {
  index: number;
  event?: string;
  fromStatus?: string;
  message: string;
  errorCode?: unknown;
}

function isRecord(value: unknown): value is DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function definitionRecord(value: unknown): StateMachineDefinition | null {
  return isRecord(value) && typeof value.initialState === "string"
    ? (value as StateMachineDefinition)
    : null;
}

function replayState(value: unknown): ReplayState | null {
  return isRecord(value) &&
    (value.currentStatus === undefined ||
      typeof value.currentStatus === "string")
    ? (value as ReplayState)
    : null;
}

function historyEntry(value: unknown): HistoryEntry | null {
  if (!isRecord(value) || typeof value.event !== "string") return null;
  if (value.context !== undefined && !isRecord(value.context)) return null;
  return value as HistoryEntry;
}

/**
 * Deterministically replay a series of transitions from an initial state.
 *
 * @param {object} options
 * @param {object} options.definition - State machine definition
 * @param {object} options.initialState - Initial state: { entityId, currentStatus }
 * @param {Array<{ event: string, context?: object }>} options.history - History of transitions
 * @returns {{ ok: boolean, states: object[], finalState: object, errors: Array<{ index: number, message: string }> }}
 */
export function replayTransitions(options: ReplayOptions) {
  const definition = definitionRecord(options.definition);
  const initialState = replayState(options.initialState);
  const history = options.history;
  if (!definition) {
    return {
      ok: false,
      states: [],
      finalState: null,
      errors: [{ index: -1, message: "Definition is required" }],
    };
  }
  if (!initialState) {
    return {
      ok: false,
      states: [],
      finalState: null,
      errors: [{ index: -1, message: "Initial state is required" }],
    };
  }
  if (!Array.isArray(history)) {
    return {
      ok: false,
      states: [],
      finalState: null,
      errors: [{ index: -1, message: "History must be an array" }],
    };
  }

  const states: ReplayState[] = [{ ...initialState }];
  const errors: ReplayError[] = [];
  let currentState: ReplayState = { ...initialState };

  for (let i = 0; i < history.length; i++) {
    const entry = historyEntry(history[i]);
    if (!entry) {
      errors.push({ index: i, message: "History entry is invalid" });
      break;
    }
    const result = transition({
      machine: definition,
      state: currentState,
      event: entry.event,
      context: entry.context || {},
    });

    if (result.ok && typeof result.toStatus === "string") {
      currentState = { ...currentState, currentStatus: result.toStatus };
      states.push({ ...currentState });
    } else {
      errors.push({
        index: i,
        event: entry.event,
        fromStatus: currentState.currentStatus,
        message: result.message || "Transition failed",
        errorCode: result.errorCode,
      });
      // Stop replay on first error
      break;
    }
  }

  return {
    ok: errors.length === 0,
    states,
    finalState: currentState,
    errors,
  };
}

/**
 * Detect tampering in a transition history by verifying hash chain integrity.
 *
 * @param {object} definition - State machine definition
 * @param {Array<{ event: string, sequenceId?: string, previousHash: string, hash: string }>} history
 * @returns {{ tampered: boolean, errors: string[], verifiedCount: number }}
 */
export function detectTampering(_definition?: unknown, history?: unknown) {
  if (!Array.isArray(history) || history.length === 0) {
    return { tampered: false, errors: [], verifiedCount: 0 };
  }

  const errors: string[] = [];
  let verifiedCount = 0;

  for (let i = 0; i < history.length; i++) {
    const entry = isRecord(history[i]) ? history[i] : {};
    const previous =
      i === 0 || !isRecord(history[i - 1]) ? null : history[i - 1];
    const expectedPreviousHash = i === 0 ? "" : String(previous?.hash || "");

    if (typeof entry.previousHash !== "string") {
      errors.push(
        `Entry ${i}: previousHash is required for hash-chain verification`,
      );
    }
    if (typeof entry.hash !== "string" || entry.hash.length === 0) {
      errors.push(`Entry ${i}: hash is required for hash-chain verification`);
      continue;
    }

    // Check previousHash link
    if (entry.previousHash !== expectedPreviousHash) {
      errors.push(
        `Entry ${i}: previousHash mismatch — expected ${expectedPreviousHash}, got ${entry.previousHash}`,
      );
    }

    // Verify the entry hash
    const entryCanonical = JSON.stringify({
      event: entry.event,
      previousHash: entry.previousHash,
      context: entry.context || {},
    });
    const computedHash = createHash("sha256")
      .update(entryCanonical)
      .digest("hex");
    if (entry.hash !== computedHash) {
      errors.push(`Entry ${i}: hash mismatch — tampering detected`);
    } else if (entry.previousHash === expectedPreviousHash) {
      verifiedCount += 1;
    }
  }

  return {
    tampered: errors.length > 0,
    errors,
    verifiedCount,
  };
}

/**
 * Verify a transition sequence against a definition, checking that
 * each transition from each state is valid per the totalMatrix.
 *
 * @param {object} definition - State machine definition
 * @param {Array<{ event: string, context?: object }>} history - Transition history
 * @returns {{ valid: boolean, errors: string[], stateSequence: string[] }}
 */
export function verifyTransitionSequence(
  definitionValue?: unknown,
  history?: unknown,
) {
  const definition = definitionRecord(definitionValue);
  if (!definition || !Array.isArray(history)) {
    return {
      valid: false,
      errors: ["Definition and history are required"],
      stateSequence: [],
    };
  }

  const errors: string[] = [];
  const stateSequence: string[] = [];
  let currentStatus = definition.initialState;
  stateSequence.push(currentStatus);

  for (let i = 0; i < history.length; i++) {
    const entry = historyEntry(history[i]);
    if (!entry) {
      errors.push(`Step ${i}: History entry is invalid`);
      break;
    }
    const { event, context = {} } = entry;
    const result = transition({
      machine: definition,
      state: { entityId: "sequence-verification", currentStatus },
      event,
      context,
    });

    if (!result.ok) {
      errors.push(
        `Step ${i}: ${result.message || `Transition rejected for ${currentStatus} -> ${event}`}`,
      );
      break;
    }

    if (typeof result.toStatus === "string") {
      currentStatus = result.toStatus;
    }
    stateSequence.push(currentStatus);
  }

  return {
    valid: errors.length === 0,
    errors,
    stateSequence,
  };
}
