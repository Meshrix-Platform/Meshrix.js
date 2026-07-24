import { MCP_CLIENT_TARGETS } from "../../mcp-release-targets.mjs";

import { notDetectedTargetDetail, targetLabel } from "./basic-utils.mjs";
import {
  clientAdapterConnectorRequest,
  describeClientAdapter,
  runClientAdapter
} from "./client-adapter-runner.mjs";
import { packageJson, SUPPORTED_TARGETS } from "./constants.mjs";
import { withInstallCandidateGuidance } from "./guidance.mjs";
import { installerOptions } from "./installer-options.mjs";
import { detectLocalCommandPaths } from "./scan-local.mjs";

export function candidateLocation() {
  return "local";
}

export function isGenericRemoteLocation() {
  return false;
}

export function candidateIdentity(candidate) {
  const command = String(candidate?.optionOverrides?.__licoAdapterClient?.command || "").trim();
  return candidate?.target && command ? `${candidate.target}:local:${command}` : String(candidate?.target || "");
}

export function mergeInstallCandidate(candidates, candidate) {
  const identity = candidateIdentity(candidate);
  const existingIndex = candidates.findIndex((item) => candidateIdentity(item) === identity);
  if (existingIndex < 0) {
    candidates.push(candidate);
    return;
  }
  if (existingIndex >= 0 && candidates[existingIndex].status !== "detected" && candidate.status === "detected") {
    candidates[existingIndex] = candidate;
  }
}

export function candidateBin(candidate) {
  return String(candidate?.optionOverrides?.__licoAdapterClient?.command || "");
}

export function candidateRemoteContext() {
  return null;
}

async function adapterDescriptor(target, settings) {
  return describeClientAdapter({ target, cacheRoot: settings.adapterCacheRoot });
}

export async function resolveClientAdapterForTarget(target, settings, requestedClient = {}) {
  if (requestedClient?.command) return { ...requestedClient };
  const described = await adapterDescriptor(target, settings);
  for (const commandName of described.result.commandNames) {
    const paths = await detectLocalCommandPaths(commandName);
    if (paths[0]) return { command: paths[0] };
  }
  return {};
}

async function verifyCandidate(settings, target, client) {
  const executed = await runClientAdapter({
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

export async function candidateHasInstalledLicoMcp(settings, candidate) {
  if (candidate?.status !== "detected") return false;
  return verifyCandidate(settings, candidate.target, candidate.optionOverrides?.__licoAdapterClient || {});
}

export async function annotateInstalledCandidates(settings, candidates) {
  for (const candidate of candidates) {
    if (typeof candidate.installed !== "boolean") {
      candidate.installed = await candidateHasInstalledLicoMcp(settings, candidate).catch(() => false);
    }
  }
  return candidates;
}

async function scanTarget(settings, target, explicitClient = {}) {
  const described = await adapterDescriptor(target, settings);
  const candidates = [];
  const commands = explicitClient.command
    ? [explicitClient.command]
    : (await Promise.all(described.result.commandNames.map((name) => detectLocalCommandPaths(name)))).flat();
  for (const command of [...new Set(commands)]) {
      const client = { command };
      const scanned = await runClientAdapter({
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
          __licoAdapterClient: client
        }
      });
  }
  return candidates;
}

export async function scanInstallTargets(options = {}) {
  const settings = installerOptions(options);
  const candidates = [];
  const explicitTarget = SUPPORTED_TARGETS.includes(String(options.target || "")) ? String(options.target) : "";
  if (!options["no-scan"]) {
    for (const { target } of MCP_CLIENT_TARGETS) {
      try {
        const explicitClient = explicitTarget === target && settings.clientCommand
          ? { command: settings.clientCommand }
          : {};
        for (const candidate of await scanTarget(settings, target, explicitClient)) mergeInstallCandidate(candidates, candidate);
      } catch (error) {
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
    if (candidates.some((candidate) => candidate.target === target)) continue;
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
    candidates: candidates.map((candidate) => withInstallCandidateGuidance(candidate, settings))
  };
}
