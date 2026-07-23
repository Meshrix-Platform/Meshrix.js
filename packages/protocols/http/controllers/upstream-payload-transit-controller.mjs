import { pipeline } from "node:stream/promises";
import { contentDispositionHeader, sendJson } from "../http-utils.mjs";
import { mcpSubjectFromGrant } from "../../mcp/adapter/http-mcp-adapter-session.mjs";

const TRANSIT_ROUTE = /^\/api\/gateway\/v1\/transit\/([^/]+)\/([^/]+)$/u;
const ARTIFACT_ROUTE = /^\/api\/gateway\/v1\/artifacts\/([^/]+)$/u;

export function isUpstreamPayloadTransitRoute(method = "", pathname = "") {
  const normalizedMethod = String(method || "").toUpperCase();
  const normalizedPathname = String(pathname || "");
  if (normalizedMethod === "POST") return TRANSIT_ROUTE.test(normalizedPathname);
  return (normalizedMethod === "GET" || normalizedMethod === "HEAD") && ARTIFACT_ROUTE.test(normalizedPathname);
}

function decodeSegment(value = "") {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function operationById(operations = [], operationId = "") {
  return (Array.isArray(operations) ? operations : []).find((operation) => operation?.id === operationId) || null;
}

function subjectFromSession(session = null) {
  const user = session?.user || {};
  return {
    type: "console-user",
    subjectId: String(user.subjectId || user.userId || user.id || "").trim(),
    userId: String(user.userId || user.id || "").trim(),
    username: String(user.username || "").trim(),
    roleId: String(user.roleId || user.role || "").trim(),
    tenantId: String(user.tenantId || "").trim(),
    scopes: Array.isArray(user.scopes) ? user.scopes : []
  };
}

async function authorizeTransit({
  securityPermissions,
  toolSkillManagementProvider,
  request,
  operation,
  method,
  url,
  input
}) {
  const consoleAuthorization = await securityPermissions.authorizeOperation({
    request,
    operation,
    method,
    url,
    input
  });
  if (consoleAuthorization?.ok === true) {
    return { ok: true, subject: subjectFromSession(consoleAuthorization.session) };
  }
  if (typeof toolSkillManagementProvider?.authorizeRequest === "function") {
    const toolAuthorization = await toolSkillManagementProvider.authorizeRequest({
      request,
      requiredScopes: operation.requiredScopes || [],
      recordUse: true,
      requestBody: Buffer.alloc(0),
      url,
      method
    });
    if (toolAuthorization?.ok === true && toolAuthorization.grant) {
      return { ok: true, subject: mcpSubjectFromGrant(toolAuthorization.grant) };
    }
  }
  return {
    ok: false,
    status: Number(consoleAuthorization?.status || 401),
    error: consoleAuthorization?.error || "Authorization is required."
  };
}

function requestParameters(url) {
  const query = {};
  const pathParameters = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (key.startsWith("path.") && key.length > 5) pathParameters[key.slice(5)] = value;
    else if (Object.hasOwn(query, key)) query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
    else query[key] = value;
  }
  return { query, pathParameters };
}

function publicTransitError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  return {
    status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
    code: String(error?.reasonCode || error?.code || "payload_transit_failed")
  };
}

export async function handleUpstreamPayloadTransitRequest({
  request,
  response,
  method,
  url,
  operations,
  securityPermissions,
  toolSkillManagementProvider,
  upstreamGatewayRegistry,
  signal = null,
  onRequestBytes = null
} = {}) {
  const transitMatch = method === "POST" ? TRANSIT_ROUTE.exec(url.pathname) : null;
  const artifactMatch = ["GET", "HEAD"].includes(method) ? ARTIFACT_ROUTE.exec(url.pathname) : null;
  if (!transitMatch && !artifactMatch) return false;
  const operationId = transitMatch ? "gateway.payload.transit" : "gateway.artifacts.get";
  const operation = operationById(operations, operationId);
  if (!operation || !upstreamGatewayRegistry) {
    sendJson(response, 404, { error: "Gateway payload transit is unavailable." });
    return true;
  }
  const serviceId = transitMatch ? decodeSegment(transitMatch[1]) : "";
  const operationKey = transitMatch ? decodeSegment(transitMatch[2]) : "";
  const artifactId = artifactMatch ? decodeSegment(artifactMatch[1]) : "";
  if ((transitMatch && (!serviceId || !operationKey)) || (artifactMatch && !artifactId)) {
    sendJson(response, 400, { error: "Gateway payload route is invalid." });
    return true;
  }
  const authorization = await authorizeTransit({
    securityPermissions,
    toolSkillManagementProvider,
    request,
    operation,
    method,
    url,
    input: { serviceId, operationKey, artifactId }
  });
  if (!authorization.ok) {
    sendJson(response, authorization.status, { error: authorization.error });
    return true;
  }
  try {
    if (artifactMatch) {
      const download = await upstreamGatewayRegistry.openArtifactDownload({
        artifactId,
        range: request.headers.range || ""
      }, authorization.subject);
      response.writeHead(download.status, {
        ...download.headers,
        "content-disposition": contentDispositionHeader("attachment", download.name || "artifact.bin"),
        "cache-control": "private, no-store"
      });
      if (method === "HEAD") {
        download.body.destroy();
        response.end();
      } else {
        await pipeline(download.body, response, { signal });
      }
      return true;
    }
    const { query, pathParameters } = requestParameters(url);
    const contentLengthHeader = request.headers["content-length"];
    const contentLength = contentLengthHeader === undefined ? null : Number(contentLengthHeader);
    upstreamGatewayRegistry.previewHttpStream({
      serviceId,
      operationKey,
      requestHeaders: request.headers,
      contentLength
    }, authorization.subject);
    if (String(request.headers.expect || "").toLowerCase() === "100-continue") {
      response.writeContinue();
    }
    const result = await upstreamGatewayRegistry.forwardHttpStream({
      serviceId,
      operationKey,
      query,
      pathParameters,
      requestHeaders: request.headers,
      contentLength,
      requestStream: request
    }, authorization.subject, {
      signal,
      async consumeResponse(upstream) {
        response.writeHead(upstream.status, {
          ...upstream.headers,
          "cache-control": upstream.headers["cache-control"] || "no-store"
        });
        await pipeline(upstream.body, response, { signal: upstream.signal || signal });
      }
    });
    onRequestBytes?.(result.requestBytes);
    return true;
  } catch (error) {
    const failure = publicTransitError(error);
    if (!response.headersSent) {
      sendJson(response, failure.status, { error: "Gateway payload transit failed.", code: failure.code });
    } else if (!response.writableEnded) {
      response.destroy(error instanceof Error ? error : undefined);
    }
    return true;
  }
}
