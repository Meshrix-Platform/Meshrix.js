import { describe, it, expect } from "vitest";
import {
  validateStateMachineDefinition,
  assertStateMachineDefinition,
  transitionState,
  listAllowedEvents,
  isTerminalStatus,
  assertTransitionAllowed,
  validateExecutableStateMachineDefinition,
  compileStateMachineDefinition,
  evaluateTransitionGuards,
  ERROR_CODES,
  StateMachineError
} from "../../../packages/foundation/src/workflow/state-machine/engine/state-machine-core.ts";

const mockDefinition: Record<string, any> = {
  machineId: "fixture.strategy.lifecycle",
  entityType: "test_entity",
  version: "1.0.0",
  description: "Test lifecycle state machine for unit tests.",
  initialState: "submitted",
  states: [
    { "id": "submitted" },
    { "id": "approved" },
    { "id": "archived", "terminal": true }
  ],
  events: [
    { "id": "test.submit" },
    { "id": "test.approve" },
    { "id":     "test.archive", "riskLevel": "high" }
  ],
    totalMatrix: [
    { "from": "submitted", "event": "test.submit", "result": "ignored_idempotent_event" },
    { "from": "submitted", "event": "test.approve", "result": "legal_transition", "to": "approved" },
    { "from": "submitted", "event": "test.archive", "result": "illegal_transition", "errorCode": "ARCHIVE_BEFORE_APPROVAL" },

    { "from": "approved", "event": "test.submit", "result": "illegal_transition", "errorCode": "ALREADY_APPROVED" },
    { "from": "approved", "event": "test.approve", "result": "ignored_idempotent_event" },
    { "from": "approved", "event": "test.archive", "result": "requires_policy", "to": "archived", "guards": ["policyAllowed"] },

    { "from": "archived", "event": "test.submit", "result": "illegal_transition", "errorCode": "ALREADY_ARCHIVED" },
    { "from": "archived", "event": "test.approve", "result": "illegal_transition", "errorCode": "ALREADY_ARCHIVED" },
    { "from": "archived", "event": "test.archive", "result": "ignored_idempotent_event" }
  ],
  invariants: ["SM-GOV-001"],
  proofObligations: [],
  proofMappings: []
};

const multiCellDefinition: Record<string, any> = {
  machineId: "fixture.strategy.multi-cell",
  entityType: "test_entity",
  version: "1.0.0",
  description: "Multi-cell test state machine for disambiguation tests.",
  initialState: "start",
  states: [
    { "id": "start" },
    { "id": "end_a", "terminal": true },
    { "id": "end_b", "terminal": true }
  ],
  events: [
    { "id": "go", "riskLevel": "high" }
  ],
  totalMatrix: [
    { "from": "start", "event": "go", "result": "illegal_transition", "errorCode": "ILLEGAL_GO" },
    { "from": "start", "event": "go", "result": "legal_transition", "to": "end_a", "guards": ["policyAllowed"] },
    { "from": "start", "event": "go", "result": "legal_transition", "to": "end_b", "guards": ["approvalApproved"] },
    { "from": "end_a", "event": "go", "result": "illegal_transition", "errorCode": "TERMINAL" },
    { "from": "end_b", "event": "go", "result": "illegal_transition", "errorCode": "TERMINAL" }
  ],
  invariants: [],
  proofObligations: []
};

describe("State Machine Core - Definition Validation", () : any => {
  it("should validate a correct definition", () : any => {
    const result: any = validateStateMachineDefinition(mockDefinition);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("should fail validation if machineId is missing", () : any => {
    const invalid: Record<string, any> = { ...mockDefinition, machineId: "" };
    const result: any = validateStateMachineDefinition(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ errorCode: ERROR_CODES.STATE_MACHINE_INVALID_DEFINITION, message: 'machineId is required' })
    );
  });

  it("should fail validation if initialState is not in states", () : any => {
    const invalid: Record<string, any> = { ...mockDefinition, initialState: "unknown_state" };
    const result: any = validateStateMachineDefinition(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ message: `initialState 'unknown_state' is not in states list` })
    );
  });

  it("should fail validation if there is a duplicate state ID", () : any => {
    const invalid: Record<string, any> = {
      ...mockDefinition,
      states: [{ id: "submitted" }, { id: "submitted" }, { id: "archived", "terminal": true }]
    };
    const result: any = validateStateMachineDefinition(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ message: 'Duplicate state IDs found' })
    );
  });

  it("should fail validation if definition is null", () : any => {
    const result: any = validateStateMachineDefinition(null);
    expect(result.ok).toBe(false);
  });
});

describe("State Machine Core - Assert Definition", () : any => {
  it("should not throw on valid definition", () : any => {
    expect(() : any => assertStateMachineDefinition(mockDefinition)).not.toThrow();
  });

  it("should throw on invalid definition", () : any => {
    const invalid: Record<string, any> = { ...mockDefinition, machineId: "" };
    expect(() : any => assertStateMachineDefinition(invalid)).toThrow(StateMachineError);
  });
});

