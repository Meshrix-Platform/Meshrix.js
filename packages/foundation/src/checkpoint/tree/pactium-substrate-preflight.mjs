import fs from "node:fs";
import path from "node:path";
import {
  createPactium,
  createStoragePort,
  createVerifiableIndexEngine,
  PACTIUM_PACKAGE_VERSION,
  PACTIUM_PROTOCOL,
  PACTIUM_SCHEMA_VERSION
} from "pactium";
import { ServerConfig } from "#lico/server-config";
import { reconcileStorageRestoreTransactionsSync } from "../../storage/restore-transaction.mjs";
import { acquireStorageRuntimeLease } from "../../storage/storage-lifecycle-lock.mjs";

export const PACTIUM_MANIFEST_FILE = "pactium-manifest.json";
export const PACTIUM_SQLITE_FILE = "pactium.sqlite";
export const PROTOCOL_SUBSTRATE_STORAGE_CATEGORY = "protocol-substrate";

export function classifyProtocolSubstrateStorageArtifact(relativePath = "") {
  const value = String(relativePath || "").replace(/\\/g, "/");
  if (
    value === PACTIUM_MANIFEST_FILE ||
    value === PACTIUM_SQLITE_FILE ||
    value === `${PACTIUM_SQLITE_FILE}-wal` ||
    value === `${PACTIUM_SQLITE_FILE}-shm` ||
    value.startsWith("cas/") ||
    value.startsWith("protocol/")
  ) {
    return PROTOCOL_SUBSTRATE_STORAGE_CATEGORY;
  }
  return "";
}

function readJsonSync(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function resolveLicoPactiumDataDir(userDataPath = "") {
  return path.resolve(String(userDataPath || ServerConfig.getDataDir()));
}

export function inspectPactiumFreshDataDir({ userDataPath = "" } = {}) {
  const dataDir = resolveLicoPactiumDataDir(userDataPath);
  const manifestPath = path.join(dataDir, PACTIUM_MANIFEST_FILE);
  const manifest = readJsonSync(manifestPath);
  const findings = [];

  if (manifest && (manifest.protocol !== PACTIUM_PROTOCOL || manifest.schema !== PACTIUM_SCHEMA_VERSION)) {
    findings.push({
      kind: "non-current-pactium-manifest",
      path: manifestPath,
      detail: `${manifest.protocol || "unknown"}:${manifest.schema || "unknown"}`
    });
  }

  return {
    ok: findings.length === 0,
    dataDir,
    protocol: PACTIUM_PROTOCOL,
    schema: PACTIUM_SCHEMA_VERSION,
    packageVersion: PACTIUM_PACKAGE_VERSION,
    findings
  };
}

export function assertPactiumFreshDataDir(input = {}) {
  const result = inspectPactiumFreshDataDir(input);
  if (result.ok) {
    return result;
  }
  const detail = result.findings
    .map((finding) => `${finding.kind}: ${finding.path}`)
    .join("; ");
  throw new Error(
    `Pactium ${PACTIUM_PACKAGE_VERSION} requires a current Pactium data directory (${detail}).`
  );
}

export function createLicoPactiumRuntime({
  userDataPath = "",
  dataDir = "",
  inMemory = false,
  storage = null,
  indexEngine = null,
  storageBackend = "",
  databasePath = ""
} = {}) {
  const resolvedDataDir = resolveLicoPactiumDataDir(userDataPath || dataDir);
  const resolvedStorageBackend = storageBackend ||
    process.env.LICO_PACTIUM_STORAGE_BACKEND ||
    process.env.PACTIUM_STORAGE_BACKEND ||
    "";
  const ownsStorage = !storage;
  const persistentStorage = !inMemory && storage?.inMemory !== true;
  const runtimeLease = persistentStorage
    ? acquireStorageRuntimeLease(resolvedDataDir)
    : null;
  let resolvedStorage;
  let core;
  let resolvedIndexEngine;
  try {
    if (runtimeLease) reconcileStorageRestoreTransactionsSync(resolvedDataDir);
    assertPactiumFreshDataDir({ userDataPath: resolvedDataDir });
    resolvedStorage = storage || createStoragePort({
      dataDir: resolvedDataDir,
      inMemory,
      storageBackend: resolvedStorageBackend,
      databasePath
    });
    core = createPactium({
      dataDir: resolvedDataDir,
      inMemory,
      storage: resolvedStorage,
      storageBackend: resolvedStorageBackend,
      databasePath
    });
    resolvedIndexEngine = indexEngine || createVerifiableIndexEngine({
      storage: resolvedStorage,
      domain: "licomesh"
    });
  } catch (error) {
    runtimeLease?.release();
    throw error;
  }
  let closePromise = null;
  let closed = false;
  return Object.freeze({
    protocol: PACTIUM_PROTOCOL,
    schema: PACTIUM_SCHEMA_VERSION,
    packageVersion: PACTIUM_PACKAGE_VERSION,
    dataDir: resolvedDataDir,
    core,
    storage: resolvedStorage,
    indexEngine: resolvedIndexEngine,
    close() {
      if (closed) return Promise.resolve();
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await core.close?.();
        if (ownsStorage) await resolvedStorage.close?.();
        runtimeLease?.release();
        closed = true;
      })().catch((error) => {
        closePromise = null;
        throw error;
      });
      return closePromise;
    }
  });
}

export function normalizeLicoPactiumRuntime(input = {}) {
  const runtime = input.pactiumRuntime || input.runtime || null;
  if (runtime?.core && runtime?.storage && runtime?.indexEngine) {
    return runtime;
  }
  return createLicoPactiumRuntime(input);
}
