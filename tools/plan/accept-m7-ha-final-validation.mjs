#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  M7_HA_DISCIPLINE,
  assertM7HaReports,
} from "../../packages/foundation/src/scale/m7-ha-discipline.mjs";
import { reduceEndToEndReleaseReceipt } from "./reduce-end-to-end-release-receipt.mjs";
import { verifyEndToEndReleasePlan } from "./verify-end-to-end-release-plan.mjs";
import { validateCanonicalBetterPlanWorkspace } from "./canonical-better-plan-validator.mjs";
import { readJson, resolveRepoRoot, writeReportAtomically } from "../server-scripts/lib/m7-ha-report.mjs";
import { profilesEqual, acceptedFinalReceipt } from "./plan-dependency-map.mjs";

const M7_HA_PROFILES = Object.freeze(["ha"]);

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolveRepoRoot(path.resolve(path.dirname(modulePath), "../.."));
const PLAN_DIRECTORY = "end-to-end-release/m7-ha";
const IMPLEMENTATION_NODE_ID = "692501fb-a136-4b6f-839d-8f76d259b9e3";
const FINAL_NODE_ID = "7895ddb1-a7c9-4abe-8550-6c9b86b2edf0";
const FINAL_COMMAND = "npm test";
const IMPLEMENTATION_EVIDENCE_PATH = "build/reports/m7-ha/implementation-evidence.json";
const FINAL_EVIDENCE_PATH = "build/reports/m7-ha/final-validation-evidence.json";

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

async function syncPlanManifest(repoRoot) {
  const candidates = [
    path.join(repoRoot, ".agents/skills/better-plan/scripts/manifest_tool.py"),
    path.join(process.env.HOME || "", ".agents/skills/better-plan/scripts/manifest_tool.py"),
  ];
  let toolPath;
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      toolPath = candidate;
      break;
    } catch {
      // try next candidate
    }
  }
  requireCondition(toolPath, "Better Plan manifest tool is unavailable");
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [toolPath, "sync-plan", "docs/plans"],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true },
  );
  requireCondition(result.status === 0, "M7 HA Better Plan manifest sync failed");
}

async function assertHaEvidenceCurrent(repoRoot) {
  const implementationEvidence = await readJson(path.join(repoRoot, IMPLEMENTATION_EVIDENCE_PATH));
  requireCondition(implementationEvidence.accepted === true, "M7 HA implementation evidence is not accepted");
  requireCondition(
    implementationEvidence.profile === M7_HA_DISCIPLINE.profile,
    "M7 HA implementation evidence profile is not ha",
  );
  requireCondition(
    implementationEvidence.node_id === IMPLEMENTATION_NODE_ID,
    "M7 HA implementation evidence node identity is mismatched",
  );
  assertM7HaReports(implementationEvidence.reports);
  return implementationEvidence;
}

export async function acceptM7HaFinalValidation({ repoRoot = defaultRepoRoot } = {}) {
  const revision = currentRevision(repoRoot);
  const planRoot = path.join(repoRoot, "docs", "plans");
  const checkpointsPath = path.join(planRoot, PLAN_DIRECTORY, "Checkpoints.json");
  const manifestPath = path.join(planRoot, "Manifest.json");
  const [checkpoints, manifest] = await Promise.all([
    fs.readFile(checkpointsPath, "utf8").then(JSON.parse),
    fs.readFile(manifestPath, "utf8").then(JSON.parse),
  ]);

  const implementationNode = checkpoints.find((node) => node.id === IMPLEMENTATION_NODE_ID);
  requireCondition(implementationNode, "M7 HA implementation node is missing");
  requireCondition(implementationNode.status === "completed", "M7 HA implementation node is not completed");

  const finalNode = checkpoints.find((node) => node.id === FINAL_NODE_ID);
  requireCondition(finalNode, "M7 HA final validation node is missing");
  requireCondition(finalNode.role === "final_validation", "M7 node is not a final validation checkpoint");
  requireCondition(
    finalNode.status === "pending" || finalNode.status === "completed",
    "M7 HA final validation node is not executable",
  );
  requireCondition(
    finalNode.regression?.commands?.[0] === FINAL_COMMAND,
    "M7 HA final regression command is not canonical",
  );
  requireCondition(finalNode.regression?.scope === "full", "M7 HA final regression scope is not full");

  const dependencyMap = JSON.parse(await fs.readFile(
    path.join(planRoot, "end-to-end-release", "DependencyMap.json"),
    "utf8",
  ));
  const mapPlan = dependencyMap.plans.find((plan) => plan.directory === PLAN_DIRECTORY);
  requireCondition(mapPlan, "M7 HA DependencyMap entry is missing");
  const existingReceipt = acceptedFinalReceipt(mapPlan, FINAL_NODE_ID);
  requireCondition(!existingReceipt, "M7 HA final validation receipt is already accepted");

  const implementationEvidence = await assertHaEvidenceCurrent(repoRoot);

  let recordedAt = finalNode.acceptance_criteria?.[0]?.evidence_refs?.[0]?.recorded_at;
  if (finalNode.status === "pending") {
    run(
      repoRoot,
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["test"],
      "M7 HA final validation complete Core regression",
    );

    recordedAt = new Date().toISOString();
    completeNode(finalNode, revision, recordedAt, FINAL_COMMAND);

    const manifestPlan = manifest.find((plan) => plan.directory === PLAN_DIRECTORY);
    requireCondition(manifestPlan, "M7 HA Manifest entry is missing");
    manifestPlan.status = "completed";

    await Promise.all([
      atomicWriteJson(checkpointsPath, checkpoints),
      atomicWriteJson(manifestPath, manifest),
    ]);
  } else {
    requireCondition(finalNode.status === "completed", "M7 HA final validation node is incomplete");
    requireCondition(
      finalNode.acceptance_criteria?.every((criterion) => criterion.checked === true),
      "M7 HA final validation criteria are incomplete",
    );
    requireCondition(typeof recordedAt === "string" && recordedAt.length > 0, "M7 HA final validation evidence timestamp is missing");
  }

  await syncPlanManifest(repoRoot);

  const canonical = await validateCanonicalBetterPlanWorkspace({ repoRoot });
  requireCondition(canonical.accepted === true, "M7 HA canonical Better Plan validation failed");
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

  requireCondition(
    profilesEqual(receipt.profiles, M7_HA_PROFILES),
    "M7 HA final receipt profiles are not ha-only",
  );
  requireCondition(
    receipt.prerequisite_receipts.every((entry) => profilesEqual(entry.profiles, M7_HA_PROFILES)),
    "M7 HA final receipt consumed a cross-profile prerequisite",
  );

  await verifyEndToEndReleasePlan({
    repoRoot,
    writeReport: true,
    requireCompletedReceipts: true,
  });

  const evidence = {
    schema_version: "licomesh.m7-ha-final-validation-acceptance.v1",
    accepted: true,
    node_id: FINAL_NODE_ID,
    plan_directory: PLAN_DIRECTORY,
    profile: M7_HA_DISCIPLINE.profile,
    final_command: FINAL_COMMAND,
    repository_revision: revision,
    recorded_at: recordedAt,
    implementation_evidence_path: IMPLEMENTATION_EVIDENCE_PATH,
    implementation_evidence_node_id: implementationEvidence.node_id,
    receipt_digest: receipt.receipt_digest,
    proof_verified: receipt.proof_anchor?.verified === true,
  };
  await writeReportAtomically(repoRoot, FINAL_EVIDENCE_PATH, evidence);

  return evidence;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  acceptM7HaFinalValidation()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
