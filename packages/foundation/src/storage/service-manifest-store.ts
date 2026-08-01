import {
  canonicalizeTypedReferenceManifest,
  createDurableManifestWriterPort,
  createManifestSnapshotReaderPort,
  normalizeManifestResourceBudget,
  serviceManifestError,
  validateManifestDigest,
  validateManifestRevision,
  validateOpaqueServiceId
} from "./storage-ports.ts";
import {
  createManifestTransactionContext,
  createServiceManifestTransaction
} from "./service-manifest-transaction.ts";
import { runStorageMaintenanceMutation } from "./storage-maintenance-coordinator.ts";

const EMPTY_TRIE: Readonly<Record<string, any>> = Object.freeze({ value: null, children: new Map<any, any>() });

function trieLookup(root?: any, key?: any) : any {
  let node: any = root;
  for (const character of key) {
    node = node.children.get(character);
    if (!node) return null;
  }
  return node.value;
}

function trieSet(node?: any, key?: any, index?: any, value?: any) : any {
  const current: any = node || EMPTY_TRIE;
  if (index === key.length) {
    return Object.freeze({ value, children: current.children });
  }
  const character: any = key[index];
  const child: any = trieSet(
    current.children.get(character),
    key,
    index + 1,
    value
  );
  const children: any = new Map<any, any>(current.children);
  children.set(character, child);
  return Object.freeze({ value: current.value, children });
}

function collectTrieValues(node?: any, output?: any) : any {
  if (node.value) output.push(node.value);
  const children: any = [...node.children.entries()].sort(
    ([left]: any[], [right]: any[]) : any => left.localeCompare(right)
  );
  for (const [, child] of children) collectTrieValues(child, output);
}

function freezeServiceRecord({
  serviceId,
  serviceRevision,
  manifestDigest,
  manifest
}: Record<string, any>) : any {
  return Object.freeze({
    serviceId,
    serviceRevision,
    manifestDigest,
    manifest
  });
}

function cacheIdentity(pointer?: any) : any {
  return `${pointer.setRevision}:${pointer.setDigest}`;
}

function createSnapshot({ root, pointer }: Record<string, any>) : any {
  const capturedRoot: any = root;
  let listed: any = null;
  return Object.freeze({
    setRevision: pointer.setRevision,
    setDigest: pointer.setDigest,
    get serviceCount() : any {
      if (!listed) {
        const output: any[] = [];
        collectTrieValues(capturedRoot, output);
        listed = Object.freeze(output);
      }
      return listed.length;
    },
    getService(serviceId?: any) : any {
      validateOpaqueServiceId(serviceId);
      return trieLookup(capturedRoot, serviceId);
    },
    hasService(serviceId?: any) : any {
      validateOpaqueServiceId(serviceId);
      return trieLookup(capturedRoot, serviceId) !== null;
    },
    listServices() : any {
      if (!listed) {
        const output: any[] = [];
        collectTrieValues(capturedRoot, output);
        listed = Object.freeze(output);
      }
      return listed;
    }
  });
}

function publicOutcome(outcome?: any, replayed?: any) : any {
  return Object.freeze({
    serviceRevision: outcome.serviceRevision,
    setRevision: outcome.setRevision,
    manifestDigest: outcome.manifestDigest,
    setDigest: outcome.setDigest,
    replayed,
    receiptRef: outcome.receiptRef
  });
}

function assertSignal(signal?: any) : any {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw serviceManifestError(
      "storage_manifest_signal_invalid",
      "Service manifest signal must be an AbortSignal."
    );
  }
}

