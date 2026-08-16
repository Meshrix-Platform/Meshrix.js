import { describe, expect, it } from "vitest";
import {
  FEATURE_MANIFEST,
  filterOperationsForFeatures,
  resolveEdition
} from "../../../packages/server-runtime/src/composition/features/feature-manifest.ts";

describe("feature manifest public boundary", () : any => {
  it("treats an explicit empty feature deployment as exposing no operations", () : any => {
    const operations: any[] = [{ id: "fixture.read", featureId: "fixture" }];

    expect(filterOperationsForFeatures(operations, null)).toHaveLength(1);
    expect(filterOperationsForFeatures(operations, { activeFeatureIds: [] })).toEqual([]);
  });

  it("keeps public editions focused on the current internal platform baseline", () : any => {
    expect(Object.keys(FEATURE_MANIFEST.editions)).toEqual(["core", "standard", "integrations"]);
    const core: any = resolveEdition("core");
    const standard: any = resolveEdition("standard");
    const integrations: any = resolveEdition("integrations");
    expect(() : any => resolveEdition("custom")).toThrow(/Unknown edition: custom/);

    expect(core.includes).toContain("operation-permission-core");
    expect(core.includes).toContain("downstream-mcp");
    expect(core.includes).toContain("upstream-gateway");
    expect(standard.includes).toContain("operation-permission-core");
    expect(standard.includes).toEqual(core.includes);
    expect(integrations.includes).toEqual(core.includes);
  });
});
