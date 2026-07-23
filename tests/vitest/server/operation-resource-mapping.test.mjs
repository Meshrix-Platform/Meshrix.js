import { describe, expect, it } from "vitest";

import { createToolCatalog } from "../../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.mjs";

const FIELD_GROUPS = Object.freeze({
  tenantId: ["tenantId", "tenant-id"],
  workspaceId: [
    "workspaceId",
    "workspace",
    "workspace-id",
    "workspaceIds",
    "workspace-ids",
    "allowedWorkspaceIds",
    "allowed-workspace-ids",
    "registryWorkspaceId",
    "registry-workspace-id",
    "targetWorkspaceId",
    "target-workspace-id",
    "parentWorkspaceId",
    "parent-workspace-id"
  ],
  serviceId: ["serviceId", "service-id", "serviceIds", "service-ids", "allowedServiceIds", "allowed-service-ids", "upstreamId", "upstream-id"],
  secretBindingId: [
    "secretBindingId",
    "secret-binding-id",
    "secretBindingIds",
    "secret-binding-ids",
    "allowedSecretBindings",
    "allowed-secret-bindings",
    "authBindingId",
    "auth-binding-id",
    "bindingId",
    "binding-id",
    "credentialRef",
    "credentialRefs",
    "secretRef",
    "secretRefs"
  ]
});

function collectBindingNames(bindings = [], output = new Set()) {
  for (const binding of bindings || []) {
    if (!binding || typeof binding !== "object") {
      continue;
    }
    if (binding.name) {
      output.add(String(binding.name));
    }
    for (const alias of binding.aliases || []) {
      output.add(String(alias));
    }
  }
  return output;
}

function operationFieldNames(operation = {}) {
  const output = new Set(Object.keys(operation.inputSchema?.properties || {}));
  collectBindingNames(operation.http?.params, output);
  collectBindingNames(operation.http?.query, output);
  collectBindingNames(operation.rpc?.params, output);
  collectBindingNames(operation.rpc?.query, output);
  collectBindingNames(operation.cli?.bodyParams, output);
  for (const [name, aliases] of Object.entries(operation.cli?.pathParams || {})) {
    output.add(name);
    for (const alias of aliases || []) {
      output.add(String(alias));
    }
  }
  return output;
}

function operationById(id) {
  return SERVER_API_OPERATIONS.find((operation) => operation.id === id);
}

describe("operation resource mapping", () => {
  it("decorates all server operations with authorization resource metadata", () => {
    expect(SERVER_API_OPERATIONS.length).toBeGreaterThan(0);
    for (const operation of SERVER_API_OPERATIONS) {
      expect(operation.resource, operation.id).toEqual(expect.objectContaining({
        capabilityDomain: expect.any(String),
        resourceKind: expect.any(String),
        capabilityVerb: expect.any(String),
        effectKind: expect.any(String),
        fieldMap: expect.any(Object)
      }));
      expect(operation.resource.resourceKind, operation.id).not.toBe("");
      expect(operation.resourceContext, operation.id).toMatchObject(operation.resource);
    }
  });

  it("maps resource-bearing request fields to ABAC keys", () => {
    const mappedOperations = [];

    for (const operation of SERVER_API_OPERATIONS) {
      const fields = operationFieldNames(operation);
      for (const [resourceKey, aliases] of Object.entries(FIELD_GROUPS)) {
        const presentAliases = aliases.filter((alias) => fields.has(alias));
        if (presentAliases.length === 0) {
          continue;
        }
        mappedOperations.push(operation.id);
        expect(operation.resource.fieldMap[resourceKey], `${operation.id}:${resourceKey}`)
          .toEqual(expect.arrayContaining(presentAliases));
      }
    }

    expect(new Set(mappedOperations).size).toBeGreaterThan(40);
  });

  it("keeps high-risk service, tenant, and workspace mappings explicit", () => {
    expect(operationById("gateway.forward").resource).toMatchObject({
      resourceKind: "external_service",
      fieldMap: {
        serviceId: expect.arrayContaining(["serviceId"]),
        secretBindingId: expect.arrayContaining(["secretBindingId"])
      }
    });
    expect(operationById("operation_permission.create_grant").resource).toMatchObject({
      resourceKind: "operation_permission_grant",
      fieldMap: {
        workspaceId: expect.arrayContaining(["allowedWorkspaceIds", "metadata.allowedWorkspaceIds"]),
        dataClasses: expect.arrayContaining(["allowedDataClasses"]),
        requestedEgress: expect.arrayContaining(["allowedEgress"]),
        serviceId: expect.arrayContaining(["allowedServiceIds"]),
        secretBindingId: expect.arrayContaining(["allowedSecretBindings", "metadata.allowedSecretBindings"])
      }
    });
    expect(operationById("operation_permission.update_grant").resource.fieldMap.secretBindingId)
      .toEqual(expect.arrayContaining(["allowedSecretBindings", "metadata.allowedSecretBindings"]));
    expect(operationById("external_services.get").resource.fieldMap.serviceId)
      .toEqual(expect.arrayContaining(["serviceId", "upstreamId"]));
    expect(operationById("auth.audit").resource.fieldMap.tenantId)
      .toEqual(expect.arrayContaining(["tenantId"]));
    expect(operationById("agent_workspaces.file.upload").resource).toMatchObject({
      resourceKind: "file",
      fieldMap: {
        workspaceId: expect.arrayContaining(["workspaceId"])
      }
    });
  });

  it("projects long-running upstream forwarding timeout from the operation registry", () => {
    const catalog = createToolCatalog({ operations: SERVER_API_OPERATIONS });
    const gatewayForward = catalog.tools.find((tool) => tool.id === "lico.gateway.forward");
    const gatewayMetrics = catalog.tools.find((tool) => tool.id === "lico.gateway.metrics");

    expect(operationById("gateway.forward").execution?.timeoutMs).toBe(180_000);
    expect(gatewayForward?.timeoutMs).toBe(180_000);
    expect(gatewayMetrics?.timeoutMs).toBe(30_000);
  });
});
