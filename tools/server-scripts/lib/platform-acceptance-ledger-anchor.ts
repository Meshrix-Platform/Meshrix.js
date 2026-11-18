/**
 * Platform acceptance ledger anchoring against the operation proof substrate.
 * Report digests carry path, schemaVersion, and contentHash only — never report bodies.
 */

/**
 * @param {object} options
 * @param {object} [options.proofSubstrate]
 * @param {string[]} options.reportPaths
 * @param {object} options.evidenceContext
 * @param {string} [options.releaseId]
 * @returns {Promise<object>}
 */
export async function anchorAcceptanceEvidence({
  proofSubstrate = null,
  reportPaths = [],
  evidenceContext = {},
  releaseId = "",
  repoRoot = ""
}: Record<string, any> = {}) : Promise<any> {
  if (!proofSubstrate || typeof proofSubstrate.recordAcceptanceEvidence !== "function") {
    return {
      ledgerEventId: "",
      envelopeId: "",
      factId: "",
      workspaceId: "",
      recordedAt: "",
      reportDigestCount: 0,
      error: proofSubstrate
        ? "proof substrate does not support acceptance evidence anchoring"
        : "no proof substrate available"
    };
  }
  if (!releaseId) {
    return {
      ledgerEventId: "",
      envelopeId: "",
      factId: "",
      workspaceId: "",
      recordedAt: "",
      reportDigestCount: 0,
      error: "releaseId is required"
    };
  }
  if (!Array.isArray(reportPaths) || reportPaths.length === 0) {
    return {
      ledgerEventId: "",
      envelopeId: "",
      factId: "",
      workspaceId: "",
      recordedAt: "",
      reportDigestCount: 0,
      error: "reportPaths must be a non-empty array"
    };
  }
  const { createHash } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const path: any = await import("node:path");
  const resolvedRoot: any = path.resolve(String(repoRoot || "."));
  const reportDigests: any[] = [];
  const logicalPaths: any = [...new Set<any>(reportPaths.map((reportPath?: any) : any =>
    String(reportPath || "").replace(/\\/gu, "/")
  ))].sort();
  if (logicalPaths.length !== reportPaths.length || logicalPaths.some((reportPath?: any) : any => (
    !reportPath || path.isAbsolute(reportPath) ||
    reportPath.split("/").some((segment?: any) : any => !segment || segment === "." || segment === "..")
  ))) {
    return {
      ledgerEventId: "",
      envelopeId: "",
      factId: "",
      workspaceId: "",
      recordedAt: "",
      reportDigestCount: 0,
      error: "reportPaths must contain unique repository-relative identities"
    };
  }
  for (const reportPath of logicalPaths) {
    try {
      const absolutePath: any = path.resolve(resolvedRoot, reportPath);
      if (!absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("report path escaped repository root");
      const content: any = await readFile(absolutePath, "utf8");
      const parsed: any = JSON.parse(content);
      if (!String(parsed?.schemaVersion || "").trim()) throw new Error("report schemaVersion is missing");
      const contentHash: any = createHash("sha256").update(content).digest("hex");
      reportDigests.push({
        path: reportPath,
        schemaVersion: String(parsed?.schemaVersion || ""),
        contentHash: `sha256:${contentHash}`
      });
    } catch {
      return {
        ledgerEventId: "",
        envelopeId: "",
        factId: "",
        workspaceId: "",
        recordedAt: "",
        reportDigestCount: reportDigests.length,
        error: `report digest unavailable:${reportPath}`
      };
    }
  }
  const evidenceSetDigest: any = `sha256:${createHash("sha256")
    .update(JSON.stringify(reportDigests))
    .digest("hex")}`;
  const context: Record<string, any> = {
    schemaVersion: "v0.0.1:meshrix:acceptance-evidence-anchor-context-2",
    sourceRevision: String(evidenceContext?.sourceRevision || "").trim(),
    sourceTreeDigest: String(evidenceContext?.sourceTreeDigest || "").trim(),
    selectedProfile: String(evidenceContext?.selectedProfile || "").trim(),
    commandDagDigest: String(evidenceContext?.commandDagDigest || "").trim(),
    ownedReportsInventoryDigest: String(evidenceContext?.ownedReportsInventoryDigest || "").trim(),
    candidateDigest: String(evidenceContext?.candidateDigest || "").trim(),
    evidenceSetDigest,
    privacySafe: evidenceContext?.privacySafe === true
  };
  const SHA256: any = /^sha256:[a-f0-9]{64}$/u;
  if (!/^[a-f0-9]{40}$/u.test(context.sourceRevision) ||
      !context.selectedProfile || context.selectedProfile.length > 128 ||
      !SHA256.test(context.sourceTreeDigest) ||
      !SHA256.test(context.commandDagDigest) ||
      !SHA256.test(context.ownedReportsInventoryDigest) ||
      !/^[a-f0-9]{64}$/u.test(context.candidateDigest) ||
      context.privacySafe !== true) {
    return {
      ledgerEventId: "",
      envelopeId: "",
      factId: "",
      workspaceId: "",
      recordedAt: "",
      reportDigestCount: reportDigests.length,
      error: "acceptance evidence context is invalid"
    };
  }
  try {
    const anchor: any = await proofSubstrate.recordAcceptanceEvidence({
      reportDigests,
      evidenceContext: context,
      releaseId,
      actor: { type: "system", role: "acceptance-reducer" }
    });
    return {
      ledgerEventId: String(anchor?.ledgerEventId || ""),
      envelopeId: String(anchor?.envelopeId || ""),
      factId: String(anchor?.factId || ""),
      workspaceId: String(anchor?.workspaceId || ""),
      recordedAt: String(anchor?.recordedAt || ""),
      reportDigestCount: reportDigests.length,
      reportDigests,
      evidenceContext: context,
      error: ""
    };
  } catch (err: any) {
    return {
      ledgerEventId: "",
      envelopeId: "",
      factId: "",
      workspaceId: "",
      recordedAt: "",
      reportDigestCount: reportDigests.length,
      error: String(err?.message || "acceptance evidence anchoring failed")
    };
  }
}

/**
 * Prove a recorded acceptance anchor against the current proof substrate.
 */
export async function verifyAcceptanceEvidenceAnchor({
  proofSubstrate = null,
  ledgerEventId = "",
  envelopeId = "",
  workspaceId = "",
  expectedReportDigests = [],
  expectedEvidenceContext = null
}: Record<string, any> = {}) : Promise<any> {
  if (!proofSubstrate) {
    return { ok: false, reason: "no_proof_substrate" };
  }
  const eventId: any = String(ledgerEventId || "").trim();
  const resolvedEnvelopeId: any = String(envelopeId || "").trim();
  if (!eventId && !resolvedEnvelopeId) {
    return { ok: false, reason: "ledger_event_id_missing" };
  }
  if (!Array.isArray(expectedReportDigests) || expectedReportDigests.length === 0) {
    return { ok: false, reason: "expected_report_digests_missing" };
  }
  let cryptographicallyVerified: any = false;
  if (resolvedEnvelopeId && typeof proofSubstrate.exportProofBundle === "function") {
    try {
      const bundle: any = await proofSubstrate.exportProofBundle({
        ledgerEventId: eventId,
        envelopeId: resolvedEnvelopeId,
        actor: { type: "system" }
      });
      const verification: any = typeof proofSubstrate.verifyReceipt === "function"
        ? await proofSubstrate.verifyReceipt({ bundle })
        : { ok: Boolean(bundle) };
      if (verification?.ok === true) {
        cryptographicallyVerified = true;
      }
    } catch {
      return { ok: false, reason: "proof_bundle_verification_failed" };
    }
  }
  if (!cryptographicallyVerified || !eventId || typeof proofSubstrate.verifyReceiptCommitment !== "function") {
    return { ok: false, reason: "cryptographic_entry_verification_unavailable" };
  }
  if (!expectedEvidenceContext) {
    return { ok: false, reason: "expected_evidence_context_missing" };
  }
  const releaseId: any = String(workspaceId || "").replace(/^release:/u, "");
  const commitment: any = await proofSubstrate.verifyReceiptCommitment({
    ledgerEventId: eventId,
    commitment: {
      kind: "acceptance-evidence",
      releaseId,
      reportDigests: expectedReportDigests.map(({ path: reportPath, schemaVersion, contentHash }: Record<string, any>) : any => ({
        path: String(reportPath || ""),
        schemaVersion: String(schemaVersion || ""),
        contentHash: String(contentHash || "")
      })).sort((left?: any, right?: any) : any => left.path.localeCompare(right.path)),
      evidenceContext: expectedEvidenceContext
    }
  });
  if (commitment?.ok !== true) {
    return { ok: false, reason: commitment?.reason || "receipt_commitment_mismatch" };
  }
  return {
    ok: true,
    ledgerEventId: eventId,
    envelopeId: resolvedEnvelopeId,
    workspaceId: String(workspaceId || ""),
    source: "verified-receipt-commitment"
  };
}
