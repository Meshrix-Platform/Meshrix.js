import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  applyVitestShard,
  mergeCompatibleSuiteProcesses,
  parseTestShard,
  type TestSuiteEntry
} from "../../../tests/lib/unified-test-runner-execution.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function suite(id: string, file: string, sideEffects = "none"): TestSuiteEntry {
  return {
    id,
    command: "npm",
    args: ["run", "vitest", "--", file],
    timeoutClass: "fast",
    sideEffects,
    flakePolicy: "fail",
    requiredServices: []
  };
}

describe("delivery feedback scale", () => {
  it("merges compatible Vitest suites without crossing execution-policy boundaries", () => {
    const planned = mergeCompatibleSuiteProcesses([
      suite("one", "one.test.ts"),
      suite("two", "two.test.ts"),
      suite("isolated", "isolated.test.ts", "temp-files"),
      { ...suite("node", "unused"), command: "node", args: ["verify.ts"] }
    ]);

    expect(planned).toHaveLength(3);
    expect(planned[0].childSuiteIds).toEqual(["one", "two"]);
    expect(planned[0].args).toEqual(["run", "vitest", "--", "one.test.ts", "two.test.ts"]);
    expect(planned[1].id).toBe("isolated");
  });

  it("adds native Vitest shard arguments only to Vitest processes", () => {
    const shard = parseTestShard("2/4");
    expect(applyVitestShard(suite("one", "one.test.ts"), shard).args).toContain("--shard=2/4");
    expect(() => parseTestShard("0/4")).toThrow();
    expect(() => parseTestShard("2/1")).toThrow();
  });

  it("registers merge, clean-revision cache, and environment-driven sharding", () => {
    const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, "tools/registry/tests.registry.json"), "utf8"));
    const publicProfiles = Object.entries(registry.profiles)
      .filter(([name]) => name.endsWith("-public"));
    expect(publicProfiles.length).toBeGreaterThan(0);
    for (const [name, profile] of publicProfiles as Array<[string, { execution?: Record<string, unknown> }]>) {
      expect(profile.execution).toMatchObject({
        mergeVitestProcesses: true,
        cachePassedResults: true,
        shardEnvironment: "MESHRIX_TEST_SHARD"
      });
      if (name === "core-public") {
        expect(profile.execution?.phases).toHaveLength(4);
      } else {
        expect(profile.execution).not.toHaveProperty("phases");
      }
    }
  });
});
