import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  asArray,
  asObject,
  normalizeSha256,
  normalizeWorkspaceRelativePath,
  uniqueStrings,
} from "./agent-workspace-support.ts";

type DataRecord = Record<string, unknown>;
interface Workspace extends DataRecord {
  workspaceId: string;
  ownerUserId?: string;
  title?: string;
}
interface ResolvedPath {
  absolutePath: string;
  relativePath: string;
}
interface CasBlock {
  cid: string;
  byteLength: number;
  payloadHash: string;
}
interface Manifest {
  rootCid: string;
  recordCount?: number;
  nextOffset?: number;
}
interface IndexEntry {
  key: string;
  valueRef?: string;
  metadata?: DataRecord;
}
interface StateCommit extends DataRecord {
  commitId: string;
  eventHash?: string;
  eventId?: string;
  operationId?: string;
  beforeRoot?: string;
  afterRoot?: string;
  contentRefs?: unknown[];
  indexRoots?: unknown;
  payload?: unknown;
}
interface SnapshotFile {
  path: string;
  exists: boolean;
  contentCid?: string;
  contentSha256?: string;
  byteLength?: number;
  encoding?: string;
}
export interface FileSnapshot extends DataRecord {
  workspaceId: string;
  stateRoot?: string;
  incremental?: boolean;
  basePath: string;
  deleteExtraneous?: boolean;
  files: SnapshotFile[];
}
interface ArchiveReceipt {
  rootCid: string;
  contentRefs: string[];
  metadata: DataRecord;
  entries?: DataRecord[];
}
interface MerkleState {
  protocolVersion?: string;
  cas: { putBlock(content: Buffer, options: DataRecord): Promise<CasBlock> };
  merkleDag: {
    buildManifest(
      kind: string,
      entries: DataRecord[],
      metadata: DataRecord,
    ): Promise<Manifest>;
  };
  stateCommit?: {
    begin(input: DataRecord): Promise<DataRecord>;
    commit(input: DataRecord): Promise<unknown>;
  };
  merkleIndex: {
    get(root: string, key: string): Promise<IndexEntry | null>;
    prove(root: string, key: string): Promise<{ proofHash: string }>;
    prefix(
      root: string,
      prefix: string,
      options?: DataRecord,
    ): Promise<IndexEntry[]>;
  };
  uploadManifest?: { materialize(input: DataRecord): Promise<Manifest> };
}
interface CheckpointTreeApi {
  checkpointTreeId?(kind: string, workspaceId: string): string;
  loadCheckpointTree?(input: DataRecord): Promise<unknown>;
  startCheckpointTree?(input: DataRecord): Promise<unknown>;
  upsertCheckpointNode?(input: DataRecord): Promise<unknown>;
}
interface FileStateDependencies {
  merkleState?: MerkleState | null;
  checkpointTreeApi?: CheckpointTreeApi | null;
  resolveWorkspacePath(
    workspace: Workspace,
    relativePath: unknown,
    options?: DataRecord,
  ): ResolvedPath;
  listWorkspaceFiles(input: DataRecord): Promise<{
    ok: boolean;
    files: Array<DataRecord & { relativePath: string }>;
  }>;
}
function record(value: unknown): DataRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as DataRecord)
    : null;
}
function workspaceRecord(value: unknown): Workspace {
  const item = record(value);
  if (!item || typeof item.workspaceId !== "string" || !item.workspaceId)
    throw new TypeError("Workspace identity is invalid.");
  return item as Workspace;
}
function commitRecord(value: unknown): StateCommit | null {
  const item = record(value);
  return item && typeof item.commitId === "string"
    ? (item as StateCommit)
    : null;
}

const MATERIALIZATION_ARCHIVE_CHUNK_BYTES = 64 * 1024;

