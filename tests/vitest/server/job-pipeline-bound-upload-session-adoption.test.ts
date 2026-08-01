import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const pipelineSeams: any = vi.hoisted(() : any => {
  const events: any[] = [];
  return {
    events,
    rawResolveUploadSessionFiles: vi.fn(async () : Promise<any> => {
      const error: any = new Error("The raw positional upload-session resolver was called.");
      error.code = "raw_upload_session_resolver_called";
      throw error;
    }),
    saveSettings: vi.fn(async (_userDataPath?: any, settings: Record<string, any> = {}) : Promise<any> => {
      events.push("settings");
      return settings || {};
    })
  };
});

vi.mock(
  "../../../packages/server-runtime/src/state/upload-session-store.ts",
  async (importOriginal?: any) : Promise<any> => ({
    ...(await importOriginal()),
    resolveUploadSessionFiles: pipelineSeams.rawResolveUploadSessionFiles
  })
);

vi.mock("#meshrix/product-api", async (importOriginal?: any) : Promise<any> => ({
  ...(await importOriginal()),
  saveSettings: pipelineSeams.saveSettings
}));

import { serverToken } from "#meshrix/client-strings";
import {
  createServerCompositionRoot
} from "#meshrix/server-runtime/composition/composition-root.ts";
import {
  createJobPipeline
} from "#meshrix/server-runtime/jobs/job-pipeline.ts";
import {
  getSessionMetaPath
} from "#meshrix/server-runtime/state/upload-session-support.ts";

const OWNER: Readonly<Record<string, any>> = Object.freeze({
  subjectId: "bound-adoption-owner",
  userId: "bound-adoption-user",
  username: "bound-adoption",
  roleId: "owner",
  tenantId: "bound-adoption-tenant"
});
const OTHER_OWNER: Readonly<Record<string, any>> = Object.freeze({
  subjectId: "substituted-owner",
  userId: "substituted-user",
  username: "substituted",
  roleId: "owner",
  tenantId: "substituted-tenant"
});
const FORBIDDEN_STORAGE_METHODS: readonly any[] = Object.freeze([
  "getObject",
  "openObjectReadStream",
  "openPrivateNoExecObjectReadStream",
  "putObject",
  "putObjectsFromFiles",
  "readObject",
  "resolveStoredObjectPath"
]);
const tempRoots: any = new Set<any>();
const compositions: any = new Set<any>();
let uploadSequence: any = 0;

function sha256(value?: any) : any {
  return createHash("sha256").update(value).digest("hex");
}

function logger() : any {
  return {
    debug() : any {},
    error() : any {},
    info() : any {},
    warn() : any {}
  };
}

async function createTempRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(
    path.join(os.tmpdir(), "meshrix-bound-upload-adoption-")
  );
  tempRoots.add(root);
  return root;
}

async function openComposition(root: any = null) : Promise<any> {
  const userDataPath: any = root || await createTempRoot();
  const composition: any = await createServerCompositionRoot({
    userDataPath,
    runtimeLogger: logger(),
    runtimeOptions: {
      enabledPlugins: [],
      pluginConfigurations: {}
    }
  });
  compositions.add(composition);
  return composition;
}

async function closeComposition(composition?: any) : Promise<any> {
  if (!composition || !compositions.has(composition)) return;
  await composition.close();
  compositions.delete(composition);
}

function receiptCount(composition?: any) : any {
  return Number(composition.storageKernel.db.prepare(`
    SELECT COUNT(*) AS count
    FROM storage_upload_consumption_receipts
  `).get()?.count || 0);
}

function forbiddenCallCount(capture?: any) : any {
  return (Object.values(capture.forbidden) as any[]).reduce(
    (total?: any, effect?: any) : any => total + effect.mock.calls.length,
    0
  );
}

