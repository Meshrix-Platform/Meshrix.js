import { describe, expect, it } from "vitest";

import {
  analyzeSourceText,
  verifySourceOrganizationAstAdvisoryContract
} from "../../../tools/server-scripts/lib/repo-organization-ast-advisory.ts";

describe("source organization AST advisory", () : any => {
  it("keeps its table-driven parser contract current", async () : Promise<any> => {
    await expect(verifySourceOrganizationAstAdvisoryContract()).resolves.toEqual({
      passed: true,
      skipped: false,
      caseCount: 4
    });
  });

  it("reports independent exported behavior components as a review candidate", async () : Promise<any> => {
    const result: any = await analyzeSourceText({
      file: "fixtures/independent-runtime.ts",
      source: [
        "export function parseInput(value: string) { return value.trim(); }",
        "export const serializeOutput = (value: object) => JSON.stringify(value);"
      ].join("\n")
    });

    expect(result).toMatchObject({
      classification: "split-candidate",
      finding: {
        code: "independent_exported_behavior_components",
        releaseBlocking: false,
        evidence: {
          exportedBehaviorComponentCount: 2
        }
      }
    });
  });

  it("reports shared mutable state as a caution instead of a split recommendation", async () : Promise<any> => {
    const result: any = await analyzeSourceText({
      file: "fixtures/shared-runtime.ts",
      source: [
        "let state = 0;",
        "export function readState() { return state; }",
        "export function updateState() { state += 1; }"
      ].join("\n")
    });

    expect(result).toMatchObject({
      classification: "mechanical-split-caution",
      finding: {
        code: "mechanical_split_requires_design",
        releaseBlocking: false,
        reasons: expect.arrayContaining(["shared_mutable_state"])
      }
    });
  });

  it("does not guess across Vue template bindings", async () : Promise<any> => {
    const result: any = await analyzeSourceText({
      file: "fixtures/runtime-view.vue",
      source: "<script setup lang=\"ts\">const value = 1;</script><template>{{ value }}</template>"
    });

    expect(result).toEqual({
      file: "fixtures/runtime-view.vue",
      classification: "unsupported",
      reason: "vue_template_bindings_not_modeled"
    });
  });
});
