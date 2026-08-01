import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createStorageKernel } from "../../../packages/foundation/src/storage/storage-kernel.ts";
import {
  locateStorageEntity,
  reconcileStorage,
  runStorageDoctor
} from "../../../packages/foundation/src/storage/ops-tools.ts";
import { createStorageProvider } from "../../../packages/foundation/src/storage/storage-provider.ts";
import { putStoredObjectFromFile } from "../../../packages/foundation/src/storage/object-store.ts";

const tempRoots: any[] = [];
const kernels: any[] = [];

async function createHarness() : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-storage-ops-"));
  tempRoots.push(userDataPath);
  const storageKernel: any = createStorageKernel({ userDataPath });
  kernels.push(storageKernel);
  return {
    userDataPath,
    storageKernel,
    storageProvider: createStorageProvider({ userDataPath, storageKernel })
  };
}

async function writeJobArtifacts(userDataPath?: any, {
  jobId = "storage-ops-job",
  status = "completed"
}: Record<string, any> = {}) : Promise<any> {
  const jobDirectory: any = path.join(userDataPath, "jobs", jobId);
  await fs.mkdir(jobDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(jobDirectory, "meta.json"),
      JSON.stringify({ id: jobId, status }),
      "utf8"
    ),
    fs.writeFile(path.join(jobDirectory, "payload.json"), "{}", "utf8"),
    fs.writeFile(path.join(jobDirectory, "result.json"), "{}", "utf8")
  ]);
  return jobDirectory;
}

