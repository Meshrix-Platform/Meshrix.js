import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OPERATION_PERMISSION_API_PREFIX: any = "/api/operation-permission/v1";

const MODULE_DIR: any = path.dirname(fileURLToPath(import.meta.url));
const ENTITY_CONFIG_ROOT: any = path.resolve(MODULE_DIR, "../../../foundation/config/entity-config/tools");

function loadEntityConfigList(kind?: any) : any {
  const directory: any = path.join(ENTITY_CONFIG_ROOT, kind);
  const entries: any = fs.readdirSync(directory, { withFileTypes: true });
  const items: any[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "manifest.json") {
      continue;
    }
    const filePath: any = path.join(directory, entry.name);
    try {
      const parsed: any = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        items.push(parsed);
      }
    } catch (error: any) {
      throw new Error(`Invalid tool entity config ${filePath}: ${error.message}`);
    }
  }
  if (!items.length) {
    throw new Error(`Operation Permission entity config ${directory} must contain current JSON entries`);
  }
  return items.sort((left?: any, right?: any) : any => String(left.id || "").localeCompare(String(right.id || "")));
}

export const OPERATION_PERMISSION_SCOPES: any = Object.freeze(
  loadEntityConfigList("scopes")
);
export const OPERATION_PERMISSION_TOOLSETS: any = Object.freeze(
  loadEntityConfigList("toolsets")
);
export const OPERATION_PERMISSION_PROFILES: any = Object.freeze(
  loadEntityConfigList("profiles")
);

