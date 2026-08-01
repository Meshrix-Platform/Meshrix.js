#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PlanExecutionPolicyError,
  evaluatePlanExecutionEligibility,
  loadPlanExecutionInputs,
} from "./plan-execution-eligibility.ts";
import { verifyBetterPlan } from "../server-scripts/verify-better-plan.ts";

const modulePath: any = fileURLToPath(import.meta.url);
const repoRoot: any = path.resolve(path.dirname(modulePath), "../..");
const OUTPUT_SCHEMA: any = "v0.0.1:meshrix:plan-execution-selection-1";
const CLOSURE_DECLARATION: any = /^Scope:\s+Closure:\s+(?:capability|module|scenario)\s+-\s+[^;]+;/u;

function isRecord(value?: any) : any {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkpointEntries(checkpoints?: any) : any {
  return checkpoints instanceof Map ? [...checkpoints.entries()] : (Object.entries(checkpoints ?? {}) as [string, any][]);
}

function selectedCheckpoint(selected?: any, checkpoints?: any) : any {
  const nodes: any = checkpointEntries(checkpoints).find(([directory]: any[]) : any => directory === selected.planDirectory)?.[1];
  return Array.isArray(nodes) ? nodes.find((node?: any) : any => node.id === selected.nodeId) : undefined;
}

function uniqueNonEmptyStrings(value?: any) : any {
  return Array.isArray(value) && value.length > 0 &&
    value.every((entry?: any) : any => typeof entry === "string" && entry.length > 0) &&
    new Set<any>(value).size === value.length;
}

function validRegressionPaths(value?: any) : any {
  if (!uniqueNonEmptyStrings(value)) {
    return false;
  }
  const normalized: any = value.map((entry?: any) : any => path.posix.normalize(entry));
  if (normalized.some((entry?: any, index?: any) : any =>
    entry !== value[index] || entry === "." || entry === ".." || entry.startsWith("../") ||
    entry.startsWith("/") || entry.includes("\\") || /[\u0000-\u001f\u007f]/u.test(entry))) {
    return false;
  }
  return normalized.every((entry?: any, index?: any) : any => normalized.every((other?: any, otherIndex?: any) : any =>
    index === otherIndex || (!entry.startsWith(`${other}/`) && !other.startsWith(`${entry}/`))));
}

export function assertSelectionContract(selected?: any, checkpoints?: any) : any {
  if (!selected) {
    throw new PlanExecutionPolicyError("no_eligible_node", "no checkpoint is eligible on the current host");
  }
  const checkpoint: any = selectedCheckpoint(selected, checkpoints);
  if (!checkpoint) {
    throw new PlanExecutionPolicyError("invalid_selection", "selected checkpoint is absent from the loaded Plan inputs");
  }
  if (checkpoint.role !== "implementation" && checkpoint.role !== "final_validation") {
    return;
  }
  const closureCount: any = typeof checkpoint.description === "string"
    ? checkpoint.description.split("Closure:").length - 1
    : 0;
  if (!CLOSURE_DECLARATION.test(checkpoint.description ?? "") || closureCount !== 1) {
    throw new PlanExecutionPolicyError(
      "missing_closure_contract",
      "selected checkpoint must declare exactly one capability, module, or scenario Closure scope",
    );
  }
  const expectedScope: any = checkpoint.role === "implementation" ? "focused" : "full";
  const regression: any = checkpoint.regression;
  const criteria: any = regression?.criteria;
  const acceptanceCriteria: any = checkpoint.acceptance_criteria;
  const validCriteria: any = Array.isArray(criteria) && criteria.length > 0 &&
    new Set<any>(criteria).size === criteria.length &&
    Array.isArray(acceptanceCriteria) &&
    criteria.every((index?: any) : any => Number.isInteger(index) && index >= 0 && index < acceptanceCriteria.length);
  if (!isRecord(regression) || regression.scope !== expectedScope ||
      !uniqueNonEmptyStrings(regression.commands) || !validRegressionPaths(regression.paths) || !validCriteria) {
    throw new PlanExecutionPolicyError(
      "invalid_regression_contract",
      `selected ${checkpoint.role} checkpoint must declare a ${expectedScope} regression contract`,
    );
  }
}

function selectedNodeProjection(node?: any) : any {
  if (!node) {
    return null;
  }
  return {
    plan_directory: node.planDirectory,
    node_id: node.nodeId,
    status: node.status,
    role: node.role,
    platform: node.platform,
    profiles: [...node.profiles],
  };
}

export function boundedSelectionOutput(evaluation?: any, checkpoints?: any) : any {
  if (evaluation.eligible.length === 0 && evaluation.deferredReasonCounts.invalid_receipt > 0) {
    throw new PlanExecutionPolicyError(
      "planning_repair_required",
      "eligible execution is waiting for a valid prerequisite Plan receipt",
    );
  }
  const selected: any = evaluation.eligible[0];
  if (!evaluation.selectedProfile && selected && selected.profiles.length === 1) {
    const candidateProfiles: any = new Set<any>(
      evaluation.eligible.flatMap((candidate?: any) : any => candidate.profiles),
    );
    if (candidateProfiles.size > 1) {
      throw new PlanExecutionPolicyError(
        "profile_selection_required",
        "multiple profile-specific checkpoints are eligible",
      );
    }
  }
  assertSelectionContract(selected, checkpoints);
  return {
    schema_version: OUTPUT_SCHEMA,
    accepted: true,
    host_platform: evaluation.hostPlatform,
    profile: evaluation.selectedProfile,
    selected: selectedNodeProjection(selected),
    candidate_count: evaluation.candidateCount,
    eligible_count: evaluation.eligible.length,
    deferred_count: evaluation.deferred.length,
    deferred_reason_counts: { ...evaluation.deferredReasonCounts },
  };
}

export async function selectNextPlanNode({
  selectedRepoRoot = repoRoot,
  selectedProfile,
  verifyPlan = verifyBetterPlan,
  loadInputs = loadPlanExecutionInputs,
}: Record<string, any> = {}) : Promise<any> {
  try {
    await verifyPlan({
      repoRoot: selectedRepoRoot,
      writeReport: false,
      requireCompletedReceipts: true,
    });
  } catch {
    throw new PlanExecutionPolicyError(
      "planning_repair_required",
      "the authoritative Plan structure requires native-main repair",
    );
  }
  const inputs: any = await loadInputs({ repoRoot: selectedRepoRoot });
  return boundedSelectionOutput(evaluatePlanExecutionEligibility({
    ...inputs,
    hostPlatform: process.platform,
    selectedProfile,
  }), inputs.checkpoints);
}

export function boundedSelectionError(error?: any) : any {
  return {
    schema_version: OUTPUT_SCHEMA,
    accepted: false,
    error_code: error instanceof PlanExecutionPolicyError ? error.code : "invalid_policy_input",
  };
}

async function main(argv: any = process.argv.slice(2)) : Promise<any> {
  let selectedProfile: any;
  for (let index: any = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--profile" || selectedProfile || !argv[index + 1]) {
      throw new PlanExecutionPolicyError("unsupported_arguments", "plan selection accepts only one --profile value");
    }
    selectedProfile = argv[index + 1];
    index += 1;
  }
  process.stdout.write(`${JSON.stringify(await selectNextPlanNode({ selectedProfile }))}\n`);
}

const isDirectRun: any = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  main().catch((error?: any) : any => {
    process.stderr.write(`${JSON.stringify(boundedSelectionError(error))}\n`);
    process.exitCode = 1;
  });
}
