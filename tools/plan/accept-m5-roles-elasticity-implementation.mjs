#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PLAN_PROFILES } from "./plan-dependency-map.mjs";
import { verifyEndToEndReleasePlan } from "./verify-end-to-end-release-plan.mjs";
import { validateCanonicalBetterPlanWorkspace } from "./canonical-better-plan-validator.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), "../..");
const PLAN_DIRECTORY = "end-to-end-release/high-concurrency/m5-roles-elasticity";
const IMPLEMENTATION_NODE_ID = "756d99b0-2d60-45f5-87d4-216d57eb9bde";
const FOCUSED_COMMAND = "npx vitest run tests/vitest/server/plan-execution-eligibility.test.mjs";

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

export async function acceptM5RolesElasticityImplementation({ repoRoot = defaultRepoRoot } = {}) {
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
  requireCondition(implementationNode.role === "implementation", "M5 node is not an implementation checkpoint");
  requireCondition(implementationNode.status === "pending", "M5 implementation node is not pending");
  requireCondition(
    implementationNode.regression?.commands?.[0] === FOCUSED_COMMAND,
    "M5 focused regression command is not canonical",
  );

  const testPath = FOCUSED_COMMAND.slice("npx vitest run ".length);
  const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  run(repoRoot, process.execPath, [vitestEntry, "run", testPath], `M5 ${testPath}`);

  const recordedAt = new Date().toISOString();
  completeNode(implementationNode, revision, recordedAt, FOCUSED_COMMAND);

  const manifestPlan = manifest.find((plan) => plan.directory === PLAN_DIRECTORY);
  requireCondition(manifestPlan, "M5 Manifest entry is missing");
  manifestPlan.status = "in_progress";

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

  return {
    schema_version: "licomesh.m5-roles-elasticity-implementation-acceptance.v1",
    accepted: true,
    node_id: IMPLEMENTATION_NODE_ID,
    plan_directory: PLAN_DIRECTORY,
    focused_command: FOCUSED_COMMAND,
    repository_revision: revision,
    recorded_at: recordedAt,
    profiles: [...PLAN_PROFILES],
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  acceptM5RolesElasticityImplementation()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
