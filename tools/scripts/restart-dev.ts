#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { forwardSignalToChild, stopManagedProcesses } from "./lib/process-lifecycle.ts";
import { launchAgentCleanupArguments, terminatePlatformProcessTree } from "./lib/startup-platform-adapter.ts";

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
    throw new Error("server_data_directory_resolution_failed");
  }
  return result.stdout.trim();
}

async function main() : Promise<any> {
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
    ...launchAgentCleanupArguments(options.port)
  ], { inherit: true });
  if (clean.status !== 0) return clean.status ?? 1;

  console.log("[restart] starting dev environment...");
  const startArgs: any[] = [
    path.join(projectRoot, "tools", "scripts", "start-all.ts"),
    "--dev",
    "--port", options.port,
    "--data-dir", dataDir,
    ...options.extraArgs
  ];
  const child: any = spawn(process.execPath, startArgs, {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });
  let forwardingStarted = false;
  let shutdownFailed = false;
  let shutdownTask: Promise<void> = Promise.resolve();
  const forward = (signal: NodeJS.Signals): void => {
    if (forwardingStarted) return;
    forwardingStarted = true;
    if (process.platform === "win32" && child?.pid) {
      shutdownTask = stopManagedProcesses([child.pid], {
        gracefulSignal: signal,
        signalTree: (pid, selectedSignal) => terminatePlatformProcessTree(pid, selectedSignal),
      }).then((result) => {
        if (result.gracefulFailed.length > 0) console.warn("[restart] graceful process-tree shutdown did not complete; force cleanup was requested");
        if (result.permissionDenied.length > 0 || result.invalid.length > 0 || result.self.length > 0) {
          shutdownFailed = true;
          console.warn("[restart] owned process-tree shutdown could not be completed");
        }
      }).catch(() => {
        shutdownFailed = true;
        console.warn("[restart] process-tree shutdown failed");
      });
      return;
    }
    const result: any = forwardSignalToChild(child, signal);
    if (result === "permission-denied" || result === "invalid" || result === "self") {
      shutdownFailed = true;
      console.warn("[restart] child shutdown signal could not be delivered");
    }
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  const exitCode = await new Promise((resolve?: any, reject?: any) : any => {
    child.once("error", reject);
    child.once("exit", (code?: any, signal?: any) : any => {
      resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
    });
  });
  await shutdownTask;
  return shutdownFailed ? 1 : exitCode;
}

try {
  process.exitCode = await main();
} catch (error: any) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
