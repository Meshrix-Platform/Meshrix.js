import os from "node:os";
import path from "node:path";

export const EXTERNAL_GATEWAY_PROTOCOL_VERSION: any = "v0.0.1:agent:external-gateway-1";

export const DEFAULT_GATEWAY_ADAPTER: any = "caddy";
export const DEFAULT_GATEWAY_BASE_URL: any = "http://127.0.0.1:7330";
export const DEFAULT_DIRECT_BASE_URL: any = "http://127.0.0.1:7228";
export const DEFAULT_MAX_BODY_SIZE: any = "512m";
export const DEFAULT_STREAM_TIMEOUT: any = "3600s";

export const EXTERNAL_GATEWAY_DELEGATED_CONTROLS: readonly any[] = Object.freeze([
  "load-balancing",
  "general-rate-limit",
  "endpoint-health",
  "replay-safe-edge-retry"
]);
export const EXTERNAL_GATEWAY_PLATFORM_CONTROLS: readonly any[] = Object.freeze([
  "authentication",
  "grant-identity",
  "operation-permission",
  "approval",
  "business-quota",
  "parser-limits",
  "resource-ceilings",
  "cancellation",
  "audit",
  "upstream-service-governance"
]);
export const EXTERNAL_GATEWAY_REQUIRED_CAPABILITIES: readonly any[] = Object.freeze([
  ...EXTERNAL_GATEWAY_DELEGATED_CONTROLS,
  "mcp-streaming",
  "trusted-proxy",
  "validated-reload"
]);

const adapterRegistry: any = new Map<any, any>();

export function getDefaultExternalGatewayRuntimeCacheRoot(env: any = process.env) : any {
  const explicit: any = String(env.MESHRIX_GATEWAY_RUNTIME_CACHE_DIR || "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const xdgCacheHome: any = String(env.XDG_CACHE_HOME || "").trim();
  const cacheHome: any = xdgCacheHome ? path.resolve(xdgCacheHome) : path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "meshrix", "external-gateway");
}

export const DEFAULT_GATEWAY_ROUTES: readonly any[] = Object.freeze([
  Object.freeze({
    routeId: "health",
    match: "exact",
    path: "/api/healthz",
    trafficClass: "health",
    streaming: false,
    bodyLimit: "1m"
  }),
  Object.freeze({
    routeId: "mcp-stream",
    match: "prefix",
    path: "/mcp",
    trafficClass: "mcp",
    streaming: true,
    sticky: true,
    bodyLimit: "16m"
  }),
  Object.freeze({
    routeId: "mcp-control",
    match: "prefix",
    path: "/api/mcp",
    trafficClass: "mcp-control",
    streaming: true,
    sticky: true,
    bodyLimit: "16m"
  }),
  Object.freeze({
    routeId: "operation-permission",
    match: "prefix",
    path: "/api/operation-permission/v1",
    trafficClass: "operation-permission",
    streaming: false,
    bodyLimit: "32m"
  }),
  Object.freeze({
    routeId: "agent-workspaces",
    match: "prefix",
    path: "/api/agent-workspaces",
    trafficClass: "workspace",
    streaming: false,
    bodyLimit: "128m"
  }),
  Object.freeze({
    routeId: "upload-sessions",
    match: "prefix",
    path: "/api/upload-sessions",
    trafficClass: "upload",
    streaming: true,
    bodyLimit: DEFAULT_MAX_BODY_SIZE
  }),
  Object.freeze({
    routeId: "agent-gateway",
    match: "prefix",
    path: "/api/agent-gateway",
    trafficClass: "agent-runtime",
    streaming: true,
    sticky: true,
    bodyLimit: "32m"
  }),
  Object.freeze({
    routeId: "console-api",
    match: "prefix",
    path: "/api/console",
    trafficClass: "console",
    streaming: false,
    bodyLimit: "16m"
  }),
  Object.freeze({
    routeId: "meshrix-http",
    match: "prefix",
    path: "/",
    trafficClass: "default",
    streaming: false,
    bodyLimit: DEFAULT_MAX_BODY_SIZE
  })
]);

