#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PlanExecutionPolicyError,
  evaluatePlanExecutionEligibility,
  loadPlanExecutionInputs,
} from "./plan-execution-eligibility.mjs";
import { verifyEndToEndReleasePlan } from "./verify-end-to-end-release-plan.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(modulePath), "../..");
const OUTPUT_SCHEMA = "licomesh.plan-execution-selection.v1";
const CLOSURE_DECLARATION = /^Scope:\s+Closure:\s+(?:capability|module|scenario)\s+-\s+[^;]+;/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkpointEntries(checkpoints) {
  return checkpoints instanceof Map ? [...checkpoints.entries()] : Object.entries(checkpoints ?? {});
}

function selectedCheckpoint(selected, checkpoints) {
  const nodes = checkpointEntries(checkpoints).find(([directory]) => directory === selected.planDirectory)?.[1];
  return Array.isArray(nodes) ? nodes.find((node) => node.id === selected.nodeId) : undefined;
}

function uniqueNonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0) &&
    new Set(value).size === value.length;
}

function validRegressionPaths(value) {
  if (!uniqueNonEmptyStrings(value)) {
    return false;
  }
  const normalized = value.map((entry) => path.posix.normalize(entry));
  if (normalized.some((entry, index) =>
    entry !== value[index] || entry === "." || entry === ".." || entry.startsWith("../") ||
    entry.startsWith("/") || entry.includes("\\") || /[\u0000-\u001f\u007f]/u.test(entry))) {
    return false;
  }
  return normalized.every((entry, index) => normalized.every((other, otherIndex) =>
    index === otherIndex || (!entry.startsWith(`${other}/`) && !other.startsWith(`${entry}/`))));
}

export function assertSelectionContract(selected, checkpoints) {
  if (!selected) {
    throw new PlanExecutionPolicyError("no_eligible_node", "no checkpoint is eligible on the current host");
  }
  const checkpoint = selectedCheckpoint(selected, checkpoints);
  if (!checkpoint) {
    throw new PlanExecutionPolicyError("invalid_selection", "selected checkpoint is absent from the loaded Plan inputs");
  }
  if (checkpoint.role !== "implementation" && checkpoint.role !== "final_validation") {
    return;
  }
  const closureCount = typeof checkpoint.description === "string"
    ? checkpoint.description.split("Closure:").length - 1
    : 0;
  if (!CLOSURE_DECLARATION.test(checkpoint.description ?? "") || closureCount !== 1) {
    throw new PlanExecutionPolicyError(
      "missing_closure_contract",
      "selected checkpoint must declare exactly one capability, module, or scenario Closure scope",
    );
  }
  const expectedScope = checkpoint.role === "implementation" ? "focused" : "full";
  const regression = checkpoint.regression;
  const criteria = regression?.criteria;
  const acceptanceCriteria = checkpoint.acceptance_criteria;
  const validCriteria = Array.isArray(criteria) && criteria.length > 0 &&
    new Set(criteria).size === criteria.length &&
    Array.isArray(acceptanceCriteria) &&
    criteria.every((index) => Number.isInteger(index) && index >= 0 && index < acceptanceCriteria.length);
  if (!isRecord(regression) || regression.scope !== expectedScope ||
      !uniqueNonEmptyStrings(regression.commands) || !validRegressionPaths(regression.paths) || !validCriteria) {
    throw new PlanExecutionPolicyError(
      "invalid_regression_contract",
      `selected ${checkpoint.role} checkpoint must declare a ${expectedScope} regression contract`,
    );
  }
}

function selectedNodeProjection(node) {
  if (!node) {
    return null;
  }
  return {
    plan_directory: node.planDirectory,
    node_id: node.nodeId,
    status: node.status,
    role: node.role,
    platform: node.platform,
  };
}

export function boundedSelectionOutput(evaluation, checkpoints) {
  if (evaluation.eligible.length === 0 && evaluation.deferredReasonCounts.invalid_receipt > 0) {
    throw new PlanExecutionPolicyError(
      "planning_repair_required",
      "eligible execution is waiting for a valid prerequisite Plan receipt",
    );
  }
  assertSelectionContract(evaluation.eligible[0], checkpoints);
  return {
    schema_version: OUTPUT_SCHEMA,
    accepted: true,
    host_platform: evaluation.hostPlatform,
    selected: selectedNodeProjection(evaluation.eligible[0]),
    candidate_count: evaluation.candidateCount,
    eligible_count: evaluation.eligible.length,
    deferred_count: evaluation.deferred.length,
    deferred_reason_counts: { ...evaluation.deferredReasonCounts },
  };
}

export async function selectNextPlanNode({
  selectedRepoRoot = repoRoot,
  verifyPlan = verifyEndToEndReleasePlan,
  loadInputs = loadPlanExecutionInputs,
} = {}) {
  try {
    await verifyPlan({
      repoRoot: selectedRepoRoot,
      writeReport: false,
      requireCompletedReceipts: false,
    });
  } catch {
    throw new PlanExecutionPolicyError(
      "planning_repair_required",
      "the authoritative Plan structure requires native-main repair",
    );
  }
  const inputs = await loadInputs({ repoRoot: selectedRepoRoot });
  return boundedSelectionOutput(evaluatePlanExecutionEligibility({
    ...inputs,
    hostPlatform: process.platform,
  }), inputs.checkpoints);
}

export function boundedSelectionError(error) {
  return {
    schema_version: OUTPUT_SCHEMA,
    accepted: false,
    error_code: error instanceof PlanExecutionPolicyError ? error.code : "invalid_policy_input",
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) {
    throw new PlanExecutionPolicyError("unsupported_arguments", "plan selection accepts no platform or path overrides");
  }
  process.stdout.write(`${JSON.stringify(await selectNextPlanNode())}\n`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(boundedSelectionError(error))}\n`);
    process.exitCode = 1;
  });
}
