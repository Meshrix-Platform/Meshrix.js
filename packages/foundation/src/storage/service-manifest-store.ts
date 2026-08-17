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
import type {
  CanonicalManifestResult,
  ManifestResourceBudget
} from "./storage-ports.ts";
import {
  createManifestTransactionContext,
  createServiceManifestTransaction
} from "./service-manifest-transaction.ts";
import { runStorageMaintenanceMutation } from "./storage-maintenance-coordinator.ts";
import type { StorageWorkTracker } from "./storage-maintenance-coordinator.ts";

type ManifestValue = Readonly<Record<string, unknown>>;

interface ServiceRecord {
  serviceId: string;
  serviceRevision: number;
  manifestDigest: string;
  manifest: ManifestValue;
}

interface TrieNode {
  value: Readonly<ServiceRecord> | null;
  children: ReadonlyMap<string, Readonly<TrieNode>>;
}

interface ManifestPointer {
  setRevision: number;
  setDigest: string;
}

interface ManifestSnapshot {
  readonly setRevision: number;
  readonly setDigest: string;
  readonly serviceCount: number;
  getService(serviceId: unknown): Readonly<ServiceRecord> | null;
  hasService(serviceId: unknown): boolean;
  listServices(): readonly Readonly<ServiceRecord>[];
}

interface SnapshotEntry {
  serviceId: string;
  serviceRevision: number;
  manifestDigest: string;
  manifestBytes: Buffer;
}

interface SnapshotState {
  pointer: Readonly<ManifestPointer>;
  entries: readonly SnapshotEntry[];
}

interface ManifestTransactionContext {
  budget: Readonly<ManifestResourceBudget>;
  signal?: AbortSignal;
  check(): void;
}

interface CommitOutcome extends ManifestPointer {
  serviceRevision: number;
  manifestDigest: string;
  receiptRef: string;
}

interface CommitResult {
  outcome: Readonly<CommitOutcome>;
  replayed: boolean;
  changed: boolean;
}

interface ServiceManifestTransaction {
  rootPath: string;
  readSnapshot(kind: "published" | "candidate", context: ManifestTransactionContext): Promise<SnapshotState>;
  commitManifest(input: {
    serviceId: string;
    expectedServiceRevision: number;
    expectedSetRevision: number;
    manifestBytes: Buffer;
    manifestDigest: string;
    requestDigest: string;
  }, context: ManifestTransactionContext): Promise<CommitResult>;
  acknowledgePublished(input: ManifestPointer, context: ManifestTransactionContext): Promise<Readonly<ManifestPointer>>;
}

interface SnapshotCache {
  identity: string;
  pointer: Readonly<ManifestPointer>;
  root: Readonly<TrieNode>;
  snapshot: Readonly<ManifestSnapshot>;
}

export interface ServiceManifestStore {
  writerPort: Readonly<{ commitManifestSet: CommitManifestSet }>;
  readerPort: Readonly<{ getSnapshot: GetSnapshot }>;
  commitManifestSet: CommitManifestSet;
  getSnapshot: GetSnapshot;
  getCandidateSnapshot: GetSnapshot;
  acknowledgePublished: AcknowledgePublished;
}

interface SnapshotOptions {
  signal?: AbortSignal;
  budget?: unknown;
}

interface CommitManifestSetInput extends SnapshotOptions {
  serviceId?: unknown;
  expectedServiceRevision?: unknown;
  expectedSetRevision?: unknown;
  manifest?: unknown;
  requestDigest?: unknown;
}

interface AcknowledgePublishedInput extends SnapshotOptions {
  setRevision?: unknown;
  setDigest?: unknown;
}

type PublicCommitOutcome = Readonly<CommitOutcome & { replayed: boolean }>;
type GetSnapshot = (input?: SnapshotOptions) => Promise<Readonly<ManifestSnapshot>>;
type CommitManifestSet = (input?: CommitManifestSetInput) => Promise<PublicCommitOutcome>;
type AcknowledgePublished = (input?: AcknowledgePublishedInput) => Promise<Readonly<ManifestSnapshot> | Readonly<ManifestPointer>>;

