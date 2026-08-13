import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { afterEach, describe, expect, it } from "vitest";

import {
  createManualQueueTimeSource,
  createQueueDefinitionRegistry,
  createSqliteWorkQueueStore
} from "../../../packages/foundation/src/work-queue/index.ts";
import { WORK_QUEUE_PRIORITY_CYCLE } from "../../../packages/foundation/src/work-queue/scheduling.ts";

const roots: any[] = [];

async function makeFixture(policy: Record<string, any> = {}) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-capacity-fair-claim-"));
  roots.push(userDataPath);
  const timeSource: any = createManualQueueTimeSource(1_700_000_000_000);
  const registry: any = createQueueDefinitionRegistry();
  const definition: any = registry.registerQueueDefinition({
    queueDefinitionId: "queue.fair-claim",
    label: "queue.fair-claim",
    ownerCapability: "runtime-capacity-fair-claim-conformance"
  });
  const store: any = createSqliteWorkQueueStore({
    userDataPath,
    timeSource,
    policy: {
      retryBackoff: {
        strategy: "exponential",
        initialDelayMs: 1,
        multiplier: 1,
        maxDelayMs: 1,
        jitter: "none"
      },
      ...policy
    }
  });
  store.registerQueueDefinition(definition);
  return { store, definition, registry, timeSource };
}

async function makeCountingFixture() : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-capacity-fair-claim-count-"));
  roots.push(userDataPath);
  const db: any = new Database(path.join(userDataPath, "work-queue.sqlite"));
  const counter: any = { statements: 0 };
  const prepare: any = db.prepare.bind(db);
  db.prepare = (sql: any) : any => {
    const statement: any = prepare(sql);
    for (const method of ["get", "all", "run", "iterate"]) {
      const original: any = statement[method].bind(statement);
      statement[method] = (...args: any[]) : any => {
        counter.statements += 1;
        return original(...args);
      };
    }
    return statement;
  };
  const registry: any = createQueueDefinitionRegistry();
  const definition: any = registry.registerQueueDefinition({
    queueDefinitionId: "queue.fair-claim-count",
    label: "queue.fair-claim-count",
    ownerCapability: "runtime-capacity-fair-claim-conformance"
  });
  const store: any = createSqliteWorkQueueStore({
    db,
    timeSource: createManualQueueTimeSource(1_700_000_000_000),
    policy: {
      retryBackoff: {
        strategy: "exponential",
        initialDelayMs: 1,
        multiplier: 1,
        maxDelayMs: 1,
        jitter: "none"
      }
    }
  });
  store.registerQueueDefinition(definition);
  counter.statements = 0;
  return { store, definition, registry, counter };
}

function boundary() : any {
  return { tenantId: "platform", workspaceId: "fair-claim" };
}

function enqueue(fixture: any, workItemId: any, schedulingScope: any, priority: any = 0) : any {
  return fixture.store.enqueue({
    ...fixture.registry.resolveQueueDefinitionForEnqueue({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: boundary(),
      dedupeKey: workItemId
    }),
    workItemId,
    schedulingScope,
    payloadRef: { kind: "fair-claim-conformance", workItemId },
    ownerRef: { capability: "runtime-capacity-fair-claim-conformance" },
    priority
  });
}

function claim(fixture: any, workerId: any, batchSize: any = 10) : any {
  return fixture.store.claim({
    queueDefinitionId: fixture.definition.queueDefinitionId,
    scope: boundary(),
    schedulingScope: {},
    workerId,
    batchSize
  });
}

async function completeAll(fixture: any, claimed: any[]) : Promise<any> {
  for (const entry of claimed) {
    fixture.store.complete({
      workItemId: entry.workItem.workItemId,
      leaseId: entry.lease.leaseId,
      reason: "fair_claim_complete"
    });
  }
}

