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
  normalizeCanonicalValue
} from "pactium";
import { serverToken } from "#meshrix/client-strings";
import { queueStateMutation } from "../../storage/state-coordinator.ts";
import {
  normalizeMeshrixPactiumRuntime,
  resolveMeshrixPactiumDataDir
} from "./pactium-substrate-preflight.ts";
import { toPactiumCanonicalSafeValue } from "./pactium-canonical-safe.ts";

export const MERKLE_STATE_SUBSTRATE_PROTOCOL: any = PACTIUM_PROTOCOL;
export const MERKLE_STATE_SUBSTRATE_PROVIDER: any = "pactium.verifiable-state-substrate";

const STATE_ROOT_SCOPE: any = "meshrix-state-root";
const STATE_COMMIT_SCOPE: any = "meshrix-state-commit";
const STATE_COMMIT_EVENT_INDEX_SCOPE: any =
  "meshrix-state-commit-event-index";
const STATE_MUTATION_IDEMPOTENCY_SCOPE: any =
  "meshrix-state-mutation-idempotency";
const EVENT_LOG_SCOPE: any = "meshrix-event-log";
const LSM_SESSION_SCOPE: any = "meshrix-lsm-session";

function substrateMutationError(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  return error;
}

async function selectedStorageBackend(storage?: any) : Promise<any> {
  await storage.initialize?.();
  return text(storage.selectedStorageBackend || storage.storageBackend || "").toLowerCase();
}

async function assertTransactionalStorage(storage?: any, capability?: any) : Promise<any> {
  if (storage.inMemory) return;
  const backend: any = await selectedStorageBackend(storage);
  if (backend !== "sqlite") {
    throw substrateMutationError(
      "pactium_transactional_storage_required",
      `${capability} requires Pactium SQLite transactional storage.`
    );
  }
}

async function withSerializedStorageMutation(storage?: any, name?: any, task?: any) : Promise<any> {
  return queueStateMutation(`pactium-storage:${storage.dataDir}`, async () : Promise<any> => {
    if (storage.inMemory || typeof storage.withWriteLock !== "function") return task();
    return storage.withWriteLock(async () : Promise<any> => {
      storage.clearCache?.();
      return task();
    }, { name, timeoutMs: 30_000 });
  });
}

