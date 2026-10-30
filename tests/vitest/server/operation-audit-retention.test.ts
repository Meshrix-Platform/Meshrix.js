import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { afterEach, describe, expect, it } from "vitest";

import {
  OperationAuditCapacityError,
  OperationAuditIdempotencyConflictError,
  OperationAuditIdRequiredError,
  createOperationAuditStore,
  inspectOperationAuditProjection
} from "../../../packages/foundation/src/security/operation-audit.ts";
import {
  normalizeLegacyOperationAuditRecord,
  operationAuditProjectionKeyId
} from "../../../packages/foundation/src/security/operation-audit-projection.ts";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import { auditOperation } from "../../../packages/server-runtime/src/composition/dispatch-operation-risk-control.ts";
const canned1 = "synthetic-token";




const temporaryRoots: Set<string> = new Set();
const PROJECTION_KEY = Buffer.alloc(32, 0x41);
const PROJECTION_KEY_ID = operationAuditProjectionKeyId(PROJECTION_KEY);

function projectionOptions(userDataPath: string, key = PROJECTION_KEY): Record<string, unknown> {
  return {
    userDataPath,
    projectionKey: key,
    projectionKeyId: operationAuditProjectionKeyId(key)
  };
}

async function createStore(options: Record<string, any> = {}) : Promise<any> {
  const userDataPath: string = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-audit-retention-"));
  temporaryRoots.add(userDataPath);
  return { userDataPath, store: createOperationAuditStore({ ...projectionOptions(userDataPath), ...options }) };
}

function record(operationId: string, createdAt = new Date().toISOString(), input: Record<string, any> = {}) : any {
  return { operationId, transport: "test", status: "ok", input, createdAt };
}

function oldIso(days: number) : string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function createLegacyAuditRoot(): Promise<string> {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-audit-legacy-"));
  temporaryRoots.add(userDataPath);
  await fs.mkdir(path.join(userDataPath, "security"), { recursive: true, mode: 0o700 });
  return userDataPath;
}

function createLegacyAuditDatabase(userDataPath: string, entry: Record<string, any>, auditId: string): string {
  const databasePath = path.join(userDataPath, "security", "operation-audit.sqlite");
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE operation_audit_log (
        audit_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL DEFAULT '',
        request_id TEXT NOT NULL DEFAULT '',
        tenant_id TEXT NOT NULL DEFAULT '',
        decision_id TEXT NOT NULL DEFAULT '',
        proof_id TEXT NOT NULL DEFAULT '',
        operation_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        actor_json TEXT NOT NULL DEFAULT '{}',
        risk TEXT NOT NULL DEFAULT '',
        read_only INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        input_hash TEXT NOT NULL DEFAULT '',
        redacted_input_json TEXT NOT NULL DEFAULT '{}',
        redacted_output_summary_json TEXT NOT NULL DEFAULT '{}',
        error TEXT NOT NULL DEFAULT '',
        risk_control_anchor_digest TEXT NOT NULL DEFAULT '',
        risk_control_last_record_digest TEXT NOT NULL DEFAULT '',
        risk_control_gate_count INTEGER NOT NULL DEFAULT 0,
        risk_control_envelope_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        record_bytes INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_operation_audit_created ON operation_audit_log(created_at);
    `);
    const legacy = normalizeLegacyOperationAuditRecord(entry, { auditId, fallbackCreatedAt: String(entry.createdAt || "") });
    database.prepare(`
      INSERT INTO operation_audit_log (
        audit_id, trace_id, request_id, tenant_id, decision_id, proof_id, operation_id,
        transport, actor_json, risk, read_only, status, duration_ms, input_hash,
        redacted_input_json, redacted_output_summary_json, error,
        risk_control_anchor_digest, risk_control_last_record_digest, risk_control_gate_count,
        risk_control_envelope_json, created_at, record_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      legacy.auditId, legacy.traceId, legacy.requestId, legacy.tenantId,
      legacy.decisionId, legacy.proofId, legacy.operationId, legacy.transport,
      legacy.actorJson, legacy.risk, legacy.readOnly, legacy.status, legacy.durationMs,
      legacy.inputHash, legacy.redactedInputJson, legacy.redactedOutputSummaryJson,
      legacy.error, legacy.riskControlAnchorDigest, legacy.riskControlLastRecordDigest,
      legacy.riskControlGateCount, legacy.riskControlEnvelopeJson, legacy.createdAt
    );
    database.pragma("user_version = 1");
  } finally {
    database.close();
  }
  return databasePath;
}

