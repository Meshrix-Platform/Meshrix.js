import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appendBoundedJsonLine } from "../../storage/bounded-jsonl.mjs";

export const READINESS_BASELINE_PROTOCOL_VERSION = "v0.0.1:platform:baseline-1";

const CONFIG_FILES = Object.freeze({
  modules: "modules.json",
  connectors: "connectors.json",
  featureProfiles: "feature-profiles.json",
  externalTargets: "external-targets.json"
});

const STORAGE_STATES = Object.freeze([
  "queued",
  "staged",
  "archived",
  "committed",
  "synced",
  "projected",
  "cached",
  "contractVerified"
]);
const READINESS_AUDIT_MAX_BYTES = 16 * 1024 * 1024;
const PUBLIC_PORT_SUMMARY_FIELDS = Object.freeze([
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

function isoNow() {
  return new Date().toISOString();
}

function ensureObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}


function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function compactHash(value) {
  return sha256(typeof value === "string" || Buffer.isBuffer(value) ? value : stableJson(value)).slice("sha256:".length, 28);
}

function projectPublicPortSummary(summary = {}) {
  return Object.fromEntries(
    PUBLIC_PORT_SUMMARY_FIELDS
      .filter((field) => summary[field] !== undefined)
      .map((field) => [field, summary[field]])
  );
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function appendJsonl(filePath, payload) {
  await appendBoundedJsonLine(filePath, payload, {
    maxBytes: READINESS_AUDIT_MAX_BYTES,
    retainedBytes: READINESS_AUDIT_MAX_BYTES / 2
  });
}

function normalizeConfigList(value) {
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

function normalizeConfigItem(item = {}) {
  const normalized = ensureObject(item);
  const id = String(normalized.id || normalized.name || normalized.key || "").trim();
  return {
    ...normalized,
    id,
    enabled: normalized.enabled !== false
  };
}

function createConfigRegistryPort({ rootPath }) {
  const configRoot = path.join(rootPath, "config-registry");

  function filePath(kind) {
    const name = CONFIG_FILES[kind];
    if (!name) {
      throw new Error(`Unknown readiness baseline config registry kind: ${kind}`);
    }
    return path.join(configRoot, name);
  }

  async function readConfig(kind) {
    const payload = await readJson(filePath(kind), { schemaVersion: "v0.0.1:schema:definition-1", kind, items: [] });
    const items = normalizeConfigList(payload).map(normalizeConfigItem).filter((item) => item.id);
    return {
      schemaVersion: String(payload.schemaVersion || "v0.0.1:schema:definition-1"),
      kind,
      path: filePath(kind),
      items
    };
  }

  async function writeConfig(kind, payload = {}) {
    const items = normalizeConfigList(payload).map(normalizeConfigItem).filter((item) => item.id);
    const next = {
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

  async function upsert(kind, item = {}) {
    const current = await readConfig(kind);
    const normalized = normalizeConfigItem(item);
    if (!normalized.id) {
      throw new Error("Config registry item id is required.");
    }
    const items = current.items.filter((entry) => entry.id !== normalized.id);
    items.push(normalized);
    return writeConfig(kind, { items });
  }

  async function listEnabled() {
    const [modules, connectors, featureProfiles, externalTargets] = await Promise.all([
      readConfig("modules"),
      readConfig("connectors"),
      readConfig("featureProfiles"),
      readConfig("externalTargets")
    ]);
    return {
      modules: modules.items.filter((item) => item.enabled),
      connectors: connectors.items.filter((item) => item.enabled),
      featureProfiles: featureProfiles.items.filter((item) => item.enabled),
      externalTargets: externalTargets.items.filter((item) => item.enabled)
    };
  }

  async function summary() {
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
      files: Object.fromEntries(Object.entries(CONFIG_FILES).map(([kind, fileName]) => [kind, path.join(configRoot, fileName)])),
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

function createMetadataStorePort({ rootPath }) {
  const filePath = path.join(rootPath, "metadata-store", "records.json");

  async function readAll() {
    return ensureObject(await readJson(filePath, { schemaVersion: "v0.0.1:schema:definition-1", records: {} }), { schemaVersion: "v0.0.1:schema:definition-1", records: {} });
  }

  async function put(record = {}) {
    const id = String(record.id || `meta_${compactHash({ record, createdAt: isoNow() })}`).trim();
    const store = await readAll();
    store.records = ensureObject(store.records);
    store.records[id] = {
      ...ensureObject(record),
      id,
      updatedAt: isoNow()
    };
    await writeJson(filePath, store);
    return store.records[id];
  }

  async function get(id) {
    const store = await readAll();
    return store.records?.[String(id)] || null;
  }

  async function list() {
    const store = await readAll();
    return Object.values(ensureObject(store.records));
  }

  return Object.freeze({
    protocolVersion: READINESS_BASELINE_PROTOCOL_VERSION,
    implementation: "local-json",
    path: filePath,
    put,
    get,
    list,
    async summary() {
      return {
        port: "MetadataStorePort",
        implementation: "local-json",
        path: filePath,
        recordCount: (await list()).length
      };
    }
  });
}

function createCachePort({ rootPath }) {
  const filePath = path.join(rootPath, "cache", "cache.json");

  async function readAll() {
    return ensureObject(await readJson(filePath, { schemaVersion: "v0.0.1:schema:definition-1", entries: {} }), { schemaVersion: "v0.0.1:schema:definition-1", entries: {} });
  }

  function cacheId({ scope = "default", key = "" } = {}) {
    return `${scope}:${key}`;
  }

  async function set({ scope = "default", key, value, ttlMs = 0 } = {}) {
    if (!key) {
      throw new Error("Cache key is required.");
    }
    const store = await readAll();
    const id = cacheId({ scope, key });
    const expiresAt = Number(ttlMs) > 0 ? new Date(Date.now() + Number(ttlMs)).toISOString() : "";
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

  async function get({ scope = "default", key } = {}) {
    const store = await readAll();
    const entry = store.entries?.[cacheId({ scope, key })];
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

  async function invalidate({ scope = "default", key } = {}) {
    const store = await readAll();
    const id = cacheId({ scope, key });
    const existed = Boolean(store.entries?.[id]);
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
    async summary() {
      const store = await readAll();
      return {
        port: "CachePort",
        implementation: "local-file-cache",
        path: filePath,
        entryCount: Object.keys(ensureObject(store.entries)).length
      };
    }
  });
}

function createQueuePort({ rootPath }) {
  const filePath = path.join(rootPath, "queue", "tasks.json");

  async function readAll() {
    return ensureObject(await readJson(filePath, { schemaVersion: "v0.0.1:schema:definition-1", tasks: [] }), { schemaVersion: "v0.0.1:schema:definition-1", tasks: [] });
  }

  async function writeAll(store) {
    await writeJson(filePath, { schemaVersion: "v0.0.1:schema:definition-1", tasks: Array.isArray(store.tasks) ? store.tasks : [] });
  }

  async function enqueue({ queueName = "default", payload = {}, idempotencyKey = "" } = {}) {
    const store = await readAll();
    const existing = idempotencyKey
      ? store.tasks.find((task) => task.idempotencyKey === idempotencyKey && task.queueName === queueName)
      : null;
    if (existing) {
      return { ...existing, deduped: true };
    }
    const task = {
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

  async function claim({ queueName = "default", workerId = "worker" } = {}) {
    const store = await readAll();
    const task = store.tasks.find((item) => item.queueName === queueName && item.status === "queued");
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

  async function heartbeat({ taskId, workerId = "worker" } = {}) {
    const store = await readAll();
    const task = store.tasks.find((item) => item.taskId === taskId);
    if (!task) {
      return null;
    }
    task.workerId = task.workerId || workerId;
    task.heartbeatAt = isoNow();
    task.updatedAt = isoNow();
    await writeAll(store);
    return task;
  }

  async function complete({ taskId, result = {} } = {}) {
    const store = await readAll();
    const task = store.tasks.find((item) => item.taskId === taskId);
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

  async function list({ queueName = "" } = {}) {
    const store = await readAll();
    return (Array.isArray(store.tasks) ? store.tasks : [])
      .filter((task) => !queueName || task.queueName === queueName);
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
    async summary() {
      const tasks = await list();
      return {
        port: "QueuePort",
        implementation: "local-durable-json-queue",
        path: filePath,
        taskCount: tasks.length,
        queuedCount: tasks.filter((task) => task.status === "queued").length
      };
    }
  });
}

function createArtifactStorePort({ rootPath }) {
  const artifactRoot = path.join(rootPath, "artifact-store");
  const blobRoot = path.join(artifactRoot, "blobs");
  const manifestPath = path.join(artifactRoot, "manifest.json");

  async function readManifest() {
    return ensureObject(await readJson(manifestPath, { schemaVersion: "v0.0.1:schema:definition-1", artifacts: {} }), { schemaVersion: "v0.0.1:schema:definition-1", artifacts: {} });
  }

  async function putArtifact({ bytes, text, json, contentType = "application/octet-stream", metadata = {} } = {}) {
    let buffer;
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
    const digest = sha256(buffer);
    const artifactRef = `artifact:${digest}`;
    const blobPath = path.join(blobRoot, digest.replace("sha256:", ""));
    await ensureDir(blobRoot);
    await fs.writeFile(blobPath, buffer);
    const manifest = await readManifest();
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

  async function getArtifact(artifactRef) {
    const manifest = await readManifest();
    const entry = manifest.artifacts?.[String(artifactRef)];
    if (!entry) {
      return null;
    }
    return {
      ...entry,
      bytes: await fs.readFile(entry.blobPath)
    };
  }

  async function listArtifacts() {
    const manifest = await readManifest();
    return Object.values(ensureObject(manifest.artifacts));
  }

  return Object.freeze({
    protocolVersion: READINESS_BASELINE_PROTOCOL_VERSION,
    implementation: "local-content-addressed-artifact-store",
    artifactRoot,
    putArtifact,
    getArtifact,
    listArtifacts,
    async summary() {
      const artifacts = await listArtifacts();
      return {
        port: "ArtifactStorePort",
        implementation: "local-content-addressed-artifact-store",
        artifactRoot,
        artifactCount: artifacts.length
      };
    }
  });
}

function createSecretStorePort({ rootPath }) {
  const registryPath = path.join(rootPath, "secret-store", "refs.json");
  const auditPath = path.join(rootPath, "secret-store", "audit.jsonl");

  async function readRegistry() {
    return ensureObject(await readJson(registryPath, { schemaVersion: "v0.0.1:schema:definition-1", refs: {} }), { schemaVersion: "v0.0.1:schema:definition-1", refs: {} });
  }

  async function createSecretRef({ namespace = "default", name = "", provider = "contract-mode", secretValue = "", metadata = {} } = {}) {
    const id = `secret_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const secretRef = `secretref:${namespace}:${id}`;
    const entry = {
      secretRef,
      namespace,
      name: String(name || id),
      provider,
      verificationMode: "contractVerified",
      redacted: secretValue ? `***${String(secretValue).slice(-2)}` : "",
      metadataHash: sha256(stableJson(ensureObject(metadata))),
      createdAt: isoNow()
    };
    const registry = await readRegistry();
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

  async function resolveSecretRef(secretRef) {
    const registry = await readRegistry();
    const entry = registry.refs?.[String(secretRef)];
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

  async function listSecretRefs() {
    const registry = await readRegistry();
    return Object.values(ensureObject(registry.refs));
  }

  return Object.freeze({
    protocolVersion: READINESS_BASELINE_PROTOCOL_VERSION,
    implementation: "contract-mode-secret-ref-store",
    registryPath,
    auditPath,
    createSecretRef,
    resolveSecretRef,
    listSecretRefs,
    async summary() {
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

export function createReadinessBaselineProvider({ userDataPath = "" } = {}) {
  if (!userDataPath) {
    throw new Error("userDataPath is required for Meshrix readiness baseline provider.");
  }
  const rootPath = path.join(userDataPath, "readiness-baseline");
  const configRegistry = createConfigRegistryPort({ rootPath });
  const metadataStore = createMetadataStorePort({ rootPath });
  const cache = createCachePort({ rootPath });
  const queue = createQueuePort({ rootPath });
  const artifactStore = createArtifactStorePort({ rootPath });
  const secretStore = createSecretStorePort({ rootPath });

  async function status() {
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
