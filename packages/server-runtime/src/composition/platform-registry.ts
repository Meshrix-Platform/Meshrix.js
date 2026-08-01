const COMMON_PLATFORMS: any = new Set<any>([
  "core",
  "security",
  "module-management",
  "data-structure-substrate",
  "operation-proof-substrate",
  "storage",
  "devops",
  "state-machine"
]);
const PLATFORM_LAYERS: Readonly<Record<string, any>> = Object.freeze({
  COMMON: "common"
});

function normalizeId(value?: any, label?: any) : any {
  const normalized: any = String(value || "").trim();
  if (!normalized) {
    throw new Error(`Platform registry ${label} is required.`);
  }
  return normalized;
}

export function createPlatformRegistry({ scope = "server" }: Record<string, any> = {}) : any {
  const entries: any = new Map<any, any>();

  function layerForPlatform(platform?: any) : any {
    if (COMMON_PLATFORMS.has(platform)) {
      return PLATFORM_LAYERS.COMMON;
    }
    throw new Error(`Platform interactive registry only accepts bottom platform interfaces: ${platform}`);
  }

  function register(entry: Record<string, any> = {}) : any {
    const platform: any = normalizeId(entry.platform, "platform");
    const id: any = normalizeId(entry.id, "id");
    const layer: any = entry.layer ? normalizeId(entry.layer, "layer") : layerForPlatform(platform);
    if (layer !== layerForPlatform(platform)) {
      throw new Error(`Platform interface ${id} has inconsistent layer ${layer} for platform ${platform}`);
    }
    if (entries.has(id)) {
      throw new Error(`Duplicate platform registration: ${id}`);
    }
    const record: Readonly<Record<string, any>> = Object.freeze({
      id,
      platform,
      layer,
      label: String(entry.label || id),
      kind: String(entry.kind || "service"),
      ownerFeatureId: String(entry.ownerFeatureId || `${platform}-platform`),
      public: entry.public !== false,
      value: entry.value,
      metadata: Object.freeze({ ...(entry.metadata || {}) })
    });
    entries.set(id, record);
    return record;
  }

  function get(id?: any) : any {
    return entries.get(String(id || "").trim()) || null;
  }

  function unregisterOwner(ownerFeatureId?: any) : any {
    const owner: any = String(ownerFeatureId || "").trim();
    if (!owner) throw new TypeError("Platform registry owner id is required.");
    let removed: any = 0;
    for (const [id, entry] of entries) {
      if (entry.ownerFeatureId !== owner) continue;
      entries.delete(id);
      removed += 1;
    }
    return Object.freeze({ ok: true, ownerFeatureId: owner, removed });
  }

  function unregister(id?: any) : any {
    const key: any = String(id || "").trim();
    return Object.freeze({ ok: true, id: key, removed: entries.delete(key) });
  }

  function prepareUnregisterOwner(ownerFeatureId?: any) : any {
    const owner: any = String(ownerFeatureId || "").trim();
    const snapshot: any = [...entries.values()].filter((entry?: any) : any => entry.ownerFeatureId === owner);
    let committed: any = false;
    return Object.freeze({
      commit() : any {
        if (!committed) unregisterOwner(owner);
        committed = true;
      },
      rollback() : any {
        if (!committed) return;
        for (const entry of snapshot) entries.set(entry.id, entry);
        committed = false;
      }
    });
  }

  function requireInterface(id?: any) : any {
    const record: any = get(id);
    if (!record) {
      throw new Error(`Missing platform registration: ${id}`);
    }
    return record;
  }

  async function callInterface(id: any, ...args: any[]) : Promise<any> {
    const record: any = requireInterface(id);
    if (typeof record.value === "function") {
      return record.value(...args);
    }
    if (record.value && typeof record.value.handle === "function") {
      return record.value.handle(...args);
    }
    throw new Error(`Platform interface is not callable: ${id}`);
  }

  function list({ platform = "", layer = "" }: Record<string, any> = {}) : any {
    return [...entries.values()]
      .filter((entry?: any) : any => !platform || entry.platform === platform)
      .filter((entry?: any) : any => !layer || entry.layer === layer)
      .map((entry?: any) : any => ({
        id: entry.id,
        platform: entry.platform,
        layer: entry.layer,
        label: entry.label,
        kind: entry.kind,
        ownerFeatureId: entry.ownerFeatureId,
        public: entry.public,
        metadata: entry.metadata
      }));
  }

  return Object.freeze({
    scope: String(scope || "server"),
    register,
    get,
    unregister,
    unregisterOwner,
    prepareUnregisterOwner,
    require: requireInterface,
    requireInterface,
    callInterface,
    list
  });
}

export function registerPlatformService(registry?: any, entry?: any) : any {
  if (!registry || typeof registry.register !== "function") {
    throw new Error("A PlatformRegistry instance is required.");
  }
  return registry.register(entry);
}

export function requirePlatformInterface(registry?: any, id?: any) : any {
  if (!registry || typeof registry.requireInterface !== "function") {
    throw new Error("A PlatformInteractiveRegistry instance is required.");
  }
  return registry.requireInterface(id);
}

export function callPlatformInterface(registry: any, id: any, ...args: any[]) : any {
  if (!registry || typeof registry.callInterface !== "function") {
    throw new Error("A PlatformInteractiveRegistry instance is required.");
  }
  return registry.callInterface(id, ...args);
}
