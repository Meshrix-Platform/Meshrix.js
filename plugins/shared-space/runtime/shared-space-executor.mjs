import {
  hasLocalDirectoryMountInput,
  inputBoolean,
  requireAgentWorkspaceMethod,
  result,
  workspaceAccessOptions,
  workspaceIdFrom
} from "./operation-helpers.mjs";

export const SHARED_SPACE_OPERATION_IDS = Object.freeze([
  "sharedspace.localDir.connect",
  "sharedspace.localDir.list",
  "sharedspace.item.list",
  "sharedspace.item.stat",
  "sharedspace.file.read",
  "sharedspace.file.write",
  "sharedspace.directory.create",
  "sharedspace.item.delete",
  "sharedspace.item.move",
  "sharedspace.sync.plan",
  "sharedspace.sync.apply",
  "sharedspace.snapshot.create",
  "sharedspace.sandbox.input.seal",
  "sharedspace.sandbox.run",
  "sharedspace.sandbox.runOpaque",
  "sharedspace.sandbox.cancel",
  "sharedspace.sandbox.status",
  "sharedspace.output.preview",
  "sharedspace.output.approve",
  "sharedspace.output.commit",
  "sharedspace.output.reject"
]);
const SHARED_SPACE_OPERATION_ID_SET = new Set(SHARED_SPACE_OPERATION_IDS);

function requirePlainInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new TypeError("Request body must be a JSON object."), {
      code: "shared_space_invalid_request",
      status: 400
    });
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw Object.assign(new TypeError("Request body must be a JSON object."), {
      code: "shared_space_invalid_request",
      status: 400
    });
  }
  return input;
}

export async function executeSharedSpaceOperation({ operationId, input = {}, context = {} } = {}) {
  const id = String(operationId || "");
  if (!SHARED_SPACE_OPERATION_ID_SET.has(id)) return null;
  requirePlainInput(input);
  const agentWorkspace = context.agentWorkspace;
  const workspaceId = workspaceIdFrom(input);
  const request = Object.freeze({ ...input, workspaceId });
  const access = workspaceAccessOptions(context.authSession);
  const actorId = String(
    context.authSession?.user?.userId ||
    context.authSession?.user?.subjectId ||
    context.authSession?.user?.username ||
    ""
  ).trim();
  if (typeof context.executeSandboxOperation === "function" && (
    id === "sharedspace.snapshot.create" || id.startsWith("sharedspace.sandbox.") || id.startsWith("sharedspace.output.")
  )) {
    return context.executeSandboxOperation({ operationId: id, input: request, context });
  }
  const invoke = async (methodName, unavailableMessage, args, successStatus = 200) => {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, methodName, unavailableMessage);
    if (error) return error;
    const operationResult = await method(args);
    return result(operationResult.ok ? successStatus : operationResult.status || 400, operationResult);
  };

  if (id === "sharedspace.localDir.connect") {
    return invoke("connectLocalDirectory", "Controlled local-directory connection is unavailable.", {
      ...request, workspaceId, operationId: id, createdBy: actorId, ...access
    }, 201);
  }
  if (id === "sharedspace.localDir.list") {
    return invoke("listLocalDirectoryMounts", "Controlled local-directory listing is unavailable.", {
      ...request, workspaceId, operationId: id, ...access
    });
  }
  if (id === "sharedspace.item.list") {
    if (hasLocalDirectoryMountInput(request)) {
      return invoke("listLocalDirectoryItems", "Controlled local-directory item listing is unavailable.", {
        ...request,
        workspaceId,
        operationId: id,
        recursive: inputBoolean(request, ["recursive"], false),
        includeDirectories: inputBoolean(request, ["includeDirectories", "include-directories"], true),
        includeFiles: inputBoolean(request, ["includeFiles", "include-files"], true),
        includeHash: inputBoolean(request, ["includeHash", "include-hash"], false),
        limit: Number(request.limit || 200),
        ...access
      });
    }
    return invoke("listWorkspaceFiles", "Workspace file listing is unavailable.", {
      workspaceId,
      path: request.path || "",
      folderPath: request.folderPath || request["folder-path"] || "",
      recursive: inputBoolean(request, ["recursive"], true),
      includeDirectories: inputBoolean(request, ["includeDirectories", "include-directories"], true),
      includeFiles: inputBoolean(request, ["includeFiles", "include-files"], true),
      limit: Number(request.limit || 500),
      operationId: id,
      ...access
    });
  }
  if (id === "sharedspace.item.stat") {
    return invoke("localDirectoryItemMetadata", "Controlled local-directory item metadata is unavailable.", {
      ...request, workspaceId, operationId: id,
      includeHash: inputBoolean(request, ["includeHash", "include-hash"], true),
      ...access
    });
  }
  if (id === "sharedspace.file.read") {
    const common = {
      ...request,
      workspaceId,
      path: request.path || request.filePath || request["file-path"] || "",
      includeText: inputBoolean(request, ["includeText", "include-text"], true),
      encoding: request.encoding || "utf8",
      operationId: id,
      ...access
    };
    return hasLocalDirectoryMountInput(request)
      ? invoke("readLocalDirectoryFile", "Controlled local-directory file reading is unavailable.", common)
      : invoke("downloadWorkspaceFile", "Workspace file reading is unavailable.", common);
  }
  if (id === "sharedspace.file.write") {
    const common = { ...request, workspaceId, operationId: id, createdBy: actorId, ...access };
    return hasLocalDirectoryMountInput(request)
      ? invoke("writeLocalDirectoryFile", "Controlled local-directory file writing is unavailable.", common)
      : invoke("uploadWorkspaceFile", "Workspace file writing is unavailable.", common, 201);
  }
  if (id === "sharedspace.item.delete") {
    const common = {
      ...request,
      workspaceId,
      path: request.path || request.filePath || request["file-path"] || "",
      operationId: id,
      recursive: inputBoolean(request, ["recursive"], false),
      ...access
    };
    return hasLocalDirectoryMountInput(request)
      ? invoke("deleteLocalDirectoryItem", "Controlled local-directory item deletion is unavailable.", common)
      : invoke("deleteWorkspaceFile", "Workspace file deletion is unavailable.", common);
  }
  if (id === "sharedspace.directory.create") {
    return invoke("createLocalDirectoryFolder", "Controlled local-directory creation is unavailable.", {
      ...request, workspaceId, operationId: id, createdBy: actorId, ...access
    }, 201);
  }
  if (id === "sharedspace.item.move") {
    return invoke("moveLocalDirectoryItem", "Controlled local-directory item move is unavailable.", {
      ...request, workspaceId, operationId: id, createdBy: actorId, ...access
    });
  }
  if (id === "sharedspace.sync.plan") {
    return invoke("localDirectorySyncPlan", "Controlled local-directory synchronization planning is unavailable.", {
      ...request, workspaceId, operationId: id, ...access
    });
  }
  if (id === "sharedspace.sync.apply") {
    return invoke("applyLocalDirectorySync", "Controlled local-directory synchronization is unavailable.", {
      ...request, workspaceId, operationId: id, createdBy: actorId, ...access
    });
  }
  return null;
}
