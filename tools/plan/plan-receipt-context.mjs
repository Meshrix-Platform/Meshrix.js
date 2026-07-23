import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  ACCEPTANCE_REQUIRED_REPORTS,
  PLATFORM_ACCEPTANCE_COMMANDS
} from "../server-scripts/lib/platform-acceptance-command-catalog.mjs";
import {
  createReleaseEvidenceInventory,
  releaseEvidenceInventoryDigest
} from "../server-scripts/lib/release-report-provenance.mjs";
import { reportPayloadDigest } from "../../packages/foundation/src/observability/sensitive-report-scan.mjs";
import { currentSourceTreeDigest } from "../server-scripts/lib/source-tree-digest.mjs";
import {
  assertReceiptCandidateCurrent,
  assertReceiptPlanCurrent,
  canonicalDigest
} from "./plan-final-receipt.mjs";

const COMMAND_DAG_DIGEST = reportPayloadDigest({
  commands: PLATFORM_ACCEPTANCE_COMMANDS.map(({ id, dependsOn, ownedReports, resourceLocks, timeoutMs }) => ({
    id, dependsOn, ownedReports, resourceLocks, timeoutMs
  }))
});
const OWNED_REPORTS_INVENTORY_DIGEST = releaseEvidenceInventoryDigest(
  createReleaseEvidenceInventory({ commands: PLATFORM_ACCEPTANCE_COMMANDS, requiredReportPaths: ACCEPTANCE_REQUIRED_REPORTS })
);

export function planReceiptSourceTreeExclusions(repoRoot) {
  const planRoot = path.join(repoRoot, "docs", "plan");
  const exclusions = ["docs/plan/end-to-end-release/DependencyMap.json"];
  if (!fs.existsSync(planRoot)) return exclusions;

  const pendingDirectories = [planRoot];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(absolutePath);
      } else if (entry.name === "Manifest.json" || entry.name === "Checkpoints.json") {
        exclusions.push(path.relative(repoRoot, absolutePath).split(path.sep).join("/"));
      }
    }
  }
  return exclusions.sort();
}

export function planReceiptSourceTreeDigest(repoRoot) {
  return currentSourceTreeDigest(repoRoot, {
    exclude: planReceiptSourceTreeExclusions(repoRoot)
  });
}

export function createPlanContractReceipt({ plan, nodeId, node } = {}) {
  if (!node || node.status !== "completed") {
    throw new Error("Contract receipt requires a completed contract node");
  }
  if (node.id !== nodeId) {
    throw new Error("Contract receipt node identity is mismatched");
  }
  const facts = {
    schema_version: "licomesh.plan-contract-receipt.v1",
    plan: String(plan || ""),
    node_id: String(nodeId || ""),
    kind: "contract",
    status: "completed",
    node_digest: reportPayloadDigest(node),
    privacy_safe: true,
    verified: true
  };
  return Object.freeze({ ...facts, receipt_digest: canonicalDigest(facts) });
}

export function normalizePlanDirectory(planDirectory) {
  if (typeof planDirectory !== "string" || planDirectory.length === 0) {
    throw new Error("Plan directory is required");
  }
  const normalized = path.posix.normalize(planDirectory);
  if (
    normalized !== planDirectory
    || path.posix.isAbsolute(normalized)
    || (normalized !== "end-to-end-release" && !normalized.startsWith("end-to-end-release/"))
    || normalized.split("/").includes("..")
    || normalized.includes("\\")
  ) {
    throw new Error("Plan directory is not a canonical contained Plan path");
  }
  return normalized;
}

export function resolveContainedPlanDirectory(planRoot, planDirectory) {
  const normalized = normalizePlanDirectory(planDirectory);
  const resolvedRoot = path.resolve(planRoot);
  const resolved = path.resolve(resolvedRoot, ...normalized.split("/"));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Plan directory escapes the Plan root");
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const realPlanPath = fs.realpathSync(resolved);
  if (!realPlanPath.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("Plan directory resolves outside the Plan root");
  }
  return { planDirectory: normalized, planPath: realPlanPath };
}

export function planAuthorityPaths(planRoot, planDirectory) {
  const resolved = resolveContainedPlanDirectory(planRoot, planDirectory);
  const names = resolved.planDirectory === "end-to-end-release"
    ? ["Requirements.md", "Evidence.md", "Architecture.md", "Validation.md"]
    : ["Plan.md"];
  return names.map((name) => path.join(resolved.planPath, name));
}

export function loadPlanAuthorityTextSync(planRoot, planDirectory) {
  return planAuthorityPaths(planRoot, planDirectory)
    .map((filePath) => `${path.basename(filePath)}\n${fs.readFileSync(filePath, "utf8")}`)
    .join("\n");
}

export async function loadPlanAuthorityText(planRoot, planDirectory) {
  const paths = planAuthorityPaths(planRoot, planDirectory);
  const texts = await Promise.all(paths.map((filePath) => fs.promises.readFile(filePath, "utf8")));
  return paths.map((filePath, index) => `${path.basename(filePath)}\n${texts[index]}`).join("\n");
}

