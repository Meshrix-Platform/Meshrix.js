import {
  TRAFFIC_MODELS,
  type TrafficModel
} from "../agent-mcp-traffic/traffic-model.ts";

export const GATEWAY_CHANNEL_PLUGIN_ACTIVATION_CHANGES_TRAFFIC = false;
export const GATEWAY_CHANNEL_CONTRACT_SCHEMA_VERSION = "v0.0.1:gateway:channel-contract-1";
export const GATEWAY_CHANNELS_CONTRIBUTION_SCHEMA_VERSION = "v0.0.1:plugin:gateway-channels-1";
export const GATEWAY_CHANNEL_SELECTION_FIELDS = Object.freeze(["direction", "channelId"]);
export const GATEWAY_CHANNEL_SELECTION_SOURCE = "meshrix_console_administrator";
export const GATEWAY_DIRECT_CHANNEL_NAME = "direct";
export const GATEWAY_EXTERNAL_ADAPTER_KINDS = Object.freeze(["caddy", "nginx", "direct"]);
export const GATEWAY_EXTERNAL_PROXY_INSTANCE_OWNERSHIP = "operator_existing";
export const GATEWAY_EXTERNAL_CONFIGURATION_AUTHORITY = "none";
export const GATEWAY_EXTERNAL_LIFECYCLE_AUTHORITY = "none";
export const GATEWAY_EXTERNAL_IMPLICIT_FALLBACK = false;

export type GatewayDirection = "downstream" | "upstream";
export type GatewayChannelKind = "built_in" | "external";
export type GatewayExternalAdapter = (typeof GATEWAY_EXTERNAL_ADAPTER_KINDS)[number] | null;

export interface GatewayChannelCapabilities {
  readonly loadDistribution: "bounded";
  readonly maxConcurrency: number;
  readonly maxRatePerSecond: number;
  readonly circuitBreaker: true;
  readonly overloadShedding: true;
  readonly timeoutMs: number;
  readonly cancellation: true;
  readonly streaming: true;
  readonly backpressure: true;
  readonly degradation: "stable_transport";
}

export interface GatewayChannelExecutionResult {
  readonly stage?: string;
  readonly trafficModel?: string;
  readonly envelopeRef?: string;
  readonly status?: string;
  readonly normalizedOutcomeRef?: string | null;
  readonly errorRef?: string | null;
  readonly generationRef?: string | null;
}

export interface GatewayChannel {
  readonly channelId: string;
  readonly direction: GatewayDirection;
  readonly kind: GatewayChannelKind;
  readonly trafficModels: readonly TrafficModel[];
  readonly externalAdapter: GatewayExternalAdapter;
  readonly capabilities: GatewayChannelCapabilities;
  readonly accepts: (value: unknown) => boolean;
  readonly execute: (input: unknown) => Promise<GatewayChannelExecutionResult>;
}

export interface GatewayChannelSelection {
  readonly schemaVersion: string;
  readonly direction: GatewayDirection;
  readonly channelId: string;
  readonly generation: number;
  readonly source: typeof GATEWAY_CHANNEL_SELECTION_SOURCE;
}

export interface GatewayChannelsPluginContribution {
  readonly schemaVersion: string;
  readonly kind: "gatewayChannels";
  readonly channels: readonly GatewayChannel[];
}

