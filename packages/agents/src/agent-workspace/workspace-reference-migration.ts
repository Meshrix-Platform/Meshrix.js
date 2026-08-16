/*
 * Workspace reference migration: Agent Connector + Core converge through
 * stable Assets, Resources, opaque Handles, one Change Set per dirty turn,
 * delta subscriptions, Suggestions, checkpoints, and restore-as-new-change.
 * Host asset fetches remain outside this collaboration path.
 */

import {
  SERVICE_COLLABORATION_CORE_STATE_GENERATION,
  SERVICE_COLLABORATION_FALLBACK_METHODS,
  SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT,
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  SERVICE_COLLABORATION_PROFILE_METHODS,
  SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD,
  SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED,
  SERVICE_COLLABORATION_SILENT_UNCERTAIN_RETRY,
  SERVICE_COLLABORATION_SUBSCRIBE_METHOD,
  assertCommitTurn,
  assertOneCoreStateGeneration,
  containsForbiddenKeys,
  createCommitRequest,
  createEffectCommand,
  createFallbackDescriptor,
  createSubscribeRequest,
  lookupFactIsAuthority,
  parseAcknowledge,
  parseObserveResponse,
  parseOpenResponse,
  parseResyncResponse,
  selectProtocolPath
} from "@meshrix/contracts/service-collaboration-contract";
import {
  CORE_CHANGE_SET_AUTHORITY_ID,
  CORE_CHANGE_SET_DEFAULT_DIGEST,
  CORE_CHANGE_SET_NON_CERTIFICATION_REASON,
  createCoreChangeSet,
  createCoreChangeSetAuthority,
  createCoreChangeSetOperation,
  rejectEffectCommand
} from "../core-change-set-authority.ts";
import { createAgentWorkspaceChangeSetSeam } from "./agent-workspace-change-set-seam.ts";
import {
  createConnectorWorkingView,
  projectConnectorMcpEnvelope
} from "@meshrix/protocols/mcp/adapter/gateway-installer/connector-working-view";

export const WORKSPACE_REFERENCE_MIGRATION_OWNED_MODULE: any =
  "packages/agents/src/agent-workspace/workspace-reference-migration.ts";
export const WORKSPACE_REFERENCE_MIGRATION_AUTHORITY_ID: any = "WorkspaceReferenceMigration";
export const WORKSPACE_REFERENCE_MIGRATION_SCHEMA_VERSION: any =
  "v0.0.1:workspace-reference-migration:state-1";
export const WORKSPACE_REFERENCE_MIGRATION_REPORT_SCHEMA_VERSION: any =
  "v0.0.1:workspace-reference-migration:report-1";
export const WORKSPACE_REFERENCE_MIGRATION_CAPACITY_CERTIFIED: any = false;
export const WORKSPACE_REFERENCE_MIGRATION_NON_CERTIFICATION_REASON: any =
  CORE_CHANGE_SET_NON_CERTIFICATION_REASON;

const PRIVATE_CACHE_HINT: any = Object.freeze({
  ttlMs: 60_000,
  cacheScope: "private"
});
const EFFECT_KINDS: readonly any[] = Object.freeze([
  "share",
  "unshare",
  "import",
  "export",
  "sandbox-apply",
  "local-directory-mutation"
]);

let factorySeq: any = 0;

function asObject(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function freezeSafe(value?: any) : any {
  if (containsForbiddenKeys(value)) {
    throw new Error("Workspace collaboration output cannot carry privacy or CRDT fields.");
  }
  if (value?.coreStateGeneration) assertOneCoreStateGeneration(value);
  return Object.freeze(value);
}

function opaqueAssetId(index?: any) : any {
  return `ast.wrm.${index}`;
}

function opaqueEntityId(index?: any) : any {
  return `ent.wrm.file.${index}`;
}

function opaqueHandle(index?: any) : any {
  return `hdl_wrm_${index}`;
}

function assertStableIdentity(value?: any) : any {
  const identity: any = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(identity)) {
    throw new TypeError("Workspace collaboration identity must be a stable opaque token.");
  }
  if (identity.includes("/") || identity.includes("\\")) {
    throw new TypeError("Workspace collaboration identity cannot be a filesystem location.");
  }
  return identity;
}

