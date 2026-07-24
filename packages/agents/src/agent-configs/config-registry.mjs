import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writePrivateFileAtomic } from "@meshrix/foundation/storage/private-file-atomic";
import {
  modelCredentialBindingKey,
  normalizeModelEndpoint,
  normalizeModelTokenHeader,
  normalizeModelTokenPrefix
} from "./credential-binding.mjs";
import { ModelCredentialStore } from "./model-credential-store.mjs";
import { mutateRegistry } from "./registry-mutation-lock.mjs";

const MANIFEST_FILE = "manifest.json";
const CURRENT_GENERATION_FILE = "current.json";
const GENERATIONS_DIRECTORY = "generations";
const POINTER_SCHEMA_VERSION = "v0.0.1:agent:config-registry-pointer-1";

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return String(value || "").trim();
}

function stableDigest(parts = []) {
  return crypto
    .createHash("sha256")
    .update(parts.map((item) => text(item)).join("\n"))
    .digest("hex")
    .slice(0, 16);
}

function generationId() {
  return `generation-${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
}

function entryFileName(prefix, id) {
  return `${prefix}-${crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 32)}.json`;
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

async function writeJson(filePath, value) {
  await writePrivateFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function manifestPath(directory) {
  return path.join(directory, MANIFEST_FILE);
}

function defaultManifest(kind) {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    kind,
    updatedAt: nowIso(),
    entries: []
  };
}

function normalizeManifest(kind, value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${kind} manifest must be an object.`);
  }
  if (value.kind !== kind || !Array.isArray(value.entries)) {
    throw new Error(`${kind} manifest kind or entries are invalid.`);
  }
  const entries = value.entries.map((entry, index) => {
    const id = text(entry?.id);
    const file = text(entry?.file);
    if (!id || !file || path.basename(file) !== file || !file.endsWith(".json") || file === MANIFEST_FILE) {
      throw new Error(`${kind} manifest entry ${index} is invalid.`);
    }
    return {
      id,
      file,
      label: text(entry.label),
      enabled: entry.enabled === true
    };
  });
  const ids = new Set();
  const foldedIds = new Set();
  const files = new Set();
  for (const entry of entries) {
    const foldedId = entry.id.toLocaleLowerCase("en-US");
    if (ids.has(entry.id) || foldedIds.has(foldedId) || files.has(entry.file)) {
      throw new Error(`${kind} manifest contains duplicate ids or files.`);
    }
    ids.add(entry.id);
    foldedIds.add(foldedId);
    files.add(entry.file);
  }
  return {
    ...defaultManifest(kind),
    ...value,
    kind,
    entries
  };
}

function assertGenerationPointer(value = {}) {
  const generation = text(value?.generation);
  const revision = Number(value?.revision);
  if (
    value?.schemaVersion !== POINTER_SCHEMA_VERSION ||
    !/^generation-[a-z0-9-]+$/u.test(generation) ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new Error("Agent config registry generation pointer is invalid.");
  }
  return {
    schemaVersion: POINTER_SCHEMA_VERSION,
    generation,
    revision
  };
}

function assertUniqueAgentIdentities(agents = []) {
  const identities = new Set();
  const foldedIdentities = new Set();
  for (const [index, entry] of agents.entries()) {
    const identity = agentIdentity(entry);
    if (!identity) {
      throw new Error(`Agent model entry ${index} requires an explicit identity.`);
    }
    const folded = identity.toLocaleLowerCase("en-US");
    if (identities.has(identity) || foldedIdentities.has(folded)) {
      throw new Error(`Agent model identity is duplicated or differs only by case: ${identity}`);
    }
    identities.add(identity);
    foldedIdentities.add(folded);
  }
}

function agentIdentity(entry = {}) {
  return text(entry.uid || entry.instanceId || entry.alias || entry.id);
}

