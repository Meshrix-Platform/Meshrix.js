#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stopManagedProcesses } from "./lib/process-lifecycle.ts";
import { isKnownMeshrixServiceCommand, isMeshrixServiceProcessOwned } from "./lib/service-process-ownership.ts";
import {
  bootoutMacLaunchService,
  currentMacUserId,
  listPlatformPortListeners,
  listPlatformProcesses,
  readPlatformProcessCommand,
  readPlatformProcessCwd,
  terminatePlatformProcessTree,
} from "./lib/startup-platform-adapter.ts";

const scriptDir: any = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot: any = path.resolve(scriptDir, "..", "..");

function usage() : any {
  console.log(`Usage:
  node tools/scripts/clean-existing-service.ts [options]

Options:
  --port <n>            Kill listeners on a server port. Can be repeated.
  --vite-port <n>       Alias for --port, intended for local Vite dev server.
  --data-dir <path>     Data dir used by Meshrix.js service processes.
  --project-root <path> Project root used for command-line matching.
  --launch-label <name> Best-effort macOS user LaunchAgent cleanup.
  --launch-plist <path> Best-effort macOS LaunchAgent plist cleanup.
  --process-only        Stop matched Meshrix.js processes; do not kill port listeners.
  --global              Kill any Meshrix.js process matching the project root, regardless of data-dir.
  --quiet               Reduce informational output.
  --help                Show help.`);
}

