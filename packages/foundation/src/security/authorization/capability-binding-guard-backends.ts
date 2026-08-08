import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  commandExistsInPath as hostCommandExists,
  linuxSecretBackendCandidates,
  resolveAutoHostSecretBackend,
  windowsDpapiCommand as hostWindowsDpapiCommand
} from "../../environment-compatibility/index.ts";
import { writePrivateFileAtomic } from "../../storage/private-file-atomic.ts";
import {
  DEFAULT_ALIAS,
  CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION,
  CAPABILITY_BINDING_GUARD_STATE_VERSION,
  asObject,
  capabilityBindingGuardLocalSealingKeyPath,
  capabilityBindingGuardStatePath,
  normalizeState,
  nowIso,
  openSealedJson,
  parseJson,
  randomBase64,
  resolveDataDir,
  safeAlias,
  sealJson,
  text
} from "./capability-binding-guard-core.ts";

export function keychainService(alias: any = DEFAULT_ALIAS) : any {
  return `com.meshrix.capability-binding-guard.${safeAlias(alias)}`;
}

export async function runText(command?: any, args: any = [], { input = "" }: Record<string, any> = {}) : Promise<any> {
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout: any = "";
    let stderr: any = "";
    child.stdout.on("data", (chunk?: any) : any => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk?: any) : any => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code?: any) : any => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${command} failed with exit code ${code}`));
        return;
      }
      resolve(stdout);
    });
    // A child that exits before consuming input raises EPIPE on the stdin
    // socket; the close handler above already rejects with the real failure.
    child.stdin.on("error", (error?: any) : any => {
      if (error?.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

export function commandExists(command?: any) : any {
  return hostCommandExists(command);
}

export function linuxBindingGuardBackendCandidates() : any {
  return linuxSecretBackendCandidates({ platform: process.platform, commandAvailableFn: commandExists });
}

export function firstUsableLinuxBindingGuardBackend() : any {
  return linuxBindingGuardBackendCandidates()[0] || "local-file";
}

export function resolveAutoBindingGuardBackend(backend: any = "auto") : any {
  return resolveAutoHostSecretBackend({
    backend,
    platform: process.platform,
    linuxCandidates: linuxBindingGuardBackendCandidates,
    commandAvailableFn: commandExists
  });
}

export function windowsDpapiCommand() : any {
  return hostWindowsDpapiCommand({ env: process.env, commandAvailableFn: commandExists });
}

export function windowsDpapiProtectedPath({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : any {
  return path.join(resolveDataDir(dataDir), "security", "capability-binding-guard", `${safeAlias(alias)}.dpapi`);
}

export async function runWindowsDpapi({ action = "protect", input = "" }: Record<string, any> = {}) : Promise<any> {
  const command: any = windowsDpapiCommand();
  if (!command) {
    throw new Error("Windows DPAPI backend requires powershell.exe or pwsh.");
  }
  const protectScript: any = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;
  const unprotectScript: any = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$cipher = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($cipher)
$plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plainBytes))
`;
  return runText(command, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    action === "unprotect" ? unprotectScript : protectScript
  ], { input });
}

export function linuxKeyringDescription(alias: any = DEFAULT_ALIAS) : any {
  return `meshrix:capability-binding-guard:${safeAlias(alias)}`;
}

export function secretToolAttributes(alias: any = DEFAULT_ALIAS) : any {
  return [
    "application",
    "meshrix",
    "component",
    "capability-binding-guard",
    "alias",
    safeAlias(alias)
  ];
}

export function passEntryName(alias: any = DEFAULT_ALIAS) : any {
  return `meshrix/capability-binding-guard/${safeAlias(alias)}`;
}

