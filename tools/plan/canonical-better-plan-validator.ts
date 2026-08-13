import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const VALIDATION_SCHEMA: any = "v0.0.1:meshrix:better-plan-validation-1";
const TOOL_OVERRIDE: any = "MESHRIX_BETTER_PLAN_MANIFEST_TOOL";

export class CanonicalBetterPlanToolError extends Error {
  code: any;
  name: any;
  constructor(code?: any) {
    super(code);
    this.name = "CanonicalBetterPlanToolError";
    this.code = code;
  }
}

function isRecord(value?: any) : any {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRetriableToolFailure(result?: any) : any {
  if (!isRecord(result)) {
    return false;
  }
  if (result.status === 137) {
    return true;
  }
  return result.status === null && result.signal === "SIGKILL";
}

async function invokeTool(runTool?: any, request?: any, { maxAttempts = 2, retryDelayMs = 50 }: Record<string, any> = {}) : Promise<any> {
  let lastResult: any;
  for (let attempt: any = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = runTool(request);
    if (!isRetriableToolFailure(lastResult) || attempt === maxAttempts) {
      return lastResult;
    }
    if (retryDelayMs > 0) {
      await new Promise((resolve?: any) : any => setTimeout(resolve, retryDelayMs));
    }
  }
  return lastResult;
}

function parseJsonOutput(result?: any, code?: any, { allowNonZeroExit = false }: Record<string, any> = {}) : any {
  if (!isRecord(result) || typeof result.stdout !== "string") {
    throw new CanonicalBetterPlanToolError(code);
  }
  if (result.status !== 0 && !allowNonZeroExit) {
    throw new CanonicalBetterPlanToolError(code);
  }
  try {
    const parsed: any = JSON.parse(result.stdout);
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new CanonicalBetterPlanToolError(code);
  }
}

async function regularFile(candidate?: any) : Promise<any> {
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
}: Record<string, any> = {}) : Promise<any> {
  const candidates: any = [
    manifestToolPath,
    env[TOOL_OVERRIDE],
    path.join(env.CODEX_HOME || path.join(homeDirectory, ".codex"), "skills", "better-plan", "scripts", "manifest_tool.py"),
    path.join(homeDirectory, ".agents", "skills", "better-plan", "scripts", "manifest_tool.py"),
  ].filter((candidate?: any) : any => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of [...new Set<any>(candidates.map((entry?: any) : any => path.resolve(entry)))]) {
    if (await regularFile(candidate)) return candidate;
  }
  throw new CanonicalBetterPlanToolError("canonical_better_plan_tool_unavailable");
}

function resolvePythonExecutable(env: any = process.env) : any {
  if (process.platform === "win32") {
    return "python";
  }
  const configured: any = String(env.MESHRIX_BETTER_PLAN_PYTHON || "").trim();
  if (configured) {
    return configured;
  }
  return process.platform === "darwin" ? "/usr/bin/python3" : "python3";
}

function defaultRunTool({ repoRoot, toolPath, args, env = process.env }: Record<string, any>) : any {
  const result: any = spawnSync(
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

export function canonicalBetterPlanChecks({ validation }: Record<string, any> = {}) : any {
  const validationAccepted: any =
    validation?.valid === true &&
    Array.isArray(validation.issues) &&
    validation.issues.length === 0;
  const checks: Record<string, any> = {
    schema: validationAccepted,
    source: validationAccepted,
    label: validationAccepted,
    graph: validationAccepted,
    privacy: true,
  };
  return {
    schema_version: VALIDATION_SCHEMA,
    accepted: (Object.values(checks) as any[]).every(Boolean),
    checks,
  };
}

async function discoverCanonicalPlanRoots(repoRoot?: any, planRoot?: any) : Promise<any> {
  const candidateRoot: any = path.resolve(repoRoot, planRoot);
  const candidates: any[] = [candidateRoot];
  try {
    const entries: any[] = await fs.readdir(candidateRoot, { withFileTypes: true });
    candidates.push(...entries.filter((entry?: any) : any => entry.isDirectory())
      .map((entry?: any) : any => path.join(candidateRoot, entry.name)));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const roots: any[] = [];
  for (const candidate of candidates) {
    try {
      const manifest: any = JSON.parse(await fs.readFile(path.join(candidate, "Manifest.json"), "utf8"));
      if (manifest?.schema === "better-plan.manifest/v3") {
        roots.push(path.relative(repoRoot, candidate).split(path.sep).join("/"));
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  if (roots.length === 0) {
    throw new CanonicalBetterPlanToolError("canonical_better_plan_workspace_missing");
  }
  return roots.sort();
}

export async function validateCanonicalBetterPlanWorkspace({
  repoRoot,
  planRoot = "docs/plans",
  runTool = defaultRunTool,
  ...toolOptions
}: Record<string, any> = {}) : Promise<any> {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new CanonicalBetterPlanToolError("canonical_better_plan_repo_root_missing");
  }
  const toolPath: any = await resolveCanonicalBetterPlanTool(toolOptions);
  const roots: any[] = await discoverCanonicalPlanRoots(repoRoot, planRoot);
  const validations: any[] = [];
  for (const root of roots) {
    const result: any = await invokeTool(runTool, {
      repoRoot,
      toolPath,
      args: ["validate", root, "--json"],
      env: toolOptions.env,
    });
    const validation: any = parseJsonOutput(
      result,
      "canonical_better_plan_validation_unreadable",
      { allowNonZeroExit: true },
    );
    if (result.status !== 0 && validation.valid === true) {
      throw new CanonicalBetterPlanToolError("canonical_better_plan_validation_unreadable");
    }
    validations.push(validation);
  }
  return canonicalBetterPlanChecks({
    validation: {
      valid: validations.every((validation?: any) : any => validation.valid === true),
      issues: validations.flatMap((validation?: any) : any => Array.isArray(validation.issues)
        ? validation.issues : ["invalid_validation_result"]),
    },
  });
}
