#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { reduceEndToEndReleaseReceipt } from "./reduce-end-to-end-release-receipt.mjs";
import { verifyEndToEndReleasePlan } from "./verify-end-to-end-release-plan.mjs";
import { validateCanonicalBetterPlanWorkspace } from "./canonical-better-plan-validator.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), "../..");
const BASELINE_DIRECTORY = "end-to-end-release/current-baseline";

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

export async function acceptCurrentBaseline({ repoRoot = defaultRepoRoot } = {}) {
  const revision = currentRevision(repoRoot);
  const planRoot = path.join(repoRoot, "docs", "plans");
  const checkpointsPath = path.join(planRoot, BASELINE_DIRECTORY, "Checkpoints.json");
  const manifestPath = path.join(planRoot, "Manifest.json");
  const [checkpoints, manifest] = await Promise.all([
    fs.readFile(checkpointsPath, "utf8").then(JSON.parse),
    fs.readFile(manifestPath, "utf8").then(JSON.parse),
  ]);
  const implementationNodes = checkpoints.filter((node) => node.role === "implementation");
  const finalNodes = checkpoints.filter((node) => node.role === "final_validation");
  requireCondition(implementationNodes.length === 11, "Current Baseline must contain exactly eleven capability checks");
  requireCondition(finalNodes.length === 1, "Current Baseline must contain exactly one final validation");
  requireCondition(
    implementationNodes.every((node) =>
      node.status === "pending" &&
      node.regression?.commands?.length === 1 &&
      /^npx vitest run tests\/vitest\/server\/[A-Za-z0-9._-]+\.test\.(?:mjs|ts)$/u
        .test(node.regression.commands[0])),
    "Current Baseline focused commands are not canonical",
  );
  const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  for (const node of implementationNodes) {
    const testPath = node.regression.commands[0].slice("npx vitest run ".length);
    run(repoRoot, process.execPath, [vitestEntry, "run", testPath], `Current Baseline ${testPath}`);
    completeNode(node, revision, new Date().toISOString(), node.regression.commands[0]);
  }

  const finalNode = finalNodes[0];
  requireCondition(finalNode.status === "pending", "Current Baseline final is not pending");
  run(
    repoRoot,
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["test"],
    "Current Baseline complete Core regression",
  );
  completeNode(finalNode, revision, new Date().toISOString(), "npm test");

  const manifestPlan = manifest.find((plan) => plan.directory === BASELINE_DIRECTORY);
  requireCondition(manifestPlan, "Current Baseline Manifest entry is missing");
  manifestPlan.status = "completed";
  await Promise.all([
    atomicWriteJson(checkpointsPath, checkpoints),
    atomicWriteJson(manifestPath, manifest),
  ]);

  const canonical = await validateCanonicalBetterPlanWorkspace({ repoRoot });
  requireCondition(canonical.accepted === true, "Current Baseline canonical Better Plan validation failed");
  await verifyEndToEndReleasePlan({
    repoRoot,
    writeReport: false,
    requireCompletedReceipts: false,
  });
  const receipt = await reduceEndToEndReleaseReceipt({
    repoRoot,
    planDirectory: BASELINE_DIRECTORY,
    planProfile: "local",
    write: true,
  });
  const dependencyMapPath = path.join(planRoot, "end-to-end-release", "DependencyMap.json");
  const dependencyMap = JSON.parse(await fs.readFile(dependencyMapPath, "utf8"));
  const baselineBinding = dependencyMap.plans
    .find((plan) => plan.directory === BASELINE_DIRECTORY)
    ?.parent_integrations
    ?.find((binding) => binding.child_final_node_id === finalNode.id);
  requireCondition(baselineBinding?.parent_node_id, "Current Baseline parent integration binding is missing");
  const rootCheckpointsPath = path.join(planRoot, "end-to-end-release", "Checkpoints.json");
  const rootCheckpoints = JSON.parse(await fs.readFile(rootCheckpointsPath, "utf8"));
  const parentIntegration = rootCheckpoints.find((node) => node.id === baselineBinding.parent_node_id);
  requireCondition(parentIntegration?.status === "pending", "Current Baseline parent integration is not pending");
  completeNode(
    parentIntegration,
    revision,
    new Date().toISOString(),
    `receipt:${receipt.receipt_digest}`,
  );
  await atomicWriteJson(rootCheckpointsPath, rootCheckpoints);
  await verifyEndToEndReleasePlan({
    repoRoot,
    writeReport: false,
    requireCompletedReceipts: true,
  });
  return {
    schema_version: "licomesh.current-baseline-acceptance.v1",
    accepted: true,
    focused_check_count: implementationNodes.length,
    full_regression_count: 1,
    final_node_id: finalNode.id,
    profiles: receipt.profiles,
    receipt_digest: receipt.receipt_digest,
    proof_verified: receipt.proof_anchor?.verified === true,
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  acceptCurrentBaseline()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
