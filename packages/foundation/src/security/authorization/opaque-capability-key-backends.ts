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
  type CapabilityKernelRecord,
  DEFAULT_ALIAS,
  capabilityKernelLocalSealingKeyPath,
  capabilityKernelStatePath,
  createKernelRecord,
  isClosedPipeError,
  keychainService,
  kernelRecordFromUnknown,
  markNeedsInitialWrite,
  nowIso,
  parseJson,
  resolveDataDir,
  safeAlias,
  stateFromKernelRecord,
  text
} from "./opaque-capability-key-core.ts";

interface KernelLocation { dataDir?: string; alias?: string }
interface KernelBackendLocation extends KernelLocation { backend?: string }
interface LocalKernelReadOptions extends KernelLocation { provider?: string; securityMode?: string }
interface TextCommandOptions { input?: string }
interface DpapiOptions { action?: "protect" | "unprotect"; input?: string }
interface KernelProviderOptions { alias?: string; provider?: string }

function parseKernelRecordJson(raw: string): CapabilityKernelRecord {
  const record = kernelRecordFromUnknown(parseJson(raw, null));
  if (!record) throw new Error("Capability kernel backend returned an invalid record.");
  return record;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

export async function runText(command = "", args: string[] = [], { input = "" }: TextCommandOptions = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.stdin.on("error", (error: Error) => {
      if (isClosedPipeError(error)) {
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${command} failed with exit code ${code}`));
        return;
      }
      resolve(stdout);
    });
    try {
      child.stdin.end(input);
    } catch (error) {
      if (!isClosedPipeError(error)) {
        reject(error);
      }
    }
  });
}

export function commandExists(command = ""): boolean {
  return hostCommandExists(command);
}

export function detectLinuxCapabilityKernelBackends() {
  return linuxSecretBackendCandidates({
    platform: process.platform,
    includeSystemdCredentials: true,
    commandAvailableFn: commandExists
  });
}

export function linuxCapabilityKernelBackendCandidates() {
  return linuxSecretBackendCandidates({ platform: process.platform, commandAvailableFn: commandExists });
}

export function firstUsableLinuxCapabilityKernelBackend() {
  return linuxCapabilityKernelBackendCandidates()[0] || "local-file";
}

export function resolveAutoCapabilityKernelBackend(backend = "auto") {
  return resolveAutoHostSecretBackend({
    backend,
    platform: process.platform,
    linuxCandidates: linuxCapabilityKernelBackendCandidates,
    commandAvailableFn: commandExists
  });
}

export function windowsDpapiCommand() {
  return hostWindowsDpapiCommand({ env: process.env, commandAvailableFn: commandExists });
}

export function windowsDpapiProtectedPath({ dataDir = "", alias = DEFAULT_ALIAS }: KernelLocation = {}) {
  return path.join(resolveDataDir(dataDir), "security", "capability-kernel", `${safeAlias(alias)}.dpapi`);
}

export async function runWindowsDpapi({ action = "protect", input = "" }: DpapiOptions = {}) {
  const command = windowsDpapiCommand();
  if (!command) {
    throw new Error("Windows DPAPI backend requires powershell.exe or pwsh.");
  }
  const protectScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;
  const unprotectScript = `
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

export function linuxKeyringDescription(alias = DEFAULT_ALIAS) {
  return `meshrix:capability-kernel:${safeAlias(alias)}`;
}

export function secretToolAttributes(alias = DEFAULT_ALIAS) {
  return [
    "application",
    "meshrix",
    "component",
    "capability-kernel",
    "alias",
    safeAlias(alias)
  ];
}

export function passEntryName(alias = DEFAULT_ALIAS) {
  return `meshrix/capability-kernel/${safeAlias(alias)}`;
}

export async function readLocalKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS, provider = "local-file", securityMode = "degraded_file_fallback" }: LocalKernelReadOptions = {}): Promise<CapabilityKernelRecord> {
  const filePath = capabilityKernelStatePath({ dataDir, alias });
  try {
    const record = parseKernelRecordJson(await fs.promises.readFile(filePath, "utf8"));
    if (record && !record.sealingKeyBase64) {
      record.sealingKeyBase64 = text(await fs.promises.readFile(
        capabilityKernelLocalSealingKeyPath({ dataDir, alias }),
        "utf8"
      ));
    }
    return record;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider, securityMode }));
    }
    throw error;
  }
}

export async function writeLocalKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS }: KernelLocation = {}, record: CapabilityKernelRecord): Promise<CapabilityKernelRecord> {
  const filePath = capabilityKernelStatePath({ dataDir, alias });
  const sealingKey = text(record.sealingKeyBase64);
  if (!sealingKey) {
    throw new Error("Local capability kernel fallback requires a sealing key sidecar.");
  }
  await writePrivateFileAtomic(capabilityKernelLocalSealingKeyPath({ dataDir, alias }), `${sealingKey}\n`);
  const { sealingKeyBase64, ...persistedRecord } = record;
  void sealingKeyBase64;
  await writePrivateFileAtomic(filePath, `${JSON.stringify(persistedRecord, null, 2)}\n`);
  return record;
}