async function readOptionalFile(filePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(filePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
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
    const { store } = await createStore({ maxPending: 8, maxPendingBytes: 2048 });
    try {
      expect(store.db).toBeUndefined();
      expect(store.lane).toBeUndefined();
      expect(store.getStats()).toMatchObject({
        owner: "mandatory-evidence-operation-audit",
        writerWorkers: 1,
        maxPending: 8,
        maxPendingBytes: 2048
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

  it("projects legacy rows before startup completes and removes the old values from SQLite remnants", async () : Promise<any> => {
    const userDataPath = await createLegacyAuditRoot();
    const auditId = "legacy-audit-row-1";
    const createdAt = new Date().toISOString();
    const sentinel = "synthetic-legacy-private-sentinel";
    const traceId = "legacy-trace-private-value";
    const tenantId = "legacy-tenant-private-value";
    const userId = "legacy-user-private-value";
    const entry: any = {
      auditId,
      traceId,
      requestId: "legacy-request-private-value",
      tenantId,
      operationId: "auth.login",
      transport: "http",
      status: "denied",
      risk: "high",
      durationMs: 7,
      actor: { type: "console-user", userId, username: "legacy-name-private-value", roleId: "administrator", tenantId, teamIds: ["legacy-team-private-value"] },
      input: { customerNote: sentinel, password: sentinel },
      output: { message: sentinel, count: 3 },
      error: sentinel,
      createdAt,
      riskControl: {
        envelopeVersion: "synthetic-envelope-v1",
        operationId: "auth.login",
        traceId,
        inputHash: "legacy-risk-control-input-hash",
        operationAnchorDigest: "synthetic-anchor-digest",
        gateRecords: [{
          recordVersion: "synthetic-gate-v1",
          controlRef: { controlId: "control.console-session", definitionVersion: "1", definitionDigest: "synthetic-control-digest" },
          gate: "session.authentication",
          decision: "deny",
          reasonCode: "invalid_credentials",
          subject: { username: sentinel },
          intent: sentinel,
          resource: { owner: sentinel },
          environment: { host: sentinel },
          enforcedBy: { id: "component.console-auth" },
          factSource: { id: "fact.console-session" },
          evidence: [{ value: sentinel }],
          occurredAt: createdAt,
          previousRecordDigest: "synthetic-previous-digest",
          recordDigest: "synthetic-record-digest"
        }]
      }
    };
    const databasePath = createLegacyAuditDatabase(userDataPath, entry, auditId);
    const retentionPath = path.join(userDataPath, "security", "audit-retention.json");
    await fs.writeFile(retentionPath, JSON.stringify({
      retentionDays: 90,
      updatedBy: { type: "console-user", userId: "legacy-retention-user", username: sentinel, roleId: "administrator" }
    }), { mode: 0o600 });
    expect((await fs.readFile(databasePath)).toString("utf8")).toContain(sentinel);
    await expect(inspectOperationAuditProjection({ userDataPath })).resolves.toMatchObject({ state: "legacy_unprojected" });

    const store = createOperationAuditStore(projectionOptions(userDataPath));
    await store.ready();
    expect(await inspectOperationAuditProjection({ userDataPath })).toEqual({
      state: "projected",
      projectionKeyId: PROJECTION_KEY_ID
    });
    const [projected] = await store.list({ userId, traceId, tenantId, limit: 10 }) as any[];
    expect(projected).toMatchObject({
      auditId,
      operationId: "auth.login",
      redactedInput: {},
      redactedOutputSummary: { type: "object", keyCount: 2 },
      createdAt
    });
    expect(projected.actor.userId).toMatch(/^hmac-sha256:v1:[a-f0-9]{64}$/u);
    expect(projected.traceId).toMatch(/^hmac-sha256:v1:[a-f0-9]{64}$/u);
    expect(projected.tenantId).toMatch(/^hmac-sha256:v1:[a-f0-9]{64}$/u);
    expect(projected.inputHash).toMatch(/^hmac-sha256:v1:[a-f0-9]{64}$/u);
    expect(projected.error).toMatch(/^hmac-sha256:v1:[a-f0-9]{64}$/u);
    expect(projected.riskControl.envelope.gateRecords[0]).toMatchObject({
      gate: "session.authentication",
      decision: "deny",
      reasonCode: "invalid_credentials",
      subject: {},
      resource: {},
      environment: {},
      evidence: []
    });
    expect(await store.appendIdempotent(entry)).toMatchObject({ auditId, replayed: true });
    for (const changed of [
      { ...entry, input: { ...entry.input, customerNote: "changed-input" } },
      { ...entry, output: { message: "changed-output", count: 3 } },
      { ...entry, actor: { ...entry.actor, username: "changed-actor" } },
      { ...entry, error: "changed-error" }
    ]) {
      await expect(store.appendIdempotent(changed)).rejects.toBeInstanceOf(OperationAuditIdempotencyConflictError);
    }
    await store.close();

    const remnants = await Promise.all([
      readOptionalFile(databasePath),
      readOptionalFile(`${databasePath}-wal`),
      readOptionalFile(`${databasePath}-shm`),
      readOptionalFile(`${databasePath}-journal`),
      readOptionalFile(retentionPath)
    ]);
    for (const bytes of remnants) expect(bytes.toString("utf8")).not.toContain(sentinel);
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      expect(Number(database.prepare("SELECT COUNT(*) AS count FROM operation_audit_log").get()?.count)).toBe(1);
    } finally {
      database.close();
    }
  });

  it("fails before changing an already projected database when key custody does not match", async () : Promise<any> => {
    const { userDataPath, store } = await createStore();
    await store.append(record("audit.projection.key-custody"));
    await store.close();
    const databasePath = path.join(userDataPath, "security", "operation-audit.sqlite");
    const before = await fs.readFile(databasePath);
    const wrongKey = Buffer.alloc(32, 0x42);
    const wrongStore = createOperationAuditStore(projectionOptions(userDataPath, wrongKey));
    const error: any = await captureRejection(wrongStore.ready());
    expect(error.code).toBe("operation_audit_projection_key_mismatch");
    await wrongStore.close().catch(() => undefined);
    expect(await fs.readFile(databasePath)).toEqual(before);
    expect(await inspectOperationAuditProjection({ userDataPath })).toMatchObject({
      state: "projected",
      projectionKeyId: PROJECTION_KEY_ID
    });
  });

  it("removes expired rows in bounded batches without deleting current evidence", async () : Promise<any> => {
    const { store } = await createStore();
    try {
      await store.append(record("expired.one", oldIso(3)));
      await store.append(record("expired.two", oldIso(3)));
      await store.append(record("expired.three", oldIso(3)));
      await store.setRetentionPolicy({ retentionDays: 1, cleanupBatchSize: 2, maintenanceEveryAppends: 1 });
      const currentOneAt = new Date(Date.now()).toISOString();
      const currentTwoAt = new Date(Date.now() + 1_000).toISOString();
      expect((await store.append(record("current.one", currentOneAt))).maintenance.deletedCount).toBe(2);
      expect((await store.append(record("current.two", currentTwoAt))).maintenance.deletedCount).toBe(1);
      expect((await store.list({ limit: 20 })).map((item: any) : any => item.operationId)).toEqual(["current.two", "current.one"]);
    } finally {
      await store.close();
    }
  });

  it("fails closed when record and logical byte capacity are exhausted", async () : Promise<any> => {
    const { store } = await createStore();
    try {
      await store.setRetentionPolicy({ maxRecords: 2, maintenanceEveryAppends: 1 });
      await store.append(record("current.one", new Date(Date.now()).toISOString()));
      await store.append(record("current.two", new Date(Date.now() + 1_000).toISOString()));
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
      await store.append(record("capacity.after-reconfigure"));
      const stats: any = await store.getCapacityStats();
      expect(stats.autoVacuum).toBe(2);
      expect(stats.maxPageCount * stats.pageSize).toBeLessThanOrEqual(policy.maxDatabaseBytes);
      expect(stats.journalSizeLimit).toBe(16 * 1024 * 1024);
    } finally {
      await store.close();
    }
  });

  it("removes the redundant created-time index while preserving audit rows", async () : Promise<any> => {
    const userDataPath = await createLegacyAuditRoot();
    const databasePath = path.join(userDataPath, "security", "operation-audit.sqlite");
    createLegacyAuditDatabase(userDataPath, record("legacy.index.probe", "2026-01-01T00:00:00.000Z"), "legacy-index-probe");

    const migrated = createOperationAuditStore(projectionOptions(userDataPath));
    await migrated.ready();
    await migrated.getCapacityStats();
    await migrated.close();

    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const indexes: any[] = database.pragma("index_list(operation_audit_log)");
      expect(indexes.map((index: any) : any => index.name)).not.toContain("idx_operation_audit_created");
      expect(indexes.map((index: any) : any => index.name)).toContain("idx_operation_audit_retention");
      const plan: any[] = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT audit_id
        FROM operation_audit_log
        WHERE created_at < ?
        ORDER BY created_at ASC, audit_id ASC
        LIMIT ?
      `).all(new Date().toISOString(), 10);
      expect(plan.map(({ detail }: any) : any => String(detail || "")).join(" "))
        .toContain("idx_operation_audit_retention");
      expect(Number(database.prepare("SELECT COUNT(*) AS count FROM operation_audit_log").get()?.count))
        .toBe(1);
    } finally {
      database.close();
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
      input: { beta: 2, token: canned1, alpha: 1 },
      output: { beta: true, alpha: "complete" }
    };
    try {
      await store.setRetentionPolicy({ maxRecords: 1, maintenanceEveryAppends: 1 });
      expect(await store.appendIdempotent(entry)).toMatchObject({ auditId: entry.auditId, replayed: false });
      const before: any = await store.getCapacityStats();
      expect(await store.appendIdempotent({
        ...entry,
        actor: { teamIds: ["synthetic-team"], userId: "synthetic-user" },
        input: { alpha: 1, token: canned1, beta: 2 },
        output: { alpha: "complete", beta: true }
      })).toEqual({ auditId: entry.auditId, replayed: true, maintenance: { deletedCount: 0 } });
      expect(await store.getCapacityStats()).toMatchObject({ rowCount: before.rowCount, logicalBytes: before.logicalBytes, appendCount: before.appendCount });
      expect(await store.getById(entry.auditId)).toMatchObject({ redactedInput: {} });
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
    const reopened: any = createOperationAuditStore(projectionOptions(userDataPath));
    try {
      await expect(reopened.appendIdempotent({ ...entry, input: { alpha: 1, beta: 2 } }))
        .resolves.toMatchObject({ auditId: entry.auditId, replayed: true });
      await expect(reopened.list({ limit: 10 })).resolves.toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });
});