function trimTrailingSlash(value: any = "") : any {
  const text: any = String(value || "").trim();
  return text.length > 1 ? text.replace(/\/+$/, "") : text;
}

function requireUrl(value?: any, label?: any) : any {
  const normalized: any = trimTrailingSlash(value);
  try {
    const parsed: any = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("credentials, query, and fragment are not allowed");
    }
    if (parsed.pathname !== "/") {
      throw new Error("base path is not supported");
    }
    return parsed;
  } catch (error: any) {
    throw new Error(`${label} must be an http(s) URL: ${value}`);
  }
}

function normalizeUrl(value?: any, fallback?: any, label?: any) : any {
  return requireUrl(value || fallback, label).toString().replace(/\/+$/, "");
}

function normalizeAdapterId(value?: any) : any {
  const adapterId: any = String(value || DEFAULT_GATEWAY_ADAPTER).trim().toLowerCase();
  if (!adapterId) {
    return DEFAULT_GATEWAY_ADAPTER;
  }
  if (adapterId === "caddyfile") {
    return "caddy";
  }
  if (adapterId === "nginx.conf") {
    return "nginx";
  }
  return adapterId;
}

function normalizeStringList(value?: any) : any {
  if (Array.isArray(value)) {
    return value.flatMap((item?: any) : any => normalizeStringList(item));
  }
  return String(value || "")
    .split(",")
    .map((item?: any) : any => item.trim())
    .filter(Boolean);
}

function normalizeUpstreams(value?: any, directBaseUrl?: any) : any {
  const rawItems: any = normalizeStringList(value).length > 0 ? normalizeStringList(value) : [directBaseUrl];
  return rawItems.map((item?: any, index?: any) : any => {
    const url: any = normalizeUrl(item, directBaseUrl, `gateway upstream #${index + 1}`);
    const parsed: any = new URL(url);
    return Object.freeze({
      id: `meshrix-upstream-${index + 1}`,
      url,
      protocol: parsed.protocol.replace(":", ""),
      host: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
      authority: `${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`
    });
  });
}

function normalizeListen(input: Record<string, any> = {}, publicBaseUrl?: any) : any {
  const publicUrl: any = requireUrl(publicBaseUrl, "gateway publicBaseUrl");
  const host: any = String(input.host || publicUrl.hostname || "127.0.0.1").trim();
  const port: any = Number(input.port || publicUrl.port || (publicUrl.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`gateway listen port must be 1-65535: ${input.port}`);
  }
  const serverName: any = String(input.serverName || input.server_name || publicUrl.hostname || "_").trim() || "_";
  return Object.freeze({
    host,
    port,
    serverName,
    address: host === "0.0.0.0" || host === "::" ? `:${port}` : `${host}:${port}`
  });
}

function cloneRoute(route: Record<string, any> = {}) : any {
  return Object.freeze({
    routeId: String(route.routeId || route.id || route.path || "").trim(),
    match: route.match === "exact" ? "exact" : "prefix",
    path: String(route.path || "/").trim() || "/",
    trafficClass: String(route.trafficClass || route.class || "default").trim(),
    streaming: route.streaming === true,
    sticky: route.sticky === true,
    bodyLimit: String(route.bodyLimit || DEFAULT_MAX_BODY_SIZE).trim(),
    ...(route.pluginId ? { pluginId: String(route.pluginId).trim() } : {})
  });
}

function activePluginGatewayRoutes(activePluginRoutes?: any) : any {
  if (activePluginRoutes === undefined) return [];
  if (!Array.isArray(activePluginRoutes)) {
    throw new TypeError("activePluginRoutes must be an array of enabled plugin route contributions");
  }
  return activePluginRoutes.flatMap((entry?: any) : any => {
    const gateway: any = entry?.gateway || entry?.implementation?.gateway;
    if (!gateway) return [];
    return [cloneRoute({ ...gateway, pluginId: entry.pluginId })];
  });
}

