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

export const WORKSPACE_REFERENCE_MIGRATION_OWNED_MODULE =
  "packages/agents/src/agent-workspace/workspace-reference-migration.ts";
export const WORKSPACE_REFERENCE_MIGRATION_AUTHORITY_ID = "WorkspaceReferenceMigration";
export const WORKSPACE_REFERENCE_MIGRATION_SCHEMA_VERSION =
  "v0.0.1:workspace-reference-migration:state-1";
export const WORKSPACE_REFERENCE_MIGRATION_REPORT_SCHEMA_VERSION =
  "v0.0.1:workspace-reference-migration:report-1";
export const WORKSPACE_REFERENCE_MIGRATION_CAPACITY_CERTIFIED = false;
export const WORKSPACE_REFERENCE_MIGRATION_NON_CERTIFICATION_REASON =
  CORE_CHANGE_SET_NON_CERTIFICATION_REASON;

type JsonRecord = Record<string, unknown>;
type EffectKind = "share" | "unshare" | "import" | "export" | "sandbox-apply" | "local-directory-mutation";
interface WorkspaceAsset { assetId: string; entityId: string; handle: string; kind: string; resourceRef: string }
export interface ResourceLink { uri: string; [key: string]: unknown }
interface OpenState { workingSetId: string; head: number; cursor: unknown; resourceLinks: ResourceLink[]; [key: string]: unknown }
interface AcknowledgeState { assignedHead: number; conflicts: unknown[]; changedEntityIds: string[]; [key: string]: unknown }
interface CounterState { applyCalls: number; changeSetApplyCalls: number; [key: string]: number }
interface Checkpoint { checkpointId: string; head: number; changeId?: string }
interface Suggestion { suggestionId: string; entityId: string; attributionRef: string; head: number; writerCalls: number }
interface CommitRequestState extends JsonRecord { workingSetId: string; handle: string; dirty: boolean; changeSet: JsonRecord | null }
interface WorkspaceFileChangeSet extends JsonRecord { changeId: string; baselineHead: number; attributionRef: string; operations: JsonRecord[] }
interface CoreAuthority {
  id: string;
  open(input?: JsonRecord): Promise<unknown>;
  observe(input?: JsonRecord): Promise<unknown>;
  commitTurn(value?: JsonRecord, lookup?: JsonRecord): Promise<unknown>;
  rebase(input?: JsonRecord, lookup?: JsonRecord): Promise<unknown>;
  resync(input?: JsonRecord, lookup?: JsonRecord): Promise<unknown>;
  subscribe(input?: JsonRecord, lookup?: JsonRecord): Promise<unknown>;
  seedDecoys(input?: JsonRecord): Readonly<{ catalogSize: number; connectedClients: number }>;
  revoke(workingSetId?: unknown): boolean;
  advanceGeneration(workingSetId?: unknown): number;
  snapshotCounters(): Readonly<CounterState>;
  inspect(workingSetId?: unknown): Readonly<JsonRecord>;
  notificationFor(workingSetId?: unknown, entityId?: unknown): unknown;
  rejectEffectCommand(value?: unknown): never;
  close(): boolean;
}
interface WorkingView {
  hydrate(input?: JsonRecord): unknown;
  subscribe(input?: unknown): unknown;
  currentGrant(): string;
  observeLocal(input?: JsonRecord): unknown;
  editLocal(input?: JsonRecord): unknown;
  acceptRemote(value?: unknown): unknown;
  queueCommit(value?: unknown): unknown;
}
interface MigrationOptions extends JsonRecord {
  authority?: unknown; connector?: unknown; observer?: unknown; nowMs?: number | (() => number);
}
interface MigrationSession {
  workingSetId: string; opened: OpenState | null; assets: WorkspaceAsset[];
  handleByEntity: Map<string, string>; entityByHandle: Map<string, string>; assetByEntity: Map<string, WorkspaceAsset>;
  checkpoints: Checkpoint[]; suggestions: Suggestion[]; connectorHead: number; observerHead: number;
  suggestionWriterCalls: number; hostFileWrites: number; treeScans: number;
  restoreReversesUnownedEffect: boolean; effectRouted: number; seq: number;
}

