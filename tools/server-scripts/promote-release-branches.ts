#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { npmCliArgs, resolveNpmCliInvocation } from "./lib/npm-cli-invocation.ts";
import {
  DIRECT_UPSTREAM as PROMOTION_SOURCES,
  selectLatestCandidateWorkflowRun,
  verifyPublishedRelease,
} from "../scripts/verify-branch-flow.ts";
import { writePrivateFileAtomic } from "../../packages/foundation/src/storage/private-file-atomic.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REVISION: any = /^[a-f0-9]{40}$/u;
const GITHUB_RETRY_INTERVAL_MS: any = 2_000;
const PROMOTION_WORKFLOWS = Object.freeze([".github/workflows/branch-flow.yml", ".github/workflows/ci.yml"]);

function failure(code?: any) : any {
  return Object.assign(new Error(String(code || "release_promotion_failed")), {
    code: String(code || "release_promotion_failed"),
  });
}

function run(command?: any, args: any[] = [], code?: any, environment: any = process.env) : any {
  const result: any = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw failure(code);
  return String(result.stdout || "").trim();
}

function git(args: any[] = [], code: any = "git_command_failed") : any {
  return run("git", args, code);
}

export function githubProcessEnvironment(environment: Record<string, any> = process.env) : any {
  return { ...environment, GODEBUG: "http2client=0" };
}

export function isTransientGithubFailure(stderr?: any) : any {
  return /(?:\bEOF\b|connection reset|connection refused|TLS handshake timeout|i\/o timeout|stream error|temporarily unavailable|HTTP 50[234])/iu
    .test(String(stderr || ""));
}

