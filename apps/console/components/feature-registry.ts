// Tier-3 feature-local component registry — declaration of record for component
// ownership tiers (Node N19 / REQ-020; design artifact component-tiers.md section 3).
//
// Tier rules — the reuse gate at tools/server-scripts/verify-console-component-reuse.ts
// reads this module and apps/console/components/common.ts as TEXT from Node tooling:
//   - Tier 1: primitives in packages/ui-console/src are declared by their package
//     import (import X from "@meshrix/ui-console/..."); no registry rows are needed —
//     the rule is documented here only.
//   - Tier 2: console commons at the components root are declared in common.ts via
//     CommonComponentRegistration entries carrying a `tier` field.
//   - Tier 3: feature-local components under a feature subdirectory — declared below.
//
// The gate's path scan treats every path literal below as a Tier-3 declaration, so each
// entry must be a real component path and each path appears exactly once. Keep this
// module import-free: the gate and the vitest suite load it from Node tooling.
//
// Feature ids are the immediate parent directory names of each component; the frozen
// vocabulary below is the union of those names.

export type ComponentTierDeclaration = {
  path: string;
  feature: string;
};

/** Frozen feature id vocabulary (immediate parent directory names under the components root). */
export const componentFeatureIdVocabulary: readonly string[] = Object.freeze([
  "admin",
  "agent-config",
  "approval",
  "authorization-governance",
  "dashboard",
  "detail",
  "modules",
  "operation-permission",
  "ops-monitor",
  "production-health",
  "service-discovery",
  "shell",
  "side-nav",
  "storage",
  "upload",
  "version-release",
  "workspaces",
]);