export async function readMacosKernelRecord({ alias = DEFAULT_ALIAS }: KernelLocation = {}): Promise<CapabilityKernelRecord> {
  if (process.platform !== "darwin") {
    throw new Error("macos-keychain capability kernel backend is only available on macOS.");
  }
  try {
    const raw = await runText("security", [
      "find-generic-password",
      "-w",
      "-a",
      "meshrix",
      "-s",
      keychainService(alias)
    ]);
    return parseKernelRecordJson(raw.trim());
  } catch (error) {
    if (/could not be found|The specified item could not be found/i.test(errorMessage(error))) {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "macos-keychain", securityMode: "keyring" }));
    }
    throw error;
  }
}

export async function writeMacosKernelRecord({ alias = DEFAULT_ALIAS }: KernelLocation = {}, record: CapabilityKernelRecord): Promise<CapabilityKernelRecord> {
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

export async function readLinuxKernelKeyringRecord({ alias = DEFAULT_ALIAS }: KernelLocation = {}): Promise<CapabilityKernelRecord> {
  const description = linuxKeyringDescription(alias);
  let serial = "";
  try {
    serial = (await runText("keyctl", ["search", "@u", "user", description])).trim();
  } catch (error) {
    if (/not found|cannot find|requested key not available|key has been revoked/i.test(errorMessage(error))) {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "linux-kernel-keyring", securityMode: "keyring" }));
    }
    throw error;
  }
  if (!serial) {
    return markNeedsInitialWrite(createKernelRecord({ alias, provider: "linux-kernel-keyring", securityMode: "keyring" }));
  }
  const raw = await runText("keyctl", ["pipe", serial]);
  return parseKernelRecordJson(raw.trim());
}

export async function writeLinuxKernelKeyringRecord({ alias = DEFAULT_ALIAS }: KernelLocation = {}, record: CapabilityKernelRecord): Promise<CapabilityKernelRecord> {
  const description = linuxKeyringDescription(alias);
  try {
    const serial = (await runText("keyctl", ["search", "@u", "user", description])).trim();
    if (serial) {
      await runText("keyctl", ["unlink", serial, "@u"]).catch(() => {});
    }
  } catch {
    // Missing existing key is expected on first write.
  }
  await runText("keyctl", ["padd", "user", description, "@u"], { input: JSON.stringify(record) });
  return record;
}

export async function readSecretServiceKernelRecord({ alias = DEFAULT_ALIAS }: KernelLocation = {}): Promise<CapabilityKernelRecord> {
  try {
    const raw = await runText("secret-tool", ["lookup", ...secretToolAttributes(alias)]);
    return parseKernelRecordJson(raw.trim());
  } catch (error) {
    if (/no such object|not found|couldn't find|cannot autolaunch/i.test(errorMessage(error))) {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "secret-service", securityMode: "keyring" }));
    }
    throw error;
  }
}

export async function writeSecretServiceKernelRecord({ alias = DEFAULT_ALIAS }: KernelLocation = {}, record: CapabilityKernelRecord): Promise<CapabilityKernelRecord> {
  await runText("secret-tool", [
    "store",
    "--label",
    `Meshrix.js Capability Kernel ${safeAlias(alias)}`,
    ...secretToolAttributes(alias)
  ], { input: JSON.stringify(record) });
  return record;
}

export async function readPassKernelRecord({ alias = DEFAULT_ALIAS }: KernelLocation = {}): Promise<CapabilityKernelRecord> {
  try {
    const raw = await runText("pass", ["show", passEntryName(alias)]);
    return parseKernelRecordJson(raw.trim());
  } catch (error) {
    if (/not in the password store|is not in the password store|No such file|not found/i.test(errorMessage(error))) {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "pass-gpg", securityMode: "user_keyring" }));
    }
    throw error;
  }
}

export async function writePassKernelRecord({ alias = DEFAULT_ALIAS }: KernelLocation = {}, record: CapabilityKernelRecord): Promise<CapabilityKernelRecord> {
  await runText("pass", ["insert", "-m", "-f", passEntryName(alias)], { input: JSON.stringify(record) });
  return record;
}

export async function readWindowsDpapiKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS }: KernelLocation = {}): Promise<CapabilityKernelRecord> {
  const filePath = windowsDpapiProtectedPath({ dataDir, alias });
  try {
    const protectedPayload = await fs.promises.readFile(filePath, "utf8");
    const raw = await runWindowsDpapi({ action: "unprotect", input: protectedPayload });
    return parseKernelRecordJson(raw.trim());
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "windows-dpapi", securityMode: "dpapi" }));
    }
    throw error;
  }
}

