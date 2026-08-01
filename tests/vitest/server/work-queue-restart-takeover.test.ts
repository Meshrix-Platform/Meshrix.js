import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";

import { describe, expect, it } from "vitest";

import {
  createManualQueueTimeSource,
  createQueueDefinitionRegistry,
  createSqliteWorkQueueStore,
  normalizeQueueDedupeKey
} from "../../../packages/foundation/src/work-queue/index.ts";
import { ensureSqliteWorkQueueSchema } from "../../../packages/foundation/src/work-queue/sqlite-schema.ts";

const DEFINITION_ID: any = "queue.jobs.import-parse";
const SCOPE: Readonly<Record<string, any>> = Object.freeze({ tenantId: "platform", workspaceId: "default" });
const execFileAsync: any = promisify(execFile);
const restartFixturePath: any = path.resolve("tools/server-scripts/lib/work-queue-process-restart-child.ts");

async function runRestartFixture(args?: any) : Promise<any> {
  const result: any = await execFileAsync(process.execPath, [restartFixturePath, ...args], {
    timeout: 15_000,
    maxBuffer: 64 * 1024
  });
  return JSON.parse(String(result.stdout || "").trim());
}

function definition() : any {
  return createQueueDefinitionRegistry().registerQueueDefinition({
    queueDefinitionId: DEFINITION_ID,
    label: "meshrix.jobs.import-parse",
    ownerCapability: "platform.job-workflow"
  });
}

function resolved(definitionValue?: any, dedupeKey?: any) : any {
  const registry: any = createQueueDefinitionRegistry();
  registry.registerQueueDefinition(definitionValue);
  return registry.resolveQueueDefinitionForEnqueue({
    queueDefinitionId: DEFINITION_ID,
    scope: SCOPE,
    dedupeKey
  });
}

