import { MCP_SERVER_NAME, packageJson } from "./constants.mjs";
import { option, parseTargets, targetInstallMode } from "./basic-utils.mjs";
import { clientAdapterConnectorRequest, runClientAdapter } from "./client-adapter-runner.mjs";
import { writeDeviceUninstall } from "./device-config.mjs";
import { explicitBaseUrl, registryBaseUrls } from "./discovery.mjs";
import {
  discoveryRegistryPath,
  readJson
} from "./device-discovery-registry.mjs";
import { redactSensitiveText, sensitiveOptionValues } from "./installer-output-safety.mjs";
import {
  chooseUninstallCandidates,
  finalizeRevokedLocalMcpCredential,
  notifyLocalMcpUninstall,
} from "./interactive.mjs";
import { canUseUninstallTui, installerOptions } from "./installer-options.mjs";
import { resolveClientAdapterForTarget, scanInstallTargets } from "./scan-candidates.mjs";

export async function optionsWithStoredBaseUrl(options = {}) {
  if (explicitBaseUrl(options) || option(options, "resolved-url", "")) {
    return options;
  }
  const [storedBaseUrl] = await registryBaseUrls(options);
  return storedBaseUrl
    ? { ...options, "resolved-url": storedBaseUrl }
    : options;
}

export async function uninstallTargets({ options, targets, optionOverrides = {} }) {
  const mergedOptions = {
    ...options,
    ...optionOverrides
  };
  const settings = installerOptions(mergedOptions);
  const uninstalled = {};
  for (const target of targets) {
    try {
      const client = await resolveClientAdapterForTarget(
        target,
        settings,
        mergedOptions.__licoAdapterClient || (settings.clientCommand ? { command: settings.clientCommand } : {})
      );
      const adapterExecution = await runClientAdapter({
        target,
        action: "uninstall",
        cacheRoot: settings.adapterCacheRoot,
        request: clientAdapterConnectorRequest({
          baseUrl: settings.baseUrl,
          tokenEnv: settings.tokenEnv,
          client
        })
      });
      uninstalled[target] = {
        ok: true,
        status: "not-installed",
        uninstallMode: "external-client-adapter",
        ...adapterExecution.result,
        adapterPackage: adapterExecution.adapter.coordinate,
        adapterCacheHit: adapterExecution.cache.hit
      };
    } catch (error) {
      uninstalled[target] = {
        ok: false,
        status: "failed",
        uninstallMode: targetInstallMode(target),
        error: redactSensitiveText(error?.message || String(error), sensitiveOptionValues(mergedOptions))
      };
    }
  }
  const successfulTargets = targets.filter((target) => uninstalled[target]?.ok !== false);
  let serverUninstall = null;
  if (successfulTargets.length > 0) {
    try {
      serverUninstall = await notifyLocalMcpUninstall(mergedOptions, { targets: successfulTargets });
      for (const target of successfulTargets) {
        const targetResult = serverUninstall.perTarget?.[target];
        if (targetResult?.ok === true) {
          const finalized = await finalizeRevokedLocalMcpCredential(target);
          if (finalized.ok) {
            uninstalled[target] = {
              ...uninstalled[target],
              serverDeviceRemoved: true,
              localProcessIdentityRemoved: true
            };
          } else {
            uninstalled[target] = {
              ...uninstalled[target],
              ok: false,
              status: "failed",
              serverDeviceRemoved: true,
              localProcessIdentityRemoved: false,
              credentialRetainedForRecovery: true,
              error: finalized.error || "The revoked MCP credential could not be removed from local secure storage."
            };
          }
          continue;
        }
        const reason = targetResult?.error || "The server-side MCP device removal was not confirmed.";
        uninstalled[target] = {
          ...uninstalled[target],
          ok: false,
          status: "failed",
          serverDeviceRemoved: false,
          localProcessIdentityRemoved: false,
          error: redactSensitiveText(reason, sensitiveOptionValues(mergedOptions))
        };
      }
    } catch (error) {
      serverUninstall = {
        ok: false,
        error: redactSensitiveText(error?.message || String(error), sensitiveOptionValues(mergedOptions))
      };
      for (const target of successfulTargets) {
        uninstalled[target] = {
          ...uninstalled[target],
          ok: false,
          status: "failed",
          serverDeviceRemoved: false,
          localProcessIdentityRemoved: false,
          error: redactSensitiveText(error?.message || String(error), sensitiveOptionValues(mergedOptions))
        };
      }
    }
  }
  const discoveryManifest = settings.baseUrl
    ? await writeDeviceUninstall({
        baseUrl: settings.baseUrl,
        uninstalled,
        tokenEnv: Object.hasOwn(mergedOptions, "token-env") ? settings.tokenEnv : "",
        discoveryPath: discoveryRegistryPath(mergedOptions)
      })
    : "";
  return {
    ok: Object.values(uninstalled).every((value) => value?.ok !== false),
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    targets,
    baseUrl: settings.baseUrl,
    discoveryManifest,
    serverUninstall,
    uninstalled
  };
}

