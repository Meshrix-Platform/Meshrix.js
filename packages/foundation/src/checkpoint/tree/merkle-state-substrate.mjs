import { randomUUID } from "node:crypto";
import { canonicalJson } from "@lico/contracts/serialization/canonical-json";
import {
  canonicalDecode,
  canonicalEncode,
  cidForCanonical,
  PACTIUM_PACKAGE_VERSION,
  PACTIUM_PROOF_TYPES,
  PACTIUM_PROTOCOL,
  PACTIUM_SCHEMA_VERSION,
  protocolHash,
  protocolHashHex,
  normalizeCanonicalValue
} from "pactium";
import { serverToken } from "#lico/client-strings";
import { queueStateMutation } from "../../storage/state-coordinator.mjs";
import {
  normalizeLicoPactiumRuntime,
  resolveLicoPactiumDataDir
} from "./pactium-substrate-preflight.mjs";
import { toPactiumCanonicalSafeValue } from "./pactium-canonical-safe.mjs";

export const MERKLE_STATE_SUBSTRATE_PROTOCOL = PACTIUM_PROTOCOL;
export const MERKLE_STATE_SUBSTRATE_PROVIDER = "pactium.verifiable-state-substrate";

const STATE_ROOT_SCOPE = "licomesh-state-root";
const STATE_COMMIT_SCOPE = "licomesh-state-commit";
const EVENT_LOG_SCOPE = "licomesh-event-log";
const LSM_SESSION_SCOPE = "licomesh-lsm-session";

function substrateMutationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function selectedStorageBackend(storage) {
  await storage.initialize?.();
  return text(storage.selectedStorageBackend || storage.storageBackend || "").toLowerCase();
}

async function assertTransactionalStorage(storage, capability) {
  if (storage.inMemory) return;
  const backend = await selectedStorageBackend(storage);
  if (backend !== "sqlite") {
    throw substrateMutationError(
      "pactium_transactional_storage_required",
      `${capability} requires Pactium SQLite transactional storage.`
    );
  }
}

async function withSerializedStorageMutation(storage, name, task) {
  return queueStateMutation(`pactium-storage:${storage.dataDir}`, async () => {
    if (storage.inMemory || typeof storage.withWriteLock !== "function") return task();
    return storage.withWriteLock(async () => {
      storage.clearCache?.();
      return task();
    }, { name, timeoutMs: 30_000 });
  });
}

async function withTransactionalCoreMutation(runtime, capability, task) {
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

function nowIso() {
  return new Date().toISOString();
}

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizePathKey(value) {
  return text(value)
    .replace(/\\/gu, "/")
    .replace(/\/+/gu, "/")
    .replace(/^\/+|\/+$/gu, "");
}

function normalizeCanonical(value) {
  return normalizeCanonicalValue(toPactiumCanonicalSafeValue(value, {
    maxDepth: 256,
    maxArrayItems: 100000,
    maxObjectKeys: 100000,
    maxStringLength: 1000000,
    binaryMode: "preserve"
  }));
}

function hashValue(value) {
  return protocolHash("licomesh.value", value);
}

function storageKey(kind, value) {
  return protocolHashHex(`licomesh.${kind}`, text(value, "default"));
}

function stateIndexDomain(scope) {
  return `licomesh-state-${storageKey("state-scope", scope)}`;
}

function normalizeIndexEntry(entry = {}) {
  const valueRef = text(entry.valueRef || entry.cid || entry.value || "");
  return {
    key: normalizePathKey(entry.key || entry.path),
    valueRef,
    valueHash: text(entry.valueHash || (valueRef ? hashValue({ valueRef }) : "")),
    metadata: normalizeCanonical(asObject(entry.metadata))
  };
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => left.key.localeCompare(right.key));
}

function proofExists(proof) {
  return proof?.proofType === PACTIUM_PROOF_TYPES.indexMembership;
}

function sortedChunkRecords(records) {
  return sortEntries(records.map((record) => ({
    ...record,
    key: `${normalizePathKey(record.relativePath || record.fileId)}#${String(Number(record.chunkIndex || 0)).padStart(12, "0")}`
  }))).map(({ key: _key, ...record }) => record);
}

