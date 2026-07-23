import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalBetterPlanToolError,
  canonicalBetterPlanChecks,
  validateCanonicalBetterPlanWorkspace,
} from "../../../tools/plan/canonical-better-plan-validator.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("canonical Better Plan workspace adapter", () => {
  it("requires both zero validation issues and zero label warnings", () => {
    expect(canonicalBetterPlanChecks({
      validation: { ok: true, issues: [] },
      labels: { errors: 0, warnings: 0 },
    })).toMatchObject({
      accepted: true,
      checks: { schema: true, source: true, label: true, graph: true, privacy: true },
    });

    expect(canonicalBetterPlanChecks({
      validation: { ok: true, issues: [] },
      labels: { errors: 0, warnings: 1 },
    })).toMatchObject({ accepted: false, checks: { label: false } });
  });

  it("runs the canonical validate and label commands without projecting the resolved tool path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-better-plan-"));
    temporaryRoots.push(root);
    const toolPath = path.join(root, "manifest_tool.py");
    await fs.writeFile(toolPath, "# synthetic fixture\n", "utf8");
    const calls = [];
    const result = await validateCanonicalBetterPlanWorkspace({
      repoRoot: root,
      manifestToolPath: toolPath,
      runTool: ({ args }) => {
        calls.push(args);
        return {
          status: 0,
          stdout: JSON.stringify(args[0] === "validate"
            ? { ok: true, issues: [] }
            : { errors: 0, warnings: 0 }),
        };
      },
    });

    expect(result.accepted).toBe(true);
    expect(calls).toEqual([
      ["validate", "docs/plans", "--check-sources", "--no-git", "--json"],
      ["check-labels", "docs/plans", "--json"],
    ]);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("fails closed with a bounded error when no installed tool is available", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-better-plan-missing-"));
    temporaryRoots.push(root);

    await expect(validateCanonicalBetterPlanWorkspace({
      repoRoot: root,
      homeDirectory: root,
      env: {},
    })).rejects.toEqual(expect.objectContaining({
      name: "CanonicalBetterPlanToolError",
      code: "canonical_better_plan_tool_unavailable",
    }));
    await expect(validateCanonicalBetterPlanWorkspace({
      repoRoot: root,
      homeDirectory: root,
      env: {},
    })).rejects.not.toHaveProperty("message", expect.stringContaining(root));
  });

  it("rejects malformed command output without retaining command output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-better-plan-output-"));
    temporaryRoots.push(root);
    const toolPath = path.join(root, "manifest_tool.py");
    await fs.writeFile(toolPath, "# synthetic fixture\n", "utf8");

    await expect(validateCanonicalBetterPlanWorkspace({
      repoRoot: root,
      manifestToolPath: toolPath,
      runTool: () => ({ status: 1, stdout: "not-json-sensitive-output" }),
    })).rejects.toBeInstanceOf(CanonicalBetterPlanToolError);
  });

  it("rejects a nonzero tool exit even when stdout resembles a passing report", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-better-plan-status-"));
    temporaryRoots.push(root);
    const toolPath = path.join(root, "manifest_tool.py");
    await fs.writeFile(toolPath, "# synthetic fixture\n", "utf8");

    await expect(validateCanonicalBetterPlanWorkspace({
      repoRoot: root,
      manifestToolPath: toolPath,
      runTool: () => ({ status: 1, stdout: JSON.stringify({ ok: true, issues: [] }) }),
    })).rejects.toEqual(expect.objectContaining({
      code: "canonical_better_plan_validation_unreadable",
    }));
  });
});
