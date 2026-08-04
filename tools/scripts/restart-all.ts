#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir: any = path.dirname(fileURLToPath(import.meta.url));
const projectRoot: any = path.resolve(scriptDir, "..", "..");
const startAllScript: any = path.join(projectRoot, "tools", "scripts", "start-all.ts");

function usage() : any {
  console.log(`Usage:
  node tools/scripts/restart-all.ts [options]

Stops existing Meshrix services for this project, then starts everything
again through tools/scripts/start-all.ts. All options are forwarded to
start-all.ts.

Options:
  --port <n>        Server port (default: 7228)
  --data-dir <path> Data directory (default: ServerConfig.getDataDir())
  --profile <name>  Runtime profile (default: default)
  --dev             Restart as server API + Vite dev server
  --skip-mcp-register  Skip local MCP Hub registration
  --no-open         Do not open a browser
  --help            Show help`);
}

function parseArgs(argv?: any) : any {
  const options: Record<string, any> = { port: "7228", vitePort: "5173", dataDir: "", dev: false };
  for (let index: any = 0; index < argv.length; index += 1) {
    const arg: any = argv[index];
    const next: any = argv[index + 1];
    if (arg === "--help") {
      usage();
      process.exit(0);
    } else if (arg === "--dev") {
      options.dev = true;
    } else if (arg === "--port" && next) {
      options.port = next;
      index += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = arg.slice("--port=".length);
    } else if (arg === "--data-dir" && next) {
      options.dataDir = next;
      index += 1;
    } else if (arg.startsWith("--data-dir=")) {
      options.dataDir = arg.slice("--data-dir=".length);
    }
  }
  if (!/^\d+$/.test(options.port)) {
    throw new Error("--port must be a number");
  }
  return options;
}

function runSync(command?: any, args?: any, options: Record<string, any> = {}) : any {
  return spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

function resolveDataDir(dataDir?: any) : any {
  const args: any[] = [path.join(projectRoot, "tools", "server-scripts", "resolve-server-data-dir.ts")];
  if (dataDir) args.push("--data-dir", dataDir);
  const result: any = runSync(process.execPath, args);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "failed to resolve data dir");
  }
  const resolved: any = result.stdout.trim();
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

async function main() : Promise<any> {
  const options: any = parseArgs(process.argv.slice(2));
  const dataDir: any = resolveDataDir(options.dataDir);

  console.log("[restart] stopping existing Meshrix services...");
  const cleanArgs: any[] = [
    path.join(projectRoot, "tools", "scripts", "clean-existing-service.ts"),
    "--port", options.port,
    "--data-dir", dataDir,
    "--launch-label", `dev.meshrix.server.${options.port}`,
    "--launch-label", "dev.meshrix.background-supervisor",
    "--launch-label", "dev.meshrix.system-inspection",
    "--launch-plist", path.join(process.env.HOME || "", "Library", "LaunchAgents", `dev.meshrix.server.${options.port}.plist`),
    "--launch-plist", path.join(process.env.HOME || "", "Library", "LaunchAgents", "dev.meshrix.background-supervisor.plist"),
    "--launch-plist", path.join(process.env.HOME || "", "Library", "LaunchAgents", "dev.meshrix.system-inspection.plist")
  ];
  if (options.dev) cleanArgs.push("--vite-port", options.vitePort);
  const clean: any = runSync(process.execPath, cleanArgs, { inherit: true });
  if (clean.status !== 0) throw new Error("pre-start cleanup failed");

  console.log("[restart] starting services: tools/scripts/start-all.ts");
  const child: any = spawn(process.execPath, [startAllScript, ...process.argv.slice(2)], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });
  const forward: any = (signal?: any) : any => {
    if (child?.pid) {
      try {
        process.kill(child.pid, signal);
      } catch {
        // child already exited
      }
    }
  };
  process.on("SIGINT", () : any => forward("SIGINT"));
  process.on("SIGTERM", () : any => forward("SIGTERM"));
  const exitCode: any = await new Promise((resolve?: any) : any => {
    child.once("exit", (code?: any) : any => resolve(code ?? 0));
  });
  process.exitCode = exitCode;
}

main().catch((error?: any) : any => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