function sleepSync(delayMs?: any) : any {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function gh(args: any[] = [], code = "github_command_failed", retryRead = true): string {
  let announcedRetry: any = false;
  for (;;) {
    const result: any = spawnSync("gh", args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: githubProcessEnvironment(),
      maxBuffer: 16 * 1024 * 1024,
      stdio: retryRead ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    if (!result.error && result.status === 0) return String(result.stdout || "").trim();
    if (!retryRead || !isTransientGithubFailure(result.stderr)) throw failure(code);
    if (!announcedRetry) {
      console.log("[release-promotion] github transport retry");
      announcedRetry = true;
    }
    sleepSync(GITHUB_RETRY_INTERVAL_MS);
  }
  throw failure(code);
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

export function repositoryFromOrigin(origin: string): string {
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(origin.trim());
  if (!match) throw failure("github_repository_invalid");
  return match[1];
}

function repositoryName(): string {
  return repositoryFromOrigin(git(["config", "--get", "remote.origin.url"], "github_repository_unavailable"));
}

async function githubJson(route: string): Promise<any> {
  return parseJson(gh(["api", route], "github_evidence_unavailable"));
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

export function ensureLocalCandidate(requestedCandidate: unknown, gitCommand: typeof git = git): string {
  const candidate = requireRevision(requestedCandidate, "candidate_revision_required");
  gitCommand(["cat-file", "-e", `${candidate}^{commit}`], "candidate_revision_unavailable");
  return candidate;
}

function verifyPublicationCandidate(candidate?: any) : any {
  const ownerRoot: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-promotion-"));
  const workspace: any = path.join(ownerRoot, "candidate");
  let addedWorktree = false;
  try {
    const added: any = spawnSync("git", ["worktree", "add", "--quiet", "--detach", workspace, candidate], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (added.status !== 0) throw failure("promotion_candidate_worktree_failed");
    addedWorktree = true;
    fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(workspace, "node_modules"), "junction");
    const runInCandidate: any = (command?: any, args: any[] = [], code?: any) : any => {
      const result: any = spawnSync(command, args, {
        cwd: workspace,
        encoding: "utf8",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.error || result.status !== 0) throw failure(code);
    };
    const npmInvocation = resolveNpmCliInvocation();
    runInCandidate(npmInvocation.command, npmCliArgs(npmInvocation, ["run", "repo:local-info-hygiene"]), "local_info_hygiene_failed");
    runInCandidate(process.execPath, ["tools/scripts/verify-git-publication.ts", "--index"], "git_publication_check_failed");
    console.log("[release-promotion] publication preflight passed");
  } finally {
    if (addedWorktree) spawnSync("git", ["worktree", "remove", "--force", workspace], { cwd: repoRoot, stdio: "ignore" });
    fs.rmSync(ownerRoot, { recursive: true, force: true });
  }
}

export function promotionPullRequestMatches(pr: any, repository: string, target: string, candidate: string): boolean {
  return Number.isSafeInteger(pr?.number) && pr.number > 0 &&
    pr.base?.ref === target && pr.head?.ref === PROMOTION_SOURCES[target] &&
    pr.base?.repo?.full_name === repository && pr.head?.repo?.full_name === repository &&
    pr.head?.sha === candidate;
}

export async function findPromotionPullRequest({ repository, target, candidate, readGithub = githubJson }: Record<string, any>): Promise<any | null> {
  const source = PROMOTION_SOURCES[target];
  if (!source) throw failure("promotion_target_invalid");
  const owner = repository.split("/")[0];
  for (let page = 1; ; page += 1) {
    const rows = await readGithub(`/repos/${repository}/pulls?state=all&base=${target}&head=${encodeURIComponent(`${owner}:${source}`)}&sort=updated&direction=desc&per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw failure("promotion_pull_requests_invalid");
    const pr = rows.find((row: any) => promotionPullRequestMatches(row, repository, target, candidate) &&
      (row.state === "open" || (typeof row.merged_at === "string" && row.merged_at.length > 0)));
    if (pr) return pr;
    if (rows.length < 100) return null;
  }
}

export function promotionRequestDecision({ target, candidate, sourceRevision, current, ancestor = isAncestor }: Record<string, any>): any {
  const source = PROMOTION_SOURCES[target];
  if (!source) throw failure("promotion_target_invalid");
  requireRevision(candidate);
  requireRevision(sourceRevision, "promotion_source_revision_invalid");
  requireRevision(current, "promotion_current_revision_invalid");
  if (sourceRevision !== candidate) throw failure("promotion_source_tip_mismatch");
  if (candidate === current || ancestor(candidate, current)) return { action: "already-promoted", source };
  if (!ancestor(current, candidate)) throw failure("promotion_source_requires_target_sync");
  return { action: "request", source };
}

export async function requestPromotion({ repository, target, candidate, readGithub = githubJson, createPullRequest }: Record<string, any>): Promise<any> {
  const existing = await findPromotionPullRequest({ repository, target, candidate, readGithub });
  if (existing) return existing;
  await createPullRequest();
  const created = await findPromotionPullRequest({ repository, target, candidate, readGithub });
  if (!created) throw failure("promotion_pull_request_not_observed");
  return created;
}

export async function verifyCompletedPromotion({
  repository, target, candidate, pr, currentTarget,
  readGithub = githubJson, readGit = git, ancestor = isAncestor
}: Record<string, any>): Promise<any> {
  if (!promotionPullRequestMatches(pr, repository, target, candidate) ||
      typeof pr.merged_at !== "string" || !pr.merged_at ||
      !/^[a-f0-9]{40}$/u.test(String(pr.merge_commit_sha || ""))) {
    throw failure("promotion_not_merged");
  }
  const mergeCommit = pr.merge_commit_sha;
  requireRevision(currentTarget, "promotion_current_revision_invalid");
  const parents = String(readGit(["rev-list", "--parents", "-n", "1", mergeCommit])).trim().split(/\s+/u).slice(1);
  if (parents.length !== 2 || parents[1] !== candidate ||
      !ancestor(parents[0], candidate) || !ancestor(mergeCommit, currentTarget) ||
      readGit(["rev-parse", `${mergeCommit}^{tree}`]) !== readGit(["rev-parse", `${candidate}^{tree}`])) {
    throw failure("promotion_merge_not_bound");
  }
  const checks: any[] = [];
  for (const workflowPath of PROMOTION_WORKFLOWS) {
    const filename = path.posix.basename(workflowPath);
    const response = await readGithub(`/repos/${repository}/actions/workflows/${filename}/runs?event=pull_request&head_sha=${candidate}&branch=${PROMOTION_SOURCES[target]}&per_page=100`);
    if (!Array.isArray(response?.workflow_runs)) throw failure("promotion_workflow_unverified");
    const run = selectLatestCandidateWorkflowRun(response.workflow_runs, {
      candidate, workflowPath, headBranch: PROMOTION_SOURCES[target], pullRequestNumber: pr.number
    });
    if (!run || run.event !== "pull_request" || run.status !== "completed" || run.conclusion !== "success") {
      throw failure("promotion_workflow_unverified");
    }
    checks.push({ workflowPath, runId: run.id, sourceRevision: candidate, conclusion: "success" });
  }
  let publication = null;
  if (target === "release") {
    const result = await verifyPublishedRelease({ repository, baseRevision: parents[0], candidate, readGit, readGithub });
    if (!result.ok) throw failure(result.code);
    publication = result.publication;
  }
  return { checks, publication, targetContainsMerge: true };
}

export function completedReleasePromotionMatches(report: any, candidate: string): boolean {
  return /^[a-f0-9]{40}$/u.test(candidate) &&
    report?.schemaVersion === "v0.0.1:release:branch-promotion-report-1" &&
    report.verifier === "tools/server-scripts/promote-release-branches.ts" &&
    report.sourceRevision === candidate && report.sourceBranch === "stable" &&
    report.targetBranch === "release" && report.status === "completed" &&
    report.targetContainsMerge === true && report.releaseReady === true &&
    Number.isSafeInteger(report.pullRequest?.number) && report.pullRequest.number > 0 &&
    report.pullRequest.headSha === candidate && /^[a-f0-9]{40}$/u.test(String(report.pullRequest.mergeCommit || "")) &&
    Array.isArray(report.checks) && PROMOTION_WORKFLOWS.every((workflowPath) => report.checks.some((check: any) =>
      check?.workflowPath === workflowPath && check.sourceRevision === candidate &&
      Number.isSafeInteger(check.runId) && check.runId > 0 && check.conclusion === "success")) &&
    report.publication?.sourceRevision === candidate && report.publication.conclusion === "success" &&
    Number.isSafeInteger(report.publication.releaseId) && report.publication.releaseId > 0 &&
    Number.isSafeInteger(report.publication.workflowRunId) && report.publication.workflowRunId > 0 &&
    typeof report.publication.version === "string" && report.publication.version.length > 0 &&
    report.publication.tag === `v${report.publication.version}`;
}

export function createPromotionReport({ target, candidate, pr, observed = null, publication = null }: Record<string, any>): any {
  const completed = observed !== null;
  return {
    schemaVersion: "v0.0.1:release:branch-promotion-report-1",
    verifier: "tools/server-scripts/promote-release-branches.ts", generatedAt: new Date().toISOString(),
    sourceRevision: candidate, sourceBranch: PROMOTION_SOURCES[target], targetBranch: target,
    status: completed ? "completed" : "requested",
    pullRequest: { number: pr.number, headSha: pr.head.sha, mergeCommit: completed ? pr.merge_commit_sha : null },
    targetContainsMerge: observed?.targetContainsMerge === true, checks: observed?.checks || [], publication,
    releaseReady: completed && target === "release" && publication !== null
  };
}

export function parseArgs(argv: string[] = []): any {
  const options: any = { candidate: "", target: "", dryRun: false, verify: false, selfTest: false, help: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    const flag = arg.split("=", 1)[0];
    if (seen.has(flag)) throw failure("release_promotion_duplicate_argument");
    seen.add(flag);
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--verify") options.verify = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (flag === "--candidate" || flag === "--target") {
      const value = arg.includes("=") ? arg.slice(flag.length + 1) : argv[++index];
      if (!value || value.startsWith("--")) throw failure("release_promotion_arguments_invalid");
      options[flag.slice(2)] = value;
    } else throw failure("release_promotion_arguments_invalid");
  }
  if (options.dryRun && options.verify) throw failure("release_promotion_arguments_invalid");
  if (!options.help && !options.selfTest) {
    if (!Object.hasOwn(PROMOTION_SOURCES, options.target)) throw failure("promotion_target_invalid");
    if (options.verify && !options.candidate) throw failure("candidate_revision_required");
    if (options.candidate) options.candidate = requireRevision(options.candidate);
  }
  return options;
}

export async function runBranchPromotion(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("Usage: npm run release:promote-branches -- --target <stable|release> [--candidate <40-hex-sha>] [--dry-run|--verify]");
    console.log("--verify requires --candidate; requests otherwise pin the current remote source tip.");
    return;
  }
  if (options.selfTest) {
    const candidate = "c".repeat(40);
    const decision = promotionRequestDecision({ target: "stable", candidate, sourceRevision: candidate, current: "a".repeat(40), ancestor: (a: string) => a === "a".repeat(40) });
    if (decision.action !== "request" || decision.source !== "nightly") throw failure("release_promotion_self_test_failed");
    console.log("[release-promotion] self-test passed");
    return;
  }
  const target = options.target;
  const source = PROMOTION_SOURCES[target];
  if (!source) throw failure("promotion_target_invalid");
  const repository = repositoryName();
  refreshRemoteBranches();
  const sourceRevision = options.verify ? null : remoteRevision(repository, source);
  const candidate = ensureLocalCandidate(options.candidate || sourceRevision);
  const currentTarget = remoteRevision(repository, target);
  let decision: any = null;
  if (!options.verify) {
    decision = promotionRequestDecision({ target, candidate, sourceRevision, current: currentTarget });
    verifyPublicationCandidate(candidate);
  }
  let publication = null;
  if (!options.verify && target === "release" && decision.action !== "already-promoted") {
    const checked = await verifyPublishedRelease({ repository, baseRevision: currentTarget, candidate, readGithub: githubJson });
    if (!checked.ok) throw failure(checked.code);
    publication = checked.publication;
  }
  if (options.dryRun) {
    console.log(`[release-promotion] ${source}->${target} ${decision.action} candidate=${candidate.slice(0, 12)}`);
    return;
  }
  let pr: any;
  if (options.verify || decision?.action === "already-promoted") {
    pr = await findPromotionPullRequest({ repository, target, candidate });
    if (!pr) throw failure("promotion_pull_request_not_observed");
  } else {
    pr = await requestPromotion({ repository, target, candidate, createPullRequest: () => {
      if (remoteRevision(repository, source) !== candidate) throw failure("promotion_source_tip_mismatch");
      return gh(["pr", "create", "--repo", repository, "--base", target, "--head", source,
        "--title", `Promote ${source} to ${target}`,
        "--body", `Promote ${source} candidate ${candidate} to ${target} through the repository-required branch policy and full regression checks.`],
        "promotion_pull_request_create_failed", false);
    } });
  }
  let observed: any = null;
  if (options.verify || pr.merged_at) {
    observed = await verifyCompletedPromotion({ repository, target, candidate, pr, currentTarget });
    publication = observed.publication;
  }
  const report = createPromotionReport({ target, candidate, pr, observed, publication });
  await writePrivateFileAtomic(path.join(repoRoot, "build", "reports", "branch-promotion.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[release-promotion] ${report.status} ${source}->${target} pr=${pr.number} candidate=${candidate.slice(0, 12)}`);
}

const invoked: any = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  runBranchPromotion().catch((error?: any) : any => {
    console.error(`[release-promotion] failed code=${String(error?.code || "release_promotion_failed")}`);
    process.exitCode = 1;
  });
}
