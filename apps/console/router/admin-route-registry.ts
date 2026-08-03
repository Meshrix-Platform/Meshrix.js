/**
 * ADMIN ROUTE REGISTRY — PURE DATA (SINGLE SOURCE OF TRUTH)
 *
 * Every admin view is registered here exactly once with its canonical viewKey
 * (camelCase) and URL slug (kebab-case).  viewToPath(), adminSectionToSlug(),
 * and slugToAdminView() are all derived from this registry.
 *
 * This file is pure data — safe to import by Node verifiers, tests, and
 * the Vue router builder.  No import.meta.glob, no Vue components, no Vite
 * dependencies.
 *
 * REGISTRATION FLOW:
 * 1. Add a viewKey + slug + componentName + description here.
 * 2. Create the corresponding .vue file under views/admin/.
 * 3. Run: node tests/verify-frontend-route-registry.ts
 * 4. Run: npm run build
 */

/**
 * @typedef {Object} AdminRouteEntry
 * @property {string} viewKey - Canonical admin view key (camelCase). Stable code identifier.
 * @property {string} slug - URL slug used in /admin/<slug> (kebab-case).
 * @property {string} componentName - Vue component filename (relative to views/admin/).
 * @property {string[]} requiredScopes - Scopes required to render or navigate to the route.
 * @property {string[]} requiredFeatureIds - Runtime features that must all be active.
 * @property {string} section - Navigation section the view belongs to (primary/service/tools/permission/model/system/operations/version).
 * @property {string} [description] - Optional description for documentation / tooling.
 */

/** @type {ReadonlyArray<AdminRouteEntry>} */
export const ADMIN_ROUTE_REGISTRY: readonly any[] = Object.freeze([
  { viewKey: "operationPermission", slug: "operation-permission", componentName: "OperationPermissionView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["operation-permission-core"], section: "primary", description: "Operation Permission" },
  { viewKey: "upstreamServices", slug: "upstream-services", componentName: "UpstreamGatewayView.vue", requiredScopes: ["gateway:read"], requiredFeatureIds: ["upstream-gateway"], section: "service", description: "Upstream services" },
  { viewKey: "upstreamServicePublish", slug: "publish-upstream-service", componentName: "UpstreamServicePublishView.vue", requiredScopes: ["gateway:write"], requiredFeatureIds: ["upstream-gateway"], section: "service", description: "Publish upstream service" },
  { viewKey: "toolList", slug: "tool-list", componentName: "ToolsView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["operation-permission-core"], section: "tools", description: "Tool list" },
  { viewKey: "toolGovernance", slug: "tool-governance", componentName: "ToolsView.vue", requiredScopes: ["gateway:read"], requiredFeatureIds: ["operation-permission-core"], section: "tools", description: "Tool governance" },
  { viewKey: "toolStats", slug: "tool-stats", componentName: "ToolsView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["operation-permission-core"], section: "tools", description: "Tool statistics" },
  { viewKey: "tagManagement", slug: "tag-management", componentName: "TagManagementView.vue", requiredScopes: ["auth:admin"], requiredFeatureIds: ["tag-management"], section: "permission", description: "Tag and role management" },
  { viewKey: "organizationGovernance", slug: "organization-governance", componentName: "OrganizationGovernanceView.vue", requiredScopes: ["auth:admin"], requiredFeatureIds: ["security-permissions"], section: "permission", description: "Organization governance template" },
  { viewKey: "apiKeyDistribution", slug: "api-key-distribution", componentName: "ApiKeyDistributionView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["operation-permission-core", "security-permissions"], section: "permission", description: "Scoped API key distribution" },
  { viewKey: "agentConfig", slug: "agent-config", componentName: "AgentConfigView.vue", requiredScopes: ["runtime:admin"], requiredFeatureIds: ["agent-gateway"], section: "model", description: "Agent configuration" },
  { viewKey: "agentAssignment", slug: "agent-assignment", componentName: "AgentAssignmentView.vue", requiredScopes: ["runtime:admin"], requiredFeatureIds: ["agent-gateway"], section: "model", description: "Agent assignment" },
  { viewKey: "contextManagement", slug: "context-management", componentName: "ContextManagementView.vue", requiredScopes: ["gateway:read"], requiredFeatureIds: ["agent-gateway"], section: "model", description: "Context management" },
  { viewKey: "storage", slug: "storage", componentName: "StorageView.vue", requiredScopes: ["storage:read"], requiredFeatureIds: ["storage-core"], section: "system", description: "Storage management" },
  { viewKey: "logs", slug: "logs", componentName: "LogsView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["devops-core"], section: "system", description: "Runtime logs" },
  { viewKey: "strategyManagement", slug: "strategy-management", componentName: "StrategyManagementView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["strategy-management"], section: "system", description: "Strategy management" },
  { viewKey: "modules", slug: "modules", componentName: "ModulesView.vue", requiredScopes: ["runtime:admin"], requiredFeatureIds: ["module-management-core"], section: "system", description: "Module management" },
  { viewKey: "jobs", slug: "jobs", componentName: "JobsView.vue", requiredScopes: ["jobs:read"], requiredFeatureIds: ["work-queue-core"], section: "operations", description: "Job queue and workflow" },
  { viewKey: "opsMonitor", slug: "ops-monitor", componentName: "OpsMonitorView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["devops-core"], section: "operations", description: "Operations monitor" },
  { viewKey: "maintenanceAgent", slug: "maintenance-agent", componentName: "MaintenanceAgentView.vue", requiredScopes: ["maintenance:read"], requiredFeatureIds: ["maintenance-agent-runbooks"], section: "operations", description: "Maintenance agent" },
  { viewKey: "versionRelease", slug: "version-release", componentName: "VersionReleaseView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["devops-core"], section: "version", description: "Version release" },
  { viewKey: "versionAssembly", slug: "version-assembly", componentName: "VersionAssemblyView.vue", requiredScopes: ["runtime:admin"], requiredFeatureIds: ["module-management-core"], section: "version", description: "Version assembly" },
  { viewKey: "productionHealth", slug: "production-health", componentName: "ProductionHealthView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["devops-core"], section: "version", description: "Production health" },
]);

// ─── Derived maps ────────────────────────────────────────────────────────────

/** @type {Record<string, string>} */
export const VIEW_KEY_TO_SLUG: any = Object.freeze(
  Object.fromEntries(ADMIN_ROUTE_REGISTRY.map((e?: any) : any => [e.viewKey, e.slug]))
);

/** @type {Record<string, string>} */
export const SLUG_TO_VIEW_KEY: any = Object.freeze(
  Object.fromEntries(ADMIN_ROUTE_REGISTRY.map((e?: any) : any => [e.slug, e.viewKey]))
);
