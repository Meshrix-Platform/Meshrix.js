import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync: any = promisify(execFile);

export const PROCESS_IDENTITY_STORE_ENV: any = "MESHRIX_MCP_PROCESS_IDENTITY_STORE";
export const PROCESS_IDENTITY_WINDOWS_DPAPI_COMMAND_ENV: any = "MESHRIX_WINDOWS_DPAPI_COMMAND";

const PROCESS_IDENTITY_CREDENTIAL_SERVICE: any = "Meshrix MCP Process Identity";
const PROCESS_IDENTITY_CREDENTIAL_TIMEOUT_MS: any = 8000;
const DEFAULT_PROCESS_IDENTITY_DIR: any = path.join(os.homedir(), ".meshrix", "mcp", "process-identity");
const TARGET_ALIASES: any = new Map<any, any>([["open-code", "opencode"]]);
const SYSTEM_STORE_MODES: any = new Set<any>([
  "macos-keychain",
  "linux-secret-service",
  "linux-kernel-keyring",
  "windows-dpapi"
]);

function normalizeTarget(value: any = "") : any {
  const target: any = String(value || "").trim().toLowerCase();
  return TARGET_ALIASES.get(target) || target;
}

function processIdentityPathForTarget(target: any = "codex") : any {
  return path.join(DEFAULT_PROCESS_IDENTITY_DIR, `${normalizeTarget(target) || "mcp"}.json`);
}

function processIdentityWindowsDpapiPath(target: any = "codex") : any {
  return path.join(DEFAULT_PROCESS_IDENTITY_DIR, `${normalizeTarget(target) || "mcp"}.dpapi`);
}

function processIdentityCredentialAccount(target: any = "codex") : any {
  return `meshrix-mcp:${normalizeTarget(target) || "mcp"}`;
}

function processIdentityStoreMode() : any {
  const mode: any = String(process.env[PROCESS_IDENTITY_STORE_ENV] || "auto").trim().toLowerCase();
  if (mode === "auto" || mode === "system" || mode === "file" || SYSTEM_STORE_MODES.has(mode)) {
    return mode;
  }
  return "auto";
}

export function supportedProcessIdentitySystemBackendsForPlatform(platform: any = process.platform) : any {
  if (platform === "darwin") {
    return ["macos-keychain"];
  }
  if (platform === "linux") {
    return ["linux-secret-service", "linux-kernel-keyring"];
  }
  if (platform === "win32") {
    return ["windows-dpapi"];
  }
  return [];
}

function processIdentitySystemBackends(mode: any = processIdentityStoreMode()) : any {
  if (mode === "file") {
    return [];
  }
  if (SYSTEM_STORE_MODES.has(mode)) {
    return [mode];
  }
  return supportedProcessIdentitySystemBackendsForPlatform();
}

function processIdentityCredentialReference(backend?: any, account?: any) : any {
  if (backend === "macos-keychain") {
    return `macos-keychain:${PROCESS_IDENTITY_CREDENTIAL_SERVICE}:${account}`;
  }
  if (backend === "linux-secret-service") {
    return `linux-secret-service:${PROCESS_IDENTITY_CREDENTIAL_SERVICE}:${account}`;
  }
  if (backend === "linux-kernel-keyring") {
    return `linux-kernel-keyring:user:${account}`;
  }
  if (backend === "windows-dpapi") {
    return `windows-dpapi:${PROCESS_IDENTITY_CREDENTIAL_SERVICE}:${account}`;
  }
  return "";
}

function parseProcessIdentityRecord(value: any = "", backend: any = "", reference: any = "") : any {
  const record: any = JSON.parse(String(value || "{}"));
  if (!record || typeof record !== "object" || Array.isArray(record) || !record.privateKeyPem || !record.clientIdentityPackage) {
    throw new Error("Stored MCP process identity record is invalid.");
  }
  if (Object.hasOwn(record, "grantToken")) {
    if (typeof record.grantToken !== "string" || !record.grantToken.trim() || record.grantToken.length > 8192) {
      throw new Error("Stored MCP process identity grant credential is invalid.");
    }
  }
  return {
    ...record,
    storageBackend: backend || record.storageBackend || "",
    credentialRef: reference || record.credentialRef || ""
  };
}

