export const CONSOLE_ADMINISTRATION_PLATFORM_WORKFLOWS: readonly any[] = Object.freeze([
  {
    id: "gateway",
    title: "Upstream gateway administration",
    routePaths: ["/admin/upstream-services"],
    viewKeys: ["upstreamServices"],
    featureIds: ["admin.upstream-services", "admin.gateway-routes"],
    actionIds: [
      "admin.upstream-services.list",
      "admin.gateway-routes.audit",
      "admin.gateway-routes.metrics"
    ],
    executorFeatureIds: ["upstream-gateway"],
    operationIds: [
      "external_services.list",
      "gateway.audit",
      "gateway.metrics"
    ],
    sourceFiles: [
      "apps/console/views/admin/UpstreamGatewayView.vue",
      "packages/server-runtime/src/composition/console-domain/operation-executor.ts",
      "packages/server-runtime/src/composition/console-domain/operation-executors/upstream-gateway-executor.ts"
    ],
    stateTokens: ["loading", "error", "empty-copy", "success", "audit", "metrics"],
    verifierFiles: [
      "tools/server-scripts/verify-upstream-gateway-e2e.ts",
      "tools/verifiers/downstream-mcp-completeness-audit.ts"
    ]
  },
  {
    id: "operation-permission-mcp",
    title: "Operation Permission and MCP grant administration",
    routePaths: ["/admin/operation-permission", "/approval"],
    viewKeys: ["operationPermission"],
    featureIds: ["admin.operation-permission", "admin.operation-permission-governance", "approval.workflow"],
    actionIds: [
      "admin.operation-permission.list",
      "admin.operation-permission.update",
      "admin.tools.catalog.inspect",
      "admin.tools.policy.evaluate",
      "admin.tools.grants.manage",
      "approval.mcp-authorize.review",
      "approval.operation-permission-pending.review",
      "approval.refresh"
    ],
    executorFeatureIds: ["operation-permission-passthrough"],
    operationIds: [
      "operation_permission.catalog",
      "operation_permission.grants",
      "operation_permission.create_grant",
      "operation_permission.update_grant",
      "operation_permission.rotate_grant",
      "operation_permission.revoke_grant",
      "operation_permission.policy_preview",
      "operation_permission.audit",
      "operation_permission.metrics_summary",
      "operation_permission.pending_operations.list",
      "operation_permission.pending_operations.resolve"
    ],
    sourceFiles: [
      "apps/console/views/admin/OperationPermissionView.vue",
      "apps/console/views/ApprovalFlowView.vue",
      "apps/console/views/DashboardView.vue",
      "apps/console/components/approval/ApprovalFlowCardList.vue",
      "apps/console/components/shell/side-nav/ConsoleSideNavDirectory.vue",
      "apps/console/composables/console-operation-permission-view-controller.ts",
      "apps/console/composables/console-operation-permission-controller.ts",
      "apps/console/composables/console-operation-permission-pending-controller.ts",
      "apps/console/composables/console-tool-grants-controller.ts",
      "apps/console/composables/console-approval-flow-view-controller.ts",
      "apps/console/composables/console-shell-approval-flow-context.ts",
      "apps/console/composables/useConsole.ts",
      "apps/console/lib/operation-permission-client.ts",
      "apps/console/lib/authorization-governance-client.ts",
      "packages/server-runtime/src/composition/console-domain/operation-executor.ts"
    ],
    stateTokens: [
      "error",
      "busy",
      "issuedToolToken",
      "policyPreviewResult",
      "denied",
      "approvalFlowStatus",
      "operationPermissionPendingOperations",
      "refreshOperationPermissionPendingOperations",
      "resolveOperationPermissionPendingOperation",
      "pendingOperation"
    ],
    verifierFiles: [
      "tools/server-scripts/verify-operation-permission-protocol-consistency.ts",
      "tools/server-scripts/verify-operation-permission-tag-governed-e2e.ts"
    ]
  },
  {
    id: "storage-jobs",
    title: "Storage and jobs administration",
    routePaths: ["/admin/storage", "/admin/jobs"],
    viewKeys: ["storage", "jobs"],
    featureIds: ["admin.storage-control", "admin.jobs-control"],
    actionIds: [
      "admin.storage.overview",
      "admin.storage.maintenance",
      "admin.jobs.list",
      "admin.jobs.control"
    ],
    executorFeatureIds: ["storage", "job-observation"],
    operationIds: [
      "storage.summary",
      "storage.doctor",
      "storage.reconcile",
      "storage.backups.list",
      "storage.backups.create",
      "storage.backups.retention",
      "storage.backups.restore_preview",
      "storage.backups.restore",
      "jobs.list",
      "jobs.get",
      "jobs.work_queue.inspect",
      "jobs.work_queue.recover_failed",
      "jobs.work_queue.rebuild"
    ],
    sourceFiles: [
      "apps/console/views/admin/StorageView.vue",
      "apps/console/views/admin/JobsView.vue",
      "apps/console/composables/console-storage-view-controller.ts",
      "apps/console/lib/jobs-client.ts",
      "packages/server-runtime/src/composition/console-domain/operation-executor.ts",
      "packages/server-runtime/src/composition/queued-job-workflow-provider.ts"
    ],
    stateTokens: ["error", "empty-state", "busy", "restore", "reconcile", "retry"],
    verifierFiles: [
      "tools/server-scripts/verify-backup-restore.ts",
      "tools/server-scripts/verify-storage-production-restore-drill.ts",
      "tools/server-scripts/verify-job-work-queue.ts"
    ]
  },
  {
    id: "release-readiness",
    title: "Release readiness and observability administration",
    routePaths: ["/admin/production-health", "/admin/ops-monitor"],
    viewKeys: ["productionHealth", "opsMonitor"],
    featureIds: ["admin.production-health", "admin.ops-monitor", "admin.logs-observability"],
    actionIds: [
      "admin.production-health.summary",
      "admin.production-health.coverage",
      "admin.production-health.gates",
      "admin.production-health.history",
      "admin.ops-monitor.health",
      "admin.ops-monitor.alerts",
      "admin.logs.list"
    ],
    executorFeatureIds: ["production-readiness", "monitor-alerts", "system-observation"],
    operationIds: [
      "production.health",
      "system.health",
      "system.background_processes",
      "system.monitor_alerts.get",
      "system.monitor_alerts.ack",
      "operation_permission.metrics_summary",
      "operation_permission.metrics_health",
      "operation_permission.metrics_export"
    ],
    sourceFiles: [
      "apps/console/views/admin/ProductionHealthView.vue",
      "apps/console/views/admin/OpsMonitorView.vue",
      "apps/console/components/admin/production-health/ProductionHealthHeroCard.vue",
      "apps/console/components/admin/production-health/ProductionGateTable.vue",
      "apps/console/composables/console-ops-monitor-view-controller.ts",
      "apps/console/lib/operation-permission-client.ts",
      "apps/console/lib/production-health-client.ts",
      "packages/server-runtime/src/composition/console-domain/operation-executor.ts"
    ],
    stateTokens: ["loading", "loadError", "Capability Kernel", "Binding Guard", "alert", "history"],
    verifierFiles: [
      "tools/server-scripts/verify-production-health-console.ts",
      "tools/server-scripts/verify-enterprise-observability-coverage.ts"
    ]
  }
]);
