export const MODEL_GATEWAY_ADAPTER_CONFIG_SCHEMA = "v0.0.1:model-gateway:adapter-config-1";
export const MODEL_GATEWAY_ADAPTER_DEFAULT_TIMEOUT_MS = 30_000;
export const MODEL_GATEWAY_ADAPTER_MAX_TIMEOUT_MS = 120_000;
export const MODEL_GATEWAY_ADAPTER_STATELESS = true;

export interface ModelGatewayAdapterConfig {
  readonly schemaVersion: typeof MODEL_GATEWAY_ADAPTER_CONFIG_SCHEMA;
  readonly enabled: boolean;
  readonly serviceRef: string | null;
  readonly timeoutMs: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function createDefaultDisabledModelGatewayAdapterConfig(): ModelGatewayAdapterConfig {
  return Object.freeze({
    schemaVersion: MODEL_GATEWAY_ADAPTER_CONFIG_SCHEMA,
    enabled: false,
    serviceRef: null,
    timeoutMs: MODEL_GATEWAY_ADAPTER_DEFAULT_TIMEOUT_MS
  });
}

export function assertModelGatewayAdapterConfig(value: unknown): ModelGatewayAdapterConfig {
  if (!isPlainObject(value)) {
    throw new Error("model_gateway_adapter_config_invalid");
  }
  if (!hasOnlyKeys(value, ["schemaVersion", "enabled", "serviceRef", "timeoutMs"])) {
    throw new Error("model_gateway_adapter_config_closed_schema");
  }
  if (value.schemaVersion !== MODEL_GATEWAY_ADAPTER_CONFIG_SCHEMA) {
    throw new Error("model_gateway_adapter_config_schema_version");
  }
  const enabled = value.enabled;
  if (typeof enabled !== "boolean") {
    throw new Error("model_gateway_adapter_config_enabled_invalid");
  }
  let serviceRef: string | null = null;
  if (value.serviceRef !== null && value.serviceRef !== undefined) {
    if (typeof value.serviceRef !== "string" || value.serviceRef.trim().length === 0) {
      throw new Error("model_gateway_adapter_config_service_ref_invalid");
    }
    serviceRef = value.serviceRef.trim();
  }
  if (enabled && serviceRef === null) {
    throw new Error("model_gateway_adapter_config_service_ref_required");
  }
  const timeoutMs = value.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0) {
    throw new Error("model_gateway_adapter_config_timeout_invalid");
  }
  if ((timeoutMs as number) > MODEL_GATEWAY_ADAPTER_MAX_TIMEOUT_MS) {
    throw new Error("model_gateway_adapter_config_timeout_out_of_bounds");
  }
  return Object.freeze({
    schemaVersion: MODEL_GATEWAY_ADAPTER_CONFIG_SCHEMA,
    enabled,
    serviceRef,
    timeoutMs: timeoutMs as number
  });
}

export function isModelGatewayAdapterConfig(value: unknown): value is ModelGatewayAdapterConfig {
  try {
    assertModelGatewayAdapterConfig(value);
    return true;
  } catch {
    return false;
  }
}
