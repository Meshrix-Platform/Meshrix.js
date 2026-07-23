import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRuntimeLogger } from "@lico/foundation/observability/runtime-logger";
import {
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  applyReplacementHunks,
  applyUnifiedPatchText,
  asObject,
  assertWorkspaceFileContentPolicy,
  fileMetadataFromStat,
  joinWorkspaceRelativePath,
  normalizeWorkspaceRelativePath,
  nowIso,
  sha256Buffer,
  stableHash,
  stripExecutableMode
} from "./agent-workspace-support.mjs";

export function createAgentWorkspaceFileWriteApi({
  workspaceForStorage,
  resolveWorkspacePath,
  updateWorkspaceTimeStmt,
  createArtifact,
  fileStateApi
} = {}) {
  const {
    decodeWorkspaceFileContent,
    filePayloadMetadata,
    archiveWorkspacePath,
    recordWorkspaceUploadIngest,
    commitWorkspaceFileState,
    recordWorkspaceFileCheckpoint
  } = fileStateApi;

  function assertMovableWorkspaceDirectory(sourceAbsolutePath, targetRelativePath) {
    const visit = (absoluteDir, relativeDir) => {
      const entries = fs.readdirSync(absoluteDir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const childAbsolutePath = path.join(absoluteDir, entry.name);
        const childRelativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const stat = fs.lstatSync(childAbsolutePath);
        if (stat.isSymbolicLink()) {
          throw new Error(`工作空间内存在不允许移动的符号链接：${childRelativePath}`);
        }
        if (stat.isDirectory()) {
          visit(childAbsolutePath, childRelativePath);
          continue;
        }
        if (!stat.isFile()) {
          throw new Error(`工作空间内存在不允许移动的特殊文件：${childRelativePath}`);
        }
        const finalRelativePath = targetRelativePath
          ? `${targetRelativePath}/${childRelativePath}`
          : childRelativePath;
        const content = fs.readFileSync(childAbsolutePath);
        assertWorkspaceFileContentPolicy({
          relativePath: finalRelativePath,
          contentBuffer: content,
          sizeBytes: stat.size
        });
      }
    };
    visit(sourceAbsolutePath, "");
  }

  async function uploadWorkspaceFile(input = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    const fileName = String(input.fileName || input.filename || input.name || "").trim();
    const explicitPath = String(input.path || input.relativePath || input.filePath || input.targetPath || "").trim();
    if (!fileName && !explicitPath) {
      return { ok: false, status: 400, error: "fileName 不能为空。" };
    }
    const resolvedName = explicitPath ? path.posix.basename(explicitPath) : fileName;
    if (resolvedName.startsWith(".")) {
      return { ok: false, status: 400, error: "不允许上传以 . 开头的文件。" };
    }
    let contentBuffer;
    try {
      contentBuffer = decodeWorkspaceFileContent(input);
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    let resolved;
    try {
      const relativePath = explicitPath
        ? normalizeWorkspaceRelativePath(explicitPath, { allowEmpty: false })
        : joinWorkspaceRelativePath(input.folderPath || input.folder || input.directory || "files", fileName);
      resolved = resolveWorkspacePath(access.workspace, relativePath);
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    if (fs.existsSync(resolved.absolutePath) && fs.lstatSync(resolved.absolutePath).isDirectory()) {
      return { ok: false, status: 409, error: "目标路径是文件夹，不能上传为文件。" };
    }
    try {
      assertWorkspaceFileContentPolicy({
        relativePath: resolved.relativePath,
        contentBuffer
      });
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    const overwritten = fs.existsSync(resolved.absolutePath);
    if (overwritten && input.overwrite === false) {
      return { ok: false, status: 409, error: "文件已存在。" };
    }
    fs.mkdirSync(path.dirname(resolved.absolutePath), { recursive: true });
    fs.writeFileSync(resolved.absolutePath, contentBuffer);
    stripExecutableMode(resolved.absolutePath);
    updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
    const artifact = createArtifact({
      workspaceId: access.workspace.workspaceId,
      level: String(input.level || "artifact"),
      title: fileName || path.posix.basename(resolved.relativePath),
      content: contentBuffer.toString(String(input.encoding || "utf8")),
      status: String(input.status || "draft"),
      createdBy: input.createdBy || input.actorUserId || input.agentId || "",
      artifactId: input.artifactId,
      runId: input.runId || "",
      citations: input.citations,
      revision: input.revision,
      createdAt: input.createdAt,
      coverageReport: {
        ...(asObject(input.coverageReport || input.coverage)),
        workspaceFilePath: resolved.relativePath
      }
    }).artifact;
    const file = fileMetadataFromStat({
      workspaceId: access.workspace.workspaceId,
      relativePath: resolved.relativePath,
      absolutePath: resolved.absolutePath,
      stat: fs.statSync(resolved.absolutePath),
      includeHash: true
    });
    const ingestReceipt = await recordWorkspaceUploadIngest({
      workspace: access.workspace,
      relativePath: resolved.relativePath,
      contentBuffer,
      operationId: input.operationId || "workspace.file.upload"
    });
    const archived = await archiveWorkspacePath(access.workspace, resolved.relativePath, {
      operationId: input.operationId || "workspace.file.upload"
    });
    const stateCommit = await commitWorkspaceFileState({
      workspace: access.workspace,
      operationId: input.operationId || "workspace.file.upload",
      mutations: archived
        ? [{
            action: "put",
            key: resolved.relativePath,
            valueRef: archived.rootCid,
            metadata: filePayloadMetadata(file)
          }]
        : [],
      contentRefs: [
        ...(archived?.contentRefs || []),
        ...(ingestReceipt?.contentRefs || [])
      ],
      payload: {
        action: "file.upload",
        path: resolved.relativePath,
        overwritten,
        sizeBytes: contentBuffer.length,
        contentSha256: file.contentSha256 || "",
        ingestReceipt: ingestReceipt
          ? {
              uploadSessionId: ingestReceipt.uploadSessionId,
              segmentId: ingestReceipt.segmentId,
              manifestRootCid: ingestReceipt.manifestRootCid,
              status: ingestReceipt.status
            }
          : null
      }
    });
    const checkpoint = await recordWorkspaceFileCheckpoint({
      workspace: access.workspace,
      operationId: input.operationId || "workspace.file.upload",
      stateCommit,
      action: "file.upload",
      path: resolved.relativePath
    });
    try {
      getRuntimeLogger().info("agent_workspace.file.upload.completed", {
        workspaceId: access.workspace.workspaceId,
        relativePath: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        absolutePathSha256: stableHash(resolved.absolutePath),
        sizeBytes: contentBuffer.length,
        contentSha256: crypto.createHash("sha256").update(contentBuffer).digest("hex"),
        overwritten,
        artifactId: artifact?.artifactId || "",
        runId: String(input.runId || ""),
        createdBy: String(input.createdBy || input.actorUserId || input.agentId || "")
      });
    } catch {
      // Logging must not turn a completed upload into a failed tool call.
    }
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      overwritten,
      stateCommit,
      ingestReceipt,
      checkpoint,
      file,
      artifact
    };
  }

  async function writeWorkspaceFile(input = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    const explicitPath = String(input.path || input.relativePath || "").trim();
    if (!explicitPath) {
      return { ok: false, status: 400, error: "path 不能为空。" };
    }
    if (path.posix.basename(explicitPath).startsWith(".")) {
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
      resolved = resolveWorkspacePath(access.workspace, normalizeWorkspaceRelativePath(explicitPath, { allowEmpty: false }));
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    if (!fs.existsSync(resolved.absolutePath)) {
      return { ok: false, status: 404, error: "文件不存在。" };
    }
    if (fs.lstatSync(resolved.absolutePath).isDirectory()) {
      return { ok: false, status: 400, error: "目标路径是文件夹，不能写入。" };
    }
    try {
      assertWorkspaceFileContentPolicy({
        relativePath: resolved.relativePath,
        contentBuffer
      });
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    fs.writeFileSync(resolved.absolutePath, contentBuffer);
    stripExecutableMode(resolved.absolutePath);
    updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
    const file = fileMetadataFromStat({
      workspaceId: access.workspace.workspaceId,
      relativePath: resolved.relativePath,
      absolutePath: resolved.absolutePath,
      stat: fs.statSync(resolved.absolutePath),
      includeHash: true
    });
    const archived = await archiveWorkspacePath(access.workspace, resolved.relativePath, {
      operationId: input.operationId || "workspace.file.write"
    });
    const stateCommit = await commitWorkspaceFileState({
      workspace: access.workspace,
      operationId: input.operationId || "workspace.file.write",
      mutations: archived
        ? [{
            action: "put",
            key: resolved.relativePath,
            valueRef: archived.rootCid,
            metadata: filePayloadMetadata(file)
          }]
        : [],
      contentRefs: archived?.contentRefs || [],
      payload: {
        action: "file.write",
        path: resolved.relativePath,
        sizeBytes: contentBuffer.length,
        contentSha256: file.contentSha256 || ""
      }
    });
    const checkpoint = await recordWorkspaceFileCheckpoint({
      workspace: access.workspace,
      operationId: input.operationId || "workspace.file.write",
      stateCommit,
      action: "file.write",
      path: resolved.relativePath
    });
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      overwritten: true,
      stateCommit,
      checkpoint,
      file
    };
  }

  async function patchWorkspaceFile(input = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    const explicitPath = String(input.path || input.relativePath || input.filePath || input["file-path"] || "").trim();
    if (!explicitPath) {
      return { ok: false, status: 400, error: "path 不能为空。" };
    }
    if (path.posix.basename(explicitPath).startsWith(".")) {
      return { ok: false, status: 400, error: "不允许操作以 . 开头的文件。" };
    }
    let resolved;
    try {
      resolved = resolveWorkspacePath(access.workspace, normalizeWorkspaceRelativePath(explicitPath, { allowEmpty: false }));
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    if (!fs.existsSync(resolved.absolutePath)) {
      return { ok: false, status: 404, error: "文件不存在。" };
    }
    if (fs.lstatSync(resolved.absolutePath).isDirectory()) {
      return { ok: false, status: 400, error: "目标路径是文件夹，不能打补丁。" };
    }
    const encoding = String(input.encoding || input.textEncoding || "utf8");
    const beforeBuffer = fs.readFileSync(resolved.absolutePath);
    const beforeSha256 = sha256Buffer(beforeBuffer);
    const expectedSha256 = String(input.expectedSha256 || input.baseSha256 || "").trim();
    if (expectedSha256 && expectedSha256 !== beforeSha256) {
      return {
        ok: false,
        status: 409,
        error: "文件内容与 expectedSha256 不匹配。",
        expectedSha256,
        currentSha256: beforeSha256
      };
    }
    let nextText;
    try {
      const beforeText = beforeBuffer.toString(encoding);
      if (Array.isArray(input.hunks) && input.hunks.length > 0) {
        nextText = applyReplacementHunks(beforeText, input.hunks);
      } else if (Object.hasOwn(input, "patch")) {
        nextText = applyUnifiedPatchText(beforeText, input.patch);
      } else {
        return { ok: false, status: 400, error: "patch 或 hunks 至少提供一个。" };
      }
    } catch (error) {
      return { ok: false, status: 409, error: error instanceof Error ? error.message : "patch 应用失败。" };
    }
    const nextBuffer = Buffer.from(nextText, encoding);
    const afterSha256 = sha256Buffer(nextBuffer);
    if (afterSha256 === beforeSha256) {
      return { ok: false, status: 409, error: "patch 未改变文件内容。", currentSha256: beforeSha256 };
    }
    try {
      assertWorkspaceFileContentPolicy({
        relativePath: resolved.relativePath,
        contentBuffer: nextBuffer
      });
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    fs.writeFileSync(resolved.absolutePath, nextBuffer);
    stripExecutableMode(resolved.absolutePath);
    updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
    const file = fileMetadataFromStat({
      workspaceId: access.workspace.workspaceId,
      relativePath: resolved.relativePath,
      absolutePath: resolved.absolutePath,
      stat: fs.statSync(resolved.absolutePath),
      includeHash: true
    });
    const archived = await archiveWorkspacePath(access.workspace, resolved.relativePath, {
      operationId: input.operationId || "workspace.file.patch"
    });
    const stateCommit = await commitWorkspaceFileState({
      workspace: access.workspace,
      operationId: input.operationId || "workspace.file.patch",
      mutations: archived
        ? [{
            action: "put",
            key: resolved.relativePath,
            valueRef: archived.rootCid,
            metadata: filePayloadMetadata(file)
          }]
        : [],
      contentRefs: archived?.contentRefs || [],
      payload: {
        action: "file.patch",
        path: resolved.relativePath,
        beforeSha256,
        afterSha256
      }
    });
    const checkpoint = await recordWorkspaceFileCheckpoint({
      workspace: access.workspace,
      operationId: input.operationId || "workspace.file.patch",
      stateCommit,
      action: "file.patch",
      path: resolved.relativePath
    });
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      patched: true,
      beforeSha256,
      afterSha256,
      stateCommit,
      checkpoint,
      file
    };
  }

  async function deleteWorkspaceFile(input = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    const explicitPath = String(input.path || input.relativePath || "").trim();
    if (!explicitPath) {
      return { ok: false, status: 400, error: "path 不能为空。" };
    }
    if (path.posix.basename(explicitPath).startsWith(".")) {
      return { ok: false, status: 400, error: "不允许操作以 . 开头的文件。" };
    }
    let resolved;
    try {
      resolved = resolveWorkspacePath(access.workspace, normalizeWorkspaceRelativePath(explicitPath, { allowEmpty: false }));
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    if (!fs.existsSync(resolved.absolutePath)) {
      return { ok: false, status: 404, error: "文件不存在。" };
    }
    const stat = fs.lstatSync(resolved.absolutePath);
    const deletedPaths = [];
    if (stat.isDirectory()) {
      const collect = (absoluteDir, relativeDir) => {
        const entries = fs.readdirSync(absoluteDir, { withFileTypes: true })
          .filter((entry) => !entry.name.startsWith("."))
          .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          const childRelativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
          const childAbsolutePath = path.join(absoluteDir, entry.name);
          const childStat = fs.lstatSync(childAbsolutePath);
          if (childStat.isSymbolicLink()) {
            throw new Error(`不允许删除符号链接：${childRelativePath}`);
          }
          if (childStat.isDirectory()) {
            collect(childAbsolutePath, childRelativePath);
          } else if (!childStat.isFile()) {
            throw new Error(`不允许删除特殊文件：${childRelativePath}`);
          }
          deletedPaths.push(childRelativePath);
        }
      };
      try {
        collect(resolved.absolutePath, resolved.relativePath);
      } catch (error) {
        return { ok: false, status: 400, error: error.message };
      }
    }
    deletedPaths.push(resolved.relativePath);
    const meta = fileMetadataFromStat({
      workspaceId: access.workspace.workspaceId,
      relativePath: resolved.relativePath,
      absolutePath: resolved.absolutePath,
      stat
    });
    if (stat.isDirectory()) {
      if (!input.recursive) {
        fs.rmdirSync(resolved.absolutePath);
      } else {
        fs.rmSync(resolved.absolutePath, { recursive: true, force: true });
      }
    } else {
      fs.unlinkSync(resolved.absolutePath);
    }
    updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
    const stateCommit = await commitWorkspaceFileState({
      workspace: access.workspace,
      operationId: input.operationId || "agent_workspaces.file.delete",
      mutations: deletedPaths.map((relativePath) => ({
        action: "delete",
        key: relativePath
      })),
      payload: {
        action: "file.delete",
        path: resolved.relativePath,
        recursive: input.recursive === true,
        deletedPathCount: deletedPaths.length
      }
    });
    const checkpoint = await recordWorkspaceFileCheckpoint({
      workspace: access.workspace,
      operationId: input.operationId || "agent_workspaces.file.delete",
      stateCommit,
      action: "file.delete",
      path: resolved.relativePath
    });
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      deleted: true,
      stateCommit,
      checkpoint,
      file: meta
    };
  }

  async function moveWorkspaceFile(input = {}) {
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
    if (path.posix.basename(sourcePath).startsWith(".") || path.posix.basename(targetPath).startsWith(".")) {
      return { ok: false, status: 400, error: "不允许操作以 . 开头的文件。" };
    }
    let resolvedSource, resolvedTarget;
    try {
      resolvedSource = resolveWorkspacePath(access.workspace, normalizeWorkspaceRelativePath(sourcePath, { allowEmpty: false }));
      resolvedTarget = resolveWorkspacePath(access.workspace, normalizeWorkspaceRelativePath(targetPath, { allowEmpty: false }));
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    if (!fs.existsSync(resolvedSource.absolutePath)) {
      return { ok: false, status: 404, error: "源文件不存在。" };
    }
    let sourceStat;
    try {
      sourceStat = fs.lstatSync(resolvedSource.absolutePath);
      if (sourceStat.isSymbolicLink() || (!sourceStat.isFile() && !sourceStat.isDirectory())) {
        return { ok: false, status: 400, error: "源路径必须是普通文件或目录。" };
      }
      if (sourceStat.isFile()) {
        assertWorkspaceFileContentPolicy({
          relativePath: resolvedTarget.relativePath,
          contentBuffer: fs.readFileSync(resolvedSource.absolutePath),
          sizeBytes: sourceStat.size
        });
      } else if (sourceStat.isDirectory()) {
        assertMovableWorkspaceDirectory(resolvedSource.absolutePath, resolvedTarget.relativePath);
      }
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
    if (fs.existsSync(resolvedTarget.absolutePath)) {
      if (!input.overwrite) {
        return { ok: false, status: 409, error: "目标路径已存在。设置 overwrite: true 以覆盖。" };
      }
      fs.rmSync(resolvedTarget.absolutePath, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(resolvedTarget.absolutePath), { recursive: true });
    fs.renameSync(resolvedSource.absolutePath, resolvedTarget.absolutePath);
    if (sourceStat?.isFile()) {
      stripExecutableMode(resolvedTarget.absolutePath);
    }
    updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
    const newStat = fs.statSync(resolvedTarget.absolutePath);
    const file = fileMetadataFromStat({
      workspaceId: access.workspace.workspaceId,
      relativePath: resolvedTarget.relativePath,
      absolutePath: resolvedTarget.absolutePath,
      stat: newStat,
      includeHash: newStat.isFile()
    });
    const archived = await archiveWorkspacePath(access.workspace, resolvedTarget.relativePath, {
      operationId: input.operationId || "agent_workspaces.file.move"
    });
    const stateCommit = await commitWorkspaceFileState({
      workspace: access.workspace,
      operationId: input.operationId || "agent_workspaces.file.move",
      mutations: [
        {
          action: "delete",
          key: resolvedSource.relativePath
        },
        ...(archived
          ? [{
              action: "put",
              key: resolvedTarget.relativePath,
              valueRef: archived.rootCid,
              metadata: filePayloadMetadata(file)
            }]
          : [])
      ],
      contentRefs: archived?.contentRefs || [],
      payload: {
        action: "file.move",
        sourcePath: resolvedSource.relativePath,
        targetPath: resolvedTarget.relativePath,
        overwrite: input.overwrite === true
      }
    });
    const checkpoint = await recordWorkspaceFileCheckpoint({
      workspace: access.workspace,
      operationId: input.operationId || "agent_workspaces.file.move",
      stateCommit,
      action: "file.move",
      path: resolvedTarget.relativePath
    });
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      moved: true,
      sourcePath: resolvedSource.relativePath,
      targetPath: resolvedTarget.relativePath,
      stateCommit,
      checkpoint,
      file
    };
  }


  return {
    uploadWorkspaceFile,
    writeWorkspaceFile,
    patchWorkspaceFile,
    deleteWorkspaceFile,
    moveWorkspaceFile
  };
}