function normalizeRoutes(routes?: any, activePluginRoutes?: any) : any {
  const inputRoutes: any = Array.isArray(routes) && routes.length > 0 ? routes : DEFAULT_GATEWAY_ROUTES;
  const normalized: any[] = [];
  const routeIds: any = new Map<any, any>();
  const routePaths: any = new Map<any, any>();
  for (const route of [
    ...inputRoutes.map(cloneRoute),
    ...activePluginGatewayRoutes(activePluginRoutes)
  ]) {
    const idConflict: any = routeIds.get(route.routeId);
    const pathConflict: any = routePaths.get(route.path);
    const conflict: any = idConflict || pathConflict;
    if (conflict) {
      if (conflict.routeId === route.routeId && conflict.path === route.path) continue;
      throw new Error(`gateway route ${route.routeId} conflicts with ${conflict.routeId}`);
    }
    routeIds.set(route.routeId, route);
    routePaths.set(route.path, route);
    normalized.push(route);
  }
  if (!normalized.some((route?: any) : any => route.path === "/")) {
    normalized.push(cloneRoute({ routeId: "meshrix-http", path: "/", trafficClass: "default" }));
  }
  return Object.freeze(normalized);
}

function renderProfileInput(profileInput: Record<string, any> = {}, adapterId: any = "") : any {
  if (profileInput?.directMode && profileInput?.gatewayMode) {
    return {
      ...profileInput,
      adapterId: adapterId || profileInput.adapterId || profileInput.gatewayMode.adapterId,
      directBaseUrl: profileInput.directMode.baseUrl,
      publicBaseUrl: profileInput.gatewayMode.publicBaseUrl,
      upstream: (profileInput.gatewayMode.upstreams || []).map((upstream?: any) : any => upstream.url),
      maxBodySize: profileInput.gatewayMode.limits?.maxBodySize,
      streamTimeout: profileInput.gatewayMode.limits?.streamTimeout,
      listen: profileInput.gatewayMode.listen,
      routes: profileInput.routes
    };
  }
  return { ...profileInput, adapterId: adapterId || profileInput.adapterId };
}

export function buildExternalGatewayRouteManifest(profileInput: Record<string, any> = {}) : any {
  const profile: any = profileInput.schemaVersion ? profileInput : normalizeExternalGatewayProfile(profileInput);
  return Object.freeze({
    schemaVersion: "v0.0.1:schema:definition-1",
    protocol: EXTERNAL_GATEWAY_PROTOCOL_VERSION,
    adapterId: profile.gatewayMode.adapterId,
    publicBaseUrl: profile.gatewayMode.publicBaseUrl,
    directBaseUrl: profile.directMode.baseUrl,
    directModeRequired: true,
    routeCount: profile.routes.length,
    routes: profile.routes.map((route?: any) : any =>
      Object.freeze({
        ...route,
        directUrl: `${profile.directMode.baseUrl}${route.path === "/" ? "" : route.path}`,
        gatewayUrl: `${profile.gatewayMode.publicBaseUrl}${route.path === "/" ? "" : route.path}`
      })
    )
  });
}

