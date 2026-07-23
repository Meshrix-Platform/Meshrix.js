#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { verifyPlatformAcceptancePlanReceipts } from "../server-scripts/lib/platform-acceptance-plan-receipts.mjs";
import { verifyEndToEndReleasePlan } from "./verify-end-to-end-release-plan.mjs";
import { validateCanonicalBetterPlanWorkspace } from "./canonical-better-plan-validator.mjs";
import { writePrivateFileAtomic } from "../../packages/foundation/src/storage/private-file-atomic.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), "../..");
const PLAN_DIRECTORY = "end-to-end-release/release-acceptance";
const SCAFFOLD_NODE_ID = "721f3190-78c6-46a9-9e4f-45d556bbb54b";
const IMPLEMENTATION_NODE_ID = "7e41164a-a1b4-4ea1-bafc-24932cd96f5e";
const SCALE_FINAL_NODE_ID = "267c70a8-0b95-4e8c-8eb2-021ebeef7c8e";
const FOCUSED_COMMAND = "npm run verify:acceptance";
const ACCEPTANCE_PROFILE = "scale";
const PLAN_PROFILE = "scale";
const ACCEPTANCE_VERIFIER = "tools/server-scripts/verify-platform-acceptance.mjs";
const EVIDENCE_PATH = "build/reports/release-scale-implementation-acceptance.json";
const DESIGN_ARTIFACT_PATH = `build/plan-design/${IMPLEMENTATION_NODE_ID}.json`;
const REQUIRED_PREREQUISITE_PLANS = Object.freeze([
  "end-to-end-release/current-baseline",
  "end-to-end-release/high-concurrency",
  "end-to-end-release/m7-scale",
]);

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

