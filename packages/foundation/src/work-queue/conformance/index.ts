import {
  assertLegalWorkQueueTransition,
  isLegalWorkQueueTransition,
  verifyWorkQueueStateMachineProof,
  verifyWorkQueueStateMachine,
  WORK_QUEUE_STATES
} from "../../workflow/state-machine/work-queue/state-machine.ts";
import { createFixedQueueTimeSource } from "../time-source.ts";
import { createQueueIdentityGenerator } from "../identity.ts";
import {
  validateQueueBackgroundWriteAspectShape,
  validateWorkQueueStoreAdapterShape
} from "../store-adapter-contract.ts";

interface ConformanceDetails { [key: string]: unknown }
interface ConformanceCheck {
  id: string;
  ok: boolean;
  details?: ConformanceDetails;
  error?: string;
}
interface StateMachineProof {
  ok: boolean; errors: string[]; version: string; matrixCells: number; states: number; events: number;
}
interface StateMachineVerification {
  ok: boolean; errors: string[]; machine: { states: string[]; transitions: object }; proof: StateMachineProof;
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProof(value: unknown): value is StateMachineProof {
  return isRecord(value) && typeof value.ok === "boolean" && Array.isArray(value.errors) && value.errors.every((entry) => typeof entry === "string") &&
    typeof value.version === "string" && typeof value.matrixCells === "number" && typeof value.states === "number" && typeof value.events === "number";
}

function isVerification(value: unknown): value is StateMachineVerification {
  return isRecord(value) && typeof value.ok === "boolean" && Array.isArray(value.errors) &&
    isRecord(value.machine) && Array.isArray(value.machine.states) && value.machine.states.every((entry) => typeof entry === "string") &&
    isRecord(value.machine.transitions) && isProof(value.proof);
}

function makeCheck(id: string, fn: () => ConformanceDetails | void): ConformanceCheck {
  try {
    const details = fn();
    return { id, ok: true, details: details || {} };
  } catch (error: unknown) {
    return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function deterministicRandomBytes(length: number): Buffer {
  return Buffer.alloc(length, 0x7a);
}

export function runWorkQueueConformanceSuite({
  storeAdapter = null,
  backgroundWriteAspect = null
}: { storeAdapter?: object | null; backgroundWriteAspect?: object | null } = {}) {
  const checks: ConformanceCheck[] = [];

  checks.push(makeCheck("state-machine-definition", () => {
    const result = verifyWorkQueueStateMachine();
    if (!isVerification(result)) throw new Error("Work Queue state-machine verification returned a malformed result.");
    if (!result.ok) {
      throw new Error(result.errors.join("; "));
    }
    if (!result.proof.ok) {
      throw new Error(result.proof.errors.join("; "));
    }
    return {
      states: result.machine.states.length,
      transitions: Object.keys(result.machine.transitions).length,
      proofMatrixCells: result.proof.matrixCells
    };
  }));

  checks.push(makeCheck("state-machine-total-matrix-proof", () => {
    const proof = verifyWorkQueueStateMachineProof();
    if (!isProof(proof)) throw new Error("Work Queue state-machine proof returned a malformed result.");
    if (!proof.ok) {
      throw new Error(proof.errors.join("; "));
    }
    return {
      version: proof.version,
      matrixCells: proof.matrixCells,
      states: proof.states,
      events: proof.events
    };
  }));

  checks.push(makeCheck("legal-transition-table", () => {
    assertLegalWorkQueueTransition({ transition: "enqueue", fromState: null, toState: WORK_QUEUE_STATES.QUEUED });
    assertLegalWorkQueueTransition({ transition: "claim", fromState: WORK_QUEUE_STATES.QUEUED, toState: WORK_QUEUE_STATES.RUNNING });
    assertLegalWorkQueueTransition({ transition: "complete", fromState: WORK_QUEUE_STATES.RUNNING, toState: WORK_QUEUE_STATES.COMPLETED });
    assertLegalWorkQueueTransition({ transition: "cancel", fromState: WORK_QUEUE_STATES.QUEUED, toState: WORK_QUEUE_STATES.CANCELLED });
    assertLegalWorkQueueTransition({ transition: "cancel", fromState: WORK_QUEUE_STATES.RETRY_WAIT, toState: WORK_QUEUE_STATES.CANCELLED });
    assertLegalWorkQueueTransition({ transition: "cancel", fromState: WORK_QUEUE_STATES.RUNNING, toState: WORK_QUEUE_STATES.CANCELLED });
    assertLegalWorkQueueTransition({ transition: "cancel", fromState: WORK_QUEUE_STATES.RECOVERED, toState: WORK_QUEUE_STATES.CANCELLED });
    assertLegalWorkQueueTransition({ transition: "fail", fromState: WORK_QUEUE_STATES.RUNNING, toState: WORK_QUEUE_STATES.FAILED });
  }));

  checks.push(makeCheck("illegal-transition-fail-closed", () => {
    if (isLegalWorkQueueTransition({ transition: "complete", fromState: WORK_QUEUE_STATES.QUEUED, toState: WORK_QUEUE_STATES.COMPLETED })) {
      throw new Error("complete from queued must be illegal.");
    }
    try {
      assertLegalWorkQueueTransition({ transition: "claim", fromState: WORK_QUEUE_STATES.COMPLETED, toState: WORK_QUEUE_STATES.RUNNING });
    } catch {
      return { illegalRejected: true };
    }
    throw new Error("claim from completed should fail closed.");
  }));

  checks.push(makeCheck("uuid-v7-identity-generator", () => {
    const timeSource = createFixedQueueTimeSource(1_718_400_000_000);
    const generator = createQueueIdentityGenerator({ timeSource, randomBytesFn: deterministicRandomBytes });
    const uuid = generator.uuid();
    if (uuid[14] !== "7") {
      throw new Error(`Expected UUIDv7 version nibble, got ${uuid}`);
    }
    if (!["8", "9", "a", "b"].includes(uuid[19])) {
      throw new Error(`Expected UUID RFC variant nibble, got ${uuid}`);
    }
    return { workItemId: generator.workItemId() };
  }));

  checks.push(makeCheck("store-adapter-shape", () => {
    if (!storeAdapter) {
      return { skipped: true, reason: "No concrete adapter supplied." };
    }
    const result: { ok: boolean; errors: string[] } = validateWorkQueueStoreAdapterShape(storeAdapter);
    if (!result.ok) {
      throw new Error(result.errors.join("; "));
    }
  }));

  checks.push(makeCheck("background-write-aspect-shape", () => {
    if (!backgroundWriteAspect) {
      return { skipped: true, reason: "No concrete aspect supplied." };
    }
    const result: { ok: boolean; errors: string[] } = validateQueueBackgroundWriteAspectShape(backgroundWriteAspect);
    if (!result.ok) {
      throw new Error(result.errors.join("; "));
    }
  }));

  return {
    ok: checks.every((check) => check.ok),
    checks
  };
}