async function readJson(filePath?: any, fallback: any = null) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function run(command?: any, args: any = [], options: Record<string, any> = {}) : Promise<any> {
  try {
    const result: any = await execFileAsync(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      timeout: options.timeoutMs || 0,
      killSignal: options.killSignal || "SIGKILL",
      maxBuffer: 10 * 1024 * 1024
    });
    return {
      ok: true,
      stdout: result.stdout || "",
      stderr: result.stderr || ""
    };
  } catch (error: any) {
    if (options.allowFailure) {
      return {
        ok: false,
        stdout: error.stdout || "",
        stderr: error.stderr || error.message || ""
      };
    }
    throw error;
  }
}

async function runWithInput(command?: any, args: any = [], input: any = "", options: Record<string, any> = {}) : Promise<any> {
  return new Promise((resolve?: any, reject?: any) : any => {
    const timeoutMs: any = Number(options.timeoutMs || 0);
    const useProcessGroup: any = timeoutMs > 0 && process.platform !== "win32";
    const child: any = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.replaceEnv === true
        ? { ...(options.env || {}) }
        : { ...process.env, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      detached: useProcessGroup
    });
    let stdout: any = "";
    let stderr: any = "";
    let settled: any = false;
    let timer: any = null;
    let forceKillTimer: any = null;
    let timedOut: any = false;
    const settle: any = (value?: any) : any => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve(value);
    };
    const fail: any = (error?: any) : any => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      reject(error);
    };
    const terminate: any = (signal?: any) : any => {
      const signalTarget: any = useProcessGroup ? -child.pid : child.pid;
      try {
        process.kill(signalTarget, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Process already exited.
        }
      }
    };
    const settleTimedOut: any = () : any => {
      const message: any = `command timed out after ${timeoutMs} ms`;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (options.allowFailure) {
        settle({ ok: false, stdout, stderr: stderr ? `${stderr}\n${message}` : message, timedOut: true });
        return;
      }
      const error: Error & Record<string, any> = new Error(message);
      error.timedOut = true;
      error.stdout = stdout;
      error.stderr = stderr;
      fail(error);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() : any => {
        timedOut = true;
        terminate("SIGKILL");
        forceKillTimer = setTimeout(settleTimedOut, options.killAfterMs || 2500);
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk?: any) : any => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk?: any) : any => {
      stderr += chunk;
    });
    child.on("error", (error?: any) : any => {
      if (options.allowFailure) {
        settle({ ok: false, stdout, stderr: stderr || error.message || "" });
        return;
      }
      fail(error);
    });
    child.on("close", (code?: any) : any => {
      if (timedOut) {
        settleTimedOut();
        return;
      }
      const ok: any = code === 0;
      if (!ok && !options.allowFailure) {
        fail(new Error(`${command} failed: ${stderr || stdout || `exit ${code}`}`));
        return;
      }
      settle({ ok, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function deleteFileProcessIdentity(target: any = "codex") : Promise<any> {
  const filePath: any = processIdentityPathForTarget(target);
  await fs.rm(filePath, { force: true });
  const remaining: any = await fs.lstat(filePath).then(() : any => true).catch((error?: any) : any => {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  });
  if (remaining) {
    throw new Error("MCP process identity private-file credential deletion was not confirmed.");
  }
}

async function writePrivateTextAtomic(filePath?: any, content?: any) : Promise<any> {
  const directory: any = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() : any => {});
  const current: any = await fs.lstat(filePath).catch((error?: any) : any => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (current && !current.isFile()) {
    throw new Error("MCP process identity file fallback target must be a regular file.");
  }
  const temporaryPath: any = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let handle: any = null;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.chmod(temporaryPath, 0o600).catch(() : any => {});
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() : any => {});
    const directoryHandle: any = await fs.open(directory, "r").catch(() : any => null);
    if (directoryHandle) {
      try {
        await directoryHandle.sync().catch(() : any => {});
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    if (handle) {
      await handle.close().catch(() : any => {});
    }
    await fs.rm(temporaryPath, { force: true }).catch(() : any => {});
  }
}

async function writePrivateJsonAtomic(filePath?: any, record?: any) : Promise<any> {
  await writePrivateTextAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

export function resolveWindowsDpapiCommand({
  platform = process.platform,
  configuredCommand = process.env[PROCESS_IDENTITY_WINDOWS_DPAPI_COMMAND_ENV]
}: Record<string, any> = {}) : any {
  if (platform === "win32") {
    return "powershell.exe";
  }
  return String(configuredCommand || "").trim();
}

function credentialSubprocessEnvironment(secretPayload: any = "") : any {
  const payload: any = String(secretPayload || "");
  return Object.fromEntries((Object.entries(process.env) as [string, any][]).filter(([name, value]: any[]) : any => {
    if (/token|secret|password|credential|private[_-]?key/iu.test(name)) {
      return false;
    }
    const normalizedValue: any = String(value || "");
    return normalizedValue.length < 8 || !payload.includes(normalizedValue);
  }));
}

async function runWindowsDpapi(action?: any, input?: any) : Promise<any> {
  const command: any = resolveWindowsDpapiCommand();
  if (!command) {
    return { ok: false, reason: "powershell_unavailable" };
  }
  const protectScript: any = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$plain = [Console]::In.ReadToEnd()",
    "$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)",
    "$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($protected))"
  ].join("\n");
  const unprotectScript: any = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$cipher = [Console]::In.ReadToEnd().Trim()",
    "$bytes = [Convert]::FromBase64String($cipher)",
    "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))"
  ].join("\n");
  const result: any = await runWithInput(command, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    action === "protect" ? protectScript : unprotectScript
  ], input, {
    allowFailure: true,
    timeoutMs: PROCESS_IDENTITY_CREDENTIAL_TIMEOUT_MS,
    env: credentialSubprocessEnvironment(input),
    replaceEnv: true
  });
  return result.ok
    ? { ok: true, value: String(result.stdout || "") }
    : { ok: false, reason: `dpapi_${action}_failed` };
}

async function saveWindowsDpapiCredential(target?: any, serialized?: any) : Promise<any> {
  if (process.platform !== "win32" && !process.env[PROCESS_IDENTITY_WINDOWS_DPAPI_COMMAND_ENV]) {
    return { ok: false, reason: "unsupported_platform" };
  }
  const protectedPayload: any = await runWindowsDpapi("protect", serialized);
  if (!protectedPayload.ok || !protectedPayload.value.trim()) {
    return { ok: false, reason: protectedPayload.reason || "dpapi_protect_empty" };
  }
  const filePath: any = processIdentityWindowsDpapiPath(target);
  await writePrivateTextAtomic(filePath, `${protectedPayload.value.trim()}\n`);
  return { ok: true };
}

async function loadWindowsDpapiCredential(target?: any) : Promise<any> {
  if (process.platform !== "win32" && !process.env[PROCESS_IDENTITY_WINDOWS_DPAPI_COMMAND_ENV]) {
    return null;
  }
  const filePath: any = processIdentityWindowsDpapiPath(target);
  const protectedPayload: any = await fs.readFile(filePath, "utf8").catch((error?: any) : any => {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  if (!protectedPayload.trim()) {
    return null;
  }
  const unprotected: any = await runWindowsDpapi("unprotect", protectedPayload);
  return unprotected.ok ? unprotected.value : null;
}

async function deleteWindowsDpapiCredential(target?: any) : Promise<any> {
  const filePath: any = processIdentityWindowsDpapiPath(target);
  await fs.rm(filePath, { force: true });
  const remaining: any = await fs.lstat(filePath).then(() : any => true).catch((error?: any) : any => {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  });
  return { ok: remaining === false };
}

async function saveMacosKeychainCredential(account?: any, serialized?: any) : Promise<any> {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "unsupported_platform" };
  }
  const result: any = await run("security", [
    "add-generic-password",
    "-a", account,
    "-s", PROCESS_IDENTITY_CREDENTIAL_SERVICE,
    "-w", serialized,
    "-U"
  ], {
    allowFailure: true,
    timeoutMs: PROCESS_IDENTITY_CREDENTIAL_TIMEOUT_MS
  });
  return result.ok ? { ok: true } : { ok: false, reason: "security_add_failed" };
}

async function loadMacosKeychainCredential(account?: any) : Promise<any> {
  if (process.platform !== "darwin") {
    return null;
  }
  const result: any = await run("security", [
    "find-generic-password",
    "-a", account,
    "-s", PROCESS_IDENTITY_CREDENTIAL_SERVICE,
    "-w"
  ], {
    allowFailure: true,
    timeoutMs: PROCESS_IDENTITY_CREDENTIAL_TIMEOUT_MS
  });
  return result.ok ? String(result.stdout || "").trimEnd() : null;
}

async function deleteMacosKeychainCredential(account?: any) : Promise<any> {
  if (process.platform !== "darwin") {
    return { ok: true, skipped: true };
  }
  const result: any = await run("security", [
    "delete-generic-password",
    "-a", account,
    "-s", PROCESS_IDENTITY_CREDENTIAL_SERVICE
  ], {
    allowFailure: true,
    timeoutMs: PROCESS_IDENTITY_CREDENTIAL_TIMEOUT_MS
  });
  return { ok: result.ok };
}

async function saveLinuxSecretServiceCredential(account?: any, serialized?: any) : Promise<any> {
  if (process.platform !== "linux") {
    return { ok: false, reason: "unsupported_platform" };
  }
  const result: any = await runWithInput("secret-tool", [
    "store",
    "--label", `${PROCESS_IDENTITY_CREDENTIAL_SERVICE} ${account}`,
    "service", PROCESS_IDENTITY_CREDENTIAL_SERVICE,
    "account", account
  ], serialized, {
    allowFailure: true,
    timeoutMs: PROCESS_IDENTITY_CREDENTIAL_TIMEOUT_MS
  });
  return result.ok ? { ok: true } : { ok: false, reason: "secret_tool_store_failed" };
}

async function loadLinuxSecretServiceCredential(account?: any) : Promise<any> {
  if (process.platform !== "linux") {
    return null;
  }
  const result: any = await run("secret-tool", [
    "lookup",
    "service", PROCESS_IDENTITY_CREDENTIAL_SERVICE,
    "account", account
  ], {
    allowFailure: true,
    timeoutMs: PROCESS_IDENTITY_CREDENTIAL_TIMEOUT_MS
  });
  return result.ok ? String(result.stdout || "").trimEnd() : null;
}

async function deleteLinuxSecretServiceCredential(account?: any) : Promise<any> {
  if (process.platform !== "linux") {
    return { ok: true, skipped: true };
  }
  const result: any = await run("secret-tool", [
    "clear",
    "service", PROCESS_IDENTITY_CREDENTIAL_SERVICE,
    "account", account
  ], {
    allowFailure: true,
    timeoutMs: PROCESS_IDENTITY_CREDENTIAL_TIMEOUT_MS
  });
  return { ok: result.ok };
}

async function keyctlSerialForAccount(account?: any) : Promise<any> {
  const result: any = await run("keyctl", ["search", "@u", "user", account], {
    allowFailure: true,
    timeoutMs: PROCESS_IDENTITY_CREDENTIAL_TIMEOUT_MS
  });
  return result.ok ? String(result.stdout || "").trim() : "";
}

async function saveLinuxKernelKeyringCredential(account?: any, serialized?: any) : Promise<any> {
  if (process.platform !== "linux") {
    return { ok: false, reason: "unsupported_platform" };
  }
  const existingSerial: any = await keyctlSerialForAccount(account);
  if (existingSerial) {
    await run("keyctl", ["unlink", existingSerial, "@u"], {
      allowFailure: true,
      timeoutMs: PROCESS_IDENTITY_CREDENTIAL_TIMEOUT_MS
    });
  }
  const result: any = await runWithInput("keyctl", ["padd", "user", account, "@u"], serialized, {
    allowFailure: true,
    timeoutMs: PROCESS_IDENTITY_CREDENTIAL_TIMEOUT_MS
  });
  if (!result.ok) {
    return { ok: false, reason: "keyctl_padd_failed" };
  }
  const loaded: any = await loadLinuxKernelKeyringCredential(account);
  return loaded === serialized ? { ok: true } : { ok: false, reason: "keyctl_roundtrip_failed" };
}

async function loadLinuxKernelKeyringCredential(account?: any) : Promise<any> {
  if (process.platform !== "linux") {
    return null;
  }
  const serial: any = await keyctlSerialForAccount(account);
  if (!serial) {
    return null;
  }
  const result: any = await run("keyctl", ["pipe", serial], {
    allowFailure: true,
    timeoutMs: PROCESS_IDENTITY_CREDENTIAL_TIMEOUT_MS
  });
  return result.ok ? String(result.stdout || "") : null;
}

async function deleteLinuxKernelKeyringCredential(account?: any) : Promise<any> {
  if (process.platform !== "linux") {
    return { ok: true, skipped: true };
  }
  const serial: any = await keyctlSerialForAccount(account);
  if (serial) {
    const result: any = await run("keyctl", ["unlink", serial, "@u"], {
      allowFailure: true,
      timeoutMs: PROCESS_IDENTITY_CREDENTIAL_TIMEOUT_MS
    });
    return { ok: result.ok };
  }
  return { ok: true, skipped: true };
}

async function saveSystemProcessIdentity(target: any = "codex", record: Record<string, any> = {}) : Promise<any> {
  const account: any = processIdentityCredentialAccount(target);
  const serialized: any = JSON.stringify(record);
  for (const backend of processIdentitySystemBackends()) {
    const saved: any = backend === "macos-keychain"
      ? await saveMacosKeychainCredential(account, serialized)
      : backend === "linux-secret-service"
        ? await saveLinuxSecretServiceCredential(account, serialized)
        : backend === "linux-kernel-keyring"
          ? await saveLinuxKernelKeyringCredential(account, serialized)
          : await saveWindowsDpapiCredential(target, serialized);
    if (!saved.ok) {
      continue;
    }
    const loaded: any = await loadSystemProcessIdentity(target, [backend]);
    if (
      loaded?.privateKeyPem === record.privateKeyPem &&
      (!Object.hasOwn(record, "grantToken") || loaded.grantToken === record.grantToken)
    ) {
      await deleteFileProcessIdentity(target);
      return {
        ok: true,
        storageBackend: backend,
        reference: processIdentityCredentialReference(backend, account)
      };
    }
  }
  return { ok: false };
}

async function loadSystemProcessIdentity(target: any = "codex", explicitBackends: any = null) : Promise<any> {
  const account: any = processIdentityCredentialAccount(target);
  const backends: any = explicitBackends || processIdentitySystemBackends();
  for (const backend of backends) {
    const value: any = backend === "macos-keychain"
      ? await loadMacosKeychainCredential(account)
      : backend === "linux-secret-service"
        ? await loadLinuxSecretServiceCredential(account)
        : backend === "linux-kernel-keyring"
          ? await loadLinuxKernelKeyringCredential(account)
          : await loadWindowsDpapiCredential(target);
    if (!value) {
      continue;
    }
    const reference: any = processIdentityCredentialReference(backend, account);
    return parseProcessIdentityRecord(value, backend, reference);
  }
  return null;
}

async function deleteSystemProcessIdentity(target: any = "codex") : Promise<any> {
  const account: any = processIdentityCredentialAccount(target);
  const configuredBackends: any = processIdentitySystemBackends();
  const backends: any[] = [...new Set<any>([
    ...processIdentitySystemBackends("auto"),
    ...configuredBackends
  ])];
  for (const backend of backends) {
    const before: any = backend === "macos-keychain"
      ? await loadMacosKeychainCredential(account)
      : backend === "linux-secret-service"
        ? await loadLinuxSecretServiceCredential(account)
        : backend === "linux-kernel-keyring"
          ? await loadLinuxKernelKeyringCredential(account)
          : await loadWindowsDpapiCredential(target);
    if (!before) {
      continue;
    }
    const deleted: any = backend === "macos-keychain"
      ? await deleteMacosKeychainCredential(account)
      : backend === "linux-secret-service"
        ? await deleteLinuxSecretServiceCredential(account)
        : backend === "linux-kernel-keyring"
          ? await deleteLinuxKernelKeyringCredential(account)
          : await deleteWindowsDpapiCredential(target);
    if (!deleted.ok) {
      throw new Error("MCP process identity system credential deletion failed.");
    }
    const after: any = backend === "macos-keychain"
      ? await loadMacosKeychainCredential(account)
      : backend === "linux-secret-service"
        ? await loadLinuxSecretServiceCredential(account)
        : backend === "linux-kernel-keyring"
          ? await loadLinuxKernelKeyringCredential(account)
          : await loadWindowsDpapiCredential(target);
    if (after) {
      throw new Error("MCP process identity system credential deletion was not confirmed.");
    }
  }
}

export async function deleteProcessIdentity(target: any = "codex") : Promise<any> {
  await deleteSystemProcessIdentity(normalizeTarget(target) || "mcp");
  await deleteFileProcessIdentity(normalizeTarget(target) || "mcp");
}

export async function saveProcessIdentity(target: any = "codex", record: Record<string, any> = {}) : Promise<any> {
  const normalizedTarget: any = normalizeTarget(target) || "mcp";
  const normalizedRecord: any = parseProcessIdentityRecord(JSON.stringify({
    ...record,
    schemaVersion: record.schemaVersion || "v0.0.1:process-identity:mcp-credential-1",
    target: normalizedTarget
  }));
  const system: any = await saveSystemProcessIdentity(normalizedTarget, normalizedRecord);
  if (system.ok) {
    return system;
  }
  const mode: any = processIdentityStoreMode();
  if (mode === "system" || SYSTEM_STORE_MODES.has(mode)) {
    throw new Error(`System credential storage is not available for MCP process identity. Set ${PROCESS_IDENTITY_STORE_ENV}=file only for controlled fallback environments.`);
  }
  const filePath: any = processIdentityPathForTarget(normalizedTarget);
  const fileRecord: Record<string, any> = {
    ...normalizedRecord,
    schemaVersion: record.schemaVersion || "v0.0.1:process-identity:mcp-file-1",
    target: normalizedTarget,
    storageBackend: "private-file-fallback"
  };
  await writePrivateJsonAtomic(filePath, fileRecord);
  return {
    ok: true,
    storageBackend: "private-file-fallback",
    reference: filePath,
    filePath
  };
}

export async function loadProcessIdentity(target: any = "codex") : Promise<any> {
  const normalizedTarget: any = normalizeTarget(target) || "mcp";
  const mode: any = processIdentityStoreMode();
  const systemRecord: any = mode === "file"
    ? null
    : await loadSystemProcessIdentity(normalizedTarget);
  if (systemRecord) {
    return systemRecord;
  }
  if (mode === "system" || SYSTEM_STORE_MODES.has(mode)) {
    return null;
  }
  const filePath: any = processIdentityPathForTarget(normalizedTarget);
  const record: any = await readJson(filePath, null);
  return record && typeof record === "object" && !Array.isArray(record)
    ? {
        ...parseProcessIdentityRecord(JSON.stringify(record), record.storageBackend || "private-file-fallback", filePath),
        filePath
      }
    : null;
}
