import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getRuntimeLogger } from "@meshrix/foundation/observability/runtime-logger";
import {
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  asArray,
  asObject,
  assertWorkspaceFileContentPolicy,
  fileMetadataFromStat,
  joinWorkspaceRelativePath,
  normalizeSha256,
  normalizeWorkspaceRelativePath,
  nowIso,
  sha256Buffer,
  stripExecutableMode
} from "./agent-workspace-support.ts";

export interface SyncRecord { [key: string]: unknown; }
interface SyncInput extends SyncRecord { leaseGuard?: () => Promise<void> | void; }
export interface WorkspaceRecord extends SyncRecord { workspaceId: string; }
type WorkspaceAccess =
  | { ok: true; workspace: WorkspaceRecord }
  | { ok: false; workspace?: WorkspaceRecord; status?: number; error?: string };
interface ResolvedWorkspacePath { absolutePath: string; relativePath: string; }
interface LocalDirectorySource { sourcePath: string; mount?: { mountRef?: string }; }
interface SyncFile {
  relativePath: string; sizeBytes: number; contentSha256: string; absolutePath?: string;
  sourceRelativePath?: string;
}
type SyncActionKind = "create" | "write" | "replace" | "delete" | "noop";
export interface SyncAction {
  action: SyncActionKind; targetPath: string; sizeBytes: number; contentSha256: string;
  sourceRelativePath?: string;
}
interface SyncSummary { create: number; write: number; delete: number; noop: number; changed: number; applied?: number; }
export interface SyncPlan {
  protocolVersion: string; ok: true; dryRun: boolean; workspaceId: string; targetPath: string;
  mountRef: string; deleteExtraneous: boolean; sourceFileCount: number; targetFileCount: number;
  actions: SyncAction[]; summary: SyncSummary;
}
export interface SyncFailure extends Record<string, unknown> { ok: false; status?: number; code?: string; error?: string; }
interface SyncError extends Error { code?: string; status?: number; }
interface ContentHandle { read(): Promise<Buffer> | Buffer; byteLength?: number; contentSha256?: string; }
interface SnapshotEntry extends SyncRecord {
  relativePath: string; exists: boolean; content?: Buffer; contentHandle?: ContentHandle;
  contentSha256: string; byteLength: number; encoding: string;
}
interface WorkspaceSnapshot {
  basePath: string; stateRoot: string; stateEventAnchor: SyncRecord;
  deleteExtraneous: boolean; localDirectorySnapshots: SyncRecord[]; files: SnapshotEntry[];
}
export interface RestoreAction extends SyncRecord { action: SyncActionKind; scope?: string; path: string; }
interface RestorePreimage extends SyncRecord {
  exists: boolean; contentCid?: string; contentSha256?: string; byteLength?: number;
}
interface LocalRestoreResult extends SyncRecord {
  actions?: RestoreAction[]; appliedActions?: RestoreAction[]; stateMutations?: SyncRecord[];
  mutations?: SyncRecord[]; contentRefs?: unknown[]; rollbackSnapshot?: SyncRecord;
}
interface StoredContent extends SyncRecord {
  cid?: string; rootCid?: string; payloadHash?: string; byteLength?: number;
  metadata?: SyncRecord; contentRefs?: unknown[];
}
interface CasBlock { bytes?: Buffer; value?: { manifestType?: string; entries?: SyncRecord[] }; }
interface MerkleState extends SyncRecord {
  cas: { getBlock(cid: string): Promise<CasBlock | null>; putBlock?(content: Buffer, input: SyncRecord): Promise<StoredContent> };
  stateCommit?: {
    begin(input: SyncRecord): Promise<SyncRecord>;
    verifyRestoreLineage?(input: SyncRecord): Promise<unknown>;
    restoreRoot?(input: SyncRecord): Promise<SyncRecord>;
  };
  eventLog?: { listEvents(scope: unknown, input: SyncRecord): Promise<SyncRecord[]> };
}
interface FileStateApi extends SyncRecord {
  decodeWorkspaceFileContent(entry: SyncRecord): Promise<Buffer> | Buffer;
  filePayloadMetadata(file: SyncRecord): SyncRecord;
  archiveWorkspacePath(workspace: WorkspaceRecord, relativePath: string, input: SyncRecord): Promise<StoredContent | null>;
  commitWorkspaceFileState(input: SyncRecord): Promise<SyncRecord>;
  recordWorkspaceFileCheckpoint(input: SyncRecord): Promise<SyncRecord>;
  workspaceStateScope(workspace: WorkspaceRecord): unknown;
  buildWorkspaceFileSnapshotFromStateRoot(workspace: WorkspaceRecord, stateRoot: unknown): Promise<SyncRecord>;
}
interface SyncApiOptions {
  merkleState?: MerkleState | null;
  workspaceForStorage(input: SyncRecord): WorkspaceAccess;
  resolveWorkspacePath(workspace: WorkspaceRecord, relativePath: string, options?: SyncRecord): ResolvedWorkspacePath;
  resolveLocalDirectorySource(input: SyncRecord, workspace: WorkspaceRecord, options?: SyncRecord): LocalDirectorySource;
  listWorkspaceFiles(input: SyncRecord): Promise<({ ok: true; files: SyncFile[] } | SyncFailure) & SyncRecord>;
  updateWorkspaceTimeStmt: { run(iso: string, workspaceId: string): unknown };
  fileStateApi: FileStateApi;
  restoreLocalDirectoryPreimage?: ((input: SyncRecord) => Promise<LocalRestoreResult>) | null;
  rollbackLocalDirectoryMutation?: ((input: SyncRecord) => Promise<LocalRestoreResult>) | null;
}

function syncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function syncErrorDetails(error: unknown): { code?: string; status?: number } {
  if (!error || typeof error !== "object") return {};
  const candidate = error as { code?: unknown; status?: unknown };
  return {
    ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    ...(typeof candidate.status === "number" ? { status: candidate.status } : {})
  };
}

export function createAgentWorkspaceSyncApi({
  merkleState = null,
  workspaceForStorage,
  resolveWorkspacePath,
  resolveLocalDirectorySource,
  listWorkspaceFiles,
  updateWorkspaceTimeStmt,
  fileStateApi,
  restoreLocalDirectoryPreimage = null,
  rollbackLocalDirectoryMutation = null
}: SyncApiOptions) {
  const {
    decodeWorkspaceFileContent,
    filePayloadMetadata,
    archiveWorkspacePath,
    commitWorkspaceFileState,
    recordWorkspaceFileCheckpoint
  } = fileStateApi;

  function sandboxMutationOrigin(input: SyncRecord = {}, { requireApproval = false }: { requireApproval?: boolean } = {}) {
    const sandboxReceiptDigest = normalizeSha256(input.sandboxReceiptDigest || "");
    if (!sandboxReceiptDigest) return null;
    const sandboxBindings = asObject(input.sandboxBindings);
    const calculatedReceiptDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify(sandboxBindings))
      .digest("hex");
    if (calculatedReceiptDigest !== sandboxReceiptDigest) {
      const error: SyncError = new Error("Sandbox receipt binding does not match its declared digest.");
      error.code = "sandbox_receipt_binding_mismatch";
      error.status = 409;
      throw error;
    }
    const previewDigest = normalizeSha256(input.previewDigest || "");
    const approvalBindingDigest = normalizeSha256(input.approvalBindingDigest || "");
    if (requireApproval && (!previewDigest || !approvalBindingDigest)) {
      const error: SyncError = new Error("Sandbox output commit requires preview and approval bindings.");
      error.code = "sandbox_output_approval_binding_required";
      error.status = 409;
      throw error;
    }
    return {
      kind: "controlled-sandbox-output",
      sandboxReceiptDigest,
      ...(previewDigest ? { previewDigest } : {}),
      ...(approvalBindingDigest ? { approvalBindingDigest } : {})
    };
  }

  function sandboxMutationReceipt({ mutationOrigin, preimage, stateCommit, checkpoint }: {
    mutationOrigin?: SyncRecord | null; preimage?: SyncRecord | null;
    stateCommit?: SyncRecord | null; checkpoint?: SyncRecord | null;
  } = {}) {
    if (!mutationOrigin) return null;
    if (
      !preimage ||
      !stateCommit?.commitId ||
      !checkpoint?.nodeId ||
      !normalizeSha256(checkpoint.checkpointBindingDigest || "") ||
      !normalizeSha256(mutationOrigin.previewDigest || "") ||
      !normalizeSha256(mutationOrigin.approvalBindingDigest || "")
    ) {
      const error: SyncError = new Error("Workspace sandbox mutation receipt could not be persisted with its transaction.");
      error.code = "workspace_sandbox_mutation_receipt_incomplete";
      error.status = 503;
      throw error;
    }
    const receipt = {
      schemaVersion: "v0.0.1:workspace:sandbox-mutation-receipt-1",
      sandboxReceiptDigest: mutationOrigin.sandboxReceiptDigest,
      previewDigest: mutationOrigin.previewDigest,
      approvalBindingDigest: mutationOrigin.approvalBindingDigest,
      preimageDigest: crypto.createHash("sha256").update(JSON.stringify(preimage)).digest("hex"),
      stateCommitId: stateCommit.commitId,
      stateCommitDigest: crypto.createHash("sha256").update(JSON.stringify(stateCommit)).digest("hex"),
      checkpointNodeId: checkpoint.nodeId,
      checkpointDigest: checkpoint.checkpointBindingDigest
    };
    return {
      ...receipt,
      receiptDigest: crypto.createHash("sha256").update(JSON.stringify(receipt)).digest("hex")
    };
  }
  function scanDirectoryForWorkspaceSync(root: string, {
    rootRelativePath = "",
    maxFiles = 2000
  }: { rootRelativePath?: string; maxFiles?: number } = {}): SyncFile[] {
    const resolvedRoot = path.resolve(root);
    if (!fs.existsSync(resolvedRoot)) {
      throw new Error("本机目录不存在。");
    }
    const rootStat = fs.lstatSync(resolvedRoot);
    if (rootStat.isSymbolicLink()) {
      throw new Error("不允许同步符号链接目录。");
    }
    if (!rootStat.isDirectory()) {
      throw new Error("sourcePath 必须是本机目录。");
    }
    const files: SyncFile[] = [];
    const visit = (absoluteDir: string, relativeDir: string): void => {
      const entries = fs.readdirSync(absoluteDir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          throw new Error(`不允许同步以 . 开头的路径：${relativeDir ? `${relativeDir}/` : ""}${entry.name}`);
        }
        const childAbsolutePath = path.join(absoluteDir, entry.name);
        const childRelativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const stat = fs.lstatSync(childAbsolutePath);
        if (stat.isSymbolicLink()) {
          throw new Error(`不允许同步符号链接：${childRelativePath}`);
        }
        if (stat.isDirectory()) {
          visit(childAbsolutePath, childRelativePath);
          continue;
        }
        if (!stat.isFile()) {
          throw new Error(`不支持同步非普通文件：${childRelativePath}`);
        }
        if (files.length >= maxFiles) {
          throw new Error(`同步文件数量超过限制：${maxFiles}`);
        }
        const targetRelativePath = rootRelativePath
          ? joinWorkspaceRelativePath(rootRelativePath, childRelativePath)
          : normalizeWorkspaceRelativePath(childRelativePath, { allowEmpty: false });
        assertWorkspaceFileContentPolicy({
          relativePath: targetRelativePath,
          sizeBytes: stat.size
        });
        const content = fs.readFileSync(childAbsolutePath);
        assertWorkspaceFileContentPolicy({
          relativePath: targetRelativePath,
          contentBuffer: content,
          sizeBytes: stat.size
        });
        files.push({
          sourceRelativePath: normalizeWorkspaceRelativePath(childRelativePath, { allowEmpty: false }),
          relativePath: targetRelativePath,
          absolutePath: childAbsolutePath,
          sizeBytes: Number(stat.size || 0),
          contentSha256: sha256Buffer(content)
        });
      }
    };
    visit(resolvedRoot, "");
    return files;
  }

  function scanWorkspaceFilesForSync(workspace: WorkspaceRecord, basePath = "", maxFiles = 2000): SyncFile[] {
    const base = resolveWorkspacePath(workspace, basePath, { allowEmpty: true });
    if (!fs.existsSync(base.absolutePath)) {
      return [];
    }
    const stat = fs.lstatSync(base.absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error("工作空间同步目标不能是符号链接。");
    }
    if (!stat.isDirectory()) {
      throw new Error("工作空间同步目标必须是目录。");
    }
    const files: SyncFile[] = [];
    const visit = (absoluteDir: string, relativeDir: string): void => {
      const entries = fs.readdirSync(absoluteDir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const childAbsolutePath = path.join(absoluteDir, entry.name);
        const childRelativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const stat = fs.lstatSync(childAbsolutePath);
        if (stat.isSymbolicLink()) {
          throw new Error(`工作空间内存在不允许同步的符号链接：${childRelativePath}`);
        }
        if (stat.isDirectory()) {
          visit(childAbsolutePath, childRelativePath);
          continue;
        }
        if (!stat.isFile()) {
          continue;
        }
        if (files.length >= maxFiles) {
          throw new Error(`工作空间同步文件数量超过限制：${maxFiles}`);
        }
        const normalizedPath = normalizeWorkspaceRelativePath(childRelativePath, { allowEmpty: false });
        const finalRelativePath = basePath ? joinWorkspaceRelativePath(basePath, normalizedPath) : normalizedPath;
        const content = fs.readFileSync(childAbsolutePath);
        assertWorkspaceFileContentPolicy({
          relativePath: finalRelativePath,
          contentBuffer: content,
          sizeBytes: stat.size
        });
        files.push({
          relativePath: finalRelativePath,
          sizeBytes: Number(stat.size || 0),
          contentSha256: sha256Buffer(content)
        });
      }
    };
    visit(base.absolutePath, "");
    return files;
  }

  function localDirectorySyncPlan(input: SyncRecord = {}, options: SyncRecord = {}): SyncPlan | SyncFailure {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let source: LocalDirectorySource;
    try {
      source = resolveLocalDirectorySource(input, access.workspace, options);
    } catch (error: unknown) {
      return { ok: false, status: 400, error: syncErrorMessage(error) };
    }
    const sourcePath = source.sourcePath;
    let targetPath: string;
    try {
      targetPath = normalizeWorkspaceRelativePath(input.targetPath || input.path || "", { allowEmpty: true });
    } catch (error: unknown) {
      return { ok: false, status: 400, error: syncErrorMessage(error) };
    }
    const maxFiles = Math.max(1, Math.min(Number(input.maxFiles || input.limit || 2000), 10000));
    const deleteExtraneous = input.deleteExtraneous === true || input.prune === true;
    let sourceFiles: SyncFile[], targetFiles: SyncFile[];
    try {
      sourceFiles = scanDirectoryForWorkspaceSync(sourcePath, { rootRelativePath: targetPath, maxFiles });
      targetFiles = scanWorkspaceFilesForSync(access.workspace, targetPath, maxFiles);
    } catch (error: unknown) {
      return { ok: false, status: 400, error: syncErrorMessage(error) };
    }
    const targetByPath = new Map(targetFiles.map((file) => [file.relativePath, file]));
    const sourceByPath = new Map(sourceFiles.map((file) => [file.relativePath, file]));
    const actions: SyncAction[] = [];
    for (const source of sourceFiles) {
      const current = targetByPath.get(source.relativePath);
      const action: SyncActionKind = !current
        ? "create"
        : current.contentSha256 === source.contentSha256
          ? "noop"
          : "write";
      actions.push({
        action,
        sourceRelativePath: source.sourceRelativePath,
        targetPath: source.relativePath,
        sizeBytes: source.sizeBytes,
        contentSha256: source.contentSha256
      });
    }
    if (deleteExtraneous) {
      for (const current of targetFiles) {
        if (!sourceByPath.has(current.relativePath)) {
          actions.push({
            action: "delete",
            targetPath: current.relativePath,
            sizeBytes: current.sizeBytes,
            contentSha256: current.contentSha256
          });
        }
      }
    }
    const changedActions = actions.filter((action) => action.action !== "noop");
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      dryRun: true,
      workspaceId: access.workspace.workspaceId,
      targetPath,
      mountRef: source.mount?.mountRef || "",
      deleteExtraneous,
      sourceFileCount: sourceFiles.length,
      targetFileCount: targetFiles.length,
      actions,
      summary: {
        create: actions.filter((action) => action.action === "create").length,
        write: actions.filter((action) => action.action === "write").length,
        delete: actions.filter((action) => action.action === "delete").length,
        noop: actions.filter((action) => action.action === "noop").length,
        changed: changedActions.length
      }
    };
  }

  async function applyLocalDirectorySync(input: SyncRecord = {}) {
    const operationId = String(input.operationId || "").trim();
    if (!operationId) {
      return {
        ok: false,
        status: 400,
        code: "local_directory_operation_id_required",
        error: "Local-directory synchronization requires an explicit operationId."
      };
    }
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    const plan = localDirectorySyncPlan(input);
    if (!plan.ok) {
      return plan;
    }
    if (input.dryRun === true) {
      return plan;
    }
    let source: LocalDirectorySource;
    try {
      source = resolveLocalDirectorySource(input, access.workspace);
    } catch (error: unknown) {
      return { ok: false, status: 400, error: syncErrorMessage(error) };
    }
    const sourcePath = source.sourcePath;
    const sourceFiles = scanDirectoryForWorkspaceSync(sourcePath, {
      rootRelativePath: plan.targetPath,
      maxFiles: Math.max(1, Math.min(Number(input.maxFiles || input.limit || 2000), 10000))
    });
    const sourceByTarget = new Map(sourceFiles.map((file) => [file.relativePath, file]));
    const mutations: SyncRecord[] = [];
    const contentRefs: unknown[] = [];
    const appliedActions: SyncAction[] = [];
    for (const action of plan.actions) {
      if (action.action === "noop") {
        continue;
      }
      const target = resolveWorkspacePath(access.workspace, action.targetPath, { allowEmpty: false });
      if (action.action === "delete") {
        if (fs.existsSync(target.absolutePath)) {
          fs.rmSync(target.absolutePath, { force: true });
        }
        mutations.push({ action: "delete", key: target.relativePath });
        appliedActions.push(action);
        continue;
      }
      const source = sourceByTarget.get(action.targetPath);
      if (!source) {
        return { ok: false, status: 409, error: `同步源文件消失：${action.sourceRelativePath || action.targetPath}` };
      }
      const content = fs.readFileSync(source.absolutePath!);
      try {
        assertWorkspaceFileContentPolicy({
          relativePath: target.relativePath,
          contentBuffer: content,
          sizeBytes: source.sizeBytes
        });
      } catch (error: unknown) {
        return { ok: false, status: 400, error: syncErrorMessage(error) };
      }
      fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
      fs.writeFileSync(target.absolutePath, content);
      stripExecutableMode(target.absolutePath);
      const archived = await archiveWorkspacePath(access.workspace, target.relativePath, {
        operationId
      });
      const stat = fs.statSync(target.absolutePath);
      const file: SyncRecord = fileMetadataFromStat({
        workspaceId: access.workspace.workspaceId,
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        stat,
        includeHash: true
      });
      if (archived) {
        mutations.push({
          action: "put",
          key: target.relativePath,
          valueRef: archived.rootCid,
          metadata: {
            ...filePayloadMetadata(file),
            contentCid: archived?.metadata?.contentCid || ""
          }
        });
        contentRefs.push(...asArray(archived.contentRefs));
      }
      appliedActions.push(action);
    }
    updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
    const stateCommit = await commitWorkspaceFileState({
      workspace: access.workspace,
      operationId,
      mutations,
      contentRefs,
      payload: {
        action: "sync.apply",
        targetPath: plan.targetPath,
        mountRef: plan.mountRef,
        deleteExtraneous: plan.deleteExtraneous,
        summary: plan.summary
      }
    });
    const checkpoint = await recordWorkspaceFileCheckpoint({
      workspace: access.workspace,
      operationId,
      stateCommit,
      action: "sync.apply",
      path: plan.targetPath || "/",
      mutations
    });
    return {
      ...plan,
      dryRun: false,
      stateCommit,
      checkpoint,
      appliedActions,
      summary: {
        ...plan.summary,
        applied: appliedActions.length
      }
    };
  }

  async function decodeWorkspaceSnapshotContent(entry: SyncRecord = {}): Promise<Buffer> {
    if (entry.contentCid || entry.cid) {
      if (!merkleState) {
        throw new Error("文件快照引用 CAS contentCid，但 Merkle State 基座不可用。");
      }
      const seen = new Set<string>();
      const decodeCid = async (cid?: unknown): Promise<Buffer> => {
        const normalizedCid = String(cid || "");
        if (!normalizedCid || seen.has(normalizedCid) || seen.size >= 100_000) {
          throw new Error("Workspace snapshot CAS manifest is cyclic or exceeds its bound.");
        }
        seen.add(normalizedCid);
        const block = await merkleState.cas.getBlock(normalizedCid);
        if (!block) {
          throw new Error(`文件快照内容块不存在：${normalizedCid}`);
        }
        if (block.value?.manifestType !== "meshrix.merkle-dag.manifest") {
          return Buffer.from(block.bytes || []);
        }
        const chunks: Buffer[] = [];
        const manifestEntries = asArray<SyncRecord>(block.value.entries)
          .slice()
          .sort((left, right) =>
            Number(asObject(left.metadata).chunkIndex ?? 0) - Number(asObject(right.metadata).chunkIndex ?? 0) ||
            String(left?.key || left?.path || "").localeCompare(String(right?.key || right?.path || ""))
          );
        for (const manifestEntry of manifestEntries) {
          chunks.push(await decodeCid(manifestEntry.valueRef || manifestEntry.cid));
        }
        return Buffer.concat(chunks);
      };
      return decodeCid(entry.contentCid || entry.cid);
    }
    return decodeWorkspaceFileContent(entry);
  }

  async function readWorkspaceSnapshotEntryContent(entry: SyncRecord = {}) {
    const contentHandle = entry.contentHandle as ContentHandle | undefined;
    const content = contentHandle && typeof contentHandle.read === "function"
      ? await contentHandle.read()
      : Buffer.isBuffer(entry.content)
        ? entry.content
        : await decodeWorkspaceSnapshotContent(entry);
    if (!Buffer.isBuffer(content)) {
      throw new Error("Workspace snapshot content handle must return a Buffer.");
    }
    const expectedByteLength = Number(entry.byteLength ?? entry.sizeBytes ?? content.length);
    if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0) {
      throw new Error("Workspace snapshot byte length is invalid.");
    }
    if (content.length !== expectedByteLength) {
      throw new Error("Workspace snapshot content size does not match its declared byte length.");
    }
    const contentSha256 = sha256Buffer(content);
    const expectedSha256 = normalizeSha256(
      entry.contentSha256 || entry.sha256 || entry.expectedSha256 || ""
    );
    if (expectedSha256 && expectedSha256 !== contentSha256) {
      throw new Error("Workspace snapshot content does not match its declared digest.");
    }
    return {
      content,
      contentSha256,
      byteLength: content.length
    };
  }

  async function normalizeWorkspaceFileSnapshot(input: SyncRecord = {}): Promise<WorkspaceSnapshot> {
    let snapshot: SyncRecord = asObject(input.snapshot || input.workspaceFileSnapshot || input.fileSnapshot || input);
    if (
      snapshot.incremental === true &&
      snapshot.stateRoot &&
      asArray(input.stateRootAllowedOperationIds).length > 0
    ) {
      const access = workspaceForStorage(input);
      if (!access.ok) {
        throw new Error(access.error || "Workspace snapshot access is unavailable.");
      }
      snapshot = await fileStateApi.buildWorkspaceFileSnapshotFromStateRoot(access.workspace, snapshot.stateRoot);
    }
    const basePath = normalizeWorkspaceRelativePath(snapshot.basePath || snapshot.rootPath || input.basePath || "", { allowEmpty: true });
    const rawFiles = asArray<SyncRecord>(snapshot.files || snapshot.entries || input.files);
    const localDirectorySnapshots = asArray<SyncRecord>(snapshot.localDirectorySnapshots || snapshot.mountSnapshots);
    const validateOpaqueContent = input.dryRun === true || input.preview === true;
    const files: SnapshotEntry[] = [];
    for (const entry of rawFiles) {
      const rawRelativePath = normalizeWorkspaceRelativePath(
        entry.path || entry.relativePath || entry.filePath || entry.name || "",
        { allowEmpty: false }
      );
      const relativePath = basePath && rawRelativePath !== basePath && !rawRelativePath.startsWith(`${basePath}/`)
        ? joinWorkspaceRelativePath(basePath, rawRelativePath)
        : rawRelativePath;
      if (path.posix.basename(relativePath).startsWith(".")) {
        throw new Error("不允许恢复以 . 开头的文件。");
      }
      const exists = entry.exists !== false && entry.deleted !== true && entry.tombstone !== true;
      if (!exists) {
        files.push({
          relativePath,
          exists: false,
          content: Buffer.alloc(0),
          contentSha256: "",
          byteLength: 0,
          encoding: String(entry.encoding || "base64")
        });
        continue;
      }
      const contentHandle = entry.contentHandle as ContentHandle | undefined;
      const hasContentHandle = contentHandle && typeof contentHandle.read === "function";
      let verified: { content?: Buffer; contentSha256: string; byteLength: number };
      if (hasContentHandle && !validateOpaqueContent) {
        const byteLength = Number(entry.byteLength ?? entry.sizeBytes);
        const contentSha256 = normalizeSha256(
          entry.contentSha256 || entry.sha256 || entry.expectedSha256 || ""
        );
        if (
          !Number.isSafeInteger(byteLength) ||
          byteLength < 0 ||
          !contentSha256 ||
          (
            contentHandle.byteLength !== undefined &&
            Number(contentHandle.byteLength) !== byteLength
          ) ||
          (
            contentHandle.contentSha256 !== undefined &&
            normalizeSha256(contentHandle.contentSha256) !== contentSha256
          )
        ) {
          throw new Error("Workspace snapshot content handle metadata is invalid.");
        }
        assertWorkspaceFileContentPolicy({
          relativePath,
          contentBuffer: Buffer.alloc(0),
          sizeBytes: byteLength
        });
        verified = { contentSha256, byteLength };
      } else {
        verified = await readWorkspaceSnapshotEntryContent(entry);
        assertWorkspaceFileContentPolicy({
          relativePath,
          contentBuffer: verified.content,
          sizeBytes: verified.byteLength
        });
      }
      files.push({
        relativePath,
        exists: true,
        ...(hasContentHandle
          ? { contentHandle }
          : { content: verified.content }),
        contentSha256: verified.contentSha256,
        byteLength: verified.byteLength,
        encoding: String(entry.encoding || "base64")
      });
    }
    return {
      basePath,
      stateRoot: String(snapshot.stateRoot || snapshot.workspaceRevision || ""),
      stateEventAnchor: asObject(snapshot.stateEventAnchor),
      deleteExtraneous: snapshot.deleteExtraneous === true || input.deleteExtraneous === true,
      localDirectorySnapshots,
      files
    };
  }

  async function restoreWorkspaceFiles(input: SyncInput = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let snapshot: WorkspaceSnapshot;
    try {
      snapshot = await normalizeWorkspaceFileSnapshot(input);
    } catch (error: unknown) {
      return { ok: false, status: 400, error: syncErrorMessage(error) };
    }
    const dryRun = input.dryRun === true || input.preview === true;
    let mutationOrigin: SyncRecord | null;
    try {
      mutationOrigin = sandboxMutationOrigin(input, {
        requireApproval: !dryRun
      });
    } catch (error: unknown) {
      const syncError = error as SyncError;
      return { ok: false, status: Number(syncError.status || 409), error: syncErrorMessage(error), code: syncError.code };
    }
    const requestedBy = String(input.createdBy || input.actorUserId || input.agentId || "").trim();
    if (
      snapshot.localDirectorySnapshots.length > 0 &&
      (typeof restoreLocalDirectoryPreimage !== "function" || typeof rollbackLocalDirectoryMutation !== "function")
    ) {
      return { ok: false, status: 503, error: "本机目录 checkpoint 恢复接口不可用。" };
    }
    const restoreDirectory = restoreLocalDirectoryPreimage;
    const rollbackDirectory = rollbackLocalDirectoryMutation;
    const desiredByPath = new Map(snapshot.files.map((entry) => [entry.relativePath, entry]));
    const existing = await listWorkspaceFiles({
      ...input,
      workspaceId: access.workspace.workspaceId,
      path: snapshot.basePath,
      folderPath: snapshot.basePath,
      recursive: true,
      includeDirectories: false,
      includeFiles: true,
      includeHash: true,
      limit: input.limit || 5000,
    });
    if (!existing.ok) {
      return existing;
    }
    const existingByPath = new Map(existing.files.map((file) => [file.relativePath, file]));
    const sandboxActions: RestoreAction[] = [];
    for (const entry of snapshot.files) {
      const current = existingByPath.get(entry.relativePath);
      if (!entry.exists) {
        sandboxActions.push({
          action: current ? "delete" : "noop",
          scope: "workspace",
          path: entry.relativePath,
          currentSha256: current?.contentSha256 || ""
        });
        continue;
      }
      const action: SyncActionKind = !current
        ? "create"
        : current.contentSha256 === entry.contentSha256
          ? "noop"
          : "write";
      sandboxActions.push({
        action,
        scope: "workspace",
        path: entry.relativePath,
        expectedSha256: entry.contentSha256,
        currentSha256: current?.contentSha256 || ""
      });
    }
    if (snapshot.deleteExtraneous) {
      for (const current of existing.files) {
        if (!desiredByPath.has(current.relativePath)) {
          sandboxActions.push({
            action: "delete",
            scope: "workspace",
            path: current.relativePath,
            currentSha256: current.contentSha256 || "",
            extraneous: true
          });
        }
      }
    }
    const localPlans: LocalRestoreResult[] = [];
    try {
      for (const localSnapshot of snapshot.localDirectorySnapshots) {
        if (String(localSnapshot.workspaceId || access.workspace.workspaceId) !== access.workspace.workspaceId) {
          return { ok: false, status: 403, error: "本机目录 checkpoint 不属于当前工作空间。" };
        }
        localPlans.push(await restoreDirectory!({
          workspace: access.workspace,
          snapshot: localSnapshot,
          dryRun: true
        }));
      }
    } catch (error: unknown) {
      const syncError = error as SyncError;
      return {
        ok: false,
        status: Math.max(400, Number(syncError.status || 400) || 400),
        error: String(syncError.code || "").startsWith("local_directory_")
          ? syncErrorMessage(error)
          : "本机目录 checkpoint 预览失败。"
      };
    }
    const actions: RestoreAction[] = [
      ...sandboxActions,
      ...localPlans.flatMap((plan) => plan.actions || [])
    ];
    if (dryRun) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        dryRun: true,
        stateCommit: null,
        checkpoint: null,
        basePath: snapshot.basePath,
        deleteExtraneous: snapshot.deleteExtraneous,
        fileCount: snapshot.files.length,
        localDirectorySnapshotCount: snapshot.localDirectorySnapshots.length,
        actions,
        appliedActions: [],
        summary: {
          create: actions.filter((action) => action.action === "create").length,
          write: actions.filter((action) => action.action === "write" || action.action === "replace").length,
          delete: actions.filter((action) => action.action === "delete").length,
          noop: actions.filter((action) => action.action === "noop").length,
          applied: 0
        },
        ...(mutationOrigin ? { mutationOrigin } : {})
      };
    }

    const sandboxApplied: RestoreAction[] = [];
    const sandboxPreimages = new Map<string, RestorePreimage>();
    const localApplied: LocalRestoreResult[] = [];
    let stateCommit: SyncRecord | null = null;
    const restoreStartState = await merkleState?.stateCommit?.begin({ scope: fileStateApi.workspaceStateScope(access.workspace) });
    const restoreStartEvents = await merkleState?.eventLog?.listEvents(fileStateApi.workspaceStateScope(access.workspace), { limit: 1 }) || [];
    try {
      const stateRootAllowedOperationIds = asArray(input.stateRootAllowedOperationIds).map(String).filter(Boolean);
      if (snapshot.stateRoot && stateRootAllowedOperationIds.length > 0) {
        await input.leaseGuard?.();
        await merkleState?.stateCommit?.verifyRestoreLineage?.({
          scope: fileStateApi.workspaceStateScope(access.workspace),
          targetRoot: snapshot.stateRoot,
          allowedOperationIds: stateRootAllowedOperationIds,
          anchor: snapshot.stateEventAnchor
        });
        await input.leaseGuard?.();
      }
      for (const localSnapshot of snapshot.localDirectorySnapshots) {
        localApplied.push(await restoreDirectory!({
          workspace: access.workspace,
          snapshot: localSnapshot,
          dryRun: false
        }));
      }
      for (const action of sandboxActions) {
        await input.leaseGuard?.();
        const entry = desiredByPath.get(action.path);
        if (action.action === "noop") {
          if (entry?.contentHandle && typeof entry.contentHandle.read === "function") {
            const verified = await readWorkspaceSnapshotEntryContent(entry);
            assertWorkspaceFileContentPolicy({
              relativePath: action.path,
              contentBuffer: verified.content,
              sizeBytes: verified.byteLength
            });
          }
          await input.leaseGuard?.();
          continue;
        }
        const resolved = resolveWorkspacePath(access.workspace, action.path);
        if (!sandboxPreimages.has(action.path)) {
          try {
            const handle = await fsPromises.open(resolved.absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
              const stat = await handle.stat();
              if (!stat.isFile()) throw new Error("Workspace restore target is not a regular file.");
              if (!merkleState?.cas?.putBlock) {
                const error: SyncError = new Error("Workspace restore preimage authority is unavailable.");
                error.code = "workspace_restore_preimage_unavailable";
                error.status = 503;
                throw error;
              }
              const content = await handle.readFile();
              const block = await merkleState.cas.putBlock(content, {
                codec: "raw",
                metadata: {
                  workspaceId: access.workspace.workspaceId,
                  relativePath: action.path,
                  preimage: true
                }
              });
              sandboxPreimages.set(action.path, {
                exists: true,
                contentCid: block.cid,
                contentSha256: normalizeSha256(block.payloadHash),
                byteLength: block.byteLength
              });
            } finally {
              await handle.close();
            }
          } catch (preimageError: unknown) {
            if ((preimageError as NodeJS.ErrnoException).code !== "ENOENT") throw preimageError;
            sandboxPreimages.set(action.path, { exists: false, content: null });
          }
        }
        if (action.action === "delete") {
          await fsPromises.rm(resolved.absolutePath, { recursive: true, force: true });
          sandboxApplied.push(action);
          await input.leaseGuard?.();
          continue;
        }
        const verified = await readWorkspaceSnapshotEntryContent(entry);
        assertWorkspaceFileContentPolicy({
          relativePath: action.path,
          contentBuffer: verified.content,
          sizeBytes: verified.byteLength
        });
        await fsPromises.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
        await fsPromises.writeFile(resolved.absolutePath, verified.content);
        stripExecutableMode(resolved.absolutePath);
        sandboxApplied.push(action);
        await input.leaseGuard?.();
      }
      const localAppliedActions = localApplied.flatMap((result) => result.appliedActions || []);
      const applied: RestoreAction[] = [...sandboxApplied, ...localAppliedActions];
      if (applied.length > 0) {
        updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
      }
      try {
        getRuntimeLogger().info("agent_workspace.files.restore.completed", {
          workspaceId: access.workspace.workspaceId,
          fileCount: snapshot.files.length,
          localDirectorySnapshotCount: snapshot.localDirectorySnapshots.length,
          appliedCount: applied.length,
          dryRun,
          requestedBy
        });
      } catch {
        // Logging must not turn a completed restore into a failed operation.
      }
      const commitMutations: SyncRecord[] = localApplied.flatMap((result) => result.stateMutations || []);
      const commitRefs: unknown[] = localApplied.flatMap((result) => result.contentRefs || []);
      const workspacePreimageFiles: SyncRecord[] = [];
      for (const [relativePath, preimage] of sandboxPreimages) {
        if (!preimage?.exists) {
          workspacePreimageFiles.push({ path: relativePath, exists: false });
          continue;
        }
        workspacePreimageFiles.push({
          path: relativePath,
          exists: true,
          contentCid: preimage.contentCid,
          contentSha256: preimage.contentSha256,
          byteLength: preimage.byteLength,
          encoding: "base64"
        });
        commitRefs.push(preimage.contentCid);
      }
      for (const action of sandboxApplied) {
        if (action.action === "delete") {
          commitMutations.push({
            action: "delete",
            key: action.path
          });
          continue;
        }
        const archived = await archiveWorkspacePath(access.workspace, action.path, {
          operationId: input.operationId || "workspace.checkpoint.restore",
          contentBuffer: desiredByPath.get(action.path)?.content
        });
        await input.leaseGuard?.();
        if (archived) {
          commitMutations.push({
            action: "put",
            key: action.path,
            valueRef: archived.rootCid,
            metadata: archived.metadata
          });
          commitRefs.push(...(archived.contentRefs || []));
        }
      }
      stateCommit = applied.length > 0 || mutationOrigin
        ? await commitWorkspaceFileState({
          workspace: access.workspace,
          operationId: input.operationId || "workspace.checkpoint.restore",
          mutations: commitMutations,
          contentRefs: commitRefs,
          payload: {
            action: "files.restore",
            basePath: snapshot.basePath,
            appliedCount: applied.length,
            localDirectorySnapshotCount: snapshot.localDirectorySnapshots.length,
            reason: input.reason || "",
            ...(mutationOrigin ? { mutationOrigin } : {})
          }
        })
        : null;
      const currentState = snapshot.stateRoot && stateRootAllowedOperationIds.length > 0
        ? await merkleState?.stateCommit?.begin?.({ scope: fileStateApi.workspaceStateScope(access.workspace) })
        : null;
      if (snapshot.stateRoot && stateRootAllowedOperationIds.length > 0 && currentState && currentState.currentRoot !== snapshot.stateRoot && typeof merkleState?.stateCommit?.restoreRoot === "function") {
        await input.leaseGuard?.();
        stateCommit = await merkleState.stateCommit.restoreRoot({
          scope: fileStateApi.workspaceStateScope(access.workspace),
          targetRoot: snapshot.stateRoot,
          expectedCurrentRoot: currentState.currentRoot,
          allowedOperationIds: stateRootAllowedOperationIds,
          anchor: snapshot.stateEventAnchor,
          operationId: `${input.operationId || "workspace.checkpoint.restore"}.state-root`,
          contentRefs: commitRefs,
          payload: {
            action: "files.restore.state-root",
            workspaceId: access.workspace.workspaceId,
            appliedCount: applied.length
          }
        });
        await input.leaseGuard?.();
      }
      if (applied.length > 0 && !stateCommit?.commitId) {
        const error: SyncError = new Error("checkpoint restore 状态提交不可用。");
        error.code = "local_directory_state_commit_unavailable";
        error.status = 503;
        throw error;
      }
      const restorePreimageSnapshot: SyncRecord | null = workspacePreimageFiles.length > 0 || localApplied.length > 0 || mutationOrigin
        ? {
            schemaVersion: "v0.0.1:workspace:file-restore-snapshot-1",
            workspaceId: access.workspace.workspaceId,
            basePath: "",
            deleteExtraneous: false,
            files: workspacePreimageFiles,
            localDirectorySnapshots: localApplied.map((result) => result.rollbackSnapshot)
          }
        : null;
      const checkpoint = stateCommit
        ? await recordWorkspaceFileCheckpoint({
          workspace: access.workspace,
          operationId: input.operationId || "workspace.checkpoint.restore",
          stateCommit,
          action: "files.restore",
          path: snapshot.basePath,
          preimageSnapshot: restorePreimageSnapshot,
          mutations: commitMutations,
          mutationOrigin
        })
        : null;
      if (stateCommit && localApplied.length > 0 && !checkpoint?.nodeId) {
        const error: SyncError = new Error("checkpoint restore 节点提交不可用。");
        error.code = "local_directory_checkpoint_unavailable";
        error.status = 503;
        throw error;
      }
      const mutationReceipt = sandboxMutationReceipt({
        mutationOrigin,
        preimage: restorePreimageSnapshot,
        stateCommit,
        checkpoint
      });
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        dryRun: false,
        stateCommit,
        checkpoint,
        basePath: snapshot.basePath,
        deleteExtraneous: snapshot.deleteExtraneous,
        fileCount: snapshot.files.length,
        localDirectorySnapshotCount: snapshot.localDirectorySnapshots.length,
        actions,
        appliedActions: applied,
        ...(mutationReceipt ? { mutationReceipt } : {}),
        summary: {
          create: actions.filter((action) => action.action === "create").length,
          write: actions.filter((action) => action.action === "write" || action.action === "replace").length,
          delete: actions.filter((action) => action.action === "delete").length,
          noop: actions.filter((action) => action.action === "noop").length,
          applied: applied.length
        },
        ...(mutationOrigin ? { mutationOrigin } : {})
      };
    } catch (error: unknown) {
      let rollbackFailed = false;
      const compensationMutations: SyncRecord[] = [];
      const compensationRefs: unknown[] = [];
      for (const action of [...sandboxApplied].reverse()) {
        try {
          await input.leaseGuard?.();
          const resolved = resolveWorkspacePath(access.workspace, action.path);
          const preimage = sandboxPreimages.get(action.path);
          if (preimage?.exists) {
            const block = preimage.contentCid
              ? await merkleState?.cas?.getBlock(preimage.contentCid)
              : null;
            if (
              !block ||
              !Buffer.isBuffer(block.bytes) ||
              block.bytes.length !== preimage.byteLength ||
              sha256Buffer(block.bytes) !== preimage.contentSha256
            ) {
              throw new Error("Workspace restore preimage content is unavailable.");
            }
            await fsPromises.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
            await fsPromises.writeFile(resolved.absolutePath, block.bytes);
            stripExecutableMode(resolved.absolutePath);
          } else {
            await fsPromises.rm(resolved.absolutePath, { recursive: true, force: true });
          }
          await input.leaseGuard?.();
        } catch {
          rollbackFailed = true;
        }
      }
      for (const result of [...localApplied].reverse()) {
        try {
          const projection = await rollbackDirectory!({
            workspace: access.workspace,
            snapshot: result.rollbackSnapshot
          });
          compensationMutations.push(...(projection.mutations || []));
          compensationRefs.push(...(projection.contentRefs || []));
        } catch {
          rollbackFailed = true;
        }
      }
      if (!rollbackFailed && stateCommit?.commitId && compensationMutations.length > 0) {
        try {
          const compensation = await commitWorkspaceFileState({
            workspace: access.workspace,
            operationId: `${input.operationId || "workspace.checkpoint.restore"}.rollback`,
            mutations: compensationMutations,
            contentRefs: compensationRefs,
            payload: {
              action: "files.restore.rollback",
              failedCommitId: stateCommit.commitId,
              localDirectorySnapshotCount: localApplied.length
            }
          });
          if (!compensation?.commitId) {
            rollbackFailed = true;
          }
        } catch {
          rollbackFailed = true;
        }
      }
      if (!rollbackFailed && restoreStartState?.currentRoot && typeof merkleState?.stateCommit?.restoreRoot === "function") {
        try {
          const current = await merkleState.stateCommit.begin({ scope: fileStateApi.workspaceStateScope(access.workspace) });
          if (current.currentRoot !== restoreStartState.currentRoot) {
            await merkleState.stateCommit.restoreRoot({
              scope: fileStateApi.workspaceStateScope(access.workspace),
              targetRoot: restoreStartState.currentRoot,
              expectedCurrentRoot: current.currentRoot,
              allowedOperationIds: [input.operationId || "workspace.checkpoint.restore"],
              anchor: restoreStartEvents[0] ? { offset: restoreStartEvents[0].offset, eventHash: restoreStartEvents[0].eventHash } : null,
              operationId: `${input.operationId || "workspace.checkpoint.restore"}.compensation`,
              payload: {
                action: "files.restore.compensation",
                ...(stateCommit?.commitId ? { failedCommitId: stateCommit.commitId } : {})
              }
            });
          }
        } catch {
          rollbackFailed = true;
        }
      }
      const failure = syncErrorDetails(error);
      return {
        ok: false,
        compensated: !rollbackFailed,
        status: rollbackFailed ? 500 : Math.max(400, failure.status || 500),
        code: rollbackFailed ? "workspace_restore_compensation_failed" : failure.code || "workspace_restore_failed",
        error: rollbackFailed
          ? "本机目录 checkpoint 恢复失败，且无法恢复 apply 前状态。"
          : "本机目录 checkpoint 恢复未完成，已恢复 apply 前状态。"
      };
    }
  }


  return {
    scanDirectoryForWorkspaceSync,
    scanWorkspaceFilesForSync,
    localDirectorySyncPlan,
    applyLocalDirectorySync,
    decodeWorkspaceSnapshotContent,
    normalizeWorkspaceFileSnapshot,
    restoreWorkspaceFiles
  };
}
