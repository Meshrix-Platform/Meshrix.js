import { SERVER_API_OPERATIONS } from "#meshrix/contracts/operations/operation-registry";
import { getRuntimeLogger } from "#meshrix/foundation/observability/runtime-logger";
import { createCapturedResponse, parseCapturedResult } from "./dispatch-operation-captured-response.ts";
import { dispatchOperation } from "./dispatch-operation-core.ts";
import {
  findHttpOperation,
  invokeRegisteredOperation
} from "./dispatch-operation-input.ts";
import { createOperationRouteIndex } from "../routing/operation-route-index.ts";

const STARTUP_SNAPSHOT_OPERATIONS: Readonly<Record<string, any>> = Object.freeze({
  readSystemInterfaces: Object.freeze({
    operationId: "system.interfaces",
    errorMessage: "Failed to build system.interfaces startup snapshot."
  }),
  readDiscoveryConfig: Object.freeze({
    operationId: "discovery.get_config",
    errorMessage: "Failed to build discovery.get_config startup snapshot."
  }),
  readAgentSyncConfig: Object.freeze({
    operationId: "agent_sync.config.get",
    errorMessage: "Failed to build agent_sync.config.get startup snapshot."
  }),
  readConsoleState: Object.freeze({
    operationId: "system.console_state",
    errorMessage: "Failed to build system.console_state startup snapshot."
  }),
  readStorageSummary: Object.freeze({
    operationId: "storage.summary",
    errorMessage: "Failed to build storage.summary startup snapshot."
  })
});

export async function dispatchRegisteredHttpOperation({
  operations = SERVER_API_OPERATIONS,
  controllers,
  method,
  url,
  request,
  response,
  requestBody,
  authorizeOperation = null,
  resolveAuthorizationOperation = null,
  verifyProcessIdentity = null,
  operationAuditStore = null,
  operationProofSubstrate = null,
  lockManager = null,
  concurrencyScope = "default",
  signal = null,
  logger = getRuntimeLogger(),
  routeIndex = null
}: Record<string, any>) : Promise<any> {
  const match: any = findHttpOperation({
    operations,
    method,
    pathname: url.pathname,
    routeIndex
  });
  if (!match) {
    return false;
  }
  const liveOperationResolver: any = typeof resolveAuthorizationOperation === "function"
    ? resolveAuthorizationOperation
    : Array.isArray(operations)
      ? ({ operationId }: Record<string, any>) : any => operations.find(
          (candidate?: any) : any => candidate?.id === operationId
        ) || null
      : routeIndex
        ? ({ operationId }: Record<string, any>) : any => routeIndex.getOperationById(operationId) || null
      : null;

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
    resolveAuthorizationOperation: liveOperationResolver,
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

export function createStartupSnapshotPort({
  operations = SERVER_API_OPERATIONS,
  controllers,
  routeIndex = null
}: Record<string, any> = {}) : any {
  if (!controllers || typeof controllers !== "object") {
    throw new TypeError("Startup snapshot controllers are required.");
  }
  if (!routeIndex) {
    throw new TypeError("Startup snapshot port requires a route index snapshot.");
  }
  const operationIndex: any = routeIndex;

  async function readSnapshot({ operationId, errorMessage }: Record<string, any>) : Promise<any> {
    const operation: any = operationIndex.getOperationById(operationId);
    if (!operation) {
      throw new Error(`Startup snapshot operation not registered: ${operationId}`);
    }
    const captured: any = createCapturedResponse();
    const url: any = new URL(
      operation.http?.path || operation.rpc?.syntheticPath || `/startup-snapshot/${operation.id}`,
      "http://127.0.0.1"
    );
    await invokeRegisteredOperation({
      operation,
      controllers,
      request: null,
      response: captured,
      requestBody: Buffer.alloc(0),
      url,
      input: {},
      applyHttpQuery: false
    });
    const payload: any = parseCapturedResult({ operation, captured });
    const statusCode: any = captured.statusCode || 200;
    if (statusCode >= 400) {
      throw new Error(payload?.error || errorMessage);
    }
    return payload;
  }

  return Object.freeze(Object.fromEntries(
    (Object.entries(STARTUP_SNAPSHOT_OPERATIONS) as [string, any][]).map(([method, definition]: any[]) : any => [
      method,
      () : any => readSnapshot(definition)
    ])
  ));
}
