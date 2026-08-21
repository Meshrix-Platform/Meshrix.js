import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openSqliteDatabase } from "../../../packages/foundation/src/storage/sqlite-database.ts";
import { createJobProjectionStore } from "../../../packages/server-runtime/src/jobs/jobs/job-projection-store.ts";
import { reconcileJobProjectionArtifacts } from "../../../packages/server-runtime/src/jobs/jobs/job-projection-recovery.ts";
import { persistJobPayload } from "../../../packages/server-runtime/src/jobs/jobs/job-manager-persistence.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXTURE_DAY_START_MS = Math.floor(Date.now() / DAY_MS) * DAY_MS;

async function withTempUserData(testCase?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(
    path.join(os.tmpdir(), "meshrix-job-projection-")
  );
  try {
    return await testCase(userDataPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

function job(index?: any, overrides: Record<string, any> = {}) : any {
  const createdAt: any = new Date(FIXTURE_DAY_START_MS + Number(index || 0) * 1_000).toISOString();
  return {
    id: `job-${String(index).padStart(5, "0")}`,
    status: "completed",
    createdAt,
    updatedAt: createdAt,
    finishedAt: createdAt,
    progressPercent: 100,
    stage: "completed",
    versionGroupId: `group-${index}`,
    versionNumber: 1,
    ...overrides
  };
}

describe("indexed job projection store", () : any => {
  it("uses keyset pages, exact counters, and the created-time index", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const store: any = createJobProjectionStore({ userDataPath });
      try {
        for (let index: any = 0; index < 500; index += 1) {
          store.importJob(job(index));
        }
        const first: any = store.list({ limit: 17 });
        const second: any = store.list({ cursor: first.nextCursor, limit: 17 });
        expect(first.items).toHaveLength(17);
        expect(second.items).toHaveLength(17);
        expect(new Set<any>([
          ...first.items.map((entry?: any) : any => entry.id),
          ...second.items.map((entry?: any) : any => entry.id)
        ]).size).toBe(34);
        expect(first.items[0].id).toBe("job-00499");
        expect(store.getCounts()).toMatchObject({
          totalCount: 500,
          counts: { completed: 500 }
        });
        const plan: any = store.explainList()
          .map((entry?: any) : any => String(entry.detail || "")).join(" ");
        expect(plan).toContain("idx_jobs_created_id");
        for (const overCapacity of [false, true]) {
          const retentionPlan: any = store.explainTerminalRetention({ overCapacity })
            .map((entry?: any) : any => String(entry.detail || "")).join(" ");
          expect(retentionPlan).toContain("idx_jobs_terminal_finished_id");
        }
      } finally {
        store.close();
      }
    });
  });

  it("enforces active capacity and removes expired terminal artifacts in bounded batches", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      let clock: any = Date.UTC(2026, 6, 23);
      const store: any = createJobProjectionStore({
        userDataPath,
        now: () : any => clock,
        policy: {
          maxRecords: 10,
          maxActiveRecords: 2,
          terminalRetentionMs: 1_000,
          cleanupBatch: 2
        }
      });
      try {
        let journalCount: any = 0;
        for (let index: any = 0; index < 3; index += 1) {
          const current: any = job(index, {
            createdAt: new Date(clock - 10_000 - index).toISOString(),
            updatedAt: new Date(clock - 10_000 - index).toISOString(),
            finishedAt: new Date(clock - 10_000 - index).toISOString()
          });
          const directory: any = path.join(userDataPath, "jobs", current.id);
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(path.join(directory, "meta.json"), "{}");
          store.importJob(current);
          const nextJournalCount: any =
            store.listArtifactJournal({ limit: 10 }).length;
          expect(nextJournalCount - journalCount).toBeLessThanOrEqual(2);
          journalCount = nextJournalCount;
        }
        store.create(job(100, {
          status: "queued",
          finishedAt: undefined,
          versionGroupId: "active-100"
        }));
        store.create(job(101, {
          status: "running",
          finishedAt: undefined,
          versionGroupId: "active-101"
        }));
        expect(() : any => store.create(job(102, {
          status: "queued",
          finishedAt: undefined,
          versionGroupId: "active-102"
        }))).toThrow(
          expect.objectContaining({
            code: "job_projection_active_capacity_exceeded"
          })
        );
        await reconcileJobProjectionArtifacts({
          userDataPath,
          projectionStore: store,
          limit: 2
        });
        expect(store.getCounts().activeCount).toBe(2);
      } finally {
        store.close();
      }
    });
  });

  it("reconciles a digest-bound artifact journal without scanning job history", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const store: any = createJobProjectionStore({ userDataPath });
      try {
        const current: any = store.create(job(1, {
          status: "queued",
          finishedAt: undefined
        }));
        const payload: any = JSON.stringify({ value: "journalled" }, null, 2);
        const payloadPath: any = path.join(
          userDataPath,
          "jobs",
          current.id,
          "payload.json"
        );
        await fs.mkdir(path.dirname(payloadPath), { recursive: true });
        await fs.writeFile(payloadPath, payload);
        store.beginArtifact({
          jobId: current.id,
          kind: "payload",
          finalRef: `jobs/${current.id}/payload.json`,
          digest: createHash("sha256").update(payload).digest("hex"),
          byteSize: Buffer.byteLength(payload)
        });

        await reconcileJobProjectionArtifacts({
          userDataPath,
          projectionStore: store
        });
        expect(store.getArtifactInfo(current.id)).toMatchObject({
          payloadBytes: Buffer.byteLength(payload),
          payloadDigest: createHash("sha256").update(payload).digest("hex")
        });
        expect(store.listArtifactJournal()).toEqual([]);
      } finally {
        store.close();
      }
    });
  });

  it("allocates unique monotonic versions across store instances", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const first: any = createJobProjectionStore({ userDataPath });
      const second: any = createJobProjectionStore({ userDataPath });
      try {
        const versions: any = Array.from({ length: 40 }, (_unused?: any, index?: any) : any => {
          const store: any = index % 2 === 0 ? first : second;
          return store.create(job(index, {
            status: "completed",
            versionGroupId: "shared-version-family",
            versionNumber: 1
          })).versionNumber;
        });
        expect(versions).toEqual(
          Array.from({ length: 40 }, (_unused?: any, index?: any) : any => index + 1)
        );
      } finally {
        second.close();
        first.close();
      }
    });
  });

  it("applies access predicates before keyset pagination", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const store: any = createJobProjectionStore({ userDataPath });
      try {
        for (let index: any = 0; index < 20; index += 1) {
          store.importJob(job(index, {
            ownerSubjectId: index % 2 === 0 ? "owner-a" : "owner-b"
          }));
        }
        const first: any = store.list({
          limit: 4,
          access: { principalIds: ["owner-a"] }
        });
        const second: any = store.list({
          cursor: first.nextCursor,
          limit: 4,
          access: { principalIds: ["owner-a"] }
        });
        expect([...first.items, ...second.items]).toHaveLength(8);
        expect([...first.items, ...second.items].every(
          (entry?: any) : any => entry.ownerSubjectId === "owner-a"
        )).toBe(true);
        expect(() : any => store.list({ cursor: "not-a-cursor" })).toThrow(
          expect.objectContaining({ code: "job_projection_cursor_invalid" })
        );
      } finally {
        store.close();
      }
    });
  });

  it("keeps pending deletion bytes charged until physical cleanup", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const store: any = createJobProjectionStore({
        userDataPath,
        policy: { maxArtifactBytes: 64 }
      });
      try {
        const first: any = store.create(job(1, {
          status: "queued",
          finishedAt: undefined
        }));
        await persistJobPayload(
          userDataPath,
          first.id,
          { value: "1234567890" },
          store
        );
        const chargedBytes: any = store.getCounts().artifactBytes;
        expect(chargedBytes).toBeGreaterThan(0);
        store.delete(first.id);
        expect(store.getCounts()).toMatchObject({
          artifactBytes: 0,
          pendingDeleteBytes: chargedBytes
        });

        const second: any = store.create(job(2, {
          status: "queued",
          finishedAt: undefined
        }));
        expect(() : any => store.beginArtifact({
          jobId: second.id,
          kind: "payload",
          finalRef: `jobs/${second.id}/payload.json`,
          digest: "a".repeat(64),
          byteSize: 64
        })).toThrow(
          expect.objectContaining({ code: "job_artifact_capacity_exceeded" })
        );
        await reconcileJobProjectionArtifacts({
          userDataPath,
          projectionStore: store
        });
        expect(store.getCounts().pendingDeleteBytes).toBe(0);
      } finally {
        store.close();
      }
    });
  });

  it("rejects partial projection schemas", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const jobsRoot: any = path.join(userDataPath, "jobs");
      await fs.mkdir(jobsRoot, { recursive: true });
      const databasePath: any = path.join(jobsRoot, "jobs.sqlite");
      const partial: any = openSqliteDatabase(databasePath);
      partial.exec(
        "CREATE TABLE jobs(id TEXT PRIMARY KEY,job_json BLOB NOT NULL)"
      );
      partial.close();
      expect(() : any => createJobProjectionStore({ userDataPath })).toThrow(
        expect.objectContaining({ code: "job_projection_schema_incomplete" })
      );
    });
  });
});
