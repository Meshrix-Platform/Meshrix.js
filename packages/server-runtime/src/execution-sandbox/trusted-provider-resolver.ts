import {
  controlledRef,
  sandboxDigest,
  SANDBOX_PROVIDER_CONFORMANCE_SCHEMA
} from "#meshrix/foundation/execution-sandbox/contracts";

const PROVIDER_ORDER: any = new Map<any, any>([
  ["rootless-podman", 0],
  ["podman", 1],
  ["rootless-docker", 2],
  ["docker", 3],
  ["registered-container", 4],
  ["registered-vm", 5]
]);

const REQUIRED_RESTRICTIONS: readonly any[] = Object.freeze([
  "filesystem",
  "process",
  "network",
  "environment",
  "credentials",
  "resources",
  "output",
  "cleanup",
  "cross-trust-domain"
]);

function text(value?: any) : any {
  return String(value || "").trim();
}

function receiptPayload(receipt: Record<string, any> = {}) : any {
  return Object.freeze({
    schemaVersion: text(receipt.schemaVersion),
    providerId: text(receipt.providerId),
    providerClass: text(receipt.providerClass),
    status: text(receipt.status),
    policyRevision: text(receipt.policyRevision),
    receiptRequirement: text(receipt.receiptRequirement),
    runtimeProfile: text(receipt.runtimeProfile),
    isolationClass: text(receipt.isolationClass),
    serviceIdentityRef: text(receipt.serviceIdentityRef),
    executableIdentityDigest: text(receipt.executableIdentityDigest),
    checkDigest: text(receipt.checkDigest),
    generatedAt: text(receipt.generatedAt),
    expiresAt: text(receipt.expiresAt)
  });
}

export function createSandboxProviderConformanceReceipt(fields: Record<string, any> = {}) : any {
  const payload: any = receiptPayload(fields);
  return Object.freeze({ ...payload, digest: sandboxDigest(payload) });
}

function adapterCatalog(adapters: any = []) : any {
  const catalog: any = new Map<any, any>();
  for (const adapter of Array.isArray(adapters) ? adapters : []) {
    const id: any = text(adapter?.id);
    const providerClass: any = text(adapter?.providerClass);
    if (
      !id ||
      catalog.has(id) ||
      !PROVIDER_ORDER.has(providerClass) ||
      typeof adapter?.probe !== "function" ||
      typeof adapter?.createBackend !== "function"
    ) {
      throw new TypeError("Trusted sandbox provider adapters must have unique governed identities.");
    }
    catalog.set(id, Object.freeze({ ...adapter, id, providerClass }));
  }
  return catalog;
}

function normalizedConfiguration(configuration?: any) : any {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return { state: "unconfigured" };
  }
  if (configuration.enabled !== true) return { state: "disabled" };
  const providerMode: any = text(configuration.providerMode);
  const providerId: any = text(configuration.providerId);
  const profileId: any = text(configuration.profileId);
  const policyRevision: any = text(configuration.policyRevision);
  const receiptRequirement: any = text(configuration.receiptRequirement);
  const allowedProviderClasses: any = Array.isArray(configuration.allowedProviderClasses)
    ? [...new Set<any>(configuration.allowedProviderClasses.map(text).filter((value?: any) : any => PROVIDER_ORDER.has(value)))]
    : [];
  if (
    !["automatic", "explicit"].includes(providerMode) ||
    (providerMode === "explicit" && !providerId) ||
    (providerMode === "automatic" && providerId) ||
    !profileId ||
    !policyRevision ||
    !receiptRequirement ||
    allowedProviderClasses.length === 0
  ) {
    return { state: "invalid" };
  }
  return {
    state: "configured",
    providerMode,
    providerId,
    profileId,
    policyRevision,
    receiptRequirement,
    allowedProviderClasses
  };
}

