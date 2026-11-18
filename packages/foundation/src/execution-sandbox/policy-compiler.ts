import {
  CONTROLLED_SANDBOX_FINAL_RECEIPT_ID,
  SANDBOX_DENIAL_REASONS,
  sandboxApprovalRequestDigest,
  sandboxDigest
} from "./contracts.ts";
import type {
  SandboxCapabilities,
  SandboxExecutionRequest,
  SandboxGovernance
} from "./contracts.ts";

type UnknownRecord = Record<string, unknown>;

interface EnabledSandboxConfiguration {
  state: "enabled";
  providerMode: "automatic" | "explicit";
  providerId: string;
  profileId: string;
  policyRevision: string;
  allowedProviderClasses: readonly string[];
  receiptRequirement: string;
}

type SandboxConfiguration =
  | Readonly<EnabledSandboxConfiguration>
  | Readonly<{ state: "unconfigured" | "invalid" | "disabled" }>;

export interface SandboxBackendDescriptor {
  id: string;
  providerClass: string;
  healthy: boolean;
  enforcedRestrictions: readonly string[];
}

export interface SandboxAdmissionPolicy {
  backendId: string;
  profileId: string;
  policyRevision: string;
  receiptRequirement: string;
  workload: Readonly<{
    runtimeKind: unknown;
    image: string;
    command: readonly string[];
    entryPoint: string;
  }>;
  capabilities: Readonly<SandboxCapabilities>;
  resources: Readonly<Record<string, number>>;
  trustDomain: string;
  requestDigest: string;
}

export type SandboxAdmission =
  | Readonly<{ admitted: false; reasonCode: string; detail: string }>
  | Readonly<{ admitted: true; policy: Readonly<SandboxAdmissionPolicy>; policyDigest: string }>;

const PROVIDER_CLASSES = new Set<string>([
  "rootless-podman",
  "podman",
  "rootless-docker",
  "docker",
  "registered-container",
  "registered-vm"
]);
const CONFIG_FIELDS = new Set<string>([
  "enabled",
  "providerMode",
  "providerId",
  "profileId",
  "policyRevision",
  "receiptRequirement",
  "allowedProviderClasses"
]);
const PROFILE_FIELDS = new Set<string>([
  "id",
  "policyRevision",
  "workloads",
  "capabilities",
  "resourceLimits",
  "requiresApproval",
  "receiptRequirement"
]);

function plainObject(value: unknown): value is UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deny(reasonCode: string, detail = ""): Readonly<{ admitted: false; reasonCode: string; detail: string }> {
  return Object.freeze({ admitted: false, reasonCode, detail });
}

function boundedPositive(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.map((entry) => String(entry || "").trim()).filter(Boolean) : []);
}

function intersectRequested(requested: readonly string[], allowed: unknown): string[] {
  const allowedSet = stringSet(allowed);
  return requested.filter((item) => allowedSet.has(item));
}

export function normalizeSandboxConfiguration(value: unknown): SandboxConfiguration {
  if (value === undefined || value === null) return Object.freeze({ state: "unconfigured" });
  if (!plainObject(value)) return Object.freeze({ state: "invalid" });
  for (const field of Object.keys(value)) {
    if (!CONFIG_FIELDS.has(field)) return Object.freeze({ state: "invalid" });
  }
  if (value.enabled !== true) return Object.freeze({ state: "disabled" });
  const providerMode = String(value.providerMode || "").trim();
  const providerId = String(value.providerId || "").trim();
  const profileId = String(value.profileId || "").trim();
  const policyRevision = String(value.policyRevision || "").trim();
  const receiptRequirement = String(value.receiptRequirement || "").trim();
  const allowedProviderClasses = Array.isArray(value.allowedProviderClasses)
    ? [...new Set(value.allowedProviderClasses.map((entry) => String(entry || "").trim()))]
    : [];
  if (
    !["automatic", "explicit"].includes(providerMode) ||
    (providerMode === "explicit" && !providerId) ||
    (providerMode === "automatic" && providerId) ||
    !profileId ||
    !policyRevision ||
    allowedProviderClasses.length === 0 ||
    allowedProviderClasses.some((entry) => !PROVIDER_CLASSES.has(entry)) ||
    receiptRequirement !== CONTROLLED_SANDBOX_FINAL_RECEIPT_ID
  ) {
    return Object.freeze({ state: "invalid" });
  }
  return Object.freeze({
    state: "enabled",
    providerMode: providerMode as "automatic" | "explicit",
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
}: {
  request: Readonly<SandboxExecutionRequest>;
  configuration?: unknown;
  profile?: unknown;
  backendDescriptor?: SandboxBackendDescriptor | null;
  selectedBackendId?: string;
  currentGovernance?: Readonly<SandboxGovernance>;
  now?: Date;
}): SandboxAdmission {
  const config = normalizeSandboxConfiguration(configuration);
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
  const backendId = String(selectedBackendId || "").trim();
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

  const governance = currentGovernance || request.governance;
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

  const workload = plainObject(profile.workloads) ? profile.workloads[request.workloadKind] : null;
  if (!plainObject(workload) || workload.runtimeKind !== request.artifact.runtimeKind) {
    return deny(SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED);
  }
  const artifactDigests = stringSet(workload.artifactDigests);
  if (
    artifactDigests.size === 0 ||
    !artifactDigests.has(request.artifact.digest) ||
    String(workload.entryPoint || "") !== request.artifact.entryPoint
  ) {
    return deny(SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED);
  }
  const allowedCapabilities: UnknownRecord = plainObject(profile.capabilities) ? profile.capabilities : {};
  const narrowed: SandboxCapabilities = {
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
  for (const field of ["filesystem", "network", "tools", "secretRefs"] as const) {
    if (narrowed[field].length !== request.capabilities[field].length) {
      return deny(SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED);
    }
  }
  for (const field of ["clock", "randomness"] as const) {
    if (request.capabilities[field] === true && narrowed[field] !== true) {
      return deny(SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED);
    }
  }
  if (narrowed.subprocesses !== request.capabilities.subprocesses) {
    return deny(SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED);
  }

  const resourceLimits: UnknownRecord = plainObject(profile.resourceLimits) ? profile.resourceLimits : {};
  const resources: Record<string, number> = {};
  for (const [field, requested] of Object.entries(request.resources)) {
    const limit = boundedPositive(resourceLimits[field]);
    if (!limit || requested > limit) return deny(SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED);
    resources[field] = requested;
  }
  const backendCapabilities = stringSet(backendDescriptor.enforcedRestrictions);
  const requiredRestrictions: string[] = [
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
  if (requiredRestrictions.some((entry) => !backendCapabilities.has(entry))) {
    return deny(SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED);
  }

  const policy: Readonly<SandboxAdmissionPolicy> = Object.freeze({
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
