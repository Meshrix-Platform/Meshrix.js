import { randomBytes } from "node:crypto";

import { verifyMcpHandshakeSignature } from "../../../mcp-identity.mjs";
import { loadProcessIdentity } from "../process-identity-store.mjs";
import {
  DEFAULT_SCAN_PORTS,
  DEFAULT_TOKEN_ENV,
  LICO_MCP_DISCOVERY_FILE_ENV,
  LICO_MCP_DISCOVERY_URL_ENV,
  LICO_MCP_URL_ENV,
  MCP_INTERFACE_VERSION,
  MCP_SERVER_NAME,
  MCP_STABLE_TOOL_NAME,
  packageJson
} from "./constants.mjs";
import { mcpTargetHeaders, normalizeBaseUrl, normalizeTarget, option } from "./basic-utils.mjs";
import {
  discoveryRegistryPath,
  readJson
} from "./device-discovery-registry.mjs";
import { readStdin, run, uniqueValues } from "./connector-process.mjs";
import { fetchJson } from "./http-json-client.mjs";
import { processIdentityHeaders } from "./process-identity-request.mjs";

export async function readLaunchctlEnv(name) {
  if (process.platform !== "darwin") {
    return "";
  }
  const result = await run("launchctl", ["getenv", name], { allowFailure: true });
  return result.ok ? result.stdout.trim() : "";
}

export function explicitBaseUrl(options = {}) {
  return normalizeBaseUrl(option(options, "url", process.env.LICO_MCP_BASE_URL || ""));
}

export function baseUrlFromEndpoint(value) {
  const text = normalizeBaseUrl(value);
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(text);
    if (parsed.pathname === "/mcp") {
      parsed.pathname = "/";
      parsed.search = "";
      parsed.hash = "";
      return normalizeBaseUrl(parsed.toString());
    }
    if (
      parsed.pathname === "/api/mcp/discovery" ||
      parsed.pathname === "/.well-known/lico/mcp.json" ||
      parsed.pathname === "/api/mcp/handshake"
    ) {
      parsed.pathname = "/";
      parsed.search = "";
      parsed.hash = "";
      return normalizeBaseUrl(parsed.toString());
    }
    return text;
  } catch {
    return "";
  }
}

export function parseScanPorts(options = {}) {
  const raw = String(option(options, "scan-ports", process.env.LICO_MCP_SCAN_PORTS || "")).trim();
  const values = raw
    ? raw.split(",").map((item) => Number(item.trim()))
    : DEFAULT_SCAN_PORTS;
  return uniqueValues(values
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535)
    .map(String))
    .map(Number);
}

export async function registryBaseUrls(options = {}) {
  const payload = await readJson(discoveryRegistryPath(options), null);
  const server = payload?.servers?.[MCP_SERVER_NAME] || payload?.mcpServers?.[MCP_SERVER_NAME] || {};
  const profiles = Object.values(payload?.serverConfig?.profiles || {});
  const activeProfile = payload?.serverConfig?.activeName
    ? payload?.serverConfig?.profiles?.[payload.serverConfig.activeName]
    : null;
  return uniqueValues([
    activeProfile?.baseUrl,
    baseUrlFromEndpoint(server.httpUrl),
    baseUrlFromEndpoint(server.url),
    baseUrlFromEndpoint(payload?.discovery?.preferredHttpDiscoveryUrl),
    baseUrlFromEndpoint(payload?.discovery?.preferredApiDiscoveryUrl),
    ...profiles.map((profile) => profile?.baseUrl)
  ]);
}

