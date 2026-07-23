import { describe, expect, it } from "vitest";
import {
  assertEvidencePolicyReadiness,
  evaluateEvidencePolicyReadiness
} from "../../../tools/server-scripts/lib/operation-proof-evidence-policy.mjs";

describe("operation proof evidence policy readiness", () => {
  it("fails when production policy is declared without a signer", () => {
    const result = evaluateEvidencePolicyReadiness({
      evidencePolicy: "production",
      signerSecret: ""
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/LICO_OPERATION_PROOF_SIGNER_SECRET/);
    expect(() => assertEvidencePolicyReadiness({
      evidencePolicy: "production",
      signerSecret: ""
    })).toThrow(/LICO_OPERATION_PROOF_SIGNER_SECRET/);
  });

  it("passes when production policy and signer are consistent", () => {
    const result = evaluateEvidencePolicyReadiness({
      evidencePolicy: "production",
      signerSecret: "fixture-signer-not-a-real-secret"
    });
    expect(result.ok).toBe(true);
    expect(() => assertEvidencePolicyReadiness({
      evidencePolicy: "production",
      signerSecret: "fixture-signer-not-a-real-secret"
    })).not.toThrow();
  });

  it("passes for development policy without a signer", () => {
    expect(evaluateEvidencePolicyReadiness({
      evidencePolicy: "development",
      signerSecret: ""
    }).ok).toBe(true);
  });

  it("passes when policy is undeclared", () => {
    expect(evaluateEvidencePolicyReadiness({
      evidencePolicy: "",
      signerSecret: ""
    }).ok).toBe(true);
  });

  it("rejects unknown policy values", () => {
    const result = evaluateEvidencePolicyReadiness({
      evidencePolicy: "staging",
      signerSecret: "x"
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/development.*production/);
  });
});