export interface GatewayExternalAttachment {
  readonly adapter: "caddy" | "nginx" | "direct";
  readonly endpointRef: string;
  readonly instanceOwnership: "operator_existing" | "operator_endpoint";
  readonly configurationAuthority: typeof GATEWAY_EXTERNAL_CONFIGURATION_AUTHORITY;
  readonly lifecycleAuthority: typeof GATEWAY_EXTERNAL_LIFECYCLE_AUTHORITY;
  readonly implicitFallback: typeof GATEWAY_EXTERNAL_IMPLICIT_FALLBACK;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function requireDirection(value: unknown): GatewayDirection {
  if (value !== "downstream" && value !== "upstream") {
    throw new Error("gateway_channel_direction_invalid");
  }
  return value;
}

function requireKind(value: unknown): GatewayChannelKind {
  if (value !== "built_in" && value !== "external") {
    throw new Error("gateway_channel_kind_invalid");
  }
  return value;
}

function isExternalAdapter(value: unknown): value is Exclude<GatewayExternalAdapter, null> {
  return value === "caddy" || value === "nginx" || value === "direct";
}

function isChannelAccepts(value: unknown): value is GatewayChannel["accepts"] {
  return typeof value === "function";
}

function isChannelExecute(value: unknown): value is GatewayChannel["execute"] {
  return typeof value === "function";
}

function requireTrafficModels(value: unknown): readonly TrafficModel[] {
  if (!Array.isArray(value)) {
    throw new Error("gateway_channel_traffic_models_required");
  }
  const models: TrafficModel[] = [];
  for (const entry of value) {
    if (entry !== "workspace_application" && entry !== "gateway_transit") {
      throw new Error("gateway_channel_traffic_model_invalid");
    }
    models.push(entry);
  }
  for (const expected of TRAFFIC_MODELS) {
    if (!models.includes(expected)) {
      throw new Error("gateway_channel_traffic_models_incomplete");
    }
  }
  if (new Set(models).size !== models.length) {
    throw new Error("gateway_channel_traffic_models_duplicate");
  }
  return Object.freeze(models);
}

export function assertGatewayChannelCapabilities(value: unknown): GatewayChannelCapabilities {
  if (!isPlainObject(value)) {
    throw new Error("gateway_channel_capabilities_invalid");
  }
  if (!hasOnlyKeys(value, [
    "loadDistribution",
    "maxConcurrency",
    "maxRatePerSecond",
    "circuitBreaker",
    "overloadShedding",
    "timeoutMs",
    "cancellation",
    "streaming",
    "backpressure",
    "degradation"
  ])) {
    throw new Error("gateway_channel_capabilities_closed_schema");
  }
  if (value.loadDistribution !== "bounded") {
    throw new Error("gateway_channel_load_distribution_must_be_bounded");
  }
  const maxConcurrency = value.maxConcurrency;
  if (!Number.isSafeInteger(maxConcurrency) || (maxConcurrency as number) <= 0) {
    throw new Error("gateway_channel_concurrency_out_of_bounds");
  }
  const maxRatePerSecond = value.maxRatePerSecond;
  if (!Number.isSafeInteger(maxRatePerSecond) || (maxRatePerSecond as number) <= 0) {
    throw new Error("gateway_channel_rate_out_of_bounds");
  }
  const timeoutMs = value.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0) {
    throw new Error("gateway_channel_timeout_out_of_bounds");
  }
  for (const field of ["circuitBreaker", "overloadShedding", "cancellation", "streaming", "backpressure"] as const) {
    if (value[field] !== true) {
      throw new Error(`gateway_channel_${field}_required`);
    }
  }
  if (value.degradation !== "stable_transport") {
    throw new Error("gateway_channel_degradation_must_be_stable_transport");
  }
  return Object.freeze({
    loadDistribution: "bounded",
    maxConcurrency: maxConcurrency as number,
    maxRatePerSecond: maxRatePerSecond as number,
    circuitBreaker: true,
    overloadShedding: true,
    timeoutMs: timeoutMs as number,
    cancellation: true,
    streaming: true,
    backpressure: true,
    degradation: "stable_transport"
  });
}

export function assertGatewayChannel(value: unknown): GatewayChannel {
  if (!isPlainObject(value)) {
    throw new Error("gateway_channel_invalid");
  }
  if (!hasOnlyKeys(value, [
    "channelId",
    "direction",
    "kind",
    "trafficModels",
    "externalAdapter",
    "capabilities",
    "accepts",
    "execute"
  ])) {
    throw new Error("gateway_channel_closed_schema");
  }
  const channelId = value.channelId;
  if (typeof channelId !== "string" || channelId.length === 0) {
    throw new Error("gateway_channel_id_required");
  }
  const direction = requireDirection(value.direction);
  const kind = requireKind(value.kind);
  const trafficModels = requireTrafficModels(value.trafficModels);
  let externalAdapter: GatewayExternalAdapter = null;
  if (kind === "built_in") {
    if (value.externalAdapter !== null && value.externalAdapter !== undefined) {
      throw new Error("gateway_channel_built_in_has_no_external_adapter");
    }
  } else {
    const adapter = value.externalAdapter;
    if (!isExternalAdapter(adapter)) {
      throw new Error("gateway_channel_external_adapter_required");
    }
    externalAdapter = adapter;
  }
  const capabilities = assertGatewayChannelCapabilities(value.capabilities);
  const accepts = value.accepts;
  const execute = value.execute;
  if (!isChannelAccepts(accepts) || !isChannelExecute(execute)) {
    throw new Error("gateway_channel_handlers_required");
  }
  return Object.freeze({
    channelId,
    direction,
    kind,
    trafficModels,
    externalAdapter,
    capabilities,
    accepts,
    execute
  });
}

