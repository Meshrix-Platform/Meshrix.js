import crypto from "node:crypto";
import path from "node:path";

import {
  finalValidationBinding,
  normalizePlanProfiles,
  parentIntegrationBinding,
  planReceiptKey,
  profilesContain,
} from "./plan-dependency-map.ts";

export const RECEIPT_SCHEMA: any = "v0.0.1:meshrix:plan-final-receipt-4";
export const REPORT_DIGEST_ALGORITHM: any = "canonical-json-without-observation-time";
const ABSOLUTE_PATH_PATTERN: any = /(?:^|[\s"'`=(])(?:\/(?:Users|home|private|var|tmp)\/|[A-Za-z]:\\)/u;
const VOLATILE_REPORT_KEYS: any = new Set<any>(["checkedAt", "generatedAt"]);
const SHA256_PATTERN: any = /^[a-f0-9]{64}$/u;

function fail(message?: any) : any { throw new Error(message); }
function requireCondition(condition?: any, message?: any) : any { if (!condition) fail(message); }

export function digest(value?: any) : any {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalValue(value?: any) : any {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key?: any) : any => [key, canonicalValue(value[key])]));
}

function canonicalReportValue(value?: any) : any {
  if (Array.isArray(value)) return value.map(canonicalReportValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value)
    .filter((key?: any) : any => !VOLATILE_REPORT_KEYS.has(key))
    .sort()
    .map((key?: any) : any => [key, canonicalReportValue(value[key])]));
}

export function canonicalDigest(value?: any) : any {
  return digest(JSON.stringify(canonicalValue(value)));
}

export function reportDigest(reportText?: any) : any {
  return digest(JSON.stringify(canonicalReportValue(JSON.parse(reportText))));
}

export function isPrivacySafeValue(value?: any) : any {
  if (typeof value !== "string") return true;
  if (value.includes("<repo-root>") || value.includes("<user-home>")) {
    return !ABSOLUTE_PATH_PATTERN.test(value.replaceAll("<repo-root>", "").replaceAll("<user-home>", ""));
  }
  return !ABSOLUTE_PATH_PATTERN.test(value) && !value.startsWith("/Users/") && !value.startsWith("/home/");
}

function privacySafeTree(value?: any) : any {
  if (Array.isArray(value)) return value.every(privacySafeTree);
  if (value && typeof value === "object") return (Object.values(value) as any[]).every(privacySafeTree);
  return isPrivacySafeValue(value);
}

function bindEvidenceRef(ref?: any) : any {
  requireCondition(ref && typeof ref === "object", "Evidence ref is invalid");
  let bound: any;
  if (ref.type === "file") {
    bound = {
      type: "file",
      path: String(ref.path || ""),
      sha256: ref.sha256 ?? null,
      recorded_at: ref.recorded_at ?? null
    };
  } else if (ref.type === "command") {
    requireCondition(!Object.hasOwn(ref, "command"), "Command evidence must not contain command text");
    requireCondition(SHA256_PATTERN.test(ref.command_sha256), "Command evidence command_sha256 is invalid");
    requireCondition(
      Object.keys(ref).every((key?: any) : any => ["type", "command_sha256", "exit_code", "recorded_at"].includes(key)),
      "Command evidence contains an unsupported field"
    );
    bound = {
      type: "command",
      command_sha256: ref.command_sha256,
      exit_code: ref.exit_code ?? null,
      recorded_at: ref.recorded_at ?? null
    };
  } else {
    fail(`Unknown evidence ref type ${ref.type}`);
  }
  requireCondition(privacySafeTree(bound), "Evidence reference is not privacy-safe");
  return { ...bound, declaration_digest: canonicalDigest(bound) };
}

function currentEvidenceRefs(finalNode?: any) : any {
  return (finalNode.acceptance_criteria ?? []).flatMap((criterion?: any) : any =>
    (criterion.evidence_refs ?? []).map(bindEvidenceRef)
  );
}