export async function uninstallSelectedCandidates({ options, selected }) {
  const partials = [];
  let discoveryManifest = "";
  let baseUrl = installerOptions(options).baseUrl;
  const uninstalled = {};
  for (const candidate of selected) {
    const partial = await uninstallTargets({
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
    ok: partials.every((partial) => partial.ok),
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    targets: [...new Set(selected.map((candidate) => candidate.target))],
    baseUrl,
    discoveryManifest,
    uninstalled,
    partials
  };
}

export async function waitAnyKey(promptText) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    const cleanup = () => {
      stdin.off("data", onData);
      if (stdin.setRawMode) {
        stdin.setRawMode(Boolean(wasRaw));
      }
      stdin.pause();
      process.stdout.write("\n");
      resolve();
    };
    const onData = () => cleanup();
    process.stdout.write(promptText);
    stdin.setEncoding("utf8");
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function uninstallTuiCommand(options) {
  const settings = installerOptions(options);
  const scan = await scanInstallTargets(options);

  const manifestPath = discoveryRegistryPath(options);
  const manifest = await readJson(manifestPath, null);
  let installedTargets = [];
  if (manifest) {
    const server = manifest.servers?.[MCP_SERVER_NAME] || {};
    installedTargets = Object.entries(server.targets || {})
      .filter(([, status]) => status?.status === "installed")
      .map(([target]) => target);
  }

  const filteredCandidates = scan.candidates.filter(c => installedTargets.includes(c.target));

  if (filteredCandidates.length === 0) {
    console.log(`\x1b[2J\x1b[HLico MCP uninstall\n`);
    console.log(`Scanned ${scan.candidates.length} supported MCP clients.`);
    console.log("None of these clients currently have Meshrix MCP installed.");
    await waitAnyKey("\nPress any key to escape...");
    return {
      ok: true,
      cancelled: true,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      reason: "No installed Meshrix MCP clients found to uninstall."
    };
  }

  const selected = await chooseUninstallCandidates({
    candidates: filteredCandidates,
    baseUrl: settings.baseUrl
  });
  if (!selected || selected.length === 0) {
    return {
      ok: false,
      cancelled: true,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      reason: "Interactive uninstall cancelled."
    };
  }
  const result = await uninstallSelectedCandidates({ options, selected });
  return {
    ...result,
    interactive: true,
    selected: selected.map((candidate) => ({
      id: candidate.id,
      target: candidate.target,
      label: candidate.label,
      detail: candidate.detail
    }))
  };
}

export async function uninstallCommand(options) {
  const resolvedOptions = await optionsWithStoredBaseUrl(options);
  if (canUseUninstallTui(options)) {
    return uninstallTuiCommand(resolvedOptions);
  }
  const targetOpt = option(resolvedOptions, "target", "");
  if (!targetOpt) {
    return {
      ok: false,
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      error: "Interactive mode requires a TTY. Please specify --target <client> for non-interactive use."
    };
  }
  const targets = parseTargets(targetOpt);
  return uninstallTargets({
    options: resolvedOptions,
    targets
  });
}
