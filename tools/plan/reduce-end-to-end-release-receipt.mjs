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
} from "./plan-final-receipt.mjs";
import { verifyPlanEvidenceCurrent } from "./plan-evidence-verifier.mjs";
import { verifyEndToEndReleasePlan } from "./verify-end-to-end-release-plan.mjs";
import { writePrivateFileAtomic } from "../../packages/foundation/src/storage/private-file-atomic.mjs";
import {
  loadPlanAuthorityText,
  planReceiptBuildContext,
  resolveContainedPlanDirectory
} from "./plan-receipt-context.mjs";
import { requirePlatformAcceptanceProfile } from "../server-scripts/lib/platform-acceptance-contract.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), "../..");

function fail(message) {
  throw new Error(message);
}

function requireCondition(condition, message) {
  if (!condition) {
    fail(message);
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function dependencyMapText(dependencyMap) {
  return `${JSON.stringify(dependencyMap, null, 2)}\n`;
}

async function readPlanState({ repoRoot, planRoot, mapPlan }) {
  const resolved = resolveContainedPlanDirectory(planRoot, mapPlan.directory);
  const [planText, checkpointsText] = await Promise.all([
    loadPlanAuthorityText(planRoot, mapPlan.directory),
    fs.readFile(path.join(resolved.planPath, "Checkpoints.json"), "utf8")
  ]);
  const finalNode = JSON.parse(checkpointsText).find((node) => node.id === mapPlan.final_validation_node_id);
  requireCondition(finalNode, `DependencyMap final-validation node is missing for ${mapPlan.directory}`);
  return { planText, checkpointsText, finalNode };
}

async function validateCandidateDependencyMap({
  repoRoot,
  planRoot,
  dependencyMap,
  currentPlanDirectories,
}) {
  for (const mapPlan of dependencyMap.plans.filter((plan) => currentPlanDirectories.has(plan.directory))) {
    const { planText, checkpointsText, finalNode } = await readPlanState({ repoRoot, planRoot, mapPlan });
    requireCondition(finalNode.status === "completed", "Receipt candidate Plan final is incomplete");
    const receipt = mapPlan.accepted_final_receipt;
    requireCondition(receipt, "Receipt candidate is missing an accepted final receipt");
    assertReceiptCurrent(receipt, planReceiptBuildContext({
      repoRoot,
      planDirectory: mapPlan.directory,
      mapPlan,
      planText,
      checkpointsText,
      finalNode,
      selectedProfile: receipt.selected_profile,
      dependencyMap,
    }));
  }

  const validationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "licomesh-plan-candidate-"));
  const candidatePlanRoot = path.join(validationRoot, "plan");
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

async function validateDraftCandidateDependencyMap({ repoRoot, planRoot, dependencyMap, draftPlanDirectories }) {
  for (const mapPlan of dependencyMap.plans.filter((plan) => draftPlanDirectories.has(plan.directory))) {
    const { planText, checkpointsText, finalNode } = await readPlanState({ repoRoot, planRoot, mapPlan });
    requireCondition(finalNode.status === "completed", "Receipt candidate Plan final is incomplete");
    const receipt = mapPlan.accepted_final_receipt;
    requireCondition(receipt, "Receipt candidate is missing an accepted final receipt");
    const context = planReceiptBuildContext({
      repoRoot,
      planDirectory: mapPlan.directory,
      mapPlan,
      planText,
      checkpointsText,
      finalNode,
      selectedProfile: receipt.selected_profile,
      dependencyMap,
      candidateReceiptPlans: draftPlanDirectories
    });
    assertReceiptCandidateCurrent(receipt, context);
  }
}

async function replaceDependencyMap({ dependencyMapPath, originalText, dependencyMap }) {
  const currentText = await fs.readFile(dependencyMapPath, "utf8");
  requireCondition(currentText === originalText, "DependencyMap changed during receipt reduction");
  await writePrivateFileAtomic(dependencyMapPath, dependencyMapText(dependencyMap));
}

async function anchorReceipt(repoRoot, receipt) {
  const { createOperationProofSubstrate } = await import("#lico/foundation/proof/proof-substrate/index");
  const proofSubstrate = createOperationProofSubstrate({ dataDir: path.join(repoRoot, "build", "plan-proof-ledger") });
  try {
    const anchor = await proofSubstrate.recordPlanReceiptEvidence({
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
    const bundle = await proofSubstrate.exportProofBundle({
      ledgerEventId: anchor.ledgerEventId,
      envelopeId: anchor.envelopeId,
      actor: { type: "system" }
    });
    const verification = await proofSubstrate.verifyReceipt({ bundle });
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
  selectedProfile,
  write = true,
} = {}) {
  requireCondition(typeof planDirectory === "string" && planDirectory.length > 0, "--plan is required");
  requireCondition(typeof selectedProfile === "string" && selectedProfile.length > 0, "--profile is required");
  selectedProfile = requirePlatformAcceptanceProfile(selectedProfile);
  const planRoot = path.join(repoRoot, "docs", "plans");
  const resolvedPlan = resolveContainedPlanDirectory(planRoot, planDirectory);
  planDirectory = resolvedPlan.planDirectory;
  const dependencyMapPath = path.join(planRoot, "end-to-end-release", "DependencyMap.json");
  const reportPath = path.join(repoRoot, "build", "reports", "end-to-end-release-plan.json");

  const originalDependencyMapText = await fs.readFile(dependencyMapPath, "utf8");
  const dependencyMap = JSON.parse(originalDependencyMapText);
  const candidateDependencyMap = structuredClone(dependencyMap);
  const mapPlan = candidateDependencyMap.plans.find((plan) => plan.directory === planDirectory);
  requireCondition(mapPlan, `DependencyMap does not contain plan ${planDirectory}`);

  const { checkpointsText, planText, finalNode } = await readPlanState({ repoRoot, planRoot, mapPlan });

  await verifyEndToEndReleasePlan({ repoRoot, writeReport: false, reportPath, requireCompletedReceipts: false });
  const buildContext = planReceiptBuildContext({
    repoRoot, planDirectory, mapPlan, planText, checkpointsText, finalNode, selectedProfile, dependencyMap: candidateDependencyMap
  });
  await verifyPlanEvidenceCurrent({
    repoRoot,
    finalNode,
  });
  const draftReceipt = buildPlanFinalReceipt(buildContext);
  mapPlan.accepted_final_receipt = draftReceipt;
  await validateDraftCandidateDependencyMap({
    repoRoot,
    planRoot,
    dependencyMap: candidateDependencyMap,
    draftPlanDirectories: new Set([planDirectory])
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
  const receipt = bindPlanReceiptProofAnchor(draftReceipt, await anchorReceipt(repoRoot, draftReceipt));
  assertReceiptCurrent(receipt, buildContext);

  mapPlan.accepted_final_receipt = receipt;
  await validateCandidateDependencyMap({
    repoRoot,
    planRoot,
    dependencyMap: candidateDependencyMap,
    currentPlanDirectories: new Set([planDirectory]),
  });
  await replaceDependencyMap({
    dependencyMapPath,
    originalText: originalDependencyMapText,
    dependencyMap: candidateDependencyMap
  });
  return receipt;
}

export async function runReceiptReductionMutationTests({
  repoRoot = defaultRepoRoot,
  planDirectory = "end-to-end-release/platform-foundation/state-machine-governance",
} = {}) {
  const results = [];
  const planRoot = path.join(repoRoot, "docs", "plans");
  const dependencyMapPath = path.join(planRoot, "end-to-end-release", "DependencyMap.json");
  const checkpointsPath = path.join(planRoot, planDirectory, "Checkpoints.json");

  const dependencyMap = await readJson(dependencyMapPath);
  const mapPlan = dependencyMap.plans.find((plan) => plan.directory === planDirectory);
  requireCondition(mapPlan, "SMG DependencyMap entry missing");
  const checkpointsText = await fs.readFile(checkpointsPath, "utf8");
  const finalNode = structuredClone(JSON.parse(checkpointsText).find((node) => node.id === mapPlan.final_validation_node_id));
  requireCondition(finalNode, "SMG final node missing");
  for (const criterion of finalNode.acceptance_criteria || []) {
    criterion.evidence_refs = (criterion.evidence_refs || []).map((ref) => {
      if (ref.type !== "command" || !Object.hasOwn(ref, "command")) return ref;
      return {
        type: "command",
        command_sha256: digest(ref.command),
        exit_code: ref.exit_code ?? null,
        recorded_at: ref.recorded_at ?? null
      };
    });
  }
  const draftGoodReceipt = buildPlanFinalReceipt({
    planDirectory,
    mapPlan,
    checkpointsText,
    finalNode,
    selectedProfile: "core",
  });
  const goodReceipt = bindPlanReceiptProofAnchor(draftGoodReceipt, {
    provider: "pactium.operation-proof-substrate",
    receipt_digest: draftGoodReceipt.receipt_digest,
    ledger_event_id: "mutation-fixture",
    envelope_id: "mutation-fixture",
    fact_id: "mutation-fixture",
    verified: true
  });
  const assertionContext = { planDirectory, mapPlan, checkpointsText, finalNode, selectedProfile: "core" };

  const cases = [
    {
      name: "absent-receipt",
      run: () => assertReceiptCurrent(null, assertionContext),
      expectedSubstring: "Accepted final receipt is missing",
    },
    {
      name: "stale-checkpoint-digest",
      run: () =>
        assertReceiptCurrent(
          { ...goodReceipt, checkpoint_digest: "0".repeat(64) },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "stale-source-revision",
      run: () =>
        assertReceiptCurrent(
          { ...goodReceipt, source_revision: "deadbeef" },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "stale-evidence-set",
      run: () =>
        assertReceiptCurrent(
          { ...goodReceipt, evidence_refs: goodReceipt.evidence_refs.slice(1) },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "stale-prerequisite-receipts",
      run: () =>
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
      run: () =>
        assertReceiptCurrent(
          { ...goodReceipt, platform: "" },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "absent-selected-profile",
      run: () =>
        assertReceiptCurrent(
          { ...structuredClone(goodReceipt), selected_profile: "" },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
    {
      name: "privacy-unsafe-evidence",
      run: () =>
        assertReceiptCurrent(
          {
            ...goodReceipt,
            evidence_refs: [
              {
                type: "file",
                path: path.posix.join(path.posix.sep, "Users", "someone", "secret", "report.json"),
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
      run: () =>
        assertReceiptCurrent(
          { ...goodReceipt, schema_version: "not-a-schema" },
          assertionContext,
        ),
      expectedSubstring: "schema is unknown",
    },
    {
      name: "mismatched-plan-identity",
      run: () =>
        assertReceiptCurrent(
          { ...goodReceipt, plan: "end-to-end-release/platform-foundation/authorization" },
          assertionContext,
        ),
      expectedSubstring: "digest is stale",
    },
  ];

  for (const testCase of cases) {
    let error;
    try {
      testCase.run();
    } catch (caught) {
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

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--self-test-mutations")) {
    const report = await runReceiptReductionMutationTests();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const planIndex = argv.indexOf("--plan");
  requireCondition(planIndex >= 0 && argv[planIndex + 1], "--plan <directory> is required");
  const profileIndex = argv.indexOf("--profile");
  requireCondition(profileIndex >= 0 && argv[profileIndex + 1], "--profile <profile> is required");
  const selectedProfile = argv[profileIndex + 1];
  const receipt = await reduceEndToEndReleaseReceipt({
    planDirectory: argv[planIndex + 1],
    selectedProfile,
    write: !argv.includes("--dry-run"),
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
