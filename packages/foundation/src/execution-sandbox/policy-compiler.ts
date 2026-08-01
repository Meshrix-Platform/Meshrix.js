import {
  CONTROLLED_SANDBOX_FINAL_RECEIPT_ID,
  SANDBOX_DENIAL_REASONS,
  sandboxApprovalRequestDigest,
  sandboxDigest
} from "./contracts.ts";

const PROVIDER_CLASSES: any = new Set<any>([
  "rootless-podman",
  "podman",
  "rootless-docker",
  "docker",
  "registered-container",
  "registered-vm"
]);
const CONFIG_FIELDS: any = new Set<any>([
  "enabled",
  "providerMode",
  "providerId",
  "profileId",
  "policyRevision",
  "receiptRequirement",
  "allowedProviderClasses"
]);
const PROFILE_FIELDS: any = new Set<any>([
  "id",
  "policyRevision",
  "workloads",
  "capabilities",
  "resourceLimits",
  "requiresApproval",
  "receiptRequirement"
]);

function plainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deny(reasonCode?: any, detail: any = "") : any {
  return Object.freeze({ admitted: false, reasonCode, detail });
}

function boundedPositive(value?: any) : any {
  const number: any = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function stringSet(value?: any) : any {
  return new Set<any>(Array.isArray(value) ? value.map((entry?: any) : any => String(entry || "").trim()).filter(Boolean) : []);
}

function intersectRequested(requested?: any, allowed?: any) : any {
  const allowedSet: any = stringSet(allowed);
  return requested.filter((item?: any) : any => allowedSet.has(item));
}

export function normalizeSandboxConfiguration(value?: any) : any {
  if (value === undefined || value === null) return Object.freeze({ state: "unconfigured" });
  if (!plainObject(value)) return Object.freeze({ state: "invalid" });
  for (const field of Object.keys(value)) {
    if (!CONFIG_FIELDS.has(field)) return Object.freeze({ state: "invalid" });
  }
  if (value.enabled !== true) return Object.freeze({ state: "disabled" });
  const providerMode: any = String(value.providerMode || "").trim();
  const providerId: any = String(value.providerId || "").trim();
  const profileId: any = String(value.profileId || "").trim();
  const policyRevision: any = String(value.policyRevision || "").trim();
  const receiptRequirement: any = String(value.receiptRequirement || "").trim();
  const allowedProviderClasses: any = Array.isArray(value.allowedProviderClasses)
    ? [...new Set<any>(value.allowedProviderClasses.map((entry?: any) : any => String(entry || "").trim()))]
    : [];
  if (
    !["automatic", "explicit"].includes(providerMode) ||
    (providerMode === "explicit" && !providerId) ||
    (providerMode === "automatic" && providerId) ||
    !profileId ||
    !policyRevision ||
    allowedProviderClasses.length === 0 ||
    allowedProviderClasses.some((entry?: any) : any => !PROVIDER_CLASSES.has(entry)) ||
    receiptRequirement !== CONTROLLED_SANDBOX_FINAL_RECEIPT_ID
  ) {
    return Object.freeze({ state: "invalid" });
  }
  return Object.freeze({
    state: "enabled",
    providerMode,
    providerId,
    profileId,
    policyRevision,
    allowedProviderClasses: Object.freeze(allowedProviderClasses),
    receiptRequirement
  });
}

export function compileSandboxAdmission({
  request,
  configuration,
  profile,
  backendDescriptor,
  selectedBackendId = "",
  currentGovernance = request?.governance,
  now = new Date()
}: Record<string, any> = {}) : any {
  const config: any = normalizeSandboxConfiguration(configuration);
  if (config.state === "unconfigured") return deny(SANDBOX_DENIAL_REASONS.UNCONFIGURED);
  if (config.state === "disabled") return deny(SANDBOX_DENIAL_REASONS.DISABLED);
  if (config.state !== "enabled") return deny(SANDBOX_DENIAL_REASONS.CONFIGURATION_INVALID);
  if (!plainObject(profile)) return deny(SANDBOX_DENIAL_REASONS.CONFIGURATION_INVALID);
  for (const field of Object.keys(profile)) {
    if (!PROFILE_FIELDS.has(field)) return deny(SANDBOX_DENIAL_REASONS.CONFIGURATION_INVALID);
  }
  if (
    String(profile.id || "") !== config.profileId ||
    String(profile.policyRevision || "") !== config.policyRevision
  ) return deny(SANDBOX_DENIAL_REASONS.CONFIGURATION_INVALID);
  const backendId: any = String(selectedBackendId || "").trim();
  if (
    !backendId ||
    !backendDescriptor ||
    String(backendDescriptor.id || "") !== backendId ||
    !config.allowedProviderClasses.includes(String(backendDescriptor.providerClass || "")) ||
    (config.providerMode === "explicit" && config.providerId !== backendId)
  ) {
    return deny(SANDBOX_DENIAL_REASONS.BACKEND_MISSING);
  }
  if (backendDescriptor.healthy !== true) return deny(SANDBOX_DENIAL_REASONS.BACKEND_UNHEALTHY);

  const governance: any = currentGovernance || {};
  if (
    governance.authorized !== true ||
    !String(governance.grantRef || "").trim() ||
    !/^[a-f0-9]{64}$/u.test(String(governance.authorizationContextDigest || ""))
  ) {
    return deny(SANDBOX_DENIAL_REASONS.AUTHORIZATION_MISSING);
  }
  if (
    governance.grantRef !== request.governance.grantRef ||
    governance.riskDecisionRef !== request.governance.riskDecisionRef ||
    governance.policyRevision !== request.governance.policyRevision ||
    governance.authorizationContextDigest !== request.governance.authorizationContextDigest
  ) {
    return deny(SANDBOX_DENIAL_REASONS.GOVERNANCE_STALE);
  }
  if (governance.revoked === true) return deny(SANDBOX_DENIAL_REASONS.GOVERNANCE_REVOKED);
  if (governance.current !== true || governance.policyRevision !== profile.policyRevision) {
    return deny(SANDBOX_DENIAL_REASONS.GOVERNANCE_STALE);
  }
  if (profile.requiresApproval === true && !String(governance.approvalRef || "").trim()) {
    return deny(SANDBOX_DENIAL_REASONS.APPROVAL_MISSING);
  }
  if (profile.requiresApproval === true) {
    if (
      governance.approvalRef !== request.governance.approvalRef ||
      governance.approvalBindingDigest !== request.governance.approvalBindingDigest ||
      governance.approvalSourceDigest !== request.governance.approvalSourceDigest ||
      governance.approvalRequestDigest !== request.governance.approvalRequestDigest ||
      governance.approvalExpiresAt !== request.governance.approvalExpiresAt
    ) {
      return deny(SANDBOX_DENIAL_REASONS.GOVERNANCE_STALE);
    }
    if (
      !/^[a-f0-9]{64}$/u.test(String(governance.approvalBindingDigest || "")) ||
      !/^[a-f0-9]{64}$/u.test(String(governance.approvalSourceDigest || "")) ||
      !/^[a-f0-9]{64}$/u.test(String(governance.approvalRequestDigest || "")) ||
      sandboxApprovalRequestDigest(request) !== governance.approvalRequestDigest ||
      !Number.isFinite(Date.parse(governance.approvalExpiresAt)) ||
      Date.parse(governance.approvalExpiresAt) <= now.getTime()
    ) {
      return deny(SANDBOX_DENIAL_REASONS.APPROVAL_STALE);
    }
  }
  if (Date.parse(request.deadlineAt) <= now.getTime()) return deny(SANDBOX_DENIAL_REASONS.TIMED_OUT);
  if (
    config.receiptRequirement &&
    String(profile.receiptRequirement || "") !== config.receiptRequirement
  ) return deny(SANDBOX_DENIAL_REASONS.CONFIGURATION_INVALID);

  const workload: any = plainObject(profile.workloads) ? profile.workloads[request.workloadKind] : null;
  if (!plainObject(workload) || workload.runtimeKind !== request.artifact.runtimeKind) {
    return deny(SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED);
  }
  const artifactDigests: any = stringSet(workload.artifactDigests);
  if (
    artifactDigests.size === 0 ||
    !artifactDigests.has(request.artifact.digest) ||
    String(workload.entryPoint || "") !== request.artifact.entryPoint
  ) {
    return deny(SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED);
  }
  const allowedCapabilities: any = plainObject(profile.capabilities) ? profile.capabilities : {};
  const narrowed: Record<string, any> = {
    filesystem: intersectRequested(request.capabilities.filesystem, allowedCapabilities.filesystem),
    network: intersectRequested(request.capabilities.network, allowedCapabilities.network),
    tools: intersectRequested(request.capabilities.tools, allowedCapabilities.tools),
    secretRefs: intersectRequested(request.capabilities.secretRefs, allowedCapabilities.secretRefs),
    clock: request.capabilities.clock === true && allowedCapabilities.clock === true,
    randomness: request.capabilities.randomness === true && allowedCapabilities.randomness === true,
    subprocesses: Math.min(
      request.capabilities.subprocesses,
      Number.isSafeInteger(Number(allowedCapabilities.subprocesses)) ? Number(allowedCapabilities.subprocesses) : 0
    )
  };
  for (const field of ["filesystem", "network", "tools", "secretRefs"]) {
    if (narrowed[field].length !== request.capabilities[field].length) {
      return deny(SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED);
    }
  }
  for (const field of ["clock", "randomness"]) {
    if (request.capabilities[field] === true && narrowed[field] !== true) {
      return deny(SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED);
    }
  }
  if (narrowed.subprocesses !== request.capabilities.subprocesses) {
    return deny(SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED);
  }

  const resourceLimits: any = plainObject(profile.resourceLimits) ? profile.resourceLimits : {};
  const resources: Record<string, any> = {};
  for (const [field, requested] of (Object.entries(request.resources) as [string, any][])) {
    const limit: any = boundedPositive(resourceLimits[field]);
    if (!limit || requested > limit) return deny(SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED);
    resources[field] = requested;
  }
  const backendCapabilities: any = stringSet(backendDescriptor.enforcedRestrictions);
  const requiredRestrictions: any[] = [
    "filesystem",
    "process",
    "network",
    "environment",
    "credentials",
    "resources",
    "output",
    "cleanup",
    "cross-trust-domain"
  ];
  if (requiredRestrictions.some((entry?: any) : any => !backendCapabilities.has(entry))) {
    return deny(SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED);
  }

  const policy: Readonly<Record<string, any>> = Object.freeze({
    backendId,
    profileId: config.profileId,
    policyRevision: profile.policyRevision,
    receiptRequirement: String(profile.receiptRequirement || ""),
    workload: Object.freeze({
      runtimeKind: workload.runtimeKind,
      image: String(workload.image || ""),
      command: Object.freeze(Array.isArray(workload.command) ? workload.command.map(String) : []),
      entryPoint: String(workload.entryPoint || "")
    }),
    capabilities: Object.freeze(narrowed),
    resources: Object.freeze(resources),
    trustDomain: sandboxDigest({
      tenantRef: request.principal.tenantRef,
      workspaceRef: request.principal.workspaceRef
    }),
    requestDigest: sandboxDigest(request)
  });
  if (!policy.workload.image || !policy.workload.command.length) {
    return deny(SANDBOX_DENIAL_REASONS.CONFIGURATION_INVALID);
  }
  return Object.freeze({ admitted: true, policy, policyDigest: sandboxDigest(policy) });
}
