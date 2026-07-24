import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OperationAuditCapacityError,
  createOperationAuditStore
} from "../../../packages/foundation/src/security/operation-audit.mjs";

const temporaryRoots = new Set();

async function createStore() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-audit-retention-"));
  temporaryRoots.add(userDataPath);
  return {
    userDataPath,
    store: createOperationAuditStore({ userDataPath })
  };
}

function append(store, operationId, createdAt = new Date().toISOString(), input = {}) {
  return store.append({
    operationId,
    transport: "test",
    status: "ok",
    input,
    createdAt
  });
}

function oldIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

afterEach(async () => {
  for (const root of temporaryRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

describe("operation audit automatic bounded retention", () => {
  it("automatically removes expired rows in bounded batches on append", async () => {
    const { store } = await createStore();
    try {
      append(store, "expired.one", oldIso(3));
      append(store, "expired.two", oldIso(3));
      append(store, "expired.three", oldIso(3));
      store.setRetentionPolicy({
        retentionDays: 1,
        cleanupBatchSize: 2,
        maintenanceEveryAppends: 1
      });

      const first = append(store, "current.one");
      expect(first.maintenance.deletedCount).toBe(2);
      const afterFirst = store.list({ limit: 20 }).map((item) => item.operationId);
      expect(afterFirst).toHaveLength(2);
      expect(afterFirst[0]).toBe("current.one");
      expect(afterFirst[1]).toMatch(/^expired\./);

      const second = append(store, "current.two");
      expect(second.maintenance.deletedCount).toBe(1);
      expect(store.list({ limit: 20 }).map((item) => item.operationId)).toEqual([
        "current.two",
        "current.one"
      ]);
    } finally {
      store.close();
    }
  });

  it("does not delete unexpired evidence when the record budget is exhausted", async () => {
    const { store } = await createStore();
    try {
      store.setRetentionPolicy({
        maxRecords: 2,
        cleanupBatchSize: 1,
        maintenanceEveryAppends: 1
      });
      append(store, "current.one");
      append(store, "current.two");

      expect(() => append(store, "current.three")).toThrowError(
        expect.objectContaining({
          name: "OperationAuditCapacityError",
          code: "operation_audit_capacity_exhausted",
          reason: "record_count"
        })
      );
      expect(store.list({ limit: 20 }).map((item) => item.operationId)).toEqual([
        "current.two",
        "current.one"
      ]);
    } finally {
      store.close();
    }
  });

  it("enforces a logical byte budget with exact trigger-maintained counters", async () => {
    const { store } = await createStore();
    try {
      store.setRetentionPolicy({
        maxLogicalBytes: 13 * 1024,
        maintenanceEveryAppends: 1
      });
      append(store, "current.large", new Date().toISOString(), { value: "x".repeat(9 * 1024) });

      expect(() => append(
        store,
        "current.overflow",
        new Date().toISOString(),
        { value: "y".repeat(9 * 1024) }
      )).toThrow(OperationAuditCapacityError);

      const meta = store.db.prepare(`
        SELECT row_count AS rowCount, logical_bytes AS logicalBytes
        FROM operation_audit_meta
        WHERE singleton = 1
      `).get();
      const exact = store.db.prepare(`
        SELECT COUNT(*) AS rowCount, COALESCE(SUM(record_bytes), 0) AS logicalBytes
        FROM operation_audit_log
      `).get();
      expect(meta).toEqual(exact);
      expect(meta.rowCount).toBe(1);
      expect(meta.logicalBytes).toBeLessThanOrEqual(13 * 1024);
    } finally {
      store.close();
    }
  });

  it("migrates existing rows into exact retention counters once", async () => {
    const { userDataPath, store } = await createStore();
    append(store, "legacy.row");
    store.db.exec(`
      DROP TRIGGER operation_audit_meta_after_insert;
      DROP TRIGGER operation_audit_meta_after_delete;
      DROP TABLE operation_audit_meta;
      UPDATE operation_audit_log SET record_bytes = 0;
      PRAGMA user_version = 1;
    `);
    store.close();

    const reopened = createOperationAuditStore({ userDataPath });
    try {
      const meta = reopened.db.prepare(`
        SELECT row_count AS rowCount, logical_bytes AS logicalBytes
        FROM operation_audit_meta
        WHERE singleton = 1
      `).get();
      expect(meta.rowCount).toBe(1);
      expect(meta.logicalBytes).toBeGreaterThan(0);
      append(reopened, "migrated.row");
      expect(reopened.db.prepare("SELECT row_count AS count FROM operation_audit_meta").get().count).toBe(2);
    } finally {
      reopened.close();
    }
  });

  it("configures bounded WAL reuse and incremental page reclamation", async () => {
    const { store } = await createStore();
    try {
      const policy = store.setRetentionPolicy({ maxDatabaseBytes: 4 * 1024 * 1024 });
      const pageSize = Number(store.db.pragma("page_size", { simple: true }));
      const maxPageCount = Number(store.db.pragma("max_page_count", { simple: true }));
      expect(Number(store.db.pragma("auto_vacuum", { simple: true }))).toBe(2);
      expect(maxPageCount * pageSize).toBeLessThanOrEqual(policy.maxDatabaseBytes);
      expect(Number(store.db.pragma("journal_size_limit", { simple: true }))).toBe(16 * 1024 * 1024);
    } finally {
      store.close();
    }
  });
});
