import { describe, expect, it } from "vitest";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";

describe("operation authorization resource context", () : any => {
  it("publishes resource mappings for every server operation", () : any => {
    expect(SERVER_API_OPERATIONS.length).toBeGreaterThan(0);
    for (const operation of SERVER_API_OPERATIONS) {
      expect(operation.resource, operation.id).toMatchObject({
        capabilityDomain: expect.any(String),
        resourceKind: expect.any(String),
        capabilityVerb: expect.any(String),
        effectKind: expect.any(String)
      });
      expect(operation.resourceContext, operation.id).toEqual(operation.resource);
    }
  });
});
