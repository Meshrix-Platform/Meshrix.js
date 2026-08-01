import fs from "node:fs";
import path from "node:path";
import {
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  boundedInteger,
  fileMetadataFromStat,
  normalizeWorkspaceRelativePath,
  nowIso,
  sha256Buffer
} from "./agent-workspace-support.ts";

export function createAgentWorkspaceFileReadApi({
  workspaceForStorage,
  resolveWorkspacePath,
  createAccessReceipt,
  updateWorkspaceTimeStmt,
  fileStateApi,
  ensurePrivateWorkspaceDirectory
}: Record<string, any> = {}) : any {
  const {
    archiveWorkspacePath,
    workspaceDownloadCacheReceipt,
    workspaceListCacheReceipt,
    commitWorkspaceFileState,
    recordWorkspaceFileCheckpoint
  } = fileStateApi;
  async function createWorkspaceFolder(input: Record<string, any> = {}) : Promise<any> {
    const access: any = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let resolved: any;
    try {
      const folderPath: any = normalizeWorkspaceRelativePath(
        input.folderPath || input.folder || input.directory || input.path || input.relativePath || "",
        { allowEmpty: false }
      );
      resolved = resolveWorkspacePath(access.workspace, folderPath);
    } catch (error: any) {
      return { ok: false, status: 400, error: error.message };
    }
    if (typeof ensurePrivateWorkspaceDirectory !== "function") {
      throw new TypeError(
        "Agent workspace private directory authority is required."
      );
    }
    try {
      ensurePrivateWorkspaceDirectory(resolved.absolutePath);
    } catch (error: any) {
      return {
        ok: false,
        status: Number(error?.status || 409),
        error: error?.message || "Workspace directory is unsafe."
      };
    }
    updateWorkspaceTimeStmt.run(nowIso(), access.workspace.workspaceId);
    const archived: any = await archiveWorkspacePath(access.workspace, resolved.relativePath, {
      operationId: input.operationId || "agent_workspaces.folder.create"
    });
    const stateCommit: any = await commitWorkspaceFileState({
      workspace: access.workspace,
      operationId: input.operationId || "agent_workspaces.folder.create",
      mutations: archived
        ? [{
            action: "put",
            key: resolved.relativePath,
            valueRef: archived.rootCid,
            metadata: archived.metadata
          }]
        : [],
      contentRefs: archived?.contentRefs || [],
      payload: {
        action: "folder.create",
        path: resolved.relativePath
      }
    });
    const checkpoint: any = await recordWorkspaceFileCheckpoint({
      workspace: access.workspace,
      operationId: input.operationId || "agent_workspaces.folder.create",
      stateCommit,
      action: "folder.create",
      path: resolved.relativePath
    });
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      stateCommit,
      checkpoint,
      folder: fileMetadataFromStat({
        workspaceId: access.workspace.workspaceId,
        relativePath: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        stat: fs.statSync(resolved.absolutePath)
      })
    };
  }

  async function listWorkspaceFiles(input: Record<string, any> = {}) : Promise<any> {
    const access: any = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let base: any;
    try {
      base = resolveWorkspacePath(
        access.workspace,
        input.folderPath || input.folder || input.directory || input.path || input.relativePath || "",
        { allowEmpty: true }
      );
    } catch (error: any) {
      return { ok: false, status: 400, error: error.message };
    }
    if (!fs.existsSync(base.absolutePath)) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        basePath: base.relativePath,
        exists: false,
        cacheReceipt: await workspaceListCacheReceipt(access.workspace, base.relativePath),
        accessReceipt: createAccessReceipt({
          workspaceId: access.workspace.workspaceId,
          operationId: input.operationId || "agent_workspaces.files.list",
          path: base.relativePath || "/",
          action: "workspace.list"
        }),
        paths: [],
        files: []
      };
    }
    const includeDirectories: any = input.includeDirectories !== false;
    const includeFiles: any = input.includeFiles !== false;
    const includeHash: any = input.includeHash === true;
    const recursive: any = input.recursive !== false;
    const limit: any = boundedInteger(input.limit, 500, 1, 5000);
    const files: any[] = [];
    const visit: any = (absoluteDir?: any, relativeDir?: any) : any => {
      if (files.length >= limit) {
        return;
      }
      const entries: any = fs.readdirSync(absoluteDir, { withFileTypes: true })
        .filter((entry?: any) : any => !entry.name.startsWith("."))
        .sort((left?: any, right?: any) : any => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files.length >= limit) {
          return;
        }
        const relativePath: any = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const absolutePath: any = path.join(absoluteDir, entry.name);
        const stat: any = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink()) {
          throw new Error(`工作空间内存在不允许访问的符号链接：${relativePath}`);
        }
        if (!stat.isDirectory() && !stat.isFile()) {
          throw new Error(`工作空间内存在不支持的特殊文件：${relativePath}`);
        }
        if ((stat.isDirectory() && includeDirectories) || (stat.isFile() && includeFiles)) {
          files.push(fileMetadataFromStat({
            workspaceId: access.workspace.workspaceId,
            relativePath,
            absolutePath,
            stat,
            includeHash
          }));
        }
        if (stat.isDirectory() && recursive) {
          visit(absolutePath, relativePath);
        }
      }
    };
    try {
      const baseStat: any = fs.lstatSync(base.absolutePath);
      if (baseStat.isSymbolicLink()) {
        return { ok: false, status: 400, error: "不允许访问符号链接。" };
      }
      if (!baseStat.isDirectory() && !baseStat.isFile()) {
        return { ok: false, status: 400, error: "不支持访问特殊文件。" };
      }
      if (baseStat.isDirectory()) {
        visit(base.absolutePath, base.relativePath);
      } else if (includeFiles) {
        files.push(fileMetadataFromStat({
          workspaceId: access.workspace.workspaceId,
          relativePath: base.relativePath,
          absolutePath: base.absolutePath,
          stat: baseStat,
          includeHash
        }));
      }
    } catch (error: any) {
      return { ok: false, status: 400, error: error.message };
    }
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      basePath: base.relativePath,
      exists: true,
      cacheReceipt: await workspaceListCacheReceipt(access.workspace, base.relativePath),
      accessReceipt: createAccessReceipt({
        workspaceId: access.workspace.workspaceId,
        operationId: input.operationId || "agent_workspaces.files.list",
        path: base.relativePath || "/",
        action: "workspace.list"
      }),
      paths: files.map((file?: any) : any => file.relativePath),
      files,
      count: files.length
    };
  }

  async function workspaceFileMetadata(input: Record<string, any> = {}) : Promise<any> {
    const access: any = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let resolved: any;
    try {
      resolved = resolveWorkspacePath(
        access.workspace,
        input.path || input.relativePath || input.filePath || input.file || "",
        { allowEmpty: false }
      );
    } catch (error: any) {
      return { ok: false, status: 400, error: error.message };
    }
    if (!fs.existsSync(resolved.absolutePath)) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        workspaceId: access.workspace.workspaceId,
        exists: false,
        cacheReceipt: await workspaceDownloadCacheReceipt(access.workspace, resolved.relativePath),
        file: {
          workspaceId: access.workspace.workspaceId,
          relativePath: resolved.relativePath
        }
      };
    }
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      exists: true,
      cacheReceipt: await workspaceDownloadCacheReceipt(access.workspace, resolved.relativePath),
      file: fileMetadataFromStat({
        workspaceId: access.workspace.workspaceId,
        relativePath: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        stat: fs.lstatSync(resolved.absolutePath),
        includeHash: input.includeHash !== false
      })
    };
  }

  async function downloadWorkspaceFile(input: Record<string, any> = {}) : Promise<any> {
    const statResult: any = await workspaceFileMetadata(input);
    if (!statResult.ok || !statResult.exists) {
      return statResult.exists === false
        ? { ...statResult, ok: false, status: 404, error: "文件不存在。" }
        : statResult;
    }
    if (statResult.file.type !== "file") {
      return { ok: false, status: 400, error: "目标路径不是文件。" };
    }
    const access: any = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    const resolved: any = resolveWorkspacePath(access.workspace, statResult.file.relativePath);
    const content: any = fs.readFileSync(resolved.absolutePath);
    const cacheReceipt: any = await workspaceDownloadCacheReceipt(access.workspace, statResult.file.relativePath);
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      file: statResult.file,
      cacheReceipt,
      accessReceipt: createAccessReceipt({
        workspaceId: access.workspace.workspaceId,
        operationId: input.operationId || "workspace.file.read",
        path: statResult.file.relativePath,
        action: "workspace.read"
      }),
      encoding: "base64",
      contentBase64: content.toString("base64"),
      content: input.includeText === false ? undefined : content.toString(String(input.textEncoding || input.encoding || "utf8"))
    };
  }

  async function openWorkspaceFileReadStream(input: Record<string, any> = {}) : Promise<any> {
    const access: any = workspaceForStorage(input);
    if (!access.ok) {
      return access;
    }
    let resolved: any;
    try {
      resolved = resolveWorkspacePath(
        access.workspace,
        input.path || input.relativePath || input.filePath || "",
        { allowEmpty: false, requireExisting: true, allowDirectory: false }
      );
    } catch (error: any) {
      return error?.code === "ENOENT"
        ? { ok: false, status: 404, error: "文件不存在。" }
        : { ok: false, status: 400, error: error.message };
    }
    const stat: any = fs.lstatSync(resolved.absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { ok: false, status: 400, error: "目标路径不是文件。" };
    }
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      workspaceId: access.workspace.workspaceId,
      relativePath: resolved.relativePath,
      name: path.posix.basename(resolved.relativePath) || "artifact.bin",
      byteLength: Number(stat.size || 0),
      accessReceipt: createAccessReceipt({
        workspaceId: access.workspace.workspaceId,
        operationId: input.operationId || "workspace.file.read",
        path: resolved.relativePath,
        action: "workspace.read"
      }),
      open: ({ start, end }: Record<string, any> = {}) : any => fs.createReadStream(resolved.absolutePath, {
        ...(Number.isSafeInteger(start) ? { start } : {}),
        ...(Number.isSafeInteger(end) ? { end } : {})
      })
    };
  }


  return {
    createWorkspaceFolder,
    listWorkspaceFiles,
    workspaceFileMetadata,
    downloadWorkspaceFile,
    openWorkspaceFileReadStream
  };
}
