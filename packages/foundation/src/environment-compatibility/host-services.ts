import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function nowIso() : any {
  return new Date().toISOString();
}

export function launchAgentTargets({
  serviceLabel = "",
  defaultServiceLabel = "",
  uid,
  homeDir = os.homedir(),
  plistPath = ""
}: Record<string, any> = {}) : any {
  const resolvedDefault: any = String(defaultServiceLabel || serviceLabel);
  const resolvedServiceLabel: any = String(serviceLabel || resolvedDefault).trim() || resolvedDefault;
  const resolvedUid: any = Number.isInteger(Number(uid))
    ? Number(uid)
    : typeof process.getuid === "function"
      ? process.getuid()
      : 0;
  const resolvedPlistPath: any = path.resolve(
    String(plistPath || path.join(homeDir, "Library", "LaunchAgents", `${resolvedServiceLabel}.plist`))
  );
  const launchTarget: any = `gui/${resolvedUid}`;
  const serviceTarget: any = `${launchTarget}/${resolvedServiceLabel}`;
  return {
    serviceLabel: resolvedServiceLabel,
    uid: resolvedUid,
    launchTarget,
    serviceTarget,
    plistPath: resolvedPlistPath
  };
}

export function defaultRunCommand(command?: any, args: any = [], options: Record<string, any> = {}) : any {
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env
    });
    let stdout: any = "";
    let stderr: any = "";
    child.stdout?.on("data", (chunk?: any) : any => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk?: any) : any => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code?: any, signal?: any) : any => {
      resolve({ code: code || 0, signal: signal || "", stdout, stderr });
    });
  });
}

async function fileExists(filePath?: any) : Promise<any> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function commandSummary(item?: any) : any {
  return {
    args: item.args,
    code: item.result?.code ?? 0,
    signal: item.result?.signal || "",
    stderr: String(item.result?.stderr || "").trim(),
    stdout: String(item.result?.stdout || "").trim()
  };
}

function isAlreadyLoaded(result: Record<string, any> = {}) : any {
  const text: any = `${result.stderr || ""}\n${result.stdout || ""}`;
  return /already\s+(?:bootstrapped|loaded|exists)|Bootstrap failed:\s*5/i.test(text);
}

export async function recoverLaunchAgentService(options: Record<string, any> = {}) : Promise<any> {
  const checkedAt: any = nowIso();
  if (options.alreadyRunning) {
    return {
      ok: true,
      attempted: false,
      reason: "already_running",
      checkedAt
    };
  }

  const platform: any = String(options.platform || process.platform);
  if (platform !== "darwin") {
    return {
      ok: false,
      attempted: false,
      reason: "unsupported_platform",
      platform,
      checkedAt
    };
  }

  const targetsFactory: any = options.targetsFactory || launchAgentTargets;
  const targets: any = targetsFactory(options);
  const exists: any = typeof options.fileExists === "function"
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

  const launchctlPath: any = options.launchctlPath || "/bin/launchctl";
  const runCommand: any = options.runCommand || defaultRunCommand;
  const commands: any[] = [];

  async function runLaunchctl(args?: any) : Promise<any> {
    const result: any = await runCommand(launchctlPath, args);
    commands.push({ args, result });
    return result;
  }

  const kickstart: any = await runLaunchctl(["kickstart", "-k", targets.serviceTarget]);
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

  const bootstrap: any = await runLaunchctl(["bootstrap", targets.launchTarget, targets.plistPath]);
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

  const retryKickstart: any = await runLaunchctl(["kickstart", "-k", targets.serviceTarget]);
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
