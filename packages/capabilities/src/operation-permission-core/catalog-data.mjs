import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OPERATION_PERMISSION_API_PREFIX = "/api/operation-permission/v1";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTITY_CONFIG_ROOT = path.resolve(MODULE_DIR, "../../../foundation/config/entity-config/tools");

function loadEntityConfigList(kind) {
  const directory = path.join(ENTITY_CONFIG_ROOT, kind);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "manifest.json") {
      continue;
    }
    const filePath = path.join(directory, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        items.push(parsed);
      }
    } catch (error) {
      throw new Error(`Invalid tool entity config ${filePath}: ${error.message}`);
    }
  }
  if (!items.length) {
    throw new Error(`Operation Permission entity config ${directory} must contain current JSON entries`);
  }
  return items.sort((left, right) => String(left.id || "").localeCompare(String(right.id || "")));
}

export const OPERATION_PERMISSION_SCOPES = Object.freeze(
  loadEntityConfigList("scopes")
);
export const OPERATION_PERMISSION_TOOLSETS = Object.freeze(
  loadEntityConfigList("toolsets")
);
export const OPERATION_PERMISSION_PROFILES = Object.freeze(
  loadEntityConfigList("profiles")
);

export const TOOL_ID_BY_OPERATION_ID = Object.freeze({
  "readiness.baseline.status": "lico.readiness.baseline.status",
  "system.health": "system.health",
  "runtime.info": "lico.runtime.info",
  "runtime.mounts": "lico.runtime.mounts",
  "runtime.set_mounts": "lico.runtime.mounts.set",
  "runtime.reload_mounts": "lico.runtime.mounts.reload",
  "architecture.live_map": "lico.architecture.liveMap",
  "sample_capability_pack.list": "lico.sampleCapabilityPack.list",
  "sample_capability_pack.get": "lico.sampleCapabilityPack.get",
  "sample_capability_pack.materialize": "lico.sampleCapabilityPack.materialize",
  "executive_report.list": "lico.executiveReport.list",
  "executive_report.preview": "lico.executiveReport.preview",
  "executive_report.generate": "lico.executiveReport.generate",
  "storage.summary": "lico.storageSummary",
  "storage.backups.list": "lico.storageBackups.list",
  "storage.backups.create": "lico.storageBackups.create",
  "storage.backups.restore_preview": "lico.storageBackups.restorePreview",
  "storage.backups.restore": "lico.storageBackups.restore",
  "jobs.list": "lico.jobs.list",
  "jobs.get": "lico.jobs.get",
  "jobs.work_queue.inspect": "lico.jobs.workQueue.inspect",
  "jobs.work_queue.pause": "lico.jobs.workQueue.pause",
  "jobs.work_queue.resume": "lico.jobs.workQueue.resume",
  "jobs.work_queue.drain": "lico.jobs.workQueue.drain",
  "jobs.work_queue.recover_failed": "lico.jobs.workQueue.recoverFailed",
  "jobs.work_queue.rebuild": "lico.jobs.workQueue.rebuild",
  "security_alerts.list": "lico.securityAlerts.list",
  "security_alerts.ack": "lico.securityAlerts.ack",
  "security_alerts.export": "lico.securityAlerts.export",
  "security_alerts.prune": "lico.securityAlerts.prune",
  "strategy.describe": "lico.strategy.describe",
  "strategy.workflow_policy.evaluate": "lico.strategy.workflowPolicy.evaluate",
  "strategy.agent_policy.evaluate": "lico.strategy.agentPolicy.evaluate",
  "strategy.route_policy.evaluate": "lico.strategy.routePolicy.evaluate",
  "strategy.queue_policy.evaluate": "lico.strategy.queuePolicy.evaluate",
  "strategy.tool_policy.preview": "lico.strategy.toolPolicy.preview",
  "agent_gateway.call": "lico.agentGateway.call",
  "model_routing.health": "lico.agentGateway.modelRouting.health",
  "agents.list": "lico.agentManagement.agents.list",
  "agents.create": "lico.agentManagement.agents.create",
  "agents.update": "lico.agentManagement.agents.update",
  "agents.delete": "lico.agentManagement.agents.delete",
  "maintenance_agent.config.get": "lico.maintenanceAgent.config.get",
  "maintenance_agent.config.set": "lico.maintenanceAgent.config.set",
  "maintenance_agent.chat": "lico.maintenanceAgent.chat",
  "maintenance_agent.runs.create": "lico.maintenanceAgent.runs.create",
  "maintenance_agent.runs.list": "lico.maintenanceAgent.runs.list",
  "maintenance_agent.runs.get": "lico.maintenanceAgent.runs.get",
  "maintenance_agent.runs.approve": "lico.maintenanceAgent.runs.approve",
  "maintenance_agent.runs.cancel": "lico.maintenanceAgent.runs.cancel",
  "context.profiles.get": "lico.context.profiles",
  "context.profiles.set": "lico.context.profiles.set",
  "context.session_memory.get": "lico.agentMemory.sessionMemory.get",
  "context.session_memory.clear": "lico.agentMemory.sessionMemory.clear",
  "agent_workspaces.create": "lico.agentWorkspace.create",
  "agent_workspaces.list": "lico.agentWorkspace.list",
  "agent_workspaces.get": "lico.agentWorkspace.get",
  "agent_workspaces.context.get": "lico.agentWorkspace.context",
  "agent_workspaces.context_bundle.export": "lico.agentWorkspace.contextBundle.export",
  "agent_workspaces.context_bundle.restore": "lico.agentWorkspace.contextBundle.restore",
  "agent_workspaces.chain.get": "lico.agentWorkspace.chain",
  "agent_workspaces.parent.set": "lico.agentWorkspace.parent.set",
  "agent_workspaces.profile.hotswap": "lico.agentWorkspace.profile.hotswap",
  "agent_workspaces.sources.set": "lico.agentWorkspace.sources.set",
  "agent_workspaces.share": "lico.agentWorkspace.share",
  "agent_workspaces.unshare": "lico.agentWorkspace.unshare",
  "agent_workspaces.delete": "lico.agentWorkspace.delete",
  "agent_workspaces.folder.create": "lico.agentWorkspace.folder.create",
  "agent_workspaces.files.list": "lico.agentWorkspace.files.list",
  "agent_workspaces.file.upload": "lico.agentWorkspace.file.upload",
  "agent_workspaces.file.stat": "lico.agentWorkspace.file.stat",
  "agent_workspaces.file.download": "lico.agentWorkspace.file.download",
  "agent_workspaces.file.write": "lico.agentWorkspace.file.write",
  "agent_workspaces.file.delete": "lico.agentWorkspace.file.delete",
  "agent_workspaces.file.move": "lico.agentWorkspace.file.move",
  "workspace.proposal.create": "lico.workspace.proposal.create",
  "workspace.proposal.apply": "lico.workspace.proposal.apply",
  "workspace_governance.describe": "lico.workspaceGovernance.describe",
  "workspace_governance.policy.set": "lico.workspaceGovernance.policy.set",
  "workspace_governance.evaluate": "lico.workspaceGovernance.evaluate",
  "workspace_governance.share_grant": "lico.workspaceGovernance.shareGrant",
  "agent_sessions.list": "lico.agentSession.list",
  "agent_sessions.get": "lico.agentSession.get",
  "agent_sessions.context.get": "lico.agentSession.context",
  "agent_sessions.events.append": "lico.agentSession.events.append",
  "agent_sessions.fork": "lico.agentSession.fork",
  "agent_sessions.compare": "lico.agentSession.compare",
  "agent_sessions.merge_proposal": "lico.agentSession.mergeProposal",
  "agent_sessions.archive": "lico.agentSession.archive",
  "agent_workspaces.submissions.resolve": "lico.agentWorkspace.submissionResolve",
  "agent_workspaces.issues.resolve": "lico.agentWorkspace.issueResolve",
  "agent_workspaces.locks.list": "lico.agentWorkspace.locks",
  "agent_workspaces.locks.write": "lico.agentWorkspace.lock",
  "agent_sync.config.get": "lico.agentSync.config.get",
  "agent_sync.config.set": "lico.agentSync.config.set",
  "agent_sync.publish": "lico.agentSync.publish",
  "agent_sync.subscribe": "lico.agentSync.subscribe",
  "authorization.subject.resolve": "lico.authorization.subject.resolve",
  "authorization.policy.evaluate": "lico.authorization.policy.evaluate",
  "authorization.governance.summary": "lico.authorization.governance.summary",
  "tag_management.tags.list": "lico.tagManagement.tags.list",
  "tag_management.tags.get": "lico.tagManagement.tags.get",
  "tag_management.tags.upsert": "lico.tagManagement.tags.upsert",
  "tag_management.tags.archive": "lico.tagManagement.tags.archive",
  "tag_management.tags.restore": "lico.tagManagement.tags.restore",
  "tag_management.projections.list": "lico.tagManagement.projections.list",
  "tag_management.projections.rebuild": "lico.tagManagement.projections.rebuild",
  "tag_management.audit.list": "lico.tagManagement.audit.list",
  "operation_permission.catalog": "lico.operationPermission.catalog",
  "operation_permission.catalog_item": "lico.operationPermission.catalogItem",
  "operation_permission.toolsets": "lico.operationPermission.toolsets",
  "operation_permission.toolsets_resolve": "lico.operationPermission.toolsetsResolve",
  "operation_permission.profiles": "lico.operationPermission.profiles",
  "operation_permission.policy_evaluate": "lico.operationPermission.policyEvaluate",
  "operation_permission.policy_preview": "lico.operationPermission.policyPreview",
  "operation_permission.execute": "lico.operationPermission.execute",
  "operation_permission.batch": "lico.operationPermission.batch",
  "operation_permission.dry_run": "lico.operationPermission.dryRun",
  "operation_permission.grants": "lico.operationPermission.grants",
  "operation_permission.create_grant": "lico.operationPermission.createGrant",
  "operation_permission.update_grant": "lico.operationPermission.updateGrant",
  "operation_permission.rotate_grant": "lico.operationPermission.rotateGrant",
  "operation_permission.revoke_grant": "lico.operationPermission.revokeGrant",
  "operation_permission.audit": "lico.operationPermission.audit",
  "operation_permission.audit_item": "lico.operationPermission.auditItem",
  "operation_permission.metrics_summary": "lico.operationPermission.metricsSummary",
  "operation_permission.metrics_export": "lico.operationPermission.metricsExport",
  "operation_permission.metrics_health": "lico.operationPermission.metricsHealth",
  "operation_permission.metrics_prometheus": "lico.operationPermission.metricsPrometheus",
  "operation_permission.metrics_storage": "lico.operationPermission.metricsStorage",
  "operation_permission.metrics_prune": "lico.operationPermission.metricsPrune",
  "operation_permission.events": "lico.operationPermission.events",
  "operation_permission.pending_operations.list": "lico.operationPermission.pendingOperations.list",
  "operation_permission.pending_operations.resolve": "lico.operationPermission.pendingOperations.resolve",
  "operation_permission.mcp.request_authorization": "lico.operationPermission.mcp.requestAuthorization",
  "operation_permission.mcp.list_requests": "lico.operationPermission.mcp.listRequests",
  "operation_permission.mcp.resolve_request": "lico.operationPermission.mcp.resolveRequest",
  "external_services.list": "lico.gateway.externalServices.list",
  "external_services.get": "lico.gateway.externalServices.get",
  "external_services.health": "lico.gateway.externalServices.health",
  "external_services.publications.list": "lico.gateway.externalServices.publications.list",
  "external_services.publications.get": "lico.gateway.externalServices.publications.get",
  "external_services.create": "lico.gateway.externalServices.create",
  "external_services.replace": "lico.gateway.externalServices.replace",
  "external_services.disable": "lico.gateway.externalServices.disable",
  "external_services.remove": "lico.gateway.externalServices.remove",
  "external_services.republish": "lico.gateway.externalServices.republish",
  "gateway.policy.preview": "lico.gateway.policyPreview",
  "gateway.forward": "lico.gateway.forward",
  "gateway.audit": "lico.gateway.audit",
  "gateway.metrics": "lico.gateway.metrics",
  "gateway.payload.transit": "lico.gateway.payloadTransit",
  "gateway.artifacts.get": "lico.gateway.artifacts.get",
  "authorization.roles.list": "lico.authorization.roles.list",
  "authorization.roles.upsert": "lico.authorization.roles.upsert",
  "authorization.departments.list": "lico.authorization.departments.list",
  "authorization.departments.upsert": "lico.authorization.departments.upsert",
  "authorization.teams.list": "lico.authorization.teams.list",
  "authorization.teams.upsert": "lico.authorization.teams.upsert",
  "authorization.users.policies.list": "lico.authorization.users.policies.list",
  "authorization.users.policy.upsert": "lico.authorization.users.policy.upsert",
  "authorization.agent_groups.list": "lico.authorization.agentGroups.list",
  "authorization.agent_groups.upsert": "lico.authorization.agentGroups.upsert",
  "authorization.agents.bindings.list": "lico.authorization.agents.bindings.list",
  "authorization.agents.binding.upsert": "lico.authorization.agents.binding.upsert",
  "authorization.approvals.list": "lico.authorization.approvals.list",
  "authorization.approvals.upsert": "lico.authorization.approvals.upsert",
  "authorization.approvals.revoke": "lico.authorization.approvals.revoke",
  "authorization.receipts.list": "lico.authorization.receipts.list",
  "authorization.loan_records.list": "lico.authorization.loanRecords.list",
  "authorization.denied_requests.list": "lico.authorization.deniedRequests.list",
  "workspace.info": "lico.workspace.info",
  "workspace.file.upload": "lico.workspace.file.upload",
  "jobs.upload_workspace_materialize": "lico.jobs.uploadWorkspaceMaterialize",
  "workspace.file.list": "lico.workspace.file.list",
  "workspace.file.download": "lico.workspace.file.download",
  "workspace.file.read": "lico.workspace.file.read",
  "workspace.file.write": "lico.workspace.file.write",
  "workspace.file.patch": "lico.workspace.file.patch",
  "workspace.contribution.submit": "lico.workspace.contribution.submit",
  "workspace.contribution.list": "lico.workspace.contribution.list",
  "workspace.contribution.leaderboard": "lico.workspace.contribution.leaderboard",
  "workspace.contribution.stats": "lico.workspace.contribution.stats",
  "workspace.contribution.report": "lico.workspace.contribution.report",
  "workspace.contribution.assets.list": "lico.workspace.contribution.assets.list",
  "workspace.contribution.permission.request": "lico.workspace.contribution.permission.request",
  "workspace.contribution.permission.grant": "lico.workspace.contribution.permission.grant",
  "workspace.contribution.scan": "lico.workspace.contribution.scan",
  "workspace.contribution.review": "lico.workspace.contribution.review",
  "workspace.contribution.preview": "lico.workspace.contribution.preview",
  "workspace.contribution.publish": "lico.workspace.contribution.publish",
  "workspace.contribution.adopt": "lico.workspace.contribution.adopt",
  "workspace.contribution.reject": "lico.workspace.contribution.reject",
  "workspace.contribution.request_changes": "lico.workspace.contribution.requestChanges",
  "workspace.contribution.revoke": "lico.workspace.contribution.revoke",
  "workspace.asset.policy.set": "lico.workspace.asset.policy.set",
  "workspace.asset.permission.check": "lico.workspace.asset.permission.check",
  "workspace.asset.target.connect": "lico.workspace.asset.target.connect",
  "workspace.asset.list": "lico.workspace.asset.list",
  "workspace.asset.read": "lico.workspace.asset.read",
  "workspace.asset.submit": "lico.workspace.asset.submit",
  "workspace.asset.mutate": "lico.workspace.asset.mutate",
  "workspace.asset.sync.plan": "lico.workspace.asset.sync.plan",
  "workspace.asset.sync.apply": "lico.workspace.asset.sync.apply",
  "workspace.asset.import": "lico.workspace.asset.import",
  "workspace.asset.export": "lico.workspace.asset.export",
  "workspace.asset.review.comment": "lico.workspace.asset.review.comment",
  "workspace.asset.review.requestChanges": "lico.workspace.asset.review.requestChanges",
  "workspace.asset.review.approve": "lico.workspace.asset.review.approve",
  "workspace.asset.checkpoint": "lico.workspace.asset.checkpoint",
  "workspace.asset.lineage": "lico.workspace.asset.lineage",
  "workspace.asset.receipt.get": "lico.workspace.asset.receipt.get",
  "workspace.asset.backfill": "lico.workspace.asset.backfill",
  "workspace.audit.query": "lico.workspace.audit.query",
  "workspace.operation.history": "lico.workspace.operation.history",
  "workspace.checkpoint.tree.list": "lico.workspace.checkpoint.tree.list",
  "workspace.checkpoint.node.get": "lico.workspace.checkpoint.node.get",
  "workspace.checkpoint.diff": "lico.workspace.checkpoint.diff",
  "workspace.checkpoint.restore.preview": "lico.workspace.checkpoint.restore.preview",
  "workspace.checkpoint.restore": "lico.workspace.checkpoint.restore",
  "workspace.checkpoint.scope.query": "lico.workspace.checkpoint.scope.query",
  "workspace.operation.revert.scope": "lico.workspace.operation.revert.scope",
  "workspace.operation.revert.apply": "lico.workspace.operation.revert.apply",
  "workspace.code.target.evaluate": "lico.workspace.code.target.evaluate",
  "workspace.code.change.prepare": "lico.workspace.code.change.prepare",
  "workspace.code.change.upload": "lico.workspace.code.change.upload",
  "workspace.code.change.link": "lico.workspace.code.change.link",
  "workspace.code.change.status.sync": "lico.workspace.code.change.status.sync"
});

