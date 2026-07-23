import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backupMocks = vi.hoisted(() => ({
  BACKUP_RESTORE_PROTOCOL_VERSION: "v0.0.1:storage:backup-restore-1",
  createStorageBackup: vi.fn(async (input) => ({ kind: "create-backup", input })),
  listStorageBackups: vi.fn(async (input) => ({ kind: "list-backups", input })),
  restoreStorageBackup: vi.fn(async (input) => ({ kind: "restore-backup", input }))
}));
const retentionMocks = vi.hoisted(() => ({
  applyStorageBackupRetention: vi.fn(async (input) => ({ kind: "retention", input })),
  reconcileStorageRetentionTransactionsSync: vi.fn(() => ({ reconciled: 0 }))
}));
const catalogMocks = vi.hoisted(() => ({
  reconcileStorageBackupCatalogSync: vi.fn(() => ({ reconciled: true, backupCount: 0 }))
}));
const opsMocks = vi.hoisted(() => ({
  reconcileStorage: vi.fn(async (input) => ({ kind: "reconcile", input })),
  runStorageDoctor: vi.fn(async (input) => ({ kind: "doctor", input }))
}));

vi.mock("../../../packages/foundation/src/storage/backup-snapshot.mjs", () => ({
  createStorageBackup: backupMocks.createStorageBackup
}));
vi.mock("../../../packages/foundation/src/storage/backup-query.mjs", () => ({
  listStorageBackups: backupMocks.listStorageBackups
}));
vi.mock("../../../packages/foundation/src/storage/restore-execution.mjs", () => ({
  restoreStorageBackup: backupMocks.restoreStorageBackup
}));
vi.mock("../../../packages/foundation/src/storage/backup-retention.mjs", () => retentionMocks);
vi.mock("../../../packages/foundation/src/storage/backup-catalog.mjs", () => catalogMocks);
vi.mock("../../../packages/foundation/src/storage/ops-tools.mjs", () => opsMocks);

import { createStorageKernel } from "../../../packages/foundation/src/storage/storage-kernel.mjs";
import {
  createStorageProvider,
  STORAGE_PROTOCOL_VERSION
} from "../../../packages/foundation/src/storage/storage-provider.mjs";

