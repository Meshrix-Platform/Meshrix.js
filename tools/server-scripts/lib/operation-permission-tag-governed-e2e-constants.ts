import { verifierOpaqueServiceId } from "./upstream-gateway-verifier-publication.ts";

export const OPERATION_PERMISSION_TAG_GOVERNED_E2E: Readonly<Record<string, any>> = Object.freeze({
  reportPath: "build/reports/operation-permission-tag-governed-e2e.json",
  mcpInterfaceVersion: "v0.0.1:mcp:interface-1",
  allowTag: "governance:e2e-allow",
  denyTag: "governance:e2e-deny",
  serviceId: verifierOpaqueServiceId("verify-tag-governed-external-service"),
  approvalTool: "meshrix.tagManagement.tags.upsert",
  docId: "verify-tag-governed-document",
  workspaceFileId: "verify-tag-governed-workspace-file",
  consoleResourceId: "verify-tag-governed-console",
  requiredPublicOperations: Object.freeze([
    "meshrix.gateway.forward",
    "meshrix.gateway.audit",
    "meshrix.gateway.metrics",
    "meshrix.workspace.create",
    "meshrix.workspace.file.upload",
    "meshrix.workspace.file.download",
    "meshrix.tagManagement.tags.list",
    "meshrix.tagManagement.tags.upsert",
    "meshrix.operationPermission.audit",
    "meshrix.operationPermission.metricsSummary",
    "meshrix.operationPermission.pendingOperations.list",
    "meshrix.operationPermission.pendingOperations.resolve"
  ])
});

export const TAG_GOVERNED_ENTITY_REFS: Readonly<Record<string, any>> = Object.freeze({
  externalService: {
    entityType: "operation.registry",
    entityId: "external-service-forward",
    capability: "upstream-service"
  },
  document: {
    entityType: "document.asset",
    entityId: OPERATION_PERMISSION_TAG_GOVERNED_E2E.docId,
    capability: "document-access"
  },
  workspace: {
    entityType: "workspace.file",
    entityId: OPERATION_PERMISSION_TAG_GOVERNED_E2E.workspaceFileId,
    capability: "workspace"
  },
  console: {
    entityType: "console.resource",
    entityId: OPERATION_PERMISSION_TAG_GOVERNED_E2E.consoleResourceId,
    capability: "console"
  }
});
