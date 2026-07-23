import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  commandExistsInPath as hostCommandExists,
  linuxSecretBackendCandidates,
  resolveAutoHostSecretBackend,
  windowsDpapiCommand as hostWindowsDpapiCommand
} from "../../environment-compatibility/index.mjs";
import { writePrivateFileAtomic } from "../../storage/private-file-atomic.mjs";
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
} from "./opaque-capability-key-core.mjs";

export async function runText(command, args = [], { input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.stdin.on("error", (error) => {
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

export function commandExists(command) {
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

export function windowsDpapiProtectedPath({ dataDir = "", alias = DEFAULT_ALIAS } = {}) {
  return path.join(resolveDataDir(dataDir), "security", "capability-kernel", `${safeAlias(alias)}.dpapi`);
}

export async function runWindowsDpapi({ action = "protect", input = "" } = {}) {
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
  return `lico:capability-kernel:${safeAlias(alias)}`;
}

export function secretToolAttributes(alias = DEFAULT_ALIAS) {
  return [
    "application",
    "lico",
    "component",
    "capability-kernel",
    "alias",
    safeAlias(alias)
  ];
}

export function passEntryName(alias = DEFAULT_ALIAS) {
  return `lico/capability-kernel/${safeAlias(alias)}`;
}

export async function readLocalKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS, provider = "local-file", securityMode = "degraded_file_fallback" } = {}) {
  const filePath = capabilityKernelStatePath({ dataDir, alias });
  try {
    const record = parseJson(await fs.promises.readFile(filePath, "utf8"), null);
    if (record && !record.sealingKeyBase64) {
      record.sealingKeyBase64 = text(await fs.promises.readFile(
        capabilityKernelLocalSealingKeyPath({ dataDir, alias }),
        "utf8"
      ));
    }
    return record;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider, securityMode }));
    }
    throw error;
  }
}

export async function writeLocalKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS } = {}, record = {}) {
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

export async function readMacosKernelRecord({ alias = DEFAULT_ALIAS } = {}) {
  if (process.platform !== "darwin") {
    throw new Error("macos-keychain capability kernel backend is only available on macOS.");
  }
  try {
    const raw = await runText("/usr/bin/security", [
      "find-generic-password",
      "-w",
      "-a",
      "lico",
      "-s",
      keychainService(alias)
    ]);
    return parseJson(raw.trim(), null);
  } catch (error) {
    if (/could not be found|The specified item could not be found/i.test(error.message)) {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "macos-keychain", securityMode: "keyring" }));
    }
    throw error;
  }
}

export async function writeMacosKernelRecord({ alias = DEFAULT_ALIAS } = {}, record = {}) {
  if (process.platform !== "darwin") {
    throw new Error("macos-keychain capability kernel backend is only available on macOS.");
  }
  await runText("/usr/bin/security", [
    "add-generic-password",
    "-U",
    "-a",
    "lico",
    "-s",
    keychainService(alias),
    "-w",
    JSON.stringify(record)
  ]);
  return record;
}

export async function readLinuxKernelKeyringRecord({ alias = DEFAULT_ALIAS } = {}) {
  const description = linuxKeyringDescription(alias);
  let serial = "";
  try {
    serial = (await runText("keyctl", ["search", "@u", "user", description])).trim();
  } catch (error) {
    if (/not found|cannot find|requested key not available|key has been revoked/i.test(error.message)) {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "linux-kernel-keyring", securityMode: "keyring" }));
    }
    throw error;
  }
  if (!serial) {
    return markNeedsInitialWrite(createKernelRecord({ alias, provider: "linux-kernel-keyring", securityMode: "keyring" }));
  }
  const raw = await runText("keyctl", ["pipe", serial]);
  return parseJson(raw.trim(), null);
}

export async function writeLinuxKernelKeyringRecord({ alias = DEFAULT_ALIAS } = {}, record = {}) {
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

export async function readSecretServiceKernelRecord({ alias = DEFAULT_ALIAS } = {}) {
  try {
    const raw = await runText("secret-tool", ["lookup", ...secretToolAttributes(alias)]);
    return parseJson(raw.trim(), null);
  } catch (error) {
    if (/no such object|not found|couldn't find|cannot autolaunch/i.test(error.message)) {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "secret-service", securityMode: "keyring" }));
    }
    throw error;
  }
}

export async function writeSecretServiceKernelRecord({ alias = DEFAULT_ALIAS } = {}, record = {}) {
  await runText("secret-tool", [
    "store",
    "--label",
    `LicoMesh Capability Kernel ${safeAlias(alias)}`,
    ...secretToolAttributes(alias)
  ], { input: JSON.stringify(record) });
  return record;
}

export async function readPassKernelRecord({ alias = DEFAULT_ALIAS } = {}) {
  try {
    const raw = await runText("pass", ["show", passEntryName(alias)]);
    return parseJson(raw.trim(), null);
  } catch (error) {
    if (/not in the password store|is not in the password store|No such file|not found/i.test(error.message)) {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "pass-gpg", securityMode: "user_keyring" }));
    }
    throw error;
  }
}

export async function writePassKernelRecord({ alias = DEFAULT_ALIAS } = {}, record = {}) {
  await runText("pass", ["insert", "-m", "-f", passEntryName(alias)], { input: JSON.stringify(record) });
  return record;
}

export async function readWindowsDpapiKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS } = {}) {
  const filePath = windowsDpapiProtectedPath({ dataDir, alias });
  try {
    const protectedPayload = await fs.promises.readFile(filePath, "utf8");
    const raw = await runWindowsDpapi({ action: "unprotect", input: protectedPayload });
    return parseJson(raw.trim(), null);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return markNeedsInitialWrite(createKernelRecord({ alias, provider: "windows-dpapi", securityMode: "dpapi" }));
    }
    throw error;
  }
}

export async function writeWindowsDpapiKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS } = {}, record = {}) {
  const filePath = windowsDpapiProtectedPath({ dataDir, alias });
  const protectedPayload = await runWindowsDpapi({ action: "protect", input: JSON.stringify(record) });
  await writePrivateFileAtomic(filePath, protectedPayload);
  return record;
}

export function degradedLocalKernelRecord(record = {}, { alias = DEFAULT_ALIAS } = {}) {
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

export function rewrapKernelRecordForProvider(record = {}, { alias = DEFAULT_ALIAS, provider = "local-file" } = {}) {
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

export async function readLinuxAutoKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS } = {}) {
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

export async function writeLinuxAutoKernelRecord({ dataDir = "", alias = DEFAULT_ALIAS } = {}, record = {}) {
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

export async function readKernelRecord({ backend = "auto", dataDir = "", alias = DEFAULT_ALIAS } = {}) {
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

export async function writeKernelRecord({ backend = "auto", dataDir = "", alias = DEFAULT_ALIAS } = {}, record = {}) {
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