function currentPrerequisiteReceipts(
  mapPlan?: any,
  finalProfiles?: any,
  candidateDigest?: any,
  prerequisiteReceiptsByKey: Record<string, any> = {},
  prerequisiteContractReceiptsByKey: Record<string, any> = {},
  candidateReceiptKeys: any = new Set<any>()
) : any {
  return (mapPlan.prerequisite_receipts ?? []).flatMap((receipt?: any) : any => {
    requireCondition(receipt && typeof receipt === "object", "Prerequisite receipt declaration is invalid");
    requireCondition(receipt.kind === "contract" || receipt.kind === "final_validation", "Prerequisite receipt kind is invalid");
    const profiles: any = normalizePlanProfiles(receipt.profiles, "Prerequisite receipt profiles are invalid");
    if (!profiles.some((profile?: any) : any => finalProfiles.includes(profile))) return [];
    requireCondition(
      profilesContain(finalProfiles, profiles),
      "Prerequisite receipt spans more than one final-validation profile owner",
    );
    const key: any = planReceiptKey(receipt.plan, receipt.node_id, receipt.kind);
    const accepted: any = receipt.kind === "contract"
      ? prerequisiteContractReceiptsByKey[key]
      : prerequisiteReceiptsByKey[key];
    requireCondition(accepted && typeof accepted === "object", `Prerequisite ${receipt.kind} receipt is missing`);
    requireCondition(accepted.plan === receipt.plan, "Prerequisite receipt plan identity is mismatched");
    requireCondition(
      (receipt.kind === "contract" ? accepted.node_id : accepted.final_node_id) === receipt.node_id,
      "Prerequisite receipt node identity is mismatched"
    );
    requireCondition(
      receipt.kind === "contract"
        ? accepted.schema_version === "v0.0.1:meshrix:plan-contract-receipt-1" && accepted.kind === "contract"
        : accepted.schema_version === RECEIPT_SCHEMA && accepted.role === "final_validation",
      "Prerequisite receipt kind is mismatched"
    );
    requireCondition(accepted.status === "completed", "Prerequisite receipt is not completed");
    if (receipt.kind === "final_validation") {
      requireCondition(
        profilesContain(accepted.profiles, profiles),
        "Prerequisite receipt profiles are mismatched",
      );
      requireCondition(
        SHA256_PATTERN.test(String(accepted.candidate_digest || "")) &&
          accepted.candidate_digest === candidateDigest,
        "Prerequisite receipt candidate is mismatched",
      );
    }
    requireCondition(accepted.privacy_safe === true && privacySafeTree(accepted), "Prerequisite receipt is privacy-unsafe");
    requireCondition(
      receipt.kind === "contract"
        ? accepted.verified === true
        : accepted.proof_anchor?.verified === true || candidateReceiptKeys.has(key),
      "Prerequisite receipt is not verified"
    );
    requireCondition(
      accepted.receipt_digest === canonicalDigest(receiptFacts(accepted)),
      "Prerequisite receipt digest is stale"
    );
    return [{
      plan: String(receipt?.plan || ""),
      node_id: String(receipt?.node_id || ""),
      kind: String(receipt?.kind || ""),
      profiles,
      receipt_digest: accepted.receipt_digest,
      ...(receipt.kind === "final_validation"
        ? { candidate_digest: accepted.candidate_digest }
        : {}),
    }];
  });
}

function receiptFacts(receipt?: any) : any {
  const { proof_anchor: _proofAnchor, receipt_digest: _receiptDigest, ...facts } = receipt;
  return facts;
}

export function bindPlanReceiptProofAnchor(receipt?: any, proofAnchor?: any) : any {
  requireCondition(receipt?.receipt_digest, "Plan receipt digest is missing");
  requireCondition(proofAnchor?.receipt_digest === receipt.receipt_digest, "Plan receipt proof anchor digest is mismatched");
  requireCondition(proofAnchor?.verified === true, "Plan receipt proof anchor is not verified");
  return { ...receipt, proof_anchor: proofAnchor };
}

