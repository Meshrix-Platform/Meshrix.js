import { describe, expect, it, vi } from "vitest";

import {
  assertConsumedGovernedExecutionPermit,
  mintGovernedExecutionPermit
} from "#meshrix/foundation/security/governed-execution-permit-authority";
import {
  createFinalProtectedSinkPermitGuard
} from "#meshrix/foundation/security/final-protected-sink-permit";

const NOW: any = 1_900_000_000_000;
const SUBJECT: Readonly<Record<string, any>> = Object.freeze({
  generation: "17",
  subjectId: "fixture-workload-subject",
  tenantId: "fixture-tenant",
  type: "workload"
});
const EFFECT: Readonly<Record<string, any>> = Object.freeze({
  kind: "protected-state-transition",
  targetDigest: "b".repeat(64)
});
const CONTEXT: Readonly<Record<string, any>> = Object.freeze({
  approvalRevision: "23",
  grantRevision: "31",
  policyRevision: "47",
  resourceRevision: "59",
  riskRevision: "11",
  workloadGeneration: "17"
});
const OPERATION_ID: any = "fixture.protected-effect";
const AUDIENCE: any = "fixture-final-protected-effect";
const REQUEST_DIGEST: any = "a".repeat(64);
const SHORT_PRIVATE_PROOF_MARKER: any = "pvt7";
const ONE_MIB_PRIVATE_PROOF_MARKER: any = "one-mib-private-proof-marker";
const PROOF_REF: any = `proof:${SHORT_PRIVATE_PROOF_MARKER}`;
const PROOF_REF_DIGEST: any =
  "sha256:6a2b226079681a43e9efa195330192ca664960c1aaacdd81b5e0456de144010d";
const MAX_BYTE_PROOF_REF: any = "é".repeat(128);
const MAX_BYTE_PROOF_REF_DIGEST: any =
  "sha256:cb06c809addd449fcc81f660cab7cf16162b77bc093ea6c31a53c4929a793fa0";
const ONE_MIB_PRIVATE_PROOF_REF: any =
  `${ONE_MIB_PRIVATE_PROOF_MARKER}${"x".repeat(
    (1024 * 1024) - Buffer.byteLength(ONE_MIB_PRIVATE_PROOF_MARKER, "utf8")
  )}`;
const PROTECTED_MARKERS: readonly any[] = Object.freeze([
  SUBJECT.subjectId,
  SUBJECT.tenantId,
  SHORT_PRIVATE_PROOF_MARKER,
  ONE_MIB_PRIVATE_PROOF_MARKER,
  "fixture-private-request-content",
  "fixture-private-context-content"
]);
const RECEIPT_KEYS: readonly any[] = Object.freeze([
  "approvalDigest",
  "audience",
  "authorizationDigest",
  "consumedAt",
  "operationId",
  "permitDigest",
  "principalDigest",
  "proofRef",
  "requestDigest",
  "resourceDigest",
  "riskDigest",
  "schemaVersion"
]);

function binding(overrides: Record<string, any> = {}) : any {
  const {
    context: contextOverrides = {},
    effect: effectOverrides = {},
    subject: subjectOverrides = {},
    ...topLevelOverrides
  } = overrides;
  return Object.freeze({
    audience: AUDIENCE,
    subject: Object.freeze({ ...SUBJECT, ...subjectOverrides }),
    operationId: OPERATION_ID,
    effect: Object.freeze({ ...EFFECT, ...effectOverrides }),
    requestDigest: REQUEST_DIGEST,
    context: Object.freeze({ ...CONTEXT, ...contextOverrides }),
    ...topLevelOverrides
  });
}

const EXACT_BINDING: any = binding();

function authorityExpected(value: any = EXACT_BINDING) : any {
  return {
    audience: value.audience,
    operationId: value.operationId,
    principal: value.subject,
    requestDigest: value.requestDigest,
    resource: {
      context: value.context,
      effect: value.effect
    }
  };
}

function mintForBinding(value: any = EXACT_BINDING, overrides: Record<string, any> = {}) : any {
  return mintGovernedExecutionPermit({
    ...authorityExpected(value),
    approval: {
      approvalRevision: value.context.approvalRevision
    },
    authorization: {
      grantRevision: value.context.grantRevision,
      policyRevision: value.context.policyRevision,
      resourceRevision: value.context.resourceRevision,
      workloadGeneration: value.context.workloadGeneration
    },
    now: NOW,
    proofRef: PROOF_REF,
    risk: {
      effectKind: value.effect.kind,
      riskRevision: value.context.riskRevision
    },
    ttlMs: 1_000,
    ...overrides
  });
}

