import { createHash } from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startCheckpointTreeMock = vi.hoisted(() => vi.fn(async () => undefined));
const upsertCheckpointNodeMock = vi.hoisted(() => vi.fn(async () => undefined));
const finishCheckpointTreeMock = vi.hoisted(() => vi.fn(async () => undefined));
const deleteCheckpointTreeMock = vi.hoisted(() => vi.fn(async () => undefined));
const checkpointTreeIdMock = vi.hoisted(() => vi.fn((kind, ...parts) => {
  const suffix = parts.filter(Boolean).join("_") || "root";
  return `checkpoint_tree_${kind}_${suffix}`;
}));

vi.mock("#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection", () => ({
  checkpointTreeId: checkpointTreeIdMock,
  deleteCheckpointTree: deleteCheckpointTreeMock,
  finishCheckpointTree: finishCheckpointTreeMock,
  startCheckpointTree: startCheckpointTreeMock,
  upsertCheckpointNode: upsertCheckpointNodeMock
}));

import {
  appendUploadSessionChunk,
  buildCheckpointReceiptFromUploadSession,
  createOrResumeUploadSession,
  deleteUploadSession,
  getUploadSession,
  resolveUploadSessionFiles
} from "../../../packages/server-runtime/src/state/upload-session-store.mjs";
import {
  UPLOAD_SESSION_MAX_ACTIVE_PER_OWNER_SCOPE,
  UPLOAD_SESSION_MAX_CHUNK_BYTES,
  UPLOAD_SESSION_EXPIRY_CLEANUP_BATCH,
  UPLOAD_SESSION_MAX_FILE_BYTES,
  UPLOAD_SESSION_MAX_FILE_COUNT,
  UPLOAD_SESSION_MAX_SOURCE_METADATA_BYTES,
  UPLOAD_SESSION_MAX_TOTAL_BYTES,
  UPLOAD_SESSION_MAX_RETAINED,
  reserveUploadSessionAdmission
} from "../../../packages/server-runtime/src/state/upload-session-admission.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const OWNER_A = {
  subjectId: "owner-a",
  userId: "owner-a",
  username: "alice",
  tenantId: "tenant-a"
};

const OWNER_B = {
  subjectId: "owner-b",
  userId: "owner-b",
  username: "bob",
  tenantId: "tenant-a"
};

const ADMIN_OWNER = {
  subjectId: "admin-owner",
  userId: "admin-owner",
  username: "admin",
  tenantId: "tenant-a",
  roleId: "admin",
  canAccessAll: true
};