async function virtualFinishRows(fixture: any) : Promise<any> {
  return fixture.store.database.prepare(`
    SELECT tenant_id, workspace_id, project_id, priority_class, virtual_finish
    FROM work_queue_virtual_finish
    ORDER BY tenant_id, workspace_id, project_id
  `).all();
}

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("runtime capacity fair claim conformance", () : any => {
  it("rotates set-based virtual-finish claims deterministically across tenant partitions", async () : Promise<any> => {
    const fixture: any = await makeFixture();
    for (const work of [
      ["a-1", "tenant-a", "workspace-a", "project-a"],
      ["a-2", "tenant-a", "workspace-a", "project-b"],
      ["a-3", "tenant-a", "workspace-b", "project-c"],
      ["b-1", "tenant-b", "workspace-c", "project-d"],
      ["b-2", "tenant-b", "workspace-c", "project-e"],
      ["b-3", "tenant-b", "workspace-d", "project-f"]
    ]) {
      enqueue(fixture, work[0], {
        tenantId: work[1],
        workspaceId: work[2],
        projectId: work[3]
      });
    }
    const claimed: any = claim(fixture, "fair-worker-1", 6).claimed;
    expect(claimed).toHaveLength(6);
    expect(claimed.map((item?: any) : any => item.workItem.schedulingScope.tenantId)).toEqual([
      "tenant-a",
      "tenant-b",
      "tenant-a",
      "tenant-b",
      "tenant-a",
      "tenant-b"
    ]);
    const projections: any = await virtualFinishRows(fixture);
    expect(projections).toHaveLength(6);
    for (const projection of projections) {
      expect(projection.virtual_finish).toBe(1);
    }
    fixture.store.close();
  });

  it("serves each partition within fairness tolerance across repeated claim rounds", async () : Promise<any> => {
    const fixture: any = await makeFixture();
    const scopeA: any = { tenantId: "tenant-a", workspaceId: "workspace-a", projectId: "project-a" };
    const scopeB: any = { tenantId: "tenant-b", workspaceId: "workspace-b", projectId: "project-b" };
    for (let index: any = 0; index < 3; index += 1) {
      enqueue(fixture, `a-${index}`, scopeA);
    }
    enqueue(fixture, "b-0", scopeB);
    const first: any = claim(fixture, "fair-worker-1", 4).claimed;
    expect(first.map((item?: any) : any => item.workItem.schedulingScope.tenantId)).toEqual([
      "tenant-a",
      "tenant-b",
      "tenant-a",
      "tenant-a"
    ]);
    await completeAll(fixture, first);

    for (let index: any = 0; index < 2; index += 1) {
      enqueue(fixture, `a-${index + 3}`, scopeA);
      enqueue(fixture, `b-${index + 1}`, scopeB);
    }
    const second: any = claim(fixture, "fair-worker-2", 4).claimed;
    expect(second.map((item?: any) : any => item.workItem.schedulingScope.tenantId)).toEqual([
      "tenant-a",
      "tenant-b",
      "tenant-a",
      "tenant-b"
    ]);
    expect((await virtualFinishRows(fixture)).length).toBeGreaterThan(0);
    fixture.store.close();
  });

  it("keeps empty and contended claims at fixed small statement work independent of history", async () : Promise<any> => {
    const claimStatements = (fixture: any, workload: () : any) : any => {
      const before: any = fixture.counter.statements;
      workload();
      return fixture.counter.statements - before;
    };
    const scope: any = { tenantId: "tenant-a", workspaceId: "workspace-a", projectId: "project-a" };
    const small: any = await makeCountingFixture();
    enqueue(small, "single-1", scope);
    const singleCount: any = claimStatements(small, () : any => claim(small, "count-worker", 1));
    expect(singleCount).toBeGreaterThan(0);

    const large: any = await makeCountingFixture();
    for (let index: any = 0; index < 201; index += 1) {
      enqueue(large, `bulk-${index}`, {
        ...scope,
        projectId: index % 5 === 0 ? "project-b" : "project-a"
      });
    }
    const contendedCount: any = claimStatements(large, () : any => claim(large, "count-worker", 1));
    expect(contendedCount).toBe(singleCount);

    const emptyCountOne: any = claimStatements(small, () : any => claim(small, "count-worker", 1));
    const emptyCountTwo: any = claimStatements(small, () : any => claim(small, "count-worker", 1));
    expect(emptyCountTwo).toBe(emptyCountOne);
    expect(emptyCountOne).toBeLessThanOrEqual(64);
    expect(singleCount).toBeLessThanOrEqual(96);
    small.store.close();
    large.store.close();
  });

  it("keeps virtual-finish projections monotonic and never resurrects fairness cursors", async () : Promise<any> => {
    const fixture: any = await makeFixture();
    const schemaTables: any = fixture.store.database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
        'work_queue_fairness_cursors', 'work_queue_virtual_finish'
      ) ORDER BY name
    `).all().map((row?: any) : any => row.name);
    expect(schemaTables).toEqual(["work_queue_virtual_finish"]);

    const scopeA: any = { tenantId: "tenant-a", workspaceId: "workspace-a", projectId: "project-a" };
    const scopeB: any = { tenantId: "tenant-b", workspaceId: "workspace-b", projectId: "project-b" };
    enqueue(fixture, "mono-a-1", scopeA);
    enqueue(fixture, "mono-a-2", scopeA);
    enqueue(fixture, "mono-b-1", scopeB);
    const before: any = await virtualFinishRows(fixture);
    expect(before.map((row?: any) : any => row.virtual_finish)).toEqual([0, 0]);

    const claimed: any[] = [];
    for (let visit: any = 0; visit < 3; visit += 1) {
      const batch: any = claim(fixture, "mono-worker", 1).claimed;
      expect(batch).toHaveLength(1);
      claimed.push(batch[0]);
      const after: any = await virtualFinishRows(fixture);
      const claimedRow: any = after.find((row?: any) : any => (
        row.tenant_id === batch[0].workItem.schedulingScope.tenantId
      ));
      const beforeRow: any = before.find((row?: any) : any => (
        row.tenant_id === batch[0].workItem.schedulingScope.tenantId
      ));
      expect(claimedRow.virtual_finish).toBeGreaterThan(beforeRow.virtual_finish);
      before.splice(0, before.length, ...after);
    }

    await completeAll(fixture, claimed);
    const idleRows: any = await virtualFinishRows(fixture);
    const remaining: any = claim(fixture, "mono-worker", 10).claimed;
    expect(remaining).toHaveLength(0);
    expect(idleRows.filter((row?: any) : any => row.virtual_finish > 0)).toHaveLength(0);
    fixture.store.close();
  });

  it("lets interleaved workers progress without a locked-row convoy", async () : Promise<any> => {
    const fixture: any = await makeFixture();
    for (let index: any = 0; index < 6; index += 1) {
      enqueue(fixture, `convoy-${index}`, {
        tenantId: index % 2 === 0 ? "tenant-a" : "tenant-b",
        workspaceId: "workspace-a",
        projectId: "project-a"
      });
    }
    const first: any = claim(fixture, "convoy-worker-1", 2).claimed;
    const second: any = claim(fixture, "convoy-worker-2", 2).claimed;
    const third: any = claim(fixture, "convoy-worker-1", 2).claimed;
    const all: any = [...first, ...second, ...third].map((entry?: any) : any => entry.workItem.workItemId);
    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(6);
    expect([...first, ...second, ...third].map((entry?: any) : any => (
      entry.workItem.schedulingScope.tenantId
    ))).toEqual([
      "tenant-a",
      "tenant-b",
      "tenant-a",
      "tenant-b",
      "tenant-a",
      "tenant-b"
    ]);
    fixture.store.close();
  });

  it("samples the finite priority cycle only once per claim round", async () : Promise<any> => {
    expect(WORK_QUEUE_PRIORITY_CYCLE).toHaveLength(15);
    const fixture: any = await makeFixture();
    const scope: any = { tenantId: "tenant-a", workspaceId: "workspace-a", projectId: "project-a" };
    for (let index: any = 0; index < 15; index += 1) {
      enqueue(fixture, `cycle-${index}`, scope);
    }
    const claimed: any = claim(fixture, "cycle-worker", 15).claimed;
    expect(claimed).toHaveLength(15);
    expect(claimed.every((entry?: any) : any => entry.workItem.priorityClass === "normal")).toBe(true);
    fixture.store.close();
  });
});
