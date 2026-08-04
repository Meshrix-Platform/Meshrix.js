#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir: any = path.dirname(fileURLToPath(import.meta.url));
const projectRoot: any = path.resolve(scriptDir, "..", "..");

function parseArgs(argv?: any) : any {
  const options: Record<string, any> = { port: "7228", dataDir: "", extraArgs: [], help: false };
  const args: any[] = [...argv];
  if (/^\d+$/.test(args[0] || "")) {
    options.port = args.shift();
  }
  for (let index: any = 0; index < args.length; index += 1) {
    const arg: any = args[index];
    const next: any = args[index + 1];
    if (arg === "--port" && next) {
      options.port = next;
      index += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = arg.slice("--port=".length);
    } else if (arg === "--data-dir" && next) {
      options.dataDir = next;
      index += 1;
    } else if (arg.startsWith("--data-dir=")) {
      options.dataDir = arg.slice("--data-dir=".length);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      options.extraArgs.push(arg);
    }
  }
  if (!/^\d+$/.test(options.port)) {
    throw new Error("--port must be a number");
  }
  return options;
}

function printUsage() : any {
  console.log(`Usage:
  node tools/scripts/restart-dev.ts [port] [options]

Options:
  --port <n>        Server port (default: 7228)
  --data-dir <path> Server data directory override
  --help, -h        Show help

Any other options are passed through to tools/scripts/start-all.ts.`);
}

function run(command?: any, args?: any, options: Record<string, any> = {}) : any {
  return spawnSync(command, args, {
    cwd: projectRoot,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true
  });
}

function resolveDataDir(dataDir?: any) : any {
  const args: any[] = [path.join(projectRoot, "tools", "server-scripts", "resolve-server-data-dir.ts")];
  if (dataDir) args.push("--data-dir", dataDir);
  const result: any = run(process.execPath, args);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "failed to resolve data dir");
  }
  return result.stdout.trim();
}

try {
  const options: any = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    process.exit(0);
  }
  const dataDir: any = resolveDataDir(options.dataDir);
  console.log("[restart] stopping old service processes...");
  const clean: any = run(process.execPath, [
    path.join(projectRoot, "tools", "scripts", "clean-existing-service.ts"),
    "--process-only",
    "--data-dir", dataDir,
    "--launch-label", `dev.meshrix.server.${options.port}`,
    "--launch-label", "dev.meshrix.background-supervisor",
    "--launch-label", "dev.meshrix.system-inspection",
    "--launch-plist", path.join(process.env.HOME || "", "Library", "LaunchAgents", `dev.meshrix.server.${options.port}.plist`),
    "--launch-plist", path.join(process.env.HOME || "", "Library", "LaunchAgents", "dev.meshrix.background-supervisor.plist"),
    "--launch-plist", path.join(process.env.HOME || "", "Library", "LaunchAgents", "dev.meshrix.system-inspection.plist")
  ], { inherit: true });
  if (clean.status !== 0) process.exit(clean.status ?? 1);

  console.log("[restart] starting dev environment...");
  const start: any = run(process.execPath, [
    path.join(projectRoot, "tools", "scripts", "start-all.ts"),
    "--dev",
    "--port", options.port,
    "--data-dir", dataDir,
    ...options.extraArgs
  ], { inherit: true });
  process.exit(start.status ?? 1);
} catch (error: any) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
