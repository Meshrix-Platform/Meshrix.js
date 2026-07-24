import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SERVER_API_OPERATIONS as CORE_SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.mjs";
import { SERVER_API_OPERATIONS as GENERATED_SERVER_API_OPERATIONS } from "../../../packages/contracts/src/generated/operations.generated.mjs";
import { validateOperationRegistryProjectionParity } from "../../../tools/verifiers/registry-operation-parity.mjs";

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

describe("registry operation parity", () => {
  it("validates exact Core static projections", async () => {
    const operationRegistry = JSON.parse(await fs.readFile(
      "tools/registry/operations/operations.registry.json",
      "utf8"
    ));
    const capabilityRegistry = JSON.parse(await fs.readFile(
      "tools/registry/capabilities/capabilities.registry.json",
      "utf8"
    ));
    const dataCache = new Map([
      ["operations/operations.registry.json", operationRegistry],
      ["capabilities/capabilities.registry.json", capabilityRegistry]
    ]);

    expect(validateOperationRegistryProjectionParity(dataCache)).toEqual([]);

    const coreOperationIds = sorted(CORE_SERVER_API_OPERATIONS.map((operation) => operation.id));
    expect(sorted(operationRegistry.operations.map((operation) => operation.id))).toEqual(coreOperationIds);
    expect(sorted(GENERATED_SERVER_API_OPERATIONS.map((operation) => operation.id))).toEqual(coreOperationIds);
  });
});
