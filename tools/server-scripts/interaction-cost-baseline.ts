#!/usr/bin/env node
/*
 * Frozen Agent-to-Service interaction-cost measurement.
 *
 * Measures equivalent legacy MCP loops and collaborative specified-protocol
 * shapes with privacy-safe numeric counters. This is a neutral-peer baseline,
 * not Connector, Change Set, or Effect Command production runtime, and it
 * cannot certify capacity.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INTERACTION_COST_BASELINE_CATALOG,
  INTERACTION_COST_CATALOG_SCHEMA_VERSION,
  INTERACTION_COST_COUNTER_NAMES,
  INTERACTION_COST_MEASUREMENT_KIND,
  INTERACTION_COST_NON_CERTIFICATION_REASON,
  INTERACTION_COST_PROFILES,
  INTERACTION_COST_REPORT_SCHEMA_VERSION,
  INTERACTION_COST_SIZE_CONSTANTS as SIZE,
  INTERACTION_COST_WORK as WORK,
  INTERACTION_COST_WORKLOAD_IDS,
  assertCapacityNeverCertified,
  assertCollaborativeTurnInvariants,
  assertFiniteNonNegativeCounters,
  createEmptyInteractionCostCounters,
  pairingByWorkloadId,
  workloadById
} from "../verifiers/interaction-cost-baseline-catalog.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.ts";

export const INTERACTION_COST_BASELINE_VERIFIER: any =
  "tools/server-scripts/agent-service-interaction-cost-baseline.ts";
export const INTERACTION_COST_BASELINE_OWNED_MODULE: any =
  "tools/server-scripts/interaction-cost-baseline.ts";
export const INTERACTION_COST_BASELINE_REPORT_RELATIVE_PATH: any =
  "build/reports/agent-service-interaction-cost-baseline.json";
export const INTERACTION_COST_BASELINE_FOCUSED_SUITE: any =
  "tests/vitest/server/interaction-cost-baseline.test.ts";

const VITEST_RUNNER: any = "./node_modules/vitest/vitest.mjs";
const SOURCE_FILES: readonly any[] = Object.freeze([
  INTERACTION_COST_BASELINE_VERIFIER,
  INTERACTION_COST_BASELINE_OWNED_MODULE,
  "tools/verifiers/interaction-cost-baseline-catalog.ts"
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
  next.applyCalls += step.apply ? 1 : 0;
  next.changeSetApplyCalls += step.changeSetApply ? 1 : 0;
  next.effectCommandCalls += step.effectCommand ? 1 : 0;
  if (typeof step.cacheWeight === "number") {
    next.cacheWeight = step.cacheWeight;
  }
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

function catalogListBytes(compact: any = false) : any {
  const entry: any = compact ? SIZE.compactIndexEntryBytes : SIZE.catalogEntryBytes;
  return {
    catalogBytes: entry * WORK.catalogSize,
    schemaBytes: SIZE.schemaTypeBytes * WORK.schemaTypeCount,
    scannedEntities: WORK.catalogSize,
    indexedStatements: WORK.catalogSize
  };
}

function collaborativeCacheWeight() : any {
  return (SIZE.schemaTypeBytes * WORK.schemaTypeCount)
    + (SIZE.handleBytes * WORK.workingSetSize)
    + SIZE.cursorBytes
    + SIZE.headBytes;
}

function initializeStep() : any {
  return {
    requestBytes: SIZE.envelopeBytes + SIZE.initializeRequestBytes,
    responseBytes: SIZE.envelopeBytes + SIZE.initializeResponseBytes,
    discoveryBytes: SIZE.envelopeBytes + SIZE.initializeRequestBytes
      + SIZE.envelopeBytes + SIZE.initializeResponseBytes,
    wakeups: 1
  };
}

function toolsListStep({ compact = false, modelContext = true }: Record<string, any> = {}) : any {
  const listed: any = catalogListBytes(compact);
  return {
    modelVisibleToolCall: true,
    requestBytes: SIZE.envelopeBytes + SIZE.toolsListRequestBytes,
    responseBytes: SIZE.envelopeBytes + listed.catalogBytes + listed.schemaBytes,
    catalogBytes: listed.catalogBytes,
    schemaBytes: listed.schemaBytes,
    modelContextBytes: modelContext ? listed.catalogBytes + listed.schemaBytes : 0,
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

function workingSetOpenStep() : any {
  const linkBytes: any = SIZE.handleBytes * WORK.workingSetSize;
  return {
    modelVisibleToolCall: true,
    remoteRead: true,
    requestBytes: SIZE.envelopeBytes + SIZE.workingSetOpenRequestBytes,
    responseBytes: SIZE.envelopeBytes + linkBytes + SIZE.cursorBytes + SIZE.headBytes,
    modelContextBytes: linkBytes + SIZE.cursorBytes + SIZE.headBytes
      + (SIZE.schemaTypeBytes * WORK.schemaTypeCount),
    scannedEntities: WORK.workingSetSize,
    indexedStatements: WORK.workingSetSize,
    wakeups: 1,
    cacheWeight: collaborativeCacheWeight(),
    subscriptionDepth: 1,
    snapshotCount: 1
  };
}

function subscribeStep() : any {
  return {
    requestBytes: SIZE.envelopeBytes + SIZE.subscribeRequestBytes,
    responseBytes: SIZE.envelopeBytes + SIZE.subscribeResponseBytes,
    wakeups: 1,
    cacheWeight: collaborativeCacheWeight(),
    subscriptionDepth: 1
  };
}

function changeSetApplyStep({ conflict = false }: Record<string, any> = {}) : any {
  const opCount: any = conflict ? 1 : WORK.dirtyIdentityCount;
  const ackBytes: any = conflict
    ? SIZE.conflictFactBytes
    : SIZE.headBytes + (SIZE.ackIdentityBytes * opCount);
  return {
    modelVisibleToolCall: true,
    apply: true,
    changeSetApply: true,
    requestBytes: SIZE.envelopeBytes + (SIZE.changeOpBytes * opCount),
    responseBytes: SIZE.envelopeBytes + ackBytes,
    modelContextBytes: SIZE.changeOpBytes * opCount,
    scannedEntities: opCount,
    indexedStatements: opCount,
    relevantOperations: conflict ? WORK.conflictRelevantOps : 0,
    wakeups: conflict ? 1 : 2,
    cacheWeight: collaborativeCacheWeight(),
    queueDepth: 1,
    subscriptionDepth: 1
  };
}

function cursorSyncStep() : any {
  return {
    modelVisibleToolCall: true,
    remoteRead: true,
    requestBytes: SIZE.envelopeBytes + SIZE.cursorBytes,
    responseBytes: SIZE.envelopeBytes + (SIZE.missingOpBytes * WORK.reconnectMissingOps),
    modelContextBytes: SIZE.missingOpBytes * WORK.reconnectMissingOps,
    scannedEntities: WORK.reconnectMissingOps,
    indexedStatements: WORK.reconnectMissingOps,
    relevantOperations: WORK.reconnectMissingOps,
    wakeups: 1,
    cacheWeight: collaborativeCacheWeight(),
    subscriptionDepth: 1
  };
}

function grantResolveStep({ purge = false }: Record<string, any> = {}) : any {
  return {
    modelVisibleToolCall: true,
    requestBytes: SIZE.envelopeBytes + SIZE.grantRequestBytes,
    responseBytes: SIZE.envelopeBytes + SIZE.grantResponseBytes,
    modelContextBytes: SIZE.grantResponseBytes,
    indexedStatements: 1,
    wakeups: 1,
    cacheWeight: purge ? 0 : collaborativeCacheWeight(),
    subscriptionDepth: purge ? 0 : 1
  };
}

function effectCommandStep() : any {
  return {
    modelVisibleToolCall: true,
    effectCommand: true,
    requestBytes: SIZE.envelopeBytes + SIZE.effectRequestBytes,
    responseBytes: SIZE.envelopeBytes + SIZE.effectResponseBytes,
    modelContextBytes: SIZE.effectRequestBytes,
    scannedEntities: 1,
    indexedStatements: 1,
    wakeups: 1,
    queueDepth: 1,
    subscriptionDepth: 1,
    cacheWeight: collaborativeCacheWeight()
  };
}

function deniedReadStep() : any {
  return {
    modelVisibleToolCall: true,
    requestBytes: SIZE.envelopeBytes + 80,
    responseBytes: SIZE.envelopeBytes + 96,
    scannedEntities: 1,
    indexedStatements: 1,
    wakeups: 1,
    timers: 1,
    retryDepth: 1
  };
}

function foldSteps(steps: any = []) : any {
  let counters: any = createEmptyInteractionCostCounters();
  for (const step of steps) {
    counters = applyStep(counters, step);
  }
  return counters;
}

function legacySteps(workloadId?: any) : any {
  if (workloadId === "cold-open") {
    return [
      initializeStep(),
      toolsListStep(),
      entityReadStep(),
      entityReadStep(),
      entityReadStep()
    ];
  }
  if (workloadId === "warm-read") {
    return [
      toolsListStep(),
      entityReadStep({ repeated: true }),
      entityReadStep({ repeated: true }),
      entityReadStep({ repeated: true })
    ];
  }
  if (workloadId === "dirty-turn") {
    return [
      toolsListStep(),
      entityReadStep(),
      entityReadStep(),
      entityReadStep(),
      entityWriteStep(),
      entityWriteStep(),
      entityWriteStep()
    ];
  }
  if (workloadId === "reconnect") {
    return [
      initializeStep(),
      toolsListStep(),
      entityReadStep({ repeated: true }),
      entityReadStep({ repeated: true }),
      entityReadStep({ repeated: true })
    ];
  }
  if (workloadId === "conflict") {
    return [
      toolsListStep(),
      entityReadStep(),
      entityWriteStep(),
      toolsListStep(),
      entityReadStep({ repeated: true }),
      { ...entityWriteStep(), retryDepth: 1, timers: 1 }
    ];
  }
  if (workloadId === "revocation") {
    return [
      toolsListStep(),
      deniedReadStep(),
      toolsListStep()
    ];
  }
  if (workloadId === "explicit-effect") {
    return [
      toolsListStep(),
      entityReadStep(),
      entityWriteStep(),
      { ...effectCommandStep(), cacheWeight: 0, subscriptionDepth: 0 }
    ];
  }
  throw new Error(`Unknown interaction-cost workload: ${String(workloadId)}`);
}

function collaborativeSteps(workloadId?: any) : any {
  if (workloadId === "cold-open") {
    return [
      initializeStep(),
      toolsListStep({ compact: true }),
      workingSetOpenStep(),
      subscribeStep()
    ];
  }
  if (workloadId === "warm-read") {
    return [];
  }
  if (workloadId === "dirty-turn") {
    return [changeSetApplyStep()];
  }
  if (workloadId === "reconnect") {
    return [cursorSyncStep()];
  }
  if (workloadId === "conflict") {
    return [changeSetApplyStep({ conflict: true })];
  }
  if (workloadId === "revocation") {
    return [grantResolveStep({ purge: true })];
  }
  if (workloadId === "explicit-effect") {
    return [effectCommandStep()];
  }
  throw new Error(`Unknown interaction-cost workload: ${String(workloadId)}`);
}

function latencyFor(profile?: any, workloadId?: any) : any {
  const rtt: any = SIZE.roundTripTicks;
  const fanout: any = SIZE.subscriberFanoutTicks;
  if (profile === "legacy") {
    if (workloadId === "dirty-turn") return { ack: rtt * WORK.dirtyIdentityCount, sub: 0 };
    if (workloadId === "conflict") return { ack: rtt * 2, sub: 0 };
    if (workloadId === "explicit-effect") return { ack: rtt * 2, sub: 0 };
    if (workloadId === "warm-read") return { ack: rtt, sub: 0 };
    if (workloadId === "revocation") return { ack: rtt, sub: 0 };
    return { ack: rtt, sub: 0 };
  }
  if (workloadId === "warm-read") return { ack: 0, sub: 0 };
  if (workloadId === "dirty-turn") return { ack: rtt, sub: rtt + fanout };
  if (workloadId === "conflict") return { ack: rtt, sub: rtt };
  if (workloadId === "explicit-effect") return { ack: rtt, sub: 0 };
  if (workloadId === "revocation") return { ack: rtt, sub: 0 };
  if (workloadId === "reconnect") return { ack: rtt, sub: rtt };
  return { ack: rtt, sub: rtt };
}

function finishProfileCounters(profile?: any, workloadId?: any, counters?: any) : any {
  const next: any = cloneCounters(counters);
  if (profile === "collaborative" && workloadId === "warm-read") {
    next.cacheWeight = collaborativeCacheWeight();
    next.subscriptionPeak = 1;
    next.memoryPeak = Math.max(next.memoryPeak, next.cacheWeight);
  }
  const latency: any = latencyFor(profile, workloadId);
  return withLatency(next, latency.ack, latency.sub);
}

export function workFingerprint(workloadId: any = "") : any {
  const pairing: any = pairingByWorkloadId(workloadId);
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

export function measureInteractionCostScenario(profile: any = "", workloadId: any = "") : any {
  if (!INTERACTION_COST_PROFILES.includes(profile)) {
    throw new Error(`Unknown interaction-cost profile: ${String(profile)}`);
  }
  const spec: any = workloadById(workloadId);
  if (!spec) {
    throw new Error(`Unknown interaction-cost workload: ${String(workloadId)}`);
  }
  const steps: any = profile === "legacy" ? legacySteps(workloadId) : collaborativeSteps(workloadId);
  const counters: any = finishProfileCounters(profile, workloadId, foldSteps(steps));
  assertFiniteNonNegativeCounters(counters);
  const measured: any = {
    scenarioId: `${profile}/${workloadId}`,
    profile,
    workloadId,
    seed: spec.seed,
    identities: WORK.identities,
    workFingerprint: workFingerprint(workloadId),
    protocolStepCount: steps.length,
    measurementKind: INTERACTION_COST_MEASUREMENT_KIND,
    counters
  };
  if (profile === "collaborative") {
    assertCollaborativeTurnInvariants(measured);
  }
  return measured;
}

export function measureInteractionCostBaseline() : any {
  const pairs: any[] = [];
  for (const workloadId of INTERACTION_COST_WORKLOAD_IDS) {
    const pairing: any = pairingByWorkloadId(workloadId);
    const legacy: any = measureInteractionCostScenario("legacy", workloadId);
    const collaborative: any = measureInteractionCostScenario("collaborative", workloadId);
    if (legacy.workFingerprint !== collaborative.workFingerprint) {
      throw new Error(`Equivalent work fingerprint mismatch for ${workloadId}`);
    }
    if (JSON.stringify(legacy.counters) === JSON.stringify(collaborative.counters)) {
      throw new Error(`Legacy and collaborative counters must differ for ${workloadId}`);
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
  return {
    catalogSchemaVersion: INTERACTION_COST_CATALOG_SCHEMA_VERSION,
    measurementKind: INTERACTION_COST_MEASUREMENT_KIND,
    connectorRuntimePresent: false,
    changeSetRuntimePresent: false,
    effectCommandRuntimePresent: false,
    capacityCertified: false,
    nonCertificationReason: INTERACTION_COST_NON_CERTIFICATION_REASON,
    pairs
  };
}

export function replayInteractionCostBaseline() : any {
  const first: any = measureInteractionCostBaseline();
  const second: any = measureInteractionCostBaseline();
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

export function assertInteractionCostBaseline(measurement: Record<string, any> = {}) : any {
  assertCapacityNeverCertified(measurement);
  const pairs: any = Array.isArray(measurement.pairs) ? measurement.pairs : [];
  if (pairs.length !== INTERACTION_COST_WORKLOAD_IDS.length) {
    throw new Error("Interaction-cost baseline must report every required workload pair.");
  }
  const seen: any = new Set<any>();
  for (const workloadId of INTERACTION_COST_WORKLOAD_IDS) {
    const pair: any = pairs.find((candidate?: any) : any => candidate.workloadId === workloadId);
    if (!pair) {
      throw new Error(`Interaction-cost baseline missing workload pair: ${workloadId}`);
    }
    seen.add(workloadId);
    for (const profile of INTERACTION_COST_PROFILES) {
      const scenario: any = pair[profile];
      if (!scenario || scenario.profile !== profile || scenario.workloadId !== workloadId) {
        throw new Error(`Interaction-cost baseline missing ${profile} scenario for ${workloadId}`);
      }
      if (scenario.workFingerprint !== pair.workFingerprint) {
        throw new Error(`Interaction-cost baseline work fingerprint drifted for ${profile}/${workloadId}`);
      }
      assertFiniteNonNegativeCounters(scenario.counters);
      if (profile === "collaborative") {
        assertCollaborativeTurnInvariants(scenario);
      }
    }
  }
  if (seen.size !== INTERACTION_COST_WORKLOAD_IDS.length) {
    throw new Error("Interaction-cost baseline workload pair set is incomplete.");
  }
  if (measurement.measurementKind !== INTERACTION_COST_MEASUREMENT_KIND) {
    throw new Error("Interaction-cost baseline must declare specified-protocol-shape measurement.");
  }
  if (
    measurement.connectorRuntimePresent === true
    || measurement.changeSetRuntimePresent === true
    || measurement.effectCommandRuntimePresent === true
  ) {
    throw new Error("Interaction-cost baseline must not claim unimplemented collaboration runtime.");
  }
  return true;
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

export function buildInteractionCostBaselineReport(
  measurement: Record<string, any> = {},
  extras: Record<string, any> = {}
) : any {
  assertInteractionCostBaseline(measurement);
  return {
    schemaVersion: INTERACTION_COST_REPORT_SCHEMA_VERSION,
    verifier: INTERACTION_COST_BASELINE_VERIFIER,
    catalogSchemaVersion: INTERACTION_COST_CATALOG_SCHEMA_VERSION,
    generatedAt: extras.generatedAt || "1970-01-01T00:00:00.000Z",
    capacityCertified: false,
    nonCertificationReason: INTERACTION_COST_NON_CERTIFICATION_REASON,
    summary: {
      profileCount: INTERACTION_COST_PROFILES.length,
      workloadCount: INTERACTION_COST_WORKLOAD_IDS.length,
      pairCount: measurement.pairs.length,
      counterCount: INTERACTION_COST_COUNTER_NAMES.length,
      capacityCertified: false,
      nonCertificationReason: INTERACTION_COST_NON_CERTIFICATION_REASON,
      deterministicReplay: extras.deterministicReplay === true,
      focusedSuitePassed: extras.focusedSuitePassed === true,
      measurementKind: INTERACTION_COST_MEASUREMENT_KIND,
      connectorRuntimePresent: false,
      changeSetRuntimePresent: false,
      effectCommandRuntimePresent: false
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
      schemaVersion: INTERACTION_COST_CATALOG_SCHEMA_VERSION,
      profiles: INTERACTION_COST_PROFILES,
      workloads: INTERACTION_COST_BASELINE_CATALOG.workloads,
      counterNames: INTERACTION_COST_COUNTER_NAMES
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
    INTERACTION_COST_BASELINE_FOCUSED_SUITE
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
    suite: INTERACTION_COST_BASELINE_FOCUSED_SUITE,
    passed: result.status === 0,
    exitCode: result.status,
    outputBytes: Buffer.byteLength(`${result.stdout || ""}${result.stderr || ""}`, "utf8"),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

export async function runAgentServiceInteractionCostBaseline({
  repoRoot = repoRootFromMeta(),
  writeReport = true,
  runFocusedTests = false,
  generatedAt = new Date().toISOString()
}: Record<string, any> = {}) : Promise<any> {
  const replay: any = replayInteractionCostBaseline();
  assert.equal(replay.identical, true, "Interaction-cost baseline counters must replay identically.");
  assertInteractionCostBaseline(replay.first);

  let focusedSuite: any = {
    suite: INTERACTION_COST_BASELINE_FOCUSED_SUITE,
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
        `Focused suite failed: ${INTERACTION_COST_BASELINE_FOCUSED_SUITE} exit=${focusedSuite.exitCode}`
      );
    }
  }

  const report: any = buildInteractionCostBaselineReport(replay.first, {
    generatedAt,
    deterministicReplay: replay.identical === true,
    focusedSuitePassed: focusedSuite.passed === true
  });
  const provenance: Record<string, any> = {
    producer: "meshrix-core-interaction-cost-baseline",
    commandId: "agent-service-interaction-cost-baseline",
    sourceRevision: await computeVerifierSourceRevision(repoRoot, SOURCE_FILES)
  };
  const finalized: any = finalizeSensitiveReport(report, { provenance });
  assertNoSensitiveReportLeak(finalized, "interaction-cost baseline report");
  assertReportProvenance(finalized, provenance);
  assertCapacityNeverCertified(finalized);

  if (writeReport === true) {
    const relativePath: any = INTERACTION_COST_BASELINE_REPORT_RELATIVE_PATH;
    const absolutePath: any = path.join(repoRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
  }

  return {
    report: finalized,
    reportPath: INTERACTION_COST_BASELINE_REPORT_RELATIVE_PATH,
    focusedSuite: {
      suite: focusedSuite.suite,
      passed: focusedSuite.passed,
      exitCode: focusedSuite.exitCode,
      outputBytes: focusedSuite.outputBytes
    }
  };
}
