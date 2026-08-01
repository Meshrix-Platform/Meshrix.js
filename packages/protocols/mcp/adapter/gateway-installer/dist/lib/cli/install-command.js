import { packageJson, PRIORITY_INSTALL_TARGETS } from "./constants.js";
import { isAutoTargetRequest, option, parseTargets, targetInstallMode } from "./basic-utils.js";
import { clientAdapterConnectorRequest, runClientAdapter } from "./client-adapter-runner.js";
import { writeDeviceDiscovery } from "./device-config.js";
import { ensureService, verifyMcpTools } from "./discovery.js";
import { assertProcessIdentityInstallLocation, chooseAutoUpdate, chooseInstallCandidates, finalizeRevokedLocalMcpCredential, notifyLocalMcpUninstall, requestLocalMcpGrant, resolveHubForInstall, resolveInstallToken } from "./interactive.js";
import { discoveryRegistryPath } from "./device-discovery-registry.js";
import { redactSensitiveText, redactToken } from "./installer-output-safety.js";
import { canUseInstallTui, installerOptions } from "./installer-options.js";
import { resolveClientAdapterForTarget, scanInstallTargets } from "./scan-candidates.js";
import { commandGuidanceContext, installGuidanceMetadata, shellCommandForInstall, shellCommandForScan } from "./guidance.js";
async function rollbackIssuedInstallGrant(options, target, tokenInfo) {
    const grantId = String(tokenInfo?.grant?.id || "");
    if (!tokenInfo?.issuedNow || !grantId) {
        return null;
    }
    const notified = await notifyLocalMcpUninstall(options, {
        targets: [target],
        expectedGrantIds: { [target]: grantId }
    });
    const targetResult = notified.perTarget?.[target];
    if (targetResult?.ok !== true) {
        return {
            ok: false,
            serverGrantRevoked: false,
            localCredentialRemoved: false,
            credentialRetainedForRecovery: true,
            error: targetResult?.error || "Newly issued MCP grant rollback was not confirmed."
        };
    }
    const finalized = await finalizeRevokedLocalMcpCredential(target, grantId);
    return {
        ...finalized,
        serverGrantRevoked: true
    };
}
export async function installTargets({ options, targets, token, tokenInfo = null, optionOverrides = {} }) {
    const mergedOptions = {
        ...options,
        ...optionOverrides
    };
    assertProcessIdentityInstallLocation(mergedOptions, targets);
    const settings = installerOptions(mergedOptions);
    const verify = !mergedOptions["no-verify"];
    try {
        await ensureService(settings.baseUrl);
    }
    catch (error) {
        const rollbacks = [];
        for (const target of targets) {
            const targetInfo = tokenInfo?.grantsByTarget?.[target] || tokenInfo;
            const rollback = await rollbackIssuedInstallGrant(mergedOptions, target, targetInfo).catch(() => ({
                ok: false,
                credentialRetainedForRecovery: true
            }));
            if (rollback) {
                rollbacks.push(rollback);
            }
        }
        const rollbackIncomplete = rollbacks.some((rollback) => rollback.ok === false);
        const suffix = rollbackIncomplete
            ? " Newly issued authorization rollback was not fully confirmed; its credential was retained for recovery."
            : "";
        throw new Error(`${error?.message || String(error)}${suffix}`);
    }
    const installed = {};
    for (const target of targets) {
        let targetToken = token;
        let targetTokenInfo = tokenInfo;
        try {
            if (!targetToken && tokenInfo?.grantsByTarget?.[target]?.token) {
                targetTokenInfo = tokenInfo.grantsByTarget[target];
                targetToken = targetTokenInfo.token;
            }
            else if (!targetToken && tokenInfo?.perTarget) {
                targetTokenInfo = await requestLocalMcpGrant(mergedOptions, {
                    targets: [target],
                    autoUpdate: Boolean(mergedOptions.__meshrixAutoUpdate ?? tokenInfo.autoUpdate)
                });
                targetToken = targetTokenInfo.token;
            }
            const client = await resolveClientAdapterForTarget(target, settings, mergedOptions.__meshrixAdapterClient || (settings.clientCommand ? { command: settings.clientCommand } : {}));
            if (!client.command) {
                throw new Error("The trusted client adapter did not detect a local client command.");
            }
            const adapterExecution = await runClientAdapter({
                target,
                action: "install",
                cacheRoot: settings.adapterCacheRoot,
                request: clientAdapterConnectorRequest({
                    baseUrl: settings.baseUrl,
                    tokenEnv: settings.tokenEnv,
                    client
                })
            });
            const clientResult = {
                installMode: "external-client-adapter",
                ...adapterExecution.result,
                adapterPackage: adapterExecution.adapter.coordinate,
                adapterCacheHit: adapterExecution.cache.hit
            };
            const httpVerification = verify ? await verifyMcpTools({ baseUrl: settings.baseUrl, token: targetToken, target }) : null;
            installed[target] = {
                ok: true,
                status: "installed",
                tokenPrefix: targetTokenInfo?.tokenPrefix || redactToken(targetToken),
                tokenSource: targetTokenInfo?.source || "provided",
                ...(clientResult || {}),
                httpVerification
            };
        }
        catch (error) {
            const authorizationRollback = await rollbackIssuedInstallGrant(mergedOptions, target, targetTokenInfo).catch(() => ({
                ok: false,
                serverGrantRevoked: false,
                localCredentialRemoved: false,
                credentialRetainedForRecovery: true,
                error: "Newly issued MCP grant rollback failed."
            }));
            const rollbackSuffix = authorizationRollback?.ok === false
                ? " Newly issued authorization rollback was not fully confirmed; its credential was retained for recovery."
                : "";
            installed[target] = {
                ok: false,
                status: "failed",
                installMode: targetInstallMode(target),
                error: `${redactSensitiveText(error?.message || String(error), [targetToken || token])}${rollbackSuffix}`,
                ...(authorizationRollback ? { authorizationRollback } : {})
            };
        }
    }
    const discoveryManifest = await writeDeviceDiscovery({
        baseUrl: settings.baseUrl,
        installed,
        token,
        tokenEnv: settings.tokenEnv,
        discoveryPath: discoveryRegistryPath(mergedOptions)
    });
    function summarizeInstalledTarget(target, value = {}) {
        return {
            installMode: value.installMode,
            status: value.status || (value.ok === false ? "failed" : "installed"),
            error: value.error || "",
            tokenSource: value.tokenSource || tokenInfo?.source || "provided",
            tokenPrefix: value.tokenPrefix || tokenInfo?.tokenPrefix || redactToken(token),
            httpVerification: value.httpVerification || null,
            ...(value.authorizationRollback ? { authorizationRollback: value.authorizationRollback } : {}),
            adapterPackage: value.adapterPackage || "",
            adapterCacheHit: value.adapterCacheHit === true
        };
    }
    return {
        ok: Object.values(installed).every((value) => value?.ok !== false),
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        targets,
        baseUrl: settings.baseUrl,
        discoveryManifest,
        installed: Object.fromEntries(Object.entries(installed).map(([target, value]) => [
            target,
            summarizeInstalledTarget(target, value)
        ]))
    };
}
function assertSelectedInstallLocations(options, selected = []) {
    for (const candidate of selected) {
        assertProcessIdentityInstallLocation({
            ...options,
            ...(candidate.optionOverrides || {})
        }, [candidate.target]);
    }
}
export async function installTuiCommand(options) {
    const settings = installerOptions(options);
    await ensureService(settings.baseUrl);
    const scan = await scanInstallTargets(options);
    const selected = await chooseInstallCandidates({
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
    const selectedTargets = [...new Set(selected.map((candidate) => candidate.target))];
    const autoUpdate = await chooseAutoUpdate();
    options.__meshrixAutoUpdate = autoUpdate;
    const tokenInfo = await resolveInstallToken(options, { targets: selectedTargets, autoUpdate });
    const hasPerCandidateOverrides = selected.some((candidate) => Object.keys(candidate.optionOverrides || {}).length > 0);
    const result = hasPerCandidateOverrides
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
        selected: selected.map((candidate) => ({
            id: candidate.id,
            target: candidate.target,
            label: candidate.label,
            detail: candidate.detail
        }))
    };
}
export async function installSelectedCandidates({ options, selected, tokenInfo }) {
    const partials = [];
    let discoveryManifest = "";
    let baseUrl = installerOptions(options).baseUrl;
    const installed = {};
    for (const candidate of selected) {
        const partial = await installTargets({
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
        ok: partials.every((partial) => partial.ok),
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        targets: [...new Set(selected.map((candidate) => candidate.target))],
        baseUrl,
        discoveryManifest,
        installed,
        partials
    };
}
export function summarizeInstallCandidate(candidate) {
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
export function noDetectedClientGuidance(candidates = [], options = {}) {
    const explicitTargets = candidates
        .map((candidate) => candidate.target)
        .filter((target, index, values) => target && values.indexOf(target) === index);
    const priorityTargets = PRIORITY_INSTALL_TARGETS.filter((target) => explicitTargets.includes(target));
    const suggestedTarget = priorityTargets[0] || explicitTargets[0] || "codex";
    const { baseUrl, tokenEnv } = commandGuidanceContext(options);
    const includeUrl = Boolean(baseUrl);
    const scanCommand = shellCommandForScan({ includeUrl, baseUrl, tokenEnv });
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
export async function installAutoDetectedCommand(resolvedOptions) {
    const scan = await scanInstallTargets(resolvedOptions);
    const selected = scan.candidates.filter((candidate) => candidate.status === "detected");
    const candidates = scan.candidates.map(summarizeInstallCandidate);
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
    const autoUpdate = Boolean(resolvedOptions["auto-update"]);
    resolvedOptions.__meshrixAutoUpdate = autoUpdate;
    const selectedTargets = [...new Set(selected.map((candidate) => candidate.target))];
    const tokenInfo = await resolveInstallToken(resolvedOptions, { targets: selectedTargets, autoUpdate });
    const result = await installSelectedCandidates({ options: resolvedOptions, selected, tokenInfo });
    return {
        ...result,
        autoDetected: true,
        selected: selected.map(summarizeInstallCandidate)
    };
}
export async function installCommand(options) {
    const initialTargetOpt = option(options, "target", "");
    const prevalidatedTargets = initialTargetOpt && !isAutoTargetRequest(initialTargetOpt)
        ? parseTargets(initialTargetOpt)
        : null;
    const resolvedOptions = await resolveHubForInstall(options);
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
        return installTuiCommand(resolvedOptions);
    }
    const targetOpt = option(resolvedOptions, "target", "");
    if (!targetOpt) {
        return installAutoDetectedCommand(resolvedOptions);
    }
    if (isAutoTargetRequest(targetOpt)) {
        return installAutoDetectedCommand(resolvedOptions);
    }
    const targets = prevalidatedTargets || parseTargets(targetOpt);
    const autoUpdate = Boolean(resolvedOptions["auto-update"]);
    resolvedOptions.__meshrixAutoUpdate = autoUpdate;
    const tokenInfo = await resolveInstallToken(resolvedOptions, { targets, autoUpdate });
    return installTargets({
        options: resolvedOptions,
        targets,
        token: tokenInfo.token,
        tokenInfo
    });
}
//# sourceMappingURL=install-command.js.map