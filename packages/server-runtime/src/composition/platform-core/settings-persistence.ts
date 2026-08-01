import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentConfigRegistry } from "#meshrix/agents/agent-configs/config-registry";
import { writePrivateFileAtomic } from "@meshrix/foundation/storage/private-file-atomic";
import {
  mutateState,
  waitForStateIdle
} from "../../state/state-coordinator.ts";
import {
  DEFAULT_SETTINGS,
  getAgentToolExecutionSettingsPath,
  getSettingsPath
} from "./settings-defaults.ts";
import {
  normalizeAgentToolExecution,
  normalizeModelLibraryAgents,
  normalizeModelLibraryEntries,
  normalizeSettings
} from "./settings-normalizers.ts";

const REGISTRY_OWNED_FIELDS: any = new Set<any>([
  "modelLibraryAgents",
  "modelLibraryAgentIds",
  "modelLibraryEntries",
  "modelLibraryRevision"
]);

const CANONICAL_SETTINGS_FIELDS: any = new Set<any>(Object.keys(DEFAULT_SETTINGS));
const SETTINGS_TRANSACTION_FORMAT: any = "settings-transaction-journal";
const SETTINGS_TRANSACTION_SCHEMA: any = 1;
const SETTINGS_TRANSACTION_FILE: any = ".settings-transaction.json";
const SETTINGS_LOCK_FILE: any = ".settings.lock";
const SETTINGS_LOCK_WAIT_MS: any = 10_000;
const SETTINGS_LOCK_STALE_MS: any = 30_000;
const REGISTRY_POINTER_SCHEMA: any = "v0.0.1:agent:config-registry-pointer-1";

function nowIso() : any {
  return new Date().toISOString();
}

function delay(ms?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

function settingsLockPath(userDataPath?: any) : any {
  return path.join(userDataPath, SETTINGS_LOCK_FILE);
}

function settingsTransactionPath(userDataPath?: any) : any {
  return path.join(userDataPath, "agent-configs", SETTINGS_TRANSACTION_FILE);
}

function processIsAlive(pid?: any) : any {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

async function readSettingsLockOwner(lockPath?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

async function settingsLockOwned(lock?: any) : Promise<any> {
  const owner: any = await readSettingsLockOwner(lock.lockPath);
  return owner?.token === lock.token;
}

async function reclaimAbandonedSettingsLock(lockPath?: any) : Promise<any> {
  let stat: any;
  try {
    stat = await fs.stat(lockPath);
  } catch (error: any) {
    return error?.code === "ENOENT";
  }
  const owner: any = await readSettingsLockOwner(lockPath);
  const ageMs: any = Math.max(0, Date.now() - stat.mtimeMs);
  const ownerPid: any = Number(owner?.pid || 0);
  const ownerRecordComplete: any = Boolean(owner?.token) && Number.isSafeInteger(ownerPid) && ownerPid > 0;
  if (ageMs < SETTINGS_LOCK_STALE_MS && (!ownerRecordComplete || processIsAlive(ownerPid))) {
    return false;
  }
  const abandonedPath: any = `${lockPath}.abandoned-${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, abandonedPath);
    await fs.rm(abandonedPath, { force: true });
    return true;
  } catch (error: any) {
    return error?.code === "ENOENT";
  }
}

async function acquireSettingsLock(userDataPath?: any) : Promise<any> {
  await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });
  await fs.chmod(userDataPath, 0o700);
  const lockPath: any = settingsLockPath(userDataPath);
  const token: any = crypto.randomUUID();
  const deadline: any = Date.now() + SETTINGS_LOCK_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      const handle: any = await fs.open(lockPath, "wx", 0o600);
      let initialized: any = false;
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: nowIso() })}\n`, "utf8");
        await handle.sync();
        initialized = true;
      } finally {
        await handle.close();
        if (!initialized) await fs.rm(lockPath, { force: true }).catch(() : any => {});
      }
      return { lockPath, token };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (await reclaimAbandonedSettingsLock(lockPath)) continue;
      await delay(15 + crypto.randomInt(35));
    }
  }
  const error: Error & Record<string, any> = new Error("Settings persistence is busy; retry the operation.");
  error.code = "settings_persistence_busy";
  throw error;
}

