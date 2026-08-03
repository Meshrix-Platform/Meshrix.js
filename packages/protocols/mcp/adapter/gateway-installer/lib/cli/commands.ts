import {
  MCP_INTERFACE_VERSION,
  MCP_SERVER_NAME,
  MCP_STABLE_TOOL_NAME,
  packageJson,
  sharedHubContract
} from "./constants.ts";
import { normalizeTarget, option } from "./basic-utils.ts";
import { writeServerConfigProfile, serverConfigCommand } from "./device-config.ts";
import {
  discardConfiguredApiKeyEnvironment,
  discoverMeshrixHub,
  ensureService,
  optionsWithDiscoveredBaseUrl,
  resolveApiKey,
  verifyMcpTools
} from "./discovery.ts";
import {
  commandGuidanceContext,
  doctorGuidance,
  installGuidanceMetadata,
  shellCommandForDiscoverLocal
} from "./guidance.ts";
import {
  deviceDiscoveryEnv,
  deviceDiscoveryPaths,
  discoveryRegistryPath,
  readJson
} from "./device-discovery-registry.ts";
import { fetchCommand } from "./fetch-command.ts";
import { fetchJson } from "./http-json-client.ts";
import { installerOptions } from "./installer-options.ts";
import { installCommand } from "./install-command.ts";
import { proxyCommand } from "./proxy-command.ts";
import { scanInstallTargets } from "./scan-candidates.ts";
import { uninstallCommand } from "./uninstall-command.ts";

export async function registerCommand(options?: any) : Promise<any> {
  discardConfiguredApiKeyEnvironment(options);
  const resolvedOptions: any = await optionsWithDiscoveredBaseUrl(options);
  const settings: any = installerOptions(resolvedOptions);
  const parsedBaseUrl: any = new URL(settings.baseUrl);
  const port: any = parsedBaseUrl.port || (parsedBaseUrl.protocol === "https:" ? "443" : "80");
  const mcpUrl: any = `${settings.baseUrl}/mcp`;
  const vmMcpUrl: any = `${parsedBaseUrl.protocol}//host.orb.internal:${port}/mcp`;
  const profile: any = await writeServerConfigProfile({
    options: resolvedOptions,
    name: String(option(resolvedOptions, "name", "default")).trim() || "default",
    discovered: resolvedOptions.__meshrixDiscovery,
    publishEnv: !resolvedOptions["no-env"]
  });
  const discoveryManifest: any = profile.path;
  const localFiles: any = deviceDiscoveryPaths(resolvedOptions);
  const env: any = deviceDiscoveryEnv({ baseUrl: settings.baseUrl, primaryPath: discoveryManifest });
  const tokenEnv: any = profile.tokenEnv || settings.tokenEnv;
  const includeUrl: any = Boolean(settings.baseUrl);
  const guidance: any = installGuidanceMetadata({ includeUrl, baseUrl: settings.baseUrl, tokenEnv });
  return {
    ok: true,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    mode: "device-hub-registration",
    baseUrl: settings.baseUrl,
    mcpUrl,
    sharedHub: sharedHubContract({ mcpUrl, vmMcpUrl }),
    discoveryManifest,
    localEntry: {
      command: shellCommandForDiscoverLocal({ includeUrl: Boolean(settings.baseUrl), baseUrl: settings.baseUrl }),
      registryFile: discoveryManifest
    },
    localFiles,
    env,
    ...guidance,
    clientInstall: guidance.clientInstallJsonCommand,
    autoInstall: guidance.autoInstallCommand,
    priorityInstall: guidance.priorityInstallCommand,
    verifiedHandshake: resolvedOptions.__meshrixDiscovery?.handshake?.payload?.identity?.keyId || "",
    serverConfig: profile.profile,
    note: "Discovered and registered the signed Meshrix MCP endpoint without installing it into any client."
  };
}

export async function readLocalDiscoveryFile(filePath?: any) : Promise<any> {
  const payload: any = await readJson(filePath, null);
  const server: any = payload?.servers?.[MCP_SERVER_NAME] || {};
  if (!server.httpUrl) {
    return null;
  }
  return {
    sourceType: "file",
    source: filePath,
    payload,
    mcpUrl: server.httpUrl,
    discoveryUrl: server.discoveryUrl || payload.discovery?.preferredHttpDiscoveryUrl || ""
  };
}

