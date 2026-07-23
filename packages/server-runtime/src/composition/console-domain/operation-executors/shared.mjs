
export function result(status, payload) {
  return { status, payload };
}

export function requireStorageProvider(context = {}) {
  if (!context.storageProvider) {
    return { error: result(503, { error: "存储 provider 不可用。" }) };
  }
  return { storageProvider: context.storageProvider };
}

export function requireClientRegistryService(context = {}) {
  if (!context.clientRegistryService) {
    return { error: result(503, { error: "客户端登记服务不可用。" }) };
  }
  return { clientRegistryService: context.clientRegistryService };
}

export function requireDevopsProvider(context = {}) {
  if (!context.devopsProvider) {
    return { error: result(503, { error: "运维 provider 不可用。" }) };
  }
  return { devopsProvider: context.devopsProvider };
}

export function requireStrategyManagementProvider(context = {}) {
  if (!context.strategyManagementProvider) {
    return { error: result(503, { error: "策略管理 provider 不可用。" }) };
  }
  return { strategyManagementProvider: context.strategyManagementProvider };
}

export function requireSettingsPort(context = {}) {
  const settingsPort = context.settingsPort;
  if (
    !settingsPort ||
    typeof settingsPort.loadSettings !== "function" ||
    typeof settingsPort.saveSettings !== "function" ||
    typeof settingsPort.normalizeSettings !== "function" ||
    typeof settingsPort.getSettingsPath !== "function"
  ) {
    return { error: result(503, { error: "设置 port 不可用。" }) };
  }
  return { settingsPort };
}

export function requireDiscoveryPort(context = {}) {
  const discoveryPort = context.discoveryPort;
  if (!discoveryPort || typeof discoveryPort.saveDiscoveryConfig !== "function") {
    return { error: result(503, { error: "发现配置 port 不可用。" }) };
  }
  return { discoveryPort };
}

export function protocolPayload(payload = {}) {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    ok: true,
    ...payload
  };
}

export function actorFrom(authSession = null, input = {}) {
  return authSession?.user?.username || authSession?.userId || input.actor || "console";
}

export function plainObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

export function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function firstProtocolInputValue(input = {}, keys = [], fallback = "") {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      continue;
    }
    const value = input[key];
    if (Array.isArray(value)) {
      const selected = value.find((item) => item !== undefined && item !== null && String(item).trim() !== "");
      if (selected !== undefined) {
        return selected;
      }
      continue;
    }
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return fallback;
}

export function inputValueList(input = {}, keys = []) {
  const values = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      continue;
    }
    const value = input[key];
    if (Array.isArray(value)) {
      values.push(...value);
    } else {
      values.push(value);
    }
  }
  return values;
}

export function normalizeDelimitedInputList(input = {}, keys = [], { lowercase = false } = {}) {
  return inputValueList(input, keys)
    .flatMap((value) => String(value || "").split(","))
    .map((value) => {
      const trimmed = value.trim();
      return lowercase ? trimmed.toLowerCase() : trimmed;
    })
    .filter(Boolean);
}

export function normalizeAgentSubscriptionInput(input = {}) {
  return {
    ...input,
    cursor: Number(firstProtocolInputValue(input, ["cursor"], 0)),
    topics: normalizeDelimitedInputList(input, ["topic", "topics"]),
    timeoutMs: Number(firstProtocolInputValue(input, ["timeoutMs", "timeout-ms", "timeout"], 0)),
    limit: Number(firstProtocolInputValue(input, ["limit"], 100)),
    includeSnapshot: parseBooleanFlag(
      firstProtocolInputValue(input, ["includeSnapshot", "include-snapshot", "snapshot"], ""),
      false
    )
  };
}

export function normalizeSearchQueryInput(input = {}) {
  return {
    ...input,
    query: String(firstProtocolInputValue(input, ["query", "q"], "") || ""),
    batchId: String(firstProtocolInputValue(input, ["batchId", "batch-id"], "") || ""),
    entityTypes: normalizeDelimitedInputList(input, ["entityType", "entityTypes", "entity-type", "entity-types"], {
      lowercase: true
    }),
    formalOnly: parseBooleanFlag(firstProtocolInputValue(input, ["formalOnly", "formal-only"], ""), false),
    limit: Number(firstProtocolInputValue(input, ["limit"], 20))
  };
}