function modelFromAgent(agent = {}, index = 0, { credentialRef = "" } = {}) {
  const provider = text(agent.provider);
  const model = text(agent.model || agent.engine);
  const identity = agentIdentity(agent);
  const id = text(agent.modelUid) || `model_${stableDigest([
    provider,
    model,
    agent.baseUrl || agent.url || "",
    identity || index
  ])}`;
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    id,
    agentUid: identity,
    provider,
    label: text(agent.modelLabel),
    model,
    engine: text(agent.engine),
    baseUrl: normalizeModelEndpoint(agent.baseUrl),
    url: normalizeModelEndpoint(agent.url),
    apiKeyConfigured: Boolean(text(agent.apiKey)),
    tokenConfigured: Boolean(text(agent.token)),
    credentialRef: text(credentialRef),
    tokenHeader: normalizeModelTokenHeader(agent.tokenHeader),
    tokenPrefix: normalizeModelTokenPrefix(agent.tokenPrefix),
    timeoutMs: Number(agent.timeoutMs || 0),
    parameters: agent.parameters && typeof agent.parameters === "object" ? agent.parameters : {}
  };
}

function agentFromLibraryEntry(agent = {}, modelId = "") {
  const id = agentIdentity(agent) || `agent_${stableDigest([agent.provider, agent.model, agent.label, agent.agentName])}`;
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    id,
    uid: id,
    instanceId: id,
    alias: id,
    modelUid: modelId || text(agent.modelUid),
    label: text(agent.label),
    agentName: text(agent.agentName),
    systemPrompt: text(agent.systemPrompt),
    pluginList: Array.isArray(agent.pluginList) ? agent.pluginList.map((item) => text(item)).filter(Boolean) : [],
    parameters: agent.parameters && typeof agent.parameters === "object" ? agent.parameters : {},
    moduleAccess: agent.moduleAccess && typeof agent.moduleAccess === "object"
      ? agent.moduleAccess
      : { mode: "selected", moduleIds: [] },
    timeoutMs: Number(agent.timeoutMs || 0),
    enabled: agent.enabled !== false
  };
}

function combineAgentModel(agent = {}, model = {}) {
  const id = agentIdentity(agent);
  return {
    uid: id,
    instanceId: id,
    alias: id,
    provider: text(model.provider || agent.provider),
    label: text(agent.label),
    baseUrl: text(model.baseUrl || agent.baseUrl),
    url: text(model.url || agent.url),
    model: text(model.model || agent.model),
    apiKey: text(model.apiKey || agent.apiKey),
    apiKeyConfigured: Boolean(text(model.apiKey || agent.apiKey)),
    token: text(model.token || agent.token),
    tokenConfigured: Boolean(text(model.token || agent.token)),
    tokenHeader: normalizeModelTokenHeader(model.tokenHeader || agent.tokenHeader),
    tokenPrefix: normalizeModelTokenPrefix(model.tokenPrefix ?? agent.tokenPrefix),
    agentName: text(agent.agentName),
    pluginList: Array.isArray(agent.pluginList) ? agent.pluginList : [],
    engine: text(model.engine || agent.engine),
    systemPrompt: text(agent.systemPrompt),
    parameters: {
      ...(model.parameters && typeof model.parameters === "object" ? model.parameters : {}),
      ...(agent.parameters && typeof agent.parameters === "object" ? agent.parameters : {})
    },
    moduleAccess: agent.moduleAccess && typeof agent.moduleAccess === "object"
      ? agent.moduleAccess
      : { mode: "selected", moduleIds: [] },
    timeoutMs: Number(agent.timeoutMs || model.timeoutMs || 0)
  };
}

function redactAgent(entry = {}) {
  const copy = { ...entry };
  if (copy.apiKey) {
    copy.apiKeyConfigured = true;
  }
  if (copy.token) {
    copy.tokenConfigured = true;
  }
  copy.apiKey = "";
  copy.token = "";
  return copy;
}

function preserveRedactedSecrets(entry = {}, currentByBinding = new Map()) {
  const binding = modelCredentialBindingKey(entry);
  const current = binding ? currentByBinding.get(binding) : null;
  const next = { ...entry };
  if (current && !text(next.apiKey) && next.apiKeyConfigured === true && text(current.apiKey)) {
    next.apiKey = current.apiKey;
  }
  if (current && !text(next.token) && next.tokenConfigured === true && text(current.token)) {
    next.token = current.token;
  }
  next.apiKeyConfigured = Boolean(text(next.apiKey));
  next.tokenConfigured = Boolean(text(next.token));
  return next;
}

