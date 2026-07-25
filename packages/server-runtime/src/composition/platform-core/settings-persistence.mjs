import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentConfigRegistry } from "#meshrix/agents/agent-configs/config-registry";
import { writePrivateFileAtomic } from "@meshrix/foundation/storage/private-file-atomic";
import {
  mutateState,
  waitForStateIdle
} from "../../state/state-coordinator.mjs";
import {
  DEFAULT_SETTINGS,
  getAgentToolExecutionSettingsPath,
  getSettingsPath
} from "./settings-defaults.mjs";
import {
  normalizeAgentToolExecution,
  normalizeModelLibraryAgents,
  normalizeModelLibraryEntries,
  normalizeSettings
} from "./settings-normalizers.mjs";

const REGISTRY_OWNED_FIELDS = new Set([
  "modelLibraryAgents",
  "modelLibraryAgentIds",
  "modelLibraryEntries",
  "modelLibraryRevision"
]);

const CANONICAL_SETTINGS_FIELDS = new Set(Object.keys(DEFAULT_SETTINGS));
const SETTINGS_TRANSACTION_FORMAT = "settings-transaction-journal";
const SETTINGS_TRANSACTION_SCHEMA = 1;
const SETTINGS_TRANSACTION_FILE = ".settings-transaction.json";
const SETTINGS_LOCK_FILE = ".settings.lock";
const SETTINGS_LOCK_WAIT_MS = 10_000;
const SETTINGS_LOCK_STALE_MS = 30_000;
const REGISTRY_POINTER_SCHEMA = "v0.0.1:agent:config-registry-pointer-1";

function nowIso() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settingsLockPath(userDataPath) {
  return path.join(userDataPath, SETTINGS_LOCK_FILE);
}

function settingsTransactionPath(userDataPath) {
  return path.join(userDataPath, "agent-configs", SETTINGS_TRANSACTION_FILE);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readSettingsLockOwner(lockPath) {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

async function settingsLockOwned(lock) {
  const owner = await readSettingsLockOwner(lock.lockPath);
  return owner?.token === lock.token;
}

async function reclaimAbandonedSettingsLock(lockPath) {
  let stat;
  try {
    stat = await fs.stat(lockPath);
  } catch (error) {
    return error?.code === "ENOENT";
  }
  const owner = await readSettingsLockOwner(lockPath);
  const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
  const ownerPid = Number(owner?.pid || 0);
  const ownerRecordComplete = Boolean(owner?.token) && Number.isSafeInteger(ownerPid) && ownerPid > 0;
  if (ageMs < SETTINGS_LOCK_STALE_MS && (!ownerRecordComplete || processIsAlive(ownerPid))) {
    return false;
  }
  const abandonedPath = `${lockPath}.abandoned-${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, abandonedPath);
    await fs.rm(abandonedPath, { force: true });
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function acquireSettingsLock(userDataPath) {
  await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });
  await fs.chmod(userDataPath, 0o700);
  const lockPath = settingsLockPath(userDataPath);
  const token = crypto.randomUUID();
  const deadline = Date.now() + SETTINGS_LOCK_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      let initialized = false;
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: nowIso() })}\n`, "utf8");
        await handle.sync();
        initialized = true;
      } finally {
        await handle.close();
        if (!initialized) await fs.rm(lockPath, { force: true }).catch(() => {});
      }
      return { lockPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await reclaimAbandonedSettingsLock(lockPath)) continue;
      await delay(15 + crypto.randomInt(35));
    }
  }
  const error = new Error("Settings persistence is busy; retry the operation.");
  error.code = "settings_persistence_busy";
  throw error;
}

