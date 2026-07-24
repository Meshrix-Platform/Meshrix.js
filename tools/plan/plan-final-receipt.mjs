import crypto from "node:crypto";
import path from "node:path";

import {
  finalValidationBinding,
  normalizePlanProfiles,
  parentIntegrationBinding,
  planReceiptKey,
  profilesContain,
} from "./plan-dependency-map.mjs";

export const RECEIPT_SCHEMA = "v0.0.1:meshrix:plan-final-receipt-4";
export const REPORT_DIGEST_ALGORITHM = "canonical-json-without-observation-time";
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'`=(])(?:\/(?:Users|home|private|var|tmp)\/|[A-Za-z]:\\)/u;
const VOLATILE_REPORT_KEYS = new Set(["checkedAt", "generatedAt"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function fail(message) { throw new Error(message); }
function requireCondition(condition, message) { if (!condition) fail(message); }

export function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalReportValue(value) {
  if (Array.isArray(value)) return value.map(canonicalReportValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value)
    .filter((key) => !VOLATILE_REPORT_KEYS.has(key))
    .sort()
    .map((key) => [key, canonicalReportValue(value[key])]));
}

export function canonicalDigest(value) {
  return digest(JSON.stringify(canonicalValue(value)));
}

export function reportDigest(reportText) {
  return digest(JSON.stringify(canonicalReportValue(JSON.parse(reportText))));
}

export function isPrivacySafeValue(value) {
  if (typeof value !== "string") return true;
  if (value.includes("<repo-root>") || value.includes("<user-home>")) {
    return !ABSOLUTE_PATH_PATTERN.test(value.replaceAll("<repo-root>", "").replaceAll("<user-home>", ""));
  }
  return !ABSOLUTE_PATH_PATTERN.test(value) && !value.startsWith("/Users/") && !value.startsWith("/home/");
}

function privacySafeTree(value) {
  if (Array.isArray(value)) return value.every(privacySafeTree);
  if (value && typeof value === "object") return Object.values(value).every(privacySafeTree);
  return isPrivacySafeValue(value);
}

function bindEvidenceRef(ref) {
  requireCondition(ref && typeof ref === "object", "Evidence ref is invalid");
  let bound;
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
      Object.keys(ref).every((key) => ["type", "command_sha256", "exit_code", "recorded_at"].includes(key)),
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

function currentEvidenceRefs(finalNode) {
  return (finalNode.acceptance_criteria ?? []).flatMap((criterion) =>
    (criterion.evidence_refs ?? []).map(bindEvidenceRef)
  );
}

function currentPrerequisiteReceipts(
  mapPlan,
  finalProfiles,
  prerequisiteReceiptsByKey = {},
  prerequisiteContractReceiptsByKey = {},
  candidateReceiptKeys = new Set()
) {
  return (mapPlan.prerequisite_receipts ?? []).flatMap((receipt) => {
    requireCondition(receipt && typeof receipt === "object", "Prerequisite receipt declaration is invalid");
    requireCondition(receipt.kind === "contract" || receipt.kind === "final_validation", "Prerequisite receipt kind is invalid");
    const profiles = normalizePlanProfiles(receipt.profiles, "Prerequisite receipt profiles are invalid");
    if (!profiles.some((profile) => finalProfiles.includes(profile))) return [];
    requireCondition(
      profilesContain(finalProfiles, profiles),
      "Prerequisite receipt spans more than one final-validation profile owner",
    );
    const key = planReceiptKey(receipt.plan, receipt.node_id, receipt.kind);
    const accepted = receipt.kind === "contract"
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
      receipt_digest: accepted.receipt_digest
    }];
  });
}

function receiptFacts(receipt) {
  const { proof_anchor: _proofAnchor, receipt_digest: _receiptDigest, ...facts } = receipt;
  return facts;
}

