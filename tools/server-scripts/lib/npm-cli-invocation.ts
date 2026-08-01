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
