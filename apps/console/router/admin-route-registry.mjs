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
 * 3. Run: node tests/verify-frontend-route-registry.mjs
 * 4. Run: npm run build
 */

/**
 * @typedef {Object} AdminRouteEntry
 * @property {string} viewKey - Canonical admin view key (camelCase). Stable code identifier.
 * @property {string} slug - URL slug used in /admin/<slug> (kebab-case).
 * @property {string} componentName - Vue component filename (relative to views/admin/).
 * @property {string[]} requiredScopes - Scopes required to render or navigate to the route.
 * @property {string[]} requiredFeatureIds - Runtime features that must all be active.
 * @property {string} section - Navigation section the view belongs to (primary/agent/integration/operationPermission/system/operations/version).
 * @property {string} [description] - Optional description for documentation / tooling.
 */

/** @type {ReadonlyArray<AdminRouteEntry>} */
export const ADMIN_ROUTE_REGISTRY = Object.freeze([
  { viewKey: "storage", slug: "storage", componentName: "StorageView.vue", requiredScopes: ["storage:read"], requiredFeatureIds: ["storage-core"], section: "system", description: "Storage management" },
  { viewKey: "jobs", slug: "jobs", componentName: "JobsView.vue", requiredScopes: ["jobs:read"], requiredFeatureIds: ["work-queue-core"], section: "operations", description: "Job queue and workflow" },
  { viewKey: "logs", slug: "logs", componentName: "LogsView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["devops-core"], section: "system", description: "Runtime logs" },
  { viewKey: "opsMonitor", slug: "ops-monitor", componentName: "OpsMonitorView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["devops-core"], section: "operations", description: "Operations monitor" },
  { viewKey: "strategyManagement", slug: "strategy-management", componentName: "StrategyManagementView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["strategy-management"], section: "system", description: "Strategy management" },
  { viewKey: "tagManagement", slug: "tag-management", componentName: "TagManagementView.vue", requiredScopes: ["auth:admin"], requiredFeatureIds: ["tag-management"], section: "system", description: "Tag and role management" },
  { viewKey: "versionRelease", slug: "version-release", componentName: "VersionReleaseView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["devops-core"], section: "version", description: "Version release" },
  { viewKey: "versionAssembly", slug: "version-assembly", componentName: "VersionAssemblyView.vue", requiredScopes: ["runtime:admin"], requiredFeatureIds: ["module-management-core"], section: "version", description: "Version assembly" },
  { viewKey: "productionHealth", slug: "production-health", componentName: "ProductionHealthView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["devops-core"], section: "version", description: "Production health" },
  { viewKey: "toolList", slug: "tool-list", componentName: "ToolsView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["operation-permission-core"], section: "operationPermission", description: "Tool list" },
  { viewKey: "toolGovernance", slug: "tool-governance", componentName: "ToolsView.vue", requiredScopes: ["gateway:read"], requiredFeatureIds: ["operation-permission-core"], section: "operationPermission", description: "Tool governance" },
  { viewKey: "toolStats", slug: "tool-stats", componentName: "ToolsView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["operation-permission-core"], section: "operationPermission", description: "Tool statistics" },
  { viewKey: "modules", slug: "modules", componentName: "ModulesView.vue", requiredScopes: ["runtime:admin"], requiredFeatureIds: ["module-management-core"], section: "system", description: "Module management" },
  { viewKey: "operationPermission", slug: "operation-permission", componentName: "OperationPermissionView.vue", requiredScopes: ["console:read"], requiredFeatureIds: ["operation-permission-core"], section: "primary", description: "Operation Permission" },
  { viewKey: "agentConfig", slug: "agent-config", componentName: "AgentConfigView.vue", requiredScopes: ["runtime:admin"], requiredFeatureIds: ["agent-gateway"], section: "agent", description: "Agent configuration" },
  { viewKey: "agentAssignment", slug: "agent-assignment", componentName: "AgentAssignmentView.vue", requiredScopes: ["runtime:admin"], requiredFeatureIds: ["agent-gateway"], section: "agent", description: "Agent assignment" },
  { viewKey: "contextManagement", slug: "context-management", componentName: "ContextManagementView.vue", requiredScopes: ["gateway:read"], requiredFeatureIds: ["agent-gateway"], section: "agent", description: "Context management" },
  { viewKey: "upstreamServices", slug: "upstream-services", componentName: "UpstreamGatewayView.vue", requiredScopes: ["gateway:read"], requiredFeatureIds: ["upstream-gateway"], section: "integration", description: "Upstream services" },
  { viewKey: "upstreamServicePublish", slug: "publish-upstream-service", componentName: "UpstreamServicePublishView.vue", requiredScopes: ["gateway:write"], requiredFeatureIds: ["upstream-gateway"], section: "integration", description: "Publish upstream service" },
  { viewKey: "maintenanceAgent", slug: "maintenance-agent", componentName: "MaintenanceAgentView.vue", requiredScopes: ["maintenance:read"], requiredFeatureIds: ["maintenance-agent-runbooks"], section: "operations", description: "Maintenance agent" },
]);

// ─── Derived maps ────────────────────────────────────────────────────────────

/** @type {Record<string, string>} */
export const VIEW_KEY_TO_SLUG = Object.freeze(
  Object.fromEntries(ADMIN_ROUTE_REGISTRY.map((e) => [e.viewKey, e.slug]))
);

/** @type {Record<string, string>} */
export const SLUG_TO_VIEW_KEY = Object.freeze(
  Object.fromEntries(ADMIN_ROUTE_REGISTRY.map((e) => [e.slug, e.viewKey]))
);