export class AgentConfigRegistry {
  constructor({ rootPath, credentialStore = null } = {}) {
    const requestedRootPath = text(rootPath);
    if (!requestedRootPath) {
      throw new TypeError("AgentConfigRegistry requires an explicit runtime rootPath.");
    }
    const resolvedRootPath = path.resolve(requestedRootPath);
    this.rootPath = resolvedRootPath;
    this.generationsPath = path.join(resolvedRootPath, GENERATIONS_DIRECTORY);
    this.currentGenerationPath = path.join(resolvedRootPath, CURRENT_GENERATION_FILE);
    this.credentialStore = credentialStore || new ModelCredentialStore({
      rootPath: path.join(resolvedRootPath, "credentials")
    });
    this.generation = "";
    this.revision = 0;
    this.modelListPath = "";
    this.agentListPath = "";
    this.loaded = false;
    this.models = [];
    this.agents = [];
    this.modelManifest = defaultManifest("model-list");
    this.agentManifest = defaultManifest("agent-list");
  }

  generationPaths(generation) {
    const root = path.join(this.generationsPath, generation);
    return {
      root,
      modelListPath: path.join(root, "model-list"),
      agentListPath: path.join(root, "agent-list")
    };
  }

  activateGeneration(pointer) {
    const normalized = assertGenerationPointer(pointer);
    const paths = this.generationPaths(normalized.generation);
    this.generation = normalized.generation;
    this.revision = normalized.revision;
    this.modelListPath = paths.modelListPath;
    this.agentListPath = paths.agentListPath;
    return normalized;
  }

  async currentPointer() {
    const pointer = await readJson(this.currentGenerationPath, null);
    return pointer ? assertGenerationPointer(pointer) : null;
  }

