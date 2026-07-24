import {
  canonicalizeTypedReferenceManifest,
  createDurableManifestWriterPort,
  createManifestSnapshotReaderPort,
  normalizeManifestResourceBudget,
  serviceManifestError,
  validateManifestDigest,
  validateManifestRevision,
  validateOpaqueServiceId
} from "./storage-ports.mjs";
import {
  createManifestTransactionContext,
  createServiceManifestTransaction
} from "./service-manifest-transaction.mjs";
import { runStorageMaintenanceMutation } from "./storage-maintenance-coordinator.mjs";

const EMPTY_TRIE = Object.freeze({ value: null, children: new Map() });

function trieLookup(root, key) {
  let node = root;
  for (const character of key) {
    node = node.children.get(character);
    if (!node) return null;
  }
  return node.value;
}

function trieSet(node, key, index, value) {
  const current = node || EMPTY_TRIE;
  if (index === key.length) {
    return Object.freeze({ value, children: current.children });
  }
  const character = key[index];
  const child = trieSet(
    current.children.get(character),
    key,
    index + 1,
    value
  );
  const children = new Map(current.children);
  children.set(character, child);
  return Object.freeze({ value: current.value, children });
}

function collectTrieValues(node, output) {
  if (node.value) output.push(node.value);
  const children = [...node.children.entries()].sort(
    ([left], [right]) => left.localeCompare(right)
  );
  for (const [, child] of children) collectTrieValues(child, output);
}

function freezeServiceRecord({
  serviceId,
  serviceRevision,
  manifestDigest,
  manifest
}) {
  return Object.freeze({
    serviceId,
    serviceRevision,
    manifestDigest,
    manifest
  });
}

function cacheIdentity(pointer) {
  return `${pointer.setRevision}:${pointer.setDigest}`;
}

function createSnapshot({ root, pointer }) {
  const capturedRoot = root;
  let listed = null;
  return Object.freeze({
    setRevision: pointer.setRevision,
    setDigest: pointer.setDigest,
    get serviceCount() {
      if (!listed) {
        const output = [];
        collectTrieValues(capturedRoot, output);
        listed = Object.freeze(output);
      }
      return listed.length;
    },
    getService(serviceId) {
      validateOpaqueServiceId(serviceId);
      return trieLookup(capturedRoot, serviceId);
    },
    hasService(serviceId) {
      validateOpaqueServiceId(serviceId);
      return trieLookup(capturedRoot, serviceId) !== null;
    },
    listServices() {
      if (!listed) {
        const output = [];
        collectTrieValues(capturedRoot, output);
        listed = Object.freeze(output);
      }
      return listed;
    }
  });
}

function publicOutcome(outcome, replayed) {
  return Object.freeze({
    serviceRevision: outcome.serviceRevision,
    setRevision: outcome.setRevision,
    manifestDigest: outcome.manifestDigest,
    setDigest: outcome.setDigest,
    replayed,
    receiptRef: outcome.receiptRef
  });
}

function assertSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw serviceManifestError(
      "storage_manifest_signal_invalid",
      "Service manifest signal must be an AbortSignal."
    );
  }
}

