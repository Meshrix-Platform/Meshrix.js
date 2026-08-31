import { randomBytes } from "node:crypto";

import {
  PLUGIN_CONSOLE_ISOLATION_BRIDGE_VERSION,
  PLUGIN_CONSOLE_ISOLATION_MAX_ASSET_BYTES,
  PLUGIN_CONSOLE_ISOLATION_MAX_REQUEST_BYTES
} from "@meshrix/foundation/module-system/plugin-console-isolation";
import { dispatchOperation } from "#meshrix/server-runtime/composition/dispatch-operation";
import {
  createPluginConsoleSandboxDocument
} from "@meshrix/server-runtime/composition/plugin-console-sandbox-document";
import { sendJson } from "#meshrix/http-utils";

const CONSOLE_SANDBOX_PREFIX: any = "/api/plugins/v1/console-sandboxes/";
const CONSOLE_BRIDGE_PREFIX: any = "/api/plugins/v1/console-bridges/";

function hasRequiredScopes(session?: any, requiredScopes?: any) : any {
  const available: any = new Set<any>(session?.user?.scopes || []);
  return requiredScopes.every((scope?: any) : any => available.has(scope));
}

function currentEntry({ request, response, consoleAuth, pluginContributions, pathname }: Record<string, any>) : any {
  const entry: any = pluginContributions?.getConsoleSandboxEntry?.(pathname) || null;
  if (!entry) {
    sendJson(response, 404, { error: "Plugin console sandbox is unavailable." });
    return null;
  }
  const session: any = consoleAuth?.getSessionFromRequest?.(request) || null;
  if (!session) {
    sendJson(response, 401, { error: "Authentication required." });
    return null;
  }
  if (!hasRequiredScopes(session, entry.requiredScopes)) {
    sendJson(response, 403, { error: "Plugin console sandbox access denied." });
    return null;
  }
  return Object.freeze({ entry, session });
}

function bridgeEntry({ request, response, consoleAuth, pluginContributions, pathname, toolId }: Record<string, any>) : any {
  const invocation: any = pluginContributions?.resolveConsoleBridgeInvocation?.(pathname, toolId) || null;
  if (!invocation) {
    sendJson(response, 404, { error: "Plugin console bridge is unavailable." });
    return null;
  }
  const session: any = consoleAuth?.getSessionFromRequest?.(request) || null;
  if (!session) {
    sendJson(response, 401, { error: "Authentication required." });
    return null;
  }
  if (!hasRequiredScopes(session, invocation.entry.requiredScopes)) {
    sendJson(response, 403, { error: "Plugin console bridge access denied." });
    return null;
  }
  return Object.freeze({ ...invocation, session });
}

