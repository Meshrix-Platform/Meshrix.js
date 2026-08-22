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
  createStableAuthorityManifest,
  selectExactPromotionArtifact,
  selectSuccessfulPromotionRun,
  validateStableAuthorityManifest,
} from "../../../tools/server-scripts/lib/release-deployment/authority.ts";
import { sha256 } from "../../../tools/server-scripts/lib/release-deployment/contract.ts";
import { runAuthorityCommand } from "../../../tools/server-scripts/resolve-branch-promotion-authority.ts";
import { buildReleaseCandidateIdentity } from "../../../tools/server-scripts/verify-release-candidate-identity.ts";
import {
  githubProcessEnvironment,
  promotionDecision,
  requiredWorkflowPaths,
  selectLatestWorkflowRun,
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

    expect(requiredWorkflowPaths("nightly")).toEqual([".github/workflows/branch-flow.yml"]);
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
    const marker: any = "\n  functional-completeness:\n";
    const start: any = ciWorkflow.indexOf(marker);
    expect(start).toBeGreaterThan(0);
    const remainder: any = ciWorkflow.slice(start + marker.length);
    const nextJob: any = remainder.search(/\n  [a-z][a-z0-9-]*:\n/u);
    const stableGate: any = ciWorkflow.slice(
      start,
      nextJob < 0 ? ciWorkflow.length : start + marker.length + nextJob,
    );
    expect(stableGate).toContain("github.ref_name == 'stable'");
    expect(stableGate).not.toContain("github.ref_name == 'release'");
    expect(stableGate).toContain("needs: [public-gate, supply-chain]");
    expect(stableGate).toContain("name: stable-authority-${{ github.sha }}");
    expect(stableGate).toContain("build/release/control/SOURCE_CANDIDATE.json");
    expect(stableGate).toContain("build/reports/platform-acceptance.json");
    expect(stableGate).toContain("stable-authority-manifest.json");
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
      await fs.promises.mkdir(bundle);
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
        supportedProfiles: ["enterprise-single-node"],
      });
      const candidateText: any = `${JSON.stringify(candidate, null, 2)}\n`;
      const functional: any = {
        schemaVersion: "v0.0.1:acceptance:platform-report-3",
        acceptanceStandard: "functional-completeness",
        claim: "functional-complete",
        candidate_digest: candidate.candidate_digest,
        status: "accepted",
        selectedProfile: "enterprise-single-node",
        sourceRevision: candidate.source_revision,
        summary: { releaseReady: true, reportLeakScan: true },
      };
      const functionalText: any = `${JSON.stringify(functional, null, 2)}\n`;
      const manifest: any = createStableAuthorityManifest({
        artifactName: `stable-authority-${candidate.source_revision}`,
        candidateDigest: candidate.candidate_digest,
        candidateFileDigest: sha256(candidateText),
        functionalReceiptDigest: sha256(functionalText),
        runAttempt: 2,
        runId: "42",
        sourceRevision: candidate.source_revision,
      });
      const run: any = {
        branch: "stable",
        event: "push",
        headSha: candidate.source_revision,
        runAttempt: 2,
        runId: "42",
        workflowPath: ".github/workflows/ci.yml",
      };
      await Promise.all([
        fs.promises.writeFile(path.join(bundle, "SOURCE_CANDIDATE.json"), candidateText),
        fs.promises.writeFile(path.join(root, "expected.json"), candidateText),
        fs.promises.writeFile(path.join(bundle, "platform-acceptance.json"), functionalText),
        fs.promises.writeFile(path.join(bundle, "stable-authority-manifest.json"), `${JSON.stringify(manifest)}\n`),
        fs.promises.writeFile(path.join(root, "run.json"), `${JSON.stringify(run)}\n`),
      ]);
      await expect(runAuthorityCommand([
        "verify-stable-bundle",
        "--bundle", bundle,
        "--expected-candidate", path.join(root, "expected.json"),
        "--run", path.join(root, "run.json"),
      ])).resolves.toMatchObject({ stage: "stable" });

      await fs.promises.writeFile(
        path.join(bundle, "stable-authority-manifest.json"),
        `${JSON.stringify({ ...manifest, unexpected: true })}\n`,
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

  it("consumes the stable authority on release and requires the tag commit to equal the release tip", () : any => {
    const branchWorkflow: any = read(".github/workflows/release-branch.yml");
    const releaseWorkflow: any = read(".github/workflows/release.yml");

    expect(branchWorkflow).toContain("runs-on: ubuntu-24.04");
    expect(branchWorkflow).toContain('branches: ["release"]');
    expect(branchWorkflow).toContain("stable-authority-${GITHUB_SHA}");
    expect(branchWorkflow).toContain("npm run server:verify:release-deployment");
    expect(branchWorkflow).toContain("release-authority-${{ github.sha }}");
    expect(branchWorkflow.match(/GH_TOKEN: \$\{\{ github\.token \}\}/gu)).toHaveLength(3);

    expect(releaseWorkflow).toContain('test "$tag_commit" = "$release_commit"');
    expect(releaseWorkflow).not.toContain("git merge-base --is-ancestor");
    expect(releaseWorkflow).toContain("name: release-authority-${{ github.sha }}");
    expect(releaseWorkflow).not.toContain("\n  functional-completeness:\n");
    expect(releaseWorkflow.match(/GH_TOKEN: \$\{\{ github\.token \}\}/gu)).toHaveLength(3);
    expect(releaseWorkflow.indexOf("- name: Install dependencies"))
      .toBeLessThan(releaseWorkflow.indexOf("- name: Validate the canonical release definition"));
  });
});
