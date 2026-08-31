import { randomUUID } from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  canonicalDecode,
  canonicalEncode,
  cidForCanonical,
  createAppendOnlyEventLog,
  createContentAddressedStore,
  PACTIUM_PACKAGE_VERSION,
  PACTIUM_PROOF_TYPES,
  PACTIUM_PROTOCOL,
  PACTIUM_SCHEMA_VERSION,
  protocolHash,
  protocolHashHex,
  normalizeCanonicalValue,
  toCanonicalSafeValue
} from "pactium";
import type {
  PactiumCanonicalValue,
  PactiumRecord,
  PactiumStoragePort
} from "pactium";
import { serverToken } from "#meshrix/client-strings";
import { queueStateMutation } from "../../storage/state-coordinator.ts";
import {
  normalizeMeshrixPactiumRuntime,
  resolveMeshrixPactiumDataDir
} from "./pactium-runtime.ts";
import type { MeshrixPactiumRuntime } from "./types.ts";
import { isRecord, recordArray } from "./types.ts";

interface CodedError extends Error { code: string; status?: number }

export interface IndexEntry extends PactiumRecord {
  key: string;
  valueRef: string;
  valueHash: string;
  metadata: PactiumCanonicalValue;
}

interface StateMutation extends PactiumRecord {
  action?: string;
  key?: string;
  valueRef?: string;
  cid?: string;
  value?: unknown;
  valueHash?: string;
  metadata?: PactiumRecord;
}

export interface NormalizedStateMutation extends PactiumRecord {
  action: "put" | "delete";
  key: string;
  valueRef: string;
  valueHash: string;
  metadata: PactiumRecord & PactiumCanonicalValue;
}

interface ChunkRecord extends PactiumRecord {
  relativePath?: string;
  fileId?: string;
  chunkIndex?: number;
  chunkCid?: string;
  cid?: string;
  byteLength?: number;
  mediaType?: string;
  metadata?: PactiumRecord;
  offset?: number;
  chunkHash?: string;
}

interface StateSubstrateOptions {
  userDataPath?: string;
  dataDir?: string;
  pactiumRuntime?: MeshrixPactiumRuntime | null;
}

export interface CasBlock extends PactiumRecord { cid: string }
export interface CasWalkResult extends PactiumRecord { missing: string[]; blockCount: number }
interface ContentAddressedStore extends PactiumRecord {
  putBlock(value: unknown, options?: PactiumRecord): Promise<CasBlock>;
  getBlock(cid: string): Promise<PactiumRecord | null>;
  hasBlock(cid: string): Promise<boolean>;
  walk(cid: string): Promise<CasWalkResult>;
  listMissing(cid: string): Promise<string[]>;
  verify(cid: string): Promise<PactiumRecord>;
}

export interface ProtocolEvent extends PactiumRecord {
  eventHash: string;
  eventId: string;
  partitionId: string;
  offset: number;
  beforeRoot: string;
  afterRoot?: string;
  operationId?: string;
  contentRefs: string[];
  payload: PactiumRecord;
  prevEventHash: string;
}

export interface StateCommitPactiumEvidence extends PactiumRecord {
  envelopeId: string;
  intentId: string;
  outcomeId: string;
  ledgerEventId: string;
  ledgerIndex: number;
  verifierManifestId: string;
  verifierManifestHash: string;
}

interface ProtocolEventLog extends PactiumRecord {
  appendEvent(input: PactiumRecord): Promise<ProtocolEvent>;
  listEvents(partitionId: string, options?: PactiumRecord): Promise<ProtocolEvent[]>;
  getEvent(partitionId: string, offset: number): Promise<ProtocolEvent | null>;
  verifyPartition(partitionId: string): Promise<PactiumRecord>;
}

export interface StateCommitRecord extends PactiumRecord {
  commitKind: "mutation" | "restore";
  commitId: string;
  scope: string;
  operationId: string;
  beforeRoot: string;
  afterRoot: string;
  eventHash: string;
  eventId: string;
  eventOffset: number;
  contentRefs: string[];
  mutations: NormalizedStateMutation[];
  payload: PactiumRecord;
  pactium: StateCommitPactiumEvidence;
}

interface StateMutationClaim extends PactiumRecord {
  inputDigest: string;
  commitId: string;
  scope: string;
  operationId: string;
}

function isStateCommitRecord(value: unknown): value is StateCommitRecord {
  const pactium = isRecord(value) && isRecord(value.pactium) ? value.pactium : null;
  return isRecord(value) &&
    (value.commitKind === "mutation" || value.commitKind === "restore") &&
    typeof value.commitId === "string" &&
    typeof value.scope === "string" &&
    typeof value.operationId === "string" &&
    typeof value.beforeRoot === "string" &&
    typeof value.afterRoot === "string" &&
    typeof value.eventHash === "string" &&
    typeof value.eventId === "string" &&
    Number.isSafeInteger(value.eventOffset) &&
    Number(value.eventOffset) >= 0 &&
    Array.isArray(value.contentRefs) &&
    Array.isArray(value.mutations) &&
    isRecord(value.payload) &&
    Boolean(pactium) &&
    typeof pactium?.envelopeId === "string" &&
    typeof pactium.intentId === "string" &&
    typeof pactium.outcomeId === "string" &&
    typeof pactium.ledgerEventId === "string" &&
    Number.isSafeInteger(pactium.ledgerIndex) &&
    Number(pactium.ledgerIndex) >= 0 &&
    typeof pactium.verifierManifestId === "string" &&
    typeof pactium.verifierManifestHash === "string";
}

function isStateMutationClaim(value: unknown): value is StateMutationClaim {
  return isRecord(value) &&
    typeof value.inputDigest === "string" &&
    typeof value.commitId === "string" &&
    typeof value.scope === "string" &&
    typeof value.operationId === "string";
}