export function createAgentWorkspaceFileStateApi({
  merkleState = null,
  checkpointTreeApi = null,
  resolveWorkspacePath,
  listWorkspaceFiles,
}: FileStateDependencies) {
  let fullSnapshotBuilds = 0;
  let incrementalCheckpointBuilds = 0;
  let unrelatedEnumerations = 0;
  let unrelatedReads = 0;
  let unrelatedHashes = 0;
  let migratedCheckpointSnapshots = 0;

  function getRefactorInstrumentation() {
    return {
      schemaVersion: "v0.0.1:workspace:file-state-refactor-instrumentation-1",
      fullSnapshotBuilds,
      incrementalCheckpointBuilds,
      unrelatedEnumerations,
      unrelatedReads,
      unrelatedHashes,
      migratedCheckpointSnapshots,
    };
  }

  function decodeWorkspaceFileContent(input: DataRecord = {}): Buffer {
    if (Object.hasOwn(input, "contentBase64")) {
      const raw = String(input.contentBase64 || "").trim();
      if (!raw) {
        return Buffer.alloc(0);
      }
      return Buffer.from(raw, "base64");
    }
    if (Object.hasOwn(input, "content")) {
      return Buffer.from(
        String(input.content || ""),
        String(input.encoding || "utf8") as BufferEncoding,
      );
    }
    throw new Error("content 或 contentBase64 至少提供一个。");
  }

  function workspaceStateScope(workspace: Workspace): string {
    return `workspace:${workspace.workspaceId}`;
  }

  function workspaceCheckpointTreeId(workspace: Workspace): string {
    return checkpointTreeApi?.checkpointTreeId
      ? checkpointTreeApi.checkpointTreeId(
          "workspace-files",
          workspace.workspaceId,
        )
      : "";
  }

  function compactStateCommit(value: unknown = null) {
    const commit = commitRecord(value);
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
          payload: asObject(commit.payload),
        }
      : null;
  }

  function filePayloadMetadata(file: DataRecord = {}): DataRecord {
    return {
      type: file.type || "file",
      sizeBytes: Number(file.sizeBytes || 0),
      contentSha256: file.contentSha256 || "",
      updatedAt: file.updatedAt || file.mtime || "",
    };
  }

  async function archiveWorkspacePath(
    workspace: Workspace,
    relativePath: unknown,
    metadata: DataRecord = {},
  ): Promise<ArchiveReceipt | null> {
    if (!merkleState) {
      return null;
    }
    const resolved = resolveWorkspacePath(workspace, relativePath, {
      allowEmpty: false,
    });
    if (!fs.existsSync(resolved.absolutePath)) {
      return null;
    }
    const { contentBuffer = null, ...archiveMetadata } = asObject(metadata);
    const stat = fs.lstatSync(resolved.absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error("不允许归档符号链接。");
    }
    if (stat.isFile()) {
      const content = Buffer.isBuffer(contentBuffer)
        ? contentBuffer
        : fs.readFileSync(resolved.absolutePath);
      const block = await merkleState.cas.putBlock(content, {
        codec: "raw",
        metadata: {
          workspaceId: workspace.workspaceId,
          relativePath: resolved.relativePath,
          ...archiveMetadata,
        },
      });
      const manifest = await merkleState.merkleDag.buildManifest(
        "workspace-file",
        [
          {
            path: resolved.relativePath,
            cid: block.cid,
            byteLength: block.byteLength,
            metadata: {
              contentSha256: block.payloadHash,
            },
          },
        ],
        {
          workspaceId: workspace.workspaceId,
          relativePath: resolved.relativePath,
          type: "file",
          ...archiveMetadata,
        },
      );
      return {
        rootCid: manifest.rootCid,
        contentRefs: [manifest.rootCid, block.cid],
        metadata: {
          type: "file",
          sizeBytes: block.byteLength,
          contentSha256: block.payloadHash,
          contentCid: block.cid,
        },
      };
    }
    if (!stat.isDirectory()) {
      throw new Error("不允许归档非普通文件或目录。");
    }
    const entries: DataRecord[] = [];
    const refs: string[] = [];
    const visit = async (
      absoluteDir: string,
      relativeDir: string,
    ): Promise<void> => {
      const children = fs
        .readdirSync(absoluteDir, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith("."))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        const childRelativePath = relativeDir
          ? `${relativeDir}/${child.name}`
          : child.name;
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
            ...asObject(metadata),
          },
        });
        refs.push(block.cid);
        entries.push({
          path: childRelativePath,
          cid: block.cid,
          byteLength: block.byteLength,
          metadata: {
            contentSha256: block.payloadHash,
          },
        });
      }
    };
    await visit(resolved.absolutePath, resolved.relativePath);
    const manifest = await merkleState.merkleDag.buildManifest(
      "workspace-directory",
      entries,
      {
        workspaceId: workspace.workspaceId,
        relativePath: resolved.relativePath,
        type: "directory",
        ...asObject(metadata),
      },
    );
    return {
      rootCid: manifest.rootCid,
      contentRefs: [manifest.rootCid, ...refs],
      entries: entries.map((entry) => ({ ...entry })),
      metadata: {
        type: "directory",
        fileCount: entries.length,
      },
    };
  }

  async function archiveWorkspaceFileSource(
    workspace: Workspace,
    relativePath: unknown,
    {
      source,
      expectedSha256,
      expectedByteCount,
      metadata = {},
    }: {
      source?: AsyncIterable<unknown>;
      expectedSha256?: unknown;
      expectedByteCount?: unknown;
      metadata?: DataRecord;
    } = {},
  ): Promise<ArchiveReceipt> {
    if (
      !merkleState?.cas?.putBlock ||
      !merkleState?.merkleDag?.buildManifest ||
      !source ||
      typeof source[Symbol.asyncIterator] !== "function"
    ) {
      throw new Error(
        "Workspace materialization archive source is unavailable.",
      );
    }
    const normalizedPath = normalizeWorkspaceRelativePath(relativePath, {
      allowEmpty: false,
    });
    const expectedDigest = normalizeSha256(expectedSha256);
    const expectedBytes = Number(expectedByteCount);
    if (
      !expectedDigest ||
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 0
    ) {
      throw new Error("Workspace materialization archive binding is invalid.");
    }
    const hasher = crypto.createHash("sha256");
    const entries: DataRecord[] = [];
    const refs: string[] = [];
    let byteLength = 0;
    let chunkIndex = 0;
    const archiveChunk = async (chunk: Buffer): Promise<void> => {
      const block = await merkleState.cas.putBlock(chunk, {
        codec: "raw",
        metadata: {
          workspaceId: workspace.workspaceId,
          relativePath: normalizedPath,
          chunkIndex,
          materialized: true,
          ...asObject(metadata),
        },
      });
      const chunkPath = `${normalizedPath}#${String(chunkIndex).padStart(12, "0")}`;
      entries.push({
        path: chunkPath,
        cid: block.cid,
        byteLength: block.byteLength,
        metadata: {
          chunkIndex,
          contentSha256: block.payloadHash,
        },
      });
      refs.push(block.cid);
      chunkIndex += 1;
    };
    for await (const value of source) {
      const buffer = Buffer.isBuffer(value)
        ? value
        : ArrayBuffer.isView(value)
          ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          : null;
      if (!buffer) {
        throw new Error(
          "Workspace materialization archive emitted non-binary content.",
        );
      }
      for (
        let offset = 0;
        offset < buffer.byteLength;
        offset += MATERIALIZATION_ARCHIVE_CHUNK_BYTES
      ) {
        const chunk = buffer.subarray(
          offset,
          Math.min(
            buffer.byteLength,
            offset + MATERIALIZATION_ARCHIVE_CHUNK_BYTES,
          ),
        );
        if (byteLength + chunk.byteLength > expectedBytes) {
          throw new Error(
            "Workspace materialization archive exceeded its byte binding.",
          );
        }
        hasher.update(chunk);
        byteLength += chunk.byteLength;
        await archiveChunk(chunk);
      }
    }
    if (entries.length === 0) {
      await archiveChunk(Buffer.alloc(0));
    }
    const contentSha256 = hasher.digest("hex");
    if (byteLength !== expectedBytes || contentSha256 !== expectedDigest) {
      throw new Error(
        "Workspace materialization archive does not match its binding.",
      );
    }
    const manifest = await merkleState.merkleDag.buildManifest(
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
        ...asObject(metadata),
      },
    );
    return {
      rootCid: manifest.rootCid,
      contentRefs: uniqueStrings([manifest.rootCid, ...refs]),
      metadata: {
        type: "file",
        sizeBytes: byteLength,
        contentSha256,
        chunkCount: entries.length,
      },
    };
  }

  async function recordWorkspaceUploadIngest({
    workspace,
    relativePath,
    contentBuffer,
    operationId,
  }: {
    workspace?: unknown;
    relativePath?: unknown;
    contentBuffer?: unknown;
    operationId?: unknown;
  } = {}) {
    if (
      !merkleState ||
      typeof merkleState.uploadManifest?.materialize !== "function"
    ) {
      return null;
    }
    const selectedWorkspace = workspaceRecord(workspace);
    const selectedPath = String(relativePath || "");
    const content = Buffer.isBuffer(contentBuffer)
      ? contentBuffer
      : Buffer.from(String(contentBuffer || ""));
    const block = await merkleState.cas.putBlock(content, {
      codec: "raw",
      metadata: {
        workspaceId: selectedWorkspace.workspaceId,
        relativePath: selectedPath,
        operationId,
        ingest: true,
      },
    });
    const chunkRecord = {
      fileId: selectedPath,
      relativePath: selectedPath,
      chunkIndex: 0,
      offset: 0,
      byteLength: content.length,
      chunkCid: block.cid,
      chunkHash: block.payloadHash,
    };
    const manifest = await merkleState.uploadManifest.materialize({
      scope: workspaceStateScope(selectedWorkspace),
      files: [
        {
          relativePath: selectedPath,
          byteLength: content.length,
          sha256: normalizeSha256(block.payloadHash),
        },
      ],
      records: [chunkRecord],
    });
    return {
      protocolVersion: merkleState.protocolVersion,
      status: "archived",
      manifestRootCid: manifest.rootCid,
      chunkCid: block.cid,
      chunkHash: block.payloadHash,
      recordCount: manifest.recordCount,
      nextOffset: manifest.nextOffset,
      contentRefs: uniqueStrings([manifest.rootCid, block.cid]),
    };
  }

  async function workspaceDownloadCacheReceipt(
    workspace: Workspace,
    relativePath: unknown,
  ) {
    if (!merkleState || typeof merkleState.stateCommit?.begin !== "function") {
      return null;
    }
    const state = await merkleState.stateCommit.begin({
      scope: workspaceStateScope(workspace),
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
        proofHash: "",
      };
    }
    const selectedPath = String(relativePath || "");
    const entry = await merkleState.merkleIndex.get(indexRootCid, selectedPath);
    const proof = await merkleState.merkleIndex.prove(
      indexRootCid,
      selectedPath,
    );
    return {
      protocolVersion: merkleState.protocolVersion,
      cacheFamily: "merkle-radix-compatible",
      implementation: "sorted-chunk-index-v1",
      cacheKey: `${workspaceStateScope(workspace)}:${relativePath}`,
      hit: Boolean(entry),
      indexRootCid,
      valueRoot: entry?.valueRef || "",
      proofHash: proof.proofHash,
    };
  }

  async function workspaceListCacheReceipt(
    workspace: Workspace,
    prefix: unknown = "",
  ) {
    const selectedPrefix = String(prefix || "");
    if (!merkleState || typeof merkleState.stateCommit?.begin !== "function") {
      return null;
    }
    const state = await merkleState.stateCommit.begin({
      scope: workspaceStateScope(workspace),
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
        proofHash: "",
      };
    }
    const entries = await merkleState.merkleIndex.prefix(
      indexRootCid,
      selectedPrefix,
    );
    const proof = await merkleState.merkleIndex.prove(
      indexRootCid,
      selectedPrefix || entries[0]?.key || "",
    );
    return {
      protocolVersion: merkleState.protocolVersion,
      cacheFamily: "merkle-radix-compatible",
      implementation: "sorted-chunk-index-v1",
      cacheKey: `${workspaceStateScope(workspace)}:${prefix || "/"}`,
      hit: entries.length > 0,
      indexRootCid,
      prefix,
      entryCount: entries.length,
      valueRoots: uniqueStrings(entries.map((entry) => entry.valueRef)).slice(
        0,
        100,
      ),
      proofHash: proof.proofHash,
    };
  }

  async function commitWorkspaceFileState(input: DataRecord = {}) {
    const {
      workspace,
      operationId,
      expectedCurrentRoot,
      idempotencyKey,
      mutations = [],
      contentRefs = [],
      payload = {},
    } = input;
    if (!merkleState || typeof merkleState.stateCommit?.commit !== "function") {
      return null;
    }
    const selectedWorkspace = workspaceRecord(workspace);
    const commitInput: DataRecord = {
      scope: workspaceStateScope(selectedWorkspace),
      operationId,
      mutations,
      contentRefs: uniqueStrings(asArray(contentRefs)),
      payload: {
        workspaceId: selectedWorkspace.workspaceId,
        ...asObject(payload),
      },
    };
    if (Object.hasOwn(input, "expectedCurrentRoot")) {
      commitInput.expectedCurrentRoot = String(expectedCurrentRoot || "");
    }
    if (Object.hasOwn(input, "idempotencyKey")) {
      commitInput.idempotencyKey = String(idempotencyKey || "");
    }
    return compactStateCommit(
      await merkleState.stateCommit.commit(commitInput),
    );
  }

  async function buildWorkspaceFileSnapshot(
    workspace: Workspace,
    {
      basePath = "",
      deleteExtraneous = true,
    }: { basePath?: string; deleteExtraneous?: boolean } = {},
  ): Promise<FileSnapshot | null> {
    if (!merkleState) {
      return null;
    }
    fullSnapshotBuilds += 1;
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
      adminUserIds: [workspace.ownerUserId].filter(Boolean),
    });
    if (!listed.ok) {
      return null;
    }
    const files: SnapshotFile[] = [];
    for (const file of listed.files) {
      const resolved = resolveWorkspacePath(workspace, file.relativePath);
      const content = fs.readFileSync(resolved.absolutePath);
      const block = await merkleState.cas.putBlock(content, {
        codec: "raw",
        metadata: {
          workspaceId: workspace.workspaceId,
          relativePath: file.relativePath,
          snapshot: true,
        },
      });
      files.push({
        path: file.relativePath,
        exists: true,
        contentCid: block.cid,
        contentSha256: normalizeSha256(block.payloadHash),
        byteLength: block.byteLength,
        encoding: "base64",
      });
    }
    return {
      workspaceId: workspace.workspaceId,
      basePath: normalizeWorkspaceRelativePath(basePath, { allowEmpty: true }),
      deleteExtraneous,
      files,
    };
  }

  async function captureWorkspaceFilePreimage(
    workspace: Workspace,
    relativePaths: unknown[] = [],
  ): Promise<FileSnapshot | null> {
    if (!merkleState?.cas?.putBlock) {
      return null;
    }
    const files: SnapshotFile[] = [];
    const captureFile = async (
      relativePath: string,
      absolutePath: string,
    ): Promise<void> => {
      const content = fs.readFileSync(absolutePath);
      const block = await merkleState.cas.putBlock(content, {
        codec: "raw",
        metadata: {
          workspaceId: workspace.workspaceId,
          relativePath,
          preimage: true,
        },
      });
      files.push({
        path: relativePath,
        exists: true,
        contentCid: block.cid,
        contentSha256: normalizeSha256(block.payloadHash),
        byteLength: block.byteLength,
        encoding: "base64",
      });
    };
    for (const rawPath of uniqueStrings(
      asArray(relativePaths).map(String).filter(Boolean),
    )) {
      const relativePath = normalizeWorkspaceRelativePath(rawPath, {
        allowEmpty: false,
      });
      const resolved = resolveWorkspacePath(workspace, relativePath);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(resolved.absolutePath);
      } catch {
        stat = null;
      }
      if (!stat) {
        files.push({ path: relativePath, exists: false });
        continue;
      }
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        continue;
      }
      if (stat.isFile()) {
        await captureFile(relativePath, resolved.absolutePath);
        continue;
      }
      const collect = (absoluteDir: string, relativeDir: string): void => {
        const entries = fs
          .readdirSync(absoluteDir, { withFileTypes: true })
          .filter((entry) => !entry.name.startsWith("."))
          .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          const childRelativePath = relativeDir
            ? `${relativeDir}/${entry.name}`
            : entry.name;
          const childAbsolutePath = path.join(absoluteDir, entry.name);
          const childStat = fs.lstatSync(childAbsolutePath);
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
      const subtreePaths: string[] = [];
      collect(resolved.absolutePath, relativePath);
      for (const subtreePath of subtreePaths) {
        const subtreeResolved = resolveWorkspacePath(workspace, subtreePath);
        await captureFile(subtreePath, subtreeResolved.absolutePath);
      }
    }
    const byPath = new Map<string, SnapshotFile>();
    for (const file of files) byPath.set(String(file.path), file);
    return {
      workspaceId: workspace.workspaceId,
      basePath: "",
      deleteExtraneous: false,
      incremental: true,
      files: [...byPath.values()],
    };
  }

  async function buildWorkspaceFileSnapshotFromStateRoot(
    workspace: Workspace,
    stateRoot: unknown = "",
  ): Promise<FileSnapshot> {
    const root = String(stateRoot || "").trim();
    if (!root || typeof merkleState?.merkleIndex?.prefix !== "function") {
      throw new Error(
        "Workspace checkpoint state root authority is unavailable.",
      );
    }
    const entries = await merkleState.merkleIndex.prefix(root, "", {
      limit: 100_000,
    });
    const files: SnapshotFile[] = [];
    for (const entry of entries) {
      const relativePath = String(entry.key || "");
      const metadata = asObject(entry.metadata);
      if (
        !relativePath ||
        relativePath.startsWith("__mount__/") ||
        metadata.type === "directory"
      ) {
        continue;
      }
      const contentCid = String(metadata.contentCid || entry.valueRef || "");
      if (!contentCid) {
        throw new Error(
          "Workspace checkpoint state entry has no content authority.",
        );
      }
      files.push({
        path: relativePath,
        exists: true,
        contentCid,
        contentSha256: normalizeSha256(metadata.contentSha256 || ""),
        byteLength: Number(metadata.sizeBytes ?? 0),
        encoding: "base64",
      });
    }
    return {
      schemaVersion: "v0.0.1:workspace:file-root-checkpoint-1",
      workspaceId: workspace.workspaceId,
      stateRoot: root,
      incremental: false,
      basePath: "",
      deleteExtraneous: true,
      files,
    };
  }

  function buildIncrementalCheckpointSnapshot({
    workspace,
    stateCommit,
    mutations = [],
  }: {
    workspace?: Workspace;
    stateCommit?: StateCommit | null;
    mutations?: unknown[];
  } = {}): FileSnapshot {
    if (!workspace) throw new TypeError("Workspace is required.");
    incrementalCheckpointBuilds += 1;
    const restorePathForKey = (key?: unknown): string => {
      const raw = String(key || "").trim();
      if (raw.startsWith("__mount__/")) {
        const parts = raw.split("/");
        if (parts.length > 2) return parts.slice(2).join("/");
      }
      return raw;
    };
    const files: SnapshotFile[] = [];
    for (const value of asArray(mutations)) {
      const mutation = record(value) || {};
      const rawKey = String(mutation.key || mutation.path || "").trim();
      if (!rawKey) continue;
      const relativePath = normalizeWorkspaceRelativePath(
        restorePathForKey(rawKey),
        { allowEmpty: false },
      );
      const exists = !["delete", "remove"].includes(
        String(mutation.action || ""),
      );
      if (!exists) {
        files.push({ path: relativePath, exists: false });
        continue;
      }
      const metadata = asObject(mutation.metadata);
      const contentSha256 = normalizeSha256(
        metadata.contentSha256 || mutation.contentSha256 || "",
      );
      const contentCid = String(metadata.contentCid || "");
      if (!contentCid) {
        continue;
      }
      files.push({
        path: relativePath,
        exists: true,
        contentCid,
        contentSha256,
        byteLength: Number(metadata.sizeBytes ?? mutation.byteLength ?? 0),
        encoding: "base64",
      });
    }
    return {
      schemaVersion: "v0.0.1:workspace:file-incremental-checkpoint-1",
      workspaceId: workspace.workspaceId,
      stateRoot: String(stateCommit?.afterRoot || ""),
      incremental: true,
      basePath: "",
      files,
    };
  }

  function migrateWorkspaceFileCheckpointSnapshot(
    value: unknown = null,
    { stateCommit = null }: { stateCommit?: StateCommit | null } = {},
  ): FileSnapshot | null {
    const snapshot = record(value);
    if (!snapshot) return null;
    if (snapshot.incremental === true) {
      return snapshot as unknown as FileSnapshot;
    }
    const files: SnapshotFile[] = asArray(
      snapshot.files || snapshot.entries,
    ).map((value): SnapshotFile => {
      const entry = record(value) || {};
      return {
        path: String(entry.path || entry.relativePath || ""),
        exists: entry.exists !== false,
        contentCid: String(entry.contentCid || entry.cid || ""),
        contentSha256: normalizeSha256(
          entry.contentSha256 || entry.sha256 || "",
        ),
        byteLength: Number(entry.byteLength ?? entry.sizeBytes ?? 0),
        encoding: String(entry.encoding || "base64"),
      };
    });
    return {
      schemaVersion: "v0.0.1:workspace:file-incremental-checkpoint-1",
      workspaceId: String(snapshot.workspaceId || ""),
      stateRoot: String(stateCommit?.afterRoot || snapshot.stateRoot || ""),
      incremental: true,
      basePath: String(snapshot.basePath || ""),
      files,
    };
  }

  async function migrateCheckpointTreeFileSnapshots({
    tree,
  }: { tree?: unknown } = {}) {
    if (
      !tree ||
      typeof checkpointTreeApi?.upsertCheckpointNode !== "function"
    ) {
      return { ok: false, migrated: 0 };
    }
    const treeRecord = record(tree);
    const nodes = Object.values(asObject(treeRecord?.nodes));
    const pending: Array<{
      node: DataRecord;
      metadata: DataRecord;
      migrated: FileSnapshot;
    }> = [];
    for (const value of nodes) {
      const node = record(value) || {};
      const metadata = asObject(node.metadata);
      const legacy =
        metadata.workspaceFileSnapshot || metadata.fileSnapshot || null;
      if (!legacy || record(legacy)?.incremental === true) continue;
      const migrated = migrateWorkspaceFileCheckpointSnapshot(legacy, {
        stateCommit: commitRecord(metadata.stateCommit),
      });
      if (!migrated) continue;
      pending.push({
        node,
        metadata,
        migrated,
      });
    }
    for (const entry of pending) {
      const legacyFiles = asArray(entry.migrated.files);
      const originalSnapshot =
        record(entry.metadata.workspaceFileSnapshot) ||
        record(entry.metadata.fileSnapshot);
      const originalFiles = asArray(originalSnapshot?.files);
      if (legacyFiles.length !== originalFiles.length) {
        return {
          ok: false,
          migrated: 0,
          error: "workspace checkpoint migration file count mismatch.",
        };
      }
      for (let index = 0; index < legacyFiles.length; index += 1) {
        const legacyFile = record(legacyFiles[index]) || {};
        const originalFile = record(originalFiles[index]) || {};
        if (
          String(legacyFile.path) !==
            String(originalFile.path || originalFile.relativePath || "") ||
          legacyFile.exists !== (originalFile.exists !== false) ||
          legacyFile.contentSha256 !==
            normalizeSha256(
              originalFile.contentSha256 || originalFile.sha256 || "",
            )
        ) {
          return {
            ok: false,
            migrated: 0,
            error:
              "workspace checkpoint migration restore projection mismatch.",
          };
        }
      }
    }
    let migrated = 0;
    for (const entry of pending) {
      const nextMetadata: DataRecord = {
        ...entry.metadata,
        workspaceFileSnapshot: entry.migrated,
      };
      if (
        entry.metadata.fileSnapshot &&
        !entry.metadata.workspaceFileSnapshot
      ) {
        delete nextMetadata.fileSnapshot;
        nextMetadata.workspaceFileSnapshot = entry.migrated;
      }
      await checkpointTreeApi.upsertCheckpointNode({
        ...entry.node,
        metadata: nextMetadata,
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
    fullSnapshot = false,
  }: {
    workspace?: Workspace;
    operationId?: string;
    stateCommit?: StateCommit | null;
    action?: string;
    path?: string;
    preimageSnapshot?: unknown;
    mutationOrigin?: unknown;
    workspaceFileSnapshot?: FileSnapshot | null;
    mutations?: unknown[];
    fullSnapshot?: boolean;
  } = {}) {
    if (!checkpointTreeApi || !workspace || !stateCommit?.commitId) {
      return null;
    }
    const treeId = workspaceCheckpointTreeId(workspace);
    if (!treeId) {
      return null;
    }
    const snapshot =
      workspaceFileSnapshot ||
      (fullSnapshot === true
        ? await buildWorkspaceFileSnapshot(workspace, {
            basePath: "",
            deleteExtraneous: true,
          })
        : buildIncrementalCheckpointSnapshot({
            workspace,
            stateCommit,
            mutations,
          }));
    if (!snapshot) {
      return null;
    }
    const existingTree =
      typeof checkpointTreeApi.loadCheckpointTree === "function"
        ? await checkpointTreeApi.loadCheckpointTree({ treeId })
        : null;
    if (existingTree) {
      const migration = await migrateCheckpointTreeFileSnapshots({
        tree: existingTree,
      });
      if (migration.ok !== true) {
        throw new Error(
          migration.error || "Workspace checkpoint migration failed.",
        );
      }
    }
    if (
      !existingTree &&
      typeof checkpointTreeApi.startCheckpointTree === "function"
    ) {
      await checkpointTreeApi.startCheckpointTree({
        treeId,
        kind: "workspace_files",
        ownerId: workspace.workspaceId,
        rootNodeId: "root",
        rootLabel: `Workspace files: ${workspace.title || workspace.workspaceId}`,
        resumePolicy: {
          mode: "append-only-workspace-file-restore",
          idempotencyKey: "treeId+nodeId",
        },
      });
    }
    if (typeof checkpointTreeApi.upsertCheckpointNode !== "function") {
      return null;
    }
    const nodeId = `commit:${stateCommit.commitId}`;
    const checkpointNode: DataRecord = {
      treeId,
      nodeId,
      parentId: "root",
      label: `${action || operationId}: ${relativePath || workspace.workspaceId}`,
      status: "completed",
      cursor: {
        commitId: stateCommit.commitId,
        afterRoot: stateCommit.afterRoot,
      },
      totals: {
        files: snapshot.files.length,
        contentRefs: asArray(stateCommit.contentRefs).length,
      },
      metadata: {
        workspaceId: workspace.workspaceId,
        operationId,
        action,
        path: relativePath || "",
        stateCommit,
        workspaceFileSnapshot: snapshot,
        ...(preimageSnapshot
          ? { workspaceFilePreimageSnapshot: preimageSnapshot }
          : {}),
        ...(mutationOrigin ? { mutationOrigin } : {}),
      },
      eventType: "workspace.file.checkpointed",
    };
    const checkpointBindingDigest = crypto
      .createHash("sha256")
      .update(canonicalJson(checkpointNode.metadata))
      .digest("hex");
    const checkpointIdempotencyKey = crypto
      .createHash("sha256")
      .update(canonicalJson(checkpointNode))
      .digest("hex");
    await checkpointTreeApi.upsertCheckpointNode({
      ...checkpointNode,
      idempotencyKey: checkpointIdempotencyKey,
    });
    return {
      treeId,
      nodeId,
      checkpointBindingDigest,
      snapshotFileCount: snapshot.files.length,
      preimageEntryCount: preimageSnapshot
        ? asArray(record(preimageSnapshot)?.files).length +
          asArray(
            record(preimageSnapshot)?.localDirectorySnapshots,
          ).reduce<number>(
            (count, value) => count + asArray(record(value)?.entries).length,
            0,
          )
        : 0,
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
    getRefactorInstrumentation,
  };
}
