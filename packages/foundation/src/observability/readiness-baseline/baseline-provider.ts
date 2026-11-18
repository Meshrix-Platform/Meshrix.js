import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appendBoundedJsonLine } from "../../storage/bounded-jsonl.ts";

export const READINESS_BASELINE_PROTOCOL_VERSION: any = "v0.0.1:platform:baseline-1";

const CONFIG_FILES: Readonly<Record<string, any>> = Object.freeze({
  modules: "modules.json",
  connectors: "connectors.json",
  featureProfiles: "feature-profiles.json",
  externalTargets: "external-targets.json"
});

const STORAGE_STATES: readonly any[] = Object.freeze([
  "queued",
  "staged",
  "archived",
  "committed",
  "synced",
  "projected",
  "cached",
  "contractVerified"
]);
const READINESS_AUDIT_MAX_BYTES: any = 16 * 1024 * 1024;
const PUBLIC_PORT_SUMMARY_FIELDS: readonly any[] = Object.freeze([
  "port",
  "implementation",
  "verificationMode",
  "recordCount",
  "entryCount",
  "taskCount",
  "queuedCount",
  "artifactCount",
  "secretRefCount",
  "counts"
]);

function isoNow() : any {
  return new Date().toISOString();
}

function ensureObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}


function sha256(value?: any) : any {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function compactHash(value?: any) : any {
  return sha256(typeof value === "string" || Buffer.isBuffer(value) ? value : stableJson(value)).slice("sha256:".length, 28);
}

function projectPublicPortSummary(summary: Record<string, any> = {}) : any {
  return Object.fromEntries(
    PUBLIC_PORT_SUMMARY_FIELDS
      .filter((field?: any) : any => summary[field] !== undefined)
      .map((field?: any) : any => [field, summary[field]])
  );
}

async function ensureDir(dirPath?: any) : Promise<any> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath?: any, fallback?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath?: any, payload?: any) : Promise<any> {
  await ensureDir(path.dirname(filePath));
  const tempPath: any = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function appendJsonl(filePath?: any, payload?: any) : Promise<any> {
  await appendBoundedJsonLine(filePath, payload, {
    maxBytes: READINESS_AUDIT_MAX_BYTES,
    retainedBytes: READINESS_AUDIT_MAX_BYTES / 2
  });
}

function normalizeConfigList(value?: any) : any {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.items)) {
    return value.items;
  }
  if (Array.isArray(value?.entries)) {
    return value.entries;
  }
  if (Array.isArray(value?.targets)) {
    return value.targets;
  }
  return [];
}

function normalizeConfigItem(item: Record<string, any> = {}) : any {
  const normalized: any = ensureObject(item);
  const id: any = String(normalized.id || normalized.name || normalized.key || "").trim();
  return {
    ...normalized,
    id,
    enabled: normalized.enabled !== false
  };
}

