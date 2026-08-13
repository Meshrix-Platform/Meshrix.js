import { packageJson, PRIORITY_INSTALL_TARGETS } from "./constants.ts";
import { isAutoTargetRequest, option, parseTargets, targetInstallMode } from "./basic-utils.ts";
import { clientAdapterConnectorRequest, runClientAdapter } from "./client-adapter-runner.ts";
import { saveMcpApiKeyCredential } from "./credential-store.ts";
import { writeDeviceDiscovery } from "./device-config.ts";
import { ensureService, verifyMcpTools } from "./discovery.ts";
import {
  assertSupportedInstallLocation,
  chooseAutoUpdate,
  chooseInstallCandidates,
  resolveHubForInstall,
  resolveInstallToken
} from "./interactive.ts";
import { discoveryRegistryPath } from "./device-discovery-registry.ts";
import { redactSensitiveText } from "./installer-output-safety.ts";
import { canUseInstallTui, installerOptions } from "./installer-options.ts";
import { resolveClientAdapterForTarget, scanInstallTargets } from "./scan-candidates.ts";
import {
  commandGuidanceContext,
  installGuidanceMetadata,
  shellCommandForInstall,
  shellCommandForScan
} from "./guidance.ts";

export async function installTargets({ options, targets, token, tokenInfo = null, optionOverrides = {} }: Record<string, any>) : Promise<any> {
  const mergedOptions: Record<string, any> = {
    ...options,
    ...optionOverrides
  };
  assertSupportedInstallLocation(mergedOptions, targets);
  const settings: any = installerOptions(mergedOptions);
  const verify: any = !mergedOptions["no-verify"];

  await ensureService(settings.baseUrl);

  const installed: Record<string, any> = {};
  for (const target of targets) {
    try {
      const client: any = await resolveClientAdapterForTarget(
        target,
        settings,
        mergedOptions.__meshrixAdapterClient || (settings.clientCommand ? { command: settings.clientCommand } : {})
      );
      if (!client.command) {
        throw new Error("The trusted client adapter did not detect a local client command.");
      }
      const adapterExecution: any = await runClientAdapter({
        target,
        action: "install",
        cacheRoot: settings.adapterCacheRoot,
        request: clientAdapterConnectorRequest({
          baseUrl: settings.baseUrl,
          tokenEnv: settings.tokenEnv,
          client
        })
      });
      const clientResult: Record<string, any> = {
        installMode: "external-client-adapter",
        ...adapterExecution.result,
        adapterPackage: adapterExecution.adapter.coordinate,
        adapterCacheHit: adapterExecution.cache.hit
      };
      const httpVerification: any = verify ? await verifyMcpTools({ baseUrl: settings.baseUrl, token, target }) : null;
      const credential: any = await saveMcpApiKeyCredential({
        target,
        baseUrl: settings.baseUrl,
        token,
        autoUpdate: mergedOptions.__meshrixAutoUpdate === true
      });
      installed[target] = {
        ok: true,
        status: "installed",
        tokenSource: tokenInfo?.source || "provided",
        ...(clientResult || {}),
        credentialStored: credential.stored === true,
        httpVerification
      };
    } catch (error: any) {
      installed[target] = {
        ok: false,
        status: "failed",
        installMode: targetInstallMode(target),
        error: redactSensitiveText(error?.message || String(error), [token])
      };
    }
  }

  const discoveryManifest: any = await writeDeviceDiscovery({
    baseUrl: settings.baseUrl,
    installed,
    tokenEnv: settings.tokenEnv,
    discoveryPath: discoveryRegistryPath(mergedOptions)
  });

  function summarizeInstalledTarget(target?: any, value: Record<string, any> = {}) : any {
    return {
      installMode: value.installMode,
      status: value.status || (value.ok === false ? "failed" : "installed"),
      error: value.error || "",
      tokenSource: value.tokenSource || tokenInfo?.source || "provided",
      httpVerification: value.httpVerification || null,
      adapterPackage: value.adapterPackage || "",
      adapterCacheHit: value.adapterCacheHit === true,
      credentialStored: value.credentialStored === true
    };
  }

  return {
    ok: (Object.values(installed) as any[]).every((value?: any) : any => value?.ok !== false),
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    targets,
    baseUrl: settings.baseUrl,
    discoveryManifest,
    installed: Object.fromEntries((Object.entries(installed) as [string, any][]).map(([target, value]: any[]) : any => [
      target,
      summarizeInstalledTarget(target, value)
    ]))
  };
}

function assertSelectedInstallLocations(options?: any, selected: any = []) : any {
  for (const candidate of selected) {
    assertSupportedInstallLocation({
      ...options,
      ...(candidate.optionOverrides || {})
    }, [candidate.target]);
  }
}