afterEach(async () : Promise<any> => {
  for (const kernel of kernels.splice(0)) kernel.close();
  await Promise.all(tempRoots.splice(0).map((root?: any) : any =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

describe("canonical storage operations", () : any => {
  it("verifies physical bytes before accepting an idempotent database-backed object retry", async () : Promise<any> => {
    const { userDataPath, storageProvider } = await createHarness();
    const content: any = Buffer.from("verified retry bytes");
    const sourcePath: any = path.join(userDataPath, "staging", "retry.bin");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, content);
    const input: Record<string, any> = {
      objectId: "storage-retry-object",
      namespace: "tests",
      fileName: "retry.bin",
      sourcePath,
      expectedSha256: createHash("sha256").update(content).digest("hex"),
      expectedByteSize: content.length
    };

    const [stored] = await storageProvider.putObjectsFromFiles([input]);
    const storedPath: any = storageProvider.resolveStoredObjectPath(stored.storageRelativePath);
    await fs.writeFile(storedPath, Buffer.alloc(content.length, 0x78));

    await expect(storageProvider.putObjectsFromFiles([input])).rejects.toMatchObject({
      code: "storage_object_integrity_mismatch"
    });
    expect(await fs.readFile(storedPath)).toEqual(Buffer.alloc(content.length, 0x78));
  });

  it("hashes an existing object-store destination instead of trusting an equal byte size", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-storage-object-retry-"));
    tempRoots.push(userDataPath);
    const content: any = Buffer.from("direct retry bytes");
    const sourcePath: any = path.join(userDataPath, "staging", "direct.bin");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, content);
    const input: Record<string, any> = {
      userDataPath,
      objectId: "direct-retry-object",
      namespace: "tests",
      fileName: "direct.bin",
      sourcePath,
      expectedSha256: createHash("sha256").update(content).digest("hex"),
      expectedByteSize: content.length
    };

    const first: any = await putStoredObjectFromFile(input);
    await expect(putStoredObjectFromFile(input)).resolves.toMatchObject({
      storageRelativePath: first.storageRelativePath,
      sha256: first.sha256,
      byteSize: first.byteSize
    });
    const storedPath: any = path.join(userDataPath, first.storageRelativePath);
    await fs.writeFile(storedPath, Buffer.alloc(content.length, 0x79));

    await expect(putStoredObjectFromFile(input)).rejects.toMatchObject({
      code: "storage_object_integrity_mismatch"
    });
    expect(await fs.readFile(storedPath)).toEqual(Buffer.alloc(content.length, 0x79));
    expect(await fs.readdir(path.join(userDataPath, "objects", ".pending"))).toEqual([]);
  });

  it("diagnoses and locates a fresh canonical database without retired domain tables", async () : Promise<any> => {
    const { userDataPath, storageProvider } = await createHarness();
    await writeJobArtifacts(userDataPath);
    const stored: any = await storageProvider.putObject({
      objectId: "storage-ops-object",
      namespace: "tests",
      fileName: "source.bin",
      buffer: Buffer.from("canonical storage bytes"),
      metadata: {
        jobId: "storage-ops-job",
        archiveBatchId: "storage-ops-batch",
        ownerSubjectId: "storage-ops-owner",
        originalFileName: "source.bin"
      }
    });

    const doctor: any = await runStorageDoctor({ userDataPath });
    expect(doctor).toMatchObject({
      databasePresent: true,
      healthy: true,
      summary: {
        objectCount: 1,
        ownedObjectCount: 1,
        deletionOperationCount: 0,
        objectFileCount: 1,
        objectBytes: stored.byteSize,
        jobDirectoryCount: 1
      }
    });
    expect((Object.values(doctor.issues) as any[]).every((entries?: any) : any => entries.length === 0)).toBe(true);

    const byJob: any = await locateStorageEntity({
      userDataPath,
      jobId: "storage-ops-job"
    });
    expect(byJob).toMatchObject({
      job: {
        jobId: "storage-ops-job",
        meta: { id: "storage-ops-job", status: "completed" }
      },
      ownership: {
        jobId: "storage-ops-job",
        archiveBatchId: "storage-ops-batch",
        objectCount: 1,
        sampleObjects: [{
          objectId: stored.objectId,
          storageRelativePath: stored.storageRelativePath,
          ownerSubjectId: "storage-ops-owner"
        }]
      }
    });

    const byBatch: any = await locateStorageEntity({
      userDataPath,
      batchId: "storage-ops-batch"
    });
    expect(byBatch.ownership).toMatchObject({
      jobId: "storage-ops-job",
      archiveBatchId: "storage-ops-batch",
      objectCount: 1
    });

    const byObject: any = await locateStorageEntity({
      userDataPath,
      objectId: stored.objectId
    });
    expect(byObject.object).toMatchObject({
      objectId: stored.objectId,
      jobId: "storage-ops-job",
      archiveBatchId: "storage-ops-batch",
      exists: true
    });
  });

  it("reports content corruption and safely prunes only unreferenced object files", async () : Promise<any> => {
    const { userDataPath, storageProvider } = await createHarness();
    await writeJobArtifacts(userDataPath);
    const stored: any = await storageProvider.putObject({
      objectId: "storage-ops-corrupt-object",
      namespace: "tests",
      fileName: "corrupt.bin",
      buffer: Buffer.from("canonical storage bytes"),
      metadata: {
        jobId: "storage-ops-job",
        archiveBatchId: "storage-ops-batch"
      }
    });
    const storedPath: any = storageProvider.resolveStoredObjectPath(stored.storageRelativePath);
    await fs.writeFile(storedPath, Buffer.alloc(stored.byteSize, 0x78));
    const orphanPath: any = path.join(userDataPath, "objects", "tests", "orphan.bin");
    await fs.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.writeFile(orphanPath, "orphan", "utf8");
    storageProvider.upsertDeletionOperation({
      operationId: "completed-storage-deletion",
      ownerId: "completed-storage-owner",
      jobId: "completed-storage-job",
      status: "completed"
    });

    const before: any = await runStorageDoctor({ userDataPath });
    expect(before.healthy).toBe(false);
    expect(before.issues.objectDigestMismatches).toEqual([{
      objectId: stored.objectId,
      storageRelativePath: stored.storageRelativePath
    }]);
    expect(before.issues.orphanObjectFiles).toEqual([
      expect.objectContaining({ storageRelativePath: "objects/tests/orphan.bin" })
    ]);
    expect(before.issues.completedDeletionOperations).toHaveLength(1);

    const reconciled: any = await reconcileStorage({
      userDataPath,
      apply: true,
      pruneOrphanObjects: true
    });
    expect(reconciled).toMatchObject({
      appliedActions: {
        removedCompletedDeletionOperations: 1,
        prunedOrphanObjectFiles: 1
      },
      healthyAfter: false
    });
    await expect(fs.stat(orphanPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(storedPath)).resolves.toMatchObject({ size: stored.byteSize });
    expect(reconciled.doctor.issues.objectDigestMismatches).toHaveLength(1);
    expect(reconciled.doctor.issues.completedDeletionOperations).toEqual([]);
  });
});
