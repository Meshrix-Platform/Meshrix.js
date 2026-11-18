import {
  controlledRef,
  sandboxDigest,
  SANDBOX_PROVIDER_CONFORMANCE_SCHEMA
} from "#meshrix/foundation/execution-sandbox/contracts";

const PROVIDER_ORDER = new Map<string, number>([
  ["rootless-podman", 0], ["podman", 1], ["rootless-docker", 2], ["docker", 3],
  ["registered-container", 4], ["registered-vm", 5]
]);

const REQUIRED_RESTRICTIONS = Object.freeze([
  "filesystem", "process", "network", "environment", "credentials", "resources",
  "output", "cleanup", "cross-trust-domain"
]);

interface ProviderReceipt {
  schemaVersion: string;
  providerId: string;
  providerClass: string;
  status: string;
  policyRevision: string;
  receiptRequirement: string;
  runtimeProfile: string;
  isolationClass: string;
  serviceIdentityRef: string;
  executableIdentityDigest: string;
  checkDigest: string;
  generatedAt: string;
  expiresAt: string;
  digest: string;
}
interface ProviderDescriptor {
  id: string;
  providerClass: string;
  healthy?: boolean;
  production?: boolean;
  isolationClass?: string;
  serviceIdentityRef?: string;
  executableIdentityDigest?: string;
  enforcedRestrictions?: readonly string[];
  conformanceReceipt?: Partial<ProviderReceipt> | null;
}
interface SandboxBackend {
  run(...args: unknown[]): Promise<unknown>;
  cleanup(...args: unknown[]): Promise<unknown>;
  close?(): Promise<void>;
}
interface ProviderAdapter {
  id: string;
  providerClass: string;
  probe(): Promise<ProviderDescriptor>;
  createBackend(descriptor: ProviderDescriptor): Promise<unknown>;
}
interface ResolverConfiguration {
  enabled?: boolean;
  providerMode?: string;
  providerId?: string;
  profileId?: string;
  policyRevision?: string;
  receiptRequirement?: string;
  allowedProviderClasses?: string[];
}
interface ConfiguredProvider {
  state: "configured";
  providerMode: "automatic" | "explicit";
  providerId: string;
  profileId: string;
  policyRevision: string;
  receiptRequirement: string;
  allowedProviderClasses: string[];
}
type NormalizedConfiguration = ConfiguredProvider | { state: "unconfigured" | "disabled" | "invalid" };
interface ResolverState {
  state: string;
  reasonCode?: string;
  generation?: number;
  providerClass?: string;
  isolationClass?: string;
  enforceableCapabilities?: string[];
  policyRevision?: string;
  providerRef?: string;
  receiptRef?: string;
  fingerprint?: string;
}
interface SelectedProvider { backend: SandboxBackend; descriptor: ProviderDescriptor }
interface ProviderResolution extends SelectedProvider { generation: number }
interface ResolverOptions {
  configuration?: ResolverConfiguration | null;
  adapters?: readonly ProviderAdapter[];
  now?: () => Date;
  ttlMs?: number;
}

function text(value: unknown): string { return String(value || "").trim(); }
function sandboxBackend(value: unknown): value is SandboxBackend {
  return value !== null && typeof value === "object" &&
    typeof (value as { run?: unknown }).run === "function" &&
    typeof (value as { cleanup?: unknown }).cleanup === "function";
}
function receiptPayload(receipt: Partial<ProviderReceipt>) {
  return Object.freeze({
    schemaVersion: text(receipt.schemaVersion), providerId: text(receipt.providerId),
    providerClass: text(receipt.providerClass), status: text(receipt.status),
    policyRevision: text(receipt.policyRevision), receiptRequirement: text(receipt.receiptRequirement),
    runtimeProfile: text(receipt.runtimeProfile), isolationClass: text(receipt.isolationClass),
    serviceIdentityRef: text(receipt.serviceIdentityRef), executableIdentityDigest: text(receipt.executableIdentityDigest),
    checkDigest: text(receipt.checkDigest), generatedAt: text(receipt.generatedAt), expiresAt: text(receipt.expiresAt)
  });
}

export function createSandboxProviderConformanceReceipt(fields: Partial<ProviderReceipt> = {}) {
  const payload = receiptPayload(fields);
  return Object.freeze({ ...payload, digest: sandboxDigest(payload) });
}

function adapterCatalog(adapters: readonly ProviderAdapter[]): Map<string, ProviderAdapter> {
  const catalog = new Map<string, ProviderAdapter>();
  for (const adapter of adapters) {
    if (!adapter.id || catalog.has(adapter.id) || !PROVIDER_ORDER.has(adapter.providerClass) ||
        typeof adapter.probe !== "function" || typeof adapter.createBackend !== "function") {
      throw new TypeError("Trusted sandbox provider adapters must have unique governed identities.");
    }
    catalog.set(adapter.id, Object.freeze({ ...adapter }));
  }
  return catalog;
}