export function normalizeExternalGatewayProfile(input: Record<string, any> = {}) : any {
  input = renderProfileInput(input);
  const mode: any = String(input.mode || "direct").trim().toLowerCase();
  if (!new Set<any>(["direct", "external"]).has(mode)) {
    throw new Error(`Unsupported External Gateway mode: ${input.mode}`);
  }
  const adapterId: any = normalizeAdapterId(input.adapterId || input.adapter || input.gateway);
  const directBaseUrl: any = normalizeUrl(input.directBaseUrl || input.directUrl, DEFAULT_DIRECT_BASE_URL, "directBaseUrl");
  const publicBaseUrl: any = normalizeUrl(
    input.publicBaseUrl || input.gatewayBaseUrl || input.publicUrl,
    DEFAULT_GATEWAY_BASE_URL,
    "publicBaseUrl"
  );
  const listen: any = normalizeListen(input.listen || {}, publicBaseUrl);
  const upstreams: any = normalizeUpstreams(input.upstreams || input.upstreamUrls || input.upstream, directBaseUrl);
  const routes: any = normalizeRoutes(input.routes, input.activePluginRoutes);
  const profile: Readonly<Record<string, any>> = Object.freeze({
    schemaVersion: "v0.0.1:schema:definition-1",
    protocol: EXTERNAL_GATEWAY_PROTOCOL_VERSION,
    profileId: String(input.profileId || `meshrix-external-gateway-${adapterId}`).trim(),
    mode,
    adapterId,
    trafficPolicyOwner: mode,
    platformGovernanceRequired: true,
    delegatedControls: EXTERNAL_GATEWAY_DELEGATED_CONTROLS,
    platformControls: EXTERNAL_GATEWAY_PLATFORM_CONTROLS,
    directMode: Object.freeze({
      required: true,
      baseUrl: directBaseUrl,
      mustWorkWithoutGateway: true
    }),
    gatewayMode: Object.freeze({
      optional: true,
      adapterId,
      publicBaseUrl,
      listen,
      upstreams,
      limits: Object.freeze({
        maxBodySize: String(input.maxBodySize || input["max-body-size"] || DEFAULT_MAX_BODY_SIZE).trim(),
        streamTimeout: String(input.streamTimeout || input["stream-timeout"] || DEFAULT_STREAM_TIMEOUT).trim()
      })
    }),
    trustedHeaderPolicy: Object.freeze({
      trustedOnlyFrom: normalizeStringList(input.trustedOnlyFrom || input["trusted-from"] || ["loopback", "private-network", "mtls"]),
      gatewayHeaders: Object.freeze([
        "X-Meshrix.js-Gateway",
        "X-Meshrix.js-Gateway-Route",
        "X-Meshrix.js-Gateway-Request-Id",
        "X-Request-Id",
        "X-Forwarded-For",
        "X-Forwarded-Host",
        "X-Forwarded-Proto"
      ]),
      directModeStripsGatewayOnlyHeaders: true
    }),
    routes,
    switchPlan: Object.freeze({
      activeAdapterId: adapterId,
      supportedAdapterIds: listExternalGatewayAdapters().map((adapter?: any) : any => adapter.adapterId),
      directFallbackUrl: directBaseUrl,
      gatewayCanBeRemoved: true
    })
  });
  return Object.freeze({
    ...profile,
    routeManifest: buildExternalGatewayRouteManifest(profile)
  });
}

function caddyPathMatchers(routes?: any) : any {
  return routes
    .filter((route?: any) : any => route.streaming)
    .flatMap((route?: any) : any => {
      if (route.match === "exact") {
        return [route.path];
      }
      if (route.path === "/") {
        return ["/"];
      }
      return [route.path, `${route.path}/*`];
    });
}

function renderCaddyProxyBlock({ matcher = "", upstreams, adapterId, streaming = false }: Record<string, any>) : any {
  const matcherPart: any = matcher ? ` ${matcher}` : "";
  const lines: any[] = [
    `  reverse_proxy${matcherPart} ${upstreams.map((upstream?: any) : any => upstream.url).join(" ")} {`,
    "    lb_policy header MCP-Session-Id least_conn",
    "    lb_try_duration 2s",
    "    lb_retry_match {",
    "      method GET HEAD",
    "    }",
    "    health_uri /api/healthz",
    "    header_up -X-Forwarded-For",
    "    header_up -X-Forwarded-Host",
    "    header_up -X-Forwarded-Proto",
    `    header_up X-Meshrix.js-Gateway ${adapterId}`,
    "    header_up X-Meshrix.js-Gateway-Route {http.request.uri.path}",
    "    header_up X-Meshrix.js-Gateway-Request-Id {http.request.uuid}",
    "    header_up X-Forwarded-Host {host}",
    "    header_up X-Forwarded-Proto {scheme}",
    "    header_up X-Forwarded-For {remote_host}"
  ];
  if (streaming) {
    lines.push("    flush_interval -1");
  }
  lines.push("  }");
  return lines.join("\n");
}

