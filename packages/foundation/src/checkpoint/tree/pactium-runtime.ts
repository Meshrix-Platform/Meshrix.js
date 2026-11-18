import path from "node:path";
import {
  PACTIUM_PACKAGE_VERSION,
  PACTIUM_PROTOCOL,
  PACTIUM_SCHEMA_VERSION,
  assertCurrentDataDir,
  createPactium,
  createStoragePort,
  createVerifiableIndexEngine
} from "pactium";
import type { PactiumIndexEngine, PactiumStoragePort } from "pactium";
import { ServerConfig } from "#meshrix/server-config";
import { reconcileStorageRestoreTransactionsSync } from "../../storage/restore-transaction.ts";
import { acquireStorageRuntimeLease } from "../../storage/storage-lifecycle-lock.ts";
import type { MeshrixPactiumRuntime } from "./types.ts";
import { isRecord } from "./types.ts";

export interface MeshrixPactiumRuntimeOptions {
  userDataPath?: string;
  dataDir?: string;
  inMemory?: boolean;
  storage?: PactiumStoragePort | null;
  indexEngine?: PactiumIndexEngine | null;
  storageBackend?: string;
  databasePath?: string;
  pactiumRuntime?: MeshrixPactiumRuntime | null;
  runtime?: MeshrixPactiumRuntime | null;
}

function isMeshrixPactiumRuntime(value: unknown): value is MeshrixPactiumRuntime {
  if (!isRecord(value) || !isRecord(value.core) || !isRecord(value.storage) || !isRecord(value.indexEngine)) {
    return false;
  }
  return typeof value.dataDir === "string" &&
    typeof value.core.recordOperation === "function" &&
    typeof value.storage.getProtocolObject === "function" &&
    typeof value.storage.putProtocolObject === "function" &&
    typeof value.indexEngine.createIndex === "function";
}

export function resolveMeshrixPactiumDataDir(userDataPath = ""): string {
  return path.resolve(String(userDataPath || ServerConfig.getDataDir()));
}

export function assertMeshrixPactiumDataDir(userDataPath = ""): void {
  assertCurrentDataDir({ dataDir: resolveMeshrixPactiumDataDir(userDataPath) });
}

export function createMeshrixPactiumRuntime({
  userDataPath = "",
  dataDir = "",
  inMemory = false,
  storage = null,
  indexEngine = null,
  storageBackend = "",
  databasePath = ""
}: MeshrixPactiumRuntimeOptions = {}): MeshrixPactiumRuntime {
  const resolvedDataDir = resolveMeshrixPactiumDataDir(userDataPath || dataDir);
  const resolvedStorageBackend = storageBackend ||
    process.env.MESHRIX_PACTIUM_STORAGE_BACKEND ||
    process.env.PACTIUM_STORAGE_BACKEND ||
    "";
  const ownsStorage = !storage;
  const persistentStorage = !inMemory && storage?.inMemory !== true;
  const runtimeLease = persistentStorage ? acquireStorageRuntimeLease(resolvedDataDir) : null;
  let resolvedStorage: PactiumStoragePort;
  let core: ReturnType<typeof createPactium>;
  let resolvedIndexEngine: PactiumIndexEngine;
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
  } catch (error: unknown) {
    runtimeLease?.release();
    throw error;
  }
  let closePromise: Promise<void> | null = null;
  let closed = false;
  return Object.freeze({
    protocol: PACTIUM_PROTOCOL,
    schema: PACTIUM_SCHEMA_VERSION,
    packageVersion: PACTIUM_PACKAGE_VERSION,
    dataDir: resolvedDataDir,
    core,
    storage: resolvedStorage,
    indexEngine: resolvedIndexEngine,
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      if (closePromise) return closePromise;
      closePromise = (async (): Promise<void> => {
        await core.close?.();
        if (ownsStorage) await resolvedStorage.close?.();
        runtimeLease?.release();
        closed = true;
      })().catch((error: unknown) => {
        closePromise = null;
        throw error;
      });
      return closePromise;
    }
  });
}

export function normalizeMeshrixPactiumRuntime(input: MeshrixPactiumRuntimeOptions = {}): MeshrixPactiumRuntime {
  const runtime = input.pactiumRuntime || input.runtime || null;
  if (isMeshrixPactiumRuntime(runtime)) return runtime;
  return createMeshrixPactiumRuntime(input);
}
