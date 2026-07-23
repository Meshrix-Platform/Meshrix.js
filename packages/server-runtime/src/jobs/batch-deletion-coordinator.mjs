import fs from "node:fs/promises";
import path from "node:path";
import { resolveWithin } from "#lico/product-api";

const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function safePathSegment(value, label = "path segment") {
  const text = String(value || "").trim();
  if (!SAFE_PATH_SEGMENT_PATTERN.test(text) || text === "." || text === ".." || text.includes("/") || text.includes("\\") || text.includes("\0")) {
    throw new Error(`Invalid ${label}.`);
  }
  return text;
}

function getJobDirectory(userDataPath, jobId) {
  return path.join(userDataPath, "jobs", safePathSegment(jobId, "job id"));
}

function pathWithinRoot(candidatePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realpathOrResolved(candidatePath) {
  try {
    return await fs.realpath(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

async function assertManagedDeletionPath(targetPath, allowedRoots = []) {
  const selectedPath = path.resolve(String(targetPath || ""));
  const roots = allowedRoots
    .map((root) => String(root || "").trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));
  if (!roots.some((root) => pathWithinRoot(selectedPath, root))) {
    throw new Error("删除路径不在受管数据目录内，已拒绝。");
  }
  const realRoots = await Promise.all(roots.map(realpathOrResolved));
  const realParent = await realpathOrResolved(path.dirname(selectedPath));
  if (!realRoots.some((root) => pathWithinRoot(realParent, root))) {
    throw new Error("删除路径父目录不在受管数据目录内，已拒绝。");
  }
}

async function removePath(targetPath, { allowedRoots = [] } = {}) {
  if (!targetPath) {
    return;
  }

  await assertManagedDeletionPath(targetPath, allowedRoots);
  await fs.rm(targetPath, {
    recursive: true,
    force: true
  });
}

async function removeEmptyParentDirectories(startPath, stopPath) {
  let currentPath = startPath;
  while (currentPath && currentPath !== stopPath && pathWithinRoot(currentPath, stopPath)) {
    try {
      const entries = await fs.readdir(currentPath);
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

async function removeStorageObjectFiles({ userDataPath, objectRootPath, storageObjectPaths = [] }) {
  for (const relativePath of storageObjectPaths) {
    if (!relativePath) {
      continue;
    }
    const objectPath = resolveWithin(userDataPath, relativePath);
    await fs.rm(objectPath, { force: true });
    await removeEmptyParentDirectories(path.dirname(objectPath), objectRootPath);
  }
}

function mergeStorageObjectPaths(...pathGroups) {
  return [...new Set(pathGroups
    .flatMap((paths) => Array.isArray(paths) ? paths : [])
    .map((relativePath) => String(relativePath || "").trim())
    .filter(Boolean))];
}

export function createBatchDeletionCoordinator({ userDataPath, jobManager, storageProvider }) {
  const jobsRootPath = path.join(userDataPath, "jobs");
  const fallbackObjectRootPath = path.join(userDataPath, "objects");

  async function executeOperation(operation) {
    let current = operation;
    const ownerId = current.ownerId;
    const jobId = current.jobId || current.state?.jobId || ownerId;
    const artifactPaths = storageProvider.getObjectOwnerArtifactPaths(ownerId);
    const state = {
      jobId,
      jobDirectory: getJobDirectory(userDataPath, jobId),
      objectRootPath: artifactPaths.objectRootPath,
      storageObjectPaths: storageProvider.listObjectStoragePathsByOwner(ownerId),
      ...(current.state || {})
    };
    state.storageObjectPaths = mergeStorageObjectPaths(state.storageObjectPaths);

    if (!state.runtimeDeleted) {
      const deletedJob = await jobManager.deleteJob(state.jobId || ownerId);
      state.deletedJob = deletedJob || null;
      state.runtimeDeleted = true;
      current = storageProvider.updateDeletionOperation(current.operationId, {
        status: "metadata_pending",
        state
      });
    }

    if (!state.metadataDeleted) {
      const latestArtifactPaths = storageProvider.getObjectOwnerArtifactPaths(ownerId);
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
    async deleteBatch(batchId) {
      const existingJob = await jobManager.getJob(batchId);
      const requestedOwner = storageProvider.findObjectOwner(batchId);
      const effectiveOwnerId = existingJob?.archiveBatchId || requestedOwner?.archiveBatchId || batchId;
      const objectOwner = storageProvider.findObjectOwner(effectiveOwnerId) || requestedOwner;
      const effectiveJobId = existingJob?.id || objectOwner?.jobId || batchId;
      const existing = storageProvider.getDeletionOperationByOwnerId(effectiveOwnerId);
      if (!existing && !existingJob && !objectOwner) {
        return null;
      }
      const operation =
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
      } catch (error) {
        const latest = storageProvider.getDeletionOperationByOwnerId(effectiveOwnerId) || operation;
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
    async resumePendingDeletions() {
      const operations = storageProvider.listPendingDeletionOperations();
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