export async function fetchDiscoveryUrl(url?: any) : Promise<any> {
  const response: any = await fetchJson(url);
  if (!response.ok) {
    return null;
  }
  const server: any = response.payload?.mcpServers?.[MCP_SERVER_NAME] || response.payload?.servers?.[MCP_SERVER_NAME] || {};
  const mcpUrl: any = server.httpUrl || server.url || "";
  if (!mcpUrl) {
    return null;
  }
  return {
    sourceType: "http",
    source: url,
    payload: response.payload,
    mcpUrl,
    discoveryUrl: url
  };
}

export async function discoverLocalCommand(options?: any) : Promise<any> {
  discardConfiguredApiKeyEnvironment(options);
  const discovered: any = await discoverMeshrixHub(options);
  if (!discovered.ok) {
    return {
      ok: false,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      attempts: discovered.attempts,
      reason: discovered.reason
    };
  }
  return {
    ok: true,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    sourceType: "signed-handshake",
    source: discovered.baseUrl,
    baseUrl: discovered.baseUrl,
    mcpUrl: `${discovered.baseUrl}/mcp`,
    discoveryUrl: `${discovered.baseUrl}/api/mcp/discovery`,
    identityKeyId: discovered.handshake?.payload?.identity?.keyId || "",
    attempts: discovered.attempts
  };
}

export async function doctorCommand(options?: any) : Promise<any> {
  const token: any = await resolveApiKey(options, { required: false });
  const resolvedOptions: any = await optionsWithDiscoveredBaseUrl(options);
  const settings: any = installerOptions(resolvedOptions);
  const discovered: any = resolvedOptions.__meshrixDiscovery || null;
  const target: any = normalizeTarget(option(resolvedOptions, "target", process.env.MESHRIX_MCP_TARGET || ""));
  const deviceManifestPath: any = discoveryRegistryPath(resolvedOptions);
  const discovery: any = await fetchJson(`${settings.baseUrl}/api/mcp/discovery`);
  const initialize: any = await ensureService(settings.baseUrl);
  const initializeMeta: any = initialize.payload?.result?._meta || {};
  const initializeSupportedTargets: any = Array.isArray(initializeMeta.supportedTargets)
    ? initializeMeta.supportedTargets.map((target?: any) : any => target.target).filter(Boolean)
    : [];
  const checks: Record<string, any> = {
    signedDiscovery: {
      ok: Boolean(discovered?.ok),
      baseUrl: settings.baseUrl,
      identityKeyId: discovered?.handshake?.payload?.identity?.keyId || "",
      attempts: discovered?.attempts || []
    },
    discovery: {
      ok: discovery.ok,
      status: discovery.status,
      installerPackage: discovery.payload?.installer?.packageName || "",
      httpUrl: discovery.payload?.mcpServers?.meshrix?.httpUrl || ""
    },
    initialize: {
      ok: true,
      serverName: initialize.payload?.result?.serverInfo?.name || "",
      serverVersion: initialize.payload?.result?.serverInfo?.version || "",
      stableToolName: initialize.payload?.result?._meta?.stableToolName || "",
      listChanged: initialize.payload?.result?.capabilities?.tools?.listChanged === true,
      sharedHubOk: initializeMeta.sharedHub?.directHttp === true,
      sharedHub: initializeMeta.sharedHub || discovery.payload?.sharedHub || null,
      priorityTargets: Array.isArray(initializeMeta.priorityTargets) ? initializeMeta.priorityTargets : [],
      supportedTargets: initializeSupportedTargets
    },
    toolsList: {
      ok: false,
      skipped: true,
      toolCount: 0,
      stableOutletSet: false,
      reason: "Set MESHRIX_MCP_TOKEN or use --token-stdin to verify tools/list."
    },
    systemHealth: {
      ok: false,
      skipped: true,
      healthy: false,
      reason: "Set MESHRIX_MCP_TOKEN or use --token-stdin to verify tools/call system.health."
    },
    deviceManifest: {
      ok: false,
      exists: false,
      pathRedacted: true
    }
  };

  if (token) {
    try {
      const verification: any = await verifyMcpTools({ baseUrl: settings.baseUrl, token, target });
      checks.toolsList = {
        ok: verification.stableToolName === MCP_STABLE_TOOL_NAME,
        skipped: false,
        toolCount: verification.toolCount,
        stableOutletSet: verification.stableToolName === MCP_STABLE_TOOL_NAME,
        categorizedOutletsOnly: true,
        sharedHubOk: verification.sharedHubOk,
        priorityTargets: verification.priorityTargets,
        supportedTargets: verification.supportedTargets
      };
      checks.systemHealth = {
        ok: verification.systemHealthOk,
        skipped: false,
        healthy: verification.systemHealthOk,
        operation: "system.health"
      };
    } catch (error: any) {
      const reason: any = error?.message || String(error);
      checks.toolsList = {
        ok: false,
        skipped: false,
        toolCount: 0,
        stableOutletSet: false,
        categorizedOutletsOnly: false,
        reason
      };
      checks.systemHealth = {
        ok: false,
        skipped: false,
        healthy: false,
        operation: "system.health",
        reason
      };
    }
  }

  const manifest: any = await readJson(deviceManifestPath, null);
  if (manifest) {
    const server: any = manifest.servers?.[MCP_SERVER_NAME] || {};
    checks.deviceManifest = {
      ok: true,
      exists: true,
      pathRedacted: true,
      httpUrl: server.httpUrl || "",
      connector: server.connector || null,
      installedTargets: (Object.entries(server.targets || {}) as [string, any][])
        .filter(([, status]: any[]) : any => status?.status === "installed")
        .map(([target]: any[]) : any => target)
    };
  }

  const guidance: any = doctorGuidance(checks, resolvedOptions);
  const { baseUrl, tokenEnv } = commandGuidanceContext(resolvedOptions);
  const includeUrl: any = Boolean(baseUrl);
  return {
    ok: checks.signedDiscovery.ok
      && checks.discovery.ok
      && checks.initialize.ok
      && (!token || (checks.toolsList.ok && checks.systemHealth.ok)),
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    sharedHub: checks.initialize.sharedHub,
    ...installGuidanceMetadata({ includeUrl, baseUrl, tokenEnv }),
    ...guidance,
    checks
  };
}