export function parseOptionalBooleanFlag(input = {}, keys = [], fallback = undefined) {
  for (const key of keys) {
    if (hasInputKey(input, key)) {
      return parseBooleanFlag(input[key], fallback === undefined ? false : fallback);
    }
  }
  return fallback;
}


export function hasInputKey(input = {}, key) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

export function hasLocalDirectoryMountInput(input = {}) {
  return Boolean(String(
    input.mountRef ||
      input.mountId ||
      input["mount-ref"] ||
      input.localDirMountRef ||
      input.localDirectoryMountRef ||
      ""
  ).trim());
}

export function inputBoolean(input = {}, keys = [], fallback = false) {
  for (const key of keys) {
    if (!hasInputKey(input, key)) continue;
    const value = input[key];
    if (typeof value === "boolean") return value;
    const text = String(value ?? "").trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off"].includes(text)) return false;
    return fallback;
  }
  return fallback;
}

export function firstInputValue(input = {}, keys = [], fallback = "") {
  for (const key of keys) {
    if (!hasInputKey(input, key)) {
      continue;
    }
    const value = input[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return fallback;
}

export function subjectFromAuthSession(authSession = null) {
  const user = authSession?.user || {};
  const scopes = [
    ...(Array.isArray(user.scopes) ? user.scopes : []),
    ...(Array.isArray(authSession?.scopes) ? authSession.scopes : [])
  ].map((scope) => String(scope || "").trim()).filter(Boolean);
  const subjectType = user.type ||
    (user.roleId === "tool-grant" ? "tool-grant" : "") ||
    (user.userId ? "console-user" : "anonymous");
  return {
    type: subjectType,
    subjectId: user.userId || user.subjectId || user.username || "",
    username: user.username || "",
    roleId: user.roleId || "",
    scopes,
    allowedWorkspaceIds: Array.isArray(user.allowedWorkspaceIds) ? [...user.allowedWorkspaceIds] : [],
    dynamicCapabilities: Array.isArray(user.dynamicCapabilities) ? [...user.dynamicCapabilities] : [],
    allowedServiceIds: Array.isArray(user.allowedServiceIds) ? [...user.allowedServiceIds] : [],
    allowedSecretBindings: Array.isArray(user.allowedSecretBindings) ? [...user.allowedSecretBindings] : []
  };
}

export function authenticatedCallerClaimsLocked(context = {}, subject = {}) {
  const user = context.authSession?.user || {};
  return (
    context.transport === "mcp" ||
    user.type === "tool-grant" ||
    user.roleId === "tool-grant" ||
    subject.type === "tool-grant" ||
    subject.roleId === "tool-grant"
  );
}

export function firstInputString(input = {}, keys = []) {
  for (const key of keys) {
    const value = String(input[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

export function callerIdClaim(context = {}, input = {}, subject = {}, keys = ["actorId", "actor-id", "actor"]) {
  const authenticatedId = subject.subjectId || subject.username || "anonymous";
  if (authenticatedCallerClaimsLocked(context, subject)) {
    return authenticatedId;
  }
  return firstInputString(input, keys) || authenticatedId;
}

export function callerKindClaim(context = {}, input = {}, subject = {}) {
  if (authenticatedCallerClaimsLocked(context, subject)) {
    return subject.type || "agent";
  }
  return String(input.contributorKind || input["contributor-kind"] || subject.type || "agent").trim() || "agent";
}

export function workspaceIdFrom(input = {}, fallback = "") {
  return String(input.workspaceId || input.workspace || fallback || "default").trim() || "default";
}

export function arrayOfStrings(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

export function workspaceAccessOptions(authSession = null) {
  const user = authSession?.user || {};
  const scopes = [
    ...(Array.isArray(user.scopes) ? user.scopes : []),
    ...(Array.isArray(authSession?.scopes) ? authSession.scopes : [])
  ].map((scope) => String(scope || "").trim()).filter(Boolean);
  const roleId = String(user.roleId || user.role || "").trim();
  const canAccessAll = (
    roleId === "owner" ||
    roleId === "admin" ||
    scopes.includes("auth:admin") ||
    scopes.includes("workspace:admin")
  );
  return {
    actorUserId: String(user.userId || user.subjectId || user.username || "").trim(),
    userId: String(user.userId || "").trim(),
    subjectId: String(user.subjectId || "").trim(),
    username: String(user.username || "").trim(),
    roleId,
    scopes,
    allowedWorkspaceIds: arrayOfStrings(user.allowedWorkspaceIds || user.workspaceIds),
    canAccessAll,
    sharingMode: canAccessAll ? "admin" : "owner-bound"
  };
}

export function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}


export function authSessionScopes(context = {}) {
  const user = context.authSession?.user || {};
  const subject = context.subject && typeof context.subject === "object" && !Array.isArray(context.subject)
    ? context.subject
    : {};
  return new Set([
    ...(Array.isArray(user.scopes) ? user.scopes : []),
    ...(Array.isArray(context.authSession?.scopes) ? context.authSession.scopes : []),
    ...(Array.isArray(subject.scopes) ? subject.scopes : [])
  ].map((scope) => String(scope || "").trim()).filter(Boolean));
}

export function hasConsoleScope(context = {}, scope = "") {
  const scopes = authSessionScopes(context);
  return scopes.has(scope) || scopes.has("auth:admin") || scopes.has("runtime:admin");
}

export function modelCallDeniedResult() {
  return result(403, {
    ok: false,
    error: {
      code: "model_call_scope_required",
      message: "This operation can call a configured model and requires model:call.",
      requiredScopes: ["model:call"]
    }
  });
}

export function modelCallRequested(input = {}) {
  const payload = input && typeof input === "object" && !Array.isArray(input)
    ? input
    : {};
  const nested = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
    ? payload.input
    : {};
  return payload.modelEnabled === true || nested.modelEnabled === true;
}


export function requireRuntimeMethod(runtime, methodName, message) {
  if (!runtime || typeof runtime[methodName] !== "function") {
    return { error: result(503, { error: message }) };
  }
  return { method: runtime[methodName].bind(runtime) };
}

export function requireAgentWorkspaceMethod(agentWorkspace, methodName, message) {
  return requireRuntimeMethod(agentWorkspace, methodName, message);
}

export async function publishProtocolEvent(protocolEventBus, topic, payload, options = {}) {
  if (!protocolEventBus || typeof protocolEventBus.publish !== "function") {
    return null;
  }
  return protocolEventBus.publish(topic, payload, options);
}


export async function authorizeToolSkillScopes({ provider, request, scopes }) {
  if (!provider?.authorizeRequest) {
    return {
      ok: false,
      status: 503,
      error: "Tool/Skill management provider is unavailable."
    };
  }
  return provider.authorizeRequest({
    request,
    requiredScopes: scopes
  });
}

export function errorPayload(error, fallbackMessage, extra = {}) {
  return {
    ok: false,
    error: error instanceof Error ? error.message : fallbackMessage,
    ...extra
  };
}


export function appendConsoleLog(context = {}, entry = {}) {
  if (typeof context.appendConsoleOperationLog === "function") {
    context.appendConsoleOperationLog(entry);
  }
}


export function appendAuthorizationArtifact(securityPermissions, methodName, artifact, metadata = {}) {
  if (!artifact || typeof securityPermissions?.[methodName] !== "function") {
    return;
  }
  securityPermissions[methodName](artifact, metadata);
}

export function filterContributionsForWorkspace(items = [], input = {}) {
  const workspaceId = String(input.workspaceId || input.workspace || "").trim();
  if (!workspaceId || !items.some((item) => Object.hasOwn(item, "workspaceId"))) {
    return items;
  }
  return items.filter((item) => item.workspaceId === workspaceId);
}
