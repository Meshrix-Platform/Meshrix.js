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

function makeCheck(id?: any, fn?: any) : any {
  try {
    const details: any = fn();
    return { id, ok: true, details: details || {} };
  } catch (error: any) {
    return { id, ok: false, error: error.message };
  }
}

function deterministicRandomBytes(length?: any) : any {
  return Buffer.alloc(length, 0x7a);
}

export function runWorkQueueConformanceSuite({
  storeAdapter = null,
  backgroundWriteAspect = null
}: Record<string, any> = {}) : any {
  const checks: any[] = [];

  checks.push(makeCheck("state-machine-definition", () : any => {
    const result: any = verifyWorkQueueStateMachine();
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

  checks.push(makeCheck("state-machine-total-matrix-proof", () : any => {
    const proof: any = verifyWorkQueueStateMachineProof();
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

  checks.push(makeCheck("legal-transition-table", () : any => {
    assertLegalWorkQueueTransition({ transition: "enqueue", fromState: null, toState: WORK_QUEUE_STATES.QUEUED });
    assertLegalWorkQueueTransition({ transition: "claim", fromState: WORK_QUEUE_STATES.QUEUED, toState: WORK_QUEUE_STATES.RUNNING });
    assertLegalWorkQueueTransition({ transition: "complete", fromState: WORK_QUEUE_STATES.RUNNING, toState: WORK_QUEUE_STATES.COMPLETED });
    assertLegalWorkQueueTransition({ transition: "cancel", fromState: WORK_QUEUE_STATES.QUEUED, toState: WORK_QUEUE_STATES.CANCELLED });
    assertLegalWorkQueueTransition({ transition: "cancel", fromState: WORK_QUEUE_STATES.RETRY_WAIT, toState: WORK_QUEUE_STATES.CANCELLED });
    assertLegalWorkQueueTransition({ transition: "cancel", fromState: WORK_QUEUE_STATES.RUNNING, toState: WORK_QUEUE_STATES.CANCELLED });
    assertLegalWorkQueueTransition({ transition: "cancel", fromState: WORK_QUEUE_STATES.RECOVERED, toState: WORK_QUEUE_STATES.CANCELLED });
    assertLegalWorkQueueTransition({ transition: "fail", fromState: WORK_QUEUE_STATES.RUNNING, toState: WORK_QUEUE_STATES.FAILED });
  }));

  checks.push(makeCheck("illegal-transition-fail-closed", () : any => {
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

  checks.push(makeCheck("uuid-v7-identity-generator", () : any => {
    const timeSource: any = createFixedQueueTimeSource(1_718_400_000_000);
    const generator: any = createQueueIdentityGenerator({ timeSource, randomBytesFn: deterministicRandomBytes });
    const uuid: any = generator.uuid();
    if (uuid[14] !== "7") {
      throw new Error(`Expected UUIDv7 version nibble, got ${uuid}`);
    }
    if (!["8", "9", "a", "b"].includes(uuid[19])) {
      throw new Error(`Expected UUID RFC variant nibble, got ${uuid}`);
    }
    return { workItemId: generator.workItemId() };
  }));

  checks.push(makeCheck("store-adapter-shape", () : any => {
    if (!storeAdapter) {
      return { skipped: true, reason: "No concrete adapter supplied." };
    }
    const result: any = validateWorkQueueStoreAdapterShape(storeAdapter);
    if (!result.ok) {
      throw new Error(result.errors.join("; "));
    }
  }));

  checks.push(makeCheck("background-write-aspect-shape", () : any => {
    if (!backgroundWriteAspect) {
      return { skipped: true, reason: "No concrete aspect supplied." };
    }
    const result: any = validateQueueBackgroundWriteAspectShape(backgroundWriteAspect);
    if (!result.ok) {
      throw new Error(result.errors.join("; "));
    }
  }));

  return {
    ok: checks.every((check?: any) : any => check.ok),
    checks
  };
}
