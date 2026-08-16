import crypto from "node:crypto";
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

export const CORE_CHANGE_SET_AUTHORITY_ID: any = "CoreChangeSetAuthority";
export const CORE_CHANGE_SET_REPORT_SCHEMA_VERSION: any = "v0.0.1:core-change-set:report-1";
export const CORE_CHANGE_SET_NON_CERTIFICATION_REASON: any = "owner_profile_not_authorized";
export const CORE_CHANGE_SET_DEFAULT_DIGEST: any =
  "sha256:abababababababababababababababababababababababababababababababab";

const PRIVATE_CACHE_HINT: any = Object.freeze({
  ttlMs: 60_000,
  cacheScope: "private"
});

let factorySeq: any = 0;

function emptyCounters() : any {
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

function freezeMessage(value?: any) : any {
  if (containsForbiddenKeys(value)) {
    throw new Error("Core Change Set output cannot carry privacy or CRDT fields.");
  }
  assertOneCoreStateGeneration(value);
  return value;
}

function asObject(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function uniqueStrings(value: any = []) : any {
  return [...new Set<any>((Array.isArray(value) ? value : []).map((entry?: any) : any => String(entry || "").trim()).filter(Boolean))];
}

function resourceUriFor(workingSetId?: any, entityId?: any) : any {
  return `meshrix://collaboration/${workingSetId}/${entityId}`;
}

function conflictFact(code?: any, entityId?: any, head: any = 0) : any {
  return { code, entityId, head };
}

export function createCoreChangeSetOperation(value: Record<string, any> = {}) : any {
  const index: any = Number.isSafeInteger(value.index) && value.index >= 0 ? value.index : 0;
  const parsed: any = parseOperation({
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

export function createCoreChangeSet(value: Record<string, any> = {}) : any {
  return createChangeSet({
    changeId: value.changeId,
    baselineHead: value.baselineHead,
    operations: (value.operations || []).map((entry?: any) : any => createCoreChangeSetOperation(entry)),
    attributionRef: value.attributionRef
  });
}

function copyWorkingSet(workingSet?: any) : any {
  const opsByEntity: any = new Map<any, any>();
  for (const [entityId, entries] of workingSet.opsByEntity) {
    opsByEntity.set(entityId, entries.map((entry?: any) : any => ({ ...entry })));
  }
  const opsByHead: any = new Map<any, any>();
  for (const [head, entries] of workingSet.opsByHead) {
    opsByHead.set(head, entries.map((entry?: any) : any => ({ ...entry })));
  }
  const entityById: any = new Map<any, any>();
  for (const [entityId, entity] of workingSet.entityById) {
    entityById.set(entityId, { ...entity });
  }
  return {
    workingSetId: workingSet.workingSetId,
    head: workingSet.head,
    entityIds: [...workingSet.entityIds],
    handles: new Map<any, any>(workingSet.handles),
    entityById,
    opsByEntity,
    opsByHead,
    historyByHead: new Map<any, any>(workingSet.historyByHead),
    historyHeads: [...workingSet.historyHeads],
    changeResults: new Map<any, any>(workingSet.changeResults),
    snapshotsByHead: new Map<any, any>(workingSet.snapshotsByHead),
    snapshotHeads: [...workingSet.snapshotHeads],
    cursors: new Map<any, any>(workingSet.cursors),
    subscribersByUri: new Map<any, any>(
      [...workingSet.subscribersByUri].map(([uri, ids]: any[]) : any => [uri, new Set<any>(ids)])
    ),
    subscriberById: new Map<any, any>(workingSet.subscriberById),
    catalogRevision: workingSet.catalogRevision,
    schemaRevision: workingSet.schemaRevision,
    catalogSize: workingSet.catalogSize,
    connectedClients: workingSet.connectedClients,
    auth: { ...workingSet.auth }
  };
}

function dropOldest(workingSet?: any, maxHistoryEntries?: any) : any {
  while (workingSet.historyHeads.length > maxHistoryEntries) {
    const oldest: any = workingSet.historyHeads.shift();
    workingSet.historyByHead.delete(oldest);
    workingSet.opsByHead.delete(oldest);
    for (const [entityId, entries] of workingSet.opsByEntity) {
      workingSet.opsByEntity.set(entityId, entries.filter((entry?: any) : any => entry.head !== oldest));
    }
  }
  while (workingSet.snapshotHeads.length > maxHistoryEntries) {
    const oldestSnapshot: any = workingSet.snapshotHeads.shift();
    workingSet.snapshotsByHead.delete(oldestSnapshot);
  }
}

function mintSnapshot(workingSet?: any, snapshotSeq?: any) : any {
  const snapshotId: any = `snap.ccs.${snapshotSeq}`;
  const entityIds: any = [...workingSet.entityIds];
  const resourceUris: any = entityIds.map((entityId?: any) : any => resourceUriFor(workingSet.workingSetId, entityId));
  const provisional: any = {
    snapshotId,
    head: workingSet.head,
    entityIds,
    resourceUris,
    byteLength: 0
  };
  provisional.byteLength = Buffer.byteLength(JSON.stringify(provisional), "utf8");
  return Object.freeze(provisional);
}

function currentCursor(workingSet?: any, cursorSeq?: any, cursorState: any = "valid") : any {
  const token: any = `cur.ccs.${cursorSeq}`;
  const cursor: any = Object.freeze({
    cursor: token,
    indexedHead: workingSet.head,
    cursorState
  });
  if (cursorState === "valid") workingSet.cursors.set(token, workingSet.head);
  return cursor;
}

function relevantInterveningOperations(workingSet?: any, entityIds?: any, baselineHead?: any, counters?: any) : any {
  const collected: any[] = [];
  for (const entityId of entityIds) {
    const entries: any = workingSet.opsByEntity.get(entityId) || [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry: any = entries[index];
      if (entry.head <= baselineHead) break;
      collected.push(entry);
      counters.relevantOperations += 1;
      counters.indexedStatements += 1;
    }
  }
  collected.sort((left?: any, right?: any) : any => left.head - right.head || left.opIndex - right.opIndex);
  return collected.map((entry?: any) : any => entry.operation);
}

function earliestCausalHead(workingSet?: any) : any {
  if (workingSet.historyHeads.length === 0) return 0;
  return Math.max(0, workingSet.historyHeads[0] - 1);
}

function matchingWakeups(workingSet?: any, resourceUris?: any) : any {
  let wakeups: any = 0;
  for (const uri of resourceUris) {
    wakeups += workingSet.subscribersByUri.get(uri)?.size || 0;
  }
  return wakeups;
}

function denyAcknowledge(workingSet?: any, code?: any, entityId?: any) : any {
  return freezeMessage(createAcknowledge({
    workingSetId: workingSet.workingSetId,
    assignedHead: workingSet.head,
    changedEntityIds: [],
    resultFacts: [],
    conflicts: [conflictFact(code, entityId, workingSet.head)],
    invalidations: []
  }));
}

function cleanAcknowledge(workingSet?: any) : any {
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
  before: Record<string, any> = {},
  after: Record<string, any> = {},
  expected: Record<string, any> = {}
) : any {
  const scanned: any = after.scannedEntities - before.scannedEntities;
  const relevant: any = after.relevantOperations - before.relevantOperations;
  const catalogDelta: any = after.catalogSize - before.catalogSize;
  const clientDelta: any = after.connectedClients - before.connectedClients;
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
  if (expected.wakeups != null && after.wakeups - before.wakeups !== expected.wakeups) {
    throw new Error("Subscriber wakeups must match changed Resource identities only.");
  }
  return true;
}

export function rejectEffectCommand(_value?: any) : any {
  throw new Error("Effect Commands are a separate family from Core Change Set authority.");
}

export function createCoreChangeSetAuthority(options: Record<string, any> = {}) : any {
  factorySeq += 1;
  const instanceId: any = String(options.instanceId || `ccs.${factorySeq}`);
  const limits: any = {
    ...SERVICE_COLLABORATION_LIMITS,
    ...asObject(options.limits)
  };
  const workingSets: any = new Map<any, any>();
  const counters: any = emptyCounters();
  let cursorSeq: any = 0;
  let snapshotSeq: any = 0;
  let subscriberSeq: any = 0;
  const defaultAuth: any = {
    principalRef: options.principalRef || "prin.ccs.1",
    grantRef: options.grantRef || "gr.ccs.1",
    resourceRef: options.resourceRef || "res.ccs.1",
    policyRef: options.policyRef || "pol.ccs.1",
    audienceRef: options.audienceRef || "aud.ccs.1",
    requestRef: options.requestRef || "req.ccs.1",
    generation: Number.isSafeInteger(options.generation) ? options.generation : 1,
    revoked: false
  };

  function laneKey(workingSetId?: any) : any {
    return `core-change-set:${instanceId}:${workingSetId}`;
  }

  function requireWorkingSet(workingSetId?: any) : any {
    const workingSet: any = workingSets.get(workingSetId);
    if (!workingSet) {
      throw new Error("Core Change Set working set is not open.");
    }
    return workingSet;
  }

  function resolveAuthorization(lookup: Record<string, any> = {}, workingSet?: any) : any {
    counters.authorizationReResolved += 1;
    for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
      if (lookupFactIsAuthority(fact) === true) {
        return { ok: false, code: "conflict.authorization_changed" };
      }
    }
    if (SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED !== false) {
      return { ok: false, code: "conflict.second_core_generation" };
    }
    const resolver: any = options.resolveAuthorization;
    if (typeof resolver === "function") {
      const resolved: any = resolver(lookup, workingSet.auth);
      if (resolved?.ok === true) return resolved;
      return { ok: false, code: resolved?.code || "conflict.authorization_changed" };
    }
    if (workingSet.auth.revoked === true) {
      return { ok: false, code: "conflict.authorization_changed" };
    }
    const principalRef: any = lookup.principalRef || workingSet.auth.principalRef;
    const grantRef: any = lookup.grantRef || workingSet.auth.grantRef;
    const resourceRef: any = lookup.resourceRef || workingSet.auth.resourceRef;
    const policyRef: any = lookup.policyRef || workingSet.auth.policyRef;
    const generation: any = lookup.generation == null ? workingSet.auth.generation : lookup.generation;
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

  function entityIdForHandle(workingSet?: any, handle?: any) : any {
    return workingSet.handles.get(handle) || "";
  }

  async function withWorkingSet(workingSetId?: any, task?: any) : Promise<any> {
    return queueStateMutation(laneKey(workingSetId), () : any => task(requireWorkingSet(workingSetId)));
  }

  function commitSnapshot(workingSet?: any) : any {
    snapshotSeq += 1;
    const snapshot: any = mintSnapshot(workingSet, snapshotSeq);
    workingSet.snapshotsByHead.set(workingSet.head, snapshot);
    workingSet.snapshotHeads.push(workingSet.head);
    counters.snapshotPeak = Math.max(counters.snapshotPeak, workingSet.snapshotHeads.length);
    return snapshot;
  }

  function applyOperations(workingSet?: any, operations?: any, assignedHead?: any) : any {
    const changed: any = uniqueStrings(operations.map((entry?: any) : any => entry.entityId));
    const logEntries: any[] = [];
    for (let opIndex = 0; opIndex < operations.length; opIndex += 1) {
      const operation: any = operations[opIndex];
      const entity: any = workingSet.entityById.get(operation.entityId);
      if (!entity) {
        return { ok: false, code: "conflict.unknown_required_field", entityId: operation.entityId };
      }
      if (operation.type === "insert") entity.index = operation.index + 1;
      else if (operation.type === "delete") entity.index = Math.max(0, entity.index - 1);
      const entry: any = { head: assignedHead, opIndex, operation };
      logEntries.push(entry);
      const entityLog: any = workingSet.opsByEntity.get(operation.entityId) || [];
      entityLog.push(entry);
      workingSet.opsByEntity.set(operation.entityId, entityLog);
    }
    workingSet.opsByHead.set(assignedHead, logEntries);
    return { ok: true, changed };
  }

  async function open(input: Record<string, any> = {}) : Promise<any> {
    const workingSetId: any = String(input.workingSetId || "").trim();
    const entitySpecs: any = Array.isArray(input.entities) && input.entities.length > 0
      ? input.entities
      : uniqueStrings(input.entityIds).map((entityId?: any) : any => ({ entityId, kind: "document-state" }));
    if (!workingSetId || entitySpecs.length === 0 || entitySpecs.length > limits.maxEntitiesPerWorkingSet) {
      throw new TypeError("Core Change Set open requires a bounded working set.");
    }
    const entityIds: any = uniqueStrings(entitySpecs.map((entry?: any) : any => entry.entityId || entry));
    if (entityIds.length !== entitySpecs.length) {
      throw new TypeError("Core Change Set entity identities must be stable and unique.");
    }
    const handles: any[] = [];
    const entityById: any = new Map<any, any>();
    const handleMap: any = new Map<any, any>();
    entitySpecs.forEach((spec?: any, index?: any) : any => {
      const entityId: any = entityIds[index];
      const handle: any = String(spec.handle || `hdl_ccs_${index + 1}`);
      handleMap.set(handle, entityId);
      entityById.set(entityId, {
        kind: spec.kind || "document-state",
        index: 0,
        resourceUri: resourceUriFor(workingSetId, entityId)
      });
      handles.push({ handle, entityId });
    });
    const workingSet: any = {
      workingSetId,
      head: 0,
      entityIds,
      handles: handleMap,
      entityById,
      opsByEntity: new Map<any, any>(entityIds.map((entityId?: any) : any => [entityId, []])),
      opsByHead: new Map<any, any>(),
      historyByHead: new Map<any, any>(),
      historyHeads: [],
      changeResults: new Map<any, any>(),
      snapshotsByHead: new Map<any, any>(),
      snapshotHeads: [],
      cursors: new Map<any, any>(),
      subscribersByUri: new Map<any, any>(),
      subscriberById: new Map<any, any>(),
      catalogRevision: "cat.ccs.1",
      schemaRevision: "sch.ccs.1",
      catalogSize: Number.isSafeInteger(input.catalogSize) ? input.catalogSize : 0,
      connectedClients: Number.isSafeInteger(input.connectedClients) ? input.connectedClients : 0,
      auth: { ...defaultAuth, ...asObject(input.authorization) }
    };
    counters.catalogSize = workingSet.catalogSize;
    counters.connectedClients = workingSet.connectedClients;
    cursorSeq += 1;
    const cursor: any = currentCursor(workingSet, cursorSeq);
    commitSnapshot(workingSet);
    workingSets.set(workingSetId, workingSet);
    const opened: any = freezeMessage(createOpenResponse({
      workingSetId,
      entityIds,
      handles,
      head: 0,
      resourceLinks: entityIds.map((entityId?: any) : any => ({
        uri: resourceUriFor(workingSetId, entityId),
        head: 0,
        cacheHint: PRIVATE_CACHE_HINT
      })),
      cacheHint: PRIVATE_CACHE_HINT,
      cursor
    }));
    const auth: any = resolveAuthorization(input.lookup || {}, workingSet);
    if (auth.ok !== true) {
      workingSets.delete(workingSetId);
      throw new Error("Core Change Set open denied by current authorization.");
    }
    return opened;
  }

  async function observe(input: Record<string, any> = {}) : Promise<any> {
    return withWorkingSet(input.workingSetId, (workingSet?: any) : any => {
      const auth: any = resolveAuthorization(input.lookup || {}, workingSet);
      const entityId: any = entityIdForHandle(workingSet, input.handle);
      if (auth.ok !== true || !entityId) {
        const error: any = new Error("Core Change Set observe denied by current authorization.");
        error.code = auth.ok === true ? "conflict.authorization_changed" : auth.code;
        throw error;
      }
      const history: any = workingSet.historyHeads.map((head?: any) : any => workingSet.historyByHead.get(head));
      const acknowledgements: any = history.map((entry?: any) : any => ({
        head: entry.head,
        changeId: entry.changeId
      }));
      return freezeMessage(createObserveResponse({
        workingSetId: workingSet.workingSetId,
        head: workingSet.head,
        resourceLinks: workingSet.entityIds.map((id?: any) : any => ({
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

  function asCommitRequest(value?: any) : any {
    if (value?.kind === "commit-request") {
      const parsed: any = parseCommitRequest(value);
      if (!parsed) throw new TypeError("Commit turn must be a versioned commit request.");
      return parsed;
    }
    return createCommitRequest({
      workingSetId: value.workingSetId,
      handle: value.handle,
      dirty: value.dirty === true,
      changeSet: value.changeSet
    });
  }

  async function commitTurn(value: Record<string, any> = {}, lookup: Record<string, any> = {}) : Promise<any> {
    const request: any = asCommitRequest(value);
    assertCommitTurn(request);
    return withWorkingSet(request.workingSetId, (live?: any) : any => {
      const workingSet: any = copyWorkingSet(live);
      const auth: any = resolveAuthorization({ ...lookup, handle: request.handle, cursor: lookup.cursor, priorApproval: lookup.priorApproval }, workingSet);
      const entityId: any = entityIdForHandle(workingSet, request.handle);
      if (auth.ok !== true) {
        return denyAcknowledge(live, auth.code, entityId || "ent.denied");
      }
      if (!entityId) {
        return denyAcknowledge(live, "conflict.authorization_changed", "ent.denied");
      }
      if (request.dirty !== true) {
        return cleanAcknowledge(live);
      }
      const changeSet: any = parseChangeSet(request.changeSet);
      if (!changeSet) {
        return denyAcknowledge(live, "conflict.unknown_required_field", entityId);
      }
      if (changeSet.family !== "document-state" || changeSet.visibility !== SERVICE_COLLABORATION_VISIBILITY) {
        return denyAcknowledge(live, "conflict.unknown_required_field", entityId);
      }
      const prior: any = live.changeResults.get(changeSet.changeId);
      if (prior) {
        counters.duplicateDeliveries += 1;
        return prior;
      }
      const changedIds: any = uniqueStrings(changeSet.operations.map((entry?: any) : any => entry.entityId));
      if (changedIds.some((id?: any) : any => !workingSet.entityById.has(id))) {
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
      let operations: any = changeSet.operations;
      if (changeSet.baselineHead < workingSet.head) {
        const intervening: any = relevantInterveningOperations(
          workingSet,
          changedIds,
          changeSet.baselineHead,
          counters
        );
        const rebased: any = rebaseOperations(operations, intervening);
        if (rebased.conflicts.length > 0) {
          return freezeMessage(createAcknowledge({
            workingSetId: workingSet.workingSetId,
            assignedHead: live.head,
            changedEntityIds: [],
            resultFacts: [],
            conflicts: rebased.conflicts.map((entry?: any) : any => ({
              ...entry,
              head: live.head
            })),
            invalidations: []
          }));
        }
        operations = rebased.rebasedOperations;
      }
      const assignedHead: any = workingSet.head + 1;
      const applied: any = applyOperations(workingSet, operations, assignedHead);
      if (applied.ok !== true) {
        return denyAcknowledge(live, applied.code, applied.entityId || entityId);
      }
      workingSet.head = assignedHead;
      const historyEntry: any = Object.freeze({
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
      const resourceUris: any = applied.changed.map((id?: any) : any => resourceUriFor(workingSet.workingSetId, id));
      counters.wakeups += matchingWakeups(workingSet, resourceUris);
      counters.applyCalls += 1;
      counters.changeSetApplyCalls += 1;
      const acknowledgement: any = freezeMessage(createAcknowledge({
        workingSetId: workingSet.workingSetId,
        assignedHead,
        changedEntityIds: applied.changed,
        resultFacts: applied.changed.map((id?: any) : any => ({ code: "applied", entityId: id })),
        conflicts: [],
        invalidations: resourceUris.map((uri?: any) : any => ({
          code: "resource_changed",
          resourceUri: uri
        }))
      }));
      workingSet.changeResults.set(changeSet.changeId, acknowledgement);
      workingSets.set(workingSet.workingSetId, workingSet);
      return acknowledgement;
    });
  }

  async function rebase(input: Record<string, any> = {}, lookup: Record<string, any> = {}) : Promise<any> {
    return withWorkingSet(input.workingSetId, (workingSet?: any) : any => {
      const auth: any = resolveAuthorization(lookup, workingSet);
      const entityId: any = entityIdForHandle(workingSet, input.handle);
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
      const operations: any = (input.operations || []).map((entry?: any) : any => createCoreChangeSetOperation(entry));
      const entityIds: any = uniqueStrings(operations.map((entry?: any) : any => entry.entityId));
      const intervening: any = input.baselineHead < workingSet.head
        ? relevantInterveningOperations(workingSet, entityIds, input.baselineHead, counters)
        : [];
      const rebased: any = rebaseOperations(operations, intervening);
      cursorSeq += 1;
      const cursor: any = currentCursor(copyWorkingSet(workingSet), cursorSeq);
      return freezeMessage(createRebaseResponse({
        workingSetId: workingSet.workingSetId,
        head: workingSet.head,
        outcome: rebased.conflicts.length > 0 ? "conflict" : "rebased",
        rebasedOperations: rebased.conflicts.length > 0 ? [] : rebased.rebasedOperations,
        conflicts: rebased.conflicts.map((entry?: any) : any => ({ ...entry, head: workingSet.head })),
        cursor
      }));
    });
  }

  function cursorRecord(workingSet?: any, cursor?: any) : any {
    const token: any = String(cursor?.cursor || "");
    if (!token || !workingSet.cursors.has(token)) {
      return { state: "expired", indexedHead: Number(cursor?.indexedHead || 0) };
    }
    const indexedHead: any = workingSet.cursors.get(token);
    if (indexedHead < earliestCausalHead(workingSet) && indexedHead !== workingSet.head) {
      return { state: "expired", indexedHead };
    }
    return { state: "valid", indexedHead };
  }

  function deltasFrom(workingSet?: any, fromHead?: any) : any {
    const deltas: any[] = [];
    for (const head of workingSet.historyHeads) {
      if (head <= fromHead) continue;
      const entries: any = workingSet.opsByHead.get(head) || [];
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

  async function resync(input: Record<string, any> = {}, lookup: Record<string, any> = {}) : Promise<any> {
    return withWorkingSet(input.workingSetId, (workingSet?: any) : any => {
      const auth: any = resolveAuthorization(lookup, workingSet);
      const entityId: any = entityIdForHandle(workingSet, input.handle);
      if (auth.ok !== true) {
        return freezeMessage(createResyncResponse({
          workingSetId: workingSet.workingSetId,
          outcome: "cancelled",
          head: workingSet.head,
          deltas: [],
          snapshot: null,
          tail: [],
          cursor: Object.freeze({
            cursor: String(input.cursor?.cursor || `cur.ccs.${cursorSeq || 1}`),
            indexedHead: workingSet.head,
            cursorState: "valid"
          })
        }));
      }
      const record: any = cursorRecord(workingSet, input.cursor);
      if (record.state === "valid") {
        cursorSeq += 1;
        const cursor: any = currentCursor(copyWorkingSet(workingSet), cursorSeq);
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
      const snapshotHead: any = workingSet.snapshotHeads[0] ?? workingSet.head;
      const snapshot: any = workingSet.snapshotsByHead.get(snapshotHead) || mintSnapshot(workingSet, snapshotSeq + 1);
      const tail: any[] = [];
      for (const head of workingSet.historyHeads) {
        if (head <= snapshot.head) continue;
        const entries: any = workingSet.opsByHead.get(head) || [];
        for (const entry of entries) {
          tail.push(entry.operation);
          if (tail.length >= limits.maxTailOps) break;
        }
        if (tail.length >= limits.maxTailOps) break;
      }
      const expiredCursor: any = Object.freeze({
        cursor: String(input.cursor?.cursor || `cur.expired.${workingSet.workingSetId}`),
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

  async function subscribe(input: Record<string, any> = {}, lookup: Record<string, any> = {}) : Promise<any> {
    return withWorkingSet(input.workingSetId, (workingSet?: any) : any => {
      const auth: any = resolveAuthorization(lookup, workingSet);
      if (auth.ok !== true) return { ok: false, code: auth.code };
      const uri: any = String(input.resourceUri || "");
      if (![...workingSet.entityById.values()].some((entity?: any) : any => entity.resourceUri === uri)) {
        return { ok: false, code: "conflict.unknown_required_field" };
      }
      subscriberSeq += 1;
      const subscriberId: any = `sub.ccs.${subscriberSeq}`;
      const bucket: any = workingSet.subscribersByUri.get(uri) || new Set<any>();
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

  function seedDecoys(input: Record<string, any> = {}) : any {
    const workingSet: any = requireWorkingSet(input.workingSetId);
    if (Number.isSafeInteger(input.catalogSize)) {
      workingSet.catalogSize = input.catalogSize;
      counters.catalogSize = input.catalogSize;
    }
    if (Number.isSafeInteger(input.connectedClients)) {
      workingSet.connectedClients = input.connectedClients;
      counters.connectedClients = input.connectedClients;
    }
    return Object.freeze({
      catalogSize: workingSet.catalogSize,
      connectedClients: workingSet.connectedClients
    });
  }

  function revoke(workingSetId?: any) : any {
    requireWorkingSet(workingSetId).auth.revoked = true;
    return true;
  }

  function advanceGeneration(workingSetId?: any) : any {
    const workingSet: any = requireWorkingSet(workingSetId);
    workingSet.auth.generation += 1;
    return workingSet.auth.generation;
  }

  function snapshotCounters() : any {
    return Object.freeze({ ...counters });
  }

  function inspect(workingSetId?: any) : any {
    const workingSet: any = requireWorkingSet(workingSetId);
    const lastCursorEntry: any = [...workingSet.cursors].at(-1) || null;
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

  function notificationFor(workingSetId?: any, entityId?: any) : any {
    const workingSet: any = requireWorkingSet(workingSetId);
    cursorSeq += 1;
    return freezeMessage(createResourceUpdatedNotification({
      resourceUri: resourceUriFor(workingSetId, entityId),
      head: workingSet.head,
      cursor: currentCursor(copyWorkingSet(workingSet), cursorSeq),
      cacheHint: PRIVATE_CACHE_HINT,
      invalidationCodes: ["resource_changed"]
    }));
  }

  function close() : any {
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

export function bindWorkspaceChangeSetSeam(authority?: any) : any {
  if (authority?.id !== CORE_CHANGE_SET_AUTHORITY_ID) {
    throw new TypeError("Workspace Change Set seam requires the Core Change Set authority.");
  }
  return Object.freeze({
    commitFileTurn(value: Record<string, any> = {}, lookup: Record<string, any> = {}) : any {
      return authority.commitTurn(value, lookup);
    }
  });
}

export function bindJobChangeSetSeam(authority?: any) : any {
  if (authority?.id !== CORE_CHANGE_SET_AUTHORITY_ID) {
    throw new TypeError("Job Change Set seam requires the Core Change Set authority.");
  }
  return Object.freeze({
    commitJobTurn(value: Record<string, any> = {}, lookup: Record<string, any> = {}) : any {
      return authority.commitTurn(value, lookup);
    }
  });
}

export default createCoreChangeSetAuthority;
