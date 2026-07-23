import { randomBytes } from "node:crypto";

import { deleteProcessIdentity, loadProcessIdentity, saveProcessIdentity } from "../process-identity-store.mjs";
import {
  MCP_INTERFACE_VERSION,
  MCP_SERVER_NAME,
  MCP_STABLE_TOOL_NAME,
  packageJson,
  sharedHubContract
} from "./constants.mjs";
import { normalizeTarget, option } from "./basic-utils.mjs";
import { writeServerConfigProfile, serverConfigCommand } from "./device-config.mjs";
import {
  discoverLicoHub,
  ensureService,
  optionsWithDiscoveredBaseUrl,
  resolveToken,
  verifyMcpTools
} from "./discovery.mjs";
import {
  commandGuidanceContext,
  doctorGuidance,
  installGuidanceMetadata,
  shellCommandForDiscoverLocal
} from "./guidance.mjs";
import {
  deviceDiscoveryEnv,
  deviceDiscoveryPaths,
  discoveryRegistryPath,
  readJson
} from "./device-discovery-registry.mjs";
import { fetchJson } from "./http-json-client.mjs";
import { installerOptions } from "./installer-options.mjs";
import { installCommand } from "./install-command.mjs";
import { proxyCommand } from "./proxy-command.mjs";
import { scanInstallTargets } from "./scan-candidates.mjs";
import { uninstallCommand } from "./uninstall-command.mjs";

export async function registerCommand(options) {
  const resolvedOptions = await optionsWithDiscoveredBaseUrl(options);
  const settings = installerOptions(resolvedOptions);
  const parsedBaseUrl = new URL(settings.baseUrl);
  const port = parsedBaseUrl.port || (parsedBaseUrl.protocol === "https:" ? "443" : "80");
  const mcpUrl = `${settings.baseUrl}/mcp`;
  const vmMcpUrl = `${parsedBaseUrl.protocol}//host.orb.internal:${port}/mcp`;
  const profile = await writeServerConfigProfile({
    options: resolvedOptions,
    name: String(option(resolvedOptions, "name", "default")).trim() || "default",
    discovered: resolvedOptions.__licoDiscovery,
    publishEnv: !resolvedOptions["no-env"]
  });
  const discoveryManifest = profile.path;
  const localFiles = deviceDiscoveryPaths(resolvedOptions);
  const env = deviceDiscoveryEnv({ baseUrl: settings.baseUrl, primaryPath: discoveryManifest });
  const tokenEnv = profile.tokenEnv || settings.tokenEnv;
  const includeUrl = Boolean(settings.baseUrl);
  const guidance = installGuidanceMetadata({ includeUrl, baseUrl: settings.baseUrl, tokenEnv });
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
    verifiedHandshake: resolvedOptions.__licoDiscovery?.handshake?.payload?.identity?.keyId || "",
    serverConfig: profile.profile,
    note: "Discovered and registered the signed LicoMesh MCP endpoint without installing it into any client."
  };
}

