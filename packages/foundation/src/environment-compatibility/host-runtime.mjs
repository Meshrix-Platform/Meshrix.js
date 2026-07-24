import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function text(value) {
  return String(value ?? "").trim();
}

export function hostPlatformKey({ platform = process.platform, arch = process.arch } = {}) {
  return `${platform}-${arch}`;
}

export function platformTargetKey({ platform = process.platform, arch = process.arch } = {}) {
  const os = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows"
  }[platform] || platform;
  const cpu = {
    arm64: "aarch64",
    x64: "x86_64"
  }[arch] || arch;
  return `${os}-${cpu}`;
}

export function windowsExecutableSuffix({ platform = process.platform } = {}) {
  return platform === "win32" ? ".exe" : "";
}

export function safePath(value = "") {
  const candidate = text(value);
  return candidate ? path.resolve(candidate) : "";
}

export function pathExists(targetPath = "") {
  if (!targetPath) return false;
  try {
    fsSync.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function executableExists(targetPath = "") {
  if (!targetPath) return false;
  try {
    fsSync.accessSync(targetPath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function shellQuote(value = "") {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function pathEntries(env = process.env) {
  return text(env.PATH)
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function defaultLocalBinEntries({
  cwd = process.cwd(),
  localBinDirs = [],
  includeDefaultLocalBin = true
} = {}) {
  const entries = [
    ...(Array.isArray(localBinDirs) ? localBinDirs : []),
    ...(includeDefaultLocalBin === false ? [] : [path.join(text(cwd) || process.cwd(), "node_modules", ".bin")])
  ];
  return [...new Set(entries.map(text).filter(Boolean))];
}

export function commandPath(commandName = "", options = {}) {
  const command = text(commandName);
  if (!command) return "";
  const platform = options.platform || process.platform;
  const spawnSyncFn = options.spawnSync || spawnSync;
  const result = platform === "win32"
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

export function commandAvailable(commandName = "", options = {}) {
  return Boolean(commandPath(commandName, options));
}

export function resolveCommandCandidate(commandNames = [], options = {}) {
  const names = [...new Set((Array.isArray(commandNames) ? commandNames : [commandNames]).map(text).filter(Boolean))];
  const platform = options.platform || process.platform;
  const executableExistsFn = options.executableExistsFn || executableExists;
  for (const name of names) {
    if (path.isAbsolute(name) || name.includes(path.sep)) {
      if (executableExistsFn(name)) {
        return { found: true, command: name, path: name };
      }
      continue;
    }
    const suffixes = platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
    const searchDirs = [...new Set([
      ...pathEntries(options.env || process.env),
      ...defaultLocalBinEntries(options)
    ])];
    for (const dir of searchDirs) {
      for (const suffix of suffixes) {
        const candidate = path.join(dir, `${name}${suffix}`);
        if (executableExistsFn(candidate)) {
          return { found: true, command: name, path: candidate };
        }
      }
    }
  }
  return { found: false, command: names[0] || "", path: "" };
}

export function runCommand(command, args = [], options = {}) {
  const spawnSyncFn = options.spawnSync || spawnSync;
  return spawnSyncFn(command, args, {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 1024 * 1024 * 12,
    timeout: options.timeoutMs || 600000
  });
}

function firstOutputLine(result = {}) {
  return text([result.stdout, result.stderr].filter(Boolean).join("\n")).split(/\r?\n/)[0] || "";
}

export function commandVersion(command, args = ["--version"], options = {}) {
  const executablePath = commandPath(command, options);
  if (!executablePath) {
    return "";
  }
  return firstOutputLine(runCommand(executablePath, args, { ...options, timeoutMs: options.timeoutMs || 5000 }));
}

export function executableCommandVersion(executablePath = "", args = ["--version"], options = {}) {
  const candidate = text(executablePath);
  if (!candidate || !(executableExists(candidate) || pathExists(candidate))) {
    return "";
  }
  return firstOutputLine(runCommand(candidate, args, { ...options, timeoutMs: options.timeoutMs || 5000 }));
}

export function executableVersion(executablePath = "", args = ["--version"], options = {}) {
  const candidate = text(executablePath);
  if (!candidate || !executableExists(candidate)) return "";
  return firstOutputLine(runCommand(candidate, args, { ...options, timeoutMs: options.timeoutMs || 5000 }));
}

export function parseJavaMajor(versionOutput = "") {
  const output = String(versionOutput || "");
  const quoted = output.match(/version\s+"([^"]+)"/i)?.[1] || "";
  const version = quoted || output.match(/(?:openjdk|java)\s+([0-9][^\s"]*)/i)?.[1] || "";
  const majorText = version.startsWith("1.")
    ? version.split(".")[1]
    : version.split(/[._+-]/)[0];
  const major = Number(majorText || 0);
  return Number.isFinite(major) ? major : 0;
}

export function parseNodeMajor(versionOutput = "") {
  const match = String(versionOutput || "").match(/v?(\d+)(?:\.|$)/);
  const major = Number(match?.[1] || 0);
  return Number.isFinite(major) ? major : 0;
}

export function parsePythonVersion(versionOutput = "") {
  const match = String(versionOutput || "").match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  return {
    major: Number(match?.[1] || 0),
    minor: Number(match?.[2] || 0),
    patch: Number(match?.[3] || 0)
  };
}

export function pythonVersionMeets(versionOutput = "", { minMajor = 3, minMinor = 10 } = {}) {
  const version = parsePythonVersion(versionOutput);
  return version.major > minMajor ||
    (version.major === minMajor && version.minor >= minMinor);
}

export function nodeVersionMeets(versionOutput = "", { minMajor = 22 } = {}) {
  return parseNodeMajor(versionOutput) >= minMajor;
}

export function javaVersionMeets(versionOutput = "", { minMajor = 21 } = {}) {
  return parseJavaMajor(versionOutput) >= minMajor;
}

export function runtimeExecutable(root = "", executableName = "", { platform = process.platform } = {}) {
  return platform === "win32"
    ? path.join(root, "Scripts", `${executableName}.exe`)
    : path.join(root, "bin", executableName);
}

export function privilegedCommand(command, args = [], options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    return { command, args };
  }
  const getuid = options.getuid || (typeof process.getuid === "function" ? process.getuid.bind(process) : null);
  if (typeof getuid === "function" && getuid() === 0) {
    return { command, args };
  }
  const commandPathFn = options.commandPathFn || commandPath;
  if (commandPathFn("sudo")) {
    return { command: "sudo", args: ["-n", command, ...args] };
  }
  return { command, args };
}

export function nativePythonInstallPlans(options = {}) {
  const platform = options.platform || process.platform;
  if (options.disableNativeRuntimeInstall === true || process.env.MESHRIX_DISABLE_NATIVE_RUNTIME_INSTALL === "1") {
    return [];
  }
  const commandPathFn = options.commandPathFn || commandPath;
  const privileged = (command, args) => privilegedCommand(command, args, { ...options, commandPathFn, platform });
  if (platform === "darwin" && commandPathFn("brew")) {
    return [{ label: "Homebrew python@3.12", commands: [{ command: "brew", args: ["install", "python@3.12"] }] }];
  }
  if (platform === "linux") {
    const plans = [];
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

export function nativeNodeInstallerToolPlans(options = {}) {
  const platform = options.platform || process.platform;
  if (options.disableNativeRuntimeInstall === true || process.env.MESHRIX_DISABLE_NATIVE_RUNTIME_INSTALL === "1") {
    return [];
  }
  const commandPathFn = options.commandPathFn || commandPath;
  if (commandPathFn("curl") || commandPathFn("wget") || commandPathFn("git")) {
    return [];
  }
  const privileged = (command, args) => privilegedCommand(command, args, { ...options, commandPathFn, platform });
  if (platform === "darwin" && commandPathFn("brew")) {
    return [{ label: "Homebrew curl", commands: [{ command: "brew", args: ["install", "curl"] }] }];
  }
  if (platform === "linux") {
    const plans = [];
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
} = {}) {
  const normalizedPackageName = text(packageName);
  const labelName = text(labelPrefix || normalizedPackageName);
  if (!normalizedPackageName || disableNativeRuntimeInstall) {
    return [];
  }
  const privileged = (command, args) => privilegedCommand(command, args, { platform, commandPathFn });
  if (platform === "darwin") {
    return commandPathFn("brew")
      ? [{ label: `Homebrew ${labelName}`, command: "brew", args: ["install", text(darwinPackageName || normalizedPackageName)] }]
      : [];
  }
  if (platform === "linux") {
    const plans = [];
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

export function macosVersionInfo(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "darwin") {
    return {
      productName: "",
      productVersion: "",
      buildVersion: "",
      label: ""
    };
  }
  const pathExistsFn = options.pathExistsFn || pathExists;
  const commandPathFn = options.commandPathFn || commandPath;
  const runCommandFn = options.runCommandFn || runCommand;
  const swVersPath = commandPathFn("sw_vers");
  if (!swVersPath) {
    return {
      productName: "macOS",
      productVersion: "",
      buildVersion: "",
      label: "macOS"
    };
  }
  const result = runCommandFn(swVersPath, [], { timeoutMs: 3000 });
  if (result.status !== 0) {
    return {
      productName: "macOS",
      productVersion: "",
      buildVersion: "",
      label: "macOS"
    };
  }
  const fields = new Map(
    text(result.stdout)
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf(":");
        return separator >= 0
          ? [text(line.slice(0, separator)), text(line.slice(separator + 1))]
          : ["", ""];
      })
      .filter(([key]) => key)
  );
  const productName = fields.get("ProductName") || "macOS";
  const productVersion = fields.get("ProductVersion") || "";
  const buildVersion = fields.get("BuildVersion") || "";
  return {
    productName,
    productVersion,
    buildVersion,
    label: [productName, productVersion].filter(Boolean).join(" ") || "macOS"
  };
}
