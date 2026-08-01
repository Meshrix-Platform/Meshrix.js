import fs from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  queueStateMutation,
  waitForStateIdle
} from "../state/state-coordinator.ts";
import { buildBootstrapPayload } from "@meshrix/protocols/http/bootstrap-payload";

const DEFAULT_DISCOVERY_CONFIG: Record<string, any> = {
  serverId: "",
  serverLabel: "",
  bootstrapBaseUrl: "",
  advertisedBaseUrl: "",
  activeServiceUrl: "",
  forwardBaseUrl: "",
  mode: "",
  configVersion: "",
  refreshIntervalSeconds: 0,
  checkInIntervalSeconds: 0,
  offlineAfterSeconds: 0
};

export function getDiscoveryConfigPath(userDataPath?: any) : any {
  return path.join(userDataPath, "discovery.json");
}

function discoveryStateKey(userDataPath?: any) : any {
  return `discovery:${path.resolve(userDataPath)}`;
}

function normalizeBaseUrl(value?: any) : any {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizePositiveInteger(value?: any, fallback?: any) : any {
  const parsed: any = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function normalizeMode(value?: any) : any {
  return ["active", "forward"].includes(String(value || "").trim())
    ? String(value).trim()
    : "";
}

function normalizeDiscoveryConfig(config: Record<string, any> = {}, context: Record<string, any> = {}) : any {
  const advertisedBaseUrl: any = normalizeBaseUrl(config.advertisedBaseUrl);
  const bootstrapBaseUrl: any = normalizeBaseUrl(config.bootstrapBaseUrl);
  const activeServiceUrl: any = normalizeBaseUrl(config.activeServiceUrl);
  const forwardBaseUrl: any = normalizeBaseUrl(config.forwardBaseUrl);
  const mode: any = normalizeMode(config.mode);

  return {
    serverId: String(config.serverId || context.serverId || "").trim(),
    serverLabel: String(config.serverLabel || context.serverLabel || "").trim(),
    bootstrapBaseUrl,
    advertisedBaseUrl,
    activeServiceUrl,
    forwardBaseUrl,
    mode,
    configVersion: String(
      config.configVersion || context.configVersion || ""
    ).trim(),
    refreshIntervalSeconds: normalizePositiveInteger(
      config.refreshIntervalSeconds,
      DEFAULT_DISCOVERY_CONFIG.refreshIntervalSeconds
    ),
    checkInIntervalSeconds: normalizePositiveInteger(
      config.checkInIntervalSeconds,
      DEFAULT_DISCOVERY_CONFIG.checkInIntervalSeconds
    ),
    offlineAfterSeconds: normalizePositiveInteger(
      config.offlineAfterSeconds,
      DEFAULT_DISCOVERY_CONFIG.offlineAfterSeconds
    )
  };
}

async function loadDiscoveryConfigUnlocked(userDataPath?: any) : Promise<any> {
  const configPath: any = getDiscoveryConfigPath(userDataPath);

  try {
    const content: any = await fs.readFile(configPath, "utf8");
    const parsed: any = JSON.parse(content);
    return normalizeDiscoveryConfig(parsed);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return normalizeDiscoveryConfig();
  }
}

export async function loadDiscoveryConfig(userDataPath?: any) : Promise<any> {
  await waitForStateIdle(discoveryStateKey(userDataPath));
  return loadDiscoveryConfigUnlocked(userDataPath);
}

async function saveDiscoveryConfigUnlocked(userDataPath?: any, incomingConfig?: any, context: Record<string, any> = {}) : Promise<any> {
  const configPath: any = getDiscoveryConfigPath(userDataPath);
  const current: any = await loadDiscoveryConfigUnlocked(userDataPath);
  const merged: any = normalizeDiscoveryConfig(
    {
      ...current,
      ...(incomingConfig || {})
    },
    context
  );

  await atomicWriteJson(configPath, merged, { trailingNewline: false });
  return merged;
}

export async function saveDiscoveryConfig(userDataPath?: any, incomingConfig?: any, context: Record<string, any> = {}) : Promise<any> {
  return queueStateMutation(discoveryStateKey(userDataPath), () : any =>
    saveDiscoveryConfigUnlocked(userDataPath, incomingConfig, context)
  );
}

export async function resolveDiscoveryState(userDataPath?: any, context: Record<string, any> = {}) : Promise<any> {
  const saved: any = await loadDiscoveryConfig(userDataPath);
  return normalizeDiscoveryConfig(
    {
      ...saved,
      ...(context.overrides || {})
    },
    context
  );
}

export { buildBootstrapPayload };