describe("State Machine Core - Transition State Logic", () : any => {
  it("should perform legal transitions successfully", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "123",
      currentStatus: "submitted",
      eventType: "test.approve"
    });
    expect(res.ok).toBe(true);
    expect(res.toStatus).toBe("approved");
    expect(res.entityType).toBe("test_entity");
    expect(res.transitionRecord.fromStatus).toBe("submitted");
    expect(res.transitionRecord.toStatus).toBe("approved");
    expect(res.requiredEffects.policy).toBe(false);
  });

  it("should report illegal transitions and suggest allowed events", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "123",
      currentStatus: "submitted",
      eventType: "test.archive"
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("ARCHIVE_BEFORE_APPROVAL");
    expect(res.allowedEvents).toContain("test.approve");
  });

  it("should return ignored idempotent event status on repeat actions", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "123",
      currentStatus: "submitted",
      eventType: "test.submit"
    });
    expect(res.ok).toBe(true);
    expect(res.idempotent).toBe(true);
    expect(res.toStatus).toBe("submitted");
  });

  it("should block non-idempotent transitions from terminal states", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "123",
      currentStatus: "archived",
      eventType: "test.approve"
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("ALREADY_ARCHIVED");
  });

  it("should allow idempotent events in terminal states", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "123",
      currentStatus: "archived",
      eventType: "test.archive"
    });
    expect(res.ok).toBe(true);
    expect(res.idempotent).toBe(true);
  });
});

describe("State Machine Core - Metadata Redaction", () : any => {
  it("should automatically redact metadata during transitions", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "123",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        password: "my-password",
        label: "test-run"
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.metadata.password).toEqual({ redacted: true, reason: "sensitive_key" });
    expect(res.transitionRecord.metadata.label).toBe("test-run");
  });

  it("should redact token-like fields in metadata during transitions", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "456",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        apiKey: "secret-12345",
        safeField: "safe-data"
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.metadata.apiKey).toEqual({ redacted: true, reason: "sensitive_key" });
    expect(res.transitionRecord.metadata.safeField).toBe("safe-data");
  });

  it("should redact absolute paths in metadata", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "789",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        dataPath: ["", "home", "<user>", "data", "config.json"].join("/"),
        other: "regular"
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.metadata.dataPath).toEqual({ redacted: true, reason: "absolute_path" });
    expect(res.transitionRecord.metadata.other).toBe("regular");
  });
});

describe("State Machine Core - Exception Throwing Wrapper", () : any => {
  it("should not throw on valid transitions", () : any => {
    const res: any = assertTransitionAllowed(mockDefinition, {
      entityId: "123",
      currentStatus: "submitted",
      eventType: "test.approve"
    });
    expect(res.ok).toBe(true);
  });

  it("should throw on invalid transitions with structured details", () : any => {
    try {
      assertTransitionAllowed(mockDefinition, {
        entityId: "123",
        currentStatus: "submitted",
        eventType: "test.archive"
      });
      expect.fail("Should have thrown error");
    } catch (error: any) {
      expect(error).toBeInstanceOf(StateMachineError);
      expect(error.code).toBe("ARCHIVE_BEFORE_APPROVAL");
      expect(error.errorCode).toBe("ARCHIVE_BEFORE_APPROVAL");
    }
  });
});

