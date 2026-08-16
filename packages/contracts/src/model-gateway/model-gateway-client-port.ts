export const MODEL_GATEWAY_CLIENT_PORT_KIND = "model-gateway-client";
export const MODEL_GATEWAY_WIRE_COMPATIBILITIES = Object.freeze(["openai", "anthropic"]);
export const MODEL_GATEWAY_CALL_OPERATION_ID = "model_gateway.call";
export const MODEL_GATEWAY_MODEL_OPERATION_IDS = Object.freeze(["models.list", "models.get"]);
export const MODEL_GATEWAY_CALL_LEDGER_STATES = Object.freeze(["released", "settled", "in_doubt"]);
export const MODEL_GATEWAY_MESHRIX_PERMIT_NEVER_SERVICE_AUTHORITY = true;

export type ModelGatewayCallLedgerState = (typeof MODEL_GATEWAY_CALL_LEDGER_STATES)[number];

export interface ModelGatewayCallRequest {
  readonly operationId: typeof MODEL_GATEWAY_CALL_OPERATION_ID;
  readonly serviceRef: string;
  readonly modelRef: string;
  readonly providerRef: string;
  readonly inputRefs: readonly string[];
  readonly idempotencyKey: string;
  readonly deadlineMs: number;
  readonly stream: boolean;
}

export interface ModelGatewayCallResult {
  readonly ledgerState: ModelGatewayCallLedgerState;
  readonly outcomeRef: string;
}

export interface ModelGatewayModelsRequest {
  readonly operationId: string;
  readonly serviceRef: string;
}

export interface ModelGatewayModelsResult {
  readonly modelRefs: readonly string[];
}

export interface ModelGatewayClientPort {
  readonly kind: typeof MODEL_GATEWAY_CLIENT_PORT_KIND;
  readonly stateless: true;
  call(request: ModelGatewayCallRequest): Promise<ModelGatewayCallResult>;
  listModels(request: ModelGatewayModelsRequest): Promise<ModelGatewayModelsResult>;
}

export function isModelGatewayClientPort(value: unknown): value is ModelGatewayClientPort {
  return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === MODEL_GATEWAY_CLIENT_PORT_KIND;
}

export function isModelGatewayOperationId(value: unknown): value is string {
  return typeof value === "string" && (value === MODEL_GATEWAY_CALL_OPERATION_ID || value.startsWith("models."));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function requireNonEmptyString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(code);
  }
  return value.trim();
}

export function assertModelGatewayCallRequest(value: unknown): ModelGatewayCallRequest {
  if (!isPlainObject(value)) {
    throw new Error("model_gateway_call_invalid");
  }
  if (!hasOnlyKeys(value, [
    "operationId",
    "serviceRef",
    "modelRef",
    "providerRef",
    "inputRefs",
    "idempotencyKey",
    "deadlineMs",
    "stream"
  ])) {
    throw new Error("model_gateway_call_closed_schema");
  }
  if (value.operationId !== MODEL_GATEWAY_CALL_OPERATION_ID) {
    throw new Error("model_gateway_call_operation_id_invalid");
  }
  const inputRefs = value.inputRefs;
  if (!Array.isArray(inputRefs)) {
    throw new Error("model_gateway_call_input_refs_required");
  }
  const refs: string[] = [];
  for (const entry of inputRefs) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error("model_gateway_call_input_ref_invalid");
    }
    refs.push(entry.trim());
  }
  if (refs.length > 64) {
    throw new Error("model_gateway_call_input_refs_bounded");
  }
  const deadlineMs = value.deadlineMs;
  if (!Number.isSafeInteger(deadlineMs) || (deadlineMs as number) <= 0) {
    throw new Error("model_gateway_call_deadline_invalid");
  }
  if (typeof value.stream !== "boolean") {
    throw new Error("model_gateway_call_stream_invalid");
  }
  return Object.freeze({
    operationId: MODEL_GATEWAY_CALL_OPERATION_ID,
    serviceRef: requireNonEmptyString(value.serviceRef, "model_gateway_call_service_ref_required"),
    modelRef: requireNonEmptyString(value.modelRef, "model_gateway_call_model_ref_required"),
    providerRef: requireNonEmptyString(value.providerRef, "model_gateway_call_provider_ref_required"),
    inputRefs: Object.freeze(refs),
    idempotencyKey: requireNonEmptyString(value.idempotencyKey, "model_gateway_call_idempotency_key_required"),
    deadlineMs: deadlineMs as number,
    stream: value.stream
  });
}
