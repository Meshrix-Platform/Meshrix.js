import { describe, expect, it } from "vitest";
import { decodeActLog, hasSuccessfulActJob, parseLocalCiArguments } from "../../../tools/scripts/local-ci.ts";
import { sanitizeVerificationLog } from "../../../tools/server-scripts/localize-verify-failure.ts";

describe("local workflow execution boundary", () => {
  it("rejects publishing jobs and credential forwarding before executing act", () => {
    for (const argument of ["release", "publish", "--secret", "--env-file", "--workflows"]) {
      expect(() => parseLocalCiArguments([argument])).toThrow("local_ci_unknown_job");
    }
  });

  it("requires the selected job's real successful terminal record", () => {
    const log = (record: object) => JSON.stringify(record);
    expect(hasSuccessfulActJob(log({ jobID: "check", jobResult: "success" }), "check")).toBe(true);
    for (const record of [
      { jobID: "other", jobResult: "success" },
      { job: "check", jobResult: "success" },
      { jobID: "check", jobResult: "skipped" },
      { jobID: "check", jobResult: "failure" },
      { jobID: "check", jobResult: "success", dryrun: true },
      { jobID: "check", msg: "success" },
    ]) expect(hasSuccessfulActJob(log(record), "check")).toBe(false);
    expect(hasSuccessfulActJob("", "check")).toBe(false);
    expect(hasSuccessfulActJob([
      log({ jobID: "check", jobResult: "success" }),
      log({ jobID: "check", jobResult: "failure" }),
    ].join("\n"), "check")).toBe(false);
  });

  it("selects the real promotion target without accepting arbitrary event overrides", () => {
    expect(parseLocalCiArguments(["branch", "--base", "stable"]).baseRef).toBe("stable");
    for (const args of [["--base"], ["--base", "untrusted"], ["--eventpath", "event.json"]]) {
      expect(() => parseLocalCiArguments(args)).toThrow();
    }
  });

  it("keeps runtime output redacted after decoding act's JSON transport", () => {
    const value = decodeActLog([
      JSON.stringify({ msg: "stdout | tests/vitest/server/example.test.ts" }),
      JSON.stringify({ msg: "synthetic runtime payload" }),
      JSON.stringify({ msg: " FAIL tests/vitest/server/example.test.ts:12" }),
      JSON.stringify({ msg: "AssertionError: expected 1 to equal 2" }),
    ].join("\n"));
    const safe = sanitizeVerificationLog(value);
    expect(safe).not.toContain("synthetic runtime payload");
    expect(safe).toContain("example.test.ts:12");
    expect(safe).toContain("expected 1 to equal 2");
    expect(safe.split("\n")).toHaveLength(4);
  });
});
