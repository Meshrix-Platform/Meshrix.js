import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OperationAuditCapacityError,
  OperationAuditIdempotencyConflictError,
  OperationAuditIdRequiredError,
  createOperationAuditStore
} from "../../../packages/foundation/src/security/operation-audit.ts";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import { auditOperation } from "../../../packages/server-runtime/src/composition/dispatch-operation-risk-control.ts";

const temporaryRoots: any = new Set<any>();

async function createStore() : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-audit-retention-"));
  temporaryRoots.add(userDataPath);
  return {
    userDataPath,
    store: createOperationAuditStore({ userDataPath })
  };
}

function append(store?: any, operationId?: any, createdAt: any = new Date().toISOString(), input: Record<string, any> = {}) : any {
  return store.append({
    operationId,
    transport: "test",
    status: "ok",
    input,
    createdAt
  });
}

function oldIso(days?: any) : any {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

afterEach(async () : Promise<any> => {
  for (const root of temporaryRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

describe("operation audit automatic bounded retention", () : any => {
  it("keeps auth.login credentials out of audit input and its digest", async () : Promise<any> => {
    const { store } = await createStore();
    const operation: any = SERVER_API_OPERATIONS.find(({ id }: Record<string, any>) : any => id === "auth.login");
    const firstPassword: any = "synthetic-password-one";
    const secondPassword: any = "synthetic-password-two";
    try {
      expect(operation?.audit).toMatchObject({
        enabled: true,
        metadataOnly: true,
        recordInput: false
      });
      expect(operation?.log).toMatchObject({
        recordInput: false,
        redaction: "secret"
      });

      for (const password of [firstPassword, secondPassword]) {
        auditOperation({
          operationAuditStore: store,
          operation,
          transport: "test",
          input: { username: "synthetic-user", password },
          status: "denied"
        });
      }

      const records: any = store.list({ operationId: "auth.login", limit: 10 });
      expect(records).toHaveLength(2);
      expect(records.map(({ redactedInput }: Record<string, any>) : any => redactedInput)).toEqual([{}, {}]);
      expect(new Set<any>(records.map(({ inputHash }: Record<string, any>) : any => inputHash)).size).toBe(1);
      expect(JSON.stringify(records)).not.toContain(firstPassword);
      expect(JSON.stringify(records)).not.toContain(secondPassword);
    } finally {
      store.close();
    }
  });

  it("automatically removes expired rows in bounded batches on append", async () : Promise<any> => {
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

      const first: any = append(store, "current.one");
      expect(first.maintenance.deletedCount).toBe(2);
      const afterFirst: any = store.list({ limit: 20 }).map((item?: any) : any => item.operationId);
      expect(afterFirst).toHaveLength(2);
      expect(afterFirst[0]).toBe("current.one");
      expect(afterFirst[1]).toMatch(/^expired\./);

      const second: any = append(store, "current.two");
      expect(second.maintenance.deletedCount).toBe(1);
      expect(store.list({ limit: 20 }).map((item?: any) : any => item.operationId)).toEqual([
        "current.two",
        "current.one"
      ]);
    } finally {
      store.close();
    }
  });

  it("does not delete unexpired evidence when the record budget is exhausted", async () : Promise<any> => {
    const { store } = await createStore();
    try {
      store.setRetentionPolicy({
        maxRecords: 2,
        cleanupBatchSize: 1,
        maintenanceEveryAppends: 1
      });
      append(store, "current.one");
      append(store, "current.two");

      expect(() : any => append(store, "current.three")).toThrowError(
        expect.objectContaining({
          name: "OperationAuditCapacityError",
          code: "operation_audit_capacity_exhausted",
          reason: "record_count"
        })
      );
      expect(store.list({ limit: 20 }).map((item?: any) : any => item.operationId)).toEqual([
        "current.two",
        "current.one"
      ]);
    } finally {
      store.close();
    }
  });

  it("enforces a logical byte budget with exact trigger-maintained counters", async () : Promise<any> => {
    const { store } = await createStore();
    try {
      store.setRetentionPolicy({
        maxLogicalBytes: 13 * 1024,
        maintenanceEveryAppends: 1
      });
      append(store, "current.large", new Date().toISOString(), { value: "x".repeat(9 * 1024) });

      expect(() : any => append(
        store,
        "current.overflow",
        new Date().toISOString(),
        { value: "y".repeat(9 * 1024) }
      )).toThrow(OperationAuditCapacityError);

      const meta: any = store.db.prepare(`
        SELECT row_count AS rowCount, logical_bytes AS logicalBytes
        FROM operation_audit_meta
        WHERE singleton = 1
      `).get();
      const exact: any = store.db.prepare(`
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

  it("migrates existing rows into exact retention counters once", async () : Promise<any> => {
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

    const reopened: any = createOperationAuditStore({ userDataPath });
    try {
      const meta: any = reopened.db.prepare(`
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

  it("configures bounded WAL reuse and incremental page reclamation", async () : Promise<any> => {
    const { store } = await createStore();
    try {
      const policy: any = store.setRetentionPolicy({ maxDatabaseBytes: 4 * 1024 * 1024 });
      const pageSize: any = Number(store.db.pragma("page_size", { simple: true }));
      const maxPageCount: any = Number(store.db.pragma("max_page_count", { simple: true }));
      expect(Number(store.db.pragma("auto_vacuum", { simple: true }))).toBe(2);
      expect(maxPageCount * pageSize).toBeLessThanOrEqual(policy.maxDatabaseBytes);
      expect(Number(store.db.pragma("journal_size_limit", { simple: true }))).toBe(16 * 1024 * 1024);
    } finally {
      store.close();
    }
  });
});

describe("operation audit idempotent append", () : any => {
  it("requires an explicit non-empty auditId", async () : Promise<any> => {
    const { store } = await createStore();
    try {
      for (const entry of [
        null,
        { operationId: "audit.idempotent" },
        { auditId: "", operationId: "audit.idempotent" },
        { auditId: "   ", operationId: "audit.idempotent" }
      ]) {
        expect(() : any => store.appendIdempotent(entry)).toThrowError(
          expect.objectContaining({
            name: "OperationAuditIdRequiredError",
            code: "operation_audit_id_required"
          })
        );
      }
      expect(() : any => store.appendIdempotent({ operationId: "audit.idempotent" }))
        .toThrow(OperationAuditIdRequiredError);
      expect(store.getById("")).toBeNull();
      expect(store.getById("missing-audit-id")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("replays the same normalized redacted record without consuming capacity", async () : Promise<any> => {
    const { store } = await createStore();
    try {
      store.setRetentionPolicy({
        maxRecords: 1,
        maintenanceEveryAppends: 1
      });
      const first: any = store.appendIdempotent({
        auditId: "audit-idempotent-1",
        traceId: "trace-idempotent-1",
        operationId: "audit.idempotent",
        transport: "test",
        status: "ok",
        actor: {
          userId: "synthetic-user",
          teamIds: ["synthetic-team"]
        },
        input: {
          beta: 2,
          token: "synthetic-token",
          alpha: 1
        },
        output: {
          beta: true,
          alpha: "complete"
        }
      });
      const afterFirst: any = store.db.prepare(`
        SELECT row_count AS rowCount,
               logical_bytes AS logicalBytes,
               append_count AS appendCount
        FROM operation_audit_meta
        WHERE singleton = 1
      `).get();

      const replay: any = store.appendIdempotent({
        auditId: "audit-idempotent-1",
        operationId: "audit.idempotent",
        traceId: "trace-idempotent-1",
        status: "ok",
        transport: "test",
        actor: {
          teamIds: ["synthetic-team"],
          userId: "synthetic-user"
        },
        input: {
          alpha: 1,
          token: "synthetic-token",
          beta: 2
        },
        output: {
          alpha: "complete",
          beta: true
        }
      });
      const afterReplay: any = store.db.prepare(`
        SELECT row_count AS rowCount,
               logical_bytes AS logicalBytes,
               append_count AS appendCount
        FROM operation_audit_meta
        WHERE singleton = 1
      `).get();

      expect(first).toMatchObject({
        auditId: "audit-idempotent-1",
        replayed: false
      });
      expect(replay).toEqual({
        auditId: "audit-idempotent-1",
        replayed: true,
        maintenance: { deletedCount: 0 }
      });
      expect(afterReplay).toEqual(afterFirst);
      expect(afterReplay.appendCount).toBe(1);
      expect(store.list({ limit: 10 })).toHaveLength(1);
      expect(store.getById("audit-idempotent-1")).toMatchObject({
        auditId: "audit-idempotent-1",
        traceId: "trace-idempotent-1",
        operationId: "audit.idempotent",
        status: "ok",
        redactedInput: {
          alpha: 1,
          beta: 2,
          token: "<redacted>"
        }
      });
    } finally {
      store.close();
    }
  });

  it("rejects a different normalized record with a stable typed conflict", async () : Promise<any> => {
    const { store } = await createStore();
    try {
      const entry: Record<string, any> = {
        auditId: "audit-idempotent-conflict",
        operationId: "audit.idempotent",
        transport: "test",
        status: "ok",
        input: { requestDigest: "a".repeat(64) },
        createdAt: "2026-01-01T00:00:00.000Z"
      };
      store.appendIdempotent(entry);
      const beforeConflict: any = store.db.prepare(`
        SELECT row_count AS rowCount,
               logical_bytes AS logicalBytes,
               append_count AS appendCount
        FROM operation_audit_meta
        WHERE singleton = 1
      `).get();

      expect(() : any => store.appendIdempotent({
        ...entry,
        status: "failed"
      })).toThrowError(
        expect.objectContaining({
          name: "OperationAuditIdempotencyConflictError",
          code: "operation_audit_idempotency_conflict",
          auditId: "audit-idempotent-conflict"
        })
      );
      expect(() : any => store.appendIdempotent({
        ...entry,
        status: "failed"
      })).toThrow(OperationAuditIdempotencyConflictError);

      const afterConflict: any = store.db.prepare(`
        SELECT row_count AS rowCount,
               logical_bytes AS logicalBytes,
               append_count AS appendCount
        FROM operation_audit_meta
        WHERE singleton = 1
      `).get();
      expect(afterConflict).toEqual(beforeConflict);
      expect(store.getById(entry.auditId)).toMatchObject({
        status: "ok",
        createdAt: entry.createdAt
      });
    } finally {
      store.close();
    }
  });

  it("replays the persisted normalized record after reopening the store", async () : Promise<any> => {
    const { userDataPath, store } = await createStore();
    const entry: Record<string, any> = {
      auditId: "audit-idempotent-reopen",
      operationId: "audit.idempotent",
      transport: "test",
      status: "ok",
      input: {
        beta: 2,
        alpha: 1
      }
    };
    store.appendIdempotent(entry);
    store.close();

    const reopened: any = createOperationAuditStore({ userDataPath });
    try {
      expect(reopened.appendIdempotent({
        ...entry,
        input: {
          alpha: 1,
          beta: 2
        }
      })).toEqual({
        auditId: entry.auditId,
        replayed: true,
        maintenance: { deletedCount: 0 }
      });
      expect(reopened.list({ limit: 10 })).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it("preserves append as a non-idempotent API", async () : Promise<any> => {
    const { store } = await createStore();
    try {
      const entry: Record<string, any> = {
        auditId: "audit-append-unchanged",
        operationId: "audit.append",
        transport: "test",
        status: "ok"
      };
      expect(store.append(entry)).toMatchObject({
        auditId: entry.auditId
      });
      expect(() : any => store.append(entry)).toThrowError(
        expect.not.objectContaining({
          code: "operation_audit_idempotency_conflict"
        })
      );
      expect(store.list({ limit: 10 })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("does not reinterpret an unrelated unique constraint as an idempotent replay", async () : Promise<any> => {
    const { store } = await createStore();
    try {
      store.db.exec(`
        CREATE UNIQUE INDEX operation_audit_test_unique_operation
        ON operation_audit_log(operation_id)
      `);
      store.appendIdempotent({
        auditId: "audit-unique-1",
        operationId: "audit.unique",
        transport: "test",
        status: "ok"
      });

      let failure: any = null;
      try {
        store.appendIdempotent({
          auditId: "audit-unique-2",
          operationId: "audit.unique",
          transport: "test",
          status: "ok"
        });
      } catch (error: any) {
        failure = error;
      }

      expect(failure).toMatchObject({
        code: "SQLITE_CONSTRAINT_UNIQUE"
      });
      expect(failure).not.toBeInstanceOf(OperationAuditIdempotencyConflictError);
      expect(store.getById("audit-unique-2")).toBeNull();
      expect(store.db.prepare(`
        SELECT row_count AS rowCount, append_count AS appendCount
        FROM operation_audit_meta
        WHERE singleton = 1
      `).get()).toEqual({
        rowCount: 1,
        appendCount: 1
      });
    } finally {
      store.close();
    }
  });
});
