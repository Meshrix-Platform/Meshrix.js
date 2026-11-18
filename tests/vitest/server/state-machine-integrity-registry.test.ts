import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createPlatformRegistry } from "../../../packages/server-runtime/src/composition/platform-registry.ts";
import {
  loadStateMachineDefinition,
  registerStateMachineDefinitions
} from "../../../packages/server-runtime/src/composition/register-state-machines.ts";
import { computeStateMachineDefinitionHash } from "../../../packages/foundation/src/workflow/state-machine/engine/state-machine-core.ts";
import { runVerifier } from "../../../tools/server-scripts/verify-state-machines.ts";

async function withTempDir(callback?: any) : Promise<any> {
  const dir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-state-machine-integrity-"));
  try {
    return await callback(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function registryFor(definition?: any, {
  definitionPath,
  hash = computeStateMachineDefinitionHash(definition)
}: Record<string, any> = {}) : any {
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
        .filter((state?: any) : any => state.terminal === true)
        .map((state?: any) : any => state.id)
        .sort()
    }]
  };
}

describe("state machine integrity registry", () : any => {
  it("registers definitions with trusted canonical hashes in metadata", () : any => {
    const registry: any = createPlatformRegistry({ scope: "state-machine-integrity-test" });
    const entries: any = registerStateMachineDefinitions(registry);

    expect(entries.length).toBeGreaterThan(0);
    const operation: any = registry.get("state-machine.operation.narrow");
    expect(operation).toBeTruthy();
    expect(operation.metadata.definitionHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(operation.metadata.integrityRegistryVersion).toBe("v0.0.1:registry:state-machine-integrity-1");
    expect(operation.metadata.matrixCellCount).toBe(operation.value.totalMatrix.length);
  });

  it("fails closed when a definition hash does not match the trusted registry", async () : Promise<any> => {
    await withTempDir(async (root?: any) : Promise<any> => {
      const definitionsDir: any = path.join(root, "definitions");
      await fs.mkdir(definitionsDir, { recursive: true });
      const definition: any = loadStateMachineDefinition("operation.narrow");
      const definitionPath: any = path.join(definitionsDir, "operation.narrow.json");
      await fs.writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`, "utf8");

      const integrityRegistryPath: any = path.join(root, "state-machine-integrity.registry.json");
      const staleRegistry: any = registryFor(definition, {
        definitionPath,
        hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
      });
      await fs.writeFile(integrityRegistryPath, `${JSON.stringify(staleRegistry, null, 2)}\n`, "utf8");

      expect(() : any => registerStateMachineDefinitions(createPlatformRegistry({ scope: "tampered-state-machine" }), {
        definitionsDir,
        integrityRegistryPath
      })).toThrow(/State machine integrity mismatch for operation\.narrow/);
    });
  });

  it("rejects a registry whose declared definition count does not match its entries", async () : Promise<any> => {
    await withTempDir(async (root?: any) : Promise<any> => {
      const definitionsDir: any = path.join(root, "definitions");
      const reportsDir: any = path.join(root, "reports");
      await fs.mkdir(definitionsDir, { recursive: true });
      const definition: any = loadStateMachineDefinition("operation.narrow");
      const definitionPath: any = path.join(definitionsDir, "operation.narrow.json");
      await fs.writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`, "utf8");

      const integrityRegistryPath: any = path.join(root, "state-machine-integrity.registry.json");
      const invalidRegistry: Record<string, any> = {
        ...registryFor(definition, { definitionPath }),
        definitionCount: 2
      };
      await fs.writeFile(integrityRegistryPath, `${JSON.stringify(invalidRegistry, null, 2)}\n`, "utf8");

      expect(() : any => runVerifier(definitionsDir, reportsDir, { integrityRegistryPath }))
        .toThrow(/definitionCount must equal machines\.length/);
    });
  });

  it("rejects an empty definition authority instead of reporting release readiness", async () : Promise<any> => {
    await withTempDir(async (root?: any) : Promise<any> => {
      const definitionsDir: any = path.join(root, "definitions");
      const reportsDir: any = path.join(root, "reports");
      await fs.mkdir(definitionsDir, { recursive: true });
      const integrityRegistryPath: any = path.join(root, "state-machine-integrity.registry.json");
      await fs.writeFile(integrityRegistryPath, `${JSON.stringify({
        "$schema": "../schema/state-machine-integrity.schema.json",
        version: "fixture.registry.empty",
        definitionRoot: "definitions",
        definitionCount: 0,
        hashAlgorithm: "canonical-json-sha256",
        machines: []
      }, null, 2)}\n`, "utf8");

      expect(() : any => runVerifier(definitionsDir, reportsDir, { integrityRegistryPath }))
        .toThrow(/at least one machine is required/);
    });
  });

  it("publishes reportLeakScan only after the report passes the real scan hook", async () : Promise<any> => {
    await withTempDir(async (root?: any) : Promise<any> => {
      const definitionsDir: any = path.join(root, "definitions");
      const reportsDir: any = path.join(root, "reports");
      await fs.mkdir(definitionsDir, { recursive: true });
      const definition: any = loadStateMachineDefinition("operation.narrow");
      const definitionPath: any = path.join(definitionsDir, "operation.narrow.json");
      await fs.writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`, "utf8");

      const integrityRegistryPath: any = path.join(root, "state-machine-integrity.registry.json");
      await fs.writeFile(
        integrityRegistryPath,
        `${JSON.stringify(registryFor(definition, { definitionPath }), null, 2)}\n`,
        "utf8"
      );

      const observedScanStates: any[] = [];
      const report: any = runVerifier(definitionsDir, reportsDir, {
        integrityRegistryPath,
        assertNoSensitiveLeak(value?: any) : any {
          observedScanStates.push(value.summary.reportLeakScan);
        }
      });

      expect(observedScanStates).toEqual([false, true]);
      expect(report.summary.reportLeakScan).toBe(true);
    });
  });
});