export function planReceiptBuildContext({
  repoRoot,
  planDirectory,
  mapPlan,
  planText,
  checkpointsText,
  finalNode,
  selectedProfile,
  dependencyMap,
  candidateReceiptPlans = new Set()
}) {
  const planRoot = path.join(repoRoot, "docs", "plan");
  normalizePlanDirectory(planDirectory);
  const repositoryRevision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true
  }).stdout?.trim() || "";
  const repositoryTreeDigest = planReceiptSourceTreeDigest(repoRoot);
  const prerequisiteReceiptsByPlan = Object.fromEntries(
    dependencyMap.plans.map((plan) => [plan.directory, plan.accepted_final_receipt || null])
  );
  const prerequisiteContractReceiptsByKey = Object.fromEntries(
    (mapPlan.prerequisite_receipts || [])
      .filter((receipt) => receipt.kind === "contract")
      .map((receipt) => {
        const { planPath: prerequisitePath } = resolveContainedPlanDirectory(planRoot, receipt.plan);
        const checkpoints = JSON.parse(fs.readFileSync(path.join(prerequisitePath, "Checkpoints.json"), "utf8"));
        const node = checkpoints.find((candidate) => candidate.id === receipt.node_id);
        const key = `${receipt.plan}\u0000${receipt.node_id}\u0000${receipt.kind}`;
        return [key, createPlanContractReceipt({
          plan: receipt.plan,
          nodeId: receipt.node_id,
          node
        })];
      })
  );
  const validatedFinalPlans = new Set();
  const validatingFinalPlans = new Set();
  const contractReceiptsFor = (plan) => Object.fromEntries(
    (plan.prerequisite_receipts || [])
      .filter((entry) => entry.kind === "contract")
      .map((entry) => {
        const { planPath: contractPath } = resolveContainedPlanDirectory(planRoot, entry.plan);
        const contractNode = JSON.parse(fs.readFileSync(path.join(contractPath, "Checkpoints.json"), "utf8"))
          .find((node) => node.id === entry.node_id);
        return [`${entry.plan}\u0000${entry.node_id}\u0000${entry.kind}`, createPlanContractReceipt({ plan: entry.plan, nodeId: entry.node_id, node: contractNode })];
      })
  );
  const validateFinalPlan = (directory) => {
    if (validatedFinalPlans.has(directory)) return;
    if (validatingFinalPlans.has(directory)) throw new Error("Prerequisite final receipt graph contains a cycle");
    validatingFinalPlans.add(directory);
    const provider = dependencyMap.plans.find((plan) => plan.directory === directory);
    if (!provider) throw new Error("Prerequisite final receipt Plan is missing from DependencyMap");
    for (const receipt of provider.prerequisite_receipts || []) {
      if (receipt.kind === "final_validation") validateFinalPlan(receipt.plan);
    }
    const accepted = provider.accepted_final_receipt;
    if (!accepted) throw new Error("Prerequisite final receipt is missing");
    const { planPath: prerequisitePath } = resolveContainedPlanDirectory(planRoot, directory);
    const prerequisitePlanText = loadPlanAuthorityTextSync(planRoot, directory);
    const prerequisiteCheckpointsText = fs.readFileSync(path.join(prerequisitePath, "Checkpoints.json"), "utf8");
    const prerequisiteFinalNode = JSON.parse(prerequisiteCheckpointsText)
      .find((node) => node.id === provider.final_validation_node_id);
    if (!prerequisiteFinalNode) throw new Error("Prerequisite final receipt node is missing");
    const assertion = candidateReceiptPlans.has(directory)
      ? assertReceiptCandidateCurrent
      : assertReceiptPlanCurrent;
    assertion(accepted, {
      planDirectory: directory,
      mapPlan: provider,
      planText: prerequisitePlanText,
      checkpointsText: prerequisiteCheckpointsText,
      finalNode: prerequisiteFinalNode,
      selectedProfile: accepted.selected_profile,
      repositoryRevision,
      repositoryTreeDigest,
      commandDagDigest: COMMAND_DAG_DIGEST,
      ownedReportsInventoryDigest: OWNED_REPORTS_INVENTORY_DIGEST,
      prerequisiteReceiptsByPlan,
      prerequisiteContractReceiptsByKey: contractReceiptsFor(provider),
      candidateReceiptPlans
    });
    validatingFinalPlans.delete(directory);
    validatedFinalPlans.add(directory);
  };
  for (const receipt of mapPlan.prerequisite_receipts || []) {
    if (receipt.kind === "final_validation") validateFinalPlan(receipt.plan);
  }
  return {
    planDirectory,
    mapPlan,
    planText,
    checkpointsText,
    finalNode,
    selectedProfile,
    repositoryRevision,
    repositoryTreeDigest,
    commandDagDigest: COMMAND_DAG_DIGEST,
    ownedReportsInventoryDigest: OWNED_REPORTS_INVENTORY_DIGEST,
    prerequisiteReceiptsByPlan,
    prerequisiteContractReceiptsByKey,
    candidateReceiptPlans
  };
}
