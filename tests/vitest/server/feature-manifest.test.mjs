import { describe, expect, it } from "vitest";
import {
  FEATURE_MANIFEST,
  filterOperationsForFeatures,
  resolveEdition
} from "../../../packages/server-runtime/src/composition/features/feature-manifest.mjs";

describe("feature manifest public boundary", () => {
  it("treats an explicit empty feature deployment as exposing no operations", () => {
    const operations = [{ id: "fixture.read", featureId: "fixture" }];

    expect(filterOperationsForFeatures(operations, null)).toHaveLength(1);
    expect(filterOperationsForFeatures(operations, { activeFeatureIds: [] })).toEqual([]);
  });

  it("keeps public editions focused on the current open platform baseline", () => {
    expect(Object.keys(FEATURE_MANIFEST.editions)).toEqual(["core", "standard", "integrations"]);
    const core = resolveEdition("core");
    const standard = resolveEdition("standard");
    const integrations = resolveEdition("integrations");
    expect(() => resolveEdition("custom")).toThrow(/Unknown edition: custom/);

    expect(core.includes).toContain("operation-permission-core");
    expect(core.includes).toContain("downstream-mcp");
    expect(core.includes).toContain("upstream-gateway");
    expect(core.includes).toContain("agent-gateway");
    expect(standard.includes).toContain("operation-permission-core");
    expect(standard.includes).toContain("agent-gateway");
    expect(integrations.includes).toContain("external-gateway");
  });
});
