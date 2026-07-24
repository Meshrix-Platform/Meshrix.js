import {
  CORE_FEATURE_INCLUDES,
  INTEGRATIONS_FEATURE_INCLUDES,
  STANDARD_FEATURE_INCLUDES
} from "./feature-manifest-support.mjs";

export {
  DEFAULT_EDITION,
  objectFromEntries,
  uniqueStrings
} from "./feature-manifest-support.mjs";

export const FEATURE_MANIFEST = Object.freeze({
  schemaVersion: "v0.0.1:schema:definition-1",
  label: "Meshrix FeatureManifest",
  groups: Object.freeze([
    "core",
    "security",
    "module-management",
    "data-structure-substrate",
    "storage",
    "devops",
    "capabilities",
    "agent",
    "agent-ingress",
    "client",
    "modules",
    "connectors",
    "industry"
]),
  editions: Object.freeze({
    core: Object.freeze({
      label: "Core",
      includes: CORE_FEATURE_INCLUDES
    }),
    standard: Object.freeze({
      label: "Standard",
      includes: STANDARD_FEATURE_INCLUDES
    }),
    integrations: Object.freeze({
      label: "Integrations",
      includes: INTEGRATIONS_FEATURE_INCLUDES
    })
  }),
  features: Object.freeze([
    {
      featureId: "core-platform",
      label: "Core platform",
      group: "core",
      required: true,
      defaultEnabled: true,
      server: {
        operationFeatures: ["discovery", "events", "runtime", "settings", "system"],
        operations: ["raw_objects.get"],
        webPanels: ["console-shell", "settings-core", "storage"],
        eventTopics: [
          "server.lifecycle",
          "system.interfaces",
          "system.console_state",
          "discovery.config",
          "discovery.clients",
          "runtime.mounts",
          "settings.current",
          "storage.summary"
        ]
      },
      web: {
        navItems: ["dashboard", "approval", "admin.storage", "drawer.discovery", "drawer.users", "drawer.modules"],
        panels: ["ConsoleShell", "StoragePanel", "SettingsDrawer", "ModulesDrawer"]
      },
      package: {
        includePaths: ["apps/server", "apps/console", "packages/server-runtime", "packages/protocols", "docs/architecture/ARCHITECTURE.md"],
        excludePaths: []
      },
      tests: { suites: ["server:verify:core"] }
    },
    {
      featureId: "security-permissions",
      label: "Security and permissions foundation",
      group: "security",
      required: true,
      defaultEnabled: true,
      server: {
        operationFeatures: ["auth"],
        eventTopics: ["auth.audit"]
      },
      package: {
        includePaths: ["packages/foundation/src/security"],
        excludePaths: []
      },
      tests: { suites: ["server:verify:console-auth", "server:verify:security-hardening", "server:verify:operation-policy"] }
    },
    {
      featureId: "security-alerts",
      label: "Security alert lifecycle",
      group: "security",
      dependsOn: ["security-permissions"],
      defaultEnabled: true,
      server: {
        operationFeatures: ["security_alerts"],
        operationPrefixes: ["security_alerts."],
        eventTopics: ["security.alerts"]
      },
      package: {
        includePaths: [
          "packages/foundation/src/security/security-alerts.mjs",
          "packages/contracts/src/operations/operation-registry.mjs",
          "packages/server-runtime/src/composition/console-domain/operation-executor.mjs"
        ],
        excludePaths: []
      },
      tests: { suites: ["tools/server-scripts/verify-security-alert-lifecycle.mjs"] }
    },
    {
      featureId: "tag-management",
      label: "Tag Management",
      group: "security",
      required: true,
      defaultEnabled: true,
      server: {
        operationFeatures: ["tag_management"],
        eventTopics: ["tag_management.updated", "authorization.governance.updated"]
      },
      package: {
        includePaths: ["packages/server-runtime/src/state/tag-management-store.mjs"],
        excludePaths: []
      },
      tests: { suites: ["server:verify:tag-management"] }
    },
    {
      featureId: "operation-dispatcher",
      label: "Operation dispatcher",
      group: "core",
      required: true,
      defaultEnabled: true,
      package: {
        includePaths: ["packages/server-runtime/src/composition", "packages/contracts/src/operations"],
        excludePaths: []
      },
      tests: { suites: ["runtime.operation-dispatch-lock"] }
    },
    {
      featureId: "console-shell",
      label: "Console shell and HTTP controller core",
      group: "core",
      required: true,
      defaultEnabled: true,
      package: {
        includePaths: [
          "packages/protocols/downstream-gateway/console",
          "packages/server-runtime/src/composition/platform-core",
          "packages/foundation/src/observability"
        ],
        excludePaths: []
      },
      tests: { suites: ["server:verify:console-auth"] }
    },
    {
      featureId: "storage-core",
      label: "Storage platform core",
      group: "storage",
      required: true,
      defaultEnabled: true,
      package: {
        includePaths: ["packages/foundation/src/storage"],
        excludePaths: []
      },
      tests: { suites: ["server:verify:storage"] }
    },
    {
      featureId: "module-management-core",
      label: "Explicit plugin and mount runtime core",
      group: "module-management",
      required: true,
      defaultEnabled: true,
      package: {
        includePaths: ["packages/foundation/src/module-system"],
        excludePaths: []
      },
      tests: { suites: ["verify:plugin-runtime"] }
    },
    {
      featureId: "data-structure-substrate-core",
      label: "Shared data structure substrate foundation",
      group: "data-structure-substrate",
      required: true,
      defaultEnabled: true,
      package: {
        includePaths: ["packages/foundation/src/checkpoint/tree"],
        excludePaths: []
      },
      tests: { suites: ["server:verify:state-coordination"] }
    },
    {
      featureId: "devops-core",
      label: "Devops foundation",
      group: "devops",
      required: true,
      defaultEnabled: true,
      server: {
        webPanels: ["logs", "production-health"]
      },
      web: {
        navItems: ["admin.logs", "admin.productionHealth"],
        panels: ["LogPanel", "ProductionHealthPanel"]
      },
      package: {
        includePaths: ["packages/foundation/src/observability"],
        excludePaths: []
      },
      tests: { suites: ["server:verify:ops", "server:verify:monitor-alerts", "server:verify:unified-registration"] }
    },
    {
      featureId: "operation-permission-core",
      label: "Operation Permission policy, grants, audit, and catalog core",
      group: "capabilities",
      required: true,
      defaultEnabled: true,
      server: {
        operationFeatures: ["operation_permission"],
        eventTopics: ["operation_permission.events"],
        webPanels: ["operation-permission-core"]
      },
      web: {
        navItems: ["admin.toolList", "admin.toolStats", "admin.operationPermission"],
        panels: ["OperationPermissionPanel", "AgentPermissionPanel"]
      },
      package: {
        includePaths: [
          "packages/capabilities/src/operation-permission-core",
          "packages/capabilities/src/skills/tool-skill-management-provider.mjs",
          "packages/foundation/config/entity-config/tools"
        ],
        excludePaths: []
      },
      tests: { suites: ["tools/server-scripts/verify-operation-permission-platform.mjs"] }
    },
    {
      featureId: "downstream-mcp",
      label: "Downstream MCP gateway surface",
      group: "capabilities",
      dependsOn: ["operation-permission-core", "security-permissions"],
      defaultEnabled: true,
      server: {
        webPanels: ["mcp-discovery", "operation-permission-core"]
      },
      package: {
        includePaths: [
          "packages/protocols/mcp",
          "packages/protocols/mcp/adapter/native-installer"
        ],
        excludePaths: []
      },
      tests: { suites: ["tools/verifiers/downstream-mcp-completeness-audit.mjs"] }
    },
    {
      featureId: "context-runtime-core",
      label: "Context runtime and compaction substrate",
      group: "agent",
      required: true,
      defaultEnabled: true,
      dependsOn: ["operation-permission-core"],
      server: {
        operationFeatures: ["context_runtime"],
        operationPrefixes: ["context."],
        eventTopics: ["context.runtime"]
      },
      package: {
        includePaths: ["packages/server-runtime/src/state/context-core", "packages/server-runtime/src/state/context-compact"],
        excludePaths: []
      },
      tests: { suites: ["tests/vitest/server/agent-context-interface.test.mjs"] }
    },
    {
      featureId: "agent-memory",
      label: "Agent session memory",
      group: "agent",
      dependsOn: ["operation-permission-core", "context-runtime-core"],
      defaultEnabled: true,
      server: {
        operationFeatures: ["agent_memory"],
        operationPrefixes: ["context.session_memory.", "agent_memory."],
        eventTopics: ["agent.memory.session"]
      },
      package: {
        includePaths: [
          "packages/agents/src/agent-memory",
          "packages/server-runtime/src/state/context-core",
          "packages/server-runtime/src/state/context-compact"
        ],
        excludePaths: []
      },
      tests: { suites: ["tests/vitest/server/agent-context-interface.test.mjs"] }
    },
    {
      featureId: "upstream-gateway",
      label: "Governed upstream service gateway",
      group: "capabilities",
      dependsOn: ["operation-permission-core", "security-permissions"],
      defaultEnabled: true,
      server: {
        operationFeatures: ["gateway", "external_services"],
        operationPrefixes: ["gateway.", "external_services."],
        eventTopics: ["gateway.forwarding", "gateway.audit"],
        webPanels: ["upstream-gateway"]
      },
      web: {
        navItems: ["admin.upstreamServices", "admin.gatewayRoutes"],
        panels: ["UpstreamGatewayPanel"]
      },
      package: {
        includePaths: [
          "packages/agents/src/upstream-gateway",
          "packages/server-runtime/src/composition/console-domain/operation-executor.mjs",
          "tools/server-scripts/verify-upstream-gateway-e2e.mjs"
        ],
        excludePaths: []
      },
      tests: { suites: ["tools/server-scripts/verify-upstream-gateway-e2e.mjs"] }
    },
    {
      featureId: "skill-hub",
      pluginId: "skill-hub",
      label: "Skill Hub package lifecycle and contribution runtime",
      group: "capabilities",
      dependsOn: ["operation-permission-core", "security-permissions"],
      defaultEnabled: false
    },
    {
      featureId: "coding-github",
      pluginId: "coding-github",
      label: "GitHub connector operations and Codespace provider",
      group: "connectors",
      dependsOn: ["operation-permission-core", "security-permissions", "upstream-gateway"],
      defaultEnabled: false
    },
    {
      featureId: "maintenance-agent-runbooks",
      label: "Maintenance Agent runbooks",
      group: "agent",
      dependsOn: ["operation-dispatcher", "operation-permission-core", "security-permissions", "work-queue-core"],
      defaultEnabled: false,
      server: {
        operationFeatures: ["maintenance_agent"],
        operationPrefixes: ["maintenance_agent."],
        eventTopics: ["maintenance.agent.run", "maintenance.agent.audit"],
        webPanels: ["maintenance-agent"]
      },
      web: {
        navItems: ["admin.maintenanceAgent"],
        panels: ["MaintenanceAgentPanel"]
      },
      package: {
        includePaths: [
          "packages/agents/src/maintenance",
          "packages/server-runtime/src/composition/background-workers/maintenance-worker.mjs"
        ],
        excludePaths: []
      },
      tests: {
        suites: [
          "server:verify:maintenance-agent",
          "tests/vitest/server/maintenance-agent-config.test.mjs",
          "tests/vitest/server/maintenance-agent-audit-store.test.mjs"
        ]
      }
    },
    {
      featureId: "strategy-management",
      label: "Workflow and agent invocation strategy management",
      group: "capabilities",
      dependsOn: ["operation-permission-core"],
      defaultEnabled: true,
      server: {
        operationFeatures: ["strategy_management"],
        operationPrefixes: ["strategy."],
        modules: ["StrategyManagementProvider"],
        webPanels: ["strategy-management"]
      },
      package: {
        includePaths: ["packages/server-runtime/src/state", "docs/protocols/PROTOCOLS.md"],
        excludePaths: []
      },
      tests: { suites: ["server:verify:strategy-management"] }
    },
    {
      featureId: "work-queue-core",
      label: "Upload sessions, checkpoints, raw object store, and work queue",
      group: "client",
      required: true,
      defaultEnabled: true,
      server: {
        operationFeatures: ["jobs", "uploads", "raw_objects"],
        eventTopics: ["uploads.session", "uploads.trace", "jobs.job", "jobs.deleted"],
        webPanels: ["work-queue"]
      },
      web: {
        navItems: ["admin.jobs"],
        panels: ["WorkQueuePanel"]
      },
      package: {
        includePaths: [
          "packages/server-runtime/src/state",
          "packages/server-runtime/src/state/upload-session-store.mjs"
        ],
        excludePaths: []
      },
      tests: { suites: ["server:verify:uploads", "server:verify:jobs"] }
    },
    {
      featureId: "agent-workspace-core",
      label: "Agent workspace and governed workspace substrate",
      group: "agent",
      required: true,
      defaultEnabled: true,
      dependsOn: ["operation-dispatcher", "operation-permission-core", "data-structure-substrate-core"],
      package: {
        includePaths: ["packages/agents/src/agent-workspace", "packages/agents/src/workspace-contribution"],
        excludePaths: []
      },
      tests: { suites: ["server:verify:agent-workspace", "server:verify:workspace-file-ops"] }
    },
    {
      featureId: "local-sharedspace",
      pluginId: "shared-space",
      label: "Local Shared Space and agent workspace",
      group: "agent",
      dependsOn: ["agent-workspace-core"],
      defaultEnabled: false
    },
    {
      featureId: "agent-gateway",
      label: "Agent gateway and model routing",
      group: "agent-ingress",
      dependsOn: ["operation-dispatcher", "operation-permission-core", "security-permissions"],
      defaultEnabled: true,
      server: {
        operationFeatures: ["agent_gateway"],
        operationPrefixes: ["agent_gateway.", "model_routing.", "agents."],
        webPanels: ["agent-gateway"]
      },
      package: {
        includePaths: ["packages/agents/src/agent-gateway"],
        excludePaths: []
      },
      tests: { suites: ["server:verify:agent-gateway", "server:verify:model-routing"] }
    },
    {
      featureId: "external-gateway",
      label: "External Gateway",
      group: "agent-ingress",
      dependsOn: ["agent-gateway"],
      defaultEnabled: true,
      server: {
        operations: [
          "runtime.external_gateway",
          "runtime.external_gateway.validate",
          "runtime.external_gateway.apply",
          "runtime.external_gateway.switch_direct"
        ],
        webPanels: ["external-gateway"]
      },
      package: {
        includePaths: ["packages/agents/src/agent-gateway/external-gateway", "tools/server-scripts/external-gateway.mjs"],
        excludePaths: []
      },
      tests: { suites: ["server:verify:external-gateway"] }
    },
    {
      featureId: "agent-management",
      label: "Agent management",
      group: "agent",
      dependsOn: ["agent-gateway", "operation-permission-core"],
      defaultEnabled: false,
      server: {
        operations: ["agents.list", "agents.create", "agents.update", "agents.delete"]
      },
      client: { modules: ["agent-registry"] },
      tests: { suites: ["server:verify:agent-management"] }
    }
])
});
