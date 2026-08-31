import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const checkpointMocks: any = vi.hoisted(() : any => ({
  checkpointTreeId: vi.fn((kind: any, ...parts: any[]) : any => `checkpoint_tree_${kind}_${parts.filter(Boolean).join("_")}`),
  deleteCheckpointTree: vi.fn(async () : Promise<any> => undefined),
  finishCheckpointTree: vi.fn(async () : Promise<any> => undefined),
  startCheckpointTree: vi.fn(async () : Promise<any> => undefined),
  upsertCheckpointNode: vi.fn(async () : Promise<any> => undefined)
}));

vi.mock("#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection", () : any => checkpointMocks);
vi.mock("#meshrix/product-api", async (importOriginal?: any) : Promise<any> => ({
  ...(await importOriginal()),
  saveSettings: vi.fn(async (_userDataPath?: any, settings: Record<string, any> = {}) : Promise<any> => settings || {})
}));

import { createStorageKernel } from "#meshrix/foundation/storage/storage-kernel";
import { createStorageProvider } from "#meshrix/foundation/storage/storage-provider";
import { createLocalCustodyKeyBroker } from "#meshrix/server-runtime/execution-sandbox/custody-key-broker";
import { createUploadNoRunCustody } from "#meshrix/server-runtime/jobs/upload-no-run-custody";
import { createJobArtifactHandlers } from "#meshrix/protocols/http/controllers/jobs-controller-artifact-handlers";
import { createBatchDeletionCoordinator } from "#meshrix/server-runtime/jobs/batch-deletion-coordinator";
import { createJobPipeline } from "#meshrix/server-runtime/jobs/job-pipeline";
import {
  createUploadSessionStore
} from "#meshrix/server-runtime/state/upload-session-store";
import { getSessionMetaPath } from "#meshrix/server-runtime/state/upload-session-support";

const tempRoots: any[] = [];
const storageKernels: any[] = [];
const custodyKeyBrokers: any[] = [];
const OWNER: Readonly<Record<string, any>> = Object.freeze({
  subjectId: "owner-upload-pipeline",
  userId: "owner-upload-pipeline",
  username: "upload-owner",
  tenantId: "upload-tenant"
});

function sha256(value?: any) : any {
  return createHash("sha256").update(value).digest("hex");
}

