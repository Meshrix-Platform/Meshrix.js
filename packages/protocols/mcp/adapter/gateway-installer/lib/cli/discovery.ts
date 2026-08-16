import { randomBytes } from "node:crypto";

import { verifyMcpHandshakeSignature } from "../../mcp-identity.ts";
import { MCP_PROTOCOL_VERSION } from "@meshrix/protocols/mcp/adapter/http-mcp-adapter-constants";
import {
  DEFAULT_SCAN_PORTS,
  DEFAULT_TOKEN_ENV,
  MESHRIX_MCP_DISCOVERY_FILE_ENV,
  MESHRIX_MCP_DISCOVERY_URL_ENV,
  MESHRIX_MCP_URL_ENV,
  MCP_INTERFACE_VERSION,
  MCP_SERVER_NAME,
  MCP_STABLE_TOOL_NAME,
  packageJson
} from "./constants.ts";
import { containsMxak1Credential, MXAK1_CREDENTIAL_PATTERN, mcpTargetHeaders, normalizeBaseUrl, normalizeTarget, option } from "./basic-utils.ts";
import {
  discoveryRegistryPath,
  readJson
} from "./device-discovery-registry.ts";
import { assertSafeEnvName, readStdin, run, uniqueValues } from "./connector-process.ts";
import { fetchJson } from "./http-json-client.ts";

export async function readLaunchctlEnv(name?: any) : Promise<any> {
  if (process.platform !== "darwin") {
    return "";
  }
  const result: any = await run("launchctl", ["getenv", name], { allowFailure: true });
  return result.ok ? result.stdout.trim() : "";
}

export function explicitBaseUrl(options: Record<string, any> = {}) : any {
  const value: any = option(options, "url", process.env.MESHRIX_MCP_BASE_URL || "");
  if (containsMxak1Credential(value)) {
    throw new Error("Raw API Keys are not accepted in URLs. Use --token-stdin or --token-env.");
  }
  return normalizeBaseUrl(value);
}

