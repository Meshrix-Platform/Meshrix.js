import fs from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  queueStateMutation,
  waitForStateIdle
} from "../storage/state-coordinator.mjs";

export const CORE_MOUNT_NAMES = [];

export function normalizeModulePath(value) {
  return String(value || "").trim();
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeMountName(value = "") {
  return String(value || "").trim();
}

function normalizeMountModuleEntry(name, value) {
  const mountName = normalizeMountName(name);
  if (!mountName) {
    return null;
  }
  if (typeof value === "string") {
    const modulePath = normalizeModulePath(value);
    return modulePath ? [mountName, modulePath] : null;
  }
  if (!isPlainObject(value)) {
    return null;
  }
  const modulePath = normalizeModulePath(value.modulePath || value.path || "");
  const entry = {
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

export function normalizeMountModules(value = {}) {
  if (!isPlainObject(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([name, entry]) => normalizeMountModuleEntry(name, entry))
      .filter(Boolean)
  );
}

function normalizeRouteTarget(value = {}) {
  if (typeof value === "string") {
    const mountName = normalizeMountName(value);
    return mountName ? { mountName, action: "" } : null;
  }
  if (!isPlainObject(value)) {
    return null;
  }
  const mountName = normalizeMountName(value.mountName || value.mount || value.target || "");
  if (!mountName) {
    return null;
  }
  return {
    mountName,
    action: normalizeMountName(value.action || value.capability || "")
  };
}

function normalizeRouteMap(value = {}, { normalizeKey = (key) => key } = {}) {
  if (!isPlainObject(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, target]) => {
        const routeKey = normalizeKey(String(key || "").trim());
        const normalizedTarget = normalizeRouteTarget(target);
        return routeKey && normalizedTarget ? [routeKey, normalizedTarget] : null;
      })
      .filter(Boolean)
  );
}

export function normalizeMountRouting(value = {}) {
  return {
    kindRoutes: normalizeRouteMap(value?.kindRoutes),
    extensionRoutes: normalizeRouteMap(value?.extensionRoutes, {
      normalizeKey: (key) => key.startsWith(".") ? key.toLowerCase() : `.${key.toLowerCase()}`
    }),
    mediaTypeRoutes: normalizeRouteMap(value?.mediaTypeRoutes, {
      normalizeKey: (key) => key.toLowerCase()
    })
  };
}

export function mergeMountRouting(base = {}, patch = {}) {
  const normalizedBase = normalizeMountRouting(base);
  const normalizedPatch = normalizeMountRouting(patch);
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

export function getMountModulesConfigPath(userDataPath) {
  return path.join(userDataPath, "mount-modules.json");
}

export function getMountRoutingConfigPath(userDataPath) {
  return path.join(userDataPath, "mount-routing.json");
}

export function getMountConfigPath(userDataPath) {
  return getMountModulesConfigPath(userDataPath);
}

export function getMountConfigPaths(userDataPath) {
  return {
    modulesPath: getMountModulesConfigPath(userDataPath),
    routingPath: getMountRoutingConfigPath(userDataPath)
  };
}

function mountConfigStateKey(userDataPath) {
  return `mount-config:${path.resolve(userDataPath)}`;
}

function normalizeMountConfig(value = {}) {
  const mountModulesSource =
    value?.mountModules && typeof value.mountModules === "object" && !Array.isArray(value.mountModules)
      ? value.mountModules
      : Object.fromEntries(
          Object.entries(value || {}).filter(([key]) => key !== "mountRouting")
        );
  return {
    mountModules: normalizeMountModules(mountModulesSource),
    mountRouting: normalizeMountRouting(value.mountRouting || {})
  };
}

async function loadMountConfigUnlocked(userDataPath) {
  const { modulesPath, routingPath } = getMountConfigPaths(userDataPath);
  let mountModules = null;
  let mountRouting = null;

  try {
    const raw = await fs.readFile(modulesPath, "utf8");
    mountModules = JSON.parse(raw);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    const raw = await fs.readFile(routingPath, "utf8");
    mountRouting = JSON.parse(raw);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  return normalizeMountConfig({
    mountModules: mountModules || {},
    mountRouting: mountRouting || {}
  });
}

export async function loadMountConfig(userDataPath) {
  await waitForStateIdle(mountConfigStateKey(userDataPath));
  return loadMountConfigUnlocked(userDataPath);
}

async function saveMountConfigUnlocked(userDataPath, incomingValue = {}) {
  const { modulesPath, routingPath } = getMountConfigPaths(userDataPath);
  const current = await loadMountConfigUnlocked(userDataPath);
  const incomingMountModules =
    incomingValue?.mountModules && typeof incomingValue.mountModules === "object"
      ? incomingValue.mountModules
      : Object.fromEntries(
          Object.entries(incomingValue || {}).filter(([key]) => key !== "mountRouting")
        );
  const next = normalizeMountConfig({
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

export async function saveMountConfig(userDataPath, incomingValue = {}) {
  return queueStateMutation(mountConfigStateKey(userDataPath), () =>
    saveMountConfigUnlocked(userDataPath, incomingValue)
  );
}
