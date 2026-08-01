import { describe, expect, it, vi } from "vitest";
import {
  compileAudienceProjection,
  createAudiencePublicationEvent,
  evaluateAudienceDecision,
  evaluateAudienceParity,
  opaqueAudiencePartitionKey,
  compileUpstreamOperationProjection
} from "../../../packages/agents/src/upstream-gateway/index.ts";
import { createToolSkillManagementProvider } from "../../../packages/capabilities/src/skills/tool-skill-management-provider.ts";
import { structuredJsonPayloadTransport } from "../../helpers/upstream-runtime-snapshot.ts";

function serviceEntry({
  serviceId = "svc_audience_a",
  tagPolicy = null,
  operations = [{
    operationKey: "read",
    method: "GET",
    path: "/read",
    risk: "read_only",
    requiredScopes: ["gateway:read"],
    payloadTransport: structuredJsonPayloadTransport()
  }]
}: Record<string, any> = {}) : any {
  return Object.freeze([
    serviceId,
    Object.freeze({
      serviceId,
      serviceRevision: 1,
      manifestDigest: "a".repeat(64),
      disabled: false,
      label: "Audience fixture",
      serviceProtocol: "http",
      baseUrl: "https://audience.invalid:443",
      credentialRefs: Object.freeze(["credential://vault/audience"]),
      tagPolicy: tagPolicy ? Object.freeze(tagPolicy) : undefined,
      operations: Object.freeze(operations.map((operation?: any) : any => Object.freeze({
        ...operation,
        payloadTransport: operation.payloadTransport || structuredJsonPayloadTransport()
      })))
    })
  ]);
}

function snapshot(setRevision?: any, entries?: any) : any {
  return Object.freeze({
    setRevision,
    setDigest: String(setRevision).padStart(64, "0"),
    serviceEntries: Object.freeze(entries),
    serviceCount: entries.length
  });
}

function grant({
  id,
  scopes = ["gateway:read"],
  toolsets = ["meshrix.gateway.read"],
  dynamicCapabilities = null,
  allowedServiceIds = null,
  allowedSecretBindings = null,
  organizationId = "",
  teamId = "",
  roleId = "",
  maxRisk = "read_only"
}: Record<string, any> = {}) : any {
  return {
    id,
    scopes,
    toolsets,
    maxRisk,
    organizationId,
    teamId,
    roleId,
    ...(dynamicCapabilities ? { dynamicCapabilities } : {}),
    ...(allowedServiceIds ? { allowedServiceIds } : {}),
    ...(allowedSecretBindings ? { allowedSecretBindings } : {})
  };
}

