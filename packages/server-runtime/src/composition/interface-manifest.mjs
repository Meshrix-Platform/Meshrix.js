export const INTERACTIVE_INTERFACE_MANIFEST = Object.freeze({
  version: "v0.0.1:platform:interactive-interface-1",
  layer: "packages/server-runtime/src/composition",
  intent: "Product and service code should consume platform capabilities through the interactive layer first.",
  productApi: Object.freeze({
    module: "#meshrix/product-api",
    interfaces: Object.freeze([
      // Settings
      Object.freeze({ name: "getSettingsPath", source: "#meshrix/settings" }),
      Object.freeze({ name: "loadSettings", source: "#meshrix/settings" }),
      Object.freeze({ name: "resolveModelForModule", source: "#meshrix/settings" }),
      Object.freeze({ name: "saveSettings", source: "#meshrix/settings" }),

      // State coordination
      Object.freeze({ name: "appendJsonLine", source: "#meshrix/state-coordinator" }),
      Object.freeze({ name: "appendJsonLineSerialized", source: "#meshrix/state-coordinator" }),
      Object.freeze({ name: "atomicWriteJson", source: "#meshrix/state-coordinator" }),
      Object.freeze({ name: "atomicWriteJsonThroughState", source: "#meshrix/state-coordinator" }),
      Object.freeze({ name: "mutateState", source: "#meshrix/state-coordinator" }),
      Object.freeze({ name: "queueStateMutation", source: "#meshrix/state-coordinator" }),
      Object.freeze({ name: "readJsonFile", source: "#meshrix/state-coordinator" }),
      Object.freeze({ name: "stateFileKey", source: "#meshrix/state-coordinator" }),
      Object.freeze({ name: "waitForStateIdle", source: "#meshrix/state-coordinator" }),

      // Security and path guards
      Object.freeze({ name: "assertServerToken", source: "#meshrix/client-strings" }),
      Object.freeze({ name: "hashClientString", source: "#meshrix/client-strings" }),
      Object.freeze({ name: "isServerToken", source: "#meshrix/client-strings" }),
      Object.freeze({ name: "resolveWithin", source: "#meshrix/client-strings" }),
      Object.freeze({ name: "serverToken", source: "#meshrix/client-strings" }),

      // Console and protocol helpers
      Object.freeze({ name: "sendJson", source: "#meshrix/http-utils" }),

      // Agent gateway
      Object.freeze({ name: "callAgentGateway", source: "../../../agents/src/agent-gateway/index.mjs" }),
      Object.freeze({ name: "publicAgentGatewayConfig", source: "../../../agents/src/agent-gateway/index.mjs" }),

      // Observability and discovery
      Object.freeze({ name: "createRuntimeLogger", source: "#meshrix/runtime-logger" }),
      Object.freeze({ name: "getRuntimeLogger", source: "#meshrix/runtime-logger" }),
      Object.freeze({ name: "setRuntimeLogger", source: "#meshrix/runtime-logger" }),
      Object.freeze({ name: "summarizeError", source: "#meshrix/runtime-logger" }),
      Object.freeze({ name: "summarizeForLog", source: "#meshrix/runtime-logger" }),
      Object.freeze({ name: "buildBootstrapPayload", source: "./discovery-config.mjs" }),
      Object.freeze({ name: "createCorePlatformProvider", source: "./core-platform-register.mjs" }),
      Object.freeze({ name: "getDiscoveryConfigPath", source: "./discovery-config.mjs" }),
      Object.freeze({ name: "loadDiscoveryConfig", source: "./discovery-config.mjs" }),
      Object.freeze({ name: "resolveDiscoveryState", source: "./discovery-config.mjs" }),
      Object.freeze({ name: "saveDiscoveryConfig", source: "./discovery-config.mjs" }),
      Object.freeze({ name: "createTraceContext", source: "../../foundation/src/observability/trace-context.mjs" }),
      Object.freeze({ name: "setTraceContextOnRequest", source: "../../foundation/src/observability/trace-context.mjs" }),
      Object.freeze({ name: "traceContextFromRequest", source: "../../foundation/src/observability/trace-context.mjs" }),
      Object.freeze({ name: "traceDetails", source: "../../foundation/src/observability/trace-context.mjs" }),

      // Runtime and storage
      Object.freeze({ name: "createServerRuntime", source: "../module-runtime/server-runtime.mjs" }),
      Object.freeze({ name: "createClientRegistryService", source: "../state/client-registry-service.mjs" }),
      Object.freeze({ name: "resolveStoredObjectPath", source: "../../../foundation/src/storage/object-store.mjs" }),

      // Operations and status
      Object.freeze({ name: "bindOperationDispatcher", source: "#meshrix/server-runtime/composition/dispatch-operation" }),
      Object.freeze({ name: "dispatchOperation", source: "#meshrix/server-runtime/composition/dispatch-operation" }),
      Object.freeze({ name: "SERVER_API_OPERATIONS", source: "#meshrix/operation-registry" }),
      Object.freeze({ name: "createOperationProofSubstrate", source: "#meshrix/foundation/proof/proof-substrate/index" }),
      Object.freeze({ name: "composeUnifiedSystemStatus", source: "../devops/unified-registration-core/unified-registration.mjs" }),
      Object.freeze({ name: "normalizeUnifiedRegistration", source: "../devops/unified-registration-core/unified-registration.mjs" }),
      Object.freeze({ name: "unifiedRegistrationForQueue", source: "../devops/unified-registration-core/unified-registration.mjs" }),
      Object.freeze({ name: "unifiedRegistrationForTask", source: "../devops/unified-registration-core/unified-registration.mjs" }),

      // Checkpoint tree
      Object.freeze({ name: "checkpointTreeId", source: "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection" }),
      Object.freeze({ name: "checkpointTreeSummary", source: "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection" }),
      Object.freeze({ name: "deleteCheckpointTree", source: "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection" }),
      Object.freeze({ name: "finishCheckpointTree", source: "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection" }),
      Object.freeze({ name: "listCheckpointTrees", source: "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection" }),
      Object.freeze({ name: "loadCheckpointTree", source: "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection" }),
      Object.freeze({ name: "startCheckpointTree", source: "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection" }),
      Object.freeze({ name: "upsertCheckpointNode", source: "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection" })
    ])
  }),
  platformRegistry: Object.freeze({
    module: "#meshrix/platform-registry",
    interfaces: Object.freeze([
      Object.freeze({ id: "security.auth.console", platform: "security", source: "../security/register.mjs" }),
      Object.freeze({ id: "security.audit.operations", platform: "security", source: "../security/register.mjs" }),
      Object.freeze({ id: "core.provider", platform: "core", source: "../platform-core/register.mjs" }),
      Object.freeze({ id: "core.events.protocol", platform: "core", source: "../platform-core/register.mjs" }),
      Object.freeze({ id: "core.logging.runtime", platform: "core", source: "../platform-core/register.mjs" }),
      Object.freeze({ id: "core.features.runtime", platform: "core", source: "../platform-core/register.mjs" }),
      Object.freeze({ id: "core.execution.sandbox", platform: "core", source: "../execution-sandbox/index.mjs" }),
      Object.freeze({ id: "core.operations.lockManager", platform: "core", source: "./core-platform-register.mjs" }),
      Object.freeze({ id: "core.operations.registry", platform: "core", source: "../platform-core/register.mjs" }),
      Object.freeze({ id: "data-structure-substrate.provider", platform: "data-structure-substrate", source: "#meshrix/foundation/checkpoint/tree/data-structure-substrate-register" }),
      Object.freeze({ id: "checkpoint-tree.projection", platform: "data-structure-substrate", source: "#meshrix/foundation/checkpoint/tree/data-structure-substrate-register" }),
      Object.freeze({ id: "merkle-state.substrate", platform: "data-structure-substrate", source: "#meshrix/foundation/checkpoint/tree/data-structure-substrate-register" }),
      Object.freeze({ id: "text-normalization.substrate", platform: "data-structure-substrate", source: "#meshrix/foundation/checkpoint/tree/data-structure-substrate-register" }),
      Object.freeze({ id: "operation-proof-substrate.provider", platform: "operation-proof-substrate", source: "#meshrix/foundation/proof/proof-substrate/register" }),
      Object.freeze({ id: "operation-proof-substrate.lifecycle", platform: "operation-proof-substrate", source: "#meshrix/foundation/proof/proof-substrate/register" }),
      Object.freeze({ id: "operation-proof-substrate.verify", platform: "operation-proof-substrate", source: "#meshrix/foundation/proof/proof-substrate/register" }),
      Object.freeze({ id: "operation-proof-substrate.export", platform: "operation-proof-substrate", source: "#meshrix/foundation/proof/proof-substrate/register" }),
      Object.freeze({ id: "operation-proof-substrate.recover", platform: "operation-proof-substrate", source: "#meshrix/foundation/proof/proof-substrate/register" }),
      Object.freeze({ id: "operation-proof-substrate.project", platform: "operation-proof-substrate", source: "#meshrix/foundation/proof/proof-substrate/register" }),
      Object.freeze({ id: "storage.provider", platform: "storage", source: "../storage/register.mjs" }),
      Object.freeze({ id: "storage.kernel", platform: "storage", source: "../storage/register.mjs" }),
      Object.freeze({ id: "module-management.provider", platform: "module-management", source: "../module-manager/register.mjs" }),
      Object.freeze({ id: "module-management.serverRuntime", platform: "module-management", source: "../module-manager/register.mjs" }),
      Object.freeze({ id: "module-management.architectureComponents", platform: "module-management", source: "../module-manager/register.mjs" }),
      Object.freeze({ id: "module-management.baseComponents", platform: "module-management", source: "../module-manager/register.mjs" }),
      Object.freeze({ id: "module-management.nonHydratableBaseComponents", platform: "module-management", source: "../module-manager/register.mjs" }),
      Object.freeze({ id: "module-management.hydratableBaseComponents", platform: "module-management", source: "../module-manager/register.mjs" }),
      Object.freeze({ id: "module-management.hydratableComponents", platform: "module-management", source: "../module-manager/register.mjs" }),
      Object.freeze({ id: "module-management.mounts", platform: "module-management", source: "../module-manager/register.mjs" }),
      Object.freeze({ id: "devops.processStatus.get", platform: "devops", source: "../devops/register.mjs" }),
      Object.freeze({ id: "devops.provider", platform: "devops", source: "../devops/register.mjs" }),
      Object.freeze({ id: "devops.monitorAlerts.state", platform: "devops", source: "../devops/register.mjs" }),
      Object.freeze({ id: "devops.monitorAlerts.saveConfig", platform: "devops", source: "../devops/register.mjs" }),
      Object.freeze({ id: "devops.monitorAlerts.runCycle", platform: "devops", source: "../devops/register.mjs" }),
      Object.freeze({ id: "devops.monitorAlerts.acknowledge", platform: "devops", source: "../devops/register.mjs" }),
      Object.freeze({ id: "devops.unifiedRegistration.normalize", platform: "devops", source: "../devops/register.mjs" }),
      Object.freeze({ id: "devops.unifiedRegistration.composeStatus", platform: "devops", source: "../devops/register.mjs" })
    ])
  })
});

export function listInteractiveProductApiInterfaces() {
  return INTERACTIVE_INTERFACE_MANIFEST.productApi.interfaces.map((entry) => entry.name);
}

export function listInteractivePlatformRegistryInterfaces() {
  return INTERACTIVE_INTERFACE_MANIFEST.platformRegistry.interfaces.map((entry) => entry.id);
}
