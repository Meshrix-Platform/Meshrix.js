import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  MAINTENANCE_PLUGIN_MESHRIX_IMPORT,
  MESHRIX_TO_MAINTENANCE_PLUGIN_EDGE,
  MODEL_GATEWAY_SERVICE_MESHRIX_RUNTIME_IMPORT,
  PLUGIN_CONFINEMENT_FORBIDDEN_AUTHORITIES,
  PLUGIN_LIFECYCLE_ACTIVATION_CHANGES_AVAILABILITY,
  PLUGIN_LIFECYCLE_ACTIVATION_CHANGES_TRAFFIC,
  assertNoMeshrixMaintenanceEdge,
  assertPluginConfinement,
  createPluginActivationResult
} from "@meshrix/contracts/plugins/plugin-confinement-contract";

describe("Plugin confinement port", () => {
  it("forbids Workspace, application-stage, selection, and maintenance authorities", () => {
    expect(PLUGIN_CONFINEMENT_FORBIDDEN_AUTHORITIES).toEqual(expect.arrayContaining([
      "workspace",
      "application_stage",
      "semantics",
      "identity",
      "authorization",
      "credential",
      "policy",
      "channel_selection",
      "model_gateway_lifecycle",
      "maintenance"
    ]));
  });

  it("accepts only availability-only lifecycle declarations", () => {
    const declaration = assertPluginConfinement({
      schemaVersion: "v0.0.1:plugin:confinement-1",
      pluginId: "plugins/external-gateway",
      forbiddenAuthorities: [...PLUGIN_CONFINEMENT_FORBIDDEN_AUTHORITIES],
      lifecycleAuthority: "availability_only"
    });
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(() => assertPluginConfinement({
      schemaVersion: "v0.0.1:plugin:confinement-1",
      pluginId: "plugins/external-gateway",
      forbiddenAuthorities: [],
      lifecycleAuthority: "availability_only"
    })).toThrow("plugin_confinement_forbidden_authorities_required");
    expect(() => assertPluginConfinement({
      schemaVersion: "v0.0.1:plugin:confinement-1",
      pluginId: "plugins/external-gateway",
      forbiddenAuthorities: [...PLUGIN_CONFINEMENT_FORBIDDEN_AUTHORITIES],
      lifecycleAuthority: "traffic_owner"
    })).toThrow("plugin_confinement_lifecycle_must_be_availability_only");
  });

  it("keeps activation availability-only and never traffic-changing", () => {
    expect(PLUGIN_LIFECYCLE_ACTIVATION_CHANGES_TRAFFIC).toBe(false);
    expect(PLUGIN_LIFECYCLE_ACTIVATION_CHANGES_AVAILABILITY).toBe(true);
    const result = createPluginActivationResult(["external:downstream:caddy"]);
    expect(result.trafficChanged).toBe(false);
    expect(Object.isFrozen(result.availableChoices)).toBe(true);
  });

  it("contains no Meshrix-to-maintenance or Service-to-Meshrix dependency edge", async () => {
    expect(MESHRIX_TO_MAINTENANCE_PLUGIN_EDGE).toBe("none");
    expect(MAINTENANCE_PLUGIN_MESHRIX_IMPORT).toBe("none");
    expect(MODEL_GATEWAY_SERVICE_MESHRIX_RUNTIME_IMPORT).toBe("none");
    assertNoMeshrixMaintenanceEdge(["plugins/agents/codex", "plugins/agents/claude-code"]);
    expect(() => assertNoMeshrixMaintenanceEdge(["plugins/agents/meshrix-self-maintenance"]))
      .toThrow("meshrix_to_maintenance_plugin_edge_forbidden");

    const url = new URL(
      "../../../plugins/agents/meshrix-self-maintenance/contracts",
      import.meta.url
    );
    const entries = await fs.readdir(url);
    expect(entries.some((entry) => entry.endsWith(".ts")
      || entry.endsWith(".js")
      || entry.endsWith(".mjs"))).toBe(false);
  });
});