async function releaseSettingsLock(lock?: any) : Promise<any> {
  if (!await settingsLockOwned(lock)) return;
  const releasePath: any = `${lock.lockPath}.release-${lock.token}`;
  try {
    await fs.rename(lock.lockPath, releasePath);
    await fs.rm(releasePath, { force: true });
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function withSettingsLock(userDataPath?: any, task?: any) : Promise<any> {
  const lock: any = await acquireSettingsLock(userDataPath);
  const heartbeat: any = setInterval(() : any => {
    void settingsLockOwned(lock).then((owned?: any) : any => {
      if (!owned) return;
      const now: any = new Date();
      return fs.utimes(lock.lockPath, now, now).catch(() : any => {});
    });
  }, Math.floor(SETTINGS_LOCK_STALE_MS / 3));
  heartbeat.unref?.();
  try {
    return await task();
  } finally {
    clearInterval(heartbeat);
    await releaseSettingsLock(lock);
  }
}

function canonicalSettingsInput(settings: Record<string, any> = {}) : any {
  return Object.fromEntries(
    (Object.entries(settings || {}) as [string, any][]).filter(([key]: any[]) : any => (
      CANONICAL_SETTINGS_FIELDS.has(key) &&
      !REGISTRY_OWNED_FIELDS.has(key)
    ))
  );
}

function mainSettingsPayload(settings: Record<string, any> = {}) : any {
  return Object.fromEntries(
    (Object.entries(canonicalSettingsInput(settings)) as [string, any][]).filter(([key]: any[]) : any => key !== "agentToolExecution")
  );
}

function redactSettingsSecrets(settings: Record<string, any> = {}) : any {
  const normalized: any = normalizeSettings(settings);
  return {
    ...normalized,
    modelLibraryAgents: normalized.modelLibraryAgents.map((entry?: any) : any => ({
      ...entry,
      apiKey: "",
      token: "",
      apiKeyConfigured: Boolean(entry.apiKey || entry.apiKeyConfigured),
      tokenConfigured: Boolean(entry.token || entry.tokenConfigured)
    }))
  };
}

function agentConfigRegistry(userDataPath?: any) : any {
  return getAgentConfigRegistry({
    rootPath: path.join(userDataPath, "agent-configs")
  });
}

async function readModelLibraryState(userDataPath?: any) : Promise<any> {
  const registry: any = agentConfigRegistry(userDataPath);
  await registry.refresh();
  return {
    modelLibraryAgents: registry.getModelLibraryAgents(),
    modelLibraryRevision: registry.revision
  };
}

async function readJsonIfExists(filePath?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function loadAgentToolExecutionSettings(userDataPath?: any) : Promise<any> {
  const splitSettings: any = await readJsonIfExists(getAgentToolExecutionSettingsPath(userDataPath));
  if (!splitSettings) {
    return {};
  }
  return {
    agentToolExecution: splitSettings.agentToolExecution || splitSettings
  };
}

async function writeSettingsJsonDocument(filePath?: any, value?: any) : Promise<any> {
  await writePrivateFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeAgentToolExecutionSettings(userDataPath?: any, settings: Record<string, any> = {}) : Promise<any> {
  const filePath: any = getAgentToolExecutionSettingsPath(userDataPath);
  await writeSettingsJsonDocument(
    filePath,
    normalizeAgentToolExecution(settings.agentToolExecution)
  );
}

async function restoreJsonDocument(filePath?: any, previousValue?: any) : Promise<any> {
  if (previousValue === null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await writeSettingsJsonDocument(filePath, previousValue);
}

function documentSnapshot(value?: any) : any {
  return value === null
    ? { exists: false }
    : { exists: true, value };
}

function pointerSnapshot(pointer: Record<string, any> = {}) : any {
  return {
    schemaVersion: REGISTRY_POINTER_SCHEMA,
    generation: String(pointer.generation || ""),
    revision: Number(pointer.revision)
  };
}

function assertDocumentSnapshot(snapshot?: any) : any {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || typeof snapshot.exists !== "boolean") {
    throw new Error("Settings transaction document snapshot is invalid.");
  }
  if (snapshot.exists && (!snapshot.value || typeof snapshot.value !== "object" || Array.isArray(snapshot.value))) {
    throw new Error("Settings transaction document value is invalid.");
  }
  return snapshot.exists ? snapshot.value : null;
}

function assertPointerSnapshot(pointer?: any) : any {
  const normalized: any = pointerSnapshot(pointer);
  if (
    pointer?.schemaVersion !== REGISTRY_POINTER_SCHEMA ||
    !/^generation-[a-z0-9-]+$/u.test(normalized.generation) ||
    !Number.isSafeInteger(normalized.revision) ||
    normalized.revision < 0
  ) {
    throw new Error("Settings transaction registry pointer is invalid.");
  }
  return normalized;
}

function assertSettingsTransactionJournal(journal?: any) : any {
  if (
    !journal ||
    typeof journal !== "object" ||
    Array.isArray(journal) ||
    journal.format !== SETTINGS_TRANSACTION_FORMAT ||
    journal.schema !== SETTINGS_TRANSACTION_SCHEMA ||
    !["prepared", "committed"].includes(journal.phase) ||
    !/^[a-f0-9]{32}$/u.test(String(journal.transactionId || ""))
  ) {
    throw new Error("Settings transaction journal is invalid.");
  }
  const previous: any = journal.previous;
  const next: any = journal.next;
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
    throw new Error("Settings transaction previous state is invalid.");
  }
  assertDocumentSnapshot(previous.main);
  assertDocumentSnapshot(previous.agentToolExecution);
  assertPointerSnapshot(previous.registryPointer);
  if (journal.phase === "committed") {
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new Error("Settings transaction committed state is invalid.");
    }
    assertDocumentSnapshot(next.main);
    assertDocumentSnapshot(next.agentToolExecution);
    assertPointerSnapshot(next.registryPointer);
  }
  return journal;
}

async function writeSettingsTransactionJournal(userDataPath?: any, journal?: any) : Promise<any> {
  const normalized: any = assertSettingsTransactionJournal(journal);
  await writePrivateFileAtomic(
    settingsTransactionPath(userDataPath),
    `${JSON.stringify(normalized, null, 2)}\n`
  );
}

async function restoreSettingsSnapshot(userDataPath?: any, snapshot?: any, phase?: any, registryTransaction?: any) : Promise<any> {
  const pointer: any = assertPointerSnapshot(snapshot.registryPointer);
  await registryTransaction.restoreGeneration(pointer, {
    allowedCurrentRevisions: phase === "prepared"
      ? [pointer.revision, pointer.revision + 1]
      : [pointer.revision],
    discardReplacedGeneration: phase === "prepared"
  });
  await restoreJsonDocument(
    getAgentToolExecutionSettingsPath(userDataPath),
    assertDocumentSnapshot(snapshot.agentToolExecution)
  );
  await restoreJsonDocument(
    getSettingsPath(userDataPath),
    assertDocumentSnapshot(snapshot.main)
  );
}

async function recoverSettingsTransactionUnlocked(userDataPath?: any, existingRegistryTransaction: any = null) : Promise<any> {
  const journalPath: any = settingsTransactionPath(userDataPath);
  const journal: any = await readJsonIfExists(journalPath);
  if (!journal) return false;
  const normalized: any = assertSettingsTransactionJournal(journal);
  const recover: any = async (registryTransaction?: any) : Promise<any> => {
    const currentJournal: any = assertSettingsTransactionJournal(await readJsonIfExists(journalPath));
    if (currentJournal.transactionId !== normalized.transactionId) {
      throw new Error("Settings transaction journal changed during recovery.");
    }
    const snapshot: any = currentJournal.phase === "committed"
      ? currentJournal.next
      : currentJournal.previous;
    await restoreSettingsSnapshot(
      userDataPath,
      snapshot,
      currentJournal.phase,
      registryTransaction
    );
    await fs.rm(journalPath, { force: true });
    return true;
  };
  if (existingRegistryTransaction) {
    return recover(existingRegistryTransaction);
  }
  const registry: any = agentConfigRegistry(userDataPath);
  return registry.withCoordinatedTransaction(normalized.transactionId, recover);
}

function settingsStateKey(userDataPath?: any) : any {
  return `settings:${path.resolve(userDataPath)}`;
}

async function loadSettingsUnlocked(userDataPath?: any, options: Record<string, any> = {}) : Promise<any> {
  const settingsPath: any = getSettingsPath(userDataPath);
  const parsed: any = await readJsonIfExists(settingsPath) || {};
  const agentToolExecutionSettings: any = await loadAgentToolExecutionSettings(userDataPath);
  const modelLibraryState: any = await readModelLibraryState(userDataPath);
  const normalized: any = normalizeSettings({
    ...canonicalSettingsInput(parsed),
    ...agentToolExecutionSettings,
    ...modelLibraryState
  });
  return options.redactSecrets ? redactSettingsSecrets(normalized) : normalized;
}

export async function loadSettings(userDataPath?: any, options: Record<string, any> = {}) : Promise<any> {
  await waitForStateIdle(settingsStateKey(userDataPath));
  return withSettingsLock(userDataPath, async () : Promise<any> => {
    await recoverSettingsTransactionUnlocked(userDataPath);
    return loadSettingsUnlocked(userDataPath, options);
  });
}

async function saveSettingsUnlocked(
  userDataPath?: any,
  incomingSettings: Record<string, any> = {},
  options: Record<string, any> = {},
  { transactionId, registryTransaction }: Record<string, any> = {}
) : Promise<any> {
  const settingsPath: any = getSettingsPath(userDataPath);
  const agentToolExecutionPath: any = getAgentToolExecutionSettingsPath(userDataPath);
  const previousMainDocument: any = await readJsonIfExists(settingsPath);
  const previousAgentToolDocument: any = await readJsonIfExists(agentToolExecutionPath);
  const current: any = await loadSettingsUnlocked(userDataPath);
  const incoming: any = incomingSettings && typeof incomingSettings === "object"
    ? incomingSettings
    : {};
  const nextSettings: Record<string, any> = {
    ...canonicalSettingsInput(current),
    ...canonicalSettingsInput(incoming)
  };

  const replacesModels: any = Object.hasOwn(incoming, "modelLibraryAgents") ||
    Object.hasOwn(incoming, "modelLibraryEntries");
  let modelLibraryAgents: any = Object.hasOwn(incoming, "modelLibraryAgents")
    ? normalizeModelLibraryAgents(incoming.modelLibraryAgents)
    : current.modelLibraryAgents;
  if (Object.hasOwn(incoming, "modelLibraryEntries")) {
    const activeProviders: any = new Set<any>(normalizeModelLibraryEntries(
      incoming.modelLibraryEntries,
      { modelLibraryEntries: incoming.modelLibraryEntries }
    ));
    modelLibraryAgents = modelLibraryAgents.filter((entry?: any) : any =>
      activeProviders.has(String(entry.provider || ""))
    );
  }
  nextSettings.modelLibraryAgents = modelLibraryAgents;
  nextSettings.modelLibraryRevision = current.modelLibraryRevision;

  const activeProviders: any = new Set<any>(modelLibraryAgents.map((entry?: any) : any => entry.provider));
  if (!activeProviders.has(String(nextSettings.defaultModelProvider || ""))) {
    nextSettings.defaultModelProvider = "";
    nextSettings.defaultModel = "";
  }

  let merged: any = normalizeSettings(nextSettings);
  const registry: any = registryTransaction.registry;
  const previousRegistryPointer: any = assertPointerSnapshot(await registryTransaction.currentPointer());
  let expectedRevision: any = null;
  if (replacesModels) {
    expectedRevision = Number(incoming.modelLibraryRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      const revisionError: Error & Record<string, any> = new Error("Model library save requires an explicit modelLibraryRevision.");
      revisionError.code = "model_library_revision_required";
      revisionError.statusCode = 409;
      throw revisionError;
    }
    if (expectedRevision !== previousRegistryPointer.revision) {
      const revisionError: Error & Record<string, any> = new Error(
        `Model library revision conflict: expected ${expectedRevision}, current ${previousRegistryPointer.revision}.`
      );
      revisionError.code = "model_library_revision_conflict";
      revisionError.statusCode = 409;
      revisionError.expectedRevision = expectedRevision;
      revisionError.currentRevision = previousRegistryPointer.revision;
      throw revisionError;
    }
  }

  const nextAgentToolDocument: any = Object.hasOwn(incoming, "agentToolExecution")
    ? normalizeAgentToolExecution(incoming.agentToolExecution)
    : previousAgentToolDocument;
  const preparedJournal: Record<string, any> = {
    format: SETTINGS_TRANSACTION_FORMAT,
    schema: SETTINGS_TRANSACTION_SCHEMA,
    phase: "prepared",
    transactionId,
    createdAt: nowIso(),
    previous: {
      main: documentSnapshot(previousMainDocument === null ? null : mainSettingsPayload(previousMainDocument)),
      agentToolExecution: documentSnapshot(previousAgentToolDocument),
      registryPointer: previousRegistryPointer
    }
  };
  let journalPrepared: any = false;
  let journalCommitted: any = false;
  try {
    await writeSettingsTransactionJournal(userDataPath, preparedJournal);
    journalPrepared = true;
    if (replacesModels) {
      try {
        await registryTransaction.replaceFromModelLibraryAgents(merged.modelLibraryAgents, {
          expectedRevision
        });
      } catch (error: any) {
        if (error?.code === "agent_config_registry_revision_conflict") {
          const revisionError: Error & Record<string, any> = new Error(
            `Model library revision conflict: expected ${error.expectedRevision}, current ${error.currentRevision}.`
          );
          revisionError.code = "model_library_revision_conflict";
          revisionError.statusCode = 409;
          revisionError.expectedRevision = error.expectedRevision;
          revisionError.currentRevision = error.currentRevision;
          throw revisionError;
        }
        throw error;
      }
      modelLibraryAgents = registry.getModelLibraryAgents();
      merged = normalizeSettings({
        ...nextSettings,
        modelLibraryAgents,
        modelLibraryRevision: registry.revision
      });
    }
    if (Object.hasOwn(incoming, "agentToolExecution")) {
      await writeAgentToolExecutionSettings(userDataPath, {
        agentToolExecution: incoming.agentToolExecution
      });
      merged.agentToolExecution = normalizeAgentToolExecution(incoming.agentToolExecution);
    }
    await writeSettingsJsonDocument(settingsPath, mainSettingsPayload(merged));
    const committedJournal: Record<string, any> = {
      ...preparedJournal,
      phase: "committed",
      committedAt: nowIso(),
      next: {
        main: documentSnapshot(mainSettingsPayload(merged)),
        agentToolExecution: documentSnapshot(nextAgentToolDocument),
        registryPointer: assertPointerSnapshot(await registryTransaction.currentPointer())
      }
    };
    await writeSettingsTransactionJournal(userDataPath, committedJournal);
    journalCommitted = true;
    await fs.rm(settingsTransactionPath(userDataPath), { force: true });
  } catch (error: any) {
    if (!journalPrepared) throw error;
    try {
      await recoverSettingsTransactionUnlocked(userDataPath, registryTransaction);
      if (journalCommitted) {
        return options.redactSecrets ? redactSettingsSecrets(merged) : merged;
      }
    } catch (recoveryError: any) {
      throw new AggregateError(
        [error, recoveryError],
        "Settings save failed and durable recovery was incomplete."
      );
    }
    throw error;
  }
  return options.redactSecrets ? redactSettingsSecrets(merged) : merged;
}

export async function saveSettings(userDataPath?: any, incomingSettings?: any, options: Record<string, any> = {}) : Promise<any> {
  const settingsPath: any = getSettingsPath(userDataPath);
  return mutateState({
    key: settingsStateKey(userDataPath),
    kind: "settings.save",
    metadata: { settingsPath },
    task: () : any => withSettingsLock(userDataPath, async () : Promise<any> => {
      await recoverSettingsTransactionUnlocked(userDataPath);
      const transactionId: any = crypto.randomUUID().replace(/-/g, "");
      const registry: any = agentConfigRegistry(userDataPath);
      return registry.withCoordinatedTransaction(transactionId, (registryTransaction?: any) : any =>
        saveSettingsUnlocked(userDataPath, incomingSettings, options, {
          transactionId,
          registryTransaction
        })
      );
    })
  });
}
