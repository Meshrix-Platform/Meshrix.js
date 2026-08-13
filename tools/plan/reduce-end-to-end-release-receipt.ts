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

const modulePath: any = fileURLToPath(import.meta.url);
const defaultRepoRoot: any = path.resolve(path.dirname(modulePath), "../..");

function fail(message?: any) : any {
  throw new Error(message);
}

function requireCondition(condition?: any, message?: any) : any {
  if (!condition) {
    fail(message);
  }
}

function dependencyMapText(dependencyMap?: any) : any {
  return `${JSON.stringify(dependencyMap, null, 2)}\n`;
}

async function readPlanState({ planRoot, mapPlan, finalNodeId }: Record<string, any>) : Promise<any> {
  const resolved: any = resolveContainedPlanDirectory(planRoot, mapPlan.directory);
  const [planText, checkpointsText] = await Promise.all([
    loadPlanAuthorityText(planRoot, mapPlan.directory),
    fs.readFile(path.join(resolved.planPath, "Checkpoints.json"), "utf8")
  ]);
  const finalNode: any = JSON.parse(checkpointsText).find((node?: any) : any => node.id === finalNodeId);
  requireCondition(finalNode, `DependencyMap final-validation node is missing for ${mapPlan.directory}`);
  return { planText, checkpointsText, finalNode };
}