function createConfigRegistryPort({ rootPath }: Record<string, any>) : any {
  const configRoot: any = path.join(rootPath, "config-registry");

  function filePath(kind?: any) : any {
    const name: any = CONFIG_FILES[kind];
    if (!name) {
      throw new Error(`Unknown readiness baseline config registry kind: ${kind}`);
    }
    return path.join(configRoot, name);
  }

  async function readConfig(kind?: any) : Promise<any> {
    const payload: any = await readJson(filePath(kind), { schemaVersion: "v0.0.1:schema:definition-1", kind, items: [] });
    const items: any = normalizeConfigList(payload).map(normalizeConfigItem).filter((item?: any) : any => item.id);
    return {
      schemaVersion: String(payload.schemaVersion || "v0.0.1:schema:definition-1"),
      kind,
      path: filePath(kind),
      items
    };
  }

  async function writeConfig(kind?: any, payload: Record<string, any> = {}) : Promise<any> {
    const items: any = normalizeConfigList(payload).map(normalizeConfigItem).filter((item?: any) : any => item.id);
    const next: Record<string, any> = {
      schemaVersion: "v0.0.1:schema:definition-1",
      kind,
      updatedAt: isoNow(),
      items
    };
    await writeJson(filePath(kind), next);
    return {
      ...next,
      path: filePath(kind)
    };
  }

  async function upsert(kind?: any, item: Record<string, any> = {}) : Promise<any> {
    const current: any = await readConfig(kind);
    const normalized: any = normalizeConfigItem(item);
    if (!normalized.id) {
      throw new Error("Config registry item id is required.");
    }
    const items: any = current.items.filter((entry?: any) : any => entry.id !== normalized.id);
    items.push(normalized);
    return writeConfig(kind, { items });
  }

  async function listEnabled() : Promise<any> {
    const [modules, connectors, featureProfiles, externalTargets] = await Promise.all([
      readConfig("modules"),
      readConfig("connectors"),
      readConfig("featureProfiles"),
      readConfig("externalTargets")
    ]);
    return {
      modules: modules.items.filter((item?: any) : any => item.enabled),
      connectors: connectors.items.filter((item?: any) : any => item.enabled),
      featureProfiles: featureProfiles.items.filter((item?: any) : any => item.enabled),
      externalTargets: externalTargets.items.filter((item?: any) : any => item.enabled)
    };
  }

  async function summary() : Promise<any> {
    const [modules, connectors, featureProfiles, externalTargets] = await Promise.all([
      readConfig("modules"),
      readConfig("connectors"),
      readConfig("featureProfiles"),
      readConfig("externalTargets")
    ]);
    return {
      port: "ConfigRegistryPort",
      implementation: "local-json",
      configRoot,
      files: Object.fromEntries((Object.entries(CONFIG_FILES) as [string, any][]).map(([kind, fileName]: any[]) : any => [kind, path.join(configRoot, fileName)])),
      counts: {
        modules: modules.items.length,
        connectors: connectors.items.length,
        featureProfiles: featureProfiles.items.length,
        externalTargets: externalTargets.items.length
      },
      enabled: await listEnabled()
    };
  }

  return Object.freeze({
    protocolVersion: READINESS_BASELINE_PROTOCOL_VERSION,
    configRoot,
    readConfig,
    writeConfig,
    upsert,
    listEnabled,
    summary
  });
}

function createMetadataStorePort({ rootPath }: Record<string, any>) : any {
  const filePath: any = path.join(rootPath, "metadata-store", "records.json");

  async function readAll() : Promise<any> {
    return ensureObject(await readJson(filePath, { schemaVersion: "v0.0.1:schema:definition-1", records: {} }), { schemaVersion: "v0.0.1:schema:definition-1", records: {} });
  }

  async function put(record: Record<string, any> = {}) : Promise<any> {
    const id: any = String(record.id || `meta_${compactHash({ record, createdAt: isoNow() })}`).trim();
    const store: any = await readAll();
    store.records = ensureObject(store.records);
    store.records[id] = {
      ...ensureObject(record),
      id,
      updatedAt: isoNow()
    };
    await writeJson(filePath, store);
    return store.records[id];
  }

  async function get(id?: any) : Promise<any> {
    const store: any = await readAll();
    return store.records?.[String(id)] || null;
  }

  async function list() : Promise<any> {
    const store: any = await readAll();
    return (Object.values(ensureObject(store.records)) as any[]);
  }

  return Object.freeze({
    protocolVersion: READINESS_BASELINE_PROTOCOL_VERSION,
    implementation: "local-json",
    path: filePath,
    put,
    get,
    list,
    async summary() : Promise<any> {
      return {
        port: "MetadataStorePort",
        implementation: "local-json",
        path: filePath,
        recordCount: (await list()).length
      };
    }
  });
}