function defaultAssets(input: Record<string, any> = {}) : any {
  const listed: any = Array.isArray(input.assets) && input.assets.length > 0
    ? input.assets
    : [{ assetId: opaqueAssetId(1), kind: "workspace-file" }];
  return listed.map((entry?: any, index?: any) : any => {
    const assetId: any = assertStableIdentity(entry.assetId || opaqueAssetId(index + 1));
    const entityId: any = assertStableIdentity(entry.entityId || opaqueEntityId(index + 1));
    const handle: any = String(entry.handle || opaqueHandle(index + 1));
    if (!/^[A-Za-z0-9_-]{8,64}$/u.test(handle)) {
      throw new TypeError("Workspace collaboration Handle must be opaque.");
    }
    return Object.freeze({
      assetId,
      entityId,
      handle,
      kind: entry.kind || "workspace-file",
      resourceRef: entry.resourceRef || `res.wrm.${index + 1}`
    });
  });
}

export function createWorkspaceFileChangeSet(value: Record<string, any> = {}) : any {
  return createCoreChangeSet({
    changeId: value.changeId,
    baselineHead: value.baselineHead,
    attributionRef: value.attributionRef || "attr.wrm.1",
    operations: [
      createCoreChangeSetOperation({
        opId: value.opId,
        type: value.type || "insert",
        entityId: value.entityId,
        index: Number.isSafeInteger(value.index) ? value.index : 0,
        payloadDigest: value.payloadDigest || CORE_CHANGE_SET_DEFAULT_DIGEST
      })
    ]
  });
}

