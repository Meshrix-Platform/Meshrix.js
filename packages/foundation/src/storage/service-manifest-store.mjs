import {
  canonicalizeTypedReferenceManifest,
  createDurableManifestWriterPort,
  createManifestSnapshotReaderPort,
  deepFreezeManifest,
  normalizeManifestResourceBudget,
  serviceManifestError,
  sha256ManifestBytes,
  stableManifestJson,
  validateManifestDigest,
  validateManifestRevision,
  validateOpaqueServiceId
} from "./storage-ports.mjs";
import {
  createManifestTransactionContext,
  createServiceManifestTransaction,
  SERVICE_MANIFEST_GENERATION_SCHEMA_VERSION,
  serviceManifestSetDigest
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
  const child = trieSet(current.children.get(character), key, index + 1, value);
  const children = new Map(current.children);
  children.set(character, child);
  return Object.freeze({ value: current.value, children });
}

function collectTrieValues(node, output) {
  if (node.value) output.push(node.value);
  const children = [...node.children.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [, child] of children) collectTrieValues(child, output);
}

function freezeServiceRecord({ serviceId, serviceRevision, manifestDigest, manifest }) {
  return Object.freeze({
    serviceId,
    serviceRevision,
    manifestDigest,
    manifest
  });
}

function createSnapshot({ root, pointer, generation }) {
  const capturedRoot = root;
  const setRevision = pointer?.setRevision || 0;
  const setDigest = pointer?.setDigest || generation.setDigest;
  const serviceCount = generation.services.length;
  return Object.freeze({
    setRevision,
    setDigest,
    serviceCount,
    getService(serviceId) {
      validateOpaqueServiceId(serviceId);
      return trieLookup(capturedRoot, serviceId);
    },
    hasService(serviceId) {
      validateOpaqueServiceId(serviceId);
      return trieLookup(capturedRoot, serviceId) !== null;
    },
    listServices() {
      const output = [];
      collectTrieValues(capturedRoot, output);
      return Object.freeze(output);
    }
  });
}

function pointerIdentity(pointer) {
  return pointer?.generationDigest || "empty";
}