function createCachePort({ rootPath }: Record<string, any>) : any {
  const filePath: any = path.join(rootPath, "cache", "cache.json");

  async function readAll() : Promise<any> {
    return ensureObject(await readJson(filePath, { schemaVersion: "v0.0.1:schema:definition-1", entries: {} }), { schemaVersion: "v0.0.1:schema:definition-1", entries: {} });
  }

  function cacheId({ scope = "default", key = "" }: Record<string, any> = {}) : any {
    return `${scope}:${key}`;
  }

  async function set({ scope = "default", key, value, ttlMs = 0 }: Record<string, any> = {}) : Promise<any> {
    if (!key) {
      throw new Error("Cache key is required.");
    }
    const store: any = await readAll();
    const id: any = cacheId({ scope, key });
    const expiresAt: any = Number(ttlMs) > 0 ? new Date(Date.now() + Number(ttlMs)).toISOString() : "";
    store.entries[id] = {
      scope,
      key,
      value,
      valueHash: sha256(stableJson(value)),
      expiresAt,
      updatedAt: isoNow()
    };
    await writeJson(filePath, store);
    return {
      cacheKey: id,
      expiresAt,
      status: "cached"
    };
  }

  async function get({ scope = "default", key }: Record<string, any> = {}) : Promise<any> {
    const store: any = await readAll();
    const entry: any = store.entries?.[cacheId({ scope, key })];
    if (!entry) {
      return { hit: false, status: "missing" };
    }
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) {
      return { hit: false, status: "expired", cacheKey: cacheId({ scope, key }) };
    }
    return {
      hit: true,
      status: "cached",
      cacheKey: cacheId({ scope, key }),
      value: entry.value,
      valueHash: entry.valueHash,
      expiresAt: entry.expiresAt
    };
  }

  async function invalidate({ scope = "default", key }: Record<string, any> = {}) : Promise<any> {
    const store: any = await readAll();
    const id: any = cacheId({ scope, key });
    const existed: any = Boolean(store.entries?.[id]);
    delete store.entries[id];
    await writeJson(filePath, store);
    return { cacheKey: id, invalidated: existed };
  }

  return Object.freeze({
    protocolVersion: READINESS_BASELINE_PROTOCOL_VERSION,
    implementation: "local-file-cache",
    path: filePath,
    set,
    get,
    invalidate,
    async summary() : Promise<any> {
      const store: any = await readAll();
      return {
        port: "CachePort",
        implementation: "local-file-cache",
        path: filePath,
        entryCount: Object.keys(ensureObject(store.entries)).length
      };
    }
  });
}

function createQueuePort({ rootPath }: Record<string, any>) : any {
  const filePath: any = path.join(rootPath, "queue", "tasks.json");

  async function readAll() : Promise<any> {
    return ensureObject(await readJson(filePath, { schemaVersion: "v0.0.1:schema:definition-1", tasks: [] }), { schemaVersion: "v0.0.1:schema:definition-1", tasks: [] });
  }

  async function writeAll(store?: any) : Promise<any> {
    await writeJson(filePath, { schemaVersion: "v0.0.1:schema:definition-1", tasks: Array.isArray(store.tasks) ? store.tasks : [] });
  }

  async function enqueue({ queueName = "default", payload = {}, idempotencyKey = "" }: Record<string, any> = {}) : Promise<any> {
    const store: any = await readAll();
    const existing: any = idempotencyKey
      ? store.tasks.find((task?: any) : any => task.idempotencyKey === idempotencyKey && task.queueName === queueName)
      : null;
    if (existing) {
      return { ...existing, deduped: true };
    }
    const task: Record<string, any> = {
      taskId: `task_${compactHash({ queueName, payload, createdAt: isoNow(), nonce: crypto.randomUUID() })}`,
      queueName,
      payload,
      idempotencyKey,
      status: "queued",
      attempts: 0,
      createdAt: isoNow(),
      updatedAt: isoNow()
    };
    store.tasks.push(task);
    await writeAll(store);
    return task;
  }

  async function claim({ queueName = "default", workerId = "worker" }: Record<string, any> = {}) : Promise<any> {
    const store: any = await readAll();
    const task: any = store.tasks.find((item?: any) : any => item.queueName === queueName && item.status === "queued");
    if (!task) {
      return null;
    }
    task.status = "claimed";
    task.workerId = workerId;
    task.attempts = Number(task.attempts || 0) + 1;
    task.claimedAt = isoNow();
    task.updatedAt = isoNow();
    await writeAll(store);
    return task;
  }

  async function heartbeat({ taskId, workerId = "worker" }: Record<string, any> = {}) : Promise<any> {
    const store: any = await readAll();
    const task: any = store.tasks.find((item?: any) : any => item.taskId === taskId);
    if (!task) {
      return null;
    }
    task.workerId = task.workerId || workerId;
    task.heartbeatAt = isoNow();
    task.updatedAt = isoNow();
    await writeAll(store);
    return task;
  }

  async function complete({ taskId, result = {} }: Record<string, any> = {}) : Promise<any> {
    const store: any = await readAll();
    const task: any = store.tasks.find((item?: any) : any => item.taskId === taskId);
    if (!task) {
      return null;
    }
    task.status = "completed";
    task.result = result;
    task.completedAt = isoNow();
    task.updatedAt = isoNow();
    await writeAll(store);
    return task;
  }

  async function list({ queueName = "" }: Record<string, any> = {}) : Promise<any> {
    const store: any = await readAll();
    return (Array.isArray(store.tasks) ? store.tasks : [])
      .filter((task?: any) : any => !queueName || task.queueName === queueName);
  }

  return Object.freeze({
    protocolVersion: READINESS_BASELINE_PROTOCOL_VERSION,
    implementation: "local-durable-json-queue",
    path: filePath,
    enqueue,
    claim,
    heartbeat,
    complete,
    list,
    async summary() : Promise<any> {
      const tasks: any = await list();
      return {
        port: "QueuePort",
        implementation: "local-durable-json-queue",
        path: filePath,
        taskCount: tasks.length,
        queuedCount: tasks.filter((task?: any) : any => task.status === "queued").length
      };
    }
  });
}

