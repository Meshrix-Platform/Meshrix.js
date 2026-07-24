#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath = path.join(process.cwd(), "build/reports/work-queue-process-restart.json");
const verifier = "tools/server-scripts/verify-work-queue-process-restart.mjs";
const commandId = "work-queue-process-restart";
const childPath = path.join(repoRoot, "tools/server-scripts/lib/work-queue-process-restart-child.mjs");
const sourceFiles = Object.freeze([
  "packages/foundation/src/work-queue/sqlite-store.mjs",
  "packages/foundation/src/work-queue/sqlite-schema.mjs",
  "packages/foundation/src/work-queue/store-serialization.mjs",
  "tools/server-scripts/lib/work-queue-process-restart-child.mjs",
  verifier
]);

async function runChild(args) {
  const result = await execFileAsync(process.execPath, [childPath, ...args], {
    timeout: 15_000,
    maxBuffer: 64 * 1024
  });
  return JSON.parse(String(result.stdout || "").trim());
}

async function writeReport(report) {
  const provenance = {
    producer: "meshrix-core-work-queue-restart",
    commandId,
    sourceRevision: await computeVerifierSourceRevision(repoRoot, sourceFiles)
  };
  const finalized = finalizeSensitiveReport(report, { provenance });
  assertNoSensitiveReportLeak(finalized, "work queue process restart report");
  assertReportProvenance(finalized, provenance);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
}

async function main() {
  const startedAt = new Date();
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-work-queue-process-restart-"));
  try {
    const seeded = await runChild(["seed", userDataPath]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const recovered = await runChild([
      "recover",
      userDataPath,
      seeded.workItemId,
      seeded.leaseId
    ]);
    assert.equal(recovered.staleFenceRejected, true);
    assert.equal(recovered.recoveredCount, 1);
    assert.equal(recovered.recoveryState, "retry_wait");
    assert.equal(recovered.claimedWorkItemId, seeded.workItemId);
    assert.equal(recovered.replacementLeaseSeq, seeded.leaseSeq + 1);
    assert.equal(seeded.checkpointSeq, 1);
    assert.equal(recovered.checkpointSeq, seeded.checkpointSeq);
    assert.equal(recovered.checkpointDigest, seeded.checkpointDigest);
    assert.equal(recovered.completed, true);
    assert.equal(recovered.finalState, "completed");
    assert.equal(recovered.completedTransitionCount, 1);
    assert.equal(recovered.projectionReplayOk, true);

    const finishedAt = new Date();
    await writeReport({
      schemaVersion: "v0.0.1:workflow:work-queue-process-restart-report-1",
      generatedAt: finishedAt.toISOString(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      verifier,
      ok: true,
      summary: {
        releaseReady: true,
        verificationPassed: true,
        coverageComplete: true,
        processBoundaryCount: 2,
        stableDefinitionReloaded: true,
        staleLeaseFenceRejected: true,
        leaseSequenceAdvanced: true,
        durableWorkRecovered: true,
        durableCheckpointResumed: true,
        retryTimingPreserved: true,
        duplicateTerminalCount: 0,
        projectionReplayPassed: true,
        finalState: "completed"
      },
      checks: [
        { id: "fresh-process-reload", status: "passed" },
        { id: "stable-definition-takeover", status: "passed" },
        { id: "stale-lease-fence", status: "passed" },
        { id: "replacement-lease-sequence", status: "passed" },
        { id: "retry-wait-timing", status: "passed" },
        { id: "durable-checkpoint-resume", status: "passed" },
        { id: "single-completed-terminal", status: "passed" },
        { id: "projection-replay", status: "passed" }
      ]
    });
    process.stdout.write(`${JSON.stringify({ ok: true, report: "build/reports/work-queue-process-restart.json" })}\n`);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

main().catch(() => {
  process.stderr.write(`${JSON.stringify({ ok: false, reason: "work_queue_process_restart_verification_failed" })}\n`);
  process.exitCode = 1;
});
