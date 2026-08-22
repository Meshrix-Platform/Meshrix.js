#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REVISION: any = /^[a-f0-9]{40}$/u;
const BRANCHES: readonly any[] = Object.freeze(["nightly", "stable", "release"]);
const POLL_INTERVAL_MS: any = 10_000;
const WORKFLOW_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  nightly: Object.freeze([".github/workflows/branch-flow.yml"]),
  stable: Object.freeze([".github/workflows/branch-flow.yml", ".github/workflows/ci.yml"]),
  release: Object.freeze([".github/workflows/branch-flow.yml", ".github/workflows/release-branch.yml"]),
});

function failure(code?: any) : any {
  return Object.assign(new Error(String(code || "release_promotion_failed")), {
    code: String(code || "release_promotion_failed"),
  });
}

function run(command?: any, args: any[] = [], code?: any) : any {
  const result: any = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw failure(code);
  return String(result.stdout || "").trim();
}

function git(args: any[] = [], code: any = "git_command_failed") : any {
  return run("git", args, code);
}

function gh(args: any[] = [], code: any = "github_command_failed") : any {
  return run("gh", args, code);
}

function parseJson(value?: any, code: any = "github_response_invalid") : any {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    throw failure(code);
  }
}

function requireRevision(value?: any, code: any = "candidate_revision_invalid") : any {
  const revision: any = String(value || "").trim().toLowerCase();
  if (!REVISION.test(revision)) throw failure(code);
  return revision;
}

function isAncestor(ancestor?: any, descendant?: any) : any {
  const result: any = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  return result.status === 0;
}

export function promotionDecision({
  current,
  candidate,
  ancestor = isAncestor,
}: Record<string, any> = {}) : any {
  const currentRevision: any = requireRevision(current, "promotion_current_revision_invalid");
  const candidateRevision: any = requireRevision(candidate);
  if (currentRevision === candidateRevision) return { action: "already-current" };
  if (!ancestor(currentRevision, candidateRevision)) throw failure("promotion_not_fast_forward");
  return { action: "advance" };
}

export function requiredWorkflowPaths(branch?: any) : any {
  const paths: any = WORKFLOW_PATHS[String(branch || "")];
  if (!paths) throw failure("promotion_branch_invalid");
  return [...paths];
}

export function selectLatestWorkflowRun(
  runs: any[] = [],
  { branch, candidate, workflowPath }: Record<string, any> = {},
) : any {
  return runs
    .filter((runRecord?: any) : any =>
      runRecord?.event === "push" &&
      runRecord?.head_branch === branch &&
      runRecord?.head_sha === candidate &&
      runRecord?.path === workflowPath
    )
    .sort((left?: any, right?: any) : any =>
      Number(right?.run_attempt || 0) - Number(left?.run_attempt || 0) ||
      Number(right?.id || 0) - Number(left?.id || 0)
    )[0] || null;
}

function shortRevision(revision?: any) : any {
  return requireRevision(revision).slice(0, 12);
}

function repositoryName() : any {
  const name: any = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], "github_repository_unavailable");
  if (!/^[^/\s]+\/[^/\s]+$/u.test(name)) throw failure("github_repository_invalid");
  return name;
}

function refreshRemoteBranches() : any {
  git([
    "fetch",
    "--quiet",
    "origin",
    "refs/heads/nightly:refs/remotes/origin/nightly",
    "refs/heads/stable:refs/remotes/origin/stable",
    "refs/heads/release:refs/remotes/origin/release",
  ], "remote_branches_fetch_failed");
}

function remoteRevision(repository?: any, branch?: any) : any {
  return requireRevision(
    gh(["api", `repos/${repository}/git/ref/heads/${branch}`, "--jq", ".object.sha"], "remote_branch_unavailable"),
    "remote_branch_revision_invalid",
  );
}

