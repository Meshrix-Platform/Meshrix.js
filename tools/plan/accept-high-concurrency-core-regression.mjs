#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateCanonicalBetterPlanWorkspace } from "./canonical-better-plan-validator.mjs";
import { verifyEndToEndReleasePlan } from "./verify-end-to-end-release-plan.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), "../..");
const PLAN_DIRECTORY = "end-to-end-release/high-concurrency";
const EVIDENCE_NODE_ID = "0e0a2b94-7d99-483d-8cac-a1f90042ed22";
const PREREQUISITE_NODE_ID = "48a06ac0-9dad-4917-a66f-258c1b71c4fd";
const FULL_COMMAND = "npm test";
const REPORT_PATH = "build/reports/high-concurrency-core.json";

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
    await fs.mkdir(path.dirname(filePath), { recursive: true });
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

export async function acceptHighConcurrencyCoreRegression({
  repoRoot = defaultRepoRoot,
  skipRegression = false,
} = {}) {
  const revision = currentRevision(repoRoot);
  const planRoot = path.join(repoRoot, "docs", "plans");
  const checkpointsPath = path.join(planRoot, PLAN_DIRECTORY, "Checkpoints.json");
  const checkpoints = JSON.parse(await fs.readFile(checkpointsPath, "utf8"));

  const prerequisiteNode = checkpoints.find((node) => node.id === PREREQUISITE_NODE_ID);
  requireCondition(prerequisiteNode, "M6 parent integration node is missing");
  requireCondition(prerequisiteNode.status === "completed", "M6 parent integration node is not completed");

  const evidenceNode = checkpoints.find((node) => node.id === EVIDENCE_NODE_ID);
  requireCondition(evidenceNode, "Shared high-concurrency Core regression node is missing");
  requireCondition(evidenceNode.role === "evidence", "Node is not an evidence checkpoint");
  requireCondition(evidenceNode.status === "pending", "Shared Core regression node is not pending");
  requireCondition(
    evidenceNode.regression?.commands?.[0] === FULL_COMMAND,
    "Shared Core regression command is not canonical",
  );
  requireCondition(
    evidenceNode.regression?.scope === "full",
    "Shared Core regression scope is not full",
  );

  if (!skipRegression) {
    run(
      repoRoot,
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["test"],
      "Shared high-concurrency complete Core regression",
    );
  }

  const latestReportPath = path.join(repoRoot, "build", "test-reports", "latest.json");
  const reportDestination = path.join(repoRoot, REPORT_PATH);
  const latestReport = JSON.parse(await fs.readFile(latestReportPath, "utf8"));
  requireCondition(latestReport.summary?.failed === 0, "Core regression report contains failures");
  const report = {
    schema_version: "licomesh.high-concurrency-core-regression.v1",
    accepted: true,
    node_id: EVIDENCE_NODE_ID,
    plan_directory: PLAN_DIRECTORY,
    command: FULL_COMMAND,
    repository_revision: revision,
    recorded_at: new Date().toISOString(),
    runner_report: latestReport,
  };
  await atomicWriteJson(reportDestination, report);

  const recordedAt = report.recorded_at;
  completeNode(evidenceNode, revision, recordedAt, FULL_COMMAND);
  await atomicWriteJson(checkpointsPath, checkpoints);

  const canonical = await validateCanonicalBetterPlanWorkspace({ repoRoot });
  requireCondition(canonical.accepted === true, "Canonical Better Plan validation failed");
  await verifyEndToEndReleasePlan({
    repoRoot,
    writeReport: true,
    requireCompletedReceipts: false,
  });

  return {
    schema_version: "licomesh.high-concurrency-core-regression-acceptance.v1",
    accepted: true,
    node_id: EVIDENCE_NODE_ID,
    plan_directory: PLAN_DIRECTORY,
    full_command: FULL_COMMAND,
    repository_revision: revision,
    recorded_at: recordedAt,
    report_path: REPORT_PATH,
    summary: latestReport.summary,
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  acceptHighConcurrencyCoreRegression()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
