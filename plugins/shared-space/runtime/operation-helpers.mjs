export function result(status, payload) {
  return { status, payload };
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function inputBoolean(input = {}, keys = [], fallback = false) {
  for (const key of keys) {
    if (Object.hasOwn(input, key)) return parseBoolean(input[key], fallback);
  }
  return fallback;
}

export function hasLocalDirectoryMountInput(input = {}) {
  return Boolean(String(
    input.mountRef || input.mountId || input["mount-ref"] || input.localDirMountRef || input.localDirectoryMountRef || ""
  ).trim());
}

export function workspaceIdFrom(input = {}, fallback = "") {
  return String(input.workspaceId || input.workspace || fallback || "default").trim() || "default";
}

export function workspaceAccessOptions(authSession = null) {
  const user = authSession?.user || {};
  const scopes = [...(user.scopes || []), ...(authSession?.scopes || [])].map(String).filter(Boolean);
  const roleId = String(user.roleId || user.role || "").trim();
  const canAccessAll = roleId === "owner" || roleId === "admin" || scopes.includes("auth:admin") || scopes.includes("workspace:admin");
  return {
    actorUserId: String(user.userId || user.subjectId || user.username || "").trim(),
    userId: String(user.userId || "").trim(),
    subjectId: String(user.subjectId || "").trim(),
    username: String(user.username || "").trim(),
    roleId,
    scopes,
    allowedWorkspaceIds: Array.isArray(user.allowedWorkspaceIds || user.workspaceIds)
      ? [...(user.allowedWorkspaceIds || user.workspaceIds)].map(String).filter(Boolean)
      : [],
    canAccessAll,
    sharingMode: canAccessAll ? "admin" : "owner-bound"
  };
}

export function requireAgentWorkspaceMethod(agentWorkspace, methodName, message) {
  if (!agentWorkspace || typeof agentWorkspace[methodName] !== "function") {
    return { error: result(503, { ok: false, error: message }) };
  }
  return { method: agentWorkspace[methodName].bind(agentWorkspace) };
}