async function withTempUserData(testCase) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upload-session-store-extra-"));
  try {
    return await testCase(userDataPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function sessionMetaPath(userDataPath, sessionId) {
  return path.join(userDataPath, "upload-sessions", sessionId, "meta.json");
}

function sessionFilePath(userDataPath, sessionId, fileIndex) {
  return path.join(userDataPath, "upload-sessions", sessionId, "files", `${fileIndex}.part`);
}

beforeEach(() => {
  startCheckpointTreeMock.mockClear();
  upsertCheckpointNodeMock.mockClear();
  finishCheckpointTreeMock.mockClear();
  deleteCheckpointTreeMock.mockClear();
  checkpointTreeIdMock.mockClear();
});

describe("upload-session store behavior", () => {
  it("creates, resumes, reads, resolves and deletes an upload session end to end", async () => {
    await withTempUserData(async (userDataPath) => {
      const created = await createOrResumeUploadSession({
        userDataPath,
        checkpoint: {
          checkpointId: "client-checkpoint-1",
          archiveBatchId: "archive-batch-1",
          clientUid: "client-a",
          sourceType: "mail"
        },
        manifest: {
          manifestDigest: sha256("manifest-a"),
          inputDigest: sha256("input-a")
        },
        owner: OWNER_A,
        files: [
          {
            relativePath: "nested\\inbox\\message.eml",
            sha256: sha256("hello world"),
            byteSize: 11,
            mediaType: "message/rfc822"
          }
        ]
      });

      expect(created).toMatchObject({
        checkpointId: expect.any(String),
        sessionId: expect.any(String),
        archiveBatchId: "archive-batch-1",
        clientUid: "client-a",
        sourceType: "mail",
        status: "uploading",
        files: [
          {
            index: 0,
            originalFileName: "message.eml",
            completed: false,
            receivedBytes: 0
          }
        ]
      });
      expect(startCheckpointTreeMock).toHaveBeenCalledTimes(1);
      expect(upsertCheckpointNodeMock).toHaveBeenCalled();

      const metaPath = sessionMetaPath(userDataPath, created.sessionId);
      const filePath = sessionFilePath(userDataPath, created.sessionId, 0);
      await expect(fs.stat(metaPath)).resolves.toBeTruthy();
      await expect(fs.stat(filePath)).rejects.toThrow();

      const resume = await createOrResumeUploadSession({
        userDataPath,
        checkpoint: {
          checkpointId: "client-checkpoint-1",
          archiveBatchId: "archive-batch-1"
        },
        manifest: {
          manifestDigest: sha256("manifest-a"),
          inputDigest: sha256("input-a")
        },
        owner: OWNER_A
      });

      expect(resume.sessionId).toBe(created.sessionId);
      expect(resume.status).toBe("uploading");

      const append = await appendUploadSessionChunk({
        userDataPath,
        sessionId: created.sessionId,
        fileIndex: 0,
        offset: 0,
        buffer: Buffer.from("hello world"),
        owner: OWNER_A
      });

      expect(append).toMatchObject({
        ok: true,
        code: "ok",
        session: {
          sessionId: created.sessionId,
          status: "complete"
        }
      });

      const session = await getUploadSession(userDataPath, created.sessionId, { owner: OWNER_A });
      expect(session).toMatchObject({
        sessionId: created.sessionId,
        status: "complete",
        files: [
          {
            index: 0,
            originalFileName: "message.eml",
            receivedBytes: 11,
            completed: true
          }
        ]
      });

      const resolvedFiles = await resolveUploadSessionFiles(userDataPath, created.sessionId, {
        owner: OWNER_A
      });
      expect(resolvedFiles).toHaveLength(1);
      expect(resolvedFiles[0]).toMatchObject({
        name: expect.any(String),
        relativePath: expect.any(String),
        originalFileName: "message.eml",
        archiveBatchId: "archive-batch-1",
        stagedPath: filePath
      });

      const receipt = await buildCheckpointReceiptFromUploadSession(userDataPath, created.sessionId, {
        owner: OWNER_A
      });
      expect(receipt).toMatchObject({
        checkpointId: expect.any(String),
        archiveBatchId: "archive-batch-1",
        clientUid: "client-a",
        sourceType: "mail",
        ownerSubjectId: "owner-a",
        ownerUserId: "owner-a",
        ownerUsername: "alice",
        ownerTenantId: "tenant-a",
        fileCount: 1,
        files: [
          {
            originalFileName: "message.eml",
            byteSize: 11,
            sha256: sha256("hello world")
          }
        ]
      });

      await deleteUploadSession(userDataPath, created.sessionId);
      await expect(fs.stat(metaPath)).rejects.toThrow();
      await expect(fs.stat(path.join(userDataPath, "upload-sessions", created.sessionId))).rejects.toThrow();
      expect(deleteCheckpointTreeMock).toHaveBeenCalledTimes(1);
    });
  });

  it("binds upload sessions to the creating owner for reads, chunk writes and receipts", async () => {
    await withTempUserData(async (userDataPath) => {
      const createdByA = await createOrResumeUploadSession({
        userDataPath,
        checkpoint: { checkpointId: "client-checkpoint-owner" },
        manifest: {
          manifestDigest: sha256("manifest-owner"),
          inputDigest: sha256("input-owner")
        },
        owner: OWNER_A,
        files: [
          {
            relativePath: "owned.txt",
            sha256: sha256("owned"),
            byteSize: 5
          }
        ]
      });
      const createdByB = await createOrResumeUploadSession({
        userDataPath,
        checkpoint: { checkpointId: "client-checkpoint-owner" },
        manifest: {
          manifestDigest: sha256("manifest-owner"),
          inputDigest: sha256("input-owner")
        },
        owner: OWNER_B,
        files: [
          {
            relativePath: "owned.txt",
            sha256: sha256("owned"),
            byteSize: 5
          }
        ]
      });

      expect(createdByB.sessionId).not.toBe(createdByA.sessionId);
      await expect(getUploadSession(userDataPath, createdByA.sessionId, { owner: OWNER_B })).resolves.toBeNull();

      const deniedAppend = await appendUploadSessionChunk({
        userDataPath,
        sessionId: createdByA.sessionId,
        fileIndex: 0,
        offset: 0,
        buffer: Buffer.from("xxxxx"),
        owner: OWNER_B
      });
      expect(deniedAppend).toMatchObject({
        ok: false,
        code: "not_found",
        session: null
      });

      const ownedAppend = await appendUploadSessionChunk({
        userDataPath,
        sessionId: createdByA.sessionId,
        fileIndex: 0,
        offset: 0,
        buffer: Buffer.from("owned"),
        owner: OWNER_A
      });
      expect(ownedAppend).toMatchObject({
        ok: true,
        session: {
          status: "complete"
        }
      });
      await expect(
        buildCheckpointReceiptFromUploadSession(userDataPath, createdByA.sessionId, { owner: OWNER_B })
      ).rejects.toThrow(`上传会话不存在或不可访问：${createdByA.sessionId}`);
      await expect(
        resolveUploadSessionFiles(userDataPath, createdByA.sessionId, { owner: OWNER_B })
      ).rejects.toThrow(`上传会话不存在或不可访问：${createdByA.sessionId}`);

      const receipt = await buildCheckpointReceiptFromUploadSession(userDataPath, createdByA.sessionId, {
        owner: OWNER_A
      });
      expect(receipt).toMatchObject({
        ownerSubjectId: "owner-a",
        fileCount: 1
      });

      const metaPath = sessionMetaPath(userDataPath, createdByA.sessionId);
      const legacyMeta = await readJson(metaPath);
      delete legacyMeta.ownerSubjectId;
      delete legacyMeta.ownerUserId;
      delete legacyMeta.ownerUsername;
      delete legacyMeta.ownerRoleId;
      delete legacyMeta.ownerTenantId;
      delete legacyMeta.ownerKey;
      await fs.writeFile(metaPath, `${JSON.stringify(legacyMeta, null, 2)}\n`, "utf8");

      await expect(getUploadSession(userDataPath, createdByA.sessionId, { owner: ADMIN_OWNER })).resolves.toBeNull();
      await expect(
        buildCheckpointReceiptFromUploadSession(userDataPath, createdByA.sessionId, { owner: ADMIN_OWNER })
      ).rejects.toThrow(`上传会话不存在或不可访问：${createdByA.sessionId}`);
    });
  });

  it("rejects invalid tokens, missing files, unsafe paths and digest validation failures", async () => {
    await withTempUserData(async (userDataPath) => {
      await expect(
        createOrResumeUploadSession({
          userDataPath,
          checkpoint: { checkpointId: "" },
          manifest: { manifestDigest: sha256("manifest-b") },
          owner: OWNER_A
        })
      ).rejects.toThrow("upload session 缺少 checkpointId。");

      await expect(
        createOrResumeUploadSession({
          userDataPath,
          checkpoint: { checkpointId: "client-checkpoint-2" },
          manifest: { manifestDigest: "not-a-sha256" },
          owner: OWNER_A
        })
      ).rejects.toThrow("manifestDigest 必须是 sha256 hex。");

      await expect(
        createOrResumeUploadSession({
          userDataPath,
          checkpoint: { checkpointId: "client-checkpoint-2" },
          manifest: { manifestDigest: sha256("manifest-c") },
          owner: OWNER_A,
          files: [
            {
              relativePath: "../escape.txt",
              sha256: sha256("payload"),
              byteSize: 7
            }
          ]
        })
      ).rejects.toThrow("上传路径不安全，已拒绝。");

      const created = await createOrResumeUploadSession({
        userDataPath,
        checkpoint: { checkpointId: "client-checkpoint-3" },
        manifest: { manifestDigest: sha256("manifest-d"), inputDigest: sha256("input-d") },
        owner: OWNER_A,
        files: [
          {
            relativePath: "folder\\child.txt",
            sha256: sha256("payload"),
            byteSize: 7
          }
        ]
      });

      const meta = await readJson(sessionMetaPath(userDataPath, created.sessionId));
      expect(meta.files[0]).toMatchObject({
        originalFileName: "child.txt",
        receivedBytes: 0,
        completedAt: ""
      });

      await expect(getUploadSession(userDataPath, "not-a-session-token", { owner: OWNER_A })).resolves.toBeNull();
      await expect(resolveUploadSessionFiles(userDataPath, "not-a-session-token", { owner: OWNER_A })).rejects.toThrow(
        /token 格式无效/
      );

      const missing = await appendUploadSessionChunk({
        userDataPath,
        sessionId: created.sessionId,
        fileIndex: 1,
        offset: 0,
        buffer: Buffer.from("x"),
        owner: OWNER_A
      });
      expect(missing).toMatchObject({
        ok: false,
        code: "file_not_found"
      });

      const invalidTokenResult = await appendUploadSessionChunk({
        userDataPath,
        sessionId: "invalid-session-token",
        fileIndex: 0,
        offset: 0,
        buffer: Buffer.from("x"),
        owner: OWNER_A
      });
      expect(invalidTokenResult).toMatchObject({
        ok: false,
        code: "not_found",
        session: null
      });

      const offsetMismatch = await appendUploadSessionChunk({
        userDataPath,
        sessionId: created.sessionId,
        fileIndex: 0,
        offset: 1,
        buffer: Buffer.from("pay"),
        owner: OWNER_A
      });
      expect(offsetMismatch).toMatchObject({
        ok: false,
        code: "offset_mismatch",
        expectedOffset: 0
      });

      const tooLarge = await appendUploadSessionChunk({
        userDataPath,
        sessionId: created.sessionId,
        fileIndex: 0,
        offset: 0,
        buffer: Buffer.from("payload-too-large"),
        owner: OWNER_A
      });
      expect(tooLarge).toMatchObject({
        ok: false,
        code: "chunk_too_large"
      });
    });
  });

  it("reconciles tampered files, returns null for missing sessions and clears a valid session", async () => {
    await withTempUserData(async (userDataPath) => {
      const created = await createOrResumeUploadSession({
        userDataPath,
        checkpoint: {
          checkpointId: "client-checkpoint-4",
          archiveBatchId: "archive-batch-4"
        },
        manifest: {
          manifestDigest: sha256("manifest-e"),
          inputDigest: sha256("input-e")
        },
        owner: OWNER_A,
        files: [
          {
            relativePath: "message.txt",
            sha256: sha256("data"),
            byteSize: 4
          }
        ]
      });

      await appendUploadSessionChunk({
        userDataPath,
        sessionId: created.sessionId,
        fileIndex: 0,
        offset: 0,
        buffer: Buffer.from("data"),
        owner: OWNER_A
      });

      const filePath = sessionFilePath(userDataPath, created.sessionId, 0);

      await fs.writeFile(filePath, Buffer.from("data++"));
      const truncated = await getUploadSession(userDataPath, created.sessionId, { owner: OWNER_A });
      expect(truncated.files[0]).toMatchObject({
        receivedBytes: 4,
        completed: true
      });

      await fs.writeFile(filePath, Buffer.from("oops"));
      const mismatch = await getUploadSession(userDataPath, created.sessionId, { owner: OWNER_A });
      expect(mismatch.files[0]).toMatchObject({
        receivedBytes: 0,
        completed: false
      });

      const metaPath = sessionMetaPath(userDataPath, created.sessionId);
      const meta = await readJson(metaPath);
      meta.files[0].receivedBytes = 0;
      meta.files[0].completedAt = "2026-01-01T00:00:00.000Z";
      meta.files[0].verifiedSha256 = "deadbeef";
      meta.updatedAt = "2026-01-01T00:00:00.000Z";
      await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

      const cleared = await getUploadSession(userDataPath, created.sessionId, { owner: OWNER_A });
      expect(cleared.files[0]).toMatchObject({
        receivedBytes: 0,
        completed: false,
        completedAt: ""
      });

      await expect(resolveUploadSessionFiles(userDataPath, created.sessionId, { owner: OWNER_A })).rejects.toThrow(
        `上传会话尚未完成：${created.sessionId}`
      );
      await expect(buildCheckpointReceiptFromUploadSession(userDataPath, created.sessionId, { owner: OWNER_A })).rejects.toThrow(
        `上传会话尚未完成：${created.sessionId}`
      );

      await expect(deleteUploadSession(userDataPath, "")).resolves.toBeUndefined();
      expect(deleteCheckpointTreeMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ treeId: expect.any(String) })
      );
    });
  });

  it("serializes concurrent chunks at the same session offset without duplicating bytes", async () => {
    await withTempUserData(async (userDataPath) => {
      const payload = Buffer.from("payload");
      const created = await createOrResumeUploadSession({
        userDataPath,
        checkpoint: { checkpointId: "client-checkpoint-concurrent" },
        manifest: {
          manifestDigest: sha256("manifest-concurrent"),
          inputDigest: sha256("input-concurrent")
        },
        owner: OWNER_A,
        files: [{
          relativePath: "concurrent.bin",
          sha256: sha256(payload),
          byteSize: payload.length
        }]
      });

      const results = await Promise.all([
        appendUploadSessionChunk({
          userDataPath,
          sessionId: created.sessionId,
          fileIndex: 0,
          offset: 0,
          buffer: payload,
          owner: OWNER_A
        }),
        appendUploadSessionChunk({
          userDataPath,
          sessionId: created.sessionId,
          fileIndex: 0,
          offset: 0,
          buffer: payload,
          owner: OWNER_A
        })
      ]);

      expect(results.map((result) => result.code).sort()).toEqual(["offset_mismatch", "ok"]);
      const filePath = sessionFilePath(userDataPath, created.sessionId, 0);
      await expect(fs.readFile(filePath)).resolves.toEqual(payload);
      await expect(fs.stat(filePath)).resolves.toMatchObject({ size: payload.length });
      await expect(getUploadSession(userDataPath, created.sessionId, { owner: OWNER_A })).resolves.toMatchObject({
        status: "complete",
        files: [{ receivedBytes: payload.length, completed: true }]
      });
    });
  });

  it("keeps directories and files private and leaves valid metadata after an atomic commit failure", async () => {
    const previousUmask = process.umask(0o022);
    try {
      await withTempUserData(async (userDataPath) => {
        const payload = Buffer.from("private");
        const created = await createOrResumeUploadSession({
          userDataPath,
          checkpoint: { checkpointId: "client-checkpoint-private" },
          manifest: {
            manifestDigest: sha256("manifest-private"),
            inputDigest: sha256("input-private")
          },
          owner: OWNER_A,
          files: [{
            relativePath: "private.bin",
            sha256: sha256(payload),
            byteSize: payload.length
          }]
        });
        const uploadSessionsPath = path.join(userDataPath, "upload-sessions");
        const sessionPath = path.join(uploadSessionsPath, created.sessionId);
        const filesPath = path.join(sessionPath, "files");
        const metaPath = sessionMetaPath(userDataPath, created.sessionId);
        const filePath = sessionFilePath(userDataPath, created.sessionId, 0);

        for (const directoryPath of [uploadSessionsPath, sessionPath, filesPath]) {
          const stats = await fs.stat(directoryPath);
          expect(stats.mode & 0o777).toBe(0o700);
        }
        expect((await fs.stat(metaPath)).mode & 0o777).toBe(0o600);

        const originalRename = fsNative.promises.rename.bind(fsNative.promises);
        const renameFailure = Object.assign(new Error("injected atomic rename failure"), { code: "EIO" });
        const renameSpy = vi.spyOn(fsNative.promises, "rename").mockImplementation(async (source, target) => {
          if (target === metaPath) {
            throw renameFailure;
          }
          return originalRename(source, target);
        });
        try {
          await expect(appendUploadSessionChunk({
            userDataPath,
            sessionId: created.sessionId,
            fileIndex: 0,
            offset: 0,
            buffer: payload,
            owner: OWNER_A
          })).rejects.toBe(renameFailure);
        } finally {
          renameSpy.mockRestore();
        }

        await expect(readJson(metaPath)).resolves.toMatchObject({
          status: "uploading",
          files: [{ receivedBytes: 0, completedAt: "" }]
        });
        expect((await fs.stat(metaPath)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
        await expect(fs.readFile(filePath)).resolves.toEqual(payload);
        expect((await fs.readdir(sessionPath)).some((entry) => entry.endsWith(".tmp"))).toBe(false);

        await expect(getUploadSession(userDataPath, created.sessionId, { owner: OWNER_A })).resolves.toMatchObject({
          status: "complete",
          files: [{ receivedBytes: payload.length, completed: true }]
        });
      });
    } finally {
      process.umask(previousUmask);
    }
  });

  it("materializes and verifies a real zero-byte part file", async () => {
    await withTempUserData(async (userDataPath) => {
      const emptySha256 = sha256(Buffer.alloc(0));
      const created = await createOrResumeUploadSession({
        userDataPath,
        checkpoint: { checkpointId: "client-checkpoint-empty" },
        manifest: {
          manifestDigest: sha256("manifest-empty"),
          inputDigest: sha256("input-empty")
        },
        owner: OWNER_A,
        files: [{
          relativePath: "empty.bin",
          sha256: emptySha256,
          byteSize: 0
        }]
      });

      expect(created).toMatchObject({
        status: "complete",
        files: [{ byteSize: 0, receivedBytes: 0, completed: true }]
      });
      const filePath = sessionFilePath(userDataPath, created.sessionId, 0);
      expect(await fs.readFile(filePath)).toEqual(Buffer.alloc(0));
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      const [resolved] = await resolveUploadSessionFiles(userDataPath, created.sessionId, {
        owner: OWNER_A
      });
      expect(resolved).toMatchObject({
        stagedPath: filePath,
        byteSize: 0,
        sha256: emptySha256
      });

      await expect(createOrResumeUploadSession({
        userDataPath,
        checkpoint: { checkpointId: "client-checkpoint-empty-invalid" },
        manifest: { manifestDigest: sha256("manifest-empty-invalid") },
        owner: OWNER_A,
        files: [{
          relativePath: "empty-invalid.bin",
          sha256: sha256("not-empty"),
          byteSize: 0
        }]
      })).rejects.toThrow("files[0].sha256 与零字节文件不匹配。");
    });
  });

  it("rejects file, session and chunk declarations above server safety ceilings", async () => {
    await withTempUserData(async (userDataPath) => {
      const base = {
        userDataPath,
        manifest: { manifestDigest: sha256("quota-manifest") },
        owner: OWNER_A
      };
      await expect(createOrResumeUploadSession({
        ...base,
        checkpoint: { checkpointId: "quota-file-count" },
        files: Array.from({ length: UPLOAD_SESSION_MAX_FILE_COUNT + 1 }, (_, index) => ({
          relativePath: `${index}.bin`,
          sha256: sha256(`file-${index}`),
          byteSize: 1
        }))
      })).rejects.toMatchObject({ code: "upload_file_count_exceeded", statusCode: 413 });

      await expect(createOrResumeUploadSession({
        ...base,
        checkpoint: { checkpointId: "quota-file-bytes" },
        files: [{
          relativePath: "large.bin",
          sha256: sha256("large"),
          byteSize: UPLOAD_SESSION_MAX_FILE_BYTES + 1
        }]
      })).rejects.toMatchObject({ code: "upload_file_bytes_exceeded", statusCode: 413 });

      await expect(createOrResumeUploadSession({
        ...base,
        checkpoint: { checkpointId: "quota-session-bytes" },
        files: Array.from({ length: 5 }, (_, index) => ({
          relativePath: `part-${index}.bin`,
          sha256: sha256(`part-${index}`),
          byteSize: index === 4 ? 1 : UPLOAD_SESSION_MAX_FILE_BYTES
        }))
      })).rejects.toMatchObject({ code: "upload_session_bytes_exceeded", statusCode: 413 });

      await expect(createOrResumeUploadSession({
        ...base,
        checkpoint: { checkpointId: "quota-source-metadata" },
        files: [{
          relativePath: "metadata.bin",
          sha256: sha256("metadata"),
          byteSize: 8,
          sourceMetadata: { value: "x".repeat(UPLOAD_SESSION_MAX_SOURCE_METADATA_BYTES) }
        }]
      })).rejects.toMatchObject({
        code: "upload_source_metadata_bytes_exceeded",
        statusCode: 413
      });
      expect(startCheckpointTreeMock).not.toHaveBeenCalled();

      const created = await createOrResumeUploadSession({
        ...base,
        checkpoint: { checkpointId: "quota-chunk" },
        files: [{
          relativePath: "chunk.bin",
          sha256: sha256("chunk"),
          byteSize: UPLOAD_SESSION_MAX_CHUNK_BYTES + 1
        }]
      });
      await expect(appendUploadSessionChunk({
        userDataPath,
        sessionId: created.sessionId,
        fileIndex: 0,
        offset: 0,
        buffer: Buffer.alloc(UPLOAD_SESSION_MAX_CHUNK_BYTES + 1),
        owner: OWNER_A
      })).resolves.toMatchObject({ ok: false, code: "chunk_bytes_exceeded" });
    });
  });

  it("serializes owner admission and removes expired session artifacts in bounded cleanup", async () => {
    await withTempUserData(async (userDataPath) => {
      const files = [{ relativePath: "pending.bin", sha256: sha256("pending"), byteSize: 7 }];
      for (let index = 0; index < UPLOAD_SESSION_MAX_ACTIVE_PER_OWNER_SCOPE; index += 1) {
        await createOrResumeUploadSession({
          userDataPath,
          checkpoint: { checkpointId: `active-${index}` },
          manifest: { manifestDigest: sha256(`active-manifest-${index}`) },
          owner: OWNER_A,
          files
        });
      }
      await expect(createOrResumeUploadSession({
        userDataPath,
        checkpoint: { checkpointId: "active-overflow" },
        manifest: { manifestDigest: sha256("active-overflow-manifest") },
        owner: OWNER_A,
        files
      })).rejects.toMatchObject({
        code: "upload_owner_active_capacity_exceeded",
        statusCode: 429
      });

      const expiredSessionIds = [];
      for (let index = 0; index < UPLOAD_SESSION_EXPIRY_CLEANUP_BATCH + 1; index += 1) {
        const expiredSessionId = `upload_session_${index.toString(16).padStart(32, "0")}`;
        expiredSessionIds.push(expiredSessionId);
        reserveUploadSessionAdmission({
          userDataPath,
          sessionId: expiredSessionId,
          ownerScopeKey: "expired-owner-scope",
          status: "complete",
          fileCount: 1,
          totalBytes: 1,
          nowMs: 0
        });
        const expiredPath = path.join(userDataPath, "upload-sessions", expiredSessionId);
        await fs.mkdir(expiredPath, { recursive: true });
        await fs.writeFile(path.join(expiredPath, "meta.json"), "{}", "utf8");
      }

      await createOrResumeUploadSession({
        userDataPath,
        checkpoint: { checkpointId: "cleanup-trigger" },
        manifest: { manifestDigest: sha256("cleanup-trigger-manifest") },
        owner: OWNER_B,
        files: []
      });
      const survivingExpiredArtifacts = await Promise.all(expiredSessionIds.map(async (sessionId) => {
        try {
          await fs.stat(path.join(userDataPath, "upload-sessions", sessionId));
          return sessionId;
        } catch {
          return null;
        }
      }));
      expect(survivingExpiredArtifacts.filter(Boolean)).toHaveLength(1);
    });
  });

  it("enforces the retained-session ceiling from the durable admission index", async () => {
    await withTempUserData(async (userDataPath) => {
      reserveUploadSessionAdmission({
        userDataPath,
        sessionId: `upload_session_${"a".repeat(32)}`,
        ownerScopeKey: "retained-owner",
        status: "complete",
        fileCount: 0,
        totalBytes: 0,
        nowMs: Date.now()
      });
      const database = new Database(path.join(userDataPath, "upload-sessions", "admission.sqlite"));
      try {
        const insert = database.prepare(`
          INSERT INTO upload_session_admission (
            session_id, owner_scope_key, status, declared_bytes, file_count,
            created_at_ms, expires_at_ms
          ) VALUES (?, 'retained-owner', 'complete', 0, 0, ?, ?)
        `);
        const nowMs = Date.now();
        database.transaction(() => {
          for (let index = 1; index < UPLOAD_SESSION_MAX_RETAINED; index += 1) {
            insert.run(`retained-${index}`, nowMs, nowMs + 60_000);
          }
        })();
      } finally {
        database.close();
      }

      await expect(createOrResumeUploadSession({
        userDataPath,
        checkpoint: { checkpointId: "retained-overflow" },
        manifest: { manifestDigest: sha256("retained-overflow") },
        owner: OWNER_A,
        files: []
      })).rejects.toMatchObject({ code: "upload_retained_capacity_exceeded", statusCode: 429 });
    });
  });
});
