import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CURRENT_PLAN_CODE,
  CURRENT_PLAN_DIRECTORY,
  CurrentPlanAuthorityError,
  boundedCurrentPlanError,
  nextCurrentPlanAction,
  validateCurrentPlanAuthority,
} from "../../../tools/plan/current-plan-authority.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const toolPath = path.join(repoRoot, "package.json");
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function expectSafeTimestamp(value: unknown): void {
  expect(value).toEqual(expect.any(String));
  expect(value).toMatch(UTC_TIMESTAMP_PATTERN);
  expect(Number.isFinite(Date.parse(String(value)))).toBe(true);
}

function expectFullRegressionState(plan: any, regression: any): void {
  if (regression === null) {
    expect(regression).toBeNull();
    return;
  }

  expect(Object.keys(regression).sort()).toEqual([
    "commands",
    "content_fingerprint",
    "passed",
    "recorded_at",
  ]);
  expect(regression.content_fingerprint).toMatch(SHA256_PATTERN);
  expectSafeTimestamp(regression.recorded_at);
  expect(regression.commands.length).toBeGreaterThan(0);
  expect(regression.commands.length).toBeLessThanOrEqual(plan.spec.full_regression.commands.length);

  for (const [index, receipt] of regression.commands.entries()) {
    expect(Object.keys(receipt).sort()).toEqual([
      "command_sha256",
      "exit_code",
      "outcome",
      "recorded_at",
    ]);
    expect(receipt.command_sha256).toBe(createHash("sha256")
      .update(String(plan.spec.full_regression.commands[index]))
      .digest("hex"));
    expect(["passed", "failed", "timeout"]).toContain(receipt.outcome);
    if (receipt.outcome === "passed") {
      expect(receipt.exit_code).toBe(0);
    } else if (receipt.outcome === "failed") {
      expect(Number.isInteger(receipt.exit_code)).toBe(true);
      expect(receipt.exit_code).not.toBe(0);
    } else {
      expect(receipt.exit_code).toBeNull();
    }
    expectSafeTimestamp(receipt.recorded_at);
    expect(Date.parse(receipt.recorded_at)).toBeLessThanOrEqual(Date.parse(regression.recorded_at));
  }

  const allCommandsPassed = regression.commands.every((receipt: any) => receipt.outcome === "passed");
  expect(regression.passed).toBe(allCommandsPassed);
  if (regression.passed) {
    expect(regression.commands).toHaveLength(plan.spec.full_regression.commands.length);
  }
}

async function writeAuthorityFixture(root: string): Promise<void> {
  const plansRoot = path.join(root, "docs/plans");
  const planRoot = path.join(plansRoot, CURRENT_PLAN_DIRECTORY);
  await fs.mkdir(planRoot, { recursive: true });
  await fs.writeFile(path.join(plansRoot, "Manifest.json"), `${JSON.stringify({
    schema: "better-plan.manifest/v3",
    plans: [{
      code: CURRENT_PLAN_CODE,
      directory: CURRENT_PLAN_DIRECTORY,
      plan: `${CURRENT_PLAN_DIRECTORY}/Plan.json`,
      checkpoints: `${CURRENT_PLAN_DIRECTORY}/Checkpoints.json`,
    }],
  })}\n`, "utf8");
  await fs.writeFile(path.join(planRoot, "Plan.json"), `${JSON.stringify({
    schema: "better-plan.plan/v3",
    code: CURRENT_PLAN_CODE,
    directory: CURRENT_PLAN_DIRECTORY,
    phase: "authorized",
    lifecycle: { sealed: { semantic_digest: "fixture-digest" } },
  })}\n`, "utf8");
  await fs.writeFile(path.join(planRoot, "Checkpoints.json"), `${JSON.stringify({
    schema: "better-plan.checkpoints/v3",
    plan: CURRENT_PLAN_CODE,
    semantic_digest: "fixture-digest",
    delivery_status: "pending",
  })}\n`, "utf8");
  await fs.writeFile(path.join(planRoot, "Plan.md"), "# Current Plan\n", "utf8");
}

