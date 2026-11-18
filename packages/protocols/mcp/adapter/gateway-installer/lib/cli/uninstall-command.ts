import { packageInfo } from "./constants.ts";
import { option, parseTargets } from "./basic-utils.ts";
import { clientAdapterRegistrationRequest, runClientAdapter } from "./client-adapter-runner.ts";
import { assertDeviceRegistrationBinding, writeDeviceUninstall } from "./device-config.ts";
import { discardConfiguredApiKeyEnvironment, explicitBaseUrl, baseUrlFromEndpoint } from "./discovery.ts";
import {
  discoveryRegistryPath,
  readJson
} from "./device-discovery-registry.ts";
import { redactSensitiveText, sensitiveOptionValues } from "./installer-output-safety.ts";
import { assertSupportedInstallLocation, chooseUninstallCandidates } from "./interactive.ts";
import { canUseUninstallTui, installerOptions } from "./installer-options.ts";
import { resolveClientAdapterForTarget, scanInstallTargets } from "./scan-candidates.ts";

export async function optionsWithStoredBaseUrl(options: Record<string, any> = {}) : Promise<any> {
  const settings = installerOptions(options);
  const manifest = await readJson(discoveryRegistryPath(options), {});
  const registration = manifest.servers?.[settings.serverName];
  const selectedUrl = explicitBaseUrl(options) || option(options, "resolved-url", "");
  const storedUrl = baseUrlFromEndpoint(registration?.httpUrl);
  const sameRegistration = !selectedUrl || selectedUrl === storedUrl;
  return {
    ...options,
    ...(!selectedUrl && storedUrl ? { "resolved-url": storedUrl } : {}),
    ...(!Object.hasOwn(options, "token-env") && sameRegistration && registration?.auth?.tokenEnv ? { "token-env": registration.auth.tokenEnv } : {})
  };
}

export async function uninstallTargets({ options, targets, optionOverrides = {} }: Record<string, any>) : Promise<any> {
  const mergedOptions: Record<string, any> = {
    ...options,
    ...optionOverrides
  };
  const settings: any = installerOptions(mergedOptions);
  assertSupportedInstallLocation(mergedOptions, targets);
  if (settings.baseUrl) await assertDeviceRegistrationBinding({ ...settings, discoveryPath: discoveryRegistryPath(mergedOptions) });
  const uninstalled: Record<string, any> = {};
  for (const target of targets) {
    try {
      const client: any = await resolveClientAdapterForTarget(
        target,
        settings,
        mergedOptions.__meshrixAdapterClient || (settings.clientCommand ? { command: settings.clientCommand } : {})
      );
      const adapterExecution: any = await runClientAdapter({
        target,
        action: "uninstall",
        request: clientAdapterRegistrationRequest({ ...settings, client })
      });
      uninstalled[target] = {
        ok: true,
        status: "not-installed",
        uninstallMode: "native-remote-mcp",
        ...adapterExecution.result,
        adapterPackage: adapterExecution.adapter.packageName
      };
    } catch (error: any) {
      uninstalled[target] = {
        ok: false,
        status: "failed",
        uninstallMode: "native-remote-mcp",
        errorCode: error?.code || "registration_removal_failed",
        error: redactSensitiveText(error?.message || String(error), sensitiveOptionValues(mergedOptions))
      };
    }
  }
  const discoveryManifest: any = settings.baseUrl && Object.values(uninstalled).some((value) => value.ok && value.removed)
    ? await writeDeviceUninstall({
        baseUrl: settings.baseUrl,
        serverName: settings.serverName,
        publishEnv: false,
        uninstalled,
        tokenEnv: Object.hasOwn(mergedOptions, "token-env") ? settings.tokenEnv : "",
        discoveryPath: discoveryRegistryPath(mergedOptions)
      })
    : "";
  return {
    ok: (Object.values(uninstalled) as any[]).every((value?: any) : any => value?.ok !== false),
    packageName: packageInfo.name,
    packageVersion: packageInfo.version,
    targets,
    baseUrl: settings.baseUrl,
    discoveryManifest,
    uninstalled
  };
}

