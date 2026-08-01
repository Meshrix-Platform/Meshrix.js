import { describe, expect, it } from "vitest";
import {
  compileUpstreamOperationProjection,
  upstreamProjectedOperationId
} from "../../../packages/agents/src/upstream-gateway/operation-projection.ts";
import { structuredJsonPayloadTransport } from "../../helpers/upstream-runtime-snapshot.ts";

function service(serviceId?: any, overrides: Record<string, any> = {}) : any {
  return Object.freeze({
    serviceId,
    serviceRevision: 3,
    manifestDigest: "a".repeat(64),
    label: "Inventory",
    serviceProtocol: "http",
    credentialRefs: ["secret://verify/inventory"],
    disabled: false,
    operations: Object.freeze([{
      operationKey: "records.read",
      protocol: "http",
      method: "GET",
      path: "/records",
      risk: "read_only",
      requiredScopes: ["gateway:read"],
      timeoutMs: 5_000,
      payloadTransport: structuredJsonPayloadTransport()
    }]),
    ...overrides
  });
}

function snapshot(entries?: any) : any {
  return Object.freeze({
    setRevision: 7,
    setDigest: "b".repeat(64),
    serviceEntries: Object.freeze(entries.map((entry?: any) : any => Object.freeze(entry)))
  });
}

describe("upstream Operation Permission projection", () : any => {
  it("compiles one deterministic governed operation and capability per enabled service operation", () : any => {
    const serviceId: any = "svc_01J0000000000000000000000";
    const candidate: any = snapshot([[serviceId, service(serviceId)]]);
    const first: any = compileUpstreamOperationProjection(candidate);
    const second: any = compileUpstreamOperationProjection(candidate);

    expect(first.operations).toHaveLength(1);
    expect(first.operations).toEqual(second.operations);
    expect(first.operations[0]).toMatchObject({
      id: upstreamProjectedOperationId(serviceId, "records.read"),
      toolId: `upstream.${serviceId}.records-read`,
      requiredScopes: ["gateway:read"],
      safety: { risk: "read_only", requiresConfirmation: false },
      _meta: {
        sourceRevision: 7,
        sourceDigest: "b".repeat(64),
        serviceId,
        serviceRevision: 3,
        operationKey: "records.read",
        dynamicCapability: {
          capabilityId: `cap:upstream:${serviceId}:records-read`,
          credentialBindingIds: [expect.stringMatching(/^credential:[a-f0-9]{16}$/u)]
        }
      }
    });
    expect(first.targets.get(first.operations[0].id)).toEqual({
      serviceId,
      operationKey: "records.read"
    });
  });

  it("excludes disabled services and rejects colliding public tool identities", () : any => {
    const disabledId: any = "svc_01J0000000000000000000001";
    expect(compileUpstreamOperationProjection(snapshot([
      [disabledId, service(disabledId, { disabled: true })]
    ])).operations).toEqual([]);

    const collisionId: any = "svc_01J0000000000000000000002";
    expect(() : any => compileUpstreamOperationProjection(snapshot([[
      collisionId,
      service(collisionId, {
        operations: [
          { operationKey: "records.read", risk: "read_only", requiredScopes: ["gateway:read"] },
          { operationKey: "records-read", risk: "read_only", requiredScopes: ["gateway:read"] }
        ]
      })
    ]]))).toThrow(/duplicate identities/u);
  });
});
