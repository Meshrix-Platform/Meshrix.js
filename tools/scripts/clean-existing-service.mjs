#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDir, "..", "..");

function usage() {
  console.log(`Usage:
  node tools/scripts/clean-existing-service.mjs [options]

Options:
  --port <n>            Kill listeners on a server port. Can be repeated.
  --vite-port <n>       Alias for --port, intended for local Vite dev server.
  --data-dir <path>     Data dir used by Meshrix service processes.
  --project-root <path> Project root used for command-line matching.
  --launch-label <name> Best-effort launchctl bootout for a user service label.
  --launch-plist <path> Best-effort launchctl bootout for a LaunchAgent plist.
  --process-only        Stop matched Meshrix processes; do not kill port listeners.
  --global              Kill any Meshrix process matching the project root, regardless of data-dir.
  --quiet               Reduce informational output.
  --help                Show help.`);
}

function parseArgs(argv) {
  const options = {
    ports: [],
    launchLabels: [],
    launchPlists: [],
    dataDir: "",
    projectRoot: defaultProjectRoot,
    processOnly: false,
    globalClean: false,
    quiet: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help") {
      usage();
      process.exit(0);
    } else if (arg === "--port" || arg === "--vite-port") {
      if (!next) throw new Error(`${arg} requires a value`);
      options.ports.push(next);
      index += 1;
    } else if (arg.startsWith("--port=")) {
      options.ports.push(arg.slice("--port=".length));
    } else if (arg.startsWith("--vite-port=")) {
      options.ports.push(arg.slice("--vite-port=".length));
    } else if (arg === "--data-dir") {
      if (!next) throw new Error("--data-dir requires a value");
      options.dataDir = next;
      index += 1;
    } else if (arg.startsWith("--data-dir=")) {
      options.dataDir = arg.slice("--data-dir=".length);
    } else if (arg === "--project-root") {
      if (!next) throw new Error("--project-root requires a value");
      options.projectRoot = next;
      index += 1;
    } else if (arg.startsWith("--project-root=")) {
      options.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--launch-label") {
      if (!next) throw new Error("--launch-label requires a value");
      options.launchLabels.push(next);
      index += 1;
    } else if (arg === "--launch-plist") {
      if (!next) throw new Error("--launch-plist requires a value");
      options.launchPlists.push(next);
      index += 1;
    } else if (arg === "--process-only") {
      options.processOnly = true;
    } else if (arg === "--global") {
      options.globalClean = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function log(options, message) {
  if (!options.quiet) {
    console.log(message);
  }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || defaultProjectRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs || 15000,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function resolveDataDir(options) {
  const args = [path.join(options.projectRoot, "tools", "server-scripts", "resolve-server-data-dir.mjs")];
  if (options.dataDir) {
    args.push("--data-dir", options.dataDir);
  }
  const result = run(process.execPath, args, { cwd: options.projectRoot });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "failed to resolve data dir");
  }
  const resolved = path.resolve(result.stdout.trim());
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

function normalizeForMatch(value) {
  return path.resolve(String(value || "")).replace(/\\/g, "/").toLowerCase();
}

function pathMatchesRoot(value, normalizedRoot) {
  const normalized = normalizeForMatch(value);
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
}

let cachedProcessList = null;

function listProcesses() {
  if (cachedProcessList) {
    return cachedProcessList;
  }
  if (process.platform === "win32") {
    const ps = run("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    ], { timeoutMs: 30000 });
    if (ps.status !== 0 || !ps.stdout.trim()) {
      cachedProcessList = [];
      return cachedProcessList;
    }
    const parsed = JSON.parse(ps.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    cachedProcessList = rows
      .map((row) => ({ pid: Number(row.ProcessId), commandLine: String(row.CommandLine || "") }))
      .filter((row) => Number.isFinite(row.pid) && row.pid > 0);
    return cachedProcessList;
  }
  const ps = run("ps", ["-Ao", "pid=,command="], { timeoutMs: 15000 });
  if (ps.status !== 0) {
    cachedProcessList = [];
    return cachedProcessList;
  }
  cachedProcessList = ps.stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+([\s\S]+)$/);
      return match ? { pid: Number(match[1]), commandLine: match[2] } : null;
    })
    .filter(Boolean);
  return cachedProcessList;
}

function commandForPid(pid) {
  if (process.platform === "win32") {
    return listProcesses().find((item) => item.pid === Number(pid))?.commandLine || "";
  }
  const result = run("ps", ["-p", String(pid), "-o", "command="], { timeoutMs: 5000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

function cwdForPid(pid) {
  if (process.platform === "win32") {
    return "";
  }
  const result = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeoutMs: 3000 });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.split(/\r?\n/).find((line) => line.startsWith("n"))?.slice(1).trim() || "";
}

function commandHasLicoEntrypoint(commandLine, projectRoot) {
  const text = String(commandLine || "").replace(/\\/g, "/");
  const root = projectRoot.replace(/\\/g, "/");
  return [
    `${root}/tools/server-scripts/start-server.mjs`,
    `${root}/tools/server-scripts/background-supervisor.mjs`,
    `${root}/tools/server-scripts/system-inspection-daemon.mjs`,
    `${root}/tools/scripts/start-all.mjs`,
    `${root}/tools/scripts/start-console.mjs`,
    "tools/server-scripts/start-server.mjs",
    "tools/server-scripts/background-supervisor.mjs",
    "tools/server-scripts/system-inspection-daemon.mjs",
    "tools/scripts/start-all.mjs",
    "tools/scripts/start-console.mjs"
  ].some((needle) => text.includes(needle));
}

function commandHasDataDir(commandLine, dataDir) {
  const text = String(commandLine || "").replace(/\\/g, "/");
  const normalized = dataDir.replace(/\\/g, "/");
  return text.includes(`--data-dir ${normalized}`)
    || text.includes(`--data-dir=${normalized}`)
    || text.includes(`MESHRIX_SERVER_DATA_DIR=${normalized}`);
}

function commandIsVite(commandLine) {
  const text = String(commandLine || "").toLowerCase();
  return text.includes("/node_modules/.bin/vite")
    || text.includes("\\node_modules\\.bin\\vite")
    || text.includes(" node_modules/vite/")
    || /\bvite(\.cmd)?\b/.test(text);
}

function pidIsLicoOwned(processItem, options, resolved) {
  const pid = typeof processItem === "object" && processItem !== null ? processItem.pid : Number(processItem);
  if (pid === process.pid) {
    return false;
  }
  const commandLine =
    typeof processItem === "object" && processItem !== null
      ? String(processItem.commandLine || "")
      : commandForPid(pid);
  if (!commandLine) {
    return false;
  }
  const isLicoEntrypoint = commandHasLicoEntrypoint(commandLine, resolved.projectRoot);
  const isVite = commandIsVite(commandLine);
  if (!isLicoEntrypoint && !isVite) {
    return false;
  }

  const commandLineMatch = commandLine.replace(/\\/g, "/").toLowerCase().includes(resolved.projectRootMatch);
  const dataDirMatch = isLicoEntrypoint && commandHasDataDir(commandLine, resolved.dataDir);
  if (isLicoEntrypoint) {
    if (options.globalClean || commandLineMatch || dataDirMatch) {
      return true;
    }
    const cwd = cwdForPid(pid);
    const cwdMatch = cwd && pathMatchesRoot(cwd, resolved.projectRootMatch);
    return Boolean(cwdMatch);
  }
  if (isVite) {
    if (options.globalClean || commandLineMatch) {
      return true;
    }
    const cwd = cwdForPid(pid);
    const cwdMatch = cwd && pathMatchesRoot(cwd, resolved.projectRootMatch);
    return Boolean(cwdMatch);
  }
  return false;
}

function describeProcess(pid, options) {
  log(options, `[clean]   PID ${pid}`);
  log(options, `[clean]     cwd: ${cwdForPid(pid) || "unknown"}`);
  log(options, `[clean]     cmd: ${commandForPid(pid) || "unknown"}`);
}

function portListenerPids(port) {
  if (process.platform === "win32") {
    const result = run("netstat.exe", ["-ano", "-p", "tcp"], { timeoutMs: 15000 });
    if (result.status !== 0) {
      return [];
    }
    const pids = new Set();
    for (const line of result.stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0].toUpperCase() !== "TCP") continue;
      const local = parts[1] || "";
      const state = parts[3] || "";
      const pid = Number(parts[4]);
      if (state.toUpperCase() === "LISTENING" && local.endsWith(`:${port}`) && Number.isFinite(pid)) {
        pids.add(pid);
      }
    }
    return [...pids];
  }
  const result = run("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], { timeoutMs: 5000 });
  if (result.status !== 0 || !result.stdout.trim()) {
    return [];
  }
  return result.stdout.split(/\s+/).map(Number).filter((pid) => Number.isFinite(pid) && pid > 0);
}

function processAlive(pid) {
  if (!pid) return false;
  if (process.platform === "win32") {
    const result = run("tasklist.exe", ["/FI", `PID eq ${pid}`], { timeoutMs: 5000 });
    return result.status === 0 && result.stdout.includes(String(pid));
  }
  const result = run("kill", ["-0", String(pid)], { timeoutMs: 3000 });
  return result.status === 0;
}

function terminatePid(pid, force = false) {
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    return run("taskkill.exe", args, { timeoutMs: 15000 });
  }
  return run("kill", [force ? "-KILL" : "-TERM", String(pid)], { timeoutMs: 5000 });
}

function waitMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stopPids(pids, options) {
  const unique = [...new Set(pids)].filter((pid) => pid && pid !== process.pid);
  for (const pid of unique) {
    terminatePid(pid, false);
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (unique.every((pid) => !processAlive(pid))) return;
    waitMs(250);
  }
  const remaining = unique.filter(processAlive);
  if (remaining.length > 0) {
    log(options, `[clean] force stopping stale Meshrix process(es): ${remaining.join(" ")}`);
    for (const pid of remaining) {
      terminatePid(pid, true);
    }
  }
}

function killPortListeners(port, options, resolved) {
  const pids = portListenerPids(port);
  if (pids.length === 0) {
    log(options, `[clean] port ${port} is free`);
    return;
  }
  const ownPids = [];
  const externalPids = [];
  for (const pid of pids) {
    if (pidIsLicoOwned(pid, options, resolved)) {
      ownPids.push(pid);
    } else {
      externalPids.push(pid);
    }
  }
  if (externalPids.length > 0) {
    log(options, `[clean] port ${port} is occupied by non-Meshrix process(es); refusing to stop them`);
    for (const pid of externalPids) {
      describeProcess(pid, options);
    }
    process.exitCode = 1;
    return;
  }
  if (ownPids.length === 0) {
    log(options, `[clean] port ${port} has no Meshrix-owned listeners`);
    return;
  }
  log(options, `[clean] stopping Meshrix-owned listeners on port ${port}: ${ownPids.join(" ")}`);
  stopPids(ownPids, options);
}

