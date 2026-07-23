import crypto from "node:crypto";
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
import {
  acceptedFinalReceipt,
  acceptedFinalReceiptEntries,
  assertCurrentDependencyMapShape,
  finalValidationBinding,
  normalizePlanProfiles,
  planReceiptKey,
  profilesContain,
} from "./plan-dependency-map.mjs";

const COMMAND_DAG_DIGEST = reportPayloadDigest({
  commands: PLATFORM_ACCEPTANCE_COMMANDS.map(({ id, dependsOn, ownedReports, resourceLocks, timeoutMs }) => ({
    id, dependsOn, ownedReports, resourceLocks, timeoutMs
  }))
});
const OWNED_REPORTS_INVENTORY_DIGEST = releaseEvidenceInventoryDigest(
  createReleaseEvidenceInventory({ commands: PLATFORM_ACCEPTANCE_COMMANDS, requiredReportPaths: ACCEPTANCE_REQUIRED_REPORTS })
);

export function planReceiptSourceTreeExclusions(repoRoot) {
  const planRoot = path.join(repoRoot, "docs", "plans");
  const exclusions = ["docs/plans/end-to-end-release/DependencyMap.json"];
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
  const committedTree = spawnSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
    cwd: repoRoot,
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (committedTree.status === 0) {
    return `sha256:${crypto.createHash("sha256").update(committedTree.stdout).digest("hex")}`;
  }
  return currentSourceTreeDigest(repoRoot, {
    exclude: planReceiptSourceTreeExclusions(repoRoot),
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
  dependencyMap,
  candidateReceiptKeys = new Set()
}) {
  const planRoot = path.join(repoRoot, "docs", "plans");
  normalizePlanDirectory(planDirectory);
  assertCurrentDependencyMapShape(dependencyMap);
  const targetBinding = finalValidationBinding(mapPlan, finalNode?.id);
  const repositoryRevision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true
  }).stdout?.trim() || "";
  const repositoryTreeDigest = planReceiptSourceTreeDigest(repoRoot);
  const prerequisiteReceiptsByKey = Object.fromEntries(
    dependencyMap.plans.flatMap((plan) =>
      acceptedFinalReceiptEntries(plan)
        .filter(({ receipt }) => receipt)
        .map(({ binding, receipt }) => [
          planReceiptKey(plan.directory, binding.node_id),
          receipt,
        ]))
  );
  const contractReceiptsFor = (plan) => Object.fromEntries(
    (plan.prerequisite_receipts || [])
      .filter((entry) => entry.kind === "contract")
      .map((entry) => {
        const { planPath: contractPath } = resolveContainedPlanDirectory(planRoot, entry.plan);
        const contractNode = JSON.parse(fs.readFileSync(path.join(contractPath, "Checkpoints.json"), "utf8"))
          .find((node) => node.id === entry.node_id);
        return [planReceiptKey(entry.plan, entry.node_id, entry.kind),
          createPlanContractReceipt({ plan: entry.plan, nodeId: entry.node_id, node: contractNode })];
      })
  );
  const prerequisiteContractReceiptsByKey = contractReceiptsFor(mapPlan);
  const validatedFinalReceipts = new Set();
  const validatingFinalReceipts = new Set();
  const validateFinalReceipt = (directory, finalNodeId) => {
    const key = planReceiptKey(directory, finalNodeId);
    if (validatedFinalReceipts.has(key)) return;
    if (validatingFinalReceipts.has(key)) throw new Error("Prerequisite final receipt graph contains a cycle");
    validatingFinalReceipts.add(key);
    const provider = dependencyMap.plans.find((plan) => plan.directory === directory);
    if (!provider) throw new Error("Prerequisite final receipt Plan is missing from DependencyMap");
    const providerBinding = finalValidationBinding(provider, finalNodeId);
    for (const receipt of provider.prerequisite_receipts || []) {
      const profiles = normalizePlanProfiles(receipt.profiles, "Prerequisite receipt profiles are invalid");
      if (!profiles.some((profile) => providerBinding.profiles.includes(profile))) continue;
      if (!profilesContain(providerBinding.profiles, profiles)) {
        throw new Error("Prerequisite receipt spans more than one final-validation profile owner");
      }
      if (receipt.kind === "final_validation") validateFinalReceipt(receipt.plan, receipt.node_id);
    }
    const accepted = acceptedFinalReceipt(provider, finalNodeId);
    if (!accepted) throw new Error("Prerequisite final receipt is missing");
    const { planPath: prerequisitePath } = resolveContainedPlanDirectory(planRoot, directory);
    const prerequisitePlanText = loadPlanAuthorityTextSync(planRoot, directory);
    const prerequisiteCheckpointsText = fs.readFileSync(path.join(prerequisitePath, "Checkpoints.json"), "utf8");
    const prerequisiteFinalNode = JSON.parse(prerequisiteCheckpointsText)
      .find((node) => node.id === finalNodeId);
    if (!prerequisiteFinalNode) throw new Error("Prerequisite final receipt node is missing");
    const assertion = candidateReceiptKeys.has(key)
      ? assertReceiptCandidateCurrent
      : assertReceiptPlanCurrent;
    assertion(accepted, {
      planDirectory: directory,
      mapPlan: provider,
      planText: prerequisitePlanText,
      checkpointsText: prerequisiteCheckpointsText,
      finalNode: prerequisiteFinalNode,
      repositoryRevision,
      repositoryTreeDigest,
      commandDagDigest: COMMAND_DAG_DIGEST,
      ownedReportsInventoryDigest: OWNED_REPORTS_INVENTORY_DIGEST,
      prerequisiteReceiptsByKey,
      prerequisiteContractReceiptsByKey: contractReceiptsFor(provider),
      candidateReceiptKeys
    });
    validatingFinalReceipts.delete(key);
    validatedFinalReceipts.add(key);
  };
  for (const receipt of mapPlan.prerequisite_receipts || []) {
    const profiles = normalizePlanProfiles(receipt.profiles, "Prerequisite receipt profiles are invalid");
    if (!profiles.some((profile) => targetBinding.profiles.includes(profile))) continue;
    if (!profilesContain(targetBinding.profiles, profiles)) {
      throw new Error("Prerequisite receipt spans more than one final-validation profile owner");
    }
    if (receipt.kind === "final_validation") validateFinalReceipt(receipt.plan, receipt.node_id);
  }
  return {
    planDirectory,
    mapPlan,
    planText,
    checkpointsText,
    finalNode,
    repositoryRevision,
    repositoryTreeDigest,
    commandDagDigest: COMMAND_DAG_DIGEST,
    ownedReportsInventoryDigest: OWNED_REPORTS_INVENTORY_DIGEST,
    prerequisiteReceiptsByKey,
    prerequisiteContractReceiptsByKey,
    candidateReceiptKeys
  };
}
