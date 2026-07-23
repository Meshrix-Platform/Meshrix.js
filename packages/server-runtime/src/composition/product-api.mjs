import path from "node:path";
import { createPluginArtifactAuthority } from "../../../foundation/src/module-system/plugin-artifact-authority.mjs";
import { normalizePluginArtifactTrustedPublicKeys } from "../../../foundation/src/module-system/plugin-artifact-trust.mjs";
import { pluginArtifactCoreContractDigest } from "./plugin-artifact-core-contract.mjs";

export { installPluginPackageArchive } from "../../../foundation/src/module-system/plugin-package-artifact-installer.mjs";
export { pluginArtifactCoreContractDigest } from "./plugin-artifact-core-contract.mjs";

export {
  getSettingsPath,
  loadSettings,
  resolveModelForModule,
  saveSettings
} from "#lico/settings";
export {
  appendJsonLine,
  appendJsonLineSerialized,
  atomicWriteJson,
  atomicWriteJsonThroughState,
  mutateState,
  queueStateMutation,
  readJsonFile,
  stateFileKey,
  waitForStateIdle
} from "#lico/state-coordinator";
export {
  assertServerToken,
  hashClientString,
  isServerToken,
  resolveWithin,
  serverToken
} from "#lico/client-strings";
export { sendJson } from "#lico/http-utils";
export async function callAgentGateway(...args) {
  const module = await import("#lico/agents/agent-gateway/index");
  return module.callAgentGateway(...args);
}
export async function publicAgentGatewayConfig(...args) {
  const module = await import("#lico/agents/agent-gateway/index");
  return module.publicAgentGatewayConfig(...args);
}
export {
  createRuntimeLogger,
  getRuntimeLogger,
  setRuntimeLogger,
  summarizeError,
  summarizeForLog
} from "#lico/runtime-logger";
export {
  buildBootstrapPayload,
  getDiscoveryConfigPath,
  loadDiscoveryConfig,
  resolveDiscoveryState,
  saveDiscoveryConfig
} from "./discovery-config.mjs";
export { createCorePlatformProvider } from "#lico/server-runtime/composition/core-platform-provider";
export {
  createTraceContext,
  setTraceContextOnRequest,
  traceContextFromRequest,
  traceDetails
} from "#lico/foundation/observability/trace-context";
export { createClientRegistryService } from "../state/client-registry-service.mjs";
export { resolveStoredObjectPath } from "#lico/foundation/storage/object-store";
export { bindOperationDispatcher, dispatchOperation } from "./dispatch-operation.mjs";
export { SERVER_API_OPERATIONS } from "#lico/operation-registry";
export {
  composeUnifiedSystemStatus,
  normalizeUnifiedRegistration,
  unifiedRegistrationForQueue,
  unifiedRegistrationForTask
} from "./unified-registration.mjs";
export {
  checkpointTreeId,
  checkpointTreeSummary,
  deleteCheckpointTree,
  finishCheckpointTree,
  listCheckpointTrees,
  loadCheckpointTree,
  startCheckpointTree,
  upsertCheckpointNode
} from "#lico/foundation/checkpoint/tree/checkpoint-tree-projection";
export async function removeImportCheckpoint() {
  return undefined;
}
export {
  createDurableWorkflowSubstrate,
  DURABLE_WORKFLOW_SUBSTRATE_PROTOCOL_VERSION,
  verifyWorkflowHistory,
  workflowId
} from "#lico/foundation/workflow/durable-workflow-substrate";

import { createServerRuntime as createCommonServerRuntime } from "../module-runtime/server-runtime.mjs";

export async function createServerRuntime(options = {}) {
  const pluginHostPorts = options.pluginHostPorts || {};
  const artifactAuthority = pluginHostPorts.artifactAuthority || await createPluginArtifactAuthority({
    artifactRoot: path.join(options.userDataPath, "plugin-artifacts"),
    trustedPublicKeys: normalizePluginArtifactTrustedPublicKeys(
      options.runtimeOptions?.pluginArtifactTrustedPublicKeys || {}
    ),
    artifactSigner: null,
    secretRef: "",
    coreContractDigest: pluginArtifactCoreContractDigest()
  });
  return createCommonServerRuntime({
    ...options,
    pluginHostPorts: { ...pluginHostPorts, artifactAuthority },
    builtinMountProviders: {}
  });
}
