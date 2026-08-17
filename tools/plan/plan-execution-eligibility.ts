import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertReceiptIntegrity, RECEIPT_SCHEMA } from "./plan-final-receipt.ts";
import {
  acceptedFinalReceipt,
  acceptedFinalReceiptEntries,
  assertCurrentDependencyMapShape,
  finalValidationBinding,
  finalValidationBindings,
  normalizePlanProfiles,
  parentIntegrationBinding,
  PLAN_PROFILE_SET,
  profilesContain,
  profilesEqual,
} from "./plan-dependency-map.ts";
import { resolveGitRepoRoot } from "../server-scripts/lib/source-tree-digest.ts";
import {
  type CheckpointNode,
  type CheckpointPlatform,
  type CheckpointsByDirectory,
  type DependencyMap,
  type DependencyMapPlan,
  type FinalValidationBinding,
  type JsonRecord,
  type ManifestPlan,
  type PlanProfile,
  isCheckpointNode,
  isCheckpointPlatform,
  isCheckpointStatus,
  hasControlCharacter,
  isJsonRecord,
} from "./plan-types.ts";

type PolicyErrorCode = string;
type RepositoryClass = "core" | "external";
type EdgeKind = "local" | "cross_plan_prerequisite" | "parent_contract" | "parent_integration";
interface PlanState {
  manifestPlan: ManifestPlan;
  nodes: CheckpointNode[];
  nodesById: Map<string, CheckpointNode>;
  implementationRoots: CheckpointNode[];
}
interface NodeMetadata {
  node: CheckpointNode;
  planDirectory: string;
  manifestPlan: ManifestPlan;
  manifestIndex: number;
  checkpointIndex: number;
  repositoryClass: RepositoryClass;
  profiles: Set<PlanProfile>;
}
export interface EligibleNodeProjection {
  planDirectory: string;
  nodeId: string;
  status: CheckpointNode["status"];
  role: string;
  platform: CheckpointPlatform;
  profiles: PlanProfile[];
  manifestIndex: number;
  checkpointIndex: number;
  incomingDependencyCount: number;
}
export interface PlanExecutionEvaluation {
  hostPlatform: Exclude<CheckpointPlatform, "any">;
  selectedProfile: PlanProfile | null;
  candidateCount: number;
  eligible: EligibleNodeProjection[];
  deferred: Array<EligibleNodeProjection & { reasons: string[]; incompleteDependencyCount: number }>;
  deferredReasonCounts: Record<string, number>;
  graph: { planCount: number; nodeCount: number; edgeCount: number };
}
export interface PlanExecutionInputs {
  manifest: ManifestPlan[];
  dependencyMap: DependencyMap;
  checkpoints: Map<string, CheckpointNode[]>;
}

const modulePath  = fileURLToPath(import.meta.url);
const defaultRepoRoot  = path.resolve(path.dirname(modulePath), "../..");

const HOST_PLATFORM_ALIASES = new Map<string, Exclude<CheckpointPlatform, "any">>([
  ["darwin", "macos"],
  ["macos", "macos"],
  ["win32", "windows"],
  ["windows", "windows"],
  ["linux", "linux"],
]);
const PLATFORM_PLAN_NAMES  = new Set(["macos", "windows", "linux"]);
const ELIGIBLE_STATUSES  = new Set(["pending", "in_progress"]);
const STATUS_PRIORITY = new Map<CheckpointNode["status"], number>([
  ["in_progress", 0],
  ["pending", 1],
]);
const SAFE_SEGMENT  = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u;
const SAFE_ROLE  = /^[a-z][a-z0-9_]*$/u;
const MAX_DIRECTORY_LENGTH  = 512;
const MAX_NODE_ID_LENGTH  = 256;
const MAX_REPOSITORY_LENGTH  = 256;
const MAX_PLAN_COUNT  = 256;
const MAX_CHECKPOINT_COUNT  = 4096;
const MAX_EDGE_COUNT  = 16_384;

export const PLAN_EXECUTION_RESOURCE_DISCIPLINE = Object.freeze({
  id: "plan-execution-eligibility",
  bounds: Object.freeze({
    maxDirectoryLength: MAX_DIRECTORY_LENGTH,
    maxNodeIdLength: MAX_NODE_ID_LENGTH,
    maxRepositoryLength: MAX_REPOSITORY_LENGTH,
    maxPlanCount: MAX_PLAN_COUNT,
    maxCheckpointCount: MAX_CHECKPOINT_COUNT,
    maxEdgeCount: MAX_EDGE_COUNT,
  }),
  scheduling: Object.freeze({
    statusPriority: Object.freeze(["in_progress", "pending"]),
  }),
  caching: Object.freeze({
    receiptValidation: "once-per-evaluation",
  }),
  lockOwnership: Object.freeze({
    graphState: "evaluation-local",
    inputMutation: "forbidden",
  }),
});

