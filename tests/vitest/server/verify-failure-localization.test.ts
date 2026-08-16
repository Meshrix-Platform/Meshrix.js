import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  formatLocalizedFailures,
  parseFailureLog
} from "../../../tools/server-scripts/localize-verify-failure.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("pull-request verification feedback", () => {
  it("names assertion, file, and command on vitest failures", () => {
    const log = [
      "RUN  v4.1.10",
      "FAIL tests/vitest/server/example.test.ts",
      "AssertionError: expected 1 to equal 2",
      "at /repo/tests/vitest/server/example.test.ts:12:3"
    ].join("\n");
    const failures = parseFailureLog(log, "npm run vitest");
    expect(failures).toHaveLength(1);
    expect(failures[0].assertion).toContain("expected 1 to equal 2");
    expect(failures[0].file).toBe("tests/vitest/server/example.test.ts");
    expect(failures[0].command).toBe("npm run vitest");
    const formatted = formatLocalizedFailures(failures);
    expect(formatted).toContain("assertion: ");
    expect(formatted).toContain("file: tests/vitest/server/example.test.ts");
    expect(formatted).toContain("command: npm run vitest");
  });

  it("names assertion, file, and command on typecheck and oxlint failures", () => {
    const typecheck = [
      "src/app.ts:12:3 - error TS2322: Type 'string' is not assignable to type 'number'.",
      "  at /repo/src/app.ts:12:3"
    ].join("\n");
    const typed = parseFailureLog(typecheck, "npm run typecheck");
    expect(typed).toHaveLength(1);
    expect(typed[0].assertion).toContain("TS2322");
    expect(typed[0].file).toBe("src/app.ts");
    expect(typed[0].command).toBe("npm run typecheck");

    const oxlint = [
      "/repo/packages/a.ts:1:17: error typescript(no-explicit-any): Unexpected `any`."
    ].join("\n");
    const linted = parseFailureLog(oxlint, "npm run typecheck");
    expect(linted).toHaveLength(1);
    expect(linted[0].assertion).toContain("no-explicit-any");
    expect(linted[0].file.endsWith("packages/a.ts")).toBe(true);
    expect(linted[0].line).toBe(1);
  });

  it("returns no facts for a clean log and self-checks through the CLI", () => {
    expect(parseFailureLog("ok\n", "npm run verify")).toEqual([]);
    const result = spawnSync(
      process.execPath,
      ["tools/server-scripts/localize-verify-failure.ts", "--self-test"],
      { cwd: repoRoot, encoding: "utf8" }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("self-test ok");
  });

  it("records the exact failed command supplied by CI", async () => {
    const fixturePath = path.join(repoRoot, "build", "verify-failure-localization.fixture.log");
    await fs.mkdir(path.dirname(fixturePath), { recursive: true });
    await fs.writeFile(
      fixturePath,
      "FAIL tests/vitest/server/example.test.ts\nAssertionError: expected true to be false\n",
      "utf8"
    );
    try {
      const result = spawnSync(
        process.execPath,
        [
          "tools/server-scripts/localize-verify-failure.ts",
          fixturePath,
          "--command",
          "npm run vitest"
        ],
        { cwd: repoRoot, encoding: "utf8" }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("command: npm run vitest");
    } finally {
      await fs.rm(fixturePath, { force: true });
    }
  });

  it("runs pull requests on a distinct fast path while public-gate keeps npm run verify", async () => {
    const workflow = await fs.readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const pullRequestJob = workflow.indexOf("  pull-request-verify:\n");
    const publicGate = workflow.indexOf("  public-gate:\n");
    const functionalCompleteness = workflow.indexOf("\n  functional-completeness:\n", publicGate);
    expect(pullRequestJob).toBeGreaterThan(0);
    expect(publicGate).toBeGreaterThan(pullRequestJob);
    expect(functionalCompleteness).toBeGreaterThan(publicGate);

    const prSection = workflow.slice(pullRequestJob, publicGate);
    expect(prSection).toContain("if: ${{ github.event_name == 'pull_request' }}");
    expect(prSection).toContain('run_check "npm run typecheck"');
    expect(prSection).toContain('run_check "npm run vitest"');
    expect(prSection).toContain('--command "$command_label"');
    expect(prSection).toContain("localize-verify-failure.ts");
    expect(prSection).not.toContain("npm run verify");
    expect(prSection).not.toContain("verify:acceptance");
    expect(prSection).not.toContain("--shard");

    const gateSection = workflow.slice(publicGate, functionalCompleteness);
    expect(gateSection).toContain("if: ${{ github.event_name != 'pull_request'");
    expect(gateSection).toContain("run: npm run verify");
    expect(gateSection).toContain("timeout-minutes: 120");
  });
});
