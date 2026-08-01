import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycleFaults: any = vi.hoisted(() : any => ({
  terminalJobIds: new Set<any>(),
  cleanupSessionIds: new Set<any>(),
  events: [],
  persistTerminalSpy: vi.fn(),
  deleteUploadSessionSpy: vi.fn()
}));

vi.mock(
  "../../../packages/server-runtime/src/jobs/jobs/job-manager-persistence.ts",
  async (importOriginal?: any) : Promise<any> => {
    const actual: any = await importOriginal();
    return {
      ...actual,
      async persistJobTerminal(...args: any[]) : Promise<any> {
        const job: any = args[1] || {};
        lifecycleFaults.events.push(`terminal:${job.id || ""}`);
        lifecycleFaults.persistTerminalSpy(job.id || "");
        if (lifecycleFaults.terminalJobIds.has(job.id)) {
          const error: any = new Error("Injected job terminal commit failure.");
          error.code = "job_terminal_commit_failed";
          throw error;
        }
        return actual.persistJobTerminal(...args);
      }
    };
  }
);

vi.mock(
  "../../../packages/server-runtime/src/state/upload-session-store.ts",
  async (importOriginal?: any) : Promise<any> => {
    const actual: any = await importOriginal();
    return {
      ...actual,
      async deleteUploadSession(userDataPath?: any, sessionId?: any) : Promise<any> {
        lifecycleFaults.events.push(`delete:${sessionId || ""}`);
        lifecycleFaults.deleteUploadSessionSpy(userDataPath, sessionId);
        if (lifecycleFaults.cleanupSessionIds.has(sessionId)) {
          const error: any = new Error("Injected upload-session cleanup failure.");
          error.code = "upload_session_cleanup_failed";
          throw error;
        }
        return actual.deleteUploadSession(userDataPath, sessionId);
      }
    };
  }
);

import {
  hashClientString,
  serverToken
} from "#meshrix/client-strings";
import {
  createStorageKernel
} from "#meshrix/foundation/storage/storage-kernel.ts";
import {
  createStorageProvider
} from "#meshrix/foundation/storage/storage-provider.ts";
import {
  createJobManager
} from "#meshrix/server-runtime/jobs/jobs/job-manager.ts";

const RECEIPT_SCHEMA: any =
  "v0.0.1:storage:upload-consumption-receipt-1";
const RECEIPT_TABLE: any = "storage_upload_consumption_receipts";
const CLEANUP_JOURNAL_TABLE: any = "job_upload_cleanup_journal";
const OWNER: Readonly<Record<string, any>> = Object.freeze({
  subjectId: "receipt-owner-subject",
  userId: "receipt-owner-user",
  tenantId: "receipt-owner-tenant"
});
const OWNER_KEY: any = hashClientString(
  JSON.stringify({
    tenantId: OWNER.tenantId,
    subjectId: OWNER.subjectId,
    userId: OWNER.userId,
    username: ""
  }),
  "upload.session.owner"
);
const tempRoots: any = new Set<any>();
const storageKernels: any = new Set<any>();
const jobManagers: any = new Set<any>();

