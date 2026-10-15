import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  createManualQueueTimeSource,
  createQueueDefinitionRegistry,
  createQueueFallbackCoordinator,
  createSqliteWorkQueueStore
} from "../../../packages/foundation/src/work-queue/index.ts";

describe("work queue fallback persistence", () => {
  it("journals one final fallback outcome and keeps it recoverable", async () => {
    const database: any = new Database(":memory:");
    const writes: Record<string, number> = {};
    let countWrites = false;
    const prepare: any = database.prepare.bind(database);
    database.prepare = (sql: string): any => {
      const statement = prepare(sql);
      const table = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+["`]?([A-Za-z0-9_]+)/iu.exec(sql)?.[1];
      if (table) {
        const run = statement.run.bind(statement);
        statement.run = (...args: unknown[]) => {
          if (countWrites) writes[table] = (writes[table] || 0) + 1;
          return run(...args);
        };
      }
      return statement;
    };
    const timeSource = createManualQueueTimeSource(10_000);
    const store = createSqliteWorkQueueStore({ databasePath: "", db: database, timeSource });

    try {
      const registry = createQueueDefinitionRegistry();
      const definition = registry.registerQueueDefinition({
        queueDefinitionId: "queue.fallback.persistence",
        label: "queue.fallback.persistence",
        ownerCapability: "work-queue-fallback-persistence-test"
      });
      store.registerQueueDefinition(definition);

      const enqueue = (workItemId: string) => {
        const resolved = registry.resolveQueueDefinitionForEnqueue({
          queueDefinitionId: definition.queueDefinitionId,
          scope: {},
          dedupeKey: workItemId
        });
        return store.enqueue({
          ...resolved,
          workItemId,
          payloadRef: { kind: "fallback-persistence-test", workItemId },
          ownerRef: { capability: "work-queue-fallback-persistence-test" }
        });
      };
      const claim = (workerId: string) => store.claim({
        queueDefinitionId: definition.queueDefinitionId,
        scope: {},
        workerId,
        batchSize: 1
      }).claimed[0];

      enqueue("failed-oldest");
      const first = claim("fallback-worker");
      const fallback = createQueueFallbackCoordinator({
        store: store as any,
        policy: { fallbackRetry: { maxAttempts: 1 } },
        fallback: async () => {
          throw new Error("synthetic fallback failure");
        }
      });
      let outcome: any;
      countWrites = true;
      try {
        outcome = await fallback.runFallback({
          fallbackTaskId: "fallback-current",
          workItem: first.workItem,
          lease: first.lease,
          workItemId: first.workItem.workItemId,
          leaseId: first.lease.leaseId
        });
      } finally {
        countWrites = false;
      }

      expect(outcome).toMatchObject({ committed: false, failed: true, fallbackTaskId: "fallback-current" });
      expect(writes).toEqual({
        work_queue_transition_journal: 1,
        work_items: 3,
        work_queue_sink_fences: 1
      });
      expect(store.inspect({ workItemId: "failed-oldest", includeJournal: true })).toMatchObject({
        workItem: { state: "failed", fallbackTaskId: "fallback-current" },
        journal: expect.arrayContaining([expect.objectContaining({ transition: "fail", toState: "failed" })])
      });
      expect(store.rebuildProjection()).toMatchObject({ ok: true, errors: [], drift: [] });
      expect(store.inspect({ workItemId: "failed-oldest" }).workItem).toMatchObject({
        state: "failed",
        fallbackTaskId: "fallback-current"
      });
    } finally {
      store.close();
      database.close();
    }
  });
});
