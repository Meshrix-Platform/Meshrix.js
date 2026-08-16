import {
  MODEL_GATEWAY_ADAPTER_CONFIG_SCHEMA,
  assertModelGatewayAdapterConfig,
  assertModelGatewayCallRequest
} from "@meshrix/contracts/model-gateway";

import {
  MODEL_GATEWAY_MCP_TOOL_BINDINGS,
  MODEL_GATEWAY_OPERATION_DEFINITIONS
} from "./src/operation-definitions.mjs";

const CONTRIBUTION_KINDS = Object.freeze([
  "operations",
  "routes",
  "mcpTools",
  "consoleEntries",
  "stateMachines",
  "verifierHooks"
]);

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyFields(value, fields) {
  return plainObject(value) && Object.keys(value).every((field) => fields.has(field));
}

function emptyContributions() {
  return Object.freeze(Object.fromEntries(CONTRIBUTION_KINDS.map((kind) => [kind, Object.freeze({})])));
}

export function validateModelGatewayConfiguration(configuration = {}) {
  return assertModelGatewayAdapterConfig({
    schemaVersion: MODEL_GATEWAY_ADAPTER_CONFIG_SCHEMA,
    ...configuration
  });
}

function currentCall(call = {}) {
  return call?.auth?.authenticated === true && call?.governance?.authorized === true &&
    call?.governance?.current === true && call?.governance?.revoked !== true;
}

function failure(code, statusCode = 502) {
  return Object.freeze({
    statusCode,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: Object.freeze({ ok: false, error: Object.freeze({ code }) })
  });
}

function normalizeOperationInput(operationId, input, configuration) {
  if (operationId === "model_gateway.call") {
    if (!onlyFields(input, new Set(["modelRef", "providerRef", "inputRefs", "idempotencyKey", "deadlineMs", "stream"]))) {
      throw new TypeError("model_gateway_call_closed_schema");
    }
    const request = assertModelGatewayCallRequest({
      operationId,
      serviceRef: configuration.serviceRef,
      ...input
    });
    return Object.freeze({
      input: Object.freeze({
        modelRef: request.modelRef,
        providerRef: request.providerRef,
        inputRefs: request.inputRefs,
        idempotencyKey: request.idempotencyKey,
        deadlineMs: request.deadlineMs,
        stream: request.stream
      }),
      idempotencyKey: request.idempotencyKey,
      timeoutMs: Math.min(configuration.timeoutMs, request.deadlineMs)
    });
  }
  if (operationId === "models.list") {
    if (!onlyFields(input, new Set())) throw new TypeError("model_gateway_models_list_closed_schema");
    return Object.freeze({ input: Object.freeze({}), idempotencyKey: "", timeoutMs: configuration.timeoutMs });
  }
  if (operationId === "models.get") {
    if (!onlyFields(input, new Set(["modelRef"]))) throw new TypeError("model_gateway_models_get_closed_schema");
    const modelRef = typeof input.modelRef === "string" ? input.modelRef.trim() : "";
    if (!modelRef || modelRef.length > 256) throw new TypeError("model_gateway_model_ref_invalid");
    return Object.freeze({ input: Object.freeze({ modelRef }), idempotencyKey: "", timeoutMs: configuration.timeoutMs });
  }
  throw new TypeError("model_gateway_operation_unknown");
}

function projectResponse(response) {
  if (!plainObject(response) || typeof response.ok !== "boolean") {
    return failure("model_gateway_response_invalid");
  }
  const statusCode = Number(response.status ?? response.statusCode ?? 502);
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    return failure("model_gateway_response_invalid");
  }
  if (response.ok !== true) {
    const code = statusCode === 403
      ? "model_gateway_denied"
      : statusCode === 429
        ? "model_gateway_rate_limited"
        : statusCode === 503
          ? "model_gateway_unavailable"
          : "model_gateway_request_failed";
    return failure(code, statusCode);
  }
  return Object.freeze({
    statusCode,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: response.data ?? null
  });
}

export async function activatePlugin({ manifest, context = {} } = {}) {
  if (manifest?.id !== "model-gateway") {
    throw new TypeError("Model Gateway requires the model-gateway manifest.");
  }
  const suppliedConfiguration = context.configuration;
  const configuration = validateModelGatewayConfiguration(
    plainObject(suppliedConfiguration) && Object.keys(suppliedConfiguration).length > 0
      ? suppliedConfiguration
      : { enabled: false, serviceRef: null, timeoutMs: 30_000 }
  );
  if (!configuration.enabled) {
    let closed = false;
    return Object.freeze({
      id: manifest.id,
      mounts: Object.freeze({}),
      contributions: emptyContributions(),
      close() {
        const alreadyClosed = closed;
        closed = true;
        return Promise.resolve(Object.freeze({ ok: true, alreadyClosed }));
      }
    });
  }

  let accepting = true;
  const active = new Set();
  const operations = {};
  for (const definition of MODEL_GATEWAY_OPERATION_DEFINITIONS) {
    operations[definition.id] = Object.freeze({
      definition,
      requiredHostPorts: Object.freeze(["externalService"]),
      execute({ input = {}, call = {}, signal = null, host = {} } = {}) {
        if (!accepting) return Promise.resolve(failure("model_gateway_adapter_closed", 503));
        if (!currentCall(call)) return Promise.resolve(failure("model_gateway_operation_denied", 403));
        if (typeof host.externalService?.request !== "function") {
          return Promise.resolve(failure("model_gateway_service_unavailable", 503));
        }
        let normalized;
        try {
          normalized = normalizeOperationInput(definition.id, input, configuration);
        } catch {
          return Promise.resolve(failure("model_gateway_input_invalid", 400));
        }
        const task = Promise.resolve(host.externalService.request({
          serviceRef: configuration.serviceRef,
          operationRef: definition.id,
          input: normalized.input,
          ...(normalized.idempotencyKey ? { idempotencyKey: normalized.idempotencyKey } : {}),
          timeoutMs: normalized.timeoutMs
        }, { signal })).then(projectResponse).catch((error) => {
          const status = signal?.aborted ? 499 : Number(error?.status ?? 502);
          return failure(
            status === 499 ? "model_gateway_cancelled" : status === 504 ? "model_gateway_timeout" :
              status === 403 ? "model_gateway_denied" : status === 429 ? "model_gateway_rate_limited" :
                status === 503 ? "model_gateway_unavailable" : "model_gateway_request_failed",
            status >= 400 && status <= 599 ? status : 502
          );
        });
        active.add(task);
        task.finally(() => active.delete(task)).catch(() => {});
        return task;
      }
    });
  }

  let closePromise = null;
  return Object.freeze({
    id: manifest.id,
    mounts: Object.freeze({}),
    contributions: Object.freeze({
      operations: Object.freeze(operations),
      routes: Object.freeze({}),
      mcpTools: MODEL_GATEWAY_MCP_TOOL_BINDINGS,
      consoleEntries: Object.freeze({}),
      stateMachines: Object.freeze({}),
      verifierHooks: Object.freeze({})
    }),
    close() {
      if (closePromise) return closePromise.then((receipt) => Object.freeze({ ...receipt, alreadyClosed: true }));
      accepting = false;
      closePromise = Promise.allSettled([...active]).then(() => Object.freeze({ ok: true, alreadyClosed: false }));
      return closePromise;
    }
  });
}
