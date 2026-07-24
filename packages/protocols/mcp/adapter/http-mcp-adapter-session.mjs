function normalizeGrantTargets(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 16);
}

export function grantMetadata(grant) {
  return grant?.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
}

export function localMcpGrantTargets(grant) {
  const metadata = grantMetadata(grant);
  return [
    ...normalizeGrantTargets(metadata.targets),
    ...normalizeGrantTargets(metadata.mcpTarget)
  ].filter((target, index, values) => values.indexOf(target) === index);
}

export function normalizeGrantValues(value, limit = 64) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

export function requestHeader(request = null, name = "") {
  const lowerName = String(name || "").toLowerCase();
  if (!lowerName) {
    return "";
  }
  const headers = request?.headers || {};
  return String(
    headers[lowerName] ??
      Object.entries(headers).find(([headerName]) => String(headerName || "").toLowerCase() === lowerName)?.[1] ??
      ""
  ).trim();
}

export function firstText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function delegatedChildOperationFromMcpCall({
  payload = {},
  request = null,
  authorization = {},
  envelope = {},
  operation = ""
} = {}) {
  void envelope;
  const grant = authorization?.grant || null;
  const metadata = grantMetadata(grant);
  if (String(grant?.type || "").trim() !== "delegated-mcp-child") {
    return null;
  }
  const canonicalDelegation = metadata.delegatedMcp && typeof metadata.delegatedMcp === "object"
    ? metadata.delegatedMcp
    : {};
  const delegatedMcp = payload?.delegatedMcp && typeof payload.delegatedMcp === "object"
    ? payload.delegatedMcp
    : {};
  const childOperation = payload?.delegatedChildOperation && typeof payload.delegatedChildOperation === "object"
    ? payload.delegatedChildOperation
    : (delegatedMcp.childOperation && typeof delegatedMcp.childOperation === "object"
        ? delegatedMcp.childOperation
        : {});
  const requested = {
    delegatedMcpGrantId: firstText(
      childOperation.grantId,
      delegatedMcp.grantId,
      requestHeader(request, "X-Meshrix-Delegated-Mcp-Grant-Id")
    ),
    delegatedSessionId: firstText(
      childOperation.sessionId,
      delegatedMcp.sessionId,
      requestHeader(request, "X-Meshrix-Delegated-Session-Id")
    ),
    delegatedTurnId: firstText(
      childOperation.turnId,
      delegatedMcp.turnId,
      requestHeader(request, "X-Meshrix-Delegated-Turn-Id")
    ),
    delegatedSubjectId: firstText(
      childOperation.subjectId,
      delegatedMcp.subjectId,
      requestHeader(request, "X-Meshrix-Delegated-Subject-Id")
    ),
    delegatedTargetId: firstText(
      childOperation.targetId,
      delegatedMcp.targetId,
      requestHeader(request, "X-Meshrix-Delegated-Target-Id")
    ),
    delegatedWorkspaceId: firstText(
      childOperation.workspaceId,
      delegatedMcp.workspaceId,
      requestHeader(request, "X-Meshrix-Delegated-Workspace-Id")
    ),
    parentOperationId: firstText(
      childOperation.parentOperationId,
      delegatedMcp.parentOperationId,
      requestHeader(request, "X-Meshrix-Delegated-Parent-Operation-Id")
    ),
    traceId: firstText(
      childOperation.traceId,
      delegatedMcp.traceId,
      requestHeader(request, "X-Meshrix-Delegated-Trace-Id")
    )
  };
  const canonical = {
    delegatedMcpGrantId: String(grant?.id || "").trim(),
    delegatedSessionId: String(canonicalDelegation.sessionId || "").trim(),
    delegatedTurnId: String(canonicalDelegation.turnId || "").trim(),
    delegatedSubjectId: String(canonicalDelegation.subjectId || "").trim(),
    delegatedTargetId: String(canonicalDelegation.targetId || "").trim(),
    delegatedWorkspaceId: String(canonicalDelegation.workspaceId || "").trim(),
    parentOperationId: String(canonicalDelegation.parentOperationId || "").trim(),
    traceId: String(canonicalDelegation.traceId || "").trim()
  };
  const missingRequestBindings = Object.keys(canonical)
    .filter((key) => !requested[key]);
  const requestBindingMismatches = Object.entries(canonical)
    .filter(([key, value]) => requested[key] && requested[key] !== value)
    .map(([key]) => key);
  const canonicalBindingComplete = Boolean(
    canonicalDelegation.issuer &&
    canonicalDelegation.binding &&
    Object.values(canonical).every(Boolean)
  );
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    issuer: String(canonicalDelegation.issuer || "").trim(),
    binding: String(canonicalDelegation.binding || "").trim(),
    ...canonical,
    grantType: String(grant?.type || "").trim(),
    grantBindingVerified: canonicalBindingComplete &&
      missingRequestBindings.length === 0 &&
      requestBindingMismatches.length === 0,
    missingRequestBindings,
    requestBindingMismatches,
    operationId: String(operation || "").trim()
  };
}

export function mcpSubjectFromGrant(grant = null) {
  if (!grant) {
    return {
      type: "anonymous",
      subjectId: "",
      label: "",
      scopes: [],
      toolsets: []
    };
  }
  return {
    type: "tool-grant",
    subjectId: String(grant.id || ""),
    label: String(grant.label || grant.id || ""),
    scopes: normalizeGrantValues(grant.scopes || [], 512),
    toolsets: normalizeGrantValues(grant.toolsets || [], 256)
  };
}

export function mcpAuthSessionFromGrant(grant = null) {
  const subject = mcpSubjectFromGrant(grant);
  if (subject.type !== "tool-grant" || !subject.subjectId) {
    return null;
  }
  return {
    user: {
      type: "tool-grant",
      roleId: "tool-grant",
      userId: subject.subjectId,
      subjectId: subject.subjectId,
      username: subject.label || subject.subjectId,
      scopes: subject.scopes,
      toolsets: subject.toolsets,
      allowedWorkspaceIds: normalizeGrantValues(grant.allowedWorkspaceIds || grant.metadata?.allowedWorkspaceIds || [], 512)
    }
  };
}
