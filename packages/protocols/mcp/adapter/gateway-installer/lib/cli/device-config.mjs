import {
  BOOTSTRAP_INSTALL_SCRIPT_ZH_CN,
  DEFAULT_TOKEN_ENV,
  LICO_MCP_DISCOVERY_FILE_ENV,
  LICO_MCP_DISCOVERY_URL_ENV,
  LICO_MCP_URL_ENV,
  MCP_INTERFACE_VERSION,
  MCP_SERVER_NAME,
  MCP_STABLE_TOOL_NAME,
  PRIORITY_INSTALL_TARGET,
  PRIORITY_INSTALL_TARGETS,
  SUPPORTED_TARGETS,
  packageJson,
  sharedHubContract,
  supportedTargetDetails
} from "./constants.mjs";
import { option, targetInstallMode } from "./basic-utils.mjs";
import { discoverLicoHub, explicitBaseUrl, publishLaunchctlEnv } from "./discovery.mjs";
import {
  deviceDiscoveryEnv,
  discoveryRegistryPath,
  readJson,
  writeJson
} from "./device-discovery-registry.mjs";
import { githubOneLineMcpInstallCommand, run, shellQuote } from "./connector-process.mjs";
import { redactToken } from "./installer-output-safety.mjs";

export function buildDeviceHubManifest({
  baseUrl,
  targets,
  tokenEnv = DEFAULT_TOKEN_ENV,
  discoveryPath = discoveryRegistryPath()
}) {
  const parsed = new URL(baseUrl);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const mcpUrl = `${baseUrl}/mcp`;
  const vmMcpUrl = `${parsed.protocol}//host.orb.internal:${port}/mcp`;
  const env = deviceDiscoveryEnv({ baseUrl, primaryPath: discoveryPath });
  const packageExec = `npx ${packageJson.name}@${packageJson.version}`;
  const urlArgs = ` --url ${shellQuote(baseUrl)}`;
  const tokenEnvArgs = tokenEnv && tokenEnv !== DEFAULT_TOKEN_ENV ? ` --token-env ${shellQuote(tokenEnv)}` : "";
  const contextArgs = `${urlArgs}${tokenEnvArgs}`;
  const githubOneLineCommand = githubOneLineMcpInstallCommand();
  const githubOneLineCommandZhCN = githubOneLineMcpInstallCommand(BOOTSTRAP_INSTALL_SCRIPT_ZH_CN);
  const githubOneLineInstallCommand = `${githubOneLineCommand} --${contextArgs}`;
  const githubOneLineInstallCommandZhCN = `${githubOneLineCommandZhCN} --${contextArgs}`;
  const githubOneLineClientInstallJsonCommand = `${githubOneLineCommand} -- --target <client>${contextArgs} --json`;
  const githubOneLineClientInstallJsonCommandZhCN = `${githubOneLineCommandZhCN} -- --target <client>${contextArgs} --json`;
  const githubOneLineAutoInstallCommand = `${githubOneLineCommand} -- --target auto${contextArgs} --json`;
  const githubOneLineAutoInstallCommandZhCN = `${githubOneLineCommandZhCN} -- --target auto${contextArgs} --json`;
  const githubOneLinePriorityInstallCommand = `${githubOneLineCommand} -- --target ${PRIORITY_INSTALL_TARGET}${contextArgs} --json`;
  const githubOneLinePriorityInstallCommandZhCN = `${githubOneLineCommandZhCN} -- --target ${PRIORITY_INSTALL_TARGET}${contextArgs} --json`;
  const discoverCommand = `${packageExec} discover-local${urlArgs} --json`;
  const interactiveInstallCommand = `${packageExec} install${urlArgs}${tokenEnvArgs}`;
  const clientInstallJsonCommand = `${packageExec} install --target <client>${urlArgs}${tokenEnvArgs} --json`;
  const autoInstallCommand = `${packageExec} install --target auto${urlArgs}${tokenEnvArgs} --json`;
  const priorityInstallCommand = `${packageExec} install --target ${PRIORITY_INSTALL_TARGET}${urlArgs}${tokenEnvArgs} --json`;
  const scanCommand = `${packageExec} scan${urlArgs}${tokenEnvArgs} --json`;
  const doctorCommand = `${packageExec} doctor${urlArgs}${tokenEnvArgs} --json`;
  return {
    version: "v0.0.1:mcp:device-hub-1",
    schemaVersion: "v0.0.1:mcp:device-hub-1",
    generatedAt: new Date().toISOString(),
    discovery: {
      strategy: "shared-device-hub",
      localEntry: {
        type: "lico-mcp-discover-local",
        command: discoverCommand,
        registryFile: discoveryPath
      },
      preferredHttpDiscoveryUrl: `${baseUrl}/.well-known/lico/mcp.json`,
      preferredApiDiscoveryUrl: `${baseUrl}/api/mcp/discovery`,
      registryFile: discoveryPath,
      localFiles: [discoveryPath],
      env,
      lookupOrder: [
        "lico-mcp discover-local --json",
        "LICO_MCP_URL",
        "LICO_MCP_DISCOVERY_URL",
        "LICO_MCP_DISCOVERY_FILE",
        "signed local port scan"
      ]
    },
    servers: {
      [MCP_SERVER_NAME]: {
        name: "LicoMesh",
        transport: "streamable-http",
        httpUrl: mcpUrl,
        vmHttpUrl: vmMcpUrl,
        discoveryUrl: `${baseUrl}/.well-known/lico/mcp.json`,
        apiDiscoveryUrl: `${baseUrl}/api/mcp/discovery`,
        stableToolName: MCP_STABLE_TOOL_NAME,
        sharedHub: sharedHubContract({ mcpUrl, vmMcpUrl }),
        connector: {
          packageName: packageJson.name,
          packageVersion: packageJson.version,
          registerCommand: `${packageExec} register${urlArgs}${tokenEnvArgs}`,
          interactiveInstallCommand,
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
          autoInstallCommand,
          priorityInstallCommand,
          priorityTargets: [...PRIORITY_INSTALL_TARGETS],
          supportedTargets: [...SUPPORTED_TARGETS],
          supportedTargetDetails: supportedTargetDetails(),
          installCommand: `${packageExec} install --target <client>${urlArgs}${tokenEnvArgs}`,
          clientInstallJsonCommand,
          uninstallCommand: `${packageExec} uninstall --target <client>${urlArgs}`,
          discoverCommand,
          scanCommand,
          doctorCommand
        },
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
          priorityTargets: [...PRIORITY_INSTALL_TARGETS]
        },
        auth: {
          type: "device-authorization-or-provided-token",
          acceptedHeaders: ["Authorization: Bearer <token>", "X-LicoMesh-Api-Key", "X-Lico-MCP-Target"],
          tokenEnv
        },
        targets
      }
    }
  };
}

