#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const LONG_LIVED_BRANCHES: readonly any[] = Object.freeze(["nightly", "stable", "release"]);
const LONG_LIVED: any = new Set<any>(LONG_LIVED_BRANCHES);
const RETIRED: any = new Set<any>(["main", "master"]);
const ZERO_OID: any = "0".repeat(40);
const DIRECT_UPSTREAM: Readonly<Record<string, any>> = Object.freeze({ stable: "nightly", release: "stable" });

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

function resolveBranch(branch?: any) : any {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    try {
      return git(["rev-parse", "--verify", `${ref}^{commit}`]);
    } catch {
      // Try the canonical local fallback.
    }
  }
  return "";
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
  branchTip = resolveBranch,
  ancestor = isAncestor
}: Record<string, any> = {}) : any {
  if (!LONG_LIVED.has(branch)) return { ok: false, code: "protected-branch-invalid" };
  if (!before || !after || before === ZERO_OID || after === ZERO_OID) {
    return { ok: false, code: "protected-branch-bootstrap-forbidden" };
  }
  if (!ancestor(before, after)) {
    return { ok: false, code: "protected-branch-not-fast-forward" };
  }
  if (branch === "nightly") {
    return { ok: true, code: "direct-nightly-advance" };
  }
  const upstream: any = DIRECT_UPSTREAM[branch];
  const tip: any = branchTip(upstream);
  if (!tip) return { ok: false, code: "promotion-source-missing" };
  return after === tip
    ? { ok: true, code: `${upstream}-fast-forward-advanced-${branch}` }
    : { ok: false, code: "promotion-source-tip-mismatch" };
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
  const topologyCases: any[] = [
    ["nightly direct commit", true, "nightly", "old-nightly", "nightly-tip", true,
      { nightly: "nightly-tip", stable: "old-stable", release: "old-release" }],
    ["nightly multi-commit advance", true, "nightly", "old-nightly", "nightly-tip", true,
      { nightly: "nightly-tip", stable: "old-stable", release: "old-release" }],
    ["stable exact upstream fast-forward", true, "stable", "old-stable", "nightly-tip", true,
      { nightly: "nightly-tip", stable: "nightly-tip", release: "old-release" }],
    ["release exact upstream fast-forward", true, "release", "old-release", "stable-tip", true,
      { nightly: "nightly-tip", stable: "stable-tip", release: "stable-tip" }],
    ["stable wrong source", false, "stable", "old-stable", "feature-tip", true,
      { nightly: "nightly-tip", stable: "feature-tip", release: "old-release" }],
    ["release wrong source", false, "release", "old-release", "nightly-tip", true,
      { nightly: "nightly-tip", stable: "stable-tip", release: "nightly-tip" }],
    ["nightly force update", false, "nightly", "old-nightly", "nightly-tip", false,
      { nightly: "nightly-tip", stable: "old-stable", release: "old-release" }],
    ["stable non-fast-forward", false, "stable", "old-stable", "nightly-tip", false,
      { nightly: "nightly-tip", stable: "nightly-tip", release: "old-release" }],
    ["release non-fast-forward", false, "release", "old-release", "stable-tip", false,
      { nightly: "nightly-tip", stable: "stable-tip", release: "stable-tip" }]
  ];
  for (const [label, expected, branch, before, after, isFastForward, branchTips] of topologyCases) {
    const result: any = verifyProtectedPushTopology({
      branch,
      before,
      after,
      branchTip: (name?: any) : any => branchTips[name] || "",
      ancestor: () : any => isFastForward
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

function verifyCurrentEvent() : any {
  const payload: any = readPayload(process.env.GITHUB_EVENT_PATH);
  const result: any = evaluateBranchFlow({
    eventName: process.env.GITHUB_EVENT_NAME || "",
    refName: process.env.GITHUB_REF_NAME || "",
    baseRef: process.env.GITHUB_BASE_REF || "",
    headRef: process.env.GITHUB_HEAD_REF || "",
    payload
  });
  console[result.ok ? "log" : "error"](`[branch-flow] ${result.code}`);
  if (!result.ok) {
    process.exitCode = 1;
    return;
  }
  if (process.env.GITHUB_EVENT_NAME === "push") {
    const topology: any = verifyProtectedPushTopology({
      branch: process.env.GITHUB_REF_NAME || "",
      before: payload.before || "",
      after: payload.after || process.env.GITHUB_SHA || ""
    });
    console[topology.ok ? "log" : "error"](`[branch-flow] ${topology.code}`);
    if (!topology.ok) process.exitCode = 1;
  }
}

function main(argv?: any) : any {
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
    main(process.argv.slice(2));
  } catch (error: any) {
    console.error(`[branch-flow] ${error?.code || "verification-failed"}`);
    process.exitCode = 1;
  }
}