export function bindPlanReceiptProofAnchor(receipt, proofAnchor) {
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
  candidateReceiptKeys = new Set()
}) {
  requireCondition(mapPlan?.directory === undefined || mapPlan.directory === planDirectory, "Plan directory and DependencyMap identity are mismatched");
  const finalBinding = finalValidationBinding(mapPlan, finalNode?.id);
  requireCondition(finalNode?.role === "final_validation", "Final node role must be final_validation");
  requireCondition(finalNode.status === "completed", "Final node must be completed before receipt reduction");
  requireCondition(finalNode.acceptance_criteria?.length > 0 && finalNode.acceptance_criteria.every((criterion) => criterion.checked === true), "Final node has unchecked acceptance criteria");
  requireCondition(finalNode.requirements?.length > 0, "Final node requirements are missing");
  requireCondition(finalNode.platform, "Final node platform is missing");
  requireCondition(finalNode.commit?.delivered, "Final node source revision (commit.delivered) is missing");
  const profiles = normalizePlanProfiles(finalBinding.profiles, "Final receipt profiles are invalid");
  const parentIntegration = parentIntegrationBinding(mapPlan, finalNode.id);
  const evidenceRefs = currentEvidenceRefs(finalNode);
  requireCondition(evidenceRefs.length > 0, "Final node has no privacy-safe evidence references");
  const prerequisites = currentPrerequisiteReceipts(
    mapPlan,
    profiles,
    prerequisiteReceiptsByKey,
    prerequisiteContractReceiptsByKey,
    candidateReceiptKeys
  );
  const receipt = {
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
    checked_criteria: finalNode.acceptance_criteria.map((criterion, index) => ({ index, checked: true, text: criterion.text })),
    evidence_refs: evidenceRefs,
    evidence_set_digest: canonicalDigest(evidenceRefs),
    prerequisite_receipts: prerequisites,
    prerequisite_receipt_set_digest: canonicalDigest(prerequisites),
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

export function assertReceiptCandidateCurrent(receipt, context) {
  requireCondition(receipt && typeof receipt === "object", "Accepted final receipt is missing");
  requireCondition(receipt.schema_version === RECEIPT_SCHEMA, "Accepted final receipt schema is unknown");
  requireCondition(receipt.privacy_safe === true && privacySafeTree(receipt), "Accepted final receipt is privacy-unsafe");
  const expected = buildPlanFinalReceipt(context);
  requireCondition(receipt.receipt_digest === expected.receipt_digest, "Accepted final receipt facts are absent or stale");
  requireCondition(canonicalDigest(receiptFacts(receipt)) === receipt.receipt_digest, "Accepted final receipt digest is stale");
}

export function assertReceiptIntegrity(receipt) {
  requireCondition(receipt && typeof receipt === "object", "Accepted final receipt is missing");
  requireCondition(receipt.schema_version === RECEIPT_SCHEMA, "Accepted final receipt schema is unknown");
  requireCondition(receipt.privacy_safe === true && privacySafeTree(receipt), "Accepted final receipt is privacy-unsafe");
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

export function assertReceiptPlanCurrent(receipt, context) {
  assertReceiptIntegrity(receipt);
  assertReceiptCandidateCurrent(receipt, {
    ...context,
    repositoryRevision: receipt.repository_revision,
    repositoryTreeDigest: receipt.repository_tree_digest,
    commandDagDigest: receipt.command_dag_digest,
    ownedReportsInventoryDigest: receipt.owned_reports_inventory_digest,
  });
}

export function assertReceiptCurrent(receipt, context) {
  assertReceiptCandidateCurrent(receipt, context);
  requireCondition(receipt.proof_anchor?.receipt_digest === receipt.receipt_digest, "Accepted final receipt proof anchor is mismatched");
  requireCondition(receipt.proof_anchor?.verified === true, "Accepted final receipt proof anchor is not verified");
}

export async function verifyPlanReceiptProofAnchor({ repoRoot, receipt, proofSubstrate = null } = {}) {
  const anchor = receipt?.proof_anchor;
  if (
    !repoRoot || anchor?.provider !== "pactium.operation-proof-substrate" ||
    anchor?.verified !== true || anchor?.receipt_digest !== receipt?.receipt_digest ||
    !anchor?.ledger_event_id || !anchor?.envelope_id
  ) {
    return Object.freeze({ ok: false, reason: "proof-anchor-shape-invalid" });
  }
  let ownedProofSubstrate = null;
  try {
    if (!proofSubstrate) {
      const { createOperationProofSubstrate } = await import("../../packages/foundation/src/proof/proof-substrate/index.mjs");
      ownedProofSubstrate = createOperationProofSubstrate({
        dataDir: path.join(repoRoot, "build", "plan-proof-ledger")
      });
      proofSubstrate = ownedProofSubstrate;
    }
    const bundle = await proofSubstrate.exportProofBundle({
      ledgerEventId: anchor.ledger_event_id,
      envelopeId: anchor.envelope_id,
      actor: { type: "system" }
    });
    const verification = await proofSubstrate.verifyReceipt({ bundle });
    if (
      verification?.ok !== true ||
      typeof proofSubstrate.getReceipt !== "function" ||
      typeof proofSubstrate.verifyReceiptCommitment !== "function"
    ) {
      return Object.freeze({ ok: false, reason: "proof-bundle-verification-failed" });
    }
    const entry = await proofSubstrate.getReceipt(anchor.ledger_event_id);
    const anchoredFactId = entry?.pactium?.receiptId || "";
    const expectedContext = {
      checkpointDigest: receipt.checkpoint_digest,
      repositoryTreeDigest: receipt.repository_tree_digest,
      evidenceSetDigest: receipt.evidence_set_digest,
      prerequisiteReceiptSetDigest: receipt.prerequisite_receipt_set_digest,
      commandDagDigest: receipt.command_dag_digest,
      ownedReportsInventoryDigest: receipt.owned_reports_inventory_digest,
      privacySafe: receipt.privacy_safe
    };
    const commitment = await proofSubstrate.verifyReceiptCommitment({
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

export async function assertPlanReceiptProofAnchorCurrent(options = {}) {
  const verification = await verifyPlanReceiptProofAnchor(options);
  requireCondition(verification.ok === true, "Accepted final receipt proof anchor is not cryptographically current");
  return verification;
}

export async function assertPlanReceiptProofAnchorsCurrent({ repoRoot, receipts = [] } = {}) {
  requireCondition(Array.isArray(receipts), "Plan receipt proof batch is invalid");
  if (receipts.length === 0) return Object.freeze({ verifiedCount: 0 });
  const { createOperationProofSubstrate } = await import("../../packages/foundation/src/proof/proof-substrate/index.mjs");
  const proofSubstrate = createOperationProofSubstrate({
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