const PRIVATE_CACHE_HINT = Object.freeze({
  ttlMs: 60_000,
  cacheScope: "private"
});
let factorySeq = 0;

function asObject(value?: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function freezeSafe<Value extends JsonRecord>(value: Value): Readonly<Value> {
  if (containsForbiddenKeys(value)) {
    throw new Error("Workspace collaboration output cannot carry privacy or CRDT fields.");
  }
  if (value?.coreStateGeneration) assertOneCoreStateGeneration(value);
  return Object.freeze(value);
}

function opaqueAssetId(index: number): string {
  return `ast.wrm.${index}`;
}

function opaqueEntityId(index: number): string {
  return `ent.wrm.file.${index}`;
}

function opaqueHandle(index: number): string {
  return `hdl_wrm_${index}`;
}

function assertStableIdentity(value?: unknown): string {
  const identity = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(identity)) {
    throw new TypeError("Workspace collaboration identity must be a stable opaque token.");
  }
  if (identity.includes("/") || identity.includes("\\")) {
    throw new TypeError("Workspace collaboration identity cannot be a filesystem location.");
  }
  return identity;
}

function isCoreAuthority(value: unknown): value is CoreAuthority {
  const candidate = asObject(value);
  return typeof candidate.id === "string" && typeof candidate.open === "function" &&
    typeof candidate.observe === "function" && typeof candidate.commitTurn === "function" &&
    typeof candidate.resync === "function" && typeof candidate.subscribe === "function" &&
    typeof candidate.snapshotCounters === "function" && typeof candidate.inspect === "function" &&
    typeof candidate.notificationFor === "function" && typeof candidate.close === "function";
}

function isWorkingView(value: unknown): value is WorkingView {
  const candidate = asObject(value);
  return typeof candidate.hydrate === "function" && typeof candidate.subscribe === "function" &&
    typeof candidate.currentGrant === "function" && typeof candidate.observeLocal === "function" &&
    typeof candidate.editLocal === "function" && typeof candidate.acceptRemote === "function" &&
    typeof candidate.queueCommit === "function";
}

function openState(value: unknown): OpenState | null {
  const candidate = asObject(value);
  if (typeof candidate.workingSetId !== "string" || typeof candidate.head !== "number" ||
      !Object.hasOwn(candidate, "cursor") || !Array.isArray(candidate.resourceLinks)) return null;
  const resourceLinks: ResourceLink[] = [];
  for (const value of candidate.resourceLinks) {
    const link = asObject(value);
    if (typeof link.uri !== "string") return null;
    resourceLinks.push({ ...link, uri: link.uri });
  }
  return { ...candidate, workingSetId: candidate.workingSetId, head: candidate.head, cursor: candidate.cursor, resourceLinks };
}

function acknowledgeState(value: unknown): AcknowledgeState | null {
  const candidate = asObject(value);
  if (typeof candidate.assignedHead !== "number" || !Array.isArray(candidate.conflicts) || !Array.isArray(candidate.changedEntityIds)) return null;
  const changedEntityIds = candidate.changedEntityIds.filter((item): item is string => typeof item === "string");
  if (changedEntityIds.length !== candidate.changedEntityIds.length) return null;
  return {
    ...candidate,
    assignedHead: candidate.assignedHead,
    conflicts: candidate.conflicts,
    changedEntityIds
  };
}

function commitRequestState(value: unknown): CommitRequestState | null {
  const candidate = asObject(value);
  if (typeof candidate.workingSetId !== "string" || typeof candidate.handle !== "string" ||
      typeof candidate.dirty !== "boolean") return null;
  const changeSet = candidate.changeSet === null ? null : asObject(candidate.changeSet);
  if (candidate.dirty && typeof changeSet?.changeId !== "string") return null;
  return { ...candidate, workingSetId: candidate.workingSetId, handle: candidate.handle, dirty: candidate.dirty, changeSet };
}

function effectKind(value: unknown): EffectKind {
  switch (value) {
    case "share": case "unshare": case "import": case "export":
    case "sandbox-apply": case "local-directory-mutation": return value;
    default: return "share";
  }
}

