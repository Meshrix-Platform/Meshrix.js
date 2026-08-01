/**
 * Operation proof evidence policy readiness.
 * Enforces consistency between declared policy and signer presence.
 * Does not invent user-configuration defaults.
 */

const VALID_POLICIES: any = new Set<any>(["development", "production", ""]);

/**
 * @param {{ evidencePolicy?: string, signerSecret?: string, signerSecretFile?: string }} [input]
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateEvidencePolicyReadiness({
  evidencePolicy = "",
  signerSecret = "",
  signerSecretFile = ""
}: Record<string, any> = {}) : any {
  const policy: any = String(evidencePolicy || "").trim();
  const secret: any = String(signerSecret || "").trim();
  const secretFile: any = String(signerSecretFile || "").trim();

  if (policy && !VALID_POLICIES.has(policy)) {
    return {
      ok: false,
      reason:
        `MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY must be "development" or "production", got "${policy}".`
    };
  }

  if (policy === "production" && !secret && !secretFile) {
    return {
      ok: false,
      reason:
        "Production evidence policy (MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY=production) " +
        "requires a configured signer secret file " +
        "(MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE) or an explicitly injected signer. " +
        "Without a signer, production-verifiable evidence is unavailable and startup must fail closed. " +
        "See docs/RUNBOOK.md for signer provisioning and rotation."
    };
  }

  return { ok: true, reason: "" };
}

/**
 * @param {{ evidencePolicy?: string, signerSecret?: string, signerSecretFile?: string }} [input]
 */
export function assertEvidencePolicyReadiness(input: Record<string, any> = {}) : any {
  const result: any = evaluateEvidencePolicyReadiness(input);
  if (!result.ok) {
    const error: Error & Record<string, any> = new Error(result.reason);
    error.code = "EVIDENCE_POLICY_NOT_READY";
    throw error;
  }
  return result;
}

/**
 * Read readiness from process environment.
 */
export function assertEvidencePolicyReadinessFromEnv(env: any = process.env) : any {
  return assertEvidencePolicyReadiness({
    evidencePolicy: env.MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY,
    signerSecretFile: env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE
  });
}
