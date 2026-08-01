import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../packages/foundation/src/storage/storage-lifecycle-lock.ts", () : any => ({
  acquireStorageMaintenanceLock: vi.fn(async () : Promise<any> => ({
    assertRestoreQuiesced: vi.fn(async () : Promise<any> => {}),
    release: vi.fn(async () : Promise<any> => {})
  }))
}));

import {
  applyStorageBackupRetention,
  reconcileStorageRetentionTransactions,
  reconcileStorageRetentionTransactionsSync
} from "../../../packages/foundation/src/storage/backup-retention.ts";
import { listStorageBackups } from "../../../packages/foundation/src/storage/backup-query.ts";
import { createStorageBackup } from "../../../packages/foundation/src/storage/backup-snapshot.ts";
import { restoreStorageBackup } from "../../../packages/foundation/src/storage/restore-execution.ts";
import {
  assertPrivacySafeStorageEvidence,
  createStorageReceipt
} from "../../../packages/foundation/src/storage/storage-evidence.ts";
import {
  STORAGE_EXECUTION_BUDGET_HARD_LIMITS,
  createStorageWorkTracker,
  normalizeStorageExecutionBudget,
  runStorageMaintenanceMutation,
  storageMaintenanceLaneStatus
} from "../../../packages/foundation/src/storage/storage-maintenance-coordinator.ts";

const roots: any[] = [];

