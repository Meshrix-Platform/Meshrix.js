#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { assertReleaseVersion, compareReleaseVersions } from "../server-scripts/lib/release-metadata.ts";

export const LONG_LIVED_BRANCHES: readonly any[] = Object.freeze(["nightly", "stable", "release"]);
const LONG_LIVED: any = new Set<any>(LONG_LIVED_BRANCHES);
const RETIRED: any = new Set<any>(["main", "master"]);
const ZERO_OID: any = "0".repeat(40);
export const DIRECT_UPSTREAM: Readonly<Record<string, string>> = Object.freeze({ stable: "nightly", release: "stable" });

function identity(payload?: any) : any {
  return {
    base: payload?.repository?.full_name || "",
    head: payload?.pull_request?.head?.repo?.full_name || ""
  };
}

function sameRepository(payload?: any) : any {
  const repositories: any = identity(payload);
  return repositories.base.length > 0
    && repositories.head.length > 0
    && repositories.base === repositories.head;
}

export function evaluateBranchFlow({
  eventName = "",
  refName = "",
  baseRef = "",
  headRef = "",
  payload = {}
}: Record<string, any> = {}) : any {
  if (eventName === "push") {
    return LONG_LIVED.has(refName)
      ? { ok: true, code: "protected-push-event" }
      : { ok: false, code: "unexpected-push-ref" };
  }
  if (eventName !== "pull_request" && eventName !== "pull_request_target") {
    return { ok: true, code: "event-not-governed" };
  }

  const base: any = baseRef || payload.pull_request?.base?.ref || "";
  const head: any = headRef || payload.pull_request?.head?.ref || "";
  if (RETIRED.has(base)) return { ok: false, code: "retired-base" };
  if (!LONG_LIVED.has(base)) return { ok: true, code: "base-not-governed" };
  if (!sameRepository(payload)) return { ok: false, code: "cross-repository-promotion" };
  if (base === "nightly") {
    return !LONG_LIVED.has(head) && !RETIRED.has(head) && head.length > 0
      ? { ok: true, code: "temporary-to-nightly" }
      : { ok: false, code: "nightly-source-invalid" };
  }
  const required: any = DIRECT_UPSTREAM[base];
  return head === required
    ? { ok: true, code: `${required}-to-${base}` }
    : { ok: false, code: `${base}-source-invalid` };
}

