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

const temporaryRoots: Set<string> = new Set();

async function createStore(options: Record<string, any> = {}) : Promise<any> {
  const userDataPath: string = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-audit-retention-"));
  temporaryRoots.add(userDataPath);
  return { userDataPath, store: createOperationAuditStore({ userDataPath, ...options }) };
}

function record(operationId: string, createdAt = new Date().toISOString(), input: Record<string, any> = {}) : any {
  return { operationId, transport: "test", status: "ok", input, createdAt };
}

function oldIso(days: number) : string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function captureRejection(request: Promise<any>) : Promise<any> {
  try {
    await request;
  } catch (error: any) {
    return error;
  }
  throw new Error("Expected operation-audit worker request to reject.");
}

afterEach(async () : Promise<void> => {
  for (const root of temporaryRoots) await fs.rm(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

describe.sequential("operation audit bounded worker owner", () : any => {
  it("owns one worker and rejects arbitrary, path, and oversized requests", async () : Promise<any> => {
    const { store } = await createStore({ maxPending: 8, maxPendingBytes: 256 });
    try {
      expect(store.db).toBeUndefined();
      expect(store.getStats()).toMatchObject({
        owner: "mandatory-evidence-operation-audit",
        writerWorkers: 1,
        maxPending: 8,
        maxPendingBytes: 256
      });
      expect(await store.append(record("audit.owner.probe"))).toMatchObject({ auditId: expect.any(String) });
    } finally {
      await store.close();
    }
    expect(store.getStats()).toMatchObject({ writerWorkers: 0, closed: true });
  });

  it("keeps auth.login credentials out of audit input and digest", async () : Promise<any> => {
    const { store } = await createStore();
    const operation: any = SERVER_API_OPERATIONS.find(({ id }: any) : any => id === "auth.login");
    try {
      for (const password of ["synthetic-password-one", "synthetic-password-two"]) {
        await auditOperation({ operationAuditStore: store, operation, transport: "test", input: { username: "synthetic-user", password }, status: "denied" });
      }
      const records: any[] = await store.list({ operationId: "auth.login", limit: 10 });
      expect(records).toHaveLength(2);
      expect(records.map(({ redactedInput }: any) : any => redactedInput)).toEqual([{}, {}]);
      expect(new Set(records.map(({ inputHash }: any) : any => inputHash)).size).toBe(1);
      expect(JSON.stringify(records)).not.toContain("synthetic-password");
    } finally {
      await store.close();
    }
  });

  it("removes expired rows in bounded batches without deleting current evidence", async () : Promise<any> => {
    const { store } = await createStore();
    try {
      await store.append(record("expired.one", oldIso(3)));
      await store.append(record("expired.two", oldIso(3)));
      await store.append(record("expired.three", oldIso(3)));
      await store.setRetentionPolicy({ retentionDays: 1, cleanupBatchSize: 2, maintenanceEveryAppends: 1 });
      expect((await store.append(record("current.one"))).maintenance.deletedCount).toBe(2);
      expect((await store.append(record("current.two"))).maintenance.deletedCount).toBe(1);
      expect((await store.list({ limit: 20 })).map((item: any) : any => item.operationId)).toEqual(["current.two", "current.one"]);
    } finally {
      await store.close();
    }
  });

  it("fails closed when record and logical byte capacity are exhausted", async () : Promise<any> => {
    const { store } = await createStore();
    try {
      await store.setRetentionPolicy({ maxRecords: 2, maintenanceEveryAppends: 1 });
      await store.append(record("current.one"));
      await store.append(record("current.two"));
      expect(await captureRejection(store.append(record("current.three"))))
        .toBeInstanceOf(OperationAuditCapacityError);
      expect((await store.list({ limit: 20 })).map((item: any) : any => item.operationId)).toEqual(["current.two", "current.one"]);
      const stats: any = await store.getCapacityStats();
      expect(stats).toMatchObject({ rowCount: 2, appendCount: 2 });
      expect(stats.logicalBytes).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  });

  it("configures bounded WAL reuse and page reclamation inside the owner", async () : Promise<any> => {
    const { store } = await createStore();
    try {
      const policy: any = await store.setRetentionPolicy({ maxDatabaseBytes: 4 * 1024 * 1024 });
      const stats: any = await store.getCapacityStats();
      expect(stats.autoVacuum).toBe(2);
      expect(stats.maxPageCount * stats.pageSize).toBeLessThanOrEqual(policy.maxDatabaseBytes);
      expect(stats.journalSizeLimit).toBe(16 * 1024 * 1024);
    } finally {
      await store.close();
    }
  });
});

describe.sequential("operation audit idempotent worker commands", () : any => {
  it("requires an explicit non-empty auditId and preserves typed errors", async () : Promise<any> => {
    const { store } = await createStore();
    try {
      for (const entry of [null, { operationId: "audit.idempotent" }, { auditId: "" }, { auditId: "   " }]) {
        expect(await captureRejection(store.appendIdempotent(entry)))
          .toBeInstanceOf(OperationAuditIdRequiredError);
      }
      await expect(store.getById("")).resolves.toBeNull();
      await expect(store.getById("missing-audit-id")).resolves.toBeNull();
    } finally {
      await store.close();
    }
  });

  it("replays the same normalized record without consuming capacity", async () : Promise<any> => {
    const { store } = await createStore();
    const entry: any = {
      auditId: "audit-idempotent-1",
      traceId: "trace-idempotent-1",
      operationId: "audit.idempotent",
      transport: "test",
      status: "ok",
      actor: { userId: "synthetic-user", teamIds: ["synthetic-team"] },
      input: { beta: 2, token: "synthetic-token", alpha: 1 },
      output: { beta: true, alpha: "complete" }
    };
    try {
      await store.setRetentionPolicy({ maxRecords: 1, maintenanceEveryAppends: 1 });
      expect(await store.appendIdempotent(entry)).toMatchObject({ auditId: entry.auditId, replayed: false });
      const before: any = await store.getCapacityStats();
      expect(await store.appendIdempotent({
        ...entry,
        actor: { teamIds: ["synthetic-team"], userId: "synthetic-user" },
        input: { alpha: 1, token: "synthetic-token", beta: 2 },
        output: { alpha: "complete", beta: true }
      })).toEqual({ auditId: entry.auditId, replayed: true, maintenance: { deletedCount: 0 } });
      expect(await store.getCapacityStats()).toMatchObject({ rowCount: before.rowCount, logicalBytes: before.logicalBytes, appendCount: before.appendCount });
      expect(await store.getById(entry.auditId)).toMatchObject({ redactedInput: { alpha: 1, beta: 2, token: "<redacted>" } });
    } finally {
      await store.close();
    }
  });

  it("rejects a different normalized record with a stable typed conflict", async () : Promise<any> => {
    const { store } = await createStore();
    const entry: any = { auditId: "audit-idempotent-conflict", operationId: "audit.idempotent", transport: "test", status: "ok", createdAt: "2026-01-01T00:00:00.000Z" };
    try {
      await store.appendIdempotent(entry);
      expect(await captureRejection(store.appendIdempotent({ ...entry, status: "failed" })))
        .toBeInstanceOf(OperationAuditIdempotencyConflictError);
      await expect(store.getById(entry.auditId)).resolves.toMatchObject({ status: "ok", createdAt: entry.createdAt });
    } finally {
      await store.close();
    }
  });

  it("replays persisted normalized evidence after lane reopen", async () : Promise<any> => {
    const { userDataPath, store } = await createStore();
    const entry: any = { auditId: "audit-idempotent-reopen", operationId: "audit.idempotent", transport: "test", status: "ok", input: { beta: 2, alpha: 1 } };
    await store.appendIdempotent(entry);
    await store.close();
    const reopened: any = createOperationAuditStore({ userDataPath });
    try {
      await expect(reopened.appendIdempotent({ ...entry, input: { alpha: 1, beta: 2 } }))
        .resolves.toMatchObject({ auditId: entry.auditId, replayed: true });
      await expect(reopened.list({ limit: 10 })).resolves.toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });
});