export class PlanExecutionPolicyError extends Error {
  code: PolicyErrorCode;
  override name = "PlanExecutionPolicyError";
  constructor(code: PolicyErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

function fail(code: PolicyErrorCode, message: string): never {
  throw new PlanExecutionPolicyError(code, message);
}

function requireCondition(condition: unknown, code: PolicyErrorCode, message: string): asserts condition {
  if (!condition) {
    fail(code, message);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return isJsonRecord(value);
}

function requireBoundedString(value: unknown, { code, message, maxLength = MAX_NODE_ID_LENGTH }: {
  code: PolicyErrorCode; message: string; maxLength?: number;
}): string {
  requireCondition(
    typeof value === "string" && value.length > 0 && value.length <= maxLength && !hasControlCharacter(value),
    code,
    message,
  );
  return value;
}

function requireStringArray(value: unknown, code: PolicyErrorCode, message: string): string[] {
  requireCondition(Array.isArray(value), code, message);
  const result = value.map((entry) => requireBoundedString(entry, { code, message }));
  requireCondition(new Set(result).size === result.length, "invalid_graph", "checkpoint graph contains a duplicate reference");
  return result;
}

function requirePlanDirectory(value: unknown, code: PolicyErrorCode = "invalid_manifest"): string {
  const directory  = requireBoundedString(value, {
    code,
    message: "plan directory is missing or malformed",
    maxLength: MAX_DIRECTORY_LENGTH,
  });
  const segments  = directory.split("/");
  requireCondition(
    !directory.startsWith("/") &&
      segments.length > 0 &&
      segments.every((segment) => segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment)),
    code,
    "plan directory is missing or malformed",
  );
  return directory;
}

function directParent(directory: string): string | null {
  const separator  = directory.lastIndexOf("/");
  return separator < 0 ? null : directory.slice(0, separator);
}

function isAncestor(left: string, right: string): boolean {
  return right.startsWith(`${left}/`);
}

function classifyRepositoryTarget(repository: unknown): RepositoryClass {
  requireCondition(
    typeof repository === "string" &&
      repository.length > 0 &&
      repository.length <= MAX_REPOSITORY_LENGTH &&
      !hasControlCharacter(repository) && !repository.includes("\\"),
    "malformed_repository",
    "checkpoint repository target is missing or malformed",
  );

  if (repository === ".git") {
    return "core";
  }

  const segments  = repository.split("/");
  requireCondition(
    !repository.startsWith("/") &&
      segments.length >= 2 &&
      segments.at(-1) === ".git" &&
      segments.slice(0, -1).every((segment) => segment === ".." || SAFE_SEGMENT.test(segment)),
    "malformed_repository",
    "checkpoint repository target is missing or malformed",
  );
  return "external";
}

export function normalizeHostPlatform(platform: unknown): Exclude<CheckpointPlatform, "any"> {
  const normalized  = typeof platform === "string" ? HOST_PLATFORM_ALIASES.get(platform) : undefined;
  requireCondition(normalized, "unknown_host_platform", "unknown host platform");
  return normalized;
}

function checkpointEntries(checkpoints: unknown): Array<[string, unknown]> {
  if (checkpoints instanceof Map) {
    return [...checkpoints.entries()];
  }
  requireCondition(isRecord(checkpoints), "invalid_checkpoints", "checkpoints must be keyed by Plan directory");
  return Object.entries(checkpoints);
}

function hasLocalPath(state: PlanState, from: string, to: string): boolean {
  const seen = new Set<string>();
  const queue  = [from];
  for (let cursor  = 0; cursor < queue.length; cursor += 1) {
    const current  = queue[cursor];
    if (current === to) {
      return true;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const next of state.nodesById.get(current)?.next ?? []) {
      queue.push(next);
    }
  }
  return false;
}

function reverseReachableNodes(state: PlanState, terminalNodeId: string): Set<string> {
  const reachable = new Set<string>();
  const queue  = [terminalNodeId];
  for (let cursor  = 0; cursor < queue.length; cursor += 1) {
    const current  = queue[cursor];
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);
    for (const prerequisite of state.nodesById.get(current)?.prerequisites ?? []) {
      queue.push(prerequisite);
    }
  }
  return reachable;
}

function participatesInPlanFinal(node: CheckpointNode, finalNode: CheckpointNode): boolean {
  return node.status !== "skipped" &&
    (node.platform === "any" || node.platform === finalNode.platform);
}

function assertLocalPlatformDirection(prerequisite: CheckpointNode, dependent: CheckpointNode): void {
  requireCondition(
    prerequisite.platform === "any" ||
      (dependent.platform !== "any" && prerequisite.platform === dependent.platform),
    "platform_dependency_mismatch",
    "platform-specific checkpoint cannot gate platform-neutral or different-platform work",
  );
}

function assertAcceptedFinalReceipt(mapPlan: DependencyMapPlan, finalNode: CheckpointNode, finalBinding: FinalValidationBinding): void {
  const receipt  = acceptedFinalReceipt(mapPlan, finalNode.id);
  requireCondition(isRecord(receipt), "invalid_final_receipt", "completed Plan final is missing its accepted final receipt");
  requireCondition(
    receipt.schema_version === RECEIPT_SCHEMA &&
      receipt.plan === mapPlan.directory &&
      receipt.final_node_id === finalNode.id &&
      receipt.parent_contract_node_id === mapPlan.parent_contract_node_id &&
      receipt.parent_integration_node_id === parentIntegrationBinding(mapPlan, finalNode.id)?.parent_node_id &&
      receipt.status === "completed" &&
      receipt.role === "final_validation" &&
      receipt.platform === finalNode.platform &&
      profilesEqual(receipt.profiles, finalBinding.profiles),
    "invalid_final_receipt",
    "accepted final receipt is not bound to the current Plan final",
  );
  requireCondition(receipt.privacy_safe === true, "invalid_final_receipt", "accepted final receipt is not privacy-safe");
  try {
    assertReceiptIntegrity(receipt);
  } catch {
    fail("invalid_final_receipt", "accepted final receipt proof is not verified or current");
  }
}

function nodeProjection(metadata: NodeMetadata, incoming: Map<string, Set<string>>): EligibleNodeProjection {
  return {
    planDirectory: metadata.planDirectory,
    nodeId: metadata.node.id,
    status: metadata.node.status,
    role: metadata.node.role,
    platform: metadata.node.platform,
    profiles: [...metadata.profiles],
    manifestIndex: metadata.manifestIndex,
    checkpointIndex: metadata.checkpointIndex,
    incomingDependencyCount: incoming.get(metadata.node.id)?.size ?? 0,
  };
}

function compareEligible(left: EligibleNodeProjection, right: EligibleNodeProjection): number {
  return (
    (STATUS_PRIORITY.get(left.status) ?? Number.MAX_SAFE_INTEGER) - (STATUS_PRIORITY.get(right.status) ?? Number.MAX_SAFE_INTEGER) ||
    left.manifestIndex - right.manifestIndex ||
    left.checkpointIndex - right.checkpointIndex
  );
}

function assertAcyclic(outgoing: Map<string, Set<string>>, incoming: Map<string, Set<string>>): void {
  const indegree  = new Map([...incoming].map(([nodeId, sources] )  => [nodeId, sources.size]));
  const queue  = [...indegree].filter(([, count] )  => count === 0).map(([nodeId] )  => nodeId);
  let visited  = 0;

  for (let cursor  = 0; cursor < queue.length; cursor += 1) {
    const current  = queue[cursor];
    visited += 1;
    for (const next of outgoing.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
      }
    }
  }