function deepKeys(value?: any, keys: any = new Set<any>()) : any {
  if (Array.isArray(value)) {
    for (const item of value) deepKeys(item, keys);
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  for (const [key, item] of (Object.entries(value) as [string, any][])) {
    keys.add(key);
    deepKeys(item, keys);
  }
  return keys;
}

function guardedStorageReceiptPort(composition?: any) : any {
  const forbidden: any = Object.fromEntries(
    FORBIDDEN_STORAGE_METHODS.map((method?: any) : any => [
      method,
      vi.fn(() : any => {
        const error: any = new Error(`Forbidden storage effect: ${method}`);
        error.code = "job_upload_adoption_storage_effect_forbidden";
        throw error;
      })
    ])
  );
  const commitInputs: any[] = [];
  const commitUploadConsumptionReceipt: any = vi.fn(async (input?: any) : Promise<any> => {
    pipelineSeams.events.push("receipt");
    commitInputs.push(structuredClone(input));
    return composition.storageProvider.commitUploadConsumptionReceipt(input);
  });
  return {
    commitInputs,
    commitUploadConsumptionReceipt,
    forbidden,
    port: Object.freeze({
      ...composition.storageProvider,
      ...forbidden,
      commitUploadConsumptionReceipt
    })
  };
}

async function createUpload(
  composition?: any,
  bytes?: any,
  { complete = true, owner = OWNER, label = "upload" }: Record<string, any> = {}
) : Promise<any> {
  uploadSequence += 1;
  const checkpointLabel: any = `${label}-${uploadSequence}`;
  const created: any = await composition.uploadSessionStore.createOrResumeUploadSession({
    checkpoint: {
      checkpointId: checkpointLabel,
      archiveBatchId: `${checkpointLabel}-batch`,
      clientUid: `${checkpointLabel}-client`,
      sourceType: "upload"
    },
    manifest: {
      manifestDigest: sha256(`${checkpointLabel}-manifest`),
      inputDigest: sha256(`${checkpointLabel}-input`)
    },
    owner,
    files: [{
      relativePath: `${checkpointLabel}.bin`,
      sha256: sha256(bytes),
      byteSize: bytes.length,
      mediaType: "application/octet-stream"
    }]
  });
  let completed: any = created;
  if (complete) {
    const append: any = await composition.uploadSessionStore.appendUploadSessionChunk({
      sessionId: created.sessionId,
      fileIndex: 0,
      offset: 0,
      buffer: bytes,
      owner
    });
    expect(append).toMatchObject({
      ok: true,
      session: {
        sessionId: created.sessionId,
        status: "complete",
        files: [{
          completed: true,
          custodyState: "sealed_no_run",
          byteSize: bytes.length
        }]
      }
    });
    completed = append.session;
  }
  const checkpointReceipt: any = complete
    ? await composition.uploadSessionStore.buildCheckpointReceiptFromUploadSession(
        created.sessionId,
        { owner }
      )
    : {
        checkpointId: created.checkpointId,
        archiveBatchId: created.archiveBatchId,
        clientUid: created.clientUid,
        sourceType: created.sourceType,
        ownerSubjectId: owner.subjectId,
        ownerUserId: owner.userId,
        ownerUsername: owner.username,
        ownerRoleId: owner.roleId,
        ownerTenantId: owner.tenantId,
        manifestSha256: created.manifestDigest,
        fileCount: 1,
        files: [{
          name: `${checkpointLabel}.bin`,
          relativePath: `${checkpointLabel}.bin`,
          sha256: sha256(bytes),
          byteSize: bytes.length
        }]
      };
  return {
    bytes,
    checkpointReceipt,
    created,
    session: completed
  };
}

function payloadFor(upload?: any, overrides: Record<string, any> = {}) : any {
  const payload: Record<string, any> = {
    uploadSessionId: upload.created.sessionId,
    archiveBatchId: upload.checkpointReceipt.archiveBatchId,
    ownerSubjectId: OWNER.subjectId,
    ownerUserId: OWNER.userId,
    ownerUsername: OWNER.username,
    ownerRoleId: OWNER.roleId,
    ownerTenantId: OWNER.tenantId,
    checkpointReceipt: structuredClone(upload.checkpointReceipt),
    settings: {}
  };
  return {
    ...payload,
    ...overrides
  };
}

function createPipelineHarness({
  composition,
  payload,
  uploadSessionStore = composition.uploadSessionStore,
  jobId = "bound-upload-adoption-job"
}: Record<string, any>) : any {
  const storage: any = guardedStorageReceiptPort(composition);
  const pipeline: any = createJobPipeline({
    userDataPath: composition.userDataPath,
    payload,
    runtime: composition.runtime,
    storageProvider: storage.port,
    uploadSessionStore,
    reportProgress: vi.fn(),
    jobId,
    generatedAt: "2026-07-30T00:00:00.000Z"
  });
  return { pipeline, storage };
}

function expectSynchronousCode(action?: any, code?: any) : any {
  let failure: any = null;
  try {
    action();
  } catch (error: any) {
    failure = error;
  }
  expect(failure).toMatchObject({ code });
}

async function rewriteSessionMeta(composition?: any, sessionId?: any, mutate?: any) : Promise<any> {
  const metaPath: any = getSessionMetaPath(composition.userDataPath, sessionId);
  const meta: any = JSON.parse(await fs.readFile(metaPath, "utf8"));
  mutate(meta);
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
}

async function expectAdoptionFailure({
  code,
  composition,
  payload,
  jobId
}: Record<string, any>) : Promise<any> {
  pipelineSeams.events.length = 0;
  pipelineSeams.saveSettings.mockClear();
  pipelineSeams.rawResolveUploadSessionFiles.mockClear();
  const beforeReceiptCount: any = receiptCount(composition);
  const beforeObjectCount: any = composition.storageKernel.getStorageSummary().objectCount;
  const { pipeline, storage } = createPipelineHarness({
    composition,
    payload,
    jobId
  });

  await expect(
    pipeline.run(pipeline.createContext())
  ).rejects.toMatchObject({ code });

  expect(storage.commitUploadConsumptionReceipt).not.toHaveBeenCalled();
  expect(forbiddenCallCount(storage)).toBe(0);
  expect(pipelineSeams.saveSettings).not.toHaveBeenCalled();
  expect(pipelineSeams.rawResolveUploadSessionFiles).not.toHaveBeenCalled();
  expect(receiptCount(composition)).toBe(beforeReceiptCount);
  expect(composition.storageKernel.getStorageSummary().objectCount)
    .toBe(beforeObjectCount);
  expect(pipelineSeams.events).toEqual([]);
}

afterEach(async () : Promise<any> => {
  for (const composition of [...compositions].reverse()) {
    await composition.close().catch(() : any => {});
    compositions.delete(composition);
  }
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true });
    tempRoots.delete(root);
  }
  uploadSequence = 0;
  pipelineSeams.events.length = 0;
  vi.clearAllMocks();
});