export function createRecord({ alias = DEFAULT_ALIAS, provider = "local-file", securityMode = "degraded_file_fallback", state = null, sealingKeyBase64 = "" }: Record<string, any> = {}) : any {
  const timestamp: any = nowIso();
  const normalizedState: any = normalizeState(state || {
    provider,
    securityMode,
    bindingLookupKeyBase64: randomBase64(32),
    bindings: [],
    events: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const sealingKey: any = sealingKeyBase64 || randomBase64(32);
  return {
    protocolVersion: CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION,
    alias: safeAlias(alias),
    provider,
    securityMode,
    generation: Number(normalizedState.epoch || 1),
    sealingKeyBase64: sealingKey,
    sealedState: sealJson({ sealingKeyBase64: sealingKey, payload: normalizedState }),
    stateRoot: normalizedState.stateRoot,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export async function readLocalRecord({ dataDir = "", alias = DEFAULT_ALIAS, provider = "local-file", securityMode = "degraded_file_fallback" }: Record<string, any> = {}) : Promise<any> {
  const filePath: any = capabilityBindingGuardStatePath({ dataDir, alias });
  let record: any;
  try {
    record = parseJson(await fs.promises.readFile(filePath, "utf8"), null);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return createRecord({ alias, provider, securityMode });
    }
    throw error;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Capability binding guard record is invalid.");
  }
  if (!record.sealingKeyBase64) {
    try {
      record.sealingKeyBase64 = text(await fs.promises.readFile(
        capabilityBindingGuardLocalSealingKeyPath({ dataDir, alias }),
        "utf8"
      ));
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        throw new Error("Local capability binding fallback requires the current sealing key sidecar.");
      }
      throw error;
    }
  }
  return record;
}

export async function writeLocalRecord({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  const filePath: any = capabilityBindingGuardStatePath({ dataDir, alias });
  const sealingKey: any = text(record.sealingKeyBase64);
  if (!sealingKey) {
    throw new Error("Local capability binding fallback requires a sealing key sidecar.");
  }
  await writePrivateFileAtomic(capabilityBindingGuardLocalSealingKeyPath({ dataDir, alias }), `${sealingKey}\n`);
  const { sealingKeyBase64, ...persistedRecord } = record;
  void sealingKeyBase64;
  await writePrivateFileAtomic(filePath, `${JSON.stringify(persistedRecord, null, 2)}\n`);
  return record;
}

export async function readMacosRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  if (process.platform !== "darwin") {
    throw new Error("macos-keychain capability binding guard backend is only available on macOS.");
  }
  try {
    const raw: any = await runText("security", [
      "find-generic-password",
      "-w",
      "-a",
      "meshrix",
      "-s",
      keychainService(alias)
    ]);
    return parseJson(raw.trim(), null);
  } catch (error: any) {
    if (/could not be found|The specified item could not be found/i.test(error.message)) {
      return createRecord({ alias, provider: "macos-keychain", securityMode: "keyring" });
    }
    throw error;
  }
}

export async function writeMacosRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  if (process.platform !== "darwin") {
    throw new Error("macos-keychain capability binding guard backend is only available on macOS.");
  }
  await runText("security", [
    "add-generic-password",
    "-U",
    "-a",
    "meshrix",
    "-s",
    keychainService(alias),
    "-w",
    JSON.stringify(record)
  ]);
  return record;
}

export async function readLinuxKeyringRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  const description: any = linuxKeyringDescription(alias);
  let serial: any = "";
  try {
    serial = (await runText("keyctl", ["search", "@u", "user", description])).trim();
  } catch (error: any) {
    if (/not found|cannot find|requested key not available|key has been revoked/i.test(error.message)) {
      return createRecord({ alias, provider: "linux-kernel-keyring", securityMode: "keyring" });
    }
    throw error;
  }
  if (!serial) {
    return createRecord({ alias, provider: "linux-kernel-keyring", securityMode: "keyring" });
  }
  const raw: any = await runText("keyctl", ["pipe", serial]);
  return parseJson(raw.trim(), null);
}

export async function writeLinuxKeyringRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  const description: any = linuxKeyringDescription(alias);
  try {
    const serial: any = (await runText("keyctl", ["search", "@u", "user", description])).trim();
    if (serial) {
      await runText("keyctl", ["unlink", serial, "@u"]).catch(() : any => {});
    }
  } catch {
    // Missing existing key is expected on first write.
  }
  await runText("keyctl", ["padd", "user", description, "@u"], { input: JSON.stringify(record) });
  return record;
}

export async function readSecretServiceRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  try {
    const raw: any = await runText("secret-tool", ["lookup", ...secretToolAttributes(alias)]);
    return parseJson(raw.trim(), null);
  } catch (error: any) {
    if (/no such object|not found|couldn't find|cannot autolaunch/i.test(error.message)) {
      return createRecord({ alias, provider: "secret-service", securityMode: "keyring" });
    }
    throw error;
  }
}

export async function writeSecretServiceRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  await runText("secret-tool", [
    "store",
    "--label",
    `Meshrix.js Capability Binding Guard ${safeAlias(alias)}`,
    ...secretToolAttributes(alias)
  ], { input: JSON.stringify(record) });
  return record;
}

