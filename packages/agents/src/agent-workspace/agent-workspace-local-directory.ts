import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertPathWithinRootSync } from "@meshrix/foundation/security/local-path-boundary";
import {
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  boundedInteger,
  normalizeWorkspaceRelativePath,
  nowIso,
  sha256Buffer,
  stableHash,
  stableId,
} from "./agent-workspace-support.ts";
import { createAgentWorkspaceLocalDirectorySupport } from "./agent-workspace-local-directory-support.ts";
import { createAgentWorkspaceLocalDirectoryMutations } from "./agent-workspace-local-directory-mutations.ts";
import { createAgentWorkspaceLocalDirectorySnapshotApi } from "./agent-workspace-local-directory-snapshot.ts";
import { readOrdinaryFileNoFollow } from "./agent-workspace-local-directory-safe-fs.ts";

type DataRecord = Record<string, unknown>;
type LocalDirectorySupportApi = ReturnType<
  typeof createAgentWorkspaceLocalDirectorySupport
>;
type LocalDirectorySnapshotApi = ReturnType<
  typeof createAgentWorkspaceLocalDirectorySnapshotApi
>;
type LocalDirectoryMutationsApi = ReturnType<
  typeof createAgentWorkspaceLocalDirectoryMutations
>;
type ResolvedLocalDirectorySource = ReturnType<
  LocalDirectorySupportApi["resolveLocalDirectorySource"]
>;
type ResolvedLocalDirectoryPath = ReturnType<
  LocalDirectorySupportApi["resolveLocalDirectoryMountPath"]
>;
type CaptureLocalDirectoryInput = Parameters<
  LocalDirectorySnapshotApi["captureLocalDirectoryPreimage"]
>[0];
type LocalDirectorySnapshot = Parameters<
  LocalDirectorySnapshotApi["workspacePreimageSnapshot"]
>[0];

