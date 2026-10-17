import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  formatLocalizedFailures,
  parseFailureLog,
  sanitizeVerificationLog,
  writeVerificationArtifacts
} from "../../../tools/server-scripts/localize-verify-failure.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("pull-request verification feedback", () => {
  it("retains later failures after a truncated structured assertion diff", () => {
    const safe = sanitizeVerificationLog([
      "{", '  "payload": "synthetic private value",',
      " FAIL tests/vitest/server/next.test.ts > next case",
      "AssertionError: expected 1 to equal 2",
      'credential="synthetic private credential"',
      " Test Files  2 failed (2)",
    ].join("\n"));
    expect(safe).not.toContain("synthetic private");
    expect(safe).toContain("FAIL tests/vitest/server/next.test.ts");
    expect(safe).toContain("AssertionError: expected 1 to equal 2");
    expect(safe).toContain("Test Files  2 failed (2)");
  });

  it("retains every diagnostic stage while removing private paths, credentials, key material and runtime output", async () => {
    const secret = ["npm", "syntheticCredentialOnly12345678901234"].join("_");
    const localRoot = ["", "home", "fixture-user", "project"].join("/");
    const log = ["Stage: first", "Error: npm_artifact_failure_1_E404", ...Array.from({ length: 120 }, (_, index) => `diagnostic ${index}`),
      `${localRoot}/src/module.ts:4:2 error TS2322: Type mismatch`, `credential=${secret}`,
      "docker exec cmd=[chown -R 1234:5678 /var/run/act/actions] user=0",
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "), "syntheticKeyBody", ["-----END", "PRIVATE KEY-----"].join(" "),
      'payload: {"content":"synthetic private request"}', 'ciphertext="synthetic encrypted value"',
      "payload: {", '  "message": "synthetic private continuation"', "}",
      "stdout | runtime fixture", "synthetic private output", "", "synthetic continuation",
      "FAIL tests/vitest/server/example.test.ts", "AssertionError: expected 1 to equal 2", "Stage: final"].join("\n");
    const safe = sanitizeVerificationLog(log, localRoot);
    expect(safe.split("\n")).toHaveLength(log.split("\n").length);
    for (const item of ["Stage: first", "npm_artifact_failure_1_E404", "diagnostic 0", "diagnostic 60", "diagnostic 119", "src/module.ts:4:2", "expected 1 to equal 2", "Stage: final"]) expect(safe).toContain(item);
    for (const item of [localRoot, secret, "syntheticKeyBody", "synthetic private", "synthetic encrypted", "synthetic continuation"]) expect(safe).not.toContain(item);
    expect(safe).not.toContain("1234:5678");
    expect(safe).toContain("chown -R <runner-uid>:<runner-gid>");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-ci-diagnostics-"));
    try {
      const report = path.join(directory, "input.json");
      await fs.writeFile(report, JSON.stringify({ suites: [{ id: "example", status: "failed" }], token: secret }));
      await writeVerificationArtifacts(log, path.join(directory, "public"), report);
      expect(await fs.readFile(path.join(directory, "public", "verification.log"), "utf8")).toContain("diagnostic 60");
      const published = JSON.parse(await fs.readFile(path.join(directory, "public", "regression.json"), "utf8"));
      expect(published.suites).toEqual([{ id: "example", status: "failed" }]);
      expect(published.token).toBe("[redacted]");
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

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

  it("routes each CI event through one maintained profile and retains its diagnostics", async () => {
    const workflow = await fs.readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const pullRequestJob = workflow.indexOf("  pull-request-verify:\n");
    const engineeringJob = workflow.indexOf("  engineering:\n");
    const dependencyReview = workflow.indexOf("  dependency-review:\n");
    expect(pullRequestJob).toBeGreaterThan(0);
    expect(engineeringJob).toBeGreaterThan(pullRequestJob);
    expect(dependencyReview).toBeGreaterThan(engineeringJob);

    const prSection = workflow.slice(pullRequestJob, engineeringJob);
    expect(prSection).toContain("if: ${{ github.event_name == 'pull_request' }}");
    expect(prSection).toContain("npm run ci:local -- --report build/ci-diagnostics/local-ci/results.json");
    expect(prSection).toContain("name: Retain sanitized logs and structured results");
    expect(prSection).toContain("if: ${{ always() }}");
    expect(prSection).toContain("build/ci-diagnostics/local-ci/results.json");
    expect(prSection).toContain("build/local-ci/");

    const engineeringSection = workflow.slice(engineeringJob, dependencyReview);
    expect(engineeringSection).toContain("if: ${{ github.event_name != 'pull_request' }}");
    expect(engineeringSection).toContain("npm run ci:local -- --report build/ci-diagnostics/local-ci/results.json");
    expect(engineeringSection).toContain("build/local-ci/");

    const reviewSection = workflow.slice(dependencyReview);
    expect(reviewSection).toContain("name: Dependency review");
    expect(reviewSection).toContain("actions/dependency-review-action@");
  });

});