describe("State Machine Core - Executable Definition Validation", () : any => {
  it("should reject definitions with unknown guard", () : any => {
    const defWithUnknownGuard: Record<string, any> = { ...mockDefinition };
    defWithUnknownGuard.totalMatrix = defWithUnknownGuard.totalMatrix.map((cell?: any) : any =>
      cell.from === "approved" && cell.event === "test.archive"
        ? { ...cell, guards: ["nonexistent_guard"] }
        : cell
    );
    const result: any = validateExecutableStateMachineDefinition(defWithUnknownGuard);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e?: any) : any => e.message.includes("nonexistent_guard"))).toBe(true);
  });

  it("should reject definitions with unknown to state", () : any => {
    const def: any = JSON.parse(JSON.stringify(mockDefinition));
    def.totalMatrix.push({ from: "submitted", event: "test.approve", result: "legal_transition", to: "unknown_state" });
    const result: any = validateExecutableStateMachineDefinition(def);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e?: any) : any => e.message.includes("unknown state"))).toBe(true);
  });

  it("should reject definitions with duplicate unguarded cells", () : any => {
    const def: any = JSON.parse(JSON.stringify(mockDefinition));
    def.totalMatrix.push({ from: "submitted", event: "test.approve", result: "legal_transition", to: "approved" });
    const result: any = validateExecutableStateMachineDefinition(def);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e?: any) : any => e.message.includes("Duplicate unguarded"))).toBe(true);
  });

  it("should accept valid executable definitions", () : any => {
    const result: any = validateExecutableStateMachineDefinition(mockDefinition);
    expect(result.ok).toBe(true);
  });

  it("should reject incomplete, unreachable, terminal-exit, and duplicate-illegal topologies", () : any => {
    const incomplete: any = JSON.parse(JSON.stringify(mockDefinition));
    incomplete.totalMatrix.pop();
    expect(validateExecutableStateMachineDefinition(incomplete).ok).toBe(false);

    const unreachable: any = JSON.parse(JSON.stringify(mockDefinition));
    unreachable.states.push({ id: "unreachable" });
    for (const event of unreachable.events) {
      unreachable.totalMatrix.push({ from: "unreachable", event: event.id, result: "illegal_transition", errorCode: "UNREACHABLE" });
    }
    expect(validateExecutableStateMachineDefinition(unreachable).ok).toBe(false);

    const terminalExit: any = JSON.parse(JSON.stringify(mockDefinition));
    terminalExit.totalMatrix = terminalExit.totalMatrix.map((cell?: any) : any =>
      cell.from === "archived" && cell.event === "test.submit"
        ? { ...cell, result: "legal_transition", to: "submitted", errorCode: undefined }
        : cell
    );
    expect(validateExecutableStateMachineDefinition(terminalExit).ok).toBe(false);

    const duplicateIllegal: any = JSON.parse(JSON.stringify(mockDefinition));
    duplicateIllegal.totalMatrix.push({ from: "archived", event: "test.submit", result: "illegal_transition", errorCode: "ALREADY_ARCHIVED" });
    expect(validateExecutableStateMachineDefinition(duplicateIllegal).ok).toBe(false);
  });

  it("should not mutate definition during validation", () : any => {
    const def: any = JSON.parse(JSON.stringify(mockDefinition));
    const pre: any = JSON.stringify(def);
    validateExecutableStateMachineDefinition(def);
    expect(JSON.stringify(def)).toBe(pre);
  });
});

describe("State Machine Core - Definition Immutability", () : any => {
  it("should not mutate definition during transitionState", () : any => {
    const def: any = JSON.parse(JSON.stringify(mockDefinition));
    const pre: any = JSON.stringify(def);
    transitionState(def, {
      entityId: "imm1",
      currentStatus: "submitted",
      eventType: "test.approve"
    });
    expect(JSON.stringify(def)).toBe(pre);
  });

  it("should not mutate definition after guard evaluation", () : any => {
    const def: any = JSON.parse(JSON.stringify(mockDefinition));
    const pre: any = JSON.stringify(def);
    transitionState(def, {
      entityId: "imm2",
      currentStatus: "approved",
      eventType: "test.archive",
      guardContext: { policyDecision: { allowed: true } }
    });
    expect(JSON.stringify(def)).toBe(pre);
  });
});

describe("State Machine Core - ERROR_CODES", () : any => {
  it("should export ERROR_CODES from core module", () : any => {
    expect(ERROR_CODES).toBeDefined();
    expect(ERROR_CODES.STATE_MACHINE_INVALID_DEFINITION).toBe("STATE_MACHINE_INVALID_DEFINITION");
    expect(ERROR_CODES.STATE_MACHINE_UNKNOWN_STATUS).toBe("STATE_MACHINE_UNKNOWN_STATUS");
    expect(ERROR_CODES.STATE_MACHINE_TERMINAL_STATUS).toBe("STATE_MACHINE_TERMINAL_STATUS");
    expect(ERROR_CODES.STATE_MACHINE_TRANSITION_NOT_ALLOWED).toBe("STATE_MACHINE_TRANSITION_NOT_ALLOWED");
  });
});

describe("State Machine Core - Utility Functions", () : any => {
  it("isTerminalStatus should correctly identify terminal states", () : any => {
    expect(isTerminalStatus(mockDefinition, "archived")).toBe(true);
    expect(isTerminalStatus(mockDefinition, "submitted")).toBe(false);
  });

  it("listAllowedEvents should return valid event names for a state", () : any => {
    const events: any = listAllowedEvents(mockDefinition, "submitted");
    expect(events).toContain("test.submit");
    expect(events).toContain("test.approve");
    expect(events).not.toContain("test.archive");
  });
});

