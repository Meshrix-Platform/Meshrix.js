import { describe, expect, it } from "vitest";

import { runCompleteTargetDiagnostics } from "../../../tools/server-scripts/lib/complete-target-diagnostics.ts";

const targets = Object.freeze(["alpha", "beta", "gamma", "delta"]);

async function runMatrix(failingTargets: readonly string[] = []) {
  const entered: string[] = [];
  const cleaned: string[] = [];
  const failed = new Set(failingTargets);
  return {
    result: await runCompleteTargetDiagnostics({
      targets,
      runTarget: async (target) => {
        entered.push(target);
        try {
          if (failed.has(target)) throw new Error("synthetic_target_failure");
          return { target, status: "passed" };
        } finally {
          cleaned.push(target);
        }
      },
      failureOutcome: (target) => ({ target, status: "failed", reasonCode: "target_failed" })
    }),
    entered,
    cleaned
  };
}

describe("complete downstream target diagnostics", () => {
  it.each([
    ["early", ["alpha"]],
    ["late", ["delta"]],
    ["multiple", ["alpha", "gamma"]]
  ])("runs and cleans the entire matrix after %s failures", async (_label, failures) => {
    const matrix = await runMatrix(failures);
    expect(matrix.entered).toEqual(targets);
    expect(matrix.cleaned).toEqual(targets);
    expect(matrix.result.executedTargets).toEqual(targets);
    expect(matrix.result.unexecutedTargets).toEqual([]);
    expect(matrix.result.outcomes).toHaveLength(targets.length);
    expect(matrix.result.failures.map(({ target }) => target)).toEqual(failures);
  });

  it("retains one success outcome for every declared target", async () => {
    const matrix = await runMatrix();
    expect(matrix.result.failures).toEqual([]);
    expect(matrix.result.unexecutedTargets).toEqual([]);
    expect(matrix.result.outcomes).toEqual(targets.map((target) => ({ target, status: "passed" })));
  });
});
