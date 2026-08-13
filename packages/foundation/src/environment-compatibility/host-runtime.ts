import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function text(value?: any) : any {
  return String(value ?? "").trim();
}

export function hostPlatformKey({ platform = process.platform, arch = process.arch }: Record<string, any> = {}) : any {
  return `${platform}-${arch}`;
}

export function platformTargetKey({ platform = process.platform, arch = process.arch }: Record<string, any> = {}) : any {
  const os: any = ({
    darwin: "darwin",
    linux: "linux",
    win32: "windows"
  } as Record<string, any>)[platform] || platform;
  const cpu: any = ({
    arm64: "aarch64",
    x64: "x86_64"
  } as Record<string, any>)[arch] || arch;
  return `${os}-${cpu}`;
}

export function windowsExecutableSuffix({ platform = process.platform }: Record<string, any> = {}) : any {
  return platform === "win32" ? ".exe" : "";
}

export function safePath(value: any = "") : any {
  const candidate: any = text(value);
  return candidate ? path.resolve(candidate) : "";
}

export function pathExists(targetPath: any = "") : any {
  if (!targetPath) return false;
  try {
    fsSync.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function executableExists(targetPath: any = "") : any {
  if (!targetPath) return false;
  try {
    fsSync.accessSync(targetPath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function shellQuote(value: any = "") : any {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function pathEntries(env: any = process.env) : any {
  return text(env.PATH)
    .split(path.delimiter)
    .map((entry?: any) : any => entry.trim())
    .filter(Boolean);
}

export function defaultLocalBinEntries({
  cwd = process.cwd(),
  localBinDirs = [],
  includeDefaultLocalBin = true
}: Record<string, any> = {}) : any {
  const entries: any[] = [
    ...(Array.isArray(localBinDirs) ? localBinDirs : []),
    ...(includeDefaultLocalBin === false ? [] : [path.join(text(cwd) || process.cwd(), "node_modules", ".bin")])
  ];
  return [...new Set<any>(entries.map(text).filter(Boolean))];
}

export function commandPath(commandName: any = "", options: Record<string, any> = {}) : any {
  const command: any = text(commandName);
  if (!command) return "";
  const platform: any = options.platform || process.platform;
  const spawnSyncFn: any = options.spawnSync || spawnSync;
  const result: any = platform === "win32"
    ? spawnSyncFn("where", [command], {
        encoding: "utf8",
        timeout: options.timeoutMs || 3000
      })
    : spawnSyncFn("sh", ["-c", `command -v ${shellQuote(command)}`], {
        encoding: "utf8",
        timeout: options.timeoutMs || 3000
      });
  if (result.status !== 0) {
    return "";
  }
  return text(result.stdout).split(/\r?\n/).map(text).find(Boolean) || "";
}

export function commandAvailable(commandName: any = "", options: Record<string, any> = {}) : any {
  return Boolean(commandPath(commandName, options));
}

export function resolveCommandCandidate(commandNames: any = [], options: Record<string, any> = {}) : any {
  const names: any[] = [...new Set<any>((Array.isArray(commandNames) ? commandNames : [commandNames]).map(text).filter(Boolean))];
  const platform: any = options.platform || process.platform;
  const executableExistsFn: any = options.executableExistsFn || executableExists;
  for (const name of names) {
    if (path.isAbsolute(name) || name.includes(path.sep)) {
      if (executableExistsFn(name)) {
        return { found: true, command: name, path: name };
      }
      continue;
    }
    const suffixes: any = platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
    const searchDirs: any[] = [...new Set<any>([
      ...pathEntries(options.env || process.env),
      ...defaultLocalBinEntries(options)
    ])];
    for (const dir of searchDirs) {
      for (const suffix of suffixes) {
        const candidate: any = path.join(dir, `${name}${suffix}`);
        if (executableExistsFn(candidate)) {
          return { found: true, command: name, path: candidate };
        }
      }
    }
  }
  return { found: false, command: names[0] || "", path: "" };
}

export function runCommand(command?: any, args: any = [], options: Record<string, any> = {}) : any {
  const spawnSyncFn: any = options.spawnSync || spawnSync;
  return spawnSyncFn(command, args, {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 1024 * 1024 * 12,
    timeout: options.timeoutMs || 600000
  });
}

function firstOutputLine(result: Record<string, any> = {}) : any {
  return text([result.stdout, result.stderr].filter(Boolean).join("\n")).split(/\r?\n/)[0] || "";
}

export function commandVersion(command?: any, args: any = ["--version"], options: Record<string, any> = {}) : any {
  const executablePath: any = commandPath(command, options);
  if (!executablePath) {
    return "";
  }
  return firstOutputLine(runCommand(executablePath, args, { ...options, timeoutMs: options.timeoutMs || 5000 }));
}

export function executableCommandVersion(executablePath: any = "", args: any = ["--version"], options: Record<string, any> = {}) : any {
  const candidate: any = text(executablePath);
  if (!candidate || !(executableExists(candidate) || pathExists(candidate))) {
    return "";
  }
  return firstOutputLine(runCommand(candidate, args, { ...options, timeoutMs: options.timeoutMs || 5000 }));
}

export function executableVersion(executablePath: any = "", args: any = ["--version"], options: Record<string, any> = {}) : any {
  const candidate: any = text(executablePath);
  if (!candidate || !executableExists(candidate)) return "";
  return firstOutputLine(runCommand(candidate, args, { ...options, timeoutMs: options.timeoutMs || 5000 }));
}

export function parseJavaMajor(versionOutput: any = "") : any {
  const output: any = String(versionOutput || "");
  const quoted: any = output.match(/version\s+"([^"]+)"/i)?.[1] || "";
  const version: any = quoted || output.match(/(?:openjdk|java)\s+([0-9][^\s"]*)/i)?.[1] || "";
  const majorText: any = version.startsWith("1.")
    ? version.split(".")[1]
    : version.split(/[._+-]/)[0];
  const major: any = Number(majorText || 0);
  return Number.isFinite(major) ? major : 0;
}

export function parseNodeMajor(versionOutput: any = "") : any {
  const match: any = String(versionOutput || "").match(/v?(\d+)(?:\.|$)/);
  const major: any = Number(match?.[1] || 0);
  return Number.isFinite(major) ? major : 0;
}

export function parsePythonVersion(versionOutput: any = "") : any {
  const match: any = String(versionOutput || "").match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  return {
    major: Number(match?.[1] || 0),
    minor: Number(match?.[2] || 0),
    patch: Number(match?.[3] || 0)
  };
}

export function pythonVersionMeets(versionOutput: any = "", { minMajor = 3, minMinor = 10 }: Record<string, any> = {}) : any {
  const version: any = parsePythonVersion(versionOutput);
  return version.major > minMajor ||
    (version.major === minMajor && version.minor >= minMinor);
}

export function nodeVersionMeets(versionOutput: any = "", { minMajor = 22 }: Record<string, any> = {}) : any {
  return parseNodeMajor(versionOutput) >= minMajor;
}

export function javaVersionMeets(versionOutput: any = "", { minMajor = 21 }: Record<string, any> = {}) : any {
  return parseJavaMajor(versionOutput) >= minMajor;
}

export function runtimeExecutable(root: any = "", executableName: any = "", { platform = process.platform }: Record<string, any> = {}) : any {
  return platform === "win32"
    ? path.join(root, "Scripts", `${executableName}.exe`)
    : path.join(root, "bin", executableName);
}

export function privilegedCommand(command?: any, args: any = [], options: Record<string, any> = {}) : any {
  const platform: any = options.platform || process.platform;
  if (platform === "win32") {
    return { command, args };
  }
  const getuid: any = options.getuid || (typeof process.getuid === "function" ? process.getuid.bind(process) : null);
  if (typeof getuid === "function" && getuid() === 0) {
    return { command, args };
  }
  const commandPathFn: any = options.commandPathFn || commandPath;
  if (commandPathFn("sudo")) {
    return { command: "sudo", args: ["-n", command, ...args] };
  }
  return { command, args };
}

export function nativePythonInstallPlans(options: Record<string, any> = {}) : any {
  const platform: any = options.platform || process.platform;
  if (options.disableNativeRuntimeInstall === true || process.env.MESHRIX_DISABLE_NATIVE_RUNTIME_INSTALL === "1") {
    return [];
  }
  const commandPathFn: any = options.commandPathFn || commandPath;
  const privileged: any = (command?: any, args?: any) : any => privilegedCommand(command, args, { ...options, commandPathFn, platform });
  if (platform === "darwin" && commandPathFn("brew")) {
    return [{ label: "Homebrew python@3.12", commands: [{ command: "brew", args: ["install", "python@3.12"] }] }];
  }
  if (platform === "linux") {
    const plans: any[] = [];
    if (commandPathFn("apt-get")) {
      plans.push({
        label: "apt python3-venv",
        commands: [
          privileged("apt-get", ["update"]),
          privileged("apt-get", ["install", "-y", "--no-install-recommends", "python3", "python3-venv", "python3-pip"])
        ]
      });
    }
    if (commandPathFn("dnf")) plans.push({ label: "dnf python3", commands: [privileged("dnf", ["install", "-y", "python3", "python3-pip"])] });
    if (commandPathFn("yum")) plans.push({ label: "yum python3", commands: [privileged("yum", ["install", "-y", "python3", "python3-pip"])] });
    if (commandPathFn("apk")) plans.push({ label: "apk python3", commands: [privileged("apk", ["add", "--no-cache", "python3", "py3-pip"])] });
    if (commandPathFn("pacman")) plans.push({ label: "pacman python", commands: [privileged("pacman", ["-Sy", "--noconfirm", "python"])] });
    if (commandPathFn("zypper")) plans.push({ label: "zypper python3", commands: [privileged("zypper", ["--non-interactive", "install", "python3", "python3-pip"])] });
    return plans;
  }
  if (platform === "win32") {
    return [
      commandPathFn("winget") ? { label: "winget Python 3.12", commands: [{ command: "winget", args: ["install", "--id", "Python.Python.3.12", "-e", "--accept-package-agreements", "--accept-source-agreements"] }] } : null,
      commandPathFn("choco") ? { label: "Chocolatey python", commands: [{ command: "choco", args: ["install", "-y", "python"] }] } : null,
      commandPathFn("scoop") ? { label: "Scoop python", commands: [{ command: "scoop", args: ["install", "python"] }] } : null
    ].filter(Boolean);
  }
  return [];
}

export function nativeNodeInstallerToolPlans(options: Record<string, any> = {}) : any {
  const platform: any = options.platform || process.platform;
  if (options.disableNativeRuntimeInstall === true || process.env.MESHRIX_DISABLE_NATIVE_RUNTIME_INSTALL === "1") {
    return [];
  }
  const commandPathFn: any = options.commandPathFn || commandPath;
  if (commandPathFn("curl") || commandPathFn("wget") || commandPathFn("git")) {
    return [];
  }
  const privileged: any = (command?: any, args?: any) : any => privilegedCommand(command, args, { ...options, commandPathFn, platform });
  if (platform === "darwin" && commandPathFn("brew")) {
    return [{ label: "Homebrew curl", commands: [{ command: "brew", args: ["install", "curl"] }] }];
  }
  if (platform === "linux") {
    const plans: any[] = [];
    if (commandPathFn("apt-get")) {
      plans.push({
        label: "apt curl",
        commands: [
          privileged("apt-get", ["update"]),
          privileged("apt-get", ["install", "-y", "--no-install-recommends", "ca-certificates", "curl"])
        ]
      });
    }
    if (commandPathFn("dnf")) plans.push({ label: "dnf curl", commands: [privileged("dnf", ["install", "-y", "ca-certificates", "curl"])] });
    if (commandPathFn("yum")) plans.push({ label: "yum curl", commands: [privileged("yum", ["install", "-y", "ca-certificates", "curl"])] });
    if (commandPathFn("apk")) plans.push({ label: "apk curl", commands: [privileged("apk", ["add", "--no-cache", "ca-certificates", "curl", "bash"])] });
    if (commandPathFn("pacman")) plans.push({ label: "pacman curl", commands: [privileged("pacman", ["-Sy", "--noconfirm", "ca-certificates", "curl"])] });
    if (commandPathFn("zypper")) plans.push({ label: "zypper curl", commands: [privileged("zypper", ["--non-interactive", "install", "ca-certificates", "curl"])] });
    return plans;
  }
  if (platform === "win32") {
    return [
      commandPathFn("winget") ? { label: "winget Git", commands: [{ command: "winget", args: ["install", "--id", "Git.Git", "-e", "--accept-package-agreements", "--accept-source-agreements"] }] } : null,
      commandPathFn("choco") ? { label: "Chocolatey curl", commands: [{ command: "choco", args: ["install", "-y", "curl"] }] } : null,
      commandPathFn("scoop") ? { label: "Scoop curl", commands: [{ command: "scoop", args: ["install", "curl"] }] } : null
    ].filter(Boolean);
  }
  return [];
}

export function nativeHostPackageInstallPlans({
  packageName = "",
  platform = process.platform,
  disableNativeRuntimeInstall = process.env.MESHRIX_DISABLE_NATIVE_RUNTIME_INSTALL === "1",
  commandPathFn = commandPath,
  darwinPackageName = packageName,
  aptPackageName = packageName,
  dnfPackageName = packageName,
  yumPackageName = packageName,
  apkPackageName = packageName,
  pacmanPackageName = packageName,
  zypperPackageName = packageName,
  wingetId = "",
  chocoPackageName = packageName,
  scoopPackageName = packageName,
  labelPrefix = ""
}: Record<string, any> = {}) : any {
  const normalizedPackageName: any = text(packageName);
  const labelName: any = text(labelPrefix || normalizedPackageName);
  if (!normalizedPackageName || disableNativeRuntimeInstall) {
    return [];
  }
  const privileged: any = (command?: any, args?: any) : any => privilegedCommand(command, args, { platform, commandPathFn });
  if (platform === "darwin") {
    return commandPathFn("brew")
      ? [{ label: `Homebrew ${labelName}`, command: "brew", args: ["install", text(darwinPackageName || normalizedPackageName)] }]
      : [];
  }
  if (platform === "linux") {
    const plans: any[] = [];
    if (commandPathFn("apt-get")) {
      plans.push({
        label: `apt ${labelName}`,
        commands: [
          privileged("apt-get", ["update"]),
          privileged("apt-get", ["install", "-y", "--no-install-recommends", text(aptPackageName || normalizedPackageName)])
        ]
      });
    }
    if (commandPathFn("dnf")) plans.push({ label: `dnf ${labelName}`, commands: [privileged("dnf", ["install", "-y", text(dnfPackageName || normalizedPackageName)])] });
    if (commandPathFn("yum")) plans.push({ label: `yum ${labelName}`, commands: [privileged("yum", ["install", "-y", text(yumPackageName || normalizedPackageName)])] });
    if (commandPathFn("apk")) plans.push({ label: `apk ${labelName}`, commands: [privileged("apk", ["add", "--no-cache", text(apkPackageName || normalizedPackageName)])] });
    if (commandPathFn("pacman")) plans.push({ label: `pacman ${labelName}`, commands: [privileged("pacman", ["-Sy", "--noconfirm", text(pacmanPackageName || normalizedPackageName)])] });
    if (commandPathFn("zypper")) plans.push({ label: `zypper ${labelName}`, commands: [privileged("zypper", ["--non-interactive", "install", text(zypperPackageName || normalizedPackageName)])] });
    return plans;
  }
  if (platform === "win32") {
    return [
      wingetId && commandPathFn("winget")
        ? { label: `winget ${labelName}`, command: "winget", args: ["install", "--id", wingetId, "-e", "--accept-package-agreements", "--accept-source-agreements"] }
        : null,
      commandPathFn("choco")
        ? { label: `Chocolatey ${labelName}`, command: "choco", args: ["install", "-y", text(chocoPackageName || normalizedPackageName)] }
        : null,
      commandPathFn("scoop")
        ? { label: `Scoop ${labelName}`, command: "scoop", args: ["install", text(scoopPackageName || normalizedPackageName)] }
        : null
    ].filter(Boolean);
  }
  return [];
}

export function macosVersionInfo(options: Record<string, any> = {}) : any {
  const platform: any = options.platform || process.platform;
  if (platform !== "darwin") {
    return {
      productName: "",
      productVersion: "",
      buildVersion: "",
      label: ""
    };
  }
  const pathExistsFn: any = options.pathExistsFn || pathExists;
  const commandPathFn: any = options.commandPathFn || commandPath;
  const runCommandFn: any = options.runCommandFn || runCommand;
  const swVersPath: any = commandPathFn("sw_vers");
  if (!swVersPath) {
    return {
      productName: "macOS",
      productVersion: "",
      buildVersion: "",
      label: "macOS"
    };
  }
  const result: any = runCommandFn(swVersPath, [], { timeoutMs: 3000 });
  if (result.status !== 0) {
    return {
      productName: "macOS",
      productVersion: "",
      buildVersion: "",
      label: "macOS"
    };
  }
  const fields: any = new Map<any, any>(
    text(result.stdout)
      .split(/\r?\n/)
      .map((line?: any) : any => {
        const separator: any = line.indexOf(":");
        return separator >= 0
          ? [text(line.slice(0, separator)), text(line.slice(separator + 1))]
          : ["", ""];
      })
      .filter(([key]: any[]) : any => key)
  );
  const productName: any = fields.get("ProductName") || "macOS";
  const productVersion: any = fields.get("ProductVersion") || "";
  const buildVersion: any = fields.get("BuildVersion") || "";
  return {
    productName,
    productVersion,
    buildVersion,
    label: [productName, productVersion].filter(Boolean).join(" ") || "macOS"
  };
}
