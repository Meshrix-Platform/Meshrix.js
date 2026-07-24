#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..", "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const serverScript = path.join(projectRoot, "tools", "server-scripts", "start-server.mjs");

function usage() {
  console.log(`Usage:
  node tools/scripts/start-all.mjs [options]

Options:
  --port <n>        Server port (default: 7228)
  --data-dir <path> Data directory (default: ServerConfig.getDataDir())
  --profile <name>  Runtime profile (default: default)
  --dev             Start server API + Vite dev server
  --skip-mcp-register  Skip local MCP Hub registration
  --no-open         Do not open a browser
  --skip-clean      Skip pre-start cleanup
  --help            Show help`);
}

function parseArgs(argv) {
  const options = {
    port: "7228",
    vitePort: "5173",
    dataDir: "",
    profile: "default",
    mode: "console",
    openBrowser: true,
    registerMcp: true,
    skipClean: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help") {
      usage();
      process.exit(0);
    } else if (arg === "--dev") {
      options.mode = "dev";
    } else if (arg === "--no-open") {
      options.openBrowser = false;
    } else if (arg === "--skip-clean") {
      options.skipClean = true;
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

function runSync(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

function resolveDataDir(dataDir) {
  const args = [path.join(projectRoot, "tools", "server-scripts", "resolve-server-data-dir.mjs")];
  if (dataDir) args.push("--data-dir", dataDir);
  const result = runSync(process.execPath, args);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "failed to resolve data dir");
  }
  const resolved = result.stdout.trim();
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

function spawnProcess(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd || projectRoot,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || "inherit",
    windowsHide: true
  });
}

function terminateProcessTree(pid, force = false) {
  if (!pid) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    runSync("taskkill.exe", args);
  } else {
    runSync("kill", [force ? "-KILL" : "-TERM", String(pid)]);
  }
}

function processAlive(pid) {
  if (!pid) return false;
  if (process.platform === "win32") {
    const result = runSync("tasklist.exe", ["/FI", `PID eq ${pid}`]);
    return result.status === 0 && result.stdout.includes(String(pid));
  }
  return runSync("kill", ["-0", String(pid)]).status === 0;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(children) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (children.every((child) => !child?.pid || !processAlive(child.pid))) return true;
    await sleep(200);
  }
  return false;
}

