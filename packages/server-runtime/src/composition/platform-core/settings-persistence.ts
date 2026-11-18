import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writePrivateFileAtomic } from "@meshrix/foundation/storage/private-file-atomic";
import { mutateState, waitForStateIdle } from "../../state/state-coordinator.ts";
import {
  getAgentToolExecutionSettingsPath,
  getSettingsPath,
  type RuntimeSettings
} from "./settings-defaults.ts";
import { normalizeAgentToolExecution, normalizeSettings } from "./settings-normalizers.ts";

interface PersistenceOptions {
  redactSecrets?: boolean;
}

interface SettingsLock {
  lockPath: string;
  token: string;
}

interface DocumentSnapshot {
  exists: boolean;
  value?: Record<string, unknown>;
}

interface SettingsJournal {
  format: "settings-transaction-journal";
  schema: 2;
  phase: "prepared" | "committed";
  transactionId: string;
  main: DocumentSnapshot;
  agentToolExecution: DocumentSnapshot;
}

const SETTINGS_LOCK_FILE = ".settings.lock";
const SETTINGS_TRANSACTION_FILE = ".settings-transaction.json";
const SETTINGS_LOCK_WAIT_MS = 10_000;
const SETTINGS_LOCK_STALE_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "";
}

function settingsLockPath(userDataPath: string): string {
  return path.join(userDataPath, SETTINGS_LOCK_FILE);
}

function settingsTransactionPath(userDataPath: string): string {
  return path.join(userDataPath, SETTINGS_TRANSACTION_FILE);
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!isRecord(parsed)) throw new Error(`Settings document must contain an object: ${path.basename(filePath)}`);
    return parsed;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function processIsAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) === "EPERM";
  }
}

async function lockOwner(lockPath: string): Promise<Record<string, unknown> | null> {
  return readJsonIfExists(lockPath).catch(() => null);
}

async function reclaimAbandonedLock(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    const owner = await lockOwner(lockPath);
    const pid = owner?.pid;
    const complete = typeof owner?.token === "string" && Number.isSafeInteger(pid) && Number(pid) > 0;
    if (Date.now() - stat.mtimeMs < SETTINGS_LOCK_STALE_MS && (!complete || processIsAlive(pid))) return false;
    const abandonedPath = `${lockPath}.abandoned-${crypto.randomUUID()}`;
    await fs.rename(lockPath, abandonedPath);
    await fs.rm(abandonedPath, { force: true });
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return true;
    return false;
  }
}

async function acquireSettingsLock(userDataPath: string): Promise<SettingsLock> {
  await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });
  await fs.chmod(userDataPath, 0o700);
  const lockPath = settingsLockPath(userDataPath);
  const token = crypto.randomUUID();
  const deadline = Date.now() + SETTINGS_LOCK_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid })}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { lockPath, token };
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (await reclaimAbandonedLock(lockPath)) continue;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw Object.assign(new Error("Settings persistence is busy; retry the operation."), {
    code: "settings_persistence_busy"
  });
}

async function withSettingsLock<T>(userDataPath: string, task: () => Promise<T>): Promise<T> {
  const lock = await acquireSettingsLock(userDataPath);
  const heartbeat = setInterval(() => {
    void fs.utimes(lock.lockPath, new Date(), new Date()).catch(() => undefined);
  }, Math.floor(SETTINGS_LOCK_STALE_MS / 3));
  heartbeat.unref();
  try {
    return await task();
  } finally {
    clearInterval(heartbeat);
    const owner = await lockOwner(lock.lockPath);
    if (owner?.token === lock.token) await fs.rm(lock.lockPath, { force: true });
  }
}

