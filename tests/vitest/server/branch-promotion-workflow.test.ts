import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  LONG_LIVED_BRANCHES,
  evaluateBranchFlow,
  verifyProtectedPushTopology
} from "../../../tools/scripts/verify-branch-flow.ts";
import {
  buildReleaseWorkflowDispatchPayload,
  createReleaseAuthorityManifest,
  createStableAuthorityManifest,
  decideReleaseBranchDispatch,
  releaseTagCreationAction,
  selectExactPromotionArtifact,
  selectSuccessfulPromotionRun,
  validateOriginatingReleaseRun,
  validateReleaseAuthorityManifest,
  validateReleaseDispatchContext,
  validateStableAuthorityManifest,
} from "../../../tools/server-scripts/lib/release-deployment/authority.ts";
import {
  FIRST_NPM_BOOTSTRAP_VERSION,
  sha256,
} from "../../../tools/server-scripts/lib/release-deployment/contract.ts";
import {
  RELEASE_REPORT_PROVENANCE_SCHEMA,
  releaseEvidenceReportPayloadDigest,
} from "../../../tools/server-scripts/lib/release-report-provenance.ts";
import {
  dispatchReleaseWorkflow,
  ensureImmutableReleaseTag,
  runAuthorityCommand,
} from "../../../tools/server-scripts/resolve-branch-promotion-authority.ts";
import { buildReleaseCandidateIdentity } from "../../../tools/server-scripts/verify-release-candidate-identity.ts";
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

function npmQualificationReport(candidate?: any) : any {
  const packageVersion = candidate.release_packages[0].version;
  const nativePlatform = "darwin/arm64";
  const target = (kind: "native" | "local_docker", testName: string) => ({
    kind,
    ...(kind === "native" ? { platform: nativePlatform } : {}),
    ...(kind === "local_docker" ? { status: "not_run", reasonCode: "docker_unavailable" } : {
      status: "passed",
      evidence: {
        lockBackedRegistryMirror: true,
        mirroredPackageCount: 2,
        mirroredArtifactCount: 2,
        ...(testName === "clean consumer install runs the packaged CLI"
          ? { publicServerCliHelp: true }
          : { publicServerBin: true }),
      },
    }),
  });
  const consumerTest = (name: string) => ({
    name,
    status: "passed",
    evidence: { targets: [target("native", name), target("local_docker", name)] },
  });
  const report: any = {
    schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
    verifier: "tools/server-scripts/verify-npm-package-installability.ts",
    generatedAt: "2026-10-02T00:00:00.000Z",
    finishedAt: "2026-10-02T00:00:01.000Z",
    candidate: {
      version: packageVersion,
      artifacts: candidate.release_packages.map((item: any) => ({
        name: item.name,
        version: item.version,
        filename: `${item.name.replace("/", "-")}-${item.version}.tgz`,
        integrity: "sha512-aGVsbG8=",
      })),
    },
    environment: {
      native: {
        os: "darwin",
        architecture: "arm64",
        platform: nativePlatform,
        nodeVersion: "24.18.1",
      },
      docker: { status: "unavailable", reasonCode: "docker_unavailable" },
    },
    tests: [
      { name: "root package declares the complete version-locked workspace release set", status: "passed" },
      { name: "release-set tarballs are source-portable and exclude host artifacts", status: "passed" },
      consumerTest("clean consumer install runs the packaged CLI"),
      consumerTest("installed framework starts and serves its default health contracts"),
    ],
    summary: {
      testCount: 4,
      failedCount: 0,
      releaseReady: true,
      reportLeakScan: true,
      qualifiedPlatforms: [{ kind: "native", platform: nativePlatform }],
    },
  };
  report.releaseEvidenceProvenance = {
    schemaVersion: RELEASE_REPORT_PROVENANCE_SCHEMA,
    commandId: "npm-package-installability",
    producer: "tools/server-scripts/verify-npm-package-installability.ts",
    runId: "42",
    candidateDigest: candidate.candidate_digest,
    recordedAt: "2026-10-02T00:00:02.000Z",
    reportPayloadDigest: releaseEvidenceReportPayloadDigest(report),
  };
  return report;
}

