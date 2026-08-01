import { MCP_CLIENT_TARGETS } from "../../mcp-release-targets.ts";

import { notDetectedTargetDetail, targetLabel } from "./basic-utils.ts";
import {
  clientAdapterConnectorRequest,
  describeClientAdapter,
  runClientAdapter
} from "./client-adapter-runner.ts";
import { packageJson, SUPPORTED_TARGETS } from "./constants.ts";
import { withInstallCandidateGuidance } from "./guidance.ts";
import { installerOptions } from "./installer-options.ts";
import { detectLocalCommandPaths } from "./scan-local.ts";

export function candidateLocation() : any {
  return "local";
}

export function isGenericRemoteLocation(_location?: any) : any {
  return false;
}

export function candidateIdentity(candidate?: any) : any {
  const command: any = String(candidate?.optionOverrides?.__meshrixAdapterClient?.command || "").trim();
  return candidate?.target && command ? `${candidate.target}:local:${command}` : String(candidate?.target || "");
}

export function mergeInstallCandidate(candidates?: any, candidate?: any) : any {
  const identity: any = candidateIdentity(candidate);
  const existingIndex: any = candidates.findIndex((item?: any) : any => candidateIdentity(item) === identity);
  if (existingIndex < 0) {
    candidates.push(candidate);
    return;
  }
  if (existingIndex >= 0 && candidates[existingIndex].status !== "detected" && candidate.status === "detected") {
    candidates[existingIndex] = candidate;
  }
}

export function candidateBin(candidate?: any) : any {
  return String(candidate?.optionOverrides?.__meshrixAdapterClient?.command || "");
}

export function candidateRemoteContext() : any {
  return null;
}

async function adapterDescriptor(target?: any, settings?: any) : Promise<any> {
  return describeClientAdapter({ target, cacheRoot: settings.adapterCacheRoot });
}

export async function resolveClientAdapterForTarget(target?: any, settings?: any, requestedClient: Record<string, any> = {}) : Promise<any> {
  if (requestedClient?.command) return { ...requestedClient };
  const described: any = await adapterDescriptor(target, settings);
  for (const commandName of described.result.commandNames) {
    const paths: any = await detectLocalCommandPaths(commandName);
    if (paths[0]) return { command: paths[0] };
  }
  return {};
}

async function verifyCandidate(settings?: any, target?: any, client?: any) : Promise<any> {
  const executed: any = await runClientAdapter({
    target,
    action: "verify",
    cacheRoot: settings.adapterCacheRoot,
    request: clientAdapterConnectorRequest({
      baseUrl: settings.baseUrl,
      tokenEnv: settings.tokenEnv,
      client
    })
  });
  return executed.result.installed === true;
}

export async function candidateHasInstalledMeshrixMcp(settings?: any, candidate?: any) : Promise<any> {
  if (candidate?.status !== "detected") return false;
  return verifyCandidate(settings, candidate.target, candidate.optionOverrides?.__meshrixAdapterClient || {});
}

export async function annotateInstalledCandidates(settings?: any, candidates?: any) : Promise<any> {
  for (const candidate of candidates) {
    if (typeof candidate.installed !== "boolean") {
      candidate.installed = await candidateHasInstalledMeshrixMcp(settings, candidate).catch(() : any => false);
    }
  }
  return candidates;
}

async function scanTarget(settings?: any, target?: any, explicitClient: Record<string, any> = {}) : Promise<any> {
  const described: any = await adapterDescriptor(target, settings);
  const candidates: any[] = [];
  const commands: any = explicitClient.command
    ? [explicitClient.command]
    : (await Promise.all(described.result.commandNames.map((name?: any) : any => detectLocalCommandPaths(name)))).flat();
  for (const command of [...new Set<any>(commands)]) {
      const client: Record<string, any> = { command };
      const scanned: any = await runClientAdapter({
        target,
        action: "scan",
        cacheRoot: settings.adapterCacheRoot,
        request: clientAdapterConnectorRequest({
          baseUrl: settings.baseUrl,
          tokenEnv: settings.tokenEnv,
          client
        })
      });
      if (scanned.result.available === false) continue;
      candidates.push({
        id: `${target}:local:${command}`,
        target,
        label: described.result.label || targetLabel(target),
        status: "detected",
        detail: command,
        installed: scanned.result.installed === true,
        adapterPackage: described.adapter.coordinate,
        adapterCacheHit: described.cache.hit && scanned.cache.hit,
        optionOverrides: {
          "execution-location": "local",
          __meshrixAdapterClient: client
        }
      });
  }
  return candidates;
}

export async function scanInstallTargets(options: Record<string, any> = {}) : Promise<any> {
  const settings: any = installerOptions(options);
  const candidates: any[] = [];
  const explicitTarget: any = SUPPORTED_TARGETS.includes(String(options.target || "")) ? String(options.target) : "";
  if (!options["no-scan"]) {
    for (const { target } of MCP_CLIENT_TARGETS) {
      try {
        const explicitClient: any = explicitTarget === target && settings.clientCommand
          ? { command: settings.clientCommand }
          : {};
        for (const candidate of await scanTarget(settings, target, explicitClient)) mergeInstallCandidate(candidates, candidate);
      } catch (error: any) {
        candidates.push({
          id: target,
          target,
          label: targetLabel(target),
          status: "not-detected",
          detail: error?.code === "CLIENT_ADAPTER_PROCESS_FAILED"
            ? "trusted client adapter could not inspect this host"
            : "trusted client adapter is unavailable"
        });
      }
    }
  }
  for (const target of SUPPORTED_TARGETS) {
    if (candidates.some((candidate?: any) : any => candidate.target === target)) continue;
    candidates.push({
      id: target,
      target,
      label: targetLabel(target),
      status: "not-detected",
      detail: options["no-scan"] ? "client adapter scan disabled" : notDetectedTargetDetail(target)
    });
  }
  await annotateInstalledCandidates(settings, candidates);
  return {
    ok: true,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    hostOs: settings.hostOs,
    baseUrl: settings.baseUrl,
    mcpUrl: settings.baseUrl ? `${settings.baseUrl}/mcp` : "",
    candidates: candidates.map((candidate?: any) : any => withInstallCandidateGuidance(candidate, settings))
  };
}
