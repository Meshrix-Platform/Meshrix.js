import {
  buildMcpHandshakePayload,
  publicMcpIdentity,
  signMcpHandshake
} from "./gateway-installer/mcp-identity.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  MESHRIX_MCP_DISCOVERY_FILE,
  MESHRIX_MCP_DISCOVERY_FILE_ENV,
  MESHRIX_MCP_DISCOVERY_URL_ENV,
  MESHRIX_MCP_URL_ENV,
  MCP_BOOTSTRAP_INSTALL_SCRIPT,
  MCP_BOOTSTRAP_INSTALL_SCRIPT_ZH_CN,
  MCP_BOOTSTRAP_UNINSTALL_SCRIPT,
  MCP_BOOTSTRAP_WINDOWS_INSTALL_SCRIPT,
  MCP_BOOTSTRAP_WINDOWS_UNINSTALL_SCRIPT,
  MCP_CLIENT_TARGETS,
  MCP_CONNECTOR_GITHUB_REPO,
  MCP_CONNECTOR_PACKAGE_NAME,
  MCP_CONNECTOR_VERSION,
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME,
  MCP_INTERFACE_VERSION,
  MCP_PRIORITY_INSTALL_TARGET,
  MCP_PRIORITY_INSTALL_TARGETS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_VERSION,
  MCP_STABLE_TOOL_NAME,
  MCP_TOOLSET_VERSION
} from "./http-mcp-adapter-constants.mjs";
import {
  MCP_CLIENT_ADAPTER_PROTOCOL,
  mcpPublicSupportedTargetDetails as releaseMcpPublicSupportedTargetDetails,
  mcpSupportedTargetDetails as releaseMcpSupportedTargetDetails
} from "./mcp-release-targets.mjs";
import { parseRequestBody } from "./http-mcp-adapter-response.mjs";

export function mcpVersionInfo() {
  return {
    interfaceVersion: MCP_INTERFACE_VERSION,
    toolsetVersion: MCP_TOOLSET_VERSION,
    serverVersion: MCP_SERVER_VERSION,
    stableToolName: MCP_STABLE_TOOL_NAME,
    categorizedOutlets: [MCP_DISCOVERY_TOOL_NAME, MCP_GATEWAY_TOOL_NAME],
    capabilitiesSummary: "Meshrix MCP gateway layer. Plugin outlets are advertised only when their contributions are active and visible.",
    capabilityFamilies: {},
    listChanged: true,
    upgradeNotification: "notifications/tools/list_changed",
    connector: {
      packageName: MCP_CONNECTOR_PACKAGE_NAME,
      packageVersion: MCP_CONNECTOR_VERSION
    }
  };
}

export function mcpConnectorRuntimeMetadata(discovery, version = mcpVersionInfo()) {
  return {
    ...version.connector,
    githubOneLineCommand: discovery.installer.githubOneLineCommand,
    githubOneLineCommandZhCN: discovery.installer.githubOneLineCommandZhCN,
    clientInstallCommand: discovery.installer.clientInstallCommand,
    clientInstallJsonCommand: discovery.installer.clientInstallJsonCommand,
    autoInstallCommand: discovery.installer.autoInstallCommand,
    priorityInstallCommand: discovery.installer.priorityInstallCommand,
    githubOneLineInstallCommand: discovery.installer.githubOneLineInstallCommand,
    githubOneLineInstallCommandZhCN: discovery.installer.githubOneLineInstallCommandZhCN,
    githubOneLineClientInstallJsonCommand: discovery.installer.githubOneLineClientInstallJsonCommand,
    githubOneLineClientInstallJsonCommandZhCN: discovery.installer.githubOneLineClientInstallJsonCommandZhCN,
    githubOneLineAutoInstallCommand: discovery.installer.githubOneLineAutoInstallCommand,
    githubOneLineAutoInstallCommandZhCN: discovery.installer.githubOneLineAutoInstallCommandZhCN,
    githubOneLinePriorityInstallCommand: discovery.installer.githubOneLinePriorityInstallCommand,
    githubOneLinePriorityInstallCommandZhCN: discovery.installer.githubOneLinePriorityInstallCommandZhCN,
    oneCommandInstall: discovery.installer.oneCommandInstall,
    oneCommandInstallZhCN: discovery.installer.oneCommandInstallZhCN,
    oneCommandClientInstallJson: discovery.installer.oneCommandClientInstallJson,
    oneCommandClientInstallJsonZhCN: discovery.installer.oneCommandClientInstallJsonZhCN,
    oneCommandAutoInstall: discovery.installer.oneCommandAutoInstall,
    oneCommandAutoInstallZhCN: discovery.installer.oneCommandAutoInstallZhCN,
    oneCommandPriorityInstall: discovery.installer.oneCommandPriorityInstall,
    oneCommandPriorityInstallZhCN: discovery.installer.oneCommandPriorityInstallZhCN,
    discoverCommand: discovery.installer.discoverCommand,
    scanCommand: discovery.installer.scanCommand,
    doctorCommand: discovery.installer.doctorCommand,
    portableAutoInstallCommand: discovery.installer.portable.autoInstallCommand,
    portablePriorityInstallCommand: discovery.installer.portable.priorityInstallCommand,
    portableClientInstallJsonCommand: discovery.installer.portable.clientInstallJsonCommand
  };
}

