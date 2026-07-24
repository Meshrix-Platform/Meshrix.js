import { executeConsoleDomainOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executor.mjs";
import { handleLicoMcpHttpRequest } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter.mjs";

export function stableJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requiredArray(schema = {}) {
  return Array.isArray(schema.required) ? schema.required.map(String) : [];
}

export async function callDownstreamMcp({ body, provider, upstreamGatewayRegistry, token }) {
  const response = createMemoryResponse();
  const handled = await handleLicoMcpHttpRequest({
    request: {
      headers: { authorization: `Bearer ${token || "gateway-verifier"}` },
      socket: { remoteAddress: "127.0.0.1" },
      __licoRequestId: "gateway-verifier"
    },
    response,
    requestBody: Buffer.from(JSON.stringify(body), "utf8"),
    method: "POST",
    url: new URL("/mcp", "http://127.0.0.1"),
    toolSkillManagementProvider: provider,
    upstreamGatewayRegistry,
    listenUrl: "http://127.0.0.1:7331",
    discoveryState: null
  });
  return {
    handled,
    statusCode: response.statusCode,
    payload: response.body ? JSON.parse(response.body) : null
  };
}

export function createVerifierSecurityPermissions() {
  return {
    evaluatePolicy({ tool = null, grant = null } = {}) {
      return {
        effect: "allow",
        allowed: true,
        reasonCode: "gateway_verifier_allowed",
        redactedReason: "Allowed by gateway verifier policy.",
        missingScopes: [],
        missingToolsets: [],
        missingCapabilities: [],
        evaluatedLayers: ["gateway_verifier"],
        createdAt: new Date().toISOString(),
        subject: grant
          ? { type: "tool-grant", subjectId: grant.id, scopes: grant.scopes || [] }
          : { type: "verifier", subjectId: "gateway-verifier" },
        resource: {
          toolId: tool?.id || "",
          operationId: tool?.operationId || ""
        },
        effectivePolicySnapshot: {
          policyRevision: createVerifierPolicyRevision()
        }
      };
    },
    getGovernancePolicyRevision() {
      return createVerifierPolicyRevision();
    },
    appendDecision() {}
  };
}

export function createVerifierUpstreamGatewayOperationHandler({ userDataPath, upstreamGatewayRegistry = null }) {
  return async function handleVerifierUpstreamGatewayOperation({
    operation,
    request,
    requestBody,
    response,
    authSession,
    params = {}
  }) {
    const input = {
      ...parseJsonObject(requestBody),
      ...(params && typeof params === "object" ? params : {})
    };
    const operationResult = await executeConsoleDomainOperation({
      operationId: operation?.id || "gateway.operation",
      input,
      context: {
        userDataPath,
        authSession,
        request,
        ...(upstreamGatewayRegistry ? { upstreamGatewayRegistry } : {})
      }
    });
    sendJson(response, operationResult.status || 500, operationResult.payload || {});
  };
}

function createMemoryResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(chunk = "") {
      this.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      this.ended = true;
    }
  };
}

function parseJsonObject(value = Buffer.alloc(0)) {
  const raw = Buffer.isBuffer(value) ? value.toString("utf8").trim() : String(value || "").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function sendJson(response, status, payload = {}) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function createVerifierPolicyRevision() {
  return {
    protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
    revision: 1,
    updatedAt: new Date().toISOString()
  };
}
