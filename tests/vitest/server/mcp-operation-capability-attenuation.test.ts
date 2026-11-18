import { describe, expect, it } from "vitest";

import { evaluateDynamicOperationAuthorization } from "../../../packages/agents/src/upstream-gateway/operation-capability.ts";

const CAPABILITY_ID: any = "cap:upstream:fixture:tools-call";

describe("effective subject authority attenuation", () : any => {
  it("does not widen an explicitly narrowed subject from a broader nested grant", () : any => {
    const decision: any = evaluateDynamicOperationAuthorization({
      type: "tool-grant",
      dynamicCapabilities: [],
      allowedServiceIds: ["fixture"],
      grant: {
        id: "grant-1",
        dynamicCapabilities: [CAPABILITY_ID]
      }
    }, {
      dynamicCapability: {
        capabilityId: CAPABILITY_ID,
        serviceId: "fixture"
      }
    });
    expect(decision).toMatchObject({
      allowed: false,
      reasonCode: "missing_dynamic_upstream_capability",
      capabilityId: CAPABILITY_ID
    });
  });

  it("uses nested grant authority only when the subject does not declare capabilities", () : any => {
    const decision: any = evaluateDynamicOperationAuthorization({
      type: "tool-grant",
      allowedServiceIds: ["fixture"],
      grant: {
        id: "grant-1",
        dynamicCapabilities: [CAPABILITY_ID]
      }
    }, {
      dynamicCapability: {
        capabilityId: CAPABILITY_ID,
        serviceId: "fixture"
      }
    });
    expect(decision).toMatchObject({
      allowed: true,
      reasonCode: "dynamic_upstream_capability_allowed",
      capabilityId: CAPABILITY_ID
    });
  });

  it("denies a plugin or console subject that does not hold the upstream tool capability", () : any => {
    const operation: Record<string, any> = {
      dynamicCapability: {
        capabilityId: "cap:upstream:fixture:tools-call-echo",
        upstreamToolName: "echo",
        serviceId: "fixture"
      }
    };
    for (const type of ["plugin-operation", "console-user"]) {
      expect(evaluateDynamicOperationAuthorization({
        type,
        dynamicCapabilities: [],
        capabilities: []
      }, operation)).toMatchObject({
        allowed: false,
        reasonCode: "missing_dynamic_upstream_capability",
        capabilityId: "cap:upstream:fixture:tools-call-echo"
      });
    }
  });

  it("allows a plugin or console subject that holds the upstream tool capability", () : any => {
    const operation: Record<string, any> = {
      dynamicCapability: {
        capabilityId: "cap:upstream:fixture:tools-call-echo",
        serviceId: "fixture"
      }
    };
    for (const type of ["plugin-operation", "console-user"]) {
      expect(evaluateDynamicOperationAuthorization({
        type,
        dynamicCapabilities: ["cap:upstream:fixture:tools-call-echo"]
      }, operation)).toMatchObject({
        allowed: true,
        reasonCode: "dynamic_upstream_capability_allowed",
        capabilityId: "cap:upstream:fixture:tools-call-echo"
      });
    }
  });
});