interface Workspace extends DataRecord {
  workspaceId: string;
}
interface WorkspaceAccessSuccess {
  ok: true;
  workspace: Workspace;
}
interface WorkspaceAccessFailure extends DataRecord {
  ok: false;
}
type WorkspaceAccess = WorkspaceAccessSuccess | WorkspaceAccessFailure;
interface MountSelection {
  workspaceId: string;
  sourcePath: string;
  expiresAt: number;
}
interface LocalDirectoryMount extends DataRecord {
  mountRef: string;
  workspaceId: string;
  sourcePath: string;
  sourceRootName: string;
  sourceRootHash: string;
  targetPath: string;
  status: string;
  symlinkPolicy: "reject";
  createdAt: string;
  updatedAt: string;
  connectedBy: string;
}
interface LocalDirectoryListItem {
  name: string;
  sourceRelativePath: string;
  type: "directory" | "file" | "special";
  state: "staged";
  archived: false;
  sizeBytes: number;
  mtimeMs: number;
  contentSha256?: string;
}
interface SyncPlanSuccess extends DataRecord {
  ok: true;
  summary: unknown;
  sourceFileCount: number;
  targetFileCount: number;
}
interface SyncPlanFailure extends DataRecord {
  ok: false;
}
type SyncPlan = SyncPlanSuccess | SyncPlanFailure;
interface CasBlock {
  cid: string;
  payloadHash: string;
  byteLength: number;
  bytes: Buffer;
}
interface MerkleState {
  cas?: {
    putBlock(content: Buffer, options: DataRecord): Promise<CasBlock>;
    getBlock(cid: string): Promise<CasBlock | null>;
  };
}
interface FileStateApi {
  filePayloadMetadata?(file: DataRecord): DataRecord;
  commitWorkspaceFileState?(input: DataRecord): Promise<unknown>;
  recordWorkspaceFileCheckpoint?(input: DataRecord): Promise<unknown>;
}
interface LocalDirectoryDependencies {
  userDataPath?: string;
  localDirectoryMountConfigPath: string;
  workspaceForStorage(input: DataRecord): WorkspaceAccess;
  createAccessReceipt(input: DataRecord): DataRecord;
  localDirectorySyncPlan(
    input: DataRecord,
    options: { allowDirectSourcePath: boolean },
  ): SyncPlan;
  decodeWorkspaceFileContent(input: DataRecord): Buffer;
  updateWorkspaceTimeStmt: {
    run(updatedAt: string, workspaceId: string): unknown;
  };
  merkleState?: MerkleState | null;
  fileStateApi?: FileStateApi | null;
}
interface LocalDirectoryApi {
  createLocalDirectoryMountSelection(input?: DataRecord): unknown;
  connectLocalDirectory(input?: DataRecord): unknown;
  listLocalDirectoryMounts(input?: DataRecord): unknown;
  listLocalDirectoryItems(input?: DataRecord): unknown;
  localDirectoryItemMetadata(input?: DataRecord): unknown;
  readLocalDirectoryFile(input?: DataRecord): unknown;
  writeLocalDirectoryFile(input?: DataRecord): Promise<unknown>;
  createLocalDirectoryFolder(input?: DataRecord): Promise<unknown>;
  deleteLocalDirectoryItem(input?: DataRecord): Promise<unknown>;
  moveLocalDirectoryItem(input?: DataRecord): Promise<unknown>;
  resolveLocalDirectorySource(
    input?: DataRecord,
    workspace?: { workspaceId?: unknown },
    options?: { allowDirectSourcePath?: boolean },
  ): unknown;
  hasLocalDirectoryMountRef(input?: DataRecord): boolean;
  restoreLocalDirectoryPreimage(input: DataRecord): Promise<unknown>;
  rollbackLocalDirectoryMutation(input: DataRecord): Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function captureInput(input: DataRecord): CaptureLocalDirectoryInput {
  if (!isRecord(input.workspace)) {
    throw new TypeError("Local-directory capture requires a workspace.");
  }
  return {
    workspace: { workspaceId: String(input.workspace.workspaceId || "") },
    input: isRecord(input.input) ? input.input : {},
    relativePaths: Array.isArray(input.relativePaths)
      ? input.relativePaths
      : [],
    operationId: String(input.operationId || ""),
    fixedRoots: input.fixedRoots === true,
  };
}

function isLocalDirectorySnapshot(
  value: unknown,
): value is LocalDirectorySnapshot {
  return (
    isRecord(value) &&
    typeof value.schemaVersion === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.mountRef === "string" &&
    typeof value.mountIdentityHash === "string" &&
    Array.isArray(value.roots) &&
    Array.isArray(value.entries) &&
    typeof value.totalBytes === "number" &&
    typeof value.entryCount === "number" &&
    typeof value.fingerprint === "string"
  );
}

function requireSnapshot(value: unknown): LocalDirectorySnapshot {
  if (!isLocalDirectorySnapshot(value)) {
    throw new TypeError("Local-directory snapshot is invalid.");
  }
  return value;
}

function snapshotOperationInput(input: DataRecord) {
  if (!isRecord(input.workspace)) {
    throw new TypeError(
      "Local-directory snapshot operation requires a workspace.",
    );
  }
  return {
    workspace: { workspaceId: String(input.workspace.workspaceId || "") },
    snapshot: requireSnapshot(input.snapshot),
    dryRun: input.dryRun === true,
  };
}

function errorNumber(
  error: unknown,
  property: "status",
  fallback: number,
): number {
  if (error !== null && typeof error === "object" && property in error) {
    return Number(error[property]) || fallback;
  }
  return fallback;
}

function errorCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    return String(error.code || "");
  }
  return "";
}

function bufferEncoding(value: unknown): BufferEncoding {
  const encoding = String(value || "utf8");
  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError(`Unsupported text encoding: ${encoding}`);
  }
  return encoding;
}

