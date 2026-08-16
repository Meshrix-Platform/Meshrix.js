import { executeConsoleDomainOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executor.ts";
import { handleMeshrixMcpHttpRequest } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter.ts";

export function stableJson(value?: any) : any {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item?: any) : any => stableJson(item)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key?: any) : any => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requiredArray(schema: Record<string, any> = {}) : any {
  return Array.isArray(schema.required) ? schema.required.map(String) : [];
}

export async function callDownstreamMcp({ body, provider, upstreamGatewayRegistry, token }: Record<string, any>) : Promise<any> {
  const response: any = createMemoryResponse();
  const handled: any = await handleMeshrixMcpHttpRequest({
    request: {
      headers: { authorization: `Bearer ${token || "gateway-verifier"}` },
      socket: { remoteAddress: "127.0.0.1" },
      __meshrixRequestId: "gateway-verifier"
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

export function createVerifierSecurityPermissions() : any {
  return {
    evaluatePolicy({ tool = null, grant = null }: Record<string, any> = {}) : any {
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
    getGovernancePolicyRevision() : any {
      return createVerifierPolicyRevision();
    },
    appendDecision() : any {}
  };
}

export function createVerifierUpstreamGatewayOperationHandler({ userDataPath, upstreamGatewayRegistry = null }: Record<string, any>) : any {
  return async function handleVerifierUpstreamGatewayOperation({
    operation,
    request,
    requestBody,
    response,
    authSession,
    params = {}
  }: Record<string, any>) : Promise<any> {
    const input: Record<string, any> = {
      ...parseJsonObject(requestBody),
      ...(params && typeof params === "object" ? params : {})
    };
    const operationResult: any = await executeConsoleDomainOperation({
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

function createMemoryResponse() : any {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(chunk: any = "") : any {
      this.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      this.ended = true;
    }
  };
}

function parseJsonObject(value: any = Buffer.alloc(0)) : any {
  const raw: any = Buffer.isBuffer(value) ? value.toString("utf8").trim() : String(value || "").trim();
  if (!raw) return {};
  const parsed: any = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function sendJson(response?: any, status?: any, payload: Record<string, any> = {}) : any {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function createVerifierPolicyRevision() : any {
  return {
    protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
    revision: 1,
    updatedAt: "2000-01-01T00:00:00.000Z"
  };
}
