import { SERVER_API_OPERATIONS } from "#meshrix/contracts/operations/operation-registry";
import { sendJson } from "#meshrix/foundation/http/http-response";
import { getRuntimeLogger, summarizeError, summarizeForLog } from "#meshrix/foundation/observability/runtime-logger";
import { createCapturedResponse, parseCapturedResult } from "./dispatch-operation-captured-response.mjs";
import { dispatchOperation } from "./dispatch-operation-core.mjs";
import { findRpcOperation, inputFromRequest } from "./dispatch-operation-input.mjs";
import { coerceValue, logOperation, requestIdFromRequest } from "./dispatch-operation-support.mjs";

export function toRequestBody(operation, params) {
  if (operation.http?.rawJsonBytes === true) {
    const hasText = Object.hasOwn(params, "bodyText");
    const hasBase64 = Object.hasOwn(params, "bodyBase64");
    if (hasText === hasBase64 || (hasText && typeof params.bodyText !== "string") ||
        (hasBase64 && (typeof params.bodyBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(params.bodyBase64)))) {
      const error = new Error("Raw JSON RPC operations require exactly one canonical bodyText or bodyBase64 carrier.");
      error.code = "rpc_raw_json_carrier_required";
      error.statusCode = 400;
      throw error;
    }
  }
  if (params.bodyBase64 !== undefined) {
    return Buffer.from(String(params.bodyBase64 || ""), "base64");
  }
  if (params.bodyText !== undefined) {
    return Buffer.from(String(params.bodyText || ""), "utf8");
  }
  const body =
    operation.rpc?.body === "params"
      ? params
      : params.body !== undefined
      ? params.body
      : params.payload !== undefined
        ? params.payload
        : undefined;
  if (body === undefined) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  return Buffer.from(JSON.stringify(body || {}), "utf8");
}

export function findParamValue(params, aliases) {
  return aliases.map((alias) => params[alias]).find(
    (item) => item !== undefined && item !== null && item !== ""
  );
}

export function buildRpcUrl(operation, params) {
  let pathname = operation.rpc?.syntheticPath || `/api/rpc/${operation.id}`;
  pathname = pathname.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    const param = (operation.rpc?.params || []).find((item) => item.name === name);
    const value = findParamValue(params, [name, ...(param?.aliases || [])]);
    if (value === undefined || value === null || value === "") {
      return `:${name}`;
    }
    return encodeURIComponent(String(value));
  });
  const url = new URL(pathname, "http://127.0.0.1");
  for (const queryParam of operation.rpc?.query || []) {
    const aliases = [queryParam.name, ...(queryParam.aliases || [])];
    const value = findParamValue(params, aliases);
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(queryParam.name, String(item));
      }
      continue;
    }
    url.searchParams.set(queryParam.name, String(value));
  }
  return url;
}

export function buildRpcTargetParams(operation, params) {
  const targetParams = {};
  for (const param of operation.rpc?.params || []) {
    const aliases = [param.name, ...(param.aliases || [])];
    const value = findParamValue(params, aliases);
    if ((value === undefined || value === null || value === "") && param.required) {
      throw new Error(`RPC 参数缺少 ${param.name}`);
    }
    if (value !== undefined && value !== null && value !== "") {
      targetParams[param.name] = coerceValue(value, param.type || "string");
    }
  }
  return targetParams;
}

export function rpcError(id, statusCode, message, data = {}) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: statusCode,
      message,
      data
    }
  };
}

export async function dispatchRpcOperation({
  operations = SERVER_API_OPERATIONS,
  controllers,
  request,
  response,
  requestBody,
  authorizeOperation = null,
  verifyProcessIdentity = null,
  operationAuditStore = null,
  operationProofSubstrate = null,
  lockManager = null,
  concurrencyScope = "default",
  signal = null,
  logger = getRuntimeLogger(),
  routeIndex = null
}) {
  let payload;
  try {
    payload = requestBody.length > 0 ? JSON.parse(requestBody.toString("utf8")) : {};
  } catch (error) {
    logOperation(logger, "warn", "operation.rpc.denied", {
      requestId: requestIdFromRequest(request),
      reason: "invalid-json",
      error: summarizeError(error)
    });
    // L-6: do not reflect error.message — it may contain position/context info
    sendJson(response, 400, rpcError(null, 400, "RPC 请求体必须是有效的 JSON。"));
    return;
  }

  const id = payload.id ?? null;
  const operation = findRpcOperation({ operations, method: payload.method, routeIndex });
  if (!operation) {
    logOperation(logger, "warn", "operation.rpc.denied", {
      requestId: requestIdFromRequest(request),
      reason: "unknown-method",
      method: payload.method || ""
    });
    sendJson(response, 404, rpcError(id, 404, "RPC 方法不存在。"));
    return;
  }

  const params = payload.params && typeof payload.params === "object" ? payload.params : {};
  const captured = createCapturedResponse();
  let dispatchResult = null;
  try {
    const rpcUrl = buildRpcUrl(operation, params);
    const targetParams = buildRpcTargetParams(operation, params);
    const targetRequestBody = toRequestBody(operation, params);
    const input = inputFromRequest({
      operation,
      requestBody: targetRequestBody,
      url: rpcUrl,
      params: operation.http?.rawJsonBytes === true ? targetParams : params,
      applyHttpQuery: false
    });
    dispatchResult = await dispatchOperation({
      operation,
      controllers,
      request,
      response: captured,
      requestBody: targetRequestBody,
      url: rpcUrl,
      params: targetParams,
      input,
      transport: "rpc",
      method: "POST",
      applyHttpQuery: false,
      authorizeOperation,
      verifyProcessIdentity,
      operationAuditStore,
      operationProofSubstrate,
      lockManager,
      concurrencyScope,
      signal,
      logger
    });
  } catch (error) {
    logOperation(logger, "error", "operation.rpc.failed", {
      requestId: requestIdFromRequest(request),
      rpcId: id,
      operationId: operation?.id || "",
      error: summarizeError(error)
    });
    const failureStatus = Number(error?.statusCode) === 400 ? 400 : 500;
    sendJson(
      response,
      200,
      rpcError(
        id,
        failureStatus,
        error?.code === "rpc_raw_json_carrier_required"
          ? "RPC 原始 JSON 操作必须使用唯一的 bodyText 或 bodyBase64。"
          : error instanceof Error && error.message.startsWith("RPC 参数缺少 ")
          ? error.message
          : "RPC 调用失败。"
      )
    );
    return;
  }

  const statusCode = captured.statusCode || 200;
  const result = parseCapturedResult({ operation, captured });
  logOperation(logger, statusCode >= 400 ? "warn" : "debug", "operation.rpc.completed", {
    requestId: requestIdFromRequest(request),
    rpcId: id,
    operationId: operation.id,
    statusCode,
    status: statusCode >= 400 ? "failed" : "ok",
    traceId: dispatchResult?.traceContext?.traceId || "",
    output: summarizeForLog(result, { maxDepth: 3, maxArrayItems: 5, maxObjectKeys: 30 })
  });
  if (statusCode >= 400) {
    sendJson(
      response,
      200,
      rpcError(id, statusCode, result?.error || `RPC 调用失败：${operation.rpc.method}`, result)
    );
    return;
  }

  sendJson(response, 200, {
    jsonrpc: "2.0",
    id,
    result
  });
}