describe("current PLAN-005 authority", () => {
  it("has one canonical v3 identity and a valid execution state", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "docs/plans/Manifest.json"), "utf8"));
    expect(manifest.schema).toBe("better-plan.manifest/v3");
    expect(manifest.plans.filter((entry: any) => entry.code === CURRENT_PLAN_CODE)).toEqual([{
      code: CURRENT_PLAN_CODE,
      checkpoints: `${CURRENT_PLAN_DIRECTORY}/Checkpoints.json`,
      directory: CURRENT_PLAN_DIRECTORY,
      plan: `${CURRENT_PLAN_DIRECTORY}/Plan.json`,
      title: "Core production-use closure",
    }]);
    expect(new Set(manifest.plans.map((entry: any) => entry.code)).size).toBe(manifest.plans.length);
    expect(new Set(manifest.plans.map((entry: any) => entry.plan)).size).toBe(manifest.plans.length);
    expect(manifest.plans.every((entry: any) => entry.plan === `${entry.directory}/Plan.json`)).toBe(true);
    expect(manifest.plans.filter((entry: any) => entry.code !== CURRENT_PLAN_CODE).every((entry: any) => (
      entry.directory !== CURRENT_PLAN_DIRECTORY && entry.plan !== `${CURRENT_PLAN_DIRECTORY}/Plan.json`
    ))).toBe(true);
    const plan = JSON.parse(await fs.readFile(
      path.join(repoRoot, "docs/plans", CURRENT_PLAN_DIRECTORY, "Plan.json"), "utf8",
    ));
    const checkpoints = JSON.parse(await fs.readFile(
      path.join(repoRoot, "docs/plans", CURRENT_PLAN_DIRECTORY, "Checkpoints.json"), "utf8",
    ));
    expect(plan).toMatchObject({
      schema: "better-plan.plan/v3",
      code: CURRENT_PLAN_CODE,
      directory: CURRENT_PLAN_DIRECTORY,
    });
    expect(["authorized", "revising", "completed", "blocked"]).toContain(plan.phase);
    expect(plan.spec.tasks).toHaveLength(1);
    expect(plan.spec.tasks[0].outcome).toMatch(/accepted.*deployed.*running/i);
    expect(JSON.stringify(plan)).not.toContain("governance migration");
    expect(checkpoints).toMatchObject({
      schema: "better-plan.checkpoints/v3",
      plan: CURRENT_PLAN_CODE,
      tasks: [{ code: "TASK-001", evidence: expect.any(Array) }],
    });
    expect(checkpoints.tasks).toHaveLength(1);
    expectFullRegressionState(plan, null);
    expectFullRegressionState(plan, checkpoints.full_regression);
    expect(["pending", "in_progress", "completed", "blocked"]).toContain(checkpoints.delivery_status);
    expect([
      "pending",
      "in_progress",
      "completed",
      "blocked_by_authority",
      "blocked_by_environment",
    ]).toContain(checkpoints.tasks[0].status);
    if (checkpoints.tasks[0].status === "pending") {
      expect(checkpoints.tasks[0].dispatch).toBeNull();
    } else if (checkpoints.tasks[0].dispatch !== null) {
      expect(checkpoints.tasks[0].dispatch).toMatchObject({ attempts: expect.any(Number) });
    }
    if (["blocked_by_authority", "blocked_by_environment"].includes(checkpoints.tasks[0].status)) {
      expect(checkpoints.tasks[0].status_reason).toEqual(expect.any(String));
      expect(checkpoints.tasks[0].status_reason.trim()).not.toBe("");
    }
    expect(checkpoints.revision).toBe(plan.lifecycle.sealed.revision);
    expect(checkpoints.semantic_digest).toBe(plan.lifecycle.sealed.semantic_digest);
  });

  it("delegates validation and next action to the canonical tool without mutating checkpoints", async () => {
    const checkpointPath = path.join(repoRoot, "docs/plans", CURRENT_PLAN_DIRECTORY, "Checkpoints.json");
    const before = await fs.readFile(checkpointPath, "utf8");
    const calls: string[][] = [];
    const action = await nextCurrentPlanAction({
      repoRoot,
      toolPath,
      runTool: ({ args }) => {
        calls.push(args);
        return args[0] === "validate"
          ? { status: 0, stdout: JSON.stringify({ valid: true, issues: [] }) }
          : { status: 0, stdout: JSON.stringify({ action: "dispatch_tasks", eligible: ["TASK-001"] }) };
      },
    });
    expect(calls).toEqual([
      ["validate", "docs/plans", "--json"],
      ["next-action", "docs/plans", "--plan", CURRENT_PLAN_CODE],
    ]);
    expect(action).toEqual({ action: "dispatch_tasks", eligible: ["TASK-001"] });
    expect(await fs.readFile(checkpointPath, "utf8")).toBe(before);
  });

  it("fails closed with bounded errors for nonzero and malformed canonical output", async () => {
    for (const result of [
      { status: 1, stdout: "private raw failure" },
      { status: 0, stdout: "[]" },
      { status: 0, stdout: "not-json" },
    ]) {
      await expect(validateCurrentPlanAuthority({ repoRoot, toolPath, runTool: () => result }))
        .rejects.toMatchObject({ code: "current_plan_validation_failed" });
    }
    const bounded = boundedCurrentPlanError(new CurrentPlanAuthorityError("current_plan_tool_unavailable"));
    expect(bounded).toEqual({
      accepted: false,
      error_code: "current_plan_tool_unavailable",
      plan: CURRENT_PLAN_CODE,
    });
    expect(JSON.stringify(bounded)).not.toMatch(/private raw failure|package\.json/u);
  });

  it("allows indexed non-current Plans while rejecting mismatched or unindexed semantic authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-current-plan-authority-"));
    const validToolResult = () => ({
      status: 0,
      stdout: JSON.stringify({ valid: true, issues: [] }),
    });
    try {
      await writeAuthorityFixture(root);
      const manifestPath = path.join(root, "docs/plans/Manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const followupRoot = path.join(root, "docs/plans/followup");
      await fs.mkdir(followupRoot, { recursive: true });
      await fs.writeFile(path.join(followupRoot, "Plan.json"), "{}\n", "utf8");
      manifest.plans.push({
        code: "PLAN-009",
        directory: "followup",
        plan: "followup/Plan.json",
      });
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
      await expect(validateCurrentPlanAuthority({ repoRoot: root, toolPath, runTool: validToolResult }))
        .resolves.toMatchObject({ plan: CURRENT_PLAN_CODE, directory: CURRENT_PLAN_DIRECTORY });

      manifest.plans[0].checkpoints = "parallel/Checkpoints.json";
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
      await expect(validateCurrentPlanAuthority({ repoRoot: root, toolPath, runTool: validToolResult }))
        .rejects.toMatchObject({ code: "current_plan_identity_invalid" });

      manifest.plans[0].checkpoints = `${CURRENT_PLAN_DIRECTORY}/Checkpoints.json`;
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
      const parallelRoot = path.join(root, "docs/plans/parallel/deep");
      await fs.mkdir(parallelRoot, { recursive: true });
      await fs.writeFile(path.join(parallelRoot, "Plan.json"), "{}\n", "utf8");
      await expect(validateCurrentPlanAuthority({ repoRoot: root, toolPath, runTool: validToolResult }))
        .rejects.toMatchObject({ code: "current_plan_identity_invalid" });

      await fs.rm(path.join(root, "docs/plans/parallel"), { recursive: true, force: true });
      await fs.mkdir(parallelRoot, { recursive: true });
      await fs.writeFile(path.join(parallelRoot, "Manifest.json"), "{}\n", "utf8");
      await expect(validateCurrentPlanAuthority({ repoRoot: root, toolPath, runTool: validToolResult }))
        .rejects.toMatchObject({ code: "current_plan_identity_invalid" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
