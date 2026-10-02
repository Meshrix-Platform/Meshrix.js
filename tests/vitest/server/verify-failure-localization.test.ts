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

  it("runs pull requests and stable through the ordered regression and resumable audit checkpoints", async () => {
    const workflow = await fs.readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
    const pullRequestJob = workflow.indexOf("  pull-request-verify:\n");
    const stableCandidate = workflow.indexOf("  stable-candidate:\n");
    const functionalCompleteness = workflow.indexOf("\n  functional-completeness:\n", stableCandidate);
    const stableEnd = workflow.indexOf("\n  node-22-compatibility:\n", functionalCompleteness);
    expect(pullRequestJob).toBeGreaterThan(0);
    expect(stableCandidate).toBeGreaterThan(pullRequestJob);
    expect(functionalCompleteness).toBeGreaterThan(stableCandidate);
    expect(stableEnd).toBeGreaterThan(functionalCompleteness);

    const prSection = workflow.slice(pullRequestJob, stableCandidate);
    expect(prSection).toContain("if: ${{ github.event_name == 'pull_request' }}");
    expect(prSection).toContain('run_check "npm test"');
    expect(prSection).toContain('--command "$command_label"');
    expect(prSection).toContain("localize-verify-failure.ts");
    expect(prSection).toContain("--artifact-dir build/ci-diagnostics --report build/test-reports/latest.json");
    expect(prSection).toContain("path: build/ci-diagnostics/");
    expect(prSection).not.toContain('tail -n 60 "$log_file"');
    expect(prSection).not.toContain("npm run verify");
    expect(prSection).not.toContain("verify:acceptance");
    expect(prSection).not.toContain("--shard");

    const gateSection = workflow.slice(stableCandidate, stableEnd);
    expect(gateSection).toContain("if: ${{ github.event_name == 'push' && github.ref_name == 'stable' }}");
    expect(gateSection).not.toContain("run: npm run verify");
    expect(gateSection).toContain("Ordered repository regression checkpoint");
    expect(gateSection).toContain("Run the canonical four-stage regression");
    expect(gateSection).toContain("Audit checkpoint / ${{ matrix.stage }}");
    expect(gateSection).toContain("Audit checkpoint / resource");
    expect(gateSection).toContain("Audit checkpoint / sandbox");
    expect(gateSection).toContain("Audit checkpoint / console evidence");
    expect(gateSection).toContain("Audit checkpoint / console");
    expect(gateSection).toContain("needs: [repository-checkpoint, audit-console-evidence-checkpoint]");
    expect(gateSection).toContain("stable-console-build-${{ github.sha }}");
    expect(gateSection).toMatch(/- name: Export compiled console assets\n\s+if: \$\{\{ always\(\) \}\}/u);
    expect(gateSection).toContain("stable-console-evidence-${{ github.sha }}");
    expect(gateSection).toContain("--profile audit-stable-resource");
    expect(gateSection).toContain("--profile audit-stable-sandbox");
    expect(gateSection).toContain("--profile audit-stable-console-evidence");
    expect(gateSection).toContain("npm run test:audit:stage");
    expect(gateSection).toContain("npm run test:audit:reduce");
    expect(gateSection).toContain("fail-fast: false");
    expect(gateSection).toContain("timeout-minutes: 120");
    expect(packageJson.scripts["test:audit"]).toContain("--continue-on-failure");
    expect(packageJson.scripts["test:audit"]).toContain("--report build/test-reports/audit-public.json");
  });

  it("binds Dependabot auto-merge to the exact reviewed revision and executed checks", async () => {
    const workflow = await fs.readFile(
      path.join(repoRoot, ".github/workflows/dependabot-security-automerge.yml"),
      "utf8",
    );
    expect(workflow).toContain("'Pull request verification'");
    expect(workflow).toContain("'Dependency review'");
    expect(workflow).not.toContain("'Public platform gate'");
    expect(workflow).not.toContain("'Supply-chain evidence'");
    expect(workflow).toContain("pull_request_review:");
    expect(workflow).toContain("dismissed");
    expect(workflow).toContain("reviews?per_page=100");
    expect(workflow).toContain('"APPROVED"');
    expect(workflow).toContain("check-runs?per_page=100");
    expect(workflow).toContain('--match-head-commit "$head_sha"');
    expect(workflow).not.toContain("--admin");
  });
});


