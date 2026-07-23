import { describe, expect, it } from "vitest";

import { testSuiteReachabilityIssues } from "../../../tools/registry/test-suite-reachability.mjs";

describe("test suite public-profile reachability", () => {
  it("accepts coverage suites reached directly or through profile inheritance", () => {
    expect(testSuiteReachabilityIssues({
      profiles: {
        "core-public": { suites: ["suite.core"] },
        "audit-public": { extends: "core-public", suites: ["suite.audit"] }
      },
      suites: [
        { id: "suite.core", coverageContribution: true },
        { id: "suite.audit", coverageContribution: true }
      ]
    })).toEqual([]);
  });

  it("rejects a coverage suite that no public profile can execute", () => {
    expect(testSuiteReachabilityIssues({
      profiles: {
        "core-public": { suites: ["suite.core"] },
        changed: { dynamic: true, suites: ["suite.orphan"] }
      },
      suites: [
        { id: "suite.core", coverageContribution: true },
        { id: "suite.orphan", coverageContribution: true }
      ]
    })).toContain(
      'tests: coverage-contributing suite "suite.orphan" is unreachable from every public profile'
    );
  });
});