function sha256(value?: any) : any {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value?: any) : any {
  if (Array.isArray(value)) {
    return `[${value.map((item?: any) : any => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key?: any) : any =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function pathExists(targetPath?: any) : Promise<any> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function waitForPathState(targetPath?: any, expected?: any, timeoutMs: any = 2_000) : Promise<any> {
  const deadline: any = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(targetPath) === expected) return;
    await new Promise((resolve?: any) : any => setTimeout(resolve, 20));
  }
  expect(await pathExists(targetPath)).toBe(expected);
}

async function createStorageHarness(label?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(
    path.join(os.tmpdir(), `meshrix-upload-receipt-${label}-`)
  );
  tempRoots.add(userDataPath);
  const storageKernel: any = createStorageKernel({ userDataPath });
  storageKernels.add(storageKernel);
  return {
    userDataPath,
    storageKernel,
    storageProvider: createStorageProvider({ userDataPath, storageKernel })
  };
}

function reopenStorageHarness(harness?: any) : any {
  harness.storageKernel.close();
  storageKernels.delete(harness.storageKernel);
  const storageKernel: any = createStorageKernel({
    userDataPath: harness.userDataPath
  });
  storageKernels.add(storageKernel);
  return {
    userDataPath: harness.userDataPath,
    storageKernel,
    storageProvider: createStorageProvider({
      userDataPath: harness.userDataPath,
      storageKernel
    })
  };
}

function createManager(userDataPath?: any, storageProvider?: any) : any {
  const manager: any = createJobManager({
    userDataPath,
    processingEnabled: false,
    storageProvider
  });
  jobManagers.add(manager);
  return manager;
}

async function closeManager(manager?: any) : Promise<any> {
  if (!manager) return;
  await manager.close();
  jobManagers.delete(manager);
}

function withJobDatabase(userDataPath?: any, action?: any) : any {
  const database: any = new Database(
    path.join(userDataPath, "jobs", "jobs.sqlite")
  );
  try {
    return action(database);
  } finally {
    database.close();
  }
}

function expectCleanupJournalTable(userDataPath?: any) : any {
  return withJobDatabase(userDataPath, (database?: any) : any => {
    const row: any = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(CLEANUP_JOURNAL_TABLE);
    expect(row).toEqual({ name: CLEANUP_JOURNAL_TABLE });
  });
}

function injectCleanupJournalInsertFailure(userDataPath?: any) : any {
  withJobDatabase(userDataPath, (database?: any) : any => {
    database.exec(`
      CREATE TRIGGER fail_upload_cleanup_journal_insert
      BEFORE INSERT ON ${CLEANUP_JOURNAL_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'injected upload cleanup journal failure');
      END;
    `);
  });
}

function removeCleanupJournalInsertFailure(userDataPath?: any) : any {
  withJobDatabase(userDataPath, (database?: any) : any => {
    database.exec("DROP TRIGGER fail_upload_cleanup_journal_insert");
  });
}

function readCleanupJournal(userDataPath?: any, sessionId?: any) : any {
  return withJobDatabase(userDataPath, (database?: any) : any =>
    database.prepare(`
      SELECT job_id AS jobId, receipt_id AS receiptId,
             session_id AS sessionId, state
      FROM ${CLEANUP_JOURNAL_TABLE}
      WHERE session_id = ?
      LIMIT 1
    `).get(sessionId) || null
  );
}

async function prepareStaging(
  userDataPath?: any,
  label?: any,
  contents: any = ["first private upload", "second private upload"]
) : Promise<any> {
  const sessionId: any = serverToken("upload_session", label);
  const sessionRoot: any = path.join(
    userDataPath,
    "upload-sessions",
    sessionId
  );
  await fs.mkdir(sessionRoot, { recursive: true });
  const objects: any[] = [];
  const orderedReceiptObjects: any[] = [];
  const stagedPaths: any[] = [];

  for (const [index, content] of contents.entries()) {
    const bytes: any = Buffer.from(content);
    const sourcePath: any = path.join(sessionRoot, `${index}.part`);
    const digest: any = sha256(bytes);
    const objectId: any = serverToken(
      "storage_object",
      sessionId,
      index,
      digest,
      bytes.length
    );
    await fs.writeFile(sourcePath, bytes);
    stagedPaths.push(sourcePath);
    objects.push({
      objectId,
      sourcePath,
      namespace: "job-uploads",
      fileName: `opaque-${index}.bin`,
      mediaType: "application/octet-stream",
      expectedSha256: digest,
      expectedByteSize: bytes.length,
      metadata: {
        artifactKind: "job-upload-source",
        sourceIndex: index,
        privateMarker: content,
        ownerSubjectId: OWNER.subjectId,
        ownerUserId: OWNER.userId
      }
    });
    orderedReceiptObjects.push({
      objectId,
      sha256: digest,
      byteSize: bytes.length
    });
  }

  return {
    sessionId,
    sessionRoot,
    stagedPaths,
    objects,
    orderedReceiptObjects,
    contents
  };
}

function receiptInput(staging?: any, overrides: Record<string, any> = {}) : any {
  return {
    sessionId: staging.sessionId,
    owner: OWNER,
    objects: staging.objects,
    ...overrides
  };
}

async function commitReceipt(storageProvider?: any, input?: any) : Promise<any> {
  expect(storageProvider.commitUploadConsumptionReceipt)
    .toEqual(expect.any(Function));
  return storageProvider.commitUploadConsumptionReceipt(input);
}

function expectReceipt(receipt?: any, staging?: any) : any {
  const receiptDigest: any = sha256(canonicalJson({
    schemaVersion: RECEIPT_SCHEMA,
    sessionId: staging.sessionId,
    ownerKey: OWNER_KEY,
    objects: staging.orderedReceiptObjects
  }));
  expect(receipt).toEqual({
    schemaVersion: RECEIPT_SCHEMA,
    receiptId: expect.stringMatching(
      /^upload_consumption_receipt_[a-f0-9]{32}$/u
    ),
    sessionId: staging.sessionId,
    ownerKey: OWNER_KEY,
    objects: staging.orderedReceiptObjects,
    receiptDigest
  });
  expect(Object.keys(receipt).sort()).toEqual([
    "objects",
    "ownerKey",
    "receiptDigest",
    "receiptId",
    "schemaVersion",
    "sessionId"
  ]);
  const serialized: any = JSON.stringify(receipt);
  for (const stagedPath of staging.stagedPaths) {
    expect(serialized).not.toContain(stagedPath);
  }
  for (const content of staging.contents) {
    expect(serialized).not.toContain(content);
  }
  expect(serialized).not.toContain(OWNER.subjectId);
  expect(serialized).not.toContain(OWNER.userId);
  expect(serialized).not.toContain(OWNER.tenantId);
}

async function createJob(manager?: any, staging?: any, label?: any) : Promise<any> {
  return manager.createJob({
    checkpointId: `upload-receipt-${label}`,
    checkpointReceipt: {
      checkpointId: `upload-receipt-${label}`
    },
    uploadSessionId: staging.sessionId,
    ownerSubjectId: OWNER.subjectId,
    ownerUserId: OWNER.userId,
    ownerTenantId: OWNER.tenantId
  });
}

beforeEach(() : any => {
  lifecycleFaults.terminalJobIds.clear();
  lifecycleFaults.cleanupSessionIds.clear();
  lifecycleFaults.events.length = 0;
  lifecycleFaults.persistTerminalSpy.mockClear();
  lifecycleFaults.deleteUploadSessionSpy.mockClear();
});

afterEach(async () : Promise<any> => {
  await Promise.allSettled(
    [...jobManagers].map((manager?: any) : any => manager.close())
  );
  jobManagers.clear();
  for (const storageKernel of storageKernels) {
    storageKernel.close();
  }
  storageKernels.clear();
  await Promise.all(
    [...tempRoots].map((root?: any) : any =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
  tempRoots.clear();
});

describe("durable upload-consumption receipt", () : any => {
  it("commits the exact ordered receipt with canonical metadata and rejects changed replay", async () : Promise<any> => {
    let harness: any = await createStorageHarness("exact");
    const staging: any = await prepareStaging(
      harness.userDataPath,
      "exact-replay"
    );

    const first: any = await commitReceipt(
      harness.storageProvider,
      receiptInput(staging)
    );

    expectReceipt(first, staging);
    expect(harness.storageKernel.getStorageSummary()).toMatchObject({
      objectCount: 2,
      ownedObjectCount: 2
    });
    for (const expected of staging.orderedReceiptObjects) {
      expect(harness.storageProvider.getObject(expected.objectId))
        .toMatchObject(expected);
    }

    const replay: any = await commitReceipt(
      harness.storageProvider,
      receiptInput(staging)
    );
    expect(replay).toEqual(first);
    expect(harness.storageKernel.getStorageSummary().objectCount).toBe(2);

    harness = reopenStorageHarness(harness);
    const restartedReplay: any = await commitReceipt(
      harness.storageProvider,
      receiptInput(staging)
    );
    expect(restartedReplay).toEqual(first);

    const changedObjectId: any = serverToken(
      "storage_object",
      staging.sessionId,
      "changed"
    );
    const conflictCases: any[] = [
      {
        owner: {
          ...OWNER,
          subjectId: "another-owner-subject",
          userId: "another-owner-user"
        }
      },
      {
        objects: [
          {
            ...staging.objects[0],
            objectId: changedObjectId
          },
          staging.objects[1]
        ]
      },
      {
        objects: [
          {
            ...staging.objects[0],
            expectedSha256: "f".repeat(64)
          },
          staging.objects[1]
        ]
      },
      {
        objects: [
          {
            ...staging.objects[0],
            expectedByteSize: staging.objects[0].expectedByteSize + 1
          },
          staging.objects[1]
        ]
      },
      {
        objects: [...staging.objects].reverse()
      },
      {
        objects: staging.objects.slice(0, 1)
      },
      {
        objects: [
          ...staging.objects,
          {
            ...staging.objects[0],
            objectId: serverToken(
              "storage_object",
              staging.sessionId,
              "added"
            )
          }
        ]
      }
    ];

    for (const overrides of conflictCases) {
      await expect(
        commitReceipt(
          harness.storageProvider,
          receiptInput(staging, overrides)
        )
      ).rejects.toMatchObject({
        code: "upload_consumption_receipt_conflict"
      });
      expect(harness.storageKernel.getStorageSummary().objectCount).toBe(2);
    }
    expect(harness.storageProvider.getObject(changedObjectId)).toBeNull();
  });

  it("retains staging when either the receipt or terminal commit fails", async () : Promise<any> => {
    const harness: any = await createStorageHarness("failure");
    const receiptFailure: any = await prepareStaging(
      harness.userDataPath,
      "receipt-failure",
      ["receipt transaction private bytes"]
    );

    expect(harness.storageProvider.commitUploadConsumptionReceipt)
      .toEqual(expect.any(Function));
    expect(
      harness.storageKernel.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      ).get(RECEIPT_TABLE)
    ).toMatchObject({ name: RECEIPT_TABLE });
    harness.storageKernel.db.exec(`
      CREATE TRIGGER fail_upload_consumption_receipt_insert
      BEFORE INSERT ON ${RECEIPT_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'injected upload consumption receipt failure');
      END;
      CREATE TRIGGER reject_storage_object_compensation_delete
      BEFORE DELETE ON storage_objects
      BEGIN
        SELECT RAISE(ABORT, 'storage object compensation is not atomic');
      END;
    `);

    await expect(
      commitReceipt(
        harness.storageProvider,
        receiptInput(receiptFailure)
      )
    ).rejects.toMatchObject({
      code: "upload_consumption_receipt_commit_failed"
    });
    expect(harness.storageKernel.getStorageSummary().objectCount).toBe(0);
    expect(
      harness.storageKernel.db.prepare(
        `SELECT COUNT(*) AS count FROM ${RECEIPT_TABLE}`
      ).get()
    ).toEqual({ count: 0 });
    for (const object of receiptFailure.objects) {
      expect(harness.storageProvider.getObject(object.objectId)).toBeNull();
    }
    await expect(fs.stat(receiptFailure.sessionRoot)).resolves.toBeTruthy();
    await expect(fs.stat(receiptFailure.stagedPaths[0])).resolves.toBeTruthy();

    harness.storageKernel.db.exec(`
      DROP TRIGGER fail_upload_consumption_receipt_insert;
      DROP TRIGGER reject_storage_object_compensation_delete;
    `);
    const terminalFailure: any = await prepareStaging(
      harness.userDataPath,
      "terminal-failure",
      ["terminal transaction private bytes"]
    );
    const receipt: any = await commitReceipt(
      harness.storageProvider,
      receiptInput(terminalFailure)
    );
    const manager: any = createManager(
      harness.userDataPath,
      harness.storageProvider
    );
    const job: any = await createJob(manager, terminalFailure, "terminal-failure");
    expect(manager.commitTerminalThenScheduleUploadCleanup)
      .toEqual(expect.any(Function));
    lifecycleFaults.terminalJobIds.add(job.id);

    await expect(
      manager.commitTerminalThenScheduleUploadCleanup({
        jobId: job.id,
        receiptId: receipt.receiptId,
        sessionId: terminalFailure.sessionId
      })
    ).rejects.toMatchObject({
      code: "job_terminal_commit_failed"
    });
    expect(lifecycleFaults.persistTerminalSpy).toHaveBeenCalledWith(job.id);
    expect(
      lifecycleFaults.deleteUploadSessionSpy.mock.calls.some(
        ([, sessionId]: any[]) : any => sessionId === terminalFailure.sessionId
      )
    ).toBe(false);
    await expect(fs.stat(terminalFailure.sessionRoot)).resolves.toBeTruthy();
    await expect(manager.getJob(job.id)).resolves.not.toMatchObject({
      status: "completed"
    });

    lifecycleFaults.terminalJobIds.delete(job.id);
    await closeManager(manager);
    const restarted: any = createManager(
      harness.userDataPath,
      harness.storageProvider
    );
    await restarted.getJob(job.id);
    expect(
      lifecycleFaults.deleteUploadSessionSpy.mock.calls.some(
        ([, sessionId]: any[]) : any => sessionId === terminalFailure.sessionId
      )
    ).toBe(false);
    await expect(fs.stat(terminalFailure.sessionRoot)).resolves.toBeTruthy();
  });

  it("journals after terminal commit and restart replays only safe cleanup", async () : Promise<any> => {
    const harness: any = await createStorageHarness("restart");
    const safe: any = await prepareStaging(
      harness.userDataPath,
      "safe-cleanup",
      ["safe cleanup private bytes"]
    );
    const receiptOnly: any = await prepareStaging(
      harness.userDataPath,
      "receipt-only",
      ["receipt-only private bytes"]
    );
    const uncommitted: any = await prepareStaging(
      harness.userDataPath,
      "uncommitted",
      ["retryable private bytes"]
    );
    const safeReceipt: any = await commitReceipt(
      harness.storageProvider,
      receiptInput(safe)
    );
    await commitReceipt(
      harness.storageProvider,
      receiptInput(receiptOnly)
    );

    const manager: any = createManager(
      harness.userDataPath,
      harness.storageProvider
    );
    const safeJob: any = await createJob(manager, safe, "safe-cleanup");
    await createJob(manager, receiptOnly, "receipt-only");
    expect(manager.commitTerminalThenScheduleUploadCleanup)
      .toEqual(expect.any(Function));
    expectCleanupJournalTable(harness.userDataPath);
    injectCleanupJournalInsertFailure(harness.userDataPath);

    await expect(
      manager.commitTerminalThenScheduleUploadCleanup({
        jobId: safeJob.id,
        receiptId: safeReceipt.receiptId,
        sessionId: safe.sessionId
      })
    ).rejects.toMatchObject({
      code: "upload_cleanup_journal_commit_failed"
    });
    expect(
      lifecycleFaults.deleteUploadSessionSpy.mock.calls.some(
        ([, sessionId]: any[]) : any => sessionId === safe.sessionId
      )
    ).toBe(false);
    expect(readCleanupJournal(harness.userDataPath, safe.sessionId)).toBeNull();
    await expect(fs.stat(safe.sessionRoot)).resolves.toBeTruthy();

    const committedBeforeJournal: any = await manager.getJob(safeJob.id);
    const resultBeforeJournal: any = await manager.getJobResult(safeJob.id);
    expect(committedBeforeJournal).toMatchObject({
      status: "completed",
      uploadConsumptionReceiptId: safeReceipt.receiptId
    });
    expect(resultBeforeJournal).toMatchObject({
      uploadConsumptionReceiptId: safeReceipt.receiptId
    });

    removeCleanupJournalInsertFailure(harness.userDataPath);
    lifecycleFaults.cleanupSessionIds.add(safe.sessionId);

    await expect(
      manager.commitTerminalThenScheduleUploadCleanup({
        jobId: safeJob.id,
        receiptId: safeReceipt.receiptId,
        sessionId: safe.sessionId
      })
    ).resolves.toMatchObject({
      status: "completed",
      uploadConsumptionReceiptId: safeReceipt.receiptId
    });

    const terminal: any = await manager.getJob(safeJob.id);
    const result: any = await manager.getJobResult(safeJob.id);
    expect(terminal).toMatchObject({
      status: "completed",
      uploadConsumptionReceiptId: safeReceipt.receiptId
    });
    expect(result).toMatchObject({
      uploadConsumptionReceiptId: safeReceipt.receiptId
    });
    const serializedResult: any = JSON.stringify(result);
    expect(serializedResult).not.toContain(safe.sessionRoot);
    expect(serializedResult).not.toContain(safe.contents[0]);
    const terminalEventIndex: any = lifecycleFaults.events.indexOf(
      `terminal:${safeJob.id}`
    );
    const firstDeleteEventIndex: any = lifecycleFaults.events.indexOf(
      `delete:${safe.sessionId}`
    );
    expect(terminalEventIndex).toBeGreaterThanOrEqual(0);
    expect(firstDeleteEventIndex).toBeGreaterThan(terminalEventIndex);
    expect(readCleanupJournal(harness.userDataPath, safe.sessionId))
      .toEqual({
        jobId: safeJob.id,
        receiptId: safeReceipt.receiptId,
        sessionId: safe.sessionId,
        state: "pending"
      });
    await expect(fs.stat(safe.sessionRoot)).resolves.toBeTruthy();

    await closeManager(manager);
    lifecycleFaults.cleanupSessionIds.delete(safe.sessionId);
    const restarted: any = createManager(
      harness.userDataPath,
      harness.storageProvider
    );
    await restarted.getJob(safeJob.id);
    await waitForPathState(safe.sessionRoot, false);
    expect(readCleanupJournal(harness.userDataPath, safe.sessionId)).toBeNull();

    await expect(fs.stat(receiptOnly.sessionRoot)).resolves.toBeTruthy();
    await expect(fs.stat(uncommitted.sessionRoot)).resolves.toBeTruthy();
    expect(
      readCleanupJournal(harness.userDataPath, receiptOnly.sessionId)
    ).toBeNull();
    expect(
      readCleanupJournal(harness.userDataPath, uncommitted.sessionId)
    ).toBeNull();
    const deletedSessionIds: any =
      lifecycleFaults.deleteUploadSessionSpy.mock.calls.map(
        ([, sessionId]: any[]) : any => sessionId
      );
    expect(
      deletedSessionIds.filter((sessionId?: any) : any => sessionId === safe.sessionId)
    ).toHaveLength(2);
    expect(deletedSessionIds).not.toContain(receiptOnly.sessionId);
    expect(deletedSessionIds).not.toContain(uncommitted.sessionId);

    const retryReceipt: any = await commitReceipt(
      harness.storageProvider,
      receiptInput(uncommitted)
    );
    expectReceipt(retryReceipt, uncommitted);
    await expect(fs.stat(uncommitted.sessionRoot)).resolves.toBeTruthy();

    await closeManager(restarted);
    const safeDeleteCallsBeforeSecondRestart: any =
      lifecycleFaults.deleteUploadSessionSpy.mock.calls.filter(
        ([, sessionId]: any[]) : any => sessionId === safe.sessionId
      ).length;
    const secondRestart: any = createManager(
      harness.userDataPath,
      harness.storageProvider
    );
    await secondRestart.getJob(safeJob.id);
    expect(
      lifecycleFaults.deleteUploadSessionSpy.mock.calls.filter(
        ([, sessionId]: any[]) : any => sessionId === safe.sessionId
      )
    ).toHaveLength(safeDeleteCallsBeforeSecondRestart);
  });
});