const EMPTY_TRIE: Readonly<TrieNode> = Object.freeze({ value: null, children: new Map() });

function trieLookup(root: Readonly<TrieNode>, key: string): Readonly<ServiceRecord> | null {
  let node: Readonly<TrieNode> = root;
  for (const character of key) {
    const child = node.children.get(character);
    if (!child) return null;
    node = child;
  }
  return node.value;
}

function trieSet(
  node: Readonly<TrieNode> | null,
  key: string,
  index: number,
  value: Readonly<ServiceRecord>
): Readonly<TrieNode> {
  const current = node || EMPTY_TRIE;
  if (index === key.length) {
    return Object.freeze({ value, children: current.children });
  }
  const character = key[index];
  const child = trieSet(
    current.children.get(character) || null,
    key,
    index + 1,
    value
  );
  const children = new Map(current.children);
  children.set(character, child);
  return Object.freeze({ value: current.value, children });
}

function collectTrieValues(node: Readonly<TrieNode>, output: ServiceRecord[]): void {
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
}: ServiceRecord): Readonly<ServiceRecord> {
  return Object.freeze({
    serviceId,
    serviceRevision,
    manifestDigest,
    manifest
  });
}

function cacheIdentity(pointer: ManifestPointer): string {
  return `${pointer.setRevision}:${pointer.setDigest}`;
}

function createSnapshot({ root, pointer }: { root: Readonly<TrieNode>; pointer: Readonly<ManifestPointer> }): Readonly<ManifestSnapshot> {
  const capturedRoot = root;
  let listed: readonly Readonly<ServiceRecord>[] | null = null;
  return Object.freeze({
    setRevision: pointer.setRevision,
    setDigest: pointer.setDigest,
    get serviceCount(): number {
      if (!listed) {
        const output: ServiceRecord[] = [];
        collectTrieValues(capturedRoot, output);
        listed = Object.freeze(output);
      }
      return listed.length;
    },
    getService(serviceId: unknown): Readonly<ServiceRecord> | null {
      return trieLookup(capturedRoot, validateOpaqueServiceId(serviceId));
    },
    hasService(serviceId: unknown): boolean {
      return trieLookup(capturedRoot, validateOpaqueServiceId(serviceId)) !== null;
    },
    listServices(): readonly Readonly<ServiceRecord>[] {
      if (!listed) {
        const output: ServiceRecord[] = [];
        collectTrieValues(capturedRoot, output);
        listed = Object.freeze(output);
      }
      return listed;
    }
  });
}

function publicOutcome(outcome: Readonly<CommitOutcome>, replayed: boolean): PublicCommitOutcome {
  return Object.freeze({
    serviceRevision: outcome.serviceRevision,
    setRevision: outcome.setRevision,
    manifestDigest: outcome.manifestDigest,
    setDigest: outcome.setDigest,
    replayed,
    receiptRef: outcome.receiptRef
  });
}

function assertSignal(signal: unknown): asserts signal is AbortSignal | undefined {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw serviceManifestError(
      "storage_manifest_signal_invalid",
      "Service manifest signal must be an AbortSignal."
    );
  }
}