function conformanceState(descriptor?: any, configuration?: any, now?: any) : any {
  const receipt: any = descriptor?.conformanceReceipt;
  const restrictions: any = new Set<any>(Array.isArray(descriptor?.enforcedRestrictions)
    ? descriptor.enforcedRestrictions.map(text)
    : []);
  if (descriptor?.healthy !== true) {
    return { conforming: false, reason: "sandbox_backend_unhealthy" };
  }
  if (
    descriptor?.production !== true ||
    !text(descriptor?.isolationClass) ||
    !text(descriptor?.serviceIdentityRef) ||
    !/^[a-f0-9]{64}$/u.test(text(descriptor?.executableIdentityDigest)) ||
    REQUIRED_RESTRICTIONS.some((restriction?: any) : any => !restrictions.has(restriction))
  ) return { conforming: false, reason: "sandbox_policy_unsupported" };
  if (
    !receipt ||
    receipt.status !== "passed" ||
    text(receipt.schemaVersion) !== SANDBOX_PROVIDER_CONFORMANCE_SCHEMA ||
    text(receipt.providerId) !== text(descriptor?.id) ||
    text(receipt.providerClass) !== text(descriptor?.providerClass) ||
    text(receipt.policyRevision) !== configuration.policyRevision ||
    text(receipt.receiptRequirement) !== configuration.receiptRequirement ||
    text(receipt.runtimeProfile) !== configuration.profileId ||
    text(receipt.isolationClass) !== text(descriptor?.isolationClass) ||
    text(receipt.serviceIdentityRef) !== text(descriptor?.serviceIdentityRef) ||
    text(receipt.executableIdentityDigest) !== text(descriptor?.executableIdentityDigest) ||
    !/^[a-f0-9]{64}$/u.test(text(receipt.checkDigest)) ||
    !/^[a-f0-9]{64}$/u.test(text(receipt.executableIdentityDigest)) ||
    !/^[a-f0-9]{64}$/u.test(text(receipt.digest)) ||
    text(receipt.digest) !== sandboxDigest(receiptPayload(receipt)) ||
    !Number.isFinite(Date.parse(receipt.generatedAt)) ||
    !Number.isFinite(Date.parse(receipt.expiresAt)) ||
    Date.parse(receipt.generatedAt) > now.getTime() ||
    Date.parse(receipt.expiresAt) <= Date.parse(receipt.generatedAt) ||
    Date.parse(receipt.expiresAt) <= now.getTime()
  ) return { conforming: false, reason: "sandbox_policy_unsupported" };
  return { conforming: true, reason: "ready" };
}

function publicProjection(state?: any) : any {
  return Object.freeze({ sandboxAvailable: state.state === "ready" });
}

function administrativeProjection(state?: any) : any {
  return Object.freeze({
    state: state.state,
    reasonCode: state.reasonCode || "",
    providerClass: state.providerClass || "",
    isolationClass: state.isolationClass || "",
    enforceableCapabilities: Object.freeze([...(state.enforceableCapabilities || [])]),
    policyRevision: state.policyRevision || "",
    providerRef: state.providerRef || "",
    receiptRef: state.receiptRef || ""
  });
}

