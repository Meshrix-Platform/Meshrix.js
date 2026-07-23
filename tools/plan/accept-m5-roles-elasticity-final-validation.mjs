#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { reduceEndToEndReleaseReceipt } from "./reduce-end-to-end-release-receipt.mjs";
import { verifyEndToEndReleasePlan } from "./verify-end-to-end-release-plan.mjs";
import { validateCanonicalBetterPlanWorkspace } from "./canonical-better-plan-validator.mjs";

const M5_PROFILES = Object.freeze(["ha", "regional-dr", "scale"]);

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), "../..");
const PLAN_DIRECTORY = "end-to-end-release/high-concurrency/m5-roles-elasticity";
const IMPLEMENTATION_NODE_ID = "756d99b0-2d60-45f5-87d4-216d57eb9bde";
const FINAL_NODE_ID = "d33e7e07-77a9-458f-a748-60b286d2c1ff";
const FINAL_COMMAND = "npm run verify:better-plan";

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

export async function acceptM5RolesElasticityFinalValidation({ repoRoot = defaultRepoRoot } = {}) {
  const revision = currentRevision(repoRoot);
  const planRoot = path.join(repoRoot, "docs", "plans");
  const checkpointsPath = path.join(planRoot, PLAN_DIRECTORY, "Checkpoints.json");
  const manifestPath = path.join(planRoot, "Manifest.json");
  const [checkpoints, manifest] = await Promise.all([
    fs.readFile(checkpointsPath, "utf8").then(JSON.parse),
    fs.readFile(manifestPath, "utf8").then(JSON.parse),
  ]);

  const implementationNode = checkpoints.find((node) => node.id === IMPLEMENTATION_NODE_ID);
  requireCondition(implementationNode, "M5 Runtime Roles And Elasticity implementation node is missing");
  requireCondition(implementationNode.status === "completed", "M5 implementation node is not completed");

  const finalNode = checkpoints.find((node) => node.id === FINAL_NODE_ID);
  requireCondition(finalNode, "M5 Runtime Roles And Elasticity final validation node is missing");
  requireCondition(finalNode.role === "final_validation", "M5 node is not a final validation checkpoint");
  requireCondition(finalNode.status === "pending", "M5 final validation node is not pending");
  requireCondition(
    finalNode.regression?.commands?.[0] === FINAL_COMMAND,
    "M5 final regression command is not canonical",
  );

  run(
    repoRoot,
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "verify:better-plan"],
    "M5 Runtime Roles And Elasticity Better Plan verification",
  );

  const recordedAt = new Date().toISOString();
  completeNode(finalNode, revision, recordedAt, FINAL_COMMAND);

  const manifestPlan = manifest.find((plan) => plan.directory === PLAN_DIRECTORY);
  requireCondition(manifestPlan, "M5 Manifest entry is missing");
  manifestPlan.status = "completed";

  await Promise.all([
    atomicWriteJson(checkpointsPath, checkpoints),
    atomicWriteJson(manifestPath, manifest),
  ]);

  const canonical = await validateCanonicalBetterPlanWorkspace({ repoRoot });
  requireCondition(canonical.accepted === true, "M5 canonical Better Plan validation failed");
  await verifyEndToEndReleasePlan({
    repoRoot,
    writeReport: false,
    requireCompletedReceipts: false,
  });

  const receipt = await reduceEndToEndReleaseReceipt({
    repoRoot,
    planDirectory: PLAN_DIRECTORY,
    finalNodeId: FINAL_NODE_ID,
    write: true,
  });

  await verifyEndToEndReleasePlan({
    repoRoot,
    writeReport: false,
    requireCompletedReceipts: true,
  });

  return {
    schema_version: "licomesh.m5-roles-elasticity-final-validation-acceptance.v1",
    accepted: true,
    node_id: FINAL_NODE_ID,
    plan_directory: PLAN_DIRECTORY,
    final_command: FINAL_COMMAND,
    repository_revision: revision,
    recorded_at: recordedAt,
    profiles: [...M5_PROFILES],
    receipt_digest: receipt.receipt_digest,
    proof_verified: receipt.proof_anchor?.verified === true,
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  acceptM5RolesElasticityFinalValidation()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