export function buildPlanFinalReceipt({
  planDirectory,
  mapPlan,
  planText = "",
  checkpointsText,
  finalNode,
  repositoryRevision = finalNode?.commit?.delivered || "",
  repositoryTreeDigest = "",
  commandDagDigest = "",
  ownedReportsInventoryDigest = "",
  prerequisiteReceiptsByKey = {},
  prerequisiteContractReceiptsByKey = {},
  candidateReceiptKeys = new Set<any>()
}: Record<string, any>) : any {
  requireCondition(mapPlan?.directory === undefined || mapPlan.directory === planDirectory, "Plan directory and DependencyMap identity are mismatched");
  const finalBinding: any = finalValidationBinding(mapPlan, finalNode?.id);
  requireCondition(finalNode?.role === "final_validation", "Final node role must be final_validation");
  requireCondition(finalNode.status === "completed", "Final node must be completed before receipt reduction");
  requireCondition(finalNode.acceptance_criteria?.length > 0 && finalNode.acceptance_criteria.every((criterion?: any) : any => criterion.checked === true), "Final node has unchecked acceptance criteria");
  requireCondition(finalNode.requirements?.length > 0, "Final node requirements are missing");
  requireCondition(finalNode.platform, "Final node platform is missing");
  requireCondition(finalNode.commit?.delivered, "Final node source revision (commit.delivered) is missing");
  const profiles: any = normalizePlanProfiles(finalBinding.profiles, "Final receipt profiles are invalid");
  requireCondition(
    Object.hasOwn(finalNode, "candidate_digest"),
    "Final node candidate digest is required",
  );
  const candidateDigest: any = String(finalNode.candidate_digest);
  requireCondition(
    SHA256_PATTERN.test(candidateDigest),
    "Final node candidate digest is invalid",
  );
  const parentIntegration: any = parentIntegrationBinding(mapPlan, finalNode.id);
  const evidenceRefs: any = currentEvidenceRefs(finalNode);
  requireCondition(evidenceRefs.length > 0, "Final node has no privacy-safe evidence references");
  const prerequisites: any = currentPrerequisiteReceipts(
    mapPlan,
    profiles,
    candidateDigest,
    prerequisiteReceiptsByKey,
    prerequisiteContractReceiptsByKey,
    candidateReceiptKeys
  );
  const receipt: Record<string, any> = {
    schema_version: RECEIPT_SCHEMA,
    plan: planDirectory,
    final_node_id: finalNode.id,
    parent_contract_node_id: mapPlan.parent_contract_node_id,
    parent_integration_node_id: parentIntegration?.parent_node_id ?? null,
    plan_digest: digest(planText),
    checkpoint_digest: digest(checkpointsText),
    final_node_digest: canonicalDigest(finalNode),
    status: finalNode.status,
    role: finalNode.role,
    platform: finalNode.platform,
    profiles,
    requirements: [...finalNode.requirements],
    checked_criteria: finalNode.acceptance_criteria.map((criterion?: any, index?: any) : any => ({ index, checked: true, text: criterion.text })),
    evidence_refs: evidenceRefs,
    evidence_set_digest: canonicalDigest(evidenceRefs),
    prerequisite_receipts: prerequisites,
    prerequisite_receipt_set_digest: canonicalDigest(prerequisites),
    candidate_digest: candidateDigest,
    source_revision: finalNode.commit.delivered,
    repository_revision: repositoryRevision,
    repository_tree_digest: repositoryTreeDigest,
    command_dag_digest: commandDagDigest,
    owned_reports_inventory_digest: ownedReportsInventoryDigest,
    privacy_safe: true
  };
  requireCondition(privacySafeTree(receipt), "Plan receipt facts are privacy-unsafe");
  return { ...receipt, receipt_digest: canonicalDigest(receiptFacts(receipt)) };
}

export function assertReceiptCandidateCurrent(receipt?: any, context?: any) : any {
  requireCondition(receipt && typeof receipt === "object", "Accepted final receipt is missing");
  requireCondition(receipt.schema_version === RECEIPT_SCHEMA, "Accepted final receipt schema is unknown");
  requireCondition(receipt.privacy_safe === true && privacySafeTree(receipt), "Accepted final receipt is privacy-unsafe");
  requireCondition(
    SHA256_PATTERN.test(String(receipt.candidate_digest || "")),
    "Accepted final receipt candidate digest is invalid",
  );
  const expected: any = buildPlanFinalReceipt(context);
  requireCondition(receipt.receipt_digest === expected.receipt_digest, "Accepted final receipt facts are absent or stale");
  requireCondition(canonicalDigest(receiptFacts(receipt)) === receipt.receipt_digest, "Accepted final receipt digest is stale");
}

export function assertReceiptIntegrity(receipt?: any) : any {
  requireCondition(receipt && typeof receipt === "object", "Accepted final receipt is missing");
  requireCondition(receipt.schema_version === RECEIPT_SCHEMA, "Accepted final receipt schema is unknown");
  requireCondition(receipt.privacy_safe === true && privacySafeTree(receipt), "Accepted final receipt is privacy-unsafe");
  requireCondition(
    SHA256_PATTERN.test(String(receipt.candidate_digest || "")),
    "Accepted final receipt candidate digest is invalid",
  );
  requireCondition(
    canonicalDigest(receiptFacts(receipt)) === receipt.receipt_digest,
    "Accepted final receipt digest is stale",
  );
  requireCondition(
    receipt.proof_anchor?.receipt_digest === receipt.receipt_digest,
    "Accepted final receipt proof anchor is mismatched",
  );
  requireCondition(receipt.proof_anchor?.verified === true, "Accepted final receipt proof anchor is not verified");
}

export function assertReceiptPlanCurrent(receipt?: any, context?: any) : any {
  assertReceiptIntegrity(receipt);
  assertReceiptCandidateCurrent(receipt, {
    ...context,
    repositoryRevision: receipt.repository_revision,
    repositoryTreeDigest: receipt.repository_tree_digest,
    commandDagDigest: receipt.command_dag_digest,
    ownedReportsInventoryDigest: receipt.owned_reports_inventory_digest,
  });
}

