import { describe, expect, it } from "vitest";

import {
  BACKEND_FUNCTIONAL_SCOPE,
  BACKEND_FUNCTIONAL_SCOPE_ENV,
  backendFunctionalExcludedTestPatterns,
  backendFunctionalScopeEnvironment
} from "../../lib/backend-functional-test-scope.ts";
import { backendServerShardVitestArgs } from "../../run-functional-backend-server.ts";

describe("backend functional Server shards", () => {
  it("uses two bounded, independently runnable Vitest shards", () => {
    const shardA = backendServerShardVitestArgs("shard-a");
    const shardB = backendServerShardVitestArgs("shard-b");

    expect(shardA).toContain("--shard=1/2");
    expect(shardB).toContain("--shard=2/2");
    expect(shardA).toContain("--maxWorkers=2");
    expect(shardB).toContain("--maxWorkers=2");
    expect(shardA.some((arg) => arg.startsWith("--exclude="))).toBe(false);
    expect(shardB.some((arg) => arg.startsWith("--exclude="))).toBe(false);
    expect(shardA.slice(0, 5)).toEqual(shardB.slice(0, 5));
  });

  it("moves resource-sensitive exclusions into the backend functional scope", () => {
    expect(backendFunctionalExcludedTestPatterns).toContain(
      "tests/vitest/server/upload-custody-workspace-materialization.test.ts"
    );
    expect(backendFunctionalExcludedTestPatterns).toContain(
      "tests/vitest/server/operation-audit-retention.test.ts"
    );
    expect(backendFunctionalScopeEnvironment({ SAFE: "true" })).toEqual({
      SAFE: "true",
      [BACKEND_FUNCTIONAL_SCOPE_ENV]: BACKEND_FUNCTIONAL_SCOPE
    });
  });

  it("rejects an unregistered or missing shard", () => {
    expect(() => backendServerShardVitestArgs("")).toThrow("<missing>");
    expect(() => backendServerShardVitestArgs("shard-c")).toThrow("shard-c");
  });
});
