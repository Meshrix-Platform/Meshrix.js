import fs from "node:fs";
import path from "node:path";

function defaultIsFile(candidate?: any) : any {
  return fs.statSync(candidate).isFile();
}

function existingFile(candidate?: any, isFile?: any) : any {
  if (!candidate) return false;
  try {
    return isFile(candidate) === true;
  } catch {
    return false;
  }
}

export function resolveNpmCliInvocation({
  env = process.env,
  execPath = process.execPath,
  isFile = defaultIsFile,
  platform = process.platform
}: Record<string, any> = {}) : any {
  const executableDirectory: any = path.dirname(execPath);
  const configured: any = String(env.npm_execpath || "");
  const candidates: any[] = [
    path.basename(configured).toLowerCase() === "npm-cli.js" ? configured : "",
    path.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  const npmCliPath: any = candidates.find((candidate?: any) : any => existingFile(candidate, isFile));
  if (npmCliPath) {
    return Object.freeze({ command: execPath, prefixArgs: Object.freeze([npmCliPath]) });
  }
  if (platform === "win32") {
    throw new Error("npm_cli_entrypoint_not_found");
  }
  return Object.freeze({ command: "npm", prefixArgs: Object.freeze([]) });
}

export function npmCliArgs(invocation?: any, args: any = []) : any {
  return [...invocation.prefixArgs, ...args];
}

export function parseNpmPackJson(stdout?: any) : any[] {
  const parsed: any = JSON.parse(String(stdout || "[]"));
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("npm_pack_json_shape_invalid");
  }
  if (typeof parsed.name === "string" || typeof parsed.filename === "string") {
    return [parsed];
  }
  return Object.values(parsed).flatMap((value?: any) : any => Array.isArray(value) ? value : [value]);
}

export function parseNpmExactViewJson(stdout?: any) : any {
  const parsed: any = JSON.parse(String(stdout || ""));
  if (!Array.isArray(parsed)) return parsed;
  if (parsed.length !== 1 || Array.isArray(parsed[0])) {
    throw new Error("npm_exact_view_result_count_invalid");
  }
  return parsed[0];
}
