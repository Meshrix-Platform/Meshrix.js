import { queueStateMutation } from "@meshrix/foundation/storage/state-coordinator";
import {
  SERVICE_COLLABORATION_CORE_STATE_GENERATION,
  SERVICE_COLLABORATION_LIMITS,
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD,
  SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED,
  SERVICE_COLLABORATION_VISIBILITY,
  assertCommitTurn,
  assertOneCoreStateGeneration,
  containsForbiddenKeys,
  createAcknowledge,
  createChangeSet,
  createCommitRequest,
  createObserveResponse,
  createOpenResponse,
  createRebaseResponse,
  createResourceUpdatedNotification,
  createResyncResponse,
  lookupFactIsAuthority,
  parseChangeSet,
  parseCommitRequest,
  parseOperation,
  rebaseOperations
} from "@meshrix/contracts/service-collaboration-contract";

export const CORE_CHANGE_SET_AUTHORITY_ID = "CoreChangeSetAuthority";
export const CORE_CHANGE_SET_REPORT_SCHEMA_VERSION = "v0.0.1:core-change-set:report-1";
export const CORE_CHANGE_SET_NON_CERTIFICATION_REASON = "owner_profile_not_authorized";
export const CORE_CHANGE_SET_DEFAULT_DIGEST =
  "sha256:abababababababababababababababababababababababababababababababab";

const PRIVATE_CACHE_HINT = Object.freeze({
  ttlMs: 60_000,
  cacheScope: "private"
});

let factorySeq = 0;

type ChangeSetOperation = NonNullable<ReturnType<typeof parseOperation>>;
type CoreChangeSet = ReturnType<typeof createChangeSet>;
type CommitRequest = ReturnType<typeof createCommitRequest>;
type Acknowledge = ReturnType<typeof createAcknowledge>;
type OpenResponse = ReturnType<typeof createOpenResponse>;
type ObserveResponse = ReturnType<typeof createObserveResponse>;
type RebaseResponse = ReturnType<typeof createRebaseResponse>;
type ResyncResponse = ReturnType<typeof createResyncResponse>;
type ResourceUpdatedNotification = ReturnType<typeof createResourceUpdatedNotification>;
type CursorState = "valid" | "expired";

interface OperationInput {
  opId?: unknown;
  type?: unknown;
  entityId?: unknown;
  index?: unknown;
  relevantIndexes?: unknown;
  payloadDigest?: unknown;
}

interface ChangeSetInput {
  changeId?: unknown;
  baselineHead?: unknown;
  operations?: unknown;
  attributionRef?: unknown;
}

interface ApprovalLookup {
  priorApproval?: string;
}

export interface AuthorityLookup extends ApprovalLookup {
  principalRef?: unknown;
  grantRef?: unknown;
  resourceRef?: unknown;
  policyRef?: unknown;
  generation?: unknown;
  handle?: unknown;
  cursor?: unknown;
  [fact: string]: unknown;
}

interface AuthorizationState {
  principalRef: string;
  grantRef: string;
  resourceRef: string;
  policyRef: string;
  audienceRef: string;
  requestRef: string;
  generation: number;
  revoked: boolean;
}

type AuthorizationDecision =
  | { ok: true; authorizationReResolved?: boolean }
  | { ok: false; code: string };

interface EntityState { kind: string; index: number; resourceUri: string }
interface OperationLogEntry { head: number; opIndex: number; operation: ChangeSetOperation }
interface HistoryEntry { head: number; changeId: string; entityIds: string[] }
type ApplyResult =
  | { ok: true; changed: string[] }
  | { ok: false; code: string; entityId: string };
interface SnapshotRecord {
  snapshotId: string;
  head: number;
  entityIds: string[];
  resourceUris: string[];
  byteLength: number;
}

interface WorkingSetStore {
  workingSetId: string;
  head: number;
  entityIds: string[];
  handles: Map<string, string>;
  entityById: Map<string, EntityState>;
  opsByEntity: Map<string, OperationLogEntry[]>;
  opsByHead: Map<number, OperationLogEntry[]>;
  historyByHead: Map<number, HistoryEntry>;
  historyHeads: number[];
  changeResults: Map<string, Acknowledge>;
  snapshotsByHead: Map<number, SnapshotRecord>;
  snapshotHeads: number[];
  cursors: Map<string, number>;
  subscribersByUri: Map<string, Set<string>>;
  subscriberById: Map<string, { resourceUri: string }>;
  catalogRevision: string;
  schemaRevision: string;
  catalogSize: number;
  connectedClients: number;
  auth: AuthorizationState;
}

interface AuthorityCounters {
  applyCalls: number; changeSetApplyCalls: number; effectCommandCalls: number;
  duplicateDeliveries: number; authorizationReResolved: number; scannedEntities: number;
  relevantOperations: number; indexedStatements: number; snapshotPeak: number;
  subscriptionPeak: number; wakeups: number; catalogSize: number; connectedClients: number;
}

interface CoreChangeSetAuthorityOptions {
  instanceId?: unknown; limits?: unknown; principalRef?: unknown; grantRef?: unknown;
  resourceRef?: unknown; policyRef?: unknown; audienceRef?: unknown; requestRef?: unknown;
  generation?: unknown; resolveAuthorization?: unknown;
}

