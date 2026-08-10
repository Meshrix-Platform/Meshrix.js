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

function invalidBody() {
  return result(400, { error: "Request body must be a JSON object." });
}

export async function executeSharedSpaceOperation({ operationId, input = {}, context = {} } = {}) {
  const id = String(operationId || "");
  if (!SHARED_SPACE_OPERATION_ID_SET.has(id)) return null;
  const agentWorkspace = context.agentWorkspace;
  const workspaceId = workspaceIdFrom(input);
  const access = workspaceAccessOptions(context.authSession);
  const actorId = context.authSession?.user?.username || context.authSession?.user?.userId || "";
  if (typeof context.executeSandboxOperation === "function" && (
    id === "sharedspace.snapshot.create" || id.startsWith("sharedspace.sandbox.") || id.startsWith("sharedspace.output.")
  )) {
    return context.executeSandboxOperation({ operationId: id, input, context });
  }
  const invoke = async (methodName, unavailableMessage, args, successStatus = 200) => {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, methodName, unavailableMessage);
    if (error) return error;
    const operationResult = await method(args);
    return result(operationResult.ok ? successStatus : operationResult.status || 400, operationResult);
  };

  if (id === "sharedspace.localDir.connect") {
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalidBody();
    return invoke("connectLocalDirectory", "Controlled local-directory connection is unavailable.", {
      workspaceId, ...input, operationId: id, createdBy: actorId || input.createdBy || "", ...access
    }, 201);
  }
  if (id === "sharedspace.localDir.list") {
    return invoke("listLocalDirectoryMounts", "Controlled local-directory listing is unavailable.", {
      workspaceId, ...input, operationId: id, ...access
    });
  }
  if (id === "sharedspace.item.list") {
    if (hasLocalDirectoryMountInput(input)) {
      return invoke("listLocalDirectoryItems", "Controlled local-directory item listing is unavailable.", {
        workspaceId,
        ...input,
        operationId: id,
        recursive: inputBoolean(input, ["recursive"], false),
        includeDirectories: inputBoolean(input, ["includeDirectories", "include-directories"], true),
        includeFiles: inputBoolean(input, ["includeFiles", "include-files"], true),
        includeHash: inputBoolean(input, ["includeHash", "include-hash"], false),
        limit: Number(input.limit || 200),
        ...access
      });
    }
    return invoke("listWorkspaceFiles", "Workspace file listing is unavailable.", {
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
  }
  if (id === "sharedspace.item.stat") {
    return invoke("localDirectoryItemMetadata", "Controlled local-directory item metadata is unavailable.", {
      workspaceId, ...input, operationId: id,
      includeHash: inputBoolean(input, ["includeHash", "include-hash"], true),
      ...access
    });
  }
  if (id === "sharedspace.file.read") {
    const common = {
      workspaceId,
      ...input,
      path: input.path || input.filePath || input["file-path"] || "",
      includeText: inputBoolean(input, ["includeText", "include-text"], true),
      encoding: input.encoding || "utf8",
      operationId: id,
      ...access
    };
    return hasLocalDirectoryMountInput(input)
      ? invoke("readLocalDirectoryFile", "Controlled local-directory file reading is unavailable.", common)
      : invoke("downloadWorkspaceFile", "Workspace file reading is unavailable.", common);
  }
  if (id === "sharedspace.file.write") {
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalidBody();
    const common = { workspaceId, ...input, operationId: id, createdBy: actorId || input.createdBy || "", ...access };
    return hasLocalDirectoryMountInput(input)
      ? invoke("writeLocalDirectoryFile", "Controlled local-directory file writing is unavailable.", common)
      : invoke("uploadWorkspaceFile", "Workspace file writing is unavailable.", common, 201);
  }
  if (id === "sharedspace.item.delete") {
    const common = {
      workspaceId,
      ...input,
      path: input.path || input.filePath || input["file-path"] || "",
      operationId: id,
      recursive: inputBoolean(input, ["recursive"], false),
      ...access
    };
    return hasLocalDirectoryMountInput(input)
      ? invoke("deleteLocalDirectoryItem", "Controlled local-directory item deletion is unavailable.", common)
      : invoke("deleteWorkspaceFile", "Workspace file deletion is unavailable.", common);
  }
  if (id === "sharedspace.directory.create") {
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalidBody();
    return invoke("createLocalDirectoryFolder", "Controlled local-directory creation is unavailable.", {
      workspaceId, ...input, operationId: id, createdBy: actorId || input.createdBy || "", ...access
    }, 201);
  }
  if (id === "sharedspace.item.move") {
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalidBody();
    return invoke("moveLocalDirectoryItem", "Controlled local-directory item move is unavailable.", {
      workspaceId, ...input, operationId: id, createdBy: actorId || input.createdBy || "", ...access
    });
  }
  if (id === "sharedspace.sync.plan") {
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalidBody();
    return invoke("localDirectorySyncPlan", "Controlled local-directory synchronization planning is unavailable.", {
      workspaceId, ...input, operationId: id, ...access
    });
  }
  if (id === "sharedspace.sync.apply") {
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalidBody();
    return invoke("applyLocalDirectorySync", "Controlled local-directory synchronization is unavailable.", {
      workspaceId, ...input, operationId: id, createdBy: actorId || input.createdBy || "", ...access
    });
  }
  return null;
}
