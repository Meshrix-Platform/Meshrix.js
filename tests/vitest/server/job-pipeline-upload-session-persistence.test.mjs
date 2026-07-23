import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const checkpointMocks = vi.hoisted(() => ({
  checkpointTreeId: vi.fn((kind, ...parts) => `checkpoint_tree_${kind}_${parts.filter(Boolean).join("_")}`),
  deleteCheckpointTree: vi.fn(async () => undefined),
  finishCheckpointTree: vi.fn(async () => undefined),
  startCheckpointTree: vi.fn(async () => undefined),
  upsertCheckpointNode: vi.fn(async () => undefined)
}));

vi.mock("#lico/foundation/checkpoint/tree/checkpoint-tree-projection", () => checkpointMocks);
vi.mock("#lico/product-api", async (importOriginal) => ({
  ...(await importOriginal()),
  saveSettings: vi.fn(async (_userDataPath, settings = {}) => settings || {})
}));

import { createStorageKernel } from "#lico/foundation/storage/storage-kernel.mjs";
import { createStorageProvider } from "#lico/foundation/storage/storage-provider.mjs";
import { createJobArtifactHandlers } from "#lico/protocols/http/controllers/jobs-controller-artifact-handlers.mjs";
import { createBatchDeletionCoordinator } from "#lico/server-runtime/jobs/batch-deletion-coordinator.mjs";
import { createJobPipeline } from "#lico/server-runtime/jobs/job-pipeline.mjs";
import {
  appendUploadSessionChunk,
  createOrResumeUploadSession,
  resolveUploadSessionFiles
} from "#lico/server-runtime/state/upload-session-store.mjs";

