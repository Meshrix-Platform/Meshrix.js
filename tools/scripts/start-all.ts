#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { npmCliArgs, resolveNpmCliInvocation } from "../server-scripts/lib/npm-cli-invocation.ts";
import { managedProcessIsAlive, stopManagedProcesses } from "./lib/process-lifecycle.ts";
import { openPlatformBrowser, terminatePlatformProcessTree } from "./lib/startup-platform-adapter.ts";

const scriptDir: any = path.dirname(fileURLToPath(import.meta.url));
const projectRoot: any = path.resolve(scriptDir, "..", "..");
const serverScript: any = path.join(projectRoot, "tools", "server-scripts", "start-server.ts");

function usage() : any {
  console.log(`Usage:
  node tools/scripts/start-all.ts [options]

Startup is idempotent: a service that already responds on its port is left
running and is not relaunched. Use tools/scripts/restart-all.ts to stop all
services and start them again.

Options:
  --port <n>        Server port (default: 7228)
  --data-dir <path> Data directory (default: ServerConfig.getDataDir())
  --profile <name>  Runtime profile (default: default)
  --dev             Start server API + Vite dev server
  --skip-mcp-register  Skip local MCP Hub registration
  --no-open         Do not open a browser
  --help            Show help`);
}

function parseArgs(argv?: any) : any {
  const options: Record<string, any> = {
    port: "7228",
    vitePort: "5173",
    dataDir: "",
    profile: "default",
    mode: "console",
    openBrowser: true,
    registerMcp: true
  };
  for (let index: any = 0; index < argv.length; index += 1) {
    const arg: any = argv[index];
    const next: any = argv[index + 1];
    if (arg === "--help") {
      usage();
      process.exit(0);
    } else if (arg === "--dev") {
      options.mode = "dev";
    } else if (arg === "--no-open") {
      options.openBrowser = false;
    } else if (arg === "--skip-mcp-register") {
      options.registerMcp = false;
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
    } else if (arg === "--profile" && next) {
      options.profile = next;
      index += 1;
    } else if (arg.startsWith("--profile=")) {
      options.profile = arg.slice("--profile=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
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

function spawnProcess(command?: any, args?: any, options: Record<string, any> = {}) : any {
  return spawn(command, args, {
    cwd: options.cwd || projectRoot,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || "inherit",
    windowsHide: true
  });
}

async function sleep(ms?: any) : Promise<any> {
  await new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

async function probeUrl(url?: any) : Promise<any> {
  try {
    const response: any = await fetch(url);
    await response.arrayBuffer().catch(() : any => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

async function probeBackend(port?: any) : Promise<any> {
  const endpoints: any[] = ["/api/auth/session", "/api/discovery/config", "/api/discovery"];
  for (const endpoint of endpoints) {
    if (await probeUrl(`http://127.0.0.1:${port}${endpoint}`)) return true;
  }
  return false;
}

async function waitForServer(port?: any, serverChild?: any) : Promise<any> {
  const endpoints: any[] = ["/api/auth/session", "/api/discovery/config", "/api/discovery"];
  for (let attempt: any = 0; attempt < 40; attempt += 1) {
    for (const endpoint of endpoints) {
      try {
        const response: any = await fetch(`http://127.0.0.1:${port}${endpoint}`);
        if (response.ok) return true;
      } catch {
        // keep waiting
      }
    }
    if (serverChild?.exitCode !== null || serverChild?.signalCode || !managedProcessIsAlive(serverChild?.pid)) {
      return false;
    }
    await sleep(1000);
  }
  return false;
}

async function cleanup(children?: any) : Promise<any> {
  const alive: any = children.filter(Boolean);
  if (alive.length === 0) return;
  console.log("");
  console.log("[exit] stopping processes...");
  const result: any = await stopManagedProcesses(
    alive.map((child?: any) : any => child.pid),
    { signalTree: (pid, signal) => terminatePlatformProcessTree(pid, signal) }
  );
  if (result.gracefulFailed.length > 0) console.warn("[exit] graceful process-tree shutdown did not complete; force cleanup was requested");
  if (result.forceSignalled.length > 0) {
    console.log("[exit] forcing remaining processes to stop...");
  }
  if (result.permissionDenied.length > 0) console.warn("[exit] permission denied while stopping an owned process");
  if (result.invalid.length > 0 || result.self.length > 0) {
    throw new Error("owned_process_cleanup_target_refused");
  }
  if (result.permissionDenied.length > 0) {
    throw new Error("owned_process_cleanup_permission_denied");
  }
}

async function main() : Promise<any> {
  const options: any = parseArgs(process.argv.slice(2));
  const npmInvocation = resolveNpmCliInvocation();
  const dataDir: any = resolveDataDir(options.dataDir);

  if (!existsSync(path.join(projectRoot, "node_modules"))) {
    console.log("[bootstrap] node_modules is missing; running npm ci");
    const install: any = runSync(npmInvocation.command, npmCliArgs(npmInvocation, ["ci"]), { inherit: true });
    if (install.status !== 0) throw new Error("npm ci failed");
  }

  const backendRunning: any = await probeBackend(options.port);
  const viteRunning: any = options.mode === "dev"
    ? await probeUrl(`http://127.0.0.1:${options.vitePort}/`)
    : false;

  if (backendRunning && (options.mode !== "dev" || viteRunning)) {
    console.log("[ok] services are already running; nothing to start");
    if (options.mode === "dev") {
      console.log(`[info] backend http://127.0.0.1:${options.port}; frontend http://127.0.0.1:${options.vitePort}`);
    } else {
      console.log(`[info] console http://127.0.0.1:${options.port}`);
    }
    console.log("[info] run node tools/scripts/restart-all.ts to stop and restart all services");
    return;
  }

  const children: any[] = [];
  let cleanupStarted: any = false;
  const cleanupOnce: any = async (exitCode?: any) : Promise<any> => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    try {
      await cleanup(children);
      process.exit(exitCode);
    } catch {
      console.error("owned_process_cleanup_failed");
      process.exit(1);
    }
  };
  process.once("SIGINT", () : any => void cleanupOnce(130));
  process.once("SIGTERM", () : any => void cleanupOnce(143));

  const commonArgs: any[] = [
    "--port", options.port,
    "--profile", options.profile,
    "--data-dir", dataDir,
    "--active-service-url", `http://127.0.0.1:${options.port}`,
    "--advertised-base-url", `http://127.0.0.1:${options.port}`
  ];

  let serverChild: any = null;
  if (backendRunning) {
    console.log(`[ok] backend is already running: http://127.0.0.1:${options.port}`);
  } else {
    if (options.mode === "console") {
      console.log("[server] starting console mode: tools/server-scripts/start-server.ts --with-ui");
      serverChild = spawnProcess(process.execPath, [serverScript, "--with-ui", ...commonArgs]);
    } else {
      console.log("[server] starting dev mode: tools/server-scripts/start-server.ts");
      serverChild = spawnProcess(process.execPath, [serverScript, ...commonArgs]);
    }
    children.push(serverChild);
    if (!(await waitForServer(options.port, serverChild))) {
      throw new Error(`backend was not ready on port ${options.port}; if a stale service occupies the port, run node tools/scripts/restart-all.ts to restart all services`);
    }
    console.log(`[ok] backend is ready: http://127.0.0.1:${options.port}`);
  }

  let viteChild: any = null;
  if (options.mode === "dev") {
    if (viteRunning) {
      console.log(`[ok] frontend is already running: http://127.0.0.1:${options.vitePort}`);
    } else {
      console.log("[web] starting Vite dev server: npm run server:dev:web");
      viteChild = spawnProcess(npmInvocation.command, npmCliArgs(npmInvocation, ["run", "server:dev:web"]), {
        env: {
          VITE_API_ORIGIN: `http://127.0.0.1:${options.port}`,
          VITE_API_PORT: options.port
        }
      });
      children.push(viteChild);
    }
  }

  if (serverChild && options.registerMcp) {
    console.log("[mcp] registering local MCP Hub: server:mcp:register");
    const result: any = runSync(npmInvocation.command, npmCliArgs(npmInvocation, ["run", "server:mcp:register", "--", "--url", `http://127.0.0.1:${options.port}`]), { inherit: true });
    console.log(result.status === 0 ? "[ok] MCP Hub registration complete" : "[warn] MCP Hub registration failed; server remains running");
  }

  if (options.openBrowser) {
    openPlatformBrowser(options.mode === "dev" ? `http://127.0.0.1:${options.vitePort}` : `http://127.0.0.1:${options.port}`);
  }

  if (options.mode === "console") {
    console.log(`[info] console is ready: http://127.0.0.1:${options.port}`);
  } else {
    console.log(`[info] dev environment is ready: backend http://127.0.0.1:${options.port}; frontend http://127.0.0.1:${options.vitePort}`);
  }
  console.log("[info] press Ctrl+C to stop the processes started by this run");

  const primaryChild: any = serverChild || viteChild;
  const exitCode: any = await new Promise((resolve?: any) : any => primaryChild.once("exit", (code?: any) : any => resolve(code ?? 0)));
  await cleanup(children.filter((child?: any) : any => child !== primaryChild));
  process.exitCode = exitCode;
}

main().catch((error?: any) : any => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