export async function installTuiCommand(options?: any, tokenInfo?: any) : Promise<any> {
  const settings: any = installerOptions(options);
  await ensureService(settings.baseUrl);
  const scan: any = await scanInstallTargets(options);
  const selected: any = await chooseInstallCandidates({
    candidates: scan.candidates,
    baseUrl: settings.baseUrl
  });
  if (!selected || selected.length === 0) {
    return {
      ok: false,
      cancelled: true,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      reason: "Interactive install cancelled."
    };
  }
  assertSelectedInstallLocations(options, selected);
  const selectedTargets: any[] = [...new Set<any>(selected.map((candidate?: any) : any => candidate.target))];
  const autoUpdate: any = await chooseAutoUpdate();
  options.__meshrixAutoUpdate = autoUpdate;
  const hasPerCandidateOverrides: any = selected.some((candidate?: any) : any =>
    Object.keys(candidate.optionOverrides || {}).length > 0
  );
  const result: any = hasPerCandidateOverrides
    ? await installSelectedCandidates({ options, selected, tokenInfo })
    : await installTargets({
        options,
        targets: selectedTargets,
        token: tokenInfo.token,
        tokenInfo
      });
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

export async function installSelectedCandidates({ options, selected, tokenInfo }: Record<string, any>) : Promise<any> {
  const partials: any[] = [];
  let discoveryManifest: any = "";
  let baseUrl: any = installerOptions(options).baseUrl;
  const installed: Record<string, any> = {};
  for (const candidate of selected) {
    const partial: any = await installTargets({
      options,
      targets: [candidate.target],
      token: tokenInfo.token,
      tokenInfo,
      optionOverrides: candidate.optionOverrides || {}
    });
    partials.push({
      target: candidate.target,
      id: candidate.id,
      label: candidate.label,
      ok: partial.ok,
      discoveryManifest: partial.discoveryManifest
    });
    discoveryManifest = partial.discoveryManifest;
    baseUrl = partial.baseUrl || baseUrl;
    Object.assign(installed, partial.installed || {});
  }
  return {
    ok: partials.every((partial?: any) : any => partial.ok),
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    targets: [...new Set<any>(selected.map((candidate?: any) : any => candidate.target))],
    baseUrl,
    discoveryManifest,
    installed,
    partials
  };
}

export function summarizeInstallCandidate(candidate?: any) : any {
  return {
    id: candidate.id,
    target: candidate.target,
    label: candidate.label,
    detail: candidate.detail || "",
    ...(candidate.mcpProbe ? { mcpProbe: candidate.mcpProbe } : {}),
    installed: Boolean(candidate.installed),
    installCommand: candidate.installCommand || "",
    repairCommand: candidate.repairCommand || "",
    doctorCommand: candidate.doctorCommand || "meshrix-mcp doctor --json"
  };
}

export function noDetectedClientGuidance(candidates: any = [], options: Record<string, any> = {}) : any {
  const explicitTargets: any = candidates
    .map((candidate?: any) : any => candidate.target)
    .filter((target?: any, index?: any, values?: any) : any => target && values.indexOf(target) === index);
  const priorityTargets: any = PRIORITY_INSTALL_TARGETS.filter((target?: any) : any => explicitTargets.includes(target));
  const suggestedTarget: any = priorityTargets[0] || explicitTargets[0] || "codex";
  const { baseUrl, tokenEnv } = commandGuidanceContext(options);
  const includeUrl: any = Boolean(baseUrl);
  const scanCommand: any = shellCommandForScan({ includeUrl, baseUrl, tokenEnv });
  return {
    errorCode: "NO_SUPPORTED_MCP_CLIENTS_DETECTED",
    nextCommand: scanCommand,
    repairCommands: [
      scanCommand,
      shellCommandForInstall({ target: suggestedTarget, includeUrl, baseUrl, tokenEnv }),
      shellCommandForInstall({ target: "auto", includeUrl, baseUrl, tokenEnv })
    ],
    ...installGuidanceMetadata({ includeUrl, baseUrl, tokenEnv })
  };
}

export async function installAutoDetectedCommand(resolvedOptions?: any, tokenInfo?: any) : Promise<any> {
  const scan: any = await scanInstallTargets(resolvedOptions);
  const selected: any = scan.candidates.filter((candidate?: any) : any => candidate.status === "detected");
  const candidates: any = scan.candidates.map(summarizeInstallCandidate);
  if (selected.length === 0) {
    return {
      ok: false,
      autoDetected: true,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      baseUrl: installerOptions(resolvedOptions).baseUrl,
      error: "No supported MCP clients were detected. Install the trusted adapter package for the target or run in a TTY for selection.",
      ...noDetectedClientGuidance(candidates, resolvedOptions),
      candidates
    };
  }
  assertSelectedInstallLocations(resolvedOptions, selected);
  const autoUpdate: any = Boolean(resolvedOptions["auto-update"]);
  resolvedOptions.__meshrixAutoUpdate = autoUpdate;
  const selectedTargets: any[] = [...new Set<any>(selected.map((candidate?: any) : any => candidate.target))];
  const result: any = await installSelectedCandidates({ options: resolvedOptions, selected, tokenInfo });
  return {
    ...result,
    autoDetected: true,
    selected: selected.map(summarizeInstallCandidate)
  };
}

export async function installCommand(options?: any) : Promise<any> {
  const tokenInfo: any = await resolveInstallToken(options);
  const initialTargetOpt: any = option(options, "target", "");
  const prevalidatedTargets: any = initialTargetOpt && !isAutoTargetRequest(initialTargetOpt)
    ? parseTargets(initialTargetOpt)
    : null;
  const resolvedOptions: any = await resolveHubForInstall(options);
  if (resolvedOptions.__meshrixSkippedDiscovery) {
    return {
      ok: false,
      skipped: true,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      ...resolvedOptions.__meshrixSkippedDiscovery
    };
  }
  if (canUseInstallTui(options)) {
    return installTuiCommand(resolvedOptions, tokenInfo);
  }
  const targetOpt: any = option(resolvedOptions, "target", "");
  if (!targetOpt) {
    return installAutoDetectedCommand(resolvedOptions, tokenInfo);
  }
  if (isAutoTargetRequest(targetOpt)) {
    return installAutoDetectedCommand(resolvedOptions, tokenInfo);
  }
  const targets: any = prevalidatedTargets || parseTargets(targetOpt);
  const autoUpdate: any = Boolean(resolvedOptions["auto-update"]);
  resolvedOptions.__meshrixAutoUpdate = autoUpdate;
  return installTargets({
    options: resolvedOptions,
    targets,
    token: tokenInfo.token,
    tokenInfo
  });
}
