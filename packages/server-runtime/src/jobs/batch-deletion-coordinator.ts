import fs from "node:fs/promises";
import path from "node:path";
import { resolveWithin } from "#meshrix/product-api";

const SAFE_PATH_SEGMENT_PATTERN: any = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function safePathSegment(value?: any, label: any = "path segment") : any {
  const text: any = String(value || "").trim();
  if (!SAFE_PATH_SEGMENT_PATTERN.test(text) || text === "." || text === ".." || text.includes("/") || text.includes("\\") || text.includes("\0")) {
    throw new Error(`Invalid ${label}.`);
  }
  return text;
}

function getJobDirectory(userDataPath?: any, jobId?: any) : any {
  return path.join(userDataPath, "jobs", safePathSegment(jobId, "job id"));
}

function pathWithinRoot(candidatePath?: any, rootPath?: any) : any {
  const relative: any = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realpathOrResolved(candidatePath?: any) : Promise<any> {
  try {
    return await fs.realpath(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

async function assertManagedDeletionPath(targetPath?: any, allowedRoots: any = []) : Promise<any> {
  const selectedPath: any = path.resolve(String(targetPath || ""));
  const roots: any = allowedRoots
    .map((root?: any) : any => String(root || "").trim())
    .filter(Boolean)
    .map((root?: any) : any => path.resolve(root));
  if (!roots.some((root?: any) : any => pathWithinRoot(selectedPath, root))) {
    throw new Error("删除路径不在受管数据目录内，已拒绝。");
  }
  const realRoots: any = await Promise.all(roots.map(realpathOrResolved));
  const realParent: any = await realpathOrResolved(path.dirname(selectedPath));
  if (!realRoots.some((root?: any) : any => pathWithinRoot(realParent, root))) {
    throw new Error("删除路径父目录不在受管数据目录内，已拒绝。");
  }
}

async function removePath(targetPath?: any, { allowedRoots = [] }: Record<string, any> = {}) : Promise<any> {
  if (!targetPath) {
    return;
  }

  await assertManagedDeletionPath(targetPath, allowedRoots);
  await fs.rm(targetPath, {
    recursive: true,
    force: true
  });
}

async function removeEmptyParentDirectories(startPath?: any, stopPath?: any) : Promise<any> {
  let currentPath: any = startPath;
  while (currentPath && currentPath !== stopPath && pathWithinRoot(currentPath, stopPath)) {
    try {
      const entries: any = await fs.readdir(currentPath);
      if (entries.length > 0) {
        return;
      }
      await fs.rmdir(currentPath);
    } catch {
      return;
    }
    currentPath = path.dirname(currentPath);
  }
}

async function removeStorageObjectFiles({ userDataPath, objectRootPath, storageObjectPaths = [] }: Record<string, any>) : Promise<any> {
  for (const relativePath of storageObjectPaths) {
    if (!relativePath) {
      continue;
    }
    const objectPath: any = resolveWithin(userDataPath, relativePath);
    await fs.rm(objectPath, { force: true });
    await removeEmptyParentDirectories(path.dirname(objectPath), objectRootPath);
  }
}

function mergeStorageObjectPaths(...pathGroups: any[]) : any {
  return [...new Set<any>(pathGroups
    .flatMap((paths?: any) : any => Array.isArray(paths) ? paths : [])
    .map((relativePath?: any) : any => String(relativePath || "").trim())
    .filter(Boolean))];
}

export function createBatchDeletionCoordinator({ userDataPath, jobManager, storageProvider }: Record<string, any>) : any {
  const jobsRootPath: any = path.join(userDataPath, "jobs");
  const fallbackObjectRootPath: any = path.join(userDataPath, "objects");

  async function executeOperation(operation?: any) : Promise<any> {
    let current: any = operation;
    const ownerId: any = current.ownerId;
    const jobId: any = current.jobId || current.state?.jobId || ownerId;
    const artifactPaths: any = storageProvider.getObjectOwnerArtifactPaths(ownerId);
    const state: Record<string, any> = {
      jobId,
      jobDirectory: getJobDirectory(userDataPath, jobId),
      objectRootPath: artifactPaths.objectRootPath,
      storageObjectPaths: storageProvider.listObjectStoragePathsByOwner(ownerId),
      ...(current.state || {})
    };
    state.storageObjectPaths = mergeStorageObjectPaths(state.storageObjectPaths);

    if (!state.runtimeDeleted) {
      const deletedJob: any = await jobManager.deleteJob(state.jobId || ownerId);
      state.deletedJob = deletedJob || null;
      state.runtimeDeleted = true;
      current = storageProvider.updateDeletionOperation(current.operationId, {
        status: "metadata_pending",
        state
      });
    }

    if (!state.metadataDeleted) {
      const latestArtifactPaths: any = storageProvider.getObjectOwnerArtifactPaths(ownerId);
      state.objectRootPath = latestArtifactPaths.objectRootPath || state.objectRootPath;
      state.objectBatchPath = latestArtifactPaths.objectBatchPath || state.objectBatchPath;
      state.storageObjectPaths = mergeStorageObjectPaths(
        state.storageObjectPaths,
        storageProvider.listObjectStoragePathsByOwner(ownerId)
      );
      storageProvider.deleteObjectRecordsByOwner(ownerId);
      state.metadataDeleted = true;
      current = storageProvider.updateDeletionOperation(current.operationId, {
        status: "artifact_cleanup_pending",
        state
      });
    }

    if (!state.artifactsDeleted) {
      await removeStorageObjectFiles({
        userDataPath,
        objectRootPath: state.objectRootPath,
        storageObjectPaths: state.storageObjectPaths
      });
      await removePath(state.objectBatchPath, {
        allowedRoots: [state.objectRootPath, fallbackObjectRootPath]
      });
      await removePath(state.jobDirectory, {
        allowedRoots: [jobsRootPath]
      });
      state.artifactsDeleted = true;
      current = storageProvider.updateDeletionOperation(current.operationId, {
        status: "completed",
        state
      });
    }

    storageProvider.deleteDeletionOperation(current.operationId);
    return {
      ok: true,
      deletedJob: state.deletedJob || null,
      batchId: ownerId
    };
  }

  return {
    async deleteBatch(batchId?: any) : Promise<any> {
      const existingJob: any = await jobManager.getJob(batchId);
      const requestedOwner: any = storageProvider.findObjectOwner(batchId);
      const effectiveOwnerId: any = existingJob?.archiveBatchId || requestedOwner?.archiveBatchId || batchId;
      const objectOwner: any = storageProvider.findObjectOwner(effectiveOwnerId) || requestedOwner;
      const effectiveJobId: any = existingJob?.id || objectOwner?.jobId || batchId;
      const existing: any = storageProvider.getDeletionOperationByOwnerId(effectiveOwnerId);
      if (!existing && !existingJob && !objectOwner) {
        return null;
      }
      const operation: any =
        existing ||
        storageProvider.upsertDeletionOperation({
          ownerId: effectiveOwnerId,
          jobId: effectiveJobId,
          status: "runtime_pending",
          state: {
            jobId: effectiveJobId,
            jobDirectory: getJobDirectory(userDataPath, effectiveJobId),
            objectRootPath: storageProvider.getObjectOwnerArtifactPaths(effectiveOwnerId).objectRootPath,
            storageObjectPaths: storageProvider.listObjectStoragePathsByOwner(effectiveOwnerId),
            runtimeDeleted: false,
            metadataDeleted: false,
            artifactsDeleted: false
          }
        });

      try {
        return await executeOperation(operation);
      } catch (error: any) {
        const latest: any = storageProvider.getDeletionOperationByOwnerId(effectiveOwnerId) || operation;
        storageProvider.updateDeletionOperation(operation.operationId, {
          status:
            latest.state?.metadataDeleted ? "artifact_cleanup_pending" : "metadata_pending",
          state: {
            ...latest.state
          },
          error: error instanceof Error ? error.message : "删除失败"
        });
        throw error;
      }
    },
    async resumePendingDeletions() : Promise<any> {
      const operations: any = storageProvider.listPendingDeletionOperations();
      for (const operation of operations) {
        try {
          await executeOperation(operation);
        } catch {
          // Keep the pending operation for the next retry cycle.
        }
      }
    }
  };
}