function createArtifactStorePort({ rootPath }: Record<string, any>) : any {
  const artifactRoot: any = path.join(rootPath, "artifact-store");
  const blobRoot: any = path.join(artifactRoot, "blobs");
  const manifestPath: any = path.join(artifactRoot, "manifest.json");

  async function readManifest() : Promise<any> {
    return ensureObject(await readJson(manifestPath, { schemaVersion: "v0.0.1:schema:definition-1", artifacts: {} }), { schemaVersion: "v0.0.1:schema:definition-1", artifacts: {} });
  }

  async function putArtifact({ bytes, text, json, contentType = "application/octet-stream", metadata = {} }: Record<string, any> = {}) : Promise<any> {
    let buffer: any;
    if (Buffer.isBuffer(bytes)) {
      buffer = bytes;
    } else if (typeof text === "string") {
      buffer = Buffer.from(text, "utf8");
    } else if (json !== undefined) {
      buffer = Buffer.from(stableJson(json), "utf8");
      contentType = contentType === "application/octet-stream" ? "application/json" : contentType;
    } else {
      throw new Error("Artifact bytes, text, or json is required.");
    }
    const digest: any = sha256(buffer);
    const artifactRef: any = `artifact:${digest}`;
    const blobPath: any = path.join(blobRoot, digest.replace("sha256:", ""));
    await ensureDir(blobRoot);
    await fs.writeFile(blobPath, buffer);
    const manifest: any = await readManifest();
    manifest.artifacts[artifactRef] = {
      artifactRef,
      digest,
      byteLength: buffer.byteLength,
      contentType,
      metadata: ensureObject(metadata),
      blobPath,
      status: "archived",
      createdAt: manifest.artifacts[artifactRef]?.createdAt || isoNow(),
      updatedAt: isoNow()
    };
    await writeJson(manifestPath, manifest);
    return manifest.artifacts[artifactRef];
  }

  async function getArtifact(artifactRef?: any) : Promise<any> {
    const manifest: any = await readManifest();
    const entry: any = manifest.artifacts?.[String(artifactRef)];
    if (!entry) {
      return null;
    }
    return {
      ...entry,
      bytes: await fs.readFile(entry.blobPath)
    };
  }

  async function listArtifacts() : Promise<any> {
    const manifest: any = await readManifest();
    return (Object.values(ensureObject(manifest.artifacts)) as any[]);
  }

  return Object.freeze({
    protocolVersion: READINESS_BASELINE_PROTOCOL_VERSION,
    implementation: "local-content-addressed-artifact-store",
    artifactRoot,
    putArtifact,
    getArtifact,
    listArtifacts,
    async summary() : Promise<any> {
      const artifacts: any = await listArtifacts();
      return {
        port: "ArtifactStorePort",
        implementation: "local-content-addressed-artifact-store",
        artifactRoot,
        artifactCount: artifacts.length
      };
    }
  });
}

