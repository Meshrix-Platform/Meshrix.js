import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SERVER_API_OPERATIONS as CORE_SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import { SERVER_API_OPERATIONS as GENERATED_SERVER_API_OPERATIONS } from "../../../packages/contracts/src/generated/operations.generated.ts";
import { validateOperationRegistryProjectionParity } from "../../../tools/verifiers/registry-operation-parity.ts";

function sorted(values?: any) : any {
  return [...values].sort((left?: any, right?: any) : any => left.localeCompare(right));
}

describe("registry operation parity", () : any => {
  it("validates exact Core static projections", async () : Promise<any> => {
    const operationRegistry: any = JSON.parse(await fs.readFile(
      "tools/registry/operations/operations.registry.json",
      "utf8"
    ));
    const capabilityRegistry: any = JSON.parse(await fs.readFile(
      "tools/registry/capabilities/capabilities.registry.json",
      "utf8"
    ));
    const dataCache: any = new Map<any, any>([
      ["operations/operations.registry.json", operationRegistry],
      ["capabilities/capabilities.registry.json", capabilityRegistry]
    ]);

    expect(validateOperationRegistryProjectionParity(dataCache)).toEqual([]);

    const coreOperationIds: any = sorted(CORE_SERVER_API_OPERATIONS.map((operation?: any) : any => operation.id));
    expect(sorted(operationRegistry.operations.map((operation?: any) : any => operation.id))).toEqual(coreOperationIds);
    expect(sorted(GENERATED_SERVER_API_OPERATIONS.map((operation?: any) : any => operation.id))).toEqual(coreOperationIds);
  });
});