function normalizedConfiguration(configuration?: ResolverConfiguration | null): NormalizedConfiguration {
  if (!configuration) return { state: "unconfigured" };
  if (configuration.enabled !== true) return { state: "disabled" };
  const providerMode = text(configuration.providerMode);
  const providerId = text(configuration.providerId);
  const profileId = text(configuration.profileId);
  const policyRevision = text(configuration.policyRevision);
  const receiptRequirement = text(configuration.receiptRequirement);
  const allowedProviderClasses = [...new Set(
    (configuration.allowedProviderClasses ?? []).map(text).filter((value) => PROVIDER_ORDER.has(value))
  )];
  if ((providerMode !== "automatic" && providerMode !== "explicit") ||
      (providerMode === "explicit" && !providerId) || (providerMode === "automatic" && providerId !== "") ||
      !profileId || !policyRevision || !receiptRequirement || allowedProviderClasses.length === 0) {
    return { state: "invalid" };
  }
  return { state: "configured", providerMode, providerId, profileId, policyRevision, receiptRequirement, allowedProviderClasses };
}

function conformanceState(descriptor: ProviderDescriptor, configuration: ConfiguredProvider, now: Date) {
  const receipt = descriptor.conformanceReceipt;
  const restrictions = new Set((descriptor.enforcedRestrictions || []).map(text));
  if (!descriptor.healthy) return { conforming: false, reason: "sandbox_backend_unhealthy" };
  if (!descriptor.production || !text(descriptor.isolationClass) || !text(descriptor.serviceIdentityRef) ||
      !/^[a-f0-9]{64}$/u.test(text(descriptor.executableIdentityDigest)) ||
      REQUIRED_RESTRICTIONS.some((restriction) => !restrictions.has(restriction))) {
    return { conforming: false, reason: "sandbox_policy_unsupported" };
  }
  if (!receipt || receipt.status !== "passed" || receipt.schemaVersion !== SANDBOX_PROVIDER_CONFORMANCE_SCHEMA ||
      receipt.providerId !== descriptor.id || receipt.providerClass !== descriptor.providerClass ||
      receipt.policyRevision !== configuration.policyRevision || receipt.receiptRequirement !== configuration.receiptRequirement ||
      receipt.runtimeProfile !== configuration.profileId || receipt.isolationClass !== descriptor.isolationClass ||
      receipt.serviceIdentityRef !== descriptor.serviceIdentityRef || receipt.executableIdentityDigest !== descriptor.executableIdentityDigest ||
      !/^[a-f0-9]{64}$/u.test(text(receipt.checkDigest)) || !/^[a-f0-9]{64}$/u.test(text(receipt.digest)) ||
      receipt.digest !== sandboxDigest(receiptPayload(receipt)) || !Number.isFinite(Date.parse(text(receipt.generatedAt))) ||
      !Number.isFinite(Date.parse(text(receipt.expiresAt))) || Date.parse(text(receipt.generatedAt)) > now.getTime() ||
      Date.parse(text(receipt.expiresAt)) <= Date.parse(text(receipt.generatedAt)) || Date.parse(text(receipt.expiresAt)) <= now.getTime()) {
    return { conforming: false, reason: "sandbox_policy_unsupported" };
  }
  return { conforming: true, reason: "ready" };
}

function publicProjection(state: ResolverState) { return Object.freeze({ sandboxAvailable: state.state === "ready" }); }
function administrativeProjection(state: ResolverState) {
  return Object.freeze({
    state: state.state, reasonCode: state.reasonCode || "", providerClass: state.providerClass || "",
    isolationClass: state.isolationClass || "", enforceableCapabilities: Object.freeze([...(state.enforceableCapabilities || [])]),
    policyRevision: state.policyRevision || "", providerRef: state.providerRef || "", receiptRef: state.receiptRef || ""
  });
}

