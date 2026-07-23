import { SERVER_API_OPERATIONS } from "#lico/contracts/operations/operation-registry";
import {
  validateInputSchema as validateGovernedInputSchema
} from "#lico/capabilities/operation-permission-core/runtime-schema";
import { coerceValue, parseJsonObject } from "./dispatch-operation-support.mjs";
import { createOperationRouteIndex } from "../routing/operation-route-index.mjs";
import { normalizeRoutingPathname } from "../routing/radix-path-trie.mjs";

const LOCAL_FORWARD_PREFIXES = [
  "/api/jobs",
  "/api/rpc",
  "/api/operation-permission",
  "/api/upload-sessions"
];

export function applyQueryParams(operation, url, params) {
  for (const queryParam of operation.http.query || []) {
    const rawValue = url.searchParams.get(queryParam.name);
    if (rawValue === null || rawValue === "") {
      continue;
    }
    params[queryParam.name] = rawValue;
  }
}

export function applyCoercion(operation, params) {
  for (const [key, type] of Object.entries(operation.http.coerce || {})) {
    if (params[key] !== undefined) {
      params[key] = coerceValue(params[key], type);
    }
  }
}

export function inputFromRequest({ operation, requestBody, url, params = {}, applyHttpQuery = true }) {
  const input = {
    ...(operation.http?.rawJsonBytes === true ? {} : parseJsonObject(requestBody)),
    ...(params && typeof params === "object" ? params : {})
  };
  if (applyHttpQuery) {
    for (const queryParam of operation.http?.query || operation.rpc?.query || []) {
      const rawValue = url?.searchParams?.get(queryParam.name);
      if (rawValue !== null && rawValue !== undefined && rawValue !== "") {
        input[queryParam.name] = rawValue;
      }
    }
  }
  return input;
}

export function validateInputSchema(operation, input = {}) {
  const validation = validateGovernedInputSchema(operation, input);
  return validation.ok ? validation : { ...validation, status: 400 };
}

export function findHttpOperation({
  operations = SERVER_API_OPERATIONS,
  method,
  pathname,
  routeIndex = null
}) {
  const match = (routeIndex || createOperationRouteIndex(operations, { strict: true }))
    .findHttpOperation(method, pathname);
  return match ? { operation: match.operation, pathParams: match.params } : null;
}

export function findRpcOperation({
  operations = SERVER_API_OPERATIONS,
  method,
  routeIndex = null
}) {
  return (routeIndex || createOperationRouteIndex(operations, { strict: true }))
    .findRpcOperation(method);
}

export function findProxyRegisteredApiRequest({
  method,
  pathname,
  discoveryState,
  operations = SERVER_API_OPERATIONS,
  routeIndex = null
}) {
  if (!discoveryState || discoveryState.mode !== "forward") {
    return null;
  }

  const normalizedPathname = normalizeRoutingPathname(pathname);
  if (!normalizedPathname || !normalizedPathname.startsWith("/api/")) {
    return null;
  }

  if (LOCAL_FORWARD_PREFIXES.some((prefix) => (
    normalizedPathname === prefix || normalizedPathname.startsWith(`${prefix}/`)
  ))) {
    return null;
  }

  if (!String(method || "").trim()) {
    return null;
  }
  const match = findHttpOperation({
    operations,
    method,
    pathname: normalizedPathname,
    routeIndex,
  });
  const operation = match?.operation || null;
  if (!operation || operation.http.localInForwardMode || operation.externalAuth === true) {
    return null;
  }

  const targetBaseUrl = String(
    discoveryState.forwardBaseUrl || discoveryState.activeServiceUrl || ""
  ).trim().replace(/\/+$/, "");
  if (!targetBaseUrl || targetBaseUrl === discoveryState.advertisedBaseUrl) {
    return null;
  }
  return {
    operation,
    pathParams: match.pathParams,
    targetBaseUrl
  };
}

export function shouldProxyRegisteredApiRequest(input = {}) {
  return Boolean(findProxyRegisteredApiRequest(input));
}

export async function invokeRegisteredOperation({
  operation,
  controllers,
  request,
  response,
  requestBody = Buffer.alloc(0),
  url,
  params = {},
  input = null,
  applyHttpQuery = true,
  authSession = null,
  operationLock = null,
  signal = null,
  governanceReceipt = null
}) {
  const controller = controllers[operation.target.controller];
  const handler = controller?.[operation.target.method];
  if (!handler) {
    throw new Error(`接口目标不存在：${operation.target.controller}.${operation.target.method}`);
  }

  const callParams = {
    operation,
    input: input && typeof input === "object" ? input : inputFromRequest({
      operation,
      requestBody,
      url,
      params,
      applyHttpQuery
    }),
    request,
    response,
    requestBody,
    url,
    authSession,
    params,
    governanceReceipt,
    ...params
  };
  if (applyHttpQuery) {
    applyQueryParams(operation, url, callParams);
  }
  applyCoercion(operation, callParams);
  if (operationLock) {
    callParams.operationLock = operationLock;
  }
  if (signal) {
    callParams.signal = signal;
  }
  await handler(callParams);
}
