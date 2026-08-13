import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  createManualQueueTimeSource,
  createQueueDefinitionRegistry,
  createSqliteWorkQueueStore,
  DEFAULT_QUEUE_POLICY
} from "../../../packages/foundation/src/work-queue/index.ts";

const roots: string[] = [];

async function createFixture(retention: Record<string, any>) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-retention-conformance-"));
  roots.push(userDataPath);
  const database: any = new Database(path.join(userDataPath, "work-queue.sqlite"));
  const statements: any = { count: 0 };
  const prepare: any = database.prepare.bind(database);
  database.prepare = (sql: any) : any => {
    const statement: any = prepare(sql);
    for (const method of ["get", "all", "run", "iterate"]) {
      const original: any = statement[method].bind(statement);
      statement[method] = (...args: any[]) : any => {
        statements.count += 1;
        return original(...args);
      };
    }
    return statement;
  };
  const registry: any = createQueueDefinitionRegistry();
  const definition: any = registry.registerQueueDefinition({
    queueDefinitionId: "queue.retention.conformance",
    label: "queue.retention.conformance",
    ownerCapability: "runtime-retention-conformance",
    policy: {
      retention: {
        ...DEFAULT_QUEUE_POLICY.retention,
        ...retention
      }
    }
  });
  const store: any = createSqliteWorkQueueStore({
    db: database,
    timeSource: createManualQueueTimeSource(1_700_000_000_000)
  });
  store.registerQueueDefinition(definition);
  statements.count = 0;
  return { database, definition, registry, statements, store };
}

function enqueue(fixture: any, workItemId: string) : any {
  return fixture.store.enqueue({
    ...fixture.registry.resolveQueueDefinitionForEnqueue({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: {},
      dedupeKey: workItemId
    }),
    workItemId,
    payloadRef: { kind: "retention-conformance", workItemId },
    ownerRef: { capability: "runtime-retention-conformance" }
  });
}

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("runtime retention maintenance conformance", () : any => {
  it("keeps ordinary transition statement work history-independent and triggers maintenance by a persisted threshold", async () : Promise<any> => {
    const fixture: any = await createFixture({
      cleanupBatchSize: 4,
      maxJournalEntries: 100,
      maxTransitionsPerWorkItem: 100,
      maxTerminalItems: 100
    });
    const statementDeltas: number[] = [];
    for (let index: any = 0; index < 4; index += 1) {
      const before: any = fixture.statements.count;
      enqueue(fixture, `retention-${index}`);
      statementDeltas.push(fixture.statements.count - before);
    }
    expect(new Set(statementDeltas.slice(0, 3)).size).toBe(1);
    expect(statementDeltas[3]).toBeLessThanOrEqual(statementDeltas[0] + 12);
    expect(fixture.database.prepare(`
      SELECT pending_transitions FROM work_queue_retention_state
      WHERE queue_definition_id = ?
    `).get(fixture.definition.queueDefinitionId)?.pending_transitions).toBe(0);
    fixture.store.close();
  });

  it("bounds terminal and journal growth while deleting only configured batches", async () : Promise<any> => {
    const fixture: any = await createFixture({
      cleanupBatchSize: 2,
      maxJournalEntries: 6,
      maxTransitionsPerWorkItem: 2,
      maxTerminalItems: 1
    });
    for (let index: any = 0; index < 6; index += 1) {
      const workItemId: any = `terminal-${index}`;
      enqueue(fixture, workItemId);
      const claimed: any = fixture.store.claim({
        queueDefinitionId: fixture.definition.queueDefinitionId,
        scope: {},
        workerId: `worker-${index}`,
        batchSize: 1
      }).claimed[0];
      fixture.store.complete({
        workItemId,
        leaseId: claimed.lease.leaseId,
        reason: "retention_conformance_complete"
      });
    }
    const terminalCount: any = fixture.database.prepare(`
      SELECT COUNT(*) AS count FROM work_items
      WHERE queue_definition_id = ? AND state IN ('completed', 'cancelled', 'expired')
    `).get(fixture.definition.queueDefinitionId)?.count;
    const journalCount: any = fixture.database.prepare(`
      SELECT COUNT(*) AS count FROM work_queue_transition_journal
      WHERE queue_definition_id = ?
    `).get(fixture.definition.queueDefinitionId)?.count;
    expect(terminalCount).toBeLessThanOrEqual(2);
    expect(journalCount).toBeLessThanOrEqual(7);
    expect(fixture.store.rebuildProjection()).toMatchObject({ ok: true, errors: [], drift: [] });
    fixture.store.close();
  });
});
