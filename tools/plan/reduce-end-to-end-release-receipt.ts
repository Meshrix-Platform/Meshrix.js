#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertReceiptCandidateCurrent,
  assertReceiptCurrent,
  bindPlanReceiptProofAnchor,
  buildPlanFinalReceipt,
  canonicalDigest,
  digest,
} from "./plan-final-receipt.ts";
import { verifyPlanEvidenceCurrent } from "./plan-evidence-verifier.ts";
import { verifyEndToEndReleasePlan } from "./verify-end-to-end-release-plan.ts";
import { writePrivateFileAtomic } from "../../packages/foundation/src/storage/private-file-atomic.ts";
import {
  loadPlanAuthorityText,
  planReceiptBuildContext,
  resolveContainedPlanDirectory
} from "./plan-receipt-context.ts";
import {
  acceptedFinalReceipt,
  assertCurrentDependencyMapShape,
  finalValidationBinding,
  finalValidationBindingForProfile,
  planReceiptKey,
  setAcceptedFinalReceipt,
} from "./plan-dependency-map.ts";
import {
  type DependencyMap,
  type DependencyMapPlan,
  type FinalCheckpointNode,
  type JsonRecord,
  type PlanFinalReceipt,
  type PlanProfile,
  type PlanReceiptProofAnchor,
  isJsonRecord,
  isFinalCheckpointNode,
} from "./plan-types.ts";

interface ReceiptProofSubstrate {
  recordPlanReceiptEvidence(input: JsonRecord): Promise<{ ledgerEventId: string; envelopeId: string; factId?: string }>;
  exportProofBundle(input: JsonRecord): Promise<unknown>;
  verifyReceipt(input: { bundle: unknown }): Promise<unknown>;
  close?(): Promise<void>;
}

function isReceiptProofSubstrate(value: unknown): value is ReceiptProofSubstrate {
  return isJsonRecord(value) &&
    typeof value.recordPlanReceiptEvidence === "function" &&
    typeof value.exportProofBundle === "function" &&
    typeof value.verifyReceipt === "function";
}

const modulePath  = fileURLToPath(import.meta.url);
const defaultRepoRoot  = path.resolve(path.dirname(modulePath), "../..");