function createStore(userDataPath?: any, timeSource?: any) : any {
  return createSqliteWorkQueueStore({
    userDataPath,
    timeSource,
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
}

describe("work queue restart takeover", () : any => {
  it("reloads a stable definition in a fresh process and fences the stale lease", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-work-queue-process-restart-"));
    try {
      const seeded: any = await runRestartFixture(["seed", userDataPath]);
      await new Promise((resolve?: any) : any => setTimeout(resolve, 80));
      const recovered: any = await runRestartFixture([
        "recover",
        userDataPath,
        seeded.workItemId,
        seeded.leaseId
      ]);
      expect(recovered).toMatchObject({
        staleFenceRejected: true,
        recoveredCount: 1,
        claimedWorkItemId: seeded.workItemId,
        replacementLeaseSeq: seeded.leaseSeq + 1,
        completed: true,
        finalState: "completed"
      });
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("enforces absolute work expiry before claim, renewal, and terminal completion", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-work-queue-expiry-"));
    const timeSource: any = createManualQueueTimeSource(5_000);
    const store: any = createStore(userDataPath, timeSource);
    try {
      const queueDefinition: any = definition();
      store.registerQueueDefinition(queueDefinition);
      const expiring: any = store.enqueue({
        ...resolved(queueDefinition, { jobId: "expiring-running", versionNumber: 1 }),
        expiresAtMs: 5_010,
        payloadRef: { kind: "import_parse_job", jobId: "expiring-running" },
        ownerRef: { capability: "platform.job-workflow", jobId: "expiring-running" }
      });
      expect(expiring.workItem.expiresAtMs).toBe(5_010);
      const claimed: any = store.claim({
        queueDefinitionId: DEFINITION_ID,
        scope: SCOPE,
        workerId: "expiry-worker",
        leaseTimeoutMs: 100
      }).claimed[0];
      expect(claimed.lease.expiresAtMs).toBe(5_010);

      timeSource.advance(5);
      expect(store.progress({
        workItemId: claimed.workItem.workItemId,
        leaseId: claimed.lease.leaseId,
        extendMs: 100
      }).lease.expiresAtMs).toBe(5_010);

      timeSource.advance(5);
      expect(store.complete({
        workItemId: claimed.workItem.workItemId,
        leaseId: claimed.lease.leaseId
      })).toMatchObject({ completed: false, expired: true, workItem: { state: "expired", expiresAtMs: 5_010 } });
      expect(store.rebuildProjection()).toMatchObject({ ok: true });

      const queued: any = store.enqueue({
        ...resolved(queueDefinition, { jobId: "expiring-queued", versionNumber: 1 }),
        expiresAtMs: 5_015,
        payloadRef: { kind: "import_parse_job", jobId: "expiring-queued" },
        ownerRef: { capability: "platform.job-workflow", jobId: "expiring-queued" }
      });
      timeSource.advance(5);
      const sweep: any = store.claim({
        queueDefinitionId: DEFINITION_ID,
        scope: SCOPE,
        workerId: "expiry-sweep-worker"
      });
      expect(sweep.claimed).toHaveLength(0);
      expect(sweep.expired).toEqual([
        expect.objectContaining({ workItemId: queued.workItem.workItemId, state: "expired" })
      ]);

      const beforeRejectedAdmissions: any = store.inspect({ queueDefinitionId: DEFINITION_ID }).items.length;
      expect(() : any => store.enqueue({
        ...resolved(queueDefinition, { jobId: "already-expired", versionNumber: 1 }),
        expiresAtMs: timeSource.nowMs(),
        payloadRef: { kind: "import_parse_job", jobId: "already-expired" },
        ownerRef: { capability: "platform.job-workflow", jobId: "already-expired" }
      })).toThrow(/later than the admission time/);
      expect(() : any => store.enqueue({
        ...resolved(queueDefinition, { jobId: "deadline-before-availability", versionNumber: 1 }),
        delayMs: 10,
        expiresAtMs: timeSource.nowMs() + 5,
        payloadRef: { kind: "import_parse_job", jobId: "deadline-before-availability" },
        ownerRef: { capability: "platform.job-workflow", jobId: "deadline-before-availability" }
      })).toThrow(/later than availableAtMs/);
      expect(store.inspect({ queueDefinitionId: DEFINITION_ID }).items).toHaveLength(beforeRejectedAdmissions);
    } finally {
      store.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("keeps definition identity stable, reclaims an expired lease, and fences late completion", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-work-queue-restart-"));
    const timeSource: any = createManualQueueTimeSource(1_000);
    const queueDefinition: any = definition();
    const admission: any = resolved(queueDefinition, { jobId: "job-1", versionNumber: 1 });
    let firstStore: any = createStore(userDataPath, timeSource);
    try {
      firstStore.registerQueueDefinition(queueDefinition);
      const enqueued: any = firstStore.enqueue({
        ...admission,
        payloadRef: { kind: "import_parse_job", jobId: "job-1" },
        ownerRef: { capability: "platform.job-workflow", jobId: "job-1" }
      });
      const firstClaim: any = firstStore.claim({
        queueDefinitionId: DEFINITION_ID,
        scope: SCOPE,
        workerId: "worker-before-restart",
        leaseTimeoutMs: 10
      });
      expect(firstClaim.claimed).toHaveLength(1);
      const staleLease: any = firstClaim.claimed[0];
      firstStore.close();

      const secondStore: any = createStore(userDataPath, timeSource);
      firstStore = null;
      try {
        secondStore.registerQueueDefinition(definition());
        const duplicate: any = secondStore.enqueue({
          ...admission,
          payloadRef: { kind: "import_parse_job", jobId: "job-1" },
          ownerRef: { capability: "platform.job-workflow", jobId: "job-1" }
        });
        expect(duplicate).toMatchObject({
          accepted: false,
          deduped: true,
          workItem: { workItemId: staleLease.workItem.workItemId }
        });

        timeSource.advance(10);
        const recovery: any = secondStore.claim({
          queueDefinitionId: DEFINITION_ID,
          scope: SCOPE,
          workerId: "worker-after-restart",
          leaseTimeoutMs: 10
        });
        expect(recovery.recovered).toHaveLength(1);
        expect(recovery.claimed).toHaveLength(0);

        timeSource.advance(1);
        const takeover: any = secondStore.claim({
          queueDefinitionId: DEFINITION_ID,
          scope: SCOPE,
          workerId: "worker-after-restart",
          leaseTimeoutMs: 10
        });
        expect(takeover.claimed).toHaveLength(1);
        const currentLease: any = takeover.claimed[0];
        expect(currentLease.lease.leaseSeq).toBe(staleLease.lease.leaseSeq + 1);
        expect(currentLease.lease.leaseId).not.toBe(staleLease.lease.leaseId);

        expect(() : any => secondStore.complete({
          workItemId: staleLease.workItem.workItemId,
          leaseId: staleLease.lease.leaseId
        })).toThrow(/Lease fence rejected/);

        const completed: any = secondStore.complete({
          workItemId: currentLease.workItem.workItemId,
          leaseId: currentLease.lease.leaseId
        });
        expect(completed).toMatchObject({ completed: true, workItem: { state: "completed" } });
        expect(secondStore.complete({
          workItemId: currentLease.workItem.workItemId,
          leaseId: currentLease.lease.leaseId
        })).toMatchObject({ completed: true, idempotent: true });

        expect(secondStore.enqueue({
          ...admission,
          payloadRef: { kind: "import_parse_job", jobId: "job-1" },
          ownerRef: { capability: "platform.job-workflow", jobId: "job-1" }
        })).toMatchObject({
          accepted: false,
          deduped: true,
          workItem: { workItemId: currentLease.workItem.workItemId, state: "completed" }
        });

        const cancellationAdmission: any = resolved(queueDefinition, { jobId: "job-2", versionNumber: 1 });
        const cancellable: any = secondStore.enqueue({
          ...cancellationAdmission,
          payloadRef: { kind: "import_parse_job", jobId: "job-2" },
          ownerRef: { capability: "platform.job-workflow", jobId: "job-2" }
        });
        const cancellationClaim: any = secondStore.claim({
          queueDefinitionId: DEFINITION_ID,
          scope: SCOPE,
          workerId: "worker-cancelled",
          leaseTimeoutMs: 10
        }).claimed[0];
        expect(cancellationClaim.workItem.workItemId).toBe(cancellable.workItem.workItemId);
        expect(secondStore.cancel({
          workItemId: cancellable.workItem.workItemId,
          actor: { system: "test-producer" },
          reason: "producer_cancelled"
        })).toMatchObject({ cancelled: true, idempotent: false, workItem: { state: "cancelled" } });
        expect(secondStore.cancel({ workItemId: cancellable.workItem.workItemId }))
          .toMatchObject({ cancelled: true, idempotent: true });
        expect(() : any => secondStore.complete({
          workItemId: cancellable.workItem.workItemId,
          leaseId: cancellationClaim.lease.leaseId
        })).toThrow(/not leased/);
        expect(() : any => secondStore.progress({
          workItemId: cancellable.workItem.workItemId,
          leaseId: cancellationClaim.lease.leaseId,
          extendMs: 10
        })).toThrow(/not leased/);
      } finally {
        secondStore.close();
      }
    } finally {
      firstStore?.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("uses typed canonical dedupe serialization without delimiter collisions", () : any => {
    expect(normalizeQueueDedupeKey(["a,b", "c"]))
      .not.toBe(normalizeQueueDedupeKey(["a", "b,c"]));
    expect(normalizeQueueDedupeKey({ value: "1" }))
      .not.toBe(normalizeQueueDedupeKey({ value: 1 }));
    expect(normalizeQueueDedupeKey({ a: 1, b: [true, null] }))
      .toBe(normalizeQueueDedupeKey({ b: [true, null], a: 1 }));
  });

  it("upgrades a revision-one database with duplicate terminal dedupe rows before adding the global index", () : any => {
    const database: any = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE queue_definitions (
          queue_definition_id TEXT NOT NULL,
          queue_definition_version INTEGER NOT NULL,
          label TEXT NOT NULL UNIQUE,
          lifecycle_state TEXT NOT NULL,
          owner_capability TEXT NOT NULL,
          allow_deprecated_enqueue INTEGER NOT NULL DEFAULT 0,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          policy_json TEXT NOT NULL DEFAULT '{}',
          routes_json TEXT NOT NULL DEFAULT '[]',
          label_history_json TEXT NOT NULL DEFAULT '[]',
          registered_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (queue_definition_id, queue_definition_version)
        );
        CREATE TABLE work_items (
          work_item_id TEXT PRIMARY KEY,
          queue_definition_id TEXT NOT NULL,
          scope_key TEXT NOT NULL,
          dedupe_key TEXT NOT NULL DEFAULT '',
          state TEXT NOT NULL DEFAULT 'completed',
          priority INTEGER NOT NULL DEFAULT 0,
          scope_json TEXT NOT NULL DEFAULT '{}',
          available_at_ms INTEGER NOT NULL DEFAULT 0,
          created_at_ms INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX idx_work_queue_dedupe_nonterminal
          ON work_items(queue_definition_id, scope_key, dedupe_key)
          WHERE dedupe_key <> '' AND work_item_id NOT LIKE 'terminal-%';
        INSERT INTO work_items VALUES
          ('terminal-first', '${DEFINITION_ID}', 'scope', 'same-key', 'completed', 0, '{}', 0, 1),
          ('terminal-second', '${DEFINITION_ID}', 'scope', 'same-key', 'completed', 0, '{}', 0, 2);
        PRAGMA user_version = 1;
      `);

      ensureSqliteWorkQueueSchema(database);

      expect(database.pragma("user_version", { simple: true })).toBe(9);
      expect(database.prepare("SELECT work_item_id, dedupe_key, state FROM work_items ORDER BY created_at_ms").all())
        .toEqual([
          { work_item_id: "terminal-first", dedupe_key: "same-key", state: "completed" },
          { work_item_id: "terminal-second", dedupe_key: "", state: "completed" }
        ]);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_queue_dedupe'").get())
        .toEqual({ name: "idx_work_queue_dedupe" });
    } finally {
      database.close();
    }
  });
});