describe("State Machine Core - Guard Execution", () : any => {
  it("should reject transition when policyAllowed guard fails", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "g1",
      currentStatus: "approved",
      eventType: "test.archive",
      guardContext: { policyDecision: { allowed: false } }
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("STATE_MACHINE_GUARD_BLOCKED");
    expect(res.blockedBy).toBe("guard");
  });

  it("should allow transition when policyAllowed guard passes", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "g2",
      currentStatus: "approved",
      eventType: "test.archive",
      guardContext: { policyDecision: { allowed: true } }
    });
    expect(res.ok).toBe(true);
    expect(res.toStatus).toBe("archived");
    expect(res.transitionRecord.guardResults).toBeDefined();
  });

  it("should reject transition for unknown guard", () : any => {
    const defWithUnknownGuard: Record<string, any> = {
      ...mockDefinition,
      totalMatrix: mockDefinition.totalMatrix.map((cell?: any) : any =>
        cell.from === "approved" && cell.event === "test.archive"
          ? { ...cell, guards: ["nonexistent_guard"] }
          : cell
      )
    };
    const res: any = transitionState(defWithUnknownGuard, {
      entityId: "g3",
      currentStatus: "approved",
      eventType: "test.archive"
    }, { skipExecutableValidation: true });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("STATE_MACHINE_GUARD_UNKNOWN");
    expect(res.blockedBy).toBe("guard");
  });

  it("should reject transition when guard context is missing", () : any => {
    const defWithApprovalGuard: Record<string, any> = {
      ...mockDefinition,
      totalMatrix: mockDefinition.totalMatrix.map((cell?: any) : any =>
        cell.from === "approved" && cell.event === "test.archive"
          ? { ...cell, guards: ["approvalApproved"] }
          : cell
      )
    };
    const res: any = transitionState(defWithApprovalGuard, {
      entityId: "g4",
      currentStatus: "approved",
      eventType: "test.archive",
      guardContext: {}
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("STATE_MACHINE_GUARD_CONTEXT_MISSING");
  });

  it("should reject transition when approvalApproved guard fails (status not approved)", () : any => {
    const defWithApprovalGuard: Record<string, any> = {
      ...mockDefinition,
      totalMatrix: mockDefinition.totalMatrix.map((cell?: any) : any =>
        cell.from === "approved" && cell.event === "test.archive"
          ? { ...cell, guards: ["approvalApproved"] }
          : cell
      )
    };
    const res: any = transitionState(defWithApprovalGuard, {
      entityId: "g5",
      currentStatus: "approved",
      eventType: "test.archive",
      guardContext: { approvalRecord: { status: "pending" } }
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("STATE_MACHINE_GUARD_BLOCKED");
  });
});

describe("State Machine Core - Multi-cell Disambiguation", () : any => {
  it("should select single passing cell from multiple guarded cells", () : any => {
    const res: any = transitionState(multiCellDefinition, {
      entityId: "m1",
      currentStatus: "start",
      eventType: "go",
      guardContext: { policyDecision: { allowed: true }, approvalRecord: { status: "pending" } }
    });
    expect(res.ok).toBe(true);
    expect(res.toStatus).toBe("end_a");
  });

  it("should select single passing cell from multiple guarded cells (second)", () : any => {
    const res: any = transitionState(multiCellDefinition, {
      entityId: "m2",
      currentStatus: "start",
      eventType: "go",
      guardContext: { policyDecision: { allowed: false }, approvalRecord: { status: "approved" } }
    });
    expect(res.ok).toBe(true);
    expect(res.toStatus).toBe("end_b");
  });

  it("should reject when no guard passes for any cell", () : any => {
    const res: any = transitionState(multiCellDefinition, {
      entityId: "m3",
      currentStatus: "start",
      eventType: "go",
      guardContext: { policyDecision: { allowed: false }, approvalRecord: { status: "pending" } }
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("STATE_MACHINE_GUARD_BLOCKED");
  });

  it("should return ambiguous when multiple guards pass", () : any => {
    const res: any = transitionState(multiCellDefinition, {
      entityId: "m4",
      currentStatus: "start",
      eventType: "go",
      guardContext: { policyDecision: { allowed: true }, approvalRecord: { status: "approved" } }
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("STATE_MACHINE_AMBIGUOUS_TRANSITION");
  });
});

describe("State Machine Core - requires_policy Evidence Check", () : any => {
  it("should reject requires_policy without allow evidence", () : any => {
    const def: Record<string, any> = {
      machineId: "fixture.strategy.policy-evidence.1",
      entityType: "test",
      version: "1.0.0",
      description: "Policy evidence test definition.",
      initialState: "start",
      states: [{ id: "start" }, { id: "end", terminal: true }],
      events: [{ id: "go" }],
      totalMatrix: [
        { from: "start", event: "go", result: "requires_policy", to: "end" },
        { from: "end", event: "go", result: "illegal_transition", errorCode: "TERMINAL" }
      ],
      invariants: [],
      proofObligations: []
    };
    const res: any = transitionState(def, {
      entityId: "p1",
      currentStatus: "start",
      eventType: "go",
      guardContext: {}
    });
    expect(res.ok).toBe(false);
    expect(res.blockedBy).toBe("policy");
  });

  it("should allow requires_policy with allow evidence", () : any => {
    const def: Record<string, any> = {
      machineId: "fixture.strategy.policy-evidence.2",
      entityType: "test",
      version: "1.0.0",
      description: "Policy evidence v2 test definition.",
      initialState: "start",
      states: [{ id: "start" }, { id: "end", terminal: true }],
      events: [{ id: "go" }],
      totalMatrix: [
        { from: "start", event: "go", result: "requires_policy", to: "end" },
        { from: "end", event: "go", result: "illegal_transition", errorCode: "TERMINAL" }
      ],
      invariants: [],
      proofObligations: []
    };
    const res: any = transitionState(def, {
      entityId: "p2",
      currentStatus: "start",
      eventType: "go",
      guardContext: { policyDecision: { allowed: true } }
    });
    expect(res.ok).toBe(true);
    expect(res.requiredEffects.policy).toBe(true);
  });
});

describe("State Machine Core - requires_approval Evidence Check", () : any => {
  it("should reject requires_approval without approved evidence", () : any => {
    const def: Record<string, any> = {
      machineId: "fixture.strategy.approval-evidence.1",
      entityType: "test",
      version: "1.0.0",
      description: "Approval evidence test definition.",
      initialState: "start",
      states: [{ id: "start" }, { id: "end", terminal: true }],
      events: [{ id: "go" }],
      totalMatrix: [
        { from: "start", event: "go", result: "requires_approval", to: "end" },
        { from: "end", event: "go", result: "illegal_transition", errorCode: "TERMINAL" }
      ],
      invariants: [],
      proofObligations: []
    };
    const res: any = transitionState(def, {
      entityId: "a1",
      currentStatus: "start",
      eventType: "go",
      guardContext: {}
    });
    expect(res.ok).toBe(false);
    expect(res.blockedBy).toBe("approval");
  });

  it("should allow requires_approval with approved evidence", () : any => {
    const def: Record<string, any> = {
      machineId: "fixture.strategy.approval-evidence.2",
      entityType: "test",
      version: "1.0.0",
      description: "Approval evidence v2 test definition.",
      initialState: "start",
      states: [{ id: "start" }, { id: "end", terminal: true }],
      events: [{ id: "go" }],
      totalMatrix: [
        { from: "start", event: "go", result: "requires_approval", to: "end" },
        { from: "end", event: "go", result: "illegal_transition", errorCode: "TERMINAL" }
      ],
      invariants: [],
      proofObligations: []
    };
    const res: any = transitionState(def, {
      entityId: "a2",
      currentStatus: "start",
      eventType: "go",
      guardContext: { approvalRecord: { status: "approved" } }
    });
    expect(res.ok).toBe(true);
    expect(res.requiredEffects.approval).toBe(true);
  });
});

describe("State Machine Core - requires_external_receipt", () : any => {
  it("should return externalReceipt required effect and allow transition", () : any => {
    const def: Record<string, any> = {
      machineId: "receipt.v1",
      entityType: "test",
      version: "1.0.0",
      description: "Receipt evidence test definition.",
      initialState: "start",
      states: [{ id: "start" }, { id: "end", terminal: true }],
      events: [{ id: "go" }],
      totalMatrix: [
        { from: "start", event: "go", result: "requires_external_receipt", to: "end", sideEffects: ["receipt_required"] },
        { from: "end", event: "go", result: "illegal_transition", errorCode: "TERMINAL" }
      ],
      invariants: [],
      proofObligations: []
    };
    const res: any = transitionState(def, {
      entityId: "r1",
      currentStatus: "start",
      eventType: "go",
      guardContext: { externalReceipt: { status: "recorded" } }
    });
    expect(res.ok).toBe(true);
    expect(res.requiredEffects.externalReceipt).toBe(true);
    expect(res.toStatus).toBe("end");
  });
});

describe("State Machine Core - deferred_async_transition", () : any => {
  it("should return async required effect and support resumePointer", () : any => {
    const def: Record<string, any> = {
      machineId: "async.v1",
      entityType: "test",
      version: "1.0.0",
      description: "Async transition test definition.",
      initialState: "start",
      states: [{ id: "start" }, { id: "end", terminal: true }],
      events: [{ id: "go" }],
      totalMatrix: [
        { from: "start", event: "go", result: "deferred_async_transition", to: "end", sideEffects: ["async_resume"] },
        { from: "end", event: "go", result: "illegal_transition", errorCode: "TERMINAL" }
      ],
      invariants: [],
      proofObligations: []
    };
    const res: any = transitionState(def, {
      entityId: "d1",
      currentStatus: "start",
      eventType: "go",
      operationId: "op-123",
      traceId: "trace-456",
      resumePointer: "resume/checkpoint/xyz"
    });
    expect(res.ok).toBe(true);
    expect(res.requiredEffects.async).toBe(true);
    expect(res.asyncTransition.required).toBe(true);
    expect(res.asyncTransition.operationId).toBe("op-123");
    expect(res.asyncTransition.traceId).toBe("trace-456");
    expect(res.asyncTransition.resumePointer).toBe("resume/checkpoint/xyz");
  });
});

describe("State Machine Core - Deep Metadata Redaction", () : any => {
  it("should redact nested object secrets", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "r1",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        config: { credentials: { apiKey: "nested-secret" } },
        label: "safe"
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.metadata.config.credentials.apiKey).toEqual({ redacted: true, reason: "sensitive_key" });
    expect(res.transitionRecord.metadata.label).toBe("safe");
  });

  it("should redact secrets in nested arrays", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "r2",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        headers: [
          { name: "Content-Type", value: "application/json" },
          { name: "Authorization", value: "Bearer token123" }
        ]
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.metadata.headers[0].value).toBe("application/json");
    expect(res.transitionRecord.metadata.headers[1].name).toEqual({ redacted: true, reason: "sensitive_key" });
  });

  it("should redact Bearer token strings", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "r3",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        authHeader: ["Bearer", "eyJhbGciOiJIUzI1NiJ9.xxx"].join(" ")
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.metadata.authHeader).toEqual({ redacted: true, reason: "sensitive_key" });
  });

  it("should redact URL query tokens", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "r4",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        callbackUrl: "https://example.com/callback?token=secret123&mode=test"
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.metadata.callbackUrl).toEqual({ redacted: true, reason: "sensitive_key" });
  });

  it("should redact Linux absolute paths", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "r5",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        path: ["", "home", "<user>", "data", "config.json"].join("/")
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.metadata.path).toEqual({ redacted: true, reason: "absolute_path" });
  });

  it("should redact Windows absolute paths", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "r6",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        path: ["C:", "Users", "test", "data", "config.json"].join("\\")
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.metadata.path).toEqual({ redacted: true, reason: "absolute_path" });
  });

  it("should not redact safe text", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "r7",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        label: "production-deployment",
        count: 42,
        tags: ["approved", "verified"]
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.metadata.label).toBe("production-deployment");
    expect(res.transitionRecord.metadata.count).toBe(42);
    expect(res.transitionRecord.metadata.tags).toEqual(["approved", "verified"]);
  });

  it("should redact &token= in URL query strings", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "r8",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        url: "https://api.example.com/callback?mode=test&token=secret456"
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.metadata.url).toEqual({ redacted: true, reason: "sensitive_key" });
  });

  it("should redact &refresh_token= in URL strings", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "r9",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        oauthUrl: `https://auth.example.com/refresh?${["refresh", "token"].join("_")}=rt_abc123&scope=read`
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.metadata.oauthUrl).toEqual({ redacted: true, reason: "sensitive_key" });
  });

  it("should redact client_secret= in strings", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "r10",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        configString: "client_id=app1&client_secret=cs_deadbeef&grant_type=authorization_code"
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.metadata.configString).toEqual({ redacted: true, reason: "sensitive_key" });
  });

  it("should redact Authorization = Bearer with spaces", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "r11",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        rawHeader: ["Authorization =", "Bearer", "some-token-value"].join(" ")
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.metadata.rawHeader).toEqual({ redacted: true, reason: "sensitive_key" });
  });

  it("should redact credentialBundle key", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "r12",
      currentStatus: "submitted",
      eventType: "test.approve",
      metadata: {
        credentialBundle: { id: "cred-1", name: "main-cred", value: "actual-secret" }
      }
    });
    expect(res.ok).toBe(true);
    // credentialBundle key matches REDACT_KEY_PATTERNS; recurses into the object
    expect(res.transitionRecord.metadata.credentialBundle.id).toBe("cred-1");
    expect(res.transitionRecord.metadata.credentialBundle.name).toBe("main-cred");
    expect(res.transitionRecord.metadata.credentialBundle.value).toEqual({ redacted: true, reason: "sensitive_key" });
  });

  it("should not redact operationId, traceId, reasonCode, or guardId", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "r13",
      currentStatus: "submitted",
      eventType: "test.approve",
      operationId: "op-123",
      traceId: "trace-456",
      reasonCode: "RC-001",
      metadata: {
        guardId: "policyAllowed",
        reasonCode: "RC-002",
        operationId: "op-789",
        traceId: "trace-012"
      }
    });
    expect(res.ok).toBe(true);
    expect(res.transitionRecord.operationId).toBe("op-123");
    expect(res.transitionRecord.traceId).toBe("trace-456");
  });
});

