import fs from "node:fs";
import path from "node:path";
import {
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  assertWorkspaceFileContentPolicy,
  nowIso,
  stripExecutableMode
} from "./agent-workspace-support.mjs";
import { readOrdinaryFileNoFollow } from "./agent-workspace-local-directory-safe-fs.mjs";

function basenameStartsWithDot(value) {
  return path.posix.basename(String(value || "").replace(/\\/g, "/")).startsWith(".");
}

function directoryEntryMetadata() {
  return { type: "directory", sizeBytes: 0 };
}

function collectFilesystemEntries(absolutePath, relativePath, stat) {
  if (basenameStartsWithDot(relativePath)) {
    throw new Error("不允许操作以 . 开头的路径。");
  }
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error("只能操作普通文件或目录。");
  }
  const entries = [{
    absolutePath,
    relativePath,
    stat,
    type: stat.isDirectory() ? "directory" : "file"
  }];
  if (!stat.isDirectory()) {
    return entries;
  }
  const children = fs.readdirSync(absolutePath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (child.name.startsWith(".")) {
      throw new Error(`不允许操作以 . 开头的路径：${relativePath}/${child.name}`);
    }
    const childRelativePath = `${relativePath}/${child.name}`;
    const childAbsolutePath = path.join(absolutePath, child.name);
    const childStat = fs.lstatSync(childAbsolutePath);
    entries.push(...collectFilesystemEntries(childAbsolutePath, childRelativePath, childStat));
  }
  return entries;
}