async function writeJson(filePath: string, value: Record<string, unknown>): Promise<void> {
  await writePrivateFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function snapshot(value: Record<string, unknown> | null): DocumentSnapshot {
  return value === null ? { exists: false } : { exists: true, value };
}

function assertSnapshot(value: unknown): DocumentSnapshot {
  if (!isRecord(value) || typeof value.exists !== "boolean") throw new Error("Settings snapshot is invalid.");
  if (value.exists && !isRecord(value.value)) throw new Error("Settings snapshot value is invalid.");
  return value as unknown as DocumentSnapshot;
}

function assertJournal(value: unknown): SettingsJournal {
  if (!isRecord(value) || value.format !== "settings-transaction-journal" || value.schema !== 2 ||
      (value.phase !== "prepared" && value.phase !== "committed") ||
      typeof value.transactionId !== "string") {
    throw new Error("Settings transaction journal is invalid.");
  }
  assertSnapshot(value.main);
  assertSnapshot(value.agentToolExecution);
  return value as unknown as SettingsJournal;
}

async function restoreDocument(filePath: string, document: DocumentSnapshot): Promise<void> {
  if (!document.exists) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await writeJson(filePath, document.value ?? {});
}

async function recoverSettingsTransaction(userDataPath: string): Promise<void> {
  const journalPath = settingsTransactionPath(userDataPath);
  const raw = await readJsonIfExists(journalPath);
  if (!raw) return;
  const journal = assertJournal(raw);
  await restoreDocument(getSettingsPath(userDataPath), journal.main);
  await restoreDocument(getAgentToolExecutionSettingsPath(userDataPath), journal.agentToolExecution);
  await fs.rm(journalPath, { force: true });
}

function mainSettings(settings: RuntimeSettings): Record<string, unknown> {
  return { executionSandbox: settings.executionSandbox };
}

async function loadSettingsUnlocked(userDataPath: string): Promise<RuntimeSettings> {
  const main = await readJsonIfExists(getSettingsPath(userDataPath)) ?? {};
  const tool = await readJsonIfExists(getAgentToolExecutionSettingsPath(userDataPath));
  return normalizeSettings({
    ...main,
    ...(tool ? { agentToolExecution: tool.agentToolExecution ?? tool } : {})
  });
}

export async function loadSettings(
  userDataPath: string,
  _options: PersistenceOptions = {}
): Promise<RuntimeSettings> {
  await waitForStateIdle(`settings:${path.resolve(userDataPath)}`);
  return withSettingsLock(userDataPath, async () => {
    await recoverSettingsTransaction(userDataPath);
    return loadSettingsUnlocked(userDataPath);
  });
}

export async function saveSettings(
  userDataPath: string,
  incomingSettings: unknown,
  _options: PersistenceOptions = {}
): Promise<RuntimeSettings> {
  const settingsPath = getSettingsPath(userDataPath);
  const toolPath = getAgentToolExecutionSettingsPath(userDataPath);
  return mutateState({
    key: `settings:${path.resolve(userDataPath)}`,
    kind: "settings.save",
    metadata: { settingsPath },
    task: () => withSettingsLock(userDataPath, async () => {
      await recoverSettingsTransaction(userDataPath);
      const previousMain = await readJsonIfExists(settingsPath);
      const previousTool = await readJsonIfExists(toolPath);
      const current = await loadSettingsUnlocked(userDataPath);
      const incoming = isRecord(incomingSettings) ? incomingSettings : {};
      const merged = normalizeSettings({
        executionSandbox: Object.hasOwn(incoming, "executionSandbox")
          ? incoming.executionSandbox
          : current.executionSandbox,
        agentToolExecution: Object.hasOwn(incoming, "agentToolExecution")
          ? incoming.agentToolExecution
          : current.agentToolExecution
      });
      const journalPath = settingsTransactionPath(userDataPath);
      const prepared: SettingsJournal = {
        format: "settings-transaction-journal",
        schema: 2,
        phase: "prepared",
        transactionId: crypto.randomUUID(),
        main: snapshot(previousMain),
        agentToolExecution: snapshot(previousTool)
      };
      await writeJson(journalPath, prepared as unknown as Record<string, unknown>);
      try {
        if (Object.hasOwn(incoming, "agentToolExecution")) {
          await writeJson(toolPath, normalizeAgentToolExecution(incoming.agentToolExecution) as unknown as Record<string, unknown>);
        }
        await writeJson(settingsPath, mainSettings(merged));
        await writeJson(journalPath, {
          ...prepared,
          phase: "committed",
          main: snapshot(mainSettings(merged)),
          agentToolExecution: snapshot(
            Object.hasOwn(incoming, "agentToolExecution")
              ? normalizeAgentToolExecution(incoming.agentToolExecution) as unknown as Record<string, unknown>
              : previousTool
          )
        });
        await fs.rm(journalPath, { force: true });
        return merged;
      } catch (error: unknown) {
        await recoverSettingsTransaction(userDataPath);
        throw error;
      }
    })
  });
}
