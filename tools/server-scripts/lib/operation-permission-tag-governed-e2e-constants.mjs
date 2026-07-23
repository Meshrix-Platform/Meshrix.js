import { verifierOpaqueServiceId } from "./upstream-gateway-verifier-publication.mjs";

export const OPERATION_PERMISSION_TAG_GOVERNED_E2E = Object.freeze({
  reportPath: "build/reports/operation-permission-tag-governed-e2e.json",
  mcpInterfaceVersion: "v0.0.1:mcp:interface-1",
  allowTag: "governance:e2e-allow",
  denyTag: "governance:e2e-deny",
  serviceId: verifierOpaqueServiceId("verify-tag-governed-external-service"),
  approvalTool: "lico.tagManagement.tags.upsert",
  docId: "verify-tag-governed-document",
  workspaceFileId: "verify-tag-governed-workspace-file",
  consoleResourceId: "verify-tag-governed-console",
  requiredPublicOperations: Object.freeze([
    "lico.gateway.forward",
    "lico.gateway.audit",
    "lico.gateway.metrics",
    "lico.workspace.create",
    "lico.workspace.file.upload",
    "lico.workspace.file.download",
    "lico.tagManagement.tags.list",
    "lico.tagManagement.tags.upsert",
    "lico.operationPermission.audit",
    "lico.operationPermission.metricsSummary",
    "lico.operationPermission.pendingOperations.list",
    "lico.operationPermission.pendingOperations.resolve"
  ])
});

export const TAG_GOVERNED_ENTITY_REFS = Object.freeze({
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