export function createServiceManifestStore({ storageRoot, now = Date.now }) {
  const transaction = createServiceManifestTransaction({ storageRoot, now });
  let candidateCache = null;
  let publishedCache = null;

  async function runSerialized({ signal, budget, startedAt }, task) {
    assertSignal(signal);
    if (signal?.aborted) {
      const context = createManifestTransactionContext({
        budget,
        signal,
        startedAt
      });
      context.check();
    }
    return runStorageMaintenanceMutation(
      transaction.rootPath,
      async ({ signal: laneSignal }) => {
        const context = createManifestTransactionContext({
          budget,
          signal,
          laneSignal,
          startedAt
        });
        context.check();
        return task(context);
      },
      {
        signal,
        kind: "storage.service-manifest.commit",
        budget: {
          maxFiles: budget.maxFiles,
          maxBytes: budget.maxReadBytes + budget.maxWriteBytes,
          maxCleanupItems: budget.maxCleanupEntries,
          maxDurationMs: budget.maxOperationMs
        }
      }
    );
  }

  function hydrateSnapshot(state, budget) {
    let root = EMPTY_TRIE;
    for (const entry of state.entries) {
      let parsed;
      try {
        parsed = JSON.parse(entry.manifestBytes.toString("utf8"));
      } catch (error) {
        throw serviceManifestError(
          "storage_manifest_content_invalid",
          "Service manifest indexed content is not valid JSON.",
          error
        );
      }
      const canonical = canonicalizeTypedReferenceManifest(parsed, budget);
      if (
        !canonical.canonicalBytes.equals(entry.manifestBytes) ||
        canonical.manifestDigest !== entry.manifestDigest
      ) {
        throw serviceManifestError(
          "storage_manifest_content_invalid",
          "Service manifest indexed content is not canonical or digest-bound."
        );
      }
      root = trieSet(root, entry.serviceId, 0, freezeServiceRecord({
        serviceId: entry.serviceId,
        serviceRevision: entry.serviceRevision,
        manifestDigest: entry.manifestDigest,
        manifest: canonical.manifest
      }));
    }
    const snapshot = createSnapshot({ root, pointer: state.pointer });
    return Object.freeze({
      identity: cacheIdentity(state.pointer),
      pointer: state.pointer,
      root,
      snapshot
    });
  }

  async function loadSnapshot(kind, context, existingCache) {
    const state = await transaction.readSnapshot(kind, context);
    const identity = cacheIdentity(state.pointer);
    if (existingCache?.identity === identity) return existingCache;
    return hydrateSnapshot(state, context.budget);
  }

  async function getSnapshot({ signal, budget: budgetInput = {} } = {}) {
    const budget = normalizeManifestResourceBudget(budgetInput);
    const startedAt = Date.now();
    return runSerialized({ signal, budget, startedAt }, async (context) => {
      publishedCache = await loadSnapshot(
        "published",
        context,
        publishedCache
      );
      return publishedCache.snapshot;
    });
  }

  async function getCandidateSnapshot({
    signal,
    budget: budgetInput = {}
  } = {}) {
    const budget = normalizeManifestResourceBudget(budgetInput);
    const startedAt = Date.now();
    return runSerialized({ signal, budget, startedAt }, async (context) => {
      candidateCache = await loadSnapshot(
        "candidate",
        context,
        candidateCache
      );
      return candidateCache.snapshot;
    });
  }

  async function commitManifestSet({
    serviceId,
    expectedServiceRevision,
    expectedSetRevision,
    manifest,
    requestDigest,
    signal,
    budget: budgetInput = {}
  } = {}) {
    const budget = normalizeManifestResourceBudget(budgetInput);
    const startedAt = Date.now();
    assertSignal(signal);
    validateOpaqueServiceId(serviceId);
    validateManifestRevision(
      expectedServiceRevision,
      "expected service revision"
    );
    validateManifestRevision(expectedSetRevision, "expected set revision");
    validateManifestDigest(requestDigest, "request digest");
    const canonical = canonicalizeTypedReferenceManifest(manifest, budget);

    return runSerialized({ signal, budget, startedAt }, async (context) => {
      const previousCache =
        candidateCache?.pointer.setRevision === expectedSetRevision
          ? candidateCache
          : null;
      const result = await transaction.commitManifest({
        serviceId,
        expectedServiceRevision,
        expectedSetRevision,
        manifestBytes: canonical.canonicalBytes,
        manifestDigest: canonical.manifestDigest,
        requestDigest
      }, context);
      if (result.changed && previousCache) {
        const record = freezeServiceRecord({
          serviceId,
          serviceRevision: result.outcome.serviceRevision,
          manifestDigest: result.outcome.manifestDigest,
          manifest: canonical.manifest
        });
        const root = trieSet(previousCache.root, serviceId, 0, record);
        const pointer = Object.freeze({
          setRevision: result.outcome.setRevision,
          setDigest: result.outcome.setDigest
        });
        candidateCache = Object.freeze({
          identity: cacheIdentity(pointer),
          pointer,
          root,
          snapshot: createSnapshot({ root, pointer })
        });
      } else if (result.changed) {
        candidateCache = null;
      }
      return publicOutcome(result.outcome, result.replayed);
    });
  }

  async function acknowledgePublished({
    setRevision,
    setDigest,
    signal,
    budget: budgetInput = {}
  } = {}) {
    const budget = normalizeManifestResourceBudget(budgetInput);
    const startedAt = Date.now();
    assertSignal(signal);
    validateManifestRevision(setRevision, "set revision");
    validateManifestDigest(setDigest, "set digest");
    return runSerialized({ signal, budget, startedAt }, async (context) => {
      const pointer = await transaction.acknowledgePublished(
        { setRevision, setDigest },
        context
      );
      if (candidateCache?.identity === cacheIdentity(pointer)) {
        publishedCache = candidateCache;
        return candidateCache.snapshot;
      }
      publishedCache = null;
      return Object.freeze({
        setRevision: pointer.setRevision,
        setDigest: pointer.setDigest
      });
    });
  }

  const writerPort = createDurableManifestWriterPort(commitManifestSet);
  const readerPort = createManifestSnapshotReaderPort(getSnapshot);
  return Object.freeze({
    writerPort,
    readerPort,
    commitManifestSet,
    getSnapshot,
    getCandidateSnapshot,
    acknowledgePublished
  });
}