async function releaseSettingsLock(lock) {
  if (!await settingsLockOwned(lock)) return;
  const releasePath = `${lock.lockPath}.release-${lock.token}`;
  try {
    await fs.rename(lock.lockPath, releasePath);
    await fs.rm(releasePath, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function withSettingsLock(userDataPath, task) {
  const lock = await acquireSettingsLock(userDataPath);
  const heartbeat = setInterval(() => {
    void settingsLockOwned(lock).then((owned) => {
      if (!owned) return;
      const now = new Date();
      return fs.utimes(lock.lockPath, now, now).catch(() => {});
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

function canonicalSettingsInput(settings = {}) {
  return Object.fromEntries(
    Object.entries(settings || {}).filter(([key]) => (
      CANONICAL_SETTINGS_FIELDS.has(key) &&
      !REGISTRY_OWNED_FIELDS.has(key)
    ))
  );
}

function mainSettingsPayload(settings = {}) {
  return Object.fromEntries(
    Object.entries(canonicalSettingsInput(settings)).filter(([key]) => key !== "agentToolExecution")
  );
}

function redactSettingsSecrets(settings = {}) {
  const normalized = normalizeSettings(settings);
  return {
    ...normalized,
    modelLibraryAgents: normalized.modelLibraryAgents.map((entry) => ({
      ...entry,
      apiKey: "",
      token: "",
      apiKeyConfigured: Boolean(entry.apiKey || entry.apiKeyConfigured),
      tokenConfigured: Boolean(entry.token || entry.tokenConfigured)
    }))
  };
}

function agentConfigRegistry(userDataPath) {
  return getAgentConfigRegistry({
    rootPath: path.join(userDataPath, "agent-configs")
  });
}

async function readModelLibraryState(userDataPath) {
  const registry = agentConfigRegistry(userDataPath);
  await registry.refresh();
  return {
    modelLibraryAgents: registry.getModelLibraryAgents(),
    modelLibraryRevision: registry.revision
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function loadAgentToolExecutionSettings(userDataPath) {
  const splitSettings = await readJsonIfExists(getAgentToolExecutionSettingsPath(userDataPath));
  if (!splitSettings) {
    return {};
  }
  return {
    agentToolExecution: splitSettings.agentToolExecution || splitSettings
  };
}

async function writeSettingsJsonDocument(filePath, value) {
  await writePrivateFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeAgentToolExecutionSettings(userDataPath, settings = {}) {
  const filePath = getAgentToolExecutionSettingsPath(userDataPath);
  await writeSettingsJsonDocument(
    filePath,
    normalizeAgentToolExecution(settings.agentToolExecution)
  );
}

async function restoreJsonDocument(filePath, previousValue) {
  if (previousValue === null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await writeSettingsJsonDocument(filePath, previousValue);
}

function documentSnapshot(value) {
  return value === null
    ? { exists: false }
    : { exists: true, value };
}

function pointerSnapshot(pointer = {}) {
  return {
    schemaVersion: REGISTRY_POINTER_SCHEMA,
    generation: String(pointer.generation || ""),
    revision: Number(pointer.revision)
  };
}

function assertDocumentSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || typeof snapshot.exists !== "boolean") {
    throw new Error("Settings transaction document snapshot is invalid.");
  }
  if (snapshot.exists && (!snapshot.value || typeof snapshot.value !== "object" || Array.isArray(snapshot.value))) {
    throw new Error("Settings transaction document value is invalid.");
  }
  return snapshot.exists ? snapshot.value : null;
}

function assertPointerSnapshot(pointer) {
  const normalized = pointerSnapshot(pointer);
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

function assertSettingsTransactionJournal(journal) {
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
  const previous = journal.previous;
  const next = journal.next;
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

async function writeSettingsTransactionJournal(userDataPath, journal) {
  const normalized = assertSettingsTransactionJournal(journal);
  await writePrivateFileAtomic(
    settingsTransactionPath(userDataPath),
    `${JSON.stringify(normalized, null, 2)}\n`
  );
}

async function restoreSettingsSnapshot(userDataPath, snapshot, phase, registryTransaction) {
  const pointer = assertPointerSnapshot(snapshot.registryPointer);
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

async function recoverSettingsTransactionUnlocked(userDataPath, existingRegistryTransaction = null) {
  const journalPath = settingsTransactionPath(userDataPath);
  const journal = await readJsonIfExists(journalPath);
  if (!journal) return false;
  const normalized = assertSettingsTransactionJournal(journal);
  const recover = async (registryTransaction) => {
    const currentJournal = assertSettingsTransactionJournal(await readJsonIfExists(journalPath));
    if (currentJournal.transactionId !== normalized.transactionId) {
      throw new Error("Settings transaction journal changed during recovery.");
    }
    const snapshot = currentJournal.phase === "committed"
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
  const registry = agentConfigRegistry(userDataPath);
  return registry.withCoordinatedTransaction(normalized.transactionId, recover);
}

function settingsStateKey(userDataPath) {
  return `settings:${path.resolve(userDataPath)}`;
}

async function loadSettingsUnlocked(userDataPath, options = {}) {
  const settingsPath = getSettingsPath(userDataPath);
  const parsed = await readJsonIfExists(settingsPath) || {};
  const agentToolExecutionSettings = await loadAgentToolExecutionSettings(userDataPath);
  const modelLibraryState = await readModelLibraryState(userDataPath);
  const normalized = normalizeSettings({
    ...canonicalSettingsInput(parsed),
    ...agentToolExecutionSettings,
    ...modelLibraryState
  });
  return options.redactSecrets ? redactSettingsSecrets(normalized) : normalized;
}

export async function loadSettings(userDataPath, options = {}) {
  await waitForStateIdle(settingsStateKey(userDataPath));
  return withSettingsLock(userDataPath, async () => {
    await recoverSettingsTransactionUnlocked(userDataPath);
    return loadSettingsUnlocked(userDataPath, options);
  });
}

async function saveSettingsUnlocked(
  userDataPath,
  incomingSettings = {},
  options = {},
  { transactionId, registryTransaction } = {}
) {
  const settingsPath = getSettingsPath(userDataPath);
  const agentToolExecutionPath = getAgentToolExecutionSettingsPath(userDataPath);
  const previousMainDocument = await readJsonIfExists(settingsPath);
  const previousAgentToolDocument = await readJsonIfExists(agentToolExecutionPath);
  const current = await loadSettingsUnlocked(userDataPath);
  const incoming = incomingSettings && typeof incomingSettings === "object"
    ? incomingSettings
    : {};
  const nextSettings = {
    ...canonicalSettingsInput(current),
    ...canonicalSettingsInput(incoming)
  };

  const replacesModels = Object.hasOwn(incoming, "modelLibraryAgents") ||
    Object.hasOwn(incoming, "modelLibraryEntries");
  let modelLibraryAgents = Object.hasOwn(incoming, "modelLibraryAgents")
    ? normalizeModelLibraryAgents(incoming.modelLibraryAgents)
    : current.modelLibraryAgents;
  if (Object.hasOwn(incoming, "modelLibraryEntries")) {
    const activeProviders = new Set(normalizeModelLibraryEntries(
      incoming.modelLibraryEntries,
      { modelLibraryEntries: incoming.modelLibraryEntries }
    ));
    modelLibraryAgents = modelLibraryAgents.filter((entry) =>
      activeProviders.has(String(entry.provider || ""))
    );
  }
  nextSettings.modelLibraryAgents = modelLibraryAgents;
  nextSettings.modelLibraryRevision = current.modelLibraryRevision;

  const activeProviders = new Set(modelLibraryAgents.map((entry) => entry.provider));
  if (!activeProviders.has(String(nextSettings.defaultModelProvider || ""))) {
    nextSettings.defaultModelProvider = "";
    nextSettings.defaultModel = "";
  }

  let merged = normalizeSettings(nextSettings);
  const registry = registryTransaction.registry;
  const previousRegistryPointer = assertPointerSnapshot(await registryTransaction.currentPointer());
  let expectedRevision = null;
  if (replacesModels) {
    expectedRevision = Number(incoming.modelLibraryRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      const revisionError = new Error("Model library save requires an explicit modelLibraryRevision.");
      revisionError.code = "model_library_revision_required";
      revisionError.statusCode = 409;
      throw revisionError;
    }
    if (expectedRevision !== previousRegistryPointer.revision) {
      const revisionError = new Error(
        `Model library revision conflict: expected ${expectedRevision}, current ${previousRegistryPointer.revision}.`
      );
      revisionError.code = "model_library_revision_conflict";
      revisionError.statusCode = 409;
      revisionError.expectedRevision = expectedRevision;
      revisionError.currentRevision = previousRegistryPointer.revision;
      throw revisionError;
    }
  }

  const nextAgentToolDocument = Object.hasOwn(incoming, "agentToolExecution")
    ? normalizeAgentToolExecution(incoming.agentToolExecution)
    : previousAgentToolDocument;
  const preparedJournal = {
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
  let journalPrepared = false;
  let journalCommitted = false;
  try {
    await writeSettingsTransactionJournal(userDataPath, preparedJournal);
    journalPrepared = true;
    if (replacesModels) {
      try {
        await registryTransaction.replaceFromModelLibraryAgents(merged.modelLibraryAgents, {
          expectedRevision
        });
      } catch (error) {
        if (error?.code === "agent_config_registry_revision_conflict") {
          const revisionError = new Error(
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
    const committedJournal = {
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
  } catch (error) {
    if (!journalPrepared) throw error;
    try {
      await recoverSettingsTransactionUnlocked(userDataPath, registryTransaction);
      if (journalCommitted) {
        return options.redactSecrets ? redactSettingsSecrets(merged) : merged;
      }
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        "Settings save failed and durable recovery was incomplete."
      );
    }
    throw error;
  }
  return options.redactSecrets ? redactSettingsSecrets(merged) : merged;
}

export async function saveSettings(userDataPath, incomingSettings, options = {}) {
  const settingsPath = getSettingsPath(userDataPath);
  return mutateState({
    key: settingsStateKey(userDataPath),
    kind: "settings.save",
    metadata: { settingsPath },
    task: () => withSettingsLock(userDataPath, async () => {
      await recoverSettingsTransactionUnlocked(userDataPath);
      const transactionId = crypto.randomUUID().replace(/-/g, "");
      const registry = agentConfigRegistry(userDataPath);
      return registry.withCoordinatedTransaction(transactionId, (registryTransaction) =>
        saveSettingsUnlocked(userDataPath, incomingSettings, options, {
          transactionId,
          registryTransaction
        })
      );
    })
  });
}
