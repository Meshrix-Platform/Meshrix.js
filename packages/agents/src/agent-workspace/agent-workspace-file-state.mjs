import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  asArray,
  asObject,
  normalizeSha256,
  normalizeWorkspaceRelativePath,
  uniqueStrings
} from "./agent-workspace-support.mjs";

export function createAgentWorkspaceFileStateApi({
  merkleState = null,
  checkpointTreeApi = null,
  resolveWorkspacePath,
  listWorkspaceFiles
} = {}) {
  function decodeWorkspaceFileContent(input = {}) {
    if (Object.hasOwn(input, "contentBase64")) {
      const raw = String(input.contentBase64 || "").trim();
      if (!raw) {
        return Buffer.alloc(0);
      }
      return Buffer.from(raw, "base64");
    }
    if (Object.hasOwn(input, "content")) {
      return Buffer.from(String(input.content || ""), String(input.encoding || "utf8"));
    }
    throw new Error("content 或 contentBase64 至少提供一个。");
  }

  function workspaceStateScope(workspace) {
    return `workspace:${workspace.workspaceId}`;
  }

  function workspaceCheckpointTreeId(workspace) {
    return checkpointTreeApi?.checkpointTreeId
      ? checkpointTreeApi.checkpointTreeId("workspace-files", workspace.workspaceId)
      : "";
  }

  function compactStateCommit(commit = null) {
    return commit
      ? {
          commitId: commit.commitId,
          eventHash: commit.eventHash,
          beforeRoot: commit.beforeRoot,
          afterRoot: commit.afterRoot,
          contentRefs: asArray(commit.contentRefs),
          indexRoots: asObject(commit.indexRoots)
        }
      : null;
  }

  function filePayloadMetadata(file = {}) {
    return {
      type: file.type || "file",
      sizeBytes: Number(file.sizeBytes || 0),
      contentSha256: file.contentSha256 || "",
      updatedAt: file.updatedAt || file.mtime || ""
    };
  }

  async function archiveWorkspacePath(workspace, relativePath, metadata = {}) {
    if (!merkleState) {
      return null;
    }
    const resolved = resolveWorkspacePath(workspace, relativePath, { allowEmpty: false });
    if (!fs.existsSync(resolved.absolutePath)) {
      return null;
    }
    const { contentBuffer = null, ...archiveMetadata } = asObject(metadata);
    const stat = fs.lstatSync(resolved.absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error("不允许归档符号链接。");
    }
    if (stat.isFile()) {
      const content = Buffer.isBuffer(contentBuffer) ? contentBuffer : fs.readFileSync(resolved.absolutePath);
      const block = await merkleState.cas.putBlock(content, {
        codec: "raw",
        metadata: {
          workspaceId: workspace.workspaceId,
          relativePath: resolved.relativePath,
          ...archiveMetadata
        }
      });
      const manifest = await merkleState.merkleDag.buildManifest("workspace-file", [
        {
          path: resolved.relativePath,
          cid: block.cid,
          byteLength: block.byteLength,
          metadata: {
            contentSha256: block.payloadHash
          }
        }
      ], {
        workspaceId: workspace.workspaceId,
        relativePath: resolved.relativePath,
        type: "file",
        ...archiveMetadata
      });
      return {
        rootCid: manifest.rootCid,
        contentRefs: [manifest.rootCid, block.cid],
        metadata: {
          type: "file",
          sizeBytes: block.byteLength,
          contentSha256: block.payloadHash
        }
      };
    }
    if (!stat.isDirectory()) {
      throw new Error("不允许归档非普通文件或目录。");
    }
    const entries = [];
    const refs = [];
    const visit = async (absoluteDir, relativeDir) => {
      const children = fs.readdirSync(absoluteDir, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith("."))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        const childRelativePath = relativeDir ? `${relativeDir}/${child.name}` : child.name;
        const childAbsolutePath = path.join(absoluteDir, child.name);
        const childStat = fs.lstatSync(childAbsolutePath);
        if (childStat.isSymbolicLink()) {
          throw new Error(`不允许归档符号链接：${childRelativePath}`);
        }
        if (childStat.isDirectory()) {
          await visit(childAbsolutePath, childRelativePath);
          continue;
        }
        if (!childStat.isFile()) {
          throw new Error(`不允许归档特殊文件：${childRelativePath}`);
        }
        const content = fs.readFileSync(childAbsolutePath);
        const block = await merkleState.cas.putBlock(content, {
          codec: "raw",
          metadata: {
            workspaceId: workspace.workspaceId,
            relativePath: childRelativePath,
            ...asObject(metadata)
          }
        });
        refs.push(block.cid);
        entries.push({
          path: childRelativePath,
          cid: block.cid,
          byteLength: block.byteLength,
          metadata: {
            contentSha256: block.payloadHash
          }
        });
      }
    };
    await visit(resolved.absolutePath, resolved.relativePath);
    const manifest = await merkleState.merkleDag.buildManifest("workspace-directory", entries, {
      workspaceId: workspace.workspaceId,
      relativePath: resolved.relativePath,
      type: "directory",
      ...asObject(metadata)
    });
    return {
      rootCid: manifest.rootCid,
      contentRefs: [manifest.rootCid, ...refs],
      metadata: {
        type: "directory",
        fileCount: entries.length
      }
    };
  }

  async function recordWorkspaceUploadIngest({
    workspace,
    relativePath,
    contentBuffer,
    operationId
  } = {}) {
    if (!merkleState || typeof merkleState.lsmIngest?.beginUploadSession !== "function") {
      return null;
    }
    const content = Buffer.isBuffer(contentBuffer) ? contentBuffer : Buffer.from(contentBuffer || "");
    const block = await merkleState.cas.putBlock(content, {
      codec: "raw",
      metadata: {
        workspaceId: workspace.workspaceId,
        relativePath,
        operationId,
        ingest: true
      }
    });
    const session = await merkleState.lsmIngest.beginUploadSession({
      scope: workspaceStateScope(workspace),
      workspaceId: workspace.workspaceId,
      files: [{
        relativePath,
        byteLength: content.length,
        sha256: normalizeSha256(block.payloadHash)
      }]
    });
    const chunkRecord = await merkleState.lsmIngest.appendChunkRecord(session.uploadSessionId, {
      fileId: relativePath,
      relativePath,
      chunkIndex: 0,
      offset: 0,
      byteLength: content.length,
      chunkCid: block.cid,
      chunkHash: block.payloadHash
    });
    const segment = await merkleState.lsmIngest.flushMemTable(session.uploadSessionId);
    const manifest = await merkleState.lsmIngest.materializeManifest(session.uploadSessionId);
    return {
      protocolVersion: merkleState.protocolVersion,
      status: "archived",
      uploadSessionId: session.uploadSessionId,
      segmentId: segment.segmentId,
      segmentRootCid: segment.rootCid,
      manifestRootCid: manifest.rootCid,
      chunkCid: block.cid,
      chunkHash: block.payloadHash,
      recordCount: segment.recordCount,
      nextOffset: Number(chunkRecord.offset || 0) + Number(chunkRecord.byteLength || 0),
      contentRefs: uniqueStrings([manifest.rootCid, segment.rootCid, block.cid])
    };
  }

  async function workspaceDownloadCacheReceipt(workspace, relativePath) {
    if (!merkleState || typeof merkleState.stateCommit?.begin !== "function") {
      return null;
    }
    const state = await merkleState.stateCommit.begin({
      scope: workspaceStateScope(workspace)
    });
    const indexRootCid = String(state.currentRoot || "");
    if (!indexRootCid) {
      return {
        protocolVersion: merkleState.protocolVersion,
        cacheFamily: "merkle-radix-compatible",
        implementation: "sorted-chunk-index-v1",
        cacheKey: `${workspaceStateScope(workspace)}:${relativePath}`,
        hit: false,
        indexRootCid: "",
        valueRoot: "",
        proofHash: ""
      };
    }
    const entry = await merkleState.merkleIndex.get(indexRootCid, relativePath);
    const proof = await merkleState.merkleIndex.prove(indexRootCid, relativePath);
    return {
      protocolVersion: merkleState.protocolVersion,
      cacheFamily: "merkle-radix-compatible",
      implementation: "sorted-chunk-index-v1",
      cacheKey: `${workspaceStateScope(workspace)}:${relativePath}`,
      hit: Boolean(entry),
      indexRootCid,
      valueRoot: entry?.valueRef || "",
      proofHash: proof.proofHash
    };
  }

  async function workspaceListCacheReceipt(workspace, prefix = "") {
    if (!merkleState || typeof merkleState.stateCommit?.begin !== "function") {
      return null;
    }
    const state = await merkleState.stateCommit.begin({
      scope: workspaceStateScope(workspace)
    });
    const indexRootCid = String(state.currentRoot || "");
    if (!indexRootCid) {
      return {
        protocolVersion: merkleState.protocolVersion,
        cacheFamily: "merkle-radix-compatible",
        implementation: "sorted-chunk-index-v1",
        cacheKey: `${workspaceStateScope(workspace)}:${prefix || "/"}`,
        hit: false,
        indexRootCid: "",
        prefix,
        entryCount: 0,
        valueRoots: [],
        proofHash: ""
      };
    }
    const entries = await merkleState.merkleIndex.prefix(indexRootCid, prefix);
    const proof = await merkleState.merkleIndex.prove(indexRootCid, prefix || entries[0]?.key || "");
    return {
      protocolVersion: merkleState.protocolVersion,
      cacheFamily: "merkle-radix-compatible",
      implementation: "sorted-chunk-index-v1",
      cacheKey: `${workspaceStateScope(workspace)}:${prefix || "/"}`,
      hit: entries.length > 0,
      indexRootCid,
      prefix,
      entryCount: entries.length,
      valueRoots: uniqueStrings(entries.map((entry) => entry.valueRef)).slice(0, 100),
      proofHash: proof.proofHash
    };
  }

  async function commitWorkspaceFileState({
    workspace,
    operationId,
    mutations = [],
    contentRefs = [],
    payload = {}
  } = {}) {
    if (!merkleState || typeof merkleState.stateCommit?.commit !== "function") {
      return null;
    }
    return compactStateCommit(await merkleState.stateCommit.commit({
      scope: workspaceStateScope(workspace),
      operationId,
      mutations,
      contentRefs: uniqueStrings(contentRefs),
      payload: {
        workspaceId: workspace.workspaceId,
        ...asObject(payload)
      }
    }));
  }

  async function buildWorkspaceFileSnapshot(workspace, { basePath = "", deleteExtraneous = true } = {}) {
    if (!merkleState) {
      return null;
    }
    const listed = await listWorkspaceFiles({
      workspaceId: workspace.workspaceId,
      path: basePath,
      folderPath: basePath,
      recursive: true,
      includeDirectories: false,
      includeFiles: true,
      includeHash: true,
      limit: 5000,
      actorUserId: workspace.ownerUserId || "",
      adminUserIds: [workspace.ownerUserId].filter(Boolean)
    });
    if (!listed.ok) {
      return null;
    }
    const files = [];
    for (const file of listed.files) {
      const resolved = resolveWorkspacePath(workspace, file.relativePath);
      const content = fs.readFileSync(resolved.absolutePath);
      const block = await merkleState.cas.putBlock(content, {
        codec: "raw",
        metadata: {
          workspaceId: workspace.workspaceId,
          relativePath: file.relativePath,
          snapshot: true
        }
      });
      files.push({
        path: file.relativePath,
        exists: true,
        contentCid: block.cid,
        contentSha256: normalizeSha256(block.payloadHash),
        byteLength: block.byteLength,
        encoding: "base64"
      });
    }
    return {
      workspaceId: workspace.workspaceId,
      basePath: normalizeWorkspaceRelativePath(basePath, { allowEmpty: true }),
      deleteExtraneous,
      files
    };
  }

  async function recordWorkspaceFileCheckpoint({
    workspace,
    operationId,
    stateCommit,
    action,
    path: relativePath,
    preimageSnapshot = null,
    mutationOrigin = null
  } = {}) {
    if (!checkpointTreeApi || !stateCommit?.commitId) {
      return null;
    }
    const treeId = workspaceCheckpointTreeId(workspace);
    if (!treeId) {
      return null;
    }
    const snapshot = await buildWorkspaceFileSnapshot(workspace, {
      basePath: "",
      deleteExtraneous: true
    });
    if (!snapshot) {
      return null;
    }
    const existingTree = typeof checkpointTreeApi.loadCheckpointTree === "function"
      ? await checkpointTreeApi.loadCheckpointTree({ treeId })
      : null;
    if (!existingTree && typeof checkpointTreeApi.startCheckpointTree === "function") {
      await checkpointTreeApi.startCheckpointTree({
        treeId,
        kind: "workspace_files",
        ownerId: workspace.workspaceId,
        rootNodeId: "root",
        rootLabel: `Workspace files: ${workspace.title || workspace.workspaceId}`,
        resumePolicy: {
          mode: "append-only-workspace-file-restore",
          idempotencyKey: "treeId+nodeId"
        }
      });
    }
    if (typeof checkpointTreeApi.upsertCheckpointNode !== "function") {
      return null;
    }
    const nodeId = `commit:${stateCommit.commitId}`;
    const checkpointNode = {
      treeId,
      nodeId,
      parentId: "root",
      label: `${action || operationId}: ${relativePath || workspace.workspaceId}`,
      status: "completed",
      cursor: {
        commitId: stateCommit.commitId,
        afterRoot: stateCommit.afterRoot
      },
      totals: {
        files: snapshot.files.length,
        contentRefs: stateCommit.contentRefs.length
      },
      metadata: {
        workspaceId: workspace.workspaceId,
        operationId,
        action,
        path: relativePath || "",
        stateCommit,
        workspaceFileSnapshot: snapshot,
        ...(preimageSnapshot ? { workspaceFilePreimageSnapshot: preimageSnapshot } : {}),
        ...(mutationOrigin ? { mutationOrigin } : {})
      },
      eventType: "workspace.file.checkpointed"
    };
    await checkpointTreeApi.upsertCheckpointNode(checkpointNode);
    return {
      treeId,
      nodeId,
      checkpointBindingDigest: crypto.createHash("sha256")
        .update(JSON.stringify(checkpointNode.metadata))
        .digest("hex"),
      snapshotFileCount: snapshot.files.length,
      preimageEntryCount: preimageSnapshot
        ? asArray(preimageSnapshot.files).length + asArray(preimageSnapshot.localDirectorySnapshots)
          .reduce((count, localSnapshot) => count + asArray(localSnapshot?.entries).length, 0)
        : 0
    };
  }


  return {
    decodeWorkspaceFileContent,
    workspaceStateScope,
    workspaceCheckpointTreeId,
    compactStateCommit,
    filePayloadMetadata,
    archiveWorkspacePath,
    recordWorkspaceUploadIngest,
    workspaceDownloadCacheReceipt,
    workspaceListCacheReceipt,
    commitWorkspaceFileState,
    buildWorkspaceFileSnapshot,
    recordWorkspaceFileCheckpoint
  };
}
