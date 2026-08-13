import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  ACCEPTANCE_REQUIRED_REPORTS,
  PLATFORM_ACCEPTANCE_COMMANDS
} from "../server-scripts/lib/platform-acceptance-command-catalog.ts";
import {
  createReleaseEvidenceInventory,
  releaseEvidenceInventoryDigest
} from "../server-scripts/lib/release-report-provenance.ts";
import { reportPayloadDigest } from "../../packages/foundation/src/observability/sensitive-report-scan.ts";
import { currentSourceTreeDigest, resolveGitRepoRoot } from "../server-scripts/lib/source-tree-digest.ts";
import {
  assertReceiptCandidateCurrent,
  assertReceiptPlanCurrent,
  canonicalDigest
} from "./plan-final-receipt.ts";
import {
  acceptedFinalReceipt,
  acceptedFinalReceiptEntries,
  assertCurrentDependencyMapShape,
  finalValidationBinding,
  normalizePlanProfiles,
  planReceiptKey,
  profilesContain,
} from "./plan-dependency-map.ts";

const COMMAND_DAG_DIGEST: any = reportPayloadDigest({
  commands: PLATFORM_ACCEPTANCE_COMMANDS.map(({ id, dependsOn, ownedReports, resourceLocks, timeoutMs }: Record<string, any>) : any => ({
    id, dependsOn, ownedReports, resourceLocks, timeoutMs
  }))
});
const OWNED_REPORTS_INVENTORY_DIGEST: any = releaseEvidenceInventoryDigest(
  createReleaseEvidenceInventory({ commands: PLATFORM_ACCEPTANCE_COMMANDS, requiredReportPaths: ACCEPTANCE_REQUIRED_REPORTS })
);

export function planReceiptSourceTreeExclusions(repoRoot?: any) : any {
  const planRoot: any = path.join(repoRoot, "docs", "plans");
  const exclusions: any[] = ["docs/plans/end-to-end-release/DependencyMap.json"];
  if (!fs.existsSync(planRoot)) return exclusions;

  const pendingDirectories: any[] = [planRoot];
  while (pendingDirectories.length > 0) {
    const directory: any = pendingDirectories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath: any = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(absolutePath);
      } else if (entry.name === "Manifest.json" || entry.name === "Checkpoints.json") {
        exclusions.push(path.relative(repoRoot, absolutePath).split(path.sep).join("/"));
      }
    }
  }
  return exclusions.sort();
}