function ensureLocalCandidate(requestedCandidate?: any) : any {
  if (git(["status", "--porcelain=v1", "--untracked-files=all"], "working_tree_check_failed") !== "") {
    throw failure("working_tree_not_clean");
  }
  if (git(["symbolic-ref", "--short", "HEAD"], "current_branch_unavailable") !== "nightly") {
    throw failure("current_branch_must_be_nightly");
  }
  git(["diff", "--check"], "git_diff_check_failed");
  const head: any = requireRevision(git(["rev-parse", "HEAD"], "candidate_revision_unavailable"));
  const candidate: any = requestedCandidate ? requireRevision(requestedCandidate) : head;
  if (candidate !== head) throw failure("candidate_must_equal_head");
  if (requireRevision(git(["rev-parse", "refs/heads/nightly"], "nightly_revision_unavailable")) !== candidate) {
    throw failure("candidate_must_equal_local_nightly");
  }
  return candidate;
}

function verifyPublicationCandidate() : any {
  run("npm", ["run", "repo:local-info-hygiene"], "local_info_hygiene_failed");
  run("node", ["tools/scripts/verify-git-publication.ts", "--index"], "git_publication_check_failed");
  console.log("[release-promotion] publication preflight passed");
}

function advanceNightly(repository?: any, candidate?: any, dryRun: any = false) : any {
  const current: any = remoteRevision(repository, "nightly");
  const decision: any = promotionDecision({ current, candidate });
  if (decision.action === "already-current") {
    console.log(`[release-promotion] nightly already at ${shortRevision(candidate)}`);
    return false;
  }
  if (dryRun) {
    console.log(`[release-promotion] nightly would advance to ${shortRevision(candidate)}`);
    return true;
  }
  git(["push", "--porcelain", "origin", `${candidate}:refs/heads/nightly`], "nightly_push_failed");
  if (remoteRevision(repository, "nightly") !== candidate) throw failure("nightly_push_not_observed");
  console.log(`[release-promotion] nightly advanced to ${shortRevision(candidate)}`);
  return true;
}

function advanceProtectedBranch(repository?: any, branch?: any, upstream?: any, candidate?: any, dryRun: any = false) : any {
  const upstreamCurrent: any = remoteRevision(repository, upstream);
  if (upstreamCurrent !== candidate) {
    if (!dryRun) throw failure(`${upstream}_tip_mismatch`);
    promotionDecision({ current: upstreamCurrent, candidate });
  }
  const current: any = remoteRevision(repository, branch);
  const decision: any = promotionDecision({ current, candidate });
  if (decision.action === "already-current") {
    console.log(`[release-promotion] ${branch} already at ${shortRevision(candidate)}`);
    return false;
  }
  if (dryRun) {
    console.log(`[release-promotion] ${branch} would advance to ${shortRevision(candidate)}`);
    return true;
  }
  gh([
    "api",
    "--method", "PATCH",
    `repos/${repository}/git/refs/heads/${branch}`,
    "-f", `sha=${candidate}`,
    "-F", "force=false",
  ], `${branch}_promotion_failed`);
  if (remoteRevision(repository, branch) !== candidate) throw failure(`${branch}_promotion_not_observed`);
  console.log(`[release-promotion] ${branch} advanced to ${shortRevision(candidate)}`);
  return true;
}

function workflowRuns(repository?: any, branch?: any, candidate?: any) : any {
  const response: any = parseJson(gh([
    "api",
    `repos/${repository}/actions/runs?event=push&branch=${branch}&head_sha=${candidate}&per_page=100`,
  ], "workflow_runs_unavailable"));
  if (!Array.isArray(response?.workflow_runs)) throw failure("workflow_runs_invalid");
  return response.workflow_runs;
}

function failedJobNames(repository?: any, runId?: any) : any {
  const response: any = parseJson(gh([
    "api",
    `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`,
  ], "workflow_jobs_unavailable"));
  if (!Array.isArray(response?.jobs)) throw failure("workflow_jobs_invalid");
  return response.jobs
    .filter((job?: any) : any => !["success", "skipped"].includes(String(job?.conclusion || "")))
    .map((job?: any) : any => ({
      job: String(job?.name || "unnamed-job"),
      steps: Array.isArray(job?.steps)
        ? job.steps
          .filter((step?: any) : any => !["success", "skipped"].includes(String(step?.conclusion || "")))
          .map((step?: any) : any => String(step?.name || "unnamed-step"))
        : [],
    }));
}