export function createAgentWorkspaceLocalDirectoryMutations({
  workspaceForStorage,
  decodeWorkspaceFileContent,
  updateWorkspaceTimeStmt,
  filePayloadMetadata,
  commitWorkspaceFileState,
  recordWorkspaceFileCheckpoint,
  resolveLocalDirectoryMountPath,
  localDirectoryFileMetadataFromStat,
  localDirectoryAccessReceipt,
  publicLocalDirectoryMount,
  archiveLocalDirectoryContent,
  mountMutationKey,
  captureLocalDirectoryPreimage,
  validateLocalDirectoryPreimage,
  rollbackLocalDirectoryMutation,
  workspacePreimageSnapshot,
  writeFileAtomically,
  ensureDirectorySafely,
  removePathSafely,
  renamePathSafely
} = {}) {
  function accessReceipt({ workspaceId, mountRef, operationId, path: relativePath, action }) {
    return localDirectoryAccessReceipt({ workspaceId, mountRef, operationId, path: relativePath, action });
  }

  function snapshotContentRefs(snapshot = {}) {
    return snapshot.entries?.map((entry) => entry.contentCid).filter(Boolean) || [];
  }

  function snapshotExistingEntries(snapshot = {}) {
    return (snapshot.entries || []).filter((entry) => entry.state !== "missing");
  }

  function safeMutationFailure(error, { rolledBack = false } = {}) {
    const known = String(error?.code || "").startsWith("local_directory_");
    return {
      ok: false,
      status: Math.max(400, Number(error?.status || (error?.code === "ENOTEMPTY" ? 409 : 500)) || 500),
      code: known ? error.code : "local_directory_mutation_failed",
      error: known
        ? error.message
        : rolledBack
          ? "本机目录 mutation 未完成，已恢复 mutation 前状态。"
          : "本机目录 mutation 未完成。"
    };
  }

  async function capturePreimage({ access, input, relativePaths, operationId }) {
    try {
      return {
        ok: true,
        capture: await captureLocalDirectoryPreimage({
          workspace: access.workspace,
          input,
          relativePaths,
          operationId
        })
      };
    } catch (error) {
      return { ok: false, result: safeMutationFailure(error) };
    }
  }

  async function rollbackMutation({ access, preimage, operationId, stateCommit = null }) {
    const projection = await rollbackLocalDirectoryMutation({
      workspace: access.workspace,
      snapshot: preimage.snapshot
    });
    updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
    if (stateCommit?.commitId) {
      const compensation = await commitWorkspaceFileState({
        workspace: access.workspace,
        operationId: `${operationId}.rollback`,
        mutations: projection.mutations,
        contentRefs: projection.contentRefs,
        payload: {
          action: "localDir.mutation.rollback",
          failedOperationId: operationId,
          mountRef: preimage.snapshot.mountRef
        }
      });
      if (!compensation?.commitId) {
        const error = new Error("本机目录 mutation 回滚后的状态补偿提交失败。");
        error.code = "local_directory_state_compensation_failed";
        error.status = 500;
        throw error;
      }
    }
  }

  function requireStateCommit(stateCommit) {
    if (!stateCommit?.commitId) {
      const error = new Error("本机目录 mutation 状态提交不可用。");
      error.code = "local_directory_state_commit_unavailable";
      error.status = 503;
      throw error;
    }
    return stateCommit;
  }

  function requireCheckpoint(checkpoint) {
    if (!checkpoint?.nodeId) {
      const error = new Error("本机目录 mutation checkpoint 不可用。");
      error.code = "local_directory_checkpoint_unavailable";
      error.status = 503;
      throw error;
    }
    return checkpoint;
  }

  async function archivePostimageEntry({ workspace, mount, entry, operationId, mountRef, root }) {
    if (entry.type === "directory") {
      return {
        mutation: {
          action: "put",
          key: mountMutationKey(mountRef, entry.relativePath),
          valueRef: "",
          metadata: directoryEntryMetadata()
        },
        contentRefs: []
      };
    }
    const { content, stat } = readOrdinaryFileNoFollow(root, entry.absolutePath);
    const archived = await archiveLocalDirectoryContent(content, {
      operationId,
      mountRef,
      relativePath: entry.relativePath,
      postimage: true
    });
    if (!archived?.rootCid) {
      const error = new Error("本机目录 postimage CAS 归档不可用。");
      error.code = "local_directory_postimage_unavailable";
      error.status = 503;
      throw error;
    }
    const file = localDirectoryFileMetadataFromStat({
      workspaceId: workspace.workspaceId,
      mount,
      relativePath: entry.relativePath,
      absolutePath: entry.absolutePath,
      stat,
      includeHash: true,
      rootPath: root,
      contentBuffer: content
    });
    return {
      mutation: {
        action: "put",
        key: mountMutationKey(mountRef, entry.relativePath),
        valueRef: archived?.rootCid || "",
        metadata: filePayloadMetadata(file)
      },
      contentRefs: archived?.contentRefs || [],
      file,
      archived
    };
  }

  async function postimageMutations({ workspace, mount, entries, operationId, mountRef, root }) {
    const mutations = [];
    const contentRefs = [];
    let primaryFile = null;
    for (const entry of entries) {
      const recorded = await archivePostimageEntry({ workspace, mount, entry, operationId, mountRef, root });
      mutations.push(recorded.mutation);
      contentRefs.push(...recorded.contentRefs);
      primaryFile ||= recorded.file || null;
    }
    return { mutations, contentRefs, primaryFile };
  }

  async function writeLocalDirectoryFile(input = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    const explicitPath = String(input.path || input.relativePath || input.filePath || input["file-path"] || "").trim();
    if (!explicitPath) {
      return { ok: false, status: 400, error: "path 不能为空。" };
    }
    if (basenameStartsWithDot(explicitPath)) {
      return { ok: false, status: 400, error: "不允许操作以 . 开头的文件。" };
    }
    let contentBuffer;
    try {
      contentBuffer = decodeWorkspaceFileContent(input);
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    let resolved;
    try {
      resolved = resolveLocalDirectoryMountPath(input, access.workspace, {
        allowEmpty: false,
        allowMissing: true,
        allowDirectory: false,
        allowFile: true
      });
      assertWorkspaceFileContentPolicy({
        relativePath: resolved.relativePath,
        contentBuffer
      });
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    if (fs.existsSync(resolved.absolutePath) && fs.lstatSync(resolved.absolutePath).isDirectory()) {
      return { ok: false, status: 409, error: "目标路径是文件夹，不能写入为文件。" };
    }
    const overwritten = fs.existsSync(resolved.absolutePath);
    if (overwritten && input.overwrite === false) {
      return { ok: false, status: 409, error: "文件已存在。" };
    }
    const mountRef = String(resolved.mount?.mountRef || "");
    const operationId = input.operationId || "workspace.file.write";
    const prepared = await capturePreimage({
      access,
      input,
      relativePaths: [resolved.relativePath],
      operationId
    });
    if (!prepared.ok) {
      return prepared.result;
    }
    const preimage = prepared.capture;
    const preimageEntry = preimage.snapshot.entries.find((entry) => entry.relativePath === resolved.relativePath);
    let mutated = false;
    let stateCommit = null;
    try {
      await validateLocalDirectoryPreimage({ workspace: access.workspace, capture: preimage });
      mutated = true;
      writeFileAtomically(resolved.root, resolved.absolutePath, contentBuffer, 0o600);
      stripExecutableMode(resolved.absolutePath);
      const stat = fs.statSync(resolved.absolutePath);
      updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
      const postimageArchived = await archiveLocalDirectoryContent(contentBuffer, {
        operationId,
        mountRef,
        relativePath: resolved.relativePath,
        postimage: true
      });
      if (!postimageArchived?.rootCid) {
        const error = new Error("本机目录 postimage CAS 归档不可用。");
        error.code = "local_directory_postimage_unavailable";
        error.status = 503;
        throw error;
      }
      const file = localDirectoryFileMetadataFromStat({
        workspaceId: access.workspace.workspaceId,
        mount: resolved.mount,
        relativePath: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        stat,
        includeHash: true,
        rootPath: resolved.root,
        contentBuffer
      });
      stateCommit = requireStateCommit(await commitWorkspaceFileState({
        workspace: access.workspace,
        operationId,
        mutations: [{
          action: "put",
          key: mountMutationKey(mountRef, resolved.relativePath),
          valueRef: postimageArchived.rootCid,
          metadata: filePayloadMetadata(file)
        }],
        contentRefs: [
          ...snapshotContentRefs(preimage.snapshot),
          ...(postimageArchived.contentRefs || [])
        ],
        payload: {
          action: "localDir.file.write",
          path: resolved.relativePath,
          mountRef,
          overwritten,
          preimageSha256: preimageEntry?.contentSha256 || "",
          contentSha256: file.contentSha256 || ""
        }
      }));
      const checkpoint = requireCheckpoint(await recordWorkspaceFileCheckpoint({
        workspace: access.workspace,
        operationId,
        stateCommit,
        action: "localDir.file.write",
        path: resolved.relativePath,
        preimageSnapshot: workspacePreimageSnapshot(preimage.snapshot)
      }));
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        mode: "localDir",
        mount: resolved.mount ? publicLocalDirectoryMount(resolved.mount) : null,
        overwritten,
        file,
        stateCommit,
        checkpoint,
        accessReceipt: accessReceipt({
          workspaceId: access.workspace.workspaceId,
          mountRef,
          operationId,
          path: resolved.relativePath,
          action: "localDir.write"
        })
      };
    } catch (error) {
      if (!mutated) {
        return safeMutationFailure(error);
      }
      try {
        await rollbackMutation({ access, preimage, operationId, stateCommit });
        return safeMutationFailure(error, { rolledBack: true });
      } catch (rollbackError) {
        return safeMutationFailure(rollbackError);
      }
    }
  }

  async function createLocalDirectoryFolder(input = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let resolved;
    try {
      resolved = resolveLocalDirectoryMountPath(input, access.workspace, {
        allowEmpty: false,
        allowMissing: true,
        allowDirectory: true,
        allowFile: false
      });
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    if (basenameStartsWithDot(resolved.relativePath)) {
      return { ok: false, status: 400, error: "不允许操作以 . 开头的路径。" };
    }
    if (fs.existsSync(resolved.absolutePath) && !fs.lstatSync(resolved.absolutePath).isDirectory()) {
      return { ok: false, status: 409, error: "目标路径已存在且不是文件夹。" };
    }
    const mountRef = String(resolved.mount?.mountRef || "");
    const operationId = input.operationId || "agent_workspaces.folder.create";
    if (resolved.exists) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        mode: "localDir",
        mount: resolved.mount ? publicLocalDirectoryMount(resolved.mount) : null,
        created: false,
        stateCommit: null,
        checkpoint: null,
        folder: localDirectoryFileMetadataFromStat({
          workspaceId: access.workspace.workspaceId,
          mount: resolved.mount,
          relativePath: resolved.relativePath,
          absolutePath: resolved.absolutePath,
          stat: resolved.stat
        }),
        accessReceipt: accessReceipt({
          workspaceId: access.workspace.workspaceId,
          mountRef,
          operationId,
          path: resolved.relativePath,
          action: "localDir.mkdir"
        })
      };
    }
    const prepared = await capturePreimage({
      access,
      input,
      relativePaths: [resolved.relativePath],
      operationId
    });
    if (!prepared.ok) {
      return prepared.result;
    }
    const preimage = prepared.capture;
    let mutated = false;
    let stateCommit = null;
    try {
      await validateLocalDirectoryPreimage({ workspace: access.workspace, capture: preimage });
      mutated = true;
      ensureDirectorySafely(resolved.root, resolved.absolutePath, 0o700);
      const stat = fs.statSync(resolved.absolutePath);
      updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
      stateCommit = requireStateCommit(await commitWorkspaceFileState({
        workspace: access.workspace,
        operationId,
        mutations: [{
          action: "put",
          key: mountMutationKey(mountRef, resolved.relativePath),
          valueRef: "",
          metadata: directoryEntryMetadata()
        }],
        contentRefs: snapshotContentRefs(preimage.snapshot),
        payload: {
          action: "localDir.mkdir",
          path: resolved.relativePath,
          mountRef
        }
      }));
      const checkpoint = requireCheckpoint(await recordWorkspaceFileCheckpoint({
        workspace: access.workspace,
        operationId,
        stateCommit,
        action: "localDir.mkdir",
        path: resolved.relativePath,
        preimageSnapshot: workspacePreimageSnapshot(preimage.snapshot)
      }));
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        mode: "localDir",
        mount: resolved.mount ? publicLocalDirectoryMount(resolved.mount) : null,
        created: true,
        stateCommit,
        checkpoint,
        folder: localDirectoryFileMetadataFromStat({
          workspaceId: access.workspace.workspaceId,
          mount: resolved.mount,
          relativePath: resolved.relativePath,
          absolutePath: resolved.absolutePath,
          stat
        }),
        accessReceipt: accessReceipt({
          workspaceId: access.workspace.workspaceId,
          mountRef,
          operationId,
          path: resolved.relativePath,
          action: "localDir.mkdir"
        })
      };
    } catch (error) {
      if (!mutated) {
        return safeMutationFailure(error);
      }
      try {
        await rollbackMutation({ access, preimage, operationId, stateCommit });
        return safeMutationFailure(error, { rolledBack: true });
      } catch (rollbackError) {
        return safeMutationFailure(rollbackError);
      }
    }
  }

  async function deleteLocalDirectoryItem(input = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let resolved;
    try {
      resolved = resolveLocalDirectoryMountPath(input, access.workspace, {
        allowEmpty: false,
        allowMissing: false,
        requireExisting: true,
        allowDirectory: true,
        allowFile: true
      });
    } catch (error) {
      return { ok: false, status: error?.code === "ENOENT" ? 404 : 400, error: error.message };
    }
    const stat = fs.lstatSync(resolved.absolutePath);
    if (stat.isDirectory() && input.recursive !== true && fs.readdirSync(resolved.absolutePath).length > 0) {
      return { ok: false, status: 409, error: "目录非空；删除目录树需要 recursive: true。" };
    }
    const mountRef = String(resolved.mount?.mountRef || "");
    const operationId = input.operationId || "agent_workspaces.file.delete";
    const prepared = await capturePreimage({
      access,
      input,
      relativePaths: [resolved.relativePath],
      operationId
    });
    if (!prepared.ok) {
      return prepared.result;
    }
    const preimage = prepared.capture;
    const entries = snapshotExistingEntries(preimage.snapshot);
    const item = localDirectoryFileMetadataFromStat({
      workspaceId: access.workspace.workspaceId,
      mount: resolved.mount,
      relativePath: resolved.relativePath,
      absolutePath: resolved.absolutePath,
      stat
    });
    let mutated = false;
    let stateCommit = null;
    try {
      await validateLocalDirectoryPreimage({ workspace: access.workspace, capture: preimage });
      mutated = true;
      removePathSafely(resolved.root, resolved.absolutePath, { recursive: input.recursive === true });
      updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
      stateCommit = requireStateCommit(await commitWorkspaceFileState({
        workspace: access.workspace,
        operationId,
        mutations: [...entries].reverse().map((entry) => ({
          action: "delete",
          key: mountMutationKey(mountRef, entry.relativePath)
        })),
        contentRefs: snapshotContentRefs(preimage.snapshot),
        payload: {
          action: "localDir.delete",
          path: resolved.relativePath,
          mountRef,
          recursive: input.recursive === true,
          deletedPathCount: entries.length,
          preimageSha256s: entries.map((entry) => entry.contentSha256).filter(Boolean)
        }
      }));
      const checkpoint = requireCheckpoint(await recordWorkspaceFileCheckpoint({
        workspace: access.workspace,
        operationId,
        stateCommit,
        action: "localDir.delete",
        path: resolved.relativePath,
        preimageSnapshot: workspacePreimageSnapshot(preimage.snapshot)
      }));
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        mode: "localDir",
        mount: resolved.mount ? publicLocalDirectoryMount(resolved.mount) : null,
        deleted: true,
        item,
        stateCommit,
        checkpoint,
        accessReceipt: accessReceipt({
          workspaceId: access.workspace.workspaceId,
          mountRef,
          operationId,
          path: resolved.relativePath,
          action: "localDir.delete"
        })
      };
    } catch (error) {
      if (!mutated) {
        return safeMutationFailure(error);
      }
      try {
        await rollbackMutation({ access, preimage, operationId, stateCommit });
        return safeMutationFailure(error, { rolledBack: true });
      } catch (rollbackError) {
        return safeMutationFailure(rollbackError);
      }
    }
  }

  async function moveLocalDirectoryItem(input = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    const sourcePath = String(input.from || input.sourcePath || "").trim();
    const targetPath = String(input.to || input.targetPath || input.path || "").trim();
    if (!sourcePath) {
      return { ok: false, status: 400, error: "sourcePath (from) 不能为空。" };
    }
    if (!targetPath) {
      return { ok: false, status: 400, error: "targetPath (to) 不能为空。" };
    }
    if (basenameStartsWithDot(sourcePath) || basenameStartsWithDot(targetPath)) {
      return { ok: false, status: 400, error: "不允许操作以 . 开头的文件。" };
    }
    let resolvedSource;
    let resolvedTarget;
    try {
      resolvedSource = resolveLocalDirectoryMountPath({ ...input, path: sourcePath }, access.workspace, {
        allowEmpty: false,
        allowMissing: false,
        requireExisting: true,
        allowDirectory: true,
        allowFile: true
      });
      resolvedTarget = resolveLocalDirectoryMountPath({ ...input, path: targetPath }, access.workspace, {
        allowEmpty: false,
        allowMissing: true,
        allowDirectory: true,
        allowFile: true
      });
    } catch (error) {
      return { ok: false, status: error?.code === "ENOENT" ? 404 : 400, error: error.message };
    }
    const sourceMountRef = String(resolvedSource.mount?.mountRef || "");
    const targetMountRef = String(resolvedTarget.mount?.mountRef || "");
    if (sourceMountRef !== targetMountRef) {
      return { ok: false, status: 400, error: "不能跨本机目录 mount 移动项目。" };
    }
    const sourceStat = fs.lstatSync(resolvedSource.absolutePath);
    if (sourceStat.isFile()) {
      try {
        assertWorkspaceFileContentPolicy({
          relativePath: resolvedTarget.relativePath,
          contentBuffer: readOrdinaryFileNoFollow(resolvedSource.root, resolvedSource.absolutePath).content,
          sizeBytes: sourceStat.size
        });
      } catch (error) {
        return { ok: false, status: 400, error: error.message };
      }
    }
    if (resolvedSource.relativePath === resolvedTarget.relativePath) {
      return { ok: false, status: 400, error: "sourcePath 与 targetPath 不能相同。" };
    }
    const targetFromSource = path.relative(resolvedSource.absolutePath, resolvedTarget.absolutePath);
    const sourceFromTarget = path.relative(resolvedTarget.absolutePath, resolvedSource.absolutePath);
    const overlaps = (relative) => relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    if (sourceStat.isDirectory() && (overlaps(targetFromSource) || overlaps(sourceFromTarget))) {
      return { ok: false, status: 400, error: "目录 move 的 sourcePath 与 targetPath 不能互相包含。" };
    }
    const operationId = input.operationId || "agent_workspaces.file.move";
    const mountRef = targetMountRef;
    if (resolvedTarget.exists) {
      if (!input.overwrite) {
        return { ok: false, status: 409, error: "目标路径已存在。设置 overwrite: true 以覆盖。" };
      }
    }
    const prepared = await capturePreimage({
      access,
      input,
      relativePaths: [resolvedSource.relativePath, resolvedTarget.relativePath],
      operationId
    });
    if (!prepared.ok) {
      return prepared.result;
    }
    const preimage = prepared.capture;
    const sourceEntries = snapshotExistingEntries(preimage.snapshot)
      .filter((entry) => entry.relativePath === resolvedSource.relativePath || entry.relativePath.startsWith(`${resolvedSource.relativePath}/`));
    const overwrittenEntries = snapshotExistingEntries(preimage.snapshot)
      .filter((entry) => entry.relativePath === resolvedTarget.relativePath || entry.relativePath.startsWith(`${resolvedTarget.relativePath}/`));
    let mutated = false;
    let stateCommit = null;
    try {
      await validateLocalDirectoryPreimage({ workspace: access.workspace, capture: preimage });
      mutated = true;
      if (resolvedTarget.exists) {
        removePathSafely(resolvedTarget.root, resolvedTarget.absolutePath, { recursive: true });
      }
      renamePathSafely(resolvedSource.root, resolvedSource.absolutePath, resolvedTarget.absolutePath);
      if (sourceStat.isFile()) {
        stripExecutableMode(resolvedTarget.absolutePath);
      }
      const newStat = fs.lstatSync(resolvedTarget.absolutePath);
      const targetEntries = collectFilesystemEntries(resolvedTarget.absolutePath, resolvedTarget.relativePath, newStat);
      const targetPostimages = await postimageMutations({
        workspace: access.workspace,
        mount: resolvedTarget.mount,
        entries: targetEntries,
        operationId,
        mountRef,
        root: resolvedTarget.root
      });
      const file = localDirectoryFileMetadataFromStat({
        workspaceId: access.workspace.workspaceId,
        mount: resolvedTarget.mount,
        relativePath: resolvedTarget.relativePath,
        absolutePath: resolvedTarget.absolutePath,
        stat: newStat,
        includeHash: newStat.isFile(),
        rootPath: resolvedTarget.root
      });
      updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
      const deleteEntries = snapshotExistingEntries(preimage.snapshot);
      stateCommit = requireStateCommit(await commitWorkspaceFileState({
        workspace: access.workspace,
        operationId,
        mutations: [
          ...[...deleteEntries].reverse().map((entry) => ({
            action: "delete",
            key: mountMutationKey(mountRef, entry.relativePath)
          })),
          ...targetPostimages.mutations
        ],
        contentRefs: [
          ...snapshotContentRefs(preimage.snapshot),
          ...targetPostimages.contentRefs
        ],
        payload: {
          action: "localDir.move",
          sourcePath: resolvedSource.relativePath,
          targetPath: resolvedTarget.relativePath,
          mountRef,
          overwrite: input.overwrite === true,
          movedPathCount: sourceEntries.length,
          overwrittenPathCount: overwrittenEntries.length,
          preimageSha256s: sourceEntries.map((entry) => entry.contentSha256).filter(Boolean),
          overwrittenSha256s: overwrittenEntries.map((entry) => entry.contentSha256).filter(Boolean)
        }
      }));
      const checkpoint = requireCheckpoint(await recordWorkspaceFileCheckpoint({
        workspace: access.workspace,
        operationId,
        stateCommit,
        action: "localDir.move",
        path: resolvedTarget.relativePath,
        preimageSnapshot: workspacePreimageSnapshot(preimage.snapshot)
      }));
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        mode: "localDir",
        mount: resolvedTarget.mount ? publicLocalDirectoryMount(resolvedTarget.mount) : null,
        moved: true,
        sourcePath: resolvedSource.relativePath,
        targetPath: resolvedTarget.relativePath,
        item: file,
        stateCommit,
        checkpoint,
        accessReceipt: accessReceipt({
          workspaceId: access.workspace.workspaceId,
          mountRef,
          operationId,
          path: resolvedTarget.relativePath,
          action: "localDir.move"
        })
      };
    } catch (error) {
      if (!mutated) {
        return safeMutationFailure(error);
      }
      try {
        await rollbackMutation({ access, preimage, operationId, stateCommit });
        return safeMutationFailure(error, { rolledBack: true });
      } catch (rollbackError) {
        return safeMutationFailure(rollbackError);
      }
    }
  }

  return {
    writeLocalDirectoryFile,
    createLocalDirectoryFolder,
    deleteLocalDirectoryItem,
    moveLocalDirectoryItem
  };
}
