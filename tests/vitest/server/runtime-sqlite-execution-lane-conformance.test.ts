import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQueueDefinitionRegistry,
  createSqliteWorkQueueLane
} from "../../../packages/foundation/src/work-queue/index.ts";
import { createOperationAuditStore } from "../../../packages/foundation/src/security/operation-audit.ts";
import { createAuthorizationStore } from "../../../packages/foundation/src/security/authorization/authorization-store.ts";
import { createOperationPermissionStore } from "../../../packages/capabilities/src/operation-permission-core/store.ts";

const roots: any[] = [];

describe("typed SQLite execution lane", () : any => {
  afterEach(async () : Promise<any> => {
    await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
  });

  it("owns one queue writer and transports only bounded discriminated commands", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-lane-"));
    roots.push(root);
    const store: any = createSqliteWorkQueueLane({ userDataPath: root, maxPending: 8, maxPendingBytes: 4096 });
    const registry: any = createQueueDefinitionRegistry();
    const definition: any = registry.registerQueueDefinition({
      queueDefinitionId: "queue.sqlite.lane",
      label: "queue.sqlite.lane",
      ownerCapability: "sqlite-lane-test"
    });
    try {
      await store.registerQueueDefinition(definition);
      const admission: any = registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: definition.queueDefinitionId,
        scope: {},
        dedupeKey: "one"
      });
      const enqueued: any = await store.enqueue({
        ...admission,
        workItemId: "lane-item-one",
        payloadRef: { kind: "test" },
        ownerRef: { capability: "sqlite-lane-test" }
      });
      expect(enqueued.workItem.workItemId).toBe("lane-item-one");
      expect(store.lane.getStats()).toMatchObject({ writerWorkers: 1, pending: 0 });
      await expect(store.lane.execute("enqueue", { sql: "SELECT 1" }))
        .rejects.toMatchObject({ code: "sqlite_lane_payload_rejected" });
      await expect(store.lane.execute("unknown", {}))
        .rejects.toMatchObject({ code: "sqlite_lane_command_rejected" });
    } finally {
      await store.close();
    }
    expect(store.lane.getStats()).toMatchObject({ writerWorkers: 0, closed: true });
  });

  it("owns one mandatory-evidence writer and rejects untyped or oversized requests", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-audit-lane-"));
    roots.push(root);
    const store: any = createOperationAuditStore({
      userDataPath: root,
      maxPending: 8,
      maxPendingBytes: 256
    });
    try {
      expect(store.db).toBeUndefined();
      expect(store.getStats()).toMatchObject({
        owner: "mandatory-evidence-operation-audit",
        writerWorkers: 1,
        maxPending: 8,
        maxPendingBytes: 256
      });
      expect(await store.append({
        operationId: "audit.owner.probe",
        transport: "test",
        status: "ok"
      })).toMatchObject({ auditId: expect.any(String) });
    } finally {
      await store.close();
    }
    expect(store.getStats()).toMatchObject({ writerWorkers: 0, closed: true });
  });

  it("owns one authorization writer through an async-only facade lifecycle", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-authorization-lane-"));
    roots.push(root);
    const store: any = createAuthorizationStore({
      userDataPath: root,
      maxPending: 8,
      maxPendingBytes: 4096
    });
    try {
      expect(store.db).toBeUndefined();
      expect(store.getStats()).toMatchObject({
        owner: "authorization-evidence",
        writerWorkers: 1,
        maxPending: 8,
        maxPendingBytes: 4096
      });
      const decision: any = await store.appendDecision({
        traceId: "authorization-lane-probe",
        subject: { type: "test", subjectId: "authorization-lane-subject" },
        operation: { id: "authorization.lane.probe" },
        effect: "allow",
        allowed: true,
        reasonCode: "allowed",
        createdAt: "2026-08-13T00:00:00.000Z"
      });
      expect(decision).toMatchObject({ decisionId: expect.any(String) });
      expect(await store.listDecisions({ traceId: "authorization-lane-probe", limit: 1 }))
        .toHaveLength(1);
    } finally {
      await store.close();
    }
    expect(store.getStats()).toMatchObject({ writerWorkers: 0, closed: true });
  });

  it("owns one operation-permission writer through an async-only facade lifecycle", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-operation-permission-lane-"));
    roots.push(root);
    const store: any = createOperationPermissionStore({
      userDataPath: root,
      capabilityBindingGuard: false,
      capabilityResolver: () : any => ["cap:tool:*"],
      maxPending: 8,
      maxPendingBytes: 4096
    });
    try {
      expect(store.db).toBeUndefined();
      expect(store.getStats()).toMatchObject({
        owner: "authorization-operation-permission",
        writerWorkers: 1,
        maxPending: 8,
        maxPendingBytes: 4096
      });
      const created: any = await store.createGrant({
        id: "operation-permission-lane-probe",
        label: "Operation Permission lane probe",
        capabilities: ["cap:tool:*"]
      });
      expect(created.grant).toMatchObject({ id: "operation-permission-lane-probe", enabled: true });
      expect(await store.getGrant(created.grant.id)).toMatchObject({ enabled: true });
      await expect(store.lane.execute("getGrant", { sql: "SELECT 1" }))
        .rejects.toMatchObject({ code: "sqlite_lane_payload_rejected" });
    } finally {
      await store.close();
    }
    expect(store.getStats()).toMatchObject({ writerWorkers: 0, closed: true });
  });
});