export function renderCaddyConfig(profileInput: Record<string, any> = {}) : any {
  const profile: any = normalizeExternalGatewayProfile(renderProfileInput(profileInput, "caddy"));
  const streamingMatchers: any = caddyPathMatchers(profile.routes);
  return [
    "# Generated by Meshrix.js. Edit the gateway profile and regenerate instead of hand-editing.",
    "# Meshrix.js must keep working through directMode.baseUrl when this gateway is removed.",
    "{",
    "  auto_https off",
    "}",
    "",
    `${profile.gatewayMode.listen.address} {`,
    "  rate_limit {",
    "    zone meshrix_default {",
    "      key {http.request.remote.host}",
    "      events 120",
    "      window 1m",
    "    }",
    "  }",
    "  encode zstd gzip",
    "  request_body {",
    `    max_size ${profile.gatewayMode.limits.maxBodySize}`,
    "  }",
    "",
    `  @meshrix_streaming path ${streamingMatchers.join(" ")}`,
    renderCaddyProxyBlock({
      matcher: "@meshrix_streaming",
      upstreams: profile.gatewayMode.upstreams,
      adapterId: "caddy",
      streaming: true
    }),
    "",
    renderCaddyProxyBlock({
      upstreams: profile.gatewayMode.upstreams,
      adapterId: "caddy",
      streaming: false
    }),
    "}",
    ""
  ].join("\n");
}

function nginxUpstreamScheme(upstreams?: any) : any {
  const schemes: any = new Set<any>(upstreams.map((upstream?: any) : any => upstream.protocol));
  if (schemes.size !== 1) {
    throw new Error("nginx gateway adapter requires all upstreams to use the same http or https scheme");
  }
  return [...schemes][0];
}

function renderNginxProxySettings({ profile, adapterId = "nginx", streaming = false }: Record<string, any>) : any {
  const lines: any[] = [
    "      proxy_http_version 1.1;",
    "      proxy_set_header Host $host;",
    "      proxy_set_header X-Forwarded-Host $host;",
    "      proxy_set_header X-Forwarded-Proto $scheme;",
    "      proxy_set_header X-Forwarded-For $remote_addr;",
    "      proxy_set_header X-Request-Id $request_id;",
    `      proxy_set_header X-Meshrix.js-Gateway ${adapterId};`,
    "      proxy_set_header X-Meshrix.js-Gateway-Route $uri;",
    "      proxy_set_header X-Meshrix.js-Gateway-Request-Id $request_id;",
    "      proxy_set_header Upgrade $http_upgrade;",
    "      proxy_set_header Connection $connection_upgrade;",
    `      proxy_read_timeout ${profile.gatewayMode.limits.streamTimeout};`
  ];
  if (!streaming) {
    lines.push("      proxy_next_upstream error timeout http_502 http_503 http_504;");
    lines.push("      proxy_next_upstream_tries 2;");
    lines.push("      proxy_next_upstream_timeout 2s;");
  }
  if (streaming) {
    lines.push("      proxy_buffering off;");
    lines.push("      proxy_request_buffering off;");
    lines.push("      proxy_cache off;");
  }
  return lines.join("\n");
}

function renderNginxLocation(route?: any, profile?: any, scheme?: any) : any {
  const modifier: any = route.match === "exact" ? "=" : "^~";
  const upstreamName: any = route.streaming ? "meshrix_backend_stream" : "meshrix_backend";
  return [
    `    location ${modifier} ${route.path} {`,
    `      client_max_body_size ${route.bodyLimit};`,
    "      limit_req zone=meshrix_default burst=40 nodelay;",
    renderNginxProxySettings({ profile, streaming: route.streaming }),
    `      proxy_pass ${scheme}://${upstreamName};`,
    "    }"
  ].join("\n");
}

