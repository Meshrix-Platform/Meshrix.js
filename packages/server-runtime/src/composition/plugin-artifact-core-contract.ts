import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { createHash } from "node:crypto";

import { SERVER_API_OPERATIONS } from "#meshrix/operation-registry";
import { PLUGIN_BUNDLE_MANIFEST_SCHEMA } from "#meshrix/contracts/plugins/plugin-bundle-manifest";
import { PLUGIN_MANIFEST_SCHEMA_VERSION } from "#meshrix/foundation/module-system/plugin-registry";

export const PLUGIN_HOST_PORT_CONTRACT: Readonly<Record<string, any>> = Object.freeze({
  workspaceAccess: Object.freeze(["readTextFile", "writeTextFile"]),
  securityPermissions: Object.freeze(["appendLoanRecord"]),
  securityAlertStore: Object.freeze(["appendAlert"]),
  processIdentity: Object.freeze(["verifyClientIdentityRevocationReceipt"]),
  operationPermissionPlatform: Object.freeze(["registerChangeHandler"]),
  operationPermissionGrant: Object.freeze(["recordPluginGrant"]),
  externalService: Object.freeze(["request"]),
  delegatedMcpGrantBroker: Object.freeze(["createDelegatedMcpGrant", "revokeDelegatedMcpGrant"]),
  agentWorkspace: Object.freeze([
    "connectLocalDirectory",
    "listLocalDirectoryMounts",
    "listLocalDirectoryItems",
    "listWorkspaceFiles",
    "localDirectoryItemMetadata",
    "readLocalDirectoryFile",
    "downloadWorkspaceFile",
    "writeLocalDirectoryFile",
    "uploadWorkspaceFile",
    "deleteLocalDirectoryItem",
    "deleteWorkspaceFile",
    "createLocalDirectoryFolder",
    "moveLocalDirectoryItem",
    "localDirectorySyncPlan",
    "applyLocalDirectorySync",
    "restoreWorkspaceFiles",
    "getWorkspaceSandboxMutationReceipt"
  ]),
  sandboxExecution: Object.freeze([
    "execute",
    "executeConfigured",
    "executeOpaque",
    "executeConfiguredOpaque",
    "cancel",
    "getStatus",
    "getReceipt",
    "resolveQuarantinedOutput",
    "disposeOutput"
  ]),
  opaqueArtifactCustody: Object.freeze(["store", "describe", "delete"])
});


export function pluginArtifactCoreContract() : any {
  return Object.freeze({
    schemaVersion: "v0.0.1:meshrix:plugin-host-contract-1",
    bundleManifestSchema: PLUGIN_BUNDLE_MANIFEST_SCHEMA,
    runtimeManifestSchema: PLUGIN_MANIFEST_SCHEMA_VERSION,
    operationIds: Object.freeze(SERVER_API_OPERATIONS.map((operation?: any) : any => operation.id).sort()),
    hostPorts: PLUGIN_HOST_PORT_CONTRACT
  });
}

export function pluginArtifactCoreContractDigest() : any {
  return `sha256:${createHash("sha256").update(canonicalJson(pluginArtifactCoreContract())).digest("hex")}`;
}
