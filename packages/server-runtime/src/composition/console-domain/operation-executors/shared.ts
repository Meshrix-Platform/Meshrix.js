
export function result(status?: any, payload?: any) : any {
  return { status, payload };
}

export function requireStorageProvider(context: Record<string, any> = {}) : any {
  if (!context.storageProvider) {
    return { error: result(503, { error: "存储 provider 不可用。" }) };
  }
  return { storageProvider: context.storageProvider };
}

export function requireClientRegistryService(context: Record<string, any> = {}) : any {
  if (!context.clientRegistryService) {
    return { error: result(503, { error: "客户端登记服务不可用。" }) };
  }
  return { clientRegistryService: context.clientRegistryService };
}

export function requireDevopsProvider(context: Record<string, any> = {}) : any {
  if (!context.devopsProvider) {
    return { error: result(503, { error: "运维 provider 不可用。" }) };
  }
  return { devopsProvider: context.devopsProvider };
}

export function requireStrategyManagementProvider(context: Record<string, any> = {}) : any {
  if (!context.strategyManagementProvider) {
    return { error: result(503, { error: "策略管理 provider 不可用。" }) };
  }
  return { strategyManagementProvider: context.strategyManagementProvider };
}

export function requireSettingsPort(context: Record<string, any> = {}) : any {
  const settingsPort: any = context.settingsPort;
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

export function requireDiscoveryPort(context: Record<string, any> = {}) : any {
  const discoveryPort: any = context.discoveryPort;
  if (!discoveryPort || typeof discoveryPort.saveDiscoveryConfig !== "function") {
    return { error: result(503, { error: "发现配置 port 不可用。" }) };
  }
  return { discoveryPort };
}

export function protocolPayload(payload: Record<string, any> = {}) : any {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    ok: true,
    ...payload
  };
}

export function actorFrom(authSession: any = null, input: Record<string, any> = {}) : any {
  return authSession?.user?.username || authSession?.userId || input.actor || "console";
}

export function plainObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

export function parseBooleanFlag(value?: any, fallback: any = false) : any {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function firstProtocolInputValue(input: Record<string, any> = {}, keys: any = [], fallback: any = "") : any {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      continue;
    }
    const value: any = input[key];
    if (Array.isArray(value)) {
      const selected: any = value.find((item?: any) : any => item !== undefined && item !== null && String(item).trim() !== "");
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

export function inputValueList(input: Record<string, any> = {}, keys: any = []) : any {
  const values: any[] = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      continue;
    }
    const value: any = input[key];
    if (Array.isArray(value)) {
      values.push(...value);
    } else {
      values.push(value);
    }
  }
  return values;
}

export function normalizeDelimitedInputList(input: Record<string, any> = {}, keys: any = [], { lowercase = false }: Record<string, any> = {}) : any {
  return inputValueList(input, keys)
    .flatMap((value?: any) : any => String(value || "").split(","))
    .map((value?: any) : any => {
      const trimmed: any = value.trim();
      return lowercase ? trimmed.toLowerCase() : trimmed;
    })
    .filter(Boolean);
}