function fail(message: string): never {
  throw new Error(message);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

function dependencyMapText(dependencyMap: DependencyMap): string {
  return `${JSON.stringify(dependencyMap, null, 2)}\n`;
}

async function readPlanState({ planRoot, mapPlan, finalNodeId }: {
  planRoot: string; mapPlan: DependencyMapPlan; finalNodeId: string;
}): Promise<{ planText: string; checkpointsText: string; finalNode: FinalCheckpointNode }> {
  const resolved  = resolveContainedPlanDirectory(planRoot, mapPlan.directory);
  const [planText, checkpointsText] = await Promise.all([
    loadPlanAuthorityText(planRoot, mapPlan.directory),
    fs.readFile(path.join(resolved.planPath, "Checkpoints.json"), "utf8")
  ]);
  const checkpoints: unknown = JSON.parse(checkpointsText);
  requireCondition(Array.isArray(checkpoints), `DependencyMap checkpoints are malformed for ${mapPlan.directory}`);
  const finalNode: unknown = checkpoints.find((node: unknown) => isFinalCheckpointNode(node) && node.id === finalNodeId);
  requireCondition(isFinalCheckpointNode(finalNode), `DependencyMap final-validation node is missing for ${mapPlan.directory}`);
  return { planText, checkpointsText, finalNode };
}

async function validateCandidateDependencyMap({
  repoRoot,
  planRoot,
  dependencyMap,
  currentReceiptKeys,
  requireProofAnchors,
}: {
  repoRoot: string;
  planRoot: string;
  dependencyMap: DependencyMap;
  currentReceiptKeys: Set<string>;
  requireProofAnchors: boolean;
}): Promise<void> {
  for (const mapPlan of dependencyMap.plans) {
    for (const binding of mapPlan.final_validations) {
      const receiptKey  = planReceiptKey(mapPlan.directory, binding.node_id);
      if (!currentReceiptKeys.has(receiptKey)) continue;
      const { planText, checkpointsText, finalNode } = await readPlanState({
        planRoot,
        mapPlan,
        finalNodeId: binding.node_id,
      });
    requireCondition(finalNode.status === "completed", "Receipt candidate Plan final is incomplete");
      const receipt  = acceptedFinalReceipt(mapPlan, binding.node_id);
    requireCondition(receipt, "Receipt candidate is missing an accepted final receipt");
      const context  = planReceiptBuildContext({
      repoRoot,
      planDirectory: mapPlan.directory,
      mapPlan,
      planText,
      checkpointsText,
      finalNode,
      dependencyMap,
        candidateReceiptKeys: requireProofAnchors ? new Set() : currentReceiptKeys,
      });
      const assertion: typeof assertReceiptCurrent | typeof assertReceiptCandidateCurrent = requireProofAnchors
        ? assertReceiptCurrent
        : assertReceiptCandidateCurrent;
      assertion(receipt, context);
    }
  }

  const validationRoot  = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plan-candidate-"));
  const candidatePlanRoot  = path.join(validationRoot, "plan");
  try {
    await fs.cp(planRoot, candidatePlanRoot, { recursive: true });
    await fs.writeFile(
      path.join(candidatePlanRoot, "end-to-end-release", "DependencyMap.json"),
      dependencyMapText(dependencyMap),
      "utf8"
    );
    await verifyEndToEndReleasePlan({
      repoRoot,
      planRoot: candidatePlanRoot,
      writeReport: false,
      requireCompletedReceipts: false
    });
  } finally {
    await fs.rm(validationRoot, { recursive: true, force: true });
  }
}

async function replaceDependencyMap({ dependencyMapPath, originalText, dependencyMap }: {
  dependencyMapPath: string; originalText: string; dependencyMap: DependencyMap;
}): Promise<void> {
  const currentText  = await fs.readFile(dependencyMapPath, "utf8");
  requireCondition(currentText === originalText, "DependencyMap changed during receipt reduction");
  await writePrivateFileAtomic(dependencyMapPath, dependencyMapText(dependencyMap));
}

async function anchorReceipt(repoRoot: string, receipt: PlanFinalReceipt): Promise<PlanReceiptProofAnchor> {
  const { createOperationProofSubstrate } = await import("#meshrix/foundation/proof/proof-substrate/index");
  const proofSubstrate: unknown = createOperationProofSubstrate({ dataDir: path.join(repoRoot, "build", "plan-proof-ledger") });
  requireCondition(isReceiptProofSubstrate(proofSubstrate), "Plan receipt proof substrate is malformed");
  try {
    const anchor  = await proofSubstrate.recordPlanReceiptEvidence({
      plan: receipt.plan,
      receiptDigest: receipt.receipt_digest,
      context: {
        checkpointDigest: receipt.checkpoint_digest,
        repositoryTreeDigest: receipt.repository_tree_digest,
        evidenceSetDigest: receipt.evidence_set_digest,
        prerequisiteReceiptSetDigest: receipt.prerequisite_receipt_set_digest,
        commandDagDigest: receipt.command_dag_digest,
        ownedReportsInventoryDigest: receipt.owned_reports_inventory_digest,
        privacySafe: receipt.privacy_safe
      },
      actor: { type: "system", role: "plan-receipt-reducer" }
    });
    const bundle  = await proofSubstrate.exportProofBundle({
      ledgerEventId: anchor.ledgerEventId,
      envelopeId: anchor.envelopeId,
      actor: { type: "system" }
    });
    const verification  = await proofSubstrate.verifyReceipt({ bundle });
    requireCondition(isJsonRecord(verification) && verification.ok === true, "Plan receipt Pactium proof verification failed");
    return {
      provider: "pactium.operation-proof-substrate",
      receipt_digest: receipt.receipt_digest,
      ledger_event_id: anchor.ledgerEventId,
      envelope_id: anchor.envelopeId,
      fact_id: anchor.factId,
      verified: true
    };
  } finally {
    await proofSubstrate.close?.();
  }
}

export async function reduceEndToEndReleaseReceipt({
  repoRoot = defaultRepoRoot,
  planDirectory,
  finalNodeId,
  planProfile,
  write = true,
}: {
  repoRoot?: string;
  planDirectory?: string;
  finalNodeId?: string;
  planProfile?: PlanProfile;
  write?: boolean;
} = {}) {
  requireCondition(typeof planDirectory === "string" && planDirectory.length > 0, "--plan is required");
  requireCondition(
    (typeof finalNodeId === "string" && finalNodeId.length > 0) !==
      (typeof planProfile === "string" && planProfile.length > 0),
    "Exactly one of --final-node or --profile is required",
  );
  const planRoot  = path.join(repoRoot, "docs", "plans");
  const resolvedPlan  = resolveContainedPlanDirectory(planRoot, planDirectory);
  planDirectory = resolvedPlan.planDirectory;
  const dependencyMapPath  = path.join(planRoot, "end-to-end-release", "DependencyMap.json");
  const reportPath  = path.join(repoRoot, "build", "reports", "end-to-end-release-plan.json");

  const originalDependencyMapText  = await fs.readFile(dependencyMapPath, "utf8");
  const dependencyMap = assertCurrentDependencyMapShape(JSON.parse(originalDependencyMapText));
  const candidateDependencyMap  = structuredClone(dependencyMap);
  const mapPlan = candidateDependencyMap.plans.find((plan) => plan.directory === planDirectory);
  requireCondition(mapPlan, `DependencyMap does not contain plan ${planDirectory}`);
  const finalBinding  = finalNodeId
    ? finalValidationBinding(mapPlan, finalNodeId)
    : finalValidationBindingForProfile(mapPlan, planProfile);
  const candidateReceiptKey  = planReceiptKey(planDirectory, finalBinding.node_id);
  const candidateReceiptKeys  = new Set([candidateReceiptKey]);

  const { checkpointsText, planText, finalNode } = await readPlanState({
    planRoot,
    mapPlan,
    finalNodeId: finalBinding.node_id,
  });

  await verifyEndToEndReleasePlan({ repoRoot, writeReport: false, reportPath, requireCompletedReceipts: false });
  const buildContext  = planReceiptBuildContext({
    repoRoot,
    planDirectory,
    mapPlan,
    planText,
    checkpointsText,
    finalNode,
    dependencyMap: candidateDependencyMap,
    candidateReceiptKeys,
  });
  await verifyPlanEvidenceCurrent({
    repoRoot,
    finalNode,
  });
  const draftReceipt  = buildPlanFinalReceipt(buildContext);
  setAcceptedFinalReceipt(mapPlan, finalBinding.node_id, draftReceipt);
  await validateCandidateDependencyMap({
    repoRoot,
    planRoot,
    dependencyMap: candidateDependencyMap,
    currentReceiptKeys: candidateReceiptKeys,
    requireProofAnchors: false,
  });
  if (!write) {
    return Object.freeze({
      dry_run: true,
      write: false,
      plan: planDirectory,
      candidate_receipt: draftReceipt,
      candidate_dependency_map_digest: canonicalDigest(candidateDependencyMap),
      authority_dependency_map_digest: canonicalDigest(dependencyMap),
      authority_unchanged: true,
      candidate_validated: true,
      proof_anchor_written: false
    });
  }
  const receipt  = bindPlanReceiptProofAnchor(draftReceipt, await anchorReceipt(repoRoot, draftReceipt));
  assertReceiptCurrent(receipt, buildContext);

  setAcceptedFinalReceipt(mapPlan, finalBinding.node_id, receipt);
  await validateCandidateDependencyMap({
    repoRoot,
    planRoot,
    dependencyMap: candidateDependencyMap,
    currentReceiptKeys: candidateReceiptKeys,
    requireProofAnchors: true,
  });
  await replaceDependencyMap({
    dependencyMapPath,
    originalText: originalDependencyMapText,
    dependencyMap: candidateDependencyMap
  });
  return receipt;
}

export async function runReceiptReductionMutationTests() {
  const results: Array<{ name: string; rejected: true; expectedSubstring: string }> = [];
  const planDirectory  = "end-to-end-release/generated-receipt-fixture";
  const finalNode: FinalCheckpointNode = {
    id: "00000000-0000-4000-8000-000000000001",
    status: "completed",
    role: "final_validation",
    platform: "any",
    requirements: ["REQ-GENERATED-RECEIPT"],
    candidate_digest: "c".repeat(64),
    commit: { repository: ".git", delivered: "generated-revision" },
    prerequisites: ["00000000-0000-4000-8000-000000000000"],
    next: [],
    acceptance_criteria: [{
      checked: true,
      text: "Generated receipt fixture is current.",
      evidence_refs: [{
        type: "command",
        command_sha256: digest("generated receipt fixture"),
        exit_code: 0,
        recorded_at: null,
      }],
    }],
  };
  const checkpointsText  = JSON.stringify([finalNode]);
  const mapPlan: DependencyMapPlan = {
    directory: planDirectory,
    parent: null,
    parent_contract_node_id: null,
    parent_integrations: [],
    final_validations: [{ node_id: finalNode.id, profiles: ["enterprise-single-node"] }],
    prerequisite_receipts: [],
    children: [],
    accepted_final_receipts: {},
  };
  const draftGoodReceipt  = buildPlanFinalReceipt({
    planDirectory,
    mapPlan,
    planText: "generated fixture",
    checkpointsText,
    finalNode,
  });
  const goodReceipt  = bindPlanReceiptProofAnchor(draftGoodReceipt, {
    provider: "pactium.operation-proof-substrate",
    receipt_digest: draftGoodReceipt.receipt_digest,
    ledger_event_id: "mutation-fixture",
    envelope_id: "mutation-fixture",
    fact_id: "mutation-fixture",
    verified: true
  });
  const assertionContext: Parameters<typeof buildPlanFinalReceipt>[0] = {
    planDirectory,
    mapPlan,
    planText: "generated fixture",
    checkpointsText,
    finalNode,
  };

  const cases: Array<{ name: string; run: () => void; expectedSubstring: string }> = [
    {
      name: "absent-receipt",
      run: ()  => assertReceiptCurrent(null, assertionContext),
      expectedSubstring: "Accepted final receipt is missing",
    },
    {
      name: "stale-checkpoint-digest",
      run: ()  =>
        assertReceiptCurrent(
          { ...goodReceipt, checkpoint_digest: "0".repeat(64) },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "stale-source-revision",
      run: ()  =>
        assertReceiptCurrent(
          { ...goodReceipt, source_revision: "deadbeef" },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "stale-evidence-set",
      run: ()  =>
        assertReceiptCurrent(
          { ...goodReceipt, evidence_refs: goodReceipt.evidence_refs.slice(1) },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "stale-prerequisite-receipts",
      run: ()  =>
        assertReceiptCurrent(
          {
            ...goodReceipt,
            prerequisite_receipts: goodReceipt.prerequisite_receipts.length > 0
              ? goodReceipt.prerequisite_receipts.slice(0, -1)
              : [{
                  plan: "mutation-fixture",
                  node_id: "00000000-0000-4000-8000-000000000000",
                  kind: "final_validation",
                }],
          },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "absent-platform",
      run: ()  =>
        assertReceiptCurrent(
          { ...goodReceipt, platform: "" },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "absent-profiles",
      run: ()  =>
        assertReceiptCurrent(
          { ...structuredClone(goodReceipt), profiles: [] },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "privacy-unsafe-evidence",
      run: ()  =>
        assertReceiptCurrent(
          {
            ...goodReceipt,
            evidence_refs: [
              {
                type: "file",
                path: "C:\\synthetic-private\\report.json",
                sha256: "abc",
              },
            ],
          },
          assertionContext,
        ),
      expectedSubstring: "privacy-unsafe",
    },
    {
      name: "unknown-schema",
      run: ()  =>
        assertReceiptCurrent(
          { ...goodReceipt, schema_version: "not-a-schema" },
          assertionContext,
        ),
      expectedSubstring: "schema is unknown",
    },
    {
      name: "mismatched-plan-identity",
      run: ()  =>
        assertReceiptCurrent(
          { ...goodReceipt, plan: "end-to-end-release/mismatched-fixture" },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
  ];

  for (const testCase of cases) {
    let error: unknown;
    try {
      testCase.run();
    } catch (caught ) {
      error = caught;
    }
    requireCondition(error instanceof Error, `Expected rejection for ${testCase.name}`);
    requireCondition(
      String(error.message).includes(testCase.expectedSubstring),
      `Expected ${testCase.name} to include ${testCase.expectedSubstring}; got ${error.message}`,
    );
    results.push({ name: testCase.name, rejected: true, expectedSubstring: testCase.expectedSubstring });
  }

  return { accepted: true, mutation_case_count: results.length, cases: results };
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--self-test-mutations")) {
    const report  = await runReceiptReductionMutationTests();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const planIndex  = argv.indexOf("--plan");
  requireCondition(planIndex >= 0 && argv[planIndex + 1], "--plan <directory> is required");
  const finalNodeIndex  = argv.indexOf("--final-node");
  const profileIndex  = argv.indexOf("--profile");
  const profileValue = profileIndex >= 0 ? argv[profileIndex + 1] : undefined;
  requireCondition(profileValue === undefined || profileValue === "enterprise-single-node", "Unknown Plan profile");
  const receipt  = await reduceEndToEndReleaseReceipt({
    planDirectory: argv[planIndex + 1],
    finalNodeId: finalNodeIndex >= 0 ? argv[finalNodeIndex + 1] : undefined,
    planProfile: profileValue,
    write: !argv.includes("--dry-run"),
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

const isDirectRun  = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
