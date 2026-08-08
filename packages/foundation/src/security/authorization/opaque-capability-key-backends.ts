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
  asObject,
  capabilityKernelLocalSealingKeyPath,
  capabilityKernelStatePath,
  createKernelRecord,
  isClosedPipeError,
  keychainService,
  markNeedsInitialWrite,
  nowIso,
  parseJson,
  publicKernelRecord,
  resolveDataDir,
  safeAlias,
  stateFromKernelRecord,
  text
} from "./opaque-capability-key-core.ts";

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
    child.stdin.on("error", (error?: any) : any => {
      if (isClosedPipeError(error)) {
        return;
      }
      reject(error);
    });
    child.on("close", (code?: any) : any => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${command} failed with exit code ${code}`));
        return;
      }
      resolve(stdout);
    });
    try {
      child.stdin.end(input);
    } catch (error: any) {
      if (!isClosedPipeError(error)) {
        reject(error);
      }
    }
  });
}

export function commandExists(command?: any) : any {
  return hostCommandExists(command);
}

export function detectLinuxCapabilityKernelBackends() : any {
  return linuxSecretBackendCandidates({
    platform: process.platform,
    includeSystemdCredentials: true,
    commandAvailableFn: commandExists
  });
}

export function linuxCapabilityKernelBackendCandidates() : any {
  return linuxSecretBackendCandidates({ platform: process.platform, commandAvailableFn: commandExists });
}

export function firstUsableLinuxCapabilityKernelBackend() : any {
  return linuxCapabilityKernelBackendCandidates()[0] || "local-file";
}

export function resolveAutoCapabilityKernelBackend(backend: any = "auto") : any {
  return resolveAutoHostSecretBackend({
    backend,
    platform: process.platform,
    linuxCandidates: linuxCapabilityKernelBackendCandidates,
    commandAvailableFn: commandExists
  });
}

export function windowsDpapiCommand() : any {
  return hostWindowsDpapiCommand({ env: process.env, commandAvailableFn: commandExists });
}

export function windowsDpapiProtectedPath({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : any {
  return path.join(resolveDataDir(dataDir), "security", "capability-kernel", `${safeAlias(alias)}.dpapi`);
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
  return `meshrix:capability-kernel:${safeAlias(alias)}`;
}

export function secretToolAttributes(alias: any = DEFAULT_ALIAS) : any {
  return [
    "application",
    "meshrix",
    "component",
    "capability-kernel",
    "alias",
    safeAlias(alias)
  ];
}

export function passEntryName(alias: any = DEFAULT_ALIAS) : any {
  return `meshrix/capability-kernel/${safeAlias(alias)}`;
}

export async function readLocalKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS, provider = "local-file", securityMode = "degraded_file_fallback" }: Record<string, any> = {}) : Promise<any> {
  const filePath: any = capabilityKernelStatePath({ dataDir, alias });
  try {
    const record: any = parseJson(await fs.promises.readFile(filePath, "utf8"), null);
    if (record && !record.sealingKeyBase64) {
      record.sealingKeyBase64 = text(await fs.promises.readFile(
        capabilityKernelLocalSealingKeyPath({ dataDir, alias }),
        "utf8"
      ));
    }
    return record;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider, securityMode }));
    }
    throw error;
  }
}

export async function writeLocalKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  const filePath: any = capabilityKernelStatePath({ dataDir, alias });
  const sealingKey: any = text(record.sealingKeyBase64);
  if (!sealingKey) {
    throw new Error("Local capability kernel fallback requires a sealing key sidecar.");
  }
  await writePrivateFileAtomic(capabilityKernelLocalSealingKeyPath({ dataDir, alias }), `${sealingKey}\n`);
  const { sealingKeyBase64, ...persistedRecord } = record;
  void sealingKeyBase64;
  await writePrivateFileAtomic(filePath, `${JSON.stringify(persistedRecord, null, 2)}\n`);
  return record;
}

export async function readMacosKernelRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  if (process.platform !== "darwin") {
    throw new Error("macos-keychain capability kernel backend is only available on macOS.");
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
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "macos-keychain", securityMode: "keyring" }));
    }
    throw error;
  }
}

export async function writeMacosKernelRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  if (process.platform !== "darwin") {
    throw new Error("macos-keychain capability kernel backend is only available on macOS.");
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

export async function readLinuxKernelKeyringRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  const description: any = linuxKeyringDescription(alias);
  let serial: any = "";
  try {
    serial = (await runText("keyctl", ["search", "@u", "user", description])).trim();
  } catch (error: any) {
    if (/not found|cannot find|requested key not available|key has been revoked/i.test(error.message)) {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "linux-kernel-keyring", securityMode: "keyring" }));
    }
    throw error;
  }
  if (!serial) {
    return markNeedsInitialWrite(createKernelRecord({ alias, provider: "linux-kernel-keyring", securityMode: "keyring" }));
  }
  const raw: any = await runText("keyctl", ["pipe", serial]);
  return parseJson(raw.trim(), null);
}

export async function writeLinuxKernelKeyringRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
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

export async function readSecretServiceKernelRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  try {
    const raw: any = await runText("secret-tool", ["lookup", ...secretToolAttributes(alias)]);
    return parseJson(raw.trim(), null);
  } catch (error: any) {
    if (/no such object|not found|couldn't find|cannot autolaunch/i.test(error.message)) {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "secret-service", securityMode: "keyring" }));
    }
    throw error;
  }
}

export async function writeSecretServiceKernelRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  await runText("secret-tool", [
    "store",
    "--label",
    `Meshrix.js Capability Kernel ${safeAlias(alias)}`,
    ...secretToolAttributes(alias)
  ], { input: JSON.stringify(record) });
  return record;
}

export async function readPassKernelRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  try {
    const raw: any = await runText("pass", ["show", passEntryName(alias)]);
    return parseJson(raw.trim(), null);
  } catch (error: any) {
    if (/not in the password store|is not in the password store|No such file|not found/i.test(error.message)) {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "pass-gpg", securityMode: "user_keyring" }));
    }
    throw error;
  }
}

export async function writePassKernelRecord({ alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  await runText("pass", ["insert", "-m", "-f", passEntryName(alias)], { input: JSON.stringify(record) });
  return record;
}

export async function readWindowsDpapiKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  const filePath: any = windowsDpapiProtectedPath({ dataDir, alias });
  try {
    const protectedPayload: any = await fs.promises.readFile(filePath, "utf8");
    const raw: any = await runWindowsDpapi({ action: "unprotect", input: protectedPayload });
    return parseJson(raw.trim(), null);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "windows-dpapi", securityMode: "dpapi" }));
    }
    throw error;
  }
}

export async function writeWindowsDpapiKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  const filePath: any = windowsDpapiProtectedPath({ dataDir, alias });
  const protectedPayload: any = await runWindowsDpapi({ action: "protect", input: JSON.stringify(record) });
  await writePrivateFileAtomic(filePath, protectedPayload);
  return record;
}

export function degradedLocalKernelRecord(record: Record<string, any> = {}, { alias = DEFAULT_ALIAS }: Record<string, any> = {}) : any {
  const state: any = stateFromKernelRecord(record);
  return {
    ...createKernelRecord({
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

export function capabilityKernelSecurityModeForProvider(provider: any = "") : any {
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

export function rewrapKernelRecordForProvider(record: Record<string, any> = {}, { alias = DEFAULT_ALIAS, provider = "local-file" }: Record<string, any> = {}) : any {
  if (provider === "local-file") {
    return degradedLocalKernelRecord(record, { alias });
  }
  const securityMode: any = capabilityKernelSecurityModeForProvider(provider);
  const state: any = stateFromKernelRecord(record);
  return {
    ...createKernelRecord({
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

export async function readLinuxAutoKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  for (const candidate of linuxCapabilityKernelBackendCandidates()) {
    try {
      if (candidate === "linux-kernel-keyring") {
        return await readLinuxKernelKeyringRecord({ alias });
      }
      if (candidate === "secret-service") {
        return await readSecretServiceKernelRecord({ alias });
      }
      if (candidate === "pass-gpg") {
        return await readPassKernelRecord({ alias });
      }
      return await readLocalKernelRecord({
        dataDir,
        alias,
        provider: "local-file",
        securityMode: "degraded_file_fallback"
      });
    } catch {
      // Auto mode keeps scanning lower-priority Linux backends before file fallback.
    }
  }
  return readLocalKernelRecord({
    dataDir,
    alias,
    provider: "local-file",
    securityMode: "degraded_file_fallback"
  });
}

export async function writeLinuxAutoKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  const candidates: any = linuxCapabilityKernelBackendCandidates();
  const startIndex: any = Math.max(0, candidates.indexOf(record.provider));
  const orderedCandidates: any = candidates.slice(startIndex);
  let lastError: any = null;
  for (const candidate of orderedCandidates) {
    const candidateRecord: any = candidate === record.provider
      ? record
      : rewrapKernelRecordForProvider(record, { alias, provider: candidate });
    try {
      if (candidate === "linux-kernel-keyring") {
        return await writeLinuxKernelKeyringRecord({ alias }, candidateRecord);
      }
      if (candidate === "secret-service") {
        return await writeSecretServiceKernelRecord({ alias }, candidateRecord);
      }
      if (candidate === "pass-gpg") {
        return await writePassKernelRecord({ alias }, candidateRecord);
      }
      return await writeLocalKernelRecord({ dataDir, alias }, candidateRecord);
    } catch (error: any) {
      lastError = error;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return writeLocalKernelRecord({ dataDir, alias }, degradedLocalKernelRecord(record, { alias }));
}

export async function readKernelRecord({ backend = "auto", dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : Promise<any> {
  if ((backend === "auto" || backend === "macos-keychain") && process.platform === "darwin") {
    try {
      return await readMacosKernelRecord({ alias });
    } catch (error: any) {
      if (backend === "macos-keychain") {
        throw error;
      }
    }
  }
  if (backend === "auto" && process.platform === "linux") {
    return readLinuxAutoKernelRecord({ dataDir, alias });
  }
  const resolvedBackend: any = resolveAutoCapabilityKernelBackend(backend);
  if (resolvedBackend === "linux-kernel-keyring") {
    try {
      return await readLinuxKernelKeyringRecord({ alias });
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
    }
  }
  if (resolvedBackend === "secret-service") {
    try {
      return await readSecretServiceKernelRecord({ alias });
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
    }
  }
  if (resolvedBackend === "pass-gpg") {
    try {
      return await readPassKernelRecord({ alias });
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
    }
  }
  if (resolvedBackend === "windows-dpapi") {
    try {
      return await readWindowsDpapiKernelRecord({ dataDir, alias });
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
    }
  }
  return readLocalKernelRecord({
    dataDir,
    alias,
    provider: backend === "auto" ? "local-file" : backend,
    securityMode: "degraded_file_fallback"
  });
}

export async function writeKernelRecord({ backend = "auto", dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}, record: Record<string, any> = {}) : Promise<any> {
  if (backend === "auto" && process.platform === "linux") {
    return writeLinuxAutoKernelRecord({ dataDir, alias }, record);
  }
  if (record.provider === "macos-keychain" && process.platform === "darwin") {
    try {
      return await writeMacosKernelRecord({ alias }, record);
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
      return writeLocalKernelRecord({ dataDir, alias }, degradedLocalKernelRecord(record, { alias }));
    }
  }
  if (record.provider === "linux-kernel-keyring") {
    try {
      return await writeLinuxKernelKeyringRecord({ alias }, record);
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
      return writeLocalKernelRecord({ dataDir, alias }, degradedLocalKernelRecord(record, { alias }));
    }
  }
  if (record.provider === "secret-service") {
    try {
      return await writeSecretServiceKernelRecord({ alias }, record);
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
      return writeLocalKernelRecord({ dataDir, alias }, degradedLocalKernelRecord(record, { alias }));
    }
  }
  if (record.provider === "pass-gpg") {
    try {
      return await writePassKernelRecord({ alias }, record);
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
      return writeLocalKernelRecord({ dataDir, alias }, degradedLocalKernelRecord(record, { alias }));
    }
  }
  if (record.provider === "windows-dpapi") {
    try {
      return await writeWindowsDpapiKernelRecord({ dataDir, alias }, record);
    } catch (error: any) {
      if (backend !== "auto") {
        throw error;
      }
      return writeLocalKernelRecord({ dataDir, alias }, degradedLocalKernelRecord(record, { alias }));
    }
  }
  return writeLocalKernelRecord({ dataDir, alias }, {
    ...record,
    provider: record.provider || (backend === "auto" ? "local-file" : backend),
    securityMode: record.securityMode || "degraded_file_fallback"
  });
}
