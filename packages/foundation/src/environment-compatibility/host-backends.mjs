import fsSync from "node:fs";
import path from "node:path";
import {
  commandAvailable
} from "./host-runtime.mjs";

function text(value) {
  return String(value ?? "").trim();
}

export function linuxSecretBackendCandidates({
  platform = process.platform,
  includeSystemdCredentials = false,
  commandAvailableFn = commandAvailable
} = {}) {
  if (platform !== "linux") {
    return [];
  }
  const candidates = [];
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
} = {}) {
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
} = {}) {
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

export function commandExistsInPath(command = "", { env = process.env } = {}) {
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
