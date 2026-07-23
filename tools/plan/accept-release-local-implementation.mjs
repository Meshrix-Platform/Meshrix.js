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
const IMPLEMENTATION_NODE_ID = "b61b9d45-0429-49f7-b968-8d563fd6c2e1";
const LOCAL_FINAL_NODE_ID = "16f011cd-b99c-4304-bbb8-414a01905e00";
const FOCUSED_COMMAND = "npm run verify:acceptance";
const ACCEPTANCE_PROFILE = "core";
const PLAN_PROFILE = "local";
const EVIDENCE_PATH = "build/reports/release-local-implementation-acceptance.json";
const DESIGN_ARTIFACT_PATH = `build/plan-design/${IMPLEMENTATION_NODE_ID}.json`;

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

export async function acceptReleaseLocalImplementation({ repoRoot = defaultRepoRoot } = {}) {
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
  requireCondition(implementationNode, "Local release implementation node is missing");
  requireCondition(implementationNode.role === "implementation", "Local release node is not an implementation checkpoint");
  requireCondition(implementationNode.status === "pending", "Local release implementation node is not pending");
  requireCondition(
    implementationNode.regression?.commands?.[0] === FOCUSED_COMMAND,
    "Local release focused regression command is not canonical",
  );

  const finalNode = checkpoints.find((node) => node.id === LOCAL_FINAL_NODE_ID);
  requireCondition(finalNode?.status === "pending", "Local final validation must remain pending");

  const frozenAt = new Date().toISOString();
  const planReceiptPreflight = await verifyPlatformAcceptancePlanReceipts({
    repoRoot,
    selectedProfile: ACCEPTANCE_PROFILE,
  });
  requireCondition(planReceiptPreflight.planProfile === PLAN_PROFILE, "Local plan receipt profile mismatch");
  requireCondition(planReceiptPreflight.requiredReceiptCount === 1, "Local release must consume exactly one prerequisite receipt");
  requireCondition(
    planReceiptPreflight.bindings.length === 1 &&
      planReceiptPreflight.bindings[0].plan === "end-to-end-release/current-baseline",
    "Local release must consume only the current-baseline final receipt",
  );

  const frozenAcceptance = {
    schema_version: "licomesh.release-local-frozen-acceptance.v1",
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

  run(
    repoRoot,
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "verify:acceptance"],
    "Local release canonical acceptance",
  );

  const postAcceptancePreflight = await verifyPlatformAcceptancePlanReceipts({
    repoRoot,
    selectedProfile: ACCEPTANCE_PROFILE,
  });
  requireCondition(
    postAcceptancePreflight.planReceiptSetDigest === planReceiptPreflight.planReceiptSetDigest,
    "Local acceptance must not mutate the frozen plan receipt set",
  );

  const recordedAt = new Date().toISOString();
  completeNode(implementationNode, revision, recordedAt, FOCUSED_COMMAND);

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
    schema_version: "licomesh.release-local-implementation-acceptance.v1",
    accepted: true,
    node_id: IMPLEMENTATION_NODE_ID,
    plan_directory: PLAN_DIRECTORY,
    plan_profile: PLAN_PROFILE,
    focused_command: FOCUSED_COMMAND,
    repository_revision: revision,
    recorded_at: recordedAt,
    frozen_at: frozenAt,
    plan_receipt_set_digest: planReceiptPreflight.planReceiptSetDigest,
    prerequisite_receipts: planReceiptPreflight.bindings.map((binding) => ({
      plan: binding.plan,
      final_node_id: binding.finalNodeId,
    })),
    local_final_node_status: finalNode.status,
  };
  await writePrivateFileAtomic(
    path.join(repoRoot, EVIDENCE_PATH),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );

  return evidence;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  acceptReleaseLocalImplementation()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
