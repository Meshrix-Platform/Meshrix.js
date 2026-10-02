import {
  buildMcpHandshakePayload,
  publicMcpIdentity,
  signMcpHandshake
} from "../adapter/gateway-installer/mcp-identity.ts";
import {
  DEFAULT_TIMEOUT_MS,
  MESHRIX_MCP_DISCOVERY_FILE,
  MESHRIX_MCP_DISCOVERY_FILE_ENV,
  MESHRIX_MCP_DISCOVERY_URL_ENV,
  MESHRIX_MCP_URL_ENV,
  MCP_NPM_PACKAGE_NAME,
  MCP_NPM_PACKAGE_VERSION,
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME,
  MCP_INTERFACE_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_VERSION,
  MCP_STABLE_TOOL_NAME,
  MCP_TOOLSET_VERSION
} from "../adapter/http-mcp-adapter-constants.ts";
import {
  MCP_CLIENT_TARGETS,
  MCP_CLIENT_ADAPTER_PROTOCOL,
  MCP_PRIORITY_INSTALL_TARGET,
  MCP_PRIORITY_INSTALL_TARGETS,
  mcpPublicSupportedTargetDetails as releaseMcpPublicSupportedTargetDetails,
  mcpSupportedTargetDetails as releaseMcpSupportedTargetDetails
} from "../adapter/mcp-release-targets.ts";
import {
  MCP_CACHE_SCOPE_PUBLIC,
  MCP_DISCOVER_CACHE_TTL_MS,
  MCP_META_SERVER_INFO,
  mcpCacheFields,
  mcpCompleteResult,
  mcpInitializeCapabilities
} from "./protocol.ts";

function parseRequestBody(requestBody?: any) : any {
  if (!requestBody || requestBody.length === 0) return {};
  return JSON.parse(requestBody.toString("utf8"));
}

export function mcpVersionInfo() : any {
  return {
    interfaceVersion: MCP_INTERFACE_VERSION,
    toolsetVersion: MCP_TOOLSET_VERSION,
    serverVersion: MCP_SERVER_VERSION,
    stableToolName: MCP_STABLE_TOOL_NAME,
    categorizedOutlets: [MCP_DISCOVERY_TOOL_NAME, MCP_GATEWAY_TOOL_NAME],
    capabilitiesSummary: "Meshrix.js MCP gateway layer. Plugin outlets are advertised only when their contributions are active and visible.",
    capabilityFamilies: {},
    listChanged: true,
    upgradeNotification: "notifications/tools/list_changed",
    connector: {
      packageName: MCP_NPM_PACKAGE_NAME,
      packageVersion: MCP_NPM_PACKAGE_VERSION
    }
  };
}

export function mcpConnectorRuntimeMetadata(discovery?: any, version: any = mcpVersionInfo()) : any {
  return {
    ...version.connector,
    clientInstallCommand: discovery.installer.clientInstallCommand,
    clientInstallJsonCommand: discovery.installer.clientInstallJsonCommand,
    autoInstallCommand: discovery.installer.autoInstallCommand,
    priorityInstallCommand: discovery.installer.priorityInstallCommand,
    installCommand: discovery.installer.installCommand,
    uninstallCommand: discovery.installer.uninstallCommand,
    discoverCommand: discovery.installer.discoverCommand,
    scanCommand: discovery.installer.scanCommand,
    doctorCommand: discovery.installer.doctorCommand,
    portableAutoInstallCommand: discovery.installer.portable.autoInstallCommand,
    portablePriorityInstallCommand: discovery.installer.portable.priorityInstallCommand,
    portableClientInstallJsonCommand: discovery.installer.portable.clientInstallJsonCommand
  };
}

export function mcpRuntimeMetadata({ listenUrl = "", discoveryState = null }: Record<string, any> = {}) : any {
  const discovery: any = buildMeshrixMcpDiscovery({ listenUrl, discoveryState });
  const version: any = mcpVersionInfo();
  return {
    ...version,
    connector: mcpConnectorRuntimeMetadata(discovery, version),
    sharedHub: discovery.sharedHub,
    priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS],
    supportedTargets: mcpPublicSupportedTargetDetails()
  };
}