export function mcpRuntimeMetadata({ listenUrl = "", discoveryState = null } = {}) {
  const discovery = buildLicoMcpDiscovery({ listenUrl, discoveryState });
  const version = mcpVersionInfo();
  return {
    ...version,
    connector: mcpConnectorRuntimeMetadata(discovery, version),
    sharedHub: discovery.sharedHub,
    priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS],
    supportedTargets: mcpPublicSupportedTargetDetails()
  };
}

export function mcpAuthorizationErrorData({ authorization = {}, listenUrl = "", discoveryState = null } = {}) {
  const discovery = buildLicoMcpDiscovery({ listenUrl, discoveryState });
  const connector = mcpConnectorRuntimeMetadata(discovery);
  const nextCommand = connector.oneCommandAutoInstall || connector.autoInstallCommand;
  const nextCommandZhCN = connector.oneCommandAutoInstallZhCN || connector.githubOneLineAutoInstallCommandZhCN;
  return {
    code: authorization.reasonCode || "authorization_denied",
    stableToolName: MCP_STABLE_TOOL_NAME,
    connector,
    authorizationRequestEndpoint: discovery.installer.authorizationRequestEndpoint,
    authorizationConsumeEndpointTemplate: discovery.installer.authorizationConsumeEndpointTemplate,
    priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS],
    supportedTargets: mcpPublicSupportedTargetDetails(),
    nextCommand,
    nextCommandZhCN,
    repairCommands: [
      nextCommand,
      nextCommandZhCN,
      connector.oneCommandPriorityInstall,
      connector.oneCommandPriorityInstallZhCN,
      connector.autoInstallCommand,
      connector.priorityInstallCommand,
      connector.doctorCommand
    ].filter(Boolean).filter((command, index, commands) => commands.indexOf(command) === index)
  };
}

