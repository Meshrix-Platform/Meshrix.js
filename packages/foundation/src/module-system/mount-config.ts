import fs from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  queueStateMutation,
  waitForStateIdle
} from "../storage/state-coordinator.ts";

export const CORE_MOUNT_NAMES: any[] = [];

export function normalizeModulePath(value?: any) : any {
  return String(value || "").trim();
}

function isPlainObject(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeMountName(value: any = "") : any {
  return String(value || "").trim();
}

function normalizeMountModuleEntry(name?: any, value?: any) : any {
  const mountName: any = normalizeMountName(name);
  if (!mountName) {
    return null;
  }
  if (typeof value === "string") {
    const modulePath: any = normalizeModulePath(value);
    return modulePath ? [mountName, modulePath] : null;
  }
  if (!isPlainObject(value)) {
    return null;
  }
  const modulePath: any = normalizeModulePath(value.modulePath || value.path || "");
  const entry: Record<string, any> = {
    id: normalizeMountName(value.id || mountName),
    kind: normalizeMountName(value.kind || mountName),
    modulePath,
    pluginId: normalizeMountName(value.pluginId || ""),
    provider: normalizeMountName(value.provider || ""),
    enabled: value.enabled !== false
  };
  if (isPlainObject(value.options)) {
    entry.options = { ...value.options };
  }
  return [mountName, entry];
}

export function normalizeMountModules(value: Record<string, any> = {}) : any {
  if (!isPlainObject(value)) {
    return {};
  }
  return Object.fromEntries(
    (Object.entries(value) as [string, any][])
      .map(([name, entry]: any[]) : any => normalizeMountModuleEntry(name, entry))
      .filter(Boolean)
  );
}

function normalizeRouteTarget(value: Record<string, any> = {}) : any {
  if (typeof value === "string") {
    const mountName: any = normalizeMountName(value);
    return mountName ? { mountName, action: "" } : null;
  }
  if (!isPlainObject(value)) {
    return null;
  }
  const mountName: any = normalizeMountName(value.mountName || value.mount || value.target || "");
  if (!mountName) {
    return null;
  }
  return {
    mountName,
    action: normalizeMountName(value.action || value.capability || "")
  };
}

function normalizeRouteMap(value: Record<string, any> = {}, { normalizeKey = (key?: any) : any => key }: Record<string, any> = {}) : any {
  if (!isPlainObject(value)) {
    return {};
  }
  return Object.fromEntries(
    (Object.entries(value) as [string, any][])
      .map(([key, target]: any[]) : any => {
        const routeKey: any = normalizeKey(String(key || "").trim());
        const normalizedTarget: any = normalizeRouteTarget(target);
        return routeKey && normalizedTarget ? [routeKey, normalizedTarget] : null;
      })
      .filter(Boolean)
  );
}

export function normalizeMountRouting(value: Record<string, any> = {}) : any {
  return {
    kindRoutes: normalizeRouteMap(value?.kindRoutes),
    extensionRoutes: normalizeRouteMap(value?.extensionRoutes, {
      normalizeKey: (key?: any) : any => key.startsWith(".") ? key.toLowerCase() : `.${key.toLowerCase()}`
    }),
    mediaTypeRoutes: normalizeRouteMap(value?.mediaTypeRoutes, {
      normalizeKey: (key?: any) : any => key.toLowerCase()
    })
  };
}

export function mergeMountRouting(base: Record<string, any> = {}, patch: Record<string, any> = {}) : any {
  const normalizedBase: any = normalizeMountRouting(base);
  const normalizedPatch: any = normalizeMountRouting(patch);
  return {
    kindRoutes: {
      ...(normalizedBase.kindRoutes || {}),
      ...(normalizedPatch.kindRoutes || {})
    },
    extensionRoutes: {
      ...(normalizedBase.extensionRoutes || {}),
      ...(normalizedPatch.extensionRoutes || {})
    },
    mediaTypeRoutes: {
      ...(normalizedBase.mediaTypeRoutes || {}),
      ...(normalizedPatch.mediaTypeRoutes || {})
    }
  };
}

export function getMountModulesConfigPath(userDataPath?: any) : any {
  return path.join(userDataPath, "mount-modules.json");
}

export function getMountRoutingConfigPath(userDataPath?: any) : any {
  return path.join(userDataPath, "mount-routing.json");
}

export function getMountConfigPath(userDataPath?: any) : any {
  return getMountModulesConfigPath(userDataPath);
}

export function getMountConfigPaths(userDataPath?: any) : any {
  return {
    modulesPath: getMountModulesConfigPath(userDataPath),
    routingPath: getMountRoutingConfigPath(userDataPath)
  };
}

function mountConfigStateKey(userDataPath?: any) : any {
  return `mount-config:${path.resolve(userDataPath)}`;
}

function normalizeMountConfig(value: Record<string, any> = {}) : any {
  const mountModulesSource: any =
    value?.mountModules && typeof value.mountModules === "object" && !Array.isArray(value.mountModules)
      ? value.mountModules
      : Object.fromEntries(
          (Object.entries(value || {}) as [string, any][]).filter(([key]: any[]) : any => key !== "mountRouting")
        );
  return {
    mountModules: normalizeMountModules(mountModulesSource),
    mountRouting: normalizeMountRouting(value.mountRouting || {})
  };
}

async function loadMountConfigUnlocked(userDataPath?: any) : Promise<any> {
  const { modulesPath, routingPath } = getMountConfigPaths(userDataPath);
  let mountModules: any = null;
  let mountRouting: any = null;

  try {
    const raw: any = await fs.readFile(modulesPath, "utf8");
    mountModules = JSON.parse(raw);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    const raw: any = await fs.readFile(routingPath, "utf8");
    mountRouting = JSON.parse(raw);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  return normalizeMountConfig({
    mountModules: mountModules || {},
    mountRouting: mountRouting || {}
  });
}

export async function loadMountConfig(userDataPath?: any) : Promise<any> {
  await waitForStateIdle(mountConfigStateKey(userDataPath));
  return loadMountConfigUnlocked(userDataPath);
}

async function saveMountConfigUnlocked(userDataPath?: any, incomingValue: Record<string, any> = {}) : Promise<any> {
  const { modulesPath, routingPath } = getMountConfigPaths(userDataPath);
  const current: any = await loadMountConfigUnlocked(userDataPath);
  const incomingMountModules: any =
    incomingValue?.mountModules && typeof incomingValue.mountModules === "object"
      ? incomingValue.mountModules
      : Object.fromEntries(
          (Object.entries(incomingValue || {}) as [string, any][]).filter(([key]: any[]) : any => key !== "mountRouting")
        );
  const next: any = normalizeMountConfig({
    ...current,
    ...(incomingValue || {}),
    mountModules: {
      ...(current.mountModules || {}),
      ...(incomingMountModules || {})
    },
    mountRouting: mergeMountRouting(
      current.mountRouting || {},
      (incomingValue && incomingValue.mountRouting) || {}
    )
  });

  await atomicWriteJson(modulesPath, next.mountModules, { trailingNewline: false });
  await atomicWriteJson(routingPath, next.mountRouting, { trailingNewline: false });
  return next;
}

export async function saveMountConfig(userDataPath?: any, incomingValue: Record<string, any> = {}) : Promise<any> {
  return queueStateMutation(mountConfigStateKey(userDataPath), () : any =>
    saveMountConfigUnlocked(userDataPath, incomingValue)
  );
}
