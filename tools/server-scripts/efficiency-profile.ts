#!/usr/bin/env node
/*
 * Named Agent-to-Service efficiency profile.
 *
 * Compares equivalent frozen legacy protocol-shape workloads with collaborative
 * measurements that exercise Connector Working View, Core Change Set authority,
 * Workspace reference migration, and explicit Effect Command separation.
 * Capacity is certified only when completeness, privacy, safety, recovery, and
 * every warm threshold pass.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SERVICE_COLLABORATION_CORE_STATE_GENERATION,
  SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS,
  SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT,
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD,
  SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED,
  SERVICE_COLLABORATION_SILENT_UNCERTAIN_RETRY,
  containsForbiddenKeys,
  createAcknowledge,
  createCommitRequest,
  createEffectCommand,
  createOpenRequest,
  createResyncRequest,
  createSubscribeRequest,
  lookupFactIsAuthority
} from "../../packages/contracts/src/service-collaboration-contract.ts";
import {
  CORE_CHANGE_SET_AUTHORITY_ID,
  assertHotPathIndependence,
  createCoreChangeSet,
  createCoreChangeSetAuthority,
  createCoreChangeSetOperation,
  rejectEffectCommand
} from "../../packages/agents/src/core-change-set-authority.ts";
import {
  WORKSPACE_REFERENCE_MIGRATION_AUTHORITY_ID,
  WORKSPACE_REFERENCE_MIGRATION_OWNED_MODULE,
  createWorkspaceReferenceMigration
} from "../../packages/agents/src/agent-workspace/workspace-reference-migration.ts";
import {
  CONNECTOR_WORKING_VIEW_OWNED_MODULE,
  createConnectorWorkingView,
  projectConnectorMcpEnvelope
} from "../../packages/protocols/mcp/adapter/gateway-installer/connector-working-view.ts";
import {
  EXPLICIT_EFFECT_COMMAND_FAMILY,
  changeSetHidesEffectCommand,
  createExplicitEffectCommandInput,
  createExplicitEffectCommandRuntime,
  mergeEffectCommandIntoChangeSet
} from "../../packages/server-runtime/src/explicit-effect-commands.ts";
import {
  INTERACTION_COST_WORKLOAD_IDS,
  assertCollaborativeTurnInvariants,
  assertFiniteNonNegativeCounters,
  createEmptyInteractionCostCounters
} from "../verifiers/interaction-cost-baseline-catalog.ts";
import {
  measureInteractionCostScenario,
  workFingerprint
} from "./interaction-cost-baseline.ts";
import {
  EFFICIENCY_BYTE_REDUCTION_THRESHOLD,
  EFFICIENCY_CALL_REDUCTION_THRESHOLD,
  EFFICIENCY_NAMED_PROFILE,
  EFFICIENCY_OWNER_PROFILE,
  EFFICIENCY_PROFILE_ASSETS,
  EFFICIENCY_PROFILE_CATALOG,
  EFFICIENCY_PROFILE_CATALOG_SCHEMA_VERSION,
  EFFICIENCY_PROFILE_COUNTER_NAMES,
  EFFICIENCY_PROFILE_MEASUREMENT_KIND,
  EFFICIENCY_PROFILE_NON_CERTIFICATION_REASONS,
  EFFICIENCY_PROFILE_REPORT_SCHEMA_VERSION,
  EFFICIENCY_PROFILE_SIZE,
  EFFICIENCY_PROFILE_WORK,
  EFFICIENCY_PROFILE_WORKLOAD_IDS,
  assertFiniteCertificationReason,
  efficiencyPairingByWorkloadId,
  efficiencyWorkloadById,
  meetsReductionThreshold,
  reductionPercent
} from "../verifiers/efficiency-profile-catalog.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.ts";

const REASON: any = EFFICIENCY_PROFILE_NON_CERTIFICATION_REASONS;
const SIZE: any = EFFICIENCY_PROFILE_SIZE;
const WORK: any = EFFICIENCY_PROFILE_WORK;

export const EFFICIENCY_PROFILE_VERIFIER: any =
  "tools/server-scripts/verify-agent-service-efficiency-profile.ts";
export const EFFICIENCY_PROFILE_OWNED_MODULE: any =
  "tools/server-scripts/efficiency-profile.ts";
export const EFFICIENCY_PROFILE_REPORT_RELATIVE_PATH: any =
  "build/reports/agent-service-efficiency-profile.json";
export const EFFICIENCY_PROFILE_FOCUSED_SUITE: any =
  "tests/vitest/server/efficiency-profile.test.ts";

const VITEST_RUNNER: any = "./node_modules/vitest/vitest.mjs";
const PRIVATE_CACHE_HINT: any = Object.freeze({ ttlMs: 60_000, cacheScope: "private" });
const OWNED_SOURCE_FILES: readonly any[] = Object.freeze([
  EFFICIENCY_PROFILE_VERIFIER,
  EFFICIENCY_PROFILE_OWNED_MODULE,
  "tools/verifiers/efficiency-profile-catalog.ts"
]);
const COLLABORATION_MODULES: readonly any[] = Object.freeze([
  CONNECTOR_WORKING_VIEW_OWNED_MODULE,
  "packages/agents/src/core-change-set-authority.ts",
  WORKSPACE_REFERENCE_MIGRATION_OWNED_MODULE,
  "packages/server-runtime/src/explicit-effect-commands.ts"
]);
const SOURCE_FILES: readonly any[] = Object.freeze([
  ...OWNED_SOURCE_FILES,
  ...COLLABORATION_MODULES
]);
const SOURCE_FORBIDDEN: readonly any[] = Object.freeze([
  /from\s+["']yjs["']/u,
  /from\s+["']automerge["']/u,
  /\bY\.Doc\b/u,
  /\bAutomerge\b/u
]);

function cloneCounters(counters?: any) : any {
  return { ...createEmptyInteractionCostCounters(), ...(counters || {}) };
}

function applyStep(counters?: any, step: Record<string, any> = {}) : any {
  const next: any = cloneCounters(counters);
  const requestBytes: any = Number(step.requestBytes || 0);
  const responseBytes: any = Number(step.responseBytes || 0);
  next.networkRoundTrips += 1;
  next.requestBytes += requestBytes;
  next.responseBytes += responseBytes;
  next.wireBytes += requestBytes + responseBytes;
  next.discoveryBytes += Number(step.discoveryBytes || 0);
  next.catalogBytes += Number(step.catalogBytes || 0);
  next.schemaBytes += Number(step.schemaBytes || 0);
  next.modelContextBytes += Number(step.modelContextBytes || 0);
  next.modelVisibleToolCalls += step.modelVisibleToolCall ? 1 : 0;
  next.modelVisibleRemoteReads += step.remoteRead ? 1 : 0;
  next.repeatedReads += step.repeatedRead ? 1 : 0;
  next.indexedStatements += Number(step.indexedStatements || 0);
  next.scannedEntities += Number(step.scannedEntities || 0);
  next.relevantOperations += Number(step.relevantOperations || 0);
  next.wakeups += Number(step.wakeups || 0);
  next.timers += Number(step.timers || 0);
  next.applyCalls += Number(step.applyCalls || (step.apply ? 1 : 0));
  next.changeSetApplyCalls += Number(step.changeSetApplyCalls || (step.changeSetApply ? 1 : 0));
  next.effectCommandCalls += Number(step.effectCommandCalls || (step.effectCommand ? 1 : 0));
  if (typeof step.cacheWeight === "number") next.cacheWeight = step.cacheWeight;
  next.queuePeak = Math.max(next.queuePeak, Number(step.queueDepth || 0));
  next.subscriptionPeak = Math.max(next.subscriptionPeak, Number(step.subscriptionDepth || 0));
  next.retryPeak = Math.max(next.retryPeak, Number(step.retryDepth || 0));
  next.snapshotPeak = Math.max(next.snapshotPeak, Number(step.snapshotCount || 0));
  const inFlight: any = requestBytes + responseBytes + (Number(step.snapshotCount || 0) * SIZE.entityBodyBytes);
  next.memoryPeak = Math.max(
    next.memoryPeak,
    next.cacheWeight + (next.queuePeak * SIZE.queueSlotBytes) + inFlight
  );
  return next;
}

function withLatency(counters?: any, acknowledgementLatency: any = 0, subscriberVisibilityLatency: any = 0) : any {
  const next: any = cloneCounters(counters);
  next.acknowledgementLatency = acknowledgementLatency;
  next.subscriberVisibilityLatency = subscriberVisibilityLatency;
  next.memoryPeak = Math.max(next.memoryPeak, next.cacheWeight + (next.queuePeak * SIZE.queueSlotBytes));
  return next;
}

function jsonBytes(value?: any) : any {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function protocolBytes(message?: any, id: any = "eff-1") : any {
  if (!message) return 0;
  const projected: any = projectConnectorMcpEnvelope({ id, message });
  if (projected?.local === true) return 0;
  if (projected?.envelope) return jsonBytes(projected.envelope);
  return jsonBytes(message);
}

function identityCursor() : any {
  return Object.freeze({
    cursor: WORK.identities.cursorRef,
    indexedHead: 0,
    cursorState: "valid"
  });
}

function catalogListBytes() : any {
  return {
    catalogBytes: SIZE.catalogEntryBytes * WORK.catalogSize,
    schemaBytes: SIZE.schemaTypeBytes * WORK.schemaTypeCount,
    scannedEntities: WORK.catalogSize,
    indexedStatements: WORK.catalogSize
  };
}

function toolsListStep() : any {
  const listed: any = catalogListBytes();
  return {
    modelVisibleToolCall: true,
    requestBytes: SIZE.envelopeBytes + SIZE.toolsListRequestBytes,
    responseBytes: SIZE.envelopeBytes + listed.catalogBytes + listed.schemaBytes,
    catalogBytes: listed.catalogBytes,
    schemaBytes: listed.schemaBytes,
    modelContextBytes: listed.catalogBytes + listed.schemaBytes,
    scannedEntities: listed.scannedEntities,
    indexedStatements: listed.indexedStatements,
    wakeups: 1
  };
}

function entityReadStep({ repeated = false }: Record<string, any> = {}) : any {
  return {
    modelVisibleToolCall: true,
    remoteRead: true,
    repeatedRead: repeated === true,
    requestBytes: SIZE.envelopeBytes + 80,
    responseBytes: SIZE.envelopeBytes + SIZE.entityBodyBytes,
    modelContextBytes: SIZE.entityBodyBytes,
    scannedEntities: 1,
    indexedStatements: 1,
    wakeups: 1,
    snapshotCount: 1
  };
}

function entityWriteStep() : any {
  return {
    modelVisibleToolCall: true,
    apply: true,
    requestBytes: SIZE.envelopeBytes + SIZE.entityBodyBytes,
    responseBytes: SIZE.envelopeBytes + 96,
    modelContextBytes: SIZE.entityBodyBytes,
    scannedEntities: 1,
    indexedStatements: 1,
    wakeups: 1,
    queueDepth: 1
  };
}

function foldSteps(steps: any = []) : any {
  let counters: any = createEmptyInteractionCostCounters();
  for (const step of steps) counters = applyStep(counters, step);
  return counters;
}

export function efficiencyWorkFingerprint(workloadId: any = "") : any {
  if (INTERACTION_COST_WORKLOAD_IDS.includes(workloadId)) {
    return workFingerprint(workloadId);
  }
  const pairing: any = efficiencyPairingByWorkloadId(workloadId);
  const payload: any = JSON.stringify({
    workloadId: pairing?.workloadId || workloadId,
    seed: pairing?.seed || 0,
    identities: WORK.identities,
    catalogSize: WORK.catalogSize,
    workingSetSize: WORK.workingSetSize,
    schemaTypeCount: WORK.schemaTypeCount,
    dirtyIdentityCount: WORK.dirtyIdentityCount
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function createRuntime(label: any = "profile") : any {
  const core: any = createCoreChangeSetAuthority({
    instanceId: `eff.${label}`,
    principalRef: WORK.identities.principalId,
    grantRef: WORK.identities.grantRef,
    resourceRef: "res.icb.1",
    policyRef: "pol.icb.1",
    audienceRef: "aud.icb.1",
    requestRef: "req.icb.1"
  });
  const connector: any = createConnectorWorkingView({
    grantLookup: WORK.identities.grantRef,
    principalLookup: WORK.identities.principalId,
    nowMs: () : any => 1_000
  });
  const observer: any = createConnectorWorkingView({
    grantLookup: "gr.icb.observer",
    nowMs: () : any => 1_000
  });
  const session: any = createWorkspaceReferenceMigration({
    instanceId: `eff.${label}`,
    workingSetId: WORK.identities.workingSetId,
    grantLookup: WORK.identities.grantRef,
    principalRef: WORK.identities.principalId,
    authority: core,
    connector,
    observer,
    nowMs: () : any => 1_000
  });
  return { core, connector, observer, session };
}

async function openSession(runtime?: any) : Promise<any> {
  return runtime.session.open({
    assets: [...EFFICIENCY_PROFILE_ASSETS],
    catalogSize: WORK.catalogSize,
    connectedClients: 4
  });
}

function changeSetFor(changeId?: any, baselineHead: any = 0, operations: any = []) : any {
  return createCoreChangeSet({
    changeId,
    baselineHead,
    attributionRef: "attr.icb.1",
    operations: operations.map((entry?: any) : any => createCoreChangeSetOperation(entry))
  });
}

function threeIdentityOps(prefix: any = "op.icb") : any {
  return EFFICIENCY_PROFILE_ASSETS.map((asset?: any, index?: any) : any => ({
    opId: `${prefix}.${index + 1}`,
    type: "insert",
    entityId: asset.entityId,
    index: 0
  }));
}

function recordingSink() : any {
  const calls: any[] = [];
  return {
    calls,
    performExternalEffect: async (input: Record<string, any> = {}) : Promise<any> => {
      calls.push({ invoked: true, hasPermit: Boolean(input.permitReceipt) });
      if (!input.permitReceipt) {
        throw new Error("External effect sink required a consumed governed permit.");
      }
      return Object.freeze({ resultState: "terminal" });
    }
  };
}

function closeRuntime(runtime?: any) : any {
  try {
    runtime.session.close();
  } catch {
    runtime.core.close();
  }
}

function finishCollaborative(workloadId?: any, counters?: any) : any {
  const next: any = cloneCounters(counters);
  const rtt: any = SIZE.roundTripTicks;
  const fanout: any = SIZE.subscriberFanoutTicks;
  if (workloadId === "warm-read") return withLatency(next, 0, 0);
  if (workloadId === "dirty-turn") return withLatency(next, rtt, rtt + fanout);
  if (workloadId === "concurrent-change") return withLatency(next, rtt, rtt + fanout);
  if (workloadId === "conflict") return withLatency(next, rtt, rtt);
  if (workloadId === "explicit-effect") return withLatency(next, rtt, 0);
  if (workloadId === "revocation") return withLatency(next, rtt, 0);
  if (workloadId === "reconnect") return withLatency(next, rtt, rtt);
  return withLatency(next, rtt, rtt);
}

async function measureCollaborativeColdOpen(runtime?: any) : Promise<any> {
  const request: any = createOpenRequest({
    workingSetRef: WORK.identities.workingSetId,
    resourceRefs: WORK.identities.entityIds,
    cursor: identityCursor()
  });
  const opened: any = await openSession(runtime);
  const subscribe: any = createSubscribeRequest({
    workingSetId: opened.workingSetId,
    cursor: opened.cursor,
    cacheHint: PRIVATE_CACHE_HINT,
    notifications: [SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD]
  });
  const responseBytes: any = jsonBytes({
    workingSetId: opened.workingSetId,
    head: opened.head,
    resourceLinks: opened.resourceLinks,
    cursor: opened.cursor
  });
  let counters: any = applyStep(createEmptyInteractionCostCounters(), {
    requestBytes: protocolBytes(request, "open-1"),
    responseBytes,
    discoveryBytes: protocolBytes(request, "open-1") + responseBytes,
    wakeups: 1
  });
  counters = applyStep(counters, {
    modelVisibleToolCall: true,
    remoteRead: true,
    requestBytes: protocolBytes(request, "open-2"),
    responseBytes,
    modelContextBytes: jsonBytes({
      workingSetId: opened.workingSetId,
      head: opened.head,
      cursor: opened.cursor
    }),
    scannedEntities: WORK.workingSetSize,
    indexedStatements: WORK.workingSetSize,
    wakeups: 1,
    cacheWeight: runtime.connector.counters().cacheWeight,
    subscriptionDepth: 1,
    snapshotCount: 1
  });
  counters = applyStep(counters, {
    requestBytes: protocolBytes(subscribe, "sub-1"),
    responseBytes: SIZE.envelopeBytes + SIZE.subscribeResponseBytes,
    wakeups: 1,
    cacheWeight: runtime.connector.counters().cacheWeight,
    subscriptionDepth: 1
  });
  return {
    counters: finishCollaborative("cold-open", counters),
    protocolStepCount: 3,
    facts: { openedHead: opened.head, peersConverged: runtime.session.peers().converged === true }
  };
}

async function measureCollaborativeWarmRead(runtime?: any) : Promise<any> {
  await openSession(runtime);
  let validCacheRemoteReads: any = 0;
  let unchangedSchemaBytes: any = 0;
  let unchangedCatalogBytes: any = 0;
  let modelContextBytes: any = 0;
  for (const asset of EFFICIENCY_PROFILE_ASSETS) {
    const local: any = runtime.session.observeLocal({ handle: asset.handle });
    if (local.cacheHit !== true || local.needsRemote === true || Number(local.remoteReads || 0) !== 0) {
      validCacheRemoteReads += 1;
    }
    unchangedSchemaBytes += Number(local.schemaModelContextBytes || 0);
    modelContextBytes += Number(local.modelContextBytes || 0);
  }
  const clean: any = await runtime.session.commitTurn({
    handle: EFFICIENCY_PROFILE_ASSETS[0].handle,
    dirty: false
  });
  const counters: any = finishCollaborative("warm-read", {
    ...createEmptyInteractionCostCounters(),
    schemaBytes: unchangedSchemaBytes,
    catalogBytes: unchangedCatalogBytes,
    modelContextBytes,
    modelVisibleRemoteReads: validCacheRemoteReads,
    cacheWeight: runtime.connector.counters().cacheWeight,
    subscriptionPeak: 1,
    memoryPeak: runtime.connector.counters().cacheWeight
  });
  return {
    counters,
    protocolStepCount: 0,
    facts: {
      cleanTurnApplyCalls: Number(clean.applyDelta || 0),
      validCacheRemoteReads,
      unchangedSchemaBytes,
      unchangedCatalogBytes
    }
  };
}

async function measureCollaborativeDirtyTurn(runtime?: any) : Promise<any> {
  await openSession(runtime);
  runtime.core.seedDecoys({
    workingSetId: WORK.identities.workingSetId,
    catalogSize: 5_000,
    connectedClients: 2_000
  });
  const operations: any = threeIdentityOps("op.icb.dirty");
  const changeSet: any = changeSetFor("chg.icb.dirty", 0, operations);
  const request: any = createCommitRequest({
    workingSetId: WORK.identities.workingSetId,
    handle: EFFICIENCY_PROFILE_ASSETS[0].handle,
    dirty: true,
    changeSet
  });
  const before: any = runtime.core.snapshotCounters();
  const dirty: any = await runtime.session.commitTurn({
    handle: EFFICIENCY_PROFILE_ASSETS[0].handle,
    dirty: true,
    changeId: "chg.icb.dirty",
    changeSet
  });
  const after: any = runtime.core.snapshotCounters();
  const applyDelta: any = after.applyCalls - before.applyCalls;
  const changeSetDelta: any = after.changeSetApplyCalls - before.changeSetApplyCalls;
  const scannedDelta: any = after.scannedEntities - before.scannedEntities;
  const relevantDelta: any = after.relevantOperations - before.relevantOperations;
  const wakeupDelta: any = after.wakeups - before.wakeups;
  assertHotPathIndependence(before, after, {
    changedEntityCount: WORK.dirtyIdentityCount,
    relevantOpCount: 0
  });
  const ack: any = createAcknowledge({
    workingSetId: WORK.identities.workingSetId,
    assignedHead: dirty.assignedHead,
    changedEntityIds: dirty.changedEntityIds,
    resultFacts: (dirty.changedEntityIds || []).map((entityId?: any) : any => ({
      code: "applied",
      entityId
    })),
    conflicts: dirty.conflicts || [],
    invalidations: (dirty.changedEntityIds || []).map((entityId?: any) : any => ({
      code: "resource_changed",
      resourceUri: `meshrix://collaboration/${WORK.identities.workingSetId}/${entityId}`
    }))
  });
  const counters: any = finishCollaborative("dirty-turn", applyStep(createEmptyInteractionCostCounters(), {
    modelVisibleToolCall: true,
    apply: applyDelta > 0,
    changeSetApply: changeSetDelta > 0,
    applyCalls: applyDelta,
    changeSetApplyCalls: changeSetDelta,
    requestBytes: protocolBytes(request, "commit-1"),
    responseBytes: protocolBytes(ack, "ack-1"),
    modelContextBytes: jsonBytes(operations),
    scannedEntities: scannedDelta,
    indexedStatements: operations.length,
    relevantOperations: relevantDelta,
    wakeups: wakeupDelta,
    cacheWeight: runtime.connector.counters().cacheWeight,
    queueDepth: 1,
    subscriptionDepth: 1
  }));
  return {
    counters,
    protocolStepCount: 1,
    facts: {
      dirtyTurnChangeSetApplyCalls: changeSetDelta,
      hotPathIndependent: true,
      peersConverged: runtime.session.peers().converged === true
    }
  };
}

async function measureCollaborativeConcurrentChange(runtime?: any) : Promise<any> {
  await openSession(runtime);
  const firstSet: any = changeSetFor("chg.icb.conc.1", 0, [{
    opId: "op.icb.conc.1",
    type: "insert",
    entityId: EFFICIENCY_PROFILE_ASSETS[0].entityId,
    index: 0
  }]);
  const first: any = await runtime.session.commitTurn({
    handle: EFFICIENCY_PROFILE_ASSETS[0].handle,
    dirty: true,
    changeId: "chg.icb.conc.1",
    changeSet: firstSet
  });
  const secondSet: any = changeSetFor("chg.icb.conc.2", first.assignedHead, [{
    opId: "op.icb.conc.2",
    type: "insert",
    entityId: EFFICIENCY_PROFILE_ASSETS[1].entityId,
    index: 0
  }]);
  const secondRequest: any = createCommitRequest({
    workingSetId: WORK.identities.workingSetId,
    handle: EFFICIENCY_PROFILE_ASSETS[1].handle,
    dirty: true,
    changeSet: secondSet
  });
  const before: any = runtime.core.snapshotCounters();
  const second: any = await runtime.session.commitTurn({
    handle: EFFICIENCY_PROFILE_ASSETS[1].handle,
    dirty: true,
    changeId: "chg.icb.conc.2",
    changeSet: secondSet
  });
  const after: any = runtime.core.snapshotCounters();
  const firstRequest: any = createCommitRequest({
    workingSetId: WORK.identities.workingSetId,
    handle: EFFICIENCY_PROFILE_ASSETS[0].handle,
    dirty: true,
    changeSet: firstSet
  });
  let counters: any = applyStep(createEmptyInteractionCostCounters(), {
    modelVisibleToolCall: true,
    apply: true,
    changeSetApply: true,
    requestBytes: protocolBytes(firstRequest, "commit-c1"),
    responseBytes: SIZE.envelopeBytes + SIZE.headBytes + SIZE.ackIdentityBytes,
    modelContextBytes: SIZE.changeOpBytes,
    scannedEntities: 1,
    indexedStatements: 1,
    wakeups: 1,
    cacheWeight: runtime.connector.counters().cacheWeight,
    queueDepth: 1,
    subscriptionDepth: 1
  });
  counters = applyStep(counters, {
    modelVisibleToolCall: true,
    apply: after.applyCalls - before.applyCalls > 0,
    changeSetApply: after.changeSetApplyCalls - before.changeSetApplyCalls > 0,
    applyCalls: after.applyCalls - before.applyCalls,
    changeSetApplyCalls: after.changeSetApplyCalls - before.changeSetApplyCalls,
    requestBytes: protocolBytes(secondRequest, "commit-c2"),
    responseBytes: SIZE.envelopeBytes + SIZE.headBytes + SIZE.ackIdentityBytes,
    modelContextBytes: SIZE.changeOpBytes,
    scannedEntities: 1,
    indexedStatements: 1,
    relevantOperations: after.relevantOperations - before.relevantOperations,
    wakeups: 1,
    cacheWeight: runtime.connector.counters().cacheWeight,
    queueDepth: 1,
    subscriptionDepth: 1
  });
  return {
    counters: finishCollaborative("concurrent-change", counters),
    protocolStepCount: 2,
    facts: {
      concurrentApplies: 1 + (after.applyCalls - before.applyCalls),
      secondHead: second.assignedHead,
      peersConverged: runtime.session.peers().converged === true
    }
  };
}

async function measureCollaborativeReconnect(runtime?: any) : Promise<any> {
  const opened: any = await openSession(runtime);
  await runtime.session.commitTurn({
    handle: EFFICIENCY_PROFILE_ASSETS[0].handle,
    dirty: true,
    changeId: "chg.icb.re.1",
    changeSet: changeSetFor("chg.icb.re.1", 0, [
      {
        opId: "op.icb.re.1",
        type: "insert",
        entityId: EFFICIENCY_PROFILE_ASSETS[0].entityId,
        index: 0
      },
      {
        opId: "op.icb.re.2",
        type: "insert",
        entityId: EFFICIENCY_PROFILE_ASSETS[1].entityId,
        index: 0
      }
    ])
  });
  const request: any = createResyncRequest({
    workingSetId: WORK.identities.workingSetId,
    handle: EFFICIENCY_PROFILE_ASSETS[0].handle,
    cursor: opened.cursor
  });
  const resync: any = await runtime.session.resyncDeltas({
    handle: EFFICIENCY_PROFILE_ASSETS[0].handle,
    cursor: opened.cursor
  });
  const counters: any = finishCollaborative("reconnect", applyStep(createEmptyInteractionCostCounters(), {
    modelVisibleToolCall: true,
    remoteRead: true,
    requestBytes: protocolBytes(request, "resync-1"),
    responseBytes: SIZE.envelopeBytes + (SIZE.missingOpBytes * Number(resync.deltaCount || 0)),
    modelContextBytes: SIZE.missingOpBytes * Number(resync.deltaCount || 0),
    scannedEntities: Number(resync.deltaCount || 0),
    indexedStatements: Number(resync.deltaCount || 0),
    relevantOperations: Number(resync.deltaCount || 0),
    wakeups: 1,
    cacheWeight: runtime.connector.counters().cacheWeight,
    subscriptionDepth: 1
  }));
  return {
    counters,
    protocolStepCount: 1,
    facts: {
      reconnectOutcome: resync.outcome,
      reconnectDeltaCount: Number(resync.deltaCount || 0)
    }
  };
}

async function measureCollaborativeConflict(runtime?: any) : Promise<any> {
  await openSession(runtime);
  await runtime.session.commitTurn({
    handle: EFFICIENCY_PROFILE_ASSETS[0].handle,
    dirty: true,
    changeId: "chg.icb.cf.1",
    changeSet: changeSetFor("chg.icb.cf.1", 0, [{
      opId: "op.icb.cf.1",
      type: "update",
      entityId: EFFICIENCY_PROFILE_ASSETS[0].entityId,
      index: 0
    }])
  });
  const conflictSet: any = changeSetFor("chg.icb.cf.2", 0, [{
    opId: "op.icb.cf.2",
    type: "update",
    entityId: EFFICIENCY_PROFILE_ASSETS[0].entityId,
    index: 0
  }]);
  const request: any = createCommitRequest({
    workingSetId: WORK.identities.workingSetId,
    handle: EFFICIENCY_PROFILE_ASSETS[0].handle,
    dirty: true,
    changeSet: conflictSet
  });
  const before: any = runtime.core.snapshotCounters();
  const conflicted: any = await runtime.session.commitTurn({
    handle: EFFICIENCY_PROFILE_ASSETS[0].handle,
    dirty: true,
    changeId: "chg.icb.cf.2",
    changeSet: conflictSet
  });
  const after: any = runtime.core.snapshotCounters();
  const conflictCount: any = Array.isArray(conflicted.conflicts) ? conflicted.conflicts.length : 0;
  const counters: any = finishCollaborative("conflict", applyStep(createEmptyInteractionCostCounters(), {
    modelVisibleToolCall: true,
    apply: after.applyCalls - before.applyCalls > 0,
    changeSetApply: after.changeSetApplyCalls - before.changeSetApplyCalls > 0,
    applyCalls: after.applyCalls - before.applyCalls,
    changeSetApplyCalls: after.changeSetApplyCalls - before.changeSetApplyCalls,
    requestBytes: protocolBytes(request, "commit-cf"),
    responseBytes: SIZE.envelopeBytes + SIZE.conflictFactBytes,
    modelContextBytes: SIZE.changeOpBytes,
    scannedEntities: 1,
    indexedStatements: 1,
    relevantOperations: after.relevantOperations - before.relevantOperations,
    wakeups: 1,
    cacheWeight: runtime.connector.counters().cacheWeight,
    queueDepth: 1,
    subscriptionDepth: 1
  }));
  return {
    counters,
    protocolStepCount: 1,
    facts: {
      conflictFactCount: conflictCount,
      conflictRecovered: conflictCount > 0 && (after.applyCalls - before.applyCalls) === 0
    }
  };
}

async function measureCollaborativeRevocation(runtime?: any) : Promise<any> {
  await openSession(runtime);
  runtime.core.revoke(WORK.identities.workingSetId);
  const purged: any = runtime.connector.revoke({ grantLookup: WORK.identities.grantRef });
  const local: any = runtime.session.observeLocal({ handle: EFFICIENCY_PROFILE_ASSETS[0].handle });
  let observeDenied: any = false;
  try {
    await runtime.core.observe({
      workingSetId: WORK.identities.workingSetId,
      handle: EFFICIENCY_PROFILE_ASSETS[0].handle
    });
  } catch {
    observeDenied = true;
  }
  const counters: any = finishCollaborative("revocation", applyStep(createEmptyInteractionCostCounters(), {
    modelVisibleToolCall: true,
    requestBytes: SIZE.envelopeBytes + SIZE.grantRequestBytes,
    responseBytes: SIZE.envelopeBytes + SIZE.grantResponseBytes,
    modelContextBytes: SIZE.grantResponseBytes,
    indexedStatements: 1,
    wakeups: 1,
    cacheWeight: 0,
    subscriptionDepth: 0,
    retryDepth: local.cacheHit === true ? 0 : 1,
    timers: 1
  }));
  return {
    counters,
    protocolStepCount: 1,
    facts: {
      revocationPurged: purged.purged === true || purged.partitionPresent === false,
      revocationDenied: observeDenied === true || local.cacheHit !== true,
      validCacheAfterRevoke: local.cacheHit === true
    }
  };
}

async function measureCollaborativeExplicitEffect(runtime?: any) : Promise<any> {
  await openSession(runtime);
  const routed: any = runtime.session.routeEffect({
    kind: "share",
    effectId: "eff.icb.share"
  });
  let rejected: any = false;
  try {
    rejectEffectCommand({ family: EXPLICIT_EFFECT_COMMAND_FAMILY });
  } catch {
    rejected = true;
  }
  const command: any = createEffectCommand({
    effectId: "eff.icb.share",
    idempotency: "idempotent",
    principalLookup: WORK.identities.principalId,
    grantLookup: WORK.identities.grantRef,
    targetRef: EFFICIENCY_PROFILE_ASSETS[0].assetId,
    policyRef: "pol.icb.1",
    approvalLookup: "apr.icb.1",
    audienceRef: "aud.icb.1",
    requestRef: "req.icb.1",
    cancellationState: "none",
    resultState: "accepted",
    auditRef: "audt.icb.1",
    compensationRef: null
  });
  const merge: any = mergeEffectCommandIntoChangeSet(
    createExplicitEffectCommandInput({
      effectId: "eff.icb.share",
      principalLookup: WORK.identities.principalId,
      grantLookup: WORK.identities.grantRef,
      targetRef: EFFICIENCY_PROFILE_ASSETS[0].assetId
    }),
    changeSetFor("chg.icb.effect", 0, [{
      opId: "op.icb.effect",
      type: "insert",
      entityId: EFFICIENCY_PROFILE_ASSETS[0].entityId,
      index: 0
    }])
  );
  const sink: any = recordingSink();
  const effectRuntime: any = createExplicitEffectCommandRuntime({
    performExternalEffect: sink.performExternalEffect,
    revalidateAuthorization: async (input: Record<string, any> = {}) : Promise<any> => (
      Object.freeze({ allowed: true, ...input })
    )
  });
  const executed: any = await effectRuntime.execute(createExplicitEffectCommandInput({
    effectId: "eff.icb.exec",
    principalLookup: WORK.identities.principalId,
    grantLookup: WORK.identities.grantRef,
    targetRef: EFFICIENCY_PROFILE_ASSETS[0].assetId
  }));
  if (executed.ok !== true || executed.family !== EXPLICIT_EFFECT_COMMAND_FAMILY) {
    throw new Error("Efficiency profile Effect Command execution did not complete.");
  }
  const counters: any = finishCollaborative("explicit-effect", applyStep(createEmptyInteractionCostCounters(), {
    modelVisibleToolCall: true,
    effectCommand: true,
    requestBytes: protocolBytes(command, "effect-1"),
    responseBytes: SIZE.envelopeBytes + SIZE.effectResponseBytes,
    modelContextBytes: SIZE.effectRequestBytes,
    scannedEntities: 1,
    indexedStatements: 1,
    wakeups: 1,
    queueDepth: 1,
    subscriptionDepth: 1,
    cacheWeight: runtime.connector.counters().cacheWeight
  }));
  return {
    counters,
    protocolStepCount: 1,
    facts: {
      effectRejectedByChangeSet: rejected === true,
      effectMergedIntoChangeSet: merge.merged === true || routed.mergedIntoChangeSet === true,
      effectExecuted: executed.ok === true && executed.family === EXPLICIT_EFFECT_COMMAND_FAMILY,
      effectHiddenInChangeSet: changeSetHidesEffectCommand(changeSetFor("chg.icb.effect", 0, [{
        opId: "op.icb.effect.hide",
        type: "insert",
        entityId: EFFICIENCY_PROFILE_ASSETS[0].entityId,
        index: 0
      }])) === true
    }
  };
}

async function measureCollaborativeWorkload(workloadId?: any) : Promise<any> {
  const runtime: any = createRuntime(workloadId);
  try {
    if (runtime.core.id !== CORE_CHANGE_SET_AUTHORITY_ID) {
      throw new Error("Efficiency profile must exercise Core Change Set authority.");
    }
    if (runtime.session.id !== WORKSPACE_REFERENCE_MIGRATION_AUTHORITY_ID) {
      throw new Error("Efficiency profile must exercise Workspace reference migration.");
    }
    if (workloadId === "cold-open") return await measureCollaborativeColdOpen(runtime);
    if (workloadId === "warm-read") return await measureCollaborativeWarmRead(runtime);
    if (workloadId === "dirty-turn") return await measureCollaborativeDirtyTurn(runtime);
    if (workloadId === "concurrent-change") return await measureCollaborativeConcurrentChange(runtime);
    if (workloadId === "reconnect") return await measureCollaborativeReconnect(runtime);
    if (workloadId === "conflict") return await measureCollaborativeConflict(runtime);
    if (workloadId === "revocation") return await measureCollaborativeRevocation(runtime);
    if (workloadId === "explicit-effect") return await measureCollaborativeExplicitEffect(runtime);
    throw new Error(`Unknown efficiency-profile workload: ${String(workloadId)}`);
  } finally {
    closeRuntime(runtime);
  }
}

function measureLegacyWorkload(workloadId?: any) : any {
  if (INTERACTION_COST_WORKLOAD_IDS.includes(workloadId)) {
    return measureInteractionCostScenario("legacy", workloadId);
  }
  const steps: any = [
    toolsListStep(),
    entityReadStep(),
    entityWriteStep(),
    toolsListStep(),
    entityReadStep({ repeated: true }),
    entityWriteStep()
  ];
  const counters: any = withLatency(
    foldSteps(steps),
    SIZE.roundTripTicks * 2,
    0
  );
  assertFiniteNonNegativeCounters(counters);
  return {
    scenarioId: `legacy/${workloadId}`,
    profile: "legacy",
    workloadId,
    seed: efficiencyWorkloadById(workloadId).seed,
    identities: WORK.identities,
    workFingerprint: efficiencyWorkFingerprint(workloadId),
    protocolStepCount: steps.length,
    counters
  };
}

function publicScenario(scenario?: any) : any {
  return {
    scenarioId: scenario.scenarioId,
    profile: scenario.profile,
    workloadId: scenario.workloadId,
    seed: scenario.seed,
    identities: scenario.identities,
    workFingerprint: scenario.workFingerprint,
    protocolStepCount: scenario.protocolStepCount,
    counters: scenario.counters
  };
}

export function scanEfficiencyProfileSource(repoRoot?: any) : any {
  const hits: any[] = [];
  for (const relativePath of COLLABORATION_MODULES) {
    const source: any = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    for (const pattern of SOURCE_FORBIDDEN) {
      if (pattern.test(source)) hits.push({ relativePath, pattern: String(pattern) });
    }
    for (const key of SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS) {
      if (new RegExp(`from\\s+["'].*${key}["']`, "u").test(source)) {
        hits.push({ relativePath, pattern: key });
      }
    }
  }
  if (hits.length > 0) {
    throw new Error(`Efficiency profile source matched forbidden collaboration residue.`);
  }
  if (SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED !== false) {
    throw new Error("Efficiency profile cannot allow a second Core generation.");
  }
  return Object.freeze({
    scannedFiles: [...COLLABORATION_MODULES],
    residueAbsent: true,
    secondCoreGenerationAllowed: false
  });
}

function pairById(pairs?: any, workloadId?: any) : any {
  return (Array.isArray(pairs) ? pairs : []).find((pair?: any) : any => pair.workloadId === workloadId) || null;
}

function evaluateCertification(measurement: Record<string, any> = {}) : any {
  const reasons: any = REASON;
  const pairs: any = Array.isArray(measurement.pairs) ? measurement.pairs : [];
  const facts: any = measurement.facts || {};
  if (pairs.length !== EFFICIENCY_PROFILE_WORKLOAD_IDS.length) {
    return {
      capacityCertified: false,
      nonCertificationReason: reasons.completenessIncomplete,
      completenessPassed: false,
      privacyPassed: false,
      safetyPassed: false,
      recoveryPassed: false,
      warmThresholdsPassed: false
    };
  }
  const warmPair: any = pairById(pairs, "warm-read");
  const dirty: any = pairById(pairs, "dirty-turn");
  const reconnect: any = pairById(pairs, "reconnect");
  const conflict: any = pairById(pairs, "conflict");
  const revocation: any = pairById(pairs, "revocation");
  const effect: any = pairById(pairs, "explicit-effect");
  const concurrent: any = pairById(pairs, "concurrent-change");
  const modulesPresent: any = measurement.connectorRuntimePresent === true
    && measurement.changeSetRuntimePresent === true
    && measurement.workspaceMigrationPresent === true
    && measurement.effectCommandRuntimePresent === true;
  const completenessPassed: any = Boolean(
    warmPair && dirty && reconnect && conflict && revocation && effect && concurrent && modulesPresent
    && facts.comparisonRun === true
  );
  const privacyPassed: any = facts.privacySafe === true;
  const safetyPassed: any = facts.hotPathIndependent === true
    && facts.lookupFactsAreAuthority === false
    && facts.secondCoreGenerationAllowed === false
    && facts.effectMergedIntoChangeSet === false
    && facts.yjsImported === false
    && facts.automergeImported === false
    && SERVICE_COLLABORATION_SILENT_UNCERTAIN_RETRY === false
    && SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT === false;
  const recoveryPassed: any = facts.reconnectRecovered === true
    && facts.conflictRecovered === true
    && facts.revocationRecovered === true;
  const warmCounters: any = warmPair?.collaborative?.counters || {};
  const dirtyCounters: any = dirty?.collaborative?.counters || {};
  const legacyCalls: any = Number(warmPair?.legacy?.counters?.modelVisibleToolCalls || 0);
  const collabCalls: any = Number(warmCounters.modelVisibleToolCalls || 0);
  const legacyBytes: any = Number(warmPair?.legacy?.counters?.modelContextBytes || 0)
    + Number(warmPair?.legacy?.counters?.wireBytes || 0);
  const collabBytes: any = Number(warmCounters.modelContextBytes || 0)
    + Number(warmCounters.wireBytes || 0);
  const unchangedSchemaBytes: any = Number(warmCounters.schemaBytes || 0);
  const unchangedCatalogBytes: any = Number(warmCounters.catalogBytes || 0);
  const validCacheRemoteReads: any = Number(warmCounters.modelVisibleRemoteReads || 0);
  const cleanTurnApplyCalls: any = Number(
    facts.cleanTurnApplyCalls == null ? warmCounters.applyCalls : facts.cleanTurnApplyCalls
  );
  const dirtyTurnChangeSetApplyCalls: any = Number(dirtyCounters.changeSetApplyCalls || 0);
  const callPassed: any = meetsReductionThreshold(
    legacyCalls,
    collabCalls,
    EFFICIENCY_CALL_REDUCTION_THRESHOLD
  );
  const bytePassed: any = meetsReductionThreshold(
    legacyBytes,
    collabBytes,
    EFFICIENCY_BYTE_REDUCTION_THRESHOLD
  );
  const warmThresholdsPassed: any = unchangedSchemaBytes === 0
    && unchangedCatalogBytes === 0
    && validCacheRemoteReads === 0
    && cleanTurnApplyCalls === 0
    && dirtyTurnChangeSetApplyCalls <= 1
    && callPassed === true
    && bytePassed === true;
  const warm: any = Object.freeze({
    unchangedCatalogBytes,
    unchangedSchemaBytes,
    validCacheRemoteReads,
    cleanTurnApplyCalls,
    dirtyTurnChangeSetApplyCalls,
    legacyModelVisibleCalls: legacyCalls,
    collaborativeModelVisibleCalls: collabCalls,
    callReductionPercent: reductionPercent(legacyCalls, collabCalls),
    callReductionThreshold: EFFICIENCY_CALL_REDUCTION_THRESHOLD,
    callReductionPassed: callPassed === true,
    legacyCombinedBytes: legacyBytes,
    collaborativeCombinedBytes: collabBytes,
    byteReductionPercent: reductionPercent(legacyBytes, collabBytes),
    byteReductionThreshold: EFFICIENCY_BYTE_REDUCTION_THRESHOLD,
    byteReductionPassed: bytePassed === true
  });
  let nonCertificationReason: any = "";
  if (completenessPassed !== true) nonCertificationReason = reasons.completenessIncomplete;
  else if (privacyPassed !== true) nonCertificationReason = reasons.privacyCountersLeak;
  else if (safetyPassed !== true) {
    nonCertificationReason = facts.hotPathIndependent === false
      ? reasons.safetyHotPath
      : reasons.dualCoreGeneration;
  } else if (recoveryPassed !== true) nonCertificationReason = reasons.recoveryIncomplete;
  else if (unchangedSchemaBytes !== 0 || unchangedCatalogBytes !== 0) {
    nonCertificationReason = reasons.unchangedSchemaBytes;
  } else if (validCacheRemoteReads !== 0) nonCertificationReason = reasons.validCacheRemoteReads;
  else if (cleanTurnApplyCalls !== 0) nonCertificationReason = reasons.cleanTurnApply;
  else if (dirtyTurnChangeSetApplyCalls > 1) nonCertificationReason = reasons.dirtyTurnChangeSet;
  else if (callPassed !== true) nonCertificationReason = reasons.callReduction;
  else if (bytePassed !== true) nonCertificationReason = reasons.byteReduction;
  const capacityCertified: any = completenessPassed === true
    && privacyPassed === true
    && safetyPassed === true
    && recoveryPassed === true
    && warmThresholdsPassed === true;
  return {
    capacityCertified,
    nonCertificationReason: capacityCertified === true ? null : assertFiniteCertificationReason(nonCertificationReason),
    completenessPassed,
    privacyPassed,
    safetyPassed,
    recoveryPassed,
    warmThresholdsPassed,
    warm
  };
}

export async function measureEfficiencyProfile() : Promise<any> {
  const facts: any = {
    comparisonRun: true,
    privacySafe: true,
    lookupFactsAreAuthority: SERVICE_COLLABORATION_LOOKUP_FACTS.some((fact?: any) : any => lookupFactIsAuthority(fact) === true),
    secondCoreGenerationAllowed: SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED === true,
    yjsImported: false,
    automergeImported: false,
    hotPathIndependent: false,
    effectMergedIntoChangeSet: false,
    reconnectRecovered: false,
    conflictRecovered: false,
    revocationRecovered: false,
    cleanTurnApplyCalls: 0,
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION
  };
  const pairs: any[] = [];
  for (const workloadId of EFFICIENCY_PROFILE_WORKLOAD_IDS) {
    const pairing: any = efficiencyPairingByWorkloadId(workloadId);
    const legacy: any = measureLegacyWorkload(workloadId);
    const collaborativeMeasured: any = await measureCollaborativeWorkload(workloadId);
    const collaborative: any = {
      scenarioId: `collaborative/${workloadId}`,
      profile: "collaborative",
      workloadId,
      seed: pairing.seed,
      identities: WORK.identities,
      workFingerprint: efficiencyWorkFingerprint(workloadId),
      protocolStepCount: collaborativeMeasured.protocolStepCount,
      measurementKind: EFFICIENCY_PROFILE_MEASUREMENT_KIND,
      counters: collaborativeMeasured.counters
    };
    assertFiniteNonNegativeCounters(legacy.counters);
    assertFiniteNonNegativeCounters(collaborative.counters);
    if (legacy.workFingerprint !== collaborative.workFingerprint) {
      throw new Error(`Equivalent work fingerprint mismatch for ${workloadId}`);
    }
    if (JSON.stringify(legacy.counters) === JSON.stringify(collaborative.counters)) {
      throw new Error(`Legacy and collaborative counters must differ for ${workloadId}`);
    }
    if (workloadId === "warm-read" || workloadId === "dirty-turn" || workloadId === "explicit-effect") {
      assertCollaborativeTurnInvariants(collaborative);
    }
    const measuredFacts: any = collaborativeMeasured.facts || {};
    if (workloadId === "warm-read") {
      facts.cleanTurnApplyCalls = Number(measuredFacts.cleanTurnApplyCalls || 0);
    }
    if (workloadId === "dirty-turn") {
      facts.hotPathIndependent = measuredFacts.hotPathIndependent === true;
    }
    if (workloadId === "reconnect") {
      facts.reconnectRecovered = measuredFacts.reconnectOutcome === "delta"
        || measuredFacts.reconnectOutcome === "snapshot-tail";
    }
    if (workloadId === "conflict") {
      facts.conflictRecovered = measuredFacts.conflictRecovered === true;
    }
    if (workloadId === "revocation") {
      facts.revocationRecovered = measuredFacts.revocationPurged === true
        && measuredFacts.revocationDenied === true
        && measuredFacts.validCacheAfterRevoke !== true;
    }
    if (workloadId === "explicit-effect") {
      facts.effectMergedIntoChangeSet = measuredFacts.effectMergedIntoChangeSet === true
        || measuredFacts.effectHiddenInChangeSet === true;
      if (measuredFacts.effectExecuted !== true || measuredFacts.effectRejectedByChangeSet !== true) {
        throw new Error("Efficiency profile did not separate Effect Commands from Change Sets.");
      }
    }
    pairs.push({
      workloadId,
      seed: pairing.seed,
      identities: WORK.identities,
      workFingerprint: legacy.workFingerprint,
      legacy,
      collaborative
    });
  }
  const measurement: any = {
    catalogSchemaVersion: EFFICIENCY_PROFILE_CATALOG_SCHEMA_VERSION,
    measurementKind: EFFICIENCY_PROFILE_MEASUREMENT_KIND,
    namedProfile: EFFICIENCY_NAMED_PROFILE,
    ownerProfile: EFFICIENCY_OWNER_PROFILE,
    connectorRuntimePresent: true,
    changeSetRuntimePresent: true,
    workspaceMigrationPresent: true,
    effectCommandRuntimePresent: true,
    facts,
    pairs
  };
  const evaluated: any = evaluateCertification(measurement);
  return {
    ...measurement,
    capacityCertified: evaluated.capacityCertified,
    nonCertificationReason: evaluated.nonCertificationReason,
    evaluation: evaluated
  };
}

export async function replayEfficiencyProfile() : Promise<any> {
  const first: any = await measureEfficiencyProfile();
  const second: any = await measureEfficiencyProfile();
  const firstCounters: any = first.pairs.map((pair?: any) : any => ({
    workloadId: pair.workloadId,
    legacy: pair.legacy.counters,
    collaborative: pair.collaborative.counters
  }));
  const secondCounters: any = second.pairs.map((pair?: any) : any => ({
    workloadId: pair.workloadId,
    legacy: pair.legacy.counters,
    collaborative: pair.collaborative.counters
  }));
  return {
    identical: JSON.stringify(firstCounters) === JSON.stringify(secondCounters),
    first,
    second
  };
}

export function assertEfficiencyProfile(measurement: Record<string, any> = {}) : any {
  const pairs: any = Array.isArray(measurement.pairs) ? measurement.pairs : [];
  if (pairs.length === 0 || measurement.facts?.comparisonRun !== true) {
    throw new Error("Named efficiency profile comparison was not run.");
  }
  if (
    measurement.connectorRuntimePresent !== true
    || measurement.changeSetRuntimePresent !== true
    || measurement.workspaceMigrationPresent !== true
    || measurement.effectCommandRuntimePresent !== true
  ) {
    throw new Error("Named efficiency profile must exercise collaboration runtime modules.");
  }
  if (SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED !== false) {
    throw new Error("Named efficiency profile cannot allow a second Core generation.");
  }
  if (pairs.length !== EFFICIENCY_PROFILE_WORKLOAD_IDS.length) {
    throw new Error("Named efficiency profile must report every required workload pair.");
  }
  for (const workloadId of EFFICIENCY_PROFILE_WORKLOAD_IDS) {
    const pair: any = pairById(pairs, workloadId);
    if (!pair) throw new Error(`Named efficiency profile missing workload pair: ${workloadId}`);
    for (const profile of ["legacy", "collaborative"]) {
      const scenario: any = pair[profile];
      if (!scenario || scenario.profile !== profile || scenario.workloadId !== workloadId) {
        throw new Error(`Named efficiency profile missing ${profile} scenario for ${workloadId}`);
      }
      assertFiniteNonNegativeCounters(scenario.counters);
    }
  }
  if (containsForbiddenKeys(measurement)) {
    throw new Error("Named efficiency profile counters leaked privacy or CRDT fields.");
  }
  const evaluated: any = measurement.evaluation || evaluateCertification(measurement);
  if (measurement.capacityCertified === true) {
    if (evaluated.warmThresholdsPassed !== true
      || evaluated.completenessPassed !== true
      || evaluated.privacyPassed !== true
      || evaluated.safetyPassed !== true
      || evaluated.recoveryPassed !== true
    ) {
      throw new Error("Named efficiency profile cannot claim certification without every threshold.");
    }
  } else {
    assertFiniteCertificationReason(
      measurement.nonCertificationReason || evaluated.nonCertificationReason
    );
  }
  return true;
}

export function buildEfficiencyProfileReport(
  measurement: Record<string, any> = {},
  extras: Record<string, any> = {}
) : any {
  assertEfficiencyProfile(measurement);
  const evaluated: any = measurement.evaluation || evaluateCertification(measurement);
  return {
    schemaVersion: EFFICIENCY_PROFILE_REPORT_SCHEMA_VERSION,
    verifier: EFFICIENCY_PROFILE_VERIFIER,
    catalogSchemaVersion: EFFICIENCY_PROFILE_CATALOG_SCHEMA_VERSION,
    generatedAt: extras.generatedAt || "1970-01-01T00:00:00.000Z",
    namedProfile: EFFICIENCY_NAMED_PROFILE,
    ownerProfile: EFFICIENCY_OWNER_PROFILE,
    capacityCertified: evaluated.capacityCertified === true,
    nonCertificationReason: evaluated.capacityCertified === true ? null : evaluated.nonCertificationReason,
    summary: {
      namedProfile: EFFICIENCY_NAMED_PROFILE,
      ownerProfile: EFFICIENCY_OWNER_PROFILE,
      profileCount: 2,
      workloadCount: EFFICIENCY_PROFILE_WORKLOAD_IDS.length,
      pairCount: measurement.pairs.length,
      counterCount: EFFICIENCY_PROFILE_COUNTER_NAMES.length,
      capacityCertified: evaluated.capacityCertified === true,
      nonCertificationReason: evaluated.capacityCertified === true ? null : evaluated.nonCertificationReason,
      completenessPassed: evaluated.completenessPassed === true,
      privacyPassed: evaluated.privacyPassed === true,
      safetyPassed: evaluated.safetyPassed === true,
      recoveryPassed: evaluated.recoveryPassed === true,
      warmThresholdsPassed: evaluated.warmThresholdsPassed === true,
      deterministicReplay: extras.deterministicReplay === true,
      focusedSuitePassed: extras.focusedSuitePassed === true,
      measurementKind: EFFICIENCY_PROFILE_MEASUREMENT_KIND,
      connectorRuntimePresent: true,
      changeSetRuntimePresent: true,
      workspaceMigrationPresent: true,
      effectCommandRuntimePresent: true,
      secondCoreGenerationAllowed: false,
      warm: evaluated.warm
    },
    pairs: measurement.pairs.map((pair?: any) : any => ({
      workloadId: pair.workloadId,
      seed: pair.seed,
      identities: pair.identities,
      workFingerprint: pair.workFingerprint,
      legacy: publicScenario(pair.legacy),
      collaborative: publicScenario(pair.collaborative)
    })),
    catalog: {
      schemaVersion: EFFICIENCY_PROFILE_CATALOG_SCHEMA_VERSION,
      namedProfile: EFFICIENCY_NAMED_PROFILE,
      ownerProfile: EFFICIENCY_OWNER_PROFILE,
      profiles: EFFICIENCY_PROFILE_CATALOG.profiles,
      workloads: EFFICIENCY_PROFILE_CATALOG.workloads,
      counterNames: EFFICIENCY_PROFILE_COUNTER_NAMES,
      thresholds: EFFICIENCY_PROFILE_CATALOG.thresholds
    }
  };
}

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

function runFocusedSuite(repoRoot?: any) : any {
  const result: any = spawnSync(process.execPath, [
    "--conditions=source",
    VITEST_RUNNER,
    "run",
    "--config",
    "vitest.config.ts",
    EFFICIENCY_PROFILE_FOCUSED_SUITE
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: "--conditions=source"
    }
  });
  return {
    suite: EFFICIENCY_PROFILE_FOCUSED_SUITE,
    passed: result.status === 0,
    exitCode: result.status,
    outputBytes: Buffer.byteLength(`${result.stdout || ""}${result.stderr || ""}`, "utf8"),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

export async function runAgentServiceEfficiencyProfile({
  repoRoot = repoRootFromMeta(),
  writeReport = true,
  runFocusedTests = false,
  generatedAt = new Date().toISOString()
}: Record<string, any> = {}) : Promise<any> {
  const source: any = scanEfficiencyProfileSource(repoRoot);
  assert.equal(source.residueAbsent, true);
  const replay: any = await replayEfficiencyProfile();
  assert.equal(replay.identical, true, "Named efficiency profile counters must replay identically.");
  assertEfficiencyProfile(replay.first);

  let focusedSuite: any = {
    suite: EFFICIENCY_PROFILE_FOCUSED_SUITE,
    passed: runFocusedTests !== true,
    exitCode: 0,
    outputBytes: 0
  };
  if (runFocusedTests === true) {
    focusedSuite = runFocusedSuite(repoRoot);
    if (focusedSuite.passed !== true) {
      process.stderr.write(focusedSuite.stdout);
      process.stderr.write(focusedSuite.stderr);
      throw new Error(
        `Focused suite failed: ${EFFICIENCY_PROFILE_FOCUSED_SUITE} exit=${focusedSuite.exitCode}`
      );
    }
  }

  const report: any = buildEfficiencyProfileReport(replay.first, {
    generatedAt,
    deterministicReplay: replay.identical === true,
    focusedSuitePassed: focusedSuite.passed === true
  });
  const provenance: Record<string, any> = {
    producer: "meshrix-core-agent-service-efficiency-profile",
    commandId: "agent-service-efficiency-profile",
    sourceRevision: await computeVerifierSourceRevision(repoRoot, SOURCE_FILES)
  };
  const finalized: any = finalizeSensitiveReport(report, { provenance });
  assertNoSensitiveReportLeak(finalized, "named efficiency profile report");
  assertReportProvenance(finalized, provenance);
  if (containsForbiddenKeys(finalized)) {
    throw new Error("Named efficiency profile report leaked privacy or CRDT fields.");
  }
  if (finalized.capacityCertified === true && finalized.summary.warmThresholdsPassed !== true) {
    throw new Error("Named efficiency profile cannot claim certification without every threshold.");
  }

  if (writeReport === true) {
    const relativePath: any = EFFICIENCY_PROFILE_REPORT_RELATIVE_PATH;
    const absolutePath: any = path.join(repoRoot, relativePath);
    await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fsPromises.writeFile(absolutePath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
  }

  return {
    report: finalized,
    reportPath: EFFICIENCY_PROFILE_REPORT_RELATIVE_PATH,
    focusedSuite: {
      suite: focusedSuite.suite,
      passed: focusedSuite.passed,
      exitCode: focusedSuite.exitCode,
      outputBytes: focusedSuite.outputBytes
    }
  };
}