const tempRoots = [];
const storageKernels = [];
const OWNER = Object.freeze({
  subjectId: "owner-upload-pipeline",
  userId: "owner-upload-pipeline",
  username: "upload-owner"
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createBufferedResponse() {
  const chunks = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  response.statusCode = 0;
  response.headers = {};
  response.writeHead = (statusCode, headers) => {
    response.statusCode = statusCode;
    response.headers = headers;
  };
  Object.defineProperty(response, "body", {
    get: () => Buffer.concat(chunks)
  });
  response.json = () => JSON.parse(response.body.toString("utf8"));
  return response;
}

async function createCompleteUploadSession(userDataPath, bytes) {
  const created = await createOrResumeUploadSession({
    userDataPath,
    checkpoint: {
      checkpointId: "pipeline-upload-checkpoint",
      archiveBatchId: "pipeline-upload-batch",
      clientUid: "pipeline-client",
      sourceType: "upload"
    },
    manifest: {
      manifestDigest: sha256("pipeline-manifest"),
      inputDigest: sha256("pipeline-input")
    },
    owner: OWNER,
    files: [{
      relativePath: "source.bin",
      sha256: sha256(bytes),
      byteSize: bytes.length,
      mediaType: "application/octet-stream"
    }]
  });
  if (bytes.length > 0) {
    await appendUploadSessionChunk({
      userDataPath,
      sessionId: created.sessionId,
      fileIndex: 0,
      offset: 0,
      buffer: bytes,
      owner: OWNER
    });
  }
  const [resolved] = await resolveUploadSessionFiles(userDataPath, created.sessionId, {
    owner: OWNER
  });
  return { created, resolved };
}

async function createHarness() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-job-pipeline-upload-"));
  tempRoots.push(userDataPath);
  const storageKernel = createStorageKernel({ userDataPath });
  storageKernels.push(storageKernel);
  return {
    userDataPath,
    storageKernel,
    storageProvider: createStorageProvider({ userDataPath, storageKernel })
  };
}

function pipelineFor({ userDataPath, storageProvider, uploadSessionId }) {
  return createJobPipeline({
    userDataPath,
    payload: {
      uploadSessionId,
      archiveBatchId: "pipeline-upload-batch",
      ownerSubjectId: OWNER.subjectId,
      ownerUserId: OWNER.userId,
      ownerUsername: OWNER.username,
      settings: {}
    },
    runtime: {},
    storageProvider,
    reportProgress: vi.fn(),
    jobId: "pipeline-upload-job",
    generatedAt: "2026-07-11T00:00:00.000Z"
  });
}

afterEach(async () => {
  for (const kernel of storageKernels.splice(0)) {
    kernel.close();
  }
  await Promise.all(tempRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

describe("job pipeline upload-session persistence", () => {
  it("persists an uploadSessionId-only source before issuing a cleanup-ready result", async () => {
    const { userDataPath, storageKernel, storageProvider } = await createHarness();
    const bytes = Buffer.from("canonical uploaded bytes");
    const { created, resolved } = await createCompleteUploadSession(userDataPath, bytes);
    const pipeline = pipelineFor({
      userDataPath,
      storageProvider,
      uploadSessionId: created.sessionId
    });

    const result = await pipeline.run(pipeline.createContext());

    expect(result).toMatchObject({
      accepted: true,
      gateway: {
        sourceCount: 1,
        uploadSessionFileCount: 1
      },
      uploadSessionConsumption: {
        status: "persisted",
        complete: true,
        expectedFileCount: 1,
        persistedFileCount: 1
      },
      sourceFiles: [{
        kind: "stored-object",
        rawObjectId: expect.any(String),
        storageRelativePath: expect.stringMatching(/^objects\//u),
        rawObjectSha256: sha256(bytes),
        rawObjectByteSize: bytes.length
      }]
    });
    expect(storageKernel.getStorageSummary().objectCount).toBe(1);
    await expect(storageProvider.readObject({
      storageRelativePath: result.sourceFiles[0].storageRelativePath
    })).resolves.toEqual(bytes);
    await expect(fs.stat(resolved.stagedPath)).resolves.toMatchObject({ size: bytes.length });

    const streamedStorageProvider = {
      ...storageProvider,
      openObjectReadStream: vi.fn((input) => storageProvider.openObjectReadStream(input)),
      readObject: vi.fn((input) => storageProvider.readObject(input))
    };
    const response = createBufferedResponse();
    const artifactHandlers = createJobArtifactHandlers({
      userDataPath,
      jobWorkflow: { getJob: vi.fn(async () => null) },
      storageObjectProvider: streamedStorageProvider,
      loadNormalizedDocumentStoreRuntime: vi.fn(),
      getDiscoveryState: vi.fn(() => ({})),
      proxyApiRequest: vi.fn()
    });
    await artifactHandlers.handleGetRawObject({
      objectId: result.sourceFiles[0].rawObjectId,
      response,
      authSession: null
    });
    expect(response).toMatchObject({
      statusCode: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "Content-Length": bytes.length
      },
      body: bytes
    });
    expect(response.headers["Content-Disposition"]).toContain("source.bin");
    expect(streamedStorageProvider.openObjectReadStream).toHaveBeenCalledOnce();
    expect(streamedStorageProvider.readObject).not.toHaveBeenCalled();
  });

  it("denies raw-object access before opening the stored object stream", async () => {
    const { userDataPath, storageProvider } = await createHarness();
    const bytes = Buffer.from("protected canonical bytes");
    const stored = await storageProvider.putObject({
      objectId: "protected-raw-object",
      namespace: "tests",
      fileName: "protected.bin",
      buffer: bytes,
      metadata: {
        ownerSubjectId: OWNER.subjectId,
        ownerUserId: OWNER.userId
      }
    });
    const guardedStorageProvider = {
      ...storageProvider,
      openObjectReadStream: vi.fn((input) => storageProvider.openObjectReadStream(input))
    };
    const artifactHandlers = createJobArtifactHandlers({
      userDataPath,
      jobWorkflow: { getJob: vi.fn(async () => null) },
      storageObjectProvider: guardedStorageProvider,
      loadNormalizedDocumentStoreRuntime: vi.fn(),
      getDiscoveryState: vi.fn(() => ({})),
      proxyApiRequest: vi.fn()
    });
    const response = createBufferedResponse();

    await artifactHandlers.handleGetRawObject({
      objectId: stored.objectId,
      response,
      authSession: {
        user: {
          subjectId: "different-subject",
          userId: "different-user"
        }
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "原始邮件不存在或不可访问。"
    });
    expect(guardedStorageProvider.openObjectReadStream).not.toHaveBeenCalled();
  });

  it("bounds concurrent raw-object streams and releases capacity after cancellation", async () => {
    const storedObject = {
      objectId: "bounded-raw-object",
      storageRelativePath: "objects/tests/bounded.bin",
      byteSize: 1,
      mediaType: "application/octet-stream",
      metadata: {}
    };
    const openObjectReadStream = vi.fn(async () => ({
      byteSize: 1,
      stream: new Readable({
        read() {}
      })
    }));
    const artifactHandlers = createJobArtifactHandlers({
      userDataPath: "",
      jobWorkflow: { getJob: vi.fn(async () => null) },
      storageObjectProvider: {
        getObject: vi.fn(() => storedObject),
        openObjectReadStream
      },
      loadNormalizedDocumentStoreRuntime: vi.fn(),
      getDiscoveryState: vi.fn(() => ({})),
      proxyApiRequest: vi.fn()
    });
    const activeDownloads = Array.from({ length: 32 }, () => {
      const abortController = new AbortController();
      return {
        abortController,
        promise: artifactHandlers.handleGetRawObject({
          objectId: storedObject.objectId,
          response: createBufferedResponse(),
          authSession: null,
          signal: abortController.signal
        })
      };
    });
    await vi.waitFor(() => {
      expect(openObjectReadStream).toHaveBeenCalledTimes(32);
    });

    const rejectedResponse = createBufferedResponse();
    await artifactHandlers.handleGetRawObject({
      objectId: storedObject.objectId,
      response: rejectedResponse,
      authSession: null
    });

    expect(rejectedResponse.statusCode).toBe(503);
    expect(rejectedResponse.json()).toEqual({
      error: "原始文件下载容量已满，请稍后重试。",
      code: "raw_object_download_capacity_exceeded"
    });
    expect(openObjectReadStream).toHaveBeenCalledTimes(32);

    for (const download of activeDownloads) {
      download.abortController.abort();
    }
    await Promise.all(activeDownloads.map(({ promise }) => promise.catch(() => {})));

    const resumedAbortController = new AbortController();
    const resumedDownload = artifactHandlers.handleGetRawObject({
      objectId: storedObject.objectId,
      response: createBufferedResponse(),
      authSession: null,
      signal: resumedAbortController.signal
    });
    await vi.waitFor(() => {
      expect(openObjectReadStream).toHaveBeenCalledTimes(33);
    });
    resumedAbortController.abort();
    await resumedDownload.catch(() => {});
  });

  it("persists a verified zero-byte upload-session file into canonical storage", async () => {
    const { userDataPath, storageKernel, storageProvider } = await createHarness();
    const bytes = Buffer.alloc(0);
    const { created, resolved } = await createCompleteUploadSession(userDataPath, bytes);
    const pipeline = pipelineFor({
      userDataPath,
      storageProvider,
      uploadSessionId: created.sessionId
    });

    const result = await pipeline.run(pipeline.createContext());

    expect(result).toMatchObject({
      accepted: true,
      uploadSessionConsumption: {
        status: "persisted",
        complete: true,
        expectedFileCount: 1,
        persistedFileCount: 1
      },
      sourceFiles: [{
        kind: "stored-object",
        rawObjectSha256: sha256(bytes),
        rawObjectByteSize: 0
      }]
    });
    expect(storageKernel.getStorageSummary().objectCount).toBe(1);
    await expect(fs.stat(resolved.stagedPath)).resolves.toMatchObject({ size: 0 });
    await expect(storageProvider.readObject({
      storageRelativePath: result.sourceFiles[0].storageRelativePath
    })).resolves.toEqual(bytes);
  });

  it("deletes the canonical objects, ownership metadata, journal, and job artifacts together", async () => {
    const { userDataPath, storageKernel, storageProvider } = await createHarness();
    const bytes = Buffer.from("canonical bytes to delete");
    const { created } = await createCompleteUploadSession(userDataPath, bytes);
    const pipeline = pipelineFor({
      userDataPath,
      storageProvider,
      uploadSessionId: created.sessionId
    });
    const result = await pipeline.run(pipeline.createContext());
    const [source] = result.sourceFiles;
    const jobDirectory = path.join(userDataPath, "jobs", "pipeline-upload-job");
    await fs.mkdir(jobDirectory, { recursive: true });
    await fs.writeFile(path.join(jobDirectory, "result.json"), "{}", "utf8");
    const job = {
      id: "pipeline-upload-job",
      archiveBatchId: "pipeline-upload-batch"
    };
    const jobManager = {
      getJob: vi.fn(async (jobId) => jobId === job.id ? job : null),
      deleteJob: vi.fn(async (jobId) => jobId === job.id ? job : null)
    };
    const deletionCoordinator = createBatchDeletionCoordinator({
      userDataPath,
      jobManager,
      storageProvider
    });

    await expect(deletionCoordinator.deleteBatch(job.id)).resolves.toMatchObject({
      ok: true,
      batchId: job.archiveBatchId,
      deletedJob: job
    });
    expect(jobManager.deleteJob).toHaveBeenCalledWith(job.id);
    expect(storageProvider.getObject(source.rawObjectId)).toBeNull();
    expect(storageProvider.findObjectOwner(job.id)).toBeNull();
    expect(storageProvider.getDeletionOperationByOwnerId(job.archiveBatchId)).toBeNull();
    expect(storageKernel.getStorageSummary().objectCount).toBe(0);
    await expect(storageProvider.readObject({
      storageRelativePath: source.storageRelativePath
    })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(jobDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes artifact cleanup from journaled paths after metadata deletion is interrupted", async () => {
    const { userDataPath, storageProvider } = await createHarness();
    const job = {
      id: "interrupted-delete-job",
      archiveBatchId: "interrupted-delete-batch"
    };
    const stored = await storageProvider.putObject({
      objectId: "interrupted-delete-object",
      namespace: "tests",
      fileName: "interrupted.bin",
      buffer: Buffer.from("interrupted deletion bytes"),
      metadata: {
        jobId: job.id,
        archiveBatchId: job.archiveBatchId
      }
    });
    const jobDirectory = path.join(userDataPath, "jobs", job.id);
    await fs.mkdir(jobDirectory, { recursive: true });
    await fs.writeFile(path.join(jobDirectory, "result.json"), "{}", "utf8");
    const jobManager = {
      getJob: vi.fn(async (jobId) => jobId === job.id ? job : null),
      deleteJob: vi.fn(async (jobId) => jobId === job.id ? job : null)
    };
    let interruptMetadataCommit = true;
    const interruptingStorageProvider = {
      ...storageProvider,
      updateDeletionOperation(operationId, patch) {
        if (interruptMetadataCommit && patch?.status === "artifact_cleanup_pending") {
          interruptMetadataCommit = false;
          throw new Error("simulated metadata journal interruption");
        }
        return storageProvider.updateDeletionOperation(operationId, patch);
      }
    };
    const interruptedCoordinator = createBatchDeletionCoordinator({
      userDataPath,
      jobManager,
      storageProvider: interruptingStorageProvider
    });

    await expect(interruptedCoordinator.deleteBatch(job.id))
      .rejects.toThrow("simulated metadata journal interruption");
    expect(storageProvider.getObject(stored.objectId)).toBeNull();
    await expect(storageProvider.readObject({
      storageRelativePath: stored.storageRelativePath
    })).resolves.toEqual(Buffer.from("interrupted deletion bytes"));
    expect(storageProvider.getDeletionOperationByOwnerId(job.archiveBatchId)).toMatchObject({
      status: "metadata_pending",
      state: {
        runtimeDeleted: true,
        metadataDeleted: false,
        storageObjectPaths: [stored.storageRelativePath]
      }
    });

    const resumedCoordinator = createBatchDeletionCoordinator({
      userDataPath,
      jobManager,
      storageProvider
    });
    await resumedCoordinator.resumePendingDeletions();
    expect(storageProvider.getDeletionOperationByOwnerId(job.archiveBatchId)).toBeNull();
    await expect(storageProvider.readObject({
      storageRelativePath: stored.storageRelativePath
    })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(jobDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains staging and leaves canonical storage empty when a completed upload is invalidated", async () => {
    const { userDataPath, storageKernel, storageProvider } = await createHarness();
    const bytes = Buffer.from("verified-upload");
    const { created, resolved } = await createCompleteUploadSession(userDataPath, bytes);
    await fs.writeFile(resolved.stagedPath, Buffer.from("tampered-upload"));
    const pipeline = pipelineFor({
      userDataPath,
      storageProvider,
      uploadSessionId: created.sessionId
    });

    await expect(pipeline.run(pipeline.createContext())).rejects.toThrow("上传会话尚未完成");
    expect(storageKernel.getStorageSummary().objectCount).toBe(0);
    await expect(fs.stat(resolved.stagedPath)).resolves.toBeTruthy();
    await expect(fs.stat(path.dirname(resolved.stagedPath))).resolves.toBeTruthy();
  });
});