  async ensureLayout() {
    await fs.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.generationsPath, { recursive: true, mode: 0o700 });
    await Promise.all([
      fs.chmod(this.rootPath, 0o700),
      fs.chmod(this.generationsPath, 0o700)
    ]);
    let pointer = await this.currentPointer();
    if (!pointer) {
      const generation = generationId();
      await this.buildGeneration([], generation);
      pointer = { schemaVersion: POINTER_SCHEMA_VERSION, generation, revision: 0 };
      await writeJson(this.currentGenerationPath, pointer);
    }
    this.activateGeneration(pointer);
  }

  async loadList(directory, kind) {
    const manifest = normalizeManifest(
      kind,
      await readJson(manifestPath(directory), null)
    );
    const entries = [];
    for (const item of manifest.entries) {
      const config = await readJson(path.join(directory, item.file), null);
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error(`${kind} config is missing or invalid: ${item.id}`);
      }
      if (text(config.id) !== item.id) {
        throw new Error(`${kind} manifest/config identity mismatch: ${item.id}`);
      }
      if (item.enabled !== false) {
        entries.push({
          ...config,
          id: item.id,
          enabled: true
        });
      }
    }
    const expectedFiles = new Set([MANIFEST_FILE, ...manifest.entries.map((entry) => entry.file)]);
    const actualFiles = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
    if (actualFiles.some((file) => !expectedFiles.has(file))) {
      throw new Error(`${kind} generation contains unlisted JSON files.`);
    }
    return { manifest, entries };
  }

  async loadActiveGeneration() {
    const models = await this.loadList(this.modelListPath, "model-list");
    const agents = await this.loadList(this.agentListPath, "agent-list");
    const hydratedModels = [];
    for (const model of models.entries) {
      const credentialRef = text(model.credentialRef);
      if (!credentialRef) {
        hydratedModels.push({ ...model, apiKey: "", token: "" });
        continue;
      }
      const binding = modelCredentialBindingKey({
        uid: model.agentUid,
        provider: model.provider,
        baseUrl: model.baseUrl,
        url: model.url
      });
      const credential = await this.credentialStore.load({
        reference: credentialRef,
        binding
      });
      hydratedModels.push({
        ...model,
        ...credential,
        apiKeyConfigured: Boolean(credential.apiKey),
        tokenConfigured: Boolean(credential.token)
      });
    }
    const modelIds = new Set(hydratedModels.map((model) => text(model.id)));
    for (const agent of agents.entries) {
      if (!modelIds.has(text(agent.modelUid))) {
        throw new Error(`Agent config references a missing model: ${agent.id}`);
      }
    }
    this.models = hydratedModels;
    this.agents = agents.entries;
    this.modelManifest = models.manifest;
    this.agentManifest = agents.manifest;
    this.loaded = true;
    return this.getState();
  }

  async refreshUnlocked() {
    await this.ensureLayout();
    const pointer = await this.currentPointer();
    this.activateGeneration(pointer);
    return this.loadActiveGeneration();
  }

  async refresh() {
    const pointer = await this.currentPointer();
    if (!pointer) {
      return mutateRegistry(this.rootPath, () => this.refreshUnlocked());
    }
    this.activateGeneration(pointer);
    return this.loadActiveGeneration();
  }

  async buildGeneration(modelLibraryAgents = [], generation = generationId()) {
    assertUniqueAgentIdentities(modelLibraryAgents);
    const paths = this.generationPaths(generation);
    const modelManifest = defaultManifest("model-list");
    const agentManifest = defaultManifest("agent-list");
    const credentialRefs = [];
    await fs.mkdir(paths.modelListPath, { recursive: true, mode: 0o700 });
    await fs.mkdir(paths.agentListPath, { recursive: true, mode: 0o700 });
    try {
      for (let index = 0; index < modelLibraryAgents.length; index += 1) {
        const entry = modelLibraryAgents[index] || {};
        const apiKey = text(entry.apiKey);
        const token = text(entry.token);
        const binding = modelCredentialBindingKey(entry);
        if ((apiKey || token) && !binding) {
          throw new Error("Configured model credentials require an explicit agent, provider, and endpoint binding.");
        }
        const credentialRef = apiKey || token
          ? await this.credentialStore.save({
              generation,
              binding,
              payload: { apiKey, token }
            })
          : "";
        if (credentialRef) credentialRefs.push(credentialRef);
        const model = modelFromAgent(entry, index, { credentialRef });
        const agent = agentFromLibraryEntry(entry, model.id);
        const modelFile = entryFileName("model", model.id);
        const agentFile = entryFileName("agent", agent.id);
        await writeJson(path.join(paths.modelListPath, modelFile), model);
        await writeJson(path.join(paths.agentListPath, agentFile), agent);
        modelManifest.entries.push({
          id: model.id,
          file: modelFile,
          label: model.label,
          enabled: true
        });
        agentManifest.entries.push({
          id: agent.id,
          file: agentFile,
          label: agent.label,
          enabled: true
        });
      }
      modelManifest.updatedAt = nowIso();
      agentManifest.updatedAt = nowIso();
      await writeJson(manifestPath(paths.modelListPath), modelManifest);
      await writeJson(manifestPath(paths.agentListPath), agentManifest);
      await this.loadList(paths.modelListPath, "model-list");
      await this.loadList(paths.agentListPath, "agent-list");
      return { generation, ...paths };
    } catch (error) {
      const cleanupResults = await Promise.allSettled([
        fs.rm(paths.root, { recursive: true, force: true }),
        ...credentialRefs.map((reference) => this.credentialStore.delete(reference))
      ]);
      const cleanupErrors = cleanupResults
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Agent config generation staging failed and cleanup was incomplete."
        );
      }
      throw error;
    }
  }

  async replaceFromModelLibraryAgents(agents = [], options = {}) {
    return mutateRegistry(this.rootPath, async () => {
      await this.replaceFromModelLibraryAgentsUnlocked(agents, options);
      return this.getState();
    }, { transactionId: options.transactionId });
  }

  async replaceFromModelLibraryAgentsUnlocked(agents = [], options = {}) {
    await this.refreshUnlocked();
    const previousPointer = assertGenerationPointer(await this.currentPointer());
    if (options.expectedRevision !== undefined) {
      const expectedRevision = Number(options.expectedRevision);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        const error = new Error("Agent config registry expectedRevision is invalid.");
        error.code = "agent_config_registry_revision_invalid";
        throw error;
      }
      if (previousPointer.revision !== expectedRevision) {
        const error = new Error(
          `Agent config registry revision conflict: expected ${expectedRevision}, current ${previousPointer.revision}.`
        );
        error.code = "agent_config_registry_revision_conflict";
        error.expectedRevision = expectedRevision;
        error.currentRevision = previousPointer.revision;
        throw error;
      }
    }
    const currentByBinding = new Map(
      this.getModelLibraryAgents()
        .map((entry) => [modelCredentialBindingKey(entry), entry])
        .filter(([binding]) => binding)
    );
    const nextAgents = (Array.isArray(agents) ? agents : [])
      .map((entry) => preserveRedactedSecrets(entry, currentByBinding));
    assertUniqueAgentIdentities(nextAgents);
    const built = await this.buildGeneration(nextAgents);
    const nextPointer = {
      schemaVersion: POINTER_SCHEMA_VERSION,
      generation: built.generation,
      revision: previousPointer.revision + 1
    };
    try {
      await writeJson(this.currentGenerationPath, nextPointer);
      this.activateGeneration(nextPointer);
      await this.loadActiveGeneration();
    } catch (error) {
      let restored = false;
      try {
        await writeJson(this.currentGenerationPath, previousPointer);
        this.activateGeneration(previousPointer);
        await this.loadActiveGeneration();
        restored = true;
      } catch {
        // Keep the original commit error; both generations remain for manual recovery.
      }
      if (restored) {
        try {
          await Promise.all([
            fs.rm(built.root, { recursive: true, force: true }),
            this.credentialStore.deleteGeneration(built.generation)
          ]);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Agent config generation commit failed and rollback cleanup was incomplete."
          );
        }
      }
      throw error;
    }
    await this.cleanupGenerations(new Set([
      built.generation,
      previousPointer.generation
    ]));
  }

  async restoreGenerationUnlocked(pointerInput, options = {}) {
    const pointer = assertGenerationPointer(pointerInput);
    const currentPointer = assertGenerationPointer(await this.currentPointer());
    if (!Array.isArray(options.allowedCurrentRevisions) || options.allowedCurrentRevisions.length === 0) {
      const error = new Error("Agent config registry recovery requires allowedCurrentRevisions.");
      error.code = "agent_config_registry_recovery_revision_required";
      throw error;
    }
    const allowed = new Set(options.allowedCurrentRevisions.map(Number));
    if (!allowed.has(currentPointer.revision)) {
      const error = new Error("Agent config registry recovery revision conflict.");
      error.code = "agent_config_registry_recovery_conflict";
      error.currentRevision = currentPointer.revision;
      throw error;
    }
    const paths = this.generationPaths(pointer.generation);
    await this.loadList(paths.modelListPath, "model-list");
    await this.loadList(paths.agentListPath, "agent-list");
    await writeJson(this.currentGenerationPath, pointer);
    this.activateGeneration(pointer);
    const state = await this.loadActiveGeneration();
    if (
      options.discardReplacedGeneration === true &&
      currentPointer.generation !== pointer.generation
    ) {
      await Promise.all([
        fs.rm(this.generationPaths(currentPointer.generation).root, { recursive: true, force: true }),
        this.credentialStore.deleteGeneration(currentPointer.generation)
      ]);
    }
    return state;
  }

  async withCoordinatedTransaction(transactionId, task) {
    const normalizedTransactionId = text(transactionId);
    if (!/^[a-f0-9]{32}$/u.test(normalizedTransactionId) || typeof task !== "function") {
      throw new TypeError("AgentConfigRegistry coordinated transaction requires an explicit transactionId and task.");
    }
    return mutateRegistry(this.rootPath, async () => {
      await this.refreshUnlocked();
      return task({
        registry: this,
        currentPointer: () => this.currentPointer(),
        replaceFromModelLibraryAgents: async (agents = [], options = {}) => {
          await this.replaceFromModelLibraryAgentsUnlocked(agents, options);
          return this.getState();
        },
        restoreGeneration: (pointer, options = {}) => this.restoreGenerationUnlocked(pointer, options)
      });
    }, { transactionId: normalizedTransactionId });
  }

  async cleanupGenerations(retained = new Set()) {
    const entries = await fs.readdir(this.generationsPath, { withFileTypes: true });
    const generations = entries
      .filter((entry) => entry.isDirectory() && /^generation-[a-z0-9-]+$/u.test(entry.name))
      .map((entry) => entry.name)
      .filter((entry) => !retained.has(entry));
    await Promise.allSettled(generations.flatMap((entry) => [
      fs.rm(path.join(this.generationsPath, entry), { recursive: true, force: true }),
      this.credentialStore.deleteGeneration(entry)
    ]));
  }

  async restoreGeneration(pointerInput, options = {}) {
    const pointer = assertGenerationPointer(pointerInput);
    return mutateRegistry(
      this.rootPath,
      () => this.restoreGenerationUnlocked(pointer, options),
      { transactionId: options.transactionId }
    );
  }

  getState() {
    const modelById = new Map(this.models.map((model) => [text(model.id), model]));
    const combinedAgents = this.agents.map((agent) =>
      combineAgentModel(agent, modelById.get(text(agent.modelUid)) || {})
    );
    return {
      rootPath: this.rootPath,
      generation: this.generation,
      revision: this.revision,
      modelListPath: this.modelListPath,
      agentListPath: this.agentListPath,
      modelManifest: this.modelManifest,
      agentManifest: this.agentManifest,
      models: this.models,
      agents: this.agents,
      modelLibraryAgents: combinedAgents,
      modelLibraryEntries: [...new Set(combinedAgents.map((agent) => text(agent.provider)).filter(Boolean))]
    };
  }

  getModelLibraryAgents({ redactSecrets = false } = {}) {
    const agents = this.getState().modelLibraryAgents;
    return redactSecrets ? agents.map(redactAgent) : agents;
  }

  getModelLibraryEntries() {
    return this.getState().modelLibraryEntries;
  }

  async upsertFromModelLibraryEntry(entry = {}) {
    const identity = agentIdentity(entry);
    if (!identity) {
      throw new Error("Agent model entry requires an explicit identity.");
    }
    return mutateRegistry(this.rootPath, async () => {
      await this.refreshUnlocked();
      const current = this.getModelLibraryAgents();
      const index = current.findIndex((item) => agentIdentity(item) === identity);
      const next = [...current];
      if (index >= 0) next[index] = entry;
      else next.unshift(entry);
      await this.replaceFromModelLibraryAgentsUnlocked(next);
      return this.getModelLibraryAgents().find((item) => agentIdentity(item) === identity) || null;
    });
  }

  async deleteAgent(agentId = "") {
    const id = text(agentId);
    if (!id) return false;
    return mutateRegistry(this.rootPath, async () => {
      await this.refreshUnlocked();
      const current = this.getModelLibraryAgents();
      const next = current.filter((item) => agentIdentity(item) !== id);
      if (next.length === current.length) return false;
      await this.replaceFromModelLibraryAgentsUnlocked(next);
      return true;
    });
  }
}

const registrySingletons = new Map();

export function getAgentConfigRegistry(options = {}) {
  const requestedRootPath = text(options.rootPath);
  if (!requestedRootPath) {
    throw new TypeError("getAgentConfigRegistry requires an explicit runtime rootPath.");
  }
  const rootPath = path.resolve(requestedRootPath);
  if (!registrySingletons.has(rootPath)) {
    registrySingletons.set(rootPath, new AgentConfigRegistry({
      ...options,
      rootPath
    }));
  }
  return registrySingletons.get(rootPath);
}