async function withTransactionalCoreMutation(runtime?: any, capability?: any, task?: any) : Promise<any> {
  const { core, storage } = runtime;
  return queueStateMutation(`pactium-storage:${runtime.dataDir}`, async () : Promise<any> => {
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

function nowIso() : any {
  return new Date().toISOString();
}

function asObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

function text(value?: any, fallback: any = "") : any {
  const normalized: any = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizePathKey(value?: any) : any {
  return text(value)
    .replace(/\\/gu, "/")
    .replace(/\/+/gu, "/")
    .replace(/^\/+|\/+$/gu, "");
}

function normalizeCanonical(value?: any) : any {
  return normalizeCanonicalValue(toPactiumCanonicalSafeValue(value, {
    maxDepth: 256,
    maxArrayItems: 100000,
    maxObjectKeys: 100000,
    maxStringLength: 1000000,
    binaryMode: "preserve"
  }));
}

function hashValue(value?: any) : any {
  return protocolHash("meshrix.value", value);
}

function storageKey(kind?: any, value?: any) : any {
  return protocolHashHex(`meshrix.${kind}`, text(value, "default"));
}

function stateIndexDomain(scope?: any) : any {
  return `meshrix-state-${storageKey("state-scope", scope)}`;
}

function normalizeIndexEntry(entry: Record<string, any> = {}) : any {
  const valueRef: any = text(entry.valueRef || entry.cid || entry.value || "");
  return {
    key: normalizePathKey(entry.key || entry.path),
    valueRef,
    valueHash: text(entry.valueHash || (valueRef ? hashValue({ valueRef }) : "")),
    metadata: normalizeCanonical(asObject(entry.metadata))
  };
}

function sortEntries(entries?: any) : any {
  return [...entries].sort((left?: any, right?: any) : any => left.key.localeCompare(right.key));
}

function proofExists(proof?: any) : any {
  return proof?.proofType === PACTIUM_PROOF_TYPES.indexMembership;
}

function sortedChunkRecords(records?: any) : any {
  return sortEntries(records.map((record?: any) : any => ({
    ...record,
    key: `${normalizePathKey(record.relativePath || record.fileId)}#${String(Number(record.chunkIndex || 0)).padStart(12, "0")}`
  }))).map(({ key: _key, ...record }: Record<string, any>) : any => record);
}

export function createPactiumStateSubstrate({ userDataPath = "", dataDir = "", pactiumRuntime = null }: Record<string, any> = {}) : any {
  const resolvedDataDir: any = resolveMeshrixPactiumDataDir(userDataPath || dataDir);
  const ownsPactiumRuntime: any = !pactiumRuntime;
  const runtime: any = normalizeMeshrixPactiumRuntime({
    dataDir: resolvedDataDir,
    pactiumRuntime
  });
  const core: any = runtime.core;
  const storage: any = runtime.storage;
  const indexEngine: any = runtime.indexEngine;
  const pins: any = new Map<any, any>();

  const contentAddressedStore: any = createContentAddressedStore({
    storage,
    defaultKind: "meshrix.cas-block"
  });

  const cas: Readonly<Record<string, any>> = Object.freeze({
    putBlock: contentAddressedStore.putBlock,
    getBlock: contentAddressedStore.getBlock,
    hasBlock: contentAddressedStore.hasBlock,
    walk: contentAddressedStore.walk,
    listMissing: contentAddressedStore.listMissing,
    verify: contentAddressedStore.verify,
    async pin(rootCid?: any, policy: Record<string, any> = {}) : Promise<any> {
      const normalizedPolicy: any = normalizeCanonical(asObject(policy));
      pins.set(rootCid, normalizedPolicy);
      await storage.putProtocolObject("meshrix-cas-pin", storageKey("cas-pin", rootCid), {
        rootCid,
        policy: normalizedPolicy,
        pinnedAt: nowIso()
      });
      return { rootCid, policy: normalizedPolicy, pinnedAt: nowIso() };
    },
    async gc() : Promise<any> {
      return {
        collected: 0,
        retainedRoots: [...pins.keys()],
        policy: "pactium-managed-retention"
      };
    }
  });

  const merkleDag: Readonly<Record<string, any>> = Object.freeze({
    async buildManifest(type?: any, refs: any = [], metadata: Record<string, any> = {}) : Promise<any> {
      const entries: any = sortEntries(asArray(refs)
        .map((entry?: any) : any => ({
          key: normalizePathKey(entry.key || entry.path || entry.relativePath),
          path: normalizePathKey(entry.path || entry.relativePath || entry.key),
          cid: text(entry.cid || entry.valueRef),
          valueRef: text(entry.valueRef || entry.cid),
          byteLength: Number(entry.byteLength || 0),
          metadata: normalizeCanonical(asObject(entry.metadata))
        }))
        .filter((entry?: any) : any => entry.key && entry.valueRef));
      const manifest: Record<string, any> = {
        protocol: PACTIUM_PROTOCOL,
        schema: PACTIUM_SCHEMA_VERSION,
        manifestType: "meshrix.merkle-dag.manifest",
        type: text(type, "manifest"),
        entries,
        refs: entries.map((entry?: any) : any => entry.valueRef),
        metadata: normalizeCanonical(asObject(metadata)),
        createdAt: nowIso()
      };
      const block: any = await cas.putBlock(manifest, {
        refs: manifest.refs,
        kind: "meshrix.merkle-dag.manifest"
      });
      return {
        ...manifest,
        rootCid: block.cid,
        manifestCid: block.cid
      };
    },
    async verify(rootCid?: any) : Promise<any> {
      const result: any = await cas.walk(rootCid);
      return {
        ok: result.missing.length === 0,
        rootCid,
        blockCount: result.blockCount,
        missing: result.missing
      };
    },
    async diff(_leftRootCid?: any, rightRootCid?: any) : Promise<any> {
      const right: any = await cas.walk(rightRootCid);
      return {
        missing: right.missing,
        rightBlockCount: right.blockCount
      };
    }
  });

  const merkleIndex: Readonly<Record<string, any>> = Object.freeze({
    async create(domain?: any, entries: any = []) : Promise<any> {
      const index: any = await indexEngine.createIndex(
        sortEntries(asArray(entries).map(normalizeIndexEntry).filter((entry?: any) : any => entry.key)),
        { domain: text(domain, "index") }
      );
      return {
        indexRootCid: index.root,
        root: index.root,
        domain: index.domain,
        count: index.count
      };
    },
    async put(indexRootCid?: any, key?: any, valueRef?: any, metadata: Record<string, any> = {}) : Promise<any> {
      const normalizedKey: any = normalizePathKey(key);
      const entry: any = normalizeIndexEntry({
        key: normalizedKey,
        valueRef,
        valueHash: hashValue({ valueRef }),
        metadata
      });
      const next: any = await indexEngine.put(indexRootCid, normalizedKey, entry, { domain: "meshrix-state" });
      return {
        indexRootCid: next.root,
        root: next.root,
        entry,
        count: next.count
      };
    },
    async delete(indexRootCid?: any, key?: any) : Promise<any> {
      const next: any = await indexEngine.delete(indexRootCid, normalizePathKey(key), { domain: "meshrix-state" });
      return {
        indexRootCid: next.root,
        root: next.root,
        count: next.count
      };
    },
    get(indexRootCid?: any, key?: any) : any {
      return indexEngine.get(indexRootCid, normalizePathKey(key));
    },
    scan(indexRootCid?: any, { min = "", max = "\uffff", limit = 5000, after = "" }: Record<string, any> = {}) : any {
      return indexEngine.scan(indexRootCid, { min, max, limit, after });
    },
    prefix(indexRootCid?: any, keyPrefix: any = "", options: Record<string, any> = {}) : any {
      return indexEngine.prefix(indexRootCid, normalizePathKey(keyPrefix), options);
    },
    diff(leftRootCid?: any, rightRootCid?: any) : any {
      return indexEngine.diff(leftRootCid, rightRootCid);
    },
    async prove(indexRootCid?: any, key?: any) : Promise<any> {
      const normalizedKey: any = normalizePathKey(key);
      const proof: any = await indexEngine.prove(indexRootCid, normalizedKey);
      const entry: any = proof.entry || null;
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
  const protocolEventLog: any = createAppendOnlyEventLog({
    storage,
    protocolObjectScope: EVENT_LOG_SCOPE,
    hashDomain: "meshrix.state-event",
    createEventId: ({ partitionId, operationId }: Record<string, any> = {}) : any =>
      serverToken("state_event", partitionId, operationId || "", nowIso(), randomUUID()),
    withWriteLock: (task?: any) : any => task()
  });

  async function appendEventUnlocked(input: Record<string, any> = {}) : Promise<any> {
    // Meshrix-normalize before Pactium so event payloads / eventHash match
    // commit records that already use normalizeCanonical(asObject(...)).
    return protocolEventLog.appendEvent({
      ...input,
      payload: normalizeCanonical(asObject(input.payload))
    });
  }

  const eventLog: Readonly<Record<string, any>> = Object.freeze({
    appendEvent(input: Record<string, any> = {}) : any {
      const partitionId: any = text(input.partitionId || input.scope, "default");
      return withSerializedStorageMutation(
        storage,
        `meshrix-event-log-${storageKey("event-partition", partitionId)}`,
        () : any => appendEventUnlocked(input)
      );
    },
    listEvents: protocolEventLog.listEvents,
    getEvent: protocolEventLog.getEvent,
    verifyPartition: protocolEventLog.verifyPartition
  });

  async function loadStateRoot(scope?: any) : Promise<any> {
    if (!storage.inMemory) storage.clearCache?.();
    return text(await storage.getProtocolObject(STATE_ROOT_SCOPE, storageKey("state-root", scope), ""));
  }

  async function saveStateRoot(scope?: any, root?: any) : Promise<any> {
    await storage.putProtocolObject(STATE_ROOT_SCOPE, storageKey("state-root", scope), text(root));
  }

  async function loadCommit(commitId?: any) : Promise<any> {
    if (!storage.inMemory) storage.clearCache?.();
    return storage.getProtocolObject(STATE_COMMIT_SCOPE, text(commitId), null);
  }

  async function saveCommit(commit?: any) : Promise<any> {
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
  }: Record<string, any>) : any {
    return storageKey("state-mutation-idempotency", canonicalJson({
      kind: text(kind),
      scope: text(scope, "default"),
      operationId: text(operationId),
      idempotencyKey: text(idempotencyKey)
    }));
  }

  function stateMutationInputDigest(kind?: any, input: Record<string, any> = {}) : any {
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
              .map(text)
              .filter(Boolean),
            maxSuffixEvents: Number(input.maxSuffixEvents || 256)
          }
        : {
            mutations: asArray(input.mutations),
            contentRefs: asArray(input.contentRefs)
          }),
      payload: asObject(input.payload)
    }));
  }

  async function replayStateMutationIfPresent(kind?: any, input: Record<string, any> = {}) : Promise<any> {
    const idempotencyKey: any = text(input.idempotencyKey);
    if (!idempotencyKey) return null;
    const scope: any = text(input.scope, "default");
    const operationId: any = text(input.operationId);
    const claimKey: any = stateMutationIdempotencyKey({
      kind,
      scope,
      operationId,
      idempotencyKey
    });
    const inputDigest: any = stateMutationInputDigest(kind, input);
    const existing: any = await storage.getProtocolObject(
      STATE_MUTATION_IDEMPOTENCY_SCOPE,
      claimKey,
      null
    );
    if (!existing) {
      return { claimKey, inputDigest, replay: null };
    }
    if (text(existing.inputDigest) !== inputDigest) {
      throw substrateMutationError(
        "state_mutation_idempotency_conflict",
        "State mutation idempotency key was reused with different input."
      );
    }
    const commit: any = await loadCommit(text(existing.commitId));
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
  }: Record<string, any>) : Promise<any> {
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

  async function verifyRestoreLineage({ scope, targetRoot, allowedOperationIds = [], anchor = null, maxSuffixEvents = 256 }: Record<string, any>) : Promise<any> {
    const events: any = [...await eventLog.listEvents(scope, { limit: 10000 })].reverse();
    const anchorOffset: any = Number(anchor?.offset);
    const anchoredEvent: any = Number.isInteger(anchorOffset) ? events[anchorOffset] : null;
    const anchorIndex: any = anchoredEvent?.eventHash === text(anchor?.eventHash) && anchoredEvent?.afterRoot === targetRoot
      ? anchorOffset
      : -1;
    const allowed: any = asArray(allowedOperationIds).map(text).filter(Boolean);
    const suffix: any = events.slice(anchorIndex + 1);
    const conflicting: any = suffix.find(
      (event?: any) : any => !allowed.includes(text(event.operationId))
    );
    if (anchorIndex < 0 || allowed.length === 0 || suffix.length > Math.max(1, Number(maxSuffixEvents) || 256) || conflicting) {
      const error: Error & Record<string, any> = new Error("State root restore lineage contains an unrelated mutation.");
      error.code = "state_root_restore_lineage_conflict";
      error.status = 409;
      throw error;
    }
    return { ok: true, eventCount: suffix.length };
  }

  const stateCommit: Readonly<Record<string, any>> = Object.freeze({
    async begin({ scope = "default" }: Record<string, any> = {}) : Promise<any> {
      return {
        scope: text(scope, "default"),
        currentRoot: await loadStateRoot(scope)
      };
    },
    async commit(input: Record<string, any> = {}) : Promise<any> {
      return withTransactionalCoreMutation(runtime, "State commits", async () : Promise<any> => {
      const scope: any = text(input.scope, "default");
      const idempotency: any = await replayStateMutationIfPresent(
        "commit",
        { ...input, scope }
      );
      if (idempotency?.replay) return idempotency.replay;
      const beforeRoot: any = await loadStateRoot(scope);
      if (Object.hasOwn(input, "expectedCurrentRoot") && text(input.expectedCurrentRoot) !== beforeRoot) {
        const error: any = substrateMutationError(
          "state_root_commit_conflict",
          "State root changed before commit."
        );
        error.status = 409;
        throw error;
      }
      let afterRoot: any = beforeRoot;
      if (!afterRoot) {
        afterRoot = (await indexEngine.createIndex([], { domain: stateIndexDomain(scope) })).root;
      }
      const mutations: any = asArray(input.mutations);
      for (const mutation of mutations) {
        const action: any = text(mutation.action, "put");
        if (action === "delete") {
          afterRoot = (await merkleIndex.delete(afterRoot, mutation.key)).indexRootCid;
        } else {
          afterRoot = (await merkleIndex.put(afterRoot, mutation.key, mutation.valueRef || mutation.value, mutation.metadata || {})).indexRootCid;
        }
      }
      const envelope: any = await core.recordOperation({
        operationId: input.operationId || "meshrix.state.commit",
        workspaceId: scope,
        idempotencyKey: text(input.idempotencyKey),
        returnIntentReplay: true,
        input: asObject(input.payload),
        result: {
          beforeRoot,
          afterRoot
        },
        stateMutations: mutations.map((mutation?: any) : any => ({
          action: text(mutation.action, "put"),
          key: normalizePathKey(mutation.key),
          valueRef: text(mutation.valueRef || mutation.value),
          valueHash: text(mutation.valueHash || hashValue(mutation.valueRef || mutation.value || "")),
          metadata: asObject(mutation.metadata)
        })).filter((mutation?: any) : any => mutation.key)
      });
      if (envelope?.replayed) {
        throw substrateMutationError(
          "state_mutation_idempotency_incomplete",
          "State evidence replay exists without a matching state mutation claim."
        );
      }
      await saveStateRoot(scope, afterRoot);
      const event: any = await appendEventUnlocked({
        partitionId: scope,
        operationId: input.operationId || "meshrix.state.commit",
        beforeRoot,
        afterRoot,
        contentRefs: input.contentRefs || [],
        payload: input.payload || {}
      });
      const commitId: any = serverToken("state_commit", scope, event.eventHash, nowIso(), randomUUID());
      const commit: Record<string, any> = {
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
      await saveStateMutationClaim({
        claimKey: idempotency?.claimKey,
        inputDigest: idempotency?.inputDigest,
        commit
      });
      return commit;
      });
    },
    async verifyRestoreLineage(input: Record<string, any> = {}) : Promise<any> {
      const scope: any = text(input.scope, "default");
      const targetRoot: any = text(input.targetRoot || input.root);
      return verifyRestoreLineage({ scope, targetRoot, allowedOperationIds: input.allowedOperationIds, anchor: input.anchor, maxSuffixEvents: input.maxSuffixEvents });
    },
    async restoreRoot(input: Record<string, any> = {}) : Promise<any> {
      return withTransactionalCoreMutation(runtime, "State root restores", async () : Promise<any> => {
        const scope: any = text(input.scope, "default");
        const idempotency: any = await replayStateMutationIfPresent(
          "restore",
          { ...input, scope }
        );
        if (idempotency?.replay) return idempotency.replay;
        const targetRoot: any = text(input.targetRoot || input.root);
        const beforeRoot: any = await loadStateRoot(scope);
        if (!targetRoot) throw new Error("State root restore requires a target root.");
        if (
          Object.hasOwn(input, "expectedCurrentRoot") &&
          text(input.expectedCurrentRoot) !== beforeRoot
        ) {
          const error: Error & Record<string, any> = new Error("State root changed before restore.");
          error.code = "state_root_restore_conflict";
          throw error;
        }
        await verifyRestoreLineage({ scope, targetRoot, allowedOperationIds: input.allowedOperationIds, anchor: input.anchor, maxSuffixEvents: input.maxSuffixEvents });
        const operationId: any = input.operationId || "meshrix.state.root.restore";
        const envelope: any = await core.recordOperation({
          operationId,
          workspaceId: scope,
          idempotencyKey: text(input.idempotencyKey),
          returnIntentReplay: true,
          input: asObject(input.payload),
          result: { beforeRoot, afterRoot: targetRoot },
          stateMutations: []
        });
        if (envelope?.replayed) {
          throw substrateMutationError(
            "state_mutation_idempotency_incomplete",
            "State evidence replay exists without a matching state mutation claim."
          );
        }
        await saveStateRoot(scope, targetRoot);
        const event: any = await appendEventUnlocked({
          partitionId: scope,
          operationId,
          beforeRoot,
          afterRoot: targetRoot,
          contentRefs: input.contentRefs || [],
          payload: { ...asObject(input.payload), restoredRoot: targetRoot }
        });
        const commitId: any = serverToken("state_commit", scope, event.eventHash, nowIso(), randomUUID());
        const commit: Record<string, any> = {
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
        await saveStateMutationClaim({
          claimKey: idempotency?.claimKey,
          inputDigest: idempotency?.inputDigest,
          commit
        });
        return commit;
      });
    },
    async verifyCommit(commitId?: any) : Promise<any> {
      const commit: any = await loadCommit(text(commitId));
      if (!commit) {
        return {
          ok: false,
          error: "commit_missing",
          commitId: text(commitId)
        };
      }
      try {
        await indexEngine.readIndexRoot(commit.afterRoot);
      } catch (error: any) {
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
    },
    async getCommitByEventHash({
      scope = "default",
      eventHash = ""
    }: Record<string, any> = {}) : Promise<any> {
      const normalizedScope: any = text(scope, "default");
      const normalizedEventHash: any = text(eventHash);
      if (!normalizedEventHash) return null;
      const indexed: any = await storage.getProtocolObject(
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
        !indexed ||
        indexed.scope !== normalizedScope ||
        indexed.eventHash !== normalizedEventHash
      ) {
        return null;
      }
      const commit: any = await loadCommit(text(indexed.commitId));
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

  async function loadSessions() : Promise<any> {
    if (!storage.inMemory) storage.clearCache?.();
    return asObject(await storage.getProtocolObject(LSM_SESSION_SCOPE, "sessions", {}));
  }

  async function saveSessions(sessions?: any) : Promise<any> {
    await storage.putProtocolObject(LSM_SESSION_SCOPE, "sessions", sessions);
  }

  const lsmIngest: Readonly<Record<string, any>> = Object.freeze({
    async beginUploadSession(input: Record<string, any> = {}) : Promise<any> {
      return withSerializedStorageMutation(storage, "meshrix-lsm-sessions", async () : Promise<any> => {
      const sessions: any = await loadSessions();
      const uploadSessionId: any = serverToken("upload_session", input.scope || "default", nowIso(), randomUUID());
      const session: Record<string, any> = {
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
    async recoverSession(uploadSessionId?: any) : Promise<any> {
      const session: any = (await loadSessions())[text(uploadSessionId)];
      if (!session) return null;
      const records: any = sortedChunkRecords(asArray(session.records));
      const nextOffset: any = records.reduce((max?: any, record?: any) : any => Math.max(max, Number(record.offset || 0) + Number(record.byteLength || 0)), 0);
      return {
        ...session,
        records,
        recordCount: records.length,
        nextOffset
      };
    },
    async appendChunkRecord(uploadSessionId?: any, record: Record<string, any> = {}) : Promise<any> {
      return withSerializedStorageMutation(storage, "meshrix-lsm-sessions", async () : Promise<any> => {
      const sessions: any = await loadSessions();
      const session: any = sessions[text(uploadSessionId)];
      if (!session) throw new Error("upload session missing");
      const chunkCid: any = text(record.chunkCid || record.cid);
      if (!chunkCid || !(await storage.hasBlock(chunkCid))) {
        throw new Error("chunkCid must reference an existing CAS block");
      }
      const normalized: Record<string, any> = {
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
    async flushMemTable(uploadSessionId?: any) : Promise<any> {
      return withSerializedStorageMutation(storage, "meshrix-lsm-sessions", async () : Promise<any> => {
      const sessions: any = await loadSessions();
      const session: any = sessions[text(uploadSessionId)];
      if (!session) throw new Error("upload session missing");
      const records: any = sortedChunkRecords(asArray(session.records));
      const segment: Record<string, any> = {
        segmentId: serverToken("lsm_segment", uploadSessionId, records.length, nowIso(), randomUUID()),
        scope: session.scope,
        level: 0,
        recordCount: records.length,
        records,
        createdAt: nowIso()
      };
      const block: any = await cas.putBlock(segment, {
        refs: records.map((record?: any) : any => record.chunkCid),
        kind: "meshrix.lsm-segment"
      });
      segment.rootCid = block.cid;
      session.segments.push(segment);
      session.updatedAt = nowIso();
      await saveSessions(sessions);
      return segment;
      });
    },
    async materializeManifest(uploadSessionId?: any) : Promise<any> {
      const session: any = (await loadSessions())[text(uploadSessionId)];
      if (!session) throw new Error("upload session missing");
      const records: any = sortedChunkRecords(asArray(session.records));
      return merkleDag.buildManifest("lsm-upload-session", records.map((record?: any) : any => ({
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
    async compactSegments(scope: any = "default") : Promise<any> {
      const normalizedScope: any = text(scope, "default");
      const sessions: any = (Object.values(await loadSessions()) as any[]).filter((session?: any) : any => session.scope === normalizedScope);
      const segments: any = sessions.flatMap((session?: any) : any => asArray(session.segments));
      const records: any = segments.flatMap((segment?: any) : any => asArray(segment.records));
      if (segments.length === 0) {
        return {
          scope: normalizedScope,
          recordCount: 0,
          sourceSegmentIds: []
        };
      }
      const compacted: Record<string, any> = {
        scope: normalizedScope,
        recordCount: records.length,
        sourceSegmentIds: segments.map((segment?: any) : any => segment.segmentId),
        level: 1,
        records: sortedChunkRecords(records),
        createdAt: nowIso()
      };
      const block: any = await cas.putBlock(compacted, {
        refs: segments.map((segment?: any) : any => segment.rootCid).filter(Boolean),
        kind: "meshrix.lsm-compacted-segment"
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
      encode(value?: any, codec: any = "pactium-canonical") : any {
        return codec === "raw" ? Buffer.from(value || "") : canonicalEncode(value);
      },
      decode(value?: any, codec: any = "pactium-canonical") : any {
        return codec === "raw" ? Buffer.from(value) : canonicalDecode(value);
      },
      cid(value?: any) : any {
        return cidForCanonical(value);
      }
    }),
    cas,
    merkleDag,
    merkleIndex,
    eventLog,
    stateCommit,
    lsmIngest,
    close() : any {
      return ownsPactiumRuntime
        ? (runtime.close?.() || Promise.resolve())
        : Promise.resolve();
    },
    listCapabilities() : any {
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