export function createServiceManifestStore({
  storageRoot,
  now = Date.now
}: {
  storageRoot: string;
  now?: () => number;
}): Readonly<ServiceManifestStore> {
  const transaction: ServiceManifestTransaction = createServiceManifestTransaction({ storageRoot, now });
  let candidateCache: SnapshotCache | null = null;
  let publishedCache: SnapshotCache | null = null;

  async function runSerialized<T>(
    {
      signal,
      budget,
      startedAt
    }: {
      signal?: AbortSignal;
      budget: Readonly<ManifestResourceBudget>;
      startedAt: number;
    },
    task: (context: ManifestTransactionContext) => T | Promise<T>
  ): Promise<T> {
    assertSignal(signal);
    if (signal?.aborted) {
      const context: ManifestTransactionContext = createManifestTransactionContext({
        budget,
        signal,
        startedAt
      });
      context.check();
    }
    return runStorageMaintenanceMutation(
      transaction.rootPath,
      async ({ signal: laneSignal }: StorageWorkTracker): Promise<T> => {
        const context: ManifestTransactionContext = createManifestTransactionContext({
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

  function hydrateSnapshot(state: SnapshotState, budget: Readonly<ManifestResourceBudget>): Readonly<SnapshotCache> {
    let root: Readonly<TrieNode> = EMPTY_TRIE;
    for (const entry of state.entries) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.manifestBytes.toString("utf8"));
      } catch (error: unknown) {
        throw serviceManifestError(
          "storage_manifest_content_invalid",
          "Service manifest indexed content is not valid JSON.",
          error
        );
      }
      const canonical: Readonly<CanonicalManifestResult> = canonicalizeTypedReferenceManifest(parsed, budget);
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

  async function loadSnapshot(
    kind: "published" | "candidate",
    context: ManifestTransactionContext,
    existingCache: SnapshotCache | null
  ): Promise<Readonly<SnapshotCache>> {
    const state = await transaction.readSnapshot(kind, context);
    const identity = cacheIdentity(state.pointer);
    if (existingCache?.identity === identity) return existingCache;
    return hydrateSnapshot(state, context.budget);
  }

  async function getSnapshot({ signal, budget: budgetInput = {} }: SnapshotOptions = {}): Promise<Readonly<ManifestSnapshot>> {
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
  }: SnapshotOptions = {}): Promise<Readonly<ManifestSnapshot>> {
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
  }: CommitManifestSetInput = {}): Promise<PublicCommitOutcome> {
    const budget = normalizeManifestResourceBudget(budgetInput);
    const startedAt = Date.now();
    assertSignal(signal);
    const selectedServiceId = validateOpaqueServiceId(serviceId);
    const selectedServiceRevision = validateManifestRevision(
      expectedServiceRevision,
      "expected service revision"
    );
    const selectedSetRevision = validateManifestRevision(expectedSetRevision, "expected set revision");
    const selectedRequestDigest = validateManifestDigest(requestDigest, "request digest");
    const canonical = canonicalizeTypedReferenceManifest(manifest, budget);

    return runSerialized({ signal, budget, startedAt }, async (context) => {
      const previousCache =
        candidateCache?.pointer.setRevision === selectedSetRevision
          ? candidateCache
          : null;
      const result = await transaction.commitManifest({
        serviceId: selectedServiceId,
        expectedServiceRevision: selectedServiceRevision,
        expectedSetRevision: selectedSetRevision,
        manifestBytes: canonical.canonicalBytes,
        manifestDigest: canonical.manifestDigest,
        requestDigest: selectedRequestDigest
      }, context);
      if (result.changed && previousCache) {
        const record = freezeServiceRecord({
          serviceId: selectedServiceId,
          serviceRevision: result.outcome.serviceRevision,
          manifestDigest: result.outcome.manifestDigest,
          manifest: canonical.manifest
        });
        const root = trieSet(previousCache.root, selectedServiceId, 0, record);
        const pointer: Readonly<ManifestPointer> = Object.freeze({
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
  }: AcknowledgePublishedInput = {}): Promise<Readonly<ManifestSnapshot> | Readonly<ManifestPointer>> {
    const budget = normalizeManifestResourceBudget(budgetInput);
    const startedAt = Date.now();
    assertSignal(signal);
    const selectedSetRevision = validateManifestRevision(setRevision, "set revision");
    const selectedSetDigest = validateManifestDigest(setDigest, "set digest");
    return runSerialized({ signal, budget, startedAt }, async (context) => {
      const pointer = await transaction.acknowledgePublished(
        { setRevision: selectedSetRevision, setDigest: selectedSetDigest },
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
