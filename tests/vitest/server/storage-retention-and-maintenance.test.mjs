import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../packages/foundation/src/storage/storage-lifecycle-lock.mjs", () => ({
  acquireStorageMaintenanceLock: vi.fn(async () => ({
    assertRestoreQuiesced: vi.fn(async () => {}),
    release: vi.fn(async () => {})
  }))
}));

import {
  applyStorageBackupRetention,
  reconcileStorageRetentionTransactions,
  reconcileStorageRetentionTransactionsSync
} from "../../../packages/foundation/src/storage/backup-retention.mjs";
import { listStorageBackups } from "../../../packages/foundation/src/storage/backup-query.mjs";
import { createStorageBackup } from "../../../packages/foundation/src/storage/backup-snapshot.mjs";
import { restoreStorageBackup } from "../../../packages/foundation/src/storage/restore-execution.mjs";
import {
  assertPrivacySafeStorageEvidence,
  createStorageReceipt
} from "../../../packages/foundation/src/storage/storage-evidence.mjs";
import {
  STORAGE_EXECUTION_BUDGET_HARD_LIMITS,
  createStorageWorkTracker,
  normalizeStorageExecutionBudget,
  runStorageMaintenanceMutation,
  storageMaintenanceLaneStatus
} from "../../../packages/foundation/src/storage/storage-maintenance-coordinator.mjs";

