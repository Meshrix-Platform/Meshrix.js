import { describe, expect, it } from "vitest";

import { createAuthorizationEngine } from "../../../packages/foundation/src/security/authorization/authorization-engine.ts";

function evaluate(input: Record<string, any> = {}) : any {
  return createAuthorizationEngine().evaluate({
    enforceConfirmation: false,
    ...input
  });
}

describe("authorization resource context mapping", () : any => {
  it("maps operation resourceContext fieldMap aliases into workspace ABAC decisions", () : any => {
    const decision: any = evaluate({
      operation: {
        id: "sample_plugin.stats",
        requiredScopes: ["workspace:read"],
        resourceContext: {
          resourceKind: "skill",
          fieldMap: {
            workspaceId: ["registryWorkspaceId"]
          }
        }
      },
      authSession: {
        user: {
          userId: "workspace-reader",
          scopes: ["workspace:read"],
          allowedWorkspaceIds: ["workspace-a"]
        }
      },
      input: {
        registryWorkspaceId: "workspace-b"
      }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("workspace_not_allowed");
    expect(decision.resource.workspaceId).toBe("workspace-b");
    expect(decision.evaluatedLayers).toContain("abac_resource_policy");
  });

  it("uses nested resource objects for service and secret binding ABAC decisions", () : any => {
    const serviceDecision: any = evaluate({
      operation: {
        id: "gateway.forward",
        requiredScopes: ["gateway:write"],
        resource: {
          resourceKind: "external_service"
        }
      },
      authSession: {
        user: {
          userId: "gateway-operator",
          scopes: ["gateway:write"],
          allowedServiceIds: ["github"]
        }
      },
      input: {
        resource: {
          serviceId: "private-mcp"
        }
      }
    });

    expect(serviceDecision.allowed).toBe(false);
    expect(serviceDecision.reasonCode).toBe("service_not_allowed");
    expect(serviceDecision.resource.serviceId).toBe("private-mcp");

    const secretDecision: any = evaluate({
      operation: {
        id: "gateway.forward",
        requiredScopes: ["gateway:write"],
        resource: {
          resourceKind: "external_service"
        }
      },
      authSession: {
        user: {
          userId: "gateway-operator",
          scopes: ["gateway:write"],
          allowedSecretBindings: ["public-binding"]
        }
      },
      input: {
        resourceContext: {
          authBindingId: "private-binding"
        }
      }
    });

    expect(secretDecision.allowed).toBe(false);
    expect(secretDecision.reasonCode).toBe("secret_binding_not_allowed");
    expect(secretDecision.resource.secretBindingId).toBe("private-binding");
  });

  it("denies grant management inputs that delegate outside the subject resource boundary", () : any => {
    const decision: any = evaluate({
      operation: {
        id: "operation_permission.create_grant",
        requiredScopes: ["runtime:admin"],
        resourceContext: {
          resourceKind: "operation_permission_grant",
          fieldMap: {
            workspaceId: ["allowedWorkspaceIds"],
            dataClasses: ["allowedDataClasses"],
            requestedEgress: ["allowedEgress"],
            serviceId: ["allowedServiceIds"],
            secretBindingId: ["allowedSecretBindings"]
          }
        }
      },
      authSession: {
        user: {
          userId: "grant-admin",
          scopes: ["runtime:admin"],
          allowedWorkspaceIds: ["ws-a"],
          allowedDataClasses: ["public"],
          allowedEgress: ["none"],
          allowedServiceIds: ["svc-a"],
          allowedSecretBindings: ["sec-a"]
        }
      },
      input: {
        allowedWorkspaceIds: ["ws-b"],
        allowedDataClasses: ["restricted"],
        allowedEgress: ["internet"],
        allowedServiceIds: ["svc-b"],
        allowedSecretBindings: ["sec-b"]
      }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("workspace_not_allowed");
    expect(decision.resource.workspaceIds).toEqual(["ws-b"]);
    expect(decision.resource.serviceIds).toEqual(["svc-b"]);
    expect(decision.resource.secretBindingIds).toEqual(["sec-b"]);
  });

  it("denies grant metadata resource limits outside the subject boundary", () : any => {
    const decision: any = evaluate({
      operation: {
        id: "operation_permission.update_grant",
        requiredScopes: ["runtime:admin"],
        resourceContext: {
          resourceKind: "operation_permission_grant",
          fieldMap: {
            workspaceId: ["allowedWorkspaceIds", "metadata.allowedWorkspaceIds"],
            secretBindingId: ["allowedSecretBindings", "metadata.allowedSecretBindings"]
          }
        }
      },
      authSession: {
        user: {
          userId: "grant-admin",
          scopes: ["runtime:admin"],
          allowedWorkspaceIds: ["ws-a"],
          allowedSecretBindings: ["sec-a"]
        }
      },
      input: {
        metadata: {
          allowedWorkspaceIds: ["ws-b"],
          allowedSecretBindings: ["sec-b"]
        }
      }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("workspace_not_allowed");
    expect(decision.resource.workspaceIds).toEqual(["ws-b"]);
    expect(decision.resource.secretBindingIds).toEqual(["sec-b"]);
  });

  it("denies grant metadata resource limits with the real registry mapping", async () : Promise<any> => {
    const { SERVER_API_OPERATIONS } = await import("../../../packages/contracts/src/operations/operation-registry.ts");
    const operation: any = SERVER_API_OPERATIONS.find((item?: any) : any => item.id === "operation_permission.create_grant");
    const decision: any = evaluate({
      operation,
      authSession: {
        user: {
          userId: "grant-admin",
          scopes: ["runtime:admin"],
          allowedWorkspaceIds: ["ws-a"],
          allowedSecretBindings: ["sec-a"]
        }
      },
      input: {
        metadata: {
          allowedWorkspaceIds: ["ws-b"],
          allowedSecretBindings: ["sec-b"]
        }
      }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("workspace_not_allowed");
  });

  it("denies gateway forwarding when credential or secret refs exceed the subject boundary", () : any => {
    const decision: any = evaluate({
      operation: {
        id: "gateway.forward",
        requiredScopes: ["gateway:write"],
        resource: {
          resourceKind: "external_service",
          fieldMap: {
            serviceId: ["serviceId"],
            secretBindingId: ["credentialRefs", "secretRefs"]
          }
        }
      },
      authSession: {
        user: {
          userId: "gateway-operator",
          scopes: ["gateway:write"],
          allowedServiceIds: ["svc-a"],
          allowedSecretBindings: ["sec-a"]
        }
      },
      input: {
        serviceId: "svc-a",
        credentialRefs: ["sec-a"],
        secretRefs: ["sec-b"]
      }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("secret_binding_not_allowed");
    expect(decision.resource.serviceIds).toEqual(["svc-a"]);
    expect(decision.resource.secretBindingIds).toEqual(["sec-a", "sec-b"]);
  });

  it("keeps legitimate mapped resource access allowed", () : any => {
    const decision: any = evaluate({
      operation: {
        id: "external_services.get",
        requiredScopes: ["gateway:read"],
        resource: {
          resourceKind: "external_service",
          fieldMap: {
            serviceId: ["upstreamId"]
          }
        }
      },
      authSession: {
        user: {
          userId: "gateway-reader",
          scopes: ["gateway:read"],
          allowedServiceIds: ["github"]
        }
      },
      input: {
        upstreamId: "github"
      }
    });

    expect(decision.allowed).toBe(true);
    expect(decision.resource.serviceId).toBe("github");
  });
});
