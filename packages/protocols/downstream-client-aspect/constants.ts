export const DOWNSTREAM_CLIENT_ASPECT_PROTOCOL_VERSION = "v0.0.1:agent:downstream-client-aspect-1";
export const DOWNSTREAM_CLIENT_ASPECT_SERVICE_KIND = "downstream-client-aspect";

export const DOWNSTREAM_CLIENT_ASPECT_ROUTE_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  mcp: "mcp-server-side"
});

export const DEFAULT_PRIORITY_FRAMEWORKS: readonly string[] = Object.freeze([]);