const tempRoots = [];
const kernels = [];

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lico-storage-provider-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const kernel of kernels.splice(0)) {
    kernel.close();
  }
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("storage provider", () => {
  it("exposes only generic storage capabilities", () => {
    const storageKernel = {
      databasePath: "/data/metadata/lico.sqlite",
      objectRootPath: "/data/objects",
      getStorageSummary: vi.fn(() => ({
        databasePath: "/data/metadata/lico.sqlite",
        objectRootPath: "/data/objects",
        objectCount: 2
      }))
    };
    const provider = createStorageProvider({
      userDataPath: "/data",
      storageKernel
    });

    expect(Object.isFrozen(provider)).toBe(true);
    expect(provider.protocolVersion).toBe(STORAGE_PROTOCOL_VERSION);
    expect(provider.getStorageKernel()).toBe(storageKernel);
    expect(provider.getStorageSummary()).toMatchObject({ objectCount: 2 });
    expect(provider.listCapabilities()).toEqual({
      protocolVersion: STORAGE_PROTOCOL_VERSION,
      capabilities: [
        expect.objectContaining({ id: "storage-summary" }),
        expect.objectContaining({ id: "object-store" }),
        expect.objectContaining({ id: "storage-object-ownership" }),
        expect.objectContaining({ id: "maintenance" }),
        expect.objectContaining({ id: "durable-service-manifests" })
      ]
    });
    expect(Object.isFrozen(provider.getDurableManifestWriterPort())).toBe(true);
    expect(Object.isFrozen(provider.getDurableManifestReaderPort())).toBe(true);
    expect(Object.isFrozen(provider.getDurableManifestCandidateAuthorityPort())).toBe(true);
    expect(provider).not.toHaveProperty("serviceManifestStore");
    expect(provider).not.toHaveProperty("recordClientCheckIn");
    expect(provider).not.toHaveProperty("rebuildSourceVocabulary");
    expect(provider).not.toHaveProperty("readRawObjectById");
  });

  it("writes, records, resolves, stats, and reads generic objects", async () => {
    const userDataPath = await tempDir();
    const storageKernel = createStorageKernel({ userDataPath });
    kernels.push(storageKernel);
    expect(retentionMocks.reconcileStorageRetentionTransactionsSync).toHaveBeenCalledWith({ userDataPath });
    expect(catalogMocks.reconcileStorageBackupCatalogSync).toHaveBeenCalledWith({
      userDataPath,
      protocolVersion: backupMocks.BACKUP_RESTORE_PROTOCOL_VERSION
    });
    const provider = createStorageProvider({ userDataPath, storageKernel });

    const stored = await provider.putObject({
      namespace: "tests",
      fileName: "sample.txt",
      mediaType: "text/plain",
      buffer: Buffer.from("stored bytes"),
      metadata: {
        source: "unit",
        jobId: "storage-provider-job",
        archiveBatchId: "storage-provider-batch",
        ownerSubjectId: "storage-provider-owner"
      }
    });

    expect(stored).toMatchObject({
      namespace: "tests",
      fileName: "sample.txt",
      byteSize: 12,
      mediaType: "text/plain",
      metadata: {
        source: "unit",
        jobId: "storage-provider-job",
        archiveBatchId: "storage-provider-batch",
        ownerSubjectId: "storage-provider-owner"
      }
    });
    expect(provider.getStorageSummary().objectCount).toBe(1);
    expect(provider.getObject(stored.objectId)).toMatchObject({
      objectId: stored.objectId,
      storageRelativePath: stored.storageRelativePath,
      sha256: stored.sha256
    });
    expect(provider.findObjectOwner("storage-provider-job")).toMatchObject({
      objectId: stored.objectId,
      jobId: "storage-provider-job",
      archiveBatchId: "storage-provider-batch",
      ownerSubjectId: "storage-provider-owner"
    });
    expect(provider.findObjectOwner("storage-provider-batch")).toMatchObject({
      objectId: stored.objectId,
      jobId: "storage-provider-job"
    });
    expect(provider.listObjectStoragePathsByOwner("storage-provider-job"))
      .toEqual([stored.storageRelativePath]);
    await expect(provider.readObject({ storageRelativePath: stored.storageRelativePath }))
      .resolves.toEqual(Buffer.from("stored bytes"));
    await expect(provider.statObject({ storageRelativePath: stored.storageRelativePath }))
      .resolves.toMatchObject({ size: 12 });
    expect(provider.resolveStoredObjectPath(stored.storageRelativePath))
      .toBe(path.join(userDataPath, stored.storageRelativePath));
    expect(() => provider.resolveStoredObjectPath("../escape")).toThrow();
    expect(() => provider.resolveStoredObjectPath("settings.json")).toThrow();
  });

  it("keeps distinct object identities on distinct paths after lossy-name normalization", async () => {
    const userDataPath = await tempDir();
    const storageKernel = createStorageKernel({ userDataPath });
    kernels.push(storageKernel);
    const provider = createStorageProvider({ userDataPath, storageKernel });
    const input = {
      namespace: "identity-collision",
      fileName: "same.bin",
      mediaType: "application/octet-stream",
      buffer: Buffer.from("same bytes")
    };

    const first = await provider.putObject({ ...input, objectId: "a" });
    const second = await provider.putObject({ ...input, objectId: "x/a" });

    expect(first.storageRelativePath).not.toBe(second.storageRelativePath);
    expect(provider.getObject("a")).toMatchObject({ storageRelativePath: first.storageRelativePath });
    expect(provider.getObject("x/a")).toMatchObject({ storageRelativePath: second.storageRelativePath });
    await expect(provider.readObject({ storageRelativePath: first.storageRelativePath }))
      .resolves.toEqual(Buffer.from("same bytes"));
    await expect(provider.readObject({ storageRelativePath: second.storageRelativePath }))
      .resolves.toEqual(Buffer.from("same bytes"));
  });

  it("publishes buffered objects only after the staged file and destination directories are durable", async () => {
    const userDataPath = await tempDir();
    const storageKernel = createStorageKernel({ userDataPath });
    kernels.push(storageKernel);
    const provider = createStorageProvider({ userDataPath, storageKernel });
    const pendingDirectory = path.join(userDataPath, "objects", ".pending");
    const events = [];
    const originalOpen = fs.open.bind(fs);
    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filePath, ...args) => {
      const handle = await originalOpen(filePath, ...args);
      const resolvedPath = path.resolve(String(filePath));
      const flags = args[0];
      let kind = "other";
      if (resolvedPath === path.resolve(pendingDirectory)) kind = "pending-directory";
      else if (flags === "wx" && resolvedPath.startsWith(`${path.resolve(pendingDirectory)}${path.sep}`)) {
        kind = "temporary-file";
      } else if (flags === "r" && resolvedPath.includes(`${path.sep}objects${path.sep}`)) {
        kind = "target-directory";
      }
      if (kind !== "other") {
        const originalSync = handle.sync.bind(handle);
        Object.defineProperty(handle, "sync", {
          configurable: true,
          value: async (...syncArgs) => {
            events.push(`${kind}:sync`);
            return originalSync(...syncArgs);
          }
        });
      }
      return handle;
    });
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      events.push("rename");
      return originalRename(...args);
    });

    const stored = await provider.putObject({
      objectId: "durable-buffer-object",
      namespace: "tests",
      fileName: "durable.bin",
      buffer: Buffer.from("durable buffered bytes")
    });

    expect(events).toEqual([
      "temporary-file:sync",
      "rename",
      "target-directory:sync",
      "pending-directory:sync"
    ]);
    expect((await fs.stat(pendingDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(provider.resolveStoredObjectPath(stored.storageRelativePath))).mode & 0o777)
      .toBe(0o600);
    expect(await fs.readdir(pendingDirectory)).toEqual([]);
  });

  it("deduplicates matching buffered retries and refuses a conflicting destination", async () => {
    const userDataPath = await tempDir();
    const storageKernel = createStorageKernel({ userDataPath });
    kernels.push(storageKernel);
    const provider = createStorageProvider({ userDataPath, storageKernel });
    const input = {
      objectId: "buffer-retry-object",
      namespace: "tests",
      fileName: "retry.bin",
      buffer: Buffer.from("stable buffered bytes")
    };
    const first = await provider.putObject(input);
    const retry = await provider.putObject(input);
    expect(retry.storageRelativePath).toBe(first.storageRelativePath);

    const targetPath = provider.resolveStoredObjectPath(first.storageRelativePath);
    await fs.writeFile(targetPath, Buffer.alloc(input.buffer.length, 0x78));
    await expect(provider.putObject(input)).rejects.toMatchObject({
      code: "storage_object_integrity_mismatch"
    });
    expect(await fs.readFile(targetPath)).toEqual(Buffer.alloc(input.buffer.length, 0x78));
    expect(await fs.readdir(path.join(userDataPath, "objects", ".pending"))).toEqual([]);
  });

  it("does not publish metadata or retain staging bytes when buffered-object rename fails", async () => {
    const userDataPath = await tempDir();
    const storageKernel = createStorageKernel({ userDataPath });
    kernels.push(storageKernel);
    const provider = createStorageProvider({ userDataPath, storageKernel });
    const originalRename = fs.rename.bind(fs);
    let injected = false;
    vi.spyOn(fs, "rename").mockImplementation(async (sourcePath, targetPath) => {
      if (!injected && String(sourcePath).includes(`${path.sep}.pending${path.sep}`)) {
        injected = true;
        const error = new Error("injected buffered-object rename failure");
        error.code = "EIO";
        throw error;
      }
      return originalRename(sourcePath, targetPath);
    });

    await expect(provider.putObject({
      objectId: "buffer-rename-failure",
      namespace: "tests",
      fileName: "failure.bin",
      buffer: Buffer.from("unpublished bytes")
    })).rejects.toMatchObject({ code: "EIO" });
    expect(injected).toBe(true);
    expect(provider.getObject("buffer-rename-failure")).toBeNull();
    expect(await fs.readdir(path.join(userDataPath, "objects", ".pending"))).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "refuses a buffered-object destination symlink without modifying its target",
    async () => {
      const userDataPath = await tempDir();
      const storageKernel = createStorageKernel({ userDataPath });
      kernels.push(storageKernel);
      const provider = createStorageProvider({ userDataPath, storageKernel });
      const input = {
        objectId: "buffer-symlink-object",
        namespace: "tests",
        fileName: "symlink.bin",
        buffer: Buffer.from("expected bytes")
      };
      const stored = await provider.putObject(input);
      const targetPath = provider.resolveStoredObjectPath(stored.storageRelativePath);
      const externalPath = path.join(userDataPath, "external-target.bin");
      await fs.writeFile(externalPath, "external bytes", "utf8");
      await fs.unlink(targetPath);
      await fs.symlink(externalPath, targetPath);

      await expect(provider.putObject(input)).rejects.toMatchObject({
        code: "storage_object_file_unsafe"
      });
      expect(await fs.readFile(externalPath, "utf8")).toBe("external bytes");
      expect((await fs.lstat(targetPath)).isSymbolicLink()).toBe(true);
      expect(await fs.readdir(path.join(userDataPath, "objects", ".pending"))).toEqual([]);
    }
  );

  it("persists and resumes storage deletion journal state", async () => {
    const userDataPath = await tempDir();
    const storageKernel = createStorageKernel({ userDataPath });
    kernels.push(storageKernel);
    const provider = createStorageProvider({ userDataPath, storageKernel });

    const created = provider.upsertDeletionOperation({
      operationId: "storage-delete-operation",
      ownerId: "storage-delete-owner",
      jobId: "storage-delete-job",
      status: "runtime_pending",
      state: { runtimeDeleted: false }
    });
    expect(created).toMatchObject({
      operationId: "storage-delete-operation",
      ownerId: "storage-delete-owner",
      jobId: "storage-delete-job",
      status: "runtime_pending",
      state: { runtimeDeleted: false }
    });
    expect(provider.upsertDeletionOperation({ ownerId: "storage-delete-owner" }))
      .toEqual(created);

    const updated = provider.updateDeletionOperation(created.operationId, {
      status: "artifact_cleanup_pending",
      state: { runtimeDeleted: true, metadataDeleted: true }
    });
    expect(updated).toMatchObject({
      status: "artifact_cleanup_pending",
      state: { runtimeDeleted: true, metadataDeleted: true }
    });
    expect(provider.listPendingDeletionOperations()).toEqual([updated]);

    storageKernel.close();
    kernels.splice(kernels.indexOf(storageKernel), 1);
    const reopenedKernel = createStorageKernel({ userDataPath });
    kernels.push(reopenedKernel);
    const reopenedProvider = createStorageProvider({
      userDataPath,
      storageKernel: reopenedKernel
    });
    expect(reopenedProvider.getDeletionOperationByOwnerId("storage-delete-owner"))
      .toEqual(updated);
    expect(reopenedProvider.listPendingDeletionOperations()).toEqual([updated]);
    expect(reopenedProvider.deleteDeletionOperation(created.operationId)).toBe(1);
    expect(reopenedProvider.getDeletionOperationByOwnerId("storage-delete-owner")).toBeNull();
  });

  it("delegates maintenance, backup, and restore operations with normalized options", async () => {
    const provider = createStorageProvider({
      userDataPath: "/data"
    });

    await expect(provider.runDoctor()).resolves.toEqual({
      kind: "doctor",
      input: { userDataPath: "/data" }
    });
    await expect(provider.reconcile({ apply: false, pruneOrphanObjects: true })).resolves.toEqual({
      kind: "reconcile",
      input: {
        userDataPath: "/data",
        apply: false,
        pruneOrphanObjects: true
      }
    });
    await expect(provider.listBackups()).resolves.toEqual({
      kind: "list-backups",
      input: { userDataPath: "/data" }
    });
    await expect(provider.createBackup({ label: "daily" })).resolves.toMatchObject({
      kind: "create-backup",
      input: { userDataPath: "/data", label: "daily", artifactClassifiers: [] }
    });
    await expect(provider.restoreBackupPreview({ backupId: "b1", includePaths: ["state.json"] })).resolves.toMatchObject({
      kind: "restore-backup",
      input: {
        userDataPath: "/data",
        backupId: "b1",
        dryRun: true,
        includePaths: ["state.json"]
      }
    });
    await expect(provider.restoreBackup({ backupId: "b1", confirm: true })).resolves.toMatchObject({
      kind: "restore-backup",
      input: {
        userDataPath: "/data",
        backupId: "b1",
        dryRun: false,
        apply: true,
        includePaths: []
      }
    });
    await expect(provider.applyBackupRetention({ policy: { keepLast: 2 } })).resolves.toMatchObject({
      kind: "retention",
      input: {
        userDataPath: "/data",
        policy: { keepLast: 2 }
      }
    });
  });

  it("returns an empty storage summary contract without a kernel", () => {
    const provider = createStorageProvider({ userDataPath: "/data" });

    expect(provider.getStorageSummary()).toEqual({
      databasePath: "/data/metadata/lico.sqlite",
      objectRootPath: "/data/objects",
      databaseExists: false,
      objectCount: 0,
      ownedObjectCount: 0,
      deletionOperationCount: 0,
      opaqueCustodyArtifactCount: 0,
      opaqueCustodyPromotionCount: 0,
      objectFileCount: 0,
      objectBytes: 0
    });
  });

  it.skipIf(process.platform === "win32")(
    "enforces private modes for core storage directories and SQLite state",
    async () => {
      const userDataPath = await tempDir();
      await fs.chmod(userDataPath, 0o755);
      const previousMask = process.umask(0o022);
      let storageKernel;
      try {
        storageKernel = createStorageKernel({ userDataPath });
      } finally {
        process.umask(previousMask);
      }
      kernels.push(storageKernel);

      expect((await fs.stat(path.join(userDataPath, "metadata"))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(userDataPath, "objects"))).mode & 0o777).toBe(0o700);
      const sqliteFiles = (await fs.readdir(path.join(userDataPath, "metadata")))
        .filter((name) => /^lico\.sqlite(?:-(?:wal|shm|journal))?$/u.test(name))
        .map((name) => path.join(userDataPath, "metadata", name));
      expect(sqliteFiles.length).toBeGreaterThanOrEqual(1);
      for (const filePath of sqliteFiles) {
        expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symbolic-link core SQLite boundary before opening storage",
    async () => {
      const userDataPath = await tempDir();
      const metadataPath = path.join(userDataPath, "metadata");
      const externalPath = path.join(userDataPath, "external.sqlite");
      await fs.mkdir(metadataPath, { recursive: true });
      await fs.writeFile(externalPath, "not-a-database", "utf8");
      await fs.symlink(externalPath, path.join(metadataPath, "lico.sqlite"));

      expect(() => createStorageKernel({ userDataPath })).toThrow(
        expect.objectContaining({ code: "private_sqlite_boundary_invalid" })
      );
      await expect(fs.readFile(externalPath, "utf8")).resolves.toBe("not-a-database");
    }
  );
});
