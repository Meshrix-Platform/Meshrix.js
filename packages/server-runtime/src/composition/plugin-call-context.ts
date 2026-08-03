import { createHash } from "node:crypto";

import { irreversibleSecurityDigest } from "#meshrix/runtime-logger";

export function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const PLUGIN_CALL_CONTEXT_SCHEMA_VERSION: any = "v0.0.1:plugin:call-context-1";
const MAX_PLUGIN_CALL_TEXT_LENGTH: any = 256;
const MAX_PLUGIN_CALL_FACTS: any = 50;

function boundedCallText(value?: any, maxLength: any = MAX_PLUGIN_CALL_TEXT_LENGTH) : any {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function boundedCallStrings(values: any = [], maxItems: any = MAX_PLUGIN_CALL_FACTS) : any {
  const source: any = Array.isArray(values) ? values : [];
  return [...new Set<any>(source.map((value?: any) : any => boundedCallText(value)).filter(Boolean))]
    .slice(0, Math.min(MAX_PLUGIN_CALL_FACTS, Math.max(0, Number(maxItems) || MAX_PLUGIN_CALL_FACTS)));
}

function irreversibleCallDigest(value?: any, namespace?: any) : any {
  const text: any = boundedCallText(value, 4096);
  return text ? irreversibleSecurityDigest(text, { namespace }) : "";
}

function headerValue(headers?: any, name?: any) : any {
  const normalizedName: any = String(name).toLowerCase();
  const matchedName: any = Object.keys(headers || {}).find((candidate?: any) : any => (
    candidate.toLowerCase() === normalizedName
  ));
  const value: any = matchedName ? headers[matchedName] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

function credentialCallDigest(value?: any) : any {
  const text: any = boundedCallText(value, 4096);
  const highEntropyOpaqueToken: any = text.length >= 32 && /^[A-Za-z0-9._~-]+$/u.test(text);
  return highEntropyOpaqueToken ? createHash("sha256").update(text).digest("hex") : "";
}

function credentialHeaderFacts(headers: Record<string, any> = {}) : any {
  const authorization: any = boundedCallText(headerValue(headers, "authorization"), 4096);
  const bearerMatch: any = /^bearer\s+(.+)$/iu.exec(authorization);
  const authorizationCredentialDigest: any = credentialCallDigest(bearerMatch?.[1]);
  const credentialDigests: any = Object.fromEntries((Object.entries(headers || {}) as [string, any][])
    .map(([name, value]: any[]) : any => [String(name).trim().toLowerCase(), Array.isArray(value) ? value[0] : value])
    .filter(([name]: any[]) : any => /^[a-z0-9][a-z0-9-]{0,127}$/u.test(name) && /-(?:token|credential)$/u.test(name))
    .slice(0, 16)
    .map(([name, value]: any[]) : any => [name, credentialCallDigest(value)])
    .filter(([, digest]: any[]) : any => digest));
  if (authorizationCredentialDigest) credentialDigests.authorization = authorizationCredentialDigest;
  return {
    ...(bearerMatch?.[1] ? { authorizationScheme: "bearer" } : {}),
    ...(Object.keys(credentialDigests).length > 0 ? { credentialDigests } : {})
  };
}

function pluginHeaderFacts(call: Record<string, any> = {}) : any {
  const headers: any = call.headers || call.request?.headers || {};
  return {
    contentType: boundedCallText(headerValue(headers, "content-type"), 128),
    accept: boundedCallText(headerValue(headers, "accept"), 128),
    ...credentialHeaderFacts(headers)
  };
}

function runtimeAuthorizationFromCall(call: Record<string, any> = {}) : any {
  return call?.request?.__meshrixToolRuntimeAuthorization ||
    call?.request?.__meshrixOperationRuntimeAuthorization ||
    null;
}

export function currentSandboxGovernance(call?: any, request?: any) : any {
  const runtimeAuthorization: any = runtimeAuthorizationFromCall(call);
  const approved: any = runtimeAuthorization?.approvedPendingOperation;
  const approvalExpiresAt: any = String(approved?.expiresAt || "").trim();
  const approvalCurrent: any = ["approved", "completed"].includes(String(approved?.status || "")) &&
    approved?.current === true && Number.isFinite(Date.parse(approvalExpiresAt)) &&
    Date.parse(approvalExpiresAt) > Date.now();
  const grantRef: any = String(runtimeAuthorization?.grant?.id || runtimeAuthorization?.grantRef || "").trim();
  const approvalRef: any = approvalCurrent ? String(approved?.pendingOperationId || "").trim() : "";
  const riskDecisionRef: any = String(runtimeAuthorization?.policy?.decisionId || "").trim();
  const policyRevisionValue: any = runtimeAuthorization?.policy?.governancePolicyRevision?.revision ??
    runtimeAuthorization?.grant?.metadata?.policyRevision ??
    runtimeAuthorization?.grant?.policyRevision ??
    "";
  const policyRevision: any = String(policyRevisionValue).trim();
  const authorized: any = runtimeAuthorization?.ok === true && Boolean(grantRef && riskDecisionRef && policyRevision);
  const approvalBindingDigest: any = approvalRef
    ? String(approved?.operationBinding?.bindingDigest || "").trim().toLowerCase()
    : "";
  const approvalSourceDigest: any = approvalRef
    ? createHash("sha256").update(canonicalPluginRequest(request || {})).digest("hex")
    : "";
  const authorizationContextDigest: any = authorized
    ? createHash("sha256").update(canonicalPluginRequest({
        operationId: String(call?.operation?.id || request?.principal?.operationRef || ""),
        grantRef,
        riskDecisionRef,
        policyRevision,
        requiredScopes: runtimeAuthorization?.requiredScopes || [],
        grantScopes: runtimeAuthorization?.grant?.scopes || [],
        grantCapabilities: runtimeAuthorization?.grant?.capabilities || [],
        approvalRef,
        approvalBindingDigest,
        request: request || {}
      })).digest("hex")
    : "";
  return Object.freeze({
    grantRef,
    approvalRef,
    approvalBindingDigest,
    approvalSourceDigest,
    approvalRequestDigest: "",
    approvalExpiresAt: approvalRef ? new Date(Date.parse(approvalExpiresAt)).toISOString() : "",
    authorizationContextDigest,
    riskDecisionRef,
    policyRevision,
    authorized,
    current: authorized,
    revoked: false
  });
}

function pluginGovernanceFacts(call: Record<string, any> = {}) : any {
  const runtimeAuthorization: any = runtimeAuthorizationFromCall(call);
  const base: any = currentSandboxGovernance(call);
  const grant: any = runtimeAuthorization?.grant || {};
  return {
    ...base,
    scopes: boundedCallStrings(grant.scopes || runtimeAuthorization?.scopes),
    toolsets: boundedCallStrings(grant.toolsets || runtimeAuthorization?.toolsets),
    toolAllow: boundedCallStrings(grant.toolAllow || runtimeAuthorization?.toolAllow),
    capabilities: boundedCallStrings(grant.capabilities || runtimeAuthorization?.capabilities),
    permitDigest: boundedCallText(call.governedExecutionPermitReceipt?.permitDigest, 128)
  };
}

function pluginApprovalFacts(call: Record<string, any> = {}) : any {
  const approved: any = runtimeAuthorizationFromCall(call)?.approvedPendingOperation;
  const binding: any = approved?.operationBinding;
  const resource: any = binding?.resource;
  if (!approved || !binding || !resource) return null;
  return {
    approvalRef: boundedCallText(approved.pendingOperationId, 256),
    operationId: boundedCallText(approved.operationId, 256),
    actorRef: irreversibleCallDigest(approved.actorId, "plugin-call-approval-actor"),
    status: boundedCallText(approved.status, 32),
    current: approved.current === true,
    expiresAt: boundedCallText(approved.expiresAt, 64),
    binding: {
      workspaceId: boundedCallText(resource.workspaceId, 256),
      proposalRef: boundedCallText(resource.proposalRef, 256),
      previewDigest: boundedCallText(resource.previewDigest, 128),
      outputDigest: boundedCallText(resource.outputDigest, 128),
      policyDigest: boundedCallText(resource.policyDigest, 128),
      policyRevision: {
        grantPolicyRevision: Number(binding.policyRevision?.grantPolicyRevision || 0),
        governancePolicyRevision: Number(binding.policyRevision?.governancePolicyRevision || 0)
      },
      bindingDigest: boundedCallText(binding.bindingDigest, 128)
    }
  };
}

function pluginAuthFacts(call: Record<string, any> = {}) : any {
  const user: any = call.authSession?.user || {};
  const externalActor: any = call.request?.__meshrixExternalAuth?.actor || {};
  const actor: any = Object.keys(user).length > 0 ? user : externalActor;
  const opaqueExternalProjection: any = Object.keys(user).length === 0 &&
    externalActor.opaqueIdentityProjection === true;
  const subject: any = actor.subjectId || actor.userId || actor.id || "";
  const toolGrant: any = actor.type === "tool-grant" || actor.roleId === "tool-grant";
  const tenant: any = actor.tenantId || actor.organizationId || (toolGrant && subject ? `tool-grant:${subject}` : "");
  const device: any = actor.deviceId || actor.clientId || actor.endpointId || "";
  const workspace: any = call.context?.contributionRegistryWorkspaceId || actor.workspaceId || "";
  const projectIdentity: any = (value?: any, namespace?: any) : any => opaqueExternalProjection
    ? boundedCallText(value, 256)
    : irreversibleCallDigest(value, namespace);
  return {
    authenticated: Boolean(subject || call.authSession || externalActor.type),
    actorType: boundedCallText(actor.type || (call.authSession ? "console-user" : externalActor.type), 64),
    subjectRef: projectIdentity(actor.subjectRef || subject, "plugin-call-subject"),
    tenantRef: projectIdentity(actor.tenantRef || tenant, "plugin-call-tenant"),
    deviceRef: projectIdentity(actor.deviceRef || device, "plugin-call-device"),
    workspaceRef: projectIdentity(actor.workspaceRef || workspace, "plugin-call-workspace"),
    scopes: boundedCallStrings(actor.scopes),
    capabilities: boundedCallStrings(actor.capabilities)
  };
}

export function pluginWorkspaceAuthority(call: Record<string, any> = {}) : any {
  const runtimeAuthorization: any = runtimeAuthorizationFromCall(call);
  const grant: any = runtimeAuthorization?.grant || {};
  const user: any = call.authSession?.user || {};
  const input: any = call.input || {};
  const workspaceRef: any = boundedCallText(
    input.workspaceId || input.workspaceRef || input.workspace || "",
    256
  );
  const allowedWorkspaceIds: any = new Set<any>(boundedCallStrings(
    [
      ...(Array.isArray(grant.allowedWorkspaceIds) ? grant.allowedWorkspaceIds : []),
      ...(Array.isArray(user.allowedWorkspaceIds) ? user.allowedWorkspaceIds : []),
      ...(Array.isArray(user.workspaceIds) ? user.workspaceIds : [])
    ]
  ));
  const scopes: any = boundedCallStrings([...(user.scopes || []), ...(grant.scopes || [])], 512);
  const roleId: any = String(user.roleId || user.role || "").trim();
  const canAccessAll: any = roleId === "owner" ||
    scopes.includes("auth:admin") || scopes.includes("workspace:admin");
  return {
    workspaceRef,
    authorized: Boolean(workspaceRef) && (canAccessAll || allowedWorkspaceIds.has(workspaceRef))
  };
}

export function pluginTraceFacts(call: Record<string, any> = {}) : any {
  const trace: any = call.request?.__meshrixTraceContext || {};
  return {
    traceRef: irreversibleCallDigest(trace.traceId || call.traceId, "plugin-call-trace"),
    requestRef: irreversibleCallDigest(
      trace.requestId || call.request?.__meshrixRequestId || call.requestId,
      "plugin-call-request"
    )
  };
}

function pluginSourceKey(call: Record<string, any> = {}) : any {
  const request: any = call.request || {};
  const source: any = call.sourceKey ||
    request.socket?.remoteAddress ||
    request.connection?.remoteAddress ||
    request.info?.remoteAddress ||
    "";
  return irreversibleCallDigest(source, "plugin-call-source");
}

function pluginDeadlineMs(call: Record<string, any> = {}) : any {
  const value: any = Number(call.deadlineMs ?? call.request?.deadlineMs);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : null;
}

function pluginConcurrencyFacts(call: Record<string, any> = {}) : any {
  const activeHttpRequests: any = Number(
    call.activeHttpRequests ?? call.request?.__meshrixActiveRequestCount
  );
  return {
    activeHttpRequests: Number.isSafeInteger(activeHttpRequests) && activeHttpRequests > 0
      ? Math.min(activeHttpRequests, 100_000)
      : 0
  };
}

export function deepFreezeSerializable(value?: any) : any {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeSerializable(entry);
  } else if (isPlainObject(value)) {
    for (const entry of (Object.values(value) as any[])) deepFreezeSerializable(entry);
  }
  return Object.freeze(value);
}

export function canonicalPluginRequest(value?: any) : any {
  if (Array.isArray(value)) return `[${value.map(canonicalPluginRequest).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key?: any) : any => `${JSON.stringify(key)}:${canonicalPluginRequest(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function createPluginCallProjection(call: Record<string, any> = {}, { invocationAuthorization = "" }: Record<string, any> = {}) : any {
  const signal: any = call.signal || call.operationLock?.signal || null;
  const projection: any = JSON.parse(JSON.stringify({
    schemaVersion: PLUGIN_CALL_CONTEXT_SCHEMA_VERSION,
    transport: boundedCallText(call.transport || (call.request ? "http" : "internal"), 32),
    method: boundedCallText(call.method || call.request?.method, 32).toUpperCase(),
    headers: pluginHeaderFacts(call),
    sourceKey: pluginSourceKey(call),
    deadlineMs: pluginDeadlineMs(call),
    concurrency: pluginConcurrencyFacts(call),
    cancellation: { aborted: signal?.aborted === true },
    auth: pluginAuthFacts(call),
    governance: pluginGovernanceFacts(call),
    approval: pluginApprovalFacts(call),
    workspaceAuthority: pluginWorkspaceAuthority(call),
    trace: pluginTraceFacts(call),
    ...(invocationAuthorization ? { invocationAuthorization } : {})
  }));
  return deepFreezeSerializable(projection);
}


export function custodyOwnerBinding(call?: any) : any {
  const user: any = call?.authSession?.user || {};
  const subjectRef: any = String(
    call?.authSession?.subjectId ||
    call?.authSession?.userId ||
    call?.authSession?.user?.subjectId ||
    call?.authSession?.user?.userId ||
    call?.context?.subjectId ||
    ""
  ).trim();
  const explicitTenantRef: any = String(
    user.tenantId ||
    call?.context?.tenantId ||
    call?.context?.organizationId ||
    ""
  ).trim();
  const toolGrant: any = user.type === "tool-grant" || user.roleId === "tool-grant";
  const tenantRef: any = explicitTenantRef || (toolGrant && subjectRef ? `tool-grant:${subjectRef}` : "");
  const workspaceRef: any = String(
    call?.context?.contributionRegistryWorkspaceId ||
    call?.input?.workspaceId ||
    call?.input?.workspaceRef ||
    ""
  ).trim();
  if (!subjectRef || !tenantRef || !workspaceRef) {
    throw new Error("Opaque custody requires authenticated subject, tenant, and workspace binding.");
  }
  return Object.freeze({ subjectRef, tenantRef, workspaceRef });
}