interface CoreChangeSetAuthority {
  readonly id: typeof CORE_CHANGE_SET_AUTHORITY_ID;
  readonly coreStateGeneration: typeof SERVICE_COLLABORATION_CORE_STATE_GENERATION;
  open(input?: WorkingSetInput): Promise<OpenResponse>;
  observe(input?: WorkingSetInput): Promise<ObserveResponse>;
  commitTurn(value?: Record<string, unknown>, lookup?: AuthorityLookup): Promise<Acknowledge>;
  rebase(input?: WorkingSetInput, lookup?: AuthorityLookup): Promise<RebaseResponse>;
  resync(input?: WorkingSetInput, lookup?: AuthorityLookup): Promise<ResyncResponse>;
  subscribe(input?: WorkingSetInput, lookup?: AuthorityLookup): Promise<SubscriptionResult>;
  seedDecoys(input?: WorkingSetInput): Readonly<{ catalogSize: number; connectedClients: number }>;
  revoke(workingSetId?: unknown): boolean;
  advanceGeneration(workingSetId?: unknown): number;
  snapshotCounters(): Readonly<AuthorityCounters>;
  inspect(workingSetId?: unknown): Readonly<Record<string, unknown>>;
  notificationFor(workingSetId?: unknown, entityId?: unknown): ResourceUpdatedNotification;
  rejectEffectCommand(value?: unknown): never;
  close(): boolean;
}

type SubscriptionResult =
  | Readonly<{ ok: true; subscriberId: string; method: string; authorizationReResolved: true }>
  | { ok: false; code: string };