export async function readPassRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  try {
    const raw: any = await runText("pass", ["show", passEntryName(alias)]);
    return parseJson(raw.trim(), null);
  } catch (error: any) {
    if (/not in the password store|is not in the password store|No such file|not found/i.test(error.message)) {
      return createRecord({ alias, provider: "pass-gpg", securityMode: "user_keyring" });
    }
    throw error;
  }
}

export async function writePassRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  await runText("pass", ["insert", "-m", "-f", passEntryName(alias)], { input: JSON.stringify(record) });
  return record;
}

export async function readWindowsDpapiRecord({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  const filePath: any = windowsDpapiProtectedPath({ dataDir, alias });
  try {
    const protectedPayload: any = await fs.promises.readFile(filePath, "utf8");
    const raw: any = await runWindowsDpapi({ action: "unprotect", input: protectedPayload });
    return parseJson(raw.trim(), null);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return createRecord({ alias, provider: "windows-dpapi", securityMode: "dpapi" });
    }
    throw error;
  }
}

export async function writeWindowsDpapiRecord({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  const filePath: any = windowsDpapiProtectedPath({ dataDir, alias });
  const protectedPayload: any = await runWindowsDpapi({ action: "protect", input: JSON.stringify(record) });
  await writePrivateFileAtomic(filePath, protectedPayload);
  return record;
}

export function openState(record: Record<string, any> = {}) : any {
  if (record.protocolVersion !== CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION) {
    throw new Error("Unsupported capability binding guard record protocol.");
  }
  if (!text(record.stateRoot)) {
    throw new Error("Capability binding guard record requires the current state root.");
  }
  const opened: any = openSealedJson({
    sealingKeyBase64: record.sealingKeyBase64,
    sealed: record.sealedState
  });
  if (Number(opened.stateVersion) !== CAPABILITY_BINDING_GUARD_STATE_VERSION) {
    throw new Error("Unsupported capability binding guard sealed state version.");
  }
  if (Buffer.from(text(opened.bindingLookupKeyBase64), "base64").length < 32) {
    throw new Error("Capability binding guard sealed state requires a 256-bit lookup key.");
  }
  const state: any = normalizeState({
    ...opened,
    provider: record.provider,
    securityMode: record.securityMode
  });
  if (state.stateRoot !== record.stateRoot) {
    throw new Error("Capability binding guard sealed state root mismatch.");
  }
  return state;
}

export function degradedLocalRecord(record: Record<string, any> = {}, { alias = DEFAULT_ALIAS }: Record<string, any> = {}) : any {
  const state: any = openState(record);
  return {
    ...createRecord({
      alias,
      provider: "local-file",
      securityMode: "degraded_file_fallback",
      state: {
        ...state,
        provider: "local-file",
        securityMode: "degraded_file_fallback"
      },
      sealingKeyBase64: record.sealingKeyBase64
    }),
    createdAt: record.createdAt || nowIso()
  };
}

export function bindingGuardSecurityModeForProvider(provider: any = "") : any {
  if (provider === "linux-kernel-keyring" || provider === "secret-service" || provider === "macos-keychain") {
    return "keyring";
  }
  if (provider === "pass-gpg") {
    return "user_keyring";
  }
  if (provider === "windows-dpapi") {
    return "dpapi";
  }
  return "degraded_file_fallback";
}

export function rewrapBindingRecordForProvider(record: Record<string, any> = {}, { alias = DEFAULT_ALIAS, provider = "local-file" }: Record<string, any> = {}) : any {
  if (provider === "local-file") {
    return degradedLocalRecord(record, { alias });
  }
  const securityMode: any = bindingGuardSecurityModeForProvider(provider);
  const state: any = openState(record);
  return {
    ...createRecord({
      alias,
      provider,
      securityMode,
      state: {
        ...state,
        provider,
        securityMode
      },
      sealingKeyBase64: record.sealingKeyBase64
    }),
    createdAt: record.createdAt || nowIso()
  };
}

export async function readLinuxAutoRecord({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  for (const candidate of linuxBindingGuardBackendCandidates()) {
    try {
      if (candidate === "linux-kernel-keyring") {
        return await readLinuxKeyringRecord({ alias });
      }
      if (candidate === "secret-service") {
        return await readSecretServiceRecord({ alias });
      }
      if (candidate === "pass-gpg") {
        return await readPassRecord({ alias });
      }
      return await readLocalRecord({
        dataDir,
        alias,
        provider: "local-file",
        securityMode: "degraded_file_fallback"
      });
    } catch {
      // Auto mode keeps scanning lower-priority Linux backends before file fallback.
    }
  }
  return readLocalRecord({
    dataDir,
    alias,
    provider: "local-file",
    securityMode: "degraded_file_fallback"
  });
}

export async function writeLinuxAutoRecord({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  const candidates: any = linuxBindingGuardBackendCandidates();
  const startIndex: any = Math.max(0, candidates.indexOf(record.provider));
  const orderedCandidates: any = candidates.slice(startIndex);
  let lastError: any = null;
  for (const candidate of orderedCandidates) {
    const candidateRecord: any = candidate === record.provider
      ? record
      : rewrapBindingRecordForProvider(record, { alias, provider: candidate });
    try {
      if (candidate === "linux-kernel-keyring") {
        return await writeLinuxKeyringRecord({ alias }, candidateRecord);
      }
      if (candidate === "secret-service") {
        return await writeSecretServiceRecord({ alias }, candidateRecord);
      }
      if (candidate === "pass-gpg") {
        return await writePassRecord({ alias }, candidateRecord);
      }
      return await writeLocalRecord({ dataDir, alias }, candidateRecord);
    } catch (error: any) {
      lastError = error;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return writeLocalRecord({ dataDir, alias }, degradedLocalRecord(record, { alias }));
}

export async function readRecord({ backend = "auto", dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  if ((backend === "auto" || backend === "macos-keychain") && process.platform === "darwin") {
    try {
      return await readMacosRecord({ alias });
    } catch (error: any) {
      if (backend === "macos-keychain") {
        throw error;
      }
    }
  }
  if (backend === "auto" && process.platform === "linux") {
    return readLinuxAutoRecord({ dataDir, alias });
  }
  const resolvedBackend: any = resolveAutoBindingGuardBackend(backend);
  if (resolvedBackend === "linux-kernel-keyring") {
    try {
      return await readLinuxKeyringRecord({ alias });
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
    }
  }
  if (resolvedBackend === "secret-service") {
    try {
      return await readSecretServiceRecord({ alias });
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
    }
  }
  if (resolvedBackend === "pass-gpg") {
    try {
      return await readPassRecord({ alias });
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
    }
  }
  if (resolvedBackend === "windows-dpapi") {
    try {
      return await readWindowsDpapiRecord({ dataDir, alias });
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
    }
  }
  return readLocalRecord({
    dataDir,
    alias,
    provider: backend === "auto" ? "local-file" : backend,
    securityMode: "degraded_file_fallback"
  });
}

export async function writeRecord({ backend = "auto", dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  if (backend === "auto" && process.platform === "linux") {
    return writeLinuxAutoRecord({ dataDir, alias }, record);
  }
  if (record.provider === "macos-keychain" && process.platform === "darwin") {
    try {
      return await writeMacosRecord({ alias }, record);
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
      return writeLocalRecord({ dataDir, alias }, degradedLocalRecord(record, { alias }));
    }
  }
  if (record.provider === "linux-kernel-keyring") {
    try {
      return await writeLinuxKeyringRecord({ alias }, record);
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
      return writeLocalRecord({ dataDir, alias }, degradedLocalRecord(record, { alias }));
    }
  }
  if (record.provider === "secret-service") {
    try {
      return await writeSecretServiceRecord({ alias }, record);
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
      return writeLocalRecord({ dataDir, alias }, degradedLocalRecord(record, { alias }));
    }
  }
  if (record.provider === "pass-gpg") {
    try {
      return await writePassRecord({ alias }, record);
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
      return writeLocalRecord({ dataDir, alias }, degradedLocalRecord(record, { alias }));
    }
  }
  if (record.provider === "windows-dpapi") {
    try {
      return await writeWindowsDpapiRecord({ dataDir, alias }, record);
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
      return writeLocalRecord({ dataDir, alias }, degradedLocalRecord(record, { alias }));
    }
  }
  return writeLocalRecord({ dataDir, alias }, {
    ...record,
    provider: record.provider || (backend === "auto" ? "local-file" : backend),
    securityMode: record.securityMode || "degraded_file_fallback"
  });
}