function createHarness({
  allowed = true,
  currentBinding = EXACT_BINDING,
  revoked = false
}: Record<string, any> = {}) : any {
  const state: Record<string, any> = {
    allowed,
    currentBinding,
    revoked
  };
  const revalidateCurrentAuthority: any = vi.fn(async () : Promise<any> => Object.freeze({
    allowed: state.allowed,
    currentBinding: state.currentBinding,
    revoked: state.revoked
  }));
  const guard: any = createFinalProtectedSinkPermitGuard({
    now: () : any => NOW,
    revalidateCurrentAuthority
  });
  return {
    consume(permit?: any, expectedBinding: any = EXACT_BINDING) : any {
      return guard.consume({
        binding: expectedBinding,
        permit
      });
    },
    guard,
    revalidateCurrentAuthority,
    state
  };
}

async function captureFailure(action?: any) : Promise<any> {
  try {
    await action();
  } catch (error: any) {
    return error;
  }
  throw new Error("Expected final protected sink permit consumption to fail.");
}

function expectPrivateMarkersAbsent(value?: any) : any {
  const serialized: any = JSON.stringify(value);
  for (const marker of PROTECTED_MARKERS) {
    expect(serialized).not.toContain(marker);
  }
}

function expectBoundedDenial(error?: any) : any {
  const projection: Record<string, any> = {
    code: error?.code,
    message: error?.message,
    statusCode: error?.statusCode
  };
  expect(typeof projection.code).toBe("string");
  expect(Buffer.byteLength(JSON.stringify(projection), "utf8"))
    .toBeLessThanOrEqual(512);
  expectPrivateMarkersAbsent(projection);
}