export function assertReceiptCurrent(receipt?: any, context?: any) : any {
  assertReceiptCandidateCurrent(receipt, context);
  requireCondition(receipt.proof_anchor?.receipt_digest === receipt.receipt_digest, "Accepted final receipt proof anchor is mismatched");
  requireCondition(receipt.proof_anchor?.verified === true, "Accepted final receipt proof anchor is not verified");
}

export async function verifyPlanReceiptProofAnchor({ repoRoot, receipt, proofSubstrate = null }: Record<string, any> = {}) : Promise<any> {
  const anchor: any = receipt?.proof_anchor;
  if (
    !repoRoot || anchor?.provider !== "pactium.operation-proof-substrate" ||
    anchor?.verified !== true || anchor?.receipt_digest !== receipt?.receipt_digest ||
    !anchor?.ledger_event_id || !anchor?.envelope_id
  ) {
    return Object.freeze({ ok: false, reason: "proof-anchor-shape-invalid" });
  }
  let ownedProofSubstrate: any = null;
  try {
    if (!proofSubstrate) {
      const { createOperationProofSubstrate } = await import("../../packages/foundation/src/proof/proof-substrate/index.ts");
      ownedProofSubstrate = createOperationProofSubstrate({
        dataDir: path.join(repoRoot, "build", "plan-proof-ledger")
      });
      proofSubstrate = ownedProofSubstrate;
    }
    const bundle: any = await proofSubstrate.exportProofBundle({
      ledgerEventId: anchor.ledger_event_id,
      envelopeId: anchor.envelope_id,
      actor: { type: "system" }
    });
    const verification: any = await proofSubstrate.verifyReceipt({ bundle });
    if (
      verification?.ok !== true ||
      typeof proofSubstrate.getReceipt !== "function" ||
      typeof proofSubstrate.verifyReceiptCommitment !== "function"
    ) {
      return Object.freeze({ ok: false, reason: "proof-bundle-verification-failed" });
    }
    const entry: any = await proofSubstrate.getReceipt(anchor.ledger_event_id);
    const anchoredFactId: any = entry?.pactium?.receiptId || "";
    const expectedContext: Record<string, any> = {
      checkpointDigest: receipt.checkpoint_digest,
      repositoryTreeDigest: receipt.repository_tree_digest,
      evidenceSetDigest: receipt.evidence_set_digest,
      prerequisiteReceiptSetDigest: receipt.prerequisite_receipt_set_digest,
      commandDagDigest: receipt.command_dag_digest,
      ownedReportsInventoryDigest: receipt.owned_reports_inventory_digest,
      privacySafe: receipt.privacy_safe
    };
    const commitment: any = await proofSubstrate.verifyReceiptCommitment({
      ledgerEventId: anchor.ledger_event_id,
      commitment: {
        kind: "plan-final-receipt",
        plan: receipt.plan,
        receiptDigest: receipt.receipt_digest,
        context: expectedContext
      }
    });
    if (
      entry?.ledgerEventId !== anchor.ledger_event_id ||
      entry?.workspaceId !== `plan-receipt:${receipt.plan}` ||
      (anchor.fact_id && anchoredFactId !== anchor.fact_id) ||
      commitment?.ok !== true
    ) {
      return Object.freeze({ ok: false, reason: "proof-entry-binding-mismatch" });
    }
    return Object.freeze({ ok: true, reason: "verified-proof-entry" });
  } catch {
    return Object.freeze({ ok: false, reason: "proof-anchor-unavailable" });
  } finally {
    await ownedProofSubstrate?.close?.();
  }
}

export async function assertPlanReceiptProofAnchorCurrent(options: Record<string, any> = {}) : Promise<any> {
  const verification: any = await verifyPlanReceiptProofAnchor(options);
  requireCondition(verification.ok === true, "Accepted final receipt proof anchor is not cryptographically current");
  return verification;
}

export async function assertPlanReceiptProofAnchorsCurrent({ repoRoot, receipts = [] }: Record<string, any> = {}) : Promise<any> {
  requireCondition(Array.isArray(receipts), "Plan receipt proof batch is invalid");
  if (receipts.length === 0) return Object.freeze({ verifiedCount: 0 });
  const { createOperationProofSubstrate } = await import("../../packages/foundation/src/proof/proof-substrate/index.ts");
  const proofSubstrate: any = createOperationProofSubstrate({
    dataDir: path.join(repoRoot, "build", "plan-proof-ledger")
  });
  try {
    for (const receipt of receipts) {
      await assertPlanReceiptProofAnchorCurrent({ repoRoot, receipt, proofSubstrate });
    }
    return Object.freeze({ verifiedCount: receipts.length });
  } finally {
    await proofSubstrate.close?.();
  }
}
