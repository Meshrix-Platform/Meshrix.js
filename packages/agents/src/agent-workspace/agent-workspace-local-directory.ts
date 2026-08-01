import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertPathWithinRootSync } from "@meshrix/foundation/security/local-path-boundary";
import {
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  asArray,
  boundedInteger,
  normalizeWorkspaceRelativePath,
  nowIso,
  sha256Buffer,
  stableHash,
  stableId
} from "./agent-workspace-support.ts";
import { createAgentWorkspaceLocalDirectorySupport } from "./agent-workspace-local-directory-support.ts";
import { createAgentWorkspaceLocalDirectoryMutations } from "./agent-workspace-local-directory-mutations.ts";
import { createAgentWorkspaceLocalDirectorySnapshotApi } from "./agent-workspace-local-directory-snapshot.ts";
import { readOrdinaryFileNoFollow } from "./agent-workspace-local-directory-safe-fs.ts";

export function createAgentWorkspaceLocalDirectoryApi({
  userDataPath,
  localDirectoryMountConfigPath,
  workspaceForStorage,
  createAccessReceipt,
  localDirectorySyncPlan,
  decodeWorkspaceFileContent,
  updateWorkspaceTimeStmt,
  merkleState = null,
  fileStateApi = null
}: Record<string, any> = {}) : any {
  const filePayloadMetadata: any = fileStateApi?.filePayloadMetadata || (() : any => ({}));
  const commitWorkspaceFileState: any = fileStateApi?.commitWorkspaceFileState || (() : any => null);
  const recordWorkspaceFileCheckpoint: any = fileStateApi?.recordWorkspaceFileCheckpoint || (() : any => null);

  const localDirectorySupport: any = createAgentWorkspaceLocalDirectorySupport({
    userDataPath,
    localDirectoryMountConfigPath,
    createAccessReceipt
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
    localDirectoryAccessReceipt
  } = localDirectorySupport;
  const mountSelections: any = new Map<any, any>();

  function pruneMountSelections(now: any = Date.now()) : any {
    for (const [selectionRef, selection] of mountSelections) {
      if (selection.expiresAt <= now) mountSelections.delete(selectionRef);
    }
    while (mountSelections.size >= 128) mountSelections.delete(mountSelections.keys().next().value);
  }

  function createLocalDirectoryMountSelection(input: Record<string, any> = {}) : any {
    const access: any = workspaceForStorage(input);
    if (!access.ok) return access;
    let root: any;
    try {
      root = validateLocalDirectoryRoot(input.sourcePath);
    } catch (error: any) {
      return { ok: false, status: 400, error: error.message };
    }
    pruneMountSelections();
    const mountSelectionRef: any = `local-directory-selection:${randomUUID().replaceAll("-", "")}`;
    mountSelections.set(mountSelectionRef, Object.freeze({
      workspaceId: access.workspace.workspaceId,
      sourcePath: root.realPath,
      expiresAt: Date.now() + 60_000
    }));
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      mountSelectionRef,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
  }
  const localDirectorySnapshotApi: any = createAgentWorkspaceLocalDirectorySnapshotApi({
    merkleState,
    resolveLocalDirectoryMountPath,
    mountMutationKey
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
    renamePathSafely
  } = localDirectorySnapshotApi;
  const localDirectoryMutations: any = createAgentWorkspaceLocalDirectoryMutations({
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
  });
  const {
    writeLocalDirectoryFile,
    createLocalDirectoryFolder,
    deleteLocalDirectoryItem,
    moveLocalDirectoryItem
  } = localDirectoryMutations;

  async function archiveLocalDirectoryContent(content?: any, metadata: Record<string, any> = {}) : Promise<any> {
    if (!merkleState?.cas?.putBlock) {
      return null;
    }
    const block: any = await merkleState.cas.putBlock(content, {
      codec: "raw",
      metadata
    });
    return {
      rootCid: block.cid,
      contentRefs: [block.cid],
      metadata: { contentSha256: block.payloadHash, sizeBytes: block.byteLength }
    };
  }

  /** Build mount-scoped mutation key to avoid collisions with sandbox files. */
  function mountMutationKey(mountRef?: any, relativePath?: any) : any {
    return `__mount__/${mountRef}/${relativePath}`;
  }

  function connectLocalDirectory(input: Record<string, any> = {}) : any {
    const access: any = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let targetPath: any;
    try {
      targetPath = normalizeWorkspaceRelativePath(input.targetPath || input.path || "", { allowEmpty: true });
    } catch (error: any) {
      return { ok: false, status: 400, error: error.message };
    }
    let root: any;
    const mountSelectionRef: any = String(input.mountSelectionRef || "").trim();
    try {
      if (mountSelectionRef) {
        pruneMountSelections();
        const selection: any = mountSelections.get(mountSelectionRef);
        mountSelections.delete(mountSelectionRef);
        if (!selection || selection.workspaceId !== access.workspace.workspaceId || selection.expiresAt <= Date.now()) {
          throw new Error("本机目录选择已失效或不属于当前工作空间。");
        }
        root = validateLocalDirectoryRoot(selection.sourcePath);
      } else {
        root = validateLocalDirectoryRoot(input.sourcePath || input.localPath || input.dirPath);
      }
    } catch (error: any) {
      return { ok: false, status: 400, error: error.message };
    }
    const validationPlan: any = localDirectorySyncPlan({
      ...input,
      workspaceId: access.workspace.workspaceId,
      sourcePath: root.realPath,
      targetPath,
      maxFiles: input.maxFiles || 2000
    }, { allowDirectSourcePath: true });
    if (!validationPlan.ok) {
      return validationPlan;
    }
    const timestamp: any = nowIso();
    const mountRef: any = String(input.mountRef || "").trim() ||
      stableId("local_dir_mount", access.workspace.workspaceId, root.realPath, targetPath);
    const mount: Record<string, any> = {
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
      connectedBy: String(input.createdBy || input.actorUserId || input.agentId || "")
    };
    const config: any = readLocalDirectoryMountConfig();
    const existingIndex: any = config.mounts.findIndex((item?: any) : any => String(item.mountRef || "") === mountRef);
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
        targetFileCount: validationPlan.targetFileCount
      }
    };
  }

  function listLocalDirectoryMounts(input: Record<string, any> = {}) : any {
    const access: any = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    const config: any = readLocalDirectoryMountConfig();
    const mounts: any = config.mounts
      .filter((item?: any) : any => String(item.workspaceId || "") === access.workspace.workspaceId)
      .map((item?: any) : any => publicLocalDirectoryMount(item));
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      mounts,
      count: mounts.length
    };
  }

  function listLocalDirectoryItems(input: Record<string, any> = {}) : any {
    const access: any = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let source: any;
    try {
      source = resolveLocalDirectorySource(input, access.workspace);
    } catch (error: any) {
      return { ok: false, status: 400, error: error.message };
    }
    let basePath: any;
    try {
      basePath = normalizeWorkspaceRelativePath(input.path || input.relativePath || "", { allowEmpty: true });
    } catch (error: any) {
      return { ok: false, status: 400, error: error.message };
    }
    const root: any = source.sourcePath;
    let target: any = basePath ? path.resolve(root, ...basePath.split("/")) : root;
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      return { ok: false, status: 400, error: "路径不能跳出本机目录 mount。" };
    }
    try {
      target = assertPathWithinRootSync(root, target, {
        label: "本机目录路径",
        allowMissing: true,
        allowDirectory: true,
        allowFile: true,
        allowSpecial: false
      }).absolutePath;
    } catch (error: any) {
      return { ok: false, status: 400, error: error.message };
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
          action: "localDir.list"
        })
      };
    }
    const rootStat: any = fs.lstatSync(target);
    if (rootStat.isSymbolicLink()) {
      return { ok: false, status: 400, error: "不允许列出符号链接对象。" };
    }
    const includeDirectories: any = input.includeDirectories !== false;
    const includeFiles: any = input.includeFiles !== false;
    const includeHash: any = input.includeHash === true;
    const recursive: any = input.recursive === true;
    const limit: any = boundedInteger(input.limit, 200, 1, 2000);
    const items: any[] = [];
    const toItem: any = (absolutePath?: any, relativePath?: any, stat?: any) : any => ({
      name: path.basename(absolutePath),
      sourceRelativePath: relativePath,
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "special",
      state: "staged",
      archived: false,
      sizeBytes: Number(stat.size || 0),
      mtimeMs: Number(stat.mtimeMs || 0),
      contentSha256: includeHash && stat.isFile() ? sha256Buffer(fs.readFileSync(absolutePath)) : undefined
    });
    const visit: any = (absoluteDir?: any, relativeDir?: any) : any => {
      if (items.length >= limit) {
        return;
      }
      const entries: any = fs.readdirSync(absoluteDir, { withFileTypes: true })
        .sort((left?: any, right?: any) : any => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (items.length >= limit) {
          return;
        }
        if (entry.name.startsWith(".")) {
          throw new Error(`不允许列出以 . 开头的路径：${relativeDir ? `${relativeDir}/` : ""}${entry.name}`);
        }
        const childAbsolutePath: any = path.join(absoluteDir, entry.name);
        const childRelativePath: any = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const stat: any = fs.lstatSync(childAbsolutePath);
        if (stat.isSymbolicLink()) {
          throw new Error(`不允许列出符号链接：${childRelativePath}`);
        }
        if ((stat.isDirectory() && includeDirectories) || (stat.isFile() && includeFiles) || (!stat.isDirectory() && !stat.isFile())) {
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
    } catch (error: any) {
      return { ok: false, status: 400, error: error.message };
    }
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      mode: "localDir",
      mount: source.mount ? publicLocalDirectoryMount(source.mount) : null,
      basePath,
      exists: true,
      paths: items.map((item?: any) : any => item.sourceRelativePath),
      items,
      count: items.length,
      accessReceipt: createAccessReceipt({
        workspaceId: access.workspace.workspaceId,
        operationId: input.operationId || "agent_workspaces.files.list",
        path: basePath || "/",
        action: "localDir.list"
      })
    };
  }

  function localDirectoryItemMetadata(input: Record<string, any> = {}) : any {
    const access: any = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let resolved: any;
    try {
      resolved = resolveLocalDirectoryMountPath(input, access.workspace, {
        allowEmpty: true,
        allowMissing: true,
        allowDirectory: true,
        allowFile: true
      });
    } catch (error: any) {
      return { ok: false, status: 400, error: error.message };
    }
    const mountRef: any = String(resolved.mount?.mountRef || "");
    if (!resolved.exists) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        mode: "localDir",
        mount: resolved.mount ? publicLocalDirectoryMount(resolved.mount) : null,
        exists: false,
        item: {
          workspaceId: access.workspace.workspaceId,
          mountRef,
          relativePath: resolved.relativePath
        },
        accessReceipt: localDirectoryAccessReceipt({
          workspaceId: access.workspace.workspaceId,
          mountRef,
          operationId: input.operationId || "agent_workspaces.file.stat",
          path: resolved.relativePath || "/",
          action: "localDir.stat"
        })
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
        rootPath: resolved.root
      }),
      accessReceipt: localDirectoryAccessReceipt({
        workspaceId: access.workspace.workspaceId,
        mountRef,
        operationId: input.operationId || "agent_workspaces.file.stat",
        path: resolved.relativePath || "/",
        action: "localDir.stat"
      })
    };
  }

  function readLocalDirectoryFile(input: Record<string, any> = {}) : any {
    const access: any = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let resolved: any;
    try {
      resolved = resolveLocalDirectoryMountPath(input, access.workspace, {
        allowEmpty: false,
        allowMissing: false,
        requireExisting: true,
        allowDirectory: false,
        allowFile: true
      });
    } catch (error: any) {
      return { ok: false, status: error?.code === "ENOENT" ? 404 : 400, error: error.message };
    }
    let content: any;
    let stat: any;
    try {
      ({ content, stat } = readOrdinaryFileNoFollow(resolved.root, resolved.absolutePath));
    } catch (error: any) {
      return { ok: false, status: Number(error?.status || 400), error: error.message };
    }
    const mountRef: any = String(resolved.mount?.mountRef || "");
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
        contentBuffer: content
      }),
      accessReceipt: localDirectoryAccessReceipt({
        workspaceId: access.workspace.workspaceId,
        mountRef,
        operationId: input.operationId || "workspace.file.read",
        path: resolved.relativePath,
        action: "localDir.read"
      }),
      encoding: "base64",
      contentBase64: content.toString("base64"),
      content: input.includeText === false ? undefined : content.toString(String(input.textEncoding || input.encoding || "utf8"))
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
    restoreLocalDirectoryPreimage,
    rollbackLocalDirectoryMutation
  };
}