async function waitForServer(port, serverChild) {
  const endpoints = ["/api/auth/session", "/api/discovery/config", "/api/discovery"];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${endpoint}`);
        if (response.ok) return true;
      } catch {
        // keep waiting
      }
    }
    if (serverChild?.exitCode !== null || (serverChild?.pid && !processAlive(serverChild.pid))) {
      return false;
    }
    await sleep(1000);
  }
  return false;
}

function openUrl(url) {
  let opener;
  if (process.platform === "darwin") {
    opener = spawnProcess("open", [url], { stdio: "ignore" });
  } else if (process.platform === "win32") {
    opener = spawnProcess("cmd.exe", ["/c", "start", "", url], { stdio: "ignore" });
  } else {
    opener = spawnProcess("xdg-open", [url], { stdio: "ignore" });
  }
  opener.once("error", (error) => {
    console.warn(`[start-all] Could not open browser automatically: ${error.message}`);
  });
  opener.unref();
}

async function cleanup(children) {
  const alive = children.filter(Boolean);
  if (alive.length === 0) return;
  console.log("");
  console.log("[exit] stopping processes...");
  for (const child of alive.toReversed()) terminateProcessTree(child.pid, false);
  if (!(await waitForExit(alive))) {
    console.log("[exit] forcing remaining processes to stop...");
    for (const child of alive.toReversed()) terminateProcessTree(child.pid, true);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataDir = resolveDataDir(options.dataDir);
  if (!options.skipClean) {
    const cleanArgs = [
      path.join(projectRoot, "tools", "scripts", "clean-existing-service.mjs"),
      "--port", options.port,
      "--data-dir", dataDir,
      "--launch-label", `dev.meshrix.server.${options.port}`,
      "--launch-label", "dev.meshrix.background-supervisor",
      "--launch-label", "dev.meshrix.system-inspection",
      "--launch-plist", path.join(process.env.HOME || "", "Library", "LaunchAgents", `dev.meshrix.server.${options.port}.plist`),
      "--launch-plist", path.join(process.env.HOME || "", "Library", "LaunchAgents", "dev.meshrix.background-supervisor.plist"),
      "--launch-plist", path.join(process.env.HOME || "", "Library", "LaunchAgents", "dev.meshrix.system-inspection.plist")
    ];
    if (options.mode === "dev") cleanArgs.push("--vite-port", options.vitePort);
    const clean = runSync(process.execPath, cleanArgs, { inherit: true });
    if (clean.status !== 0) throw new Error("pre-start cleanup failed");
  }

  if (!existsSync(path.join(projectRoot, "node_modules"))) {
    console.log("[bootstrap] node_modules is missing; running npm ci");
    const install = runSync(npmCommand, ["ci"], { inherit: true });
    if (install.status !== 0) throw new Error("npm ci failed");
  }

  const children = [];
  let cleanupStarted = false;
  const cleanupOnce = async (exitCode) => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    await cleanup(children);
    process.exit(exitCode);
  };
  process.once("SIGINT", () => void cleanupOnce(130));
  process.once("SIGTERM", () => void cleanupOnce(143));

  const commonArgs = [
    "--port", options.port,
    "--profile", options.profile,
    "--data-dir", dataDir,
    "--active-service-url", `http://127.0.0.1:${options.port}`,
    "--advertised-base-url", `http://127.0.0.1:${options.port}`
  ];

  let serverChild;
  if (options.mode === "console") {
    console.log("[server] starting console mode: tools/server-scripts/start-server.mjs --with-ui");
    serverChild = spawnProcess(process.execPath, [serverScript, "--with-ui", ...commonArgs]);
    children.push(serverChild);
  } else {
    console.log("[server] starting dev mode: tools/server-scripts/start-server.mjs + Vite");
    serverChild = spawnProcess(process.execPath, [serverScript, ...commonArgs]);
    children.push(serverChild);
    if (await waitForServer(options.port, serverChild)) {
      console.log("[server] backend is ready; starting Vite...");
      const viteChild = spawnProcess(npmCommand, ["run", "server:dev:web"], {
        env: {
          VITE_API_ORIGIN: `http://127.0.0.1:${options.port}`,
          VITE_API_PORT: options.port
        }
      });
      children.push(viteChild);
    } else {
      throw new Error("backend failed to start; check logs and retry");
    }
  }

  if (await waitForServer(options.port, serverChild)) {
    console.log(`[ok] backend is ready: http://127.0.0.1:${options.port}`);
  } else {
    throw new Error(`backend was not ready on port ${options.port}`);
  }

  if (options.registerMcp) {
    console.log("[mcp] registering local MCP Hub: server:mcp:register");
    const result = runSync(npmCommand, ["run", "server:mcp:register", "--", "--url", `http://127.0.0.1:${options.port}`], { inherit: true });
    console.log(result.status === 0 ? "[ok] MCP Hub registration complete" : "[warn] MCP Hub registration failed; server remains running");
  }

  if (options.openBrowser) {
    openUrl(options.mode === "dev" ? `http://127.0.0.1:${options.vitePort}` : `http://127.0.0.1:${options.port}`);
  }

  if (options.mode === "console") {
    console.log(`[info] console is ready: http://127.0.0.1:${options.port}`);
  } else {
    console.log(`[info] dev environment is ready: backend http://127.0.0.1:${options.port}; frontend http://127.0.0.1:${options.vitePort}`);
  }
  console.log("[info] press Ctrl+C to stop all processes");

  const exitCode = await new Promise((resolve) => serverChild.once("exit", (code) => resolve(code ?? 0)));
  await cleanup(children.filter((child) => child !== serverChild));
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