export async function uninstallSelectedCandidates({ options, selected }: Record<string, any>) : Promise<any> {
  const partials: any[] = [];
  let discoveryManifest: any = "";
  let baseUrl: any = installerOptions(options).baseUrl;
  const uninstalled: Record<string, any> = {};
  for (const candidate of selected) {
    const partial: any = await uninstallTargets({
      options,
      targets: [candidate.target],
      optionOverrides: candidate.optionOverrides || {}
    });
    partials.push({
      target: candidate.target,
      id: candidate.id,
      label: candidate.label,
      ok: partial.ok,
      discoveryManifest: partial.discoveryManifest
    });
    discoveryManifest = partial.discoveryManifest || discoveryManifest;
    baseUrl = partial.baseUrl || baseUrl;
    Object.assign(uninstalled, partial.uninstalled || {});
  }
  return {
    ok: partials.every((partial?: any) : any => partial.ok),
    packageName: packageInfo.name,
    packageVersion: packageInfo.version,
    targets: [...new Set<any>(selected.map((candidate?: any) : any => candidate.target))],
    baseUrl,
    discoveryManifest,
    uninstalled,
    partials
  };
}

export async function waitAnyKey(promptText?: any) : Promise<any> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }
  return new Promise((resolve?: any) : any => {
    const stdin: any = process.stdin;
    const wasRaw: any = stdin.isRaw;
    const cleanup: any = () : any => {
      stdin.off("data", onData);
      if (stdin.setRawMode) {
        stdin.setRawMode(Boolean(wasRaw));
      }
      stdin.pause();
      process.stdout.write("\n");
      resolve();
    };
    const onData: any = () : any => cleanup();
    process.stdout.write(promptText);
    stdin.setEncoding("utf8");
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function uninstallTuiCommand(options?: any) : Promise<any> {
  const settings: any = installerOptions(options);
  const scan: any = await scanInstallTargets(options);

  const manifestPath: any = discoveryRegistryPath(options);
  const manifest: any = await readJson(manifestPath, null);
  let installedTargets: any[] = [];
  if (manifest) {
    const server: any = manifest.servers?.[settings.serverName] || {};
    installedTargets = (Object.entries(server.targets || {}) as [string, any][])
      .filter(([, status]: any[]) : any => ["configured", "installed"].includes(status?.status))
      .map(([target]: any[]) : any => target);
  }

  const filteredCandidates: any = scan.candidates.filter((c?: any) : any => installedTargets.includes(c.target));

  if (filteredCandidates.length === 0) {
    console.log(`\x1b[2J\x1b[HMeshrix MCP uninstall\n`);
    console.log(`Scanned ${scan.candidates.length} supported MCP clients.`);
    console.log("None of these clients currently have Meshrix.js MCP installed.");
    await waitAnyKey("\nPress any key to escape...");
    return {
      ok: true,
      cancelled: true,
      packageName: packageInfo.name,
      packageVersion: packageInfo.version,
      reason: "No installed Meshrix.js MCP clients found to uninstall."
    };
  }

  const selected: any = await chooseUninstallCandidates({
    candidates: filteredCandidates,
    baseUrl: settings.baseUrl
  });
  if (!selected || selected.length === 0) {
    return {
      ok: false,
      cancelled: true,
      packageName: packageInfo.name,
      packageVersion: packageInfo.version,
      reason: "Interactive uninstall cancelled."
    };
  }
  const result: any = await uninstallSelectedCandidates({ options, selected });
  return {
    ...result,
    interactive: true,
    selected: selected.map((candidate?: any) : any => ({
      id: candidate.id,
      target: candidate.target,
      label: candidate.label,
      detail: candidate.detail
    }))
  };
}

export async function uninstallCommand(options?: any) : Promise<any> {
  discardConfiguredApiKeyEnvironment(options);
  const resolvedOptions: any = await optionsWithStoredBaseUrl(options);
  if (canUseUninstallTui(options)) {
    return uninstallTuiCommand(resolvedOptions);
  }
  const targetOpt: any = option(resolvedOptions, "target", "");
  if (!targetOpt) {
    return {
      ok: false,
      packageName: packageInfo.name,
      packageVersion: packageInfo.version,
      error: "Interactive mode requires a TTY. Please specify --target <client> for non-interactive use."
    };
  }
  const targets: any = parseTargets(targetOpt);
  return uninstallTargets({
    options: resolvedOptions,
    targets
  });
}