function createBufferedResponse() : any {
  const chunks: any[] = [];
  const response: any = new Writable({
    write(chunk?: any, _encoding?: any, callback?: any) : any {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  response.statusCode = 0;
  response.headers = {};
  response.writeHead = (statusCode?: any, headers?: any) : any => {
    response.statusCode = statusCode;
    response.headers = headers;
  };
  Object.defineProperty(response, "body", {
    get: () : any => Buffer.concat(chunks)
  });
  response.json = () : any => JSON.parse(response.body.toString("utf8"));
  return response;
}

async function createCompleteUploadSession(uploadSessionStore?: any, bytes?: any) : Promise<any> {
  const created: any = await uploadSessionStore.createOrResumeUploadSession({
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
    await uploadSessionStore.appendUploadSessionChunk({
      sessionId: created.sessionId,
      fileIndex: 0,
      offset: 0,
      buffer: bytes,
      owner: OWNER
    });
  }
  const [resolved] = await uploadSessionStore.resolveUploadSessionFiles(created.sessionId, {
    owner: OWNER
  });
  const checkpointReceipt: any =
    await uploadSessionStore.buildCheckpointReceiptFromUploadSession(
      created.sessionId,
      { owner: OWNER }
    );
  return { checkpointReceipt, created, resolved };
}

async function createHarness() : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-job-pipeline-upload-"));
  tempRoots.push(userDataPath);
  const storageKernel: any = createStorageKernel({ userDataPath });
  storageKernels.push(storageKernel);
  const storageProvider: any = createStorageProvider({ userDataPath, storageKernel });
  const keyBroker: any = createLocalCustodyKeyBroker({ userDataPath });
  custodyKeyBrokers.push(keyBroker);
  const noRunCustody: any = createUploadNoRunCustody({
    userDataPath,
    storageKernel,
    storageProvider,
    keyBroker,
    reauthorizeCustodyRead: async () : Promise<any> => ({ allowed: false })
  });
  const uploadSessionStore: any = createUploadSessionStore({
    userDataPath,
    custodyPort: noRunCustody.stagingPort,
    custodyDescribe: noRunCustody.describe
  });
  return {
    userDataPath,
    storageKernel,
    storageProvider,
    uploadSessionStore
  };
}

function pipelineFor({ checkpointReceipt, userDataPath, storageProvider, uploadSessionId, uploadSessionStore }: Record<string, any>) : any {
  return createJobPipeline({
    userDataPath,
    payload: {
      uploadSessionId,
      checkpointReceipt,
      archiveBatchId: "pipeline-upload-batch",
      ownerSubjectId: OWNER.subjectId,
      ownerUserId: OWNER.userId,
      ownerUsername: OWNER.username,
      ownerRoleId: OWNER.roleId,
      ownerTenantId: OWNER.tenantId,
      settings: {}
    },
    runtime: {},
    storageProvider,
    uploadSessionStore,
    reportProgress: vi.fn(),
    jobId: "pipeline-upload-job",
    generatedAt: "2026-07-11T00:00:00.000Z"
  });
}

afterEach(async () : Promise<any> => {
  for (const keyBroker of custodyKeyBrokers.splice(0)) {
    await keyBroker.close();
  }
  for (const kernel of storageKernels.splice(0)) {
    kernel.close();
  }
  await Promise.all(tempRoots.splice(0).map((root?: any) : any =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

describe("job pipeline upload-session persistence", () : any => {
  it("binds an uploadSessionId-only source to a descriptor-only receipt", async () : Promise<any> => {
    const { userDataPath, storageKernel, storageProvider, uploadSessionStore } = await createHarness();
    const bytes: any = Buffer.from("canonical uploaded bytes");
    const { checkpointReceipt, created } = await createCompleteUploadSession(uploadSessionStore, bytes);
    const pipeline: any = pipelineFor({
      userDataPath,
      checkpointReceipt,
      storageProvider,
      uploadSessionStore,
      uploadSessionId: created.sessionId
    });

    const result: any = await pipeline.run(pipeline.createContext());

    expect(result).toMatchObject({
      accepted: true,
      gateway: {
        sourceCount: 1,
        uploadSessionFileCount: 1
      },
      uploadConsumptionReceiptId: expect.stringMatching(
        /^upload_consumption_receipt_[a-f0-9]{32}$/u
      ),
      sourceFiles: [{
        kind: "upload-consumption-receipt-object",
        uploadConsumptionReceiptId: expect.any(String),
        receiptObjectIndex: 0,
        contentSha256: sha256(bytes),
        contentByteSize: bytes.length
      }]
    });
    expect(
      storageProvider.getUploadConsumptionReceipt(
        result.uploadConsumptionReceiptId
      )
    ).toMatchObject({
      sessionId: created.sessionId,
      objects: [{
        sha256: sha256(bytes),
        byteSize: bytes.length
      }]
    });
    expect(storageKernel.getStorageSummary().objectCount).toBe(1);
    expect(result.sourceFiles[0]).not.toHaveProperty("rawObjectId");
    expect(result.sourceFiles[0]).not.toHaveProperty("storageRelativePath");
  });

  it("denies raw-object access before opening the stored object stream", async () : Promise<any> => {
    const { userDataPath, storageProvider } = await createHarness();
    const bytes: any = Buffer.from("protected canonical bytes");
    const stored: any = await storageProvider.putObject({
      objectId: "protected-raw-object",
      namespace: "tests",
      fileName: "protected.bin",
      buffer: bytes,
      metadata: {
        ownerSubjectId: OWNER.subjectId,
        ownerUserId: OWNER.userId
      }
    });
    const guardedStorageProvider: Record<string, any> = {
      ...storageProvider,
      openObjectReadStream: vi.fn((input?: any) : any => storageProvider.openObjectReadStream(input))
    };
    const artifactHandlers: any = createJobArtifactHandlers({
      userDataPath,
      jobWorkflow: { getJob: vi.fn(async () : Promise<any> => null) },
      storageObjectProvider: guardedStorageProvider,
      loadNormalizedDocumentStoreRuntime: vi.fn(),
      getDiscoveryState: vi.fn(() : any => ({})),
      proxyApiRequest: vi.fn()
    });
    const response: any = createBufferedResponse();

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

  it("denies raw-object access when the internal identity is absent", async () : Promise<any> => {
    const { userDataPath, storageProvider } = await createHarness();
    const stored: any = await storageProvider.putObject({
      objectId: "missing-identity-raw-object",
      namespace: "tests",
      fileName: "protected.bin",
      buffer: Buffer.from("protected canonical bytes"),
      metadata: {
        ownerSubjectId: OWNER.subjectId,
        ownerUserId: OWNER.userId
      }
    });
    const guardedStorageProvider: Record<string, any> = {
      ...storageProvider,
      openObjectReadStream: vi.fn((input?: any) : any => storageProvider.openObjectReadStream(input))
    };
    const artifactHandlers: any = createJobArtifactHandlers({
      userDataPath,
      jobWorkflow: { getJob: vi.fn(async () : Promise<any> => null) },
      storageObjectProvider: guardedStorageProvider,
      loadNormalizedDocumentStoreRuntime: vi.fn(),
      getDiscoveryState: vi.fn(() : any => ({})),
      proxyApiRequest: vi.fn()
    });
    const response: any = createBufferedResponse();

    await artifactHandlers.handleGetRawObject({
      objectId: stored.objectId,
      response,
      authSession: null
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "原始邮件不存在或不可访问。"
    });
    expect(guardedStorageProvider.openObjectReadStream).not.toHaveBeenCalled();
  });

  it("bounds concurrent raw-object streams and releases capacity after cancellation", async () : Promise<any> => {
    const storedObject: Record<string, any> = {
      objectId: "bounded-raw-object",
      storageRelativePath: "objects/tests/bounded.bin",
      byteSize: 1,
      mediaType: "application/octet-stream",
      metadata: {
        ownerSubjectId: OWNER.subjectId,
        ownerUserId: OWNER.userId
      }
    };
    const openObjectReadStream: any = vi.fn(async () : Promise<any> => ({
      byteSize: 1,
      stream: new Readable({
        read() : any {}
      })
    }));
    const artifactHandlers: any = createJobArtifactHandlers({
      userDataPath: "",
      jobWorkflow: { getJob: vi.fn(async () : Promise<any> => null) },
      storageObjectProvider: {
        getObject: vi.fn(() : any => storedObject),
        openObjectReadStream
      },
      loadNormalizedDocumentStoreRuntime: vi.fn(),
      getDiscoveryState: vi.fn(() : any => ({})),
      proxyApiRequest: vi.fn()
    });
    const activeDownloads: any = Array.from({ length: 32 }, () : any => {
      const abortController: any = new AbortController();
      return {
        abortController,
        promise: artifactHandlers.handleGetRawObject({
          objectId: storedObject.objectId,
          response: createBufferedResponse(),
          authSession: { user: OWNER },
          signal: abortController.signal
        })
      };
    });
    await vi.waitFor(() : any => {
      expect(openObjectReadStream).toHaveBeenCalledTimes(32);
    });

    const rejectedResponse: any = createBufferedResponse();
    await artifactHandlers.handleGetRawObject({
      objectId: storedObject.objectId,
      response: rejectedResponse,
      authSession: { user: OWNER }
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
    await Promise.all(activeDownloads.map(({ promise }: Record<string, any>) : any => promise.catch(() : any => {})));

    const resumedAbortController: any = new AbortController();
    const resumedDownload: any = artifactHandlers.handleGetRawObject({
      objectId: storedObject.objectId,
      response: createBufferedResponse(),
      authSession: { user: OWNER },
      signal: resumedAbortController.signal
    });
    await vi.waitFor(() : any => {
      expect(openObjectReadStream).toHaveBeenCalledTimes(33);
    });
    resumedAbortController.abort();
    await resumedDownload.catch(() : any => {});
  });

  it("persists a verified zero-byte upload-session file into canonical storage", async () : Promise<any> => {
    const { userDataPath, storageKernel, storageProvider, uploadSessionStore } = await createHarness();
    const bytes: any = Buffer.alloc(0);
    const { checkpointReceipt, created, resolved } = await createCompleteUploadSession(uploadSessionStore, bytes);
    const pipeline: any = pipelineFor({
      userDataPath,
      checkpointReceipt,
      storageProvider,
      uploadSessionStore,
      uploadSessionId: created.sessionId
    });

    const result: any = await pipeline.run(pipeline.createContext());

    expect(result).toMatchObject({
      accepted: true,
      uploadConsumptionReceiptId: expect.stringMatching(
        /^upload_consumption_receipt_[a-f0-9]{32}$/u
      ),
      sourceFiles: [{
        kind: "upload-consumption-receipt-object",
        contentSha256: sha256(bytes),
        contentByteSize: 0
      }]
    });
    expect(
      storageProvider.getUploadConsumptionReceipt(
        result.uploadConsumptionReceiptId
      )
    ).toMatchObject({
      sessionId: created.sessionId,
      objects: [{
        sha256: sha256(bytes),
        byteSize: 0
      }]
    });
    expect(storageKernel.getStorageSummary().objectCount).toBe(1);
    expect(result.sourceFiles[0]).not.toHaveProperty("rawObjectId");
    expect(result.sourceFiles[0]).not.toHaveProperty("storageRelativePath");
  });

  it("deletes job artifacts without deleting independently owned upload custody", async () : Promise<any> => {
    const { userDataPath, storageKernel, storageProvider, uploadSessionStore } = await createHarness();
    const bytes: any = Buffer.from("canonical bytes to delete");
    const { checkpointReceipt, created } = await createCompleteUploadSession(uploadSessionStore, bytes);
    const pipeline: any = pipelineFor({
      userDataPath,
      checkpointReceipt,
      storageProvider,
      uploadSessionStore,
      uploadSessionId: created.sessionId
    });
    const result: any = await pipeline.run(pipeline.createContext());
    const receipt: any = storageProvider.getUploadConsumptionReceipt(
      result.uploadConsumptionReceiptId
    );
    const custodyObjectId: any = receipt.objects[0].objectId;
    const jobDirectory: any = path.join(userDataPath, "jobs", "pipeline-upload-job");
    await fs.mkdir(jobDirectory, { recursive: true });
    await fs.writeFile(path.join(jobDirectory, "result.json"), "{}", "utf8");
    const job: Record<string, any> = {
      id: "pipeline-upload-job",
      archiveBatchId: "pipeline-upload-batch"
    };
    const jobManager: Record<string, any> = {
      getJob: vi.fn(async (jobId?: any) : Promise<any> => jobId === job.id ? job : null),
      deleteJob: vi.fn(async (jobId?: any) : Promise<any> => jobId === job.id ? job : null)
    };
    const deletionCoordinator: any = createBatchDeletionCoordinator({
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
    expect(storageProvider.getObject(custodyObjectId)).not.toBeNull();
    expect(storageProvider.findObjectOwner(job.id)).toBeNull();
    expect(storageProvider.getDeletionOperationByOwnerId(job.archiveBatchId)).toBeNull();
    expect(storageKernel.getStorageSummary().objectCount).toBe(1);
    await expect(fs.stat(jobDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes artifact cleanup from journaled paths after metadata deletion is interrupted", async () : Promise<any> => {
    const { userDataPath, storageProvider } = await createHarness();
    const job: Record<string, any> = {
      id: "interrupted-delete-job",
      archiveBatchId: "interrupted-delete-batch"
    };
    const stored: any = await storageProvider.putObject({
      objectId: "interrupted-delete-object",
      namespace: "tests",
      fileName: "interrupted.bin",
      buffer: Buffer.from("interrupted deletion bytes"),
      metadata: {
        jobId: job.id,
        archiveBatchId: job.archiveBatchId
      }
    });
    const jobDirectory: any = path.join(userDataPath, "jobs", job.id);
    await fs.mkdir(jobDirectory, { recursive: true });
    await fs.writeFile(path.join(jobDirectory, "result.json"), "{}", "utf8");
    const jobManager: Record<string, any> = {
      getJob: vi.fn(async (jobId?: any) : Promise<any> => jobId === job.id ? job : null),
      deleteJob: vi.fn(async (jobId?: any) : Promise<any> => jobId === job.id ? job : null)
    };
    let interruptMetadataCommit: any = true;
    const interruptingStorageProvider: Record<string, any> = {
      ...storageProvider,
      updateDeletionOperation(operationId?: any, patch?: any) : any {
        if (interruptMetadataCommit && patch?.status === "artifact_cleanup_pending") {
          interruptMetadataCommit = false;
          throw new Error("simulated metadata journal interruption");
        }
        return storageProvider.updateDeletionOperation(operationId, patch);
      }
    };
    const interruptedCoordinator: any = createBatchDeletionCoordinator({
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

    const resumedCoordinator: any = createBatchDeletionCoordinator({
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

  it("rejects invalidated upload metadata before creating a consumption receipt", async () : Promise<any> => {
    const { userDataPath, storageKernel, storageProvider, uploadSessionStore } = await createHarness();
    const bytes: any = Buffer.from("verified-upload");
    const { checkpointReceipt, created } = await createCompleteUploadSession(uploadSessionStore, bytes);
    const metaPath: any = getSessionMetaPath(userDataPath, created.sessionId);
    const meta: any = JSON.parse(await fs.readFile(metaPath, "utf8"));
    meta.files[0].sha256 = sha256("tampered-upload");
    await fs.writeFile(metaPath, JSON.stringify(meta), "utf8");
    const pipeline: any = pipelineFor({
      userDataPath,
      checkpointReceipt,
      storageProvider,
      uploadSessionStore,
      uploadSessionId: created.sessionId
    });

    await expect(pipeline.run(pipeline.createContext())).rejects.toMatchObject({
      code: "upload_session_custody_state_invalid"
    });
    expect(storageProvider.getUploadConsumptionReceipt(
      checkpointReceipt.receiptId || ""
    )).toBeNull();
    expect(storageKernel.getStorageSummary().objectCount).toBe(1);
  });
});