export function renderNginxConfig(profileInput: Record<string, any> = {}) : any {
  const profile: any = normalizeExternalGatewayProfile(renderProfileInput(profileInput, "nginx"));
  const scheme: any = nginxUpstreamScheme(profile.gatewayMode.upstreams);
  const listenAddress: any =
    profile.gatewayMode.listen.host === "0.0.0.0" || profile.gatewayMode.listen.host === "::"
      ? String(profile.gatewayMode.listen.port)
      : `${profile.gatewayMode.listen.host}:${profile.gatewayMode.listen.port}`;
  return [
    "# Generated by Meshrix.js. Edit the gateway profile and regenerate instead of hand-editing.",
    "# Meshrix.js must keep working through directMode.baseUrl when this gateway is removed.",
    "worker_processes auto;",
    "",
    "events {",
    "  worker_connections 1024;",
    "}",
    "",
    "http {",
    "  limit_req_zone $binary_remote_addr zone=meshrix_default:10m rate=120r/m;",
    "  map $http_upgrade $connection_upgrade {",
    "    default upgrade;",
    "    '' '';",
    "  }",
    "",
    "  upstream meshrix_backend {",
    "    least_conn;",
    ...profile.gatewayMode.upstreams.map((upstream?: any) : any => `    server ${upstream.authority};`),
    "    keepalive 32;",
    "  }",
    "",
    "  upstream meshrix_backend_stream {",
    "    hash $http_mcp_session_id consistent; # Mcp-Session-Id affinity",
    ...profile.gatewayMode.upstreams.map((upstream?: any) : any => `    server ${upstream.authority};`),
    "    keepalive 32;",
    "  }",
    "",
    "  server {",
    `    listen ${listenAddress};`,
    `    server_name ${profile.gatewayMode.listen.serverName};`,
    `    client_max_body_size ${profile.gatewayMode.limits.maxBodySize};`,
    "",
    ...profile.routes.map((route?: any) : any => renderNginxLocation(route, profile, scheme)).join("\n\n").split("\n"),
    "  }",
    "}",
    ""
  ].join("\n");
}

export function registerExternalGatewayAdapter(adapter: Record<string, any> = {}) : any {
  const adapterId: any = normalizeAdapterId(adapter.adapterId || adapter.id);
  if (!adapterId) {
    throw new Error("gateway adapterId is required");
  }
  if (typeof adapter.renderConfig !== "function") {
    throw new Error(`gateway adapter ${adapterId} must provide renderConfig(profile)`);
  }
  const normalized: Readonly<Record<string, any>> = Object.freeze({
    adapterId,
    label: String(adapter.label || adapterId).trim(),
    fileName: String(adapter.fileName || `${adapterId}.conf`).trim(),
    mediaType: String(adapter.mediaType || "text/plain").trim(),
    capabilities: Object.freeze([...(adapter.capabilities || [])]),
    requiredModules: Object.freeze([...(adapter.requiredModules || [])]),
    renderConfig: adapter.renderConfig
  });
  adapterRegistry.set(adapterId, normalized);
  return normalized;
}

registerExternalGatewayAdapter({
  adapterId: "caddy",
  label: "Caddy",
  fileName: "Caddyfile",
  mediaType: "text/caddyfile",
  capabilities: [...EXTERNAL_GATEWAY_REQUIRED_CAPABILITIES],
  requiredModules: ["http.handlers.rate_limit"],
  renderConfig: renderCaddyConfig
});

registerExternalGatewayAdapter({
  adapterId: "nginx",
  label: "Nginx",
  fileName: "nginx.conf",
  mediaType: "text/nginx-conf",
  capabilities: [...EXTERNAL_GATEWAY_REQUIRED_CAPABILITIES],
  requiredModules: [],
  renderConfig: renderNginxConfig
});

export function listExternalGatewayAdapters() : any {
  return [...adapterRegistry.values()].map((adapter?: any) : any =>
    Object.freeze({
      adapterId: adapter.adapterId,
      label: adapter.label,
      fileName: adapter.fileName,
      mediaType: adapter.mediaType,
      capabilities: adapter.capabilities,
      requiredModules: adapter.requiredModules
    })
  );
}

export function getExternalGatewayAdapter(adapterId: any = DEFAULT_GATEWAY_ADAPTER) : any {
  const normalized: any = normalizeAdapterId(adapterId);
  const adapter: any = adapterRegistry.get(normalized);
  if (!adapter) {
    throw new Error(`Unsupported gateway adapter: ${adapterId}`);
  }
  return adapter;
}

function runtimeExecutableName(adapterId?: any) : any {
  const baseName: any = adapterId === "nginx" ? "nginx" : "caddy";
  return process.platform === "win32" ? `${baseName}.exe` : baseName;
}

function normalizeRuntimePlatform(value: any = "") : any {
  return String(value || `${process.platform}-${process.arch}`).trim();
}

