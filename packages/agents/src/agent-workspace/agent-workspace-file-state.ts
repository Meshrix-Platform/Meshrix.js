import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  asArray,
  asObject,
  normalizeSha256,
  normalizeWorkspaceRelativePath,
  uniqueStrings
} from "./agent-workspace-support.ts";

const MATERIALIZATION_ARCHIVE_CHUNK_BYTES: any = 64 * 1024;

export function createAgentWorkspaceFileStateApi({
  merkleState = null,
  checkpointTreeApi = null,
  resolveWorkspacePath,
  listWorkspaceFiles
}: Record<string, any> = {}) : any {
  let fullSnapshotBuilds: any = 0;
  let incrementalCheckpointBuilds: any = 0;
  let unrelatedEnumerations: any = 0;
  let unrelatedReads: any = 0;
  let unrelatedHashes: any = 0;
  let migratedCheckpointSnapshots: any = 0;

  function getRefactorInstrumentation() : any {
    return {
      schemaVersion: "v0.0.1:workspace:file-state-refactor-instrumentation-1",
      fullSnapshotBuilds,
      incrementalCheckpointBuilds,
      unrelatedEnumerations,
      unrelatedReads,
      unrelatedHashes,
      migratedCheckpointSnapshots
    };
  }

  function decodeWorkspaceFileContent(input: Record<string, any> = {}) : any {
    if (Object.hasOwn(input, "contentBase64")) {
      const raw: any = String(input.contentBase64 || "").trim();
      if (!raw) {
        return Buffer.alloc(0);
      }
      return Buffer.from(raw, "base64");
    }
    if (Object.hasOwn(input, "content")) {
      return Buffer.from(
        String(input.content || ""),
        String(input.encoding || "utf8") as BufferEncoding
      );
    }
    throw new Error("content 或 contentBase64 至少提供一个。");
  }

  function workspaceStateScope(workspace?: any) : any {
    return `workspace:${workspace.workspaceId}`;
  }

  function workspaceCheckpointTreeId(workspace?: any) : any {
    return checkpointTreeApi?.checkpointTreeId
      ? checkpointTreeApi.checkpointTreeId("workspace-files", workspace.workspaceId)
      : "";
  }

  function compactStateCommit(commit: any = null) : any {
    return commit
      ? {
          commitId: commit.commitId,
          eventHash: commit.eventHash,
          eventId: commit.eventId,
          operationId: commit.operationId,
          beforeRoot: commit.beforeRoot,
          afterRoot: commit.afterRoot,
          contentRefs: asArray(commit.contentRefs),
          indexRoots: asObject(commit.indexRoots),
          payload: asObject(commit.payload)
        }
      : null;
  }

  function filePayloadMetadata(file: Record<string, any> = {}) : any {
    return {
      type: file.type || "file",
      sizeBytes: Number(file.sizeBytes || 0),
      contentSha256: file.contentSha256 || "",
      updatedAt: file.updatedAt || file.mtime || ""
    };
  }

  async function archiveWorkspacePath(workspace?: any, relativePath?: any, metadata: Record<string, any> = {}) : Promise<any> {
    if (!merkleState) {
      return null;
    }
    const resolved: any = resolveWorkspacePath(workspace, relativePath, { allowEmpty: false });
    if (!fs.existsSync(resolved.absolutePath)) {
      return null;
    }
    const { contentBuffer = null, ...archiveMetadata } = asObject(metadata);
    const stat: any = fs.lstatSync(resolved.absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error("不允许归档符号链接。");
    }
    if (stat.isFile()) {
      const content: any = Buffer.isBuffer(contentBuffer) ? contentBuffer : fs.readFileSync(resolved.absolutePath);
      const block: any = await merkleState.cas.putBlock(content, {
        codec: "raw",
        metadata: {
          workspaceId: workspace.workspaceId,
          relativePath: resolved.relativePath,
          ...archiveMetadata
        }
      });
      const manifest: any = await merkleState.merkleDag.buildManifest("workspace-file", [
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
          contentSha256: block.payloadHash,
          contentCid: block.cid
        }
      };
    }
    if (!stat.isDirectory()) {
      throw new Error("不允许归档非普通文件或目录。");
    }
    const entries: any[] = [];
    const refs: any[] = [];
    const visit: any = async (absoluteDir?: any, relativeDir?: any) : Promise<any> => {
      const children: any = fs.readdirSync(absoluteDir, { withFileTypes: true })
        .filter((entry?: any) : any => !entry.name.startsWith("."))
        .sort((left?: any, right?: any) : any => left.name.localeCompare(right.name));
      for (const child of children) {
        const childRelativePath: any = relativeDir ? `${relativeDir}/${child.name}` : child.name;
        const childAbsolutePath: any = path.join(absoluteDir, child.name);
        const childStat: any = fs.lstatSync(childAbsolutePath);
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
        const content: any = fs.readFileSync(childAbsolutePath);
        const block: any = await merkleState.cas.putBlock(content, {
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
    const manifest: any = await merkleState.merkleDag.buildManifest("workspace-directory", entries, {
      workspaceId: workspace.workspaceId,
      relativePath: resolved.relativePath,
      type: "directory",
      ...asObject(metadata)
    });
    return {
      rootCid: manifest.rootCid,
      contentRefs: [manifest.rootCid, ...refs],
      entries: entries.map((entry?: any) : any => ({ ...entry })),
      metadata: {
        type: "directory",
        fileCount: entries.length
      }
    };
  }

  async function archiveWorkspaceFileSource(
    workspace?: any,
    relativePath?: any,
    {
      source,
      expectedSha256,
      expectedByteCount,
      metadata = {}
    }: Record<string, any> = {}
  ) : Promise<any> {
    if (
      !merkleState?.cas?.putBlock ||
      !merkleState?.merkleDag?.buildManifest ||
      !source ||
      typeof source[Symbol.asyncIterator] !== "function"
    ) {
      throw new Error("Workspace materialization archive source is unavailable.");
    }
    const normalizedPath: any = normalizeWorkspaceRelativePath(
      relativePath,
      { allowEmpty: false }
    );
    const expectedDigest: any = normalizeSha256(expectedSha256);
    const expectedBytes: any = Number(expectedByteCount);
    if (
      !expectedDigest ||
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 0
    ) {
      throw new Error("Workspace materialization archive binding is invalid.");
    }
    const hasher: any = crypto.createHash("sha256");
    const entries: any[] = [];
    const refs: any[] = [];
    let byteLength: any = 0;
    let chunkIndex: any = 0;
    const archiveChunk: any = async (chunk?: any) : Promise<any> => {
      const block: any = await merkleState.cas.putBlock(chunk, {
        codec: "raw",
        metadata: {
          workspaceId: workspace.workspaceId,
          relativePath: normalizedPath,
          chunkIndex,
          materialized: true,
          ...asObject(metadata)
        }
      });
      const chunkPath: any =
        `${normalizedPath}#${String(chunkIndex).padStart(12, "0")}`;
      entries.push({
        path: chunkPath,
        cid: block.cid,
        byteLength: block.byteLength,
        metadata: {
          chunkIndex,
          contentSha256: block.payloadHash
        }
      });
      refs.push(block.cid);
      chunkIndex += 1;
    };
    for await (const value of source) {
      const buffer: any = Buffer.isBuffer(value)
        ? value
        : ArrayBuffer.isView(value)
          ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          : null;
      if (!buffer) {
        throw new Error("Workspace materialization archive emitted non-binary content.");
      }
      for (
        let offset: any = 0;
        offset < buffer.byteLength;
        offset += MATERIALIZATION_ARCHIVE_CHUNK_BYTES
      ) {
        const chunk: any = buffer.subarray(
          offset,
          Math.min(
            buffer.byteLength,
            offset + MATERIALIZATION_ARCHIVE_CHUNK_BYTES
          )
        );
        if (byteLength + chunk.byteLength > expectedBytes) {
          throw new Error("Workspace materialization archive exceeded its byte binding.");
        }
        hasher.update(chunk);
        byteLength += chunk.byteLength;
        await archiveChunk(chunk);
      }
    }
    if (entries.length === 0) {
      await archiveChunk(Buffer.alloc(0));
    }
    const contentSha256: any = hasher.digest("hex");
    if (
      byteLength !== expectedBytes ||
      contentSha256 !== expectedDigest
    ) {
      throw new Error("Workspace materialization archive does not match its binding.");
    }
    const manifest: any = await merkleState.merkleDag.buildManifest(
      "workspace-file-chunks",
      entries,
      {
        workspaceId: workspace.workspaceId,
        relativePath: normalizedPath,
        type: "file",
        sizeBytes: byteLength,
        contentSha256,
        chunkCount: entries.length,
        materialized: true,
        ...asObject(metadata)
      }
    );
    return {
      rootCid: manifest.rootCid,
      contentRefs: uniqueStrings([manifest.rootCid, ...refs]),
      metadata: {
        type: "file",
        sizeBytes: byteLength,
        contentSha256,
        chunkCount: entries.length
      }
    };
  }

  async function recordWorkspaceUploadIngest({
    workspace,
    relativePath,
    contentBuffer,
    operationId
  }: Record<string, any> = {}) : Promise<any> {
    if (!merkleState || typeof merkleState.uploadManifest?.materialize !== "function") {
      return null;
    }
    const content: any = Buffer.isBuffer(contentBuffer) ? contentBuffer : Buffer.from(contentBuffer || "");
    const block: any = await merkleState.cas.putBlock(content, {
      codec: "raw",
      metadata: {
        workspaceId: workspace.workspaceId,
        relativePath,
        operationId,
        ingest: true
      }
    });
    const chunkRecord: any = {
      fileId: relativePath,
      relativePath,
      chunkIndex: 0,
      offset: 0,
      byteLength: content.length,
      chunkCid: block.cid,
      chunkHash: block.payloadHash
    };
    const manifest: any = await merkleState.uploadManifest.materialize({
      scope: workspaceStateScope(workspace),
      files: [{
        relativePath,
        byteLength: content.length,
        sha256: normalizeSha256(block.payloadHash)
      }],
      records: [chunkRecord]
    });
    return {
      protocolVersion: merkleState.protocolVersion,
      status: "archived",
      manifestRootCid: manifest.rootCid,
      chunkCid: block.cid,
      chunkHash: block.payloadHash,
      recordCount: manifest.recordCount,
      nextOffset: manifest.nextOffset,
      contentRefs: uniqueStrings([manifest.rootCid, block.cid])
    };
  }

  async function workspaceDownloadCacheReceipt(workspace?: any, relativePath?: any) : Promise<any> {
    if (!merkleState || typeof merkleState.stateCommit?.begin !== "function") {
      return null;
    }
    const state: any = await merkleState.stateCommit.begin({
      scope: workspaceStateScope(workspace)
    });
    const indexRootCid: any = String(state.currentRoot || "");
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
    const entry: any = await merkleState.merkleIndex.get(indexRootCid, relativePath);
    const proof: any = await merkleState.merkleIndex.prove(indexRootCid, relativePath);
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

  async function workspaceListCacheReceipt(workspace?: any, prefix: any = "") : Promise<any> {
    if (!merkleState || typeof merkleState.stateCommit?.begin !== "function") {
      return null;
    }
    const state: any = await merkleState.stateCommit.begin({
      scope: workspaceStateScope(workspace)
    });
    const indexRootCid: any = String(state.currentRoot || "");
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
    const entries: any = await merkleState.merkleIndex.prefix(indexRootCid, prefix);
    const proof: any = await merkleState.merkleIndex.prove(indexRootCid, prefix || entries[0]?.key || "");
    return {
      protocolVersion: merkleState.protocolVersion,
      cacheFamily: "merkle-radix-compatible",
      implementation: "sorted-chunk-index-v1",
      cacheKey: `${workspaceStateScope(workspace)}:${prefix || "/"}`,
      hit: entries.length > 0,
      indexRootCid,
      prefix,
      entryCount: entries.length,
      valueRoots: uniqueStrings(entries.map((entry?: any) : any => entry.valueRef)).slice(0, 100),
      proofHash: proof.proofHash
    };
  }

  async function commitWorkspaceFileState(input: Record<string, any> = {}) : Promise<any> {
    const {
      workspace,
      operationId,
      expectedCurrentRoot,
      idempotencyKey,
      mutations = [],
      contentRefs = [],
      payload = {}
    } = input;
    if (!merkleState || typeof merkleState.stateCommit?.commit !== "function") {
      return null;
    }
    const commitInput: Record<string, any> = {
      scope: workspaceStateScope(workspace),
      operationId,
      mutations,
      contentRefs: uniqueStrings(contentRefs),
      payload: {
        workspaceId: workspace.workspaceId,
        ...asObject(payload)
      }
    };
    if (Object.hasOwn(input, "expectedCurrentRoot")) {
      commitInput.expectedCurrentRoot = String(expectedCurrentRoot || "");
    }
    if (Object.hasOwn(input, "idempotencyKey")) {
      commitInput.idempotencyKey = String(idempotencyKey || "");
    }
    return compactStateCommit(
      await merkleState.stateCommit.commit(commitInput)
    );
  }

  async function buildWorkspaceFileSnapshot(workspace?: any, { basePath = "", deleteExtraneous = true }: Record<string, any> = {}) : Promise<any> {
    if (!merkleState) {
      return null;
    }
    fullSnapshotBuilds += 1;
    const listed: any = await listWorkspaceFiles({
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
    const files: any[] = [];
    for (const file of listed.files) {
      const resolved: any = resolveWorkspacePath(workspace, file.relativePath);
      const content: any = fs.readFileSync(resolved.absolutePath);
      const block: any = await merkleState.cas.putBlock(content, {
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

  async function captureWorkspaceFilePreimage(workspace?: any, relativePaths: any[] = []) : Promise<any> {
    if (!merkleState?.cas?.putBlock) {
      return null;
    }
    const files: any[] = [];
    const captureFile: any = async (relativePath?: any, absolutePath?: any) : Promise<any> => {
      const content: any = fs.readFileSync(absolutePath);
      const block: any = await merkleState.cas.putBlock(content, {
        codec: "raw",
        metadata: {
          workspaceId: workspace.workspaceId,
          relativePath,
          preimage: true
        }
      });
      files.push({
        path: relativePath,
        exists: true,
        contentCid: block.cid,
        contentSha256: normalizeSha256(block.payloadHash),
        byteLength: block.byteLength,
        encoding: "base64"
      });
    };
    for (const rawPath of uniqueStrings(asArray(relativePaths).map(String).filter(Boolean))) {
      const relativePath: any = normalizeWorkspaceRelativePath(rawPath, { allowEmpty: false });
      const resolved: any = resolveWorkspacePath(workspace, relativePath);
      let stat: any = null;
      try {
        stat = fs.lstatSync(resolved.absolutePath);
      } catch {
        stat = null;
      }
      if (!stat) {
        files.push({ path: relativePath, exists: false });
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) {
        continue;
      }
      if (stat.isFile()) {
        await captureFile(relativePath, resolved.absolutePath);
        continue;
      }
      const collect: any = (absoluteDir?: any, relativeDir?: any) : any => {
        const entries: any = fs.readdirSync(absoluteDir, { withFileTypes: true })
          .filter((entry?: any) : any => !entry.name.startsWith("."))
          .sort((left?: any, right?: any) : any => left.name.localeCompare(right.name));
        for (const entry of entries) {
          const childRelativePath: any = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
          const childAbsolutePath: any = path.join(absoluteDir, entry.name);
          const childStat: any = fs.lstatSync(childAbsolutePath);
          if (childStat.isSymbolicLink()) {
            continue;
          }
          if (childStat.isDirectory()) {
            collect(childAbsolutePath, childRelativePath);
          } else if (childStat.isFile()) {
            subtreePaths.push(childRelativePath);
          }
        }
      };
      const subtreePaths: any[] = [];
      collect(resolved.absolutePath, relativePath);
      for (const subtreePath of subtreePaths) {
        const subtreeResolved: any = resolveWorkspacePath(workspace, subtreePath);
        await captureFile(subtreePath, subtreeResolved.absolutePath);
      }
    }
    const byPath: any = new Map<any, any>();
    for (const file of files) byPath.set(String(file.path), file);
    return {
      workspaceId: workspace.workspaceId,
      basePath: "",
      deleteExtraneous: false,
      incremental: true,
      files: [...byPath.values()]
    };
  }

  async function buildWorkspaceFileSnapshotFromStateRoot(workspace?: any, stateRoot: any = "") : Promise<any> {
    const root: any = String(stateRoot || "").trim();
    if (!root || typeof merkleState?.merkleIndex?.prefix !== "function") {
      throw new Error("Workspace checkpoint state root authority is unavailable.");
    }
    const entries: any = await merkleState.merkleIndex.prefix(root, "", { limit: 100_000 });
    const files: any[] = [];
    for (const entry of asArray(entries)) {
      const relativePath: any = String(entry?.key || "");
      const metadata: any = asObject(entry?.metadata);
      if (!relativePath || relativePath.startsWith("__mount__/") || metadata.type === "directory") {
        continue;
      }
      const contentCid: any = String(metadata.contentCid || entry?.valueRef || "");
      if (!contentCid) {
        throw new Error("Workspace checkpoint state entry has no content authority.");
      }
      files.push({
        path: relativePath,
        exists: true,
        contentCid,
        contentSha256: normalizeSha256(metadata.contentSha256 || ""),
        byteLength: Number(metadata.sizeBytes ?? 0),
        encoding: "base64"
      });
    }
    return {
      schemaVersion: "v0.0.1:workspace:file-root-checkpoint-1",
      workspaceId: workspace.workspaceId,
      stateRoot: root,
      incremental: false,
      basePath: "",
      deleteExtraneous: true,
      files
    };
  }

  function buildIncrementalCheckpointSnapshot({
    workspace,
    stateCommit,
    mutations = []
  }: Record<string, any> = {}) : any {
    incrementalCheckpointBuilds += 1;
    const restorePathForKey: any = (key?: any) : any => {
      const raw: any = String(key || "").trim();
      if (raw.startsWith("__mount__/")) {
        const parts: any = raw.split("/");
        if (parts.length > 2) return parts.slice(2).join("/");
      }
      return raw;
    };
    const files: any[] = [];
    for (const mutation of asArray(mutations)) {
      const rawKey: any = String(mutation?.key || mutation?.path || "").trim();
      if (!rawKey) continue;
      const relativePath: any = normalizeWorkspaceRelativePath(restorePathForKey(rawKey), { allowEmpty: false });
      const exists: any = !["delete", "remove"].includes(String(mutation?.action || ""));
      if (!exists) {
        files.push({ path: relativePath, exists: false });
        continue;
      }
      const metadata: any = asObject(mutation.metadata);
      const contentSha256: any = normalizeSha256(metadata.contentSha256 || mutation?.contentSha256 || "");
      const contentCid: any = String(metadata.contentCid || "");
      if (!contentCid) {
        continue;
      }
      files.push({
        path: relativePath,
        exists: true,
        contentCid,
        contentSha256,
        byteLength: Number(metadata.sizeBytes ?? mutation?.byteLength ?? 0),
        encoding: "base64"
      });
    }
    return {
      schemaVersion: "v0.0.1:workspace:file-incremental-checkpoint-1",
      workspaceId: workspace.workspaceId,
      stateRoot: String(stateCommit?.afterRoot || ""),
      incremental: true,
      basePath: "",
      files
    };
  }

  function migrateWorkspaceFileCheckpointSnapshot(snapshot: any = null, { stateCommit = null }: Record<string, any> = {}) : any {
    if (!snapshot || snapshot.incremental === true) {
      return snapshot;
    }
    const files: any[] = asArray(snapshot.files || snapshot.entries)
      .map((entry?: any) : any => ({
        path: String(entry?.path || entry?.relativePath || ""),
        exists: entry?.exists !== false,
        contentCid: String(entry?.contentCid || entry?.cid || ""),
        contentSha256: normalizeSha256(entry?.contentSha256 || entry?.sha256 || ""),
        byteLength: Number(entry?.byteLength ?? entry?.sizeBytes ?? 0),
        encoding: String(entry?.encoding || "base64")
      }));
    return {
      schemaVersion: "v0.0.1:workspace:file-incremental-checkpoint-1",
      workspaceId: snapshot.workspaceId || "",
      stateRoot: String(stateCommit?.afterRoot || snapshot.stateRoot || ""),
      incremental: true,
      basePath: String(snapshot.basePath || ""),
      files
    };
  }

  async function migrateCheckpointTreeFileSnapshots({ tree }: Record<string, any> = {}) : Promise<any> {
    if (!tree || typeof checkpointTreeApi?.upsertCheckpointNode !== "function") {
      return { ok: false, migrated: 0 };
    }
    const nodes: any[] = Object.values(asObject(tree.nodes)) as any[];
    const pending: any[] = [];
    for (const node of nodes) {
      const metadata: any = asObject(node?.metadata);
      const legacy: any = metadata.workspaceFileSnapshot || metadata.fileSnapshot || null;
      if (!legacy || legacy.incremental === true) continue;
      const migrated: any = migrateWorkspaceFileCheckpointSnapshot(legacy, {
        stateCommit: metadata.stateCommit
      });
      pending.push({
        node,
        metadata,
        migrated
      });
    }
    for (const entry of pending) {
      const legacyFiles: any = asArray(entry.migrated.files);
      const originalFiles: any = asArray(entry.metadata.workspaceFileSnapshot?.files || entry.metadata.fileSnapshot?.files);
      if (legacyFiles.length !== originalFiles.length) {
        return { ok: false, migrated: 0, error: "workspace checkpoint migration file count mismatch." };
      }
      for (let index: any = 0; index < legacyFiles.length; index += 1) {
        if (
          String(legacyFiles[index].path) !== String(originalFiles[index]?.path || originalFiles[index]?.relativePath || "") ||
          legacyFiles[index].exists !== (originalFiles[index]?.exists !== false) ||
          legacyFiles[index].contentSha256 !== normalizeSha256(originalFiles[index]?.contentSha256 || originalFiles[index]?.sha256 || "")
        ) {
          return { ok: false, migrated: 0, error: "workspace checkpoint migration restore projection mismatch." };
        }
      }
    }
    let migrated: any = 0;
    for (const entry of pending) {
      const nextMetadata: Record<string, any> = {
        ...entry.metadata,
        workspaceFileSnapshot: entry.migrated
      };
      if (entry.metadata.fileSnapshot && !entry.metadata.workspaceFileSnapshot) {
        delete nextMetadata.fileSnapshot;
        nextMetadata.workspaceFileSnapshot = entry.migrated;
      }
      await checkpointTreeApi.upsertCheckpointNode({
        ...entry.node,
        metadata: nextMetadata
      });
      migrated += 1;
      migratedCheckpointSnapshots += 1;
    }
    return { ok: true, migrated };
  }

  async function recordWorkspaceFileCheckpoint({
    workspace,
    operationId,
    stateCommit,
    action,
    path: relativePath,
    preimageSnapshot = null,
    mutationOrigin = null,
    workspaceFileSnapshot = null,
    mutations = [],
    fullSnapshot = false
  }: Record<string, any> = {}) : Promise<any> {
    if (!checkpointTreeApi || !stateCommit?.commitId) {
      return null;
    }
    const treeId: any = workspaceCheckpointTreeId(workspace);
    if (!treeId) {
      return null;
    }
    const snapshot: any = workspaceFileSnapshot ||
      (fullSnapshot === true
        ? await buildWorkspaceFileSnapshot(workspace, {
            basePath: "",
            deleteExtraneous: true
          })
        : buildIncrementalCheckpointSnapshot({
            workspace,
            stateCommit,
            mutations
          }));
    if (!snapshot) {
      return null;
    }
    const existingTree: any = typeof checkpointTreeApi.loadCheckpointTree === "function"
      ? await checkpointTreeApi.loadCheckpointTree({ treeId })
      : null;
    if (existingTree) {
      const migration: any = await migrateCheckpointTreeFileSnapshots({ tree: existingTree });
      if (migration.ok !== true) {
        throw new Error(migration.error || "Workspace checkpoint migration failed.");
      }
    }
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
    const nodeId: any = `commit:${stateCommit.commitId}`;
    const checkpointNode: Record<string, any> = {
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
    const checkpointBindingDigest: any = crypto.createHash("sha256")
      .update(canonicalJson(checkpointNode.metadata))
      .digest("hex");
    const checkpointIdempotencyKey: any = crypto.createHash("sha256")
      .update(canonicalJson(checkpointNode))
      .digest("hex");
    await checkpointTreeApi.upsertCheckpointNode({
      ...checkpointNode,
      idempotencyKey: checkpointIdempotencyKey
    });
    return {
      treeId,
      nodeId,
      checkpointBindingDigest,
      snapshotFileCount: snapshot.files.length,
      preimageEntryCount: preimageSnapshot
        ? asArray(preimageSnapshot.files).length + asArray(preimageSnapshot.localDirectorySnapshots)
          .reduce((count?: any, localSnapshot?: any) : any => count + asArray(localSnapshot?.entries).length, 0)
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
    archiveWorkspaceFileSource,
    recordWorkspaceUploadIngest,
    workspaceDownloadCacheReceipt,
    workspaceListCacheReceipt,
    commitWorkspaceFileState,
    buildWorkspaceFileSnapshot,
    buildWorkspaceFileSnapshotFromStateRoot,
    recordWorkspaceFileCheckpoint,
    captureWorkspaceFilePreimage,
    migrateWorkspaceFileCheckpointSnapshot,
    migrateCheckpointTreeFileSnapshots,
    getRefactorInstrumentation
  };
}
