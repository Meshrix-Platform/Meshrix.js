import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  LONG_LIVED_BRANCHES,
  evaluateBranchFlow,
  verifyProtectedPushTopology
} from "../../../tools/scripts/verify-branch-flow.ts";
import {
  githubProcessEnvironment,
  isTransientGithubFailure,
  extractSafeFailureSignals,
  jobsFailedBeforeRunnerAssignment,
  promotionDecision,
  requiredWorkflowPaths,
  runnerAssignmentRetryDelay,
  selectLatestWorkflowRun,
  verifyUpdatedReference,
} from "../../../tools/server-scripts/promote-release-branches.ts";

const ROOT: any = path.resolve(import.meta.dirname, "../../..");

function read(relativePath?: any) : any {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function branchTips(tips?: any) : any {
  return (name?: any) : any => tips?.[name] || "";
}

function sameRepositoryPayload(base?: any, head?: any) : any {
  return {
    repository: { full_name: "example/repository" },
    pull_request: {
      base: { ref: base },
      head: { ref: head, repo: { full_name: "example/repository" } }
    }
  };
}

describe("branch promotion workflow", () : any => {
  it("keeps nightly direct-write feedback without a promotion gate", () : any => {
    expect(LONG_LIVED_BRANCHES).toEqual(["nightly", "stable", "release"]);

    const direct: any = verifyProtectedPushTopology({
      branch: "nightly",
      before: "old-nightly",
      after: "nightly-tip",
      ancestor: () : any => true,
    });
    expect(direct).toEqual({ ok: true, code: "direct-nightly-advance" });

    const merge: any = verifyProtectedPushTopology({
      branch: "nightly",
      before: "old-nightly",
      after: "nightly-tip",
      ancestor: () : any => true,
    });
    expect(merge).toEqual({ ok: true, code: "direct-nightly-advance" });

    const nonFastForward: any = verifyProtectedPushTopology({
      branch: "nightly",
      before: "old-nightly",
      after: "nightly-tip",
      ancestor: () : any => false,
    });
    expect(nonFastForward.ok).toBe(false);
    expect(nonFastForward.code).toBe("protected-branch-not-fast-forward");

  });

  it("automates exact-tip promotion and waits only for each branch authority", () : any => {
    const candidate: any = "c".repeat(40);
    const current: any = "a".repeat(40);
    expect(promotionDecision({ current, candidate, ancestor: () : any => true }))
      .toEqual({ action: "advance" });
    expect(promotionDecision({ current: candidate, candidate, ancestor: () : any => false }))
      .toEqual({ action: "already-current" });
    expect(() : any => promotionDecision({ current, candidate, ancestor: () : any => false }))
      .toThrow("promotion_not_fast_forward");
    expect(verifyUpdatedReference(JSON.stringify({ object: { sha: candidate } }), candidate))
      .toBe(candidate);
    expect(() : any => verifyUpdatedReference(
      JSON.stringify({ object: { sha: current } }),
      candidate,
      "stable_promotion_not_observed",
    )).toThrow("stable_promotion_not_observed");

    expect(requiredWorkflowPaths("nightly")).toEqual([
      ".github/workflows/branch-flow.yml",
      ".github/workflows/ci.yml",
    ]);
    expect(requiredWorkflowPaths("stable")).toEqual([
      ".github/workflows/branch-flow.yml",
      ".github/workflows/ci.yml",
    ]);
    expect(requiredWorkflowPaths("release")).toEqual([
      ".github/workflows/branch-flow.yml",
      ".github/workflows/ci.yml",
    ]);

    const run: any = selectLatestWorkflowRun([
      { id: 10, path: ".github/workflows/ci.yml", event: "push", head_branch: "stable", head_sha: candidate, run_attempt: 1 },
      { id: 11, path: ".github/workflows/ci.yml", event: "push", head_branch: "stable", head_sha: candidate, run_attempt: 2 },
      { id: 12, path: ".github/workflows/ci.yml", event: "push", head_branch: "nightly", head_sha: candidate, run_attempt: 3 },
    ], { branch: "stable", candidate, workflowPath: ".github/workflows/ci.yml" });
    expect(run?.id).toBe(11);
    expect(githubProcessEnvironment({ EXAMPLE: "retained" })).toEqual({
      EXAMPLE: "retained",
      GODEBUG: "http2client=0",
    });
    expect(isTransientGithubFailure("Get request: EOF")).toBe(true);
    expect(isTransientGithubFailure("HTTP 503 service unavailable")).toBe(true);
    expect(isTransientGithubFailure("HTTP 403 forbidden")).toBe(false);
    expect(jobsFailedBeforeRunnerAssignment([
      { runnerAssigned: false, steps: [] },
      { runnerAssigned: false, steps: [] },
    ])).toBe(true);
    expect(jobsFailedBeforeRunnerAssignment([
      { runnerAssigned: true, steps: [] },
    ])).toBe(false);
    expect(jobsFailedBeforeRunnerAssignment([
      { runnerAssigned: false, steps: ["Install dependencies"] },
    ])).toBe(false);
    expect([1, 2, 3, 4, 8].map(runnerAssignmentRetryDelay)).toEqual([
      30_000,
      60_000,
      120_000,
      300_000,
      300_000,
    ]);
    expect(extractSafeFailureSignals([
      "FAILED execution-sandbox.controlled-runtime (1200ms)",
      "FAILED noisy",
      "productionBackendFailedChecks=cpuLimitEnforced,pidLimitEnforced",
      "productionBackendProbeFailures=sandbox_runtime_failed:oci_create_failed",
      "productionBackendProbeFailures=sandbox_runtime_failed:oci_create_failed:oci_option_unsupported:125",
      "private payload must not pass through",
    ].join("\n"))).toEqual([
      "check:cpuLimitEnforced",
      "check:pidLimitEnforced",
      "probe:sandbox_runtime_failed:oci_create_failed",
      "suite:execution-sandbox.controlled-runtime",
    ]);
    const automation: any = read("tools/server-scripts/promote-release-branches.ts");
    expect(automation).not.toContain('["run", "rerun", String(selected.id), "--failed"]');
    expect(automation).not.toContain("MAX_WORKFLOW_WAIT_MS");
    expect(automation).not.toContain("MAX_GITHUB_ATTEMPTS");
    expect(automation).not.toContain("_wait_timeout");
    expect(automation).not.toContain("resumedRunnerAssignmentFailures");
    expect(automation).not.toContain("resumeRequestedAttempt");
    expect(automation).not.toContain('remoteRevision(repository, "nightly") !== candidate');
  });

  it("requires canonical accepted-generation resolution before promotion", () : any => {
    const automation: any = read("tools/server-scripts/promote-release-branches.ts");
    expect(automation).toContain("resolveCurrentAcceptedCandidate");
    expect(automation).toContain("await ensureLocalCandidate(options.candidate)");
    expect(automation).not.toContain("pointer.generation");
  });

  it("admits stable and release only when the after commit is the exact upstream tip", () : any => {
    const stable: any = verifyProtectedPushTopology({
      branch: "stable",
      before: "old-stable",
      after: "nightly-tip",
      branchTip: branchTips({ nightly: "nightly-tip" }),
      ancestor: () : any => true,
    });
    expect(stable).toEqual({ ok: true, code: "nightly-fast-forward-advanced-stable" });

    const release: any = verifyProtectedPushTopology({
      branch: "release",
      before: "old-release",
      after: "stable-tip",
      branchTip: branchTips({ stable: "stable-tip" }),
      ancestor: () : any => true,
    });
    expect(release).toEqual({ ok: true, code: "stable-fast-forward-advanced-release" });
  });

  it("rejects wrong sources, stale bases, and bootstrap pushes on protected branches", () : any => {
    const wrongStableSource: any = verifyProtectedPushTopology({
      branch: "stable",
      before: "old-stable",
      after: "feature-tip",
      branchTip: branchTips({ nightly: "nightly-tip" }),
      ancestor: () : any => true,
    });
    expect(wrongStableSource.ok).toBe(false);
    expect(wrongStableSource.code).toBe("promotion-source-tip-mismatch");

    const wrongReleaseSource: any = verifyProtectedPushTopology({
      branch: "release",
      before: "old-release",
      after: "nightly-tip",
      branchTip: branchTips({ stable: "stable-tip" }),
      ancestor: () : any => true,
    });
    expect(wrongReleaseSource.ok).toBe(false);
    expect(wrongReleaseSource.code).toBe("promotion-source-tip-mismatch");

    const nonFastForwardStable: any = verifyProtectedPushTopology({
      branch: "stable",
      before: "old-stable",
      after: "nightly-tip",
      branchTip: branchTips({ nightly: "nightly-tip" }),
      ancestor: () : any => false,
    });
    expect(nonFastForwardStable.ok).toBe(false);
    expect(nonFastForwardStable.code).toBe("protected-branch-not-fast-forward");

    const bootstrap: any = verifyProtectedPushTopology({
      branch: "stable",
      before: "0".repeat(40),
      after: "nightly-tip",
      branchTip: branchTips({ nightly: "nightly-tip" }),
    });
    expect(bootstrap.ok).toBe(false);
    expect(bootstrap.code).toBe("protected-branch-bootstrap-forbidden");

    const invalidBranch: any = verifyProtectedPushTopology({
      branch: "main",
      before: "old",
      after: "new",
      branchTip: branchTips({ main: "old" })
    });
    expect(invalidBranch.ok).toBe(false);
    expect(invalidBranch.code).toBe("protected-branch-invalid");
  });

  it("governs pull-request promotion sources to one direct upstream per long-lived branch", () : any => {
    expect(evaluateBranchFlow({
      eventName: "push",
      refName: "nightly"
    })).toEqual({ ok: true, code: "protected-push-event" });
    expect(evaluateBranchFlow({
      eventName: "push",
      refName: "main"
    }).ok).toBe(false);

    expect(evaluateBranchFlow({
      eventName: "pull_request",
      baseRef: "nightly",
      headRef: "agent/security-review",
      payload: sameRepositoryPayload("nightly", "agent/security-review")
    })).toEqual({ ok: true, code: "temporary-to-nightly" });
    expect(evaluateBranchFlow({
      eventName: "pull_request",
      baseRef: "stable",
      headRef: "nightly",
      payload: sameRepositoryPayload("stable", "nightly")
    })).toEqual({ ok: true, code: "nightly-to-stable" });
    expect(evaluateBranchFlow({
      eventName: "pull_request",
      baseRef: "release",
      headRef: "stable",
      payload: sameRepositoryPayload("release", "stable")
    })).toEqual({ ok: true, code: "stable-to-release" });

    expect(evaluateBranchFlow({
      eventName: "pull_request",
      baseRef: "nightly",
      headRef: "stable",
      payload: sameRepositoryPayload("nightly", "stable")
    }).ok).toBe(false);
    expect(evaluateBranchFlow({
      eventName: "pull_request",
      baseRef: "release",
      headRef: "nightly",
      payload: sameRepositoryPayload("release", "nightly")
    }).ok).toBe(false);

    const crossRepository: any = sameRepositoryPayload("nightly", "agent/security-review");
    crossRepository.pull_request.head.repo.full_name = "fork/repository";
    expect(evaluateBranchFlow({
      eventName: "pull_request",
      baseRef: "nightly",
      headRef: "agent/security-review",
      payload: crossRepository
    }).ok).toBe(false);
    expect(evaluateBranchFlow({
      eventName: "pull_request",
      baseRef: "main",
      headRef: "agent/security-review",
      payload: sameRepositoryPayload("main", "agent/security-review")
    }).ok).toBe(false);
  });


});