  requireCondition(visited === outgoing.size, "invalid_graph", "combined checkpoint graph contains a cycle");
}

export function evaluatePlanExecutionEligibility({
  manifest,
  dependencyMap,
  checkpoints,
  checkpointsByDirectory,
  hostPlatform,
  selectedProfile,
  requireAcceptedFinalReceipts = true,
}: {
  manifest?: unknown;
  dependencyMap?: unknown;
  checkpoints?: CheckpointsByDirectory;
  checkpointsByDirectory?: CheckpointsByDirectory;
  hostPlatform?: unknown;
  selectedProfile?: PlanProfile;
  requireAcceptedFinalReceipts?: boolean;
} = {}): PlanExecutionEvaluation {
  const normalizedHostPlatform  = normalizeHostPlatform(hostPlatform);
  requireCondition(
    selectedProfile === undefined || PLAN_PROFILE_SET.has(selectedProfile),
    "unknown_profile",
    "unknown execution profile",
  );
  const injectedCheckpoints  = checkpoints ?? checkpointsByDirectory;
  requireCondition(
    checkpoints === undefined || checkpointsByDirectory === undefined || checkpoints === checkpointsByDirectory,
    "invalid_checkpoints",
    "multiple checkpoint collections were provided",
  );
  requireCondition(Array.isArray(manifest) && manifest.length > 0, "invalid_manifest", "Manifest must be a non-empty array");
  let currentDependencyMap: DependencyMap;
  try {
    currentDependencyMap = assertCurrentDependencyMapShape(dependencyMap);
  } catch {
    fail("invalid_dependency_map", "DependencyMap schema or Plan entries are not current");
  }
  const manifestByDirectory = new Map<string, ManifestPlan>();
  const manifestIndexByDirectory = new Map<string, number>();
  for (const [manifestIndex, manifestPlan] of manifest.entries()) {
    requireCondition(isRecord(manifestPlan) && typeof manifestPlan.directory === "string" && typeof manifestPlan.checkpoints === "string", "invalid_manifest", "Manifest Plan entry is malformed");
    const directory  = requirePlanDirectory(manifestPlan.directory);
    requireCondition(!manifestByDirectory.has(directory), "invalid_manifest", "Manifest contains a duplicate Plan directory");
    requireCondition(
      manifestPlan.checkpoints === `${directory}/Checkpoints.json`,
      "invalid_manifest",
      "Manifest checkpoint path does not match its Plan directory",
    );
    manifestByDirectory.set(directory, { ...manifestPlan, directory, checkpoints: manifestPlan.checkpoints });
    manifestIndexByDirectory.set(directory, manifestIndex);
  }

  const checkpointCollectionEntries  = checkpointEntries(injectedCheckpoints);
  requireCondition(
    checkpointCollectionEntries.length === manifest.length,
    "invalid_checkpoints",
    "checkpoint collection and Manifest Plan counts differ",
  );
  const checkpointCollection = new Map<string, unknown>();
  for (const [directoryValue, nodes] of checkpointCollectionEntries) {
    const directory  = requirePlanDirectory(directoryValue, "invalid_checkpoints");
    requireCondition(manifestByDirectory.has(directory), "invalid_checkpoints", "checkpoint collection contains an unknown Plan");
    requireCondition(!checkpointCollection.has(directory), "invalid_checkpoints", "checkpoint collection contains a duplicate Plan");
    checkpointCollection.set(directory, nodes);
  }
  requireCondition(
    [...manifestByDirectory.keys()].every((directory) => checkpointCollection.has(directory)),
    "invalid_checkpoints",
    "checkpoint collection is missing a Manifest Plan",
  );

  const mapByDirectory = new Map<string, DependencyMapPlan>();
  for (const mapPlan of currentDependencyMap.plans) {
    requireCondition(isRecord(mapPlan), "invalid_dependency_map", "DependencyMap Plan entry is malformed");
    const directory  = requirePlanDirectory(mapPlan.directory, "invalid_dependency_map");
    requireCondition(!mapByDirectory.has(directory), "invalid_dependency_map", "DependencyMap contains a duplicate Plan directory");
    requireCondition(mapPlan.parent === null || typeof mapPlan.parent === "string", "invalid_dependency_map", "Plan parent is malformed");
    if (mapPlan.parent !== null) {
      requirePlanDirectory(mapPlan.parent, "invalid_dependency_map");
    }
    let bindings: FinalValidationBinding[];
    try {
      bindings = finalValidationBindings(mapPlan);
      acceptedFinalReceiptEntries(mapPlan);
    } catch {
      fail("invalid_dependency_map", "Plan final-validation or receipt bindings are malformed");
    }
    for (const binding of bindings) {
      requireBoundedString(binding.node_id, {
        code: "invalid_dependency_map",
        message: "Plan final-validation checkpoint is missing",
      });
    }
    requireCondition(Array.isArray(mapPlan.children), "invalid_dependency_map", "Plan children must be an array");
    const children = mapPlan.children.map((child) => requirePlanDirectory(child, "invalid_dependency_map"));
    requireCondition(new Set(children).size === children.length, "invalid_graph", "Plan contains a duplicate child reference");
    requireCondition(
      Array.isArray(mapPlan.prerequisite_receipts),
      "invalid_dependency_map",
      "Plan prerequisite receipts must be an array",
    );
    const receiptKeys = mapPlan.prerequisite_receipts.map((receipt) => {
      requireCondition(isRecord(receipt), "invalid_dependency_map", "cross-Plan receipt is malformed");
      const plan  = requirePlanDirectory(receipt.plan, "invalid_dependency_map");
      const nodeId  = requireBoundedString(receipt.node_id, {
        code: "invalid_dependency_map",
        message: "cross-Plan receipt node is missing",
      });
      requireCondition(
        receipt.kind === "contract" || receipt.kind === "final_validation",
        "invalid_dependency_map",
        "cross-Plan receipt kind is invalid",
      );
      let receiptProfiles: PlanProfile[];
      try {
        receiptProfiles = normalizePlanProfiles(receipt.profiles, "invalid");
      } catch {
        fail("invalid_dependency_map", "cross-Plan receipt profiles are invalid");
      }
      return `${plan}\u0000${nodeId}\u0000${receipt.kind}\u0000${receiptProfiles.join(",")}`;
    });
    requireCondition(new Set(receiptKeys).size === receiptKeys.length, "invalid_graph", "Plan contains a duplicate prerequisite receipt");
    mapByDirectory.set(directory, mapPlan);
  }
  requireCondition(
    [...mapByDirectory.keys()].every((directory) => manifestByDirectory.has(directory)),
    "invalid_graph",
    "DependencyMap contains a Plan absent from Manifest",
  );

  for (const [directory, manifestPlan] of manifestByDirectory) {
    if (mapByDirectory.has(directory)) {
      continue;
    }
    const draftNodes  = checkpointCollection.get(directory);
    requireCondition(
      manifestPlan.status === "pending" &&
        Array.isArray(draftNodes) && draftNodes.length > 0 &&
        draftNodes.every((node) => isRecord(node) && node.status === "pending"),
      "invalid_graph",
      "A Manifest-only Plan must remain an entirely pending draft until it is integrated into DependencyMap",
    );
  }

  const planStates = new Map<string, PlanState>();
  const globalNodeMetadata = new Map<string, NodeMetadata>();
  const parentIntegrationNodeIds  = new Set(
    currentDependencyMap.plans.flatMap((plan) =>
      plan.parent_integrations.map((binding) => binding.parent_node_id)),
  );
  for (const [directory] of mapByDirectory) {
    const manifestPlan  = manifestByDirectory.get(directory);
    requireCondition(manifestPlan, "invalid_manifest", "DependencyMap Plan is absent from Manifest");
    const nodes  = checkpointCollection.get(directory);
    requireCondition(Array.isArray(nodes) && nodes.length > 0, "invalid_checkpoints", "Plan checkpoints must be a non-empty array");
    const nodesById = new Map<string, CheckpointNode>();
    const platformPlan  = PLATFORM_PLAN_NAMES.has(path.posix.basename(directory)) ? path.posix.basename(directory) : null;

    for (const [checkpointIndex, node] of nodes.entries()) {
      requireCondition(isRecord(node), "invalid_checkpoints", "checkpoint entry is malformed");
      const nodeId  = requireBoundedString(node.id, { code: "invalid_checkpoints", message: "checkpoint node id is missing" });
      requireCondition(!nodesById.has(nodeId), "invalid_graph", "Plan contains a duplicate checkpoint node id");
      requireCondition(!globalNodeMetadata.has(nodeId), "invalid_graph", "checkpoint node id is not globally unique");
      requireCondition(isCheckpointStatus(node.status), "invalid_graph", "checkpoint status is unknown");
      requireCondition(typeof node.role === "string" && SAFE_ROLE.test(node.role), "invalid_graph", "checkpoint role is malformed");
      requireCondition(isCheckpointPlatform(node.platform), "unknown_platform", "unknown checkpoint platform");
      if (platformPlan !== null) {
        requireCondition(
          node.platform === platformPlan,
          "platform_plan_mismatch",
          "platform-named Plan contains a checkpoint for another platform",
        );
      }
      requireCondition(isRecord(node.commit), "malformed_repository", "checkpoint repository target is missing or malformed");
      const repositoryClass  = classifyRepositoryTarget(node.commit.repository);
      requireCondition(typeof node.commit.repository === "string", "malformed_repository", "checkpoint repository target is missing or malformed");
      const prerequisites  = requireStringArray(
        node.prerequisites,
        "invalid_graph",
        "checkpoint prerequisites must be a string array",
      );
      const next  = requireStringArray(node.next, "invalid_graph", "checkpoint next references must be a string array");
      const normalizedNode: CheckpointNode = {
        ...node,
        id: nodeId,
        status: node.status,
        role: node.role,
        platform: node.platform,
        commit: { ...node.commit, repository: node.commit.repository },
        prerequisites,
        next,
      };
      const metadata: NodeMetadata = {
        node: normalizedNode,
        planDirectory: directory,
        manifestPlan,
        manifestIndex: manifestIndexByDirectory.get(directory)!,
        checkpointIndex,
        repositoryClass,
        profiles: new Set<PlanProfile>(),
      };
      nodesById.set(nodeId, normalizedNode);
      globalNodeMetadata.set(nodeId, metadata);
    }

    const localRoots = [...nodesById.values()].filter((node) => node.prerequisites.length === 0);
    requireCondition(localRoots.length === 1, "invalid_graph", "Plan must have exactly one local root checkpoint");
    planStates.set(directory, { manifestPlan, nodes: [...nodesById.values()], nodesById, implementationRoots: [] });
  }

  const incoming = new Map<string, Set<string>>([...globalNodeMetadata.keys()].map((nodeId) => [nodeId, new Set<string>()]));
  const outgoing = new Map<string, Set<string>>([...globalNodeMetadata.keys()].map((nodeId) => [nodeId, new Set<string>()]));
  const edgeKinds = new Map<string, Set<EdgeKind>>();
  const addEdge = (from: string, to: string, kind: EdgeKind): void => {
    requireCondition(globalNodeMetadata.has(from), "unknown_reference", "checkpoint edge has an unknown source reference");
    requireCondition(globalNodeMetadata.has(to), "unknown_reference", "checkpoint edge has an unknown target reference");
    const edgeKey  = `${from}\u0000${to}`;
    outgoing.get(from)!.add(to);
    incoming.get(to)!.add(from);
    const kinds = edgeKinds.get(edgeKey) ?? new Set<EdgeKind>();
    kinds.add(kind);
    edgeKinds.set(edgeKey, kinds);
  };

  for (const [directory, state] of planStates) {
    for (const node of state.nodes) {
      for (const prerequisite of node.prerequisites) {
        requireCondition(state.nodesById.has(prerequisite), "unknown_reference", "unknown local prerequisite reference");
        const prerequisiteNode = state.nodesById.get(prerequisite);
        requireCondition(prerequisiteNode, "unknown_reference", "unknown local prerequisite reference");
        assertLocalPlatformDirection(prerequisiteNode, node);
        requireCondition(
          prerequisiteNode.next.includes(node.id),
          "invalid_graph",
          "local prerequisite edge is not reciprocal with next",
        );
        addEdge(prerequisite, node.id, "local");
      }
      for (const next of node.next) {
        requireCondition(state.nodesById.has(next), "unknown_reference", "unknown local next reference");
        const nextNode = state.nodesById.get(next);
        requireCondition(nextNode, "unknown_reference", "unknown local next reference");
        requireCondition(
          nextNode.prerequisites.includes(node.id),
          "invalid_graph",
          "local next edge is not reciprocal with prerequisites",
        );
      }
    }

    state.implementationRoots = state.nodes.filter(
      (node) =>
        node.role === "implementation" &&
        node.prerequisites.every((prerequisite) => state.nodesById.get(prerequisite)?.role !== "implementation"),
    );
    requireCondition(state.implementationRoots.length > 0, "invalid_graph", "Plan has no implementation entry checkpoint");

    const mapPlan  = mapByDirectory.get(directory);
    for (const binding of finalValidationBindings(mapPlan)) {
      const finalNode  = state.nodesById.get(binding.node_id);
      requireCondition(finalNode?.role === "final_validation", "unknown_reference", "declared final-validation checkpoint is invalid");
      requireCondition(finalNode.next.length === 0, "invalid_graph", "Plan final-validation checkpoint must be locally terminal");
      const reducesToFinal  = reverseReachableNodes(state, finalNode.id);
      for (const nodeId of reducesToFinal) {
        const metadata  = globalNodeMetadata.get(nodeId);
        if (!metadata || !participatesInPlanFinal(metadata.node, finalNode)) continue;
        for (const profile of binding.profiles) metadata.profiles.add(profile);
      }
    }
    requireCondition(
      state.nodes.filter((node) => node.status !== "skipped" && !parentIntegrationNodeIds.has(node.id))
        .every((node) => (globalNodeMetadata.get(node.id)?.profiles.size ?? 0) > 0),
      "invalid_graph",
      "local checkpoint does not reduce to a declared Plan final-validation checkpoint",
    );
  }

  const rootPlans = currentDependencyMap.plans.filter((plan) => plan.parent === null);
  requireCondition(rootPlans.length === 1, "invalid_graph", "DependencyMap must contain exactly one root Plan");

  for (const [directory, state] of planStates) {
    const mapPlan  = mapByDirectory.get(directory);
    const consumerIndex  = manifestIndexByDirectory.get(directory);
    requireCondition(mapPlan && consumerIndex !== undefined, "invalid_graph", "Plan graph metadata is missing");
    const expectedChildren  = currentDependencyMap.plans
      .filter((candidate) => candidate.parent === directory)
      .map((candidate) => candidate.directory)
      .sort();
    const declaredChildren  = [...mapPlan.children].sort();
    requireCondition(
      JSON.stringify(expectedChildren) === JSON.stringify(declaredChildren),
      "invalid_graph",
      "DependencyMap child list is not reciprocal",
    );

    for (const receipt of mapPlan.prerequisite_receipts) {
      const provider  = mapByDirectory.get(receipt.plan);
      requireCondition(provider, "unknown_reference", "unknown cross-Plan receipt provider reference");
      requireCondition(
        (manifestIndexByDirectory.get(receipt.plan) ?? Number.MAX_SAFE_INTEGER) < consumerIndex,
        "invalid_graph",
        "cross-Plan receipt provider must precede its consumer in Manifest order",
      );
      requireCondition(
        !isAncestor(receipt.plan, directory) && !isAncestor(directory, receipt.plan),
        "invalid_graph",
        "ancestry dependency is incorrectly declared as a cross-Plan receipt",
      );
      const receiptNode = planStates.get(receipt.plan)?.nodesById.get(receipt.node_id);
      requireCondition(receiptNode, "unknown_reference", "unknown cross-Plan receipt node reference");
      const receiptProfiles  = normalizePlanProfiles(receipt.profiles);
      if (receipt.kind === "final_validation") {
        let providerBinding: FinalValidationBinding;
        try {
          providerBinding = finalValidationBinding(provider, receipt.node_id);
        } catch {
          fail("invalid_graph", "final-validation receipt does not identify a provider final checkpoint");
        }
        requireCondition(
          receiptNode.role === "final_validation" &&
            profilesContain(providerBinding.profiles, receiptProfiles),
          "invalid_graph",
          "final-validation receipt profile coverage is invalid",
        );
      } else {
        requireCondition(
          receiptNode.role === "implementation" || receiptNode.role === "architecture_scaffold",
          "invalid_graph",
          "contract receipt does not identify a non-final contract checkpoint",
        );
      }
      requireCondition(
        profilesContain([...(globalNodeMetadata.get(receipt.node_id)?.profiles ?? [])], receiptProfiles),
        "invalid_graph",
        "cross-Plan receipt provider does not cover the declared profiles",
      );
      const applicableRoots = state.implementationRoots.filter((implementationRoot) =>
        receiptProfiles.some((profile) => globalNodeMetadata.get(implementationRoot.id)?.profiles.has(profile)));
      requireCondition(applicableRoots.length > 0, "invalid_graph", "cross-Plan receipt has no applicable consumer");
      for (const implementationRoot of applicableRoots) {
        requireCondition(
          profilesContain([...(globalNodeMetadata.get(implementationRoot.id)?.profiles ?? [])], receiptProfiles),
          "invalid_graph",
          "cross-Plan receipt spans multiple consumer final owners",
        );
        addEdge(receipt.node_id, implementationRoot.id, "cross_plan_prerequisite");
      }
    }

    if (mapPlan.parent === null) {
      requireCondition(
        mapPlan.parent_contract_node_id === null && mapPlan.parent_integrations.length === 0,
        "invalid_graph",
        "root Plan must not declare parent checkpoints",
      );
      continue;
    }

    const parent  = mapByDirectory.get(mapPlan.parent);
    requireCondition(parent, "unknown_reference", "unknown parent Plan reference");
    requireCondition(directParent(directory) === mapPlan.parent, "invalid_graph", "Plan parent is not its direct directory ancestor");
    requireCondition(
      (manifestIndexByDirectory.get(mapPlan.parent) ?? Number.MAX_SAFE_INTEGER) < consumerIndex,
      "invalid_graph",
      "parent Plan must precede its child in Manifest order",
    );
    const parentState = planStates.get(mapPlan.parent);
    requireCondition(parentState, "unknown_reference", "unknown parent Plan state");
    requireCondition(typeof mapPlan.parent_contract_node_id === "string", "unknown_reference", "unknown parent contract checkpoint reference");
    const parentContract = parentState.nodesById.get(mapPlan.parent_contract_node_id);
    requireCondition(parentContract, "unknown_reference", "unknown parent contract checkpoint reference");
    requireCondition(
      parentContract.role === "implementation" || parentContract.role === "architecture_scaffold",
      "invalid_graph",
      "parent contract checkpoint is not a non-final contract",
    );
    for (const binding of finalValidationBindings(mapPlan)) {
      const integrationBinding  = parentIntegrationBinding(mapPlan, binding.node_id);
      requireCondition(integrationBinding, "unknown_reference", "unknown parent integration binding");
      const parentIntegration = parentState.nodesById.get(integrationBinding.parent_node_id);
      const childFinalNode = state.nodesById.get(binding.node_id);
      requireCondition(parentIntegration, "unknown_reference", "unknown parent integration checkpoint reference");
      requireCondition(childFinalNode, "unknown_reference", "unknown child final checkpoint reference");
      const expectedIntegrationRole  = childFinalNode.platform === "any" ? "implementation" : "evidence";
      requireCondition(
        parentIntegration.role === expectedIntegrationRole,
        "invalid_graph",
        "parent integration checkpoint role does not match the child platform scope",
      );
      requireCondition(
        parentIntegration.platform === childFinalNode.platform,
        "platform_integration_mismatch",
        "parent integration checkpoint must remain owned by the child final platform",
      );
      for (const profile of binding.profiles) {
        globalNodeMetadata.get(parentIntegration.id)?.profiles.add(profile);
      }
      requireCondition(
        profilesContain([...(globalNodeMetadata.get(parentIntegration.id)?.profiles ?? [])], binding.profiles),
        "invalid_graph",
        "parent integration checkpoint does not cover the child final profiles",
      );
      requireCondition(
        hasLocalPath(parentState, parentContract.id, parentIntegration.id),
        "invalid_graph",
        "parent contract checkpoint does not precede its child integration checkpoint",
      );
      const applicableRoots = state.implementationRoots.filter((implementationRoot) =>
        binding.profiles.some((profile) => globalNodeMetadata.get(implementationRoot.id)?.profiles.has(profile)));
      for (const implementationRoot of applicableRoots) {
        addEdge(parentContract.id, implementationRoot.id, "parent_contract");
      }
      addEdge(binding.node_id, parentIntegration.id, "parent_integration");
    }
  }

  assertAcyclic(outgoing, incoming);

  requireCondition(
    planStates.size <= MAX_PLAN_COUNT,
    "graph_budget_exceeded",
    "Plan count exceeds the execution eligibility budget",
  );
  requireCondition(
    globalNodeMetadata.size <= MAX_CHECKPOINT_COUNT,
    "graph_budget_exceeded",
    "checkpoint count exceeds the execution eligibility budget",
  );
  requireCondition(
    edgeKinds.size <= MAX_EDGE_COUNT,
    "graph_budget_exceeded",
    "checkpoint edge count exceeds the execution eligibility budget",
  );

  for (const [nodeId, metadata] of globalNodeMetadata) {
    if (metadata.node.status !== "completed") {
      continue;
    }
    requireCondition(
      [...(incoming.get(nodeId) ?? [])].every(
        (dependencyId) => globalNodeMetadata.get(dependencyId)?.node.status === "completed",
      ),
      "invalid_completed_dependency",
      "completed checkpoint has an incomplete incoming dependency",
    );
  }

  const receiptValidatedFinals = new Set<string>();
  const requireAcceptedFinalReceipt = (directory: string, finalNodeId: string): void => {
    const key  = `${directory}\u0000${finalNodeId}`;
    if (receiptValidatedFinals.has(key)) {
      return;
    }
    const mapPlan  = mapByDirectory.get(directory);
    requireCondition(mapPlan, "unknown_reference", "unknown receipt Plan");
    const finalBinding = finalValidationBinding(mapPlan, finalNodeId);
    const finalNode = planStates.get(directory)?.nodesById.get(finalNodeId);
    requireCondition(finalNode, "unknown_reference", "unknown receipt final node");
    requireCondition(
      finalNode.status === "completed",
      "invalid_final_receipt",
      "accepted final receipt provider checkpoint is incomplete",
    );
    assertAcceptedFinalReceipt(mapPlan, finalNode, finalBinding);
    receiptValidatedFinals.add(key);
  };

  for (const [directory, mapPlan] of mapByDirectory) {
    for (const { binding, receipt } of acceptedFinalReceiptEntries(mapPlan)) {
      const finalNode = planStates.get(directory)?.nodesById.get(binding.node_id);
      requireCondition(finalNode, "unknown_reference", "accepted receipt final node is missing");
      requireCondition(
        finalNode.status === "completed" || receipt === undefined,
        "invalid_final_receipt",
        "incomplete Plan retains an accepted final receipt",
      );
    }
  }

  const eligible: EligibleNodeProjection[] = [];
  const deferred: PlanExecutionEvaluation["deferred"] = [];
  const deferredReasonCounts: Record<string, number> = {
    repository_mismatch: 0,
    platform_mismatch: 0,
    incomplete_dependencies: 0,
    invalid_receipt: 0,
  };
  let candidateCount  = 0;

  for (const metadata of globalNodeMetadata.values()) {
    if (!ELIGIBLE_STATUSES.has(metadata.node.status)) {
      continue;
    }
    if (selectedProfile && !metadata.profiles.has(selectedProfile)) {
      continue;
    }
    candidateCount += 1;
    const reasons: string[] = [];
    if (metadata.repositoryClass !== "core") {
      reasons.push("repository_mismatch");
    }
    if (metadata.node.platform !== "any" && metadata.node.platform !== normalizedHostPlatform) {
      reasons.push("platform_mismatch");
    }
    const incompleteDependencyCount = [...(incoming.get(metadata.node.id) ?? [])].filter(
      (dependencyId) => globalNodeMetadata.get(dependencyId)?.node.status !== "completed",
    ).length;
    if (incompleteDependencyCount > 0) {
      reasons.push("incomplete_dependencies");
    }
    if (requireAcceptedFinalReceipts && reasons.length === 0) {
      try {
        for (const dependencyId of incoming.get(metadata.node.id) ?? []) {
          const dependency  = globalNodeMetadata.get(dependencyId);
          requireCondition(dependency, "unknown_reference", "execution dependency is missing");
          if (dependency.node.role === "final_validation") {
            requireAcceptedFinalReceipt(dependency.planDirectory, dependency.node.id);
          }
        }
      } catch (error ) {
        if (!(error instanceof PlanExecutionPolicyError) || error.code !== "invalid_final_receipt") {
          throw error;
        }
        reasons.push("invalid_receipt");
      }
    }

    const projection  = nodeProjection(metadata, incoming);
    if (reasons.length === 0) {
      eligible.push(projection);
      continue;
    }
    for (const reason of reasons) {
      deferredReasonCounts[reason] += 1;
    }
    deferred.push({ ...projection, reasons, incompleteDependencyCount });
  }

  eligible.sort(compareEligible);

  return {
    hostPlatform: normalizedHostPlatform,
    selectedProfile: selectedProfile ?? null,
    candidateCount,
    eligible,
    deferred,
    deferredReasonCounts,
    graph: {
      planCount: planStates.size,
      nodeCount: globalNodeMetadata.size,
      edgeCount: edgeKinds.size,
    },
  };
}