function createSecretStorePort({ rootPath }: Record<string, any>) : any {
  const registryPath: any = path.join(rootPath, "secret-store", "refs.json");
  const auditPath: any = path.join(rootPath, "secret-store", "audit.jsonl");

  async function readRegistry() : Promise<any> {
    return ensureObject(await readJson(registryPath, { schemaVersion: "v0.0.1:schema:definition-1", refs: {} }), { schemaVersion: "v0.0.1:schema:definition-1", refs: {} });
  }

  async function createSecretRef({ namespace = "default", name = "", provider = "contract-mode", secretValue = "", metadata = {} }: Record<string, any> = {}) : Promise<any> {
    const id: any = `secret_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const secretRef: any = `secretref:${namespace}:${id}`;
    const entry: Record<string, any> = {
      secretRef,
      namespace,
      name: String(name || id),
      provider,
      verificationMode: "contractVerified",
      redacted: secretValue ? `***${String(secretValue).slice(-2)}` : "",
      metadataHash: sha256(stableJson(ensureObject(metadata))),
      createdAt: isoNow()
    };
    const registry: any = await readRegistry();
    registry.refs[secretRef] = entry;
    await writeJson(registryPath, registry);
    await appendJsonl(auditPath, {
      event: "secret_ref.created",
      secretRef,
      namespace,
      provider,
      verificationMode: entry.verificationMode,
      createdAt: isoNow()
    });
    return entry;
  }

  async function resolveSecretRef(secretRef?: any) : Promise<any> {
    const registry: any = await readRegistry();
    const entry: any = registry.refs?.[String(secretRef)];
    if (!entry) {
      return null;
    }
    await appendJsonl(auditPath, {
      event: "secret_ref.resolved",
      secretRef,
      provider: entry.provider,
      verificationMode: entry.verificationMode,
      createdAt: isoNow()
    });
    return {
      secretRef,
      provider: entry.provider,
      verificationMode: entry.verificationMode,
      handleType: "controlled-secret-handle",
      canRevealValue: false
    };
  }

  async function listSecretRefs() : Promise<any> {
    const registry: any = await readRegistry();
    return (Object.values(ensureObject(registry.refs)) as any[]);
  }

  return Object.freeze({
    protocolVersion: READINESS_BASELINE_PROTOCOL_VERSION,
    implementation: "contract-mode-secret-ref-store",
    registryPath,
    auditPath,
    createSecretRef,
    resolveSecretRef,
    listSecretRefs,
    async summary() : Promise<any> {
      return {
        port: "SecretStorePort",
        implementation: "contract-mode-secret-ref-store",
        verificationMode: "contractVerified",
        registryPath,
        auditPath,
        secretRefCount: (await listSecretRefs()).length
      };
    }
  });
}

export function createReadinessBaselineProvider({ userDataPath = "" }: Record<string, any> = {}) : any {
  if (!userDataPath) {
    throw new Error("userDataPath is required for Meshrix.js readiness baseline provider.");
  }
  const rootPath: any = path.join(userDataPath, "readiness-baseline");
  const configRegistry: any = createConfigRegistryPort({ rootPath });
  const metadataStore: any = createMetadataStorePort({ rootPath });
  const cache: any = createCachePort({ rootPath });
  const queue: any = createQueuePort({ rootPath });
  const artifactStore: any = createArtifactStorePort({ rootPath });
  const secretStore: any = createSecretStorePort({ rootPath });

  async function status() : Promise<any> {
    const [config, metadata, cacheSummary, queueSummary, artifact, secret] = await Promise.all([
      configRegistry.summary(),
      metadataStore.summary(),
      cache.summary(),
      queue.summary(),
      artifactStore.summary(),
      secretStore.summary()
    ]);
    return {
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: READINESS_BASELINE_PROTOCOL_VERSION,
      status: "operational",
      verificationMode: "runtime-observed",
      readiness: {
        status: "not-assessed",
        authority: "platform-acceptance-reducer"
      },
      boundaries: {
        sourceConfig: "repository templates and examples",
        runtimeConfig: "ServerConfig.getDataDir()/readiness-baseline",
        externalState: "contract-mode adapters until real credentials are configured"
      },
      mcpOutlets: [
        "meshrix.discovery",
        "meshrix.gateway"
      ],
      storageStates: STORAGE_STATES,
      ports: [config, metadata, cacheSummary, queueSummary, artifact, secret]
        .map(projectPublicPortSummary)
    };
  }

  return Object.freeze({
    protocolVersion: READINESS_BASELINE_PROTOCOL_VERSION,
    configRegistry,
    metadataStore,
    cache,
    queue,
    artifactStore,
    secretStore,
    status
  });
}
