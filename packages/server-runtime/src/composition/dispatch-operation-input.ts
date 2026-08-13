import { SERVER_API_OPERATIONS } from "#meshrix/contracts/operations/operation-registry";
import {
  validateInputSchema as validateGovernedInputSchema
} from "#meshrix/capabilities/operation-permission-core/runtime-schema";
import { coerceValue, parseJsonObject } from "./dispatch-operation-support.ts";
import { createOperationRouteIndex } from "../routing/operation-route-index.ts";
import { normalizeRoutingPathname } from "../routing/radix-path-trie.ts";

const LOCAL_FORWARD_PREFIXES: any[] = [
  "/api/jobs",
  "/api/rpc",
  "/api/operation-permission",
  "/api/upload-sessions"
];

export function applyQueryParams(operation?: any, url?: any, params?: any) : any {
  for (const queryParam of operation.http.query || []) {
    const rawValue: any = url.searchParams.get(queryParam.name);
    if (rawValue === null || rawValue === "") {
      continue;
    }
    params[queryParam.name] = rawValue;
  }
}

export function applyCoercion(operation?: any, params?: any) : any {
  for (const [key, type] of (Object.entries(operation.http.coerce || {}) as [string, any][])) {
    if (params[key] !== undefined) {
      params[key] = coerceValue(params[key], type);
    }
  }
}

export function inputFromRequest({ operation, requestBody, url, params = {}, applyHttpQuery = true }: Record<string, any>) : any {
  const input: Record<string, any> = {
    ...(operation.http?.rawJsonBytes === true ? {} : parseJsonObject(requestBody)),
    ...(params && typeof params === "object" ? params : {})
  };
  if (applyHttpQuery) {
    for (const queryParam of operation.http?.query || operation.rpc?.query || []) {
      const rawValue: any = url?.searchParams?.get(queryParam.name);
      if (rawValue !== null && rawValue !== undefined && rawValue !== "") {
        input[queryParam.name] = rawValue;
      }
    }
  }
  return input;
}

export function validateInputSchema(operation?: any, input: Record<string, any> = {}) : any {
  const validation: any = validateGovernedInputSchema(operation, input);
  return validation.ok ? validation : { ...validation, status: 400 };
}

export function findHttpOperation({
  operations = SERVER_API_OPERATIONS,
  method,
  pathname,
  routeIndex = null
}: Record<string, any>) : any {
  if (!routeIndex) {
    return null;
  }
  const match: any = routeIndex.findHttpOperation(method, pathname);
  return match ? { operation: match.operation, pathParams: match.params } : null;
}

export function findRpcOperation({
  operations = SERVER_API_OPERATIONS,
  method,
  routeIndex = null
}: Record<string, any>) : any {
  return routeIndex ? routeIndex.findRpcOperation(method) : null;
}

export function findProxyRegisteredApiRequest({
  method,
  pathname,
  discoveryState,
  operations = SERVER_API_OPERATIONS,
  routeIndex = null
}: Record<string, any>) : any {
  if (!discoveryState || discoveryState.mode !== "forward") {
    return null;
  }

  const normalizedPathname: any = normalizeRoutingPathname(pathname);
  if (!normalizedPathname || !normalizedPathname.startsWith("/api/")) {
    return null;
  }

  if (LOCAL_FORWARD_PREFIXES.some((prefix?: any) : any => (
    normalizedPathname === prefix || normalizedPathname.startsWith(`${prefix}/`)
  ))) {
    return null;
  }

  if (!String(method || "").trim()) {
    return null;
  }
  const match: any = findHttpOperation({
    operations,
    method,
    pathname: normalizedPathname,
    routeIndex,
  });
  const operation: any = match?.operation || null;
  if (!operation || operation.http.localInForwardMode || operation.externalAuth === true) {
    return null;
  }

  const targetBaseUrl: any = String(
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

export function shouldProxyRegisteredApiRequest(input: Record<string, any> = {}) : any {
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
  finalProtectedSinkPermit = null
}: Record<string, any>) : Promise<any> {
  const controller: any = controllers[operation.target.controller];
  const handler: any = controller?.[operation.target.method];
  if (!handler) {
    throw new Error(`接口目标不存在：${operation.target.controller}.${operation.target.method}`);
  }

  const callParams: Record<string, any> = {
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
    finalProtectedSinkPermit,
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
