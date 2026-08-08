import {
  BOOTSTRAP_INSTALL_SCRIPT_ZH_CN,
  DEFAULT_TOKEN_ENV,
  MESHRIX_MCP_DISCOVERY_FILE_ENV,
  MESHRIX_MCP_DISCOVERY_URL_ENV,
  MESHRIX_MCP_URL_ENV,
  MCP_INTERFACE_VERSION,
  MCP_SERVER_NAME,
  MCP_STABLE_TOOL_NAME,
  PRIORITY_INSTALL_TARGET,
  PRIORITY_INSTALL_TARGETS,
  SUPPORTED_TARGETS,
  packageJson,
  sharedHubContract,
  supportedTargetDetails
} from "./constants.ts";
import { option, targetInstallMode } from "./basic-utils.ts";
import { discardConfiguredApiKeyEnvironment, discoverMeshrixHub, explicitBaseUrl, publishLaunchctlEnv } from "./discovery.ts";
import {
  deviceDiscoveryEnv,
  discoveryRegistryPath,
  readJson,
  writeJson
} from "./device-discovery-registry.ts";
import { githubOneLineMcpInstallCommand, run, shellQuote } from "./connector-process.ts";

export function buildDeviceHubManifest({
  baseUrl,
  targets,
  tokenEnv = DEFAULT_TOKEN_ENV,
  discoveryPath = discoveryRegistryPath()
}: Record<string, any>) : any {
  const parsed: any = new URL(baseUrl);
  const port: any = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const mcpUrl: any = `${baseUrl}/mcp`;
  const vmMcpUrl: any = `${parsed.protocol}//host.orb.internal:${port}/mcp`;
  const env: any = deviceDiscoveryEnv({ baseUrl, primaryPath: discoveryPath });
  const packageExec: any = `npx ${packageJson.name}@${packageJson.version}`;
  const urlArgs: any = ` --url ${shellQuote(baseUrl)}`;
  const tokenEnvArgs: any = tokenEnv && tokenEnv !== DEFAULT_TOKEN_ENV ? ` --token-env ${shellQuote(tokenEnv)}` : "";
  const contextArgs: any = `${urlArgs}${tokenEnvArgs}`;
  const githubOneLineCommand: any = githubOneLineMcpInstallCommand();
  const githubOneLineCommandZhCN: any = githubOneLineMcpInstallCommand(BOOTSTRAP_INSTALL_SCRIPT_ZH_CN);
  const githubOneLineInstallCommand: any = `${githubOneLineCommand} --${contextArgs}`;
  const githubOneLineInstallCommandZhCN: any = `${githubOneLineCommandZhCN} --${contextArgs}`;
  const githubOneLineClientInstallJsonCommand: any = `${githubOneLineCommand} -- --target <client>${contextArgs} --json`;
  const githubOneLineClientInstallJsonCommandZhCN: any = `${githubOneLineCommandZhCN} -- --target <client>${contextArgs} --json`;
  const githubOneLineAutoInstallCommand: any = `${githubOneLineCommand} -- --target auto${contextArgs} --json`;
  const githubOneLineAutoInstallCommandZhCN: any = `${githubOneLineCommandZhCN} -- --target auto${contextArgs} --json`;
  const githubOneLinePriorityInstallCommand: any = `${githubOneLineCommand} -- --target ${PRIORITY_INSTALL_TARGET}${contextArgs} --json`;
  const githubOneLinePriorityInstallCommandZhCN: any = `${githubOneLineCommandZhCN} -- --target ${PRIORITY_INSTALL_TARGET}${contextArgs} --json`;
  const discoverCommand: any = `${packageExec} discover-local${urlArgs} --json`;
  const interactiveInstallCommand: any = `${packageExec} install${urlArgs}${tokenEnvArgs}`;
  const clientInstallJsonCommand: any = `${packageExec} install --target <client>${urlArgs}${tokenEnvArgs} --json`;
  const autoInstallCommand: any = `${packageExec} install --target auto${urlArgs}${tokenEnvArgs} --json`;
  const priorityInstallCommand: any = `${packageExec} install --target ${PRIORITY_INSTALL_TARGET}${urlArgs}${tokenEnvArgs} --json`;
  const scanCommand: any = `${packageExec} scan${urlArgs}${tokenEnvArgs} --json`;
  const doctorCommand: any = `${packageExec} doctor${urlArgs}${tokenEnvArgs} --json`;
  return {
    version: "v0.0.1:mcp:device-hub-1",
    schemaVersion: "v0.0.1:mcp:device-hub-1",
    generatedAt: new Date().toISOString(),
    discovery: {
      strategy: "shared-device-hub",
      localEntry: {
        type: "meshrix-mcp-discover-local",
        command: discoverCommand,
        registryFile: discoveryPath
      },
      preferredHttpDiscoveryUrl: `${baseUrl}/.well-known/meshrix/mcp.json`,
      preferredApiDiscoveryUrl: `${baseUrl}/api/mcp/discovery`,
      registryFile: discoveryPath,
      localFiles: [discoveryPath],
      env,
      lookupOrder: [
        "meshrix-mcp discover-local --json",
        "MESHRIX_MCP_URL",
        "MESHRIX_MCP_DISCOVERY_URL",
        "MESHRIX_MCP_DISCOVERY_FILE",
        "signed local port scan"
      ]
    },
    servers: {
      [MCP_SERVER_NAME]: {
        name: "Meshrix.js",
        transport: "streamable-http",
        httpUrl: mcpUrl,
        vmHttpUrl: vmMcpUrl,
        discoveryUrl: `${baseUrl}/.well-known/meshrix/mcp.json`,
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
          type: "api-key",
          input: "protected-stdin-or-environment",
          acceptedHeaders: ["X-Meshrix.js-Api-Key", "X-Meshrix.js-MCP-Target"],
          tokenEnv
        },
        targets
      }
    }
  };
}

