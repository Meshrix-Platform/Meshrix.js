import type { CreateMaterializationRuntimeOptions } from "../jobs/upload-workspace-materialization/runtime.ts";

import {
  assertAgentWorkspaceMaterializationPort
} from "#meshrix/agents/agent-workspace/agent-workspace-materialization-port";
import {
  createUploadWorkspaceMaterializationRuntime
} from "../jobs/upload-workspace-materialization/index.ts";

/**
 * Composition wiring for governed upload-workspace materialization.
 *
 * This adapter only obtains the root-owned workspace materialization port and
 * injects concrete dependencies into the feature runtime. Queue admission,
 * reconciliation, execution, cancellation and the store/queue lifetime are
 * owned by `jobs/upload-workspace-materialization/runtime.ts`.
 */
export async function createUploadWorkspaceMaterializationProvider({
  userDataPath,
  queueApplicationPort,
  workspaceMaterializationPort,
  uploadSessionStore,
  uploadCustodyReadPort,
  deferredProtectedSinkAuthorityPort,
  resolveOperation,
  operationAuditStore,
  operationProofSubstrate,
  transactionStore = null,
  faultInjector = null
}: Omit<CreateMaterializationRuntimeOptions, "privateWorkspaceMaterializationPort"> & { workspaceMaterializationPort: unknown }) {
  const privateWorkspaceMaterializationPort =
    assertAgentWorkspaceMaterializationPort(
      workspaceMaterializationPort
    );
  return createUploadWorkspaceMaterializationRuntime({
    userDataPath,
    queueApplicationPort,
    privateWorkspaceMaterializationPort,
    uploadSessionStore,
    uploadCustodyReadPort,
    deferredProtectedSinkAuthorityPort,
    resolveOperation,
    operationAuditStore,
    operationProofSubstrate,
    transactionStore,
    faultInjector
  });
}