export function createWorkspaceReferenceMigration(options: Record<string, any> = {}) : any {
  factorySeq += 1;
  const instanceId: any = String(options.instanceId || `wrm.${factorySeq}`);
  const grantLookup: any = String(options.grantLookup || "gr.wrm.1");
  const workingSetId: any = String(options.workingSetId || `ws.wrm.${factorySeq}`);
  const core: any = options.authority || createCoreChangeSetAuthority({
    instanceId,
    principalRef: options.principalRef || "prin.wrm.1",
    grantRef: grantLookup,
    resourceRef: options.resourceRef || "res.wrm.1",
    policyRef: options.policyRef || "pol.wrm.1",
    audienceRef: options.audienceRef || "aud.wrm.1",
    requestRef: options.requestRef || "req.wrm.1"
  });
  if (core.id !== CORE_CHANGE_SET_AUTHORITY_ID) {
    throw new TypeError("Workspace reference migration requires the Core Change Set authority.");
  }
  const seam: any = createAgentWorkspaceChangeSetSeam(core);
  let nowMs: any = Number.isSafeInteger(options.nowMs) ? options.nowMs : 1_000;
  const clock: any = typeof options.nowMs === "function" ? options.nowMs : () : any => nowMs;
  const connector: any = options.connector || createConnectorWorkingView({
    grantLookup,
    nowMs: clock
  });
  const observer: any = options.observer || createConnectorWorkingView({
    grantLookup: options.observerGrantLookup || "gr.wrm.observer",
    nowMs: clock
  });
  const session: any = {
    workingSetId,
    opened: null,
    assets: [],
    handleByEntity: new Map<any, any>(),
    entityByHandle: new Map<any, any>(),
    assetByEntity: new Map<any, any>(),
    checkpoints: [],
    suggestions: [],
    connectorHead: 0,
    observerHead: 0,
    suggestionWriterCalls: 0,
    hostFileWrites: 0,
    treeScans: 0,
    restoreReversesUnownedEffect: false,
    effectRouted: 0,
    seq: 0
  };

  function requireOpen() : any {
    if (!session.opened) {
      throw new Error("Workspace collaboration Working Set is not open.");
    }
    return session.opened;
  }

  function nextSeq(prefix?: any) : any {
    session.seq += 1;
    return `${prefix}.${session.seq}`;
  }

  function entityForHandle(handle?: any) : any {
    const entityId: any = session.entityByHandle.get(handle);
    if (!entityId) {
      throw new TypeError("Workspace collaboration Handle is not bound to a Resource.");
    }
    return entityId;
  }

  async function hydratePeer(peer?: any, opened?: any, observed?: any) : Promise<any> {
    const hydrated: any = peer.hydrate({
      open: opened,
      observe: observed,
      grantLookup: peer.currentGrant()
    });
    if (hydrated.ok !== true) {
      throw new Error("Workspace collaboration peer could not observe confirmed Resources.");
    }
    return hydrated;
  }

  function subscribePeer(peer?: any, opened?: any) : any {
    const subscribed: any = peer.subscribe(createSubscribeRequest({
      workingSetId: opened.workingSetId,
      cursor: opened.cursor,
      cacheHint: PRIVATE_CACHE_HINT,
      notifications: [SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD]
    }));
    if (subscribed.ok !== true) {
      throw new Error("Workspace collaboration peer could not subscribe to Resource deltas.");
    }
    return subscribed;
  }

  async function open(input: Record<string, any> = {}) : Promise<any> {
    if (SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED !== false) {
      throw new Error("Workspace collaboration cannot introduce a second Core generation.");
    }
    for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
      if (lookupFactIsAuthority(fact) === true) {
        throw new Error("Workspace collaboration lookup facts are not authority.");
      }
    }
    const assets: any = defaultAssets(input);
    const opened: any = await core.open({
      workingSetId,
      catalogSize: Number.isSafeInteger(input.catalogSize) ? input.catalogSize : 0,
      connectedClients: Number.isSafeInteger(input.connectedClients) ? input.connectedClients : 0,
      entities: assets.map((asset?: any) : any => ({
        entityId: asset.entityId,
        kind: asset.kind,
        handle: asset.handle
      }))
    });
    const parsedOpen: any = parseOpenResponse(opened);
    if (!parsedOpen) {
      throw new TypeError("Workspace collaboration open must return a versioned Working Set.");
    }
    session.opened = parsedOpen;
    session.assets = assets;
    session.handleByEntity.clear();
    session.entityByHandle.clear();
    session.assetByEntity.clear();
    for (const asset of assets) {
      session.handleByEntity.set(asset.entityId, asset.handle);
      session.entityByHandle.set(asset.handle, asset.entityId);
      session.assetByEntity.set(asset.entityId, asset);
    }
    session.connectorHead = parsedOpen.head;
    session.observerHead = parsedOpen.head;
    const observed: any = await core.observe({
      workingSetId,
      handle: assets[0].handle
    });
    const parsedObserve: any = parseObserveResponse(observed);
    if (!parsedObserve) {
      throw new TypeError("Workspace collaboration observe must return confirmed Resources.");
    }
    await hydratePeer(connector, parsedOpen, parsedObserve);
    await hydratePeer(observer, parsedOpen, parsedObserve);
    subscribePeer(connector, parsedOpen);
    subscribePeer(observer, parsedOpen);
    for (const link of parsedOpen.resourceLinks) {
      await core.subscribe({
        workingSetId,
        resourceUri: link.uri
      });
    }
    session.checkpoints.push(Object.freeze({
      checkpointId: "ckpt.wrm.0",
      head: parsedOpen.head
    }));
    return freezeSafe({
      schemaVersion: WORKSPACE_REFERENCE_MIGRATION_SCHEMA_VERSION,
      coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
      workingSetId,
      head: parsedOpen.head,
      assets: assets.map((asset?: any) : any => Object.freeze({
        assetId: asset.assetId,
        entityId: asset.entityId,
        handle: asset.handle,
        resourceRef: asset.resourceRef
      })),
      resourceLinks: parsedOpen.resourceLinks,
      cursor: parsedOpen.cursor,
      subscribeMethod: SERVICE_COLLABORATION_SUBSCRIBE_METHOD,
      notificationMethod: SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD,
      secondCoreGenerationAllowed: SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED,
      capacityCertified: WORKSPACE_REFERENCE_MIGRATION_CAPACITY_CERTIFIED
    });
  }

  function observeLocal(input: Record<string, any> = {}) : any {
    requireOpen();
    const handle: any = input.handle || session.assets[0].handle;
    const local: any = connector.observeLocal({ handle });
    return Object.freeze({
      ok: local.ok === true,
      cacheHit: local.cacheHit === true,
      needsRemote: local.needsRemote === true,
      remoteReads: local.remoteReads,
      modelContextBytes: local.modelContextBytes,
      schemaModelContextBytes: local.schemaModelContextBytes,
      treeScans: session.treeScans,
      hostFileWrites: session.hostFileWrites
    });
  }

  function suggest(input: Record<string, any> = {}) : any {
    requireOpen();
    const handle: any = input.handle || session.assets[0].handle;
    const entityId: any = entityForHandle(handle);
    const attributionRef: any = String(input.attributionRef || "attr.wrm.suggest");
    const edited: any = connector.editLocal({ dirtyEntityIds: [entityId] });
    session.suggestions.push(Object.freeze({
      suggestionId: nextSeq("sug.wrm"),
      entityId,
      attributionRef,
      head: edited.confirmedHead,
      writerCalls: 0
    }));
    return Object.freeze({
      ok: edited.ok === true,
      dualWrite: false,
      writerCalls: session.suggestionWriterCalls,
      hostFileWrites: session.hostFileWrites,
      changeSetApplyCalls: core.snapshotCounters().changeSetApplyCalls,
      attributionRef,
      omittedUnchanged: edited.omittedUnchanged === true,
      view: edited.view
    });
  }

  async function fanout(ack?: any, entityId?: any) : Promise<any> {
    const connectorAck: any = connector.acceptRemote(ack);
    const observerAck: any = observer.acceptRemote(ack);
    if (connectorAck.ok === true) session.connectorHead = connectorAck.assignedHead;
    if (observerAck.ok === true) session.observerHead = observerAck.assignedHead;
    const note: any = core.notificationFor(workingSetId, entityId);
    connector.acceptRemote(note);
    observer.acceptRemote(note);
    const observed: any = await core.observe({
      workingSetId,
      handle: session.handleByEntity.get(entityId)
    });
    connector.acceptRemote(observed);
    observer.acceptRemote(observed);
    return note;
  }

  async function commitTurn(input: Record<string, any> = {}) : Promise<any> {
    const opened: any = requireOpen();
    const handle: any = input.handle || session.assets[0].handle;
    const entityId: any = entityForHandle(handle);
    const dirty: any = input.dirty === true;
    const request: any = createCommitRequest({
      workingSetId,
      handle,
      dirty,
      changeSet: dirty === true
        ? (input.changeSet || createWorkspaceFileChangeSet({
          changeId: input.changeId || nextSeq("chg.wrm"),
          baselineHead: input.baselineHead == null ? core.inspect(workingSetId).head : input.baselineHead,
          entityId,
          opId: input.opId || nextSeq("op.wrm"),
          attributionRef: input.attributionRef || "attr.wrm.1",
          type: input.type || "insert"
        }))
        : null
    });
    assertCommitTurn(request);
    const queued: any = connector.queueCommit(request);
    const before: any = core.snapshotCounters();
    const ack: any = await seam.commitFileTurn(request);
    const parsedAck: any = parseAcknowledge(ack);
    if (!parsedAck) {
      throw new TypeError("Workspace collaboration commit must acknowledge through Core.");
    }
    const after: any = core.snapshotCounters();
    const applyDelta: any = after.applyCalls - before.applyCalls;
    const changeSetDelta: any = after.changeSetApplyCalls - before.changeSetApplyCalls;
    if (dirty === true) {
      await fanout(parsedAck, entityId);
      if (parsedAck.conflicts.length === 0) {
        session.checkpoints.push(Object.freeze({
          checkpointId: `ckpt.wrm.${parsedAck.assignedHead}`,
          head: parsedAck.assignedHead,
          changeId: request.changeSet.changeId
        }));
      }
    } else {
      connector.acceptRemote(parsedAck);
      observer.acceptRemote(parsedAck);
      session.connectorHead = parsedAck.assignedHead;
      session.observerHead = parsedAck.assignedHead;
    }
    return freezeSafe({
      ok: parsedAck.conflicts.length === 0,
      dirty,
      assignedHead: parsedAck.assignedHead,
      applyDelta,
      changeSetDelta,
      queued: queued.ok === true,
      conflicts: parsedAck.conflicts,
      changedEntityIds: parsedAck.changedEntityIds,
      coreHead: core.inspect(workingSetId).head,
      connectorHead: session.connectorHead,
      observerHead: session.observerHead,
      hostFileWrites: session.hostFileWrites,
      treeScans: session.treeScans
    });
  }

  async function restoreAsNewChange(input: Record<string, any> = {}) : Promise<any> {
    requireOpen();
    if (input.rewindHistory === true || input.reverseEffect === true) {
      throw new Error("Workspace restore is a new Change Set and does not rewind history or Effect Commands.");
    }
    if (SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT !== false) {
      throw new Error("Local rollback must not claim to reverse an unowned Effect Command.");
    }
    const handle: any = input.handle || session.assets[0].handle;
    const entityId: any = entityForHandle(handle);
    const currentHead: any = core.inspect(workingSetId).head;
    const checkpointId: any = String(input.checkpointId || session.checkpoints.at(-1)?.checkpointId || "ckpt.wrm.0");
    const checkpoint: any = session.checkpoints.find((entry?: any) : any => entry.checkpointId === checkpointId)
      || session.checkpoints[0];
    if (!checkpoint) {
      throw new Error("Workspace restore requires a recorded checkpoint identity.");
    }
    const before: any = core.snapshotCounters();
    const restored: any = await commitTurn({
      handle,
      dirty: true,
      changeId: input.changeId || nextSeq("chg.wrm.restore"),
      baselineHead: currentHead,
      entityId,
      opId: input.opId || nextSeq("op.wrm.restore"),
      attributionRef: input.attributionRef || "attr.wrm.restore",
      type: "update"
    });
    const after: any = core.snapshotCounters();
    session.restoreReversesUnownedEffect = false;
    return freezeSafe({
      ok: restored.ok === true,
      restoreAsNewChange: true,
      checkpointId,
      baselineHead: currentHead,
      assignedHead: restored.assignedHead,
      applyDelta: after.applyCalls - before.applyCalls,
      rewound: restored.assignedHead < currentHead,
      reversesUnownedEffect: session.restoreReversesUnownedEffect,
      coreHead: restored.coreHead,
      connectorHead: restored.connectorHead,
      observerHead: restored.observerHead
    });
  }

  function routeEffect(input: Record<string, any> = {}) : any {
    requireOpen();
    const kind: any = EFFECT_KINDS.includes(input.kind) ? input.kind : "share";
    void kind;
    const before: any = core.snapshotCounters();
    let rejected: any = false;
    try {
      rejectEffectCommand({ family: "effect-command" });
    } catch {
      rejected = true;
    }
    const command: any = createEffectCommand({
      effectId: input.effectId || nextSeq("eff.wrm"),
      idempotency: "idempotent",
      principalLookup: input.principalLookup || "prin.wrm.1",
      grantLookup: input.grantLookup || grantLookup,
      targetRef: input.targetRef || session.assets[0].assetId,
      policyRef: input.policyRef || "pol.wrm.1",
      approvalLookup: input.approvalLookup || "apr.wrm.1",
      audienceRef: input.audienceRef || "aud.wrm.1",
      requestRef: input.requestRef || "req.wrm.1",
      cancellationState: "none",
      resultState: "accepted",
      auditRef: input.auditRef || "audt.wrm.1",
      compensationRef: null
    });
    session.effectRouted += 1;
    const after: any = core.snapshotCounters();
    return freezeSafe({
      ok: rejected === true,
      family: command.family,
      mergedIntoChangeSet: false,
      changeSetApplyDelta: after.changeSetApplyCalls - before.changeSetApplyCalls,
      effectCommand: command,
      reversesUnownedEffect: false
    });
  }

  async function resyncDeltas(input: Record<string, any> = {}) : Promise<any> {
    const opened: any = requireOpen();
    const handle: any = input.handle || session.assets[0].handle;
    const cursor: any = input.cursor || opened.cursor;
    const resync: any = await core.resync({
      workingSetId,
      handle,
      cursor
    });
    const parsed: any = parseResyncResponse(resync);
    if (!parsed) {
      throw new TypeError("Workspace collaboration resync must return bounded deltas.");
    }
    connector.acceptRemote(parsed);
    observer.acceptRemote(parsed);
    if (parsed.outcome === "delta" || parsed.outcome === "snapshot-tail") {
      session.connectorHead = parsed.head;
      session.observerHead = parsed.head;
    }
    return freezeSafe({
      outcome: parsed.outcome,
      head: parsed.head,
      deltaCount: Array.isArray(parsed.deltas) ? parsed.deltas.length : 0,
      tailCount: Array.isArray(parsed.tail) ? parsed.tail.length : 0,
      treeScans: session.treeScans
    });
  }

  function peers() : any {
    const inspected: any = session.opened ? core.inspect(workingSetId) : { head: 0 };
    return Object.freeze({
      coreHead: inspected.head,
      connectorHead: session.connectorHead,
      observerHead: session.observerHead,
      converged: inspected.head === session.connectorHead && inspected.head === session.observerHead,
      treeScans: session.treeScans,
      hostFileWrites: session.hostFileWrites,
      suggestionWriterCalls: session.suggestionWriterCalls
    });
  }

  function fallback() : any {
    const descriptor: any = createFallbackDescriptor();
    const selected: any = selectProtocolPath(true);
    if (selected.coreStateGeneration !== SERVICE_COLLABORATION_CORE_STATE_GENERATION) {
      throw new Error("Workspace collaboration fallback must retain one Core state generation.");
    }
    return Object.freeze({
      descriptor,
      profileMethods: [...SERVICE_COLLABORATION_PROFILE_METHODS],
      ordinaryMethods: [...SERVICE_COLLABORATION_FALLBACK_METHODS],
      secondCoreGenerationAllowed: SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED
    });
  }

  function snapshot() : any {
    const counters: any = core.snapshotCounters();
    const facts: any = Object.freeze({
      schemaVersion: WORKSPACE_REFERENCE_MIGRATION_SCHEMA_VERSION,
      coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
      authorityId: WORKSPACE_REFERENCE_MIGRATION_AUTHORITY_ID,
      capacityCertified: WORKSPACE_REFERENCE_MIGRATION_CAPACITY_CERTIFIED,
      nonCertificationReason: WORKSPACE_REFERENCE_MIGRATION_NON_CERTIFICATION_REASON,
      lookupFactsAreAuthority: false,
      secondCoreGenerationAllowed: SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED,
      silentUncertainRetry: SERVICE_COLLABORATION_SILENT_UNCERTAIN_RETRY,
      localRollbackReversesEffect: SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT,
      applyCalls: counters.applyCalls,
      changeSetApplyCalls: counters.changeSetApplyCalls,
      effectRouted: session.effectRouted,
      suggestionWriterCalls: session.suggestionWriterCalls,
      hostFileWrites: session.hostFileWrites,
      treeScans: session.treeScans,
      restoreReversesUnownedEffect: session.restoreReversesUnownedEffect,
      checkpointCount: session.checkpoints.length,
      suggestionCount: session.suggestions.length,
      ...peers()
    });
    if (containsForbiddenKeys(facts)) {
      throw new Error("Workspace collaboration snapshot must remain privacy-safe.");
    }
    return facts;
  }

  function close() : any {
    core.close();
    session.opened = null;
    session.handleByEntity.clear();
    session.entityByHandle.clear();
    session.assetByEntity.clear();
    return true;
  }

  return Object.freeze({
    id: WORKSPACE_REFERENCE_MIGRATION_AUTHORITY_ID,
    ownedModule: WORKSPACE_REFERENCE_MIGRATION_OWNED_MODULE,
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    capacityCertified: WORKSPACE_REFERENCE_MIGRATION_CAPACITY_CERTIFIED,
    open,
    observeLocal,
    suggest,
    commitTurn,
    restoreAsNewChange,
    routeEffect,
    resyncDeltas,
    peers,
    fallback,
    snapshot,
    projectMcp: projectConnectorMcpEnvelope,
    commitFileTurn: seam.commitFileTurn,
    close
  });
}

export default createWorkspaceReferenceMigration;
