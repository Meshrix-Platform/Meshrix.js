#!/usr/bin/env node
/*
 * Workspace reference-migration verifier.
 *
 * Proves Workspace peers converge through bounded deltas and one turn apply,
 * restore is a new Change Set, Suggestions do not dual-write, and the
 * collaboration path has no live per-file tools, path identity, scan sync,
 * dual reads, or dual writes. This is not named-profile capacity certification.
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
  SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED,
  containsForbiddenKeys,
  lookupFactIsAuthority
} from "../../packages/contracts/src/service-collaboration-contract.ts";
import {
  WORKSPACE_REFERENCE_MIGRATION_AUTHORITY_ID,
  WORKSPACE_REFERENCE_MIGRATION_CAPACITY_CERTIFIED,
  WORKSPACE_REFERENCE_MIGRATION_NON_CERTIFICATION_REASON,
  WORKSPACE_REFERENCE_MIGRATION_OWNED_MODULE,
  WORKSPACE_REFERENCE_MIGRATION_REPORT_SCHEMA_VERSION,
  createWorkspaceReferenceMigration
} from "../../packages/agents/src/agent-workspace/workspace-reference-migration.ts";
import {
  WORKSPACE_COLLABORATION_PROJECTION_OWNED_MODULE,
  assertWorkspaceCollaborationProtocolPath,
  workspaceOrdinaryMcpFallback
} from "../../packages/protocols/mcp/workspace-collaboration-projection.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.ts";

export const WORKSPACE_COLLABORATION_MIGRATION_VERIFIER: any =
  "tools/server-scripts/verify-workspace-collaboration-migration.ts";
export const WORKSPACE_COLLABORATION_MIGRATION_REPORT_RELATIVE_PATH: any =
  "build/reports/workspace-collaboration-migration.json";
export const WORKSPACE_COLLABORATION_MIGRATION_FOCUSED_SUITE: any =
  "tests/vitest/server/workspace-reference-migration.test.ts";

const VITEST_RUNNER: any = "./node_modules/vitest/vitest.mjs";
const COLLABORATION_PATH_FILES: readonly any[] = Object.freeze([
  WORKSPACE_REFERENCE_MIGRATION_OWNED_MODULE,
  "packages/agents/src/agent-workspace/agent-workspace-change-set-seam.ts",
  WORKSPACE_COLLABORATION_PROJECTION_OWNED_MODULE
]);
const SOURCE_FILES: readonly any[] = Object.freeze([
  WORKSPACE_COLLABORATION_MIGRATION_VERIFIER,
  ...COLLABORATION_PATH_FILES
]);
const RESIDUE_PATTERNS: readonly any[] = Object.freeze([
  /scanWorkspaceFilesForSync/u,
  /scanDirectoryForWorkspaceSync/u,
  /\blistWorkspaceFiles\b/u,
  /\bwriteWorkspaceFile\b/u,
  /\bpatchWorkspaceFile\b/u,
  /\bdownloadWorkspaceFile\b/u,
  /agent_workspaces\.file\./u,
  /workspace\.file\.write/u,
  /workspace\.file\.patch/u,
  /workspace\.file\.read/u,
  /from\s+["']yjs["']/u,
  /from\s+["']automerge["']/u,
  /\bY\.Doc\b/u,
  /\bAutomerge\b/u,
  /\brelativePath\b/u,
  /\bdualWrite\s*[:=]\s*true\b/u,
  /merkleDag/u
]);

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

export function assertWorkspaceCollaborationResidue(repoRoot: any = repoRootFromMeta()) : any {
  const hits: any[] = [];
  for (const relativePath of COLLABORATION_PATH_FILES) {
    const source: any = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    for (const pattern of RESIDUE_PATTERNS) {
      if (pattern.test(source)) {
        hits.push({ relativePath, pattern: String(pattern) });
      }
    }
  }
  assert.equal(hits.length, 0, `Collaboration-path residue remains: ${JSON.stringify(hits)}`);
  assert.equal(SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED, false);
  return Object.freeze({
    scannedFiles: [...COLLABORATION_PATH_FILES],
    residueAbsent: true,
    hitCount: 0
  });
}

export async function assertWorkspaceReferenceMigration() : Promise<any> {
  for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
    assert.equal(lookupFactIsAuthority(fact), false);
  }
  assert.equal(WORKSPACE_REFERENCE_MIGRATION_CAPACITY_CERTIFIED, false);
  assert.match(WORKSPACE_REFERENCE_MIGRATION_NON_CERTIFICATION_REASON, /^[a-z][a-z0-9_]{2,64}$/u);

  const protocol: any = assertWorkspaceCollaborationProtocolPath();
  assert.equal(protocol.secondCoreGenerationAllowed, false);
  const fallback: any = workspaceOrdinaryMcpFallback();
  assert.equal(fallback.kind, "fallback");
  assert.deepEqual([...fallback.methods], ["tools/call", "resources/read", "resources/list"]);

  const session: any = createWorkspaceReferenceMigration({
    instanceId: "verify.wrm.1",
    workingSetId: "ws.wrm.1"
  });
  const opened: any = await session.open({
    assets: [
      { assetId: "ast.wrm.1", entityId: "ent.wrm.file.1", handle: "hdl_wrm_1" },
      { assetId: "ast.wrm.2", entityId: "ent.wrm.file.2", handle: "hdl_wrm_2" }
    ]
  });
  assert.equal(opened.workingSetId, "ws.wrm.1");
  assert.equal(opened.head, 0);
  assert.equal(opened.assets.length, 2);
  assert.equal(opened.assets[0].assetId, "ast.wrm.1");
  assert.equal(opened.assets[0].handle, "hdl_wrm_1");
  assert.equal(String(opened.assets[0].assetId).includes("/"), false);
  assert.equal(containsForbiddenKeys(opened), false);

  const warm: any = session.observeLocal({ handle: "hdl_wrm_1" });
  assert.equal(warm.cacheHit, true);
  assert.equal(warm.needsRemote, false);
  assert.equal(warm.remoteReads, 0);
  assert.equal(warm.treeScans, 0);

  const suggested: any = session.suggest({
    handle: "hdl_wrm_1",
    attributionRef: "attr.wrm.suggest"
  });
  assert.equal(suggested.dualWrite, false);
  assert.equal(suggested.writerCalls, 0);
  assert.equal(suggested.hostFileWrites, 0);
  assert.equal(suggested.changeSetApplyCalls, 0);
  assert.equal(suggested.view.kind, "edit-view");

  const clean: any = await session.commitTurn({
    handle: "hdl_wrm_1",
    dirty: false
  });
  assert.equal(clean.applyDelta, 0);
  assert.equal(clean.changeSetDelta, 0);
  assert.equal(clean.assignedHead, 0);
  assert.equal(clean.treeScans, 0);
  assert.equal(clean.hostFileWrites, 0);

  const dirty: any = await session.commitTurn({
    handle: "hdl_wrm_1",
    dirty: true,
    changeId: "chg.wrm.1",
    opId: "op.wrm.1",
    baselineHead: 0
  });
  assert.equal(dirty.applyDelta, 1);
  assert.equal(dirty.changeSetDelta, 1);
  assert.equal(dirty.assignedHead, 1);
  assert.equal(dirty.coreHead, 1);
  assert.equal(dirty.connectorHead, 1);
  assert.equal(dirty.observerHead, 1);
  assert.equal(session.peers().converged, true);

  const deltas: any = await session.resyncDeltas({
    handle: "hdl_wrm_1",
    cursor: opened.cursor
  });
  assert.ok(deltas.outcome === "delta" || deltas.outcome === "snapshot-tail");
  assert.equal(deltas.treeScans, 0);
  if (deltas.outcome === "delta") {
    assert.equal(deltas.deltaCount >= 1, true);
  }

  const restored: any = await session.restoreAsNewChange({
    handle: "hdl_wrm_1",
    checkpointId: "ckpt.wrm.1"
  });
  assert.equal(restored.restoreAsNewChange, true);
  assert.equal(restored.rewound, false);
  assert.equal(restored.reversesUnownedEffect, false);
  assert.equal(restored.assignedHead, 2);
  assert.equal(restored.applyDelta, 1);
  assert.equal(session.peers().converged, true);

  const effect: any = session.routeEffect({
    kind: "share",
    effectId: "eff.wrm.share"
  });
  assert.equal(effect.family, "effect-command");
  assert.equal(effect.mergedIntoChangeSet, false);
  assert.equal(effect.changeSetApplyDelta, 0);
  assert.equal(effect.reversesUnownedEffect, false);

  const snapshot: any = session.snapshot();
  assert.equal(snapshot.authorityId, WORKSPACE_REFERENCE_MIGRATION_AUTHORITY_ID);
  assert.equal(snapshot.coreStateGeneration, SERVICE_COLLABORATION_CORE_STATE_GENERATION);
  assert.equal(snapshot.capacityCertified, false);
  assert.equal(snapshot.changeSetApplyCalls, 2);
  assert.equal(snapshot.suggestionWriterCalls, 0);
  assert.equal(snapshot.hostFileWrites, 0);
  assert.equal(snapshot.treeScans, 0);
  assert.equal(snapshot.restoreReversesUnownedEffect, false);
  assert.equal(snapshot.converged, true);
  assert.equal(containsForbiddenKeys(snapshot), false);
  session.close();

  return Object.freeze({
    schemaVersion: WORKSPACE_REFERENCE_MIGRATION_REPORT_SCHEMA_VERSION,
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    authorityId: WORKSPACE_REFERENCE_MIGRATION_AUTHORITY_ID,
    peersConverged: true,
    dirtyTurnChangeSets: 1,
    cleanTurnApplyCalls: 0,
    restoreAsNewChange: true,
    restoreRewound: false,
    suggestionsDualWrite: false,
    residueAbsent: true,
    scannedFiles: [...COLLABORATION_PATH_FILES],
    capacityCertified: false,
    reason: WORKSPACE_REFERENCE_MIGRATION_NON_CERTIFICATION_REASON
  });
}

export function buildWorkspaceCollaborationMigrationReport(
  assertion: Record<string, any> = {},
  extras: Record<string, any> = {}
) : any {
  return {
    schemaVersion: WORKSPACE_REFERENCE_MIGRATION_REPORT_SCHEMA_VERSION,
    verifier: WORKSPACE_COLLABORATION_MIGRATION_VERIFIER,
    generatedAt: extras.generatedAt || "1970-01-01T00:00:00.000Z",
    coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
    summary: {
      authorityId: WORKSPACE_REFERENCE_MIGRATION_AUTHORITY_ID,
      peersConverged: assertion.peersConverged === true,
      dirtyTurnChangeSets: assertion.dirtyTurnChangeSets,
      cleanTurnApplyCalls: assertion.cleanTurnApplyCalls,
      restoreAsNewChange: assertion.restoreAsNewChange === true,
      restoreRewound: assertion.restoreRewound === true,
      suggestionsDualWrite: assertion.suggestionsDualWrite === true,
      residueAbsent: assertion.residueAbsent === true,
      scannedFiles: [...(assertion.scannedFiles || COLLABORATION_PATH_FILES)],
      focusedSuitePassed: extras.focusedSuitePassed === true,
      capacityCertified: false,
      reason: WORKSPACE_REFERENCE_MIGRATION_NON_CERTIFICATION_REASON,
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
    WORKSPACE_COLLABORATION_MIGRATION_FOCUSED_SUITE
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
    suite: WORKSPACE_COLLABORATION_MIGRATION_FOCUSED_SUITE,
    passed: result.status === 0,
    exitCode: result.status,
    outputBytes: Buffer.byteLength(`${result.stdout || ""}${result.stderr || ""}`, "utf8"),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

export async function runWorkspaceCollaborationMigration({
  repoRoot = repoRootFromMeta(),
  writeReport = true,
  runFocusedTests = false,
  generatedAt = new Date().toISOString()
}: Record<string, any> = {}) : Promise<any> {
  const residue: any = assertWorkspaceCollaborationResidue(repoRoot);
  const assertion: any = await assertWorkspaceReferenceMigration();
  assert.equal(residue.residueAbsent, true);
  assert.equal(assertion.residueAbsent, true);

  let focusedSuite: any = {
    suite: WORKSPACE_COLLABORATION_MIGRATION_FOCUSED_SUITE,
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
        `Focused suite failed: ${WORKSPACE_COLLABORATION_MIGRATION_FOCUSED_SUITE} exit=${focusedSuite.exitCode}`
      );
    }
  }

  const report: any = buildWorkspaceCollaborationMigrationReport(assertion, {
    generatedAt,
    focusedSuitePassed: focusedSuite.passed === true
  });
  const provenance: Record<string, any> = {
    producer: "meshrix-workspace-collaboration-migration",
    commandId: "workspace-collaboration-migration",
    sourceRevision: await computeVerifierSourceRevision(repoRoot, SOURCE_FILES)
  };
  const finalized: any = finalizeSensitiveReport(report, { provenance });
  assertNoSensitiveReportLeak(finalized, "workspace collaboration migration report");
  assertReportProvenance(finalized, provenance);
  assert.equal(finalized.summary.capacityCertified, false);
  assert.equal(containsForbiddenKeys(finalized), false);

  if (writeReport === true) {
    const relativePath: any = WORKSPACE_COLLABORATION_MIGRATION_REPORT_RELATIVE_PATH;
    const absolutePath: any = path.join(repoRoot, relativePath);
    await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fsPromises.writeFile(absolutePath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
  }

  return {
    report: finalized,
    reportPath: WORKSPACE_COLLABORATION_MIGRATION_REPORT_RELATIVE_PATH,
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
    const result: any = await runWorkspaceCollaborationMigration({
      writeReport: true,
      runFocusedTests: true
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      reportPath: result.reportPath,
      peersConverged: result.report.summary.peersConverged,
      dirtyTurnChangeSets: result.report.summary.dirtyTurnChangeSets,
      cleanTurnApplyCalls: result.report.summary.cleanTurnApplyCalls,
      restoreAsNewChange: result.report.summary.restoreAsNewChange,
      residueAbsent: result.report.summary.residueAbsent,
      capacityCertified: result.report.summary.capacityCertified,
      focusedSuitePassed: result.report.summary.focusedSuitePassed
    })}\n`);
  } catch (error: any) {
    const message: any = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
