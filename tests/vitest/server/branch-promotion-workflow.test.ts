import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DIRECT_UPSTREAM,
  LONG_LIVED_BRANCHES,
  evaluateBranchFlow,
  readGithubJson,
  selectLatestCandidateWorkflowRun,
  verifyProtectedPushTopology,
  verifyPublishedRelease
} from "../../../tools/scripts/verify-branch-flow.ts";
import { compareReleaseVersions } from "../../../tools/server-scripts/lib/release-metadata.ts";
import {
  completedReleasePromotionMatches,
  createPromotionReport,
  ensureLocalCandidate,
  findPromotionPullRequest,
  parseArgs,
  githubProcessEnvironment,
  isTransientGithubFailure,
  promotionRequestDecision,
  repositoryFromOrigin,
  requestPromotion,
  verifyCompletedPromotion,
} from "../../../tools/server-scripts/promote-release-branches.ts";

function promotionPr({ branch, source, headSha, mergeCommit, repository = "example/repository", ...overrides }: any): any {
  return {
    number: 42,
    merged_at: "2026-01-01T00:00:00Z",
    merge_commit_sha: mergeCommit,
    base: { ref: branch, repo: { full_name: repository } },
    head: { ref: source, sha: headSha, repo: { full_name: repository } },
    ...overrides
  };
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

  it("keeps the github transport helpers used by the request path", () : any => {
    expect(githubProcessEnvironment({ EXAMPLE: "retained" })).toEqual({
      EXAMPLE: "retained",
      GODEBUG: "http2client=0",
    });
    expect(isTransientGithubFailure("Get request: EOF")).toBe(true);
    expect(isTransientGithubFailure("HTTP 503 service unavailable")).toBe(true);
    expect(isTransientGithubFailure("HTTP 403 forbidden")).toBe(false);
  });

  it("parses only canonical GitHub origin URLs into a repository slug", () : any => {
    expect(repositoryFromOrigin("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(repositoryFromOrigin("git@github.com:owner/repo")).toBe("owner/repo");
    expect(repositoryFromOrigin("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(repositoryFromOrigin("https://github.com/owner/repo")).toBe("owner/repo");
    expect(repositoryFromOrigin("ssh://git@github.com/owner/repo.git")).toBe("owner/repo");
    expect(repositoryFromOrigin("git@github.com:owner/re.po")).toBe("owner/re.po");
    expect(repositoryFromOrigin("git@github.com:owner/repo.gitx")).not.toBe("owner/repo");
    for (const origin of [
      "https://gitlab.com/owner/repo",
      "https://token@github.com/owner/repo.git",
      "git@other-host.example:owner/repo.git",
      "owner/repo",
      "https://github.com/owner",
      "https://github.com/owner/repo/sub/path.git",
    ]) {
      expect(() : any => repositoryFromOrigin(origin), origin).toThrow("github_repository_invalid");
    }
  });

  it("requires an available exact Git candidate before promotion", () => {
    const candidate = "a".repeat(40);
    const calls: any[] = [];
    const gitCommand: any = (args: any, code: any) => { calls.push({ args, code }); return ""; };
    expect(ensureLocalCandidate(candidate, gitCommand)).toBe(candidate);
    expect(calls).toEqual([{ args: ["cat-file", "-e", `${candidate}^{commit}`], code: "candidate_revision_unavailable" }]);
    expect(() => ensureLocalCandidate("not-a-revision", gitCommand)).toThrow("candidate_revision_required");
    expect(calls).toHaveLength(1);
    expect(() => ensureLocalCandidate(candidate, () => { throw new Error("candidate_revision_unavailable"); })).toThrow("candidate_revision_unavailable");
  });

  it("requests a promotion only for the exact source tip containing the target", () : any => {
    const candidate: any = "c".repeat(40);
    const current: any = "a".repeat(40);
    const older: any = "b".repeat(40);
    const ancestry: any = new Set([`${current}->${candidate}`]);
    const ancestor: any = (left: any, right: any) : any => ancestry.has(`${left}->${right}`);
    expect(promotionRequestDecision({
      target: "stable", candidate, sourceRevision: candidate, current, ancestor
    })).toEqual({ action: "request", source: "nightly" });
    expect(promotionRequestDecision({
      target: "stable", candidate: current, sourceRevision: current, current, ancestor
    })).toEqual({ action: "already-promoted", source: "nightly" });
    ancestry.add(`${candidate}->${older}`);
    expect(promotionRequestDecision({
      target: "stable", candidate, sourceRevision: candidate, current: older, ancestor
    })).toEqual({ action: "already-promoted", source: "nightly" });
    expect(() : any => promotionRequestDecision({
      target: "stable", candidate, sourceRevision: older, current, ancestor
    })).toThrow("promotion_source_tip_mismatch");
    expect(() : any => promotionRequestDecision({
      target: "stable", candidate: older, sourceRevision: older, current, ancestor
    })).toThrow("promotion_source_requires_target_sync");
    expect(() : any => promotionRequestDecision({
      target: "nightly", candidate, sourceRevision: candidate, current, ancestor
    })).toThrow("promotion_target_invalid");
    expect(() : any => promotionRequestDecision({
      target: "stable", candidate: "short", sourceRevision: candidate, current, ancestor
    })).toThrow("candidate_revision_invalid");
  });

  it("finds or requests only an observed same-repository promotion pull request", async () : Promise<void> => {
    const repository: any = "example/repository";
    const candidate: any = "c".repeat(40);
    const openPr: any = promotionPr({ branch: "stable", source: "nightly", headSha: candidate, mergeCommit: null, state: "open", merged_at: null });
    const mergedPr: any = promotionPr({ branch: "stable", source: "nightly", headSha: candidate, mergeCommit: "stable-merge", state: "closed" });
    const findCalls: any[] = [];
    const readGithub: any = async (route: any) : Promise<any> => {
      findCalls.push(route);
      if (route.includes("/pulls?")) {
        if (route.includes("page=2")) {
          return [promotionPr({ branch: "stable", source: "nightly", headSha: candidate, mergeCommit: null, state: "open", merged_at: null, number: 99 })];
        }
        return [
          promotionPr({ branch: "stable", source: "agent/feature", headSha: candidate, mergeCommit: null, state: "open", merged_at: null }),
          promotionPr({ branch: "nightly", source: "nightly", headSha: candidate, mergeCommit: null, state: "open", merged_at: null }),
          promotionPr({ branch: "stable", source: "nightly", headSha: candidate, mergeCommit: null, state: "closed", merged_at: null }),
          promotionPr({ branch: "stable", source: "nightly", headSha: "d".repeat(40), mergeCommit: null, state: "open", merged_at: null }),
          promotionPr({ branch: "stable", source: "nightly", headSha: candidate, mergeCommit: null, state: "open", merged_at: null, head: { ref: "nightly", sha: candidate, repo: { full_name: "fork/repository" } } }),
          ...Array(95).fill(null).map(() : any => ({ number: 1 })),
        ];
      }
      throw new Error(`unexpected-route:${route}`);
    };
    expect((await findPromotionPullRequest({ repository, target: "stable", candidate, readGithub }))?.number).toBe(99);
    expect(findCalls.filter((route: any) : any => route.includes("page=2"))).toHaveLength(1);

    findCalls.length = 0;
    expect(await findPromotionPullRequest({ repository, target: "stable", candidate,
      readGithub: async () : Promise<any> => [openPr] })).toBe(openPr);
    expect(await findPromotionPullRequest({ repository, target: "stable", candidate,
      readGithub: async () : Promise<any> => [mergedPr] })).toBe(mergedPr);

    let creates = 0;
    const created: any = await requestPromotion({
      repository, target: "stable", candidate,
      readGithub: async (route: any) : Promise<any> => (creates === 0 ? [] : [openPr]),
      createPullRequest: async () : Promise<any> => { creates += 1; },
    });
    expect(created).toBe(openPr);
    expect(creates).toBe(1);

    creates = 0;
    expect(await requestPromotion({
      repository, target: "stable", candidate,
      readGithub: async () : Promise<any> => [openPr],
      createPullRequest: async () : Promise<any> => { creates += 1; },
    })).toBe(openPr);
    expect(creates).toBe(0);

    await expect(findPromotionPullRequest({
      repository, target: "stable", candidate,
      readGithub: async () : Promise<any> => ({ message: "error" }),
    })).rejects.toThrow("promotion_pull_requests_invalid");
    await expect(requestPromotion({
      repository, target: "stable", candidate,
      readGithub: async () : Promise<any> => [],
      createPullRequest: async () : Promise<any> => { creates += 1; },
    })).rejects.toThrow("promotion_pull_request_not_observed");

    creates = 0;
    await expect(requestPromotion({
      repository, target: "stable", candidate,
      readGithub: async () : Promise<any> => { throw new Error("read-unavailable"); },
      createPullRequest: async () : Promise<any> => { creates += 1; },
    })).rejects.toThrow("read-unavailable");
    expect(creates).toBe(0);

    let present = false;
    const resumedRequest: any = {
      repository, target: "stable", candidate,
      readGithub: async () : Promise<any> => (present ? [openPr] : []),
      createPullRequest: async () : Promise<any> => {
        creates += 1;
        present = true;
        throw new Error("connection-lost-after-create");
      },
    };
    await expect(requestPromotion(resumedRequest)).rejects.toThrow("connection-lost-after-create");
    expect(creates).toBe(1);
    expect(await requestPromotion(resumedRequest)).toBe(openPr);
    expect(creates).toBe(1);
  });

  it("verifies a completed guarded merge against frozen parents and workflow proof", async () : Promise<void> => {
    const repository: any = "example/repository";
    const candidate: any = "b".repeat(40);
    const before: any = "a".repeat(40);
    const mergeCommit: any = "c".repeat(40);
    const currentTarget: any = "d".repeat(40);
    const pr: any = promotionPr({ branch: "stable", source: "nightly", headSha: candidate, mergeCommit });
    const tree: any = "e".repeat(40);
    const run: any = {
      id: 30, run_attempt: 1, event: "pull_request", status: "completed", conclusion: "success",
      head_sha: candidate, head_branch: "nightly", path: "", pull_requests: [{ number: 42 }],
    };
    const makeSeams = (overrides: any = {}) : any => ({
      readGit: (args: any) : any => {
        const key: any = args.join(" ");
        const map: any = {
          [`rev-list --parents -n 1 ${mergeCommit}`]: `${mergeCommit} ${before} ${candidate}`,
          [`rev-parse ${mergeCommit}^{tree}`]: tree,
          [`rev-parse ${candidate}^{tree}`]: tree,
          ...overrides.git,
        };
        if (!(key in map)) throw new Error(`unexpected-git:${key}`);
        return map[key];
      },
      readGithub: async (route: any) : Promise<any> => {
        for (const workflowPath of [".github/workflows/branch-flow.yml", ".github/workflows/ci.yml"]) {
          const filename: any = workflowPath.split("/").pop();
          if (route === `${"/repos"}/${repository}/actions/workflows/${filename}/runs?event=pull_request&head_sha=${candidate}&branch=nightly&per_page=100`) {
            const runs: any = overrides.runs?.[workflowPath] ?? [{ ...run, path: workflowPath }];
            if (!Array.isArray(runs)) return { workflow_runs: runs };
            return { workflow_runs: runs };
          }
        }
        throw new Error(`unexpected-route:${route}`);
      },
      ancestor: (left: any, right: any) : any => (overrides.ancestry ?? new Set([`${before}->${candidate}`, `${mergeCommit}->${currentTarget}`])).has(`${left}->${right}`),
    });
    const observed: any = await verifyCompletedPromotion({
      repository, target: "stable", candidate, pr, currentTarget, ...makeSeams()
    });
    expect(observed).toEqual({
      targetContainsMerge: true,
      publication: null,
      checks: [
        { workflowPath: ".github/workflows/branch-flow.yml", runId: 30, sourceRevision: candidate, conclusion: "success" },
        { workflowPath: ".github/workflows/ci.yml", runId: 30, sourceRevision: candidate, conclusion: "success" },
      ],
    });

    const failing: any[] = [
      ["unmerged", { pr: { ...pr, merged_at: null } }, "promotion_not_merged"],
      ["wrong candidate", { candidate: "d".repeat(40) }, "promotion_not_merged"],
      ["no merge sha", { pr: { ...pr, merge_commit_sha: null } }, "promotion_not_merged"],
      ["single parent", { git: { [`rev-list --parents -n 1 ${mergeCommit}`]: `${mergeCommit} ${before}` } }, "promotion_merge_not_bound"],
      ["swapped parents", { git: { [`rev-list --parents -n 1 ${mergeCommit}`]: `${mergeCommit} ${candidate} ${before}` } }, "promotion_merge_not_bound"],
      ["target not descendant", { ancestry: new Set([`${before}->${candidate}`]) }, "promotion_merge_not_bound"],
      ["mismatched tree", { git: { [`rev-parse ${candidate}^{tree}`]: "f".repeat(40) } }, "promotion_merge_not_bound"],
      ["failed run", { runs: { ".github/workflows/ci.yml": [{ ...run, path: ".github/workflows/ci.yml", conclusion: "failure" }] } }, "promotion_workflow_unverified"],
      ["in-progress run", { runs: { ".github/workflows/ci.yml": [{ ...run, path: ".github/workflows/ci.yml", status: "in_progress" }] } }, "promotion_workflow_unverified"],
      ["wrong head", { runs: { ".github/workflows/ci.yml": [{ ...run, path: ".github/workflows/ci.yml", head_sha: before }] } }, "promotion_workflow_unverified"],
      ["wrong pr", { runs: { ".github/workflows/ci.yml": [{ ...run, path: ".github/workflows/ci.yml", pull_requests: [{ number: 9 }] }] } }, "promotion_workflow_unverified"],
      ["missing runs", { runs: { ".github/workflows/ci.yml": [] } }, "promotion_workflow_unverified"],
    ];
    for (const [label, overrides, code] of failing) {
      const seams: any = makeSeams(overrides);
      const call: any = { repository, target: "stable", candidate, pr, currentTarget, ...seams };
      if (overrides.pr) call.pr = overrides.pr;
      if (overrides.candidate) call.candidate = overrides.candidate;
      await expect(verifyCompletedPromotion(call), label).rejects.toThrow(code);
    }

    const releasePr: any = promotionPr({ branch: "release", source: "stable", headSha: candidate, mergeCommit });
    const released: any = await verifyCompletedPromotion({
      repository, target: "release", candidate, pr: releasePr, currentTarget,
      ...makeSeams(),
      readGit: (args: any) : any => {
        const key: any = args.join(" ");
        const map: any = {
          [`rev-list --parents -n 1 ${mergeCommit}`]: `${mergeCommit} ${before} ${candidate}`,
          [`rev-parse ${mergeCommit}^{tree}`]: tree,
          [`rev-parse ${candidate}^{tree}`]: tree,
          [`show ${before}:package.json`]: JSON.stringify({ version: "1.2.3" }),
          [`show ${candidate}:package.json`]: JSON.stringify({ version: "1.3.0" }),
          [`show ${candidate}:tools/registry/release-definition.registry.json`]: JSON.stringify({ release: { version: "1.3.0", tag: "v1.3.0" } }),
        };
        if (!(key in map)) throw new Error(`unexpected-git:${key}`);
        return map[key];
      },
      readGithub: async (route: any) : Promise<any> => {
        const base: any = `/repos/${repository}`;
        for (const filename of ["branch-flow.yml", "ci.yml"]) {
          if (route === `${base}/actions/workflows/${filename}/runs?event=pull_request&head_sha=${candidate}&branch=stable&per_page=100`) {
            return { workflow_runs: [{ ...run, path: `.github/workflows/${filename}`, head_branch: "stable" }] };
          }
        }
        const githubMap: any = {
          [`${base}/releases/tags/v1.3.0`]: { id: 77, tag_name: "v1.3.0", draft: false, published_at: "2026-01-02T00:00:00Z" },
          [`${base}/git/ref/tags/v1.3.0`]: { object: { type: "commit", sha: candidate } },
          [`${base}/actions/workflows/release.yml/runs?head_sha=${candidate}&branch=v1.3.0&per_page=100`]: {
            workflow_runs: [{ id: 55, run_attempt: 1, event: "push", status: "completed", conclusion: "success", head_sha: candidate, head_branch: "v1.3.0", path: ".github/workflows/release.yml" }],
          },
        };
        if (!(route in githubMap)) throw new Error(`unexpected-route:${route}`);
        return githubMap[route];
      },
    });
    expect(released.targetContainsMerge).toBe(true);
    expect(released.checks).toHaveLength(2);
    expect(released.publication).toEqual({
      version: "1.3.0", tag: "v1.3.0", sourceRevision: candidate,
      releaseId: 77, workflowRunId: 55, conclusion: "success"
    });
  });

  it("accepts only a completed bound release promotion report", () : any => {
    const candidate: any = "b".repeat(40);
    const mergeCommit: any = "c".repeat(40);
    const report: any = {
      schemaVersion: "v0.0.1:release:branch-promotion-report-1",
      verifier: "tools/server-scripts/promote-release-branches.ts",
      generatedAt: "2026-01-02T00:00:00Z",
      sourceRevision: candidate, sourceBranch: "stable", targetBranch: "release",
      status: "completed",
      pullRequest: { number: 42, headSha: candidate, mergeCommit },
      targetContainsMerge: true,
      checks: [
        { workflowPath: ".github/workflows/branch-flow.yml", runId: 30, sourceRevision: candidate, conclusion: "success" },
        { workflowPath: ".github/workflows/ci.yml", runId: 31, sourceRevision: candidate, conclusion: "success" },
      ],
      publication: {
        version: "1.3.0", tag: "v1.3.0", sourceRevision: candidate,
        releaseId: 77, workflowRunId: 55, conclusion: "success"
      },
      releaseReady: true,
    };
    expect(completedReleasePromotionMatches(report, candidate)).toBe(true);
    const rejections: any[] = [
      { status: "requested" },
      { targetBranch: "stable" },
      { sourceBranch: "nightly" },
      { pullRequest: { ...report.pullRequest, headSha: "d".repeat(40) } },
      { pullRequest: { ...report.pullRequest, mergeCommit: null } },
      { publication: null },
      { publication: { ...report.publication, tag: "v1.4.0" } },
      { publication: { ...report.publication, conclusion: "failure" } },
      { checks: report.checks.slice(1) },
      { checks: [{ ...report.checks[0], conclusion: "failure" }, report.checks[1]] },
      { releaseReady: false },
      { targetContainsMerge: false },
      { schemaVersion: "unknown" },
      { sourceRevision: "d".repeat(40) },
    ];
    for (const patch of rejections) {
      expect(completedReleasePromotionMatches({ ...report, ...patch }, candidate), JSON.stringify(patch)).toBe(false);
    }
    expect(completedReleasePromotionMatches(report, "d".repeat(40))).toBe(false);
    expect(completedReleasePromotionMatches(report, "not-a-sha")).toBe(false);
    expect(completedReleasePromotionMatches(null, candidate)).toBe(false);
  });

  it("rejects direct protected fast-forwards that arrive without a merged promotion pull request", () : any => {
    for (const [branch, after] of [["stable", "nightly-tip"], ["release", "stable-tip"]]) {
      const direct: any = verifyProtectedPushTopology({
        branch,
        before: `old-${branch}`,
        after,
        repository: "example/repository",
        ancestor: () : any => true,
        parentsOf: () : any => [`old-${branch}`, after],
      });
      expect(direct).toEqual({ ok: false, code: "promotion-pr-merge-missing" });
    }
  });

  it("admits same-repository promotion merges recorded by the merged pull request", () : any => {
    const stable: any = verifyProtectedPushTopology({
      branch: "stable",
      before: "old-stable",
      after: "stable-merge",
      repository: "example/repository",
      pullRequests: [promotionPr({ branch: "stable", source: "nightly", headSha: "nightly-head", mergeCommit: "stable-merge" })],
      ancestor: () : any => true,
      parentsOf: () : any => ["old-stable", "nightly-head"],
    });
    expect(stable).toEqual({
      ok: true,
      code: "nightly-pr-promoted-stable",
      promotion: { number: 42, headSha: "nightly-head", mergeCommit: "stable-merge" }
    });

    const release: any = verifyProtectedPushTopology({
      branch: "release",
      before: "old-release",
      after: "release-merge",
      repository: "example/repository",
      pullRequests: [promotionPr({ branch: "release", source: "stable", headSha: "stable-head", mergeCommit: "release-merge" })],
      ancestor: () : any => true,
      parentsOf: () : any => ["old-release", "stable-head"],
    });
    expect(release).toEqual({
      ok: true,
      code: "stable-pr-promoted-release",
      promotion: { number: 42, headSha: "stable-head", mergeCommit: "release-merge" }
    });

    const movedTip: any = verifyProtectedPushTopology({
      branch: "stable",
      before: "old-stable",
      after: "stable-merge",
      repository: "example/repository",
      pullRequests: [promotionPr({ branch: "stable", source: "nightly", headSha: "merged-nightly-head", mergeCommit: "stable-merge" })],
      ancestor: () : any => true,
      parentsOf: () : any => ["old-stable", "merged-nightly-head"],
    });
    expect(movedTip.ok).toBe(true);
  });

  it("rejects promotion merges that cannot prove the recorded same-repository pull request", () : any => {
    const base: any = {
      branch: "stable",
      before: "old-stable",
      after: "stable-merge",
      repository: "example/repository",
      ancestor: () : any => true,
    };
    const cases: any[] = [
      ["wrong source ref", { head: { ref: "agent/feature", sha: "nightly-head", repo: { full_name: "example/repository" } } }, ["old-stable", "nightly-head"]],
      ["fork head repository", { head: { ref: "nightly", sha: "nightly-head", repo: { full_name: "fork/repository" } } }, ["old-stable", "nightly-head"]],
      ["unmerged record", { merged_at: null }, ["old-stable", "nightly-head"]],
      ["wrong merge commit", { merge_commit_sha: "other-merge" }, ["old-stable", "nightly-head"]],
      ["wrong base branch", { base: { ref: "nightly", repo: { full_name: "example/repository" } } }, ["old-stable", "nightly-head"]],
    ];
    for (const [label, overrides, parents] of cases) {
      const result: any = verifyProtectedPushTopology({
        ...base,
        pullRequests: [promotionPr({ branch: "stable", source: "nightly", headSha: "nightly-head", mergeCommit: "stable-merge", ...overrides })],
        parentsOf: () : any => parents,
      });
      expect(result.ok, label).toBe(false);
      expect(result.code, label).toBe("promotion-pr-merge-missing");
    }
    const parentShapes: any[] = [
      ["swapped parents", ["nightly-head", "old-stable"]],
      ["extra parents", ["old-stable", "nightly-head", "extra"]],
      ["mismatched head parent", ["old-stable", "other-head"]],
      ["single parent", ["old-stable"]],
    ];
    for (const [label, parents] of parentShapes) {
      const result: any = verifyProtectedPushTopology({
        ...base,
        pullRequests: [promotionPr({ branch: "stable", source: "nightly", headSha: "nightly-head", mergeCommit: "stable-merge" })],
        parentsOf: () : any => parents,
      });
      expect(result.ok, label).toBe(false);
      expect(result.code, label).toBe("promotion-pr-merge-missing");
    }

    const nonFastForward: any = verifyProtectedPushTopology({
      ...base,
      pullRequests: [promotionPr({ branch: "stable", source: "nightly", headSha: "nightly-head", mergeCommit: "stable-merge" })],
      ancestor: () : any => false,
      parentsOf: () : any => ["old-stable", "nightly-head"],
    });
    expect(nonFastForward.code).toBe("protected-branch-not-fast-forward");

    const bootstrap: any = verifyProtectedPushTopology({
      branch: "stable",
      before: "0".repeat(40),
      after: "nightly-tip",
      repository: "example/repository",
      ancestor: () : any => true,
    });
    expect(bootstrap.code).toBe("protected-branch-bootstrap-forbidden");

    const invalidBranch: any = verifyProtectedPushTopology({
      branch: "main",
      before: "old",
      after: "new",
      repository: "example/repository",
    });
    expect(invalidBranch.code).toBe("protected-branch-invalid");
  });

  it("orders release versions by SemVer precedence including prerelease identifiers", () : any => {
    const ordered: any[] = [
      ["1.10.0", "1.9.9", 1],
      ["1.3.0", "1.3.0-rc.1", 1],
      ["1.3.0-rc.10", "1.3.0-rc.2", 1],
      ["1.3.0-rc.1", "1.3.0-alpha.1", 1],
      ["1.3.0-1", "1.3.0-alpha", -1],
      ["1.3.0-rc.1", "1.3.0-rc.1.2", -1],
      ["1.3.0", "1.3.0", 0],
      ["1.3.0-beta.2", "1.3.0-beta.10", -1],
      ["9007199254740993.0.0", "9007199254740992.0.0", 1],
    ];
    for (const [left, right, expected] of ordered) {
      expect(compareReleaseVersions(left, right), `${left} vs ${right}`).toBe(expected);
      expect(compareReleaseVersions(right, left), `${right} vs ${left}`).toBe(expected === 0 ? 0 : -expected);
    }
    expect(compareReleaseVersions("1.3.0-rc-with.dots-2", "1.3.0-rc-with.dots-1")).toBe(1);
    expect(() : any => compareReleaseVersions("1.3.0+build", "1.3.0")).toThrow();
    expect(() : any => compareReleaseVersions("1.3.0", "nightly")).toThrow();
  });

  it("accepts only a strictly newer version published from the exact promoted head", async () : Promise<void> => {
    const base: any = "a".repeat(40);
    const candidate: any = "b".repeat(40);
    const tagObject: any = "c".repeat(40);
    const repository: any = "example/repository";
    const route: any = `/repos/${repository}`;
    const run: any = {
      id: 20, run_attempt: 1, event: "push", status: "completed", conclusion: "success",
      head_sha: candidate, head_branch: "v1.3.0", path: ".github/workflows/release.yml"
    };
    const githubMap: any = {
      [`${route}/releases/tags/v1.3.0`]: { id: 77, tag_name: "v1.3.0", draft: false, published_at: "2026-01-02T00:00:00Z" },
      [`${route}/git/ref/tags/v1.3.0`]: { object: { type: "commit", sha: candidate } },
      [`${route}/actions/workflows/release.yml/runs?head_sha=${candidate}&branch=v1.3.0&per_page=100`]: { workflow_runs: [run] },
    };
    const readGithub: any = async (path: any) : Promise<any> => {
      if (!(path in githubMap)) throw new Error(`unexpected-route:${path}`);
      return githubMap[path];
    };
    const readGit: any = (args: any) : any => {
      const key: any = `${args[0]}:${args[1]}`;
      const map: any = {
        [`show:${base}:package.json`]: JSON.stringify({ version: "1.2.3" }),
        [`show:${candidate}:package.json`]: JSON.stringify({ version: "1.3.0" }),
        [`show:${candidate}:tools/registry/release-definition.registry.json`]: JSON.stringify({ release: { version: "1.3.0", tag: "v1.3.0" } }),
      };
      if (!(key in map)) throw new Error(`unexpected-git:${key}`);
      return map[key];
    };
    const options: any = { repository, baseRevision: base, candidate, readGit, readGithub };

    expect(await verifyPublishedRelease(options)).toEqual({
      ok: true,
      code: "new-version-published",
      publication: {
        version: "1.3.0", tag: "v1.3.0", sourceRevision: candidate,
        releaseId: 77, workflowRunId: 20, conclusion: "success"
      }
    });

    githubMap[`${route}/git/ref/tags/v1.3.0`] = { object: { type: "tag", sha: tagObject } };
    githubMap[`${route}/git/tags/${tagObject}`] = { object: { type: "commit", sha: candidate } };
    expect(await verifyPublishedRelease(options)).toEqual({
      ok: true,
      code: "new-version-published",
      publication: {
        version: "1.3.0", tag: "v1.3.0", sourceRevision: candidate,
        releaseId: 77, workflowRunId: 20, conclusion: "success"
      }
    });
  });

  it("denies release evidence before or through each documented read", async () : Promise<void> => {
    const base: any = "a".repeat(40);
    const candidate: any = "b".repeat(40);
    const repository: any = "example/repository";
    const route: any = `/repos/${repository}`;
    let githubCalls = 0;
    let gitCalls = 0;
    const manifest: any = { version: "1.3.0" };
    const definition: any = { release: { version: "1.3.0", tag: "v1.3.0" } };
    const releaseOk: any = { id: 77, tag_name: "v1.3.0", draft: false, published_at: "2026-01-02T00:00:00Z" };
    const refOk: any = { object: { type: "commit", sha: candidate } };
    const runsOk: any = { workflow_runs: [{ id: 20, run_attempt: 1, event: "push", status: "completed", conclusion: "success", head_sha: candidate, head_branch: "v1.3.0", path: ".github/workflows/release.yml" }] };
    const check = async (overrides: any = {}, githubMap: any = {}, expected = "release-evidence-unavailable") : Promise<any> => {
      githubCalls = 0;
      gitCalls = 0;
      const git: any = (args: any) : any => {
        gitCalls += 1;
        const map: any = {
          [`show:${base}:package.json`]: JSON.stringify(overrides.base ?? { version: "1.2.3" }),
          [`show:${candidate}:package.json`]: JSON.stringify(overrides.manifest ?? manifest),
          [`show:${candidate}:tools/registry/release-definition.registry.json`]: JSON.stringify(overrides.definition ?? definition),
        };
        const key: any = `${args[0]}:${args[1]}`;
        if (!(key in map)) throw new Error(`unexpected-git:${key}`);
        return map[key];
      };
      const github: any = async (path: any) : Promise<any> => {
        githubCalls += 1;
        const map: any = {
          [`${route}/releases/tags/v1.3.0`]: githubMap.release ?? releaseOk,
          [`${route}/git/ref/tags/v1.3.0`]: githubMap.ref ?? refOk,
          [`${route}/actions/workflows/release.yml/runs?head_sha=${candidate}&branch=v1.3.0&per_page=100`]: githubMap.runs ?? runsOk,
          ...githubMap.extra,
        };
        if (!(path in map) || map[path] === "throw") throw new Error(`route-unavailable:${path}`);
        return map[path];
      };
      const result: any = await verifyPublishedRelease({
        repository: overrides.repository ?? repository,
        baseRevision: overrides.baseRevision ?? base,
        candidate: overrides.candidate ?? candidate,
        readGit: git,
        readGithub: github,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe(expected);
      return result;
    };

    await check({ base: { version: "1.3.0" } }, {}, "release-version-not-new");
    expect(githubCalls).toBe(0);
    await check({ base: { version: "1.4.0" } }, {}, "release-version-not-new");
    expect(githubCalls).toBe(0);
    await check({ manifest: { version: "1.3.1" } }, {}, "release-version-mismatch");
    expect(githubCalls).toBe(0);
    await check({ definition: { release: { version: "1.2.9", tag: "v1.3.0" } } }, {}, "release-version-mismatch");
    expect(githubCalls).toBe(0);
    await check({ definition: { release: { version: "1.3.0", tag: "v1.3.1" } } }, {}, "release-version-mismatch");
    expect(githubCalls).toBe(0);
    await check({ repository: "bad repo" }, {}, "release-candidate-invalid");
    expect(gitCalls).toBe(0);
    await check({ candidate: "not-a-sha" }, {}, "release-candidate-invalid");
    expect(gitCalls).toBe(0);
    await check({ baseRevision: "deadbeef" }, {}, "release-candidate-invalid");
    expect(gitCalls).toBe(0);

    await check({}, { release: { ...releaseOk, draft: true } }, "release-not-published");
    await check({}, { release: { ...releaseOk, published_at: "" } }, "release-not-published");
    await check({}, { release: { ...releaseOk, tag_name: "v1.4.0" } }, "release-not-published");
    await check({}, { release: "throw" }, "release-evidence-unavailable");
    await check({}, { ref: { object: { type: "commit", sha: "d".repeat(40) } } }, "release-tag-candidate-mismatch");
    await check({}, { ref: "throw" }, "release-evidence-unavailable");

    const tagSha: any = "c".repeat(40);
    const cyclic: any = { object: { type: "tag", sha: tagSha } };
    await check({}, {
      ref: cyclic,
      extra: { [`${route}/git/tags/${tagSha}`]: cyclic },
    }, "release-tag-invalid");
    await check({}, { runs: "throw" }, "release-evidence-unavailable");
    await check({}, { runs: { workflow_runs: "not-a-list" } }, "release-workflow-unverified");
    await check({}, { runs: { workflow_runs: [] } }, "release-workflow-unverified");
    for (const [label, patch] of [
      ["wrong sha", { head_sha: "d".repeat(40) }],
      ["wrong tag branch", { head_branch: "v1.4.0" }],
      ["wrong workflow path", { path: ".github/workflows/ci.yml" }],
      ["failed conclusion", { conclusion: "failure" }],
      ["skipped conclusion", { conclusion: "skipped" }],
      ["in progress", { status: "in_progress" }],
      ["unsupported event", { event: "pull_request" }],
    ]) {
      const run: any = { ...runsOk.workflow_runs[0], ...patch };
      await check({}, { runs: { workflow_runs: [run] } }, "release-workflow-unverified");
      void label;
    }
    await check({}, { runs: { workflow_runs: [
      { ...runsOk.workflow_runs[0], id: 10, run_attempt: 3 },
      { ...runsOk.workflow_runs[0], id: 20, run_attempt: 1, conclusion: "failure" },
    ] } }, "release-workflow-unverified");
    const dispatched: any = { ...runsOk.workflow_runs[0], event: "workflow_dispatch" };
    const okResult: any = await verifyPublishedRelease({
      repository, baseRevision: base, candidate,
      readGit: (args: any) : any => {
        const map: any = {
          [`show:${base}:package.json`]: JSON.stringify({ version: "1.2.3" }),
          [`show:${candidate}:package.json`]: JSON.stringify({ version: "1.3.0" }),
          [`show:${candidate}:tools/registry/release-definition.registry.json`]: JSON.stringify(definition),
        };
        const key: any = `${args[0]}:${args[1]}`;
        if (!(key in map)) throw new Error(`unexpected-git:${key}`);
        return map[key];
      },
      readGithub: async (path: any) : Promise<any> => {
        const map: any = {
          [`${route}/releases/tags/v1.3.0`]: releaseOk,
          [`${route}/git/ref/tags/v1.3.0`]: refOk,
          [`${route}/actions/workflows/release.yml/runs?head_sha=${candidate}&branch=v1.3.0&per_page=100`]: { workflow_runs: [dispatched] },
        };
        if (!(path in map)) throw new Error(`route-unavailable:${path}`);
        return map[path];
      },
    });
    expect(okResult.ok).toBe(true);
    expect(okResult.code).toBe("new-version-published");
  });

  it("selects the newest matching workflow run by id then attempt", () : any => {
    const candidate: any = "b".repeat(40);
    const options: any = { candidate, workflowPath: ".github/workflows/release.yml", headBranch: "v1.3.0" };
    expect(selectLatestCandidateWorkflowRun([
      { id: 10, run_attempt: 3, head_sha: candidate, path: ".github/workflows/release.yml", head_branch: "v1.3.0" },
      { id: 20, run_attempt: 1, head_sha: candidate, path: ".github/workflows/release.yml", head_branch: "v1.3.0" },
    ], options)?.id).toBe(20);
    expect(selectLatestCandidateWorkflowRun([
      { id: 10, run_attempt: 1, head_sha: "d".repeat(40), path: ".github/workflows/release.yml", head_branch: "v1.3.0" },
      { id: 20, run_attempt: 1, head_sha: candidate, path: ".github/workflows/ci.yml", head_branch: "v1.3.0" },
      { id: 30, run_attempt: 1, head_sha: candidate, path: ".github/workflows/release.yml", head_branch: "nightly" },
      { id: "40", run_attempt: 1, head_sha: candidate, path: ".github/workflows/release.yml", head_branch: "v1.3.0" },
    ], options)).toBeNull();
    expect(selectLatestCandidateWorkflowRun([
      { id: 10, run_attempt: 1, head_sha: candidate, path: ".github/workflows/release.yml", head_branch: "v1.3.0", pull_requests: [{ number: 7 }] },
      { id: 20, run_attempt: 1, head_sha: candidate, path: ".github/workflows/release.yml", head_branch: "v1.3.0", pull_requests: [] },
    ], { ...options, pullRequestNumber: 7 })?.id).toBe(10);
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

const repoRoot: any = path.resolve(import.meta.dirname, "../../..");
const readJson: any = (relativePath: any) : any =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));

function workflowJobNames(relativePath: any) : Map<string, string> {
  const source: any = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
  const names: any = new Map();
  const lines: any[] = source.split("\n");
  const jobsIndex: any = lines.findIndex((line: any) : any => line === "jobs:");
  if (jobsIndex < 0) throw new Error(`jobs-section-missing:${relativePath}`);
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const header: any = /^ {2}([a-zA-Z0-9_-]+):$/u.exec(lines[index]);
    if (!header) continue;
    let cursor = index + 1;
    let display: any = "";
    while (cursor < lines.length && !/^ {2}[a-zA-Z0-9_-]+:$/u.test(lines[cursor])) {
      const displayMatch: any = /^ {4}name: (.+)$/u.exec(lines[cursor]);
      if (displayMatch) { display = displayMatch[1].trim(); break; }
      cursor += 1;
    }
    if (!display) throw new Error(`job-name-missing:${relativePath}:${header[1]}`);
    names.set(header[1], display);
  }
  return names;
}

afterEach(() : any => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("promotion requester contract and ruleset binding", () : any => {
  it("parses operator arguments with target-bound candidate rules", () : any => {
    expect(parseArgs(["--target", "stable"])).toMatchObject({ target: "stable", candidate: "", verify: false });
    expect(parseArgs(["--target=release", "--dry-run"]).candidate).toBe("");
    const pinned: any = "b".repeat(40);
    expect(parseArgs(["--target", "stable", "--candidate", pinned]).candidate).toBe(pinned);
    expect(parseArgs(["--target", "release", "--verify", "--candidate", pinned])).toMatchObject({ verify: true, candidate: pinned });
    expect(() : any => parseArgs(["--target", "release", "--verify"])).toThrow("candidate_revision_required");
    expect(() : any => parseArgs([])).toThrow("promotion_target_invalid");
    expect(() : any => parseArgs(["--target", "nightly"])).toThrow("promotion_target_invalid");
    expect(() : any => parseArgs(["--target", "constructor"])).toThrow("promotion_target_invalid");
    expect(() : any => parseArgs(["--target", "stable", "--target", "release"])).toThrow("release_promotion_duplicate_argument");
    expect(() : any => parseArgs(["--target", "stable", "--dry-run", "--verify"])).toThrow("release_promotion_arguments_invalid");
    expect(() : any => parseArgs(["--target", "stable", "--candidate", "short"])).toThrow("candidate_revision_invalid");
  });

  it("exposes two concrete catalog tasks each requesting one promotion target", () : any => {
    const catalog: any = readJson("workflows/catalog.json");
    const taskById: any = new Map(catalog.tasks.map((task: any) : any => [task.id, task]));
    for (const [taskId, target] of [["meshrix-js.promote-stable", "stable"], ["meshrix-js.promote-release", "release"]]) {
      const task: any = taskById.get(taskId);
      expect(task, taskId).toBeTruthy();
      expect(task.command).toBe("npm");
      expect(task.args.slice(0, 3)).toEqual(["run", "release:promote-branches", "--"]);
      const parsed: any = parseArgs(task.args.slice(3));
      expect(parsed.target, taskId).toBe(target);
      expect(parsed.verify, taskId).toBe(false);
    }
    expect(catalog.profiles["stable-promotion"]).toEqual(["meshrix-js.promote-stable"]);
    expect(catalog.profiles["release-promotion"]).toEqual(["meshrix-js.promote-release"]);
  });

  it("distinguishes requested from completed promotion in its own report", () : any => {
    const candidate: any = "b".repeat(40);
    const mergeCommit: any = "c".repeat(40);
    const pr: any = promotionPr({ branch: "release", source: "stable", headSha: candidate, mergeCommit });
    const publication: any = { version: "1.3.0", tag: "v1.3.0", sourceRevision: candidate, releaseId: 77, workflowRunId: 55, conclusion: "success" };
    const requested: any = createPromotionReport({ target: "release", candidate, pr, publication });
    expect(requested.status).toBe("requested");
    expect(requested.releaseReady).toBe(false);
    expect(requested.pullRequest.mergeCommit).toBeNull();
    expect(completedReleasePromotionMatches(requested, candidate)).toBe(false);

    const observedStable: any = {
      targetContainsMerge: true,
      publication: null,
      checks: [".github/workflows/branch-flow.yml", ".github/workflows/ci.yml"]
        .map((workflowPath: any) : any => ({ workflowPath, runId: 30, sourceRevision: candidate, conclusion: "success" })),
    };
    const stablePr: any = promotionPr({ branch: "stable", source: "nightly", headSha: candidate, mergeCommit });
    const stableReport: any = createPromotionReport({ target: "stable", candidate, pr: stablePr, observed: observedStable });
    expect(stableReport.status).toBe("completed");
    expect(stableReport.releaseReady).toBe(false);
    expect(stableReport.pullRequest.mergeCommit).toBe(mergeCommit);

    const observedRelease: any = {
      targetContainsMerge: true,
      publication,
      checks: observedStable.checks,
    };
    const releaseReport: any = createPromotionReport({ target: "release", candidate, pr, observed: observedRelease, publication: observedRelease.publication });
    expect(releaseReport.status).toBe("completed");
    expect(completedReleasePromotionMatches(releaseReport, candidate)).toBe(true);
  });

  it("reads GitHub only through a fixed repository route with a bearer token", async () : Promise<void> => {
    vi.stubEnv("GH_TOKEN", "fixture-token");
    const fetched: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any, options: any) : Promise<any> => {
      fetched.push([String(url), options?.headers]);
      return { ok: true, json: async () : Promise<any> => ({ workflow_runs: [] }) };
    }));
    await expect(readGithubJson("https://api.github.com/repos/x/y")).rejects.toThrow("github-route-invalid");
    await expect(readGithubJson("/other/route")).rejects.toThrow("github-route-invalid");
    expect(fetched).toHaveLength(0);
    await expect(readGithubJson("/repos/example/repository/actions/runs")).resolves.toEqual({ workflow_runs: [] });
    expect(fetched[0][0]).toBe("https://api.github.com/repos/example/repository/actions/runs");
    expect(fetched[0][1].Authorization).toBe("Bearer fixture-token");
    expect(fetched[0][1].Accept).toBe("application/vnd.github+json");
    expect(fetched[0][1]["X-GitHub-Api-Version"]).toBe("2022-11-28");
    vi.stubGlobal("fetch", vi.fn(async () : Promise<any> => ({ ok: false, status: 403, json: async () : Promise<any> => ({}) })));
    await expect(readGithubJson("/repos/example/repository/actions/runs")).rejects.toThrow("github-read-failed-403");
  });

  it("binds the promotion ruleset to the actual workflow job names and merge proof", () : any => {
    const ruleset: any = readJson(".github/rulesets/promotions.json");
    expect(ruleset.enforcement).toBe("active");
    expect(ruleset.bypass_actors).toEqual([]);
    expect(ruleset.conditions.ref_name.include.sort()).toEqual(
      Object.keys(DIRECT_UPSTREAM).map((branch: any) : any => `refs/heads/${branch}`).sort());
    const pullRule: any = ruleset.rules.find((rule: any) : any => rule.type === "pull_request");
    expect(pullRule.parameters.allowed_merge_methods).toEqual(["merge"]);
    const checksRule: any = ruleset.rules.find((rule: any) : any => rule.type === "required_status_checks");
    expect(checksRule.parameters.strict_required_status_checks_policy).toBe(true);
    const contexts: any = checksRule.parameters.required_status_checks;
    expect(contexts.every((check: any) : any => check.integration_id === 15368)).toBe(true);
    const requiredNames: any = contexts.map((check: any) : any => check.context).sort();
    const branchFlowJobs: any = workflowJobNames(".github/workflows/branch-flow.yml");
    const ciJobs: any = workflowJobNames(".github/workflows/ci.yml");
    const actualNames: any = [
      branchFlowJobs.get("branch-flow"),
      ciJobs.get("pull-request-verify"),
      ciJobs.get("dependency-review"),
    ];
    expect(requiredNames).toEqual([...actualNames].sort());
    expect(ciJobs.get("engineering")).toBe("Engineering verification");

    const ciSource: any = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const branchFlowSource: any = fs.readFileSync(path.join(repoRoot, ".github/workflows/branch-flow.yml"), "utf8");
    const pullTypes: any = /pull_request:[\s\S]*?types: \[([^\]]+)\]/u;
    expect(pullTypes.exec(ciSource)?.[1]).toContain("opened");
    expect(pullTypes.exec(ciSource)?.[1]).not.toContain("edited");
    expect(pullTypes.exec(branchFlowSource)?.[1]).toContain("edited");
  });
});
