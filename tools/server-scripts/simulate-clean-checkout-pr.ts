#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLAN_RELATIVE_ROOT = "docs/plans";
const DEFAULT_SIMULATION_ROOT = path.join(repoRoot, "build", "clean-checkout-pr-simulation");
const EXPECTED_PLAN_FILES: readonly string[] = Object.freeze([
  "Manifest.json",
  "Capabilities.json",
  "FutureGoals.md",
  "end-to-end-release/Plan.md",
  "end-to-end-release/Checkpoints.json",
  "end-to-end-release/DependencyMap.json"
]);
const REFUSAL_MESSAGE = "refusing to replace checkpoints or receipts";

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function snapshotPlanWorkspace(plansRoot: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const pending: string[] = [""];
  while (pending.length > 0) {
    const relative = pending.pop() ?? "";
    const absolute = path.join(plansRoot, relative);
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childAbsolute = path.join(plansRoot, childRelative);
      if (entry.isDirectory()) {
        pending.push(childRelative);
      } else if (entry.isFile()) {
        snapshot[childRelative] = sha256Text(await fs.readFile(childAbsolute, "utf8"));
      }
    }
  }
  return snapshot;
}

function sameSnapshot(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function assertIsolatedOutputRoot(root: string, outputRoot: string): void {
  const relative = path.relative(root, outputRoot);
  requireCondition(
    relative !== "" && !relative.split(path.sep).includes(".."),
    `simulate-clean-checkout-pr: output root must stay inside the repository: ${outputRoot}`
  );
  requireCondition(
    outputRoot !== path.join(root, PLAN_RELATIVE_ROOT) &&
      !outputRoot.startsWith(`${path.join(root, PLAN_RELATIVE_ROOT)}${path.sep}`),
    `simulate-clean-checkout-pr: ${REFUSAL_MESSAGE}`
  );
}

async function verifyFreshPlanWorkspace(outputRoot: string): Promise<{ plans: number; nodes: number }> {
  let nodes = 0;
  for (const relativePath of EXPECTED_PLAN_FILES) {
    const absolute = path.join(outputRoot, relativePath);
    const content = await fs.readFile(absolute, "utf8");
    requireCondition(content.trim().length > 0, `simulate-clean-checkout-pr: empty plan file ${relativePath}`);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(outputRoot, "Manifest.json"), "utf8")) as unknown[];
  requireCondition(Array.isArray(manifest) && manifest.length > 0, "simulate-clean-checkout-pr: Manifest.json has no plans");
  const checkpoints = JSON.parse(
    await fs.readFile(path.join(outputRoot, "end-to-end-release", "Checkpoints.json"), "utf8")
  ) as Array<{ code?: string; status?: string }>;
  nodes = Array.isArray(checkpoints) ? checkpoints.length : 0;
  requireCondition(nodes > 0, "simulate-clean-checkout-pr: Checkpoints.json has no nodes");
  requireCondition(
    checkpoints.some((node) => node.code === "DQ-PROVENANCE" && node.status === "pending"),
    "simulate-clean-checkout-pr: fresh plan is missing the pending delivery-quality frontier"
  );
  return { plans: manifest.length, nodes };
}

async function runPlanRebuild(root: string, outputRoot: string): Promise<void> {
  const script = path.join(root, "tools", "plan", "rebuild-current-plan-baseline.ts");
  const result = spawnSync(process.execPath, [script, "--output-root", outputRoot], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    windowsHide: true
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`simulate-clean-checkout-pr: plan rebuild failed: ${detail || "unknown error"}`);
  }
}

export async function simulateCleanCheckoutPr({
  repoRoot: root = repoRoot,
  outputRoot
}: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const resolvedRoot = path.resolve(String(root || repoRoot));
  const plansRoot = path.join(resolvedRoot, PLAN_RELATIVE_ROOT);
  const resolvedOutputRoot = outputRoot
    ? path.resolve(String(outputRoot))
    : path.join(resolvedRoot === repoRoot ? DEFAULT_SIMULATION_ROOT : path.join(resolvedRoot, "build", "clean-checkout-pr-simulation"), "latest");
  assertIsolatedOutputRoot(resolvedRoot, resolvedOutputRoot);

  const before = await snapshotPlanWorkspace(plansRoot);
  await fs.rm(resolvedOutputRoot, { recursive: true, force: true });
  await runPlanRebuild(resolvedRoot, resolvedOutputRoot);
  const result = await verifyFreshPlanWorkspace(resolvedOutputRoot);
  const after = await snapshotPlanWorkspace(plansRoot);
  requireCondition(
    sameSnapshot(before, after),
    "simulate-clean-checkout-pr: existing docs/plans workspace was replaced"
  );
  return {
    ok: true,
    outputRoot: resolvedOutputRoot,
    docsPlansUnchanged: true,
    plansRoot,
    ...result
  };
}

function parseArguments(argv: string[]): { outputRoot?: string } {
  let outputRoot: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output-root") {
      if (outputRoot || !argv[index + 1]) throw new Error(REFUSAL_MESSAGE);
      outputRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(REFUSAL_MESSAGE);
  }
  return { outputRoot };
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { outputRoot } = parseArguments(argv);
  const result = await simulateCleanCheckoutPr({ repoRoot, outputRoot });
  const { outputRoot: absoluteOutputRoot, plansRoot, ...summary } = result;
  process.stdout.write(`${JSON.stringify({
    ...summary,
    outputRoot: path.relative(repoRoot, String(absoluteOutputRoot)) || ".",
    plansRoot: path.relative(repoRoot, String(plansRoot)) || "."
  }, null, 2)}\n`);
}

const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`[simulate-clean-checkout-pr] ${String((error as Error)?.message || error)}\n`);
    process.exitCode = 1;
  });
}