export async function publishDeviceHubManifest({ baseUrl, targets, tokenEnv = DEFAULT_TOKEN_ENV, publishEnv = true, discoveryPath = discoveryRegistryPath() }: Record<string, any>) : Promise<any> {
  const manifest: any = buildDeviceHubManifest({ baseUrl, targets, tokenEnv, discoveryPath });
  await writeJson(discoveryPath, manifest);
  const envPublished: any = publishEnv ? await publishLaunchctlEnv(manifest.discovery.env) : false;
  return {
    primaryPath: discoveryPath,
    paths: [discoveryPath],
    env: manifest.discovery.env,
    envPublished,
    manifest
  };
}

export async function writeDeviceDiscovery({ baseUrl, installed, tokenEnv = DEFAULT_TOKEN_ENV, publishEnv = true, discoveryPath = discoveryRegistryPath() }: Record<string, any>) : Promise<any> {
  const manifestPath: any = discoveryPath;
  const existingManifest: any = await readJson(manifestPath, {});
  const existingServer: any = existingManifest?.servers?.[MCP_SERVER_NAME] || {};
  const existingTargets: any = existingServer.targets || {};
  const targetStatuses: any = Object.fromEntries(SUPPORTED_TARGETS.map((target?: any) : any => [
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
          status: "installed"
        }
      : existingTargets[target] || {
          installMode: "supported",
          status: "not-installed"
        }
  ]));
  const published: any = await publishDeviceHubManifest({
    baseUrl,
    targets: targetStatuses,
    tokenEnv,
    publishEnv,
    discoveryPath: manifestPath
  });
  return published.primaryPath;
}