export function createServiceManifestStore({ storageRoot, now = Date.now }: Record<string, any>) : any {
  const transaction: any = createServiceManifestTransaction({ storageRoot, now });
  let candidateCache: any = null;
  let publishedCache: any = null;

  async function runSerialized({ signal, budget, startedAt }: Record<string, any>, task?: any) : Promise<any> {
    assertSignal(signal);
    if (signal?.aborted) {
      const context: any = createManifestTransactionContext({
        budget,
        signal,
        startedAt
      });
      context.check();
    }
    return runStorageMaintenanceMutation(
      transaction.rootPath,
      async ({ signal: laneSignal }: Record<string, any>) : Promise<any> => {
        const context: any = createManifestTransactionContext({
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

  function hydrateSnapshot(state?: any, budget?: any) : any {
    let root: any = EMPTY_TRIE;
    for (const entry of state.entries) {
      let parsed: any;
      try {
        parsed = JSON.parse(entry.manifestBytes.toString("utf8"));
      } catch (error: any) {
        throw serviceManifestError(
          "storage_manifest_content_invalid",
          "Service manifest indexed content is not valid JSON.",
          error
        );
      }
      const canonical: any = canonicalizeTypedReferenceManifest(parsed, budget);
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
    const snapshot: any = createSnapshot({ root, pointer: state.pointer });
    return Object.freeze({
      identity: cacheIdentity(state.pointer),
      pointer: state.pointer,
      root,
      snapshot
    });
  }

  async function loadSnapshot(kind?: any, context?: any, existingCache?: any) : Promise<any> {
    const state: any = await transaction.readSnapshot(kind, context);
    const identity: any = cacheIdentity(state.pointer);
    if (existingCache?.identity === identity) return existingCache;
    return hydrateSnapshot(state, context.budget);
  }

  async function getSnapshot({ signal, budget: budgetInput = {} }: Record<string, any> = {}) : Promise<any> {
    const budget: any = normalizeManifestResourceBudget(budgetInput);
    const startedAt: any = Date.now();
    return runSerialized({ signal, budget, startedAt }, async (context?: any) : Promise<any> => {
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
  }: Record<string, any> = {}) : Promise<any> {
    const budget: any = normalizeManifestResourceBudget(budgetInput);
    const startedAt: any = Date.now();
    return runSerialized({ signal, budget, startedAt }, async (context?: any) : Promise<any> => {
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
  }: Record<string, any> = {}) : Promise<any> {
    const budget: any = normalizeManifestResourceBudget(budgetInput);
    const startedAt: any = Date.now();
    assertSignal(signal);
    validateOpaqueServiceId(serviceId);
    validateManifestRevision(
      expectedServiceRevision,
      "expected service revision"
    );
    validateManifestRevision(expectedSetRevision, "expected set revision");
    validateManifestDigest(requestDigest, "request digest");
    const canonical: any = canonicalizeTypedReferenceManifest(manifest, budget);

    return runSerialized({ signal, budget, startedAt }, async (context?: any) : Promise<any> => {
      const previousCache: any =
        candidateCache?.pointer.setRevision === expectedSetRevision
          ? candidateCache
          : null;
      const result: any = await transaction.commitManifest({
        serviceId,
        expectedServiceRevision,
        expectedSetRevision,
        manifestBytes: canonical.canonicalBytes,
        manifestDigest: canonical.manifestDigest,
        requestDigest
      }, context);
      if (result.changed && previousCache) {
        const record: any = freezeServiceRecord({
          serviceId,
          serviceRevision: result.outcome.serviceRevision,
          manifestDigest: result.outcome.manifestDigest,
          manifest: canonical.manifest
        });
        const root: any = trieSet(previousCache.root, serviceId, 0, record);
        const pointer: Readonly<Record<string, any>> = Object.freeze({
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
  }: Record<string, any> = {}) : Promise<any> {
    const budget: any = normalizeManifestResourceBudget(budgetInput);
    const startedAt: any = Date.now();
    assertSignal(signal);
    validateManifestRevision(setRevision, "set revision");
    validateManifestDigest(setDigest, "set digest");
    return runSerialized({ signal, budget, startedAt }, async (context?: any) : Promise<any> => {
      const pointer: any = await transaction.acknowledgePublished(
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

  const writerPort: any = createDurableManifestWriterPort(commitManifestSet);
  const readerPort: any = createManifestSnapshotReaderPort(getSnapshot);
  return Object.freeze({
    writerPort,
    readerPort,
    commitManifestSet,
    getSnapshot,
    getCandidateSnapshot,
    acknowledgePublished
  });
}