async function tempRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-storage-retention-"));
  roots.push(root);
  return root;
}

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("storage maintenance coordinator", () : any => {
  it("rejects every execution budget above its owner hard limit", () : any => {
    const fields: any[] = [
      "maxFiles",
      "maxBytes",
      "maxCleanupItems",
      "maxQueueDepth",
      "maxDurationMs",
      "bufferBytes"
    ];
    for (const field of fields) {
      expect(() : any => normalizeStorageExecutionBudget({
        [field]: STORAGE_EXECUTION_BUDGET_HARD_LIMITS[field] + 1
      })).toThrow(expect.objectContaining({
        code: "storage_execution_budget_limit_exceeded"
      }));
    }
    expect(() : any => normalizeStorageExecutionBudget({ maxQueueDepth: Number.MAX_SAFE_INTEGER }))
      .toThrow(expect.objectContaining({ code: "storage_execution_budget_limit_exceeded" }));
  });

  it("accepts individual boundary values but rejects an unsafe queue-buffer product", () : any => {
    expect(normalizeStorageExecutionBudget({
      maxFiles: STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxFiles,
      maxBytes: STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxBytes,
      maxCleanupItems: STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxCleanupItems,
      maxQueueDepth: 64,
      maxDurationMs: STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxDurationMs,
      bufferBytes: STORAGE_EXECUTION_BUDGET_HARD_LIMITS.bufferBytes
    })).toMatchObject({
      maxFiles: STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxFiles,
      maxBytes: STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxBytes
    });
    expect(() : any => normalizeStorageExecutionBudget({
      maxQueueDepth: STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxQueueDepth,
      bufferBytes: STORAGE_EXECUTION_BUDGET_HARD_LIMITS.bufferBytes
    })).toThrow(expect.objectContaining({
      code: "storage_execution_budget_product_exceeded"
    }));
  });

  it("rejects oversized queue construction before scheduling or proportional allocation", () : any => {
    const root: any = path.join(os.tmpdir(), "meshrix-storage-oversized-queue");
    expect(() : any => runStorageMaintenanceMutation(
      root,
      async () : Promise<any> => null,
      { budget: { maxQueueDepth: STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxQueueDepth + 1 } }
    )).toThrow(expect.objectContaining({
      code: "storage_execution_budget_limit_exceeded"
    }));
    expect(storageMaintenanceLaneStatus(root)).toEqual({
      active: false,
      fenced: false,
      queued: 0
    });
  });

  it("serializes mutations per storage root in FIFO order", async () : Promise<any> => {
    const root: any = await tempRoot();
    const order: any[] = [];
    let releaseFirst: any;
    const firstReady: any = new Promise((resolve?: any) : any => {
      releaseFirst = resolve;
    });
    const first: any = runStorageMaintenanceMutation(root, async () : Promise<any> => {
      order.push("first-start");
      await firstReady;
      order.push("first-end");
    });
    const second: any = runStorageMaintenanceMutation(root, async () : Promise<any> => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(storageMaintenanceLaneStatus(root)).toEqual({ active: false, fenced: false, queued: 0 });
  });

  it("keeps a timed-out lane fenced until the original writer terminates", async () : Promise<any> => {
    const root: any = await tempRoot();
    let releaseWriter: any;
    const writerTerminal: any = new Promise((resolve?: any) : any => {
      releaseWriter = resolve;
    });
    const writer: any = runStorageMaintenanceMutation(root, () : any => writerTerminal, {
      budget: { maxDurationMs: 10 }
    });
    await expect(writer).rejects.toMatchObject({ code: "storage_operation_timeout" });
    expect(storageMaintenanceLaneStatus(root).fenced).toBe(true);
    await expect(runStorageMaintenanceMutation(root, async () : Promise<any> => null))
      .rejects.toMatchObject({ code: "storage_operation_fenced" });
    releaseWriter();
    await new Promise((resolve?: any) : any => setTimeout(resolve, 0));
    expect(storageMaintenanceLaneStatus(root).fenced).toBe(false);
  });

  it("fails closed when file, byte, or cleanup budgets are exceeded", () : any => {
    const tracker: any = createStorageWorkTracker({
      budget: { maxFiles: 1, maxBytes: 4, maxCleanupItems: 1 }
    });
    expect(tracker.consume({ files: 1, bytes: 4, cleanupItems: 1 }))
      .toEqual({ files: 1, bytes: 4, cleanupItems: 1 });
    expect(() : any => tracker.consume({ bytes: 1 }))
      .toThrow(expect.objectContaining({ code: "storage_execution_budget_exceeded" }));
  });
});

describe("storage backup retention", () : any => {
  it("does not infer or apply retention when policy is absent", async () : Promise<any> => {
    const root: any = await tempRoot();
    const result: any = await applyStorageBackupRetention({ userDataPath: root });
    expect(result.status).toBe("not_configured");
    expect(result.deletedBackupIds).toEqual([]);
    expect(result.receipt).toMatchObject({
      schema: "meshrix.storage.receipt",
      kind: "backup-retention",
      status: "not_configured",
      redacted: true,
      rawPayloadIncluded: false
    });
    expect(await reconcileStorageRetentionTransactions({ userDataPath: root }))
      .toEqual({ reconciled: 0 });
  });

  it("serially quarantines and deletes only generations selected by explicit policy", async () : Promise<any> => {
    const root: any = await tempRoot();
    await fs.writeFile(path.join(root, "state.json"), "one", "utf8");
    const first: any = await createStorageBackup({ userDataPath: root, label: "first" });
    await fs.writeFile(path.join(root, "state.json"), "two", "utf8");
    const second: any = await createStorageBackup({ userDataPath: root, label: "second" });
    await fs.writeFile(path.join(root, "state.json"), "three", "utf8");
    const third: any = await createStorageBackup({ userDataPath: root, label: "third" });

    const result: any = await applyStorageBackupRetention({
      userDataPath: root,
      policy: { keepLast: 1, protectedBackupIds: [first.backupId] }
    });
    expect(result.status).toBe("applied");
    expect(result.deletedBackupIds).toHaveLength(1);
    expect(result.deletedBackupIds).toContain(second.backupId);
    expect(result.deletedBackupIds).not.toContain(first.backupId);
    expect(result.deletedBackupIds).not.toContain(third.backupId);
    const listed: any = await listStorageBackups({ userDataPath: root });
    expect(new Set<any>(listed.backups.map((entry?: any) : any => entry.backupId)))
      .toEqual(new Set<any>([first.backupId, third.backupId]));
    expect(result.receipt.counts).toEqual({ deleted: 1, retained: 2, protected: 1 });
    expect(JSON.stringify(result.receipt)).not.toContain("state.json");
    expect(JSON.stringify(result.receipt)).not.toContain("first");
  });

  it("applies configured retention inside the backup maintenance lifecycle", async () : Promise<any> => {
    const root: any = await tempRoot();
    await fs.writeFile(path.join(root, "state.json"), "one", "utf8");
    const first: any = await createStorageBackup({ userDataPath: root, label: "first" });
    await fs.writeFile(path.join(root, "state.json"), "two", "utf8");
    const second: any = await createStorageBackup({ userDataPath: root, label: "second" });
    await fs.writeFile(path.join(root, "state.json"), "three", "utf8");
    const third: any = await createStorageBackup({
      userDataPath: root,
      label: "third",
      retentionPolicy: { keepLast: 2 }
    });

    expect(third.retention).toMatchObject({
      status: "applied",
      deletedBackupIds: [first.backupId]
    });
    expect((await listStorageBackups({ userDataPath: root })).backups.map((entry?: any) : any => entry.backupId))
      .toEqual([third.backupId, second.backupId]);
  });

  it("rejects unsafe policy and privacy evidence instead of broadening deletion", async () : Promise<any> => {
    const root: any = await tempRoot();
    await expect(applyStorageBackupRetention({ userDataPath: root, policy: { keepLast: 0 } }))
      .rejects.toMatchObject({ code: "storage_retention_policy_invalid" });
    const receipt: any = createStorageReceipt({ kind: "backup-retention", status: "applied" });
    expect(assertPrivacySafeStorageEvidence(receipt)).toBe(true);
    expect(() : any => assertPrivacySafeStorageEvidence({ secret: "not-allowed" }))
      .toThrow(expect.objectContaining({ code: "storage_receipt_privacy_violation" }));
  });

  it("rolls back an interrupted prepared retention transaction during startup reconciliation", async () : Promise<any> => {
    const root: any = await tempRoot();
    const backupId: any = "backup_2026-01-01T00-00-00-000Z_interrupted";
    const transactionId: any = "retention_00000000-0000-4000-8000-000000000076";
    const backupRoot: any = path.join(root, "backups");
    const transactionRoot: any = path.join(backupRoot, ".retention-transactions", transactionId);
    const quarantineRoot: any = path.join(transactionRoot, "quarantine");
    await fs.mkdir(path.join(quarantineRoot, backupId), { recursive: true });
    await fs.writeFile(path.join(transactionRoot, "retention-journal.json"), JSON.stringify({
      schema: "meshrix.storage.retention-journal",
      transactionId,
      phase: "prepared",
      policyDigest: digestForTest("startup-retention"),
      candidateIds: [backupId],
      movedIds: [backupId]
    }), "utf8");

    expect(reconcileStorageRetentionTransactionsSync({ userDataPath: root }))
      .toEqual({ reconciled: 1 });
    await expect(fs.stat(path.join(backupRoot, backupId))).resolves.toBeTruthy();
    await expect(fs.stat(transactionRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates cancellation and resource budgets through backup and restore work", async () : Promise<any> => {
    const root: any = await tempRoot();
    await fs.writeFile(path.join(root, "state.json"), "budgeted-storage-content", "utf8");
    const cancelled: any = new AbortController();
    const reason: any = Object.assign(new Error("cancelled"), { code: "storage_operation_cancelled" });
    cancelled.abort(reason);
    await expect(createStorageBackup({ userDataPath: root, signal: cancelled.signal }))
      .rejects.toMatchObject({ code: "storage_operation_cancelled" });
    await expect(createStorageBackup({ userDataPath: root, budget: { maxBytes: 1 } }))
      .rejects.toMatchObject({ code: "storage_execution_budget_exceeded" });

    const backup: any = await createStorageBackup({ userDataPath: root });
    await expect(restoreStorageBackup({
      userDataPath: root,
      backupId: backup.backupId,
      budget: { maxBytes: 1 }
    })).rejects.toMatchObject({ code: "storage_execution_budget_exceeded" });
  });
});

function digestForTest(value?: any) : any {
  return Buffer.from(String(value)).toString("hex").padEnd(64, "0").slice(0, 64);
}
