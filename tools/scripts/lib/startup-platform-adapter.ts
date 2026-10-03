import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  inspectManagedProcess,
  isManagedPid,
  signalManagedProcess,
  type ManagedSignalResult,
  type ProcessSignal,
} from "./process-lifecycle.ts";

export interface ProcessDescriptor {
  pid: number;
  commandLine: string;
}

export interface PlatformCommandResult {
  status: number | null;
  stdout: string;
}

export type PlatformCommandRunner = (
  command: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
) => PlatformCommandResult;

export function runPlatformCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): PlatformCommandResult {
  const result = spawnSync(command, [...args], {
    env: { ...process.env, ...environment },
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error("startup_platform_command_failed");
  return { status: result.status, stdout: result.stdout || "" };
}

function requireSuccess(result: PlatformCommandResult): string {
  if (result.status !== 0) throw new Error("startup_process_discovery_failed");
  return result.stdout;
}

export function listPlatformProcesses(
  platform = process.platform,
  run: PlatformCommandRunner = runPlatformCommand,
  commandLineNeedles: readonly string[] = [],
): ProcessDescriptor[] {
  if (platform === "win32") {
    const needles = commandLineNeedles.filter((needle) => needle.trim());
    const filterCommand = needles.length === 0
      ? "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
      : "$needles = ConvertFrom-Json -InputObject $env:MESHRIX_PROCESS_DISCOVERY_NEEDLES; Get-CimInstance Win32_Process | Where-Object { $line = $_.CommandLine; $line -and @($needles | Where-Object { $line.IndexOf($_, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0 } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const stdout = requireSuccess(run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      filterCommand,
    ], needles.length === 0 ? undefined : { MESHRIX_PROCESS_DISCOVERY_NEEDLES: JSON.stringify(needles) }));
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
      .map((row) => ({ pid: Number(row.ProcessId), commandLine: String(row.CommandLine || "") }))
      .filter((row) => isManagedPid(row.pid));
  }

  if (platform === "linux") {
    const needles = [
      ...commandLineNeedles.filter((needle) => needle.trim()).map((needle) => needle.toLowerCase()),
      "tools/server-scripts/start-server.ts",
      "tools/server-scripts/background-supervisor.ts",
      "tools/server-scripts/system-inspection-daemon.ts",
      "tools/scripts/start-all.ts",
      "tools/scripts/start-console.ts",
      "node_modules/.bin/vite",
    ];
    const processes: ProcessDescriptor[] = [];
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (!isManagedPid(pid)) continue;
      try {
        const commandLine = readFileSync(`/proc/${entry.name}/cmdline`, "utf8").replace(/\0/g, " ").trim();
        if (commandLine && needles.some((needle) => commandLine.toLowerCase().includes(needle))) {
          processes.push({ pid, commandLine });
        }
      } catch {
        // A process may exit or restrict /proc access during enumeration.
      }
    }
    return processes;
  }

  const stdout = requireSuccess(run("ps", ["-Ao", "pid=,command="]));
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+([\s\S]+)$/);
      return match ? { pid: Number(match[1]), commandLine: match[2] } : null;
    })
    .filter((row): row is ProcessDescriptor => row !== null && isManagedPid(row.pid));
}