export function createPactiumStateSubstrate({ userDataPath = "", dataDir = "", pactiumRuntime = null } = {}) {
  const resolvedDataDir = resolveLicoPactiumDataDir(userDataPath || dataDir);
  const ownsPactiumRuntime = !pactiumRuntime;
  const runtime = normalizeLicoPactiumRuntime({
    dataDir: resolvedDataDir,
    pactiumRuntime
  });
  const core = runtime.core;
  const storage = runtime.storage;
  const indexEngine = runtime.indexEngine;
  const pins = new Map();

  async function putBlock(value, options = {}) {
    const codec = text(options.codec, "pactium-canonical") === "raw" ? "raw" : "pactium-canonical";
    return storage.putBlock(value, {
      codec,
      kind: text(options.kind || options.metadata?.kind, "licomesh.cas-block"),
      refs: asArray(options.refs).map(text).filter(Boolean)
    });
  }

  async function getBlock(cid) {
    const record = await storage.getBlock(text(cid));
    if (!record) return null;
    const bytes = Buffer.from(record.bytes || Buffer.from(String(record.payloadBase64 || ""), "base64"));
    return {
      ...record,
      bytes,
      value: record.codec === "raw" ? null : canonicalDecode(bytes)
    };
  }

  async function walk(rootCid) {
    return storage.walk(text(rootCid));
  }

  const cas = Object.freeze({
    putBlock,
    getBlock,
    hasBlock(cid) {
      return storage.hasBlock(text(cid));
    },
    walk,
    async listMissing(rootCid) {
      return (await walk(rootCid)).missing;
    },
    async pin(rootCid, policy = {}) {
      const normalizedPolicy = normalizeCanonical(asObject(policy));
      pins.set(rootCid, normalizedPolicy);
      await storage.putProtocolObject("licomesh-cas-pin", storageKey("cas-pin", rootCid), {
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
    async buildManifest(type, refs = [], metadata = {}) {
      const entries = sortEntries(asArray(refs)
        .map((entry) => ({
          key: normalizePathKey(entry.key || entry.path || entry.relativePath),
          path: normalizePathKey(entry.path || entry.relativePath || entry.key),
          cid: text(entry.cid || entry.valueRef),
          valueRef: text(entry.valueRef || entry.cid),
          byteLength: Number(entry.byteLength || 0),
          metadata: normalizeCanonical(asObject(entry.metadata))
        }))
        .filter((entry) => entry.key && entry.valueRef));
      const manifest = {
        protocol: PACTIUM_PROTOCOL,
        schema: PACTIUM_SCHEMA_VERSION,
        manifestType: "licomesh.merkle-dag.manifest",
        type: text(type, "manifest"),
        entries,
        refs: entries.map((entry) => entry.valueRef),
        metadata: normalizeCanonical(asObject(metadata)),
        createdAt: nowIso()
      };
      const block = await putBlock(manifest, {
        refs: manifest.refs,
        kind: "licomesh.merkle-dag.manifest"
      });
      return {
        ...manifest,
        rootCid: block.cid,
        manifestCid: block.cid
      };
    },
    async verify(rootCid) {
      const result = await walk(rootCid);
      return {
        ok: result.missing.length === 0,
        rootCid,
        blockCount: result.blockCount,
        missing: result.missing
      };
    },
    async diff(_leftRootCid, rightRootCid) {
      const right = await walk(rightRootCid);
      return {
        missing: right.missing,
        rightBlockCount: right.blockCount
      };
    }
  });

  const merkleIndex = Object.freeze({
    async create(domain, entries = []) {
      const index = await indexEngine.createIndex(
        sortEntries(asArray(entries).map(normalizeIndexEntry).filter((entry) => entry.key)),
        { domain: text(domain, "index") }
      );
      return {
        indexRootCid: index.root,
        root: index.root,
        domain: index.domain,
        count: index.count
      };
    },
    async put(indexRootCid, key, valueRef, metadata = {}) {
      const normalizedKey = normalizePathKey(key);
      const entry = normalizeIndexEntry({
        key: normalizedKey,
        valueRef,
        valueHash: hashValue({ valueRef }),
        metadata
      });
      const next = await indexEngine.put(indexRootCid, normalizedKey, entry, { domain: "licomesh-state" });
      return {
        indexRootCid: next.root,
        root: next.root,
        entry,
        count: next.count
      };
    },
    async delete(indexRootCid, key) {
      const next = await indexEngine.delete(indexRootCid, normalizePathKey(key), { domain: "licomesh-state" });
      return {
        indexRootCid: next.root,
        root: next.root,
        count: next.count
      };
    },
    get(indexRootCid, key) {
      return indexEngine.get(indexRootCid, normalizePathKey(key));
    },
    scan(indexRootCid, { min = "", max = "\uffff", limit = 5000, after = "" } = {}) {
      return indexEngine.scan(indexRootCid, { min, max, limit, after });
    },
    prefix(indexRootCid, keyPrefix = "", options = {}) {
      return indexEngine.prefix(indexRootCid, normalizePathKey(keyPrefix), options);
    },
    diff(leftRootCid, rightRootCid) {
      return indexEngine.diff(leftRootCid, rightRootCid);
    },
    async prove(indexRootCid, key) {
      const normalizedKey = normalizePathKey(key);
      const proof = await indexEngine.prove(indexRootCid, normalizedKey);
      const entry = proof.entry || null;
      return {
        ...proof,
        exists: proofExists(proof),
        valueRef: entry?.valueRef || "",
        entry,
        indexRootCid: proof.indexRoot || indexRootCid,
        proofHash: protocolHash("licomesh.index-proof", proof)
      };
    }
  });

  async function loadEvents(partitionId) {
    if (!storage.inMemory) storage.clearCache?.();
    return asArray(await storage.getProtocolObject(EVENT_LOG_SCOPE, storageKey("event-log", partitionId), []));
  }

  async function saveEvents(partitionId, events) {
    await storage.putProtocolObject(EVENT_LOG_SCOPE, storageKey("event-log", partitionId), events);
  }

  async function appendEventUnlocked(input = {}) {
      const partitionId = text(input.partitionId || input.scope, "default");
      const events = await loadEvents(partitionId);
      const previous = events.at(-1) || null;
      const event = {
        protocol: PACTIUM_PROTOCOL,
        schema: PACTIUM_SCHEMA_VERSION,
        eventId: serverToken("state_event", partitionId, input.operationId || "", nowIso(), randomUUID()),
        partitionId,
        operationId: text(input.operationId),
        offset: events.length,
        beforeRoot: text(input.beforeRoot),
        afterRoot: text(input.afterRoot),
        contentRefs: asArray(input.contentRefs).map(text).filter(Boolean),
        payload: normalizeCanonical(asObject(input.payload)),
        prevEventHash: previous?.eventHash || "",
        createdAt: nowIso()
      };
      event.eventHash = protocolHash("licomesh.state-event", {
        ...event,
        eventHash: undefined
      });
      events.push(event);
      await saveEvents(partitionId, events);
      return event;
  }

  const eventLog = Object.freeze({
    async appendEvent(input = {}) {
      const partitionId = text(input.partitionId || input.scope, "default");
      return withSerializedStorageMutation(
        storage,
        `licomesh-event-log-${storageKey("event-partition", partitionId)}`,
        () => appendEventUnlocked(input)
      );
    },
    async listEvents(partitionId, { limit = 100 } = {}) {
      const events = await loadEvents(partitionId);
      return [...events].reverse().slice(0, Math.max(1, Math.min(Number(limit || 100), 10000)));
    },
    async verifyPartition(partitionId) {
      const events = await loadEvents(partitionId);
      let previousHash = "";
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        const expectedHash = protocolHash("licomesh.state-event", {
          ...event,
          eventHash: undefined
        });
        if (event.offset !== index || event.prevEventHash !== previousHash || event.eventHash !== expectedHash) {
          return {
            ok: false,
            partitionId,
            eventCount: events.length,
            failedOffset: index
          };
        }
        previousHash = event.eventHash;
      }
      return { ok: true, partitionId, eventCount: events.length };
    }
  });

  async function loadStateRoot(scope) {
    if (!storage.inMemory) storage.clearCache?.();
    return text(await storage.getProtocolObject(STATE_ROOT_SCOPE, storageKey("state-root", scope), ""));
  }

  async function saveStateRoot(scope, root) {
    await storage.putProtocolObject(STATE_ROOT_SCOPE, storageKey("state-root", scope), text(root));
  }

  async function loadCommit(commitId) {
    if (!storage.inMemory) storage.clearCache?.();
    return storage.getProtocolObject(STATE_COMMIT_SCOPE, text(commitId), null);
  }

  async function saveCommit(commit) {
    await storage.putProtocolObject(STATE_COMMIT_SCOPE, commit.commitId, commit);
  }

  async function verifyRestoreLineage({ scope, targetRoot, allowedOperationIds = [], anchor = null, maxSuffixEvents = 256 }) {
    const events = await loadEvents(scope);
    const anchorOffset = Number(anchor?.offset);
    const anchoredEvent = Number.isInteger(anchorOffset) ? events[anchorOffset] : null;
    const anchorIndex = anchoredEvent?.eventHash === text(anchor?.eventHash) && anchoredEvent?.afterRoot === targetRoot
      ? anchorOffset
      : -1;
    const allowed = asArray(allowedOperationIds).map(text).filter(Boolean);
    const suffix = events.slice(anchorIndex + 1);
    const conflicting = suffix.find((event) => !allowed.some((operationId) =>
      event.operationId === operationId || event.operationId.startsWith(`${operationId}.`)
    ));
    if (anchorIndex < 0 || allowed.length === 0 || suffix.length > Math.max(1, Number(maxSuffixEvents) || 256) || conflicting) {
      const error = new Error("State root restore lineage contains an unrelated mutation.");
      error.code = "state_root_restore_lineage_conflict";
      error.status = 409;
      throw error;
    }
    return { ok: true, eventCount: suffix.length };
  }

  const stateCommit = Object.freeze({
    async begin({ scope = "default" } = {}) {
      return {
        scope: text(scope, "default"),
        currentRoot: await loadStateRoot(scope)
      };
    },
    async commit(input = {}) {
      return withTransactionalCoreMutation(runtime, "State commits", async () => {
      const scope = text(input.scope, "default");
      const beforeRoot = await loadStateRoot(scope);
      let afterRoot = beforeRoot;
      if (!afterRoot) {
        afterRoot = (await indexEngine.createIndex([], { domain: stateIndexDomain(scope) })).root;
      }
      const mutations = asArray(input.mutations);
      for (const mutation of mutations) {
        const action = text(mutation.action, "put");
        if (action === "delete") {
          afterRoot = (await merkleIndex.delete(afterRoot, mutation.key)).indexRootCid;
        } else {
          afterRoot = (await merkleIndex.put(afterRoot, mutation.key, mutation.valueRef || mutation.value, mutation.metadata || {})).indexRootCid;
        }
      }
      await saveStateRoot(scope, afterRoot);
      const event = await appendEventUnlocked({
        partitionId: scope,
        operationId: input.operationId || "licomesh.state.commit",
        beforeRoot,
        afterRoot,
        contentRefs: input.contentRefs || [],
        payload: input.payload || {}
      });
      const envelope = await core.recordOperation({
        operationId: input.operationId || "licomesh.state.commit",
        workspaceId: scope,
        idempotencyKey: text(input.idempotencyKey),
        input: asObject(input.payload),
        result: {
          beforeRoot,
          afterRoot,
          eventId: event.eventId
        },
        stateMutations: mutations.map((mutation) => ({
          action: text(mutation.action, "put"),
          key: normalizePathKey(mutation.key),
          valueRef: text(mutation.valueRef || mutation.value),
          valueHash: text(mutation.valueHash || hashValue(mutation.valueRef || mutation.value || "")),
          metadata: asObject(mutation.metadata)
        })).filter((mutation) => mutation.key)
      });
      const commitId = serverToken("state_commit", scope, event.eventHash, nowIso(), randomUUID());
      const commit = {
        protocol: PACTIUM_PROTOCOL,
        schema: PACTIUM_SCHEMA_VERSION,
        commitId,
        scope,
        operationId: text(input.operationId),
        beforeRoot,
        afterRoot,
        eventHash: event.eventHash,
        eventId: event.eventId,
        contentRefs: asArray(input.contentRefs).map(text).filter(Boolean),
        mutations: normalizeCanonical(mutations),
        payload: normalizeCanonical(asObject(input.payload)),
        pactium: {
          envelopeId: envelope.envelopeId,
          outcomeId: envelope.factId,
          ledgerEventId: envelope.factRef?.ledgerEventId || "",
          ledgerIndex: envelope.factRef?.ledgerIndex ?? -1
        },
        createdAt: nowIso()
      };
      await saveCommit(commit);
      return commit;
      });
    },
    async verifyRestoreLineage(input = {}) {
      const scope = text(input.scope, "default");
      const targetRoot = text(input.targetRoot || input.root);
      return verifyRestoreLineage({ scope, targetRoot, allowedOperationIds: input.allowedOperationIds, anchor: input.anchor, maxSuffixEvents: input.maxSuffixEvents });
    },
    async restoreRoot(input = {}) {
      return withTransactionalCoreMutation(runtime, "State root restores", async () => {
        const scope = text(input.scope, "default");
        const targetRoot = text(input.targetRoot || input.root);
        const beforeRoot = await loadStateRoot(scope);
        if (!targetRoot) throw new Error("State root restore requires a target root.");
        if (input.expectedCurrentRoot && text(input.expectedCurrentRoot) !== beforeRoot) {
          const error = new Error("State root changed before restore.");
          error.code = "state_root_restore_conflict";
          throw error;
        }
        await verifyRestoreLineage({ scope, targetRoot, allowedOperationIds: input.allowedOperationIds, anchor: input.anchor, maxSuffixEvents: input.maxSuffixEvents });
        await saveStateRoot(scope, targetRoot);
        const operationId = input.operationId || "licomesh.state.root.restore";
        const event = await appendEventUnlocked({
          partitionId: scope,
          operationId,
          beforeRoot,
          afterRoot: targetRoot,
          contentRefs: input.contentRefs || [],
          payload: { ...asObject(input.payload), restoredRoot: targetRoot }
        });
        const envelope = await core.recordOperation({
          operationId,
          workspaceId: scope,
          idempotencyKey: text(input.idempotencyKey),
          input: asObject(input.payload),
          result: { beforeRoot, afterRoot: targetRoot, eventId: event.eventId },
          stateMutations: []
        });
        const commitId = serverToken("state_commit", scope, event.eventHash, nowIso(), randomUUID());
        const commit = {
          protocol: PACTIUM_PROTOCOL,
          schema: PACTIUM_SCHEMA_VERSION,
          commitId,
          scope,
          operationId: text(operationId),
          beforeRoot,
          afterRoot: targetRoot,
          eventHash: event.eventHash,
          eventId: event.eventId,
          contentRefs: asArray(input.contentRefs).map(text).filter(Boolean),
          mutations: [],
          payload: normalizeCanonical(asObject(input.payload)),
          pactium: {
            envelopeId: envelope.envelopeId,
            outcomeId: envelope.factId,
            ledgerEventId: envelope.factRef?.ledgerEventId || "",
            ledgerIndex: envelope.factRef?.ledgerIndex ?? -1
          },
          createdAt: nowIso()
        };
        await saveCommit(commit);
        return commit;
      });
    },
    async verifyCommit(commitId) {
      const commit = await loadCommit(text(commitId));
      if (!commit) {
        return {
          ok: false,
          error: "commit_missing",
          commitId: text(commitId)
        };
      }
      try {
        await indexEngine.readIndexRoot(commit.afterRoot);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "state_root_missing",
          commit
        };
      }
      return {
        ok: true,
        commit
      };
    }
  });

  async function loadSessions() {
    if (!storage.inMemory) storage.clearCache?.();
    return asObject(await storage.getProtocolObject(LSM_SESSION_SCOPE, "sessions", {}));
  }

  async function saveSessions(sessions) {
    await storage.putProtocolObject(LSM_SESSION_SCOPE, "sessions", sessions);
  }

  const lsmIngest = Object.freeze({
    async beginUploadSession(input = {}) {
      return withSerializedStorageMutation(storage, "licomesh-lsm-sessions", async () => {
      const sessions = await loadSessions();
      const uploadSessionId = serverToken("upload_session", input.scope || "default", nowIso(), randomUUID());
      const session = {
        uploadSessionId,
        scope: text(input.scope, "default"),
        files: normalizeCanonical(asArray(input.files)),
        records: [],
        segments: [],
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      sessions[uploadSessionId] = session;
      await saveSessions(sessions);
      return session;
      });
    },
    async recoverSession(uploadSessionId) {
      const session = (await loadSessions())[text(uploadSessionId)];
      if (!session) return null;
      const records = sortedChunkRecords(asArray(session.records));
      const nextOffset = records.reduce((max, record) => Math.max(max, Number(record.offset || 0) + Number(record.byteLength || 0)), 0);
      return {
        ...session,
        records,
        recordCount: records.length,
        nextOffset
      };
    },
    async appendChunkRecord(uploadSessionId, record = {}) {
      return withSerializedStorageMutation(storage, "licomesh-lsm-sessions", async () => {
      const sessions = await loadSessions();
      const session = sessions[text(uploadSessionId)];
      if (!session) throw new Error("upload session missing");
      const chunkCid = text(record.chunkCid || record.cid);
      if (!chunkCid || !(await storage.hasBlock(chunkCid))) {
        throw new Error("chunkCid must reference an existing CAS block");
      }
      const normalized = {
        fileId: text(record.fileId || record.relativePath),
        relativePath: normalizePathKey(record.relativePath || record.fileId),
        chunkIndex: Number(record.chunkIndex || 0),
        offset: Number(record.offset || 0),
        byteLength: Number(record.byteLength || 0),
        chunkCid,
        chunkHash: text(record.chunkHash),
        metadata: normalizeCanonical(asObject(record.metadata)),
        recordedAt: nowIso()
      };
      session.records.push(normalized);
      session.updatedAt = nowIso();
      await saveSessions(sessions);
      return normalized;
      });
    },
    async flushMemTable(uploadSessionId) {
      return withSerializedStorageMutation(storage, "licomesh-lsm-sessions", async () => {
      const sessions = await loadSessions();
      const session = sessions[text(uploadSessionId)];
      if (!session) throw new Error("upload session missing");
      const records = sortedChunkRecords(asArray(session.records));
      const segment = {
        segmentId: serverToken("lsm_segment", uploadSessionId, records.length, nowIso(), randomUUID()),
        scope: session.scope,
        level: 0,
        recordCount: records.length,
        records,
        createdAt: nowIso()
      };
      const block = await putBlock(segment, {
        refs: records.map((record) => record.chunkCid),
        kind: "licomesh.lsm-segment"
      });
      segment.rootCid = block.cid;
      session.segments.push(segment);
      session.updatedAt = nowIso();
      await saveSessions(sessions);
      return segment;
      });
    },
    async materializeManifest(uploadSessionId) {
      const session = (await loadSessions())[text(uploadSessionId)];
      if (!session) throw new Error("upload session missing");
      const records = sortedChunkRecords(asArray(session.records));
      return merkleDag.buildManifest("lsm-upload-session", records.map((record) => ({
        key: `${normalizePathKey(record.relativePath || record.fileId)}#${String(Number(record.chunkIndex || 0)).padStart(12, "0")}`,
        path: `${normalizePathKey(record.relativePath || record.fileId)}#${String(Number(record.chunkIndex || 0)).padStart(12, "0")}`,
        cid: record.chunkCid,
        byteLength: record.byteLength,
        metadata: { offset: record.offset, chunkHash: record.chunkHash }
      })), {
        uploadSessionId,
        scope: session.scope
      });
    },
    async compactSegments(scope = "default") {
      const normalizedScope = text(scope, "default");
      const sessions = Object.values(await loadSessions()).filter((session) => session.scope === normalizedScope);
      const segments = sessions.flatMap((session) => asArray(session.segments));
      const records = segments.flatMap((segment) => asArray(segment.records));
      if (segments.length === 0) {
        return {
          scope: normalizedScope,
          recordCount: 0,
          sourceSegmentIds: []
        };
      }
      const compacted = {
        scope: normalizedScope,
        recordCount: records.length,
        sourceSegmentIds: segments.map((segment) => segment.segmentId),
        level: 1,
        records: sortedChunkRecords(records),
        createdAt: nowIso()
      };
      const block = await putBlock(compacted, {
        refs: segments.map((segment) => segment.rootCid).filter(Boolean),
        kind: "licomesh.lsm-compacted-segment"
      });
      return {
        ...compacted,
        rootCid: block.cid
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
      encode(value, codec = "pactium-canonical") {
        return codec === "raw" ? Buffer.from(value || "") : canonicalEncode(value);
      },
      decode(value, codec = "pactium-canonical") {
        return codec === "raw" ? Buffer.from(value) : canonicalDecode(value);
      },
      cid(value) {
        return cidForCanonical(value);
      }
    }),
    cas,
    merkleDag,
    merkleIndex,
    eventLog,
    stateCommit,
    lsmIngest,
    close() {
      return ownsPactiumRuntime
        ? (runtime.close?.() || Promise.resolve())
        : Promise.resolve();
    },
    listCapabilities() {
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
          "lsm-ingest"
        ]
      };
    }
  });
}