function expectCanonicalReceipt(
  receipt?: any,
  { proofRefDigest = PROOF_REF_DIGEST }: Record<string, any> = {}
) : any {
  expect(Object.keys(receipt).sort()).toEqual([...RECEIPT_KEYS].sort());
  expect(receipt).toMatchObject({
    audience: AUDIENCE,
    operationId: OPERATION_ID,
    permitDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    proofRef: proofRefDigest,
    requestDigest: REQUEST_DIGEST,
    schemaVersion:
      "v0.0.1:security:governed-execution-permit-consumption-1"
  });
  expect(receipt.proofRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(Buffer.byteLength(receipt.proofRef, "utf8")).toBe(71);
  expect(Buffer.byteLength(JSON.stringify(receipt), "utf8"))
    .toBeLessThanOrEqual(1_024);
  expectPrivateMarkersAbsent(receipt);
  expect(
    assertConsumedGovernedExecutionPermit(
      receipt,
      authorityExpected(EXACT_BINDING)
    )
  ).toBe(receipt);
}

describe("final protected sink permit primitive", () : any => {
  it("returns one canonical branded receipt and rejects caller-authored authority", async () : Promise<any> => {
    const permit: any = mintForBinding();
    const harness: any = createHarness();

    expect(Object.keys(harness.guard)).toEqual(["consume"]);
    expect(permit).toMatch(/^mxp_[A-Za-z0-9_-]+$/u);
    expect(permit).not.toContain(OPERATION_ID);
    expect(permit).not.toContain(AUDIENCE);
    expectPrivateMarkersAbsent(permit);

    const receipt: any = await harness.consume(permit);

    expectCanonicalReceipt(receipt);
    expect(harness.revalidateCurrentAuthority).toHaveBeenCalledTimes(1);
    const revalidationInput: any =
      harness.revalidateCurrentAuthority.mock.calls[0][0];
    expect(Object.keys(revalidationInput).sort()).toEqual([
      "binding",
      "consumptionReceipt"
    ]);
    expect(revalidationInput.binding).toEqual(EXACT_BINDING);
    expect(Object.isFrozen(revalidationInput.binding)).toBe(true);
    expect(Object.isFrozen(revalidationInput.binding.subject)).toBe(true);
    expect(Object.isFrozen(revalidationInput.binding.effect)).toBe(true);
    expect(Object.isFrozen(revalidationInput.binding.context)).toBe(true);
    expect(revalidationInput.consumptionReceipt).toBe(receipt);

    expect(() : any => assertConsumedGovernedExecutionPermit(
      { ...receipt },
      authorityExpected(EXACT_BINDING)
    )).toThrow(expect.objectContaining({
      code: "governed_execution_permit_consumption_required"
    }));

    const successfulReplay: any = await captureFailure(() : any =>
      harness.consume(permit)
    );
    expect(successfulReplay).toEqual(expect.objectContaining({
      code: "governed_execution_permit_unknown_or_replayed"
    }));
    expectBoundedDenial(successfulReplay);

    const fabricatedInputs: any[] = [
      {
        permit: "",
        expectedCode: "final_protected_sink_permit_required"
      },
      {
        permit: {
          audience: AUDIENCE,
          binding: EXACT_BINDING,
          permitDigest: receipt.permitDigest
        },
        expectedCode: "final_protected_sink_permit_required"
      },
      {
        permit: `mxp_${"z".repeat(43)}`,
        expectedCode: "governed_execution_permit_unknown_or_replayed"
      },
      {
        permit: `mxp_${"y".repeat(43)}`,
        expectedBinding: Object.freeze({
          ...EXACT_BINDING,
          callerDecision: true
        }),
        expectedCode: "final_protected_sink_permit_binding_invalid"
      },
      {
        permit: `mxp_${"x".repeat(43)}`,
        expectedBinding: binding({
          context: { callerDecision: true }
        }),
        expectedCode: "final_protected_sink_permit_binding_invalid"
      }
    ];
    for (const fabricated of fabricatedInputs) {
      const error: any = await captureFailure(() : any =>
        harness.consume(
          fabricated.permit,
          fabricated.expectedBinding || EXACT_BINDING
        )
      );
      expect(error).toEqual(expect.objectContaining({
        code: fabricated.expectedCode
      }));
      expectBoundedDenial(error);
    }
    expect(harness.revalidateCurrentAuthority).toHaveBeenCalledTimes(1);
  });

  it("validates raw proof-reference byte and control boundaries before minting and never returns proof content", async () : Promise<any> => {
    expect(Buffer.byteLength(MAX_BYTE_PROOF_REF, "utf8")).toBe(256);
    expect(Buffer.byteLength(ONE_MIB_PRIVATE_PROOF_REF, "utf8"))
      .toBe(1024 * 1024);

    const boundaryPermit: any = mintForBinding(EXACT_BINDING, {
      proofRef: MAX_BYTE_PROOF_REF
    });
    const boundaryHarness: any = createHarness();
    const boundaryReceipt: any = await boundaryHarness.consume(boundaryPermit);

    expectCanonicalReceipt(boundaryReceipt, {
      proofRefDigest: MAX_BYTE_PROOF_REF_DIGEST
    });
    expect(boundaryReceipt.proofRef).not.toContain(MAX_BYTE_PROOF_REF);
    expect(boundaryHarness.revalidateCurrentAuthority).toHaveBeenCalledTimes(1);

    const invalidProofReferences: any[] = [
      "é".repeat(129),
      `${PROOF_REF}\n`,
      `${PROOF_REF}\u0000suffix`,
      ONE_MIB_PRIVATE_PROOF_REF
    ];
    for (const proofRef of invalidProofReferences) {
      let mintedPermit: any;
      const error: any = await captureFailure(() : any => {
        mintedPermit = mintForBinding(EXACT_BINDING, { proofRef });
        return mintedPermit;
      });

      expect(mintedPermit).toBeUndefined();
      expect(error).toEqual(expect.objectContaining({
        code: "governed_execution_permit_proof_ref_invalid"
      }));
      expectBoundedDenial(error);
    }
  });

  it("burns every structurally valid audience, subject, operation, effect, request, or context substitution", async () : Promise<any> => {
    const substitutions: any[] = [
      {
        id: "audience",
        expectedCode: "governed_execution_permit_binding_mismatch",
        value: binding({ audience: "fixture-other-protected-effect" })
      },
      {
        id: "subject",
        expectedCode: "governed_execution_permit_principal_mismatch",
        value: binding({
          subject: { subjectId: "fixture-other-workload" }
        })
      },
      {
        id: "operation",
        expectedCode: "governed_execution_permit_binding_mismatch",
        value: binding({ operationId: "fixture.other-protected-effect" })
      },
      {
        id: "effect",
        expectedCode: "governed_execution_permit_resource_mismatch",
        value: binding({
          effect: { targetDigest: "c".repeat(64) }
        })
      },
      {
        id: "request",
        expectedCode: "governed_execution_permit_binding_mismatch",
        value: binding({ requestDigest: "d".repeat(64) })
      },
      {
        id: "context",
        expectedCode: "governed_execution_permit_resource_mismatch",
        value: binding({
          context: { grantRevision: "32" }
        })
      }
    ];

    for (const substitution of substitutions) {
      const permit: any = mintForBinding();
      const harness: any = createHarness();
      const denied: any = await captureFailure(() : any =>
        harness.consume(permit, substitution.value)
      );

      expect(denied).toEqual(expect.objectContaining({
        code: substitution.expectedCode
      }));
      expectBoundedDenial(denied);
      expect(harness.revalidateCurrentAuthority).not.toHaveBeenCalled();

      const replayed: any = await captureFailure(() : any =>
        harness.consume(permit, EXACT_BINDING)
      );
      expect(replayed).toEqual(expect.objectContaining({
        code: "governed_execution_permit_unknown_or_replayed"
      }));
      expectBoundedDenial(replayed);
      expect(harness.revalidateCurrentAuthority).not.toHaveBeenCalled();
    }
  });

  it("makes expiry, current denial, revocation, and current-binding drift terminal", async () : Promise<any> => {
    const expiredPermit: any = mintForBinding(EXACT_BINDING, {
      now: NOW - 2_000,
      ttlMs: 1
    });
    const expiredHarness: any = createHarness();
    const expired: any = await captureFailure(() : any =>
      expiredHarness.consume(expiredPermit)
    );
    expect(expired).toEqual(expect.objectContaining({
      code: "governed_execution_permit_expired"
    }));
    expectBoundedDenial(expired);
    expect(expiredHarness.revalidateCurrentAuthority).not.toHaveBeenCalled();
    const expiredReplay: any = await captureFailure(() : any =>
      expiredHarness.consume(expiredPermit)
    );
    expect(expiredReplay).toEqual(expect.objectContaining({
      code: "governed_execution_permit_unknown_or_replayed"
    }));

    const deniedPermit: any = mintForBinding();
    const deniedHarness: any = createHarness({
      allowed: false
    });
    const denied: any = await captureFailure(() : any =>
      deniedHarness.consume(deniedPermit)
    );
    expect(denied).toEqual(expect.objectContaining({
      code: "final_protected_sink_permit_denied"
    }));
    expectBoundedDenial(denied);
    expect(deniedHarness.revalidateCurrentAuthority).toHaveBeenCalledTimes(1);
    deniedHarness.state.allowed = true;
    const deniedReplay: any = await captureFailure(() : any =>
      deniedHarness.consume(deniedPermit)
    );
    expect(deniedReplay).toEqual(expect.objectContaining({
      code: "governed_execution_permit_unknown_or_replayed"
    }));
    expect(deniedHarness.revalidateCurrentAuthority).toHaveBeenCalledTimes(1);

    const revokedPermit: any = mintForBinding();
    const revokedHarness: any = createHarness({
      allowed: false,
      revoked: true
    });
    const revoked: any = await captureFailure(() : any =>
      revokedHarness.consume(revokedPermit)
    );
    expect(revoked).toEqual(expect.objectContaining({
      code: "final_protected_sink_permit_revoked"
    }));
    expectBoundedDenial(revoked);
    expect(revokedHarness.revalidateCurrentAuthority).toHaveBeenCalledTimes(1);
    revokedHarness.state.allowed = true;
    revokedHarness.state.revoked = false;
    const revokedReplay: any = await captureFailure(() : any =>
      revokedHarness.consume(revokedPermit)
    );
    expect(revokedReplay).toEqual(expect.objectContaining({
      code: "governed_execution_permit_unknown_or_replayed"
    }));
    expect(revokedHarness.revalidateCurrentAuthority).toHaveBeenCalledTimes(1);

    const driftedPermit: any = mintForBinding();
    const driftedHarness: any = createHarness({
      currentBinding: binding({
        context: { policyRevision: "48" }
      })
    });
    const drifted: any = await captureFailure(() : any =>
      driftedHarness.consume(driftedPermit)
    );
    expect(drifted).toEqual(expect.objectContaining({
      code: "final_protected_sink_permit_current_binding_mismatch"
    }));
    expectBoundedDenial(drifted);
    expect(driftedHarness.revalidateCurrentAuthority).toHaveBeenCalledTimes(1);
    driftedHarness.state.currentBinding = EXACT_BINDING;
    const driftedReplay: any = await captureFailure(() : any =>
      driftedHarness.consume(driftedPermit)
    );
    expect(driftedReplay).toEqual(expect.objectContaining({
      code: "governed_execution_permit_unknown_or_replayed"
    }));
    expect(driftedHarness.revalidateCurrentAuthority).toHaveBeenCalledTimes(1);
  });

  it("allows exactly one winner when the same permit is consumed concurrently", async () : Promise<any> => {
    const permit: any = mintForBinding();
    const harness: any = createHarness();

    const outcomes: any = await Promise.allSettled([
      harness.consume(permit),
      harness.consume(permit)
    ]);
    const fulfilled: any = outcomes.filter(
      (outcome?: any) : any => outcome.status === "fulfilled"
    );
    const rejected: any = outcomes.filter(
      (outcome?: any) : any => outcome.status === "rejected"
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectCanonicalReceipt(fulfilled[0].value);
    expect(rejected[0].reason).toEqual(expect.objectContaining({
      code: "governed_execution_permit_unknown_or_replayed"
    }));
    expectBoundedDenial(rejected[0].reason);
    expect(harness.revalidateCurrentAuthority).toHaveBeenCalledTimes(1);
  });
});
