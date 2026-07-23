/**
 * Operation proof evidence policy readiness.
 * Enforces consistency between declared policy and signer presence.
 * Does not invent user-configuration defaults.
 */

const VALID_POLICIES = new Set(["development", "production", ""]);

/**
 * @param {{ evidencePolicy?: string, signerSecret?: string }} [input]
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateEvidencePolicyReadiness({
  evidencePolicy = "",
  signerSecret = ""
} = {}) {
  const policy = String(evidencePolicy || "").trim();
  const secret = String(signerSecret || "").trim();

  if (policy && !VALID_POLICIES.has(policy)) {
    return {
      ok: false,
      reason:
        `LICO_OPERATION_PROOF_EVIDENCE_POLICY must be "development" or "production", got "${policy}".`
    };
  }

  if (policy === "production" && !secret) {
    return {
      ok: false,
      reason:
        "Production evidence policy (LICO_OPERATION_PROOF_EVIDENCE_POLICY=production) " +
        "requires a configured signer (LICO_OPERATION_PROOF_SIGNER_SECRET). " +
        "Without a signer, production deployments silently produce non-verifiable evidence. " +
        "See docs/RUNBOOK.md for signer provisioning and rotation."
    };
  }

  return { ok: true, reason: "" };
}

/**
 * @param {{ evidencePolicy?: string, signerSecret?: string }} [input]
 */
export function assertEvidencePolicyReadiness(input = {}) {
  const result = evaluateEvidencePolicyReadiness(input);
  if (!result.ok) {
    const error = new Error(result.reason);
    error.code = "EVIDENCE_POLICY_NOT_READY";
    throw error;
  }
  return result;
}

/**
 * Read readiness from process environment.
 */
export function assertEvidencePolicyReadinessFromEnv(env = process.env) {
  return assertEvidencePolicyReadiness({
    evidencePolicy: env.LICO_OPERATION_PROOF_EVIDENCE_POLICY,
    signerSecret: env.LICO_OPERATION_PROOF_SIGNER_SECRET
  });
}
