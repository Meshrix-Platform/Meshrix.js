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
import { ServerConfig } from "#meshrix/server-config";
import { reconcileStorageRestoreTransactionsSync } from "../../storage/restore-transaction.ts";
import { acquireStorageRuntimeLease } from "../../storage/storage-lifecycle-lock.ts";

export const PACTIUM_MANIFEST_FILE: any = "pactium-manifest.json";
export const PACTIUM_SQLITE_FILE: any = "pactium.sqlite";
export const PROTOCOL_SUBSTRATE_STORAGE_CATEGORY: any = "protocol-substrate";

export function classifyProtocolSubstrateStorageArtifact(relativePath: any = "") : any {
  const value: any = String(relativePath || "").replace(/\\/g, "/");
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

function readJsonSync(filePath?: any) : any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function resolveMeshrixPactiumDataDir(userDataPath: any = "") : any {
  return path.resolve(String(userDataPath || ServerConfig.getDataDir()));
}

export function inspectPactiumFreshDataDir({ userDataPath = "" }: Record<string, any> = {}) : any {
  const dataDir: any = resolveMeshrixPactiumDataDir(userDataPath);
  const manifestPath: any = path.join(dataDir, PACTIUM_MANIFEST_FILE);
  const manifest: any = readJsonSync(manifestPath);
  const findings: any[] = [];

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

export function assertPactiumFreshDataDir(input: Record<string, any> = {}) : any {
  const result: any = inspectPactiumFreshDataDir(input);
  if (result.ok) {
    return result;
  }
  const detail: any = result.findings
    .map((finding?: any) : any => `${finding.kind}: ${finding.path}`)
    .join("; ");
  throw new Error(
    `Pactium ${PACTIUM_PACKAGE_VERSION} requires a current Pactium data directory (${detail}).`
  );
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