function sleep(delayMs?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, delayMs));
}

async function waitForWorkflow(repository?: any, branch?: any, candidate?: any, workflowPath?: any) : Promise<any> {
  let lastState: any = "";
  for (;;) {
    const selected: any = selectLatestWorkflowRun(workflowRuns(repository, branch, candidate), {
      branch,
      candidate,
      workflowPath,
    });
    const state: any = selected
      ? `${String(selected.status || "unknown")}:${String(selected.conclusion || "")}`
      : "awaiting-run";
    if (state !== lastState) {
      console.log(`[release-promotion] ${branch} ${path.basename(workflowPath)} ${state}`);
      lastState = state;
    }
    if (!selected || selected.status !== "completed") {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (selected.conclusion === "success") return selected;
    for (const failed of failedJobNames(repository, selected.id)) {
      console.error(`[release-promotion] failed job=${failed.job} steps=${failed.steps.join(",") || "none"}`);
    }
    throw failure(`${branch}_${path.basename(workflowPath, ".yml")}_failed`);
  }
}

async function waitForBranchAuthority(repository?: any, branch?: any, candidate?: any) : Promise<any> {
  await Promise.all(requiredWorkflowPaths(branch).map((workflowPath?: any) : any =>
    waitForWorkflow(repository, branch, candidate, workflowPath)
  ));
  console.log(`[release-promotion] ${branch} authority passed`);
}

function parseArgs(argv: any[] = []) : any {
  const options: Record<string, any> = { candidate: "", dryRun: false, selfTest: false, help: false };
  for (let index: any = 0; index < argv.length; index += 1) {
    const arg: any = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--candidate") options.candidate = argv[++index] || "";
    else if (arg.startsWith("--candidate=")) options.candidate = arg.slice("--candidate=".length);
    else throw failure("release_promotion_arguments_invalid");
  }
  return options;
}

export async function runBranchPromotion(argv: any[] = process.argv.slice(2)) : Promise<any> {
  const options: any = parseArgs(argv);
  if (options.help) {
    console.log("Usage: npm run release:promote-branches -- [--candidate <40-hex-sha>] [--dry-run]");
    return;
  }
  if (options.selfTest) {
    const candidate: any = "c".repeat(40);
    const current: any = "a".repeat(40);
    promotionDecision({ current, candidate, ancestor: () : any => true });
    if (requiredWorkflowPaths("stable").length !== 2) throw failure("release_promotion_self_test_failed");
    console.log("[release-promotion] self-test passed");
    return;
  }

  const candidate: any = ensureLocalCandidate(options.candidate);
  const repository: any = repositoryName();
  refreshRemoteBranches();
  verifyPublicationCandidate();
  console.log(`[release-promotion] candidate ${shortRevision(candidate)}`);

  advanceNightly(repository, candidate, options.dryRun);
  if (options.dryRun) {
    advanceProtectedBranch(repository, "stable", "nightly", candidate, true);
    advanceProtectedBranch(repository, "release", "stable", candidate, true);
    return;
  }
  await waitForBranchAuthority(repository, "nightly", candidate);

  advanceProtectedBranch(repository, "stable", "nightly", candidate);
  await waitForBranchAuthority(repository, "stable", candidate);

  advanceProtectedBranch(repository, "release", "stable", candidate);
  await waitForBranchAuthority(repository, "release", candidate);

  for (const branch of BRANCHES) {
    if (remoteRevision(repository, branch) !== candidate) throw failure("promotion_final_ref_mismatch");
  }
  console.log(`[release-promotion] complete candidate=${shortRevision(candidate)} branches=nightly,stable,release deployment=verified`);
}

const invoked: any = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  runBranchPromotion().catch((error?: any) : any => {
    console.error(`[release-promotion] failed code=${String(error?.code || "release_promotion_failed")}`);
    process.exitCode = 1;
  });
}