describe("branch promotion workflow", () : any => {
  it("waits for the exact successful deployment run before accepting its release authority", () : any => {
    const sourceRevision = "a".repeat(40);
    const context = {
      repository: "Meshrix-Platform/Meshrix.js",
      runId: "90210",
      runAttempt: 2,
      sourceRevision,
      event: "workflow_dispatch",
    };
    const run = {
      id: 90210,
      run_attempt: 2,
      path: ".github/workflows/release-branch.yml",
      head_branch: "release",
      head_sha: sourceRevision,
      event: "workflow_dispatch",
      repository: { full_name: context.repository },
      status: "in_progress",
      conclusion: null,
    };
    expect(validateOriginatingReleaseRun(run, context)).toEqual({ pending: true });
    expect(validateOriginatingReleaseRun({ ...run, status: "completed", conclusion: "success" }, context))
      .toMatchObject({
        pending: false,
        selection: {
          branch: "release",
          event: "workflow_dispatch",
          headSha: sourceRevision,
          runAttempt: 2,
          runId: "90210",
          workflowPath: ".github/workflows/release-branch.yml",
        },
      });
    for (const altered of [
      { ...run, path: ".github/workflows/release.yml" },
      { ...run, event: "push" },
      { ...run, head_sha: "b".repeat(40) },
      { ...run, run_attempt: 1 },
      { ...run, repository: { full_name: "other/repository" } },
    ]) {
      expect(() => validateOriginatingReleaseRun(altered, context))
        .toThrowError(expect.objectContaining({ code: "promotion_authority_originating_run_mismatch" }));
    }
    expect(() => validateOriginatingReleaseRun({ ...run, status: "completed", conclusion: "failure" }, context))
      .toThrowError(expect.objectContaining({ code: "promotion_authority_originating_run_unsuccessful" }));
  });

  it("binds release dispatch to the immutable canonical tag and permits only an exact manual bootstrap candidate", () : any => {
    const sourceRevision = "a".repeat(40);
    const context = {
      tag: "v0.0.1",
      canonicalTag: "v0.0.1",
      sourceRevision,
      tagRevision: sourceRevision,
      sourceRunId: "90210",
      sourceRunAttempt: 2,
      sourceEvent: "workflow_dispatch",
      repository: "Meshrix-Platform/Meshrix.js",
      releaseVersion: "0.0.1",
      bootstrapCandidate: "0.0.1",
    };
    expect(validateReleaseDispatchContext(context)).toMatchObject({
      tag: "v0.0.1",
      sourceRevision,
      runId: "90210",
      runAttempt: 2,
      bootstrapCandidate: "0.0.1",
    });
    expect(buildReleaseWorkflowDispatchPayload(context)).toEqual({
      ref: "v0.0.1",
      inputs: {
        originating_event: "workflow_dispatch",
        originating_run_attempt: "2",
        originating_run_id: "90210",
        source_revision: sourceRevision,
        bootstrap_candidate: "0.0.1",
      },
    });
    expect(() => validateReleaseDispatchContext({ ...context, tagRevision: "b".repeat(40) }))
      .toThrowError(expect.objectContaining({ code: "release_dispatch_tag_revision_mismatch" }));
    expect(() => validateReleaseDispatchContext({ ...context, canonicalTag: "v0.0.2" }))
      .toThrowError(expect.objectContaining({ code: "release_dispatch_tag_mismatch" }));
    expect(() => validateReleaseDispatchContext({ ...context, bootstrapCandidate: "0.0.2" }))
      .toThrowError(expect.objectContaining({ code: "release_dispatch_bootstrap_candidate_invalid" }));
    expect(() => validateReleaseDispatchContext({ ...context, sourceEvent: "push" }))
      .toThrowError(expect.objectContaining({ code: "release_dispatch_bootstrap_candidate_invalid" }));
    expect(releaseTagCreationAction(null, sourceRevision)).toBe("create");
    expect(releaseTagCreationAction(sourceRevision, sourceRevision)).toBe("verify");
    expect(() => releaseTagCreationAction("b".repeat(40), sourceRevision))
      .toThrowError(expect.objectContaining({ code: "release_tag_target_conflict" }));
  });

  it("requires manual bootstrap for the first-version push and preserves automatic OIDC dispatch afterward", async () : Promise<any> => {
    const firstPush = decideReleaseBranchDispatch({
      event: "push",
      refType: "branch",
      refName: "release",
      releaseVersion: FIRST_NPM_BOOTSTRAP_VERSION,
    });
    expect(firstPush).toEqual({
      action: "manual-bootstrap-required",
      bootstrapCandidate: FIRST_NPM_BOOTSTRAP_VERSION,
      dispatchRelease: false,
    });
    await expect(runAuthorityCommand([
      "decide-release-branch-dispatch",
      "--event", "push",
      "--ref-type", "branch",
      "--ref-name", "release",
      "--release-version", FIRST_NPM_BOOTSTRAP_VERSION,
      "--bootstrap-candidate", "",
    ])).resolves.toMatchObject(firstPush);

    const manualBootstrap = decideReleaseBranchDispatch({
      event: "workflow_dispatch",
      refType: "branch",
      refName: "release",
      releaseVersion: FIRST_NPM_BOOTSTRAP_VERSION,
      bootstrapCandidate: FIRST_NPM_BOOTSTRAP_VERSION,
    });
    expect(manualBootstrap).toEqual({
      action: "dispatch-bootstrap",
      bootstrapCandidate: FIRST_NPM_BOOTSTRAP_VERSION,
      dispatchRelease: true,
    });
    await expect(runAuthorityCommand([
      "decide-release-branch-dispatch",
      "--event", "workflow_dispatch",
      "--ref-type", "branch",
      "--ref-name", "release",
      "--release-version", FIRST_NPM_BOOTSTRAP_VERSION,
      "--bootstrap-candidate", FIRST_NPM_BOOTSTRAP_VERSION,
    ])).resolves.toMatchObject(manualBootstrap);

    const laterPush = decideReleaseBranchDispatch({
      event: "push",
      refType: "branch",
      refName: "release",
      releaseVersion: "0.0.2",
    });
    expect(laterPush).toEqual({
      action: "dispatch-oidc",
      bootstrapCandidate: "",
      dispatchRelease: true,
    });
    await expect(runAuthorityCommand([
      "decide-release-branch-dispatch",
      "--event", "push",
      "--ref-type", "branch",
      "--ref-name", "release",
      "--release-version", "0.0.2",
      "--bootstrap-candidate", "",
    ])).resolves.toMatchObject(laterPush);
  });

  it("rejects wrong release refs, invalid versions, and bootstrap outside the first manual dispatch", () : any => {
    const valid = {
      event: "push",
      refType: "branch",
      refName: "release",
      releaseVersion: FIRST_NPM_BOOTSTRAP_VERSION,
    };
    expect(() => decideReleaseBranchDispatch({ ...valid, refName: "stable" }))
      .toThrowError(expect.objectContaining({ code: "release_branch_ref_invalid" }));
    expect(() => decideReleaseBranchDispatch({ ...valid, refType: "tag" }))
      .toThrowError(expect.objectContaining({ code: "release_branch_ref_type_invalid" }));
    expect(() => decideReleaseBranchDispatch({ ...valid, releaseVersion: "latest" }))
      .toThrowError(expect.objectContaining({ code: "release_dispatch_version_invalid" }));
    expect(() => decideReleaseBranchDispatch({
      ...valid,
      bootstrapCandidate: FIRST_NPM_BOOTSTRAP_VERSION,
    })).toThrowError(expect.objectContaining({ code: "release_dispatch_bootstrap_candidate_invalid" }));
    expect(() => decideReleaseBranchDispatch({
      ...valid,
      event: "workflow_dispatch",
    })).toThrowError(expect.objectContaining({ code: "release_dispatch_bootstrap_candidate_required" }));
    expect(() => decideReleaseBranchDispatch({
      ...valid,
      event: "workflow_dispatch",
      releaseVersion: "0.0.2",
      bootstrapCandidate: FIRST_NPM_BOOTSTRAP_VERSION,
    })).toThrowError(expect.objectContaining({ code: "release_dispatch_bootstrap_candidate_invalid" }));
  });

  it("creates or verifies a release tag through GitHub without replacing a conflicting ref", async () : Promise<any> => {
    const revision = "a".repeat(40);
    const calls: any[] = [];
    const fetchImplementation = async (url: any, init: any = {}) : Promise<any> => {
      calls.push({ url: String(url), method: init.method || "GET", body: init.body });
      if (String(url).endsWith("/git/ref/tags/v0.0.1")) {
        return new Response(JSON.stringify({ object: { type: "commit", sha: revision } }), { status: 200 });
      }
      throw new Error("unexpected GitHub request");
    };
    await expect(ensureImmutableReleaseTag({
      repository: "Meshrix-Platform/Meshrix.js",
      tag: "v0.0.1",
      sourceRevision: revision,
      token: "synthetic-github-token",
      fetchImplementation,
    })).resolves.toMatchObject({ action: "verify", tag: "v0.0.1", sourceRevision: revision });
    expect(calls.map(({ method }: Record<string, any>) : any => method)).toEqual(["GET"]);
    expect(JSON.stringify(calls)).not.toContain("synthetic-github-token");

    const createCalls: any[] = [];
    let lookupCount = 0;
    const createFetch = async (url: any, init: any = {}) : Promise<any> => {
      createCalls.push({ url: String(url), method: init.method || "GET", body: init.body });
      if (String(url).endsWith("/git/ref/tags/v0.0.1")) {
        lookupCount += 1;
        return lookupCount === 1
          ? new Response(null, { status: 404 })
          : new Response(JSON.stringify({ object: { type: "commit", sha: revision } }), { status: 200 });
      }
      if (String(url).endsWith("/git/refs")) return new Response("{}", { status: 201 });
      throw new Error("unexpected GitHub request");
    };
    await expect(ensureImmutableReleaseTag({
      repository: "Meshrix-Platform/Meshrix.js",
      tag: "v0.0.1",
      sourceRevision: revision,
      token: "synthetic-github-token",
      fetchImplementation: createFetch,
    })).resolves.toMatchObject({ action: "verify" });
    expect(createCalls.map(({ method }: Record<string, any>) : any => method)).toEqual(["GET", "POST", "GET"]);
    expect(JSON.parse(createCalls[1].body)).toEqual({ ref: "refs/tags/v0.0.1", sha: revision });
  });

  it("dispatches only the release workflow with source-run facts and the canonical tag ref", async () : Promise<any> => {
    const revision = "a".repeat(40);
    let request: any;
    const result = await dispatchReleaseWorkflow({
      repository: "Meshrix-Platform/Meshrix.js",
      tag: "v0.0.1",
      sourceRevision: revision,
      runId: "90210",
      runAttempt: 2,
      sourceEvent: "push",
      releaseVersion: "0.0.1",
      token: "synthetic-github-token",
      fetchImplementation: async (url: any, init: any = {}) : Promise<any> => {
        request = { url: String(url), method: init.method, body: JSON.parse(init.body) };
        return new Response(null, { status: 204 });
      },
    });
    expect(request).toMatchObject({
      url: "https://api.github.com/repos/Meshrix-Platform/Meshrix.js/actions/workflows/release.yml/dispatches",
      method: "POST",
      body: {
        ref: "v0.0.1",
        inputs: {
          originating_event: "push",
          originating_run_attempt: "2",
          originating_run_id: "90210",
          source_revision: revision,
          bootstrap_candidate: "",
        },
      },
    });
    expect(result).toMatchObject({ sourceRunId: "90210", sourceRunAttempt: 2 });
    expect(JSON.stringify({ request, result })).not.toContain("synthetic-github-token");
  });

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
      ".github/workflows/release-branch.yml",
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

  it("runs the complete stable gate only on stable and exports one stable authority bundle", () : any => {
    const ciWorkflow: any = read(".github/workflows/ci.yml");
    const marker: any = "\n  stable-functional-completeness:\n";
    const start: any = ciWorkflow.indexOf(marker);
    expect(start).toBeGreaterThan(0);
    const remainder: any = ciWorkflow.slice(start + marker.length);
    const nextJob: any = remainder.search(/\n  [a-z][a-z0-9-]*:\n/u);
    const stableGate: any = ciWorkflow.slice(
      start,
      nextJob < 0 ? ciWorkflow.length : start + marker.length + nextJob,
    );
    expect(stableGate).toContain("github.event_name == 'push' && github.ref_name == 'stable'");
    expect(stableGate).not.toContain("github.ref_name == 'release'");
    expect(stableGate).toContain("npm run ci:local -- --scope release");
    expect(stableGate).toContain("create-stable-bundle");
    expect(stableGate).toContain("--candidate build/release/control/SOURCE_CANDIDATE.json");
    expect(stableGate).toContain("--functional build/reports/accepted-candidate.json");
    expect(stableGate).toContain("--npm-report build/reports/npm-package-installability.json");
    expect(stableGate).toContain("--run-id ${{ github.run_id }}");
    expect(stableGate).toContain("--run-attempt ${{ github.run_attempt }}");
    expect(stableGate).toContain("name: stable-authority-${{ github.sha }}");
    expect(stableGate).toContain("--bundle build/release/control/stable-authority");
    expect(stableGate).not.toContain("verify-release-deployment");
  });

  it("selects the highest exact successful rerun and exactly one unexpired artifact", () : any => {
    const sha: any = "a".repeat(40);
    const common: any = {
      path: ".github/workflows/ci.yml",
      event: "push",
      head_branch: "stable",
      head_sha: sha,
      status: "completed",
      conclusion: "success",
    };
    const selected: any = selectSuccessfulPromotionRun({
      workflow_runs: [
        { ...common, id: 101, run_attempt: 1 },
        { ...common, id: 102, run_attempt: 2 },
        { ...common, id: 103, run_attempt: 3, conclusion: "failure" },
        { ...common, id: 104, run_attempt: 4, head_sha: "b".repeat(40) },
      ],
    }, {
      workflowPath: ".github/workflows/ci.yml",
      branch: "stable",
      headSha: sha,
    });
    expect(selected).toMatchObject({ runId: "102", runAttempt: 2, headSha: sha });

    expect(selectExactPromotionArtifact({ artifacts: [{
      id: 501,
      name: `stable-authority-${sha}`,
      expired: false,
      archive_download_url: "https://api.example.invalid/artifact",
    }] }, { artifactName: `stable-authority-${sha}` }).artifactId).toBe("501");

    expect(() : any => selectSuccessfulPromotionRun({ workflow_runs: [
      { ...common, id: 201, run_attempt: 2 },
      { ...common, id: 202, run_attempt: 2 },
    ] }, {
      workflowPath: ".github/workflows/ci.yml",
      branch: "stable",
      headSha: sha,
    })).toThrowError(expect.objectContaining({ code: "promotion_authority_run_ambiguous" }));
    expect(() : any => selectExactPromotionArtifact({ artifacts: [
      { id: 1, name: `stable-authority-${sha}`, expired: false, archive_download_url: "one" },
      { id: 2, name: `stable-authority-${sha}`, expired: false, archive_download_url: "two" },
    ] }, { artifactName: `stable-authority-${sha}` }))
      .toThrowError(expect.objectContaining({ code: "promotion_authority_artifact_ambiguous" }));
  });

  it("keeps stable authority manifests closed and exact-run bound", () : any => {
    const sha: any = "a".repeat(40);
    const manifest: any = createStableAuthorityManifest({
      artifactName: `stable-authority-${sha}`,
      candidateDigest: "b".repeat(64),
      candidateFileDigest: "c".repeat(64),
      functionalReceiptDigest: "d".repeat(64),
      npmQualificationReceiptDigest: "e".repeat(64),
      runAttempt: 2,
      runId: "9001",
      sourceRevision: sha,
    });
    expect(validateStableAuthorityManifest(manifest)).toEqual(manifest);
    expect(() : any => validateStableAuthorityManifest({ ...manifest, stale: true }))
      .toThrowError(expect.objectContaining({ code: "stable_authority_manifest_fields_invalid" }));
    expect(() : any => validateStableAuthorityManifest({
      ...manifest,
      workflowPath: ".github/workflows/release.yml",
    })).toThrowError(expect.objectContaining({ code: "stable_authority_workflow_path_invalid" }));
  });

  it("revalidates a stable bundle against an independently materialized candidate", async () : Promise<any> => {
    const root: any = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meshrix-authority-test-"));
    try {
      const bundle: any = path.join(root, "bundle");
      const releaseBundle: any = path.join(root, "release-bundle");
      const candidate: any = buildReleaseCandidateIdentity({
        sourceRevision: "a".repeat(40),
        repositoryTreeDigest: `sha256:${"b".repeat(64)}`,
        releaseDefinitionSha256: `sha256:${"c".repeat(64)}`,
        packageLockSha256: `sha256:${"d".repeat(64)}`,
        releasePackages: [{
          manifest_path: "package.json",
          manifest_sha256: "e".repeat(64),
          name: "meshrix.js",
          version: "0.0.1",
        }],
        reportInventoryDigest: `sha256:${"f".repeat(64)}`,
        supportedProfiles: ["single-node"],
      });
      const candidateText: any = `${JSON.stringify(candidate, null, 2)}\n`;
      const functional: any = {
        schemaVersion: "v0.0.1:meshrix:accepted-candidate-receipt-1",
        claim: "functional-complete",
        status: "accepted",
        releaseReady: true,
        generationId: "stable-test-generation",
        selectedProfile: "single-node",
        sourceRevision: candidate.source_revision,
        candidateDigest: candidate.candidate_digest,
      };
      const functionalText: any = `${JSON.stringify(functional, null, 2)}\n`;
      const npmReport: any = npmQualificationReport(candidate);
      const npmText: any = `${JSON.stringify(npmReport, null, 2)}\n`;
      const candidatePath = path.join(root, "candidate.json");
      const functionalPath = path.join(root, "accepted-candidate.json");
      const npmReportPath = path.join(root, "npm-package-installability.json");
      const run: any = {
        branch: "stable",
        event: "push",
        headSha: candidate.source_revision,
        runAttempt: 2,
        runId: "42",
        workflowPath: ".github/workflows/ci.yml",
      };
      await Promise.all([
        fs.promises.writeFile(candidatePath, candidateText),
        fs.promises.writeFile(path.join(root, "expected.json"), candidateText),
        fs.promises.writeFile(functionalPath, functionalText),
        fs.promises.writeFile(npmReportPath, npmText),
        fs.promises.writeFile(path.join(root, "run.json"), `${JSON.stringify(run)}\n`),
      ]);
      await expect(runAuthorityCommand([
        "create-stable-bundle",
        "--candidate", candidatePath,
        "--functional", functionalPath,
        "--npm-report", npmReportPath,
        "--run-id", "42",
        "--run-attempt", "2",
        "--bundle", bundle,
      ])).resolves.toMatchObject({ stage: "stable" });
      await expect(runAuthorityCommand([
        "verify-stable-bundle",
        "--bundle", bundle,
        "--expected-candidate", path.join(root, "expected.json"),
        "--run", path.join(root, "run.json"),
      ])).resolves.toMatchObject({ stage: "stable" });

      const releaseManifestPath = path.join(releaseBundle, "release-authority-manifest.json");
      await expect(runAuthorityCommand([
        "create-release-bundle",
        "--stable-bundle", bundle,
        "--expected-candidate", path.join(root, "expected.json"),
        "--stable-run", path.join(root, "run.json"),
        "--run-id", "43",
        "--run-attempt", "1",
        "--bundle", releaseBundle,
      ])).resolves.toMatchObject({ stage: "release" });
      const releaseManifest = validateReleaseAuthorityManifest(
        JSON.parse(await fs.promises.readFile(releaseManifestPath, "utf8")),
      );
      expect(releaseManifest).toMatchObject({
        deploymentClaim: null,
        deploymentReceiptDigest: null,
        npmQualificationReceiptDigest: sha256(npmText),
      });
      const releaseRun = {
        branch: "release",
        event: "push",
        headSha: candidate.source_revision,
        runAttempt: 1,
        runId: "43",
        workflowPath: ".github/workflows/release-branch.yml",
      };
      await fs.promises.writeFile(path.join(root, "release-run.json"), `${JSON.stringify(releaseRun)}\n`);
      await expect(runAuthorityCommand([
        "verify-release-bundle",
        "--bundle", releaseBundle,
        "--expected-candidate", path.join(root, "expected.json"),
        "--run", path.join(root, "release-run.json"),
      ])).resolves.toMatchObject({ stage: "release" });
      const invalidDeploymentPath = path.join(root, "invalid-deployment.json");
      await fs.promises.writeFile(invalidDeploymentPath, "{}\n");
      await expect(runAuthorityCommand([
        "create-release-bundle",
        "--stable-bundle", bundle,
        "--expected-candidate", path.join(root, "expected.json"),
        "--stable-run", path.join(root, "run.json"),
        "--run-id", "44",
        "--run-attempt", "1",
        "--deployment", invalidDeploymentPath,
        "--bundle", path.join(root, "invalid-release-authority"),
      ])).rejects.toMatchObject({ code: "release_deployment_receipt_fields_invalid" });

      await fs.promises.writeFile(
        path.join(bundle, "stable-authority-manifest.json"),
        `${JSON.stringify({
          ...JSON.parse(await fs.promises.readFile(path.join(bundle, "stable-authority-manifest.json"), "utf8")),
          unexpected: true,
        })}\n`,
      );
      await expect(runAuthorityCommand([
        "verify-stable-bundle",
        "--bundle", bundle,
        "--expected-candidate", path.join(root, "expected.json"),
        "--run", path.join(root, "run.json"),
      ])).rejects.toMatchObject({ code: "stable_authority_manifest_fields_invalid" });
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("promotes the exact accepted npm candidate without a deployment receipt", () : any => {
    const branchWorkflow: any = read(".github/workflows/release-branch.yml");
    const releaseWorkflow: any = read(".github/workflows/release.yml");

    expect(branchWorkflow).toContain('branches: ["release"]');
    expect(branchWorkflow).toContain("workflow_dispatch:");
    expect(branchWorkflow).toContain("bootstrap_candidate:");
    expect(branchWorkflow).toContain("release-authority:");
    expect(branchWorkflow).toContain("prepare-branch-authority");
    expect(branchWorkflow).toContain("BOOTSTRAP_CANDIDATE");
    expect(branchWorkflow).toContain("ensure-release-tag");
    expect(branchWorkflow).toContain("dispatch-release");
    expect(branchWorkflow).not.toContain("release-deployment");
    expect(branchWorkflow).toContain("release-authority-${{ github.sha }}");
    expect(branchWorkflow.match(/GH_TOKEN: \$\{\{ github\.token \}\}/gu)).toHaveLength(3);

    expect(releaseWorkflow).toContain('test "$tag_commit" = "$release_commit"');
    expect(releaseWorkflow).toContain("workflow_dispatch:");
    expect(releaseWorkflow).toContain("verify-originating-run");
    expect(releaseWorkflow).toContain("while :");
    expect(releaseWorkflow).not.toContain("git merge-base --is-ancestor");
    expect(releaseWorkflow).toContain("name: release-authority-${{ github.sha }}");
    expect(releaseWorkflow).not.toContain("\n  functional-completeness:\n");
    expect(releaseWorkflow.match(/GH_TOKEN: \$\{\{ github\.token \}\}/gu)).toHaveLength(3);
    expect(releaseWorkflow.indexOf("- name: Install dependencies"))
      .toBeLessThan(releaseWorkflow.indexOf("- name: Validate the canonical release definition"));
  });
});