export async function writeDeviceUninstall({ baseUrl, uninstalled, tokenEnv = DEFAULT_TOKEN_ENV, publishEnv = true, discoveryPath = discoveryRegistryPath() }: Record<string, any>) : Promise<any> {
  const manifestPath: any = discoveryPath;
  const existingManifest: any = await readJson(manifestPath, {});
  const existingServer: any = existingManifest?.servers?.[MCP_SERVER_NAME] || {};
  const effectiveTokenEnv: any = tokenEnv || existingManifestTokenEnv(existingServer);
  const existingTargets: any = existingServer.targets || {};
  const targets: any = Object.fromEntries(SUPPORTED_TARGETS.map((target?: any) : any => [
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
  const published: any = await publishDeviceHubManifest({
    baseUrl,
    targets,
    tokenEnv: effectiveTokenEnv,
    publishEnv,
    discoveryPath: manifestPath
  });
  return published.primaryPath;
}

export function defaultTargetStatuses(existingTargets: Record<string, any> = {}) : any {
  return Object.fromEntries(SUPPORTED_TARGETS.map((target?: any) : any => [
    target,
    existingTargets[target] || {
      installMode: "supported",
      status: "not-installed"
    }
  ]));
}

export function profileFromDiscovery({ name, discovered }: Record<string, any>) : any {
  const baseUrl: any = discovered.baseUrl;
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

export function existingManifestTokenEnv(server: Record<string, any> = {}) : any {
  return String(server.auth?.tokenEnv || DEFAULT_TOKEN_ENV);
}

export async function writeServerConfigProfile({ options, name = "default", discovered, publishEnv = true }: Record<string, any>) : Promise<any> {
  const discoveryPath: any = discoveryRegistryPath(options);
  const existingManifest: any = await readJson(discoveryPath, {});
  const existingServer: any = existingManifest?.servers?.[MCP_SERVER_NAME] || {};
  const tokenEnv: any = Object.hasOwn(options, "token-env")
    ? String(option(options, "token-env", DEFAULT_TOKEN_ENV))
    : existingManifestTokenEnv(existingServer);
  const published: any = await publishDeviceHubManifest({
    baseUrl: discovered.baseUrl,
    targets: defaultTargetStatuses(existingServer.targets || {}),
    tokenEnv,
    publishEnv,
    discoveryPath
  });
  const manifest: any = await readJson(discoveryPath, {});
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

export async function resetServerConfig({ options, publishEnv = true }: Record<string, any>) : Promise<any> {
  const discoveryPath: any = discoveryRegistryPath(options);
  const existingManifest: any = await readJson(discoveryPath, {});
  const resetManifest: Record<string, any> = {
    version: "v0.0.1:mcp:device-hub-1",
    schemaVersion: "v0.0.1:mcp:device-hub-1",
    generatedAt: new Date().toISOString(),
    discovery: {
      strategy: "shared-device-hub",
      localEntry: {
        type: "meshrix-mcp-discover-local",
        command: `npx ${packageJson.name}@${packageJson.version} discover-local --json`,
        registryFile: discoveryPath
      },
      registryFile: discoveryPath,
      localFiles: [discoveryPath],
      env: {},
      lookupOrder: [
        "meshrix-mcp discover-local --json",
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
    await run("launchctl", ["unsetenv", MESHRIX_MCP_URL_ENV], { allowFailure: true });
    await run("launchctl", ["unsetenv", MESHRIX_MCP_DISCOVERY_URL_ENV], { allowFailure: true });
    await run("launchctl", ["unsetenv", MESHRIX_MCP_DISCOVERY_FILE_ENV], { allowFailure: true });
  }
  return {
    ok: true,
    path: discoveryPath,
    reset: true
  };
}

export async function serverConfigCommand(options?: any) : Promise<any> {
  discardConfiguredApiKeyEnvironment(options);
  const discoveryPath: any = discoveryRegistryPath(options);
  if (options.reset) {
    return resetServerConfig({ options, publishEnv: !options["no-env"] });
  }
  if (options.list) {
    const manifest: any = await readJson(discoveryPath, {});
    return {
      ok: true,
      path: discoveryPath,
      activeName: manifest?.serverConfig?.activeName || "",
      profiles: manifest?.serverConfig?.profiles || {},
      currentServer: manifest?.servers?.[MCP_SERVER_NAME] || null
    };
  }
  if (options.set) {
    const url: any = explicitBaseUrl(options);
    if (!url) {
      throw new Error("server-config --set requires --url.");
    }
    const discovered: any = await discoverMeshrixHub({ ...options, url });
    if (!discovered.ok) {
      throw new Error(`Failed to verify Meshrix.js MCP server at ${url}: ${discovered.reason}`);
    }
    return writeServerConfigProfile({
      options,
      name: String(option(options, "name", "default")).trim() || "default",
      discovered,
      publishEnv: !options["no-env"]
    });
  }
  if (options.switch) {
    const name: any = String(options.switch || "").trim();
    const manifest: any = await readJson(discoveryPath, {});
    const profile: any = manifest?.serverConfig?.profiles?.[name];
    if (!profile?.baseUrl) {
      throw new Error(`No Meshrix.js MCP server profile named ${name}.`);
    }
    const discovered: any = await discoverMeshrixHub({ ...options, url: profile.baseUrl });
    if (!discovered.ok) {
      throw new Error(`Failed to verify Meshrix.js MCP server profile ${name}: ${discovered.reason}`);
    }
    return writeServerConfigProfile({
      options,
      name,
      discovered,
      publishEnv: !options["no-env"]
    });
  }
  if (options.refresh) {
    const manifest: any = await readJson(discoveryPath, {});
    const activeName: any = manifest?.serverConfig?.activeName || "default";
    const discovered: any = await discoverMeshrixHub(options);
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
