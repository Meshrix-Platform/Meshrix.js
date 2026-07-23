import { createHash } from "node:crypto";
import { transition } from "./transition.mjs";

/**
 * Deterministically replay a series of transitions from an initial state.
 *
 * @param {object} options
 * @param {object} options.definition - State machine definition
 * @param {object} options.initialState - Initial state: { entityId, currentStatus }
 * @param {Array<{ event: string, context?: object }>} options.history - History of transitions
 * @returns {{ ok: boolean, states: object[], finalState: object, errors: Array<{ index: number, message: string }> }}
 */
export function replayTransitions({ definition, initialState, history }) {
  if (!definition) {
    return { ok: false, states: [], finalState: null, errors: [{ index: -1, message: "Definition is required" }] };
  }
  if (!initialState) {
    return { ok: false, states: [], finalState: null, errors: [{ index: -1, message: "Initial state is required" }] };
  }
  if (!Array.isArray(history)) {
    return { ok: false, states: [], finalState: null, errors: [{ index: -1, message: "History must be an array" }] };
  }

  const states = [{ ...initialState }];
  const errors = [];
  let currentState = { ...initialState };

  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    const result = transition({
      machine: definition,
      state: currentState,
      event: entry.event,
      context: entry.context || {},
    });

    if (result.ok && result.toStatus) {
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
export function detectTampering(definition, history) {
  if (!Array.isArray(history) || history.length === 0) {
    return { tampered: false, errors: [], verifiedCount: 0 };
  }

  const errors = [];
  let verifiedCount = 0;

  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    const expectedPreviousHash = i === 0 ? "" : history[i - 1].hash;

    if (typeof entry.previousHash !== "string") {
      errors.push(`Entry ${i}: previousHash is required for hash-chain verification`);
    }
    if (typeof entry.hash !== "string" || entry.hash.length === 0) {
      errors.push(`Entry ${i}: hash is required for hash-chain verification`);
      continue;
    }

    // Check previousHash link
    if (entry.previousHash !== expectedPreviousHash) {
      errors.push(`Entry ${i}: previousHash mismatch — expected ${expectedPreviousHash}, got ${entry.previousHash}`);
    }

    // Verify the entry hash
    const entryCanonical = JSON.stringify({
      event: entry.event,
      previousHash: entry.previousHash,
      context: entry.context || {},
    });
    const computedHash = createHash("sha256").update(entryCanonical).digest("hex");
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
export function verifyTransitionSequence(definition, history) {
  if (!definition || !history) {
    return { valid: false, errors: ["Definition and history are required"], stateSequence: [] };
  }

  const errors = [];
  const stateSequence = [];
  let currentStatus = definition.initialState;
  stateSequence.push(currentStatus);

  for (let i = 0; i < history.length; i++) {
    const { event, context = {} } = history[i];
    const result = transition({
      machine: definition,
      state: { entityId: "sequence-verification", currentStatus },
      event,
      context,
    });

    if (!result.ok) {
      errors.push(`Step ${i}: ${result.message || `Transition rejected for ${currentStatus} -> ${event}`}`);
      break;
    }

    if (result.toStatus) {
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