export function normalizeAgentSubscriptionInput(input: Record<string, any> = {}) : any {
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

export function normalizeSearchQueryInput(input: Record<string, any> = {}) : any {
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

export function parseOptionalBooleanFlag(input: Record<string, any> = {}, keys: any = [], fallback: any = undefined) : any {
  for (const key of keys) {
    if (hasInputKey(input, key)) {
      return parseBooleanFlag(input[key], fallback === undefined ? false : fallback);
    }
  }
  return fallback;
}


export function hasInputKey(input: Record<string, any> = {}, key?: any) : any {
  return Object.prototype.hasOwnProperty.call(input, key);
}

export function hasLocalDirectoryMountInput(input: Record<string, any> = {}) : any {
  return Boolean(String(
    input.mountRef ||
      input.mountId ||
      input["mount-ref"] ||
      input.localDirMountRef ||
      input.localDirectoryMountRef ||
      ""
  ).trim());
}

export function inputBoolean(input: Record<string, any> = {}, keys: any = [], fallback: any = false) : any {
  for (const key of keys) {
    if (!hasInputKey(input, key)) continue;
    const value: any = input[key];
    if (typeof value === "boolean") return value;
    const text: any = String(value ?? "").trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off"].includes(text)) return false;
    return fallback;
  }
  return fallback;
}

export function firstInputValue(input: Record<string, any> = {}, keys: any = [], fallback: any = "") : any {
  for (const key of keys) {
    if (!hasInputKey(input, key)) {
      continue;
    }
    const value: any = input[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return fallback;
}

export function subjectFromAuthSession(authSession: any = null) : any {
  const user: any = authSession?.user || {};
  const scopes: any = [
    ...(Array.isArray(user.scopes) ? user.scopes : []),
    ...(Array.isArray(authSession?.scopes) ? authSession.scopes : [])
  ].map((scope?: any) : any => String(scope || "").trim()).filter(Boolean);
  const subjectType: any = user.type ||
    (user.roleId === "tool-grant" ? "tool-grant" : "") ||
    (user.userId ? "console-user" : "anonymous");
  return {
    type: subjectType,
    subjectId: user.userId || user.subjectId || user.username || "",
    username: user.username || "",
    roleId: user.roleId || "",
    tenantId: user.tenantId || "",
    organizationNodeId: user.organizationNodeId || authSession?.organizationNodeId || "",
    scopes,
    allowedWorkspaceIds: Array.isArray(user.allowedWorkspaceIds) ? [...user.allowedWorkspaceIds] : [],
    dynamicCapabilities: Array.isArray(user.dynamicCapabilities) ? [...user.dynamicCapabilities] : [],
    allowedServiceIds: Array.isArray(user.allowedServiceIds) ? [...user.allowedServiceIds] : [],
    allowedSecretBindings: Array.isArray(user.allowedSecretBindings) ? [...user.allowedSecretBindings] : []
  };
}

export function authenticatedCallerClaimsLocked(context: Record<string, any> = {}, subject: Record<string, any> = {}) : any {
  const user: any = context.authSession?.user || {};
  return (
    context.transport === "mcp" ||
    user.type === "tool-grant" ||
    user.roleId === "tool-grant" ||
    subject.type === "tool-grant" ||
    subject.roleId === "tool-grant"
  );
}

export function firstInputString(input: Record<string, any> = {}, keys: any = []) : any {
  for (const key of keys) {
    const value: any = String(input[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

export function callerIdClaim(context: Record<string, any> = {}, input: Record<string, any> = {}, subject: Record<string, any> = {}, keys: any = ["actorId", "actor-id", "actor"]) : any {
  const authenticatedId: any = subject.subjectId || subject.username || "anonymous";
  if (authenticatedCallerClaimsLocked(context, subject)) {
    return authenticatedId;
  }
  return firstInputString(input, keys) || authenticatedId;
}

export function callerKindClaim(context: Record<string, any> = {}, input: Record<string, any> = {}, subject: Record<string, any> = {}) : any {
  if (authenticatedCallerClaimsLocked(context, subject)) {
    return subject.type || "agent";
  }
  return String(input.contributorKind || input["contributor-kind"] || subject.type || "agent").trim() || "agent";
}

export function workspaceIdFrom(input: Record<string, any> = {}, fallback: any = "") : any {
  return String(input.workspaceId || input.workspace || fallback || "default").trim() || "default";
}

export function arrayOfStrings(value?: any) : any {
  return Array.isArray(value)
    ? value.map((item?: any) : any => String(item || "").trim()).filter(Boolean)
    : [];
}

export function workspaceAccessOptions(authSession: any = null) : any {
  const user: any = authSession?.user || {};
  const scopes: any = [
    ...(Array.isArray(user.scopes) ? user.scopes : []),
    ...(Array.isArray(authSession?.scopes) ? authSession.scopes : [])
  ].map((scope?: any) : any => String(scope || "").trim()).filter(Boolean);
  const roleId: any = String(user.roleId || user.role || "").trim();
  const canAccessAll: any = (
    roleId === "owner" ||
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

export function objectOrNull(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}


export function authSessionScopes(context: Record<string, any> = {}) : any {
  const user: any = context.authSession?.user || {};
  const subject: any = context.subject && typeof context.subject === "object" && !Array.isArray(context.subject)
    ? context.subject
    : {};
  return new Set<any>([
    ...(Array.isArray(user.scopes) ? user.scopes : []),
    ...(Array.isArray(context.authSession?.scopes) ? context.authSession.scopes : []),
    ...(Array.isArray(subject.scopes) ? subject.scopes : [])
  ].map((scope?: any) : any => String(scope || "").trim()).filter(Boolean));
}

export function hasConsoleScope(context: Record<string, any> = {}, scope: any = "") : any {
  const scopes: any = authSessionScopes(context);
  return scopes.has(scope) || scopes.has("auth:admin") || scopes.has("runtime:admin");
}

export function modelCallDeniedResult() : any {
  return result(403, {
    ok: false,
    error: {
      code: "model_call_scope_required",
      message: "This operation can call a configured model and requires model:call.",
      requiredScopes: ["model:call"]
    }
  });
}

export function modelCallRequested(input: Record<string, any> = {}) : any {
  const payload: any = input && typeof input === "object" && !Array.isArray(input)
    ? input
    : {};
  const nested: any = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
    ? payload.input
    : {};
  return payload.modelEnabled === true || nested.modelEnabled === true;
}


export function requireRuntimeMethod(runtime?: any, methodName?: any, message?: any) : any {
  if (!runtime || typeof runtime[methodName] !== "function") {
    return { error: result(503, { error: message }) };
  }
  return { method: runtime[methodName].bind(runtime) };
}

export function requireAgentWorkspaceMethod(agentWorkspace?: any, methodName?: any, message?: any) : any {
  return requireRuntimeMethod(agentWorkspace, methodName, message);
}

export async function publishProtocolEvent(protocolEventBus?: any, topic?: any, payload?: any, options: Record<string, any> = {}) : Promise<any> {
  if (!protocolEventBus || typeof protocolEventBus.publish !== "function") {
    return null;
  }
  return protocolEventBus.publish(topic, payload, options);
}


export async function authorizeToolSkillScopes({ provider, request, scopes }: Record<string, any>) : Promise<any> {
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

export function errorPayload(error?: any, fallbackMessage?: any, extra: Record<string, any> = {}) : any {
  const code: any = String(error?.code || error?.reasonCode || "").trim();
  return {
    ok: false,
    error: error instanceof Error ? error.message : fallbackMessage,
    ...(code ? { code } : {}),
    ...extra
  };
}


export async function appendConsoleLog(context: Record<string, any> = {}, entry: Record<string, any> = {}) : Promise<any> {
  if (typeof context.appendConsoleOperationLog === "function") {
    await context.appendConsoleOperationLog(entry);
  }
}


export function appendAuthorizationArtifact(securityPermissions?: any, methodName?: any, artifact?: any, metadata: Record<string, any> = {}) : any {
  if (!artifact || typeof securityPermissions?.[methodName] !== "function") {
    return;
  }
  securityPermissions[methodName](artifact, metadata);
}

export function filterContributionsForWorkspace(items: any = [], input: Record<string, any> = {}) : any {
  const workspaceId: any = String(input.workspaceId || input.workspace || "").trim();
  if (!workspaceId || !items.some((item?: any) : any => Object.hasOwn(item, "workspaceId"))) {
    return items;
  }
  return items.filter((item?: any) : any => item.workspaceId === workspaceId);
}
