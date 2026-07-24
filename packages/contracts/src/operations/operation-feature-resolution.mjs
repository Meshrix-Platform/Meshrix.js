const AGENT_WORKSPACE_CORE_OPERATION_IDS = new Set([
  "agent_workspaces.create",
  "agent_workspaces.list",
  "agent_workspaces.get",
  "agent_workspaces.delete",
  "agent_workspaces.folder.create",
  "agent_workspaces.files.list",
  "agent_workspaces.file.upload",
  "agent_workspaces.file.stat",
  "agent_workspaces.file.download",
  "agent_workspaces.file.write",
  "agent_workspaces.file.delete",
  "agent_workspaces.file.move"
]);

const FEATURE_BY_REGISTRY_FEATURE = Object.freeze({
  auth: "security-permissions",
  discovery: "core-platform",
  events: "core-platform",
  runtime: "core-platform",
  settings: "core-platform",
  storage: "storage-core",
  system: "core-platform",
  raw_objects: "storage-core",
  jobs: "work-queue-core",
  uploads: "work-queue-core",
  tag_management: "tag-management",
  security_alerts: "security-alerts",
  gateway: "upstream-gateway",
  external_services: "upstream-gateway",
  operation_permission: "operation-permission-core",
  strategy_management: "strategy-management",
  agent_management: "agent-management",
  agent_memory: "agent-memory",
  context_runtime: "context-runtime-core",
  custom_http_adapter: "agent-gateway",
  agent_gateway: "agent-gateway",
  agent_sync: "agent-gateway",
  agent_workspace: "agent-workspace-core",
  maintenance_agent: "maintenance-agent-runbooks"
});

export function operationFeatureId(operation = {}) {
  const operationId = String(operation.id || "");
  const operationFeature = String(operation.feature || "");
  const explicitFeatureId = String(operation.featureId || "").trim();

  if (explicitFeatureId) return explicitFeatureId;
  if (
    AGENT_WORKSPACE_CORE_OPERATION_IDS.has(operationId) ||
    operationId.startsWith("workspace.file.") ||
    operationId.startsWith("workspace.audit.") ||
    operationId.startsWith("workspace.operation.") ||
    operationId.startsWith("workspace.checkpoint.")
  ) {
    return "agent-workspace-core";
  }
  if (operationId.startsWith("agent_workspaces.")) {
    return "agent-workspace-core";
  }
  if (operationId.startsWith("context.session_memory.") || operationId.startsWith("agent_memory.")) {
    return "agent-memory";
  }
  if (operationId.startsWith("maintenance_agent.")) {
    return "maintenance-agent-runbooks";
  }
  if (["agents.list", "agents.create", "agents.update", "agents.delete"].includes(operationId)) {
    return "agent-management";
  }
  if (operationId === "settings.model_probe") {
    return "agent-gateway";
  }
  if (operationId.startsWith("agent_gateway.") || operationId.startsWith("agent_sync.")) {
    return "agent-gateway";
  }
  if (operationId.startsWith("security_alerts.")) {
    return "security-alerts";
  }
  if (operationId.startsWith("gateway.") || operationId.startsWith("external_services.")) {
    return "upstream-gateway";
  }
  return FEATURE_BY_REGISTRY_FEATURE[operationFeature] || "core-platform";
}
