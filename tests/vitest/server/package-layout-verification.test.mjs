import { describe, expect, it } from "vitest";

import { packageIncludedMismatches } from "../../../tools/scripts/package-layout-verification.mjs";

describe("repository package inclusion metadata", () => {
  it("compares root entries with the authoritative packed file set", () => {
    expect(packageIncludedMismatches([
      { name: "package.json", packageIncluded: true },
      { name: "internal", packageIncluded: false },
      { name: "packages", packageIncluded: true }
    ], [
      "package.json",
      "packages/runtime/index.mjs"
    ])).toEqual([]);

    expect(packageIncludedMismatches([
      { name: "internal", packageIncluded: true }
    ], [])).toEqual([{
      name: "internal",
      declaredPackageIncluded: true,
      actualPackageIncluded: false
    }]);
  });
});