export function assertGatewayExternalAttachment(value: unknown): GatewayExternalAttachment {
  if (!isPlainObject(value) || !hasOnlyKeys(value, [
    "adapter",
    "endpointRef",
    "instanceOwnership",
    "configurationAuthority",
    "lifecycleAuthority",
    "implicitFallback"
  ])) {
    throw new Error("gateway_external_attachment_closed_schema");
  }
  if (value.adapter !== "caddy" && value.adapter !== "nginx" && value.adapter !== "direct") {
    throw new Error("gateway_external_attachment_adapter_invalid");
  }
  if (typeof value.endpointRef !== "string" || value.endpointRef.trim().length === 0) {
    throw new Error("gateway_external_attachment_endpoint_ref_required");
  }
  const expectedOwnership = value.adapter === "direct" ? "operator_endpoint" : "operator_existing";
  if (value.instanceOwnership !== expectedOwnership) {
    throw new Error("gateway_external_attachment_operator_owned_required");
  }
  if (value.configurationAuthority !== GATEWAY_EXTERNAL_CONFIGURATION_AUTHORITY ||
      value.lifecycleAuthority !== GATEWAY_EXTERNAL_LIFECYCLE_AUTHORITY) {
    throw new Error("gateway_external_attachment_authority_forbidden");
  }
  if (value.implicitFallback !== GATEWAY_EXTERNAL_IMPLICIT_FALLBACK) {
    throw new Error("gateway_external_attachment_implicit_fallback_forbidden");
  }
  return Object.freeze({
    adapter: value.adapter,
    endpointRef: value.endpointRef.trim(),
    instanceOwnership: expectedOwnership,
    configurationAuthority: GATEWAY_EXTERNAL_CONFIGURATION_AUTHORITY,
    lifecycleAuthority: GATEWAY_EXTERNAL_LIFECYCLE_AUTHORITY,
    implicitFallback: GATEWAY_EXTERNAL_IMPLICIT_FALLBACK
  });
}

export function assertGatewayDirectionSelection(value: unknown): GatewayChannelSelection {
  if (!isPlainObject(value)) {
    throw new Error("gateway_direction_selection_invalid");
  }
  if (!hasOnlyKeys(value, ["schemaVersion", "direction", "channelId", "generation", "source"])) {
    throw new Error("gateway_direction_selection_closed_schema");
  }
  const direction = requireDirection(value.direction);
  const channelId = value.channelId;
  if (typeof channelId !== "string" || channelId.length === 0) {
    throw new Error("gateway_direction_selection_channel_required");
  }
  const generation = value.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
    throw new Error("gateway_direction_selection_generation_invalid");
  }
  if (value.source !== GATEWAY_CHANNEL_SELECTION_SOURCE) {
    throw new Error("gateway_direction_selection_console_only");
  }
  return Object.freeze({
    schemaVersion: typeof value.schemaVersion === "string" ? value.schemaVersion : "",
    direction,
    channelId,
    generation: generation as number,
    source: GATEWAY_CHANNEL_SELECTION_SOURCE
  });
}

export function assertPluginGatewayChannelContribution(value: unknown): GatewayChannelsPluginContribution {
  if (!isPlainObject(value)) {
    throw new Error("gateway_channel_contribution_invalid");
  }
  if (!hasOnlyKeys(value, ["schemaVersion", "kind", "channels"])) {
    throw new Error("gateway_channel_contribution_closed_schema");
  }
  if (value.kind !== "gatewayChannels") {
    throw new Error("gateway_channel_contribution_kind_invalid");
  }
  if (value.schemaVersion !== GATEWAY_CHANNELS_CONTRIBUTION_SCHEMA_VERSION) {
    throw new Error("gateway_channel_contribution_schema_version");
  }
  const channels = value.channels;
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error("gateway_channel_contribution_channels_required");
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    kind: "gatewayChannels",
    channels: Object.freeze(channels.map((entry) => assertGatewayChannel(entry)))
  });
}
