import { SERVER_API_OPERATIONS } from "#meshrix/contracts/operations/operation-registry";
import { getRuntimeLogger } from "#meshrix/foundation/observability/runtime-logger";
import { createCapturedResponse, parseCapturedResult } from "./dispatch-operation-captured-response.mjs";
import { dispatchOperation } from "./dispatch-operation-core.mjs";
import { findHttpOperation } from "./dispatch-operation-input.mjs";
import { createOperationRouteIndex } from "../routing/operation-route-index.mjs";

export async function dispatchRegisteredHttpOperation({
  operations = SERVER_API_OPERATIONS,
  controllers,
  method,
  url,
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
  const match = findHttpOperation({
    operations,
    method,
    pathname: url.pathname,
    routeIndex
  });
  if (!match) {
    return false;
  }

  await dispatchOperation({
    operation: match.operation,
    controllers,
    request,
    response,
    requestBody,
    url,
    params: match.pathParams,
    transport: "http",
    method,
    authorizeOperation,
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

export async function dispatchInternalOperation({
  operations = SERVER_API_OPERATIONS,
  controllers,
  operationId,
  input = {},
  request = null,
  authSession = null,
  actor = { type: "system" },
  operationAuditStore = null,
  operationProofSubstrate = null,
  lockManager = null,
  concurrencyScope = "default",
  signal = null,
  logger = getRuntimeLogger(),
  routeIndex = null
} = {}) {
  const operation = (routeIndex || createOperationRouteIndex(operations, { strict: true }))
    .getOperationById(operationId);
  if (!operation) {
    throw new Error(`Internal operation not registered: ${operationId}`);
  }

  const captured = createCapturedResponse();
  const url = new URL(operation.http?.path || operation.rpc?.syntheticPath || `/internal/${operation.id}`, "http://127.0.0.1");
  await dispatchOperation({
    operation,
    controllers,
    request,
    response: captured,
    requestBody: Buffer.from(JSON.stringify(input || {}), "utf8"),
    url,
    input,
    transport: "internal",
    method: operation.http?.method || "POST",
    applyHttpQuery: false,
    authorizeOperation: null,
    operationAuditStore,
    operationProofSubstrate,
    lockManager,
    concurrencyScope,
    signal,
    logger,
    authSession,
    actor
  });

  return {
    operation,
    statusCode: captured.statusCode || 200,
    headers: captured.headers || {},
    payload: parseCapturedResult({ operation, captured })
  };
}