function bootoutLaunchLabel(label, options) {
  if (process.platform !== "darwin") return;
  const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
  const target = `gui/${uid}/${label}`;
  log(options, `[clean] stopping launch service ${target}`);
  run("launchctl", ["bootout", target], { timeoutMs: 5000 });
}

function bootoutLaunchPlist(plistPath, options) {
  if (process.platform !== "darwin") return;
  const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
  log(options, `[clean] stopping launch plist ${plistPath}`);
  run("launchctl", ["bootout", `gui/${uid}`, plistPath], { timeoutMs: 5000 });
}

try {
  const options = parseArgs(process.argv.slice(2));
  options.projectRoot = path.resolve(options.projectRoot);
  const dataDir = resolveDataDir(options);
  const resolved = {
    projectRoot: options.projectRoot,
    projectRootMatch: normalizeForMatch(options.projectRoot),
    dataDir
  };

  for (const label of options.launchLabels) bootoutLaunchLabel(label, options);
  for (const plistPath of options.launchPlists) bootoutLaunchPlist(plistPath, options);

  const stalePids = listProcesses()
    .filter((item) => pidIsLicoOwned(item, options, resolved))
    .map((item) => item.pid);
  if (stalePids.length > 0) {
    log(options, `[clean] stopping stale Meshrix service processes: ${stalePids.join(" ")}`);
    stopPids(stalePids, options);
  } else {
    log(options, `[clean] no stale Meshrix service processes for ${dataDir}`);
  }

  if (options.processOnly) {
    if (options.ports.length > 0) {
      log(options, "[clean] process-only mode enabled; skipping port listener cleanup");
    }
  } else {
    cachedProcessList = null;
    for (const port of options.ports) {
      killPortListeners(port, options, resolved);
    }
  }
  log(options, "[clean] existing Meshrix service cleanup complete");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