export const INTERNAL_OPERATION_IDS_HIDDEN_FROM_TOOL_CATALOG = Object.freeze(new Set([
  "operation_permission.execute",
  "operation_permission.batch",
  "operation_permission.dry_run"
]));

export const TOOL_ALIAS_IDS_BY_OPERATION_ID = Object.freeze({
  "agent_workspaces.create": ["lico.workspace.create"],
  "agent_workspaces.folder.create": ["lico.workspace.folder.create"],
  "agent_workspaces.files.list": ["lico.workspace.files.list"],
  "agent_workspaces.file.stat": ["lico.workspace.file.stat"],
  "agent_workspaces.file.delete": ["lico.workspace.file.delete"],
  "agent_workspaces.file.move": ["lico.workspace.file.move"]
});

export const TOOLSET_BY_SCOPE = Object.freeze({
  "model:call": "lico.model.call",
  "workspace:read": "lico.agent.workspace.read",
  "workspace:write": "lico.agent.workspace",
  "workspace:maintain": "lico.agent.workspace.maintain",
  "storage:read": "lico.storage.read",
  "storage:write": "lico.storage.write",
  "jobs:read": "lico.jobs.read",
  "jobs:write": "lico.jobs.write",
  "console:read": "lico.console.read",
  "runtime:admin": "lico.runtime.maintain",
  "gateway:read": "lico.gateway.read",
  "gateway:write": "lico.gateway.write",
  "gateway:maintain": "lico.gateway.maintain",
  "gateway:admin": "lico.gateway.admin",
  "maintenance:read": "lico.maintenance.read",
  "maintenance:run": "lico.maintenance.run",
  "maintenance:admin": "lico.maintenance.maintain",
  "maintenance:approve": "lico.maintenance.maintain",
  "agent_sync:publish": "lico.agent.sync.publish",
  "auth:admin": "lico.authorization.admin"
});

export const RISK_RANK = Object.freeze({
  read_only: 0,
  safe_write: 1,
  repair_write: 2,
  destructive: 3
});

export const TOOLSET_BY_ID = new Map(OPERATION_PERMISSION_TOOLSETS.map((toolset) => [toolset.id, toolset]));
