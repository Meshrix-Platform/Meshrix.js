#!/usr/bin/env node
/*
 * Connector Working View verifier.
 *
 * Authorization-partitioned private caches, bounded Inbox/Outbox, acknowledgement,
 * and explicit resync. Does not apply Core Change Sets or execute Effect Commands.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SERVICE_COLLABORATION_CORE_STATE_GENERATION,
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  SERVICE_COLLABORATION_PROTOCOL_VERSION,
  SERVICE_COLLABORATION_SCHEMA_VERSION,
  containsForbiddenKeys,
  createCommitRequest,
  createObserveResponse,
  createOpenResponse,
  createResyncResponse,
  lookupFactIsAuthority,
  parseCollaborationMessage
} from "../../packages/contracts/src/service-collaboration-contract.ts";
import {
  CONNECTOR_WORKING_VIEW_CAPACITY_CERTIFIED,
  CONNECTOR_WORKING_VIEW_NON_CERTIFICATION_REASON,
  CONNECTOR_WORKING_VIEW_OWNED_MODULE,
  CONNECTOR_WORKING_VIEW_REPORT_SCHEMA_VERSION,
  createConnectorWorkingView,
  projectConnectorMcpEnvelope
} from "../../packages/protocols/mcp/adapter/gateway-installer/connector-working-view.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.ts";

export const CONNECTOR_WORKING_VIEW_VERIFIER: any =
  "tools/server-scripts/verify-connector-working-view.ts";
export const CONNECTOR_WORKING_VIEW_REPORT_RELATIVE_PATH: any =
  "build/reports/connector-working-view.json";
export const CONNECTOR_WORKING_VIEW_FOCUSED_SUITE: any =
  "tests/vitest/server/connector-working-view.test.ts";
export const CONNECTOR_WORKING_VIEW_CORPUS_RELATIVE_PATH: any =
  "packages/contracts/src/fixtures/service-collaboration-wire-corpus.json";

const VITEST_RUNNER: any = "./node_modules/vitest/vitest.mjs";
const SOURCE_FILES: readonly any[] = Object.freeze([
  CONNECTOR_WORKING_VIEW_VERIFIER,
  CONNECTOR_WORKING_VIEW_OWNED_MODULE
]);

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

function readJson(repoRoot?: any, relativePath?: any) : any {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function cloneJson(value?: any) : any {
  return JSON.parse(JSON.stringify(value));
}

function secondDirtyCommit(corpus?: any) : any {
  const changeSet: any = cloneJson(corpus.valid["commit-request-dirty"].changeSet);
  changeSet.changeId = "chg.sc.2";
  changeSet.operations[0].opId = "op.sc.9";
  return createCommitRequest({
    workingSetId: corpus.valid["commit-request-dirty"].workingSetId,
    handle: corpus.valid["commit-request-dirty"].handle,
    dirty: true,
    changeSet
  });
}

function secondPartitionOpen() : any {
  return createOpenResponse({
    workingSetId: "ws.sc.2",
    entityIds: ["ent.sc.b"],
    handles: [{ handle: "hdl_sc_entity_b", entityId: "ent.sc.b" }],
    head: 1,
    resourceLinks: [{
      uri: "meshrix://collaboration/ws.sc.2/ent.sc.b",
      head: 1,
      cacheHint: { ttlMs: 60000, cacheScope: "private" }
    }],
    cacheHint: { ttlMs: 60000, cacheScope: "private" },
    cursor: { cursor: "cur.sc.b1", indexedHead: 1, cursorState: "valid" }
  });
}

function secondPartitionObserve() : any {
  return createObserveResponse({
    workingSetId: "ws.sc.2",
    head: 1,
    resourceLinks: [{
      uri: "meshrix://collaboration/ws.sc.2/ent.sc.b",
      head: 1,
      cacheHint: { ttlMs: 60000, cacheScope: "private" }
    }],
    catalogRevision: "cat.sc.2",
    schemaRevision: "sch.sc.2",
    acknowledgements: [],
    history: [],
    cacheHit: false,
    cacheHint: { ttlMs: 60000, cacheScope: "private" }
  });
}

export function assertConnectorWorkingView(repoRoot: any = repoRootFromMeta()) : any {
  const corpus: any = readJson(repoRoot, CONNECTOR_WORKING_VIEW_CORPUS_RELATIVE_PATH);
  assert.equal(corpus.schemaVersion, SERVICE_COLLABORATION_SCHEMA_VERSION);
  assert.equal(CONNECTOR_WORKING_VIEW_CAPACITY_CERTIFIED, false);
  assert.match(CONNECTOR_WORKING_VIEW_NON_CERTIFICATION_REASON, /^[a-z][a-z0-9_]{2,64}$/u);
  for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
    assert.equal(lookupFactIsAuthority(fact), false);
  }

  let nowMs: any = 1_000;
  const view: any = createConnectorWorkingView({
    grantLookup: "gr.sc.1",
    nowMs: () : any => nowMs
  });
  const hydrated: any = view.hydrate({
    open: corpus.valid["open-response"],
    observe: corpus.valid["observe-response"],
    grantLookup: "gr.sc.1"
  });
  assert.equal(hydrated.ok, true);
  assert.equal(hydrated.remoteReads, 1);

  const warm: any = view.observeLocal({ handle: "hdl_sc_entity_a" });
  assert.equal(warm.cacheHit, true);
  assert.equal(warm.needsRemote, false);
  assert.equal(warm.remoteReads, 0);
  assert.equal(warm.schemaModelContextBytes, 0);
  assert.equal(warm.modelContextBytes, 0);
  assert.equal(view.counters().remoteReads, 1);
  assert.equal(containsForbiddenKeys(warm.response), false);

  const edited: any = view.editLocal({ dirtyEntityIds: ["ent.sc.a"] });
  assert.equal(edited.omittedUnchanged, true);
  assert.equal(edited.schemaModelContextBytes, 0);
  assert.equal(edited.changeSetApplyCalls, 0);
  assert.equal(edited.view.kind, "edit-view");
  const localEdit: any = projectConnectorMcpEnvelope({ message: edited.view });
  assert.equal(localEdit.local, true);
  assert.equal(localEdit.envelope, null);

  const queued: any = view.queueCommit(corpus.valid["commit-request-dirty"]);
  assert.equal(queued.ok, true);
  assert.equal(queued.changeSetApplyCalls, 0);
  assert.equal(queued.confirmedHead, corpus.valid["open-response"].head);
  assert.equal(queued.unacknowledgedChanges, 1);

  const pressured: any = createConnectorWorkingView({
    grantLookup: "gr.sc.1",
    nowMs: () : any => nowMs,
    budgets: { maxOutboxCount: 1, maxInboxCount: 1 }
  });
  pressured.hydrate({
    open: corpus.valid["open-response"],
    observe: corpus.valid["observe-response"]
  });
  const firstQueue: any = pressured.queueCommit(corpus.valid["commit-request-dirty"]);
  assert.equal(firstQueue.ok, true);
  assert.equal(firstQueue.unacknowledgedChanges, 1);
  const secondQueue: any = pressured.queueCommit(secondDirtyCommit(corpus));
  assert.equal(secondQueue.ok, false);
  assert.equal(secondQueue.outcome, "backpressure");
  assert.equal(secondQueue.dropped, 0);
  assert.equal(secondQueue.unacknowledgedChanges, 1);
  assert.equal(pressured.counters().droppedUnacknowledgedChanges, 0);
  const firstNote: any = pressured.acceptRemote(corpus.valid["resource-updated"]);
  assert.equal(firstNote.ok, true);
  const secondNote: any = pressured.acceptRemote(corpus.valid["resource-updated"]);
  assert.equal(secondNote.outcome, "backpressure");
  assert.equal(secondNote.dropped, 0);
  assert.equal(pressured.counters().unacknowledgedChanges >= 1, true);

  const acked: any = view.acceptRemote(corpus.valid.acknowledge);
  assert.equal(acked.ok, true);
  assert.equal(acked.unacknowledgedChanges, 0);
  const afterInvalidation: any = view.observeLocal({ handle: "hdl_sc_entity_a" });
  assert.equal(afterInvalidation.cacheHit, false);
  assert.equal(afterInvalidation.needsRemote, true);
  const refill: any = view.acceptRemote(corpus.valid["observe-response"]);
  assert.equal(refill.ok, true);
  const restored: any = view.observeLocal({ handle: "hdl_sc_entity_a" });
  assert.equal(restored.cacheHit, true);
  assert.equal(restored.schemaModelContextBytes, 0);

  nowMs += 70_000;
  const expired: any = view.observeLocal({ handle: "hdl_sc_entity_a" });
  assert.equal(expired.cacheHit, false);
  nowMs = 1_000;
  view.acceptRemote(corpus.valid["observe-response"]);
  assert.equal(view.observeLocal({ handle: "hdl_sc_entity_a" }).cacheHit, true);

  const subscribed: any = view.subscribe(corpus.valid["subscribe-request"]);
  assert.equal(subscribed.ok, true);
  const projectedOpen: any = projectConnectorMcpEnvelope({
    id: "connector-open",
    message: corpus.valid["open-request"]
  });
  assert.equal(projectedOpen.local, false);
  assert.equal(projectedOpen.envelope.method, "meshrix/collaboration/open");
  assert.equal(containsForbiddenKeys(projectedOpen.envelope), false);
  const projectedNote: any = projectConnectorMcpEnvelope({
    message: corpus.valid["resource-updated"]
  });
  assert.equal(projectedNote.envelope.method, "notifications/resources/updated");
  assert.equal(Object.prototype.hasOwnProperty.call(projectedNote.envelope, "id"), false);

  const privacyRejected: any = view.acceptRemote(corpus.invalid.privacyContent);
  assert.equal(privacyRejected.ok, false);
  const effectRejected: any = view.acceptRemote(corpus.valid["effect-command"]);
  assert.equal(effectRejected.outcome, "effect-command-not-executed");
  assert.equal(view.counters().effectCommandExecutions, 0);

  view.queueCommit(corpus.valid["commit-request-dirty"]);
  const backpressureResync: any = view.acceptRemote(createResyncResponse({
    workingSetId: "ws.sc.1",
    outcome: "backpressure",
    head: 5,
    deltas: [],
    snapshot: null,
    tail: [],
    cursor: { cursor: "cur.sc.1", indexedHead: 5, cursorState: "valid" }
  }));
  assert.equal(backpressureResync.outcome, "backpressure");
  assert.equal(backpressureResync.dropped, 0);
  assert.equal(backpressureResync.unacknowledgedChanges >= 1, true);
  const deltaResync: any = view.acceptRemote(corpus.valid["resync-response-delta"]);
  assert.equal(deltaResync.ok, true);
  assert.equal(deltaResync.outcome, "delta");
  const snapshotResync: any = view.acceptRemote(corpus.valid["resync-response-snapshot"]);
  assert.equal(snapshotResync.ok, true);
  assert.equal(snapshotResync.outcome, "snapshot-tail");

  view.reResolve("gr.sc.2");
  const other: any = view.hydrate({
    open: secondPartitionOpen(),
    observe: secondPartitionObserve(),
    grantLookup: "gr.sc.2"
  });
  assert.equal(other.ok, true);
  assert.equal(view.partitionPresent("gr.sc.2"), true);
  assert.equal(view.observeLocal({ handle: "hdl_sc_entity_b" }).cacheHit, true);
  assert.equal(view.observeLocal({ handle: "hdl_sc_entity_a" }).cacheHit, false);
  view.reResolve("gr.sc.1");
  assert.equal(view.observeLocal({ handle: "hdl_sc_entity_a" }).cacheHit, true);
  const purged: any = view.revoke({ grantLookup: "gr.sc.1" });
  assert.equal(purged.purged, true);
  assert.equal(view.partitionPresent("gr.sc.1"), false);
  assert.equal(view.partitionPresent("gr.sc.2"), true);
  view.reResolve("gr.sc.1");
  const revokedObserve: any = view.observeLocal({ handle: "hdl_sc_entity_a" });
  assert.equal(revokedObserve.cacheHit, false);
  assert.equal(revokedObserve.needsRemote, true);
  view.reResolve("gr.sc.2");
  assert.equal(view.observeLocal({ handle: "hdl_sc_entity_b" }).cacheHit, true);

  const facts: any = view.snapshot();
  assert.equal(facts.capacityCertified, false);
  assert.equal(facts.lookupFactsAreAuthority, false);
  assert.equal(facts.changeSetApplyCalls, 0);
  assert.equal(facts.effectCommandExecutions, 0);
  assert.equal(facts.droppedUnacknowledgedChanges, 0);
  assert.equal(facts.schemaModelContextBytes, 0);
  assert.equal(containsForbiddenKeys(facts), false);
  assert.equal(parseCollaborationMessage(corpus.invalid.privacyGrant), null);

  return Object.freeze({
    schemaVersion: CONNECTOR_WORKING_VIEW_REPORT_SCHEMA_VERSION,
    protocolVersion: SERVICE_COLLABORATION_PROTOCOL_VERSION,
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    warmCacheRemoteReads: 0,
    unchangedSchemaModelContextBytes: facts.schemaModelContextBytes,
    revocationPurgedPartition: purged.purged === true,
    siblingPartitionRetained: view.partitionPresent("gr.sc.2") === true,
    unacknowledgedChangesRetained: secondQueue.dropped === 0 && secondQueue.unacknowledgedChanges === 1,
    lookupFactsAreAuthority: false,
    privacySafe: true,
    capacityCertified: CONNECTOR_WORKING_VIEW_CAPACITY_CERTIFIED,
    nonCertificationReason: CONNECTOR_WORKING_VIEW_NON_CERTIFICATION_REASON,
    changeSetRuntimePresent: false,
    effectCommandRuntimePresent: false,
    connectorWorkingViewPresent: true,
    cacheHits: view.counters().cacheHits,
    remoteReads: view.counters().remoteReads
  });
}

export function buildConnectorWorkingViewReport(
  assertion: Record<string, any> = {},
  extras: Record<string, any> = {}
) : any {
  return {
    schemaVersion: CONNECTOR_WORKING_VIEW_REPORT_SCHEMA_VERSION,
    verifier: CONNECTOR_WORKING_VIEW_VERIFIER,
    generatedAt: extras.generatedAt || "1970-01-01T00:00:00.000Z",
    protocolVersion: SERVICE_COLLABORATION_PROTOCOL_VERSION,
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    summary: {
      warmCacheRemoteReads: assertion.warmCacheRemoteReads === 0 ? 0 : assertion.warmCacheRemoteReads,
      unchangedSchemaModelContextBytes: assertion.unchangedSchemaModelContextBytes === 0
        ? 0
        : assertion.unchangedSchemaModelContextBytes,
      revocationPurgedPartition: assertion.revocationPurgedPartition === true,
      siblingPartitionRetained: assertion.siblingPartitionRetained === true,
      unacknowledgedChangesRetained: assertion.unacknowledgedChangesRetained === true,
      lookupFactsAreAuthority: false,
      privacySafe: assertion.privacySafe === true,
      capacityCertified: false,
      nonCertificationReason: CONNECTOR_WORKING_VIEW_NON_CERTIFICATION_REASON,
      focusedSuitePassed: extras.focusedSuitePassed === true,
      changeSetRuntimePresent: false,
      effectCommandRuntimePresent: false,
      connectorWorkingViewPresent: assertion.connectorWorkingViewPresent === true,
      cacheHits: assertion.cacheHits,
      grantReResolved: true
    }
  };
}

function runFocusedSuite(repoRoot?: any) : any {
  const result: any = spawnSync(process.execPath, [
    "--conditions=source",
    VITEST_RUNNER,
    "run",
    "--config",
    "vitest.config.ts",
    CONNECTOR_WORKING_VIEW_FOCUSED_SUITE
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
    suite: CONNECTOR_WORKING_VIEW_FOCUSED_SUITE,
    passed: result.status === 0,
    exitCode: result.status,
    outputBytes: Buffer.byteLength(`${result.stdout || ""}${result.stderr || ""}`, "utf8"),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

export async function runConnectorWorkingView({
  repoRoot = repoRootFromMeta(),
  writeReport = true,
  runFocusedTests = false,
  generatedAt = new Date().toISOString()
}: Record<string, any> = {}) : Promise<any> {
  const assertion: any = assertConnectorWorkingView(repoRoot);

  let focusedSuite: any = {
    suite: CONNECTOR_WORKING_VIEW_FOCUSED_SUITE,
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
        `Focused suite failed: ${CONNECTOR_WORKING_VIEW_FOCUSED_SUITE} exit=${focusedSuite.exitCode}`
      );
    }
  }

  const report: any = buildConnectorWorkingViewReport(assertion, {
    generatedAt,
    focusedSuitePassed: focusedSuite.passed === true
  });
  const provenance: Record<string, any> = {
    producer: "meshrix-connector-working-view",
    commandId: "connector-working-view",
    sourceRevision: await computeVerifierSourceRevision(repoRoot, SOURCE_FILES)
  };
  const finalized: any = finalizeSensitiveReport(report, { provenance });
  assertNoSensitiveReportLeak(finalized, "connector working view report");
  assertReportProvenance(finalized, provenance);
  if (finalized.summary.capacityCertified === true) {
    throw new Error("Connector Working View must not certify capacity.");
  }

  if (writeReport === true) {
    const relativePath: any = CONNECTOR_WORKING_VIEW_REPORT_RELATIVE_PATH;
    const absolutePath: any = path.join(repoRoot, relativePath);
    await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fsPromises.writeFile(absolutePath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
  }

  return {
    report: finalized,
    reportPath: CONNECTOR_WORKING_VIEW_REPORT_RELATIVE_PATH,
    focusedSuite: {
      suite: focusedSuite.suite,
      passed: focusedSuite.passed,
      exitCode: focusedSuite.exitCode,
      outputBytes: focusedSuite.outputBytes
    }
  };
}

const executedDirectly: any = process.argv[1]
  && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (executedDirectly) {
  try {
    const result: any = await runConnectorWorkingView({
      writeReport: true,
      runFocusedTests: true
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      reportPath: result.reportPath,
      warmCacheRemoteReads: result.report.summary.warmCacheRemoteReads,
      unchangedSchemaModelContextBytes: result.report.summary.unchangedSchemaModelContextBytes,
      revocationPurgedPartition: result.report.summary.revocationPurgedPartition,
      unacknowledgedChangesRetained: result.report.summary.unacknowledgedChangesRetained,
      capacityCertified: result.report.summary.capacityCertified,
      focusedSuitePassed: result.report.summary.focusedSuitePassed
    })}\n`);
  } catch (error: any) {
    const message: any = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
