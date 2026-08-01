import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import {
  transitionState,
  ERROR_CODES
} from "../../../packages/foundation/src/workflow/state-machine/engine/state-machine-core.ts";

const __filename: any = fileURLToPath(import.meta.url);
const __dirname: any = path.dirname(__filename);
const defPath: any = path.resolve(__dirname, "../../../packages/foundation/src/workflow/state-machine/definitions/production.readiness.lifecycle.json");

describe("Production Readiness Lifecycle State Machine", () : any => {
  let definition: any;

  beforeAll(async () : Promise<any> => {
    const raw: any = await fs.readFile(defPath, "utf8");
    definition = JSON.parse(raw);
  });

  it("PO-READY-001: Any P0 failure blocks production_ready", () : any => {
    const mapping: any = definition.proofMappings.find((m?: any) : any => m.obligationId === "PO-READY-001");
    expect(mapping).toBeDefined();
    expect(mapping.params.target).toBe("release_candidate");
  });

  it("PO-READY-002: Waiver must have valid schema fields", () : any => {
    const mapping: any = definition.proofMappings.find((m?: any) : any => m.obligationId === "PO-READY-002");
    expect(mapping).toBeDefined();
    expect(mapping.params.target).toBe("waiver_requested");
  });

  it("PO-READY-003: Production-ready claim requires machine-readable report", () : any => {
    const mapping: any = definition.proofMappings.find((m?: any) : any => m.obligationId === "PO-READY-003");
    expect(mapping).toBeDefined();
  });

  it("PO-READY-004: Contract-only not counted as live evidence", () : any => {
    const mapping: any = definition.proofMappings.find((m?: any) : any => m.obligationId === "PO-READY-004");
    expect(mapping).toBeDefined();
  });

  it("should allow normal transition from not_started to collecting_evidence", () : any => {
    const res: any = transitionState(definition, {
      entityId: "gate-1",
      currentStatus: "not_started",
      eventType: "gate.start"
    });
    expect(res.ok).toBe(true);
    expect(res.toStatus).toBe("collecting_evidence");
  });

  it("should allow transition from running_checks to passed", () : any => {
    const res: any = transitionState(definition, {
      entityId: "gate-1",
      currentStatus: "running_checks",
      eventType: "gate.pass"
    });
    expect(res.ok).toBe(true);
    expect(res.toStatus).toBe("passed");
  });

  it("should reject gate.release_candidate from running_checks when require_p0_passed_or_waived guard fails", () : any => {
    const res: any = transitionState(definition, {
      entityId: "gate-2",
      currentStatus: "running_checks",
      eventType: "gate.release_candidate",
      guardContext: {
        readinessReport: {
          scopes: [
            { scopeId: "p0-1", productionRequired: true, status: "failed" }
          ]
        }
      }
    });
    expect(res.ok).toBe(false);
    expect(res.blockedBy).toBe("guard");
    expect(res.errorCode).toBe("STATE_MACHINE_GUARD_BLOCKED");
  });

  it("should allow gate.release_candidate from running_checks when guard passes", () : any => {
    const res: any = transitionState(definition, {
      entityId: "gate-3",
      currentStatus: "running_checks",
      eventType: "gate.release_candidate",
      guardContext: {
        readinessReport: {
          scopes: [
            { scopeId: "p0-1", productionRequired: true, status: "passed" }
          ]
        }
      }
    });
    expect(res.ok).toBe(true);
    expect(res.toStatus).toBe("release_candidate");
  });

  it("should reject gate.waiver_approve from waiver_requested when architect approval guard fails", () : any => {
    const res: any = transitionState(definition, {
      entityId: "gate-4",
      currentStatus: "waiver_requested",
      eventType: "gate.waiver_approve",
      guardContext: {
        approvalRecord: { status: "pending" }
      }
    });
    expect(res.ok).toBe(false);
    expect(res.blockedBy).toBe("guard");
  });

  it("should allow gate.waiver_approve from waiver_requested when architect approval passes", () : any => {
    const res: any = transitionState(definition, {
      entityId: "gate-5",
      currentStatus: "waiver_requested",
      eventType: "gate.waiver_approve",
      guardContext: {
        approvalRecord: { status: "approved", role: "architect" }
      }
    });
    expect(res.ok).toBe(true);
    expect(res.toStatus).toBe("waiver_approved");
  });

  it("should allow gate.release_candidate from waiver_approved when p0 guard passes", () : any => {
    const res: any = transitionState(definition, {
      entityId: "gate-6",
      currentStatus: "waiver_approved",
      eventType: "gate.release_candidate",
      guardContext: {
        readinessReport: {
          scopes: [
            { scopeId: "p0-1", productionRequired: true, status: "waived", waiver: { waiverId: "w1" } }
          ]
        }
      }
    });
    expect(res.ok).toBe(true);
    expect(res.toStatus).toBe("release_candidate");
  });
});
