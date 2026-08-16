export const TRAFFIC_MODEL_DESCRIPTOR_FIELD = "trafficModel";
export const TRAFFIC_MODEL_SCHEMA_VERSION = "v0.0.1:agent-mcp-traffic:traffic-model-1";
export const TRAFFIC_MODELS = Object.freeze(["workspace_application", "gateway_transit"]);
export type TrafficModel = (typeof TRAFFIC_MODELS)[number];
export const TRAFFIC_MODEL_VALUES = TRAFFIC_MODELS;
export const TRAFFIC_MODEL_CALLER_OVERRIDE_FORBIDDEN = true;
export const TRAFFIC_MODEL_INFERENCE_FORBIDDEN = true;
export const TRAFFIC_MODEL_SELECTS_ONLY_MIDDLE_STAGE = true;
export const TRAFFIC_MODEL_NEVER_SELECTS_GATEWAY_STAGES = true;
export const TRAFFIC_MODEL_REJECTED_ERROR = "AGENT_MCP_TRAFFIC_MODEL_REJECTED";
export const TRAFFIC_MODEL_OVERRIDE_FIELDS = Object.freeze([
  "callerTrafficModel",
  "trafficModelOverride",
  "requestedTrafficModel"
]);
export const TRAFFIC_MODEL_FORBIDDEN_INFERENCE_SOURCES = Object.freeze([
  "url",
  "tool_name",
  "payload_shape",
  "workspace_id",
  "runtime_health"
]);
export const TRAFFIC_MODEL_ERROR_CODES = Object.freeze([
  "traffic_model_missing",
  "traffic_model_required_or_unknown",
  "traffic_model_conflict",
  "traffic_model_override_denied"
]);
export type TrafficModelErrorCode = (typeof TRAFFIC_MODEL_ERROR_CODES)[number];

export function normalizeTrafficModel(value?: unknown): TrafficModel | null {
  return value === "workspace_application" || value === "gateway_transit" ? value : null;
}

export function isTrafficModel(value: unknown): value is TrafficModel {
  return normalizeTrafficModel(value) !== null;
}

export function assertTrafficModel(value?: unknown): TrafficModel {
  const trafficModel = normalizeTrafficModel(value);
  if (trafficModel === null) {
    throw new Error("traffic_model_required_or_unknown");
  }
  return trafficModel;
}

export function requireTrafficModel(value?: unknown): TrafficModel {
  const trafficModel = normalizeTrafficModel(value);
  if (trafficModel === null) {
    throw new Error(
      `${TRAFFIC_MODEL_REJECTED_ERROR}: trafficModel must be exactly workspace_application or gateway_transit`
    );
  }
  return trafficModel;
}

export function classifyTrafficModel(input?: Readonly<Record<string, unknown>>): TrafficModel {
  if (input === undefined || input === null) {
    throw new Error("traffic_model_missing");
  }
  for (const field of TRAFFIC_MODEL_OVERRIDE_FIELDS) {
    if (field in input) {
      throw new Error("traffic_model_conflict");
    }
  }
  return assertTrafficModel(input[TRAFFIC_MODEL_DESCRIPTOR_FIELD]);
}

export function denyTrafficModelOverride(record: Readonly<Record<string, unknown>>): void {
  for (const field of TRAFFIC_MODEL_OVERRIDE_FIELDS) {
    if (field in record) {
      throw new Error("traffic_model_override_denied");
    }
  }
}

export function assertCallerCannotOverrideTrafficModel(
  descriptor: Readonly<Record<string, unknown>>,
  callerInput?: Readonly<Record<string, unknown>>
): TrafficModel {
  const trafficModel = requireTrafficModel(descriptor[TRAFFIC_MODEL_DESCRIPTOR_FIELD]);
  if (callerInput && Object.prototype.hasOwnProperty.call(callerInput, TRAFFIC_MODEL_DESCRIPTOR_FIELD)) {
    throw new Error(`${TRAFFIC_MODEL_REJECTED_ERROR}: callers cannot supply or override trafficModel`);
  }
  return trafficModel;
}

export function assertNoTrafficModelConflict(
  descriptor: Readonly<Record<string, unknown>>,
  callerInput?: Readonly<Record<string, unknown>>
): TrafficModel {
  const trafficModel = assertTrafficModel(descriptor[TRAFFIC_MODEL_DESCRIPTOR_FIELD]);
  if (callerInput) {
    denyTrafficModelOverride(callerInput);
    if (TRAFFIC_MODEL_DESCRIPTOR_FIELD in callerInput) {
      throw new Error("traffic_model_conflict");
    }
  }
  return trafficModel;
}
