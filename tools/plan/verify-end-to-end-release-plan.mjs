#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertPlanReceiptProofAnchorsCurrent, assertReceiptPlanCurrent } from "./plan-final-receipt.mjs";
import { evaluatePlanExecutionEligibility } from "./plan-execution-eligibility.mjs";
import { loadPlanAuthorityText, planReceiptBuildContext } from "./plan-receipt-context.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), "../..");
const externalSourcePattern = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):(.+)$/u;
const externalSourceAuthorities = new Map([
  ["LicoLand/Lico-Dev", [/^skills\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/.+$/u, /^workflows\/catalog\.json$/u]],
  ["LicoMesh/licomesh-plugins", [/^AGENTS\.md$/u, /^plugins(?:\/.+)?$/u]],
]);

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

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function directParent(directory) {
  const separator = directory.lastIndexOf("/");
  return separator < 0 ? null : directory.slice(0, separator);
}

function isAncestor(left, right) {
  return right.startsWith(`${left}/`);
}

function isContainedPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizedRelativeSource(source, message) {
  requireCondition(
    typeof source === "string" && source.length > 0 && !/[\\\u0000-\u001f\u007f]/u.test(source),
    message,
  );
  requireCondition(!path.posix.isAbsolute(source), message);
  const segments = source.split("/");
  requireCondition(segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."), message);
  requireCondition(path.posix.normalize(source) === source, message);
  return source;
}

async function validateManifestSource(repoRoot, source) {
  requireCondition(typeof source === "string", "Manifest source must be a string");
  requireCondition(!source.includes("://"), "Manifest source URI is not an authoritative Plan source");

  const externalMatch = externalSourcePattern.exec(source);
  if (externalMatch) {
    const [, authority, declaredPath] = externalMatch;
    const allowedPatterns = externalSourceAuthorities.get(authority);
    requireCondition(allowedPatterns, "Manifest repository-qualified source authority is not allowed");
    const normalizedPath = normalizedRelativeSource(
      declaredPath,
      "Manifest repository-qualified source path is unsafe",
    );
    requireCondition(
      allowedPatterns.some((pattern) => pattern.test(normalizedPath)),
      "Manifest repository-qualified source is outside its authoritative surface",
    );
    return;
  }

  requireCondition(!source.includes(":"), "Manifest local source path is unsafe");
  const normalizedSource = normalizedRelativeSource(source, "Manifest local source path is unsafe");
  requireCondition(
    normalizedSource.startsWith("docs/plans/") ||
      normalizedSource.startsWith("tools/plan/"),
    "Manifest local source is not project-root-relative to an allowed plan authority",
  );
  const resolvedSource = path.resolve(repoRoot, normalizedSource);
  requireCondition(isContainedPath(repoRoot, resolvedSource), "Manifest local source escapes the project root");
  let realRepoRoot;
  let realSource;
  try {
    [realRepoRoot, realSource] = await Promise.all([fs.realpath(repoRoot), fs.realpath(resolvedSource)]);
  } catch {
    fail("Manifest local source does not exist");
  }
  requireCondition(isContainedPath(realRepoRoot, realSource), "Manifest local source escapes the project root");
}

function addEdge(adjacency, indegree, from, to, kind, edgeCounts) {
  requireCondition(adjacency.has(from), `${kind} edge has unknown source node`);
  requireCondition(adjacency.has(to), `${kind} edge has unknown target node`);
  const key = `${from}\u0000${to}`;
  if (adjacency.get(from).has(key)) {
    return;
  }
  adjacency.get(from).set(key, to);
  indegree.set(to, indegree.get(to) + 1);
  edgeCounts[kind] = (edgeCounts[kind] ?? 0) + 1;
}

function hasLocalPath(nodesById, from, to) {
  const seen = new Set();
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === to) {
      return true;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const next of nodesById.get(current)?.next ?? []) {
      queue.push(next);
    }
  }
  return false;
}

function participatesInPlanFinal(node, finalNode) {
  return node.status !== "skipped" &&
    (node.platform === "any" || node.platform === finalNode.platform);
}

function assertLocalPlatformDirection(prerequisite, dependent) {
  requireCondition(
    prerequisite.platform === "any" ||
      (dependent.platform !== "any" && prerequisite.platform === dependent.platform),
    "Platform-specific checkpoint cannot gate platform-neutral or different-platform work",
  );
}

function resolvePlanPaths({ repoRoot = defaultRepoRoot, planRoot, reportPath } = {}) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedPlanRoot = path.resolve(planRoot ?? path.join(resolvedRepoRoot, "docs", "plans"));
  const resolvedReportPath = path.resolve(
    reportPath ?? path.join(resolvedRepoRoot, "build", "reports", "end-to-end-release-plan.json"),
  );
  return {
    repoRoot: resolvedRepoRoot,
    planRoot: resolvedPlanRoot,
    reportPath: resolvedReportPath,
    manifestPath: path.join(resolvedPlanRoot, "Manifest.json"),
    dependencyMapPath: path.join(resolvedPlanRoot, "end-to-end-release", "DependencyMap.json"),
  };
}

