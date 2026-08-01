import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalBetterPlanToolError,
  canonicalBetterPlanChecks,
  validateCanonicalBetterPlanWorkspace,
} from "../../../tools/plan/canonical-better-plan-validator.ts";

const temporaryRoots: any[] = [];

afterEach(async () : Promise<any> => {
  await Promise.all(temporaryRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("canonical Better Plan workspace adapter", () : any => {
  it("requires both zero validation issues and zero label warnings", () : any => {
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

  it("runs the canonical validate and label commands without projecting the resolved tool path", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-better-plan-"));
    temporaryRoots.push(root);
    const toolPath: any = path.join(root, "manifest_tool.py");
    await fs.writeFile(toolPath, "# synthetic fixture\n", "utf8");
    const calls: any[] = [];
    const result: any = await validateCanonicalBetterPlanWorkspace({
      repoRoot: root,
      manifestToolPath: toolPath,
      runTool: ({ args }: Record<string, any>) : any => {
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

  it("fails closed with a bounded error when no installed tool is available", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-better-plan-missing-"));
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

  it("rejects malformed command output without retaining command output", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-better-plan-output-"));
    temporaryRoots.push(root);
    const toolPath: any = path.join(root, "manifest_tool.py");
    await fs.writeFile(toolPath, "# synthetic fixture\n", "utf8");

    await expect(validateCanonicalBetterPlanWorkspace({
      repoRoot: root,
      manifestToolPath: toolPath,
      runTool: () : any => ({ status: 1, stdout: "not-json-sensitive-output" }),
    })).rejects.toBeInstanceOf(CanonicalBetterPlanToolError);
  });

  it("rejects a nonzero tool exit even when stdout resembles a passing report", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-better-plan-status-"));
    temporaryRoots.push(root);
    const toolPath: any = path.join(root, "manifest_tool.py");
    await fs.writeFile(toolPath, "# synthetic fixture\n", "utf8");

    await expect(validateCanonicalBetterPlanWorkspace({
      repoRoot: root,
      manifestToolPath: toolPath,
      runTool: () : any => ({ status: 1, stdout: JSON.stringify({ ok: true, issues: [] }) }),
    })).rejects.toEqual(expect.objectContaining({
      code: "canonical_better_plan_labels_unreadable",
    }));
  });

  it("retries once when manifest_tool is SIGKILL'd before returning JSON", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-better-plan-retry-"));
    temporaryRoots.push(root);
    const toolPath: any = path.join(root, "manifest_tool.py");
    await fs.writeFile(toolPath, "# synthetic fixture\n", "utf8");
    const attempts: any[] = [];
    const passingPayload: any = (command?: any) : any => JSON.stringify(
      command === "validate" ? { ok: true, issues: [] } : { errors: 0, warnings: 0 },
    );

    const result: any = await validateCanonicalBetterPlanWorkspace({
      repoRoot: root,
      manifestToolPath: toolPath,
      runTool: ({ args }: Record<string, any>) : any => {
        attempts.push(args[0]);
        if (attempts.length === 1) {
          return { status: null, signal: "SIGKILL", stdout: "" };
        }
        return { status: 0, stdout: passingPayload(args[0]) };
      },
    });

    expect(result.accepted).toBe(true);
    expect(attempts).toEqual(["validate", "validate", "check-labels"]);
  });
});