describe("State Machine Core - Guard Evaluator Injection Rejection (P0-B)", () : any => {
  it("should reject guardEvaluator injected via input object", () : any => {
    const res: any = transitionState(mockDefinition, {
      entityId: "ib1",
      currentStatus: "approved",
      eventType: "test.archive",
      guardContext: { policyDecision: { allowed: false } },
      guardEvaluator: () : any => [{ ok: true }]
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("STATE_MACHINE_GUARD_INJECTION_REJECTED");
  });

  it("should NOT bypass guard via input.guardEvaluator when real guard would fail", () : any => {
    const defWithGuard: Record<string, any> = {
      ...mockDefinition,
      totalMatrix: mockDefinition.totalMatrix.map((cell?: any) : any =>
        cell.from === "approved" && cell.event === "test.archive"
          ? { ...cell, guards: ["policyAllowed"] }
          : cell
      )
    };
    const res: any = transitionState(defWithGuard, {
      entityId: "ib2",
      currentStatus: "approved",
      eventType: "test.archive",
      guardContext: { policyDecision: { allowed: false } },
      guardEvaluator: () : any => [{ ok: true, guardId: "policyAllowed" }]
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("STATE_MACHINE_GUARD_INJECTION_REJECTED");
  });
});

describe("State Machine Core - EvaluateTransitionGuards Consistency (P0-C)", () : any => {
  it("evaluateTransitionGuards and transitionState agree on single-cell guard pass", () : any => {
    const def: Record<string, any> = {
      machineId: "consistency.v1",
      entityType: "test",
      version: "1.0.0",
      description: "Consistency test definition.",
      initialState: "start",
      states: [{ id: "start" }, { id: "end", terminal: true }],
      events: [{ id: "go" }],
      totalMatrix: [
        { from: "start", event: "go", result: "legal_transition", to: "end", guards: ["policyAllowed"] },
        { from: "end", event: "go", result: "illegal_transition", errorCode: "TERMINAL" }
      ],
      invariants: [],
      proofObligations: []
    };
    const context: Record<string, any> = { policyDecision: { allowed: true } };

    const transResult: any = transitionState(def, {
      entityId: "c1",
      currentStatus: "start",
      eventType: "go",
      guardContext: context
    });
    const evalResult: any = evaluateTransitionGuards(def, "start", "go", context);

    expect(transResult.ok).toBe(true);
    expect(evalResult.ok).toBe(true);
  });

  it("evaluateTransitionGuards and transitionState agree on single-cell guard fail", () : any => {
    const def: Record<string, any> = {
      machineId: "consistency.v2",
      entityType: "test",
      version: "1.0.0",
      description: "Consistency test v2.",
      initialState: "start",
      states: [{ id: "start" }, { id: "end", terminal: true }],
      events: [{ id: "go" }],
      totalMatrix: [
        { from: "start", event: "go", result: "legal_transition", to: "end", guards: ["policyAllowed"] },
        { from: "end", event: "go", result: "illegal_transition", errorCode: "TERMINAL" }
      ],
      invariants: [],
      proofObligations: []
    };
    const context: Record<string, any> = { policyDecision: { allowed: false } };

    const transResult: any = transitionState(def, {
      entityId: "c2",
      currentStatus: "start",
      eventType: "go",
      guardContext: context
    });
    const evalResult: any = evaluateTransitionGuards(def, "start", "go", context);

    expect(transResult.ok).toBe(false);
    expect(evalResult.ok).toBe(false);
  });

  it("evaluateTransitionGuards and transitionState agree on missing guard context", () : any => {
    const def: Record<string, any> = {
      machineId: "consistency.v3",
      entityType: "test",
      version: "1.0.0",
      description: "Consistency test v3.",
      initialState: "start",
      states: [{ id: "start" }, { id: "end", terminal: true }],
      events: [{ id: "go" }],
      totalMatrix: [
        { from: "start", event: "go", result: "legal_transition", to: "end", guards: ["policyAllowed"] },
        { from: "end", event: "go", result: "illegal_transition", errorCode: "TERMINAL" }
      ],
      invariants: [],
      proofObligations: []
    };

    const transResult: any = transitionState(def, {
      entityId: "c3",
      currentStatus: "start",
      eventType: "go",
      guardContext: {}
    });
    const evalResult: any = evaluateTransitionGuards(def, "start", "go", {});

    expect(transResult.ok).toBe(false);
    expect(evalResult.ok).toBe(false);
  });
});

describe("State Machine Core - Compile/Cache Validation (P1-D)", () : any => {
  it("compileStateMachineDefinition returns compiled result with definitionHash", () : any => {
    const compiled: any = compileStateMachineDefinition(mockDefinition);
    expect(compiled.compiled).toBe(true);
    expect(compiled.validationResult.ok).toBe(true);
    expect(compiled.definitionHash).toBeDefined();
    expect(compiled.definitionHash.startsWith("sha256:")).toBe(true);
  });

  it("compiled definition produces same transition result as direct transitionState", () : any => {
    const compiled: any = compileStateMachineDefinition(mockDefinition);

    const directResult: any = transitionState(mockDefinition, {
      entityId: "h1",
      currentStatus: "submitted",
      eventType: "test.approve"
    });
    const compiledResult: any = transitionState(compiled.definition, {
      entityId: "h2",
      currentStatus: "submitted",
      eventType: "test.approve"
    }, { validatedDefinitionHash: compiled.definitionHash });

    expect(compiledResult.ok).toBe(true);
    expect(compiledResult.toStatus).toBe(directResult.toStatus);
    expect(compiledResult.transitionRecord.fromStatus).toBe(directResult.transitionRecord.fromStatus);
  });

  it("validatedDefinitionHash rejects when definition is modified after compilation", () : any => {
    const compiled: any = compileStateMachineDefinition(mockDefinition);
    // Create a structurally invalid definition by adding a duplicate unguarded cell
    const modifiedDef: any = JSON.parse(JSON.stringify(mockDefinition));
    modifiedDef.totalMatrix.push({
      from: "submitted",
      event: "test.approve",
      result: "legal_transition",
      to: "approved"
    });

    const res: any = transitionState(modifiedDef, {
      entityId: "h3",
      currentStatus: "submitted",
      eventType: "test.approve"
    }, { validatedDefinitionHash: compiled.definitionHash });
    // Hash mismatch triggers re-validation, which catches the duplicate unguarded cells
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("STATE_MACHINE_INVALID_DEFINITION");
  });

  it("validatedDefinitionHash skips validation for identical definition", () : any => {
    const compiled: any = compileStateMachineDefinition(mockDefinition);

    const res: any = transitionState(mockDefinition, {
      entityId: "h4",
      currentStatus: "submitted",
      eventType: "test.approve"
    }, { validatedDefinitionHash: compiled.definitionHash });

    expect(res.ok).toBe(true);
  });

  it("default path still rejects unexecutable definition", () : any => {
    const invalidDef: any = JSON.parse(JSON.stringify(mockDefinition));
    invalidDef.totalMatrix.push({
      from: "submitted",
      event: "test.approve",
      result: "legal_transition",
      to: "approved"
    });

    const res: any = transitionState(invalidDef, {
      entityId: "h5",
      currentStatus: "submitted",
      eventType: "test.approve"
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("STATE_MACHINE_INVALID_DEFINITION");
  });
});

describe("State Machine Core - Recursive Canonical Hash (P0-A)", () : any => {
  it("hash changes when totalMatrix[0].to is modified", () : any => {
    const compiled: any = compileStateMachineDefinition(mockDefinition);
    const modifiedDef: any = JSON.parse(JSON.stringify(mockDefinition));
    modifiedDef.totalMatrix[1].to = "archived"; // was "approved"

    const compiled2: any = compileStateMachineDefinition(modifiedDef);
    expect(compiled2.definitionHash).not.toBe(compiled.definitionHash);
  });

  it("hash changes when totalMatrix[0].guards is modified", () : any => {
    const compiled: any = compileStateMachineDefinition(mockDefinition);
    const modifiedDef: any = JSON.parse(JSON.stringify(mockDefinition));
    modifiedDef.totalMatrix[5].guards = ["approvalApproved"]; // was ["policyAllowed"]

    const compiled2: any = compileStateMachineDefinition(modifiedDef);
    expect(compiled2.definitionHash).not.toBe(compiled.definitionHash);
  });

  it("hash changes when states[0].id is modified", () : any => {
    const compiled: any = compileStateMachineDefinition(mockDefinition);
    const modifiedDef: any = JSON.parse(JSON.stringify(mockDefinition));
    modifiedDef.states[0].id = "different_start";

    const compiled2: any = compileStateMachineDefinition(modifiedDef);
    expect(compiled2.definitionHash).not.toBe(compiled.definitionHash);
  });

  it("nested modification with old validatedDefinitionHash triggers re-validation", () : any => {
    const compiled: any = compileStateMachineDefinition(mockDefinition);
    const modifiedDef: any = JSON.parse(JSON.stringify(mockDefinition));
    // Change a guards value deeply nested in totalMatrix
    modifiedDef.totalMatrix[5].guards = ["approvalApproved"];

    const res: any = transitionState(modifiedDef, {
      entityId: "n1",
      currentStatus: "approved",
      eventType: "test.archive",
      guardContext: { approvalRecord: { status: "approved" }, policyDecision: { allowed: true } }
    }, { validatedDefinitionHash: compiled.definitionHash });
    // Hash mismatch -> re-validates. The definition is still structurally valid
    // (approvalApproved is a known guard), so the transition should proceed.
    expect(res.ok).toBe(true);
    expect(res.toStatus).toBe("archived");
  });
});

describe("State Machine Core - staticOnly Guard Isolation (P1-C)", () : any => {
  it("executable validation fails when low-risk transition uses staticOnly guard", () : any => {
    const def: any = JSON.parse(JSON.stringify(mockDefinition));
    // Add noApprovalRequired (staticOnly) to a low-risk transition
    def.totalMatrix = def.totalMatrix.map((cell?: any) : any =>
      cell.from === "submitted" && cell.event === "test.approve"
        ? { ...cell, guards: ["noApprovalRequired"] }
        : cell
    );

    const result: any = validateExecutableStateMachineDefinition(def);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e?: any) : any => e.message.includes("staticOnly"))).toBe(true);
  });

  it("executable validation fails when staticOnly guard used in requiredGuards", () : any => {
    const def: any = JSON.parse(JSON.stringify(mockDefinition));
    def.totalMatrix = def.totalMatrix.map((cell?: any) : any =>
      cell.from === "submitted" && cell.event === "test.approve"
        ? { ...cell, requiredGuards: ["noApprovalRequired"] }
        : cell
    );

    const result: any = validateExecutableStateMachineDefinition(def);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e?: any) : any => e.message.includes("staticOnly"))).toBe(true);
  });
});
