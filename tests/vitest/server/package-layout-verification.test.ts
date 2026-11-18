import { describe, expect, it } from "vitest";

import { packageIncludedMismatches } from "../../../tools/scripts/package-layout-verification.ts";

describe("repository package inclusion metadata", () : any => {
  it("compares root entries with the authoritative packed file set", () : any => {
    expect(packageIncludedMismatches([
      { name: "package.json", packageIncluded: true },
      { name: "internal", packageIncluded: false },
      { name: "packages", packageIncluded: true }
    ], [
      "package.json",
      "packages/runtime/index.ts"
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
