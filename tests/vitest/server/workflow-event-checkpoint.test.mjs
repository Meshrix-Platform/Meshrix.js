import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startCheckpointTreeMock = vi.hoisted(() => vi.fn(async () => undefined));
const upsertCheckpointNodeMock = vi.hoisted(() => vi.fn(async () => undefined));
const finishCheckpointTreeMock = vi.hoisted(() => vi.fn(async () => undefined));
const deleteCheckpointTreeMock = vi.hoisted(() => vi.fn(async () => undefined));
const checkpointTreeIdMock = vi.hoisted(() => vi.fn((kind, ...parts) => {
  const suffix = parts.filter(Boolean).join("_") || "root";
  return `checkpoint_tree_${kind}_${suffix}`;
}));

vi.mock("#lico/foundation/checkpoint/tree/checkpoint-tree-projection", () => ({
  checkpointTreeId: checkpointTreeIdMock,
  deleteCheckpointTree: deleteCheckpointTreeMock,
  finishCheckpointTree: finishCheckpointTreeMock,
  startCheckpointTree: startCheckpointTreeMock,
  upsertCheckpointNode: upsertCheckpointNodeMock
}));

import { createProtocolEventBus } from "../../../packages/protocols/pubsub/event-bus.mjs";
import { createSqliteProtocolEventStore } from "../../../packages/server-runtime/src/events/sqlite-protocol-event-store.mjs";
import {
  appendUploadSessionChunk,
  createOrResumeUploadSession
} from "../../../packages/server-runtime/src/state/upload-session-store.mjs";
import {
  createDurableWorkflowSubstrate,
  workflowId
} from "../../../packages/foundation/src/workflow/durable-workflow-substrate.mjs";
import {
  dispatchInternalOperation,
  dispatchOperation
} from "#lico/server-runtime/composition/dispatch-operation";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

const OWNER_A = {
  subjectId: "workflow-owner-a",
  userId: "workflow-owner-a",
  username: "workflow-a",
  tenantId: "tenant-a"
};