export async function verifyEndToEndReleasePlan(options = {}) {
  const { repoRoot, planRoot, reportPath, manifestPath, dependencyMapPath } = resolvePlanPaths(options);
  const writeReport = options.writeReport !== false;
  const requireCompletedReceipts = options.requireCompletedReceipts !== false;

  const manifestText = await fs.readFile(manifestPath, "utf8");
  const dependencyMapText = await fs.readFile(dependencyMapPath, "utf8");
  const manifest = JSON.parse(manifestText);
  const dependencyMap = JSON.parse(dependencyMapText);

  requireCondition(Array.isArray(manifest), "Manifest must be an array");
  requireCondition(Array.isArray(dependencyMap.plans), "DependencyMap plans must be an array");
  requireCondition(dependencyMap.schema_version === 2, "DependencyMap schema version is not current");

  const manifestByDirectory = new Map();
  const manifestIndexByDirectory = new Map();
  for (const [manifestIndex, plan] of manifest.entries()) {
    requireCondition(typeof plan.directory === "string" && plan.directory.length > 0, "Manifest Plan directory is missing");
    requireCondition(!manifestByDirectory.has(plan.directory), "Manifest contains a duplicate Plan directory");
    manifestByDirectory.set(plan.directory, plan);
    manifestIndexByDirectory.set(plan.directory, manifestIndex);

    for (const source of plan.source_files ?? []) {
      await validateManifestSource(repoRoot, source);
    }
  }

  const mapByDirectory = new Map();
  for (const plan of dependencyMap.plans) {
    requireCondition(typeof plan.directory === "string" && plan.directory.length > 0, "DependencyMap Plan directory is missing");
    requireCondition(!mapByDirectory.has(plan.directory), "DependencyMap contains a duplicate Plan directory");
    requireCondition(!Object.hasOwn(plan, "prerequisites"), "DependencyMap retains the superseded Plan-level prerequisites field");
    requireCondition(Array.isArray(plan.prerequisite_receipts), "DependencyMap prerequisite_receipts must be an array");
    requireCondition(Array.isArray(plan.children), "DependencyMap children must be an array");
    requireCondition(
      new Set(plan.children).size === plan.children.length,
      "DependencyMap contains a duplicate child Plan",
    );
    const receiptKeys = plan.prerequisite_receipts.map(
      (receipt) => `${receipt?.plan ?? ""}\u0000${receipt?.node_id ?? ""}\u0000${receipt?.kind ?? ""}`,
    );
    requireCondition(
      new Set(receiptKeys).size === receiptKeys.length,
      "DependencyMap contains a duplicate prerequisite receipt",
    );
    mapByDirectory.set(plan.directory, plan);
  }

  requireCondition(
    [...mapByDirectory.keys()].every((directory) => manifestByDirectory.has(directory)),
    "DependencyMap contains a Plan absent from Manifest",
  );

  let manifestDependencyOrderEdges = 0;
  for (const plan of dependencyMap.plans) {
    const consumerIndex = manifestIndexByDirectory.get(plan.directory);
    requireCondition(consumerIndex !== undefined, "DependencyMap Plan is missing from Manifest");
    if (plan.parent !== null) {
      const parentIndex = manifestIndexByDirectory.get(plan.parent);
      requireCondition(parentIndex !== undefined, "DependencyMap parent Plan is missing from Manifest");
      requireCondition(parentIndex < consumerIndex, "Manifest parent Plan must precede its child Plan");
      manifestDependencyOrderEdges += 1;
    }
    for (const prerequisiteReceipt of plan.prerequisite_receipts) {
      const providerIndex = manifestIndexByDirectory.get(prerequisiteReceipt.plan);
      requireCondition(providerIndex !== undefined, "Prerequisite receipt provider is missing from Manifest");
      requireCondition(providerIndex < consumerIndex, "Manifest prerequisite receipt provider must precede its consumer Plan");
      manifestDependencyOrderEdges += 1;
    }
  }

  const planState = new Map();
  const globalNodeOwner = new Map();
  const checkpointCollection = new Map();
  for (const [directory, manifestPlan] of manifestByDirectory) {
    const expectedCheckpoints = `${directory}/Checkpoints.json`;
    requireCondition(manifestPlan.checkpoints === expectedCheckpoints, "Manifest checkpoint path does not match its Plan directory");
    const checkpointsPath = path.join(planRoot, expectedCheckpoints);
    const nodes = await readJson(checkpointsPath);
    requireCondition(Array.isArray(nodes) && nodes.length > 0, "Plan Checkpoints must be a non-empty array");
    checkpointCollection.set(directory, nodes);

    if (!mapByDirectory.has(directory)) {
      requireCondition(
        manifestPlan.status === "pending" && nodes.every((node) => node?.status === "pending"),
        "A Manifest-only Plan must remain an entirely pending draft until it is integrated into DependencyMap",
      );
      continue;
    }

    const nodesById = new Map();
    for (const node of nodes) {
      requireCondition(typeof node.id === "string" && node.id.length > 0, "Checkpoint node id is missing");
      requireCondition(!nodesById.has(node.id), "Plan contains a duplicate checkpoint node id");
      requireCondition(!globalNodeOwner.has(node.id), "Checkpoint node id is not globally unique");
      nodesById.set(node.id, node);
      globalNodeOwner.set(node.id, directory);
    }

    const implementationRoots = nodes.filter(
      (node) =>
        node.role === "implementation" &&
        (node.prerequisites ?? []).every((prerequisite) => nodesById.get(prerequisite)?.role !== "implementation"),
    );
    requireCondition(implementationRoots.length > 0, "Plan has no implementation entry checkpoint");
    const localRoots = nodes.filter((node) => (node.prerequisites ?? []).length === 0);
    requireCondition(localRoots.length === 1, "Plan must have exactly one local root checkpoint");
    planState.set(directory, { manifestPlan, nodes, nodesById, implementationRoots });
  }

  const adjacency = new Map([...globalNodeOwner.keys()].map((id) => [id, new Map()]));
  const indegree = new Map([...globalNodeOwner.keys()].map((id) => [id, 0]));
  const edgeCounts = {};

  const receiptsRequiringProofVerification = [];
  for (const [directory, state] of planState) {
    for (const node of state.nodes) {
      for (const prerequisite of node.prerequisites ?? []) {
        requireCondition(state.nodesById.has(prerequisite), "Local prerequisite escapes its owning Plan");
        assertLocalPlatformDirection(state.nodesById.get(prerequisite), node);
        requireCondition(
          state.nodesById.get(prerequisite).next?.includes(node.id),
          "Local prerequisite edge is not reciprocal with next",
        );
        addEdge(adjacency, indegree, prerequisite, node.id, "local", edgeCounts);
      }
      for (const next of node.next ?? []) {
        requireCondition(state.nodesById.has(next), "Local next edge escapes its owning Plan");
        requireCondition(
          state.nodesById.get(next).prerequisites?.includes(node.id),
          "Local next edge is not reciprocal with prerequisites",
        );
      }
    }

    const mapPlan = mapByDirectory.get(directory);
    const finalNode = state.nodesById.get(mapPlan.final_validation_node_id);
    requireCondition(finalNode?.role === "final_validation", "DependencyMap final-validation owner is invalid");
    requireCondition((finalNode.next ?? []).length === 0, "Plan final-validation node must be locally terminal");
    requireCondition(
      state.nodes
        .filter((node) => participatesInPlanFinal(node, finalNode))
        .every((node) => hasLocalPath(state.nodesById, node.id, finalNode.id)),
      `A local checkpoint does not reduce to the declared Plan final-validation node for ${directory}`,
    );

    const expectedSources = new Set(state.manifestPlan.source_files ?? []);
    for (const referencedDirectory of [
      ...(mapPlan.prerequisite_receipts ?? []).map((receipt) => receipt.plan),
      ...(mapPlan.children ?? []),
    ]) {
      requireCondition(
        expectedSources.has(`docs/plans/${referencedDirectory}/Checkpoints.json`),
        "Manifest is missing an exact prerequisite or child checkpoint source",
      );
    }

    for (const prerequisiteReceipt of mapPlan.prerequisite_receipts ?? []) {
      const prerequisiteDirectory = prerequisiteReceipt.plan;
      const prerequisite = mapByDirectory.get(prerequisiteDirectory);
      requireCondition(prerequisite, "DependencyMap prerequisite Plan does not exist");
      requireCondition(
        !isAncestor(prerequisiteDirectory, directory) && !isAncestor(directory, prerequisiteDirectory),
        "An ancestry edge is incorrectly encoded as a final-receipt prerequisite",
      );
      const receiptOwner = planState.get(prerequisiteDirectory);
      const receiptNode = receiptOwner.nodesById.get(prerequisiteReceipt.node_id);
      requireCondition(receiptNode, "Cross-Plan prerequisite receipt node does not belong to its declared Plan");
      if (prerequisiteReceipt.kind === "final_validation") {
        requireCondition(
          prerequisiteReceipt.node_id === prerequisite.final_validation_node_id && receiptNode.role === "final_validation",
          "Final-validation prerequisite receipt does not identify the Plan final node",
        );
      } else if (prerequisiteReceipt.kind === "contract") {
        requireCondition(
          receiptNode.role === "implementation" || receiptNode.role === "architecture_scaffold",
          "Contract prerequisite receipt must identify a non-final delivery contract node",
        );
      } else {
        fail("Cross-Plan prerequisite receipt kind is invalid");
      }
      for (const implementationRoot of state.implementationRoots) {
        addEdge(
          adjacency,
          indegree,
          prerequisiteReceipt.node_id,
          implementationRoot.id,
          "cross_plan_prerequisite",
          edgeCounts,
        );
      }
    }

    const expectedChildren = dependencyMap.plans
      .filter((candidate) => candidate.parent === directory)
      .map((candidate) => candidate.directory)
      .sort();
    const declaredChildren = [...(mapPlan.children ?? [])].sort();
    requireCondition(JSON.stringify(expectedChildren) === JSON.stringify(declaredChildren), "DependencyMap child list is not reciprocal");

    const finalNodeForReceipt = state.nodesById.get(mapPlan.final_validation_node_id);
    if (finalNodeForReceipt?.status === "completed") {
      for (const prerequisiteReceipt of mapPlan.prerequisite_receipts ?? []) {
        const prerequisiteState = planState.get(prerequisiteReceipt.plan);
        const prerequisiteNode = prerequisiteState?.nodesById.get(prerequisiteReceipt.node_id);
        requireCondition(
          prerequisiteNode?.status === "completed",
          `Completed Plan ${directory} has an incomplete ${prerequisiteReceipt.kind} prerequisite node`,
        );
      }
      if (requireCompletedReceipts) {
        const receipt = mapPlan.accepted_final_receipt;
        requireCondition(receipt, "Accepted final receipt is missing");
        const checkpointsPath = path.join(planRoot, directory, "Checkpoints.json");
        const checkpointsText = await fs.readFile(checkpointsPath, "utf8");
        const planText = await loadPlanAuthorityText(planRoot, directory);
        assertReceiptPlanCurrent(receipt, planReceiptBuildContext({
          repoRoot,
          planDirectory: directory,
          mapPlan,
          planText,
          checkpointsText,
          finalNode: finalNodeForReceipt,
          selectedProfile: receipt.selected_profile,
          dependencyMap,
        }));
        receiptsRequiringProofVerification.push(receipt);
      }
    } else {
      requireCondition(
        !mapPlan.accepted_final_receipt,
        "DependencyMap retains an accepted final receipt for an incomplete Plan final",
      );
    }

    if (mapPlan.parent === null) {
      requireCondition(directory === "end-to-end-release", "Only the release root may omit a parent");
      requireCondition(mapPlan.parent_contract_node_id === null, "Root parent contract node must be null");
      requireCondition(mapPlan.parent_integration_node_id === null, "Root parent integration node must be null");
      continue;
    }

    requireCondition(mapByDirectory.has(mapPlan.parent), "DependencyMap parent Plan does not exist");
    requireCondition(directParent(directory) === mapPlan.parent, "DependencyMap parent is not the direct directory ancestor");
    const parentState = planState.get(mapPlan.parent);
    const parentContract = parentState.nodesById.get(mapPlan.parent_contract_node_id);
    const parentIntegration = parentState.nodesById.get(mapPlan.parent_integration_node_id);
    requireCondition(parentContract, "Parent contract checkpoint does not belong to the parent Plan");
    requireCondition(
      parentContract.role === "implementation" || parentContract.role === "architecture_scaffold",
      "Parent contract checkpoint must be a non-final architecture or implementation node",
    );
    const expectedIntegrationRole = finalNodeForReceipt.platform === "any" ? "implementation" : "evidence";
    requireCondition(
      parentIntegration?.role === expectedIntegrationRole,
      "Parent integration checkpoint role does not match the child platform scope",
    );
    requireCondition(
      parentIntegration.platform === finalNodeForReceipt.platform,
      "Parent integration checkpoint must remain owned by the child final platform",
    );
    requireCondition(
      JSON.stringify(parentIntegration).includes(`docs/plans/${directory}/Checkpoints.json`),
      `Parent integration checkpoint does not identify the child receipt source for ${directory}`,
    );
    requireCondition(
      JSON.stringify(parentIntegration).includes(mapPlan.final_validation_node_id),
      "Parent integration checkpoint does not identify the exact child final-validation node",
    );
    requireCondition(
      hasLocalPath(parentState.nodesById, parentContract.id, parentIntegration.id),
      "Parent contract checkpoint does not precede its child integration checkpoint",
    );

    for (const implementationRoot of state.implementationRoots) {
      addEdge(adjacency, indegree, parentContract.id, implementationRoot.id, "parent_contract", edgeCounts);
    }
    addEdge(
      adjacency,
      indegree,
      mapPlan.final_validation_node_id,
      parentIntegration.id,
      "parent_integration",
      edgeCounts,
    );
  }
  await assertPlanReceiptProofAnchorsCurrent({ repoRoot, receipts: receiptsRequiringProofVerification });

  for (const [from, targets] of adjacency) {
    for (const to of targets.values()) {
      const predecessorState = planState.get(globalNodeOwner.get(from));
      const successorState = planState.get(globalNodeOwner.get(to));
      const predecessor = predecessorState?.nodesById.get(from);
      const successor = successorState?.nodesById.get(to);
      requireCondition(
        successor?.status !== "completed" || predecessor?.status === "completed",
        "Completed checkpoint has an incomplete local or global predecessor",
      );
    }
  }

  const queue = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort();
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    visited += 1;
    for (const next of adjacency.get(current).values()) {
      const remaining = indegree.get(next) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }
  requireCondition(visited === globalNodeOwner.size, "Combined local and cross-Plan receipt graph contains a cycle");

  const executionAdmissionByPlatform = Object.fromEntries(
    ["macos", "windows", "linux"].map((hostPlatform) => {
      const admission = evaluatePlanExecutionEligibility({
        manifest,
        dependencyMap,
        checkpoints: checkpointCollection,
        hostPlatform,
        requireAcceptedFinalReceipts: requireCompletedReceipts,
      });
      return [hostPlatform, {
        candidate_count: admission.candidateCount,
        eligible_count: admission.eligible.length,
        deferred_count: admission.deferred.length,
        deferred_reason_counts: admission.deferredReasonCounts,
      }];
    }),
  );

  const report = {
    schema_version: "licomesh.end-to-end-release-plan-proof.v2",
    accepted: true,
    plan_count: planState.size,
    manifest_plan_count: manifest.length,
    draft_plan_count: manifest.length - planState.size,
    checkpoint_node_count: globalNodeOwner.size,
    parent_contract_edges: edgeCounts.parent_contract ?? 0,
    parent_integration_edges: edgeCounts.parent_integration ?? 0,
    cross_plan_prerequisite_edges: edgeCounts.cross_plan_prerequisite ?? 0,
    local_edges: edgeCounts.local ?? 0,
    manifest_dependency_order_edges: manifestDependencyOrderEdges,
    topologically_reduced_nodes: visited,
    execution_admission_policy_accepted: true,
    execution_admission_by_platform: executionAdmissionByPlatform,
    manifest_sha256: digest(manifestText),
    dependency_map_sha256: digest(dependencyMapText),
  };

  if (writeReport) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

async function copyPlanWorkspace(sourcePlanRoot, targetPlanRoot) {
  await fs.cp(sourcePlanRoot, targetPlanRoot, { recursive: true });
}

async function normalizeMutationFixtureStatuses(planRoot) {
  const manifest = await readJson(path.join(planRoot, "Manifest.json"));
  const dependencyMap = await readJson(path.join(planRoot, "end-to-end-release", "DependencyMap.json"));
  const nodesByPlan = new Map();
  const stateByPlan = new Map();
  for (const manifestPlan of manifest) {
    const checkpointsPath = path.join(planRoot, manifestPlan.directory, "Checkpoints.json");
    const nodes = await readJson(checkpointsPath);
    nodesByPlan.set(manifestPlan.directory, { checkpointsPath, nodes });
    stateByPlan.set(manifestPlan.directory, new Map(nodes.map((node) => [node.id, node])));
  }

  const statusEdges = [];
  for (const mapPlan of dependencyMap.plans) {
    const state = stateByPlan.get(mapPlan.directory);
    for (const node of state.values()) {
      for (const prerequisite of node.prerequisites ?? []) {
        statusEdges.push([state.get(prerequisite), node]);
      }
    }
    const implementationRoots = [...state.values()].filter(
      (node) =>
        node.role === "implementation" &&
        (node.prerequisites ?? []).every((prerequisite) => state.get(prerequisite)?.role !== "implementation"),
    );
    if (mapPlan.parent !== null) {
      const parentState = stateByPlan.get(mapPlan.parent);
      const parentContract = parentState.get(mapPlan.parent_contract_node_id);
      const parentIntegration = parentState.get(mapPlan.parent_integration_node_id);
      for (const implementationRoot of implementationRoots) {
        statusEdges.push([parentContract, implementationRoot]);
      }
      statusEdges.push([state.get(mapPlan.final_validation_node_id), parentIntegration]);
    }
    for (const receipt of mapPlan.prerequisite_receipts ?? []) {
      const provider = stateByPlan.get(receipt.plan)?.get(receipt.node_id);
      for (const implementationRoot of implementationRoots) {
        statusEdges.push([provider, implementationRoot]);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [predecessor, successor] of statusEdges) {
      if (successor?.status === "completed" && predecessor?.status !== "completed") {
        predecessor.status = "completed";
        changed = true;
      }
    }
  }
  await Promise.all(
    [...nodesByPlan.values()].map(({ checkpointsPath, nodes }) => writeJson(checkpointsPath, nodes)),
  );
}

async function expectVerificationFailure({
  repoRoot,
  planRoot,
  expectedSubstring,
  requireCompletedReceipts = false,
}) {
  let error;
  try {
    await verifyEndToEndReleasePlan({
      repoRoot,
      planRoot,
      writeReport: false,
      requireCompletedReceipts,
      reportPath: path.join(planRoot, "mutation-report.json"),
    });
  } catch (caught) {
    error = caught;
  }
  requireCondition(error instanceof Error, `Expected verification failure containing ${expectedSubstring}`);
  requireCondition(
    String(error.message).includes(expectedSubstring),
    `Expected failure message to include ${expectedSubstring}; got: ${error.message}`,
  );
}

export async function runEndToEndReleasePlanMutationTests({ repoRoot = defaultRepoRoot } = {}) {
  const sourcePlanRoot = path.join(repoRoot, "docs", "plans");
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lico-e2e-plan-mutations-"));
  const results = [];

  try {
    const completeRootFinalFromAcceptedPlan = async (planRoot) => {
      const dependencyMapPath = path.join(planRoot, "end-to-end-release", "DependencyMap.json");
      const dependencyMap = await readJson(dependencyMapPath);
      const rootPlan = dependencyMap.plans.find((plan) => plan.directory === "end-to-end-release");
      let donorPlan;
      for (const candidate of dependencyMap.plans.filter((plan) => plan.accepted_final_receipt)) {
        const candidateNodes = await readJson(path.join(planRoot, candidate.directory, "Checkpoints.json"));
        const candidateFinal = candidateNodes.find((node) => node.id === candidate.final_validation_node_id);
        const evidenceRefs = (candidateFinal?.acceptance_criteria ?? []).flatMap(
          (criterion) => criterion.evidence_refs ?? [],
        );
        if (
          evidenceRefs.length > 0 &&
          evidenceRefs.every(
            (ref) =>
              ref.type !== "command" ||
              (!Object.hasOwn(ref, "command") && /^[a-f0-9]{64}$/u.test(ref.command_sha256)),
          )
        ) {
          donorPlan = candidate;
          break;
        }
      }
      requireCondition(rootPlan && donorPlan, "root receipt mutation fixtures missing");

      const rootCheckpointsPath = path.join(planRoot, rootPlan.directory, "Checkpoints.json");
      const donorCheckpointsPath = path.join(planRoot, donorPlan.directory, "Checkpoints.json");
      const rootNodes = await readJson(rootCheckpointsPath);
      const donorNodes = await readJson(donorCheckpointsPath);
      const rootFinal = rootNodes.find((node) => node.id === rootPlan.final_validation_node_id);
      const donorFinal = donorNodes.find((node) => node.id === donorPlan.final_validation_node_id);
      requireCondition(rootFinal && donorFinal?.status === "completed", "completed final receipt mutation fixture missing");
      Object.assign(rootFinal, {
        status: "completed",
        platform: donorFinal.platform,
        requirements: structuredClone(donorFinal.requirements),
        acceptance_criteria: structuredClone(donorFinal.acceptance_criteria),
        commit: structuredClone(donorFinal.commit),
      });
      await writeJson(rootCheckpointsPath, rootNodes);
      return { dependencyMapPath, dependencyMap, rootPlan, donorPlan };
    };

    const cases = [
      {
        name: "root-completed-final-missing-receipt",
        expectedSubstring: "Accepted final receipt is missing",
        requireCompletedReceipts: true,
        mutate: async (planRoot) => {
          const { dependencyMapPath, dependencyMap, rootPlan } = await completeRootFinalFromAcceptedPlan(planRoot);
          delete rootPlan.accepted_final_receipt;
          await writeJson(dependencyMapPath, dependencyMap);
        },
      },
      {
        name: "root-completed-final-stale-receipt",
        expectedSubstring: "Accepted final receipt facts are absent or stale",
        requireCompletedReceipts: true,
        mutate: async (planRoot) => {
          const { dependencyMapPath, dependencyMap, rootPlan, donorPlan } =
            await completeRootFinalFromAcceptedPlan(planRoot);
          rootPlan.accepted_final_receipt = structuredClone(donorPlan.accepted_final_receipt);
          await writeJson(dependencyMapPath, dependencyMap);
        },
      },
      {
        name: "root-incomplete-final-retains-receipt",
        expectedSubstring: "DependencyMap retains an accepted final receipt for an incomplete Plan final",
        mutate: async (planRoot) => {
          const dependencyMapPath = path.join(planRoot, "end-to-end-release", "DependencyMap.json");
          const dependencyMap = await readJson(dependencyMapPath);
          const rootPlan = dependencyMap.plans.find((plan) => plan.directory === "end-to-end-release");
          const donorPlan = dependencyMap.plans.find((plan) => plan.accepted_final_receipt);
          requireCondition(rootPlan && donorPlan, "incomplete root receipt mutation fixtures missing");
          rootPlan.accepted_final_receipt = structuredClone(donorPlan.accepted_final_receipt);
          await writeJson(dependencyMapPath, dependencyMap);
        },
      },
      {
        name: "completed-final-status-inversion",
        expectedSubstring: "Completed checkpoint has an incomplete local or global predecessor",
        mutate: async (planRoot) => {
          const checkpointsPath = path.join(planRoot, "end-to-end-release/Checkpoints.json");
          const nodes = await readJson(checkpointsPath);
          const finalNode = nodes.find((node) => node.role === "final_validation");
          requireCondition(finalNode, "root final status mutation fixture missing");
          finalNode.status = "completed";
          await writeJson(checkpointsPath, nodes);
        },
      },
      {
        name: "parent-final-child-prerequisite",
        expectedSubstring: "Parent contract checkpoint must be a non-final architecture or implementation node",
        mutate: async (planRoot) => {
          const dependencyMapPath = path.join(planRoot, "end-to-end-release", "DependencyMap.json");
          const dependencyMap = await readJson(dependencyMapPath);
          const smg = dependencyMap.plans.find(
            (plan) => plan.directory === "end-to-end-release/platform-foundation/state-machine-governance",
          );
          const pf = dependencyMap.plans.find((plan) => plan.directory === "end-to-end-release/platform-foundation");
          requireCondition(smg && pf, "mutation fixture plans missing");
          smg.parent_contract_node_id = pf.final_validation_node_id;
          await writeJson(dependencyMapPath, dependencyMap);
        },
      },
      {
        name: "parent-child-cycle",
        expectedSubstring: "Combined local and cross-Plan receipt graph contains a cycle",
        mutate: async (planRoot) => {
          const checkpointsPath = path.join(
            planRoot,
            "end-to-end-release/platform-foundation/state-machine-governance/Checkpoints.json",
          );
          const nodes = await readJson(checkpointsPath);
          const root = nodes.find((node) => (node.prerequisites ?? []).length === 0);
          const mid = nodes.find((node) => (node.prerequisites ?? []).includes(root?.id));
          const later = nodes.find((node) => (node.prerequisites ?? []).includes(mid?.id));
          requireCondition(root && mid && later, "SMG chain missing for cycle mutation");
          mid.prerequisites = Array.from(new Set([...(mid.prerequisites ?? []), later.id]));
          later.next = Array.from(new Set([...(later.next ?? []), mid.id]));
          await writeJson(checkpointsPath, nodes);
        },
      },
      {
        name: "wrong-receipt-owner-or-kind",
        expectedSubstring: "Cross-Plan prerequisite receipt kind is invalid",
        mutate: async (planRoot) => {
          const dependencyMapPath = path.join(planRoot, "end-to-end-release", "DependencyMap.json");
          const dependencyMap = await readJson(dependencyMapPath);
          const auth = dependencyMap.plans.find(
            (plan) => plan.directory === "end-to-end-release/platform-foundation/authorization",
          );
          requireCondition(auth?.prerequisite_receipts?.length > 0, "authorization receipts missing");
          auth.prerequisite_receipts[0].kind = "not-a-valid-kind";
          await writeJson(dependencyMapPath, dependencyMap);
        },
      },
      {
        name: "stale-node-id",
        expectedSubstring: "Cross-Plan prerequisite receipt node does not belong to its declared Plan",
        mutate: async (planRoot) => {
          const dependencyMapPath = path.join(planRoot, "end-to-end-release", "DependencyMap.json");
          const dependencyMap = await readJson(dependencyMapPath);
          const auth = dependencyMap.plans.find(
            (plan) => plan.directory === "end-to-end-release/platform-foundation/authorization",
          );
          requireCondition(auth?.prerequisite_receipts?.length > 0, "authorization receipts missing");
          auth.prerequisite_receipts[0].node_id = "00000000-0000-4000-8000-deadbeefdead";
          await writeJson(dependencyMapPath, dependencyMap);
        },
      },
      {
        name: "missing-reciprocal-edge",
        expectedSubstring: "Local next edge is not reciprocal with prerequisites",
        mutate: async (planRoot) => {
          const checkpointsPath = path.join(
            planRoot,
            "end-to-end-release/platform-foundation/state-machine-governance/Checkpoints.json",
          );
          const nodes = await readJson(checkpointsPath);
          const root = nodes.find((node) => (node.prerequisites ?? []).length === 0);
          const mid = nodes.find((node) => (node.prerequisites ?? []).includes(root?.id));
          const later = nodes.find((node) => (node.prerequisites ?? []).includes(mid?.id));
          requireCondition(root && mid && later, "SMG chain missing for reciprocal mutation");
          root.next = Array.from(new Set([...(root.next ?? []), later.id]));
          await writeJson(checkpointsPath, nodes);
        },
      },
      {
        name: "missing-reciprocal-prerequisite-edge",
        expectedSubstring: "Local prerequisite edge is not reciprocal with next",
        mutate: async (planRoot) => {
          const checkpointsPath = path.join(
            planRoot,
            "end-to-end-release/platform-foundation/state-machine-governance/Checkpoints.json",
          );
          const nodes = await readJson(checkpointsPath);
          const root = nodes.find((node) => (node.prerequisites ?? []).length === 0);
          const mid = nodes.find((node) => (node.prerequisites ?? []).includes(root?.id));
          const later = nodes.find((node) => (node.prerequisites ?? []).includes(mid?.id));
          requireCondition(root && mid && later, "SMG chain missing for reverse reciprocal mutation");
          later.prerequisites = Array.from(new Set([...(later.prerequisites ?? []), root.id]));
          await writeJson(checkpointsPath, nodes);
        },
      },
      {
        name: "absent-source-file",
        expectedSubstring: "Manifest local source does not exist",
        mutate: async (planRoot) => {
          const manifestPath = path.join(planRoot, "Manifest.json");
          const manifest = await readJson(manifestPath);
          const pf = manifest.find((plan) => plan.directory === "end-to-end-release/platform-foundation");
          requireCondition(pf, "platform-foundation manifest entry missing");
          pf.source_files = [...(pf.source_files ?? []), "docs/plans/missing-source-authority.json"];
          await writeJson(manifestPath, manifest);
        },
      },
      {
        name: "unsafe-source-uri",
        expectedSubstring: "Manifest source URI is not an authoritative Plan source",
        mutate: async (planRoot) => {
          const manifestPath = path.join(planRoot, "Manifest.json");
          const manifest = await readJson(manifestPath);
          manifest[0].source_files.push("https://example.invalid/plan.json");
          await writeJson(manifestPath, manifest);
        },
      },
      {
        name: "local-source-traversal",
        expectedSubstring: "Manifest local source path is unsafe",
        mutate: async (planRoot) => {
          const manifestPath = path.join(planRoot, "Manifest.json");
          const manifest = await readJson(manifestPath);
          manifest[0].source_files.push("docs/plans/../../README.md");
          await writeJson(manifestPath, manifest);
        },
      },
      {
        name: "client-repository-qualified-source",
        expectedSubstring: "Manifest repository-qualified source authority is not allowed",
        mutate: async (planRoot) => {
          const manifestPath = path.join(planRoot, "Manifest.json");
          const manifest = await readJson(manifestPath);
          manifest[0].source_files.push("LicoMesh/licoarc-client:README.md");
          await writeJson(manifestPath, manifest);
        },
      },
      {
        name: "duplicate-plan-or-node",
        expectedSubstring: "Plan contains a duplicate checkpoint node id",
        mutate: async (planRoot) => {
          const checkpointsPath = path.join(
            planRoot,
            "end-to-end-release/platform-foundation/state-machine-governance/Checkpoints.json",
          );
          const nodes = await readJson(checkpointsPath);
          requireCondition(nodes.length > 0, "SMG checkpoints empty");
          nodes.push(structuredClone(nodes[0]));
          await writeJson(checkpointsPath, nodes);
        },
      },
      {
        name: "missing-child-integration",
        expectedSubstring: "Parent integration checkpoint role does not match the child platform scope",
        mutate: async (planRoot) => {
          const dependencyMapPath = path.join(planRoot, "end-to-end-release", "DependencyMap.json");
          const dependencyMap = await readJson(dependencyMapPath);
          const smg = dependencyMap.plans.find(
            (plan) => plan.directory === "end-to-end-release/platform-foundation/state-machine-governance",
          );
          requireCondition(smg, "SMG dependency map entry missing");
          smg.parent_integration_node_id = smg.final_validation_node_id;
          await writeJson(dependencyMapPath, dependencyMap);
        },
      },
      {
        name: "platform-child-mismatch",
        expectedSubstring: "platform-named Plan contains a checkpoint for another platform",
        mutate: async (planRoot) => {
          const checkpointsPath = path.join(
            planRoot,
            "end-to-end-release/gateway-distribution/downstream-mcp/native-installer/windows/Checkpoints.json",
          );
          const nodes = await readJson(checkpointsPath);
          requireCondition(nodes.length > 0, "Windows native-installer checkpoints missing");
          nodes[0].platform = "any";
          await writeJson(checkpointsPath, nodes);
        },
      },
      {
        name: "platform-integration-role-erasure",
        expectedSubstring: "Parent integration checkpoint role does not match the child platform scope",
        mutate: async (planRoot) => {
          const checkpointsPath = path.join(
            planRoot,
            "end-to-end-release/gateway-distribution/downstream-mcp/native-installer/Checkpoints.json",
          );
          const nodes = await readJson(checkpointsPath);
          const windowsIntegration = nodes.find(
            (node) => node.id === "10000000-0000-4000-8000-000000000190",
          );
          requireCondition(windowsIntegration, "Windows integration checkpoint missing");
          windowsIntegration.role = "implementation";
          await writeJson(checkpointsPath, nodes);
        },
      },
      {
        name: "foreign-platform-gates-neutral-final",
        expectedSubstring: "Platform-specific checkpoint cannot gate platform-neutral or different-platform work",
        mutate: async (planRoot) => {
          const checkpointsPath = path.join(
            planRoot,
            "end-to-end-release/gateway-distribution/downstream-mcp/native-installer/Checkpoints.json",
          );
          const nodes = await readJson(checkpointsPath);
          const windowsIntegration = nodes.find(
            (node) => node.id === "10000000-0000-4000-8000-000000000190",
          );
          const neutralFinal = nodes.find(
            (node) => node.id === "10000000-0000-4000-8000-000000000191",
          );
          requireCondition(windowsIntegration && neutralFinal, "native-installer platform mutation fixtures missing");
          windowsIntegration.next = [neutralFinal.id];
          neutralFinal.prerequisites = Array.from(new Set([...(neutralFinal.prerequisites ?? []), windowsIntegration.id]));
          await writeJson(checkpointsPath, nodes);
        },
      },
      {
        name: "malformed-repository-target",
        expectedSubstring: "checkpoint repository target is missing or malformed",
        mutate: async (planRoot) => {
          const checkpointsPath = path.join(
            planRoot,
            "end-to-end-release/platform-foundation/state-machine-governance/Checkpoints.json",
          );
          const nodes = await readJson(checkpointsPath);
          requireCondition(nodes.length > 0, "SMG checkpoints empty");
          nodes[0].commit.repository = "../client-repository";
          await writeJson(checkpointsPath, nodes);
        },
      },
    ];

    for (const testCase of cases) {
      const caseRoot = path.join(workRoot, testCase.name);
      await copyPlanWorkspace(sourcePlanRoot, caseRoot);
      await normalizeMutationFixtureStatuses(caseRoot);
      await testCase.mutate(caseRoot);
      await expectVerificationFailure({
        repoRoot,
        planRoot: caseRoot,
        expectedSubstring: testCase.expectedSubstring,
        requireCompletedReceipts: testCase.requireCompletedReceipts,
      });
      results.push({ name: testCase.name, rejected: true, expectedSubstring: testCase.expectedSubstring });
    }
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }

  return {
    accepted: true,
    mutation_case_count: results.length,
    cases: results,
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--self-test-mutations")) {
    requireCondition(argv.length === 1, "Plan verifier received unsupported arguments");
    const mutationReport = await runEndToEndReleasePlanMutationTests();
    process.stdout.write(`${JSON.stringify(mutationReport)}\n`);
    return;
  }

  const structuralOnly = argv.includes("--structural-only");
  requireCondition(
    argv.length === (structuralOnly ? 1 : 0),
    "Plan verifier received unsupported arguments",
  );
  const report = await verifyEndToEndReleasePlan({
    requireCompletedReceipts: !structuralOnly,
    writeReport: !structuralOnly,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