interface WorkingSetInput {
  workingSetId?: unknown; handle?: unknown; lookup?: unknown; entities?: unknown;
  entityIds?: unknown; catalogSize?: unknown; connectedClients?: unknown;
  authorization?: unknown; operations?: unknown; baselineHead?: unknown; cursor?: unknown;
  resourceUri?: unknown; [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string { return String(value || ""); }
function asSafeInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function isAuthorizationDecision(value: unknown): value is AuthorizationDecision {
  return isRecord(value) && (value.ok === true || (value.ok === false && typeof value.code === "string"));
}

function emptyCounters(): AuthorityCounters {
  return {
    applyCalls: 0,
    changeSetApplyCalls: 0,
    effectCommandCalls: 0,
    duplicateDeliveries: 0,
    authorizationReResolved: 0,
    scannedEntities: 0,
    relevantOperations: 0,
    indexedStatements: 0,
    snapshotPeak: 0,
    subscriptionPeak: 0,
    wakeups: 0,
    catalogSize: 0,
    connectedClients: 0
  };
}

function freezeMessage<T>(value: T): T {
  if (containsForbiddenKeys(value)) {
    throw new Error("Core Change Set output cannot carry privacy or CRDT fields.");
  }
  assertOneCoreStateGeneration(value);
  return value;
}

function uniqueStrings(value: unknown = []): string[] {
  return [...new Set<string>((Array.isArray(value) ? value : []).map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function resourceUriFor(workingSetId: string, entityId: string): string {
  return `meshrix://collaboration/${workingSetId}/${entityId}`;
}

function conflictFact(code: string, entityId: string, head = 0) {
  return { code, entityId, head };
}

export function createCoreChangeSetOperation(value: OperationInput = {}): ChangeSetOperation {
  const index = typeof value.index === "number" && Number.isSafeInteger(value.index) && value.index >= 0 ? value.index : 0;
  const parsed = parseOperation({
    opId: value.opId,
    type: value.type || "insert",
    entityId: value.entityId,
    index,
    relevantIndexes: Array.isArray(value.relevantIndexes) ? value.relevantIndexes : [index],
    payloadDigest: value.payloadDigest || CORE_CHANGE_SET_DEFAULT_DIGEST
  });
  if (!parsed) {
    throw new TypeError("Core Change Set operation does not satisfy the wire contract.");
  }
  return parsed;
}

export function createCoreChangeSet(value: ChangeSetInput = {}): CoreChangeSet {
  const operations = Array.isArray(value.operations) ? value.operations : [];
  return createChangeSet({
    changeId: value.changeId,
    baselineHead: value.baselineHead,
    operations: operations.map((entry) => createCoreChangeSetOperation(asObject(entry))),
    attributionRef: value.attributionRef
  });
}

function copyWorkingSet(workingSet: WorkingSetStore): WorkingSetStore {
  const opsByEntity = new Map<string, OperationLogEntry[]>();
  for (const [entityId, entries] of workingSet.opsByEntity) {
    opsByEntity.set(entityId, entries.map((entry) => ({ ...entry })));
  }
  const opsByHead = new Map<number, OperationLogEntry[]>();
  for (const [head, entries] of workingSet.opsByHead) {
    opsByHead.set(head, entries.map((entry) => ({ ...entry })));
  }
  const entityById = new Map<string, EntityState>();
  for (const [entityId, entity] of workingSet.entityById) {
    entityById.set(entityId, { ...entity });
  }
  return {
    workingSetId: workingSet.workingSetId,
    head: workingSet.head,
    entityIds: [...workingSet.entityIds],
    handles: new Map(workingSet.handles),
    entityById,
    opsByEntity,
    opsByHead,
    historyByHead: new Map(workingSet.historyByHead),
    historyHeads: [...workingSet.historyHeads],
    changeResults: new Map(workingSet.changeResults),
    snapshotsByHead: new Map(workingSet.snapshotsByHead),
    snapshotHeads: [...workingSet.snapshotHeads],
    cursors: new Map(workingSet.cursors),
    subscribersByUri: new Map<string, Set<string>>(
      [...workingSet.subscribersByUri].map(([uri, ids]) => [uri, new Set(ids)])
    ),
    subscriberById: new Map(workingSet.subscriberById),
    catalogRevision: workingSet.catalogRevision,
    schemaRevision: workingSet.schemaRevision,
    catalogSize: workingSet.catalogSize,
    connectedClients: workingSet.connectedClients,
    auth: { ...workingSet.auth }
  };
}

function dropOldest(workingSet: WorkingSetStore, maxHistoryEntries: number): void {
  while (workingSet.historyHeads.length > maxHistoryEntries) {
    const oldest = workingSet.historyHeads.shift();
    if (oldest === undefined) break;
    workingSet.historyByHead.delete(oldest);
    workingSet.opsByHead.delete(oldest);
    for (const [entityId, entries] of workingSet.opsByEntity) {
      workingSet.opsByEntity.set(entityId, entries.filter((entry) => entry.head !== oldest));
    }
  }
  while (workingSet.snapshotHeads.length > maxHistoryEntries) {
    const oldestSnapshot = workingSet.snapshotHeads.shift();
    if (oldestSnapshot === undefined) break;
    workingSet.snapshotsByHead.delete(oldestSnapshot);
  }
}

function mintSnapshot(workingSet: WorkingSetStore, snapshotSeq: number): SnapshotRecord {
  const snapshotId = `snap.ccs.${snapshotSeq}`;
  const entityIds = [...workingSet.entityIds];
  const resourceUris = entityIds.map((entityId) => resourceUriFor(workingSet.workingSetId, entityId));
  const provisional = {
    snapshotId,
    head: workingSet.head,
    entityIds,
    resourceUris,
    byteLength: 0
  };
  provisional.byteLength = Buffer.byteLength(JSON.stringify(provisional), "utf8");
  return Object.freeze(provisional);
}

function currentCursor(workingSet: WorkingSetStore, cursorSeq: number, cursorState: CursorState = "valid") {
  const token = `cur.ccs.${cursorSeq}`;
  const cursor = Object.freeze({
    cursor: token,
    indexedHead: workingSet.head,
    cursorState
  });
  if (cursorState === "valid") workingSet.cursors.set(token, workingSet.head);
  return cursor;
}

function relevantInterveningOperations(
  workingSet: WorkingSetStore,
  entityIds: readonly string[],
  baselineHead: number,
  counters: AuthorityCounters
): ChangeSetOperation[] {
  const collected: OperationLogEntry[] = [];
  for (const entityId of entityIds) {
    const entries = workingSet.opsByEntity.get(entityId) || [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.head <= baselineHead) break;
      collected.push(entry);
      counters.relevantOperations += 1;
      counters.indexedStatements += 1;
    }
  }
  collected.sort((left, right) => left.head - right.head || left.opIndex - right.opIndex);
  return collected.map((entry) => entry.operation);
}

function earliestCausalHead(workingSet: WorkingSetStore): number {
  if (workingSet.historyHeads.length === 0) return 0;
  return Math.max(0, workingSet.historyHeads[0] - 1);
}

function matchingWakeups(workingSet: WorkingSetStore, resourceUris: readonly string[]): number {
  let wakeups = 0;
  for (const uri of resourceUris) {
    wakeups += workingSet.subscribersByUri.get(uri)?.size || 0;
  }
  return wakeups;
}

function denyAcknowledge(workingSet: WorkingSetStore, code: string, entityId: string): Acknowledge {
  return freezeMessage(createAcknowledge({
    workingSetId: workingSet.workingSetId,
    assignedHead: workingSet.head,
    changedEntityIds: [],
    resultFacts: [],
    conflicts: [conflictFact(code, entityId, workingSet.head)],
    invalidations: []
  }));
}

function cleanAcknowledge(workingSet: WorkingSetStore): Acknowledge {
  return freezeMessage(createAcknowledge({
    workingSetId: workingSet.workingSetId,
    assignedHead: workingSet.head,
    changedEntityIds: [],
    resultFacts: [],
    conflicts: [],
    invalidations: []
  }));
}

export function assertHotPathIndependence(
  before: Partial<AuthorityCounters> = {},
  after: Partial<AuthorityCounters> = {},
  expected: Record<string, unknown> = {}
): true {
  const scanned = Number(after.scannedEntities) - Number(before.scannedEntities);
  const relevant = Number(after.relevantOperations) - Number(before.relevantOperations);
  const catalogDelta = Number(after.catalogSize) - Number(before.catalogSize);
  const clientDelta = Number(after.connectedClients) - Number(before.connectedClients);
  if (scanned !== expected.changedEntityCount) {
    throw new Error("Hot-path scanned entities must equal changed identities.");
  }
  if (relevant !== expected.relevantOpCount) {
    throw new Error("Hot-path relevant operations must equal intervening ops for changed identities.");
  }
  if (expected.catalogSizeDelta != null && catalogDelta !== expected.catalogSizeDelta) {
    throw new Error("Catalog decoy size must not be consumed by the hot path.");
  }
  if (expected.connectedClientDelta != null && clientDelta !== expected.connectedClientDelta) {
    throw new Error("Connected-client decoy size must not be consumed by the hot path.");
  }
  if (expected.wakeups != null && Number(after.wakeups) - Number(before.wakeups) !== expected.wakeups) {
    throw new Error("Subscriber wakeups must match changed Resource identities only.");
  }
  return true;
}

export function rejectEffectCommand(_value?: unknown): never {
  throw new Error("Effect Commands are a separate family from Core Change Set authority.");
}

export function createCoreChangeSetAuthority(options: CoreChangeSetAuthorityOptions = {}): CoreChangeSetAuthority {
  factorySeq += 1;
  const instanceId = String(options.instanceId || `ccs.${factorySeq}`);
  const limitOverrides = asObject(options.limits);
  const limits = {
    maxEntitiesPerWorkingSet: asSafeInteger(limitOverrides.maxEntitiesPerWorkingSet, SERVICE_COLLABORATION_LIMITS.maxEntitiesPerWorkingSet),
    maxResultFacts: asSafeInteger(limitOverrides.maxResultFacts, SERVICE_COLLABORATION_LIMITS.maxResultFacts),
    maxInvalidations: asSafeInteger(limitOverrides.maxInvalidations, SERVICE_COLLABORATION_LIMITS.maxInvalidations),
    maxHistoryEntries: asSafeInteger(limitOverrides.maxHistoryEntries, SERVICE_COLLABORATION_LIMITS.maxHistoryEntries),
    maxDeltaPage: asSafeInteger(limitOverrides.maxDeltaPage, SERVICE_COLLABORATION_LIMITS.maxDeltaPage),
    maxTailOps: asSafeInteger(limitOverrides.maxTailOps, SERVICE_COLLABORATION_LIMITS.maxTailOps)
  };
  const workingSets = new Map<string, WorkingSetStore>();
  const counters = emptyCounters();
  let cursorSeq = 0;
  let snapshotSeq = 0;
  let subscriberSeq = 0;
  const defaultAuth: AuthorizationState = {
    principalRef: asString(options.principalRef || "prin.ccs.1"),
    grantRef: asString(options.grantRef || "gr.ccs.1"),
    resourceRef: asString(options.resourceRef || "res.ccs.1"),
    policyRef: asString(options.policyRef || "pol.ccs.1"),
    audienceRef: asString(options.audienceRef || "aud.ccs.1"),
    requestRef: asString(options.requestRef || "req.ccs.1"),
    generation: asSafeInteger(options.generation, 1),
    revoked: false
  };

  function laneKey(workingSetId: string): string {
    return `core-change-set:${instanceId}:${workingSetId}`;
  }

  function requireWorkingSet(workingSetId: unknown): WorkingSetStore {
    const workingSet = workingSets.get(asString(workingSetId));
    if (!workingSet) {
      throw new Error("Core Change Set working set is not open.");
    }
    return workingSet;
  }

  function resolveAuthorization(lookup: AuthorityLookup = {}, workingSet: WorkingSetStore): AuthorizationDecision {
    counters.authorizationReResolved += 1;
    for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
      if (lookupFactIsAuthority(fact) === true) {
        return { ok: false, code: "conflict.authorization_changed" };
      }
    }
    if (SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED !== false) {
      return { ok: false, code: "conflict.second_core_generation" };
    }
    const resolver = options.resolveAuthorization;
    if (typeof resolver === "function") {
      const resolved: unknown = resolver(lookup, workingSet.auth);
      if (isAuthorizationDecision(resolved)) return resolved.ok === true
        ? resolved
        : { ok: false, code: resolved.code || "conflict.authorization_changed" };
      return { ok: false, code: "conflict.authorization_changed" };
    }
    if (workingSet.auth.revoked === true) {
      return { ok: false, code: "conflict.authorization_changed" };
    }
    const principalRef = lookup.principalRef || workingSet.auth.principalRef;
    const grantRef = lookup.grantRef || workingSet.auth.grantRef;
    const resourceRef = lookup.resourceRef || workingSet.auth.resourceRef;
    const policyRef = lookup.policyRef || workingSet.auth.policyRef;
    const generation = lookup.generation == null ? workingSet.auth.generation : lookup.generation;
    if (
      principalRef !== workingSet.auth.principalRef
      || grantRef !== workingSet.auth.grantRef
      || resourceRef !== workingSet.auth.resourceRef
      || policyRef !== workingSet.auth.policyRef
      || generation !== workingSet.auth.generation
    ) {
      return { ok: false, code: "conflict.authorization_changed" };
    }
    return { ok: true, authorizationReResolved: true };
  }

  function entityIdForHandle(workingSet: WorkingSetStore, handle: unknown): string {
    return workingSet.handles.get(asString(handle)) || "";
  }

  async function withWorkingSet<T>(workingSetId: unknown, task: (workingSet: WorkingSetStore) => T | Promise<T>): Promise<T> {
    const id = asString(workingSetId);
    return queueStateMutation(laneKey(id), () => task(requireWorkingSet(id)));
  }

  function commitSnapshot(workingSet: WorkingSetStore): SnapshotRecord {
    snapshotSeq += 1;
    const snapshot = mintSnapshot(workingSet, snapshotSeq);
    workingSet.snapshotsByHead.set(workingSet.head, snapshot);
    workingSet.snapshotHeads.push(workingSet.head);
    counters.snapshotPeak = Math.max(counters.snapshotPeak, workingSet.snapshotHeads.length);
    return snapshot;
  }

  function applyOperations(
    workingSet: WorkingSetStore,
    operations: readonly ChangeSetOperation[],
    assignedHead: number
  ): ApplyResult {
    const changed = uniqueStrings(operations.map((entry) => entry.entityId));
    const logEntries: OperationLogEntry[] = [];
    for (let opIndex = 0; opIndex < operations.length; opIndex += 1) {
      const operation = operations[opIndex];
      const entity = workingSet.entityById.get(operation.entityId);
      if (!entity) {
        return { ok: false, code: "conflict.unknown_required_field", entityId: operation.entityId };
      }
      if (operation.type === "insert") entity.index = operation.index + 1;
      else if (operation.type === "delete") entity.index = Math.max(0, entity.index - 1);
      const entry = { head: assignedHead, opIndex, operation };
      logEntries.push(entry);
      const entityLog = workingSet.opsByEntity.get(operation.entityId) || [];
      entityLog.push(entry);
      workingSet.opsByEntity.set(operation.entityId, entityLog);
    }
    workingSet.opsByHead.set(assignedHead, logEntries);
    return { ok: true, changed };
  }

  async function open(input: WorkingSetInput = {}): Promise<OpenResponse> {
    const workingSetId = String(input.workingSetId || "").trim();
    const entitySpecs = Array.isArray(input.entities) && input.entities.length > 0
      ? input.entities
      : uniqueStrings(input.entityIds).map((entityId) => ({ entityId, kind: "document-state" }));
    if (!workingSetId || entitySpecs.length === 0 || entitySpecs.length > limits.maxEntitiesPerWorkingSet) {
      throw new TypeError("Core Change Set open requires a bounded working set.");
    }
    const entityIds = uniqueStrings(entitySpecs.map((entry) => asObject(entry).entityId || entry));
    if (entityIds.length !== entitySpecs.length) {
      throw new TypeError("Core Change Set entity identities must be stable and unique.");
    }
    const handles: Array<{ handle: string; entityId: string }> = [];
    const entityById = new Map<string, EntityState>();
    const handleMap = new Map<string, string>();
    entitySpecs.forEach((spec, index) => {
      const entitySpec = asObject(spec);
      const entityId = entityIds[index];
      if (!entityId) throw new TypeError("Core Change Set entity identity is missing.");
      const handle = String(entitySpec.handle || `hdl_ccs_${index + 1}`);
      handleMap.set(handle, entityId);
      entityById.set(entityId, {
        kind: String(entitySpec.kind || "document-state"),
        index: 0,
        resourceUri: resourceUriFor(workingSetId, entityId)
      });
      handles.push({ handle, entityId });
    });
    const authorization = asObject(input.authorization);
    const workingSet: WorkingSetStore = {
      workingSetId,
      head: 0,
      entityIds,
      handles: handleMap,
      entityById,
      opsByEntity: new Map<string, OperationLogEntry[]>(entityIds.map((entityId) => [entityId, []])),
      opsByHead: new Map<number, OperationLogEntry[]>(),
      historyByHead: new Map<number, HistoryEntry>(),
      historyHeads: [],
      changeResults: new Map<string, Acknowledge>(),
      snapshotsByHead: new Map<number, SnapshotRecord>(),
      snapshotHeads: [],
      cursors: new Map<string, number>(),
      subscribersByUri: new Map<string, Set<string>>(),
      subscriberById: new Map<string, { resourceUri: string }>(),
      catalogRevision: "cat.ccs.1",
      schemaRevision: "sch.ccs.1",
      catalogSize: asSafeInteger(input.catalogSize),
      connectedClients: asSafeInteger(input.connectedClients),
      auth: {
        principalRef: asString(authorization.principalRef || defaultAuth.principalRef),
        grantRef: asString(authorization.grantRef || defaultAuth.grantRef),
        resourceRef: asString(authorization.resourceRef || defaultAuth.resourceRef),
        policyRef: asString(authorization.policyRef || defaultAuth.policyRef),
        audienceRef: asString(authorization.audienceRef || defaultAuth.audienceRef),
        requestRef: asString(authorization.requestRef || defaultAuth.requestRef),
        generation: asSafeInteger(authorization.generation, defaultAuth.generation),
        revoked: authorization.revoked === true || defaultAuth.revoked
      }
    };
    counters.catalogSize = workingSet.catalogSize;
    counters.connectedClients = workingSet.connectedClients;
    cursorSeq += 1;
    const cursor = currentCursor(workingSet, cursorSeq);
    commitSnapshot(workingSet);
    workingSets.set(workingSetId, workingSet);
    const opened = freezeMessage(createOpenResponse({
      workingSetId,
      entityIds,
      handles,
      head: 0,
      resourceLinks: entityIds.map((entityId) => ({
        uri: resourceUriFor(workingSetId, entityId),
        head: 0,
        cacheHint: PRIVATE_CACHE_HINT
      })),
      cacheHint: PRIVATE_CACHE_HINT,
      cursor
    }));
    const auth = resolveAuthorization(asObject(input.lookup), workingSet);
    if (auth.ok !== true) {
      workingSets.delete(workingSetId);
      throw new Error("Core Change Set open denied by current authorization.");
    }
    return opened;
  }

  async function observe(input: WorkingSetInput = {}): Promise<ObserveResponse> {
    return withWorkingSet(input.workingSetId, (workingSet) => {
      const auth = resolveAuthorization(asObject(input.lookup), workingSet);
      const entityId = entityIdForHandle(workingSet, input.handle);
      if (auth.ok !== true || !entityId) {
        const error = Object.assign(new Error("Core Change Set observe denied by current authorization."), {
          code: auth.ok === true ? "conflict.authorization_changed" : auth.code
        });
        throw error;
      }
      const history = workingSet.historyHeads.map((head) => {
        const entry = workingSet.historyByHead.get(head);
        if (!entry) throw new Error("Core Change Set history index is inconsistent.");
        return entry;
      });
      const acknowledgements = history.map((entry) => ({
        head: entry.head,
        changeId: entry.changeId
      }));
      return freezeMessage(createObserveResponse({
        workingSetId: workingSet.workingSetId,
        head: workingSet.head,
        resourceLinks: workingSet.entityIds.map((id) => ({
          uri: resourceUriFor(workingSet.workingSetId, id),
          head: workingSet.head,
          cacheHint: PRIVATE_CACHE_HINT
        })),
        catalogRevision: workingSet.catalogRevision,
        schemaRevision: workingSet.schemaRevision,
        acknowledgements,
        history,
        cacheHit: false,
        cacheHint: PRIVATE_CACHE_HINT
      }));
    });
  }

  function asCommitRequest(value: unknown): CommitRequest {
    const input = asObject(value);
    if (input.kind === "commit-request") {
      const parsed = parseCommitRequest(value);
      if (!parsed) throw new TypeError("Commit turn must be a versioned commit request.");
      return parsed;
    }
    return createCommitRequest({
      workingSetId: input.workingSetId,
      handle: input.handle,
      dirty: input.dirty === true,
      changeSet: input.changeSet
    });
  }

  async function commitTurn(value: Record<string, unknown> = {}, lookup: AuthorityLookup = {}): Promise<Acknowledge> {
    const request = asCommitRequest(value);
    assertCommitTurn(request);
    return withWorkingSet(request.workingSetId, (live) => {
      const workingSet = copyWorkingSet(live);
      const auth = resolveAuthorization({ ...lookup, handle: request.handle, cursor: lookup.cursor, priorApproval: lookup.priorApproval }, workingSet);
      const entityId = entityIdForHandle(workingSet, request.handle);
      if (auth.ok !== true) {
        return denyAcknowledge(live, auth.code, entityId || "ent.denied");
      }
      if (!entityId) {
        return denyAcknowledge(live, "conflict.authorization_changed", "ent.denied");
      }
      if (request.dirty !== true) {
        return cleanAcknowledge(live);
      }
      const changeSet = parseChangeSet(request.changeSet);
      if (!changeSet) {
        return denyAcknowledge(live, "conflict.unknown_required_field", entityId);
      }
      if (changeSet.family !== "document-state" || changeSet.visibility !== SERVICE_COLLABORATION_VISIBILITY) {
        return denyAcknowledge(live, "conflict.unknown_required_field", entityId);
      }
      const prior = live.changeResults.get(changeSet.changeId);
      if (prior) {
        counters.duplicateDeliveries += 1;
        return prior;
      }
      const changedIds = uniqueStrings(changeSet.operations.map((entry) => entry.entityId));
      if (changedIds.some((id) => !workingSet.entityById.has(id))) {
        return denyAcknowledge(live, "conflict.unknown_required_field", entityId);
      }
      if (
        changedIds.length > limits.maxResultFacts
        || changedIds.length > limits.maxInvalidations
      ) {
        return denyAcknowledge(live, "conflict.budget_exceeded", entityId);
      }
      if (changeSet.baselineHead > workingSet.head) {
        return denyAcknowledge(live, "conflict.stale_baseline", entityId);
      }
      if (changeSet.baselineHead < earliestCausalHead(workingSet)) {
        return denyAcknowledge(live, "conflict.stale_baseline", entityId);
      }
      counters.scannedEntities += changedIds.length;
      let operations = changeSet.operations;
      if (changeSet.baselineHead < workingSet.head) {
        const intervening = relevantInterveningOperations(
          workingSet,
          changedIds,
          changeSet.baselineHead,
          counters
        );
        const rebased = rebaseOperations(operations, intervening);
        if (rebased.conflicts.length > 0) {
          return freezeMessage(createAcknowledge({
            workingSetId: workingSet.workingSetId,
            assignedHead: live.head,
            changedEntityIds: [],
            resultFacts: [],
            conflicts: rebased.conflicts.map((entry) => ({
              ...entry,
              head: live.head
            })),
            invalidations: []
          }));
        }
        operations = rebased.rebasedOperations;
      }
      const assignedHead = workingSet.head + 1;
      const applied = applyOperations(workingSet, operations, assignedHead);
      if (applied.ok !== true) {
        return denyAcknowledge(live, applied.code, applied.entityId || entityId);
      }
      workingSet.head = assignedHead;
      const historyEntry = Object.freeze({
        head: assignedHead,
        changeId: changeSet.changeId,
        entityIds: applied.changed
      });
      workingSet.historyByHead.set(assignedHead, historyEntry);
      workingSet.historyHeads.push(assignedHead);
      cursorSeq += 1;
      currentCursor(workingSet, cursorSeq);
      commitSnapshot(workingSet);
      dropOldest(workingSet, limits.maxHistoryEntries);
      const resourceUris = applied.changed.map((id) => resourceUriFor(workingSet.workingSetId, id));
      counters.wakeups += matchingWakeups(workingSet, resourceUris);
      counters.applyCalls += 1;
      counters.changeSetApplyCalls += 1;
      const acknowledgement = freezeMessage(createAcknowledge({
        workingSetId: workingSet.workingSetId,
        assignedHead,
        changedEntityIds: applied.changed,
        resultFacts: applied.changed.map((id) => ({ code: "applied", entityId: id })),
        conflicts: [],
        invalidations: resourceUris.map((uri) => ({
          code: "resource_changed",
          resourceUri: uri
        }))
      }));
      workingSet.changeResults.set(changeSet.changeId, acknowledgement);
      workingSets.set(workingSet.workingSetId, workingSet);
      return acknowledgement;
    });
  }

  async function rebase(input: WorkingSetInput = {}, lookup: AuthorityLookup = {}): Promise<RebaseResponse> {
    return withWorkingSet(input.workingSetId, (workingSet) => {
      const auth = resolveAuthorization(lookup, workingSet);
      const entityId = entityIdForHandle(workingSet, input.handle);
      if (auth.ok !== true) {
        return freezeMessage(createRebaseResponse({
          workingSetId: workingSet.workingSetId,
          head: workingSet.head,
          outcome: "conflict",
          rebasedOperations: [],
          conflicts: [conflictFact(auth.code, entityId || "ent.denied", workingSet.head)],
          cursor: Object.freeze({
            cursor: `cur.ccs.${cursorSeq || 1}`,
            indexedHead: workingSet.head,
            cursorState: "valid"
          })
        }));
      }
      const operationInputs = Array.isArray(input.operations) ? input.operations : [];
      const operations = operationInputs.map((entry) => createCoreChangeSetOperation(asObject(entry)));
      const entityIds = uniqueStrings(operations.map((entry) => entry.entityId));
      const baselineHead = asSafeInteger(input.baselineHead);
      const intervening = baselineHead < workingSet.head
        ? relevantInterveningOperations(workingSet, entityIds, baselineHead, counters)
        : [];
      const rebased = rebaseOperations(operations, intervening);
      cursorSeq += 1;
      const cursor = currentCursor(copyWorkingSet(workingSet), cursorSeq);
      return freezeMessage(createRebaseResponse({
        workingSetId: workingSet.workingSetId,
        head: workingSet.head,
        outcome: rebased.conflicts.length > 0 ? "conflict" : "rebased",
        rebasedOperations: rebased.conflicts.length > 0 ? [] : rebased.rebasedOperations,
        conflicts: rebased.conflicts.map((entry) => ({ ...entry, head: workingSet.head })),
        cursor
      }));
    });
  }

  function cursorRecord(workingSet: WorkingSetStore, cursor: unknown): { state: CursorState; indexedHead: number } {
    const cursorInput = asObject(cursor);
    const token = String(cursorInput.cursor || "");
    if (!token || !workingSet.cursors.has(token)) {
      return { state: "expired", indexedHead: Number(cursorInput.indexedHead || 0) };
    }
    const indexedHead = workingSet.cursors.get(token);
    if (indexedHead === undefined) return { state: "expired", indexedHead: 0 };
    if (indexedHead < earliestCausalHead(workingSet) && indexedHead !== workingSet.head) {
      return { state: "expired", indexedHead };
    }
    return { state: "valid", indexedHead };
  }

  function deltasFrom(workingSet: WorkingSetStore, fromHead: number) {
    const deltas: Array<{ head: number; opIndex: number; operation: ChangeSetOperation }> = [];
    for (const head of workingSet.historyHeads) {
      if (head <= fromHead) continue;
      const entries = workingSet.opsByHead.get(head) || [];
      for (const entry of entries) {
        deltas.push({
          head: entry.head,
          opIndex: entry.opIndex,
          operation: entry.operation
        });
        if (deltas.length >= limits.maxDeltaPage) return deltas;
      }
    }
    return deltas;
  }

  async function resync(input: WorkingSetInput = {}, lookup: AuthorityLookup = {}): Promise<ResyncResponse> {
    return withWorkingSet(input.workingSetId, (workingSet) => {
      const auth = resolveAuthorization(lookup, workingSet);
      if (auth.ok !== true) {
        const cursorInput = asObject(input.cursor);
        return freezeMessage(createResyncResponse({
          workingSetId: workingSet.workingSetId,
          outcome: "cancelled",
          head: workingSet.head,
          deltas: [],
          snapshot: null,
          tail: [],
          cursor: Object.freeze({
            cursor: String(cursorInput.cursor || `cur.ccs.${cursorSeq || 1}`),
            indexedHead: workingSet.head,
            cursorState: "valid"
          })
        }));
      }
      const record = cursorRecord(workingSet, input.cursor);
      if (record.state === "valid") {
        cursorSeq += 1;
        const cursor = currentCursor(copyWorkingSet(workingSet), cursorSeq);
        return freezeMessage(createResyncResponse({
          workingSetId: workingSet.workingSetId,
          outcome: "delta",
          head: workingSet.head,
          deltas: deltasFrom(workingSet, record.indexedHead),
          snapshot: null,
          tail: [],
          cursor
        }));
      }
      const snapshotHead = workingSet.snapshotHeads[0] ?? workingSet.head;
      const snapshot = workingSet.snapshotsByHead.get(snapshotHead) || mintSnapshot(workingSet, snapshotSeq + 1);
      const tail: ChangeSetOperation[] = [];
      for (const head of workingSet.historyHeads) {
        if (head <= snapshot.head) continue;
        const entries = workingSet.opsByHead.get(head) || [];
        for (const entry of entries) {
          tail.push(entry.operation);
          if (tail.length >= limits.maxTailOps) break;
        }
        if (tail.length >= limits.maxTailOps) break;
      }
      const cursorInput = asObject(input.cursor);
      const expiredCursor = Object.freeze({
        cursor: String(cursorInput.cursor || `cur.expired.${workingSet.workingSetId}`),
        indexedHead: record.indexedHead,
        cursorState: "expired"
      });
      return freezeMessage(createResyncResponse({
        workingSetId: workingSet.workingSetId,
        outcome: "snapshot-tail",
        head: workingSet.head,
        deltas: [],
        snapshot,
        tail,
        cursor: expiredCursor
      }));
    });
  }

  async function subscribe(input: WorkingSetInput = {}, lookup: AuthorityLookup = {}): Promise<SubscriptionResult> {
    return withWorkingSet(input.workingSetId, (workingSet) => {
      const auth = resolveAuthorization(lookup, workingSet);
      if (auth.ok !== true) return { ok: false, code: auth.code };
      const uri = String(input.resourceUri || "");
      if (![...workingSet.entityById.values()].some((entity) => entity.resourceUri === uri)) {
        return { ok: false, code: "conflict.unknown_required_field" };
      }
      subscriberSeq += 1;
      const subscriberId = `sub.ccs.${subscriberSeq}`;
      const bucket = workingSet.subscribersByUri.get(uri) || new Set<string>();
      bucket.add(subscriberId);
      workingSet.subscribersByUri.set(uri, bucket);
      workingSet.subscriberById.set(subscriberId, { resourceUri: uri });
      counters.subscriptionPeak = Math.max(counters.subscriptionPeak, workingSet.subscriberById.size);
      return Object.freeze({
        ok: true,
        subscriberId,
        method: SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD,
        authorizationReResolved: true
      });
    });
  }

  function seedDecoys(input: WorkingSetInput = {}): Readonly<{ catalogSize: number; connectedClients: number }> {
    const workingSet = requireWorkingSet(input.workingSetId);
    if (typeof input.catalogSize === "number" && Number.isSafeInteger(input.catalogSize)) {
      workingSet.catalogSize = input.catalogSize;
      counters.catalogSize = input.catalogSize;
    }
    if (typeof input.connectedClients === "number" && Number.isSafeInteger(input.connectedClients)) {
      workingSet.connectedClients = input.connectedClients;
      counters.connectedClients = input.connectedClients;
    }
    return Object.freeze({
      catalogSize: workingSet.catalogSize,
      connectedClients: workingSet.connectedClients
    });
  }

  function revoke(workingSetId?: unknown): boolean {
    requireWorkingSet(workingSetId).auth.revoked = true;
    return true;
  }

  function advanceGeneration(workingSetId?: unknown): number {
    const workingSet = requireWorkingSet(workingSetId);
    workingSet.auth.generation += 1;
    return workingSet.auth.generation;
  }

  function snapshotCounters(): Readonly<AuthorityCounters> {
    return Object.freeze({ ...counters });
  }

  function inspect(workingSetId?: unknown): Readonly<Record<string, unknown>> {
    const workingSet = requireWorkingSet(workingSetId);
    const lastCursorEntry = [...workingSet.cursors].at(-1) || null;
    return Object.freeze({
      workingSetId: workingSet.workingSetId,
      head: workingSet.head,
      entityCount: workingSet.entityIds.length,
      historyCount: workingSet.historyHeads.length,
      snapshotCount: workingSet.snapshotHeads.length,
      catalogSize: workingSet.catalogSize,
      connectedClients: workingSet.connectedClients,
      subscriberCount: workingSet.subscriberById.size,
      changeIdCount: workingSet.changeResults.size,
      lastCursor: lastCursorEntry
        ? Object.freeze({
          cursor: lastCursorEntry[0],
          indexedHead: lastCursorEntry[1],
          cursorState: "valid"
        })
        : null
    });
  }

  function notificationFor(workingSetId?: unknown, entityId?: unknown): ResourceUpdatedNotification {
    const workingSet = requireWorkingSet(workingSetId);
    cursorSeq += 1;
    return freezeMessage(createResourceUpdatedNotification({
      resourceUri: resourceUriFor(asString(workingSetId), asString(entityId)),
      head: workingSet.head,
      cursor: currentCursor(copyWorkingSet(workingSet), cursorSeq),
      cacheHint: PRIVATE_CACHE_HINT,
      invalidationCodes: ["resource_changed"]
    }));
  }

  function close(): boolean {
    workingSets.clear();
    Object.assign(counters, emptyCounters());
    return true;
  }

  return Object.freeze({
    id: CORE_CHANGE_SET_AUTHORITY_ID,
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    open,
    observe,
    commitTurn,
    rebase,
    resync,
    subscribe,
    seedDecoys,
    revoke,
    advanceGeneration,
    snapshotCounters,
    inspect,
    notificationFor,
    rejectEffectCommand,
    close
  });
}

function isCommitAuthority(value: unknown): value is Pick<CoreChangeSetAuthority, "id" | "commitTurn"> {
  return isRecord(value)
    && value.id === CORE_CHANGE_SET_AUTHORITY_ID
    && typeof value.commitTurn === "function";
}

export function bindWorkspaceChangeSetSeam(authority?: unknown) {
  if (!isCommitAuthority(authority)) {
    throw new TypeError("Workspace Change Set seam requires the Core Change Set authority.");
  }
  return Object.freeze({
    commitFileTurn(value: Record<string, unknown> = {}, lookup: AuthorityLookup = {}): Promise<Acknowledge> {
      return authority.commitTurn(value, lookup);
    }
  });
}

export function bindJobChangeSetSeam(authority?: unknown) {
  if (!isCommitAuthority(authority)) {
    throw new TypeError("Job Change Set seam requires the Core Change Set authority.");
  }
  return Object.freeze({
    commitJobTurn(value: Record<string, unknown> = {}, lookup: AuthorityLookup = {}): Promise<Acknowledge> {
      return authority.commitTurn(value, lookup);
    }
  });
}

export default createCoreChangeSetAuthority;