async function validateCandidateDependencyMap({
  repoRoot,
  planRoot,
  dependencyMap,
  currentReceiptKeys,
  requireProofAnchors,
}: Record<string, any>) : Promise<any> {
  for (const mapPlan of dependencyMap.plans) {
    for (const binding of mapPlan.final_validations) {
      const receiptKey: any = planReceiptKey(mapPlan.directory, binding.node_id);
      if (!currentReceiptKeys.has(receiptKey)) continue;
      const { planText, checkpointsText, finalNode } = await readPlanState({
        planRoot,
        mapPlan,
        finalNodeId: binding.node_id,
      });
    requireCondition(finalNode.status === "completed", "Receipt candidate Plan final is incomplete");
      const receipt: any = acceptedFinalReceipt(mapPlan, binding.node_id);
    requireCondition(receipt, "Receipt candidate is missing an accepted final receipt");
      const context: any = planReceiptBuildContext({
      repoRoot,
      planDirectory: mapPlan.directory,
      mapPlan,
      planText,
      checkpointsText,
      finalNode,
      dependencyMap,
        candidateReceiptKeys: requireProofAnchors ? new Set<any>() : currentReceiptKeys,
      });
      (requireProofAnchors ? assertReceiptCurrent : assertReceiptCandidateCurrent)(receipt, context);
    }
  }

  const validationRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plan-candidate-"));
  const candidatePlanRoot: any = path.join(validationRoot, "plan");
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

async function replaceDependencyMap({ dependencyMapPath, originalText, dependencyMap }: Record<string, any>) : Promise<any> {
  const currentText: any = await fs.readFile(dependencyMapPath, "utf8");
  requireCondition(currentText === originalText, "DependencyMap changed during receipt reduction");
  await writePrivateFileAtomic(dependencyMapPath, dependencyMapText(dependencyMap));
}

async function anchorReceipt(repoRoot?: any, receipt?: any) : Promise<any> {
  const { createOperationProofSubstrate } = await import("#meshrix/foundation/proof/proof-substrate/index");
  const proofSubstrate: any = createOperationProofSubstrate({ dataDir: path.join(repoRoot, "build", "plan-proof-ledger") });
  try {
    const anchor: any = await proofSubstrate.recordPlanReceiptEvidence({
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
    const bundle: any = await proofSubstrate.exportProofBundle({
      ledgerEventId: anchor.ledgerEventId,
      envelopeId: anchor.envelopeId,
      actor: { type: "system" }
    });
    const verification: any = await proofSubstrate.verifyReceipt({ bundle });
    requireCondition(verification?.ok === true, "Plan receipt Pactium proof verification failed");
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
}: Record<string, any> = {}) : Promise<any> {
  requireCondition(typeof planDirectory === "string" && planDirectory.length > 0, "--plan is required");
  requireCondition(
    (typeof finalNodeId === "string" && finalNodeId.length > 0) !==
      (typeof planProfile === "string" && planProfile.length > 0),
    "Exactly one of --final-node or --profile is required",
  );
  const planRoot: any = path.join(repoRoot, "docs", "plans");
  const resolvedPlan: any = resolveContainedPlanDirectory(planRoot, planDirectory);
  planDirectory = resolvedPlan.planDirectory;
  const dependencyMapPath: any = path.join(planRoot, "end-to-end-release", "DependencyMap.json");
  const reportPath: any = path.join(repoRoot, "build", "reports", "end-to-end-release-plan.json");

  const originalDependencyMapText: any = await fs.readFile(dependencyMapPath, "utf8");
  const dependencyMap: any = JSON.parse(originalDependencyMapText);
  assertCurrentDependencyMapShape(dependencyMap);
  const candidateDependencyMap: any = structuredClone(dependencyMap);
  const mapPlan: any = candidateDependencyMap.plans.find((plan?: any) : any => plan.directory === planDirectory);
  requireCondition(mapPlan, `DependencyMap does not contain plan ${planDirectory}`);
  const finalBinding: any = finalNodeId
    ? finalValidationBinding(mapPlan, finalNodeId)
    : finalValidationBindingForProfile(mapPlan, planProfile);
  const candidateReceiptKey: any = planReceiptKey(planDirectory, finalBinding.node_id);
  const candidateReceiptKeys: any = new Set<any>([candidateReceiptKey]);

  const { checkpointsText, planText, finalNode } = await readPlanState({
    planRoot,
    mapPlan,
    finalNodeId: finalBinding.node_id,
  });

  await verifyEndToEndReleasePlan({ repoRoot, writeReport: false, reportPath, requireCompletedReceipts: false });
  const buildContext: any = planReceiptBuildContext({
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
  const draftReceipt: any = buildPlanFinalReceipt(buildContext);
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
  const receipt: any = bindPlanReceiptProofAnchor(draftReceipt, await anchorReceipt(repoRoot, draftReceipt));
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

export async function runReceiptReductionMutationTests() : Promise<any> {
  const results: any[] = [];
  const planDirectory: any = "end-to-end-release/generated-receipt-fixture";
  const finalNode: Record<string, any> = {
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
  const checkpointsText: any = JSON.stringify([finalNode]);
  const mapPlan: Record<string, any> = {
    directory: planDirectory,
    parent: null,
    parent_contract_node_id: null,
    parent_integrations: [],
    final_validations: [{ node_id: finalNode.id, profiles: ["enterprise-single-node"] }],
    prerequisite_receipts: [],
    children: [],
    accepted_final_receipts: {},
  };
  const draftGoodReceipt: any = buildPlanFinalReceipt({
    planDirectory,
    mapPlan,
    planText: "generated fixture",
    checkpointsText,
    finalNode,
  });
  const goodReceipt: any = bindPlanReceiptProofAnchor(draftGoodReceipt, {
    provider: "pactium.operation-proof-substrate",
    receipt_digest: draftGoodReceipt.receipt_digest,
    ledger_event_id: "mutation-fixture",
    envelope_id: "mutation-fixture",
    fact_id: "mutation-fixture",
    verified: true
  });
  const assertionContext: Record<string, any> = {
    planDirectory,
    mapPlan,
    planText: "generated fixture",
    checkpointsText,
    finalNode,
  };

  const cases: any[] = [
    {
      name: "absent-receipt",
      run: () : any => assertReceiptCurrent(null, assertionContext),
      expectedSubstring: "Accepted final receipt is missing",
    },
    {
      name: "stale-checkpoint-digest",
      run: () : any =>
        assertReceiptCurrent(
          { ...goodReceipt, checkpoint_digest: "0".repeat(64) },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "stale-source-revision",
      run: () : any =>
        assertReceiptCurrent(
          { ...goodReceipt, source_revision: "deadbeef" },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "stale-evidence-set",
      run: () : any =>
        assertReceiptCurrent(
          { ...goodReceipt, evidence_refs: goodReceipt.evidence_refs.slice(1) },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "stale-prerequisite-receipts",
      run: () : any =>
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
      run: () : any =>
        assertReceiptCurrent(
          { ...goodReceipt, platform: "" },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "absent-profiles",
      run: () : any =>
        assertReceiptCurrent(
          { ...structuredClone(goodReceipt), profiles: [] },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "privacy-unsafe-evidence",
      run: () : any =>
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
      run: () : any =>
        assertReceiptCurrent(
          { ...goodReceipt, schema_version: "not-a-schema" },
          assertionContext,
        ),
      expectedSubstring: "schema is unknown",
    },
    {
      name: "mismatched-plan-identity",
      run: () : any =>
        assertReceiptCurrent(
          { ...goodReceipt, plan: "end-to-end-release/mismatched-fixture" },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
  ];

  for (const testCase of cases) {
    let error: any;
    try {
      testCase.run();
    } catch (caught: any) {
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

async function main(argv: any = process.argv.slice(2)) : Promise<any> {
  if (argv.includes("--self-test-mutations")) {
    const report: any = await runReceiptReductionMutationTests();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const planIndex: any = argv.indexOf("--plan");
  requireCondition(planIndex >= 0 && argv[planIndex + 1], "--plan <directory> is required");
  const finalNodeIndex: any = argv.indexOf("--final-node");
  const profileIndex: any = argv.indexOf("--profile");
  const receipt: any = await reduceEndToEndReleaseReceipt({
    planDirectory: argv[planIndex + 1],
    finalNodeId: finalNodeIndex >= 0 ? argv[finalNodeIndex + 1] : undefined,
    planProfile: profileIndex >= 0 ? argv[profileIndex + 1] : undefined,
    write: !argv.includes("--dry-run"),
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

const isDirectRun: any = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  main().catch((error?: any) : any => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