async function withTempUserData(testCase, prefix = "lico-workflow-event-checkpoint-more-extra-") {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await testCase(userDataPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

function createLogger() {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function createAuditStore() {
  return {
    append: vi.fn(async (entry) => entry)
  };
}

beforeEach(() => {
  startCheckpointTreeMock.mockClear();
  upsertCheckpointNodeMock.mockClear();
  finishCheckpointTreeMock.mockClear();
  deleteCheckpointTreeMock.mockClear();
  checkpointTreeIdMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workflow-event-checkpoint behavior", () => {
  it("handles publish failures and aborted event subscriptions", async () => {
    await withTempUserData(async (userDataPath) => {
      const logger = createLogger();
      const durableStore = createSqliteProtocolEventStore({ userDataPath });
      let failNextPublish = true;
      const eventStore = {
        publish(...args) {
          if (failNextPublish) {
            failNextPublish = false;
            return Promise.reject(new Error("store write failed"));
          }
          return durableStore.publish(...args);
        },
        read: (...args) => durableStore.read(...args),
        getLatest: (...args) => durableStore.getLatest(...args),
        getRevision: (...args) => durableStore.getRevision(...args),
        getStats: (...args) => durableStore.getStats(...args)
      };
      const bus = createProtocolEventBus({ eventStore, logger });

      await expect(bus.publish("", { nope: true })).rejects.toThrow("发布事件缺少 topic。");
      await expect(bus.publish("alpha", { round: 1 })).rejects.toThrow("store write failed");

      const event = await bus.publish("alpha", { round: 2 }, { retain: false });
      expect(event).toMatchObject({
        topic: "alpha",
        offset: 1,
        payload: { round: 2 }
      });
      expect(logger.error).toHaveBeenCalledWith(
        "event.publish.failed",
        expect.objectContaining({ topic: "alpha" })
      );

      await withTempUserData(async (emptyUserDataPath) => {
        const emptyStore = createSqliteProtocolEventStore({
          userDataPath: emptyUserDataPath
        });
        const emptyBus = createProtocolEventBus({
          eventStore: emptyStore,
          logger
        });
        const controller = new AbortController();
        controller.abort();
        const aborted = await emptyBus.subscribe({
          cursor: 0,
          topics: ["alpha"],
          timeoutMs: 5000,
          signal: controller.signal
        });

        expect(aborted.events).toEqual([]);
        expect(aborted.nextCursor).toBe(0);
        await emptyBus.close();
        emptyStore.close();
      });
      await bus.close();
      durableStore.close();
    });
  });

  it("resumes upload sessions, rejects archive conflicts and surfaces offset and sha mismatches", async () => {
    await withTempUserData(async (userDataPath) => {
      const created = await createOrResumeUploadSession({
        userDataPath,
        checkpoint: {
          checkpointId: "checkpoint-empty",
          archiveBatchId: "archive-a",
          clientUid: "client-a",
          sourceType: "mail"
        },
        manifest: {
          manifestDigest: sha256("manifest-empty"),
          inputDigest: sha256("input-empty")
        },
        owner: OWNER_A,
        files: []
      });

      expect(created).toMatchObject({
        status: "complete",
        files: []
      });
      expect(finishCheckpointTreeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userDataPath,
          status: "completed"
        })
      );

      const resumed = await createOrResumeUploadSession({
        userDataPath,
        checkpoint: {
          checkpointId: "checkpoint-empty",
          archiveBatchId: "archive-a"
        },
        manifest: {
          manifestDigest: sha256("manifest-empty"),
          inputDigest: sha256("input-empty")
        },
        owner: OWNER_A
      });

      expect(resumed.sessionId).toBe(created.sessionId);
      expect(resumed.status).toBe("complete");
      expect(upsertCheckpointNodeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userDataPath,
          status: "completed"
        })
      );

      await expect(createOrResumeUploadSession({
        userDataPath,
        checkpoint: {
          checkpointId: "checkpoint-empty",
          archiveBatchId: "archive-b"
        },
        manifest: {
          manifestDigest: sha256("manifest-empty"),
          inputDigest: sha256("input-empty")
        },
        owner: OWNER_A
      })).rejects.toThrow("同一 checkpoint 的归档批次不一致，拒绝覆盖。");

      const chunkSession = await createOrResumeUploadSession({
        userDataPath,
        checkpoint: {
          checkpointId: "checkpoint-chunk",
          archiveBatchId: "archive-chunk"
        },
        manifest: {
          manifestDigest: sha256("manifest-chunk"),
          inputDigest: sha256("input-chunk")
        },
        owner: OWNER_A,
        files: [
          {
            relativePath: "folder/note.txt",
            sha256: sha256("good"),
            byteSize: 4
          }
        ]
      });

      const offsetMismatch = await appendUploadSessionChunk({
        userDataPath,
        sessionId: chunkSession.sessionId,
        fileIndex: 0,
        offset: 1,
        buffer: Buffer.from("good"),
        owner: OWNER_A
      });
      expect(offsetMismatch).toMatchObject({
        ok: false,
        code: "offset_mismatch",
        expectedOffset: 0
      });

      const shaMismatch = await appendUploadSessionChunk({
        userDataPath,
        sessionId: chunkSession.sessionId,
        fileIndex: 0,
        offset: 0,
        buffer: Buffer.from("bad!"),
        owner: OWNER_A
      });
      expect(shaMismatch).toMatchObject({
        ok: false,
        code: "sha256_mismatch",
        expectedOffset: 0
      });
      expect(shaMismatch.session).toMatchObject({
        sessionId: chunkSession.sessionId,
        status: "uploading",
        files: [
          {
            receivedBytes: 0,
            completed: false
          }
        ]
      });
    });
  });

  it("preserves terminal workflow status and blocks completion when state is still open", async () => {
    await withTempUserData(async (userDataPath) => {
      const runtime = createDurableWorkflowSubstrate({ userDataPath });
      const canceledId = workflowId("workflow", "terminal-boundary");

      const canceled = await runtime.startWorkflow({
        workflowId: canceledId,
        workflowType: "boundary",
        ownerId: "owner-a",
        ownerKind: "boundary",
        status: "canceled",
        input: { kind: "terminal" }
      });
      expect(canceled.status).toBe("canceled");

      const scheduled = await runtime.scheduleActivity(canceledId, {
        activityId: "activity-boundary",
        activityType: "probe",
        idempotencyKey: "boundary-activity",
        input: { probe: true }
      });
      expect(scheduled.workflow.status).toBe("canceled");

      const runningId = workflowId("workflow", "recover-boundary");
      await runtime.startWorkflow({
        workflowId: runningId,
        workflowType: "boundary",
        ownerId: "owner-a",
        ownerKind: "boundary",
        input: { kind: "running" }
      });

      const openWorkflow = await runtime.scheduleActivity(runningId, {
        activityId: "human-review-activity",
        activityType: "review",
        idempotencyKey: "review-activity",
        input: { review: true }
      });
      expect(openWorkflow.workflow.status).toBe("running");

      await runtime.requestHumanReview(runningId, {
        reviewId: "review-1",
        reviewType: "boundary_review",
        reasons: ["needs approval"]
      });
      await expect(runtime.completeWorkflow(runningId, { done: true })).rejects.toThrow(
        "Workflow has unresolved human reviews."
      );

      const externalId = workflowId("workflow", "external-boundary");
      await runtime.startWorkflow({
        workflowId: externalId,
        workflowType: "boundary",
        ownerId: "owner-a",
        ownerKind: "boundary",
        input: { kind: "external" }
      });
      await runtime.beginExternalWrite(externalId, {
        writeId: "write-1",
        providerId: "provider-a",
        targetRef: "collection://boundary",
        input: { affected: [1] }
      });
      await expect(runtime.completeWorkflow(externalId, { done: true })).rejects.toThrow(
        "Workflow has unresolved external partial writes."
      );

      const recovered = await runtime.recoverWorkflows({ ownerKind: "boundary" });
      expect(recovered.count).toBe(2);
      expect(recovered.recovered.map((item) => item.workflowId)).toEqual(
        expect.arrayContaining([runningId, externalId])
      );
      expect(recovered.recovered.some((item) => item.workflowId === canceledId)).toBe(false);
    });
  });

  it("rejects missing dispatcher registrations, records metadata and rethrows handler failures", async () => {
    const response = {
      statusCode: 200,
      headers: {},
      chunks: [],
      writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = { ...this.headers, ...headers };
      },
      write(chunk) {
        if (chunk !== undefined && chunk !== null) {
          this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
      },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) {
          this.write(chunk);
        }
        this.ended = true;
      }
    };

    await expect(dispatchInternalOperation({
      operationId: "unit.dispatch.missing",
      operations: []
    })).rejects.toThrow("Internal operation not registered: unit.dispatch.missing");

    const auditStore = createAuditStore();
    const logger = createLogger();
    const operation = {
      id: "unit.dispatch.metadata",
      target: { controller: "unit", method: "handle" },
      http: {
        method: "POST",
        path: "/api/unit/dispatch-metadata",
        query: [{ name: "mode" }],
        coerce: { count: "number", confirm: "boolean" }
      },
      requiredScopes: ["console:read"],
      readOnly: true,
      concurrencySafe: true,
      safety: { risk: "read_only" },
        inputSchema: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            count: { type: "number" },
            confirm: { type: "boolean" }
          }
        },
      audit: {
        enabled: true,
        recordInput: false,
        recordOutput: true,
        redaction: "default"
      },
      log: {
        enabled: true,
        recordInput: false,
        redaction: "default"
      }
    };

    const request = {
      headers: {},
      __licoRequestId: "request-metadata-1"
    };

    const handler = vi.fn(({ response: res, mode, count, confirm }) => {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        mode,
        count,
        confirm
      }));
    });

    const result = await dispatchOperation({
      operation,
      controllers: {
        unit: {
          handle: handler
        }
      },
      request,
      response,
      url: new URL("http://127.0.0.1/api/unit/dispatch-metadata?mode=fast&count=7&confirm=true"),
      params: {
        count: "7",
        confirm: "true"
      },
      requestBody: Buffer.from(JSON.stringify({ name: "alpha" }), "utf8"),
      authorizeOperation: vi.fn().mockResolvedValue({
        ok: true,
        session: { user: { scopes: ["console:read"] } }
      }),
      operationAuditStore: auditStore,
      logger
    });

    expect(result.statusCode).toBe(201);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
      mode: "fast",
      count: 7,
      confirm: true
    }));
    expect(auditStore.append).toHaveBeenCalledWith(expect.objectContaining({
      status: "ok",
      input: {}
    }));

    const failingAuditStore = createAuditStore();
    const failingResponse = {
      ...response,
      statusCode: 200,
      headers: {},
      chunks: [],
      ended: false
    };

    await expect(dispatchOperation({
      operation: {
        ...operation,
        id: "unit.dispatch.failure"
      },
      controllers: {
        unit: {
          handle: vi.fn(() => {
            throw new Error("handler boom");
          })
        }
      },
      request: {
        headers: {},
        __licoRequestId: "request-metadata-2"
      },
      response: failingResponse,
      url: new URL("http://127.0.0.1/api/unit/dispatch-metadata?mode=slow"),
      params: {
        count: "1",
        confirm: "false"
      },
      requestBody: Buffer.from(JSON.stringify({ name: "beta" }), "utf8"),
      authorizeOperation: vi.fn().mockResolvedValue({
        ok: true,
        session: { user: { scopes: ["console:read"] } }
      }),
      operationAuditStore: failingAuditStore,
      logger
    })).rejects.toThrow("handler boom");

    expect(failingAuditStore.append).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      input: {},
      error: "handler boom"
    }));
  });
});
