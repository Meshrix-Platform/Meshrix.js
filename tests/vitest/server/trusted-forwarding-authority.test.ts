import { describe, expect, it } from "vitest";
import {
  assertConsumedGovernedExecutionPermit,
  consumeGovernedExecutionPermit,
  mintGovernedExecutionPermit
} from "#meshrix/foundation/security/governed-execution-permit-authority";

function mint(overrides: Record<string, any> = {}) : any {
  return mintGovernedExecutionPermit({
    operationId: "fixture.protected",
    audience: "registered-operation-handler",
    principal: { type: "workload", subjectId: "fixture-subject", generation: "7" },
    resource: { target: "fixture-target" },
    requestDigest: "a".repeat(64),
    proofRef: "proof-fixture",
    authorization: { decisionId: "decision-fixture", policyRevision: "4" },
    approval: { approved: true },
    risk: { class: "safe_write" },
    ...overrides
  });
}

const expected: Record<string, any> = {
  operationId: "fixture.protected",
  audience: "registered-operation-handler",
  principal: { type: "workload", subjectId: "fixture-subject", generation: "7" },
  resource: { target: "fixture-target" },
  requestDigest: "a".repeat(64)
};

describe("governed execution permit authority", () : any => {
  it("mints an opaque single-use permit and brands its consumption receipt", () : any => {
    const permit: any = mint();
    expect(permit).toMatch(/^mxp_[A-Za-z0-9_-]+$/u);
    expect(permit).not.toContain("fixture.protected");
    const receipt: any = consumeGovernedExecutionPermit(permit, expected);
    expect(assertConsumedGovernedExecutionPermit(receipt, expected)).toBe(receipt);
    expect(() : any => consumeGovernedExecutionPermit(permit, expected))
      .toThrow(expect.objectContaining({ code: "governed_execution_permit_unknown_or_replayed" }));
  });

  it("consumes and denies a permit on the first wrong binding attempt", () : any => {
    const permit: any = mint();
    expect(() : any => consumeGovernedExecutionPermit(permit, {
      ...expected,
      audience: "another-sink"
    })).toThrow(expect.objectContaining({ code: "governed_execution_permit_binding_mismatch" }));
    expect(() : any => consumeGovernedExecutionPermit(permit, expected))
      .toThrow(expect.objectContaining({ code: "governed_execution_permit_unknown_or_replayed" }));
  });

  it("rejects expired permits and forged plain-object receipts", () : any => {
    const permit: any = mint({ now: 1, ttlMs: 1 });
    expect(() : any => consumeGovernedExecutionPermit(permit, expected, 2))
      .toThrow(expect.objectContaining({ code: "governed_execution_permit_expired" }));
    expect(() : any => assertConsumedGovernedExecutionPermit({
      operationId: expected.operationId,
      audience: expected.audience
    }, expected)).toThrow(expect.objectContaining({
      code: "governed_execution_permit_consumption_required"
    }));
  });
});