export async function loadPlanExecutionInputs({ repoRoot = defaultRepoRoot, planRoot }: {
  repoRoot?: string; planRoot?: string;
} = {}): Promise<PlanExecutionInputs> {
  const resolvedRepoRoot  = path.resolve(repoRoot);
  const resolvedPlanRoot  = path.resolve(planRoot ?? path.join(resolvedRepoRoot, "docs", "plans"));
  const generationWorker  = process.env.MESHRIX_ACCEPTANCE_GENERATION_WORKER === "1";
  const gitRepoRoot  = generationWorker ? resolveGitRepoRoot(resolvedRepoRoot) : resolvedRepoRoot;
  const [canonicalPlanRoot, packageText, gitStat] = await Promise.all([
    fs.realpath(resolvedPlanRoot),
    fs.readFile(path.join(resolvedRepoRoot, "package.json"), "utf8"),
    fs.stat(path.join(gitRepoRoot, ".git")),
  ]);
  const gitTopLevelResult  = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: gitRepoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assertRepositoryIdentity({
    repoRoot: resolvedRepoRoot,
    gitTopLevel: generationWorker
      ? resolvedRepoRoot
      : gitTopLevelResult.status === 0 ? gitTopLevelResult.stdout.trim() : "",
    planRoot: canonicalPlanRoot,
    packageManifest: JSON.parse(packageText),
    gitMarkerPresent: generationWorker || gitStat.isDirectory() || gitStat.isFile(),
  });
  const manifestPath  = path.join(resolvedPlanRoot, "Manifest.json");
  const dependencyMapPath  = path.join(resolvedPlanRoot, "end-to-end-release", "DependencyMap.json");
  const [manifestText, dependencyMapText] = await Promise.all([
    fs.readFile(manifestPath, "utf8"),
    fs.readFile(dependencyMapPath, "utf8"),
  ]);
  const manifest: unknown = JSON.parse(manifestText);
  const dependencyMap = assertCurrentDependencyMapShape(JSON.parse(dependencyMapText));
  requireCondition(Array.isArray(manifest), "invalid_manifest", "Manifest must be an array");

  const checkpoints = new Map<string, CheckpointNode[]>();
  await Promise.all(
    manifest.map(async (manifestPlan: unknown) => {
      requireCondition(isRecord(manifestPlan) && typeof manifestPlan.directory === "string" && typeof manifestPlan.checkpoints === "string", "invalid_manifest", "Manifest Plan entry is malformed");
      const directory  = requirePlanDirectory(manifestPlan.directory);
      const expectedCheckpointPath  = `${directory}/Checkpoints.json`;
      requireCondition(
        manifestPlan.checkpoints === expectedCheckpointPath,
        "invalid_manifest",
        "Manifest checkpoint path does not match its Plan directory",
      );
      const checkpointPath  = path.resolve(resolvedPlanRoot, expectedCheckpointPath);
      requireCondition(
        checkpointPath.startsWith(`${resolvedPlanRoot}${path.sep}`),
        "invalid_manifest",
        "Manifest checkpoint path escapes the plan root",
      );
      const parsedCheckpoints: unknown = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
      requireCondition(Array.isArray(parsedCheckpoints) && parsedCheckpoints.every(isCheckpointNode), "invalid_checkpoints", "checkpoint collection is malformed");
      checkpoints.set(directory, parsedCheckpoints);
    }),
  );

  const typedManifest = manifest.map((entry) => {
    requireCondition(isRecord(entry) && typeof entry.directory === "string" && typeof entry.checkpoints === "string", "invalid_manifest", "Manifest Plan entry is malformed");
    return { ...entry, directory: entry.directory, checkpoints: entry.checkpoints };
  });
  return { manifest: typedManifest, dependencyMap, checkpoints };
}

export function assertRepositoryIdentity({ repoRoot, gitTopLevel, planRoot, packageManifest, gitMarkerPresent }: {
  repoRoot?: string; gitTopLevel?: string; planRoot?: string; packageManifest?: unknown; gitMarkerPresent?: boolean;
} = {}): void {
  const resolvedRepoRoot  = path.resolve(repoRoot ?? "");
  requireCondition(
    gitMarkerPresent === true && path.resolve(gitTopLevel ?? "") === resolvedRepoRoot,
    "repository_identity_mismatch",
    "repository root is not the current Git top-level",
  );
  requireCondition(
    isRecord(packageManifest) && packageManifest.name === "meshrix.js",
    "repository_identity_mismatch",
    "repository root is not the Meshrix.js Core package",
  );
  requireCondition(
    path.resolve(planRoot ?? "") === path.join(resolvedRepoRoot, "docs", "plans"),
    "repository_identity_mismatch",
    "plan root is not the canonical Core Plan root",
  );
}

export const evaluatePlanExecutionAdmission  = evaluatePlanExecutionEligibility;