function git(args?: any) : any {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function isAncestor(ancestor?: any, descendant?: any) : any {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

export function verifyProtectedPushTopology({
  branch,
  before,
  after,
  repository = "",
  pullRequests = [],
  ancestor = isAncestor,
  parentsOf = commitParentsOf
}: Record<string, any> = {}) : any {
  if (!LONG_LIVED.has(branch)) return { ok: false, code: "protected-branch-invalid" };
  if (!before || !after || before === ZERO_OID || after === ZERO_OID) {
    return { ok: false, code: "protected-branch-bootstrap-forbidden" };
  }
  if (!ancestor(before, after)) return { ok: false, code: "protected-branch-not-fast-forward" };
  if (branch === "nightly") return { ok: true, code: "direct-nightly-advance" };
  const source: any = DIRECT_UPSTREAM[branch];
  const parents: any = parentsOf(after);
  const promotion: any = Array.isArray(pullRequests) && pullRequests.find((pr: any) =>
    Number.isSafeInteger(pr?.number) && pr.number > 0 &&
    typeof pr.merged_at === "string" && pr.merged_at.length > 0 &&
    pr.merge_commit_sha === after && pr.base?.ref === branch &&
    pr.head?.ref === source && repository.length > 0 &&
    pr.base?.repo?.full_name === repository && pr.head?.repo?.full_name === repository &&
    Array.isArray(parents) && parents.length === 2 &&
    parents[0] === before && parents[1] === pr.head?.sha
  );
  if (!promotion) return { ok: false, code: "promotion-pr-merge-missing" };
  return {
    ok: true, code: `${source}-pr-promoted-${branch}`,
    promotion: { number: promotion.number, headSha: promotion.head.sha, mergeCommit: after }
  };
}

function commitParentsOf(revision?: any) : any {
  try {
    const line: any = git(["rev-list", "--parents", "-n", "1", String(revision)]);
    return String(line).split(/\s+/).slice(1).filter(Boolean);
  } catch {
    return [];
  }
}

export async function readGithubJson(route: string): Promise<any> {
  if (!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//u.test(route)) {
    throw new Error('github-route-invalid');
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Meshrix-branch-flow'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com${route}`, { headers });
  if (!response.ok) throw new Error(`github-read-failed-${response.status}`);
  return response.json();
}

export function selectLatestCandidateWorkflowRun(
  runs: any[] = [],
  { candidate, workflowPath, headBranch, pullRequestNumber }: Record<string, any> = {}
): any {
  return runs.filter((run) =>
    Number.isSafeInteger(run?.id) && run.id > 0 &&
    run.head_sha === candidate && run.path === workflowPath &&
    run.head_branch === headBranch &&
    (pullRequestNumber === undefined ||
      (Array.isArray(run.pull_requests) &&
       run.pull_requests.some((pr: any) => pr?.number === pullRequestNumber)))
  ).sort((a, b) => b.id - a.id || Number(b.run_attempt || 0) - Number(a.run_attempt || 0))[0] || null;
}

export async function verifyPublishedRelease({
  repository, baseRevision, candidate, readGit = git, readGithub = readGithubJson
}: Record<string, any> = {}): Promise<any> {
  const denied = (code: string) => ({ ok: false, code });
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(String(repository || '')) ||
      !/^[a-f0-9]{40}$/u.test(String(baseRevision || '')) ||
      !/^[a-f0-9]{40}$/u.test(String(candidate || ''))) {
    return denied('release-candidate-invalid');
  }
  try {
    const base = JSON.parse(readGit(['show', `${baseRevision}:package.json`]));
    const manifest = JSON.parse(readGit(['show', `${candidate}:package.json`]));
    const definition = JSON.parse(readGit(['show', `${candidate}:tools/registry/release-definition.registry.json`]));
    const version = assertReleaseVersion(definition?.release?.version);
    const tag = definition?.release?.tag;
    if (tag !== `v${version}` || manifest?.version !== version) {
      return denied('release-version-mismatch');
    }
    if (compareReleaseVersions(version, assertReleaseVersion(base?.version)) <= 0) {
      return denied('release-version-not-new');
    }
    const route = `/repos/${repository}`;
    const release = await readGithub(`${route}/releases/tags/${encodeURIComponent(tag)}`);
    if (!Number.isSafeInteger(release?.id) || release.id <= 0 ||
        release.tag_name !== tag || release.draft !== false ||
        typeof release.published_at !== 'string' || !release.published_at) {
      return denied('release-not-published');
    }
    let object = (await readGithub(`${route}/git/ref/tags/${encodeURIComponent(tag)}`))?.object;
    const visited = new Set<string>();
    while (object?.type === 'tag') {
      if (!/^[a-f0-9]{40}$/u.test(String(object.sha || '')) || visited.has(object.sha)) {
        return denied('release-tag-invalid');
      }
      visited.add(object.sha);
      object = (await readGithub(`${route}/git/tags/${object.sha}`))?.object;
    }
    if (object?.type !== 'commit' || object.sha !== candidate) {
      return denied('release-tag-candidate-mismatch');
    }
    const response = await readGithub(`${route}/actions/workflows/release.yml/runs?head_sha=${candidate}&branch=${encodeURIComponent(tag)}&per_page=100`);
    if (!Array.isArray(response?.workflow_runs)) return denied('release-workflow-unverified');
    const run = selectLatestCandidateWorkflowRun(response.workflow_runs, {
      candidate, workflowPath: '.github/workflows/release.yml', headBranch: tag
    });
    if (!run || !['push', 'workflow_dispatch'].includes(run.event) ||
        run.status !== 'completed' || run.conclusion !== 'success') {
      return denied('release-workflow-unverified');
    }
    return {
      ok: true, code: 'new-version-published',
      publication: {
        version, tag, sourceRevision: candidate, releaseId: release.id,
        workflowRunId: run.id, conclusion: 'success'
      }
    };
  } catch {
    return denied('release-evidence-unavailable');
  }
}

function promotionPr({ branch, source, headSha, mergeCommit, repository = "example/repository", ...overrides }: Record<string, any> = {}): any {
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

export function runSelfTest() : any {
  const policyCases: any[] = [
    ["temporary to nightly", true, "nightly", "agent/security-review"],
    ["nightly to stable", true, "stable", "nightly"],
    ["stable to release", true, "release", "stable"],
    ["stable to nightly", false, "nightly", "stable"],
    ["temporary to stable", false, "stable", "agent/security-review"],
    ["nightly to release", false, "release", "nightly"],
    ["temporary to retired main", false, "main", "agent/security-review"],
    ["retired main to nightly", false, "nightly", "main"]
  ];
  for (const [label, expected, base, head] of policyCases) {
    const result: any = evaluateBranchFlow({
      eventName: "pull_request",
      baseRef: base,
      headRef: head,
      payload: sameRepositoryPayload(base, head)
    });
    if (result.ok !== expected) throw new Error(`policy fixture failed: ${label}`);
  }
  const missingIdentity: any = evaluateBranchFlow({
    eventName: "pull_request",
    baseRef: "nightly",
    headRef: "agent/security-review",
    payload: {}
  });
  if (missingIdentity.ok) throw new Error("policy fixture failed: missing repository identity");
  const crossRepository: any = sameRepositoryPayload("nightly", "agent/security-review");
  crossRepository.pull_request.head.repo.full_name = "fork/repository";
  if (evaluateBranchFlow({
    eventName: "pull_request",
    baseRef: "nightly",
    headRef: "agent/security-review",
    payload: crossRepository
  }).ok) throw new Error("policy fixture failed: cross-repository source");
  const repository: any = "example/repository";
  const stablePr: any = promotionPr({ branch: "stable", source: "nightly", headSha: "nightly-head", mergeCommit: "stable-merge" });
  const releasePr: any = promotionPr({ branch: "release", source: "stable", headSha: "stable-head", mergeCommit: "release-merge" });
  const topologyCases: any[] = [
    ["nightly direct commit", true, "nightly", "old-nightly", "nightly-tip", true, [], []],
    ["nightly multi-commit advance", true, "nightly", "old-nightly", "nightly-tip", true, [], []],
    ["stable promotion PR merge", true, "stable", "old-stable", "stable-merge", true, [stablePr], ["old-stable", "nightly-head"]],
    ["release promotion PR merge", true, "release", "old-release", "release-merge", true, [releasePr], ["old-release", "stable-head"]],
    ["stable direct fast-forward without PR", false, "stable", "old-stable", "nightly-tip", true, [], ["old-stable", "nightly-tip"]],
    ["release direct fast-forward without PR", false, "release", "old-release", "stable-tip", true, [], ["old-release", "stable-tip"]],
    ["stable PR from wrong source ref", false, "stable", "old-stable", "stable-merge", true,
      [promotionPr({ branch: "stable", source: "agent/feature", headSha: "feature-head", mergeCommit: "stable-merge" })],
      ["old-stable", "feature-head"]],
    ["release PR from wrong upstream", false, "release", "old-release", "release-merge", true,
      [promotionPr({ branch: "release", source: "nightly", headSha: "nightly-head", mergeCommit: "release-merge" })],
      ["old-release", "nightly-head"]],
    ["nightly force update", false, "nightly", "old-nightly", "nightly-tip", false, [], []],
    ["stable non-fast-forward", false, "stable", "old-stable", "stable-merge", false, [stablePr], ["old-stable", "nightly-head"]],
    ["release non-fast-forward", false, "release", "old-release", "release-merge", false, [releasePr], ["old-release", "stable-head"]],
    ["stable unmerged PR", false, "stable", "old-stable", "stable-merge", true,
      [promotionPr({ branch: "stable", source: "nightly", headSha: "nightly-head", mergeCommit: "stable-merge", merged_at: null })],
      ["old-stable", "nightly-head"]],
    ["stable PR head from a fork", false, "stable", "old-stable", "stable-merge", true,
      [promotionPr({ branch: "stable", source: "nightly", headSha: "nightly-head", mergeCommit: "stable-merge",
        head: { ref: "nightly", sha: "nightly-head", repo: { full_name: "fork/repository" } } })],
      ["old-stable", "nightly-head"]],
    ["stable PR merge_commit mismatch", false, "stable", "old-stable", "stable-merge", true,
      [promotionPr({ branch: "stable", source: "nightly", headSha: "nightly-head", mergeCommit: "other-merge" })],
      ["old-stable", "nightly-head"]],
    ["stable swapped merge parents", false, "stable", "old-stable", "stable-merge", true, [stablePr], ["nightly-head", "old-stable"]],
    ["stable extra merge parents", false, "stable", "old-stable", "stable-merge", true, [stablePr], ["old-stable", "nightly-head", "extra"]],
    ["stable bootstrap push", false, "stable", ZERO_OID, "stable-tip", true, [], []],
    ["unknown branch", false, "main", "old", "new", true, [], []]
  ];
  for (const [label, expected, branch, before, after, isFastForward, pullRequests, mergeParents] of topologyCases) {
    const result: any = verifyProtectedPushTopology({
      branch,
      before,
      after,
      repository,
      pullRequests,
      ancestor: () : any => isFastForward,
      parentsOf: () : any => mergeParents
    });
    if (result.ok !== expected) throw new Error(`topology fixture failed: ${label}`);
  }
  return { fixtures: policyCases.length + topologyCases.length + 2 };
}

function readPayload(file?: any) : any {
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

async function verifyCurrentEvent(): Promise<void> {
  const payload = readPayload(process.env.GITHUB_EVENT_PATH);
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const refName = process.env.GITHUB_REF_NAME || '';
  const baseRef = process.env.GITHUB_BASE_REF || payload.pull_request?.base?.ref || '';
  const repository = process.env.GITHUB_REPOSITORY || payload.repository?.full_name || '';
  const result = evaluateBranchFlow({
    eventName, refName, baseRef, headRef: process.env.GITHUB_HEAD_REF || '', payload
  });
  console[result.ok ? "log" : "error"](`[branch-flow] ${result.code}`);
  if (!result.ok) { process.exitCode = 1; return; }
  if ((eventName === 'pull_request' || eventName === 'pull_request_target') && baseRef === 'release') {
    const published = await verifyPublishedRelease({
      repository, baseRevision: payload.pull_request?.base?.sha,
      candidate: payload.pull_request?.head?.sha
    });
    console[published.ok ? "log" : "error"](`[branch-flow] ${published.code}`);
    if (!published.ok) process.exitCode = 1;
    return;
  }
  if (eventName !== 'push') return;
  const before = payload.before || '';
  const after = payload.after || process.env.GITHUB_SHA || '';
  let pullRequests: any[] = [];
  if (refName === 'stable' || refName === 'release') {
    if (!/^[a-f0-9]{40}$/u.test(after)) throw new Error('promotion-revision-invalid');
    // GitHub returns merged and open associations outside the default branch too.
    // https://docs.github.com/en/rest/commits/commits#list-pull-requests-associated-with-a-commit
    pullRequests = await readGithubJson(`/repos/${repository}/commits/${after}/pulls`);
  }
  const topology = verifyProtectedPushTopology({ branch: refName, before, after, repository, pullRequests });
  console[topology.ok ? "log" : "error"](`[branch-flow] ${topology.code}`);
  if (!topology.ok) { process.exitCode = 1; return; }
  if (refName === 'release') {
    const published = await verifyPublishedRelease({
      repository, baseRevision: before, candidate: topology.promotion.headSha
    });
    console[published.ok ? "log" : "error"](`[branch-flow] ${published.code}`);
    if (!published.ok) process.exitCode = 1;
  }
}

async function main(argv?: any) : Promise<any> {
  if (argv.length === 0) return verifyCurrentEvent();
  if (argv.length === 1 && argv[0] === "--self-test") {
    const result: any = runSelfTest();
    console.log(`[branch-flow] ${result.fixtures} fixtures passed.`);
    return;
  }
  throw Object.assign(new Error("invalid invocation"), { code: "invalid-invocation" });
}

const invoked: any = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  try {
    await main(process.argv.slice(2));
  } catch (error: any) {
    console.error(`[branch-flow] ${error?.code || "verification-failed"}`);
    process.exitCode = 1;
  }
}