export async function candidateBaseUrls(options = {}) {
  const explicit = explicitBaseUrl(options);
  if (explicit) {
    return [explicit];
  }
  const launchDiscoveryFile = await readLaunchctlEnv(LICO_MCP_DISCOVERY_FILE_ENV);
  const launchDiscoveryUrl = await readLaunchctlEnv(LICO_MCP_DISCOVERY_URL_ENV);
  const launchMcpUrl = await readLaunchctlEnv(LICO_MCP_URL_ENV);
  const fileCandidates = uniqueValues([
    discoveryRegistryPath(options),
    launchDiscoveryFile
  ]);
  const fromFiles = [];
  for (const filePath of fileCandidates) {
    const payload = await readJson(filePath, null);
    const server = payload?.servers?.[MCP_SERVER_NAME] || payload?.mcpServers?.[MCP_SERVER_NAME] || {};
    const profiles = Object.values(payload?.serverConfig?.profiles || {});
    const activeProfile = payload?.serverConfig?.activeName
      ? payload?.serverConfig?.profiles?.[payload.serverConfig.activeName]
      : null;
    fromFiles.push(
      activeProfile?.baseUrl,
      baseUrlFromEndpoint(server.httpUrl),
      baseUrlFromEndpoint(server.url),
      baseUrlFromEndpoint(payload?.discovery?.preferredHttpDiscoveryUrl),
      baseUrlFromEndpoint(payload?.discovery?.preferredApiDiscoveryUrl),
      ...profiles.map((profile) => profile?.baseUrl)
    );
  }
  const scanned = parseScanPorts(options).flatMap((port) => [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`
  ]);
  return uniqueValues([
    baseUrlFromEndpoint(process.env[LICO_MCP_URL_ENV]),
    baseUrlFromEndpoint(process.env[LICO_MCP_DISCOVERY_URL_ENV]),
    baseUrlFromEndpoint(launchMcpUrl),
    baseUrlFromEndpoint(launchDiscoveryUrl),
    ...fromFiles,
    ...scanned
  ]).map(normalizeBaseUrl);
}

export async function fetchLicoDiscovery(baseUrl) {
  const url = `${baseUrl}/api/mcp/discovery`;
  const result = await fetchJson(url, { timeoutMs: 1500 });
  const payload = result.payload || {};
  const identity = payload.identity || null;
  if (
    !result.ok ||
    payload.name !== "LicoMesh" ||
    payload.interfaceVersion !== MCP_INTERFACE_VERSION ||
    payload.stableToolName !== MCP_STABLE_TOOL_NAME ||
    identity?.algorithm !== "Ed25519" ||
    !identity?.publicKeyJwk ||
    !payload.handshake?.url
  ) {
    throw new Error("not an LicoMesh MCP discovery response");
  }
  return payload;
}

export async function verifyLicoHandshake(baseUrl, discovery) {
  const nonce = randomBytes(32).toString("base64url");
  const result = await fetchJson(`${baseUrl}/api/mcp/handshake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nonce,
      client: {
        name: packageJson.name,
        version: packageJson.version
      }
    }),
    timeoutMs: 2500
  });
  const payload = result.payload?.payload || {};
  const signature = result.payload?.signature || {};
  const publicKeyJwk = payload.identity?.publicKeyJwk;
  if (
    !result.ok ||
    result.payload?.ok !== true ||
    payload.schemaVersion !== "v0.0.1:mcp:handshake-1" ||
    payload.nonce !== nonce ||
    payload.server?.name !== "LicoMesh" ||
    payload.server?.interfaceVersion !== MCP_INTERFACE_VERSION ||
    payload.server?.stableToolName !== MCP_STABLE_TOOL_NAME ||
    payload.identity?.keyId !== discovery.identity?.keyId ||
    signature.algorithm !== "Ed25519" ||
    !verifyMcpHandshakeSignature({ publicKeyJwk, payload, signature: signature.value })
  ) {
    throw new Error("LicoMesh MCP handshake signature verification failed");
  }
  return {
    ok: true,
    baseUrl,
    discovery,
    handshake: result.payload
  };
}

export async function discoverLicoHub(options = {}) {
  const attempts = [];
  const candidates = await candidateBaseUrls(options);
  for (const baseUrl of candidates) {
    try {
      const discovery = await fetchLicoDiscovery(baseUrl);
      const verified = await verifyLicoHandshake(baseUrl, discovery);
      return {
        ...verified,
        attempts: [
          ...attempts,
          { baseUrl, ok: true, verified: true }
        ]
      };
    } catch (error) {
      attempts.push({
        baseUrl,
        ok: false,
        verified: false,
        reason: error?.name === "AbortError" ? "timeout" : error?.message || String(error)
      });
    }
  }
  return {
    ok: false,
    attempts,
    reason: "No signed LicoMesh MCP hub was discovered on this device."
  };
}

export async function optionsWithDiscoveredBaseUrl(options = {}) {
  const discovered = await discoverLicoHub(options);
  if (!discovered.ok) {
    throw new Error(`${discovered.reason} Use --url only if you know the LicoMesh base URL; it will still be handshake-verified.`);
  }
  return {
    ...options,
    "resolved-url": discovered.baseUrl,
    __licoDiscovery: discovered
  };
}