describe("job pipeline bound upload-session adoption", () : any => {
  it("commits one descriptor-only receipt through the exact root store and replays it after restart", async () : Promise<any> => {
    const root: any = await createTempRoot();
    let composition: any = await openComposition(root);
    const bytes: any = Buffer.from(
      "sealed upload payload that job adoption must never open",
      "utf8"
    );
    const upload: any = await createUpload(composition, bytes, {
      label: "descriptor-receipt"
    });
    const [sealedFile] = upload.session.files;
    const objectCountAfterSeal: any =
      composition.storageKernel.getStorageSummary().objectCount;
    pipelineSeams.events.length = 0;
    pipelineSeams.saveSettings.mockClear();
    pipelineSeams.rawResolveUploadSessionFiles.mockClear();
    const first: any = createPipelineHarness({
      composition,
      payload: payloadFor(upload)
    });

    const firstResult: any = await first.pipeline.run(
      first.pipeline.createContext()
    );

    expect(firstResult).toMatchObject({
      accepted: true,
      gateway: {
        sourceCount: 1,
        uploadSessionFileCount: 1
      },
      uploadConsumptionReceiptId: expect.stringMatching(
        /^upload_consumption_receipt_[a-f0-9]{32}$/u
      )
    });
    expect(firstResult.sourceFiles).toHaveLength(1);
    expect(firstResult.sourceFiles[0]).toMatchObject({
      kind: "upload-consumption-receipt-object",
      uploadConsumptionReceiptId:
        firstResult.uploadConsumptionReceiptId,
      receiptObjectIndex: 0,
      contentSha256: sha256(bytes),
      contentByteSize: bytes.length
    });
    expect(first.storage.commitUploadConsumptionReceipt)
      .toHaveBeenCalledOnce();
    expect(first.storage.commitInputs).toEqual([{
      sessionId: upload.created.sessionId,
      owner: {
        subjectId: OWNER.subjectId,
        userId: OWNER.userId,
        username: OWNER.username,
        roleId: OWNER.roleId,
        tenantId: OWNER.tenantId
      },
      custodyDescriptors: [{
        resourceRef: `upload-resource:${upload.created.sessionId}:0`,
        custodyRef: sealedFile.custodyRef,
        custodyState: "sealed_no_run",
        contentDigest: sha256(bytes),
        envelopeDigest: sealedFile.envelopeDigest,
        byteSize: bytes.length
      }]
    }]);
    expect(Object.keys(first.storage.commitInputs[0]).sort()).toEqual([
      "custodyDescriptors",
      "owner",
      "sessionId"
    ]);
    expect(
      Object.keys(first.storage.commitInputs[0].custodyDescriptors[0]).sort()
    ).toEqual([
      "byteSize",
      "contentDigest",
      "custodyRef",
      "custodyState",
      "envelopeDigest",
      "resourceRef"
    ]);
    expect(forbiddenCallCount(first.storage)).toBe(0);
    expect(pipelineSeams.rawResolveUploadSessionFiles).not.toHaveBeenCalled();
    expect(composition.storageKernel.getStorageSummary().objectCount)
      .toBe(objectCountAfterSeal);
    expect(receiptCount(composition)).toBe(1);
    const durableReceipt: any =
      composition.storageProvider.getUploadConsumptionReceipt(
        firstResult.uploadConsumptionReceiptId
      );
    expect(durableReceipt).toMatchObject({
      receiptId: firstResult.uploadConsumptionReceiptId,
      sessionId: upload.created.sessionId,
      objects: [{
        objectId: expect.any(String),
        sha256: sha256(bytes),
        byteSize: bytes.length
      }]
    });
    expect(Object.keys(durableReceipt).sort()).toEqual([
      "objects",
      "ownerKey",
      "receiptDigest",
      "receiptId",
      "schemaVersion",
      "sessionId"
    ]);
    const [logicalObject] = durableReceipt.objects;
    const physicalCustodyObject: any =
      composition.storageKernel.db.prepare(`
        SELECT object_id, sha256, byte_size, storage_rel_path
        FROM storage_objects
        WHERE object_id = ?
        LIMIT 1
      `).get(logicalObject.objectId);
    expect(physicalCustodyObject).toMatchObject({
      object_id: logicalObject.objectId,
      sha256: sealedFile.envelopeDigest
    });
    expect(Number(physicalCustodyObject.byte_size))
      .toBeGreaterThan(logicalObject.byteSize);
    expect(logicalObject).toEqual({
      objectId: physicalCustodyObject.object_id,
      sha256: sha256(bytes),
      byteSize: bytes.length
    });
    expect(logicalObject.sha256).not.toBe(physicalCustodyObject.sha256);
    expect(logicalObject.byteSize)
      .not.toBe(Number(physicalCustodyObject.byte_size));
    const publicAndCommitKeys: any = deepKeys({
      commit: first.storage.commitInputs[0],
      receipt: durableReceipt,
      result: firstResult
    });
    for (const forbiddenKey of [
      "absolutePath",
      "bytes",
      "buffer",
      "filePath",
      "hostPath",
      "rawObjectId",
      "sourcePath",
      "stagedPath",
      "storageRelativePath"
    ]) {
      expect(publicAndCommitKeys.has(forbiddenKey)).toBe(false);
    }
    expect(JSON.stringify({
      commit: first.storage.commitInputs[0],
      receipt: durableReceipt,
      result: firstResult
    })).not.toContain(physicalCustodyObject.storage_rel_path);

    await closeComposition(composition);
    composition = await openComposition(root);
    pipelineSeams.events.length = 0;
    pipelineSeams.saveSettings.mockClear();
    pipelineSeams.rawResolveUploadSessionFiles.mockClear();
    const replay: any = createPipelineHarness({
      composition,
      payload: payloadFor(upload)
    });
    const replayResult: any = await replay.pipeline.run(
      replay.pipeline.createContext()
    );

    expect(replayResult.uploadConsumptionReceiptId)
      .toBe(firstResult.uploadConsumptionReceiptId);
    expect(
      composition.storageProvider.getUploadConsumptionReceipt(
        replayResult.uploadConsumptionReceiptId
      )
    ).toEqual(durableReceipt);
    expect(receiptCount(composition)).toBe(1);
    expect(composition.storageKernel.getStorageSummary().objectCount)
      .toBe(objectCountAfterSeal);
    expect(replay.storage.commitInputs).toEqual(first.storage.commitInputs);
    expect(forbiddenCallCount(replay.storage)).toBe(0);
    expect(pipelineSeams.rawResolveUploadSessionFiles).not.toHaveBeenCalled();
  });

  it("rejects missing, wrapped, and foreign-root stores before pipeline effects", async () : Promise<any> => {
    const composition: any = await openComposition();
    const foreignComposition: any = await openComposition();
    const upload: any = await createUpload(
      composition,
      Buffer.from("identity-bound upload", "utf8"),
      { label: "store-identity" }
    );
    const payload: any = payloadFor(upload);
    const beforeReceiptCount: any = receiptCount(composition);
    const beforeObjectCount: any =
      composition.storageKernel.getStorageSummary().objectCount;
    const positionalAdapter: Readonly<Record<string, any>> = Object.freeze({
      resolveUploadSessionFiles(_userDataPath?: any, sessionId?: any, options: Record<string, any> = {}) : any {
        return composition.uploadSessionStore.resolveUploadSessionFiles(
          sessionId,
          options
        );
      }
    });

    for (const uploadSessionStore of [
      undefined,
      positionalAdapter,
      foreignComposition.uploadSessionStore
    ]) {
      pipelineSeams.events.length = 0;
      pipelineSeams.saveSettings.mockClear();
      pipelineSeams.rawResolveUploadSessionFiles.mockClear();
      const storage: any = guardedStorageReceiptPort(composition);
      expectSynchronousCode(() : any => createJobPipeline({
        userDataPath: composition.userDataPath,
        payload,
        runtime: composition.runtime,
        storageProvider: storage.port,
        uploadSessionStore,
        reportProgress: vi.fn(),
        jobId: "invalid-store-job",
        generatedAt: "2026-07-30T00:00:00.000Z"
      }), "upload_session_store_binding_invalid");
      expect(storage.commitUploadConsumptionReceipt).not.toHaveBeenCalled();
      expect(forbiddenCallCount(storage)).toBe(0);
      expect(pipelineSeams.saveSettings).not.toHaveBeenCalled();
      expect(pipelineSeams.rawResolveUploadSessionFiles).not.toHaveBeenCalled();
      expect(pipelineSeams.events).toEqual([]);
    }
    expect(receiptCount(composition)).toBe(beforeReceiptCount);
    expect(composition.storageKernel.getStorageSummary().objectCount)
      .toBe(beforeObjectCount);
  });

  it("reconciles custody and rejects stale state plus owner, session, and digest substitution before durable effects", async () : Promise<any> => {
    const composition: any = await openComposition();
    const source: any = await createUpload(
      composition,
      Buffer.from("bound source descriptor", "utf8"),
      { label: "binding-source" }
    );
    const substitutedSession: any = await createUpload(
      composition,
      Buffer.from("different sealed session", "utf8"),
      { label: "binding-session-substitution" }
    );
    const incomplete: any = await createUpload(
      composition,
      Buffer.from("custody remains incomplete", "utf8"),
      { complete: false, label: "stale-complete-metadata" }
    );
    const persistedDigest: any = await createUpload(
      composition,
      Buffer.from("custody digest remains authoritative", "utf8"),
      { label: "persisted-digest-substitution" }
    );

    await rewriteSessionMeta(
      composition,
      incomplete.created.sessionId,
      (meta?: any) : any => {
        meta.status = "complete";
        meta.files[0].receivedBytes = meta.files[0].byteSize;
        meta.files[0].completedAt = "2026-07-30T00:00:00.000Z";
        meta.files[0].verifiedSha256 = meta.files[0].sha256;
        meta.files[0].contentDigest = meta.files[0].sha256;
        meta.files[0].envelopeDigest = sha256("forged-stale-envelope");
        meta.files[0].custodyState = "sealed_no_run";
      }
    );
    await rewriteSessionMeta(
      composition,
      persistedDigest.created.sessionId,
      (meta?: any) : any => {
        meta.files[0].sha256 = sha256("substituted-persisted-digest");
      }
    );

    await expectAdoptionFailure({
      code: "upload_session_not_found",
      composition,
      jobId: "owner-substitution-job",
      payload: payloadFor(source, {
        ownerSubjectId: OTHER_OWNER.subjectId,
        ownerUserId: OTHER_OWNER.userId,
        ownerUsername: OTHER_OWNER.username,
        ownerRoleId: OTHER_OWNER.roleId,
        ownerTenantId: OTHER_OWNER.tenantId
      })
    });
    await expectAdoptionFailure({
      code: "upload_session_adoption_binding_mismatch",
      composition,
      jobId: "session-substitution-job",
      payload: payloadFor(source, {
        uploadSessionId: substitutedSession.created.sessionId
      })
    });
    const digestSubstitutionPayload: any = payloadFor(source);
    digestSubstitutionPayload.checkpointReceipt.files[0].sha256 =
      sha256("substituted-checkpoint-digest");
    await expectAdoptionFailure({
      code: "upload_session_adoption_binding_mismatch",
      composition,
      jobId: "checkpoint-digest-substitution-job",
      payload: digestSubstitutionPayload
    });
    await expectAdoptionFailure({
      code: "upload_session_adoption_not_sealed",
      composition,
      jobId: "stale-metadata-job",
      payload: payloadFor(incomplete)
    });
    await expectAdoptionFailure({
      code: "upload_session_custody_state_invalid",
      composition,
      jobId: "persisted-digest-substitution-job",
      payload: payloadFor(persistedDigest)
    });
    await expectAdoptionFailure({
      code: "upload_session_not_found",
      composition,
      jobId: "missing-session-substitution-job",
      payload: payloadFor(source, {
        uploadSessionId: serverToken(
          "upload_session",
          "unbound-session-substitution"
        )
      })
    });
  });
});