export async function discoverCommand(options?: any) : Promise<any> {
  discardConfiguredApiKeyEnvironment(options);
  const resolvedOptions: any = await optionsWithDiscoveredBaseUrl(options);
  const baseUrl: any = installerOptions(resolvedOptions).baseUrl;
  const discovery: any = await fetchJson(`${baseUrl}/api/mcp/discovery`);
  if (!discovery.ok) {
    throw new Error(`Meshrix MCP discovery failed: HTTP ${discovery.status}`);
  }
  return {
    ...discovery.payload,
    signedHandshake: {
      ok: true,
      identityKeyId: resolvedOptions.__meshrixDiscovery?.handshake?.payload?.identity?.keyId || ""
    }
  };
}

export async function scanCommand(options?: any) : Promise<any> {
  discardConfiguredApiKeyEnvironment(options);
  const discovered: any = await discoverMeshrixHub(options);
  const scanOptions: any = discovered.ok
    ? { ...options, "resolved-url": discovered.baseUrl, __meshrixDiscovery: discovered }
    : options;
  const scan: any = await scanInstallTargets(scanOptions);
  return {
    ...scan,
    serverDiscovery: discovered.ok
      ? {
          ok: true,
          baseUrl: discovered.baseUrl,
          identityKeyId: discovered.handshake?.payload?.identity?.keyId || ""
        }
      : {
          ok: false,
          attempts: discovered.attempts,
          reason: discovered.reason
      }
  };
}

export const MESHRIX_MCP_COMMAND_REGISTRY: Readonly<Record<string, any>> = Object.freeze({
  install: installCommand,
  register: registerCommand,
  proxy: proxyCommand,
  scan: scanCommand,
  "discover-local": discoverLocalCommand,
  uninstall: uninstallCommand,
  doctor: doctorCommand,
  discover: discoverCommand,
  fetch: fetchCommand,
  "server-config": serverConfigCommand
});
