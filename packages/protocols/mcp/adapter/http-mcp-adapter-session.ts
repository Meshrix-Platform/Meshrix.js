function normalizeGrantTargets(value?: any) : any {
  const items: any = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set<any>(items.map((item?: any) : any => String(item || "").trim()).filter(Boolean))].slice(0, 16);
}

export function grantMetadata(grant?: any) : any {
  return grant?.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
}

export function localMcpGrantTargets(grant?: any) : any {
  const metadata: any = grantMetadata(grant);
  return [
    ...normalizeGrantTargets(metadata.targets),
    ...normalizeGrantTargets(metadata.mcpTarget)
  ].filter((target?: any, index?: any, values?: any) : any => values.indexOf(target) === index);
}

export function normalizeGrantValues(value?: any, limit: any = 64) : any {
  const items: any = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set<any>(items.map((item?: any) : any => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

export function requestHeader(request: any = null, name: any = "") : any {
  const lowerName: any = String(name || "").toLowerCase();
  if (!lowerName) {
    return "";
  }
  const headers: any = request?.headers || {};
  return String(
    headers[lowerName] ??
      (Object.entries(headers) as [string, any][]).find(([headerName]: any[]) : any => String(headerName || "").toLowerCase() === lowerName)?.[1] ??
      ""
  ).trim();
}

export function firstText(...values: any[]) : any {
  for (const value of values) {
    const text: any = String(value || "").trim();
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
}: Record<string, any> = {}) : any {
  void envelope;
  const grant: any = authorization?.grant || null;
  const metadata: any = grantMetadata(grant);
  if (String(grant?.type || "").trim() !== "delegated-mcp-child") {
    return null;
  }
  const canonicalDelegation: any = metadata.delegatedMcp && typeof metadata.delegatedMcp === "object"
    ? metadata.delegatedMcp
    : {};
  const delegatedMcp: any = payload?.delegatedMcp && typeof payload.delegatedMcp === "object"
    ? payload.delegatedMcp
    : {};
  const childOperation: any = payload?.delegatedChildOperation && typeof payload.delegatedChildOperation === "object"
    ? payload.delegatedChildOperation
    : (delegatedMcp.childOperation && typeof delegatedMcp.childOperation === "object"
        ? delegatedMcp.childOperation
        : {});
  const requested: Record<string, any> = {
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
  const canonical: Record<string, any> = {
    delegatedMcpGrantId: String(grant?.id || "").trim(),
    delegatedSessionId: String(canonicalDelegation.sessionId || "").trim(),
    delegatedTurnId: String(canonicalDelegation.turnId || "").trim(),
    delegatedSubjectId: String(canonicalDelegation.subjectId || "").trim(),
    delegatedTargetId: String(canonicalDelegation.targetId || "").trim(),
    delegatedWorkspaceId: String(canonicalDelegation.workspaceId || "").trim(),
    parentOperationId: String(canonicalDelegation.parentOperationId || "").trim(),
    traceId: String(canonicalDelegation.traceId || "").trim()
  };
  const missingRequestBindings: any = Object.keys(canonical)
    .filter((key?: any) : any => !requested[key]);
  const requestBindingMismatches: any = (Object.entries(canonical) as [string, any][])
    .filter(([key, value]: any[]) : any => requested[key] && requested[key] !== value)
    .map(([key]: any[]) : any => key);
  const canonicalBindingComplete: any = Boolean(
    canonicalDelegation.issuer &&
    canonicalDelegation.binding &&
    (Object.values(canonical) as any[]).every(Boolean)
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

export function mcpSubjectFromGrant(grant: any = null) : any {
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

export function mcpAuthSessionFromGrant(grant: any = null) : any {
  const subject: any = mcpSubjectFromGrant(grant);
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