export const TOOL_ID_BY_OPERATION_ID: Readonly<Record<string, any>> = Object.freeze({
  "readiness.baseline.status": "meshrix.readiness.baseline.status",
  "system.health": "system.health",
  "runtime.info": "meshrix.runtime.info",
  "runtime.mounts": "meshrix.runtime.mounts",
  "runtime.set_mounts": "meshrix.runtime.mounts.set",
  "runtime.reload_mounts": "meshrix.runtime.mounts.reload",
  "architecture.live_map": "meshrix.architecture.liveMap",
  "sample_capability_pack.list": "meshrix.sampleCapabilityPack.list",
  "sample_capability_pack.get": "meshrix.sampleCapabilityPack.get",
  "sample_capability_pack.materialize": "meshrix.sampleCapabilityPack.materialize",
  "executive_report.list": "meshrix.executiveReport.list",
  "executive_report.preview": "meshrix.executiveReport.preview",
  "executive_report.generate": "meshrix.executiveReport.generate",
  "storage.summary": "meshrix.storageSummary",
  "storage.backups.list": "meshrix.storageBackups.list",
  "storage.backups.create": "meshrix.storageBackups.create",
  "storage.backups.restore_preview": "meshrix.storageBackups.restorePreview",
  "storage.backups.restore": "meshrix.storageBackups.restore",
  "jobs.list": "meshrix.jobs.list",
  "jobs.get": "meshrix.jobs.get",
  "jobs.work_queue.inspect": "meshrix.jobs.workQueue.inspect",
  "jobs.work_queue.pause": "meshrix.jobs.workQueue.pause",
  "jobs.work_queue.resume": "meshrix.jobs.workQueue.resume",
  "jobs.work_queue.drain": "meshrix.jobs.workQueue.drain",
  "jobs.work_queue.recover_failed": "meshrix.jobs.workQueue.recoverFailed",
  "jobs.work_queue.rebuild": "meshrix.jobs.workQueue.rebuild",
  "uploads.create_session": "uploads.create_session",
  "uploads.get_session": "uploads.get_session",
  "uploads.upload_chunk": "uploads.upload_chunk",
  "security_alerts.list": "meshrix.securityAlerts.list",
  "security_alerts.ack": "meshrix.securityAlerts.ack",
  "security_alerts.export": "meshrix.securityAlerts.export",
  "security_alerts.prune": "meshrix.securityAlerts.prune",
  "strategy.describe": "meshrix.strategy.describe",
  "strategy.workflow_policy.evaluate": "meshrix.strategy.workflowPolicy.evaluate",
  "strategy.agent_policy.evaluate": "meshrix.strategy.agentPolicy.evaluate",
  "strategy.route_policy.evaluate": "meshrix.strategy.routePolicy.evaluate",
  "strategy.queue_policy.evaluate": "meshrix.strategy.queuePolicy.evaluate",
  "strategy.tool_policy.preview": "meshrix.strategy.toolPolicy.preview",
  "model_gateway.call": "meshrix.modelGateway.call",
  "models.list": "meshrix.modelGateway.models.list",
  "authorization.organization_governance.get": "meshrix.authorization.organizationGovernance.get",
  "authorization.organization_governance.import": "meshrix.authorization.organizationGovernance.import",
  "authorization.organization_governance.preview": "meshrix.authorization.organizationGovernance.preview",
  "authorization.organization_governance.publish": "meshrix.authorization.organizationGovernance.publish",
  "operation_permission.api_keys.issuer_scopes": "meshrix.operationPermission.apiKeys.issuerScopes",
  "operation_permission.api_keys.list": "meshrix.operationPermission.apiKeys.list",
  "operation_permission.api_keys.create": "meshrix.operationPermission.apiKeys.create",
  "operation_permission.api_keys.rotate": "meshrix.operationPermission.apiKeys.rotate",
  "operation_permission.api_keys.revoke": "meshrix.operationPermission.apiKeys.revoke",
  "models.get": "meshrix.modelGateway.models.get",
  "context.profiles.get": "meshrix.context.profiles",
  "context.profiles.set": "meshrix.context.profiles.set",
  "context.session_memory.get": "meshrix.agentMemory.sessionMemory.get",
  "context.session_memory.clear": "meshrix.agentMemory.sessionMemory.clear",
  "agent_workspaces.create": "meshrix.agentWorkspace.create",
  "agent_workspaces.list": "meshrix.agentWorkspace.list",
  "agent_workspaces.get": "meshrix.agentWorkspace.get",
  "agent_workspaces.context.get": "meshrix.agentWorkspace.context",
  "agent_workspaces.context_bundle.export": "meshrix.agentWorkspace.contextBundle.export",
  "agent_workspaces.context_bundle.restore": "meshrix.agentWorkspace.contextBundle.restore",
  "agent_workspaces.chain.get": "meshrix.agentWorkspace.chain",
  "agent_workspaces.parent.set": "meshrix.agentWorkspace.parent.set",
  "agent_workspaces.profile.hotswap": "meshrix.agentWorkspace.profile.hotswap",
  "agent_workspaces.sources.set": "meshrix.agentWorkspace.sources.set",
  "agent_workspaces.share": "meshrix.agentWorkspace.share",
  "agent_workspaces.unshare": "meshrix.agentWorkspace.unshare",
  "agent_workspaces.delete": "meshrix.agentWorkspace.delete",
  "agent_workspaces.folder.create": "meshrix.agentWorkspace.folder.create",
  "agent_workspaces.files.list": "meshrix.agentWorkspace.files.list",
  "agent_workspaces.file.upload": "meshrix.agentWorkspace.file.upload",
  "agent_workspaces.file.stat": "meshrix.agentWorkspace.file.stat",
  "agent_workspaces.file.download": "meshrix.agentWorkspace.file.download",
  "agent_workspaces.file.write": "meshrix.agentWorkspace.file.write",
  "agent_workspaces.file.delete": "meshrix.agentWorkspace.file.delete",
  "agent_workspaces.file.move": "meshrix.agentWorkspace.file.move",
  "workspace.proposal.create": "meshrix.workspace.proposal.create",
  "workspace.proposal.apply": "meshrix.workspace.proposal.apply",
  "workspace_governance.describe": "meshrix.workspaceGovernance.describe",
  "workspace_governance.policy.set": "meshrix.workspaceGovernance.policy.set",
  "workspace_governance.evaluate": "meshrix.workspaceGovernance.evaluate",
  "workspace_governance.share_grant": "meshrix.workspaceGovernance.shareGrant",
  "agent_sessions.list": "meshrix.agentSession.list",
  "agent_sessions.get": "meshrix.agentSession.get",
  "agent_sessions.context.get": "meshrix.agentSession.context",
  "agent_sessions.events.append": "meshrix.agentSession.events.append",
  "agent_sessions.fork": "meshrix.agentSession.fork",
  "agent_sessions.compare": "meshrix.agentSession.compare",
  "agent_sessions.merge_proposal": "meshrix.agentSession.mergeProposal",
  "agent_sessions.archive": "meshrix.agentSession.archive",
  "agent_workspaces.submissions.resolve": "meshrix.agentWorkspace.submissionResolve",
  "agent_workspaces.issues.resolve": "meshrix.agentWorkspace.issueResolve",
  "agent_workspaces.locks.list": "meshrix.agentWorkspace.locks",
  "agent_workspaces.locks.write": "meshrix.agentWorkspace.lock",
  "agent_sync.config.get": "meshrix.agentSync.config.get",
  "agent_sync.config.set": "meshrix.agentSync.config.set",
  "agent_sync.publish": "meshrix.agentSync.publish",
  "agent_sync.subscribe": "meshrix.agentSync.subscribe",
  "authorization.subject.resolve": "meshrix.authorization.subject.resolve",
  "authorization.policy.evaluate": "meshrix.authorization.policy.evaluate",
  "authorization.governance.summary": "meshrix.authorization.governance.summary",
  "tag_management.tags.list": "meshrix.tagManagement.tags.list",
  "tag_management.tags.get": "meshrix.tagManagement.tags.get",
  "tag_management.tags.upsert": "meshrix.tagManagement.tags.upsert",
  "tag_management.tags.archive": "meshrix.tagManagement.tags.archive",
  "tag_management.tags.restore": "meshrix.tagManagement.tags.restore",
  "tag_management.projections.list": "meshrix.tagManagement.projections.list",
  "tag_management.projections.rebuild": "meshrix.tagManagement.projections.rebuild",
  "tag_management.audit.list": "meshrix.tagManagement.audit.list",
  "operation_permission.catalog": "meshrix.operationPermission.catalog",
  "operation_permission.catalog_item": "meshrix.operationPermission.catalogItem",
  "operation_permission.toolsets": "meshrix.operationPermission.toolsets",
  "operation_permission.toolsets_resolve": "meshrix.operationPermission.toolsetsResolve",
  "operation_permission.profiles": "meshrix.operationPermission.profiles",
  "operation_permission.policy_evaluate": "meshrix.operationPermission.policyEvaluate",
  "operation_permission.policy_preview": "meshrix.operationPermission.policyPreview",
  "operation_permission.execute": "meshrix.operationPermission.execute",
  "operation_permission.batch": "meshrix.operationPermission.batch",
  "operation_permission.dry_run": "meshrix.operationPermission.dryRun",
  "operation_permission.grants": "meshrix.operationPermission.grants",
  "operation_permission.create_grant": "meshrix.operationPermission.createGrant",
  "operation_permission.update_grant": "meshrix.operationPermission.updateGrant",
  "operation_permission.rotate_grant": "meshrix.operationPermission.rotateGrant",
  "operation_permission.revoke_grant": "meshrix.operationPermission.revokeGrant",
  "operation_permission.audit": "meshrix.operationPermission.audit",
  "operation_permission.audit_item": "meshrix.operationPermission.auditItem",
  "operation_permission.metrics_summary": "meshrix.operationPermission.metricsSummary",
  "operation_permission.metrics_export": "meshrix.operationPermission.metricsExport",
  "operation_permission.metrics_health": "meshrix.operationPermission.metricsHealth",
  "operation_permission.metrics_prometheus": "meshrix.operationPermission.metricsPrometheus",
  "operation_permission.metrics_storage": "meshrix.operationPermission.metricsStorage",
  "operation_permission.metrics_prune": "meshrix.operationPermission.metricsPrune",
  "operation_permission.events": "meshrix.operationPermission.events",
  "operation_permission.pending_operations.list": "meshrix.operationPermission.pendingOperations.list",
  "operation_permission.pending_operations.resolve": "meshrix.operationPermission.pendingOperations.resolve",
  "external_services.list": "meshrix.gateway.externalServices.list",
  "external_services.get": "meshrix.gateway.externalServices.get",
  "external_services.health": "meshrix.gateway.externalServices.health",
  "external_services.publications.list": "meshrix.gateway.externalServices.publications.list",
  "external_services.publications.get": "meshrix.gateway.externalServices.publications.get",
  "external_services.create": "meshrix.gateway.externalServices.create",
  "external_services.replace": "meshrix.gateway.externalServices.replace",
  "external_services.disable": "meshrix.gateway.externalServices.disable",
  "external_services.remove": "meshrix.gateway.externalServices.remove",
  "external_services.republish": "meshrix.gateway.externalServices.republish",
  "gateway.policy.preview": "meshrix.gateway.policyPreview",
  "gateway.forward": "meshrix.gateway.forward",
  "gateway.audit": "meshrix.gateway.audit",
  "gateway.metrics": "meshrix.gateway.metrics",
  "gateway.payload.transit": "meshrix.gateway.payloadTransit",
  "gateway.artifacts.get": "meshrix.gateway.artifacts.get",
  "authorization.roles.list": "meshrix.authorization.roles.list",
  "authorization.roles.upsert": "meshrix.authorization.roles.upsert",
  "authorization.departments.list": "meshrix.authorization.departments.list",
  "authorization.departments.upsert": "meshrix.authorization.departments.upsert",
  "authorization.teams.list": "meshrix.authorization.teams.list",
  "authorization.teams.upsert": "meshrix.authorization.teams.upsert",
  "authorization.users.policies.list": "meshrix.authorization.users.policies.list",
  "authorization.users.policy.upsert": "meshrix.authorization.users.policy.upsert",
  "authorization.agent_groups.list": "meshrix.authorization.agentGroups.list",
  "authorization.agent_groups.upsert": "meshrix.authorization.agentGroups.upsert",
  "authorization.agents.bindings.list": "meshrix.authorization.agents.bindings.list",
  "authorization.agents.binding.upsert": "meshrix.authorization.agents.binding.upsert",
  "authorization.approvals.list": "meshrix.authorization.approvals.list",
  "authorization.approvals.upsert": "meshrix.authorization.approvals.upsert",
  "authorization.approvals.revoke": "meshrix.authorization.approvals.revoke",
  "authorization.receipts.list": "meshrix.authorization.receipts.list",
  "authorization.loan_records.list": "meshrix.authorization.loanRecords.list",
  "authorization.denied_requests.list": "meshrix.authorization.deniedRequests.list",
  "workspace.info": "meshrix.workspace.info",
  "workspace.file.upload": "meshrix.workspace.file.upload",
  "jobs.upload_workspace_materialize": "meshrix.jobs.uploadWorkspaceMaterialize",
  "workspace.file.list": "meshrix.workspace.file.list",
  "workspace.file.download": "meshrix.workspace.file.download",
  "workspace.file.read": "meshrix.workspace.file.read",
  "workspace.file.write": "meshrix.workspace.file.write",
  "workspace.file.patch": "meshrix.workspace.file.patch",
  "workspace.contribution.submit": "meshrix.workspace.contribution.submit",
  "workspace.contribution.list": "meshrix.workspace.contribution.list",
  "workspace.contribution.leaderboard": "meshrix.workspace.contribution.leaderboard",
  "workspace.contribution.stats": "meshrix.workspace.contribution.stats",
  "workspace.contribution.report": "meshrix.workspace.contribution.report",
  "workspace.contribution.assets.list": "meshrix.workspace.contribution.assets.list",
  "workspace.contribution.permission.request": "meshrix.workspace.contribution.permission.request",
  "workspace.contribution.permission.grant": "meshrix.workspace.contribution.permission.grant",
  "workspace.contribution.scan": "meshrix.workspace.contribution.scan",
  "workspace.contribution.review": "meshrix.workspace.contribution.review",
  "workspace.contribution.preview": "meshrix.workspace.contribution.preview",
  "workspace.contribution.publish": "meshrix.workspace.contribution.publish",
  "workspace.contribution.adopt": "meshrix.workspace.contribution.adopt",
  "workspace.contribution.reject": "meshrix.workspace.contribution.reject",
  "workspace.contribution.request_changes": "meshrix.workspace.contribution.requestChanges",
  "workspace.contribution.revoke": "meshrix.workspace.contribution.revoke",
  "workspace.asset.policy.set": "meshrix.workspace.asset.policy.set",
  "workspace.asset.permission.check": "meshrix.workspace.asset.permission.check",
  "workspace.asset.target.connect": "meshrix.workspace.asset.target.connect",
  "workspace.asset.list": "meshrix.workspace.asset.list",
  "workspace.asset.read": "meshrix.workspace.asset.read",
  "workspace.asset.submit": "meshrix.workspace.asset.submit",
  "workspace.asset.mutate": "meshrix.workspace.asset.mutate",
  "workspace.asset.sync.plan": "meshrix.workspace.asset.sync.plan",
  "workspace.asset.sync.apply": "meshrix.workspace.asset.sync.apply",
  "workspace.asset.import": "meshrix.workspace.asset.import",
  "workspace.asset.export": "meshrix.workspace.asset.export",
  "workspace.asset.review.comment": "meshrix.workspace.asset.review.comment",
  "workspace.asset.review.requestChanges": "meshrix.workspace.asset.review.requestChanges",
  "workspace.asset.review.approve": "meshrix.workspace.asset.review.approve",
  "workspace.asset.checkpoint": "meshrix.workspace.asset.checkpoint",
  "workspace.asset.lineage": "meshrix.workspace.asset.lineage",
  "workspace.asset.receipt.get": "meshrix.workspace.asset.receipt.get",
  "workspace.asset.backfill": "meshrix.workspace.asset.backfill",
  "workspace.audit.query": "meshrix.workspace.audit.query",
  "workspace.operation.history": "meshrix.workspace.operation.history",
  "workspace.checkpoint.tree.list": "meshrix.workspace.checkpoint.tree.list",
  "workspace.checkpoint.node.get": "meshrix.workspace.checkpoint.node.get",
  "workspace.checkpoint.diff": "meshrix.workspace.checkpoint.diff",
  "workspace.checkpoint.restore.preview": "meshrix.workspace.checkpoint.restore.preview",
  "workspace.checkpoint.restore": "meshrix.workspace.checkpoint.restore",
  "workspace.checkpoint.scope.query": "meshrix.workspace.checkpoint.scope.query",
  "workspace.operation.revert.scope": "meshrix.workspace.operation.revert.scope",
  "workspace.operation.revert.apply": "meshrix.workspace.operation.revert.apply",
  "workspace.code.target.evaluate": "meshrix.workspace.code.target.evaluate",
  "workspace.code.change.prepare": "meshrix.workspace.code.change.prepare",
  "workspace.code.change.upload": "meshrix.workspace.code.change.upload",
  "workspace.code.change.link": "meshrix.workspace.code.change.link",
  "workspace.code.change.status.sync": "meshrix.workspace.code.change.status.sync"
});

