import path from "node:path";
import {
  PACTIUM_MANIFEST_FILE as PACTIUM_PACKAGE_MANIFEST_FILE,
  PACTIUM_PACKAGE_VERSION,
  PACTIUM_PROTOCOL,
  PACTIUM_SCHEMA_VERSION,
  PACTIUM_SQLITE_FILE as PACTIUM_PACKAGE_SQLITE_FILE,
  PROTOCOL_STORAGE_CATEGORY,
  assertCurrentDataDir,
  classifyProtocolStorageArtifact,
  createPactium,
  createStoragePort,
  createVerifiableIndexEngine,
  inspectDataDir
} from "pactium";
import { ServerConfig } from "#meshrix/server-config";
import { reconcileStorageRestoreTransactionsSync } from "../../storage/restore-transaction.ts";
import { acquireStorageRuntimeLease } from "../../storage/storage-lifecycle-lock.ts";

/** @deprecated Use `PACTIUM_MANIFEST_FILE` from `pactium`. Removal: next major (Meshrix 1.0.0). */
export const PACTIUM_MANIFEST_FILE: any = PACTIUM_PACKAGE_MANIFEST_FILE;
/** @deprecated Use `PACTIUM_SQLITE_FILE` from `pactium`. Removal: next major (Meshrix 1.0.0). */
export const PACTIUM_SQLITE_FILE: any = PACTIUM_PACKAGE_SQLITE_FILE;
/** @deprecated Use `PROTOCOL_STORAGE_CATEGORY` from `pactium`. Removal: next major (Meshrix 1.0.0). */
export const PROTOCOL_SUBSTRATE_STORAGE_CATEGORY: any = PROTOCOL_STORAGE_CATEGORY;

/**
 * @deprecated Use `classifyProtocolStorageArtifact` from `pactium`. Removal: next major (Meshrix 1.0.0).
 */
export function classifyProtocolSubstrateStorageArtifact(relativePath: any = "") : any {
  return classifyProtocolStorageArtifact(relativePath);
}

export function resolveMeshrixPactiumDataDir(userDataPath: any = "") : any {
  return path.resolve(String(userDataPath || ServerConfig.getDataDir()));
}

/**
 * @deprecated Use `inspectDataDir` from `pactium` with an explicit `dataDir`. Removal: next major (Meshrix 1.0.0).
 */
export function inspectPactiumFreshDataDir({ userDataPath = "" }: Record<string, any> = {}) : any {
  return inspectDataDir({ dataDir: resolveMeshrixPactiumDataDir(userDataPath) });
}

/**
 * @deprecated Use `assertCurrentDataDir` from `pactium` with an explicit `dataDir`. Removal: next major (Meshrix 1.0.0).
 */
export function assertPactiumFreshDataDir(input: Record<string, any> = {}) : any {
  const dataDir: any = resolveMeshrixPactiumDataDir(input.userDataPath || input.dataDir || "");
  return assertCurrentDataDir({ dataDir });
}

export function createMeshrixPactiumRuntime({
  userDataPath = "",
  dataDir = "",
  inMemory = false,
  storage = null,
  indexEngine = null,
  storageBackend = "",
  databasePath = ""
}: Record<string, any> = {}) : any {
  const resolvedDataDir: any = resolveMeshrixPactiumDataDir(userDataPath || dataDir);
  const resolvedStorageBackend: any = storageBackend ||
    process.env.MESHRIX_PACTIUM_STORAGE_BACKEND ||
    process.env.PACTIUM_STORAGE_BACKEND ||
    "";
  const ownsStorage: any = !storage;
  const persistentStorage: any = !inMemory && storage?.inMemory !== true;
  const runtimeLease: any = persistentStorage
    ? acquireStorageRuntimeLease(resolvedDataDir)
    : null;
  let resolvedStorage: any;
  let core: any;
  let resolvedIndexEngine: any;
  try {
    if (runtimeLease) reconcileStorageRestoreTransactionsSync(resolvedDataDir);
    assertCurrentDataDir({ dataDir: resolvedDataDir });
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
      domain: "meshrix"
    });
  } catch (error: any) {
    runtimeLease?.release();
    throw error;
  }
  let closePromise: any = null;
  let closed: any = false;
  return Object.freeze({
    protocol: PACTIUM_PROTOCOL,
    schema: PACTIUM_SCHEMA_VERSION,
    packageVersion: PACTIUM_PACKAGE_VERSION,
    dataDir: resolvedDataDir,
    core,
    storage: resolvedStorage,
    indexEngine: resolvedIndexEngine,
    close() : any {
      if (closed) return Promise.resolve();
      if (closePromise) return closePromise;
      closePromise = (async () : Promise<any> => {
        await core.close?.();
        if (ownsStorage) await resolvedStorage.close?.();
        runtimeLease?.release();
        closed = true;
      })().catch((error?: any) : any => {
        closePromise = null;
        throw error;
      });
      return closePromise;
    }
  });
}

export function normalizeMeshrixPactiumRuntime(input: Record<string, any> = {}) : any {
  const runtime: any = input.pactiumRuntime || input.runtime || null;
  if (runtime?.core && runtime?.storage && runtime?.indexEngine) {
    return runtime;
  }
  return createMeshrixPactiumRuntime(input);
}
