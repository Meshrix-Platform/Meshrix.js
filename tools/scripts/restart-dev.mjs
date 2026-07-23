#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..", "..");

function parseArgs(argv) {
  const options = { port: "7228", dataDir: "", extraArgs: [], help: false };
  const args = [...argv];
  if (/^\d+$/.test(args[0] || "")) {
    options.port = args.shift();
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
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

function printUsage() {
  console.log(`Usage:
  node tools/scripts/restart-dev.mjs [port] [options]

Options:
  --port <n>        Server port (default: 7228)
  --data-dir <path> Server data directory override
  --help, -h        Show help

Any other options are passed through to tools/scripts/start-all.mjs.`);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: projectRoot,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true
  });
}

function resolveDataDir(dataDir) {
  const args = [path.join(projectRoot, "tools", "server-scripts", "resolve-server-data-dir.mjs")];
  if (dataDir) args.push("--data-dir", dataDir);
  const result = run(process.execPath, args);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "failed to resolve data dir");
  }
  return result.stdout.trim();
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    process.exit(0);
  }
  const dataDir = resolveDataDir(options.dataDir);
  console.log("[restart] stopping old service processes...");
  const clean = run(process.execPath, [
    path.join(projectRoot, "tools", "scripts", "clean-existing-service.mjs"),
    "--process-only",
    "--data-dir", dataDir,
    "--launch-label", `dev.lico.server.${options.port}`,
    "--launch-label", "dev.lico.background-supervisor",
    "--launch-label", "dev.lico.system-inspection",
    "--launch-plist", path.join(process.env.HOME || "", "Library", "LaunchAgents", `dev.lico.server.${options.port}.plist`),
    "--launch-plist", path.join(process.env.HOME || "", "Library", "LaunchAgents", "dev.lico.background-supervisor.plist"),
    "--launch-plist", path.join(process.env.HOME || "", "Library", "LaunchAgents", "dev.lico.system-inspection.plist")
  ], { inherit: true });
  if (clean.status !== 0) process.exit(clean.status ?? 1);

  console.log("[restart] starting dev environment...");
  const start = run(process.execPath, [
    path.join(projectRoot, "tools", "scripts", "start-all.mjs"),
    "--dev",
    "--port", options.port,
    "--data-dir", dataDir,
    "--skip-clean",
    ...options.extraArgs
  ], { inherit: true });
  process.exit(start.status ?? 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
