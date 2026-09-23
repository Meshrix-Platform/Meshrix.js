import { executeConsoleDomainOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executor.ts";
import { createPlatformMcpGateway } from "../../../packages/server-runtime/src/composition/gateway-composition.ts";
import { mcpModernHttpRequest } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-client-wire.ts";

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
  const wire: any = mcpModernHttpRequest(body, {
    authorization: `Bearer ${token || "gateway-verifier"}`
  });
  const platform = createPlatformMcpGateway({
    toolSkillManagementProvider: provider,
    upstreamGatewayRegistry
  });
  await platform.gateway.start();
  try {
    const handled: any = await platform.adapter.handle({
      method: "POST",
      headers: wire.headers,
      body: wire.message,
      rawRequest: {
        method: "POST",
        headers: wire.headers,
        socket: { remoteAddress: "127.0.0.1" },
        __meshrixRequestId: "gateway-verifier"
      },
      requestBody: Buffer.from(wire.body, "utf8"),
      url: new URL("/mcp", "http://127.0.0.1")
    } as any);
    return {
      handled,
      statusCode: handled.status,
      payload: handled.body || null
    };
  } finally {
    await platform.close();
  }
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