export function createTrustedSandboxProviderResolver({
  configuration = null,
  adapters = [],
  now = () : any => new Date(),
  ttlMs = 5_000
}: Record<string, any> = {}) : any {
  const catalog: any = adapterCatalog(adapters);
  const configured: any = normalizedConfiguration(configuration);
  const boundedTtl: any = Number.isSafeInteger(Number(ttlMs)) && Number(ttlMs) > 0
    ? Math.min(Number(ttlMs), 60_000)
    : 5_000;
  let generation: any = 0;
  let expiresAt: any = 0;
  let refreshPromise: any = null;
  let quarantined: any = false;
  let selected: any = null;
  let state: any = configured.state !== "configured"
    ? { state: configured.state }
    : { state: "unavailable" };

  function expireCachedSelection() : any {
    if (state.state !== "ready") return;
    const currentTime: any = now().getTime();
    if (!Number.isFinite(currentTime) || currentTime >= expiresAt) {
      selected = null;
      expiresAt = 0;
      state = { state: "unavailable", reasonCode: "sandbox_provider_selection_stale" };
    }
  }

  async function refresh({ force = false }: Record<string, any> = {}) : Promise<any> {
    if (quarantined) return state;
    if (configured.state !== "configured") return state;
    if (!force && now().getTime() < expiresAt) return state;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () : Promise<any> => {
      state = { state: "probing" };
      const candidates: any[] = [];
      let observed: any = 0;
      let reasonCode: any = "sandbox_backend_missing";
      for (const adapter of catalog.values()) {
        if (!configured.allowedProviderClasses.includes(adapter.providerClass)) continue;
        if (configured.providerMode === "explicit" && configured.providerId !== adapter.id) continue;
        observed += 1;
        let descriptor: any;
        try {
          descriptor = await adapter.probe();
        } catch {
          continue;
        }
        if (
          text(descriptor?.id) !== adapter.id ||
          text(descriptor?.providerClass) !== adapter.providerClass
        ) continue;
        const conformance: any = conformanceState(descriptor, configured, now());
        if (!conformance.conforming) {
          if (
            reasonCode === "sandbox_backend_missing" ||
            conformance.reason === "sandbox_backend_unhealthy"
          ) reasonCode = conformance.reason;
          continue;
        }
        candidates.push({ adapter, descriptor });
      }
      candidates.sort((left?: any, right?: any) : any => {
        const rank: any = PROVIDER_ORDER.get(left.adapter.providerClass) -
          PROVIDER_ORDER.get(right.adapter.providerClass);
        return rank || left.adapter.id.localeCompare(right.adapter.id);
      });
      const winner: any = candidates[0] || null;
      if (!winner) {
        selected = null;
        expiresAt = now().getTime() + boundedTtl;
        state = {
          state: observed > 0 ? "degraded" : "unavailable",
          reasonCode
        };
        return state;
      }
      const backend: any = await winner.adapter.createBackend(winner.descriptor);
      if (!backend || typeof backend.run !== "function" || typeof backend.cleanup !== "function") {
        selected = null;
        expiresAt = now().getTime() + boundedTtl;
        state = { state: "degraded" };
        return state;
      }
      const receipt: any = winner.descriptor.conformanceReceipt;
      selected = Object.freeze({ backend, descriptor: Object.freeze({ ...winner.descriptor }) });
      expiresAt = Math.min(
        now().getTime() + boundedTtl,
        Date.parse(receipt.expiresAt)
      );
      generation += 1;
      state = {
        state: "ready",
        generation,
        providerClass: winner.adapter.providerClass,
        isolationClass: text(winner.descriptor.isolationClass),
        enforceableCapabilities: [...new Set<any>(winner.descriptor.enforcedRestrictions.map(text))].sort(),
        policyRevision: configured.policyRevision,
        providerRef: controlledRef(winner.adapter.id, "sandbox-provider"),
        receiptRef: controlledRef(sandboxDigest({
          schemaVersion: receipt.schemaVersion,
          digest: receipt.digest
        }), "sandbox-conformance-receipt"),
        fingerprint: sandboxDigest({
          providerRef: controlledRef(winner.adapter.id, "sandbox-provider"),
          serviceIdentityRef: text(winner.descriptor.serviceIdentityRef),
          restrictions: winner.descriptor.enforcedRestrictions,
          policyRevision: configured.policyRevision,
          receiptDigest: receipt.digest,
          expiresAt: receipt.expiresAt
        })
      };
      return state;
    })().finally(() : any => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  async function resolve() : Promise<any> {
    await refresh();
    if (state.state === "ready" && selected) {
      return Object.freeze({ ...selected, generation: state.generation });
    }
    if (state.state === "degraded" && state.reasonCode) {
      throw Object.assign(new Error("No conforming sandbox provider is ready."), {
        code: state.reasonCode
      });
    }
    return null;
  }

  function validate(resolution?: any) : any {
    expireCachedSelection();
    return state.state === "ready" && selected !== null &&
      resolution?.generation === state.generation &&
      resolution?.backend === selected.backend &&
      resolution?.descriptor === selected.descriptor;
  }

  function invalidate() : any {
    selected = null;
    expiresAt = 0;
    if (!quarantined) state = configured.state === "configured"
      ? { state: "unavailable" }
      : { state: configured.state };
  }

  function quarantine() : any {
    selected = null;
    expiresAt = 0;
    quarantined = true;
    state = { state: "quarantined" };
  }

  async function close() : Promise<any> {
    quarantined = true;
    const current: any = selected;
    selected = null;
    state = { state: "quarantined" };
    await current?.backend?.close?.();
  }

  return Object.freeze({
    refresh,
    resolve,
    validate,
    invalidate,
    quarantine,
    publicProjection: () : any => {
      expireCachedSelection();
      return publicProjection(state);
    },
    administrativeProjection: () : any => {
      expireCachedSelection();
      return administrativeProjection(state);
    },
    close,
    requiredRestrictions: REQUIRED_RESTRICTIONS
  });
}

export { REQUIRED_RESTRICTIONS as REQUIRED_SANDBOX_PROVIDER_RESTRICTIONS };