export function createTrustedSandboxProviderResolver({
  configuration = null, adapters = [], now = () => new Date(), ttlMs = 5_000
}: ResolverOptions = {}) {
  const catalog = adapterCatalog(adapters);
  const configured = normalizedConfiguration(configuration);
  const boundedTtl = Number.isSafeInteger(ttlMs) && ttlMs > 0 ? Math.min(ttlMs, 60_000) : 5_000;
  let generation = 0;
  let expiresAt = 0;
  let refreshPromise: Promise<ResolverState> | null = null;
  let quarantined = false;
  let selected: SelectedProvider | null = null;
  let state: ResolverState = configured.state !== "configured" ? { state: configured.state } : { state: "unavailable" };

  function expireCachedSelection(): void {
    if (state.state !== "ready") return;
    const currentTime = now().getTime();
    if (!Number.isFinite(currentTime) || currentTime >= expiresAt) {
      selected = null; expiresAt = 0;
      state = { state: "unavailable", reasonCode: "sandbox_provider_selection_stale" };
    }
  }

  async function refresh({ force = false }: { force?: boolean } = {}): Promise<ResolverState> {
    if (quarantined || configured.state !== "configured") return state;
    if (!force && now().getTime() < expiresAt) return state;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      state = { state: "probing" };
      const candidates: Array<{ adapter: ProviderAdapter; descriptor: ProviderDescriptor }> = [];
      let observed = 0;
      let reasonCode = "sandbox_backend_missing";
      for (const adapter of catalog.values()) {
        if (!configured.allowedProviderClasses.includes(adapter.providerClass) ||
            (configured.providerMode === "explicit" && configured.providerId !== adapter.id)) continue;
        observed += 1;
        let descriptor: ProviderDescriptor;
        try { descriptor = await adapter.probe(); } catch { continue; }
        if (descriptor.id !== adapter.id || descriptor.providerClass !== adapter.providerClass) continue;
        const conformance = conformanceState(descriptor, configured, now());
        if (!conformance.conforming) {
          if (reasonCode === "sandbox_backend_missing" || conformance.reason === "sandbox_backend_unhealthy") reasonCode = conformance.reason;
          continue;
        }
        candidates.push({ adapter, descriptor });
      }
      candidates.sort((left, right) =>
        (PROVIDER_ORDER.get(left.adapter.providerClass) ?? 99) - (PROVIDER_ORDER.get(right.adapter.providerClass) ?? 99) ||
        left.adapter.id.localeCompare(right.adapter.id));
      const winner = candidates[0];
      if (!winner) {
        selected = null; expiresAt = now().getTime() + boundedTtl;
        return state = { state: observed > 0 ? "degraded" : "unavailable", reasonCode };
      }
      const backend = await winner.adapter.createBackend(winner.descriptor);
      if (!sandboxBackend(backend)) return state = { state: "degraded" };
      const receipt = winner.descriptor.conformanceReceipt;
      if (!receipt) return state = { state: "degraded" };
      selected = Object.freeze({ backend, descriptor: Object.freeze({ ...winner.descriptor }) });
      expiresAt = Math.min(now().getTime() + boundedTtl, Date.parse(text(receipt.expiresAt)));
      generation += 1;
      return state = {
        state: "ready", generation, providerClass: winner.adapter.providerClass,
        isolationClass: winner.descriptor.isolationClass,
        enforceableCapabilities: [...new Set((winner.descriptor.enforcedRestrictions || []).map(text))].sort(),
        policyRevision: configured.policyRevision,
        providerRef: controlledRef(winner.adapter.id, "sandbox-provider"),
        receiptRef: controlledRef(sandboxDigest({ schemaVersion: text(receipt.schemaVersion), digest: text(receipt.digest) }), "sandbox-conformance-receipt"),
        fingerprint: sandboxDigest({
          providerRef: controlledRef(winner.adapter.id, "sandbox-provider"),
          serviceIdentityRef: winner.descriptor.serviceIdentityRef,
          restrictions: winner.descriptor.enforcedRestrictions,
          policyRevision: configured.policyRevision,
          receiptDigest: receipt.digest,
          expiresAt: receipt.expiresAt
        })
      };
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function resolve(): Promise<Readonly<ProviderResolution> | null> {
    await refresh();
    if (state.state === "ready" && selected) return Object.freeze({ ...selected, generation });
    if (state.state === "degraded" && state.reasonCode) {
      throw Object.assign(new Error("No conforming sandbox provider is ready."), { code: state.reasonCode });
    }
    return null;
  }
  function validate(resolution?: ProviderResolution | null): boolean {
    expireCachedSelection();
    return state.state === "ready" && selected !== null && resolution?.generation === generation &&
      resolution.backend === selected.backend && resolution.descriptor === selected.descriptor;
  }
  function invalidate(): void {
    selected = null; expiresAt = 0;
    if (!quarantined) state = configured.state === "configured" ? { state: "unavailable" } : { state: configured.state };
  }
  function quarantine(): void { selected = null; expiresAt = 0; quarantined = true; state = { state: "quarantined" }; }
  async function close(): Promise<void> {
    quarantined = true; const current = selected; selected = null; state = { state: "quarantined" };
    await current?.backend.close?.();
  }
  return Object.freeze({
    refresh, resolve, validate, invalidate, quarantine,
    publicProjection: () => { expireCachedSelection(); return publicProjection(state); },
    administrativeProjection: () => { expireCachedSelection(); return administrativeProjection(state); },
    close, requiredRestrictions: REQUIRED_RESTRICTIONS
  });
}

export { REQUIRED_RESTRICTIONS as REQUIRED_SANDBOX_PROVIDER_RESTRICTIONS };
