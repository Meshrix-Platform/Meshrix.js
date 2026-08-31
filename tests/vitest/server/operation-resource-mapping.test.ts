import { describe, expect, it } from "vitest";

import { createToolCatalog } from "../../../packages/capabilities/src/operation-permission-core/catalog.ts";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import { resolveResourceContext } from "../../../packages/foundation/src/security/authorization/authorization-resource-context.ts";

const FIELD_GROUPS: Readonly<Record<string, any>> = Object.freeze({
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

function collectBindingNames(bindings: any = [], output: any = new Set<any>()) : any {
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

function operationFieldNames(operation: Record<string, any> = {}) : any {
  const output: any = new Set<any>(Object.keys(operation.inputSchema?.properties || {}));
  collectBindingNames(operation.http?.params, output);
  collectBindingNames(operation.http?.query, output);
  collectBindingNames(operation.rpc?.params, output);
  collectBindingNames(operation.rpc?.query, output);
  collectBindingNames(operation.cli?.bodyParams, output);
  for (const [name, aliases] of (Object.entries(operation.cli?.pathParams || {}) as [string, any][])) {
    output.add(name);
    for (const alias of aliases || []) {
      output.add(String(alias));
    }
  }
  return output;
}

function operationById(id?: any) : any {
  return SERVER_API_OPERATIONS.find((operation?: any) : any => operation.id === id);
}

describe("operation resource mapping", () : any => {
  it("decorates all server operations with authorization resource metadata", () : any => {
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

  it("maps resource-bearing request fields to ABAC keys", () : any => {
    const mappedOperations: any[] = [];

    for (const operation of SERVER_API_OPERATIONS) {
      const fields: any = operationFieldNames(operation);
      for (const [resourceKey, aliases] of (Object.entries(FIELD_GROUPS) as [string, any][])) {
        const presentAliases: any = aliases.filter((alias?: any) : any => fields.has(alias));
        if (presentAliases.length === 0) {
          continue;
        }
        mappedOperations.push(operation.id);
        expect(operation.resource.fieldMap[resourceKey], `${operation.id}:${resourceKey}`)
          .toEqual(expect.arrayContaining(presentAliases));
      }
    }

    expect(new Set<any>(mappedOperations).size).toBeGreaterThan(40);
  });

  it("keeps high-risk service, tenant, and workspace mappings explicit", () : any => {
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

  it("does not let a generic business field override a fixed authorization resource fact", () : any => {
    expect(operationById("tag_management.tags.list").resource).toMatchObject({
      resourceKind: "tag",
      fieldMap: {}
    });
    expect(operationById("tag_management.tags.upsert").resource).toMatchObject({
      resourceKind: "tag",
      fieldMap: {}
    });
    expect(operationById("operation_permission.create_grant").resource.fieldMap.resourceKind)
      .toEqual(expect.arrayContaining(["allowedResourceKinds", "metadata.allowedResourceKinds"]));
    expect(resolveResourceContext({
      operation: operationById("tag_management.tags.list"),
      input: { kind: "custom" }
    }).resourceKind).toBe("tag");
    expect(resolveResourceContext({
      operation: {
        resourceContext: {
          resourceKind: "tag",
          fieldMap: { resourceKind: ["kind"] }
        }
      },
      input: { kind: "custom" }
    }).resourceKind).toBe("custom");
  });

  it("projects long-running upstream forwarding timeout from the operation registry", () : any => {
    const catalog: any = createToolCatalog({ operations: SERVER_API_OPERATIONS });
    const gatewayForward: any = catalog.tools.find((tool?: any) : any => tool.id === "meshrix.gateway.forward");
    const gatewayMetrics: any = catalog.tools.find((tool?: any) : any => tool.id === "meshrix.gateway.metrics");

    expect(operationById("gateway.forward").execution?.timeoutMs).toBe(180_000);
    expect(gatewayForward?.timeoutMs).toBe(180_000);
    expect(gatewayMetrics?.timeoutMs).toBe(30_000);
  });
});
