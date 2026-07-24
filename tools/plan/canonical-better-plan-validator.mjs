import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const VALIDATION_SCHEMA = "v0.0.1:meshrix:better-plan-validation-1";
const TOOL_OVERRIDE = "MESHRIX_BETTER_PLAN_MANIFEST_TOOL";

export class CanonicalBetterPlanToolError extends Error {
  constructor(code) {
    super(code);
    this.name = "CanonicalBetterPlanToolError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRetriableToolFailure(result) {
  if (!isRecord(result)) {
    return false;
  }
  if (result.status === 137) {
    return true;
  }
  return result.status === null && result.signal === "SIGKILL";
}

async function invokeTool(runTool, request, { maxAttempts = 2, retryDelayMs = 50 } = {}) {
  let lastResult;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = runTool(request);
    if (!isRetriableToolFailure(lastResult) || attempt === maxAttempts) {
      return lastResult;
    }
    if (retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return lastResult;
}

function parseJsonOutput(result, code, { allowNonZeroExit = false } = {}) {
  if (!isRecord(result) || typeof result.stdout !== "string") {
    throw new CanonicalBetterPlanToolError(code);
  }
  if (result.status !== 0 && !allowNonZeroExit) {
    throw new CanonicalBetterPlanToolError(code);
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new CanonicalBetterPlanToolError(code);
  }
}

async function regularFile(candidate) {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

export async function resolveCanonicalBetterPlanTool({
  env = process.env,
  homeDirectory = os.homedir(),
  manifestToolPath,
} = {}) {
  const candidates = [
    manifestToolPath,
    env[TOOL_OVERRIDE],
    path.join(env.CODEX_HOME || path.join(homeDirectory, ".codex"), "skills", "better-plan", "scripts", "manifest_tool.py"),
    path.join(homeDirectory, ".agents", "skills", "better-plan", "scripts", "manifest_tool.py"),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of [...new Set(candidates.map((entry) => path.resolve(entry)))]) {
    if (await regularFile(candidate)) return candidate;
  }
  throw new CanonicalBetterPlanToolError("canonical_better_plan_tool_unavailable");
}

function resolvePythonExecutable(env = process.env) {
  if (process.platform === "win32") {
    return "python";
  }
  const configured = String(env.MESHRIX_BETTER_PLAN_PYTHON || "").trim();
  if (configured) {
    return configured;
  }
  return process.platform === "darwin" ? "/usr/bin/python3" : "python3";
}

function defaultRunTool({ repoRoot, toolPath, args, env = process.env }) {
  const result = spawnSync(
    resolvePythonExecutable(env),
    [toolPath, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
  };
}

export function canonicalBetterPlanChecks({ validation, labels } = {}) {
  const validationAccepted =
    validation?.ok === true &&
    Array.isArray(validation.issues) &&
    validation.issues.length === 0;
  const labelsAccepted =
    labels?.errors === 0 &&
    labels?.warnings === 0;
  const checks = {
    schema: validationAccepted,
    source: validationAccepted,
    label: labelsAccepted,
    graph: validationAccepted,
    privacy: true,
  };
  return {
    schema_version: VALIDATION_SCHEMA,
    accepted: Object.values(checks).every(Boolean),
    checks,
  };
}

export async function validateCanonicalBetterPlanWorkspace({
  repoRoot,
  planRoot = "docs/plans",
  runTool = defaultRunTool,
  ...toolOptions
} = {}) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new CanonicalBetterPlanToolError("canonical_better_plan_repo_root_missing");
  }
  const toolPath = await resolveCanonicalBetterPlanTool(toolOptions);
  const validation = parseJsonOutput(await invokeTool(runTool, {
    repoRoot,
    toolPath,
    args: ["validate", planRoot, "--check-sources", "--no-git", "--json"],
    env: toolOptions.env,
  }), "canonical_better_plan_validation_unreadable", { allowNonZeroExit: true });
  const labels = parseJsonOutput(await invokeTool(runTool, {
    repoRoot,
    toolPath,
    args: ["check-labels", planRoot, "--json"],
    env: toolOptions.env,
  }), "canonical_better_plan_labels_unreadable");
  return canonicalBetterPlanChecks({ validation, labels });
}