describe("executed Dependabot admission", () => {
  it("requires current write-authorized approval and rejects stale, revoked or failing evidence", async () => {
    const workflow = await fs.readFile(path.join(repoRoot, ".github/workflows/dependabot-security-automerge.yml"), "utf8");
    const source = workflow.slice(workflow.indexOf("      - name: Merge the exact admitted Dependabot revision"));
    const script = source.slice(source.indexOf("        run: |\n") + "        run: |\n".length).split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-dependency-admission-"));
    const eventPath = path.join(directory, "event.json");
    const fixturePath = path.join(directory, "fixture.json");
    const receiptPath = path.join(directory, "merge.json");
    const head = "candidate-head";
    const review = (id: number, state: string, commit = head, login = "maintainer") => ({ id, state, commit_id: commit, user: { login, type: "User" }, author_association: "MEMBER" });
    const checks = ["Pull request verification", "Dependency review"].map((name, index) => ({ id: index + 1, name, conclusion: "success", app: { slug: "github-actions" } }));
    const cases = [
      { name: "approved", reviews: [review(1, "APPROVED")], merge: true },
      { name: "comment preserves operative approval", reviews: [review(1, "APPROVED"), review(2, "COMMENTED")], merge: true },
      { name: "read-only organization member", reviews: [review(1, "APPROVED")], permission: "read", merge: false },
      { name: "stale approval", reviews: [review(1, "APPROVED", "old-head")], merge: false },
      { name: "dismissed", reviews: [review(1, "APPROVED"), review(2, "DISMISSED")], merge: false },
      { name: "changes requested by another maintainer", reviews: [review(1, "APPROVED"), review(2, "CHANGES_REQUESTED", head, "second")], merge: false },
      { name: "prior unresolved change request", reviews: [review(1, "CHANGES_REQUESTED", "old-head", "second"), review(2, "APPROVED")], merge: false },
      { name: "paginated approval", reviews: [review(1, "COMMENTED"), review(2, "APPROVED")], paginate: true, merge: true },
      { name: "failed check", reviews: [review(1, "APPROVED")], failed: true, merge: false },
      { name: "latest rerun supersedes older run", reviews: [review(1, "APPROVED")], rerun: true, merge: true },
      { name: "changed head", reviews: [review(1, "APPROVED")], changed: true, merge: false },
    ];
    try {
      await fs.writeFile(eventPath, JSON.stringify({ pull_request: { number: 7, head: { sha: head } } }));
      await fs.writeFile(path.join(directory, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const f = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "merge") { fs.writeFileSync(process.env.RECEIPT, JSON.stringify(args)); process.exit(0); }
const endpoint = args.find((x) => x.startsWith("repos/"));
let result;
if (endpoint.endsWith("/permission")) { process.stdout.write(f.permission || "write"); process.exit(0); }
if (endpoint.includes("/reviews?")) result = f.paginate ? [f.reviews.slice(0, 1), f.reviews.slice(1)] : [f.reviews];
else if (endpoint.includes("/check-runs?")) result = [{ check_runs: f.checks }];
else result = { user: { login: "dependabot[bot]" }, base: { ref: "nightly" }, head: { sha: f.changed ? "changed-head" : "candidate-head" }, state: "open", labels: [{ name: "dependabot-automerge" }] };
process.stdout.write(JSON.stringify(result));
`);
      await fs.chmod(path.join(directory, "gh"), 0o700);
      for (const entry of cases) {
        const currentChecks = entry.failed ? checks.map((check) => ({ ...check, conclusion: "failure" })) : entry.rerun ? [...checks.map((check) => ({ ...check, conclusion: "failure" })), ...checks.map((check) => ({ ...check, id: check.id + 10 }))] : checks;
        await fs.writeFile(fixturePath, JSON.stringify({ ...entry, checks: currentChecks }));
        await fs.rm(receiptPath, { force: true });
        const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], { encoding: "utf8", env: { PATH: `${directory}:${path.dirname(process.execPath)}:${process.env.PATH}`, EVENT_NAME: "pull_request_review", AUTOMERGE_LABEL: "dependabot-automerge", GITHUB_REPOSITORY: "example/project", GITHUB_EVENT_PATH: eventPath, FIXTURE: fixturePath, RECEIPT: receiptPath } });
        expect(result.status, `${entry.name}: ${result.stderr}`).toBe(0);
        const receipt = await fs.readFile(receiptPath, "utf8").catch(() => "");
        expect(Boolean(receipt), entry.name).toBe(entry.merge);
        if (receipt) expect(JSON.parse(receipt).slice(-2)).toEqual(["--match-head-commit", head]);
      }
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
