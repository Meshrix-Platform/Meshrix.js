import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

type HostEnvironment = NodeJS.ProcessEnv;

export interface LaunchAgentTargets {
  serviceLabel: string;
  uid: number;
  launchTarget: string;
  serviceTarget: string;
  plistPath: string;
}

interface LaunchAgentTargetOptions {
  serviceLabel?: string;
  defaultServiceLabel?: string;
  uid?: number | string;
  homeDir?: string;
  plistPath?: string;
}

export interface CommandResult {
  code: number;
  signal: string;
  stdout: string;
  stderr: string;
}

type RunCommand = (command: string, args?: string[], options?: { cwd?: string; env?: HostEnvironment }) => Promise<CommandResult>;

interface RecoverLaunchAgentOptions extends LaunchAgentTargetOptions {
  alreadyRunning?: boolean;
  platform?: NodeJS.Platform | string;
  targetsFactory?: (options: LaunchAgentTargetOptions) => LaunchAgentTargets;
  fileExists?: (filePath: string) => boolean | Promise<boolean>;
  launchctlPath?: string;
  runCommand?: RunCommand;
}

export interface LaunchAgentRecoveryResult extends Partial<LaunchAgentTargets> {
  ok: boolean;
  attempted: boolean;
  reason?: string;
  action?: string;
  platform?: string;
  checkedAt: string;
  commands?: Array<{ args: string[]; code: number; signal: string; stderr: string; stdout: string }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function launchAgentTargets({
  serviceLabel = "",
  defaultServiceLabel = "",
  uid,
  homeDir = os.homedir(),
  plistPath = ""
}: LaunchAgentTargetOptions = {}): LaunchAgentTargets {
  const resolvedDefault = String(defaultServiceLabel || serviceLabel);
  const resolvedServiceLabel = String(serviceLabel || resolvedDefault).trim() || resolvedDefault;
  const resolvedUid = Number.isInteger(Number(uid))
    ? Number(uid)
    : typeof process.getuid === "function"
      ? process.getuid()
      : 0;
  const resolvedPlistPath = path.resolve(
    String(plistPath || path.join(homeDir, "Library", "LaunchAgents", `${resolvedServiceLabel}.plist`))
  );
  const launchTarget = `gui/${resolvedUid}`;
  const serviceTarget = `${launchTarget}/${resolvedServiceLabel}`;
  return {
    serviceLabel: resolvedServiceLabel,
    uid: resolvedUid,
    launchTarget,
    serviceTarget,
    plistPath: resolvedPlistPath
  };
}

export function defaultRunCommand(command: string, args: string[] = [], options: { cwd?: string; env?: HostEnvironment } = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code: code || 0, signal: signal || "", stdout, stderr });
    });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function commandSummary(item: { args: string[]; result: CommandResult }) {
  return {
    args: item.args,
    code: item.result?.code ?? 0,
    signal: item.result?.signal || "",
    stderr: String(item.result?.stderr || "").trim(),
    stdout: String(item.result?.stdout || "").trim()
  };
}

function isAlreadyLoaded(result: CommandResult): boolean {
  const text = `${result.stderr || ""}\n${result.stdout || ""}`;
  return /already\s+(?:bootstrapped|loaded|exists)|Bootstrap failed:\s*5/i.test(text);
}

export async function recoverLaunchAgentService(options: RecoverLaunchAgentOptions = {}): Promise<LaunchAgentRecoveryResult> {
  const checkedAt = nowIso();
  if (options.alreadyRunning) {
    return {
      ok: true,
      attempted: false,
      reason: "already_running",
      checkedAt
    };
  }

  const platform = String(options.platform || process.platform);
  if (platform !== "darwin") {
    return {
      ok: false,
      attempted: false,
      reason: "unsupported_platform",
      platform,
      checkedAt
    };
  }

  const targetsFactory = options.targetsFactory || launchAgentTargets;
  const targets = targetsFactory(options);
  const exists = typeof options.fileExists === "function"
    ? await options.fileExists(targets.plistPath)
    : await fileExists(targets.plistPath);
  if (!exists) {
    return {
      ok: false,
      attempted: false,
      reason: "plist_missing",
      ...targets,
      checkedAt
    };
  }

  const launchctlPath = options.launchctlPath || "/bin/launchctl";
  const runCommand = options.runCommand || defaultRunCommand;
  const commands: Array<{ args: string[]; result: CommandResult }> = [];

  async function runLaunchctl(args: string[]): Promise<CommandResult> {
    const result = await runCommand(launchctlPath, args);
    commands.push({ args, result });
    return result;
  }

  const kickstart = await runLaunchctl(["kickstart", "-k", targets.serviceTarget]);
  if (kickstart.code === 0) {
    return {
      ok: true,
      attempted: true,
      action: "kickstart",
      ...targets,
      checkedAt,
      commands: commands.map(commandSummary)
    };
  }

  const bootstrap = await runLaunchctl(["bootstrap", targets.launchTarget, targets.plistPath]);
  if (bootstrap.code !== 0 && !isAlreadyLoaded(bootstrap)) {
    return {
      ok: false,
      attempted: true,
      reason: "bootstrap_failed",
      ...targets,
      checkedAt,
      commands: commands.map(commandSummary)
    };
  }

  const retryKickstart = await runLaunchctl(["kickstart", "-k", targets.serviceTarget]);
  return {
    ok: retryKickstart.code === 0,
    attempted: true,
    action: retryKickstart.code === 0 ? "bootstrap_then_kickstart" : "kickstart_failed",
    reason: retryKickstart.code === 0 ? "" : "kickstart_failed",
    ...targets,
    checkedAt,
    commands: commands.map(commandSummary)
  };
}