export function readPlatformProcessCommand(
  pid: number,
  platform = process.platform,
  run: PlatformCommandRunner = runPlatformCommand,
): string {
  if (!isManagedPid(pid)) return "";
  if (platform === "win32") {
    const stdout = requireSuccess(run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object -ExpandProperty CommandLine`,
    ]));
    return stdout.trim();
  }
  const result = run("ps", ["-p", String(pid), "-o", "command="]);
  return result.status === 0 ? result.stdout.trim() : "";
}

export function readPlatformProcessCwd(
  pid: number,
  platform = process.platform,
  run: PlatformCommandRunner = runPlatformCommand,
): string {
  if (!isManagedPid(pid) || platform === "win32") return "";
  if (platform === "linux") {
    try {
      return realpathSync(`/proc/${pid}/cwd`);
    } catch {
      return "";
    }
  }
  const result = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  if (result.status !== 0) return "";
  return result.stdout.split(/\r?\n/).find((line) => line.startsWith("n"))?.slice(1).trim() || "";
}

export function listPlatformPortListeners(
  port: number,
  platform = process.platform,
  run: PlatformCommandRunner = runPlatformCommand,
): number[] {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("startup_port_invalid");
  }
  if (platform === "win32") {
    const stdout = requireSuccess(run("netstat.exe", ["-ano", "-p", "tcp"]));
    const pids = new Set<number>();
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0].toUpperCase() !== "TCP") continue;
      const local = parts[1] || "";
      const pid = Number(parts[4]);
      if (parts[3].toUpperCase() === "LISTENING" && local.endsWith(`:${port}`) && isManagedPid(pid)) {
        pids.add(pid);
      }
    }
    return [...pids];
  }
  const result = run("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"]);
  if (result.status === null) throw new Error("startup_port_listener_discovery_failed");
  if (result.status !== 0 || !result.stdout.trim()) return [];
  return [...new Set(result.stdout.split(/\s+/).map(Number).filter(isManagedPid))];
}

export function terminatePlatformProcessTree(
  pid: number,
  signal: ProcessSignal,
  {
    platform = process.platform,
    selfPid = process.pid,
    run = runPlatformCommand,
    inspect = (targetPid: number) => inspectManagedProcess(targetPid, { selfPid }),
  }: {
    platform?: string;
    selfPid?: number;
    run?: PlatformCommandRunner;
    inspect?: (pid: number) => ReturnType<typeof inspectManagedProcess>;
  } = {},
): ManagedSignalResult {
  if (!isManagedPid(pid)) return "invalid";
  if (pid === selfPid) return "self";
  if (platform !== "win32") return signalManagedProcess(pid, signal, { selfPid });

  const state = inspect(pid);
  if (state === "exited" || state === "invalid") return "already-exited";
  if (state === "permission-denied") return "permission-denied";
  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") args.push("/F");
  const result = run("taskkill.exe", args);
  if (result.status === 0) return "sent";

  const after = inspect(pid);
  if (after === "exited" || after === "invalid") return "already-exited";
  if (after === "permission-denied") return "permission-denied";
  if (signal !== "SIGKILL") return "failed";
  throw new Error("startup_process_tree_termination_failed");
}

export function launchAgentCleanupArguments(
  port: string,
  {
    platform = process.platform,
    homeDirectory = os.homedir(),
  }: { platform?: string; homeDirectory?: string } = {},
): string[] {
  if (platform !== "darwin") return [];
  const launchAgents = path.join(homeDirectory, "Library", "LaunchAgents");
  const labels = [
    `dev.meshrix.server.${port}`,
    "dev.meshrix.background-supervisor",
    "dev.meshrix.system-inspection",
  ];
  const plists = labels.map((label) => path.join(launchAgents, `${label}.plist`));
  return [
    ...labels.flatMap((label) => ["--launch-label", label]),
    ...plists.flatMap((plist) => ["--launch-plist", plist]),
  ];
}

export function currentMacUserId(platform = process.platform): number {
  if (platform !== "darwin" || typeof process.getuid !== "function") {
    throw new Error("macos_user_identity_unavailable");
  }
  return process.getuid();
}

export function bootoutMacLaunchService(
  args: readonly string[],
  { platform = process.platform, run = runPlatformCommand }: { platform?: string; run?: PlatformCommandRunner } = {},
): void {
  if (platform !== "darwin") return;
  run("launchctl", args);
}

export function openPlatformBrowser(
  url: string,
  { platform = process.platform, spawnProcess = spawn }: { platform?: string; spawnProcess?: typeof spawn } = {},
): void {
  const executable = platform === "darwin" ? "open" : platform === "win32" ? "explorer.exe" : "xdg-open";
  const opener = spawnProcess(executable, [url], { detached: true, stdio: "ignore", windowsHide: true });
  opener.once("error", () => console.warn("[start-all] automatic browser opening failed"));
  opener.unref();
}
