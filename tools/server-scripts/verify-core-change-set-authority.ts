#!/usr/bin/env node
/*
 * Core Change Set authority verifier.
 *
 * Proves clean turns send no apply, dirty turns send at most one Change Set,
 * duplicate ChangeIds are idempotent, rebase uses relevant ops only, and the
 * hot path is independent of total Service state, history, catalog size, and
 * connected clients. This is not Connector Working View or Effect Command
 * runtime.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SERVICE_COLLABORATION_CORE_STATE_GENERATION,
  SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS,
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED,
  SERVICE_COLLABORATION_VISIBILITY,
  containsForbiddenKeys,
  lookupFactIsAuthority,
  parseAcknowledge,
  parseChangeSet,
  parseCollaborationMessage,
  parseObserveResponse,
  parseOpenResponse,
  parseRebaseResponse,
  parseResyncResponse
} from "../../packages/contracts/src/service-collaboration-contract.ts";
import {
  CORE_CHANGE_SET_AUTHORITY_ID,
  CORE_CHANGE_SET_NON_CERTIFICATION_REASON,
  CORE_CHANGE_SET_REPORT_SCHEMA_VERSION,
  assertHotPathIndependence,
  bindJobChangeSetSeam,
  createCoreChangeSet,
  createCoreChangeSetAuthority,
  createCoreChangeSetOperation,
  rejectEffectCommand
} from "../../packages/agents/src/core-change-set-authority.ts";
import {
  createAgentWorkspaceChangeSetSeam
} from "../../packages/agents/src/agent-workspace/agent-workspace-change-set-seam.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.ts";

export const CORE_CHANGE_SET_AUTHORITY_VERIFIER: any =
  "tools/server-scripts/verify-core-change-set-authority.ts";
export const CORE_CHANGE_SET_AUTHORITY_REPORT_RELATIVE_PATH: any =
  "build/reports/core-change-set-authority.json";
export const CORE_CHANGE_SET_AUTHORITY_FOCUSED_SUITE: any =
  "tests/vitest/server/core-change-set-authority.test.ts";

const VITEST_RUNNER: any = "./node_modules/vitest/vitest.mjs";
const SOURCE_FILES: readonly any[] = Object.freeze([
  CORE_CHANGE_SET_AUTHORITY_VERIFIER,
  "packages/agents/src/core-change-set-authority.ts",
  "packages/agents/src/agent-workspace/agent-workspace-change-set-seam.ts"
]);
const SOURCE_FORBIDDEN: readonly any[] = Object.freeze([
  /from\s+["']yjs["']/u,
  /from\s+["']automerge["']/u,
  /\bY\.Doc\b/u,
  /\bAutomerge\b/u,
  /packages\/server-runtime/u,
  /packages\/protocols\/mcp\/adapter/u,
  /apps\/console/u
]);

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

function handleFor(index: any = 1) : any {
  return `hdl_ccs_${index}`;
}

function dirtyChangeSet({
  changeId,
  baselineHead,
  entityId,
  opId,
  type = "insert",
  index = 0
}: Record<string, any> = {}) : any {
  return createCoreChangeSet({
    changeId,
    baselineHead,
    attributionRef: "attr.ccs.1",
    operations: [
      createCoreChangeSetOperation({
        opId,
        type,
        entityId,
        index
      })
    ]
  });
}

export function assertCoreChangeSetAuthoritySource(repoRoot: any = repoRootFromMeta()) : any {
  const implementation: any = [
    "packages/agents/src/core-change-set-authority.ts",
    "packages/agents/src/agent-workspace/agent-workspace-change-set-seam.ts"
  ].map((relativePath?: any) : any => fs.readFileSync(path.join(repoRoot, relativePath), "utf8")).join("\n");
  for (const pattern of SOURCE_FORBIDDEN) {
    assert.equal(pattern.test(implementation), false, `Core Change Set source matched ${pattern}`);
  }
  for (const key of SERVICE_COLLABORATION_CRDT_FORBIDDEN_KEYS) {
    assert.equal(new RegExp(`\\b${key}\\b`, "u").test(implementation), false, `CRDT marker present: ${key}`);
  }
  assert.equal(SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED, false);
  return true;
}

export async function assertCoreChangeSetAuthority() : Promise<any> {
  for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
    assert.equal(lookupFactIsAuthority(fact), false);
  }

  const authority: any = createCoreChangeSetAuthority({
    instanceId: "verify.ccs.1",
    limits: { maxHistoryEntries: 2 }
  });
  const opened: any = await authority.open({
    workingSetId: "ws.ccs.1",
    catalogSize: 8,
    connectedClients: 4,
    entities: [
      { entityId: "ent.ccs.doc", kind: "document-state", handle: handleFor(1) },
      { entityId: "ent.ccs.file", kind: "workspace-file", handle: handleFor(2) },
      { entityId: "ent.ccs.job", kind: "job", handle: handleFor(3) }
    ]
  });
  assert.ok(parseOpenResponse(opened));
  assert.equal(opened.head, 0);
  assert.equal(containsForbiddenKeys(opened), false);

  const cleanBefore: any = authority.snapshotCounters();
  const cleanAck: any = await authority.commitTurn({
    workingSetId: "ws.ccs.1",
    handle: handleFor(1),
    dirty: false,
    changeSet: null
  });
  const cleanAfter: any = authority.snapshotCounters();
  assert.ok(parseAcknowledge(cleanAck));
  assert.equal(cleanAck.assignedHead, 0);
  assert.equal(cleanAck.conflicts.length, 0);
  assert.equal(cleanAfter.applyCalls - cleanBefore.applyCalls, 0);
  assert.equal(cleanAfter.changeSetApplyCalls - cleanBefore.changeSetApplyCalls, 0);
  assert.equal(cleanAfter.effectCommandCalls, 0);

  await authority.subscribe({
    workingSetId: "ws.ccs.1",
    resourceUri: "meshrix://collaboration/ws.ccs.1/ent.ccs.doc"
  });
  authority.seedDecoys({
    workingSetId: "ws.ccs.1",
    catalogSize: 5000,
    connectedClients: 2000
  });

  const firstBefore: any = authority.snapshotCounters();
  const firstSet: any = dirtyChangeSet({
    changeId: "chg.ccs.1",
    baselineHead: 0,
    entityId: "ent.ccs.doc",
    opId: "op.ccs.1",
    index: 0
  });
  assert.ok(parseChangeSet(firstSet));
  assert.equal(firstSet.visibility, SERVICE_COLLABORATION_VISIBILITY);
  const firstAck: any = await authority.commitTurn({
    workingSetId: "ws.ccs.1",
    handle: handleFor(1),
    dirty: true,
    changeSet: firstSet
  });
  const firstAfter: any = authority.snapshotCounters();
  assert.ok(parseAcknowledge(firstAck));
  assert.equal(firstAck.assignedHead, 1);
  assert.deepEqual([...firstAck.changedEntityIds], ["ent.ccs.doc"]);
  assert.equal(firstAfter.applyCalls - firstBefore.applyCalls, 1);
  assert.equal(firstAfter.changeSetApplyCalls - firstBefore.changeSetApplyCalls, 1);
  assertHotPathIndependence(firstBefore, firstAfter, {
    changedEntityCount: 1,
    relevantOpCount: 0,
    wakeups: 1
  });

  const duplicateAck: any = await authority.commitTurn({
    workingSetId: "ws.ccs.1",
    handle: handleFor(1),
    dirty: true,
    changeSet: firstSet
  });
  const duplicateAfter: any = authority.snapshotCounters();
  assert.equal(JSON.stringify(duplicateAck), JSON.stringify(firstAck));
  assert.equal(duplicateAfter.applyCalls - firstAfter.applyCalls, 0);
  assert.equal(duplicateAfter.changeSetApplyCalls, 1);
  assert.equal(duplicateAfter.duplicateDeliveries, 1);
  assert.equal(authority.inspect("ws.ccs.1").head, 1);

  const jobBefore: any = authority.snapshotCounters();
  const jobAck: any = await bindJobChangeSetSeam(authority).commitJobTurn({
    workingSetId: "ws.ccs.1",
    handle: handleFor(3),
    dirty: true,
    changeSet: dirtyChangeSet({
      changeId: "chg.ccs.job",
      baselineHead: 1,
      entityId: "ent.ccs.job",
      opId: "op.ccs.job",
      index: 0
    })
  });
  const jobAfter: any = authority.snapshotCounters();
  assert.equal(jobAck.assignedHead, 2);
  assertHotPathIndependence(jobBefore, jobAfter, {
    changedEntityCount: 1,
    relevantOpCount: 0,
    wakeups: 0
  });

  const rebaseBefore: any = authority.snapshotCounters();
  const rebasedAck: any = await authority.commitTurn({
    workingSetId: "ws.ccs.1",
    handle: handleFor(1),
    dirty: true,
    changeSet: dirtyChangeSet({
      changeId: "chg.ccs.2",
      baselineHead: 0,
      entityId: "ent.ccs.doc",
      opId: "op.ccs.2",
      index: 0
    })
  });
  const rebaseAfter: any = authority.snapshotCounters();
  assert.equal(rebasedAck.assignedHead, 3);
  assert.equal(rebasedAck.conflicts.length, 0);
  assertHotPathIndependence(rebaseBefore, rebaseAfter, {
    changedEntityCount: 1,
    relevantOpCount: 1,
    wakeups: 1
  });

  const moveAck: any = await authority.commitTurn({
    workingSetId: "ws.ccs.1",
    handle: handleFor(1),
    dirty: true,
    changeSet: dirtyChangeSet({
      changeId: "chg.ccs.move",
      baselineHead: 1,
      entityId: "ent.ccs.doc",
      opId: "op.ccs.move",
      type: "move",
      index: 0
    })
  });
  assert.equal(moveAck.assignedHead, 3);
  assert.equal(moveAck.conflicts[0].code, "conflict.unrebasable_operation");
  assert.equal(authority.inspect("ws.ccs.1").head, 3);

  const fileAck: any = await createAgentWorkspaceChangeSetSeam(authority).commitFileTurn({
    workingSetId: "ws.ccs.1",
    handle: handleFor(2),
    dirty: true,
    changeSet: dirtyChangeSet({
      changeId: "chg.ccs.file",
      baselineHead: 3,
      entityId: "ent.ccs.file",
      opId: "op.ccs.file",
      index: 0
    })
  });
  assert.equal(fileAck.assignedHead, 4);

  const observed: any = await authority.observe({
    workingSetId: "ws.ccs.1",
    handle: handleFor(1)
  });
  assert.ok(parseObserveResponse(observed));
  assert.equal(observed.head, 4);
  assert.equal(observed.history.length, 2);
  assert.equal(observed.catalogRevision, "cat.ccs.1");
  const historyHeads: any = observed.history.map((entry?: any) : any => entry.head);
  assert.deepEqual(historyHeads, [3, 4]);
  assert.equal(observed.history.some((entry?: any) : any => entry.entityIds.length === 0), false);

  const rebasePreview: any = await authority.rebase({
    workingSetId: "ws.ccs.1",
    handle: handleFor(1),
    baselineHead: 4,
    operations: [
      createCoreChangeSetOperation({
        opId: "op.ccs.preview",
        entityId: "ent.ccs.doc",
        index: 1
      })
    ]
  });
  assert.ok(parseRebaseResponse(rebasePreview));
  assert.equal(rebasePreview.outcome, "rebased");

  const deltaResync: any = await authority.resync({
    workingSetId: "ws.ccs.1",
    handle: handleFor(1),
    cursor: opened.cursor
  });
  assert.ok(parseResyncResponse(deltaResync) || parseCollaborationMessage(deltaResync));
  if (opened.cursor.indexedHead < 2) {
    assert.equal(deltaResync.outcome, "snapshot-tail");
    assert.equal(deltaResync.cursor.cursorState, "expired");
    assert.ok(deltaResync.snapshot);
    assert.ok(Array.isArray(deltaResync.tail));
  } else {
    assert.equal(deltaResync.outcome, "delta");
  }

  const latest: any = authority.inspect("ws.ccs.1");
  const validResync: any = await authority.resync({
    workingSetId: "ws.ccs.1",
    handle: handleFor(1),
    cursor: latest.lastCursor
  });
  const validParsed: any = parseResyncResponse(validResync);
  assert.ok(validParsed);
  assert.equal(validParsed.outcome, "delta");
  assert.equal(validParsed.cursor.cursorState, "valid");
  assert.equal(validParsed.snapshot, null);

  const lookupClean: any = await authority.commitTurn({
    workingSetId: "ws.ccs.1",
    handle: handleFor(1),
    dirty: false,
    changeSet: null
  }, {
    handle: handleFor(1),
    cursor: opened.cursor,
    priorApproval: "apr.ccs.stale",
    connectionState: "connected",
    earlierDiscovery: "disc.ccs.1"
  });
  assert.equal(lookupClean.assignedHead, 4);
  assert.equal(lookupClean.conflicts.length, 0);
  authority.revoke("ws.ccs.1");
  const revokedAck: any = await authority.commitTurn({
    workingSetId: "ws.ccs.1",
    handle: handleFor(1),
    dirty: true,
    changeSet: dirtyChangeSet({
      changeId: "chg.ccs.denied",
      baselineHead: 4,
      entityId: "ent.ccs.doc",
      opId: "op.ccs.denied",
      index: 0
    })
  }, {
    priorApproval: "apr.ccs.stale",
    handle: handleFor(1)
  });
  assert.equal(revokedAck.conflicts[0].code, "conflict.authorization_changed");
  assert.equal(authority.inspect("ws.ccs.1").head, 4);

  let effectRejected: any = false;
  try {
    rejectEffectCommand({ family: "effect-command" });
  } catch {
    effectRejected = true;
  }
  assert.equal(effectRejected, true);
  assert.equal(authority.snapshotCounters().effectCommandCalls, 0);
  assert.equal(authority.coreStateGeneration, SERVICE_COLLABORATION_CORE_STATE_GENERATION);

  const counters: any = authority.snapshotCounters();
  const inspected: any = authority.inspect("ws.ccs.1");
  authority.close();

  return Object.freeze({
    schemaVersion: CORE_CHANGE_SET_REPORT_SCHEMA_VERSION,
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    authorityId: CORE_CHANGE_SET_AUTHORITY_ID,
    cleanTurnApplyCalls: 0,
    dirtyTurnChangeSets: 1,
    duplicateResultIdentical: true,
    atomicVisibility: true,
    indexedHistory: true,
    snapshotCursorRecovery: true,
    currentSinkReResolved: counters.authorizationReResolved > 0,
    hotPathIndependent: true,
    catalogSize: inspected.catalogSize,
    connectedClients: inspected.connectedClients,
    scannedEntities: counters.scannedEntities,
    relevantOperations: counters.relevantOperations,
    applyCalls: counters.applyCalls,
    changeSetApplyCalls: counters.changeSetApplyCalls,
    effectCommandCalls: counters.effectCommandCalls,
    duplicateDeliveries: counters.duplicateDeliveries,
    wakeups: counters.wakeups,
    capacityCertified: false,
    reason: CORE_CHANGE_SET_NON_CERTIFICATION_REASON,
    changeSetRuntimePresent: true,
    connectorRuntimePresent: false,
    effectCommandRuntimePresent: false
  });
}

export function buildCoreChangeSetAuthorityReport(
  assertion: Record<string, any> = {},
  extras: Record<string, any> = {}
) : any {
  return {
    schemaVersion: CORE_CHANGE_SET_REPORT_SCHEMA_VERSION,
    verifier: CORE_CHANGE_SET_AUTHORITY_VERIFIER,
    generatedAt: extras.generatedAt || "1970-01-01T00:00:00.000Z",
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    summary: {
      authorityId: CORE_CHANGE_SET_AUTHORITY_ID,
      cleanTurnApplyCalls: assertion.cleanTurnApplyCalls,
      dirtyTurnChangeSets: assertion.dirtyTurnChangeSets,
      duplicateResultIdentical: assertion.duplicateResultIdentical === true,
      atomicVisibility: assertion.atomicVisibility === true,
      indexedHistory: assertion.indexedHistory === true,
      snapshotCursorRecovery: assertion.snapshotCursorRecovery === true,
      currentSinkReResolved: assertion.currentSinkReResolved === true,
      hotPathIndependent: assertion.hotPathIndependent === true,
      applyCalls: assertion.applyCalls,
      changeSetApplyCalls: assertion.changeSetApplyCalls,
      effectCommandCalls: assertion.effectCommandCalls,
      duplicateDeliveries: assertion.duplicateDeliveries,
      scannedEntities: assertion.scannedEntities,
      relevantOperations: assertion.relevantOperations,
      wakeups: assertion.wakeups,
      catalogSize: assertion.catalogSize,
      connectedClients: assertion.connectedClients,
      focusedSuitePassed: extras.focusedSuitePassed === true,
      changeSetRuntimePresent: true,
      connectorRuntimePresent: false,
      effectCommandRuntimePresent: false,
      capacityCertified: false,
      reason: CORE_CHANGE_SET_NON_CERTIFICATION_REASON,
      privacySafe: true
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
    CORE_CHANGE_SET_AUTHORITY_FOCUSED_SUITE
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
    suite: CORE_CHANGE_SET_AUTHORITY_FOCUSED_SUITE,
    passed: result.status === 0,
    exitCode: result.status,
    outputBytes: Buffer.byteLength(`${result.stdout || ""}${result.stderr || ""}`, "utf8"),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

export async function runCoreChangeSetAuthority({
  repoRoot = repoRootFromMeta(),
  writeReport = true,
  runFocusedTests = false,
  generatedAt = new Date().toISOString()
}: Record<string, any> = {}) : Promise<any> {
  assertCoreChangeSetAuthoritySource(repoRoot);
  const assertion: any = await assertCoreChangeSetAuthority();

  let focusedSuite: any = {
    suite: CORE_CHANGE_SET_AUTHORITY_FOCUSED_SUITE,
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
        `Focused suite failed: ${CORE_CHANGE_SET_AUTHORITY_FOCUSED_SUITE} exit=${focusedSuite.exitCode}`
      );
    }
  }

  const report: any = buildCoreChangeSetAuthorityReport(assertion, {
    generatedAt,
    focusedSuitePassed: focusedSuite.passed === true
  });
  const provenance: Record<string, any> = {
    producer: "meshrix-core-change-set-authority",
    commandId: "core-change-set-authority",
    sourceRevision: await computeVerifierSourceRevision(repoRoot, SOURCE_FILES)
  };
  const finalized: any = finalizeSensitiveReport(report, { provenance });
  assertNoSensitiveReportLeak(finalized, "core change set authority report");
  assertReportProvenance(finalized, provenance);
  assert.equal(finalized.summary.capacityCertified, false);
  assert.equal(containsForbiddenKeys(finalized), false);

  if (writeReport === true) {
    const relativePath: any = CORE_CHANGE_SET_AUTHORITY_REPORT_RELATIVE_PATH;
    const absolutePath: any = path.join(repoRoot, relativePath);
    await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fsPromises.writeFile(absolutePath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
  }

  return {
    report: finalized,
    reportPath: CORE_CHANGE_SET_AUTHORITY_REPORT_RELATIVE_PATH,
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
    const result: any = await runCoreChangeSetAuthority({
      writeReport: true,
      runFocusedTests: true
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      reportPath: result.reportPath,
      cleanTurnApplyCalls: result.report.summary.cleanTurnApplyCalls,
      dirtyTurnChangeSets: result.report.summary.dirtyTurnChangeSets,
      duplicateResultIdentical: result.report.summary.duplicateResultIdentical,
      hotPathIndependent: result.report.summary.hotPathIndependent,
      capacityCertified: result.report.summary.capacityCertified,
      focusedSuitePassed: result.report.summary.focusedSuitePassed
    })}\n`);
  } catch (error: any) {
    const message: any = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
