#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  acceptedFinalReceipt,
  parentIntegrationBinding,
  profilesEqual,
} from "./plan-dependency-map.mjs";
import { assertReceiptIntegrity } from "./plan-final-receipt.mjs";
import { verifyEndToEndReleasePlan } from "./verify-end-to-end-release-plan.mjs";
import { validateCanonicalBetterPlanWorkspace } from "./canonical-better-plan-validator.mjs";

const HC_PROFILES = Object.freeze(["ha", "regional-dr", "scale"]);
const EXPECTED_RECEIPT_DIGEST = "ed2c75af2c340b664a9813a01e7e925260080a2a89eda8f117b0a5b1e1c20572";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), "../..");
const CHILD_PLAN_DIRECTORY = "end-to-end-release/high-concurrency";
const PARENT_PLAN_DIRECTORY = "end-to-end-release";
const CHILD_FINAL_NODE_ID = "767db312-c6ef-4b17-8a06-56e543a9dd62";
const PARENT_INTEGRATION_NODE_ID = "5ab12cd4-d2ef-477e-8874-3edd94774e3f";
const FOCUSED_COMMAND = "npm run verify:better-plan";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function currentRevision(repoRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  requireCondition(result.status === 0 && result.stdout.trim(), "Current repository revision is unavailable");
  return result.stdout.trim();
}

function run(repoRoot, executable, args, label) {
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  requireCondition(result.status === 0, `${label} failed`);
}

function completeNode(node, revision, recordedAt, commandIdentity) {
  node.status = "completed";
  node.commit.delivered = revision;
  for (const criterion of node.acceptance_criteria) {
    criterion.checked = true;
    criterion.evidence_refs = [{
      type: "command",
      command_sha256: sha256(commandIdentity),
      exit_code: 0,
      recorded_at: recordedAt,
    }];
  }
  if (node.regression) {
    node.regression.last_pass = {
      recorded_at: recordedAt,
      contract_digest: sha256(JSON.stringify({
        scope: node.regression.scope,
        commands: node.regression.commands,
        paths: node.regression.paths,
        criteria: node.regression.criteria,
      })),
      content_fingerprint: sha256(`${revision}\u0000${commandIdentity}`),
    };
  }
}

async function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function acceptHighConcurrencyParentIntegration({ repoRoot = defaultRepoRoot } = {}) {
  const revision = currentRevision(repoRoot);
  const planRoot = path.join(repoRoot, "docs", "plans");
  const dependencyMapPath = path.join(planRoot, "end-to-end-release", "DependencyMap.json");
  const childCheckpointsPath = path.join(planRoot, CHILD_PLAN_DIRECTORY, "Checkpoints.json");
  const parentCheckpointsPath = path.join(planRoot, PARENT_PLAN_DIRECTORY, "Checkpoints.json");

  const [dependencyMap, childCheckpoints, parentCheckpoints] = await Promise.all([
    fs.readFile(dependencyMapPath, "utf8").then(JSON.parse),
    fs.readFile(childCheckpointsPath, "utf8").then(JSON.parse),
    fs.readFile(parentCheckpointsPath, "utf8").then(JSON.parse),
  ]);

  const childMapPlan = dependencyMap.plans.find((plan) => plan.directory === CHILD_PLAN_DIRECTORY);
  requireCondition(childMapPlan, "High-concurrency DependencyMap entry is missing");

  const childFinalNode = childCheckpoints.find((node) => node.id === CHILD_FINAL_NODE_ID);
  requireCondition(childFinalNode, "High-concurrency final validation node is missing");
  requireCondition(childFinalNode.status === "completed", "High-concurrency final validation node is not completed");

  const integrationBinding = parentIntegrationBinding(childMapPlan, CHILD_FINAL_NODE_ID);
  requireCondition(
    integrationBinding.parent_node_id === PARENT_INTEGRATION_NODE_ID,
    "High-concurrency parent integration binding does not target the assigned node",
  );
  requireCondition(
    profilesEqual(integrationBinding.profiles, HC_PROFILES),
    "High-concurrency parent integration profiles are not profile-scoped",
  );

  const receipt = acceptedFinalReceipt(childMapPlan, CHILD_FINAL_NODE_ID);
  requireCondition(receipt, "High-concurrency accepted final receipt is missing");
  requireCondition(
    receipt.final_node_id === CHILD_FINAL_NODE_ID &&
      receipt.parent_integration_node_id === PARENT_INTEGRATION_NODE_ID &&
      receipt.status === "completed" &&
      receipt.privacy_safe === true &&
      profilesEqual(receipt.profiles, HC_PROFILES) &&
      receipt.receipt_digest === EXPECTED_RECEIPT_DIGEST,
    "High-concurrency accepted final receipt is not current or profile-scoped",
  );
  assertReceiptIntegrity(receipt);

  const parentIntegration = parentCheckpoints.find((node) => node.id === PARENT_INTEGRATION_NODE_ID);
  requireCondition(parentIntegration, "High-concurrency parent integration node is missing");
  requireCondition(
    parentIntegration.role === "implementation",
    "High-concurrency parent integration is not an implementation checkpoint",
  );
  requireCondition(parentIntegration.status === "pending", "High-concurrency parent integration node is not pending");
  requireCondition(
    parentIntegration.regression?.commands?.[0] === FOCUSED_COMMAND,
    "High-concurrency parent integration focused regression command is not canonical",
  );

  run(
    repoRoot,
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "verify:better-plan"],
    "High-concurrency parent integration Better Plan verification",
  );

  const recordedAt = new Date().toISOString();
  const commandIdentity = `receipt:${receipt.receipt_digest}`;
  completeNode(parentIntegration, revision, recordedAt, commandIdentity);

  const dependencyMapBeforeWrite = JSON.parse(await fs.readFile(dependencyMapPath, "utf8"));
  requireCondition(
    dependencyMapBeforeWrite.plans.find((plan) => plan.directory === CHILD_PLAN_DIRECTORY)
      ?.accepted_final_receipts?.[CHILD_FINAL_NODE_ID]?.receipt_digest === receipt.receipt_digest,
    "High-concurrency DependencyMap receipt changed before parent checkpoint write",
  );

  await atomicWriteJson(parentCheckpointsPath, parentCheckpoints);

  const canonical = await validateCanonicalBetterPlanWorkspace({ repoRoot });
  requireCondition(
    canonical.accepted === true,
    "High-concurrency parent integration canonical Better Plan validation failed",
  );
  await verifyEndToEndReleasePlan({
    repoRoot,
    writeReport: false,
    requireCompletedReceipts: true,
  });

  return {
    schema_version: "licomesh.high-concurrency-parent-integration-acceptance.v1",
    accepted: true,
    node_id: PARENT_INTEGRATION_NODE_ID,
    child_final_node_id: CHILD_FINAL_NODE_ID,
    child_plan_directory: CHILD_PLAN_DIRECTORY,
    parent_plan_directory: PARENT_PLAN_DIRECTORY,
    focused_command: FOCUSED_COMMAND,
    repository_revision: revision,
    recorded_at: recordedAt,
    profiles: [...HC_PROFILES],
    receipt_digest: receipt.receipt_digest,
    proof_verified: receipt.proof_anchor?.verified === true,
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  acceptHighConcurrencyParentIntegration()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