export async function acceptReleaseScaleImplementation({ repoRoot = defaultRepoRoot } = {}) {
  const revision = currentRevision(repoRoot);
  const planRoot = path.join(repoRoot, "docs", "plans");
  const checkpointsPath = path.join(planRoot, PLAN_DIRECTORY, "Checkpoints.json");
  const manifestPath = path.join(planRoot, "Manifest.json");
  const [checkpoints, manifest] = await Promise.all([
    fs.readFile(checkpointsPath, "utf8").then(JSON.parse),
    fs.readFile(manifestPath, "utf8").then(JSON.parse),
  ]);

  const scaffoldNode = checkpoints.find((node) => node.id === SCAFFOLD_NODE_ID);
  requireCondition(scaffoldNode?.status === "completed", "Release acceptance scaffold is not completed");

  const implementationNode = checkpoints.find((node) => node.id === IMPLEMENTATION_NODE_ID);
  requireCondition(implementationNode, "Scale release implementation node is missing");
  requireCondition(implementationNode.role === "implementation", "Scale release node is not an implementation checkpoint");
  requireCondition(implementationNode.status === "pending", "Scale release implementation node is not pending");
  requireCondition(
    implementationNode.regression?.commands?.[0] === FOCUSED_COMMAND,
    "Scale release focused regression command is not canonical",
  );

  const finalNode = checkpoints.find((node) => node.id === SCALE_FINAL_NODE_ID);
  requireCondition(finalNode?.status === "pending", "Scale final validation must remain pending");

  const frozenAt = new Date().toISOString();
  const planReceiptPreflight = await verifyPlatformAcceptancePlanReceipts({
    repoRoot,
    selectedProfile: ACCEPTANCE_PROFILE,
  });
  requireCondition(planReceiptPreflight.planProfile === PLAN_PROFILE, "Scale plan receipt profile mismatch");
  requireCondition(planReceiptPreflight.requiredReceiptCount === 3, "Scale release must consume exactly three prerequisite receipts");
  requireCondition(
    planReceiptPreflight.bindings.length === 3 &&
      REQUIRED_PREREQUISITE_PLANS.every((planDirectory) =>
        planReceiptPreflight.bindings.some((binding) => binding.plan === planDirectory)),
    "Scale release must consume only the scale prerequisite receipts",
  );

  const frozenAcceptance = {
    schema_version: "licomesh.release-scale-frozen-acceptance.v1",
    node_id: IMPLEMENTATION_NODE_ID,
    plan_directory: PLAN_DIRECTORY,
    plan_profile: PLAN_PROFILE,
    acceptance_profile: ACCEPTANCE_PROFILE,
    focused_command: FOCUSED_COMMAND,
    frozen_at: frozenAt,
    repository_revision: revision,
    plan_receipt_preflight: {
      plan_receipt_set_digest: planReceiptPreflight.planReceiptSetDigest,
      required_receipt_count: planReceiptPreflight.requiredReceiptCount,
      bindings: planReceiptPreflight.bindings.map((binding) => ({
        plan: binding.plan,
        final_node_id: binding.finalNodeId,
        receipt_digest: binding.receiptDigest,
      })),
    },
  };
  await fs.mkdir(path.join(repoRoot, "build", "plan-design"), { recursive: true });
  await writePrivateFileAtomic(
    path.join(repoRoot, DESIGN_ARTIFACT_PATH),
    `${JSON.stringify(frozenAcceptance, null, 2)}\n`,
  );

  const acceptanceCommandIdentity = `${ACCEPTANCE_VERIFIER} --profile ${ACCEPTANCE_PROFILE}`;
  run(
    repoRoot,
    process.execPath,
    [path.join(repoRoot, ACCEPTANCE_VERIFIER), "--profile", ACCEPTANCE_PROFILE],
    "Scale release canonical acceptance",
  );

  const postAcceptancePreflight = await verifyPlatformAcceptancePlanReceipts({
    repoRoot,
    selectedProfile: ACCEPTANCE_PROFILE,
  });
  requireCondition(
    postAcceptancePreflight.planReceiptSetDigest === planReceiptPreflight.planReceiptSetDigest,
    "Scale acceptance must not mutate the frozen plan receipt set",
  );

  const recordedAt = new Date().toISOString();
  completeNode(implementationNode, revision, recordedAt, acceptanceCommandIdentity);

  const manifestPlan = manifest.find((plan) => plan.directory === PLAN_DIRECTORY);
  requireCondition(manifestPlan, "Release acceptance Manifest entry is missing");
  manifestPlan.status = "in_progress";

  await Promise.all([
    atomicWriteJson(checkpointsPath, checkpoints),
    atomicWriteJson(manifestPath, manifest),
  ]);

  const canonical = await validateCanonicalBetterPlanWorkspace({ repoRoot });
  requireCondition(canonical.accepted === true, "Release acceptance canonical Better Plan validation failed");
  await verifyEndToEndReleasePlan({
    repoRoot,
    writeReport: false,
    requireCompletedReceipts: false,
  });

  const evidence = {
    schema_version: "licomesh.release-scale-implementation-acceptance.v1",
    accepted: true,
    node_id: IMPLEMENTATION_NODE_ID,
    plan_directory: PLAN_DIRECTORY,
    plan_profile: PLAN_PROFILE,
    acceptance_profile: ACCEPTANCE_PROFILE,
    focused_command: FOCUSED_COMMAND,
    acceptance_command: acceptanceCommandIdentity,
    repository_revision: revision,
    recorded_at: recordedAt,
    frozen_at: frozenAt,
    plan_receipt_set_digest: planReceiptPreflight.planReceiptSetDigest,
    prerequisite_receipts: planReceiptPreflight.bindings.map((binding) => ({
      plan: binding.plan,
      final_node_id: binding.finalNodeId,
    })),
    scale_final_node_status: finalNode.status,
  };
  await writePrivateFileAtomic(
    path.join(repoRoot, EVIDENCE_PATH),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );

  return evidence;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  acceptReleaseScaleImplementation()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