/** Every Tier-3 component: repo-relative component path bound to its owning feature id. Sorted by path. */
export const componentFeatureRegistry: readonly ComponentTierDeclaration[] = Object.freeze([
  { path: "apps/console/components/admin/AuthorizationGovernanceCard.vue", feature: "admin" },
  { path: "apps/console/components/admin/authorization-governance/AuthorizationGovernanceEditor.vue", feature: "authorization-governance" },
  { path: "apps/console/components/admin/authorization-governance/AuthorizationGovernanceGrid.vue", feature: "authorization-governance" },
  { path: "apps/console/components/admin/authorization-governance/AuthorizationGovernanceMetrics.vue", feature: "authorization-governance" },
  { path: "apps/console/components/admin/authorization-governance/AuthorizationGovernancePanel.vue", feature: "authorization-governance" },
  { path: "apps/console/components/admin/modules/RuntimeModuleConfigItem.vue", feature: "modules" },
  { path: "apps/console/components/admin/modules/RuntimeModuleGroup.vue", feature: "modules" },
  { path: "apps/console/components/admin/modules/RuntimeModulesPanel.vue", feature: "modules" },
  { path: "apps/console/components/admin/operation-permission/GrantToolRulePanel.vue", feature: "operation-permission" },
  { path: "apps/console/components/admin/operation-permission/ToolGrantCreateCard.vue", feature: "operation-permission" },
  { path: "apps/console/components/admin/operation-permission/ToolGrantListCard.vue", feature: "operation-permission" },
  { path: "apps/console/components/admin/operation-permission/ToolPolicyPreviewPanel.vue", feature: "operation-permission" },
  { path: "apps/console/components/admin/ops-monitor/OpsMonitorAlertsPanel.vue", feature: "ops-monitor" },
  { path: "apps/console/components/admin/ops-monitor/OpsMonitorProcessTable.vue", feature: "ops-monitor" },
  { path: "apps/console/components/admin/ops-monitor/OpsMonitorSummaryCard.vue", feature: "ops-monitor" },
  { path: "apps/console/components/admin/production-health/ProductionCoverageWarning.vue", feature: "production-health" },
  { path: "apps/console/components/admin/production-health/ProductionGateTable.vue", feature: "production-health" },
  { path: "apps/console/components/admin/production-health/ProductionHealthBottomGrid.vue", feature: "production-health" },
  { path: "apps/console/components/admin/production-health/ProductionHealthHeroCard.vue", feature: "production-health" },
  { path: "apps/console/components/admin/production-health/ProductionSectionGrid.vue", feature: "production-health" },
  { path: "apps/console/components/admin/storage/StorageDiscoveryCard.vue", feature: "storage" },
  { path: "apps/console/components/admin/storage/StorageOverviewCard.vue", feature: "storage" },
  { path: "apps/console/components/admin/storage/StorageRuntimeCard.vue", feature: "storage" },
  { path: "apps/console/components/admin/storage/StorageSessionCard.vue", feature: "storage" },
  { path: "apps/console/components/admin/version-release/VersionReleaseBaselineCard.vue", feature: "version-release" },
  { path: "apps/console/components/admin/version-release/VersionReleaseReadinessCard.vue", feature: "version-release" },
  { path: "apps/console/components/approval/ApprovalFlowCardList.vue", feature: "approval" },
  { path: "apps/console/components/dashboard/DashboardPluginCard.vue", feature: "dashboard" },
  { path: "apps/console/components/shell/ConsoleAuthGate.vue", feature: "shell" },
  { path: "apps/console/components/shell/ConsoleAuthUsersPanel.vue", feature: "shell" },
  { path: "apps/console/components/shell/ConsoleCommandPalette.vue", feature: "shell" },
  { path: "apps/console/components/shell/ConsoleDrawer.vue", feature: "shell" },
  { path: "apps/console/components/shell/ConsolePreferencesPanel.vue", feature: "shell" },
  { path: "apps/console/components/shell/ConsoleRuntimeModulesPanel.vue", feature: "shell" },
  { path: "apps/console/components/shell/ConsoleServiceDiscoveryPanel.vue", feature: "shell" },
  { path: "apps/console/components/shell/ConsoleSideNav.vue", feature: "shell" },
  { path: "apps/console/components/shell/ConsoleTopbar.vue", feature: "shell" },
  { path: "apps/console/components/shell/ServerPathPickerDialog.vue", feature: "shell" },
  { path: "apps/console/components/shell/service-discovery/ConsoleServerAddressRow.vue", feature: "service-discovery" },
  { path: "apps/console/components/shell/service-discovery/ConsoleServiceDiscoverySaveBar.vue", feature: "service-discovery" },
  { path: "apps/console/components/shell/service-discovery/ConsoleServiceIdentityFields.vue", feature: "service-discovery" },
  { path: "apps/console/components/shell/side-nav/ConsoleSideNavBackdrop.vue", feature: "side-nav" },
  { path: "apps/console/components/shell/side-nav/ConsoleSideNavBrand.vue", feature: "side-nav" },
  { path: "apps/console/components/shell/side-nav/ConsoleSideNavDirectory.vue", feature: "side-nav" },
  { path: "apps/console/components/shell/side-nav/ConsoleSideNavFooter.vue", feature: "side-nav" },
  { path: "apps/console/components/shell/side-nav/ConsoleSideNavLink.vue", feature: "side-nav" },
  { path: "apps/console/components/shell/side-nav/ConsoleSideNavOperationsSection.vue", feature: "side-nav" },
  { path: "apps/console/components/shell/side-nav/ConsoleSideNavPermissionSection.vue", feature: "side-nav" },
  { path: "apps/console/components/shell/side-nav/ConsoleSideNavPrimaryLinks.vue", feature: "side-nav" },
  { path: "apps/console/components/shell/side-nav/ConsoleSideNavServiceSection.vue", feature: "side-nav" },
  { path: "apps/console/components/shell/side-nav/ConsoleSideNavSystemSection.vue", feature: "side-nav" },
  { path: "apps/console/components/shell/side-nav/ConsoleSideNavToolsSection.vue", feature: "side-nav" },
  { path: "apps/console/components/shell/side-nav/ConsoleSideNavVersionSection.vue", feature: "side-nav" },
  { path: "apps/console/components/upload/UploadFileListRow.vue", feature: "upload" },
  { path: "apps/console/components/upload/UploadSplitButton.vue", feature: "upload" },
  { path: "apps/console/components/workspaces/WorkspaceCheckpointPanel.vue", feature: "workspaces" },
  { path: "apps/console/components/workspaces/WorkspaceDeleteAction.vue", feature: "workspaces" },
  { path: "apps/console/components/workspaces/WorkspaceDetailPanel.vue", feature: "workspaces" },
  { path: "apps/console/components/workspaces/WorkspaceExpandedDetail.vue", feature: "workspaces" },
  { path: "apps/console/components/workspaces/WorkspaceExpandedOverview.vue", feature: "workspaces" },
  { path: "apps/console/components/workspaces/WorkspaceResolvedProfilePanel.vue", feature: "workspaces" },
  { path: "apps/console/components/workspaces/detail/WorkspaceAssetPanel.vue", feature: "detail" },
  { path: "apps/console/components/workspaces/detail/WorkspaceCreatePanel.vue", feature: "detail" },
  { path: "apps/console/components/workspaces/detail/WorkspaceParentPanel.vue", feature: "detail" },
  { path: "apps/console/components/workspaces/detail/WorkspaceProfilePanel.vue", feature: "detail" },
  { path: "apps/console/components/workspaces/detail/WorkspaceSharePanel.vue", feature: "detail" },
]);