export async function publishLaunchctlEnv(env) {
  for (const name of Object.keys(env || {})) {
    if (/(?:token|secret|password|credential|api[_-]?key)/iu.test(name)) {
      throw new Error("sensitive_environment_persistence_requires_a_secret_store");
    }
  }
  if (process.platform === "darwin") {
    for (const [name, value] of Object.entries(env)) {
      await run("launchctl", ["setenv", name, value], { allowFailure: true });
    }
    return true;
  }
  
  if (process.platform === "win32") {
    for (const [name, value] of Object.entries(env)) {
      await run("setx", [name, value], { allowFailure: true });
    }
    return true;
  }

  process.stderr.write("\n[Notice] Please add the following to your ~/.bashrc or ~/.zshrc:\n");
  for (const [name, value] of Object.entries(env)) {
    process.stderr.write(`export ${name}="${value}"\n`);
  }
  process.stderr.write("\n");
  return false;
}

export async function resolveToken(options, { required = false } = {}) {
  if (options["token-stdin"]) {
    return (await readStdin()).trim();
  }
  const tokenEnv = String(option(options, "token-env", DEFAULT_TOKEN_ENV));
  const envToken = String(process.env[tokenEnv] || "").trim();
  if (envToken) {
    return envToken;
  }
  if (required) {
    throw new Error(`Missing token. Provide --token-stdin or ${tokenEnv}.`);
  }
  return "";
}

export async function ensureService(baseUrl) {
  const initialize = await fetchJson(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "lico-mcp-connector", version: packageJson.version }
      }
    })
  });
  if (!initialize.ok || initialize.payload?.result?.serverInfo?.name !== "LicoMesh") {
    throw new Error(`LicoMesh MCP is not available at ${baseUrl}/mcp.`);
  }
  return initialize;
}

export function authHeaders(token, target = "") {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-LicoMesh-Api-Key": token,
    ...mcpTargetHeaders(target)
  };
}

export async function signedAuthHeaders({ baseUrl, token, target = "", method = "POST", body = "", url = "" } = {}) {
  const requestUrl = String(url || `${baseUrl}/mcp`);
  const identity = await loadProcessIdentity(target);
  return {
    ...authHeaders(token, target),
    ...processIdentityHeaders({
      method,
      url: new URL(requestUrl),
      body,
      identity
    })
  };
}

export async function verifyMcpTools({ baseUrl, token, target = "" }) {
  const toolsListBody = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsList = await fetchJson(`${baseUrl}/mcp`, {
    method: "POST",
    headers: await signedAuthHeaders({ baseUrl, token, target, method: "POST", body: toolsListBody }),
    body: toolsListBody
  });
  const healthBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: MCP_STABLE_TOOL_NAME,
      arguments: {
        apiVersion: MCP_INTERFACE_VERSION,
        operation: "system.health",
        input: {},
        clientVersion: packageJson.version
      }
    }
  });
  const health = await fetchJson(`${baseUrl}/mcp`, {
    method: "POST",
    headers: await signedAuthHeaders({ baseUrl, token, target, method: "POST", body: healthBody }),
    body: healthBody
  });
  const tools = toolsList.payload?.result?.tools || [];
  const toolNames = new Set(tools.map((tool) => tool.name));
  const hasStableOutlet = toolNames.has(MCP_STABLE_TOOL_NAME);
  const hasOnlyUniqueNamedTools = toolNames.size === tools.length && tools.every((tool) => String(tool.name || "").trim());
  if (
    !toolsList.ok
    || !health.ok
    || tools.length === 0
    || !hasStableOutlet
    || !hasOnlyUniqueNamedTools
    || health.payload?.result?.structuredContent?.payload?.ok !== true
  ) {
    throw new Error([
      "MCP HTTP verification failed",
      `toolsStatus=${toolsList.status || 0}`,
      `healthStatus=${health.status || 0}`,
      `toolCount=${tools.length}`,
      `hasStableOutlet=${hasStableOutlet ? "true" : "false"}`,
      `hasOnlyUniqueNamedTools=${hasOnlyUniqueNamedTools ? "true" : "false"}`,
      `systemHealthOk=${health.payload?.result?.structuredContent?.payload?.ok === true ? "true" : "false"}`
    ].join(";"));
  }
  const runtimeMeta = toolsList.payload?.result?._meta || {};
  const runtimeSupportedTargets = Array.isArray(runtimeMeta.supportedTargets)
    ? runtimeMeta.supportedTargets.map((target) => target.target).filter(Boolean)
    : [];
  return {
    toolCount: tools.length,
    stableToolName: tools.find(t => t.name === MCP_STABLE_TOOL_NAME)?.name || "",
    systemHealthOk: health.payload?.result?.structuredContent?.payload?.ok === true,
    sharedHubOk: runtimeMeta.sharedHub?.directHttp === true,
    priorityTargets: Array.isArray(runtimeMeta.priorityTargets) ? runtimeMeta.priorityTargets : [],
    supportedTargets: runtimeSupportedTargets
  };
}
