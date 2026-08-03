export const MAINTENANCE_AGENT_RISKS: any[] = [
  "read_only",
  "safe_write",
  "repair_write",
  "destructive"
];

export function normalizeRisk(value?: any, fallback: any = "read_only") : any {
  const trimmed: any = String(value || "").trim();
  if (!trimmed) {
    return fallback;
  }
  if (MAINTENANCE_AGENT_RISKS.includes(trimmed)) {
    return trimmed;
  }
  // Unrecognized risk values are a contract-level error — they indicate a
  // stale definition, a typo, or an unregistered risk class.  Reject them
  // rather than silently promoting an unknown risk to the safest tier.
  throw new Error(
    `Unrecognized operation risk "${value}". ` +
    `Allowed risks: ${MAINTENANCE_AGENT_RISKS.join(", ")}.`
  );
}

export function riskRank(value?: any) : any {
  const index: any = MAINTENANCE_AGENT_RISKS.indexOf(normalizeRisk(value));
  return index >= 0 ? index : 0;
}

export function maxRisk(...risks: any[]) : any {
  return risks
    .map((risk?: any) : any => normalizeRisk(risk))
    .sort((left?: any, right?: any) : any => riskRank(right) - riskRank(left))[0] || "read_only";
}

export const OPERATION_ASPECTS: Readonly<Record<string, any>> = Object.freeze({
  AUTHORIZATION: "authorization",
  SAFETY: "safety",
  AUDIT: "audit",
  DISPATCH: "dispatch",
  PROOF: "operation-proof"
});

export const OPERATION_PROOF_PROFILES: Readonly<Record<string, any>> = Object.freeze({
  FULL: "full",
  RECEIPT: "receipt",
  ON_CHANGE: "on-change",
  EXCLUDED: "excluded"
});

export const DEFAULT_REPAIR_APPROVAL_SCOPE: any = "maintenance:approve";

export const READ_ONLY_POST_OPERATION_IDS: any = new Set<any>([
  "auth.roles.get",
  "context.compaction.preview",
  "settings.model_probe"
]);

export const PUBLIC_OPERATION_IDS: any = new Set<any>([
  "system.health",
  "system.bootstrap",
  "auth.session",
  "auth.login",
  "discovery.check_in"
]);

export const PROOF_EXCLUDED_OPERATION_IDS: any = new Map<any, any>([
  ["system.health", "health"],
  ["system.bootstrap", "bootstrap"],
  ["system.interfaces", "static-discovery"],
  ["auth.session", "session-discovery"],
  ["auth.login", "bootstrap-auth"],
  ["auth.logout", "session-discovery"],
  ["discovery.check_in", "client-discovery"],
  ["appearance_presets.list", "public-catalog"],
  ["production.health", "health"],
  ["architecture.live_map", "static-discovery"],
  ["sample_capability_pack.list", "public-catalog"],
  ["sample_capability_pack.get", "public-catalog"]
]);

export const EXTERNAL_AUTH_OPERATION_IDS: any = new Set<any>([
  "agent_sync.publish",
  "operation_permission.execute",
  "operation_permission.batch",
  "operation_permission.dry_run"
]);

export const EXTERNAL_AUTH_MISSING_CODE_DECORATORS: any = new Map<any, any>([
  ["operation_permission.execute", "missing_token"],
  ["operation_permission.batch", "missing_token"],
  ["operation_permission.dry_run", "missing_token"]
]);

export const EXTERNAL_AUTH_VERIFIER_DECORATORS: any = new Map<any, any>([
  ["operation_permission.execute", { method: "verifyToolSkillExternalAuth" }],
  ["operation_permission.batch", { method: "verifyToolSkillExternalAuth" }],
  ["operation_permission.dry_run", { method: "verifyToolSkillExternalAuth" }]
]);

export const REQUIRED_SCOPE_DECORATORS: any = new Map<any, any>([
  ["events.subscribe", ["console:read"]],
  ["agent_sync.subscribe", ["console:read"]],
  ["discovery.clients", ["console:read"]],
  ["agents.list", ["console:read"]]
]);

export const SAFETY_DECORATORS: any = new Map<any, any>([
  ["agent_sync.config.set", { risk: "repair_write" }],
  ["maintenance_agent.config.set", { risk: "repair_write" }],
  ["maintenance_agent.runs.approve", { risk: "repair_write", requiresConfirmation: false }],
  ["agents.create", { risk: "repair_write" }],
  ["agents.update", { risk: "repair_write" }],
  ["agents.delete", { risk: "repair_write" }],
  ["auth.roles.get", { risk: "read_only" }],
  ["auth.users.update", { risk: "repair_write" }],
  ["auth.oidc.set", { risk: "repair_write" }],
  ["auth.audit.retention.set", { risk: "repair_write" }],
  ["auth.audit.prune", { risk: "repair_write" }],
  ["operation_permission.metrics_prune", { risk: "repair_write" }],
  ["external_services.remove", { risk: "repair_write", approvalScope: "runtime:admin" }],
  ["auth.sessions.rotate", { risk: "safe_write" }],
  ["discovery.clients.alignment_command", { risk: "repair_write" }],
  ["discovery.set_config", { risk: "repair_write" }],
  ["runtime.set_mounts", { risk: "repair_write", approvalScope: "runtime:admin" }],
  ["runtime.reload_mounts", { risk: "repair_write", approvalScope: "runtime:admin" }],
  ["runtime.external_gateway.validate", { risk: "safe_write", requiresConfirmation: false }],
  ["runtime.external_gateway.apply", { risk: "repair_write", approvalScope: "runtime:admin" }],
  ["runtime.external_gateway.switch_direct", { risk: "repair_write", approvalScope: "runtime:admin" }],
  ["storage.reconcile", { risk: "repair_write" }],
  ["settings.set", { risk: "repair_write" }],
  ["context.session_memory.clear", { risk: "repair_write" }],
  ["jobs.delete", { risk: "repair_write" }],
  ["jobs.cancel", { risk: "safe_write" }]
]);

export const CONCURRENCY_GROUP_DECORATORS: any = new Map<any, any>([
  ["settings.set", "settings"],
  ["runtime.set_mounts", "runtime.mounts"],
  ["runtime.reload_mounts", "runtime.mounts"],
  ["runtime.external_gateway.apply", "runtime.external_gateway"],
  ["runtime.external_gateway.switch_direct", "runtime.external_gateway"],
  ["runtime.assembly.build", "runtime.assembly"],
  ["discovery.set_config", "discovery.config"],
  ["agent_sync.config.set", "agent_sync.config"],
  ["agents.create", "agent_management.model_library"],
  ["agents.update", "agent_management.model_library"],
  ["agents.delete", "agent_management.model_library"],
  ["maintenance_agent.config.set", "maintenance_agent.config"],
  ["context.compaction.run", "context.compaction"],
  ["context.session_memory.clear", "agent.memory"]
]);
