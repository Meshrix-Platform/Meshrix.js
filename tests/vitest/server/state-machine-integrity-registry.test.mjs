import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createPlatformRegistry } from "../../../packages/server-runtime/src/composition/platform-registry.mjs";
import {
  loadStateMachineDefinition,
  registerStateMachineDefinitions
} from "../../../packages/server-runtime/src/composition/register-state-machines.mjs";
import { computeStateMachineDefinitionHash } from "../../../packages/foundation/src/workflow/state-machine/engine/state-machine-core.mjs";
import { runVerifier } from "../../../tools/server-scripts/verify-state-machines.mjs";

async function withTempDir(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-state-machine-integrity-"));
  try {
    return await callback(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function registryFor(definition, {
  definitionPath,
  hash = computeStateMachineDefinitionHash(definition)
} = {}) {
  return {
    "$schema": "../schema/state-machine-integrity.schema.json",
    version: "fixture.registry.state-machine-integrity",
    definitionRoot: path.dirname(definitionPath || ""),
    definitionCount: 1,
    hashAlgorithm: "canonical-json-sha256",
    machines: [{
      machineId: definition.machineId,
      entityType: definition.entityType || "",
      version: definition.version || "",
      path: path.relative(process.cwd(), definitionPath).split(path.sep).join("/"),
      canonicalSha256: hash,
      stateCount: definition.states.length,
      eventCount: definition.events.length,
      matrixCellCount: definition.totalMatrix.length,
      initialState: definition.initialState,
      terminalStateIds: definition.states
        .filter((state) => state.terminal === true)
        .map((state) => state.id)
        .sort()
    }]
  };
}

describe("state machine integrity registry", () => {
  it("registers definitions with trusted canonical hashes in metadata", () => {
    const registry = createPlatformRegistry({ scope: "state-machine-integrity-test" });
    const entries = registerStateMachineDefinitions(registry);

    expect(entries.length).toBeGreaterThan(0);
    const operation = registry.get("state-machine.operation.narrow");
    expect(operation).toBeTruthy();
    expect(operation.metadata.definitionHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(operation.metadata.integrityRegistryVersion).toBe("v0.0.1:registry:state-machine-integrity-1");
    expect(operation.metadata.matrixCellCount).toBe(operation.value.totalMatrix.length);
  });

  it("fails closed when a definition hash does not match the trusted registry", async () => {
    await withTempDir(async (root) => {
      const definitionsDir = path.join(root, "definitions");
      await fs.mkdir(definitionsDir, { recursive: true });
      const definition = loadStateMachineDefinition("operation.narrow");
      const definitionPath = path.join(definitionsDir, "operation.narrow.json");
      await fs.writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`, "utf8");

      const integrityRegistryPath = path.join(root, "state-machine-integrity.registry.json");
      const staleRegistry = registryFor(definition, {
        definitionPath,
        hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
      });
      await fs.writeFile(integrityRegistryPath, `${JSON.stringify(staleRegistry, null, 2)}\n`, "utf8");

      expect(() => registerStateMachineDefinitions(createPlatformRegistry({ scope: "tampered-state-machine" }), {
        definitionsDir,
        integrityRegistryPath
      })).toThrow(/State machine integrity mismatch for operation\.narrow/);
    });
  });

  it("rejects a registry whose declared definition count does not match its entries", async () => {
    await withTempDir(async (root) => {
      const definitionsDir = path.join(root, "definitions");
      const reportsDir = path.join(root, "reports");
      await fs.mkdir(definitionsDir, { recursive: true });
      const definition = loadStateMachineDefinition("operation.narrow");
      const definitionPath = path.join(definitionsDir, "operation.narrow.json");
      await fs.writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`, "utf8");

      const integrityRegistryPath = path.join(root, "state-machine-integrity.registry.json");
      const invalidRegistry = {
        ...registryFor(definition, { definitionPath }),
        definitionCount: 2
      };
      await fs.writeFile(integrityRegistryPath, `${JSON.stringify(invalidRegistry, null, 2)}\n`, "utf8");

      expect(() => runVerifier(definitionsDir, reportsDir, { integrityRegistryPath }))
        .toThrow(/definitionCount must equal machines\.length/);
    });
  });

  it("rejects an empty definition authority instead of reporting release readiness", async () => {
    await withTempDir(async (root) => {
      const definitionsDir = path.join(root, "definitions");
      const reportsDir = path.join(root, "reports");
      await fs.mkdir(definitionsDir, { recursive: true });
      const integrityRegistryPath = path.join(root, "state-machine-integrity.registry.json");
      await fs.writeFile(integrityRegistryPath, `${JSON.stringify({
        "$schema": "../schema/state-machine-integrity.schema.json",
        version: "fixture.registry.empty",
        definitionRoot: "definitions",
        definitionCount: 0,
        hashAlgorithm: "canonical-json-sha256",
        machines: []
      }, null, 2)}\n`, "utf8");

      expect(() => runVerifier(definitionsDir, reportsDir, { integrityRegistryPath }))
        .toThrow(/at least one machine is required/);
    });
  });

  it("publishes reportLeakScan only after the report passes the real scan hook", async () => {
    await withTempDir(async (root) => {
      const definitionsDir = path.join(root, "definitions");
      const reportsDir = path.join(root, "reports");
      await fs.mkdir(definitionsDir, { recursive: true });
      const definition = loadStateMachineDefinition("operation.narrow");
      const definitionPath = path.join(definitionsDir, "operation.narrow.json");
      await fs.writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`, "utf8");

      const integrityRegistryPath = path.join(root, "state-machine-integrity.registry.json");
      await fs.writeFile(
        integrityRegistryPath,
        `${JSON.stringify(registryFor(definition, { definitionPath }), null, 2)}\n`,
        "utf8"
      );

      const observedScanStates = [];
      const report = runVerifier(definitionsDir, reportsDir, {
        integrityRegistryPath,
        assertNoSensitiveLeak(value) {
          observedScanStates.push(value.summary.reportLeakScan);
        }
      });

      expect(observedScanStates).toEqual([false, true]);
      expect(report.summary.reportLeakScan).toBe(true);
    });
  });
});
