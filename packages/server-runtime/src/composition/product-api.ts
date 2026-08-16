import path from "node:path";
import { createPluginArtifactAuthority } from "#meshrix/foundation/module-system/plugin-artifact-authority";
import { normalizePluginArtifactTrustedPublicKeys } from "#meshrix/foundation/module-system/plugin-artifact-trust";
import { pluginArtifactCoreContractDigest } from "./plugin-artifact-core-contract.ts";

export { installPluginPackageArchive } from "#meshrix/foundation/module-system/plugin-package-artifact-installer";
export { pluginArtifactCoreContractDigest } from "./plugin-artifact-core-contract.ts";

export {
  getSettingsPath,
  loadSettings,
  saveSettings
} from "#meshrix/settings";
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
} from "#meshrix/state-coordinator";
export {
  assertServerToken,
  hashClientString,
  isServerToken,
  resolveWithin,
  serverToken
} from "#meshrix/client-strings";
export { sendJson } from "#meshrix/http-utils";
export {
  createRuntimeLogger,
  getRuntimeLogger,
  setRuntimeLogger,
  summarizeError,
  summarizeForLog
} from "#meshrix/runtime-logger";
export {
  buildBootstrapPayload,
  getDiscoveryConfigPath,
  loadDiscoveryConfig,
  resolveDiscoveryState,
  saveDiscoveryConfig
} from "./discovery-config.ts";
export { createCorePlatformProvider } from "#meshrix/server-runtime/composition/core-platform-provider";
export {
  createTraceContext,
  setTraceContextOnRequest,
  traceContextFromRequest,
  traceDetails
} from "#meshrix/foundation/observability/trace-context";
export { createClientRegistryService } from "../state/client-registry-service.ts";
export { resolveStoredObjectPath } from "#meshrix/foundation/storage/object-store";
export { bindOperationDispatcher, dispatchOperation } from "./dispatch-operation.ts";
export { SERVER_API_OPERATIONS } from "#meshrix/operation-registry";
export {
  composeUnifiedSystemStatus,
  normalizeUnifiedRegistration,
  unifiedRegistrationForQueue,
  unifiedRegistrationForTask
} from "./unified-registration.ts";
export {
  checkpointTreeId,
  checkpointTreeSummary,
  deleteCheckpointTree,
  finishCheckpointTree,
  listCheckpointTrees,
  loadCheckpointTree,
  startCheckpointTree,
  upsertCheckpointNode
} from "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection";
export async function removeImportCheckpoint(_input?: any) : Promise<any> {
  return undefined;
}
export {
  createDurableWorkflowSubstrate,
  DURABLE_WORKFLOW_SUBSTRATE_PROTOCOL_VERSION,
  verifyWorkflowHistory,
  workflowId
} from "#meshrix/foundation/workflow/durable-workflow-substrate";

import { createServerRuntime as createCommonServerRuntime } from "../module-runtime/server-runtime.ts";

export async function createServerRuntime(options: Record<string, any> = {}) : Promise<any> {
  const pluginHostPorts: any = options.pluginHostPorts || {};
  const artifactAuthority: any = pluginHostPorts.artifactAuthority || await createPluginArtifactAuthority({
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