export async function writeWindowsDpapiKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS }: KernelLocation = {}, record: CapabilityKernelRecord): Promise<CapabilityKernelRecord> {
  const filePath = windowsDpapiProtectedPath({ dataDir, alias });
  const protectedPayload = await runWindowsDpapi({ action: "protect", input: JSON.stringify(record) });
  await writePrivateFileAtomic(filePath, protectedPayload);
  return record;
}

export function degradedLocalKernelRecord(record: CapabilityKernelRecord, { alias = DEFAULT_ALIAS }: KernelLocation = {}): CapabilityKernelRecord {
  const state = stateFromKernelRecord(record);
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

export function capabilityKernelSecurityModeForProvider(provider = "") {
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

export function rewrapKernelRecordForProvider(record: CapabilityKernelRecord, { alias = DEFAULT_ALIAS, provider = "local-file" }: KernelProviderOptions = {}): CapabilityKernelRecord {
  if (provider === "local-file") {
    return degradedLocalKernelRecord(record, { alias });
  }
  const securityMode = capabilityKernelSecurityModeForProvider(provider);
  const state = stateFromKernelRecord(record);
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

export async function readLinuxAutoKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS }: KernelLocation = {}): Promise<CapabilityKernelRecord> {
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

export async function writeLinuxAutoKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS }: KernelLocation = {}, record: CapabilityKernelRecord): Promise<CapabilityKernelRecord> {
  const candidates = linuxCapabilityKernelBackendCandidates();
  const startIndex = Math.max(0, candidates.indexOf(record.provider));
  const orderedCandidates = candidates.slice(startIndex);
  let lastError = null;
  for (const candidate of orderedCandidates) {
    const candidateRecord = candidate === record.provider
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
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return writeLocalKernelRecord({ dataDir, alias }, degradedLocalKernelRecord(record, { alias }));
}

export async function readKernelRecord({ backend = "auto", dataDir = "", alias = DEFAULT_ALIAS }: KernelBackendLocation = {}): Promise<CapabilityKernelRecord> {
  if ((backend === "auto" || backend === "macos-keychain") && process.platform === "darwin") {
    try {
      return await readMacosKernelRecord({ alias });
    } catch (error) {
      if (backend === "macos-keychain") {
        throw error;
      }
    }
  }
  if (backend === "auto" && process.platform === "linux") {
    return readLinuxAutoKernelRecord({ dataDir, alias });
  }
  const resolvedBackend = resolveAutoCapabilityKernelBackend(backend);
  if (resolvedBackend === "linux-kernel-keyring") {
    try {
      return await readLinuxKernelKeyringRecord({ alias });
    } catch (error) {
      if (backend !== "auto") {
        throw error;
      }
    }
  }
  if (resolvedBackend === "secret-service") {
    try {
      return await readSecretServiceKernelRecord({ alias });
    } catch (error) {
      if (backend !== "auto") {
        throw error;
      }
    }
  }
  if (resolvedBackend === "pass-gpg") {
    try {
      return await readPassKernelRecord({ alias });
    } catch (error) {
      if (backend !== "auto") {
        throw error;
      }
    }
  }
  if (resolvedBackend === "windows-dpapi") {
    try {
      return await readWindowsDpapiKernelRecord({ dataDir, alias });
    } catch (error) {
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

export async function writeKernelRecord({ backend = "auto", dataDir = "", alias = DEFAULT_ALIAS }: KernelBackendLocation = {}, record: CapabilityKernelRecord): Promise<CapabilityKernelRecord> {
  if (backend === "auto" && process.platform === "linux") {
    return writeLinuxAutoKernelRecord({ dataDir, alias }, record);
  }
  if (record.provider === "macos-keychain" && process.platform === "darwin") {
    try {
      return await writeMacosKernelRecord({ alias }, record);
    } catch (error) {
      if (backend !== "auto") {
        throw error;
      }
      return writeLocalKernelRecord({ dataDir, alias }, degradedLocalKernelRecord(record, { alias }));
    }
  }
  if (record.provider === "linux-kernel-keyring") {
    try {
      return await writeLinuxKernelKeyringRecord({ alias }, record);
    } catch (error) {
      if (backend !== "auto") {
        throw error;
      }
      return writeLocalKernelRecord({ dataDir, alias }, degradedLocalKernelRecord(record, { alias }));
    }
  }
  if (record.provider === "secret-service") {
    try {
      return await writeSecretServiceKernelRecord({ alias }, record);
    } catch (error) {
      if (backend !== "auto") {
        throw error;
      }
      return writeLocalKernelRecord({ dataDir, alias }, degradedLocalKernelRecord(record, { alias }));
    }
  }
  if (record.provider === "pass-gpg") {
    try {
      return await writePassKernelRecord({ alias }, record);
    } catch (error) {
      if (backend !== "auto") {
        throw error;
      }
      return writeLocalKernelRecord({ dataDir, alias }, degradedLocalKernelRecord(record, { alias }));
    }
  }
  if (record.provider === "windows-dpapi") {
    try {
      return await writeWindowsDpapiKernelRecord({ dataDir, alias }, record);
    } catch (error) {
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