function defaultAssets(input: JsonRecord = {}): WorkspaceAsset[] {
  const listed: unknown[] = Array.isArray(input.assets) && input.assets.length > 0
    ? input.assets
    : [{ assetId: opaqueAssetId(1), kind: "workspace-file" }];
  return listed.map((value, index) => {
    const entry = asObject(value);
    const assetId = assertStableIdentity(entry.assetId || opaqueAssetId(index + 1));
    const entityId = assertStableIdentity(entry.entityId || opaqueEntityId(index + 1));
    const handle = String(entry.handle || opaqueHandle(index + 1));
    if (!/^[A-Za-z0-9_-]{8,64}$/u.test(handle)) {
      throw new TypeError("Workspace collaboration Handle must be opaque.");
    }
    return Object.freeze({
      assetId,
      entityId,
      handle,
      kind: String(entry.kind || "workspace-file"),
      resourceRef: String(entry.resourceRef || `res.wrm.${index + 1}`)
    });
  });
}

export function createWorkspaceFileChangeSet(value: JsonRecord = {}): WorkspaceFileChangeSet {
  const changeSet = asObject(createCoreChangeSet({
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
  }));
  const operations = Array.isArray(changeSet.operations) ? changeSet.operations.map(asObject) : [];
  if (typeof changeSet.changeId !== "string" || typeof changeSet.baselineHead !== "number" ||
      typeof changeSet.attributionRef !== "string" || operations.length === 0) {
    throw new TypeError("Workspace file Change Set is invalid.");
  }
  return {
    ...changeSet,
    changeId: changeSet.changeId,
    baselineHead: changeSet.baselineHead,
    attributionRef: changeSet.attributionRef,
    operations
  };
}