export async function publishDeviceHubManifest({ baseUrl, targets, tokenEnv = DEFAULT_TOKEN_ENV, publishEnv = true, discoveryPath = discoveryRegistryPath() }) {
  const manifest = buildDeviceHubManifest({ baseUrl, targets, tokenEnv, discoveryPath });
  await writeJson(discoveryPath, manifest);
  const envPublished = publishEnv ? await publishLaunchctlEnv(manifest.discovery.env) : false;
  return {
    primaryPath: discoveryPath,
    paths: [discoveryPath],
    env: manifest.discovery.env,
    envPublished,
    manifest
  };
}

export async function writeDeviceDiscovery({ baseUrl, installed, token, tokenEnv = DEFAULT_TOKEN_ENV, publishEnv = true, discoveryPath = discoveryRegistryPath() }) {
  const manifestPath = discoveryPath;
  const existingManifest = await readJson(manifestPath, {});
  const existingServer = existingManifest?.servers?.[MCP_SERVER_NAME] || {};
  const existingTargets = existingServer.targets || {};
  const targetStatuses = Object.fromEntries(SUPPORTED_TARGETS.map((target) => [
    target,
    installed[target]
      ? installed[target].ok === false
        ? {
            installMode: installed[target].installMode || targetInstallMode(target),
            status: "failed",
            error: installed[target].error || "Install failed."
          }
        : {
          installMode: installed[target].installMode,
          status: "installed",
          tokenPrefix: installed[target].tokenPrefix || redactToken(token)
        }
      : existingTargets[target] || {
          installMode: "supported",
          status: "not-installed"
        }
  ]));
  const published = await publishDeviceHubManifest({
    baseUrl,
    targets: targetStatuses,
    tokenEnv,
    publishEnv,
    discoveryPath: manifestPath
  });
  return published.primaryPath;
}