export function baseUrlFromEndpoint(value?: any) : any {
  const text: any = normalizeBaseUrl(value);
  if (!text) {
    return "";
  }
  try {
    const parsed: any = new URL(text);
    if (parsed.pathname === "/mcp") {
      parsed.pathname = "/";
      parsed.search = "";
      parsed.hash = "";
      return normalizeBaseUrl(parsed.toString());
    }
    if (
      parsed.pathname === "/api/mcp/discovery" ||
      parsed.pathname === "/.well-known/meshrix/mcp.json" ||
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

export function parseScanPorts(options: Record<string, any> = {}) : any {
  const raw: any = String(option(options, "scan-ports", process.env.MESHRIX_MCP_SCAN_PORTS || "")).trim();
  const values: any = raw
    ? raw.split(",").map((item?: any) : any => Number(item.trim()))
    : DEFAULT_SCAN_PORTS;
  return uniqueValues(values
    .filter((port?: any) : any => Number.isInteger(port) && port > 0 && port <= 65535)
    .map(String))
    .map(Number);
}

export async function registryBaseUrls(options: Record<string, any> = {}) : Promise<any> {
  const payload: any = await readJson(discoveryRegistryPath(options), null);
  const server: any = payload?.servers?.[MCP_SERVER_NAME] || payload?.mcpServers?.[MCP_SERVER_NAME] || {};
  const profiles: any = (Object.values(payload?.serverConfig?.profiles || {}) as any[]);
  const activeProfile: any = payload?.serverConfig?.activeName
    ? payload?.serverConfig?.profiles?.[payload.serverConfig.activeName]
    : null;
  return uniqueValues([
    activeProfile?.baseUrl,
    baseUrlFromEndpoint(server.httpUrl),
    baseUrlFromEndpoint(server.url),
    baseUrlFromEndpoint(payload?.discovery?.preferredHttpDiscoveryUrl),
    baseUrlFromEndpoint(payload?.discovery?.preferredApiDiscoveryUrl),
    ...profiles.map((profile?: any) : any => profile?.baseUrl)
  ]);
}

export async function candidateBaseUrls(options: Record<string, any> = {}) : Promise<any> {
  const explicit: any = explicitBaseUrl(options);
  if (explicit) {
    return [explicit];
  }
  const launchDiscoveryFile: any = await readLaunchctlEnv(MESHRIX_MCP_DISCOVERY_FILE_ENV);
  const launchDiscoveryUrl: any = await readLaunchctlEnv(MESHRIX_MCP_DISCOVERY_URL_ENV);
  const launchMcpUrl: any = await readLaunchctlEnv(MESHRIX_MCP_URL_ENV);
  const fileCandidates: any = uniqueValues([
    discoveryRegistryPath(options),
    launchDiscoveryFile
  ]);
  const fromFiles: any[] = [];
  for (const filePath of fileCandidates) {
    const payload: any = await readJson(filePath, null);
    const server: any = payload?.servers?.[MCP_SERVER_NAME] || payload?.mcpServers?.[MCP_SERVER_NAME] || {};
    const profiles: any = (Object.values(payload?.serverConfig?.profiles || {}) as any[]);
    const activeProfile: any = payload?.serverConfig?.activeName
      ? payload?.serverConfig?.profiles?.[payload.serverConfig.activeName]
      : null;
    fromFiles.push(
      activeProfile?.baseUrl,
      baseUrlFromEndpoint(server.httpUrl),
      baseUrlFromEndpoint(server.url),
      baseUrlFromEndpoint(payload?.discovery?.preferredHttpDiscoveryUrl),
      baseUrlFromEndpoint(payload?.discovery?.preferredApiDiscoveryUrl),
      ...profiles.map((profile?: any) : any => profile?.baseUrl)
    );
  }
  const scanned: any = parseScanPorts(options).flatMap((port?: any) : any => [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`
  ]);
  return uniqueValues([
    baseUrlFromEndpoint(process.env[MESHRIX_MCP_URL_ENV]),
    baseUrlFromEndpoint(process.env[MESHRIX_MCP_DISCOVERY_URL_ENV]),
    baseUrlFromEndpoint(launchMcpUrl),
    baseUrlFromEndpoint(launchDiscoveryUrl),
    ...fromFiles,
    ...scanned
  ]).map(normalizeBaseUrl);
}

export async function fetchMeshrixDiscovery(baseUrl?: any) : Promise<any> {
  const url: any = `${baseUrl}/api/mcp/discovery`;
  const result: any = await fetchJson(url, { timeoutMs: 1500 });
  const payload: any = result.payload || {};
  const identity: any = payload.identity || null;
  if (
    !result.ok ||
    payload.name !== "Meshrix.js" ||
    payload.interfaceVersion !== MCP_INTERFACE_VERSION ||
    payload.stableToolName !== MCP_STABLE_TOOL_NAME ||
    identity?.algorithm !== "Ed25519" ||
    !identity?.publicKeyJwk ||
    !payload.handshake?.url
  ) {
    throw new Error("not an Meshrix.js MCP discovery response");
  }
  return payload;
}

export async function verifyMeshrixHandshake(baseUrl?: any, discovery?: any) : Promise<any> {
  const nonce: any = randomBytes(32).toString("base64url");
  const result: any = await fetchJson(`${baseUrl}/api/mcp/handshake`, {
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
  const payload: any = result.payload?.payload || {};
  const signature: any = result.payload?.signature || {};
  const publicKeyJwk: any = payload.identity?.publicKeyJwk;
  if (
    !result.ok ||
    result.payload?.ok !== true ||
    payload.schemaVersion !== "v0.0.1:mcp:handshake-1" ||
    payload.nonce !== nonce ||
    payload.server?.name !== "Meshrix.js" ||
    payload.server?.interfaceVersion !== MCP_INTERFACE_VERSION ||
    payload.server?.stableToolName !== MCP_STABLE_TOOL_NAME ||
    payload.identity?.keyId !== discovery.identity?.keyId ||
    signature.algorithm !== "Ed25519" ||
    !verifyMcpHandshakeSignature({ publicKeyJwk, payload, signature: signature.value })
  ) {
    throw new Error("Meshrix.js MCP handshake signature verification failed");
  }
  return {
    ok: true,
    baseUrl,
    discovery,
    handshake: result.payload
  };
}

export async function discoverMeshrixHub(options: Record<string, any> = {}) : Promise<any> {
  const attempts: any[] = [];
  const candidates: any = await candidateBaseUrls(options);
  for (const baseUrl of candidates) {
    try {
      const discovery: any = await fetchMeshrixDiscovery(baseUrl);
      const verified: any = await verifyMeshrixHandshake(baseUrl, discovery);
      return {
        ...verified,
        attempts: [
          ...attempts,
          { baseUrl, ok: true, verified: true }
        ]
      };
    } catch (error: any) {
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
    reason: "No signed Meshrix.js MCP hub was discovered on this device."
  };
}

export async function optionsWithDiscoveredBaseUrl(options: Record<string, any> = {}) : Promise<any> {
  const discovered: any = await discoverMeshrixHub(options);
  if (!discovered.ok) {
    throw new Error(`${discovered.reason} Use --url only if you know the Meshrix.js base URL; it will still be handshake-verified.`);
  }
  return {
    ...options,
    "resolved-url": discovered.baseUrl,
    __meshrixDiscovery: discovered
  };
}

export async function publishLaunchctlEnv(env?: any) : Promise<any> {
  for (const name of Object.keys(env || {})) {
    if (/(?:token|secret|password|credential|api[_-]?key)/iu.test(name)) {
      throw new Error("sensitive_environment_persistence_requires_a_secret_store");
    }
  }
  if (process.platform === "darwin") {
    for (const [name, value] of (Object.entries(env) as [string, any][])) {
      await run("launchctl", ["setenv", name, value], { allowFailure: true });
    }
    return true;
  }

  if (process.platform === "win32") {
    for (const [name, value] of (Object.entries(env) as [string, any][])) {
      await run("setx", [name, value], { allowFailure: true });
    }
    return true;
  }

  process.stderr.write("\n[Notice] Please add the following to your ~/.bashrc or ~/.zshrc:\n");
  for (const [name, value] of (Object.entries(env) as [string, any][])) {
    process.stderr.write(`export ${name}="${value}"\n`);
  }
  process.stderr.write("\n");
  return false;
}

export async function resolveApiKey(options: Record<string, any> = {}, { required = false }: Record<string, any> = {}) : Promise<any> {
  const tokenEnv: any = assertSafeEnvName(String(option(options, "token-env", DEFAULT_TOKEN_ENV)));
  const envToken: any = String(process.env[tokenEnv] || "").trim();
  const stdinRequested: any = options["token-stdin"] === true;
  if (Object.hasOwn(process.env, tokenEnv)) {
    delete process.env[tokenEnv];
  }
  if (stdinRequested && envToken) {
    throw new Error(`Ambiguous API Key input. Use either --token-stdin or ${tokenEnv}, not both.`);
  }
  const credential: any = stdinRequested ? (await readStdin()).trim() : envToken;
  if (!credential) {
    if (required) throw new Error(`Missing API Key. Provide --token-stdin or ${tokenEnv}.`);
    return "";
  }
  if (!MXAK1_CREDENTIAL_PATTERN.test(credential)) {
    throw new Error("Invalid API Key. A strict mxak1 credential is required from protected stdin or the configured environment variable.");
  }
  return credential;
}

export function discardConfiguredApiKeyEnvironment(options: Record<string, any> = {}) : any {
  const tokenEnv: any = assertSafeEnvName(String(option(options, "token-env", DEFAULT_TOKEN_ENV)));
  if (Object.hasOwn(process.env, tokenEnv)) {
    delete process.env[tokenEnv];
  }
}

export async function ensureService(baseUrl?: any) : Promise<any> {
  const initialize: any = await fetchJson(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "meshrix-mcp-connector", version: packageJson.version }
      }
    })
  });
  if (!initialize.ok || initialize.payload?.result?.serverInfo?.name !== "Meshrix.js") {
    throw new Error(`Meshrix.js MCP is not available at ${baseUrl}/mcp.`);
  }
  return initialize;
}

export function authHeaders(token?: any, target: any = "") : any {
  const credential: any = String(token || "").trim();
  if (!MXAK1_CREDENTIAL_PATTERN.test(credential)) {
    throw new Error("Invalid API Key. A strict mxak1 credential is required.");
  }
  return {
    "Content-Type": "application/json",
    "X-Meshrix.js-Api-Key": credential,
    "X-Meshrix.js-Connector-Package-Id": "meshrix-mcp-connector",
    ...mcpTargetHeaders(target)
  };
}

export async function verifyMcpTools({ baseUrl, token, target = "" }: Record<string, any>) : Promise<any> {
  const toolsListBody: any = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsList: any = await fetchJson(`${baseUrl}/mcp`, {
    method: "POST",
    headers: authHeaders(token, target),
    body: toolsListBody
  });
  const healthBody: any = JSON.stringify({
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
  const health: any = await fetchJson(`${baseUrl}/mcp`, {
    method: "POST",
    headers: authHeaders(token, target),
    body: healthBody
  });
  const tools: any = toolsList.payload?.result?.tools || [];
  const toolNames: any = new Set<any>(tools.map((tool?: any) : any => tool.name));
  const hasStableOutlet: any = toolNames.has(MCP_STABLE_TOOL_NAME);
  const hasOnlyUniqueNamedTools: any = toolNames.size === tools.length && tools.every((tool?: any) : any => String(tool.name || "").trim());
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
  const runtimeMeta: any = toolsList.payload?.result?._meta || {};
  const runtimeSupportedTargets: any = Array.isArray(runtimeMeta.supportedTargets)
    ? runtimeMeta.supportedTargets.map((target?: any) : any => target.target).filter(Boolean)
    : [];
  return {
    toolCount: tools.length,
    stableToolName: tools.find((t?: any) : any => t.name === MCP_STABLE_TOOL_NAME)?.name || "",
    systemHealthOk: health.payload?.result?.structuredContent?.payload?.ok === true,
    sharedHubOk: runtimeMeta.sharedHub?.directHttp === true,
    priorityTargets: Array.isArray(runtimeMeta.priorityTargets) ? runtimeMeta.priorityTargets : [],
    supportedTargets: runtimeSupportedTargets
  };
}
