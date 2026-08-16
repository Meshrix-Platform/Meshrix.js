import fsSync from "node:fs";
import path from "node:path";
import {
  commandAvailable
} from "./host-runtime.ts";

type CommandAvailable = (command: string) => boolean;
type HostEnvironment = Readonly<Record<string, string | undefined>>;

interface LinuxSecretBackendOptions {
  platform?: NodeJS.Platform | string;
  includeSystemdCredentials?: boolean;
  commandAvailableFn?: CommandAvailable;
}

interface ResolveSecretBackendOptions extends LinuxSecretBackendOptions {
  backend?: string;
  linuxCandidates?: (options?: LinuxSecretBackendOptions) => string[];
  darwinBackend?: string;
  windowsBackend?: string;
}

interface WindowsDpapiOptions {
  env?: HostEnvironment;
  commandAvailableFn?: CommandAvailable;
}

function text(value?: unknown): string {
  return String(value ?? "").trim();
}

export function linuxSecretBackendCandidates({
  platform = process.platform,
  includeSystemdCredentials = false,
  commandAvailableFn = commandAvailable
}: LinuxSecretBackendOptions = {}): string[] {
  if (platform !== "linux") {
    return [];
  }
  const candidates: string[] = [];
  if (includeSystemdCredentials && (commandAvailableFn("systemd-creds") || commandAvailableFn("systemd-cryptenroll"))) {
    candidates.push("systemd-credentials");
  }
  if (commandAvailableFn("keyctl")) {
    candidates.push("linux-kernel-keyring");
  }
  if (commandAvailableFn("secret-tool")) {
    candidates.push("secret-service");
  }
  if (commandAvailableFn("pass")) {
    candidates.push("pass-gpg");
  }
  candidates.push("local-file");
  return candidates;
}

export function resolveAutoHostSecretBackend({
  backend = "auto",
  platform = process.platform,
  linuxCandidates = linuxSecretBackendCandidates,
  commandAvailableFn = commandAvailable,
  darwinBackend = "macos-keychain",
  windowsBackend = "windows-dpapi"
}: ResolveSecretBackendOptions = {}): string {
  const normalized = text(backend || "auto");
  if (normalized !== "auto") {
    return normalized;
  }
  if (platform === "darwin") {
    return darwinBackend;
  }
  if (platform === "linux") {
    return linuxCandidates({ platform, commandAvailableFn })[0] || "local-file";
  }
  if (platform === "win32") {
    return commandAvailableFn("powershell.exe") || commandAvailableFn("pwsh") ? windowsBackend : "local-file";
  }
  return "local-file";
}

export function windowsDpapiCommand({
  env = process.env,
  commandAvailableFn = commandAvailable
}: WindowsDpapiOptions = {}): string {
  const configured = text(env.MESHRIX_WINDOWS_DPAPI_COMMAND);
  if (configured) {
    return configured;
  }
  if (commandAvailableFn("powershell.exe")) {
    return "powershell.exe";
  }
  if (commandAvailableFn("pwsh")) {
    return "pwsh";
  }
  return "";
}

export function commandExistsInPath(command: unknown = "", { env = process.env }: { env?: HostEnvironment } = {}): boolean {
  const executable = text(command);
  if (!executable) {
    return false;
  }
  const suffixes = process.platform === "win32" && !/\.(?:exe|cmd|bat)$/i.test(executable)
    ? ["", ".exe", ".cmd", ".bat"]
    : [""];
  for (const dir of text(env.PATH).split(path.delimiter).map(text).filter(Boolean)) {
    for (const suffix of suffixes) {
      try {
        fsSync.accessSync(path.join(dir, `${executable}${suffix}`), fsSync.constants.X_OK);
        return true;
      } catch {
        // Keep scanning PATH.
      }
    }
  }
  return false;
}