export function mcpAuthorizationErrorData({ authorization = {}, listenUrl = "", discoveryState = null }: Record<string, any> = {}) : any {
  const discovery: any = buildMeshrixMcpDiscovery({ listenUrl, discoveryState });
  const connector: any = mcpConnectorRuntimeMetadata(discovery);
  const nextCommand: any = connector.autoInstallCommand;
  return {
    code: authorization.reasonCode || "authorization_denied",
    stableToolName: MCP_STABLE_TOOL_NAME,
    connector,
    priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS],
    supportedTargets: mcpPublicSupportedTargetDetails(),
    nextCommand,
    repairCommands: [
      nextCommand,
      connector.priorityInstallCommand,
      connector.doctorCommand
    ].filter(Boolean).filter((command?: any, index?: any, commands?: any) : any => commands.indexOf(command) === index)
  };
}

export function mcpDiscoveryBase({ listenUrl = "", discoveryState = null }: Record<string, any> = {}) : any {
  const baseUrl: any = String(discoveryState?.activeServiceUrl || listenUrl || "").replace(/\/+$/, "");
  let vmBaseUrl: any = "";
  try {
    const parsed: any = new URL(baseUrl);
    vmBaseUrl = `${parsed.protocol}//host.orb.internal:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  } catch {
    // Keep the conservative default.
  }
  return { baseUrl, vmBaseUrl };
}

function shellQuote(value?: any) : any {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function commandUrlArgs(baseUrl?: any) : any {
  const text: any = String(baseUrl || "").trim();
  return text ? ` --url ${shellQuote(text)}` : "";
}

export function npmMcpCommand(command = "", baseUrl = ""): string {
  const baseCommand = `npx --yes --package ${MCP_NPM_PACKAGE_NAME}@${MCP_NPM_PACKAGE_VERSION} meshrix-mcp`;
  const urlArgs: any = commandUrlArgs(baseUrl);
  const commandText = [baseCommand, command].filter(Boolean).join(" ");
  return `${commandText}${urlArgs}`;
}

function mcpTargetConfigTemplate(_target?: any, { baseUrl = "", vmBaseUrl = "" }: Record<string, any> = {}) : any {
  return {
    protocol: MCP_CLIENT_ADAPTER_PROTOCOL,
    endpoint: {
      httpUrl: `${baseUrl}/mcp`,
      vmHttpUrl: `${vmBaseUrl}/mcp`,
      tokenEnv: "MESHRIX_MCP_TOKEN"
    }
  };
}

function mcpPublicTargetConfigTemplate(_target?: any, { baseUrl = "", vmBaseUrl = "" }: Record<string, any> = {}) : any {
  return {
    endpoint: {
      httpUrl: `${baseUrl}/mcp`,
      vmHttpUrl: `${vmBaseUrl}/mcp`,
      tokenEnv: "MESHRIX_MCP_TOKEN"
    }
  };
}

function mcpClientTargetGuides({ baseUrl = "", vmBaseUrl = "" }: Record<string, any> = {}) : any {
  const urlArgs: any = commandUrlArgs(baseUrl);
  const packageExec = `npx --yes --package ${MCP_NPM_PACKAGE_NAME}@${MCP_NPM_PACKAGE_VERSION} meshrix-mcp`;
  return MCP_CLIENT_TARGETS.map((client?: any) : any => ({
    target: client.target,
    label: client.label,
    priority: client.priority,
    locations: [...client.locations],
    endpoints: {
      mcpUrl: `${baseUrl}/mcp`,
      vmMcpUrl: `${vmBaseUrl}/mcp`
    },
    install: {
      command: `${packageExec} install --target ${client.target}${urlArgs}`,
      commandJson: `${packageExec} install --target ${client.target}${urlArgs} --json`,
      uninstallCommand: `${packageExec} uninstall --target ${client.target}${urlArgs} --json`,
      doctorCommand: `${packageExec} doctor${urlArgs} --json`
    },
    tokenInput: "api-key-stdin-or-env",
    configTemplate: mcpPublicTargetConfigTemplate(client.target, { baseUrl, vmBaseUrl })
  }));
}

export function mcpSupportedTargetDetails() : any {
  return releaseMcpSupportedTargetDetails();
}

export function mcpPublicSupportedTargetDetails() : any {
  return releaseMcpPublicSupportedTargetDetails();
}

export function buildMeshrixMcpDiscovery({ listenUrl = "", discoveryState = null }: Record<string, any> = {}) : any {
  const { baseUrl, vmBaseUrl } = mcpDiscoveryBase({ listenUrl, discoveryState });
  const urlArgs: any = commandUrlArgs(baseUrl);
  const packageExec = `npx --yes --package ${MCP_NPM_PACKAGE_NAME}@${MCP_NPM_PACKAGE_VERSION} meshrix-mcp`;
  const installCommand: any = npmMcpCommand("install", baseUrl);
  const clientInstallCommand: any = `${packageExec} install --target codex${urlArgs}`;
  const clientInstallJsonCommand: any = `${packageExec} install --target codex${urlArgs} --json`;
  const autoInstallCommand: any = `${packageExec} install --target auto${urlArgs} --json`;
  const priorityInstallCommand: any = `${packageExec} install --target ${MCP_PRIORITY_INSTALL_TARGET}${urlArgs} --json`;
  const interactiveInstallCommand: any = installCommand;
  const uninstallCommand: any = `${packageExec} uninstall --target codex${urlArgs} --json`;
  const doctorCommand: any = `${packageExec} doctor${urlArgs} --json`;
  const discoverCommand: any = `${packageExec} discover-local${urlArgs} --json`;
  const scanCommand: any = `${packageExec} scan${urlArgs} --json`;
  const clientTargets: any = mcpClientTargetGuides({ baseUrl, vmBaseUrl });
  const supportedTargets: any = mcpPublicSupportedTargetDetails();
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    name: "Meshrix.js",
    description: "Meshrix.js MCP gateway layer. Provides Discovery, Gateway, and enabled plugin outlets.",
    interfaceVersion: MCP_INTERFACE_VERSION,
    toolsetVersion: MCP_TOOLSET_VERSION,
    serverVersion: MCP_SERVER_VERSION,
    serverId: discoveryState?.serverId || "",
    stableToolName: MCP_STABLE_TOOL_NAME,
    sharedHub: {
      canonicalMcpUrl: `${baseUrl}/mcp`,
      vmMcpUrl: `${vmBaseUrl}/mcp`,
      clientPolicy: "discover-shared-hub-then-opt-in",
      defaultClientMutation: "none",
      directHttp: true
    },
    localDiscovery: {
      entrypoint: {
        command: discoverCommand,
        registryFile: MESHRIX_MCP_DISCOVERY_FILE,
        schemaVersion: "v0.0.1:mcp:device-hub-1"
      },
      env: {
        [MESHRIX_MCP_URL_ENV]: `${baseUrl}/mcp`,
        [MESHRIX_MCP_DISCOVERY_URL_ENV]: `${baseUrl}/.well-known/meshrix/mcp.json`,
        [MESHRIX_MCP_DISCOVERY_FILE_ENV]: MESHRIX_MCP_DISCOVERY_FILE
      },
      files: [
        MESHRIX_MCP_DISCOVERY_FILE
      ],
      http: [
        `${baseUrl}/.well-known/meshrix/mcp.json`,
        `${baseUrl}/api/mcp/discovery`
      ],
      lookupOrder: [
        "meshrix-mcp discover-local --json",
        "MESHRIX_MCP_URL",
        "MESHRIX_MCP_DISCOVERY_URL",
        "MESHRIX_MCP_DISCOVERY_FILE",
        "local port scan"
      ]
    },
    installer: {
      packageName: MCP_NPM_PACKAGE_NAME,
      packageVersion: MCP_NPM_PACKAGE_VERSION,
      releaseChannel: "stable",
      supportedTargets,
      priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS],
      installCommand,
      interactiveInstallCommand,
      autoInstallCommand,
      priorityInstallCommand,
      clientInstallCommand,
      clientInstallJsonCommand,
      uninstallCommand,
      doctorCommand,
      discoverCommand,
      scanCommand,
      tokenInput: "api-key-stdin-or-env",
      portable: {
        requiresInstalledNode: false,
        strategy: "verified-portable-connector",
        preferredArchive: "versioned-portable-archive",
        releaseChecksumFile: "RELEASE_SHA256SUMS",
        releaseChecksumSigstoreBundleFile: "RELEASE_SHA256SUMS.sigstore.json",
        checksumAuthorityVerificationOrder: "sigstore-bundle-then-asset-digest",
        checksumVerificationRequired: true,
        command: "meshrix-mcp",
        supportsMultiSelect: true,
        releaseAssetPattern: "meshrix-mcp-connector-<version>-<platform>.<tar.gz|zip>",
        tarballReleaseAssetPattern: "meshrix-mcp-connector-<version>-<platform>.tar.gz",
        zipInstallEntry: "",
        installCommand,
        interactiveInstallCommand,
        autoInstallCommand,
        priorityInstallCommand,
        priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS],
        clientInstallCommand,
        clientInstallJsonCommand,
        doubleClickEntry: ""
      }
    },
    clientTargets,
    upgrade: {
      listChanged: true,
      notification: "notifications/tools/list_changed",
      reinstallCommand: installCommand,
      priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS],
      doctorCommand
    },
    mcpServers: {
      meshrix: {
        httpUrl: `${baseUrl}/mcp`,
        vmHttpUrl: `${vmBaseUrl}/mcp`,
        headers: {
          "X-Meshrix.js-Api-Key": "${MESHRIX_MCP_TOKEN}"
        },
        authProviderType: "meshrix_api_key",
        timeout: DEFAULT_TIMEOUT_MS
      }
    },
    auth: {
      type: "meshrix_operation_permission_token",
      acceptedHeaders: ["Authorization: Bearer <token>", "X-Meshrix.js-Api-Key"],
      tokenSource: "Meshrix.js Operation Permission grant token"
    },
    identity: discoveryState?.mcpIdentity
      ? publicMcpIdentity(discoveryState.mcpIdentity)
      : null,
    handshake: {
      schemaVersion: "v0.0.1:mcp:handshake-1",
      method: "POST",
      url: `${baseUrl}/api/mcp/handshake`,
      nonceBytes: 32,
      signatureAlgorithm: "Ed25519",
      signaturePayloadEncoding: "v0.0.1:platform:stable-json-1"
    }
  };
}

function validHandshakeNonce(value?: any) : any {
  return /^[A-Za-z0-9_-]{24,256}$/.test(String(value || ""));
}

function gatewayTransitEvidence(request?: any) : any {
  const adapterId: any = String(request?.headers?.["x-meshrix-gateway"] || "").trim().toLowerCase();
  const route: any = String(request?.headers?.["x-meshrix-gateway-route"] || "").trim();
  const requestId: any = String(request?.headers?.["x-meshrix-gateway-request-id"] || "").trim();
  if (!["caddy", "nginx"].includes(adapterId) || route !== "/api/mcp/handshake" || !requestId) {
    return null;
  }
  return Object.freeze({ adapterId, route, requestIdPresent: true });
}

export function mcpHandshake({ request = null, requestBody, listenUrl = "", discoveryState = null }: Record<string, any>) : any {
  const identity: any = discoveryState?.mcpIdentity;
  if (!identity) {
    return {
      ok: false,
      status: 503,
      body: {
        ok: false,
        error: "Meshrix.js MCP identity is not available."
      }
    };
  }
  const body: any = parseRequestBody(requestBody);
  const nonce: any = String(body?.nonce || "").trim();
  if (!validHandshakeNonce(nonce)) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: "MCP handshake requires a base64url nonce with at least 24 characters."
      }
    };
  }
  const { baseUrl, vmBaseUrl } = mcpDiscoveryBase({ listenUrl, discoveryState });
  const discovery: any = buildMeshrixMcpDiscovery({ listenUrl, discoveryState });
  const issuedAt: any = new Date().toISOString();
  const payload: any = buildMcpHandshakePayload({
    nonce,
    issuedAt,
    identity,
    discovery,
    baseUrl,
    vmBaseUrl,
    externalGateway: gatewayTransitEvidence(request)
  });
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      payload,
      signature: signMcpHandshake({ identity, payload })
    }
  };
}

export function mcpDiscoverResult({ listenUrl = "", discoveryState = null, serverInfo = { name: "Meshrix.js", version: MCP_SERVER_VERSION } }: Record<string, any> = {}) : any {
  const runtime: any = mcpRuntimeMetadata({ listenUrl, discoveryState });
  const cache: any = mcpCacheFields({
    ttlMs: MCP_DISCOVER_CACHE_TTL_MS,
    cacheScope: MCP_CACHE_SCOPE_PUBLIC
  });
  return mcpCompleteResult({
    supportedVersions: [MCP_PROTOCOL_VERSION],
    capabilities: mcpInitializeCapabilities(),
    instructions: runtime.capabilitiesSummary,
    ttlMs: cache.ttlMs,
    cacheScope: cache.cacheScope,
    _meta: {
       [MCP_META_SERVER_INFO]: serverInfo,
      ...runtime
    }
  });
}

function mcpToolResult(payload?: any) : any {
  const structuredContent: any = payload?.result !== undefined ? payload.result : payload;
  return {
    content: payload?.content || [
      {
        type: "text",
        text: JSON.stringify(structuredContent ?? {}, null, 2)
      }
    ],
    structuredContent
  };
}