export async function writeDeviceUninstall({ baseUrl, uninstalled, tokenEnv = DEFAULT_TOKEN_ENV, publishEnv = true, discoveryPath = discoveryRegistryPath() }) {
  const manifestPath = discoveryPath;
  const existingManifest = await readJson(manifestPath, {});
  const existingServer = existingManifest?.servers?.[MCP_SERVER_NAME] || {};
  const effectiveTokenEnv = tokenEnv || existingManifestTokenEnv(existingServer);
  const existingTargets = existingServer.targets || {};
  const targets = Object.fromEntries(SUPPORTED_TARGETS.map((target) => [
    target,
    uninstalled[target]
      ? uninstalled[target].ok === false
        ? {
            installMode: uninstalled[target].uninstallMode || targetInstallMode(target),
            status: "failed",
            error: uninstalled[target].error || "Uninstall failed."
          }
        : {
          installMode: uninstalled[target].uninstallMode,
          status: "not-installed"
        }
      : existingTargets[target] || {
          installMode: "supported",
          status: "not-installed"
        }
  ]));
  const published = await publishDeviceHubManifest({
    baseUrl,
    targets,
    tokenEnv: effectiveTokenEnv,
    publishEnv,
    discoveryPath: manifestPath
  });
  return published.primaryPath;
}

export function defaultTargetStatuses(existingTargets = {}) {
  return Object.fromEntries(SUPPORTED_TARGETS.map((target) => [
    target,
    existingTargets[target] || {
      installMode: "supported",
      status: "not-installed"
    }
  ]));
}

export function profileFromDiscovery({ name, discovered }) {
  const baseUrl = discovered.baseUrl;
  return {
    name,
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    discoveryUrl: `${baseUrl}/api/mcp/discovery`,
    identityKeyId: discovered.handshake?.payload?.identity?.keyId || "",
    serverId: discovered.discovery?.serverId || discovered.handshake?.payload?.server?.serverId || "",
    serverVersion: discovered.discovery?.serverVersion || discovered.handshake?.payload?.server?.serverVersion || "",
    interfaceVersion: discovered.discovery?.interfaceVersion || MCP_INTERFACE_VERSION,
    stableToolName: discovered.discovery?.stableToolName || MCP_STABLE_TOOL_NAME,
    updatedAt: new Date().toISOString()
  };
}

export function existingManifestTokenEnv(server = {}) {
  return String(server.auth?.tokenEnv || DEFAULT_TOKEN_ENV);
}

export async function writeServerConfigProfile({ options, name = "default", discovered, publishEnv = true }) {
  const discoveryPath = discoveryRegistryPath(options);
  const existingManifest = await readJson(discoveryPath, {});
  const existingServer = existingManifest?.servers?.[MCP_SERVER_NAME] || {};
  const tokenEnv = Object.hasOwn(options, "token-env")
    ? String(option(options, "token-env", DEFAULT_TOKEN_ENV))
    : existingManifestTokenEnv(existingServer);
  const published = await publishDeviceHubManifest({
    baseUrl: discovered.baseUrl,
    targets: defaultTargetStatuses(existingServer.targets || {}),
    tokenEnv,
    publishEnv,
    discoveryPath
  });
  const manifest = await readJson(discoveryPath, {});
  manifest.serverConfig = {
    ...(manifest.serverConfig || {}),
    activeName: name,
    profiles: {
      ...(existingManifest.serverConfig?.profiles || {}),
      [name]: profileFromDiscovery({ name, discovered })
    },
    updatedAt: new Date().toISOString()
  };
  await writeJson(discoveryPath, manifest);
  return {
    ok: true,
    path: published.primaryPath,
    activeName: name,
    profile: manifest.serverConfig.profiles[name],
    tokenEnv
  };
}

