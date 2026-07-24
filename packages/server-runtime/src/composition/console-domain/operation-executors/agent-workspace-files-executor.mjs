
import {
  actorFrom,
  inputBoolean,
  parseBooleanFlag,
  requireAgentWorkspaceMethod,
  result,
  workspaceAccessOptions,
  workspaceIdFrom
} from "./shared.mjs";
import {
  isManagedWorkspaceAssetWriteOperation,
  normalizeWorkspaceAssetTarget,
  workspaceAssetSemanticFromOperation
} from "./workspace-asset-model.mjs";
import { runManagedWorkspaceAssetWrite } from "./workspace-asset-governance.mjs";

export async function executeAgentWorkspaceFileOperation({ operationId, input, context }) {
  const id = String(operationId || "");
  const handledOperations = new Set([
    "agent_workspaces.folder.create",
    "agent_workspaces.files.list",
    "agent_workspaces.file.stat",
    "agent_workspaces.file.download",
    "agent_workspaces.file.upload",
    "agent_workspaces.file.write",
    "agent_workspaces.file.delete",
    "agent_workspaces.file.move",
    "workspace.file.upload",
    "workspace.file.list",
    "workspace.file.download",
    "workspace.file.read",
    "workspace.file.write",
    "workspace.file.patch"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }
  if (isManagedWorkspaceAssetWriteOperation(id) && context.workspaceAssetManagedWriteActive !== true) {
    const target = normalizeWorkspaceAssetTarget(input, id);
    return runManagedWorkspaceAssetWrite({
      operationId: id,
      input,
      context,
      target,
      semantic: workspaceAssetSemanticFromOperation(id),
      downstreamOperationId: id,
      routeMode: "managed_workspace_asset_write",
      run: () => executeAgentWorkspaceFileOperation({
        operationId: id,
        input,
        context: {
          ...context,
          workspaceAssetManagedWriteActive: true
        }
      })
    });
  }
  const agentWorkspace = context.agentWorkspace;
  const workspaceId = workspaceIdFrom(input);
  const access = workspaceAccessOptions(context.authSession);
  const actorId = context.authSession?.user?.username || context.authSession?.user?.userId || "";
  if (id === "agent_workspaces.folder.create") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "createWorkspaceFolder", "工作空间文件夹接口不可用。");
    if (error) return error;
    const operationResult = await method({
      workspaceId,
      ...input,
      operationId: id,
      ...access
    });
    return result(operationResult.ok ? 201 : operationResult.status || 400, operationResult);
  }
  if (id === "agent_workspaces.files.list" || id === "workspace.file.list") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "listWorkspaceFiles", "工作空间文件列表接口不可用。");
    if (error) return error;
    const operationResult = await method({
      workspaceId,
      path: input.path || "",
      folderPath: input.folderPath || input["folder-path"] || "",
      recursive: inputBoolean(input, ["recursive"], true),
      includeDirectories: inputBoolean(input, ["includeDirectories", "include-directories"], true),
      includeFiles: inputBoolean(input, ["includeFiles", "include-files"], true),
      limit: Number(input.limit || 500),
      operationId: id,
      ...access
    });
    return result(operationResult.ok ? 200 : operationResult.status || 400, operationResult);
  }
  if (id === "agent_workspaces.file.stat") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "workspaceFileMetadata", "工作空间文件查询接口不可用。");
    if (error) return error;
    const operationResult = await method({
      workspaceId,
      path: input.path || input.filePath || input["file-path"] || "",
      includeHash: !["0", "false", "no"].includes(String(input.includeHash ?? input["include-hash"] ?? "true").toLowerCase()),
      ...access
    });
    return result(operationResult.ok ? 200 : operationResult.status || 400, operationResult);
  }
  if (id === "agent_workspaces.file.download" || id === "workspace.file.download" || id === "workspace.file.read") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "downloadWorkspaceFile", "工作空间文件下载接口不可用。");
    if (error) return error;
    const operationResult = await method({
      workspaceId,
      path: input.path || input.filePath || input["file-path"] || "",
      includeText: inputBoolean(input, ["includeText", "include-text"], true),
      encoding: input.encoding || "utf8",
      operationId: id,
      ...access
    });
    return result(operationResult.ok ? 200 : operationResult.status || 400, operationResult);
  }
  if (id === "agent_workspaces.file.upload" || id === "workspace.file.upload") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "uploadWorkspaceFile", "工作空间存储接口不可用。");
    if (error) return error;
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return result(400, { error: "请求体必须是 JSON 对象。" });
    }
    const operationResult = await method({
      workspaceId,
      ...input,
      operationId: id,
      createdBy: actorId || input.createdBy || "",
      ...access
    });
    return result(operationResult.ok ? 201 : operationResult.status || 400, operationResult);
  }
  if (id === "agent_workspaces.file.write" || id === "workspace.file.write") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "writeWorkspaceFile", "工作空间存储接口不可用。");
    if (error) return error;
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return result(400, { error: "请求体必须是 JSON 对象。" });
    }
    const operationResult = await method({
      workspaceId,
      ...input,
      operationId: id,
      createdBy: actorId || input.createdBy || "",
      ...access
    });
    return result(operationResult.ok ? 200 : operationResult.status || 400, operationResult);
  }
  if (id === "workspace.file.patch") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "patchWorkspaceFile", "工作空间补丁接口不可用。");
    if (error) return error;
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return result(400, { error: "请求体必须是 JSON 对象。" });
    }
    const operationResult = await method({
      workspaceId,
      ...input,
      operationId: id,
      createdBy: actorId || input.createdBy || "",
      ...access
    });
    return result(operationResult.ok ? 200 : operationResult.status || 400, operationResult);
  }
  if (id === "agent_workspaces.file.delete") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "deleteWorkspaceFile", "工作空间存储接口不可用。");
    if (error) return error;
    const operationResult = await method({
      workspaceId,
      path: input.path || input.filePath || input["file-path"] || "",
      operationId: id,
      recursive: inputBoolean(input, ["recursive"], false),
      ...access
    });
    return result(operationResult.ok ? 200 : operationResult.status || 400, operationResult);
  }
  if (id === "agent_workspaces.file.move") {
    const { method, error } = requireAgentWorkspaceMethod(
      agentWorkspace,
      "moveWorkspaceFile",
      "工作空间存储接口不可用。"
    );
    if (error) return error;
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return result(400, { error: "请求体必须是 JSON 对象。" });
    }
    const operationResult = await method({
      workspaceId,
      ...input,
      operationId: id,
      createdBy: actorId || input.createdBy || "",
      ...access
    });
    return result(operationResult.ok ? 200 : operationResult.status || 400, operationResult);
  }
  return null;
}