const roots = [];

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-storage-retention-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("storage maintenance coordinator", () => {
  it("rejects every execution budget above its owner hard limit", () => {
    const fields = [
      "maxFiles",
      "maxBytes",
      "maxCleanupItems",
      "maxQueueDepth",
      "maxDurationMs",
      "bufferBytes"
    ];
    for (const field of fields) {
      expect(() => normalizeStorageExecutionBudget({
        [field]: STORAGE_EXECUTION_BUDGET_HARD_LIMITS[field] + 1
      })).toThrow(expect.objectContaining({
        code: "storage_execution_budget_limit_exceeded"
      }));
    }
    expect(() => normalizeStorageExecutionBudget({ maxQueueDepth: Number.MAX_SAFE_INTEGER }))
      .toThrow(expect.objectContaining({ code: "storage_execution_budget_limit_exceeded" }));
  });

  it("accepts individual boundary values but rejects an unsafe queue-buffer product", () => {
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
    expect(() => normalizeStorageExecutionBudget({
      maxQueueDepth: STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxQueueDepth,
      bufferBytes: STORAGE_EXECUTION_BUDGET_HARD_LIMITS.bufferBytes
    })).toThrow(expect.objectContaining({
      code: "storage_execution_budget_product_exceeded"
    }));
  });

  it("rejects oversized queue construction before scheduling or proportional allocation", () => {
    const root = path.join(os.tmpdir(), "meshrix-storage-oversized-queue");
    expect(() => runStorageMaintenanceMutation(
      root,
      async () => null,
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

  it("serializes mutations per storage root in FIFO order", async () => {
    const root = await tempRoot();
    const order = [];
    let releaseFirst;
    const firstReady = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const first = runStorageMaintenanceMutation(root, async () => {
      order.push("first-start");
      await firstReady;
      order.push("first-end");
    });
    const second = runStorageMaintenanceMutation(root, async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(storageMaintenanceLaneStatus(root)).toEqual({ active: false, fenced: false, queued: 0 });
  });

  it("keeps a timed-out lane fenced until the original writer terminates", async () => {
    const root = await tempRoot();
    let releaseWriter;
    const writerTerminal = new Promise((resolve) => {
      releaseWriter = resolve;
    });
    const writer = runStorageMaintenanceMutation(root, () => writerTerminal, {
      budget: { maxDurationMs: 10 }
    });
    await expect(writer).rejects.toMatchObject({ code: "storage_operation_timeout" });
    expect(storageMaintenanceLaneStatus(root).fenced).toBe(true);
    await expect(runStorageMaintenanceMutation(root, async () => null))
      .rejects.toMatchObject({ code: "storage_operation_fenced" });
    releaseWriter();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storageMaintenanceLaneStatus(root).fenced).toBe(false);
  });

  it("fails closed when file, byte, or cleanup budgets are exceeded", () => {
    const tracker = createStorageWorkTracker({
      budget: { maxFiles: 1, maxBytes: 4, maxCleanupItems: 1 }
    });
    expect(tracker.consume({ files: 1, bytes: 4, cleanupItems: 1 }))
      .toEqual({ files: 1, bytes: 4, cleanupItems: 1 });
    expect(() => tracker.consume({ bytes: 1 }))
      .toThrow(expect.objectContaining({ code: "storage_execution_budget_exceeded" }));
  });
});

describe("storage backup retention", () => {
  it("does not infer or apply retention when policy is absent", async () => {
    const root = await tempRoot();
    const result = await applyStorageBackupRetention({ userDataPath: root });
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

  it("serially quarantines and deletes only generations selected by explicit policy", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "state.json"), "one", "utf8");
    const first = await createStorageBackup({ userDataPath: root, label: "first" });
    await fs.writeFile(path.join(root, "state.json"), "two", "utf8");
    const second = await createStorageBackup({ userDataPath: root, label: "second" });
    await fs.writeFile(path.join(root, "state.json"), "three", "utf8");
    const third = await createStorageBackup({ userDataPath: root, label: "third" });

    const result = await applyStorageBackupRetention({
      userDataPath: root,
      policy: { keepLast: 1, protectedBackupIds: [first.backupId] }
    });
    expect(result.status).toBe("applied");
    expect(result.deletedBackupIds).toHaveLength(1);
    expect(result.deletedBackupIds).toContain(second.backupId);
    expect(result.deletedBackupIds).not.toContain(first.backupId);
    expect(result.deletedBackupIds).not.toContain(third.backupId);
    const listed = await listStorageBackups({ userDataPath: root });
    expect(new Set(listed.backups.map((entry) => entry.backupId)))
      .toEqual(new Set([first.backupId, third.backupId]));
    expect(result.receipt.counts).toEqual({ deleted: 1, retained: 2, protected: 1 });
    expect(JSON.stringify(result.receipt)).not.toContain("state.json");
    expect(JSON.stringify(result.receipt)).not.toContain("first");
  });

  it("applies configured retention inside the backup maintenance lifecycle", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "state.json"), "one", "utf8");
    const first = await createStorageBackup({ userDataPath: root, label: "first" });
    await fs.writeFile(path.join(root, "state.json"), "two", "utf8");
    const second = await createStorageBackup({ userDataPath: root, label: "second" });
    await fs.writeFile(path.join(root, "state.json"), "three", "utf8");
    const third = await createStorageBackup({
      userDataPath: root,
      label: "third",
      retentionPolicy: { keepLast: 2 }
    });

    expect(third.retention).toMatchObject({
      status: "applied",
      deletedBackupIds: [first.backupId]
    });
    expect((await listStorageBackups({ userDataPath: root })).backups.map((entry) => entry.backupId))
      .toEqual([third.backupId, second.backupId]);
  });

  it("rejects unsafe policy and privacy evidence instead of broadening deletion", async () => {
    const root = await tempRoot();
    await expect(applyStorageBackupRetention({ userDataPath: root, policy: { keepLast: 0 } }))
      .rejects.toMatchObject({ code: "storage_retention_policy_invalid" });
    const receipt = createStorageReceipt({ kind: "backup-retention", status: "applied" });
    expect(assertPrivacySafeStorageEvidence(receipt)).toBe(true);
    expect(() => assertPrivacySafeStorageEvidence({ secret: "not-allowed" }))
      .toThrow(expect.objectContaining({ code: "storage_receipt_privacy_violation" }));
  });

  it("rolls back an interrupted prepared retention transaction during startup reconciliation", async () => {
    const root = await tempRoot();
    const backupId = "backup_2026-01-01T00-00-00-000Z_interrupted";
    const transactionId = "retention_00000000-0000-4000-8000-000000000076";
    const backupRoot = path.join(root, "backups");
    const transactionRoot = path.join(backupRoot, ".retention-transactions", transactionId);
    const quarantineRoot = path.join(transactionRoot, "quarantine");
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

  it("propagates cancellation and resource budgets through backup and restore work", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "state.json"), "budgeted-storage-content", "utf8");
    const cancelled = new AbortController();
    const reason = Object.assign(new Error("cancelled"), { code: "storage_operation_cancelled" });
    cancelled.abort(reason);
    await expect(createStorageBackup({ userDataPath: root, signal: cancelled.signal }))
      .rejects.toMatchObject({ code: "storage_operation_cancelled" });
    await expect(createStorageBackup({ userDataPath: root, budget: { maxBytes: 1 } }))
      .rejects.toMatchObject({ code: "storage_execution_budget_exceeded" });

    const backup = await createStorageBackup({ userDataPath: root });
    await expect(restoreStorageBackup({
      userDataPath: root,
      backupId: backup.backupId,
      budget: { maxBytes: 1 }
    })).rejects.toMatchObject({ code: "storage_execution_budget_exceeded" });
  });
});

function digestForTest(value) {
  return Buffer.from(String(value)).toString("hex").padEnd(64, "0").slice(0, 64);
}
