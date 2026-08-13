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
} from "./lib/sensitive-report-scan.ts";

const execFileAsync: any = promisify(execFile);
const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath: any = path.join(process.cwd(), "build/reports/work-queue-process-restart.json");
const verifier: any = "tools/server-scripts/verify-work-queue-process-restart.ts";
const commandId: any = "work-queue-process-restart";
const childPath: any = path.join(repoRoot, "tools/server-scripts/lib/work-queue-process-restart-child.ts");
const sourceFiles: readonly any[] = Object.freeze([
  "packages/foundation/src/work-queue/sqlite-store.ts",
  "packages/foundation/src/work-queue/sqlite-schema.ts",
  "packages/foundation/src/work-queue/store-serialization.ts",
  "tools/server-scripts/lib/work-queue-process-restart-child.ts",
  verifier
]);

async function runChild(args?: any) : Promise<any> {
  const result: any = await execFileAsync(process.execPath, [childPath, ...args], {
    timeout: 15_000,
    maxBuffer: 64 * 1024
  });
  return JSON.parse(String(result.stdout || "").trim());
}

async function writeReport(report?: any) : Promise<any> {
  const provenance: Record<string, any> = {
    producer: "meshrix-core-work-queue-restart",
    commandId,
    sourceRevision: await computeVerifierSourceRevision(repoRoot, sourceFiles)
  };
  const finalized: any = finalizeSensitiveReport(report, { provenance });
  assertNoSensitiveReportLeak(finalized, "work queue process restart report");
  assertReportProvenance(finalized, provenance);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
}

async function main() : Promise<any> {
  const startedAt: any = new Date();
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-work-queue-process-restart-"));
  try {
    const seeded: any = await runChild(["seed", userDataPath]);
    await new Promise((resolve?: any) : any => setTimeout(resolve, 80));
    const recovered: any = await runChild([
      "recover",
      userDataPath,
      seeded.workItemId,
      seeded.leaseId
    ]);
    assert.equal(recovered.staleFenceRejected, true);
    assert.equal(recovered.recoveredCount, 1);
    assert.equal(recovered.recoveryState, "in_doubt");
    assert.equal(recovered.recoveryLeaseSeq, seeded.leaseSeq);
    assert.equal(seeded.checkpointSeq, 1);
    assert.equal(recovered.checkpointSeq, seeded.checkpointSeq);
    assert.equal(recovered.checkpointDigest, seeded.checkpointDigest);
    assert.equal(recovered.receiptRecorded, true);
    assert.equal(recovered.reconciled, true);
    assert.equal(recovered.finalState, "completed");
    assert.equal(recovered.terminalTransitionCount, 1);
    assert.equal(recovered.projectionReplayOk, true);

    const finishedAt: any = new Date();
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
        inDoubtGenerationRetained: true,
        durableWorkFenced: true,
        durableCheckpointResumed: true,
        sinkReceiptReconciled: true,
        duplicateTerminalCount: 0,
        projectionReplayPassed: true,
        finalState: "completed"
      },
      checks: [
        { id: "fresh-process-reload", status: "passed" },
        { id: "in-doubt-fence-on-crash", status: "passed" },
        { id: "stale-lease-fence", status: "passed" },
        { id: "generation-retained", status: "passed" },
        { id: "no-takeover-without-receipt", status: "passed" },
        { id: "durable-checkpoint-resume", status: "passed" },
        { id: "sink-receipt-reconciliation", status: "passed" },
        { id: "single-completed-terminal", status: "passed" },
        { id: "projection-replay", status: "passed" }
      ]
    });
    process.stdout.write(`${JSON.stringify({ ok: true, report: "build/reports/work-queue-process-restart.json" })}\n`);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

main().catch(() : any => {
  process.stderr.write(`${JSON.stringify({ ok: false, reason: "work_queue_process_restart_verification_failed" })}\n`);
  process.exitCode = 1;
});