export function resolveExternalGatewayRuntimePlan(input: Record<string, any> = {}, env: any = process.env) : any {
  const adapter: any = getExternalGatewayAdapter(input.adapterId || input.adapter || input.gateway);
  const platform: any = normalizeRuntimePlatform(input.platform);
  const cacheRoot: any = path.resolve(String(input.cacheRoot || input.cacheDir || getDefaultExternalGatewayRuntimeCacheRoot(env)));
  const executableName: any = runtimeExecutableName(adapter.adapterId);
  const runtimeRoot: any = path.join(cacheRoot, "runtimes", adapter.adapterId, platform);
  const cachedExecutablePath: any = path.join(runtimeRoot, "bin", executableName);
  const configuredBinary: any = String(
    input.runtimeBinary ||
      input.binary ||
      env[`MESHRIX_${adapter.adapterId.toUpperCase()}_BINARY`] ||
      env.MESHRIX_GATEWAY_RUNTIME_BINARY ||
      ""
  ).trim();
  const runtimeUrl: any = String(
    input.runtimeUrl ||
      input.url ||
      env[`MESHRIX_${adapter.adapterId.toUpperCase()}_RUNTIME_URL`] ||
      env.MESHRIX_GATEWAY_RUNTIME_URL ||
      ""
  ).trim();
  return Object.freeze({
    schemaVersion: "v0.0.1:schema:definition-1",
    protocol: EXTERNAL_GATEWAY_PROTOCOL_VERSION,
    adapterId: adapter.adapterId,
    platform,
    cacheRoot,
    runtimeRoot,
    binDir: path.join(runtimeRoot, "bin"),
    cachedExecutablePath,
    executableName,
    configuredBinary: configuredBinary ? path.resolve(configuredBinary) : "",
    runtimeUrl,
    sourcePolicy: "configured-binary -> local-cache -> PATH -> runtime-url",
    cacheIsLocal: cacheRoot.includes(`${path.sep}.cache${path.sep}`) || cacheRoot.endsWith(`${path.sep}.cache`)
  });
}

export function renderExternalGatewayConfig(input: Record<string, any> = {}) : any {
  const profile: any = normalizeExternalGatewayProfile(input);
  const adapter: any = getExternalGatewayAdapter(profile.gatewayMode.adapterId);
  const config: any = adapter.renderConfig(profile);
  return Object.freeze({
    adapterId: adapter.adapterId,
    fileName: adapter.fileName,
    mediaType: adapter.mediaType,
    profile,
    routeManifest: profile.routeManifest,
    capabilities: adapter.capabilities,
    requiredModules: adapter.requiredModules,
    config
  });
}

function publicState(state?: any) : any {
  return state.mode === "direct"
    ? Object.freeze({ mode: "direct", generation: state.generation })
    : Object.freeze({
        mode: "external",
        adapterId: state.profile.gatewayMode.adapterId,
        generation: state.generation,
        profile: state.profile
      });
}