function parseArgs(argv?: any) : any {
  const options: Record<string, any> = {
    ports: [],
    launchLabels: [],
    launchPlists: [],
    dataDir: "",
    projectRoot: defaultProjectRoot,
    processOnly: false,
    globalClean: false,
    quiet: false
  };
  for (let index: any = 0; index < argv.length; index += 1) {
    const arg: any = argv[index];
    const next: any = argv[index + 1];
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

function log(options?: any, message?: any) : any {
  if (!options.quiet) {
    console.log(message);
  }
}

function run(command?: any, args?: any, options: Record<string, any> = {}) : any {
  return spawnSync(command, args, {
    cwd: options.cwd || defaultProjectRoot,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function resolveDataDir(options?: any) : any {
  const args: any[] = [path.join(options.projectRoot, "tools", "server-scripts", "resolve-server-data-dir.ts")];
  if (options.dataDir) {
    args.push("--data-dir", options.dataDir);
  }
  const result: any = run(process.execPath, args, { cwd: options.projectRoot });
  if (result.status !== 0) {
    throw new Error("service_data_directory_resolution_failed");
  }
  const resolved: any = path.resolve(result.stdout.trim());
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

let cachedProcessList: any = null;

function listProcesses(resolved?: any) : any {
  if (cachedProcessList) {
    return cachedProcessList;
  }
  cachedProcessList = listPlatformProcesses(
    process.platform,
    undefined,
    [resolved?.projectRoot || "", resolved?.dataDir || ""],
  );
  return cachedProcessList;
}

function commandForPid(pid?: any) : any {
  return listProcesses().find((item?: any) : any => item.pid === Number(pid))?.commandLine
    || readPlatformProcessCommand(Number(pid));
}

function cwdForPid(pid?: any) : any {
  return readPlatformProcessCwd(Number(pid));
}

function pidIsMeshrixOwned(processItem?: any, options?: any, resolved?: any) : any {
  const pid: any = typeof processItem === "object" && processItem !== null ? processItem.pid : Number(processItem);
  if (pid === process.pid) {
    return false;
  }
  const commandLine: any =
    typeof processItem === "object" && processItem !== null
      ? String(processItem.commandLine || "")
      : commandForPid(pid);
  if (!commandLine) {
    return false;
  }
  const identity: any = { pid, commandLine };
  const context: any = {
    selfPid: process.pid,
    projectRoot: resolved.projectRoot,
    dataDirectory: resolved.dataDir,
    globalClean: options.globalClean,
  };
  if (isMeshrixServiceProcessOwned(identity, context)) return true;
  if (!isKnownMeshrixServiceCommand(commandLine)) return false;
  return isMeshrixServiceProcessOwned({ ...identity, workingDirectory: cwdForPid(pid) }, context);
}

function portListenerPids(port?: any) : any {
  return listPlatformPortListeners(Number(port));
}

export async function stopPids(pids: Iterable<number>, options: { quiet?: boolean } = {}) : Promise<void> {
  const result = await stopManagedProcesses(pids, { signalTree: terminatePlatformProcessTree });
  if (result.gracefulFailed.length > 0) log(options, "[clean] graceful process-tree shutdown did not complete; force cleanup was requested");
  if (result.forceSignalled.length > 0) log(options, "[clean] force-stopped remaining owned service process(es)");
  if (result.permissionDenied.length > 0) {
    throw new Error("service_process_stop_permission_denied");
  }
  if (result.invalid.length > 0 || result.self.length > 0) {
    throw new Error("service_process_stop_target_refused");
  }
}

async function killPortListeners(port?: any, options?: any, resolved?: any) : Promise<any> {
  const pids: any = portListenerPids(port);
  if (pids.length === 0) {
    log(options, `[clean] port ${port} is free`);
    return;
  }
  const ownPids: any[] = [];
  const externalPids: any[] = [];
  for (const pid of pids) {
    if (pidIsMeshrixOwned(pid, options, resolved)) {
      ownPids.push(pid);
    } else {
      externalPids.push(pid);
    }
  }
  if (externalPids.length > 0) {
    log(options, `[clean] port ${port} is occupied by non-Meshrix.js process(es); refusing to stop them`);
    process.exitCode = 1;
    return;
  }
  if (ownPids.length === 0) {
    log(options, `[clean] port ${port} has no Meshrix.js-owned listeners`);
    return;
  }
  log(options, `[clean] stopping Meshrix.js-owned listeners on port ${port}`);
  await stopPids(ownPids, options);
}

function bootoutLaunchLabel(label?: any, options?: any) : any {
  if (process.platform !== "darwin") return;
  const uid: any = currentMacUserId();
  const target: any = `gui/${uid}/${label}`;
  log(options, "[clean] requesting macOS user service cleanup");
  bootoutMacLaunchService(["bootout", target]);
}

function bootoutLaunchPlist(plistPath?: any, options?: any) : any {
  if (process.platform !== "darwin") return;
  const uid: any = currentMacUserId();
  log(options, "[clean] requesting macOS LaunchAgent cleanup");
  bootoutMacLaunchService(["bootout", `gui/${uid}`, plistPath]);
}

async function main() : Promise<any> {
  const options: any = parseArgs(process.argv.slice(2));
  options.projectRoot = path.resolve(options.projectRoot);
  const dataDir: any = resolveDataDir(options);
  const resolved: Record<string, any> = {
    projectRoot: options.projectRoot,
    dataDir
  };

  for (const label of options.launchLabels) bootoutLaunchLabel(label, options);
  for (const plistPath of options.launchPlists) bootoutLaunchPlist(plistPath, options);

  const stalePids: any = listProcesses(resolved)
    .filter((item?: any) : any => pidIsMeshrixOwned(item, options, resolved))
    .map((item?: any) : any => item.pid);
  if (stalePids.length > 0) {
    log(options, "[clean] stopping stale Meshrix.js service processes");
    await stopPids(stalePids, options);
  } else {
    log(options, "[clean] no stale Meshrix.js service processes");
  }

  if (options.processOnly) {
    if (options.ports.length > 0) {
      log(options, "[clean] process-only mode enabled; skipping port listener cleanup");
    }
  } else {
    cachedProcessList = null;
    for (const port of options.ports) {
      await killPortListeners(port, options, resolved);
    }
  }
  log(options, "[clean] existing Meshrix.js service cleanup complete");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error: any) {
    console.error(error instanceof Error ? error.message : "service_cleanup_failed");
    process.exitCode = 1;
  }
}