describe("upstream audience projection", () : any => {
  it("keeps discovery and execution decisions identical across two subjects", () : any => {
    const candidate: any = snapshot(1, [serviceEntry()]);
    const projection: any = compileUpstreamOperationProjection(candidate);
    const operation: any = projection.operations[0];
    const service: any = candidate.serviceEntries[0][1];
    const capabilityId: any = operation._meta.dynamicCapability.capabilityId;

    const allowedGrant: any = grant({
      id: "grant-org-a",
      organizationId: "org-a",
      teamId: "team-a",
      roleId: "reader",
      dynamicCapabilities: [capabilityId],
      allowedServiceIds: [service.serviceId],
      allowedSecretBindings: operation._meta.dynamicCapability.credentialBindingIds
    });
    const deniedGrant: any = grant({
      id: "grant-org-b",
      organizationId: "org-b",
      teamId: "team-b",
      roleId: "reader",
      dynamicCapabilities: [],
      allowedServiceIds: [service.serviceId]
    });

    const allowedParity: any = evaluateAudienceParity({
      grant: allowedGrant,
      operation,
      service
    });
    const deniedParity: any = evaluateAudienceParity({
      grant: deniedGrant,
      operation,
      service
    });
    expect(allowedParity.identical).toBe(true);
    expect(allowedParity.discovery.allowed).toBe(true);
    expect(deniedParity.identical).toBe(true);
    expect(deniedParity.discovery.allowed).toBe(false);
    expect(deniedParity.discovery.visibleMetadata).toBe(false);
    expect(JSON.stringify(deniedParity)).not.toContain("credential://vault");
  });

  it("applies deny-tag precedence and fails closed for missing metadata", () : any => {
    const candidate: any = snapshot(2, [serviceEntry({
      tagPolicy: {
        allowTags: ["upstream-allowed"],
        denyTags: ["upstream-denied"],
        entityRefs: [{ entityType: "external_services.service", entityId: "svc_audience_a" }]
      }
    })]);
    const projection: any = compileUpstreamOperationProjection(candidate);
    const operation: any = projection.operations[0];
    const service: any = candidate.serviceEntries[0][1];
    const capabilityId: any = operation._meta.dynamicCapability.capabilityId;
    const baseGrant: any = grant({
      id: "grant-tagged",
      dynamicCapabilities: [capabilityId],
      allowedServiceIds: [service.serviceId],
      allowedSecretBindings: operation._meta.dynamicCapability.credentialBindingIds
    });
    const denyStore: Record<string, any> = {
      listEntityTags() : any {
        return [{ tagId: "upstream-denied" }];
      }
    };
    const denied: any = evaluateAudienceDecision({
      grant: baseGrant,
      operation,
      service,
      tagStore: denyStore,
      purpose: "discovery"
    });
    expect(denied).toMatchObject({
      allowed: false,
      visibleMetadata: false
    });
    expect(denied.reasonCode).toMatch(/tag|denied|audience/u);
  });

  it("fails closed when a credential-bound capability has no granted binding", () : any => {
    const candidate: any = snapshot(2, [serviceEntry()]);
    const projection: any = compileUpstreamOperationProjection(candidate);
    const operation: any = projection.operations[0];
    const service: any = candidate.serviceEntries[0][1];
    const decision: any = evaluateAudienceDecision({
      grant: grant({
        id: "grant-binding-missing",
        dynamicCapabilities: [operation._meta.dynamicCapability.capabilityId],
        allowedServiceIds: [service.serviceId],
        allowedSecretBindings: []
      }),
      operation,
      service,
      purpose: "discovery"
    });
    expect(decision).toMatchObject({
      allowed: false,
      reasonCode: "audience_credential_binding_missing",
      visibleMetadata: false
    });
  });

  it("uses the same audience authority for catalog discovery and execution", async () : Promise<any> => {
    const runtimeExecute: any = vi.fn(async () : Promise<any> => ({ ok: true, status: 200, payload: {} }));
    const tool: Record<string, any> = {
      id: "upstream.service.read",
      status: "active",
      upstreamProjectedOperation: true,
      requiredScopes: [],
      toolsets: [],
      risk: "read_only",
      dynamicCapability: { capabilityId: "capability-read", credentialBindingIds: [] }
    };
    const audience: any = vi.fn(({ purpose }: Record<string, any>) : any => ({
      allowed: purpose === "discovery",
      reasonCode: purpose === "discovery" ? "audience_allowed" : "audience_denied"
    }));
    const provider: any = createToolSkillManagementProvider({
      operationPermissionPlatform: {
        catalog: () : any => ({ tools: [tool] }),
        registry: { getTool: () : any => tool },
        runtime: { executeTool: runtimeExecute }
      },
      evaluateToolAudience: audience
    });
    const authorization: Record<string, any> = {
      grant: {
        id: "grant-audience",
        scopes: [],
        toolsets: [],
        maxRisk: "read_only",
        dynamicCapabilities: ["capability-read"]
      }
    };

    expect(provider.listVisibleTools({ authorization })).toEqual([tool]);
    await expect(provider.executeTool({
      toolId: tool.id,
      authorization
    })).resolves.toMatchObject({
      ok: false,
      status: 403,
      payload: { error: { code: "upstream_audience_denied" } }
    });
    expect(audience.mock.calls.map(([input]: any[]) : any => input.purpose)).toEqual(["discovery", "execution"]);
    expect(runtimeExecute).not.toHaveBeenCalled();
  });

  it("advances audience revision and diffs only affected opaque partitions", () : any => {
    const candidate: any = snapshot(3, [serviceEntry()]);
    const projection: any = compileUpstreamOperationProjection(candidate);
    const capabilityId: any = projection.operations[0]._meta.dynamicCapability.capabilityId;
    const bindingIds: any = projection.operations[0]._meta.dynamicCapability.credentialBindingIds;
    const first: any = compileAudienceProjection({
      sourceRevision: 3,
      sourceDigest: candidate.setDigest,
      catalogFingerprint: "catalog-a",
      snapshot: candidate,
      projectedOperations: projection.operations,
      grants: [
        grant({
          id: "grant-1",
          dynamicCapabilities: [capabilityId],
          allowedServiceIds: ["svc_audience_a"],
          allowedSecretBindings: bindingIds
        }),
        grant({
          id: "grant-2",
          dynamicCapabilities: [],
          allowedServiceIds: ["svc_audience_a"]
        })
      ]
    });
    expect(first.ready).toBe(true);
    expect(first.audienceRevision).toBe(1);
    expect(first.partitionCount).toBe(2);
    expect(first.affectedPartitions.length).toBe(2);
    for (const key of first.affectedPartitions) {
      expect(key).not.toContain("grant-");
      expect(key).not.toContain("svc_");
    }

    const second: any = compileAudienceProjection({
      sourceRevision: 3,
      sourceDigest: candidate.setDigest,
      catalogFingerprint: "catalog-a",
      snapshot: candidate,
      projectedOperations: projection.operations,
      previousProjection: first,
      grants: [
        grant({
          id: "grant-1",
          dynamicCapabilities: [capabilityId],
          allowedServiceIds: ["svc_audience_a"],
          allowedSecretBindings: bindingIds
        }),
        grant({
          id: "grant-2",
          dynamicCapabilities: [capabilityId],
          allowedServiceIds: ["svc_audience_a"],
          allowedSecretBindings: bindingIds
        })
      ]
    });
    expect(second.audienceRevision).toBe(2);
    expect(second.replayed).toBe(false);
    expect(second.affectedPartitions.length).toBeGreaterThan(0);
    expect(second.affectedPartitions.length).toBeLessThanOrEqual(2);

    const replay: any = compileAudienceProjection({
      sourceRevision: 3,
      sourceDigest: candidate.setDigest,
      catalogFingerprint: "catalog-a",
      snapshot: candidate,
      projectedOperations: projection.operations,
      previousProjection: second,
      grants: [
        grant({
          id: "grant-1",
          dynamicCapabilities: [capabilityId],
          allowedServiceIds: ["svc_audience_a"],
          allowedSecretBindings: bindingIds
        }),
        grant({
          id: "grant-2",
          dynamicCapabilities: [capabilityId],
          allowedServiceIds: ["svc_audience_a"],
          allowedSecretBindings: bindingIds
        })
      ]
    });
    expect(replay.replayed).toBe(true);
    expect(replay.audienceRevision).toBe(second.audienceRevision);
    expect(replay.affectedPartitions).toEqual([]);

    const event: any = createAudiencePublicationEvent(second);
    expect(event.type).toBe("upstream.audiences_published");
    expect(JSON.stringify(event)).not.toContain("gateway:read");
    expect(JSON.stringify(event)).not.toContain("org-");
    expect(event.affectedPartitions).toEqual(second.affectedPartitions);
  });

  it("invalidates visible partitions when an operation descriptor changes without changing its id", () : any => {
    const firstSnapshot: any = snapshot(4, [serviceEntry()]);
    const firstOperations: any = compileUpstreamOperationProjection(firstSnapshot).operations;
    const capability: any = firstOperations[0]._meta.dynamicCapability;
    const audienceGrant: any = grant({
      id: "grant-descriptor",
      dynamicCapabilities: [capability.capabilityId],
      allowedServiceIds: ["svc_audience_a"],
      allowedSecretBindings: capability.credentialBindingIds
    });
    const first: any = compileAudienceProjection({
      sourceRevision: 4,
      sourceDigest: firstSnapshot.setDigest,
      catalogFingerprint: "catalog-4",
      snapshot: firstSnapshot,
      projectedOperations: firstOperations,
      grants: [audienceGrant]
    });
    const secondSnapshot: any = snapshot(5, [serviceEntry({
      operations: [{
        operationKey: "read",
        method: "GET",
        path: "/read",
        risk: "read_only",
        requiredScopes: ["gateway:read"],
        requestSchema: { type: "object", properties: { query: { type: "string" } } }
      }]
    })]);
    const secondOperations: any = compileUpstreamOperationProjection(secondSnapshot).operations;
    expect(secondOperations[0].id).toBe(firstOperations[0].id);
    const second: any = compileAudienceProjection({
      sourceRevision: 5,
      sourceDigest: secondSnapshot.setDigest,
      catalogFingerprint: "catalog-5",
      snapshot: secondSnapshot,
      projectedOperations: secondOperations,
      grants: [audienceGrant],
      previousProjection: first
    });
    expect(second.partitionSnapshot[0][0]).toBe(first.partitionSnapshot[0][0]);
    expect(second.affectedPartitions).toEqual([second.partitionSnapshot[0][0]]);
  });

  it("builds opaque partition keys without embedding subjects or tags", () : any => {
    const key: any = opaqueAudiencePartitionKey({
      grantId: "grant-secret-subject",
      serverIdentity: "meshrix",
      audienceDigest: "digest-1"
    });
    expect(key).not.toContain("grant-secret-subject");
    expect(key).not.toContain("digest-1");
  });
});