function bytesInput(value: unknown): string | Uint8Array {
  if (typeof value === "string" || value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Codec input must be a string, Uint8Array, or ArrayBuffer.");
}

function isContentAddressedStore(value: PactiumRecord): value is ContentAddressedStore {
  return typeof value.putBlock === "function" &&
    typeof value.getBlock === "function" &&
    typeof value.hasBlock === "function" &&
    typeof value.walk === "function" &&
    typeof value.listMissing === "function" &&
    typeof value.verify === "function";
}

function isProtocolEventLog(value: PactiumRecord): value is ProtocolEventLog {
  return typeof value.appendEvent === "function" &&
    typeof value.listEvents === "function" &&
    typeof value.getEvent === "function" &&
    typeof value.verifyPartition === "function";
}

export const MERKLE_STATE_SUBSTRATE_PROTOCOL = PACTIUM_PROTOCOL;
export const MERKLE_STATE_SUBSTRATE_PROVIDER = "pactium.verifiable-state-substrate";

const STATE_ROOT_SCOPE = "meshrix-state-root";
const STATE_COMMIT_SCOPE = "meshrix-state-commit";
const STATE_COMMIT_EVENT_INDEX_SCOPE = "meshrix-state-commit-event-index";
const STATE_MUTATION_IDEMPOTENCY_SCOPE = "meshrix-state-mutation-idempotency";
const EVENT_LOG_SCOPE = "meshrix-event-log";
const STATE_EVENT_HASH_DOMAIN = "meshrix.state-event";
const EMPTY_STATE_VALUE_REF = "meshrix:value-ref:none";

function substrateMutationError(code: string, message: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

async function selectedStorageBackend(storage: PactiumStoragePort): Promise<string> {
  await storage.initialize?.();
  return text(storage.selectedStorageBackend || storage.storageBackend || "").toLowerCase();
}

async function assertTransactionalStorage(storage: PactiumStoragePort, capability: string): Promise<void> {
  if (storage.inMemory) return;
  const backend = await selectedStorageBackend(storage);
  if (backend !== "sqlite") {
    throw substrateMutationError(
      "pactium_transactional_storage_required",
      `${capability} requires Pactium SQLite transactional storage.`
    );
  }
}

async function withSerializedStorageMutation<Result>(storage: PactiumStoragePort, name: string, task: () => Promise<Result>): Promise<Result> {
  return queueStateMutation(`pactium-storage:${storage.dataDir}`, async () => {
    if (storage.inMemory || typeof storage.withWriteLock !== "function") return task();
    return storage.withWriteLock(async () => {
      storage.clearCache?.();
      return task();
    }, { name, timeoutMs: 30_000 });
  });
}

async function withTransactionalCoreMutation<Result>(runtime: MeshrixPactiumRuntime, capability: string, task: () => Promise<Result>): Promise<Result> {
  const { core, storage } = runtime;
  return queueStateMutation(`pactium-storage:${runtime.dataDir}`, async () => {
    await assertTransactionalStorage(storage, capability);
    if (typeof core.withMutationTransaction === "function") {
      return core.withMutationTransaction(task);
    }
    if (storage.inMemory) return task();
    throw substrateMutationError(
      "pactium_transaction_api_required",
      `${capability} requires Pactium compound mutation transactions.`
    );
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function asObject(value: unknown, fallback: PactiumRecord = {}): PactiumRecord {
  return isRecord(value) ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ""): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizePathKey(value: unknown): string {
  return text(value)
    .replace(/\\/gu, "/")
    .replace(/\/+/gu, "/")
    .replace(/^\/+|\/+$/gu, "");
}

function normalizeCanonical(value: unknown): PactiumCanonicalValue {
  return normalizeCanonicalValue(toCanonicalSafeValue(value, {
    maxDepth: 256,
    maxArrayItems: 100000,
    maxObjectKeys: 100000,
    maxStringLength: 1000000,
    binaryMode: "preserve"
  }));
}

function hashValue(value: unknown): string {
  return protocolHash("meshrix.value", value);
}

function storageKey(kind: string, value: unknown): string {
  return protocolHashHex(`meshrix.${kind}`, text(value, "default"));
}

function stateIndexDomain(scope: unknown): string {
  return `meshrix-state-${storageKey("state-scope", scope)}`;
}

function normalizeIndexEntry(entry: PactiumRecord = {}): IndexEntry {
  const valueRef = text(entry.valueRef || entry.cid || entry.value || "");
  return {
    key: normalizePathKey(entry.key || entry.path),
    valueRef,
    valueHash: text(entry.valueHash || (valueRef ? hashValue({ valueRef }) : "")),
    metadata: normalizeCanonical(asObject(entry.metadata))
  };
}

function normalizeStateMutations(value: unknown): NormalizedStateMutation[] {
  if (value !== undefined && !Array.isArray(value)) {
    throw substrateMutationError(
      "state_mutations_invalid",
      "State mutations must be an array."
    );
  }
  const latestByKey = new Map<string, NormalizedStateMutation>();
  for (const candidate of asArray(value)) {
    if (!isRecord(candidate)) {
      throw substrateMutationError(
        "state_mutation_invalid",
        "Each state mutation must be an object."
      );
    }
    const mutation = candidate as StateMutation;
    const action = text(mutation.action, "put");
    if (action !== "put" && action !== "delete") {
      throw substrateMutationError(
        "state_mutation_action_invalid",
        "State mutation action must be put or delete."
      );
    }
    const key = normalizePathKey(mutation.key);
    if (!key) {
      throw substrateMutationError(
        "state_mutation_key_required",
        "State mutation key is required."
      );
    }
    const metadata = normalizeCanonical(asObject(mutation.metadata)) as PactiumRecord & PactiumCanonicalValue;
    if (action === "delete") {
      latestByKey.set(key, { action, key, valueRef: "", valueHash: "", metadata });
      continue;
    }
    const suppliedValue = Object.hasOwn(mutation, "valueRef")
      ? mutation.valueRef
      : Object.hasOwn(mutation, "cid")
        ? mutation.cid
        : mutation.value;
    if (typeof suppliedValue !== "string") {
      throw substrateMutationError(
        "state_mutation_value_ref_required",
        "Put state mutations require a string valueRef."
      );
    }
    const valueRef = suppliedValue.trim() || EMPTY_STATE_VALUE_REF;
    const valueHash = hashValue({ valueRef });
    if (text(mutation.valueHash) && text(mutation.valueHash) !== valueHash) {
      throw substrateMutationError(
        "state_mutation_value_hash_mismatch",
        "State mutation valueHash does not match valueRef."
      );
    }
    latestByKey.set(key, { action, key, valueRef, valueHash, metadata });
  }
  return sortEntries([...latestByKey.values()]);
}

function pactiumStateMutations(mutations: readonly NormalizedStateMutation[]): NormalizedStateMutation[] {
  return mutations.map((mutation) => ({ ...mutation }));
}

function normalizeContentRefs(value: unknown): string[] {
  if (value !== undefined && !Array.isArray(value)) {
    throw substrateMutationError(
      "state_content_refs_invalid",
      "State commit contentRefs must be an array."
    );
  }
  return asArray(value).map((contentRef) => text(contentRef)).filter(Boolean);
}

function canonicalEquals(left: unknown, right: unknown): boolean {
  return canonicalJson(normalizeCanonical(left)) === canonicalJson(normalizeCanonical(right));
}

function sortEntries<Entry extends { key: string }>(entries: readonly Entry[]): Entry[] {
  return [...entries].sort((left, right) => left.key.localeCompare(right.key));
}

function proofExists(proof: unknown): boolean {
  return isRecord(proof) && proof.proofType === PACTIUM_PROOF_TYPES.indexMembership;
}

function sortedChunkRecords(records: readonly ChunkRecord[]): ChunkRecord[] {
  return sortEntries(records.map((record) => ({
    ...record,
    key: `${normalizePathKey(record.relativePath || record.fileId)}#${String(Number(record.chunkIndex || 0)).padStart(12, "0")}`
  }))).map(({ key: _key, ...record }) => record);
}

export function createPactiumStateSubstrate({ userDataPath = "", dataDir = "", pactiumRuntime = null }: StateSubstrateOptions = {}) {
  const resolvedDataDir = resolveMeshrixPactiumDataDir(userDataPath || dataDir);
  const ownsPactiumRuntime = !pactiumRuntime;
  const runtime = normalizeMeshrixPactiumRuntime({
    dataDir: resolvedDataDir,
    pactiumRuntime
  });
  const core = runtime.core;
  const storage = runtime.storage;
  const indexEngine = runtime.indexEngine;
  const pins = new Map<string, PactiumCanonicalValue>();

  const createdContentAddressedStore = createContentAddressedStore({
    storage,
    defaultKind: "meshrix.cas-block"
  });
  if (!isContentAddressedStore(createdContentAddressedStore)) {
    throw new Error("Pactium content-addressed store does not expose the required operations.");
  }
  const contentAddressedStore = createdContentAddressedStore;

  const cas = Object.freeze({
    putBlock: contentAddressedStore.putBlock,
    getBlock: contentAddressedStore.getBlock,
    hasBlock: contentAddressedStore.hasBlock,
    walk: contentAddressedStore.walk,
    listMissing: contentAddressedStore.listMissing,
    verify: contentAddressedStore.verify,
    async pin(rootCid: string, policy: PactiumRecord = {}) {
      const normalizedPolicy = normalizeCanonical(asObject(policy));
      pins.set(rootCid, normalizedPolicy);
      await storage.putProtocolObject("meshrix-cas-pin", storageKey("cas-pin", rootCid), {
        rootCid,
        policy: normalizedPolicy,
        pinnedAt: nowIso()
      });
      return { rootCid, policy: normalizedPolicy, pinnedAt: nowIso() };
    },
    async gc() {
      return {
        collected: 0,
        retainedRoots: [...pins.keys()],
        policy: "pactium-managed-retention"
      };
    }
  });

  const merkleDag = Object.freeze({
    async buildManifest(type: unknown, refs: unknown = [], metadata: PactiumRecord = {}) {
      const entries = sortEntries(recordArray(refs)
        .map((entry) => ({
          key: normalizePathKey(entry.key || entry.path || entry.relativePath),
          path: normalizePathKey(entry.path || entry.relativePath || entry.key),
          cid: text(entry.cid || entry.valueRef),
          valueRef: text(entry.valueRef || entry.cid),
          byteLength: Number(entry.byteLength || 0),
          metadata: normalizeCanonical(asObject(entry.metadata))
        }))
        .filter((entry) => entry.key && entry.valueRef));
      const manifest: PactiumRecord = {
        protocol: PACTIUM_PROTOCOL,
        schema: PACTIUM_SCHEMA_VERSION,
        manifestType: "meshrix.merkle-dag.manifest",
        type: text(type, "manifest"),
        entries,
        refs: entries.map((entry) => entry.valueRef),
        metadata: normalizeCanonical(asObject(metadata)),
        createdAt: nowIso()
      };
      const block = await cas.putBlock(manifest, {
        refs: manifest.refs,
        kind: "meshrix.merkle-dag.manifest"
      });
      return {
        ...manifest,
        rootCid: text(block.cid),
        manifestCid: text(block.cid)
      };
    },
    async verify(rootCid: string) {
      const result = await cas.walk(rootCid);
      return {
        ok: result.missing.length === 0,
        rootCid,
        blockCount: result.blockCount,
        missing: result.missing
      };
    },
    async diff(_leftRootCid: string, rightRootCid: string) {
      const right = await cas.walk(rightRootCid);
      return {
        missing: right.missing,
        rightBlockCount: right.blockCount
      };
    }
  });

  const merkleIndex = Object.freeze({
    async create(domain: unknown, entries: unknown = []) {
      const index = await indexEngine.createIndex(
        sortEntries(recordArray(entries).map(normalizeIndexEntry).filter((entry) => entry.key)),
        { domain: text(domain, "index") }
      );
      return {
        indexRootCid: text(index.root),
        root: text(index.root),
        domain: text(index.domain),
        count: Number(index.count || 0)
      };
    },
    async put(indexRootCid: string, key: unknown, valueRef: unknown, metadata: PactiumRecord = {}) {
      const normalizedKey = normalizePathKey(key);
      const entry = normalizeIndexEntry({
        key: normalizedKey,
        valueRef,
        valueHash: hashValue({ valueRef }),
        metadata
      });
      const next = await indexEngine.put(indexRootCid, normalizedKey, entry, { domain: "meshrix-state" });
      return {
        indexRootCid: text(next.root),
        root: text(next.root),
        entry,
        count: Number(next.count || 0)
      };
    },
    async delete(indexRootCid: string, key: unknown) {
      const next = await indexEngine.delete(indexRootCid, normalizePathKey(key), { domain: "meshrix-state" });
      return {
        indexRootCid: text(next.root),
        root: text(next.root),
        count: Number(next.count || 0)
      };
    },
    get(indexRootCid: string, key: unknown) {
      return indexEngine.get(indexRootCid, normalizePathKey(key));
    },
    scan(indexRootCid: string, { min = "", max = "\uffff", limit = 5000, after = "" }: { min?: string; max?: string; limit?: number; after?: string } = {}) {
      return indexEngine.scan(indexRootCid, { min, max, limit, after });
    },
    prefix(indexRootCid: string, keyPrefix = "", options: { min?: string; max?: string; limit?: number; after?: string } = {}) {
      return indexEngine.prefix(indexRootCid, normalizePathKey(keyPrefix), options);
    },
    diff(leftRootCid: string, rightRootCid: string) {
      return indexEngine.diff(leftRootCid, rightRootCid);
    },
    async prove(indexRootCid: string, key: unknown) {
      const normalizedKey = normalizePathKey(key);
      const proof = await indexEngine.prove(indexRootCid, normalizedKey);
      const entry = isRecord(proof.entry) ? proof.entry : null;
      return {
        ...proof,
        exists: proofExists(proof),
        valueRef: entry?.valueRef || "",
        entry,
        indexRootCid: proof.indexRoot || indexRootCid,
        proofHash: protocolHash("meshrix.index-proof", proof)
      };
    }
  });

  // Caller-owned locking: compound state commits already hold the storage write
  // lock, so the Pactium helper must not take a nested lock on append.
  const createdProtocolEventLog = createAppendOnlyEventLog({
    storage,
    protocolObjectScope: EVENT_LOG_SCOPE,
    hashDomain: STATE_EVENT_HASH_DOMAIN,
    createEventId: ({ partitionId, operationId }: PactiumRecord = {})  =>
      serverToken("state_event", partitionId, operationId || "", nowIso(), randomUUID()),
    withWriteLock: async (task) => task()
  });
  if (!isProtocolEventLog(createdProtocolEventLog)) {
    throw new Error("Pactium event log does not expose the required operations.");
  }
  const protocolEventLog = createdProtocolEventLog;

  async function appendEventUnlocked(input: PactiumRecord = {}) {
    // Meshrix.js-normalize before Pactium so event payloads / eventHash match
    // commit records that already use normalizeCanonical(asObject(...)).
    return protocolEventLog.appendEvent({
      ...input,
      payload: normalizeCanonical(asObject(input.payload))
    });
  }

  const eventLog = Object.freeze({
    appendEvent(input: PactiumRecord = {})  {
      const partitionId = text(input.partitionId || input.scope, "default");
      return withSerializedStorageMutation(
        storage,
        `meshrix-event-log-${storageKey("event-partition", partitionId)}`,
        ()  => appendEventUnlocked(input)
      );
    },
    listEvents: protocolEventLog.listEvents,
    getEvent: protocolEventLog.getEvent,
    verifyPartition: protocolEventLog.verifyPartition
  });

  async function loadStateRoot(scope: unknown): Promise<string> {
    if (!storage.inMemory) storage.clearCache?.();
    return text(await storage.getProtocolObject(STATE_ROOT_SCOPE, storageKey("state-root", scope), ""));
  }

  async function saveStateRoot(scope: unknown, root: unknown): Promise<void> {
    await storage.putProtocolObject(STATE_ROOT_SCOPE, storageKey("state-root", scope), text(root));
  }

  async function loadStoredCommit(commitId: unknown): Promise<unknown> {
    if (!storage.inMemory) storage.clearCache?.();
    return storage.getProtocolObject(STATE_COMMIT_SCOPE, text(commitId), null);
  }

  async function loadCommit(commitId: unknown): Promise<StateCommitRecord | null> {
    const stored = await loadStoredCommit(commitId);
    return isStateCommitRecord(stored) ? stored : null;
  }

  async function saveCommit(commit: StateCommitRecord): Promise<void> {
    await storage.putProtocolObject(STATE_COMMIT_SCOPE, commit.commitId, commit);
    await storage.putProtocolObject(
      STATE_COMMIT_EVENT_INDEX_SCOPE,
      storageKey(
        "state-commit-event",
        canonicalJson({
          scope: commit.scope,
          eventHash: commit.eventHash
        })
      ),
      {
        commitId: commit.commitId,
        scope: commit.scope,
        eventHash: commit.eventHash
      }
    );
  }

  function stateMutationIdempotencyKey({
    kind,
    scope,
    operationId,
    idempotencyKey
  }: PactiumRecord)  {
    return storageKey("state-mutation-idempotency", canonicalJson({
      kind: text(kind),
      scope: text(scope, "default"),
      operationId: text(operationId),
      idempotencyKey: text(idempotencyKey)
    }));
  }

  function stateMutationInputDigest(kind: "commit" | "restore", input: PactiumRecord = {}): string {
    return protocolHash(`meshrix.state-${kind}`, normalizeCanonical({
      scope: text(input.scope, "default"),
      operationId: text(input.operationId),
      ...(Object.hasOwn(input, "expectedCurrentRoot")
        ? { expectedCurrentRoot: text(input.expectedCurrentRoot) }
        : {}),
      ...(kind === "restore"
        ? {
            targetRoot: text(input.targetRoot || input.root),
            anchor: asObject(input.anchor),
            allowedOperationIds: asArray(input.allowedOperationIds)
              .map((operationId) => text(operationId))
              .filter(Boolean),
            maxSuffixEvents: Number(input.maxSuffixEvents || 256),
            contentRefs: asArray(input.contentRefs)
          }
        : {
            mutations: asArray(input.mutations),
            contentRefs: asArray(input.contentRefs)
          }),
      payload: asObject(input.payload)
    }));
  }

  async function replayStateMutationIfPresent(kind: "commit" | "restore", input: PactiumRecord = {}) {
    const idempotencyKey = text(input.idempotencyKey);
    if (!idempotencyKey) return null;
    const scope = text(input.scope, "default");
    const operationId = text(input.operationId);
    const claimKey = stateMutationIdempotencyKey({
      kind,
      scope,
      operationId,
      idempotencyKey
    });
    const inputDigest = stateMutationInputDigest(kind, input);
    const storedClaim = await storage.getProtocolObject(
      STATE_MUTATION_IDEMPOTENCY_SCOPE,
      claimKey,
      null
    );
    if (!storedClaim) {
      return { claimKey, inputDigest, replay: null };
    }
    if (!isStateMutationClaim(storedClaim)) {
      throw substrateMutationError(
        "state_mutation_idempotency_incomplete",
        "State mutation idempotency claim is incomplete."
      );
    }
    const existing = storedClaim;
    if (text(existing.inputDigest) !== inputDigest) {
      throw substrateMutationError(
        "state_mutation_idempotency_conflict",
        "State mutation idempotency key was reused with different input."
      );
    }
    const commit = await loadCommit(text(existing.commitId));
    if (
      !commit ||
      commit.scope !== scope ||
      commit.operationId !== operationId
    ) {
      throw substrateMutationError(
        "state_mutation_idempotency_incomplete",
        "State mutation idempotency claim is incomplete."
      );
    }
    return {
      claimKey,
      inputDigest,
      replay: Object.freeze({ ...commit, replayed: true })
    };
  }

  async function saveStateMutationClaim({
    claimKey,
    inputDigest,
    commit
  }: { claimKey?: string; inputDigest?: string; commit: StateCommitRecord }): Promise<void> {
    if (!claimKey) return;
    await storage.putProtocolObject(
      STATE_MUTATION_IDEMPOTENCY_SCOPE,
      claimKey,
      {
        inputDigest,
        commitId: commit.commitId,
        scope: commit.scope,
        operationId: commit.operationId
      }
    );
  }

  async function verifyRestoreLineage({
    scope,
    targetRoot,
    allowedOperationIds = [],
    anchor = null,
    maxSuffixEvents = 256
  }: {
    scope: string;
    targetRoot: string;
    allowedOperationIds?: unknown;
    anchor?: unknown;
    maxSuffixEvents?: unknown;
  }) {
    const events = [...await eventLog.listEvents(scope, { limit: 10000 })].reverse();
    const normalizedAnchor = asObject(anchor);
    const anchorOffset = Number(normalizedAnchor.offset);
    const anchoredEvent = Number.isInteger(anchorOffset) ? events[anchorOffset] : null;
    const anchorIndex = anchoredEvent?.eventHash === text(normalizedAnchor.eventHash) && anchoredEvent?.afterRoot === targetRoot
      ? anchorOffset
      : -1;
    const allowed = asArray(allowedOperationIds).map((operationId) => text(operationId)).filter(Boolean);
    const suffix = events.slice(anchorIndex + 1);
    const conflicting = suffix.find(
      (event) => !allowed.includes(text(event.operationId))
    );
    if (anchorIndex < 0 || allowed.length === 0 || suffix.length > Math.max(1, Number(maxSuffixEvents) || 256) || conflicting) {
      const error = new Error("State root restore lineage contains an unrelated mutation.") as CodedError;
      error.code = "state_root_restore_lineage_conflict";
      error.status = 409;
      throw error;
    }
    return { ok: true, eventCount: suffix.length };
  }

  async function pactiumEvidenceForEnvelope(
    envelopeValue: unknown,
    { operationId, scope }: { operationId: string; scope: string }
  ): Promise<StateCommitPactiumEvidence> {
    const envelope = asObject(envelopeValue);
    const factRef = asObject(envelope.factRef);
    const verifierManifest = asObject(asObject(envelope.ledgerHead).verifierManifest);
    const ledgerIndex = Number(factRef.ledgerIndex ?? -1);
    if (
      envelope.envelopeKind !== "operation-outcome" ||
      envelope.factType !== "operation.outcome" ||
      !text(envelope.envelopeId) ||
      !text(envelope.factId) ||
      !text(factRef.ledgerEventId) ||
      !text(verifierManifest.manifestId) ||
      !text(verifierManifest.manifestHash) ||
      !Number.isSafeInteger(ledgerIndex) ||
      ledgerIndex < 0
    ) {
      throw substrateMutationError(
        "state_commit_pactium_evidence_invalid",
        "Pactium did not return complete state commit evidence."
      );
    }
    const ledgerLeaf = await core.readLedgerLeaf(ledgerIndex);
    const fact = isRecord(ledgerLeaf?.fact) ? ledgerLeaf.fact : null;
    if (
      !fact ||
      ledgerLeaf?.eventId !== factRef.ledgerEventId ||
      fact.factType !== "operation.outcome" ||
      fact.intentId !== envelope.factId ||
      fact.operationId !== operationId ||
      fact.workspaceId !== scope ||
      !text(fact.outcomeId)
    ) {
      throw substrateMutationError(
        "state_commit_pactium_evidence_invalid",
        "Pactium state commit evidence does not bind to the recorded operation."
      );
    }
    return {
      envelopeId: text(envelope.envelopeId),
      intentId: text(fact.intentId),
      outcomeId: text(fact.outcomeId),
      ledgerEventId: text(factRef.ledgerEventId),
      ledgerIndex,
      verifierManifestId: text(verifierManifest.manifestId),
      verifierManifestHash: text(verifierManifest.manifestHash)
    };
  }

  async function readStateEntries(root: string): Promise<IndexEntry[]> {
    if (!root) return [];
    const snapshot = await indexEngine.readSnapshot(root);
    return sortEntries(recordArray(snapshot.entries)
      .map(normalizeIndexEntry)
      .filter((entry) => entry.key));
  }

  function replayStateEntries(
    entries: readonly IndexEntry[],
    mutations: readonly NormalizedStateMutation[]
  ): IndexEntry[] {
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    for (const mutation of mutations) {
      if (mutation.action === "delete") {
        byKey.delete(mutation.key);
      } else {
        byKey.set(mutation.key, {
          key: mutation.key,
          valueRef: mutation.valueRef,
          valueHash: mutation.valueHash,
          metadata: mutation.metadata
        });
      }
    }
    return sortEntries([...byKey.values()]);
  }

  async function readPactiumProofMaterial(envelope: PactiumRecord): Promise<PactiumRecord> {
    for (const reference of recordArray(envelope.proofRefs)) {
      const cid = text(reference.cid);
      if (!cid) continue;
      const block = await core.resolveBlock(cid);
      if (!block?.bytes) continue;
      const decoded = canonicalDecode(bytesInput(block.bytes));
      if (isRecord(decoded) && decoded.materialType === "pactium.proof-material") {
        return decoded;
      }
    }
    throw substrateMutationError(
      "state_commit_pactium_proof_missing",
      "Pactium state commit proof material is missing."
    );
  }

  async function verifyCommitEvent(commit: StateCommitRecord): Promise<void> {
    const event = await eventLog.getEvent(commit.scope, commit.eventOffset);
    if (!event) {
      throw substrateMutationError(
        "state_commit_event_missing",
        "State commit event is missing."
      );
    }
    const expectedPayload = commit.commitKind === "restore"
      ? { ...commit.payload, restoredRoot: commit.afterRoot }
      : commit.payload;
    const expectedHash = protocolHash(STATE_EVENT_HASH_DOMAIN, {
      ...event,
      eventHash: undefined
    });
    if (
      event.protocol !== PACTIUM_PROTOCOL ||
      event.schema !== PACTIUM_SCHEMA_VERSION ||
      event.partitionId !== commit.scope ||
      event.offset !== commit.eventOffset ||
      event.eventId !== commit.eventId ||
      event.eventHash !== commit.eventHash ||
      event.eventHash !== expectedHash ||
      event.operationId !== commit.operationId ||
      event.beforeRoot !== commit.beforeRoot ||
      event.afterRoot !== commit.afterRoot ||
      !canonicalEquals(event.contentRefs, commit.contentRefs) ||
      !canonicalEquals(event.payload, expectedPayload)
    ) {
      throw substrateMutationError(
        "state_commit_event_mismatch",
        "State commit event does not match the commit record."
      );
    }
    const partition = await eventLog.verifyPartition(commit.scope);
    if (partition.ok !== true) {
      throw substrateMutationError(
        "state_commit_event_chain_invalid",
        "State commit event partition hash chain is invalid."
      );
    }
  }

  async function verifyCommitPactiumEvidence(commit: StateCommitRecord): Promise<void> {
    let bundle: Awaited<ReturnType<typeof core.exportProofBundle>>;
    try {
      bundle = await core.exportProofBundle(commit.pactium.envelopeId);
    } catch {
      throw substrateMutationError(
        "state_commit_pactium_envelope_missing",
        "State commit Pactium envelope is missing."
      );
    }
    const envelope = asObject(bundle.envelope);
    const factRef = asObject(envelope.factRef);
    if (
      envelope.envelopeId !== commit.pactium.envelopeId ||
      envelope.envelopeKind !== "operation-outcome" ||
      envelope.factType !== "operation.outcome" ||
      envelope.factId !== commit.pactium.intentId ||
      factRef.ledgerEventId !== commit.pactium.ledgerEventId ||
      Number(factRef.ledgerIndex ?? -1) !== commit.pactium.ledgerIndex
    ) {
      throw substrateMutationError(
        "state_commit_pactium_locator_mismatch",
        "State commit Pactium envelope locator does not match."
      );
    }
    const proofMaterial = await readPactiumProofMaterial(envelope);
    const ledgerProof = asObject(proofMaterial.ledger);
    const trustedManifest = asObject(asObject(ledgerProof.head).verifierManifest);
    if (
      trustedManifest.manifestId !== commit.pactium.verifierManifestId ||
      trustedManifest.manifestHash !== commit.pactium.verifierManifestHash
    ) {
      throw substrateMutationError(
        "state_commit_pactium_trust_mismatch",
        "State commit Pactium verifier manifest does not match."
      );
    }
    const verification = await core.verifyEnvelope(bundle.envelope, {
      trustedManifest,
      requireFullStateMutationProofs: true
    });
    if (verification.ok !== true) {
      throw substrateMutationError(
        "state_commit_pactium_proof_invalid",
        "State commit Pactium proof did not verify."
      );
    }
    const ledgerLeaf = await core.readLedgerLeaf(commit.pactium.ledgerIndex);
    const fact = isRecord(ledgerLeaf?.fact) ? ledgerLeaf.fact : null;
    if (
      !fact ||
      ledgerLeaf?.index !== commit.pactium.ledgerIndex ||
      ledgerLeaf.eventId !== commit.pactium.ledgerEventId ||
      ledgerLeaf.factCid !== factRef.factCid ||
      ledgerLeaf.factHash !== factRef.factHash ||
      fact.factType !== "operation.outcome" ||
      fact.intentId !== commit.pactium.intentId ||
      fact.outcomeId !== commit.pactium.outcomeId ||
      fact.operationId !== commit.operationId ||
      fact.workspaceId !== commit.scope ||
      fact.status !== "succeeded" ||
      fact.resultHash !== protocolHash("operation.outcome", {
        beforeRoot: commit.beforeRoot,
        afterRoot: commit.afterRoot
      })
    ) {
      throw substrateMutationError(
        "state_commit_pactium_ledger_mismatch",
        "State commit Pactium ledger outcome does not match."
      );
    }
    const proofs = asObject(proofMaterial.proofs);
    const proofCommit = asObject(proofs.stateCommit);
    const proofProfile = asObject(proofCommit.proofProfile);
    const expectedMutations = pactiumStateMutations(commit.mutations);
    if (
      proofCommit.factType !== "state.commit" ||
      proofCommit.outcomeId !== commit.pactium.outcomeId ||
      proofCommit.intentId !== commit.pactium.intentId ||
      proofCommit.workspaceId !== commit.scope ||
      Number(proofCommit.mutationCount ?? -1) !== expectedMutations.length ||
      !canonicalEquals(proofCommit.mutations, expectedMutations) ||
      !canonicalEquals(proofCommit.mutationKeys, expectedMutations.map(({ key }) => key)) ||
      !canonicalEquals(proofCommit.mutationActions, expectedMutations.map(({ action }) => action)) ||
      proofCommit.mutationProofMode !== "full" ||
      proofCommit.proofCompleteness !== "full" ||
      proofProfile.mode !== "full" ||
      proofProfile.completeness !== "full" ||
      Number(proofProfile.totalUniqueKeyCount ?? -1) !== expectedMutations.length ||
      Number(proofProfile.provedKeyCount ?? -1) !== expectedMutations.length
    ) {
      throw substrateMutationError(
        "state_commit_pactium_state_mismatch",
        "State commit Pactium state mutation proof does not match."
      );
    }
  }

  async function verifyStateCommitRecord(commit: StateCommitRecord): Promise<void> {
    if (
      commit.protocol !== PACTIUM_PROTOCOL ||
      commit.schema !== PACTIUM_SCHEMA_VERSION ||
      !text(commit.commitId) ||
      !text(commit.scope) ||
      !text(commit.operationId) ||
      !text(commit.afterRoot) ||
      !text(commit.eventHash) ||
      !text(commit.eventId)
    ) {
      throw substrateMutationError(
        "state_commit_record_invalid",
        "State commit record is invalid."
      );
    }
    const normalizedContentRefs = normalizeContentRefs(commit.contentRefs);
    const normalizedMutations = normalizeStateMutations(commit.mutations);
    if (
      !canonicalEquals(commit.contentRefs, normalizedContentRefs) ||
      !canonicalEquals(commit.mutations, normalizedMutations) ||
      (commit.commitKind === "restore" && normalizedMutations.length !== 0)
    ) {
      throw substrateMutationError(
        "state_commit_record_noncanonical",
        "State commit record is not canonical."
      );
    }
    let beforeEntries: IndexEntry[];
    let afterEntries: IndexEntry[];
    try {
      beforeEntries = await readStateEntries(commit.beforeRoot);
      afterEntries = await readStateEntries(commit.afterRoot);
    } catch {
      throw substrateMutationError(
        "state_commit_root_invalid",
        "State commit references an invalid Merkle root."
      );
    }
    if (
      commit.commitKind === "mutation" &&
      !canonicalEquals(replayStateEntries(beforeEntries, normalizedMutations), afterEntries)
    ) {
      throw substrateMutationError(
        "state_commit_replay_mismatch",
        "State commit mutations do not reproduce the after root."
      );
    }
    await verifyCommitEvent(commit);
    await verifyCommitPactiumEvidence(commit);
  }

  const stateCommit = Object.freeze({
    async begin({ scope = "default" }: PactiumRecord = {}) {
      return {
        scope: text(scope, "default"),
        currentRoot: await loadStateRoot(scope)
      };
    },
    async commit(input: PactiumRecord = {}) {
      return withTransactionalCoreMutation(runtime, "State commits", async () => {
        const scope = text(input.scope, "default");
        const operationId = text(input.operationId, "meshrix.state.commit");
        const mutations = normalizeStateMutations(input.mutations);
        const contentRefs = normalizeContentRefs(input.contentRefs);
        const payload = normalizeCanonical(asObject(input.payload)) as PactiumRecord;
        const idempotency = await replayStateMutationIfPresent(
          "commit",
          { ...input, scope, operationId, mutations, contentRefs, payload }
        );
        if (idempotency?.replay) return idempotency.replay;
        const beforeRoot = await loadStateRoot(scope);
        if (Object.hasOwn(input, "expectedCurrentRoot") && text(input.expectedCurrentRoot) !== beforeRoot) {
          const error = substrateMutationError(
            "state_root_commit_conflict",
            "State root changed before commit."
          );
          error.status = 409;
          throw error;
        }
        let afterRoot = beforeRoot;
        if (!afterRoot) {
          afterRoot = text((await indexEngine.createIndex([], { domain: stateIndexDomain(scope) })).root);
        }
        for (const mutation of mutations) {
          if (mutation.action === "delete") {
            afterRoot = (await merkleIndex.delete(afterRoot, mutation.key)).indexRootCid;
          } else {
            afterRoot = (await merkleIndex.put(afterRoot, mutation.key, mutation.valueRef, mutation.metadata)).indexRootCid;
          }
        }
        const envelope = await core.recordOperation({
          operationId,
          workspaceId: scope,
          idempotencyKey: text(input.idempotencyKey),
          returnIntentReplay: true,
          input: payload,
          result: { beforeRoot, afterRoot },
          stateMutations: pactiumStateMutations(mutations),
          proofOptions: { stateMutationProofMode: "full" }
        });
        if (envelope?.replayed) {
          throw substrateMutationError(
            "state_mutation_idempotency_incomplete",
            "State evidence replay exists without a matching state mutation claim."
          );
        }
        const pactium = await pactiumEvidenceForEnvelope(envelope, { operationId, scope });
        await saveStateRoot(scope, afterRoot);
        const event = await appendEventUnlocked({
          partitionId: scope,
          operationId,
          beforeRoot,
          afterRoot,
          contentRefs,
          payload
        });
        const commitId = serverToken("state_commit", scope, event.eventHash, nowIso(), randomUUID());
        const commit: StateCommitRecord = {
          protocol: PACTIUM_PROTOCOL,
          schema: PACTIUM_SCHEMA_VERSION,
          commitKind: "mutation",
          commitId,
          scope,
          operationId,
          beforeRoot,
          afterRoot,
          eventHash: event.eventHash,
          eventId: event.eventId,
          eventOffset: Number(event.offset),
          contentRefs,
          mutations,
          payload,
          pactium,
          createdAt: nowIso()
        };
        await saveCommit(commit);
        await saveStateMutationClaim({
          claimKey: idempotency?.claimKey,
          inputDigest: idempotency?.inputDigest,
          commit
        });
        return commit;
      });
    },
    async verifyRestoreLineage(input: PactiumRecord = {}) {
      const scope = text(input.scope, "default");
      const targetRoot = text(input.targetRoot || input.root);
      return verifyRestoreLineage({ scope, targetRoot, allowedOperationIds: input.allowedOperationIds, anchor: input.anchor, maxSuffixEvents: input.maxSuffixEvents });
    },
    async restoreRoot(input: PactiumRecord = {}) {
      return withTransactionalCoreMutation(runtime, "State root restores", async () => {
        const scope = text(input.scope, "default");
        const operationId = text(input.operationId, "meshrix.state.root.restore");
        const contentRefs = normalizeContentRefs(input.contentRefs);
        const payload = normalizeCanonical(asObject(input.payload)) as PactiumRecord;
        const idempotency = await replayStateMutationIfPresent(
          "restore",
          { ...input, scope, operationId, contentRefs, payload }
        );
        if (idempotency?.replay) return idempotency.replay;
        const targetRoot = text(input.targetRoot || input.root);
        const beforeRoot = await loadStateRoot(scope);
        if (!targetRoot) throw new Error("State root restore requires a target root.");
        if (
          Object.hasOwn(input, "expectedCurrentRoot") &&
          text(input.expectedCurrentRoot) !== beforeRoot
        ) {
          const error = new Error("State root changed before restore.") as CodedError;
          error.code = "state_root_restore_conflict";
          throw error;
        }
        await verifyRestoreLineage({ scope, targetRoot, allowedOperationIds: input.allowedOperationIds, anchor: input.anchor, maxSuffixEvents: input.maxSuffixEvents });
        try {
          await indexEngine.readIndexRoot(targetRoot);
        } catch {
          throw substrateMutationError(
            "state_root_restore_target_invalid",
            "State root restore target is not a readable Merkle root."
          );
        }
        const envelope = await core.recordOperation({
          operationId,
          workspaceId: scope,
          idempotencyKey: text(input.idempotencyKey),
          returnIntentReplay: true,
          input: payload,
          result: { beforeRoot, afterRoot: targetRoot },
          stateMutations: [],
          proofOptions: { stateMutationProofMode: "full" }
        });
        if (envelope?.replayed) {
          throw substrateMutationError(
            "state_mutation_idempotency_incomplete",
            "State evidence replay exists without a matching state mutation claim."
          );
        }
        const pactium = await pactiumEvidenceForEnvelope(envelope, { operationId, scope });
        await saveStateRoot(scope, targetRoot);
        const event = await appendEventUnlocked({
          partitionId: scope,
          operationId,
          beforeRoot,
          afterRoot: targetRoot,
          contentRefs,
          payload: { ...payload, restoredRoot: targetRoot }
        });
        const commitId = serverToken("state_commit", scope, event.eventHash, nowIso(), randomUUID());
        const commit: StateCommitRecord = {
          protocol: PACTIUM_PROTOCOL,
          schema: PACTIUM_SCHEMA_VERSION,
          commitKind: "restore",
          commitId,
          scope,
          operationId: text(operationId),
          beforeRoot,
          afterRoot: targetRoot,
          eventHash: event.eventHash,
          eventId: event.eventId,
          eventOffset: Number(event.offset),
          contentRefs,
          mutations: [],
          payload,
          pactium,
          createdAt: nowIso()
        };
        await saveCommit(commit);
        await saveStateMutationClaim({
          claimKey: idempotency?.claimKey,
          inputDigest: idempotency?.inputDigest,
          commit
        });
        return commit;
      });
    },
    async verifyCommit(commitId: unknown) {
      const normalizedCommitId = text(commitId);
      const stored = await loadStoredCommit(normalizedCommitId);
      if (stored === null || stored === undefined) {
        return {
          ok: false,
          error: "commit_missing",
          commitId: normalizedCommitId
        };
      }
      if (!isStateCommitRecord(stored)) {
        return {
          ok: false,
          error: "commit_malformed",
          commitId: normalizedCommitId
        };
      }
      const commit = stored;
      try {
        await verifyStateCommitRecord(commit);
      } catch (error) {
        return {
          ok: false,
          error: isRecord(error) && typeof error.code === "string"
            ? error.code
            : "state_commit_verification_failed",
          commit
        };
      }
      return {
        ok: true,
        commit
      };
    },
    async getCommitByEventHash({
      scope = "default",
      eventHash = ""
    }: PactiumRecord = {}) {
      const normalizedScope = text(scope, "default");
      const normalizedEventHash = text(eventHash);
      if (!normalizedEventHash) return null;
      const indexed = await storage.getProtocolObject(
        STATE_COMMIT_EVENT_INDEX_SCOPE,
        storageKey(
          "state-commit-event",
          canonicalJson({
            scope: normalizedScope,
            eventHash: normalizedEventHash
          })
        ),
        null
      );
      if (
        !isRecord(indexed) ||
        typeof indexed.scope !== "string" ||
        typeof indexed.eventHash !== "string" ||
        typeof indexed.commitId !== "string" ||
        indexed.scope !== normalizedScope ||
        indexed.eventHash !== normalizedEventHash
      ) {
        return null;
      }
      const commit = await loadCommit(text(indexed.commitId));
      if (
        !commit ||
        commit.scope !== normalizedScope ||
        commit.eventHash !== normalizedEventHash
      ) {
        throw substrateMutationError(
          "state_commit_event_index_incomplete",
          "State commit event index is incomplete."
        );
      }
      return commit;
    }
  });

  const uploadManifest = Object.freeze({
    async materialize(input: PactiumRecord = {}) {
      const records: ChunkRecord[] = sortedChunkRecords(recordArray(input.records));
      for (const record of records) {
        const chunkCid = text(record.chunkCid || record.cid);
        if (!chunkCid || !(await storage.hasBlock(chunkCid))) {
          throw new Error("chunkCid must reference an existing CAS block");
        }
      }
      const manifest = await merkleDag.buildManifest(
        "upload-manifest",
        records.map((record) => {
          const relativePath = normalizePathKey(record.relativePath || record.fileId);
          const suffix = String(Number(record.chunkIndex || 0)).padStart(12, "0");
          return {
            key: `${relativePath}#${suffix}`,
            path: `${relativePath}#${suffix}`,
            cid: text(record.chunkCid || record.cid),
            byteLength: Number(record.byteLength || 0),
            metadata: {
              offset: Number(record.offset || 0),
              chunkHash: text(record.chunkHash)
            }
          };
        }),
        {
          scope: text(input.scope, "default"),
          files: normalizeCanonical(asArray(input.files))
        }
      );
      return {
        ...manifest,
        recordCount: records.length,
        nextOffset: records.reduce(
          (maximum, record) => Math.max(
            maximum,
            Number(record.offset || 0) + Number(record.byteLength || 0)
          ),
          0
        )
      };
    }
  });

  return Object.freeze({
    protocol: PACTIUM_PROTOCOL,
    schema: PACTIUM_SCHEMA_VERSION,
    protocolVersion: PACTIUM_PROTOCOL,
    provider: MERKLE_STATE_SUBSTRATE_PROVIDER,
    pactiumPackageVersion: PACTIUM_PACKAGE_VERSION,
    dataDir: resolvedDataDir,
    pactiumRuntime: runtime,
    canonicalCodec: Object.freeze({
      normalize: normalizeCanonical,
      stableJson: canonicalJson,
      hash: hashValue,
      encode(value: unknown, codec = "pactium-canonical") {
        return codec === "raw" ? Buffer.from(bytesInput(value)) : canonicalEncode(value);
      },
      decode(value: unknown, codec = "pactium-canonical") {
        return codec === "raw" ? Buffer.from(bytesInput(value)) : canonicalDecode(bytesInput(value));
      },
      cid(value: unknown) {
        return cidForCanonical(value);
      }
    }),
    cas,
    merkleDag,
    merkleIndex,
    eventLog,
    stateCommit,
    uploadManifest,
    close()  {
      return ownsPactiumRuntime
        ? (runtime.close?.() || Promise.resolve())
        : Promise.resolve();
    },
    listCapabilities()  {
      return {
        protocol: PACTIUM_PROTOCOL,
        provider: MERKLE_STATE_SUBSTRATE_PROVIDER,
        capabilities: [
          "canonical-codec",
          "content-addressed-store",
          "merkle-dag",
          "verifiable-index",
          "event-log",
          "state-commit",
          "upload-manifest"
        ]
      };
    }
  });
}