export async function resetServerConfig({ options, publishEnv = true }) {
  const discoveryPath = discoveryRegistryPath(options);
  const existingManifest = await readJson(discoveryPath, {});
  const resetManifest = {
    version: "v0.0.1:mcp:device-hub-1",
    schemaVersion: "v0.0.1:mcp:device-hub-1",
    generatedAt: new Date().toISOString(),
    discovery: {
      strategy: "shared-device-hub",
      localEntry: {
        type: "lico-mcp-discover-local",
        command: `npx ${packageJson.name}@${packageJson.version} discover-local --json`,
        registryFile: discoveryPath
      },
      registryFile: discoveryPath,
      localFiles: [discoveryPath],
      env: {},
      lookupOrder: [
        "lico-mcp discover-local --json",
        "signed local port scan"
      ]
    },
    servers: {},
    serverConfig: {
      activeName: "",
      profiles: {},
      updatedAt: new Date().toISOString(),
      previousActiveName: existingManifest?.serverConfig?.activeName || ""
    }
  };
  await writeJson(discoveryPath, resetManifest);
  if (publishEnv && process.platform === "darwin") {
    await run("launchctl", ["unsetenv", LICO_MCP_URL_ENV], { allowFailure: true });
    await run("launchctl", ["unsetenv", LICO_MCP_DISCOVERY_URL_ENV], { allowFailure: true });
    await run("launchctl", ["unsetenv", LICO_MCP_DISCOVERY_FILE_ENV], { allowFailure: true });
  }
  return {
    ok: true,
    path: discoveryPath,
    reset: true
  };
}

export async function serverConfigCommand(options) {
  const discoveryPath = discoveryRegistryPath(options);
  if (options.reset) {
    return resetServerConfig({ options, publishEnv: !options["no-env"] });
  }
  if (options.list) {
    const manifest = await readJson(discoveryPath, {});
    return {
      ok: true,
      path: discoveryPath,
      activeName: manifest?.serverConfig?.activeName || "",
      profiles: manifest?.serverConfig?.profiles || {},
      currentServer: manifest?.servers?.[MCP_SERVER_NAME] || null
    };
  }
  if (options.set) {
    const url = explicitBaseUrl(options);
    if (!url) {
      throw new Error("server-config --set requires --url.");
    }
    const discovered = await discoverLicoHub({ ...options, url });
    if (!discovered.ok) {
      throw new Error(`Failed to verify LicoMesh MCP server at ${url}: ${discovered.reason}`);
    }
    return writeServerConfigProfile({
      options,
      name: String(option(options, "name", "default")).trim() || "default",
      discovered,
      publishEnv: !options["no-env"]
    });
  }
  if (options.switch) {
    const name = String(options.switch || "").trim();
    const manifest = await readJson(discoveryPath, {});
    const profile = manifest?.serverConfig?.profiles?.[name];
    if (!profile?.baseUrl) {
      throw new Error(`No LicoMesh MCP server profile named ${name}.`);
    }
    const discovered = await discoverLicoHub({ ...options, url: profile.baseUrl });
    if (!discovered.ok) {
      throw new Error(`Failed to verify LicoMesh MCP server profile ${name}: ${discovered.reason}`);
    }
    return writeServerConfigProfile({
      options,
      name,
      discovered,
      publishEnv: !options["no-env"]
    });
  }
  if (options.refresh) {
    const manifest = await readJson(discoveryPath, {});
    const activeName = manifest?.serverConfig?.activeName || "default";
    const discovered = await discoverLicoHub(options);
    if (!discovered.ok) {
      throw new Error(discovered.reason);
    }
    return writeServerConfigProfile({
      options,
      name: activeName,
      discovered,
      publishEnv: !options["no-env"]
    });
  }
  return serverConfigCommand({ ...options, list: true });
}