export function createWorkspaceReferenceMigration(options: MigrationOptions = {}) {
  factorySeq += 1;
  const instanceId = String(options.instanceId || `wrm.${factorySeq}`);
  const grantLookup = String(options.grantLookup || "gr.wrm.1");
  const workingSetId = String(options.workingSetId || `ws.wrm.${factorySeq}`);
  const authorityCandidate: unknown = options.authority || createCoreChangeSetAuthority({
    instanceId,
    principalRef: options.principalRef || "prin.wrm.1",
    grantRef: grantLookup,
    resourceRef: options.resourceRef || "res.wrm.1",
    policyRef: options.policyRef || "pol.wrm.1",
    audienceRef: options.audienceRef || "aud.wrm.1",
    requestRef: options.requestRef || "req.wrm.1"
  });
  if (!isCoreAuthority(authorityCandidate)) {
    throw new TypeError("Workspace reference migration requires a Core authority provider.");
  }
  const core = authorityCandidate;
  if (core.id !== CORE_CHANGE_SET_AUTHORITY_ID) {
    throw new TypeError("Workspace reference migration requires the Core Change Set authority.");
  }
  const seam = createAgentWorkspaceChangeSetSeam(core);
  let nowMs = typeof options.nowMs === "number" && Number.isSafeInteger(options.nowMs) ? options.nowMs : 1_000;
  const clock = typeof options.nowMs === "function" ? options.nowMs : (): number => nowMs;
  const connectorCandidate: unknown = options.connector || createConnectorWorkingView({
    grantLookup,
    nowMs: clock
  });
  const observerCandidate: unknown = options.observer || createConnectorWorkingView({
    grantLookup: options.observerGrantLookup || "gr.wrm.observer",
    nowMs: clock
  });
  if (!isWorkingView(connectorCandidate) || !isWorkingView(observerCandidate)) {
    throw new TypeError("Workspace reference migration requires valid connector working views.");
  }
  const connector = connectorCandidate;
  const observer = observerCandidate;
  const session: MigrationSession = {
    workingSetId,
    opened: null,
    assets: [],
    handleByEntity: new Map(),
    entityByHandle: new Map(),
    assetByEntity: new Map(),
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

  function requireOpen(): OpenState {
    if (!session.opened) {
      throw new Error("Workspace collaboration Working Set is not open.");
    }
    return session.opened;
  }

  function nextSeq(prefix: string): string {
    session.seq += 1;
    return `${prefix}.${session.seq}`;
  }

  function entityForHandle(handle: string): string {
    const entityId = session.entityByHandle.get(handle);
    if (!entityId) {
      throw new TypeError("Workspace collaboration Handle is not bound to a Resource.");
    }
    return entityId;
  }

  async function hydratePeer(peer: WorkingView, opened: OpenState, observed: unknown): Promise<JsonRecord> {
    const hydrated = asObject(peer.hydrate({
      open: opened,
      observe: observed,
      grantLookup: peer.currentGrant()
    }));
    if (hydrated.ok !== true) {
      throw new Error("Workspace collaboration peer could not observe confirmed Resources.");
    }
    return hydrated;
  }

  function subscribePeer(peer: WorkingView, opened: OpenState): JsonRecord {
    const subscribed = asObject(peer.subscribe(createSubscribeRequest({
      workingSetId: opened.workingSetId,
      cursor: opened.cursor,
      cacheHint: PRIVATE_CACHE_HINT,
      notifications: [SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD]
    })));
    if (subscribed.ok !== true) {
      throw new Error("Workspace collaboration peer could not subscribe to Resource deltas.");
    }
    return subscribed;
  }

  async function open(input: JsonRecord = {}) {
    if (SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED !== false) {
      throw new Error("Workspace collaboration cannot introduce a second Core generation.");
    }
    for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
      if (lookupFactIsAuthority(fact) === true) {
        throw new Error("Workspace collaboration lookup facts are not authority.");
      }
    }
    const assets = defaultAssets(input);
    const opened: unknown = await core.open({
      workingSetId,
      catalogSize: Number.isSafeInteger(input.catalogSize) ? input.catalogSize : 0,
      connectedClients: Number.isSafeInteger(input.connectedClients) ? input.connectedClients : 0,
      entities: assets.map((asset) => ({
        entityId: asset.entityId,
        kind: asset.kind,
        handle: asset.handle
      }))
    });
    const parsedOpen = openState(parseOpenResponse(opened));
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
    const observed: unknown = await core.observe({
      workingSetId,
      handle: assets[0].handle
    });
    const parsedObserve: unknown = parseObserveResponse(observed);
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
      assets: assets.map((asset) => Object.freeze({
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

  function observeLocal(input: JsonRecord = {}) {
    requireOpen();
    const handle = String(input.handle || session.assets[0].handle);
    const local = asObject(connector.observeLocal({ handle }));
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

  function suggest(input: JsonRecord = {}) {
    requireOpen();
    const handle = String(input.handle || session.assets[0].handle);
    const entityId = entityForHandle(handle);
    const attributionRef = String(input.attributionRef || "attr.wrm.suggest");
    const edited = asObject(connector.editLocal({ dirtyEntityIds: [entityId] }));
    session.suggestions.push(Object.freeze({
      suggestionId: nextSeq("sug.wrm"),
      entityId,
      attributionRef,
      head: Number(edited.confirmedHead || 0),
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

  async function fanout(ack: AcknowledgeState, entityId: string): Promise<unknown> {
    const connectorAck = asObject(connector.acceptRemote(ack));
    const observerAck = asObject(observer.acceptRemote(ack));
    if (connectorAck.ok === true) session.connectorHead = Number(connectorAck.assignedHead || 0);
    if (observerAck.ok === true) session.observerHead = Number(observerAck.assignedHead || 0);
    const note = core.notificationFor(workingSetId, entityId);
    connector.acceptRemote(note);
    observer.acceptRemote(note);
    const observed: unknown = await core.observe({
      workingSetId,
      handle: session.handleByEntity.get(entityId)
    });
    connector.acceptRemote(observed);
    observer.acceptRemote(observed);
    return note;
  }

  async function commitTurn(input: JsonRecord = {}) {
    requireOpen();
    const handle = String(input.handle || session.assets[0].handle);
    const entityId = entityForHandle(handle);
    const dirty = input.dirty === true;
    const request = commitRequestState(createCommitRequest({
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
    }));
    if (!request) throw new TypeError("Workspace collaboration commit request is invalid.");
    assertCommitTurn(request);
    const queued = asObject(connector.queueCommit(request));
    const before = core.snapshotCounters();
    const ack: unknown = await seam.commitFileTurn(request);
    const parsedAck = acknowledgeState(parseAcknowledge(ack));
    if (!parsedAck) {
      throw new TypeError("Workspace collaboration commit must acknowledge through Core.");
    }
    const after = core.snapshotCounters();
    const applyDelta = after.applyCalls - before.applyCalls;
    const changeSetDelta = after.changeSetApplyCalls - before.changeSetApplyCalls;
    if (dirty === true) {
      await fanout(parsedAck, entityId);
      if (parsedAck.conflicts.length === 0) {
        session.checkpoints.push(Object.freeze({
          checkpointId: `ckpt.wrm.${parsedAck.assignedHead}`,
          head: parsedAck.assignedHead,
          changeId: String(request.changeSet?.changeId || "")
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

  async function restoreAsNewChange(input: JsonRecord = {}) {
    requireOpen();
    if (input.rewindHistory === true || input.reverseEffect === true) {
      throw new Error("Workspace restore is a new Change Set and does not rewind history or Effect Commands.");
    }
    if (SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT !== false) {
      throw new Error("Local rollback must not claim to reverse an unowned Effect Command.");
    }
    const handle = String(input.handle || session.assets[0].handle);
    const entityId = entityForHandle(handle);
    const currentHead = Number(core.inspect(workingSetId).head || 0);
    const checkpointId = String(input.checkpointId || session.checkpoints.at(-1)?.checkpointId || "ckpt.wrm.0");
    const checkpoint = session.checkpoints.find((entry) => entry.checkpointId === checkpointId)
      || session.checkpoints[0];
    if (!checkpoint) {
      throw new Error("Workspace restore requires a recorded checkpoint identity.");
    }
    const before = core.snapshotCounters();
    const restored = await commitTurn({
      handle,
      dirty: true,
      changeId: input.changeId || nextSeq("chg.wrm.restore"),
      baselineHead: currentHead,
      entityId,
      opId: input.opId || nextSeq("op.wrm.restore"),
      attributionRef: input.attributionRef || "attr.wrm.restore",
      type: "update"
    });
    const after = core.snapshotCounters();
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

  function routeEffect(input: JsonRecord = {}) {
    requireOpen();
    const kind = effectKind(input.kind);
    void kind;
    const before = core.snapshotCounters();
    let rejected = false;
    try {
      rejectEffectCommand({ family: "effect-command" });
    } catch {
      rejected = true;
    }
    const command = asObject(createEffectCommand({
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
    }));
    session.effectRouted += 1;
    const after = core.snapshotCounters();
    return freezeSafe({
      ok: rejected === true,
      family: command.family,
      mergedIntoChangeSet: false,
      changeSetApplyDelta: after.changeSetApplyCalls - before.changeSetApplyCalls,
      effectCommand: command,
      reversesUnownedEffect: false
    });
  }

  async function resyncDeltas(input: JsonRecord = {}) {
    const opened = requireOpen();
    const handle = String(input.handle || session.assets[0].handle);
    const cursor = input.cursor || opened.cursor;
    const resync: unknown = await core.resync({
      workingSetId,
      handle,
      cursor
    });
    const parsed = asObject(parseResyncResponse(resync));
    if (typeof parsed.outcome !== "string" || typeof parsed.head !== "number") {
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

  function peers() {
    const inspected = session.opened ? core.inspect(workingSetId) : { head: 0 };
    const coreHead = Number(inspected.head || 0);
    return Object.freeze({
      coreHead,
      connectorHead: session.connectorHead,
      observerHead: session.observerHead,
      converged: coreHead === session.connectorHead && coreHead === session.observerHead,
      treeScans: session.treeScans,
      hostFileWrites: session.hostFileWrites,
      suggestionWriterCalls: session.suggestionWriterCalls
    });
  }

  function fallback() {
    const descriptor: unknown = createFallbackDescriptor();
    const selected = asObject(selectProtocolPath(true));
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

  function snapshot() {
    const counters = core.snapshotCounters();
    const facts = Object.freeze({
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

  function close(): boolean {
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
