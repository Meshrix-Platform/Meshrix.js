import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isJsonRecord, type JsonRecord } from "./plan-types.ts";

interface ToolResult { status: number | null; signal: NodeJS.Signals | null; stdout: string }
interface ToolRequest { repoRoot: string; toolPath: string; args: string[]; env?: NodeJS.ProcessEnv }
type RunTool = (request: ToolRequest) => ToolResult;
interface ToolResolutionOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  manifestToolPath?: string;
}

const VALIDATION_SCHEMA  = "v0.0.1:meshrix:better-plan-validation-1";
const TOOL_OVERRIDE  = "MESHRIX_BETTER_PLAN_MANIFEST_TOOL";

export class CanonicalBetterPlanToolError extends Error {
  code ;
  name ;
  constructor(code: string) {
    super(code);
    this.name = "CanonicalBetterPlanToolError";
    this.code = code;
  }
}

function isRetriableToolFailure(result: unknown): result is ToolResult {
  if (!isJsonRecord(result)) {
    return false;
  }
  if (result.status === 137) {
    return true;
  }
  return result.status === null && result.signal === "SIGKILL";
}

async function invokeTool(runTool: RunTool, request: ToolRequest, { maxAttempts = 2, retryDelayMs = 50 }: {
  maxAttempts?: number;
  retryDelayMs?: number;
} = {}): Promise<ToolResult> {
  let lastResult: ToolResult | undefined;
  for (let attempt  = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = runTool(request);
    if (!isRetriableToolFailure(lastResult) || attempt === maxAttempts) {
      return lastResult;
    }
    if (retryDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  if (!lastResult) throw new CanonicalBetterPlanToolError("canonical_better_plan_tool_unreadable");
  return lastResult;
}

function parseJsonOutput(result: unknown, code: string, { allowNonZeroExit = false }: {
  allowNonZeroExit?: boolean;
} = {}): JsonRecord {
  if (!isJsonRecord(result) || typeof result.stdout !== "string") {
    throw new CanonicalBetterPlanToolError(code);
  }
  if (result.status !== 0 && !allowNonZeroExit) {
    throw new CanonicalBetterPlanToolError(code);
  }
  try {
    const parsed  = JSON.parse(result.stdout);
    if (!isJsonRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new CanonicalBetterPlanToolError(code);
  }
}

async function regularFile(candidate: string): Promise<boolean> {
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
}: ToolResolutionOptions = {}): Promise<string> {
  const candidates  = [
    manifestToolPath,
    env[TOOL_OVERRIDE],
    path.join(env.CODEX_HOME || path.join(homeDirectory, ".codex"), "skills", "better-plan", "scripts", "manifest_tool.py"),
    path.join(homeDirectory, ".agents", "skills", "better-plan", "scripts", "manifest_tool.py"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of new Set(candidates.map((entry) => path.resolve(entry)))) {
    if (await regularFile(candidate)) return candidate;
  }
  throw new CanonicalBetterPlanToolError("canonical_better_plan_tool_unavailable");
}

function resolvePythonExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    return "python";
  }
  const configured  = String(env.MESHRIX_BETTER_PLAN_PYTHON || "").trim();
  if (configured) {
    return configured;
  }
  return process.platform === "darwin" ? "/usr/bin/python3" : "python3";
}

function defaultRunTool({ repoRoot, toolPath, args, env = process.env }: ToolRequest): ToolResult {
  const result  = spawnSync(
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

export function canonicalBetterPlanChecks({ validation }: { validation?: JsonRecord } = {}) {
  const validationAccepted  =
    validation?.valid === true &&
    Array.isArray(validation.issues) &&
    validation.issues.length === 0;
  const checks: Record<string, boolean> = {
    schema: validationAccepted,
    source: validationAccepted,
    label: validationAccepted,
    graph: validationAccepted,
    privacy: true,
  };
  return {
    schema_version: VALIDATION_SCHEMA,
    accepted: Object.values(checks).every(Boolean),
    checks,
  };
}

function errorCode(error: unknown): string {
  return isJsonRecord(error) && typeof error.code === "string" ? error.code : "";
}

async function discoverCanonicalPlanRoots(repoRoot: string, planRoot: string): Promise<string[]> {
  const candidateRoot  = path.resolve(repoRoot, planRoot);
  const candidates  = [candidateRoot];
  try {
    const entries  = await fs.readdir(candidateRoot, { withFileTypes: true });
    candidates.push(...entries.filter((entry)  => entry.isDirectory())
      .map((entry)  => path.join(candidateRoot, entry.name)));
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      const manifest  = JSON.parse(await fs.readFile(path.join(candidate, "Manifest.json"), "utf8"));
      if (isJsonRecord(manifest) && manifest.schema === "better-plan.manifest/v3") {
        roots.push(path.relative(repoRoot, candidate).split(path.sep).join("/"));
      }
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
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
}: ToolResolutionOptions & {
  repoRoot?: string;
  planRoot?: string;
  runTool?: RunTool;
} = {}) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new CanonicalBetterPlanToolError("canonical_better_plan_repo_root_missing");
  }
  const toolPath  = await resolveCanonicalBetterPlanTool(toolOptions);
  const roots  = await discoverCanonicalPlanRoots(repoRoot, planRoot);
  const validations: JsonRecord[] = [];
  for (const root of roots) {
    const result  = await invokeTool(runTool, {
      repoRoot,
      toolPath,
      args: ["validate", root, "--json"],
      env: toolOptions.env,
    });
    const validation  = parseJsonOutput(
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
      valid: validations.every((validation) => validation.valid === true),
      issues: validations.flatMap((validation) => Array.isArray(validation.issues)
        ? validation.issues : ["invalid_validation_result"]),
    },
  });
}