export const INTERNAL_OPERATION_IDS_HIDDEN_FROM_TOOL_CATALOG: any = Object.freeze(new Set<any>([
  "operation_permission.execute",
  "operation_permission.batch",
  "operation_permission.dry_run"
]));

export const TOOL_ALIAS_IDS_BY_OPERATION_ID: Readonly<Record<string, any>> = Object.freeze({
  "agent_workspaces.create": ["meshrix.workspace.create"],
  "agent_workspaces.folder.create": ["meshrix.workspace.folder.create"],
  "agent_workspaces.files.list": ["meshrix.workspace.files.list"],
  "agent_workspaces.file.stat": ["meshrix.workspace.file.stat"],
  "agent_workspaces.file.delete": ["meshrix.workspace.file.delete"],
  "agent_workspaces.file.move": ["meshrix.workspace.file.move"]
});

export const TOOLSET_BY_SCOPE: Readonly<Record<string, any>> = Object.freeze({
  "model:call": "meshrix.model.call",
  "workspace:read": "meshrix.agent.workspace.read",
  "workspace:write": "meshrix.agent.workspace",
  "workspace:maintain": "meshrix.agent.workspace.maintain",
  "storage:read": "meshrix.storage.read",
  "storage:write": "meshrix.storage.write",
  "uploads:write": "meshrix.uploads.write",
  "jobs:read": "meshrix.jobs.read",
  "jobs:write": "meshrix.jobs.write",
  "console:read": "meshrix.console.read",
  "runtime:admin": "meshrix.runtime.maintain",
  "gateway:read": "meshrix.gateway.read",
  "gateway:write": "meshrix.gateway.write",
  "gateway:maintain": "meshrix.gateway.maintain",
  "gateway:admin": "meshrix.gateway.admin",
  "maintenance:read": "meshrix.maintenance.read",
  "maintenance:run": "meshrix.maintenance.run",
  "maintenance:admin": "meshrix.maintenance.maintain",
  "maintenance:approve": "meshrix.maintenance.maintain",
  "agent_sync:publish": "meshrix.agent.sync.publish",
  "auth:admin": "meshrix.authorization.admin"
});

export const RISK_RANK: Readonly<Record<string, any>> = Object.freeze({
  read_only: 0,
  safe_write: 1,
  repair_write: 2,
  destructive: 3
});

export const TOOLSET_BY_ID: any = new Map<any, any>(OPERATION_PERMISSION_TOOLSETS.map((toolset?: any) : any => [toolset.id, toolset]));
