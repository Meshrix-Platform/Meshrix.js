import { apiCapabilityId } from "@meshrix/foundation/security/authorization/authorization-engine";

const MXAK1_CREDENTIAL_PATTERN: any = /^mxak1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;

const PROCESS_IDENTITY_HEADERS: readonly string[] = Object.freeze([
  "x-meshrix-client-id",
  "x-meshrix-identity-package-id",
  "x-meshrix-process-key-id",
  "x-meshrix-timestamp",
  "x-meshrix-nonce",
  "x-meshrix-body-sha256",
  "x-meshrix-client-fingerprint-id",
  "x-meshrix-machine-instance-id",
  "x-meshrix-app-instance-id",
  "x-meshrix-runtime-instance-id",
  "x-meshrix-client-fingerprint-hash",
  "x-meshrix-signature",
  "x-meshrix-capability-key"
]);

function headerEntries(request: any = null, name: any = "") : any[] {
  const lowerName: any = String(name || "").toLowerCase();
  return (Object.entries(request?.headers || {}) as [string, any][])
    .filter(([candidate]: any[]) : any => String(candidate || "").toLowerCase() === lowerName)
    .flatMap(([, raw]: any[]) : any => Array.isArray(raw) ? raw : [raw]);
}

function rawHeader(request: any = null, name: any = "") : any {
  const values: any[] = headerEntries(request, name);
  return values.length === 1 ? String(values[0] ?? "") : "";
}

function header(request: any = null, name: any = "") : any {
  const raw: any = rawHeader(request, name);
  if (Array.isArray(raw)) {
    return raw.length === 1 ? String(raw[0] || "").trim() : "";
  }
  return String(raw || "").trim();
}

function repeatedHeader(request: any = null, name: any = "") : any {
  return headerEntries(request, name).length > 1;
}

function denial(status: any, reasonCode: any, error: any) : any {
  return { handled: true, ok: false, status, reasonCode, error };
}

async function verifiedProcessIdentity({
  request,
  requestBody,
  url,
  method,
  securityPermissions
}: Record<string, any>) : Promise<any> {
  const supplied: any = PROCESS_IDENTITY_HEADERS.some((name?: any) : any => headerEntries(request, name).length > 0);
  if (!supplied) return { ok: true, evidence: null };
  if (PROCESS_IDENTITY_HEADERS.some((name?: any) : any => repeatedHeader(request, name))) {
    return denial(400, "api_key_process_identity_ambiguous", "API key process identity headers are ambiguous.");
  }
  if (typeof securityPermissions?.verifyProcessIdentity !== "function") {
    return denial(503, "api_key_authority_unavailable", "API key process identity verification is unavailable.");
  }
  let verification: any;
  try {
    verification = await securityPermissions.verifyProcessIdentity({
      request,
      requestBody: Buffer.isBuffer(requestBody) ? requestBody : Buffer.from(String(requestBody || "")),
      url: url instanceof URL ? url : new URL(String(request?.url || "/mcp"), "http://127.0.0.1"),
      method: String(method || request?.method || "GET").toUpperCase(),
      operation: {
        id: "mcp.request",
        processIdentity: { required: true, requiredCapabilities: [apiCapabilityId("mcp.request")] }
      }
    });
  } catch {
    return denial(401, "api_key_process_identity_required", "API key process identity verification failed.");
  }
  if (!verification?.ok) {
    return denial(
      verification?.status || 401,
      verification?.reasonCode || "api_key_process_identity_required",
      verification?.error || "API key process identity verification failed."
    );
  }
  request.__meshrixProcessIdentity = verification;
  return {
    ok: true,
    evidence: {
      ...verification,
      publicKeyFingerprint: String(
        verification.publicKeyFingerprint ||
        verification.client?.processPublicKeyHash ||
        ""
      )
    }
  };
}

export function isStrictMcpApiKey(value: any = "") : any {
  return MXAK1_CREDENTIAL_PATTERN.test(String(value || ""));
}

export async function authenticateMcpApiKey({
  request,
  requestBody = Buffer.alloc(0),
  url = null,
  method = "GET",
  apiKeyDistributionProvider = null,
  securityPermissions = null
}: Record<string, any> = {}) : Promise<any> {
  const authorizationHeader: any = header(request, "authorization");
  const bearerCredential: any = authorizationHeader.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim() || "";
  const toolToken: any = header(request, "x-meshrix-tool-token");
  const apiKey: any = rawHeader(request, "x-meshrix-api-key");
  const credentialKinds: any = [Boolean(authorizationHeader), Boolean(toolToken), Boolean(apiKey)].filter(Boolean).length;

  if (["authorization", "x-meshrix-tool-token", "x-meshrix-api-key"].some((name?: any) : any => repeatedHeader(request, name)) || credentialKinds > 1) {
    return denial(400, "mcp_credential_ambiguous", "MCP request contains multiple credential kinds.");
  }
  if (isStrictMcpApiKey(bearerCredential) || isStrictMcpApiKey(toolToken)) {
    return denial(401, "api_key_wrong_auth_scheme", "API keys must use X-Meshrix-Api-Key.");
  }
  if (!apiKey) return { handled: false };
  if (!isStrictMcpApiKey(apiKey)) {
    const reasonCode: any = apiKey.trim().startsWith("mxak1.") ? "api_key_invalid" : "api_key_legacy_grant_rejected";
    return denial(401, reasonCode, "X-Meshrix-Api-Key accepts only a valid mxak1 credential.");
  }
  if (typeof apiKeyDistributionProvider?.authenticateRuntime !== "function") {
    return denial(503, "api_key_authority_unavailable", "API key authorization is unavailable.");
  }

  const identity: any = await verifiedProcessIdentity({ request, requestBody, url, method, securityPermissions });
  if (!identity.ok) return identity;
  try {
    const authorization: any = await apiKeyDistributionProvider.authenticateRuntime({
      credential: apiKey,
      serverAudience: header(request, "host"),
      targetId: header(request, "x-meshrix-mcp-target"),
      connectorPackageId: header(request, "x-meshrix-connector-package-id") || null,
      processIdentityEvidence: identity.evidence
    });
    if (!authorization ||
      authorization.credentialKind !== "scoped_api_key" ||
      !authorization.keyId ||
      !authorization.workloadPrincipalId ||
      !authorization.organizationNodeId ||
      !Number.isSafeInteger(authorization.lifecycleRevision) ||
      !authorization.policyFingerprint ||
      !authorization.policy ||
      typeof authorization.policy !== "object" ||
      Array.isArray(authorization.policy)) {
      return denial(503, "api_key_authority_unavailable", "API key authorization returned an invalid context.");
    }
    const apiKeyAuthorization: any = Object.freeze({
      credentialKind: "scoped_api_key",
      keyId: String(authorization.keyId),
      workloadPrincipalId: String(authorization.workloadPrincipalId),
      organizationNodeId: String(authorization.organizationNodeId),
      lifecycleRevision: authorization.lifecycleRevision,
      policyFingerprint: String(authorization.policyFingerprint),
      policy: authorization.policy,
      processIdentity: authorization.processIdentity || null,
      credentialFingerprint: String(authorization.credentialFingerprint || "")
    });
    return {
      handled: true,
      ok: true,
      status: 200,
      credentialKind: "scoped_api_key",
      apiKeyAuthorization,
      processIdentity: authorization.processIdentity || null
    };
  } catch (error: any) {
    return denial(
      Number(error?.status || error?.statusCode || 401),
      String(error?.reasonCode || error?.code || "api_key_invalid"),
      String(error?.publicMessage || "API key authorization failed.")
    );
  }
}
