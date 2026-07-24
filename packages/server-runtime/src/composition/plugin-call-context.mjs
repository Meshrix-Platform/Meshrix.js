import { createHash } from "node:crypto";

import { irreversibleSecurityDigest } from "#meshrix/runtime-logger";

export function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const PLUGIN_CALL_CONTEXT_SCHEMA_VERSION = "v0.0.1:plugin:call-context-1";
const MAX_PLUGIN_CALL_TEXT_LENGTH = 256;
const MAX_PLUGIN_CALL_FACTS = 50;

function boundedCallText(value, maxLength = MAX_PLUGIN_CALL_TEXT_LENGTH) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function boundedCallStrings(values = []) {
  const source = Array.isArray(values) ? values : [];
  return [...new Set(source.map((value) => boundedCallText(value)).filter(Boolean))]
    .slice(0, MAX_PLUGIN_CALL_FACTS);
}

function irreversibleCallDigest(value, namespace) {
  const text = boundedCallText(value, 4096);
  return text ? irreversibleSecurityDigest(text, { namespace }) : "";
}

function headerValue(headers, name) {
  const normalizedName = String(name).toLowerCase();
  const matchedName = Object.keys(headers || {}).find((candidate) => (
    candidate.toLowerCase() === normalizedName
  ));
  const value = matchedName ? headers[matchedName] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

function credentialCallDigest(value) {
  const text = boundedCallText(value, 4096);
  const highEntropyOpaqueToken = text.length >= 32 && /^[A-Za-z0-9._~-]+$/u.test(text);
  return highEntropyOpaqueToken ? createHash("sha256").update(text).digest("hex") : "";
}

function credentialHeaderFacts(headers = {}) {
  const authorization = boundedCallText(headerValue(headers, "authorization"), 4096);
  const bearerMatch = /^bearer\s+(.+)$/iu.exec(authorization);
  const authorizationCredentialDigest = credentialCallDigest(bearerMatch?.[1]);
  const credentialDigests = Object.fromEntries(Object.entries(headers || {})
    .map(([name, value]) => [String(name).trim().toLowerCase(), Array.isArray(value) ? value[0] : value])
    .filter(([name]) => /^[a-z0-9][a-z0-9-]{0,127}$/u.test(name) && /-(?:token|credential)$/u.test(name))
    .slice(0, 16)
    .map(([name, value]) => [name, credentialCallDigest(value)])
    .filter(([, digest]) => digest));
  if (authorizationCredentialDigest) credentialDigests.authorization = authorizationCredentialDigest;
  return {
    ...(bearerMatch?.[1] ? { authorizationScheme: "bearer" } : {}),
    ...(Object.keys(credentialDigests).length > 0 ? { credentialDigests } : {})
  };
}

function pluginHeaderFacts(call = {}) {
  const headers = call.headers || call.request?.headers || {};
  return {
    contentType: boundedCallText(headerValue(headers, "content-type"), 128),
    accept: boundedCallText(headerValue(headers, "accept"), 128),
    ...credentialHeaderFacts(headers)
  };
}

function runtimeAuthorizationFromCall(call = {}) {
  return call?.request?.__licoToolRuntimeAuthorization ||
    call?.request?.__licoOperationRuntimeAuthorization ||
    null;
}

export function currentSandboxGovernance(call, request) {
  const runtimeAuthorization = runtimeAuthorizationFromCall(call);
  const approved = runtimeAuthorization?.approvedPendingOperation;
  const approvalExpiresAt = String(approved?.expiresAt || "").trim();
  const approvalCurrent = ["approved", "completed"].includes(String(approved?.status || "")) &&
    approved?.current === true && Number.isFinite(Date.parse(approvalExpiresAt)) &&
    Date.parse(approvalExpiresAt) > Date.now();
  const grantRef = String(runtimeAuthorization?.grant?.id || runtimeAuthorization?.grantRef || "").trim();
  const approvalRef = approvalCurrent ? String(approved?.pendingOperationId || "").trim() : "";
  const riskDecisionRef = String(runtimeAuthorization?.policy?.decisionId || "").trim();
  const policyRevisionValue = runtimeAuthorization?.policy?.governancePolicyRevision?.revision ??
    runtimeAuthorization?.grant?.metadata?.policyRevision ??
    runtimeAuthorization?.grant?.policyRevision ??
    "";
  const policyRevision = String(policyRevisionValue).trim();
  const authorized = runtimeAuthorization?.ok === true && Boolean(grantRef && riskDecisionRef && policyRevision);
  const approvalBindingDigest = approvalRef
    ? String(approved?.operationBinding?.bindingDigest || "").trim().toLowerCase()
    : "";
  const approvalSourceDigest = approvalRef
    ? createHash("sha256").update(canonicalPluginRequest(request || {})).digest("hex")
    : "";
  const authorizationContextDigest = authorized
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

function pluginGovernanceFacts(call = {}) {
  const runtimeAuthorization = runtimeAuthorizationFromCall(call);
  const base = currentSandboxGovernance(call);
  const grant = runtimeAuthorization?.grant || {};
  return {
    ...base,
    scopes: boundedCallStrings(grant.scopes || runtimeAuthorization?.scopes),
    toolsets: boundedCallStrings(grant.toolsets || runtimeAuthorization?.toolsets),
    toolAllow: boundedCallStrings(grant.toolAllow || runtimeAuthorization?.toolAllow),
    capabilities: boundedCallStrings(grant.capabilities || runtimeAuthorization?.capabilities),
    receiptDigest: boundedCallText(call.governanceReceipt?.receiptDigest, 128)
  };
}

function pluginApprovalFacts(call = {}) {
  const approved = runtimeAuthorizationFromCall(call)?.approvedPendingOperation;
  const binding = approved?.operationBinding;
  const resource = binding?.resource;
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

function pluginAuthFacts(call = {}) {
  const user = call.authSession?.user || {};
  const externalActor = call.request?.__licoExternalAuth?.actor || {};
  const actor = Object.keys(user).length > 0 ? user : externalActor;
  const opaqueExternalProjection = Object.keys(user).length === 0 &&
    externalActor.opaqueIdentityProjection === true;
  const subject = actor.subjectId || actor.userId || actor.id || "";
  const toolGrant = actor.type === "tool-grant" || actor.roleId === "tool-grant";
  const tenant = actor.tenantId || actor.organizationId || (toolGrant && subject ? `tool-grant:${subject}` : "");
  const device = actor.deviceId || actor.clientId || actor.endpointId || "";
  const workspace = call.context?.contributionRegistryWorkspaceId || actor.workspaceId || "";
  const projectIdentity = (value, namespace) => opaqueExternalProjection
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

export function pluginWorkspaceAuthority(call = {}) {
  const runtimeAuthorization = runtimeAuthorizationFromCall(call);
  const grant = runtimeAuthorization?.grant || {};
  const user = call.authSession?.user || {};
  const input = call.input || {};
  const workspaceRef = boundedCallText(
    input.workspaceId || input.workspaceRef || input.workspace || "",
    256
  );
  const allowedWorkspaceIds = new Set(boundedCallStrings(
    [
      ...(Array.isArray(grant.allowedWorkspaceIds) ? grant.allowedWorkspaceIds : []),
      ...(Array.isArray(user.allowedWorkspaceIds) ? user.allowedWorkspaceIds : []),
      ...(Array.isArray(user.workspaceIds) ? user.workspaceIds : [])
    ]
  ));
  const scopes = boundedCallStrings([...(user.scopes || []), ...(grant.scopes || [])], 512);
  const roleId = String(user.roleId || user.role || "").trim();
  const canAccessAll = roleId === "owner" || roleId === "admin" ||
    scopes.includes("auth:admin") || scopes.includes("workspace:admin");
  return {
    workspaceRef,
    authorized: Boolean(workspaceRef) && (canAccessAll || allowedWorkspaceIds.has(workspaceRef))
  };
}

export function pluginTraceFacts(call = {}) {
  const trace = call.request?.__licoTraceContext || {};
  return {
    traceRef: irreversibleCallDigest(trace.traceId || call.traceId, "plugin-call-trace"),
    requestRef: irreversibleCallDigest(
      trace.requestId || call.request?.__licoRequestId || call.requestId,
      "plugin-call-request"
    )
  };
}

function pluginSourceKey(call = {}) {
  const request = call.request || {};
  const source = call.sourceKey ||
    request.socket?.remoteAddress ||
    request.connection?.remoteAddress ||
    request.info?.remoteAddress ||
    "";
  return irreversibleCallDigest(source, "plugin-call-source");
}

function pluginDeadlineMs(call = {}) {
  const value = Number(call.deadlineMs ?? call.request?.deadlineMs);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : null;
}

function pluginConcurrencyFacts(call = {}) {
  const activeHttpRequests = Number(
    call.activeHttpRequests ?? call.request?.__licoActiveRequestCount
  );
  return {
    activeHttpRequests: Number.isSafeInteger(activeHttpRequests) && activeHttpRequests > 0
      ? Math.min(activeHttpRequests, 100_000)
      : 0
  };
}

export function deepFreezeSerializable(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeSerializable(entry);
  } else if (isPlainObject(value)) {
    for (const entry of Object.values(value)) deepFreezeSerializable(entry);
  }
  return Object.freeze(value);
}

export function canonicalPluginRequest(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalPluginRequest).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalPluginRequest(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function createPluginCallProjection(call = {}, { invocationAuthorization = "" } = {}) {
  const signal = call.signal || call.operationLock?.signal || null;
  const projection = JSON.parse(JSON.stringify({
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


export function custodyOwnerBinding(call) {
  const user = call?.authSession?.user || {};
  const subjectRef = String(
    call?.authSession?.subjectId ||
    call?.authSession?.userId ||
    call?.authSession?.user?.subjectId ||
    call?.authSession?.user?.userId ||
    call?.context?.subjectId ||
    ""
  ).trim();
  const explicitTenantRef = String(
    user.tenantId ||
    call?.context?.tenantId ||
    call?.context?.organizationId ||
    ""
  ).trim();
  const toolGrant = user.type === "tool-grant" || user.roleId === "tool-grant";
  const tenantRef = explicitTenantRef || (toolGrant && subjectRef ? `tool-grant:${subjectRef}` : "");
  const workspaceRef = String(
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
