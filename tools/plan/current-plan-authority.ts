#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CURRENT_PLAN_CODE = "PLAN-005";
export const CURRENT_PLAN_DIRECTORY = "production-use-closure";
export const CURRENT_PLAN_ROOT = "docs/plans";

const TOOL_OVERRIDE = "MESHRIX_BETTER_PLAN_MANIFEST_TOOL";
const PLAN_PATH = `${CURRENT_PLAN_DIRECTORY}/Plan.json`;
const STATE_PATHS = Object.freeze({
  manifest: "docs/plans/Manifest.json",
  plan: `docs/plans/${PLAN_PATH}`,
  projection: `docs/plans/${CURRENT_PLAN_DIRECTORY}/Plan.md`,
  checkpoints: `docs/plans/${CURRENT_PLAN_DIRECTORY}/Checkpoints.json`,
});

interface ToolResult {
  status: number | null;
  stdout: string;
}

interface ToolRequest {
  repoRoot: string;
  toolPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type RunCurrentPlanTool = (request: ToolRequest) => ToolResult;

export class CurrentPlanAuthorityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CurrentPlanAuthorityError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(filePath: string, code: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!isRecord(value)) throw new Error("not_object");
    return value;
  } catch {
    throw new CurrentPlanAuthorityError(code);
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function authoritySourcePaths(root: string): Promise<string[]> {
  const pending = [root];
  const sources: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop() ?? root;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else if (entry.isFile() && (entry.name === "Manifest.json" || entry.name === "Plan.json")) {
        sources.push(path.relative(root, absolutePath).split(path.sep).join("/"));
      }
    }
  }
  return sources.sort();
}

