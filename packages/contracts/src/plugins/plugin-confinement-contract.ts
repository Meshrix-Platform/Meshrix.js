export const PLUGIN_CONFINEMENT_SCHEMA_VERSION = "v0.0.1:plugin:confinement-1";
export const PLUGIN_LIFECYCLE_ACTIVATION_CHANGES_AVAILABILITY = true;
export const PLUGIN_LIFECYCLE_ACTIVATION_CHANGES_TRAFFIC = false;

export const EXTERNAL_GATEWAY_WORKSPACE_PORT = "none";
export const EXTERNAL_GATEWAY_APPLICATION_STAGE_PORT = "none";
export const EXTERNAL_GATEWAY_SEMANTIC_AUTHORITY = "none";
export const EXTERNAL_GATEWAY_SELECTION_AUTHORITY = "none";
export const EXTERNAL_GATEWAY_ENVELOPE_MUTATION = "none";

export const PLUGIN_CONFINEMENT_FORBIDDEN_AUTHORITIES = Object.freeze([
  "workspace",
  "application_stage",
  "semantics",
  "identity",
  "authorization",
  "credential",
  "policy",
  "channel_selection",
  "model_gateway_lifecycle",
  "maintenance"
]);

export type PluginConfinementAuthority = (typeof PLUGIN_CONFINEMENT_FORBIDDEN_AUTHORITIES)[number];

export const MESHRIX_TO_MAINTENANCE_PLUGIN_EDGE = "none";
export const MAINTENANCE_PLUGIN_MESHRIX_IMPORT = "none";
export const MODEL_GATEWAY_SERVICE_MESHRIX_RUNTIME_IMPORT = "none";

export interface PluginConfinementDeclaration {
  readonly schemaVersion: typeof PLUGIN_CONFINEMENT_SCHEMA_VERSION;
  readonly pluginId: string;
  readonly forbiddenAuthorities: readonly string[];
  readonly lifecycleAuthority: "availability_only";
}

export interface PluginActivationResult {
  readonly trafficChanged: false;
  readonly availableChoices: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function assertNoMeshrixMaintenanceEdge(paths: readonly string[]): void {
  if (paths.some((entry) => entry.includes("meshrix-self-maintenance"))) {
    throw new Error("meshrix_to_maintenance_plugin_edge_forbidden");
  }
}

export function assertPluginConfinement(value: unknown): PluginConfinementDeclaration {
  if (!isPlainObject(value)) {
    throw new Error("plugin_confinement_invalid");
  }
  if (!hasOnlyKeys(value, ["schemaVersion", "pluginId", "forbiddenAuthorities", "lifecycleAuthority"])) {
    throw new Error("plugin_confinement_closed_schema");
  }
  if (value.schemaVersion !== PLUGIN_CONFINEMENT_SCHEMA_VERSION) {
    throw new Error("plugin_confinement_schema_version");
  }
  const pluginId = value.pluginId;
  if (typeof pluginId !== "string" || pluginId.length === 0) {
    throw new Error("plugin_confinement_plugin_id_required");
  }
  const forbiddenAuthorities = value.forbiddenAuthorities;
  if (!Array.isArray(forbiddenAuthorities) || forbiddenAuthorities.length === 0) {
    throw new Error("plugin_confinement_forbidden_authorities_required");
  }
  for (const authority of forbiddenAuthorities) {
    if (typeof authority !== "string" || authority.length === 0) {
      throw new Error("plugin_confinement_forbidden_authority_invalid");
    }
  }
  if (value.lifecycleAuthority !== "availability_only") {
    throw new Error("plugin_confinement_lifecycle_must_be_availability_only");
  }
  return Object.freeze({
    schemaVersion: PLUGIN_CONFINEMENT_SCHEMA_VERSION,
    pluginId,
    forbiddenAuthorities: Object.freeze([...forbiddenAuthorities]),
    lifecycleAuthority: "availability_only"
  });
}

export function createPluginActivationResult(choices: readonly string[]): PluginActivationResult {
  if (!Array.isArray(choices)) {
    throw new Error("plugin_activation_choices_invalid");
  }
  return Object.freeze({
    trafficChanged: false,
    availableChoices: Object.freeze([...choices])
  });
}