export async function readLocalDiscoveryFile(filePath) {
  const payload = await readJson(filePath, null);
  const server = payload?.servers?.[MCP_SERVER_NAME] || {};
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

export async function fetchDiscoveryUrl(url) {
  const response = await fetchJson(url);
  if (!response.ok) {
    return null;
  }
  const server = response.payload?.mcpServers?.[MCP_SERVER_NAME] || response.payload?.servers?.[MCP_SERVER_NAME] || {};
  const mcpUrl = server.httpUrl || server.url || "";
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

export async function discoverLocalCommand(options) {
  const discovered = await discoverLicoHub(options);
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

export async function doctorCommand(options) {
  const resolvedOptions = await optionsWithDiscoveredBaseUrl(options);
  const settings = installerOptions(resolvedOptions);
  const discovered = resolvedOptions.__licoDiscovery || null;
  const token = await resolveToken(resolvedOptions, { required: false });
  const target = normalizeTarget(option(resolvedOptions, "target", process.env.LICO_MCP_TARGET || ""));
  const deviceManifestPath = discoveryRegistryPath(resolvedOptions);
  const discovery = await fetchJson(`${settings.baseUrl}/api/mcp/discovery`);
  const initialize = await ensureService(settings.baseUrl);
  const initializeMeta = initialize.payload?.result?._meta || {};
  const initializeSupportedTargets = Array.isArray(initializeMeta.supportedTargets)
    ? initializeMeta.supportedTargets.map((target) => target.target).filter(Boolean)
    : [];
  const checks = {
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
      httpUrl: discovery.payload?.mcpServers?.lico?.httpUrl || ""
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
      reason: "Set LICO_MCP_TOKEN or use --token-stdin to verify tools/list."
    },
    systemHealth: {
      ok: false,
      skipped: true,
      healthy: false,
      reason: "Set LICO_MCP_TOKEN or use --token-stdin to verify tools/call system.health."
    },
    deviceManifest: {
      ok: false,
      exists: false,
      pathRedacted: true
    }
  };

  if (token) {
    try {
      const verification = await verifyMcpTools({ baseUrl: settings.baseUrl, token, target });
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
    } catch (error) {
      const reason = error?.message || String(error);
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

  const manifest = await readJson(deviceManifestPath, null);
  if (manifest) {
    const server = manifest.servers?.[MCP_SERVER_NAME] || {};
    checks.deviceManifest = {
      ok: true,
      exists: true,
      pathRedacted: true,
      httpUrl: server.httpUrl || "",
      connector: server.connector || null,
      installedTargets: Object.entries(server.targets || {})
        .filter(([, status]) => status?.status === "installed")
        .map(([target]) => target)
    };
  }

  const guidance = doctorGuidance(checks, resolvedOptions);
  const { baseUrl, tokenEnv } = commandGuidanceContext(resolvedOptions);
  const includeUrl = Boolean(baseUrl);
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

export async function discoverCommand(options) {
  const resolvedOptions = await optionsWithDiscoveredBaseUrl(options);
  const baseUrl = installerOptions(resolvedOptions).baseUrl;
  const discovery = await fetchJson(`${baseUrl}/api/mcp/discovery`);
  if (!discovery.ok) {
    throw new Error(`LicoMesh MCP discovery failed: HTTP ${discovery.status}`);
  }
  return {
    ...discovery.payload,
    signedHandshake: {
      ok: true,
      identityKeyId: resolvedOptions.__licoDiscovery?.handshake?.payload?.identity?.keyId || ""
    }
  };
}

export async function scanCommand(options) {
  const discovered = await discoverLicoHub(options);
  const scanOptions = discovered.ok
    ? { ...options, "resolved-url": discovered.baseUrl, __licoDiscovery: discovered }
    : options;
  const scan = await scanInstallTargets(scanOptions);
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

export async function identityStoreSelfTestCommand(options = {}) {
  const target = normalizeTarget(option(options, "target", `verify-${randomBytes(6).toString("hex")}`));
  if (!target.startsWith("verify-")) {
    throw new Error("identity-store-self-test only accepts verify-* targets.");
  }
  await deleteProcessIdentity(target);
  const secretMarker = `verify-private-key-${randomBytes(18).toString("base64url")}`;
  const grantMarker = `verify-grant-${randomBytes(24).toString("base64url")}`;
  const record = {
    schemaVersion: "v0.0.1:process-identity:mcp-self-test-1",
    target,
    baseUrl: "http://127.0.0.1:0",
    savedAt: new Date().toISOString(),
    grantToken: grantMarker,
    privateKeyPem: secretMarker,
    clientIdentityPackage: {
      clientId: target,
      packageId: `pkg_${randomBytes(10).toString("base64url")}`,
      processKey: {
        processKeyId: `pkey_${randomBytes(10).toString("base64url")}`
      },
      clientFingerprint: {
        fingerprintId: `fp_${randomBytes(8).toString("base64url")}`,
        machineInstanceId: `machine_${randomBytes(8).toString("base64url")}`,
        appInstanceId: `app_${randomBytes(8).toString("base64url")}`,
        runtimeInstanceId: `runtime_${randomBytes(8).toString("base64url")}`,
        fingerprintHash: `sha256:${randomBytes(24).toString("base64url")}`
      }
    },
    serverIdentity: null
  };
  try {
    const saved = await saveProcessIdentity(target, record);
    const loaded = await loadProcessIdentity(target);
    if (!loaded || loaded.privateKeyPem !== secretMarker || loaded.grantToken !== grantMarker) {
      throw new Error("MCP process identity credential store roundtrip failed.");
    }
    return {
      ok: true,
      target,
      storageBackend: loaded.storageBackend || saved.storageBackend || "",
      systemCredential: (loaded.storageBackend || saved.storageBackend || "") !== "private-file-fallback",
      fileFallback: (loaded.storageBackend || saved.storageBackend || "") === "private-file-fallback",
      credentialRef: saved.filePath ? "" : saved.reference || loaded.credentialRef || "",
      fileModeChecked: saved.filePath ? true : false
    };
  } finally {
    await deleteProcessIdentity(target);
  }
}

export const LICO_MCP_COMMAND_REGISTRY = Object.freeze({
  install: installCommand,
  register: registerCommand,
  proxy: proxyCommand,
  scan: scanCommand,
  "discover-local": discoverLocalCommand,
  uninstall: uninstallCommand,
  doctor: doctorCommand,
  discover: discoverCommand,
  "server-config": serverConfigCommand,
  "identity-store-self-test": identityStoreSelfTestCommand
});