export function createAgentWorkspaceLocalDirectoryApi({
  userDataPath,
  localDirectoryMountConfigPath,
  workspaceForStorage,
  createAccessReceipt,
  localDirectorySyncPlan,
  decodeWorkspaceFileContent,
  updateWorkspaceTimeStmt,
  merkleState = null,
  fileStateApi = null,
}: LocalDirectoryDependencies): LocalDirectoryApi {
  const filePayloadMetadata = fileStateApi?.filePayloadMetadata || (() => ({}));
  const commitWorkspaceFileState =
    fileStateApi?.commitWorkspaceFileState || (async () => null);
  const recordWorkspaceFileCheckpoint =
    fileStateApi?.recordWorkspaceFileCheckpoint || (async () => null);

  const localDirectorySupport: LocalDirectorySupportApi =
    createAgentWorkspaceLocalDirectorySupport({
      userDataPath,
      localDirectoryMountConfigPath,
      createAccessReceipt,
    });
  const {
    readLocalDirectoryMountConfig,
    writeLocalDirectoryMountConfig,
    validateLocalDirectoryRoot,
    publicLocalDirectoryMount,
    resolveLocalDirectorySource,
    hasLocalDirectoryMountRef,
    resolveLocalDirectoryMountPath,
    localDirectoryFileMetadataFromStat,
    localDirectoryAccessReceipt,
  } = localDirectorySupport;
  const mountSelections = new Map<string, MountSelection>();

  function pruneMountSelections(now = Date.now()): void {
    for (const [selectionRef, selection] of mountSelections) {
      if (selection.expiresAt <= now) mountSelections.delete(selectionRef);
    }
    while (mountSelections.size >= 128) {
      const oldest = mountSelections.keys().next().value;
      if (oldest === undefined) break;
      mountSelections.delete(oldest);
    }
  }

  function createLocalDirectoryMountSelection(input: DataRecord = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) return access;
    let root: ReturnType<
      LocalDirectorySupportApi["validateLocalDirectoryRoot"]
    >;
    try {
      root = validateLocalDirectoryRoot(input.sourcePath);
    } catch (error: unknown) {
      return { ok: false, status: 400, error: errorMessage(error) };
    }
    pruneMountSelections();
    const mountSelectionRef = `local-directory-selection:${randomUUID().replaceAll("-", "")}`;
    mountSelections.set(
      mountSelectionRef,
      Object.freeze({
        workspaceId: access.workspace.workspaceId,
        sourcePath: root.realPath,
        expiresAt: Date.now() + 60_000,
      }),
    );
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      mountSelectionRef,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
  const localDirectorySnapshotApi: LocalDirectorySnapshotApi =
    createAgentWorkspaceLocalDirectorySnapshotApi({
      merkleState,
      resolveLocalDirectoryMountPath,
      mountMutationKey,
    });
  const {
    captureLocalDirectoryPreimage,
    validateLocalDirectoryPreimage,
    restoreLocalDirectoryPreimage,
    rollbackLocalDirectoryMutation,
    workspacePreimageSnapshot,
    writeFileAtomically,
    ensureDirectorySafely,
    removePathSafely,
    renamePathSafely,
  } = localDirectorySnapshotApi;
  const localDirectoryMutations: LocalDirectoryMutationsApi =
    createAgentWorkspaceLocalDirectoryMutations({
      workspaceForStorage,
      decodeWorkspaceFileContent,
      updateWorkspaceTimeStmt,
      filePayloadMetadata,
      commitWorkspaceFileState,
      recordWorkspaceFileCheckpoint,
      resolveLocalDirectoryMountPath: (input, workspace, options) => {
        const resolved = resolveLocalDirectoryMountPath(
          input,
          workspace,
          options,
        );
        return {
          ...resolved,
          mount: resolved.mount ? { ...resolved.mount } : null,
          stat: resolved.stat || undefined,
        };
      },
      localDirectoryFileMetadataFromStat,
      localDirectoryAccessReceipt,
      publicLocalDirectoryMount,
      archiveLocalDirectoryContent,
      mountMutationKey,
      captureLocalDirectoryPreimage: (input) =>
        captureLocalDirectoryPreimage(captureInput(input)),
      validateLocalDirectoryPreimage: (input) =>
        validateLocalDirectoryPreimage(
          input as Parameters<typeof validateLocalDirectoryPreimage>[0],
        ),
      rollbackLocalDirectoryMutation,
      workspacePreimageSnapshot: (snapshot) =>
        workspacePreimageSnapshot(requireSnapshot(snapshot)),
      writeFileAtomically,
      ensureDirectorySafely,
      removePathSafely,
      renamePathSafely,
    });
  const {
    writeLocalDirectoryFile,
    createLocalDirectoryFolder,
    deleteLocalDirectoryItem,
    moveLocalDirectoryItem,
  } = localDirectoryMutations;

  async function archiveLocalDirectoryContent(
    content: Buffer,
    metadata: DataRecord = {},
  ) {
    if (!merkleState?.cas?.putBlock) {
      return null;
    }
    const block = await merkleState.cas.putBlock(content, {
      codec: "raw",
      metadata,
    });
    return {
      rootCid: block.cid,
      contentRefs: [block.cid],
      metadata: {
        contentSha256: block.payloadHash,
        sizeBytes: block.byteLength,
        contentCid: block.cid,
      },
    };
  }

  /** Build mount-scoped mutation key to avoid collisions with sandbox files. */
  function mountMutationKey(mountRef: string, relativePath: string): string {
    return `__mount__/${mountRef}/${relativePath}`;
  }

  function connectLocalDirectory(input: DataRecord = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let targetPath: string;
    try {
      targetPath = normalizeWorkspaceRelativePath(
        input.targetPath || input.path || "",
        { allowEmpty: true },
      );
    } catch (error: unknown) {
      return { ok: false, status: 400, error: errorMessage(error) };
    }
    let root: ReturnType<
      LocalDirectorySupportApi["validateLocalDirectoryRoot"]
    >;
    const mountSelectionRef = String(input.mountSelectionRef || "").trim();
    try {
      if (mountSelectionRef) {
        pruneMountSelections();
        const selection = mountSelections.get(mountSelectionRef);
        mountSelections.delete(mountSelectionRef);
        if (
          !selection ||
          selection.workspaceId !== access.workspace.workspaceId ||
          selection.expiresAt <= Date.now()
        ) {
          throw new Error("本机目录选择已失效或不属于当前工作空间。");
        }
        root = validateLocalDirectoryRoot(selection.sourcePath);
      } else {
        root = validateLocalDirectoryRoot(
          input.sourcePath || input.localPath || input.dirPath,
        );
      }
    } catch (error: unknown) {
      return { ok: false, status: 400, error: errorMessage(error) };
    }
    const validationPlan = localDirectorySyncPlan(
      {
        ...input,
        workspaceId: access.workspace.workspaceId,
        sourcePath: root.realPath,
        targetPath,
        maxFiles: input.maxFiles || 2000,
      },
      { allowDirectSourcePath: true },
    );
    if (!validationPlan.ok) {
      return validationPlan;
    }
    const timestamp = nowIso();
    const mountRef =
      String(input.mountRef || "").trim() ||
      stableId(
        "local_dir_mount",
        access.workspace.workspaceId,
        root.realPath,
        targetPath,
      );
    const mount: LocalDirectoryMount = {
      mountRef,
      workspaceId: access.workspace.workspaceId,
      sourcePath: root.realPath,
      sourceRootName: path.basename(root.realPath),
      sourceRootHash: stableHash(root.realPath),
      targetPath,
      status: input.enabled === false ? "disabled" : "active",
      symlinkPolicy: "reject",
      createdAt: timestamp,
      updatedAt: timestamp,
      connectedBy: String(
        input.createdBy || input.actorUserId || input.agentId || "",
      ),
    };
    const config = readLocalDirectoryMountConfig();
    const existingIndex = config.mounts.findIndex(
      (item) => String(item.mountRef || "") === mountRef,
    );
    if (existingIndex >= 0) {
      mount.createdAt = config.mounts[existingIndex].createdAt || timestamp;
      config.mounts[existingIndex] = mount;
    } else {
      config.mounts.push(mount);
    }
    writeLocalDirectoryMountConfig(config);
    updateWorkspaceTimeStmt.run(timestamp, access.workspace.workspaceId);
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      mount: publicLocalDirectoryMount(mount),
      syncPreview: {
        dryRun: true,
        summary: validationPlan.summary,
        sourceFileCount: validationPlan.sourceFileCount,
        targetFileCount: validationPlan.targetFileCount,
      },
    };
  }

  function listLocalDirectoryMounts(input: DataRecord = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    const config = readLocalDirectoryMountConfig();
    const mounts = config.mounts
      .filter(
        (item) =>
          String(item.workspaceId || "") === access.workspace.workspaceId,
      )
      .map((item) => publicLocalDirectoryMount(item));
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      mounts,
      count: mounts.length,
    };
  }

  function listLocalDirectoryItems(input: DataRecord = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let source: ResolvedLocalDirectorySource;
    try {
      source = resolveLocalDirectorySource(input, access.workspace);
    } catch (error: unknown) {
      return { ok: false, status: 400, error: errorMessage(error) };
    }
    let basePath: string;
    try {
      basePath = normalizeWorkspaceRelativePath(
        input.path || input.relativePath || "",
        { allowEmpty: true },
      );
    } catch (error: unknown) {
      return { ok: false, status: 400, error: errorMessage(error) };
    }
    const root = source.sourcePath;
    let target = basePath ? path.resolve(root, ...basePath.split("/")) : root;
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      return { ok: false, status: 400, error: "路径不能跳出本机目录 mount。" };
    }
    try {
      target = assertPathWithinRootSync(root, target, {
        label: "本机目录路径",
        allowMissing: true,
        allowDirectory: true,
        allowFile: true,
        allowSpecial: false,
      }).absolutePath;
    } catch (error: unknown) {
      return { ok: false, status: 400, error: errorMessage(error) };
    }
    if (!fs.existsSync(target)) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        mode: "localDir",
        mount: source.mount ? publicLocalDirectoryMount(source.mount) : null,
        basePath,
        exists: false,
        paths: [],
        items: [],
        count: 0,
        accessReceipt: createAccessReceipt({
          workspaceId: access.workspace.workspaceId,
          operationId: input.operationId || "agent_workspaces.files.list",
          path: basePath || "/",
          action: "localDir.list",
        }),
      };
    }
    const rootStat = fs.lstatSync(target);
    if (rootStat.isSymbolicLink()) {
      return { ok: false, status: 400, error: "不允许列出符号链接对象。" };
    }
    const includeDirectories = input.includeDirectories !== false;
    const includeFiles = input.includeFiles !== false;
    const includeHash = input.includeHash === true;
    const recursive = input.recursive === true;
    const limit = boundedInteger(input.limit, 200, 1, 2000);
    const items: LocalDirectoryListItem[] = [];
    const toItem = (
      absolutePath: string,
      relativePath: string,
      stat: fs.Stats,
    ): LocalDirectoryListItem => ({
      name: path.basename(absolutePath),
      sourceRelativePath: relativePath,
      type: stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : "special",
      state: "staged",
      archived: false,
      sizeBytes: Number(stat.size || 0),
      mtimeMs: Number(stat.mtimeMs || 0),
      contentSha256:
        includeHash && stat.isFile()
          ? sha256Buffer(fs.readFileSync(absolutePath))
          : undefined,
    });
    const visit = (absoluteDir: string, relativeDir: string): void => {
      if (items.length >= limit) {
        return;
      }
      const entries = fs
        .readdirSync(absoluteDir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (items.length >= limit) {
          return;
        }
        if (entry.name.startsWith(".")) {
          throw new Error(
            `不允许列出以 . 开头的路径：${relativeDir ? `${relativeDir}/` : ""}${entry.name}`,
          );
        }
        const childAbsolutePath = path.join(absoluteDir, entry.name);
        const childRelativePath = relativeDir
          ? `${relativeDir}/${entry.name}`
          : entry.name;
        const stat = fs.lstatSync(childAbsolutePath);
        if (stat.isSymbolicLink()) {
          throw new Error(`不允许列出符号链接：${childRelativePath}`);
        }
        if (
          (stat.isDirectory() && includeDirectories) ||
          (stat.isFile() && includeFiles) ||
          (!stat.isDirectory() && !stat.isFile())
        ) {
          items.push(toItem(childAbsolutePath, childRelativePath, stat));
        }
        if (stat.isDirectory() && recursive) {
          visit(childAbsolutePath, childRelativePath);
        }
      }
    };
    try {
      if (rootStat.isDirectory()) {
        visit(target, basePath);
      } else if (includeFiles) {
        items.push(toItem(target, basePath, rootStat));
      }
    } catch (error: unknown) {
      return { ok: false, status: 400, error: errorMessage(error) };
    }
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      mode: "localDir",
      mount: source.mount ? publicLocalDirectoryMount(source.mount) : null,
      basePath,
      exists: true,
      paths: items.map((item) => item.sourceRelativePath),
      items,
      count: items.length,
      accessReceipt: createAccessReceipt({
        workspaceId: access.workspace.workspaceId,
        operationId: input.operationId || "agent_workspaces.files.list",
        path: basePath || "/",
        action: "localDir.list",
      }),
    };
  }

  function localDirectoryItemMetadata(input: DataRecord = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let resolved: ResolvedLocalDirectoryPath;
    try {
      resolved = resolveLocalDirectoryMountPath(input, access.workspace, {
        allowEmpty: true,
        allowMissing: true,
        allowDirectory: true,
        allowFile: true,
      });
    } catch (error: unknown) {
      return { ok: false, status: 400, error: errorMessage(error) };
    }
    const mountRef = String(resolved.mount?.mountRef || "");
    if (!resolved.exists) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        mode: "localDir",
        mount: resolved.mount
          ? publicLocalDirectoryMount(resolved.mount)
          : null,
        exists: false,
        item: {
          workspaceId: access.workspace.workspaceId,
          mountRef,
          relativePath: resolved.relativePath,
        },
        accessReceipt: localDirectoryAccessReceipt({
          workspaceId: access.workspace.workspaceId,
          mountRef,
          operationId: String(
            input.operationId || "agent_workspaces.file.stat",
          ),
          path: resolved.relativePath || "/",
          action: "localDir.stat",
        }),
      };
    }
    if (!resolved.stat) {
      return {
        ok: false,
        status: 409,
        error: "本机目录对象状态不可用。",
      };
    }
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      mode: "localDir",
      mount: resolved.mount ? publicLocalDirectoryMount(resolved.mount) : null,
      exists: true,
      item: localDirectoryFileMetadataFromStat({
        workspaceId: access.workspace.workspaceId,
        mount: resolved.mount,
        relativePath: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        stat: resolved.stat,
        includeHash: input.includeHash === true,
        rootPath: resolved.root,
      }),
      accessReceipt: localDirectoryAccessReceipt({
        workspaceId: access.workspace.workspaceId,
        mountRef,
        operationId: String(input.operationId || "agent_workspaces.file.stat"),
        path: resolved.relativePath || "/",
        action: "localDir.stat",
      }),
    };
  }

  function readLocalDirectoryFile(input: DataRecord = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let resolved: ResolvedLocalDirectoryPath;
    try {
      resolved = resolveLocalDirectoryMountPath(input, access.workspace, {
        allowEmpty: false,
        allowMissing: false,
        requireExisting: true,
        allowDirectory: false,
        allowFile: true,
      });
    } catch (error: unknown) {
      return {
        ok: false,
        status: errorCode(error) === "ENOENT" ? 404 : 400,
        error: errorMessage(error),
      };
    }
    let content: Buffer;
    let stat: fs.Stats;
    try {
      ({ content, stat } = readOrdinaryFileNoFollow(
        resolved.root,
        resolved.absolutePath,
      ));
    } catch (error: unknown) {
      return {
        ok: false,
        status: errorNumber(error, "status", 400),
        error: errorMessage(error),
      };
    }
    const mountRef = String(resolved.mount?.mountRef || "");
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      mode: "localDir",
      mount: resolved.mount ? publicLocalDirectoryMount(resolved.mount) : null,
      file: localDirectoryFileMetadataFromStat({
        workspaceId: access.workspace.workspaceId,
        mount: resolved.mount,
        relativePath: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        stat,
        includeHash: input.includeHash !== false,
        rootPath: resolved.root,
        contentBuffer: content,
      }),
      accessReceipt: localDirectoryAccessReceipt({
        workspaceId: access.workspace.workspaceId,
        mountRef,
        operationId: String(input.operationId || "workspace.file.read"),
        path: resolved.relativePath,
        action: "localDir.read",
      }),
      encoding: "base64",
      contentBase64: content.toString("base64"),
      content:
        input.includeText === false
          ? undefined
          : content.toString(
              bufferEncoding(input.textEncoding || input.encoding),
            ),
    };
  }

  return {
    createLocalDirectoryMountSelection,
    connectLocalDirectory,
    listLocalDirectoryMounts,
    listLocalDirectoryItems,
    localDirectoryItemMetadata,
    readLocalDirectoryFile,
    writeLocalDirectoryFile,
    createLocalDirectoryFolder,
    deleteLocalDirectoryItem,
    moveLocalDirectoryItem,
    resolveLocalDirectorySource,
    hasLocalDirectoryMountRef,
    restoreLocalDirectoryPreimage: (input) =>
      restoreLocalDirectoryPreimage(snapshotOperationInput(input)),
    rollbackLocalDirectoryMutation: (input) =>
      rollbackLocalDirectoryMutation(snapshotOperationInput(input)),
  };
}
