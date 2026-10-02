#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { forwardSignalToChild, stopManagedProcesses } from "./lib/process-lifecycle.ts";
import { launchAgentCleanupArguments, terminatePlatformProcessTree } from "./lib/startup-platform-adapter.ts";

const scriptDir: any = path.dirname(fileURLToPath(import.meta.url));
const projectRoot: any = path.resolve(scriptDir, "..", "..");
const startAllScript: any = path.join(projectRoot, "tools", "scripts", "start-all.ts");

function usage() : any {
  console.log(`Usage:
  node tools/scripts/restart-all.ts [options]

Stops existing Meshrix.js services for this project, then starts everything
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
    throw new Error("server_data_directory_resolution_failed");
  }
  const resolved: any = result.stdout.trim();
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

async function main() : Promise<any> {
  const options: any = parseArgs(process.argv.slice(2));
  const dataDir: any = resolveDataDir(options.dataDir);

  console.log("[restart] stopping existing Meshrix.js services...");
  const cleanArgs: any[] = [
    path.join(projectRoot, "tools", "scripts", "clean-existing-service.ts"),
    "--port", options.port,
    "--data-dir", dataDir,
    ...launchAgentCleanupArguments(options.port)
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
  const exitCode: any = await new Promise((resolve?: any, reject?: any) : any => {
    child.once("error", reject);
    child.once("exit", (code?: any, signal?: any) : any => {
      resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
    });
  });
  await shutdownTask;
  process.exitCode = shutdownFailed ? 1 : exitCode;
}

main().catch((error?: any) : any => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