export async function resolveCurrentPlanTool({
  env = process.env,
  homeDirectory = os.homedir(),
}: {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
} = {}): Promise<string> {
  const codexRoot = env.CODEX_HOME || path.join(homeDirectory, ".codex");
  const candidates = [
    env[TOOL_OVERRIDE],
    path.join(codexRoot, "skills", "better-plan", "scripts", "manifest_tool.py"),
    path.join(homeDirectory, ".agents", "skills", "better-plan", "scripts", "manifest_tool.py"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);

  for (const candidate of new Set(candidates.map((entry) => path.resolve(entry)))) {
    if (await isRegularFile(candidate)) return candidate;
  }
  throw new CurrentPlanAuthorityError("current_plan_tool_unavailable");
}

function pythonExecutable(env: NodeJS.ProcessEnv): string {
  const configured = String(env.MESHRIX_BETTER_PLAN_PYTHON || "").trim();
  if (configured) return configured;
  if (process.platform === "win32") return "python";
  return process.platform === "darwin" ? "/usr/bin/python3" : "python3";
}

function defaultRunTool({ repoRoot, toolPath, args, env }: ToolRequest): ToolResult {
  const result = spawnSync(pythonExecutable(env), [toolPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

function parseToolObject(result: ToolResult, code: string): Record<string, unknown> {
  if (result.status !== 0) throw new CurrentPlanAuthorityError(code);
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isRecord(parsed)) throw new Error("not_object");
    return parsed;
  } catch {
    throw new CurrentPlanAuthorityError(code);
  }
}

async function assertExactWorkspace(repoRoot: string): Promise<{
  plan: Record<string, unknown>;
  checkpoints: Record<string, unknown>;
}> {
  const root = path.join(repoRoot, CURRENT_PLAN_ROOT);
  let sources: string[];
  try {
    sources = await authoritySourcePaths(root);
  } catch {
    throw new CurrentPlanAuthorityError("current_plan_manifest_invalid");
  }
  const manifest = await readJsonObject(path.join(root, "Manifest.json"), "current_plan_manifest_invalid");
  const plans = manifest.plans;
  if (manifest.schema !== "better-plan.manifest/v3" || !Array.isArray(plans) || plans.length === 0) {
    throw new CurrentPlanAuthorityError("current_plan_identity_invalid");
  }
  const entries: Record<string, unknown>[] = [];
  const indexedPlanPaths: string[] = [];
  const indexedCodes = new Set<string>();
  for (const candidate of plans) {
    if (!isRecord(candidate)) throw new CurrentPlanAuthorityError("current_plan_identity_invalid");
    const code = String(candidate.code || "");
    const directory = String(candidate.directory || "");
    const planPath = String(candidate.plan || "");
    if (!/^PLAN-[0-9]{3}$/u.test(code) || !directory || directory.includes("\\") ||
        planPath !== `${directory}/Plan.json` || path.posix.normalize(planPath) !== planPath ||
        planPath.startsWith("../") || indexedCodes.has(code) || indexedPlanPaths.includes(planPath) ||
        (candidate.checkpoints !== undefined && candidate.checkpoints !== `${directory}/Checkpoints.json`)) {
      throw new CurrentPlanAuthorityError("current_plan_identity_invalid");
    }
    indexedCodes.add(code);
    indexedPlanPaths.push(planPath);
    entries.push(candidate);
  }
  const expectedSources = ["Manifest.json", ...indexedPlanPaths].sort();
  if (JSON.stringify(sources) !== JSON.stringify(expectedSources)) {
    throw new CurrentPlanAuthorityError("current_plan_identity_invalid");
  }
  const currentEntries = entries.filter((candidate) => candidate.code === CURRENT_PLAN_CODE);
  if (currentEntries.length !== 1) throw new CurrentPlanAuthorityError("current_plan_identity_invalid");
  const entry = currentEntries[0];
  if (entry.directory !== CURRENT_PLAN_DIRECTORY ||
      entry.plan !== PLAN_PATH || entry.checkpoints !== `${CURRENT_PLAN_DIRECTORY}/Checkpoints.json`) {
    throw new CurrentPlanAuthorityError("current_plan_identity_invalid");
  }

  const plan = await readJsonObject(path.join(root, PLAN_PATH), "current_plan_semantic_state_invalid");
  const checkpoints = await readJsonObject(
    path.join(root, CURRENT_PLAN_DIRECTORY, "Checkpoints.json"),
    "current_plan_execution_state_invalid",
  );
  if (plan.schema !== "better-plan.plan/v3" || plan.code !== CURRENT_PLAN_CODE ||
      plan.directory !== CURRENT_PLAN_DIRECTORY || checkpoints.schema !== "better-plan.checkpoints/v3" ||
      checkpoints.plan !== CURRENT_PLAN_CODE || checkpoints.semantic_digest !==
      (isRecord(plan.lifecycle) && isRecord(plan.lifecycle.sealed) ? plan.lifecycle.sealed.semantic_digest : undefined)) {
    throw new CurrentPlanAuthorityError("current_plan_state_roles_invalid");
  }
  if (!(await isRegularFile(path.join(root, CURRENT_PLAN_DIRECTORY, "Plan.md")))) {
    throw new CurrentPlanAuthorityError("current_plan_projection_missing");
  }
  return { plan, checkpoints };
}

export async function validateCurrentPlanAuthority({
  repoRoot,
  env = process.env,
  homeDirectory,
  runTool = defaultRunTool,
  toolPath,
}: {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  runTool?: RunCurrentPlanTool;
  toolPath?: string;
}): Promise<Record<string, unknown>> {
  const resolvedRoot = path.resolve(repoRoot);
  const { plan, checkpoints } = await assertExactWorkspace(resolvedRoot);
  const resolvedTool = toolPath || await resolveCurrentPlanTool({ env, homeDirectory });
  const validation = parseToolObject(runTool({
    repoRoot: resolvedRoot,
    toolPath: resolvedTool,
    args: ["validate", CURRENT_PLAN_ROOT, "--json"],
    env,
  }), "current_plan_validation_failed");
  if (validation.valid !== true || !Array.isArray(validation.issues) || validation.issues.length !== 0) {
    throw new CurrentPlanAuthorityError("current_plan_validation_failed");
  }
  return {
    plan: CURRENT_PLAN_CODE,
    directory: CURRENT_PLAN_DIRECTORY,
    phase: plan.phase,
    delivery_status: checkpoints.delivery_status,
    state_paths: { ...STATE_PATHS },
  };
}

export async function nextCurrentPlanAction(options: Parameters<typeof validateCurrentPlanAuthority>[0]): Promise<Record<string, unknown>> {
  await validateCurrentPlanAuthority(options);
  const env = options.env ?? process.env;
  const resolvedTool = options.toolPath || await resolveCurrentPlanTool({ env, homeDirectory: options.homeDirectory });
  const action = parseToolObject((options.runTool ?? defaultRunTool)({
    repoRoot: path.resolve(options.repoRoot),
    toolPath: resolvedTool,
    args: ["next-action", CURRENT_PLAN_ROOT, "--plan", CURRENT_PLAN_CODE],
    env,
  }), "current_plan_next_action_failed");
  if (typeof action.action !== "string" || action.action.length === 0) {
    throw new CurrentPlanAuthorityError("current_plan_next_action_failed");
  }
  return action;
}

export function boundedCurrentPlanError(error: unknown): { accepted: false; error_code: string; plan: string } {
  return {
    accepted: false,
    error_code: error instanceof CurrentPlanAuthorityError ? error.code : "current_plan_authority_failed",
    plan: CURRENT_PLAN_CODE,
  };
}

async function main(): Promise<void> {
  const modulePath = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(modulePath), "../..");
  if (process.argv.length !== 3 || process.argv[2] !== "next") {
    throw new CurrentPlanAuthorityError("current_plan_command_invalid");
  }
  process.stdout.write(`${JSON.stringify(await nextCurrentPlanAction({ repoRoot }))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(boundedCurrentPlanError(error))}\n`);
    process.exitCode = 1;
  });
}