function parseBridgeEnvelope(requestBody?: any) : any {
  if (!Buffer.isBuffer(requestBody) || requestBody.length <= 0 || requestBody.length > PLUGIN_CONSOLE_ISOLATION_MAX_REQUEST_BYTES) {
    return null;
  }
  try {
    const value: any = JSON.parse(requestBody.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const allowed: any = new Set<any>([
      "bridgeVersion",
      "pluginId",
      "componentId",
      "artifactDigest",
      "artifactGeneration",
      "route",
      "toolId",
      "payload"
    ]);
    if (Object.keys(value).some((field?: any) : any => !allowed.has(field))) return null;
    if (!value.route || typeof value.route !== "object" || Array.isArray(value.route)) return null;
    if (Object.keys(value.route).some((field?: any) : any => !new Set<any>(["path", "viewKey"]).has(field))) return null;
    return value;
  } catch {
    return null;
  }
}

function envelopeMatchesEntry(envelope?: any, entry?: any) : any {
  const routePath: any = String(envelope?.route?.path || "").split(/[?#]/u)[0];
  const viewKey: any = String(envelope?.route?.viewKey || "");
  return envelope?.bridgeVersion === PLUGIN_CONSOLE_ISOLATION_BRIDGE_VERSION &&
    envelope.pluginId === entry.pluginId &&
    envelope.componentId === entry.componentId &&
    envelope.artifactDigest === entry.artifactDigest &&
    envelope.artifactGeneration === entry.artifactGeneration &&
    (entry.routePath ? routePath === entry.routePath : viewKey === entry.viewKey);
}

async function servePluginConsoleSandbox({
  request,
  response,
  method,
  url,
  consoleAuth,
  pluginContributions
}: Record<string, any>) : Promise<any> {
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendJson(response, 405, { error: "Method not allowed." });
    return true;
  }
  const admission: any = currentEntry({
    request,
    response,
    consoleAuth,
    pluginContributions,
    pathname: url.pathname
  });
  if (!admission) return true;
  let asset: any;
  try {
    asset = await pluginContributions.readConsoleSandbox(url.pathname);
  } catch {
    asset = null;
  }
  if (!asset || asset.entry.artifactDigest !== admission.entry.artifactDigest ||
      asset.entry.artifactGeneration !== admission.entry.artifactGeneration ||
      asset.entry.pluginId !== admission.entry.pluginId ||
      asset.bytes.length <= 0 || asset.bytes.length > PLUGIN_CONSOLE_ISOLATION_MAX_ASSET_BYTES) {
    sendJson(response, 404, { error: "Plugin console sandbox is unavailable." });
    return true;
  }
  const nonce: any = randomBytes(18).toString("base64");
  const document: any = createPluginConsoleSandboxDocument({
    source: asset.bytes.toString("utf8"),
    componentId: admission.entry.componentId,
    nonce,
    bridgeVersion: admission.entry.bridgeVersion
  });
  const bytes: any = Buffer.from(document.html, "utf8");
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Length", String(bytes.length));
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Security-Policy", document.csp);
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (method === "HEAD") response.end();
  else response.end(bytes);
  return true;
}

async function invokePluginConsoleBridge({
  request,
  response,
  requestBody,
  method,
  url,
  consoleAuth,
  pluginContributions,
  requestOperations,
  controllers,
  authorizeOperation,
  verifyProcessIdentity,
  operationAuditStore,
  operationProofSubstrate,
  lockManager,
  concurrencyScope,
  signal,
  logger
}: Record<string, any>) : Promise<any> {
  if (method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Method not allowed." });
    return true;
  }
  const envelope: any = parseBridgeEnvelope(requestBody);
  if (!envelope) {
    sendJson(response, 400, { error: "Plugin console bridge request is invalid." });
    return true;
  }
  const invocation: any = bridgeEntry({
    request,
    response,
    consoleAuth,
    pluginContributions,
    pathname: url.pathname,
    toolId: envelope.toolId
  });
  if (!invocation) return true;
  if (!envelopeMatchesEntry(envelope, invocation.entry)) {
    sendJson(response, 409, { error: "Plugin console bridge authority changed." });
    return true;
  }
  const operations: any[] = Array.isArray(requestOperations) ? requestOperations : [];
  const operation: any = operations.find((candidate?: any) : any => (
    candidate.id === invocation.operationId && candidate.pluginId === invocation.entry.pluginId
  )) || null;
  if (!operation) {
    sendJson(response, 404, { error: "Plugin console tool is unavailable." });
    return true;
  }
  await dispatchOperation({
    operation,
    controllers,
    request,
    response,
    requestBody,
    url,
    input: envelope.payload ?? {},
    transport: "plugin-console",
    method,
    authorizeOperation,
    resolveAuthorizationOperation: ({ operationId }: Record<string, any>) : any => (
      operations.find((candidate?: any) : any => candidate.id === operationId) || null
    ),
    verifyProcessIdentity,
    operationAuditStore,
    operationProofSubstrate,
    lockManager,
    concurrencyScope,
    signal,
    logger
  });
  return true;
}

export async function handlePluginConsoleRequest(input: Record<string, any> = {}) : Promise<any> {
  const pathname: any = String(input.url?.pathname || "");
  if (pathname.startsWith(CONSOLE_SANDBOX_PREFIX)) return servePluginConsoleSandbox(input);
  if (pathname.startsWith(CONSOLE_BRIDGE_PREFIX)) return invokePluginConsoleBridge(input);
  return false;
}

export {
  CONSOLE_BRIDGE_PREFIX,
  CONSOLE_SANDBOX_PREFIX
};
