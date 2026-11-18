import { packageInfo, PRIORITY_INSTALL_TARGETS } from "./constants.ts";
import { isAutoTargetRequest, option, parseTargets } from "./basic-utils.ts";
import { nativeCapability } from "@meshrix/client-adapter-kit";
import { clientAdapterRegistrationRequest, runClientAdapter } from "./client-adapter-runner.ts";
import { assertDeviceRegistrationBinding, writeDeviceDiscovery } from "./device-config.ts";
import { ensureService, verifyMcpTools } from "./discovery.ts";
import {
  assertSupportedInstallLocation,
  assertNativeInstallOptions,
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

export async function installTargets({ options, targets, token, tokenInfo = null, optionOverrides = {}, serviceChecks = new Map() }: Record<string, any>) : Promise<any> {
  const mergedOptions: Record<string, any> = {
    ...options,
    ...optionOverrides
  };
  assertNativeInstallOptions(mergedOptions);
  if (tokenInfo?.source === "protected-stdin") throw Object.assign(new Error("Native registration requires a protected runtime reference, not a stdin-only credential."), { code: "credential_handoff_required" });
  assertSupportedInstallLocation(mergedOptions, targets);
  const settings: any = installerOptions(mergedOptions);
  const verify: any = !mergedOptions["no-verify"];

  const serviceBinding = JSON.stringify([settings.baseUrl, settings.serverName, settings.tokenEnv, verify, discoveryRegistryPath(mergedOptions)]);
  const installed: Record<string, any> = {};
  for (const target of targets) {
    try {
      const capability = nativeCapability(target);
      if (!capability.supported) throw Object.assign(new Error(capability.reason), { code: capability.reasonCode });
      if (!serviceChecks.has(serviceBinding)) serviceChecks.set(serviceBinding, (async () => {
        await assertDeviceRegistrationBinding({ ...settings, discoveryPath: discoveryRegistryPath(mergedOptions) });
        await ensureService(settings.baseUrl);
        return verify && token ? verifyMcpTools({ baseUrl: settings.baseUrl, token }) : null;
      })());
      const serviceVerification = await serviceChecks.get(serviceBinding);
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
        request: clientAdapterRegistrationRequest({ ...settings, client })
      });
      const clientResult: Record<string, any> = {
        installMode: "native-remote-mcp",
        ...adapterExecution.result,
        adapterPackage: adapterExecution.adapter.packageName
      };
      if (clientResult.installed !== true || clientResult.status !== "configured") throw new Error("The client adapter did not confirm the expected native registration.");
      installed[target] = {
        ...clientResult,
        ok: true,
        status: "configured",
        serverName: settings.serverName,
        credentialRef: settings.credentialRef,
        credentialStatus: "external-reference-unverified",
        credentialStored: false,
        environmentProvisioned: false,
        connectivity: "not-run",
        serviceVerification
      };
    } catch (error: any) {
      installed[target] = {
        ok: false,
        status: error?.code === "unsupported_protected_header_reference" ? "unsupported" : "failed",
        errorCode: error?.code || "registration_failed",
        installMode: "native-remote-mcp",
        error: redactSensitiveText(error?.message || String(error), [token])
      };
    }
  }

  const discoveryManifest: any = Object.values(installed).some((value) => value.ok)
    ? await writeDeviceDiscovery({
        baseUrl: settings.baseUrl, serverName: settings.serverName, installed,
        tokenEnv: settings.tokenEnv, publishEnv: false,
        discoveryPath: discoveryRegistryPath(mergedOptions)
      }) : "";

  return {
    ok: (Object.values(installed) as any[]).every((value?: any) : any => value?.ok !== false),
    packageName: packageInfo.name,
    packageVersion: packageInfo.version,
    targets,
    baseUrl: settings.baseUrl,
    discoveryManifest,
    serverName: settings.serverName,
    installed
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
  const scan: any = await scanInstallTargets(options);
  const selected: any = await chooseInstallCandidates({
    candidates: scan.candidates,
    baseUrl: settings.baseUrl
  });
  if (!selected || selected.length === 0) {
    return {
      ok: false,
      cancelled: true,
      packageName: packageInfo.name,
      packageVersion: packageInfo.version,
      reason: "Interactive install cancelled."
    };
  }
  assertSelectedInstallLocations(options, selected);
  const selectedTargets: any[] = [...new Set<any>(selected.map((candidate?: any) : any => candidate.target))];
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
  const serviceChecks = new Map();
  let discoveryManifest: any = "";
  let baseUrl: any = installerOptions(options).baseUrl;
  const installed: Record<string, any> = {};
  for (const candidate of selected) {
    const partial: any = await installTargets({
      options,
      targets: [candidate.target],
      token: tokenInfo.token,
      tokenInfo,
      serviceChecks,
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
    packageName: packageInfo.name,
    packageVersion: packageInfo.version,
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
    nativeRegistration: candidate.nativeRegistration,
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
  const context = commandGuidanceContext(options);
  context.includeUrl = Boolean(context.baseUrl);
  const scanCommand: any = shellCommandForScan(context);
  return {
    errorCode: "NO_SUPPORTED_MCP_CLIENTS_DETECTED",
    nextCommand: scanCommand,
    repairCommands: [
      scanCommand,
      shellCommandForInstall({ target: suggestedTarget, ...context }),
      shellCommandForInstall({ target: "auto", ...context })
    ],
    ...installGuidanceMetadata(context)
  };
}

export async function installAutoDetectedCommand(resolvedOptions?: any, tokenInfo?: any) : Promise<any> {
  const scan: any = await scanInstallTargets(resolvedOptions);
  const selected: any = scan.candidates.filter((candidate?: any) : any => candidate.status === "detected" && candidate.nativeRegistration?.supported === true);
  const candidates: any = scan.candidates.map(summarizeInstallCandidate);
  if (selected.length === 0) {
    return {
      ok: false,
      autoDetected: true,
      packageName: packageInfo.name,
      packageVersion: packageInfo.version,
      baseUrl: installerOptions(resolvedOptions).baseUrl,
      error: "No supported MCP client was detected. Install or configure a supported client application, then retry or choose a target in a TTY.",
      ...noDetectedClientGuidance(candidates, resolvedOptions),
      candidates
    };
  }
  assertSelectedInstallLocations(resolvedOptions, selected);
  const selectedTargets: any[] = [...new Set<any>(selected.map((candidate?: any) : any => candidate.target))];
  const result: any = await installSelectedCandidates({ options: resolvedOptions, selected, tokenInfo });
  return {
    ...result,
    autoDetected: true,
    selected: selected.map(summarizeInstallCandidate)
  };
}

export async function installCommand(options: Record<string, any> = {}) : Promise<any> {
  assertNativeInstallOptions(options);
  const initialTargetOpt: any = option(options, "target", "");
  const prevalidatedTargets: any = initialTargetOpt && !isAutoTargetRequest(initialTargetOpt)
    ? parseTargets(initialTargetOpt)
    : null;
  if (options["client-config"] || options["client-config-root"]) assertSupportedInstallLocation(options, prevalidatedTargets || []);
  if (prevalidatedTargets?.every((target: string) => !nativeCapability(target).supported)) {
    return installTargets({ options, targets: prevalidatedTargets, token: "" });
  }
  const tokenInfo: any = await resolveInstallToken(options);
  const resolvedOptions: any = await resolveHubForInstall(options);
  if (resolvedOptions.__meshrixSkippedDiscovery) {
    return {
      ok: false,
      skipped: true,
      packageName: packageInfo.name,
      packageVersion: packageInfo.version,
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
  return installTargets({
    options: resolvedOptions,
    targets,
    token: tokenInfo.token,
    tokenInfo
  });
}