export function mcpDiscoveryBase({ listenUrl = "", discoveryState = null } = {}) {
  const baseUrl = String(discoveryState?.activeServiceUrl || listenUrl || "").replace(/\/+$/, "");
  let vmBaseUrl = "";
  try {
    const parsed = new URL(baseUrl);
    vmBaseUrl = `${parsed.protocol}//host.orb.internal:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  } catch {
    // Keep the conservative default.
  }
  return { baseUrl, vmBaseUrl };
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function commandUrlArgs(baseUrl) {
  const text = String(baseUrl || "").trim();
  return text ? ` --url ${shellQuote(text)}` : "";
}

function githubOneLineMcpInstallCommand(scriptName = MCP_BOOTSTRAP_INSTALL_SCRIPT) {
  if (!/^[A-Za-z0-9._-]+$/u.test(String(scriptName || ""))) {
    throw new Error("invalid_local_installer_name");
  }
  return `/bin/sh -c 'exec /bin/sh ./${scriptName} "$@"'`;
}

export function githubOneLineMcpInstallCommands({ baseUrl = "" } = {}) {
  const urlArgs = commandUrlArgs(baseUrl);
  const command = githubOneLineMcpInstallCommand();
  const commandZhCN = githubOneLineMcpInstallCommand(MCP_BOOTSTRAP_INSTALL_SCRIPT_ZH_CN);
  const build = (oneLineCommand) => ({
    installCommand: urlArgs ? `${oneLineCommand} --${urlArgs}` : oneLineCommand,
    clientInstallJsonCommand: `${oneLineCommand} -- --target <client>${urlArgs} --json`,
    autoInstallCommand: `${oneLineCommand} -- --target auto${urlArgs} --json`,
    priorityInstallCommand: `${oneLineCommand} -- --target ${MCP_PRIORITY_INSTALL_TARGET}${urlArgs} --json`
  });
  const english = build(command);
  const zhCN = build(commandZhCN);
  return {
    command,
    ...english,
    commandZhCN,
    installCommandZhCN: zhCN.installCommand,
    clientInstallJsonCommandZhCN: zhCN.clientInstallJsonCommand,
    autoInstallCommandZhCN: zhCN.autoInstallCommand,
    priorityInstallCommandZhCN: zhCN.priorityInstallCommand
  };
}

function mcpTargetConfigTemplate(_target, { baseUrl = "", vmBaseUrl = "" } = {}) {
  return {
    protocol: MCP_CLIENT_ADAPTER_PROTOCOL,
    endpoint: {
      httpUrl: `${baseUrl}/mcp`,
      vmHttpUrl: `${vmBaseUrl}/mcp`,
      tokenEnv: "MESHRIX_MCP_TOKEN"
    }
  };
}

function mcpPublicTargetConfigTemplate(_target, { baseUrl = "", vmBaseUrl = "" } = {}) {
  return {
    endpoint: {
      httpUrl: `${baseUrl}/mcp`,
      vmHttpUrl: `${vmBaseUrl}/mcp`,
      tokenEnv: "MESHRIX_MCP_TOKEN"
    }
  };
}

function mcpClientTargetGuides({ baseUrl = "", vmBaseUrl = "", githubOneLineCommand = "", githubOneLineCommandZhCN = "" } = {}) {
  const urlArgs = commandUrlArgs(baseUrl);
  return MCP_CLIENT_TARGETS.map((client) => ({
    target: client.target,
    label: client.label,
    priority: client.priority,
    locations: [...client.locations],
    endpoints: {
      mcpUrl: `${baseUrl}/mcp`,
      vmMcpUrl: `${vmBaseUrl}/mcp`
    },
    install: {
      oneCommand: `${githubOneLineCommand} -- --target ${client.target}${urlArgs}`,
      oneCommandJson: `${githubOneLineCommand} -- --target ${client.target}${urlArgs} --json`,
      oneCommandZhCN: `${githubOneLineCommandZhCN} -- --target ${client.target}${urlArgs}`,
      oneCommandJsonZhCN: `${githubOneLineCommandZhCN} -- --target ${client.target}${urlArgs} --json`,
      nativeScript: `${githubOneLineCommand} -- --target ${client.target}${urlArgs}`,
      nativeScriptJson: `${githubOneLineCommand} -- --target ${client.target}${urlArgs} --json`,
      uninstall: `${githubOneLineMcpInstallCommand(MCP_BOOTSTRAP_UNINSTALL_SCRIPT)} -- --target ${client.target}`,
      doctor: `${githubOneLineCommand} -- doctor${urlArgs} --json`
    },
    tokenInput: "device-authorization-or-stdin-or-env",
    configTemplate: mcpPublicTargetConfigTemplate(client.target, { baseUrl, vmBaseUrl })
  }));
}

export function mcpSupportedTargetDetails() {
  return releaseMcpSupportedTargetDetails();
}

export function mcpPublicSupportedTargetDetails() {
  return releaseMcpPublicSupportedTargetDetails();
}

export function buildLicoMcpDiscovery({ listenUrl = "", discoveryState = null } = {}) {
  const { baseUrl, vmBaseUrl } = mcpDiscoveryBase({ listenUrl, discoveryState });
  const urlArgs = commandUrlArgs(baseUrl);
  const {
    command: githubOneLineCommand,
    commandZhCN: githubOneLineCommandZhCN,
    installCommand: githubOneLineInstallCommand,
    installCommandZhCN: githubOneLineInstallCommandZhCN,
    clientInstallJsonCommand: githubOneLineClientInstallJsonCommand,
    clientInstallJsonCommandZhCN: githubOneLineClientInstallJsonCommandZhCN,
    autoInstallCommand: githubOneLineAutoInstallCommand,
    autoInstallCommandZhCN: githubOneLineAutoInstallCommandZhCN,
    priorityInstallCommand: githubOneLinePriorityInstallCommand,
    priorityInstallCommandZhCN: githubOneLinePriorityInstallCommandZhCN
  } = githubOneLineMcpInstallCommands({ baseUrl });
  const installCommand = githubOneLineInstallCommand;
  const clientInstallCommand = `${githubOneLineCommand} -- --target <client>${urlArgs}`;
  const clientInstallJsonCommand = githubOneLineClientInstallJsonCommand;
  const autoInstallCommand = githubOneLineAutoInstallCommand;
  const priorityInstallCommand = githubOneLinePriorityInstallCommand;
  const interactiveInstallCommand = githubOneLineInstallCommand;
  const uninstallCommand = `${githubOneLineMcpInstallCommand(MCP_BOOTSTRAP_UNINSTALL_SCRIPT)} -- --target <client>`;
  const doctorCommand = `${githubOneLineCommand} -- doctor${urlArgs}`;
  const discoverCommand = `${githubOneLineCommand} -- discover-local${urlArgs} --json`;
  const scanCommand = `${githubOneLineCommand} -- scan${urlArgs} --json`;
  const clientTargets = mcpClientTargetGuides({ baseUrl, vmBaseUrl, githubOneLineCommand, githubOneLineCommandZhCN });
  const supportedTargets = mcpPublicSupportedTargetDetails();
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    name: "Meshrix",
    description: "Meshrix MCP gateway layer. Provides Discovery, Gateway, and enabled plugin outlets.",
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
      packageName: MCP_CONNECTOR_PACKAGE_NAME,
      packageVersion: MCP_CONNECTOR_VERSION,
      releaseChannel: "stable",
      supportedTargets,
      priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS],
      githubOneLineCommand,
      githubOneLineCommandZhCN,
      githubOneLineInstallCommand,
      githubOneLineInstallCommandZhCN,
      githubOneLineClientInstallJsonCommand,
      githubOneLineClientInstallJsonCommandZhCN,
      githubOneLineAutoInstallCommand,
      githubOneLineAutoInstallCommandZhCN,
      githubOneLinePriorityInstallCommand,
      githubOneLinePriorityInstallCommandZhCN,
      oneCommandInstall: githubOneLineInstallCommand,
      oneCommandInstallZhCN: githubOneLineInstallCommandZhCN,
      oneCommandClientInstallJson: githubOneLineClientInstallJsonCommand,
      oneCommandClientInstallJsonZhCN: githubOneLineClientInstallJsonCommandZhCN,
      oneCommandAutoInstall: githubOneLineAutoInstallCommand,
      oneCommandAutoInstallZhCN: githubOneLineAutoInstallCommandZhCN,
      oneCommandPriorityInstall: githubOneLinePriorityInstallCommand,
      oneCommandPriorityInstallZhCN: githubOneLinePriorityInstallCommandZhCN,
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
      tokenInput: "device-authorization-or-stdin-or-env",
      authorizationRequestEndpoint: `${baseUrl}/api/mcp/local-grant/requests`,
      authorizationConsumeEndpointTemplate: `${baseUrl}/api/mcp/local-grant/requests/<request-id>/consume`,
      nativeEntrypoint: MCP_BOOTSTRAP_INSTALL_SCRIPT,
      windowsEntrypoint: MCP_BOOTSTRAP_WINDOWS_INSTALL_SCRIPT,
      portable: {
        requiresInstalledNode: false,
        strategy: "verified-portable-connector",
        preferredArchive: "versioned-portable-archive",
        releaseChecksumFile: "RELEASE_SHA256SUMS",
        releaseChecksumSigstoreBundleFile: "RELEASE_SHA256SUMS.sigstore.json",
        checksumAuthorityVerificationOrder: "sigstore-bundle-then-asset-digest",
        checksumVerificationRequired: true,
        bootstrapScript: MCP_BOOTSTRAP_INSTALL_SCRIPT,
        bootstrapScriptZhCN: MCP_BOOTSTRAP_INSTALL_SCRIPT_ZH_CN,
        windowsBootstrapScript: MCP_BOOTSTRAP_WINDOWS_INSTALL_SCRIPT,
        windowsUninstallScript: MCP_BOOTSTRAP_WINDOWS_UNINSTALL_SCRIPT,
        githubLatestBootstrapUrl: `https://github.com/${MCP_CONNECTOR_GITHUB_REPO}/releases/latest/download/${MCP_BOOTSTRAP_INSTALL_SCRIPT}`,
        githubLatestBootstrapUrlZhCN: `https://github.com/${MCP_CONNECTOR_GITHUB_REPO}/releases/latest/download/${MCP_BOOTSTRAP_INSTALL_SCRIPT_ZH_CN}`,
        githubOneLineCommand,
        githubOneLineCommandZhCN,
        githubOneLineAutoInstallCommand,
        githubOneLineAutoInstallCommandZhCN,
        githubOneLinePriorityInstallCommand,
        githubOneLinePriorityInstallCommandZhCN,
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
      reinstallCommand: githubOneLineInstallCommand,
      reinstallCommandZhCN: githubOneLineInstallCommandZhCN,
      clientReinstallJsonCommand: githubOneLineClientInstallJsonCommand,
      clientReinstallJsonCommandZhCN: githubOneLineClientInstallJsonCommandZhCN,
      agentReinstallCommand: githubOneLineAutoInstallCommand,
      agentReinstallCommandZhCN: githubOneLineAutoInstallCommandZhCN,
      priorityAgentReinstallCommand: githubOneLinePriorityInstallCommand,
      priorityAgentReinstallCommandZhCN: githubOneLinePriorityInstallCommandZhCN,
      oneCommandReinstall: githubOneLineInstallCommand,
      oneCommandReinstallZhCN: githubOneLineInstallCommandZhCN,
      oneCommandClientReinstallJson: githubOneLineClientInstallJsonCommand,
      oneCommandClientReinstallJsonZhCN: githubOneLineClientInstallJsonCommandZhCN,
      oneCommandAgentReinstall: githubOneLineAutoInstallCommand,
      oneCommandAgentReinstallZhCN: githubOneLineAutoInstallCommandZhCN,
      oneCommandPriorityAgentReinstall: githubOneLinePriorityInstallCommand,
      oneCommandPriorityAgentReinstallZhCN: githubOneLinePriorityInstallCommandZhCN,
      priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS],
      doctorCommand
    },
    mcpServers: {
      meshrix: {
        httpUrl: `${baseUrl}/mcp`,
        vmHttpUrl: `${vmBaseUrl}/mcp`,
        headers: {
          "X-Meshrix-Api-Key": "${MESHRIX_MCP_TOKEN}"
        },
        authProviderType: "meshrix_api_key",
        timeout: DEFAULT_TIMEOUT_MS
      }
    },
    auth: {
      type: "meshrix_operation_permission_token",
      acceptedHeaders: ["Authorization: Bearer <token>", "X-Meshrix-Api-Key"],
      tokenSource: "Meshrix Operation Permission grant token"
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

function validHandshakeNonce(value) {
  return /^[A-Za-z0-9_-]{24,256}$/.test(String(value || ""));
}

function gatewayTransitEvidence(request) {
  const adapterId = String(request?.headers?.["x-meshrix-gateway"] || "").trim().toLowerCase();
  const route = String(request?.headers?.["x-meshrix-gateway-route"] || "").trim();
  const requestId = String(request?.headers?.["x-meshrix-gateway-request-id"] || "").trim();
  if (!["caddy", "nginx"].includes(adapterId) || route !== "/api/mcp/handshake" || !requestId) {
    return null;
  }
  return Object.freeze({ adapterId, route, requestIdPresent: true });
}

export function mcpHandshake({ request = null, requestBody, listenUrl = "", discoveryState = null }) {
  const identity = discoveryState?.mcpIdentity;
  if (!identity) {
    return {
      ok: false,
      status: 503,
      body: {
        ok: false,
        error: "Meshrix MCP identity is not available."
      }
    };
  }
  const body = parseRequestBody(requestBody);
  const nonce = String(body?.nonce || "").trim();
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
  const discovery = buildLicoMcpDiscovery({ listenUrl, discoveryState });
  const issuedAt = new Date().toISOString();
  const payload = buildMcpHandshakePayload({
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

export function mcpInitializeResult({ listenUrl = "", discoveryState = null } = {}) {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: {
        listChanged: true
      }
    },
    serverInfo: {
      name: "Meshrix",
      version: MCP_SERVER_VERSION
    },
    _meta: mcpRuntimeMetadata({ listenUrl, discoveryState })
  };
}

function mcpToolResult(payload) {
  const structuredContent = payload?.result !== undefined ? payload.result : payload;
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