function requestOutcome({
  requestDigest,
  serviceId,
  manifestDigest,
  expectedServiceRevision,
  expectedSetRevision,
  serviceRevision,
  setRevision,
  setDigest
}) {
  const receiptDigest = sha256ManifestBytes(Buffer.from(stableManifestJson({
    requestDigest,
    serviceId,
    manifestDigest,
    expectedServiceRevision,
    expectedSetRevision,
    serviceRevision,
    setRevision,
    setDigest
  }), "utf8"));
  return Object.freeze({
    requestDigest,
    serviceId,
    manifestDigest,
    expectedServiceRevision,
    expectedSetRevision,
    serviceRevision,
    setRevision,
    setDigest,
    receiptRef: `urn:lico:storage-manifest-receipt:${receiptDigest}`
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

function assertRequestMatches(outcome, input) {
  if (
    outcome.serviceId !== input.serviceId ||
    outcome.manifestDigest !== input.manifestDigest ||
    outcome.expectedServiceRevision !== input.expectedServiceRevision ||
    outcome.expectedSetRevision !== input.expectedSetRevision
  ) {
    throw serviceManifestError(
      "storage_manifest_replay_conflict",
      "Service manifest request identity was reused with different canonical input."
    );
  }
}

export function createServiceManifestStore({ storageRoot }) {
  const transaction = createServiceManifestTransaction({ storageRoot });
  let candidateCache = null;
  let publishedCache = null;

  async function runSerialized({ signal, budget, startedAt }, task) {
    assertSignal(signal);
    if (signal?.aborted) {
      const context = createManifestTransactionContext({ budget, signal, startedAt });
      context.check();
    }
    return runStorageMaintenanceMutation(transaction.rootPath, async ({ signal: laneSignal }) => {
      const context = createManifestTransactionContext({
        budget,
        signal,
        laneSignal,
        startedAt
      });
      context.check();
      return task(context);
    }, {
      signal,
      kind: "storage.service-manifest.commit",
      budget: {
        maxFiles: budget.maxFiles,
        maxBytes: budget.maxReadBytes + budget.maxWriteBytes,
        maxCleanupItems: budget.maxCleanupEntries,
        maxDurationMs: budget.maxOperationMs
      }
    });
  }

  async function hydrateCache(state, context, existingCache = null) {
    const identity = pointerIdentity(state.pointer);
    if (existingCache?.identity === identity) return existingCache;
    let root = EMPTY_TRIE;
    const services = new Map();
    for (const entry of state.generation.services) {
      context.check();
      const bytes = await transaction.readManifest(entry.manifestDigest, context);
      let parsed;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch (error) {
        throw serviceManifestError(
          "storage_manifest_content_invalid",
          "Service manifest immutable content is not valid JSON.",
          error
        );
      }
      const canonical = canonicalizeTypedReferenceManifest(parsed, context.budget);
      if (!canonical.canonicalBytes.equals(bytes) || canonical.manifestDigest !== entry.manifestDigest) {
        throw serviceManifestError(
          "storage_manifest_content_invalid",
          "Service manifest immutable content is not canonical or digest-bound."
        );
      }
      const record = freezeServiceRecord({
        ...entry,
        manifest: canonical.manifest
      });
      root = trieSet(root, entry.serviceId, 0, record);
      services.set(entry.serviceId, entry);
    }
    const requests = new Map(
      state.generation.requests.map((outcome) => [outcome.requestDigest, Object.freeze({ ...outcome })])
    );
    const snapshot = createSnapshot({ root, pointer: state.pointer, generation: state.generation });
    return Object.freeze({
      identity,
      pointer: state.pointer,
      generation: state.generation,
      root,
      services,
      requests,
      snapshot
    });
  }

  async function getSnapshot({ signal, budget: budgetInput = {} } = {}) {
    const budget = normalizeManifestResourceBudget(budgetInput);
    const startedAt = Date.now();
    return runSerialized({ signal, budget, startedAt }, async (context) => {
      const state = await transaction.readPublished(context);
      publishedCache = await hydrateCache(state, context, publishedCache);
      return publishedCache.snapshot;
    });
  }

  async function getCandidateSnapshot({ signal, budget: budgetInput = {} } = {}) {
    const budget = normalizeManifestResourceBudget(budgetInput);
    const startedAt = Date.now();
    return runSerialized({ signal, budget, startedAt }, async (context) => {
      const state = await transaction.recover(context);
      candidateCache = await hydrateCache(state, context, candidateCache);
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
    validateManifestRevision(expectedServiceRevision, "expected service revision");
    validateManifestRevision(expectedSetRevision, "expected set revision");
    validateManifestDigest(requestDigest, "request digest");
    const canonical = canonicalizeTypedReferenceManifest(manifest, budget);
    const inputIdentity = Object.freeze({
      serviceId,
      manifestDigest: canonical.manifestDigest,
      expectedServiceRevision,
      expectedSetRevision
    });

    return runSerialized({ signal, budget, startedAt }, async (context) => {
      const state = await transaction.recover(context);
      const current = await hydrateCache(state, context, candidateCache);
      candidateCache = current;
      const existingRequest = current.requests.get(requestDigest);
      if (existingRequest) {
        assertRequestMatches(existingRequest, inputIdentity);
        return publicOutcome(existingRequest, true);
      }

      const existingService = current.services.get(serviceId) || null;
      const actualServiceRevision = existingService?.serviceRevision || 0;
      const actualSetRevision = state.generation.setRevision;
      if (expectedServiceRevision !== actualServiceRevision) {
        throw serviceManifestError(
          "storage_manifest_service_revision_stale",
          "Service manifest expected service revision is stale."
        );
      }
      if (expectedSetRevision !== actualSetRevision) {
        throw serviceManifestError(
          "storage_manifest_set_revision_stale",
          "Service manifest expected set revision is stale."
        );
      }

      const unchanged = existingService?.manifestDigest === canonical.manifestDigest;
      const serviceRevision = unchanged ? actualServiceRevision : actualServiceRevision + 1;
      const setRevision = unchanged ? actualSetRevision : actualSetRevision + 1;
      const services = new Map(current.services);
      if (!unchanged) {
        services.set(serviceId, Object.freeze({
          serviceId,
          serviceRevision,
          manifestDigest: canonical.manifestDigest
        }));
      }
      if (services.size > budget.maxServices) {
        throw serviceManifestError(
          "storage_manifest_budget_exceeded",
          "Service manifest service count exceeds its resource budget."
        );
      }
      const serviceEntries = [...services.values()]
        .map((entry) => ({ ...entry }))
        .sort((left, right) => left.serviceId.localeCompare(right.serviceId));
      const setDigest = serviceManifestSetDigest(serviceEntries);
      const outcome = requestOutcome({
        requestDigest,
        serviceId,
        manifestDigest: canonical.manifestDigest,
        expectedServiceRevision,
        expectedSetRevision,
        serviceRevision,
        setRevision,
        setDigest
      });
      const requests = new Map(current.requests);
      requests.set(requestDigest, outcome);
      if (requests.size > budget.maxRequestRecords) {
        throw serviceManifestError(
          "storage_manifest_budget_exceeded",
          "Service manifest request history exceeds its resource budget."
        );
      }
      const requestEntries = [...requests.values()]
        .map((entry) => ({ ...entry }))
        .sort((left, right) => left.requestDigest.localeCompare(right.requestDigest));
      const generation = deepFreezeManifest({
        schemaVersion: SERVICE_MANIFEST_GENERATION_SCHEMA_VERSION,
        setRevision,
        setDigest,
        services: serviceEntries,
        requests: requestEntries
      });

      const pointer = await transaction.commit({
        previousPointer: state.pointer,
        generation,
        manifestBytes: canonical.canonicalBytes,
        manifestDigest: canonical.manifestDigest,
        requestDigest,
        serviceId,
        terminalOutcome: outcome
      }, context);

      const root = unchanged
        ? current.root
        : trieSet(current.root, serviceId, 0, freezeServiceRecord({
          serviceId,
          serviceRevision,
          manifestDigest: canonical.manifestDigest,
          manifest: canonical.manifest
        }));
      const snapshot = createSnapshot({ root, pointer, generation });
      candidateCache = Object.freeze({
        identity: pointerIdentity(pointer),
        pointer,
        generation,
        root,
        services,
        requests,
        snapshot
      });
      return publicOutcome(outcome, false);
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
      const candidateState = await transaction.recover(context);
      const publishedState = await transaction.readPublished(context);
      const candidate = await hydrateCache(candidateState, context, candidateCache);
      const published = await hydrateCache(publishedState, context, publishedCache);
      if (
        candidate.snapshot.setRevision !== setRevision ||
        candidate.snapshot.setDigest !== setDigest
      ) {
        throw serviceManifestError(
          "storage_manifest_acknowledgement_stale",
          "Service manifest acknowledgement does not match the current candidate."
        );
      }
      await transaction.acknowledgePublished({
        candidatePointer: candidateState.pointer,
        candidateGeneration: candidateState.generation,
        publishedPointer: publishedState.pointer,
        publishedGeneration: publishedState.generation
      }, context);
      candidateCache = candidate;
      publishedCache = candidate;
      return candidate.snapshot;
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
