import { apiCapabilityId } from "@meshrix/foundation/security/authorization/authorization-engine";
import {
  headerValue,
  isLocalMcpGrant,
  localMcpGrantTargets,
  redactedTraceRef,
  sourceIpFromRequest
} from "./store-utils.mjs";

export function createGrantProcessIdentityMethods(ctx, { appendGrantEvent }) {
  function appendSecurityAlert({
    category = "security",
    severity = "medium",
    reasonCode = "security_alert",
    title = "Security alert",
    grant = null,
    request = null,
    details = {}
  } = {}) {
    try {
      return ctx.getSecurityAlertStore().appendAlert({
        category,
        severity,
        reasonCode,
        title,
        actorRef: grant?.metadata?.clientId || grant?.metadata?.agentProfileId || "local-mcp-client",
        subjectRef: "local-mcp-grant",
        resourceRef: "mcp.request",
        sourceIp: sourceIpFromRequest(request),
        traceId: redactedTraceRef(request),
        details: {
          grantType: grant?.type || "",
          clientId: grant?.metadata?.clientId || "",
          targets: localMcpGrantTargets(grant || {}),
          userAgent: headerValue(request, "user-agent"),
          ...details
        }
      });
    } catch {
      return null;
    }
  }

  function recordMcpTargetBindingDenial({ grant, request, decision } = {}) {
    const sourceIp = sourceIpFromRequest(request);
    const userAgent = headerValue(request, "user-agent");
    const details = {
      reasonCode: decision.reasonCode || "mcp_target_binding_denied",
      requestedTarget: decision.requestedTarget || "",
      allowedTargets: decision.allowedTargets || [],
      sourceIp,
      userAgent
    };
    appendGrantEvent(grant.id, "mcp_target_binding_denied", details);
    ctx.appendMetric({
      traceId: request?.__licoTraceContext?.traceId || request?.__licoRequestId || "",
      toolId: "mcp.request",
      grantId: grant.id,
      profileId: grant.metadata?.agentProfileId || grant.metadata?.profileId || "",
      status: "denied",
      risk: "read_only",
      reasonCode: details.reasonCode
    });
    ctx.notifyChange({
      type: "mcp_target_binding_denied",
      grantId: grant.id,
      reasonCode: details.reasonCode,
      requestedTarget: details.requestedTarget,
      allowedTargets: details.allowedTargets
    });
    appendSecurityAlert({
      category: "mcp_client_identity",
      severity: "high",
      reasonCode: details.reasonCode,
      title: "Local MCP grant target binding denied",
      grant,
      request,
      details
    });
  }

  async function verifyLocalMcpProcessIdentity({
    grant,
    request,
    requestBody = Buffer.alloc(0),
    url = null,
    method = "GET"
  } = {}) {
    if (!isLocalMcpGrant(grant)) {
      return { ok: true, applicable: false, reasonCode: "not_local_mcp_grant" };
    }
    if (request?.__licoProcessIdentity?.ok === true) {
      return { ok: true, applicable: true, reasonCode: "process_identity_reused", verification: request.__licoProcessIdentity };
    }
    if (!ctx.securityPermissions || typeof ctx.securityPermissions.verifyProcessIdentity !== "function") {
      const decision = {
        ok: false,
        status: 503,
        reasonCode: "process_identity_unavailable",
        error: "Process identity verifier is unavailable."
      };
      appendSecurityAlert({
        category: "mcp_client_identity",
        severity: "critical",
        reasonCode: decision.reasonCode,
        title: "Local MCP grant process identity verifier unavailable",
        grant,
        request,
        details: { required: true }
      });
      return decision;
    }
    const requestUrl = url instanceof URL
      ? url
      : new URL(String(request?.url || "/mcp"), "http://127.0.0.1");
    const verification = await ctx.securityPermissions.verifyProcessIdentity({
      request,
      requestBody: Buffer.isBuffer(requestBody) ? requestBody : Buffer.from(String(requestBody || "")),
      url: requestUrl,
      method: String(method || request?.method || "GET").toUpperCase(),
      operation: {
        id: "mcp.request",
        processIdentity: {
          required: true,
          requiredCapabilities: [apiCapabilityId("mcp.request")]
        }
      }
    });
    if (verification.ok) {
      request.__licoProcessIdentity = verification;
      return {
        ok: true,
        applicable: true,
        reasonCode: verification.reasonCode || "process_identity_verified",
        verification
      };
    }
    appendGrantEvent(grant.id, "mcp_process_identity_denied", {
      reasonCode: verification.reasonCode || "process_identity_denied",
      status: verification.status || 401,
      clientId: headerValue(request, "x-meshrix-client-id"),
      packageId: headerValue(request, "x-meshrix-identity-package-id"),
      processKeyId: headerValue(request, "x-meshrix-process-key-id"),
      sourceIp: sourceIpFromRequest(request),
      userAgent: headerValue(request, "user-agent")
    });
    ctx.appendMetric({
      traceId: request?.__licoTraceContext?.traceId || request?.__licoRequestId || "",
      toolId: "mcp.request",
      grantId: grant.id,
      profileId: grant.metadata?.agentProfileId || grant.metadata?.profileId || "",
      status: "denied",
      risk: "read_only",
      reasonCode: verification.reasonCode || "process_identity_denied"
    });
    ctx.notifyChange({
      type: "mcp_process_identity_denied",
      grantId: grant.id,
      reasonCode: verification.reasonCode || "process_identity_denied"
    });
    appendSecurityAlert({
      category: "mcp_client_identity",
      severity: "critical",
      reasonCode: verification.reasonCode || "process_identity_denied",
      title: "Local MCP grant process identity denied",
      grant,
      request,
      details: {
        status: verification.status || 401,
        error: verification.error || "Process identity denied.",
        clientId: headerValue(request, "x-meshrix-client-id"),
        packageId: headerValue(request, "x-meshrix-identity-package-id"),
        processKeyId: headerValue(request, "x-meshrix-process-key-id")
      }
    });
    return verification;
  }

  return { recordMcpTargetBindingDenial, verifyLocalMcpProcessIdentity };
}