export function createExternalGatewayAuthority({
  initialState = { mode: "direct", generation: 0 },
  persist = async () : Promise<any> => {},
  validateRuntime = async () : Promise<any> => ({ ok: true }),
  probe = async () : Promise<any> => ({ ok: false, reason: "external_gateway_probe_unavailable" })
}: Record<string, any> = {}) : any {
  let state: any = initialState.mode === "external"
    ? {
        mode: "external",
        generation: Number(initialState.generation || 0),
        profile: normalizeExternalGatewayProfile(initialState.profile || initialState)
      }
    : { mode: "direct", generation: Number(initialState.generation || 0) };
  let mutationTail: any = Promise.resolve();

  function conflict(expectedGeneration?: any) : any {
    return Number(expectedGeneration) !== state.generation
      ? Object.freeze({
          ok: false,
          reason: "external_gateway_generation_conflict",
          generation: state.generation
        })
      : null;
  }

  function enqueue(task?: any) : any {
    const result: any = mutationTail.then(task);
    mutationTail = result.catch(() : any => {});
    return result;
  }

  async function validate(input: Record<string, any> = {}) : Promise<any> {
    const configuredPublicBaseUrl: any = String(
      input.publicBaseUrl || input.gatewayBaseUrl || input.publicUrl || input.gatewayMode?.publicBaseUrl || ""
    ).trim();
    if (!configuredPublicBaseUrl) {
      return Object.freeze({
        ok: false,
        reason: "external_gateway_public_url_required",
        generation: state.generation
      });
    }
    let profile: any;
    try {
      profile = normalizeExternalGatewayProfile({ ...input, mode: "external" });
    } catch {
      return Object.freeze({
        ok: false,
        reason: "external_gateway_profile_invalid",
        generation: state.generation
      });
    }
    const staticResult: any = validateExternalGatewayProfile(profile);
    if (!staticResult.ok) return Object.freeze({ ...staticResult, generation: state.generation });
    const runtimeResult: any = await validateRuntime({
      profile,
      adapter: getExternalGatewayAdapter(profile.gatewayMode.adapterId),
      rendered: renderExternalGatewayConfig(profile)
    });
    return Object.freeze({ ...runtimeResult, profile, generation: state.generation });
  }

  return Object.freeze({
    getState: () : any => publicState(state),
    listAdapters: listExternalGatewayAdapters,
    validate,
    apply(input: Record<string, any> = {}) : any {
      return enqueue(async () : Promise<any> => {
        const stale: any = conflict(input.expectedGeneration);
        if (stale) return stale;
        const validation: any = await validate(input);
        if (validation.ok !== true) {
          return Object.freeze({
            ok: false,
            reason: validation.reason || "external_gateway_validation_failed",
            generation: state.generation
          });
        }
        const probeResult: any = await probe({ profile: validation.profile });
        if (probeResult?.ok !== true) {
          return Object.freeze({ ok: false, reason: probeResult?.reason || "external_gateway_probe_failed", generation: state.generation });
        }
        const next: Record<string, any> = { mode: "external", generation: state.generation + 1, profile: validation.profile };
        await persist(publicState(next));
        state = next;
        return Object.freeze({ ok: true, ...publicState(state) });
      });
    },
    switchDirect(input: Record<string, any> = {}) : any {
      return enqueue(async () : Promise<any> => {
        const stale: any = conflict(input.expectedGeneration);
        if (stale) return stale;
        const next: Record<string, any> = { mode: "direct", generation: state.generation + 1 };
        await persist(publicState(next));
        state = next;
        return Object.freeze({ ok: true, ...publicState(state) });
      });
    }
  });
}

export function validateExternalGatewayProfile(input: Record<string, any> = {}) : any {
  const rendered: any = renderExternalGatewayConfig(input);
  const failures: any[] = [];
  const profile: any = rendered.profile;
  const missingCapabilities: any = EXTERNAL_GATEWAY_REQUIRED_CAPABILITIES.filter(
    (capability?: any) : any => !rendered.capabilities.includes(capability)
  );
  if (missingCapabilities.length > 0) {
    failures.push(`adapter is missing required capabilities: ${missingCapabilities.join(", ")}`);
  }
  if (profile.directMode.required !== true || profile.directMode.mustWorkWithoutGateway !== true) {
    failures.push("direct mode must be required and independent from gateway mode");
  }
  if (profile.gatewayMode.optional !== true) {
    failures.push("gateway mode must be optional");
  }
  for (const requiredRoute of ["/mcp", "/api/mcp", "/api/operation-permission/v1", "/api/agent-workspaces", "/api/upload-sessions"]) {
    if (!profile.routes.some((route?: any) : any => route.path === requiredRoute)) {
      failures.push(`missing gateway route ${requiredRoute}`);
    }
  }
  if (!profile.trustedHeaderPolicy.directModeStripsGatewayOnlyHeaders) {
    failures.push("direct mode must strip or ignore gateway-only headers");
  }
  return Object.freeze({
    ok: failures.length === 0,
    failures,
    adapterId: rendered.adapterId,
    routeCount: profile.routes.length,
    directModeRequired: profile.directMode.required,
    gatewayOptional: profile.gatewayMode.optional,
    missingCapabilities
  });
}
