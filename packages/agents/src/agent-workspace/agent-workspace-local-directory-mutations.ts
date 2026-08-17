import fs from "node:fs";
import path from "node:path";
import {
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  assertWorkspaceFileContentPolicy,
  nowIso,
  stripExecutableMode,
} from "./agent-workspace-support.ts";
import { readOrdinaryFileNoFollow } from "./agent-workspace-local-directory-safe-fs.ts";

type DataRecord = Record<string, unknown>;
interface Workspace {
  workspaceId: string;
  [key: string]: unknown;
}
interface Mount {
  mountRef?: string;
  [key: string]: unknown;
}
interface Access {
  ok: true;
  workspace: Workspace;
}
interface AccessFailure extends DataRecord {
  ok: false;
}
interface ResolvedPath {
  root: string;
  absolutePath: string;
  relativePath: string;
  mount?: Mount | null;
  exists?: boolean;
  stat?: fs.Stats;
}
interface SnapshotEntry {
  relativePath: string;
  state?: string;
  contentCid?: string;
  contentSha256?: string;
}
interface PreimageSnapshot {
  entries: SnapshotEntry[];
  mountRef?: string;
  [key: string]: unknown;
}
interface PreimageCapture {
  snapshot: PreimageSnapshot;
  [key: string]: unknown;
}
interface StateMutation {
  action: "put" | "delete";
  key: string;
  valueRef?: string;
  metadata?: DataRecord;
}
interface StateCommit extends DataRecord {
  commitId: string;
}
interface Checkpoint extends DataRecord {
  nodeId: string;
}
interface ArchivedContent extends DataRecord {
  rootCid: string;
  contentRefs?: string[];
  metadata?: DataRecord;
}
interface PostimageRecord {
  mutation: StateMutation;
  contentRefs: string[];
  file?: DataRecord;
  archived?: ArchivedContent;
}
interface MutationFailureResult {
  ok: false;
  status: number;
  code: string | undefined;
  error: string;
}
interface FilesystemEntry {
  absolutePath: string;
  relativePath: string;
  stat: fs.Stats;
  type: "directory" | "file";
}
interface MutationFailure extends Error {
  code?: string;
  status?: number;
}
interface MutationDependencies {
  workspaceForStorage(input: DataRecord): Access | AccessFailure;
  decodeWorkspaceFileContent(input: DataRecord): Buffer;
  updateWorkspaceTimeStmt: {
    run(updatedAt: string, workspaceId: string): unknown;
  };
  filePayloadMetadata(file: DataRecord): DataRecord;
  commitWorkspaceFileState(input: DataRecord): Promise<unknown>;
  recordWorkspaceFileCheckpoint(input: DataRecord): Promise<unknown>;
  resolveLocalDirectoryMountPath(
    input: DataRecord,
    workspace: Workspace,
    options: DataRecord,
  ): ResolvedPath;
  localDirectoryFileMetadataFromStat(input: DataRecord): DataRecord;
  localDirectoryAccessReceipt(input: DataRecord): unknown;
  publicLocalDirectoryMount(mount: Mount): unknown;
  archiveLocalDirectoryContent(
    content: Buffer,
    input: DataRecord,
  ): Promise<unknown>;
  mountMutationKey(mountRef: string, relativePath: string): string;
  captureLocalDirectoryPreimage(input: DataRecord): Promise<unknown>;
  validateLocalDirectoryPreimage(input: DataRecord): Promise<unknown>;
  rollbackLocalDirectoryMutation(input: DataRecord): Promise<unknown>;
  workspacePreimageSnapshot(snapshot: PreimageSnapshot): unknown;
  writeFileAtomically(
    root: string,
    absolutePath: string,
    content: Buffer,
    mode: number,
  ): void;
  ensureDirectorySafely(root: string, absolutePath: string, mode: number): void;
  removePathSafely(
    root: string,
    absolutePath: string,
    options: { recursive: boolean },
  ): void;
  renamePathSafely(root: string, source: string, target: string): void;
}
function dataRecord(value: unknown): DataRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as DataRecord)
    : null;
}
function failure(value: unknown): MutationFailure {
  return value instanceof Error
    ? (value as MutationFailure)
    : new Error("本机目录 mutation 未完成。");
}
function preimageCapture(value: unknown): PreimageCapture {
  const record = dataRecord(value);
  const snapshot = dataRecord(record?.snapshot);
  if (!record || !snapshot || !Array.isArray(snapshot.entries))
    throw new TypeError("本机目录 preimage 无效。");
  return record as unknown as PreimageCapture;
}
function stateCommit(value: unknown): StateCommit | null {
  const record = dataRecord(value);
  return record && typeof record.commitId === "string" && record.commitId
    ? (record as StateCommit)
    : null;
}
function checkpointRecord(value: unknown): Checkpoint | null {
  const record = dataRecord(value);
  return record && typeof record.nodeId === "string" && record.nodeId
    ? (record as Checkpoint)
    : null;
}
function archivedContent(value: unknown): ArchivedContent | null {
  const record = dataRecord(value);
  return record && typeof record.rootCid === "string" && record.rootCid
    ? (record as ArchivedContent)
    : null;
}