export function planReceiptSourceTreeDigest(repoRoot?: any) : any {
  const gitRepoRoot: any = resolveGitRepoRoot(repoRoot);
  const committedTree: any = spawnSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
    cwd: gitRepoRoot,
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

export function createPlanContractReceipt({ plan, nodeId, node }: Record<string, any> = {}) : any {
  if (!node || node.status !== "completed") {
    throw new Error("Contract receipt requires a completed contract node");
  }
  if (node.id !== nodeId) {
    throw new Error("Contract receipt node identity is mismatched");
  }
  const facts: Record<string, any> = {
    schema_version: "v0.0.1:meshrix:plan-contract-receipt-1",
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

export function normalizePlanDirectory(planDirectory?: any) : any {
  if (typeof planDirectory !== "string" || planDirectory.length === 0) {
    throw new Error("Plan directory is required");
  }
  const normalized: any = path.posix.normalize(planDirectory);
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

export function resolveContainedPlanDirectory(planRoot?: any, planDirectory?: any) : any {
  const normalized: any = normalizePlanDirectory(planDirectory);
  const resolvedRoot: any = path.resolve(planRoot);
  const resolved: any = path.resolve(resolvedRoot, ...normalized.split("/"));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Plan directory escapes the Plan root");
  }
  const realRoot: any = fs.realpathSync(resolvedRoot);
  const realPlanPath: any = fs.realpathSync(resolved);
  if (!realPlanPath.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("Plan directory resolves outside the Plan root");
  }
  return { planDirectory: normalized, planPath: realPlanPath };
}

export function planAuthorityPaths(planRoot?: any, planDirectory?: any) : any {
  const resolved: any = resolveContainedPlanDirectory(planRoot, planDirectory);
  return [path.join(resolved.planPath, "Plan.md")];
}

export function loadPlanAuthorityTextSync(planRoot?: any, planDirectory?: any) : any {
  return planAuthorityPaths(planRoot, planDirectory)
    .map((filePath?: any) : any => `${path.basename(filePath)}\n${fs.readFileSync(filePath, "utf8")}`)
    .join("\n");
}

export async function loadPlanAuthorityText(planRoot?: any, planDirectory?: any) : Promise<any> {
  const paths: any = planAuthorityPaths(planRoot, planDirectory);
  const texts: any = await Promise.all(paths.map((filePath?: any) : any => fs.promises.readFile(filePath, "utf8")));
  return paths.map((filePath?: any, index?: any) : any => `${path.basename(filePath)}\n${texts[index]}`).join("\n");
}

export function planReceiptBuildContext({
  repoRoot,
  planDirectory,
  mapPlan,
  planText,
  checkpointsText,
  finalNode,
  dependencyMap,
  candidateReceiptKeys = new Set<any>()
}: Record<string, any>) : any {
  const planRoot: any = path.join(repoRoot, "docs", "plans");
  normalizePlanDirectory(planDirectory);
  assertCurrentDependencyMapShape(dependencyMap);
  const targetBinding: any = finalValidationBinding(mapPlan, finalNode?.id);
  const gitRepoRoot: any = resolveGitRepoRoot(repoRoot);
  const repositoryRevision: any = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: gitRepoRoot,
    encoding: "utf8",
    windowsHide: true
  }).stdout?.trim() || "";
  const repositoryTreeDigest: any = planReceiptSourceTreeDigest(repoRoot);
  const prerequisiteReceiptsByKey: any = Object.fromEntries(
    dependencyMap.plans.flatMap((plan?: any) : any =>
      acceptedFinalReceiptEntries(plan)
        .filter(({ receipt }: Record<string, any>) : any => receipt)
        .map(({ binding, receipt }: Record<string, any>) : any => [
          planReceiptKey(plan.directory, binding.node_id),
          receipt,
        ]))
  );
  const contractReceiptsFor: any = (plan?: any) : any => Object.fromEntries(
    (plan.prerequisite_receipts || [])
      .filter((entry?: any) : any => entry.kind === "contract")
      .map((entry?: any) : any => {
        const { planPath: contractPath } = resolveContainedPlanDirectory(planRoot, entry.plan);
        const contractNode: any = JSON.parse(fs.readFileSync(path.join(contractPath, "Checkpoints.json"), "utf8"))
          .find((node?: any) : any => node.id === entry.node_id);
        return [planReceiptKey(entry.plan, entry.node_id, entry.kind),
          createPlanContractReceipt({ plan: entry.plan, nodeId: entry.node_id, node: contractNode })];
      })
  );
  const prerequisiteContractReceiptsByKey: any = contractReceiptsFor(mapPlan);
  const validatedFinalReceipts: any = new Set<any>();
  const validatingFinalReceipts: any = new Set<any>();
  const validateFinalReceipt: any = (directory?: any, finalNodeId?: any) : any => {
    const key: any = planReceiptKey(directory, finalNodeId);
    if (validatedFinalReceipts.has(key)) return;
    if (validatingFinalReceipts.has(key)) throw new Error("Prerequisite final receipt graph contains a cycle");
    validatingFinalReceipts.add(key);
    const provider: any = dependencyMap.plans.find((plan?: any) : any => plan.directory === directory);
    if (!provider) throw new Error("Prerequisite final receipt Plan is missing from DependencyMap");
    const providerBinding: any = finalValidationBinding(provider, finalNodeId);
    for (const receipt of provider.prerequisite_receipts || []) {
      const profiles: any = normalizePlanProfiles(receipt.profiles, "Prerequisite receipt profiles are invalid");
      if (!profiles.some((profile?: any) : any => providerBinding.profiles.includes(profile))) continue;
      if (!profilesContain(providerBinding.profiles, profiles)) {
        throw new Error("Prerequisite receipt spans more than one final-validation profile owner");
      }
      if (receipt.kind === "final_validation") validateFinalReceipt(receipt.plan, receipt.node_id);
    }
    const accepted: any = acceptedFinalReceipt(provider, finalNodeId);
    if (!accepted) throw new Error("Prerequisite final receipt is missing");
    const { planPath: prerequisitePath } = resolveContainedPlanDirectory(planRoot, directory);
    const prerequisitePlanText: any = loadPlanAuthorityTextSync(planRoot, directory);
    const prerequisiteCheckpointsText: any = fs.readFileSync(path.join(prerequisitePath, "Checkpoints.json"), "utf8");
    const prerequisiteFinalNode: any = JSON.parse(prerequisiteCheckpointsText)
      .find((node?: any) : any => node.id === finalNodeId);
    if (!prerequisiteFinalNode) throw new Error("Prerequisite final receipt node is missing");
    const assertion: any = candidateReceiptKeys.has(key)
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
    const profiles: any = normalizePlanProfiles(receipt.profiles, "Prerequisite receipt profiles are invalid");
    if (!profiles.some((profile?: any) : any => targetBinding.profiles.includes(profile))) continue;
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
