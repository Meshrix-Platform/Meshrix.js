import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface LocalConfigSchema {
  $schema: string;
  $id: string;
  required: readonly string[];
  additionalProperties: boolean;
  properties: {
    schemaVersion: { const: string };
    credentialRefs: {
      items: {
        required: readonly string[];
        additionalProperties: boolean;
        properties: Record<string, unknown>;
      };
    };
  };
}

async function readConfigSchema(): Promise<LocalConfigSchema> {
  const url = new URL(
    "../../../plugins/agents/meshrix-self-maintenance/contracts/local-config.schema.json",
    import.meta.url
  );
  return JSON.parse(await fs.readFile(url, "utf8")) as LocalConfigSchema;
}

describe("Agent self-maintenance local configuration contract", () => {
  it("is one closed schema file with all required behavior-control fields", async () => {
    const schema = await readConfigSchema();
    expect(schema.$schema).toContain("json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toContain("agent-self-maintenance-local-config.schema.json");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.schemaVersion.const)
      .toBe("v0.0.1:meshrix-self-maintenance:local-config-1");
    expect(schema.required).toEqual(expect.arrayContaining([
      "schemaVersion",
      "enabledRevision",
      "targets",
      "strategies",
      "schedules",
      "runbooks",
      "budgets",
      "operationAllowlist",
      "resourceAllowlist",
      "workspaceSelectors",
      "credentialRefs"
    ]));
  });

  it("declares no inbound control surface", async () => {
    const schema = await readConfigSchema();
    const propertyKeys: string[] = Object.keys(schema.properties);
    for (const inbound of ["server", "listener", "socket", "port", "pid", "controlChannel", "lifecycle"]) {
      expect(propertyKeys).not.toContain(inbound);
    }
  });

  it("holds credential references only, never secret material", async () => {
    const schema = await readConfigSchema();
    const credentialItem = schema.properties.credentialRefs.items;
    expect(credentialItem.required).toEqual(["id", "ref"]);
    expect(credentialItem.additionalProperties).toBe(false);
    expect(Object.keys(credentialItem.properties)).toEqual(["id", "ref"]);
  });

  it("accepts exactly the closed single-file shape", async () => {
    const schema = await readConfigSchema();
    const fixture: Record<string, unknown> = {
      schemaVersion: "v0.0.1:meshrix-self-maintenance:local-config-1",
      enabledRevision: "rev-2026-08-16",
      targets: [{ id: "target-1", kind: "agent-runtime" }],
      strategies: [{ id: "strategy-1", kind: "planned-repair" }],
      schedules: [{ id: "schedule-1", cron: "0 3 * * *" }],
      runbooks: [{ id: "runbook-1", steps: [{ operationId: "model_gateway.call" }] }],
      budgets: {
        maxConcurrentCalls: 2,
        maxCallsPerDay: 24,
        maxCostUnitsPerDay: 1000
      },
      operationAllowlist: ["model_gateway.call", "models.list"],
      resourceAllowlist: ["workspace://maintenance"],
      workspaceSelectors: ["workspace-id-maintenance"],
      credentialRefs: [{ id: "model-gateway-client", ref: "credential:model-gateway-client" }]
    };
    expect(Object.keys(fixture).sort()).toEqual([...schema.required].sort());
  });
});