function basenameStartsWithDot(value?: unknown): boolean {
  return path.posix
    .basename(String(value || "").replace(/\\/g, "/"))
    .startsWith(".");
}

function directoryEntryMetadata(): DataRecord {
  return { type: "directory", sizeBytes: 0 };
}

function collectFilesystemEntries(
  absolutePath: string,
  relativePath: string,
  stat: fs.Stats,
): FilesystemEntry[] {
  if (basenameStartsWithDot(relativePath)) {
    throw new Error("不允许操作以 . 开头的路径。");
  }
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error("只能操作普通文件或目录。");
  }
  const entries: FilesystemEntry[] = [
    {
      absolutePath,
      relativePath,
      stat,
      type: stat.isDirectory() ? "directory" : "file",
    },
  ];
  if (!stat.isDirectory()) {
    return entries;
  }
  const children = fs
    .readdirSync(absolutePath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (child.name.startsWith(".")) {
      throw new Error(
        `不允许操作以 . 开头的路径：${relativePath}/${child.name}`,
      );
    }
    const childRelativePath = `${relativePath}/${child.name}`;
    const childAbsolutePath = path.join(absolutePath, child.name);
    const childStat = fs.lstatSync(childAbsolutePath);
    entries.push(
      ...collectFilesystemEntries(
        childAbsolutePath,
        childRelativePath,
        childStat,
      ),
    );
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
  renamePathSafely,
}: MutationDependencies) {
  function accessReceipt({
    workspaceId,
    mountRef,
    operationId,
    path: relativePath,
    action,
  }: {
    workspaceId: string;
    mountRef: string;
    operationId: string;
    path: string;
    action: string;
  }) {
    return localDirectoryAccessReceipt({
      workspaceId,
      mountRef,
      operationId,
      path: relativePath,
      action,
    });
  }

  function snapshotContentRefs(snapshot: PreimageSnapshot): string[] {
    return snapshot.entries
      .map((entry) => entry.contentCid)
      .filter((value): value is string => Boolean(value));
  }

  function snapshotExistingEntries(
    snapshot: PreimageSnapshot,
  ): SnapshotEntry[] {
    return snapshot.entries.filter((entry) => entry.state !== "missing");
  }

  function safeMutationFailure(
    error: unknown,
    { rolledBack = false }: { rolledBack?: boolean } = {},
  ): MutationFailureResult {
    const observed = failure(error);
    const known = String(observed.code || "").startsWith("local_directory_");
    return {
      ok: false,
      status: Math.max(
        400,
        Number(
          observed.status || (observed.code === "ENOTEMPTY" ? 409 : 500),
        ) || 500,
      ),
      code: known ? observed.code : "local_directory_mutation_failed",
      error: known
        ? observed.message
        : rolledBack
          ? "本机目录 mutation 未完成，已恢复 mutation 前状态。"
          : "本机目录 mutation 未完成。",
    };
  }

  async function capturePreimage({
    access,
    input,
    relativePaths,
    operationId,
  }: {
    access: Access;
    input: DataRecord;
    relativePaths: string[];
    operationId: string;
  }): Promise<
    | { ok: true; capture: PreimageCapture }
    | { ok: false; result: MutationFailureResult }
  > {
    try {
      return {
        ok: true,
        capture: preimageCapture(
          await captureLocalDirectoryPreimage({
            workspace: access.workspace,
            input,
            relativePaths,
            operationId,
          }),
        ),
      };
    } catch (error: unknown) {
      return { ok: false, result: safeMutationFailure(error) };
    }
  }

  async function rollbackMutation({
    access,
    preimage,
    operationId,
    stateCommit: priorCommit = null,
  }: {
    access: Access;
    preimage: PreimageCapture;
    operationId: string;
    stateCommit?: StateCommit | null;
  }): Promise<void> {
    const projection =
      dataRecord(
        await rollbackLocalDirectoryMutation({
          workspace: access.workspace,
          snapshot: preimage.snapshot,
        }),
      ) || {};
    updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
    if (priorCommit?.commitId) {
      const compensation = stateCommit(
        await commitWorkspaceFileState({
          workspace: access.workspace,
          operationId: `${operationId}.rollback`,
          mutations: Array.isArray(projection.mutations)
            ? projection.mutations
            : [],
          contentRefs: Array.isArray(projection.contentRefs)
            ? projection.contentRefs
            : [],
          payload: {
            action: "localDir.mutation.rollback",
            failedOperationId: operationId,
            mountRef: preimage.snapshot.mountRef,
          },
        }),
      );
      if (!compensation) {
        const error = new Error(
          "本机目录 mutation 回滚后的状态补偿提交失败。",
        ) as MutationFailure;
        error.code = "local_directory_state_compensation_failed";
        error.status = 500;
        throw error;
      }
    }
  }

  function requireStateCommit(value?: unknown): StateCommit {
    const commit = stateCommit(value);
    if (!commit) {
      const error = new Error(
        "本机目录 mutation 状态提交不可用。",
      ) as MutationFailure;
      error.code = "local_directory_state_commit_unavailable";
      error.status = 503;
      throw error;
    }
    return commit;
  }

  function requireCheckpoint(value?: unknown): Checkpoint {
    const checkpoint = checkpointRecord(value);
    if (!checkpoint) {
      const error = new Error(
        "本机目录 mutation checkpoint 不可用。",
      ) as MutationFailure;
      error.code = "local_directory_checkpoint_unavailable";
      error.status = 503;
      throw error;
    }
    return checkpoint;
  }

  async function archivePostimageEntry({
    workspace,
    mount,
    entry,
    operationId,
    mountRef,
    root,
  }: {
    workspace: Workspace;
    mount?: Mount | null;
    entry: FilesystemEntry;
    operationId: string;
    mountRef: string;
    root: string;
  }): Promise<PostimageRecord> {
    if (entry.type === "directory") {
      return {
        mutation: {
          action: "put",
          key: mountMutationKey(mountRef, entry.relativePath),
          valueRef: "",
          metadata: directoryEntryMetadata(),
        },
        contentRefs: [],
      };
    }
    const { content, stat } = readOrdinaryFileNoFollow(
      root,
      entry.absolutePath,
    );
    const archived = archivedContent(
      await archiveLocalDirectoryContent(content, {
        operationId,
        mountRef,
        relativePath: entry.relativePath,
        postimage: true,
      }),
    );
    if (!archived) {
      const error = new Error(
        "本机目录 postimage CAS 归档不可用。",
      ) as MutationFailure;
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
      contentBuffer: content,
    });
    return {
      mutation: {
        action: "put",
        key: mountMutationKey(mountRef, entry.relativePath),
        valueRef: archived?.rootCid || "",
        metadata: {
          ...filePayloadMetadata(file),
          contentCid: archived?.metadata?.contentCid || "",
        },
      },
      contentRefs: archived?.contentRefs || [],
      file,
      archived,
    };
  }

  async function postimageMutations({
    workspace,
    mount,
    entries,
    operationId,
    mountRef,
    root,
  }: {
    workspace: Workspace;
    mount?: Mount | null;
    entries: FilesystemEntry[];
    operationId: string;
    mountRef: string;
    root: string;
  }) {
    const mutations: StateMutation[] = [];
    const contentRefs: string[] = [];
    let primaryFile: DataRecord | null = null;
    for (const entry of entries) {
      const recorded: PostimageRecord = await archivePostimageEntry({
        workspace,
        mount,
        entry,
        operationId,
        mountRef,
        root,
      });
      mutations.push(recorded.mutation);
      contentRefs.push(...recorded.contentRefs);
      primaryFile ||= recorded.file || null;
    }
    return { mutations, contentRefs, primaryFile };
  }

  async function writeLocalDirectoryFile(input: DataRecord = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    const explicitPath = String(
      input.path ||
        input.relativePath ||
        input.filePath ||
        input["file-path"] ||
        "",
    ).trim();
    if (!explicitPath) {
      return { ok: false, status: 400, error: "path 不能为空。" };
    }
    if (basenameStartsWithDot(explicitPath)) {
      return { ok: false, status: 400, error: "不允许操作以 . 开头的文件。" };
    }
    let contentBuffer: Buffer;
    try {
      contentBuffer = decodeWorkspaceFileContent(input);
    } catch (error: unknown) {
      return { ok: false, status: 400, error: failure(error).message };
    }
    let resolved: ResolvedPath;
    try {
      resolved = resolveLocalDirectoryMountPath(input, access.workspace, {
        allowEmpty: false,
        allowMissing: true,
        allowDirectory: false,
        allowFile: true,
      });
      assertWorkspaceFileContentPolicy({
        relativePath: resolved.relativePath,
        contentBuffer,
      });
    } catch (error: unknown) {
      return { ok: false, status: 400, error: failure(error).message };
    }
    if (
      fs.existsSync(resolved.absolutePath) &&
      fs.lstatSync(resolved.absolutePath).isDirectory()
    ) {
      return {
        ok: false,
        status: 409,
        error: "目标路径是文件夹，不能写入为文件。",
      };
    }
    const overwritten = fs.existsSync(resolved.absolutePath);
    if (overwritten && input.overwrite === false) {
      return { ok: false, status: 409, error: "文件已存在。" };
    }
    const mountRef = String(resolved.mount?.mountRef || "");
    const operationId = String(input.operationId || "workspace.file.write");
    const prepared = await capturePreimage({
      access,
      input,
      relativePaths: [resolved.relativePath],
      operationId,
    });
    if (!prepared.ok) {
      return prepared.result;
    }
    const preimage = prepared.capture;
    const preimageEntry = preimage.snapshot.entries.find(
      (entry) => entry.relativePath === resolved.relativePath,
    );
    let mutated = false;
    let currentStateCommit: StateCommit | null = null;
    try {
      await validateLocalDirectoryPreimage({
        workspace: access.workspace,
        capture: preimage,
      });
      mutated = true;
      writeFileAtomically(
        resolved.root,
        resolved.absolutePath,
        contentBuffer,
        0o600,
      );
      stripExecutableMode(resolved.absolutePath);
      const stat = fs.statSync(resolved.absolutePath);
      updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
      const postimageArchived = archivedContent(
        await archiveLocalDirectoryContent(contentBuffer, {
          operationId,
          mountRef,
          relativePath: resolved.relativePath,
          postimage: true,
        }),
      );
      if (!postimageArchived) {
        const error = new Error(
          "本机目录 postimage CAS 归档不可用。",
        ) as MutationFailure;
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
        contentBuffer,
      });
      const writeMutations: StateMutation[] = [
        {
          action: "put",
          key: mountMutationKey(mountRef, resolved.relativePath),
          valueRef: postimageArchived.rootCid,
          metadata: {
            ...filePayloadMetadata(file),
            contentCid: postimageArchived?.metadata?.contentCid || "",
          },
        },
      ];
      currentStateCommit = requireStateCommit(
        await commitWorkspaceFileState({
          workspace: access.workspace,
          operationId,
          mutations: writeMutations,
          contentRefs: [
            ...snapshotContentRefs(preimage.snapshot),
            ...(postimageArchived.contentRefs || []),
          ],
          payload: {
            action: "localDir.file.write",
            path: resolved.relativePath,
            mountRef,
            overwritten,
            preimageSha256: preimageEntry?.contentSha256 || "",
            contentSha256: file.contentSha256 || "",
          },
        }),
      );
      const checkpoint = requireCheckpoint(
        await recordWorkspaceFileCheckpoint({
          workspace: access.workspace,
          operationId,
          stateCommit: currentStateCommit,
          action: "localDir.file.write",
          path: resolved.relativePath,
          preimageSnapshot: workspacePreimageSnapshot(preimage.snapshot),
          mutations: writeMutations,
        }),
      );
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        mode: "localDir",
        mount: resolved.mount
          ? publicLocalDirectoryMount(resolved.mount)
          : null,
        overwritten,
        file,
        stateCommit: currentStateCommit,
        checkpoint,
        accessReceipt: accessReceipt({
          workspaceId: access.workspace.workspaceId,
          mountRef,
          operationId,
          path: resolved.relativePath,
          action: "localDir.write",
        }),
      };
    } catch (error: unknown) {
      if (!mutated) {
        return safeMutationFailure(error);
      }
      try {
        await rollbackMutation({
          access,
          preimage,
          operationId,
          stateCommit: currentStateCommit,
        });
        return safeMutationFailure(error, { rolledBack: true });
      } catch (rollbackError: unknown) {
        return safeMutationFailure(rollbackError);
      }
    }
  }

  async function createLocalDirectoryFolder(input: DataRecord = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let resolved: ResolvedPath;
    try {
      resolved = resolveLocalDirectoryMountPath(input, access.workspace, {
        allowEmpty: false,
        allowMissing: true,
        allowDirectory: true,
        allowFile: false,
      });
    } catch (error: unknown) {
      return { ok: false, status: 400, error: failure(error).message };
    }
    if (basenameStartsWithDot(resolved.relativePath)) {
      return { ok: false, status: 400, error: "不允许操作以 . 开头的路径。" };
    }
    if (
      fs.existsSync(resolved.absolutePath) &&
      !fs.lstatSync(resolved.absolutePath).isDirectory()
    ) {
      return { ok: false, status: 409, error: "目标路径已存在且不是文件夹。" };
    }
    const mountRef = String(resolved.mount?.mountRef || "");
    const operationId = String(
      input.operationId || "agent_workspaces.folder.create",
    );
    if (resolved.exists) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        mode: "localDir",
        mount: resolved.mount
          ? publicLocalDirectoryMount(resolved.mount)
          : null,
        created: false,
        stateCommit: null,
        checkpoint: null,
        folder: localDirectoryFileMetadataFromStat({
          workspaceId: access.workspace.workspaceId,
          mount: resolved.mount,
          relativePath: resolved.relativePath,
          absolutePath: resolved.absolutePath,
          stat: resolved.stat,
        }),
        accessReceipt: accessReceipt({
          workspaceId: access.workspace.workspaceId,
          mountRef,
          operationId,
          path: resolved.relativePath,
          action: "localDir.mkdir",
        }),
      };
    }
    const prepared = await capturePreimage({
      access,
      input,
      relativePaths: [resolved.relativePath],
      operationId,
    });
    if (!prepared.ok) {
      return prepared.result;
    }
    const preimage = prepared.capture;
    let mutated = false;
    let currentStateCommit: StateCommit | null = null;
    try {
      await validateLocalDirectoryPreimage({
        workspace: access.workspace,
        capture: preimage,
      });
      mutated = true;
      ensureDirectorySafely(resolved.root, resolved.absolutePath, 0o700);
      const stat = fs.statSync(resolved.absolutePath);
      updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
      const mkdirMutations: StateMutation[] = [
        {
          action: "put",
          key: mountMutationKey(mountRef, resolved.relativePath),
          valueRef: "",
          metadata: directoryEntryMetadata(),
        },
      ];
      currentStateCommit = requireStateCommit(
        await commitWorkspaceFileState({
          workspace: access.workspace,
          operationId,
          mutations: mkdirMutations,
          contentRefs: snapshotContentRefs(preimage.snapshot),
          payload: {
            action: "localDir.mkdir",
            path: resolved.relativePath,
            mountRef,
          },
        }),
      );
      const checkpoint = requireCheckpoint(
        await recordWorkspaceFileCheckpoint({
          workspace: access.workspace,
          operationId,
          stateCommit: currentStateCommit,
          action: "localDir.mkdir",
          path: resolved.relativePath,
          preimageSnapshot: workspacePreimageSnapshot(preimage.snapshot),
          mutations: mkdirMutations,
        }),
      );
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        mode: "localDir",
        mount: resolved.mount
          ? publicLocalDirectoryMount(resolved.mount)
          : null,
        created: true,
        stateCommit: currentStateCommit,
        checkpoint,
        folder: localDirectoryFileMetadataFromStat({
          workspaceId: access.workspace.workspaceId,
          mount: resolved.mount,
          relativePath: resolved.relativePath,
          absolutePath: resolved.absolutePath,
          stat,
        }),
        accessReceipt: accessReceipt({
          workspaceId: access.workspace.workspaceId,
          mountRef,
          operationId,
          path: resolved.relativePath,
          action: "localDir.mkdir",
        }),
      };
    } catch (error: unknown) {
      if (!mutated) {
        return safeMutationFailure(error);
      }
      try {
        await rollbackMutation({
          access,
          preimage,
          operationId,
          stateCommit: currentStateCommit,
        });
        return safeMutationFailure(error, { rolledBack: true });
      } catch (rollbackError: unknown) {
        return safeMutationFailure(rollbackError);
      }
    }
  }

  async function deleteLocalDirectoryItem(input: DataRecord = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let resolved: ResolvedPath;
    try {
      resolved = resolveLocalDirectoryMountPath(input, access.workspace, {
        allowEmpty: false,
        allowMissing: false,
        requireExisting: true,
        allowDirectory: true,
        allowFile: true,
      });
    } catch (error: unknown) {
      const observed = failure(error);
      return {
        ok: false,
        status: observed.code === "ENOENT" ? 404 : 400,
        error: observed.message,
      };
    }
    const stat = fs.lstatSync(resolved.absolutePath);
    if (
      stat.isDirectory() &&
      input.recursive !== true &&
      fs.readdirSync(resolved.absolutePath).length > 0
    ) {
      return {
        ok: false,
        status: 409,
        error: "目录非空；删除目录树需要 recursive: true。",
      };
    }
    const mountRef = String(resolved.mount?.mountRef || "");
    const operationId = String(
      input.operationId || "agent_workspaces.file.delete",
    );
    const prepared = await capturePreimage({
      access,
      input,
      relativePaths: [resolved.relativePath],
      operationId,
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
      stat,
    });
    let mutated = false;
    let currentStateCommit: StateCommit | null = null;
    try {
      await validateLocalDirectoryPreimage({
        workspace: access.workspace,
        capture: preimage,
      });
      mutated = true;
      removePathSafely(resolved.root, resolved.absolutePath, {
        recursive: input.recursive === true,
      });
      updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
      const deleteMutations: StateMutation[] = [...entries]
        .reverse()
        .map((entry) => ({
          action: "delete" as const,
          key: mountMutationKey(mountRef, entry.relativePath),
        }));
      currentStateCommit = requireStateCommit(
        await commitWorkspaceFileState({
          workspace: access.workspace,
          operationId,
          mutations: deleteMutations,
          contentRefs: snapshotContentRefs(preimage.snapshot),
          payload: {
            action: "localDir.delete",
            path: resolved.relativePath,
            mountRef,
            recursive: input.recursive === true,
            deletedPathCount: entries.length,
            preimageSha256s: entries
              .map((entry) => entry.contentSha256)
              .filter(Boolean),
          },
        }),
      );
      const checkpoint = requireCheckpoint(
        await recordWorkspaceFileCheckpoint({
          workspace: access.workspace,
          operationId,
          stateCommit: currentStateCommit,
          action: "localDir.delete",
          path: resolved.relativePath,
          preimageSnapshot: workspacePreimageSnapshot(preimage.snapshot),
          mutations: deleteMutations,
        }),
      );
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        mode: "localDir",
        mount: resolved.mount
          ? publicLocalDirectoryMount(resolved.mount)
          : null,
        deleted: true,
        item,
        stateCommit: currentStateCommit,
        checkpoint,
        accessReceipt: accessReceipt({
          workspaceId: access.workspace.workspaceId,
          mountRef,
          operationId,
          path: resolved.relativePath,
          action: "localDir.delete",
        }),
      };
    } catch (error: unknown) {
      if (!mutated) {
        return safeMutationFailure(error);
      }
      try {
        await rollbackMutation({
          access,
          preimage,
          operationId,
          stateCommit: currentStateCommit,
        });
        return safeMutationFailure(error, { rolledBack: true });
      } catch (rollbackError: unknown) {
        return safeMutationFailure(rollbackError);
      }
    }
  }

  async function moveLocalDirectoryItem(input: DataRecord = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    const sourcePath = String(input.from || input.sourcePath || "").trim();
    const targetPath = String(
      input.to || input.targetPath || input.path || "",
    ).trim();
    if (!sourcePath) {
      return { ok: false, status: 400, error: "sourcePath (from) 不能为空。" };
    }
    if (!targetPath) {
      return { ok: false, status: 400, error: "targetPath (to) 不能为空。" };
    }
    if (
      basenameStartsWithDot(sourcePath) ||
      basenameStartsWithDot(targetPath)
    ) {
      return { ok: false, status: 400, error: "不允许操作以 . 开头的文件。" };
    }
    let resolvedSource: ResolvedPath;
    let resolvedTarget: ResolvedPath;
    try {
      resolvedSource = resolveLocalDirectoryMountPath(
        { ...input, path: sourcePath },
        access.workspace,
        {
          allowEmpty: false,
          allowMissing: false,
          requireExisting: true,
          allowDirectory: true,
          allowFile: true,
        },
      );
      resolvedTarget = resolveLocalDirectoryMountPath(
        { ...input, path: targetPath },
        access.workspace,
        {
          allowEmpty: false,
          allowMissing: true,
          allowDirectory: true,
          allowFile: true,
        },
      );
    } catch (error: unknown) {
      const observed = failure(error);
      return {
        ok: false,
        status: observed.code === "ENOENT" ? 404 : 400,
        error: observed.message,
      };
    }
    const sourceMountRef = String(resolvedSource.mount?.mountRef || "");
    const targetMountRef = String(resolvedTarget.mount?.mountRef || "");
    if (sourceMountRef !== targetMountRef) {
      return {
        ok: false,
        status: 400,
        error: "不能跨本机目录 mount 移动项目。",
      };
    }
    const sourceStat = fs.lstatSync(resolvedSource.absolutePath);
    if (sourceStat.isFile()) {
      try {
        assertWorkspaceFileContentPolicy({
          relativePath: resolvedTarget.relativePath,
          contentBuffer: readOrdinaryFileNoFollow(
            resolvedSource.root,
            resolvedSource.absolutePath,
          ).content,
          sizeBytes: sourceStat.size,
        });
      } catch (error: unknown) {
        return { ok: false, status: 400, error: failure(error).message };
      }
    }
    if (resolvedSource.relativePath === resolvedTarget.relativePath) {
      return {
        ok: false,
        status: 400,
        error: "sourcePath 与 targetPath 不能相同。",
      };
    }
    const targetFromSource = path.relative(
      resolvedSource.absolutePath,
      resolvedTarget.absolutePath,
    );
    const sourceFromTarget = path.relative(
      resolvedTarget.absolutePath,
      resolvedSource.absolutePath,
    );
    const overlaps = (relative: string): boolean =>
      Boolean(
        relative && !relative.startsWith("..") && !path.isAbsolute(relative),
      );
    if (
      sourceStat.isDirectory() &&
      (overlaps(targetFromSource) || overlaps(sourceFromTarget))
    ) {
      return {
        ok: false,
        status: 400,
        error: "目录 move 的 sourcePath 与 targetPath 不能互相包含。",
      };
    }
    const operationId = String(
      input.operationId || "agent_workspaces.file.move",
    );
    const mountRef = targetMountRef;
    if (resolvedTarget.exists) {
      if (!input.overwrite) {
        return {
          ok: false,
          status: 409,
          error: "目标路径已存在。设置 overwrite: true 以覆盖。",
        };
      }
    }
    const prepared = await capturePreimage({
      access,
      input,
      relativePaths: [resolvedSource.relativePath, resolvedTarget.relativePath],
      operationId,
    });
    if (!prepared.ok) {
      return prepared.result;
    }
    const preimage = prepared.capture;
    const sourceEntries = snapshotExistingEntries(preimage.snapshot).filter(
      (entry) =>
        entry.relativePath === resolvedSource.relativePath ||
        entry.relativePath.startsWith(`${resolvedSource.relativePath}/`),
    );
    const overwrittenEntries = snapshotExistingEntries(
      preimage.snapshot,
    ).filter(
      (entry) =>
        entry.relativePath === resolvedTarget.relativePath ||
        entry.relativePath.startsWith(`${resolvedTarget.relativePath}/`),
    );
    let mutated = false;
    let currentStateCommit: StateCommit | null = null;
    try {
      await validateLocalDirectoryPreimage({
        workspace: access.workspace,
        capture: preimage,
      });
      mutated = true;
      if (resolvedTarget.exists) {
        removePathSafely(resolvedTarget.root, resolvedTarget.absolutePath, {
          recursive: true,
        });
      }
      renamePathSafely(
        resolvedSource.root,
        resolvedSource.absolutePath,
        resolvedTarget.absolutePath,
      );
      if (sourceStat.isFile()) {
        stripExecutableMode(resolvedTarget.absolutePath);
      }
      const newStat = fs.lstatSync(resolvedTarget.absolutePath);
      const targetEntries = collectFilesystemEntries(
        resolvedTarget.absolutePath,
        resolvedTarget.relativePath,
        newStat,
      );
      const targetPostimages = await postimageMutations({
        workspace: access.workspace,
        mount: resolvedTarget.mount,
        entries: targetEntries,
        operationId,
        mountRef,
        root: resolvedTarget.root,
      });
      const file = localDirectoryFileMetadataFromStat({
        workspaceId: access.workspace.workspaceId,
        mount: resolvedTarget.mount,
        relativePath: resolvedTarget.relativePath,
        absolutePath: resolvedTarget.absolutePath,
        stat: newStat,
        includeHash: newStat.isFile(),
        rootPath: resolvedTarget.root,
      });
      updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
      const deleteEntries = snapshotExistingEntries(preimage.snapshot);
      const moveMutations: StateMutation[] = [
        ...[...deleteEntries].reverse().map((entry) => ({
          action: "delete" as const,
          key: mountMutationKey(mountRef, entry.relativePath),
        })),
        ...targetPostimages.mutations,
      ];
      currentStateCommit = requireStateCommit(
        await commitWorkspaceFileState({
          workspace: access.workspace,
          operationId,
          mutations: moveMutations,
          contentRefs: [
            ...snapshotContentRefs(preimage.snapshot),
            ...targetPostimages.contentRefs,
          ],
          payload: {
            action: "localDir.move",
            sourcePath: resolvedSource.relativePath,
            targetPath: resolvedTarget.relativePath,
            mountRef,
            overwrite: input.overwrite === true,
            movedPathCount: sourceEntries.length,
            overwrittenPathCount: overwrittenEntries.length,
            preimageSha256s: sourceEntries
              .map((entry) => entry.contentSha256)
              .filter(Boolean),
            overwrittenSha256s: overwrittenEntries
              .map((entry) => entry.contentSha256)
              .filter(Boolean),
          },
        }),
      );
      const checkpoint = requireCheckpoint(
        await recordWorkspaceFileCheckpoint({
          workspace: access.workspace,
          operationId,
          stateCommit: currentStateCommit,
          action: "localDir.move",
          path: resolvedTarget.relativePath,
          preimageSnapshot: workspacePreimageSnapshot(preimage.snapshot),
          mutations: moveMutations,
        }),
      );
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        mode: "localDir",
        mount: resolvedTarget.mount
          ? publicLocalDirectoryMount(resolvedTarget.mount)
          : null,
        moved: true,
        sourcePath: resolvedSource.relativePath,
        targetPath: resolvedTarget.relativePath,
        item: file,
        stateCommit: currentStateCommit,
        checkpoint,
        accessReceipt: accessReceipt({
          workspaceId: access.workspace.workspaceId,
          mountRef,
          operationId,
          path: resolvedTarget.relativePath,
          action: "localDir.move",
        }),
      };
    } catch (error: unknown) {
      if (!mutated) {
        return safeMutationFailure(error);
      }
      try {
        await rollbackMutation({
          access,
          preimage,
          operationId,
          stateCommit: currentStateCommit,
        });
        return safeMutationFailure(error, { rolledBack: true });
      } catch (rollbackError: unknown) {
        return safeMutationFailure(rollbackError);
      }
    }
  }

  return {
    writeLocalDirectoryFile,
    createLocalDirectoryFolder,
    deleteLocalDirectoryItem,
    moveLocalDirectoryItem,
  };
}
