#!/usr/bin/env node
/**
 * Branch-flow verifier for CI.
 *
 * Rules:
 *   - Push workflows run only for protected long-lived branches.
 *   - PRs to nightly come from a repository-owned temporary branch.
 *   - PRs to stable come from nightly in the same repository.
 *   - PRs to release come from stable in the same repository.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const LONG_LIVED_BRANCHES = Object.freeze(["nightly", "stable", "release"]);
const longLivedBranchSet = new Set(LONG_LIVED_BRANCHES);
const ZERO_OID = "0".repeat(40);
const DIRECT_UPSTREAM = Object.freeze({
  stable: "nightly",
  release: "stable"
});

function repositoryIdentity(payload) {
  return {
    base: payload?.repository?.full_name || "",
    head: payload?.pull_request?.head?.repo?.full_name || ""
  };
}

function pullRequestHeadIsSameRepository(payload) {
  const identity = repositoryIdentity(payload);
  if (!identity.base || !identity.head) return true;
  return identity.base === identity.head;
}

export function evaluateBranchFlow({
  eventName = "",
  refName = "",
  baseRef = "",
  headRef = "",
  payload = {}
} = {}) {
  if (eventName === "push") {
    if (!longLivedBranchSet.has(refName)) {
      return {
        ok: false,
        message: `push workflow is only expected on ${LONG_LIVED_BRANCHES.join(", ")}; received ${refName || "unknown ref"}.`
      };
    }
    return {
      ok: true,
      message: `protected branch push event accepted for ${refName}; repository rulesets enforce PR updates.`
    };
  }

  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const resolvedBaseRef = baseRef || payload.pull_request?.base?.ref || "";
    const resolvedHeadRef = headRef || payload.pull_request?.head?.ref || "";
    if (resolvedBaseRef === "nightly" && !pullRequestHeadIsSameRepository(payload)) {
      return { ok: false, message: "nightly may only be updated from repository-owned temporary branches." };
    }
    if (resolvedBaseRef === "nightly" && longLivedBranchSet.has(resolvedHeadRef)) {
      return {
        ok: false,
        message: `nightly may only be updated from a temporary branch; received ${resolvedHeadRef || "unknown head"}.`
      };
    }
    if (resolvedBaseRef === "stable" && resolvedHeadRef !== "nightly") {
      return {
        ok: false,
        message: `stable may only be updated by PRs from nightly; received ${resolvedHeadRef || "unknown head"}.`
      };
    }
    if (resolvedBaseRef === "stable" && !pullRequestHeadIsSameRepository(payload)) {
      return { ok: false, message: "stable may only be updated from the repository-owned nightly branch." };
    }
    if (resolvedBaseRef === "release" && resolvedHeadRef !== "stable") {
      return {
        ok: false,
        message: `release may only be updated by PRs from stable; received ${resolvedHeadRef || "unknown head"}.`
      };
    }
    if (resolvedBaseRef === "release" && !pullRequestHeadIsSameRepository(payload)) {
      return { ok: false, message: "release may only be updated from the repository-owned stable branch." };
    }
    if (resolvedBaseRef === "main") {
      return {
        ok: false,
        message: `main is not an active Meshrix long-lived branch; use ${LONG_LIVED_BRANCHES.join(", ")}.`
      };
    }
    if (resolvedBaseRef === "nightly") {
      return { ok: true, message: `PR to nightly accepted from ${resolvedHeadRef || "unknown head"}.` };
    }
    if (resolvedBaseRef === "stable" || resolvedBaseRef === "release") {
      return { ok: true, message: `PR ${resolvedHeadRef} -> ${resolvedBaseRef} accepted.` };
    }
    return {
      ok: true,
      message: `no branch-flow rule applies to PR base ${resolvedBaseRef || "unknown base"}.`
    };
  }

  return { ok: true, message: `no branch-flow rule applies to event ${eventName || "unknown"}.` };
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function commitParents(commit) {
  return git(["show", "-s", "--format=%P", commit]).split(/\s+/u).filter(Boolean);
}

function isAncestor(ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

function resolveRemoteBranch(branch) {
  for (const candidate of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    try {
      return git(["rev-parse", "--verify", `${candidate}^{commit}`]);
    } catch {
      // Try the next canonical local projection.
    }
  }
  return "";
}

export function verifyProtectedPushTopology({
  branch,
  before,
  after,
  parents = commitParents,
  resolveBranch = resolveRemoteBranch,
  ancestor = isAncestor
} = {}) {
  if (!longLivedBranchSet.has(branch)) {
    return { ok: false, message: `protected update expected; received ${branch || "unknown branch"}.` };
  }
  if (!before || !after || before === ZERO_OID || after === ZERO_OID) {
    return { ok: false, message: `${branch} must already exist and cannot be created or deleted by a push.` };
  }
  const afterParents = parents(after);
  if (afterParents.length !== 2 || afterParents[0] !== before) {
    return {
      ok: false,
      message: `${branch} must advance by exactly one merge commit whose first parent is the previous ${branch} tip.`
    };
  }
  const mergedHead = afterParents[1];
  if (branch === "nightly") {
    for (const protectedBranch of LONG_LIVED_BRANCHES) {
      const protectedTip = resolveBranch(protectedBranch);
      if (protectedTip && ancestor(mergedHead, protectedTip)) {
        return {
          ok: false,
          message: `nightly may only merge a temporary branch; the merged head belongs to ${protectedBranch}.`
        };
      }
    }
    return { ok: true, message: "nightly advanced by one temporary-branch merge." };
  }
  const upstream = DIRECT_UPSTREAM[branch];
  const upstreamTip = resolveBranch(upstream);
  if (!upstreamTip) {
    return { ok: false, message: `cannot verify the repository-owned ${upstream} tip.` };
  }
  if (!ancestor(mergedHead, upstreamTip)) {
    return { ok: false, message: `${branch} may only merge the repository-owned ${upstream} branch.` };
  }
  return { ok: true, message: `${branch} advanced from ${upstream}.` };
}

function readEventPayload(eventPath) {
  if (!eventPath) return {};
  try {
    return JSON.parse(fs.readFileSync(eventPath, "utf8"));
  } catch {
    return {};
  }
}

function sameRepositoryPullRequest(baseRef, headRef) {
  return {
    repository: { full_name: "example/meshrix" },
    pull_request: {
      base: { ref: baseRef },
      head: { ref: headRef, repo: { full_name: "example/meshrix" } }
    }
  };
}

export function runBranchFlowSelfTest() {
  const fixtures = [
    { label: "nightly push", expected: true, input: { eventName: "push", refName: "nightly" } },
    { label: "stable push", expected: true, input: { eventName: "push", refName: "stable" } },
    { label: "release push", expected: true, input: { eventName: "push", refName: "release" } },
    {
      label: "temporary branch to nightly",
      expected: true,
      input: {
        eventName: "pull_request",
        baseRef: "nightly",
        headRef: "feature/ci-policy",
        payload: sameRepositoryPullRequest("nightly", "feature/ci-policy")
      }
    },
    {
      label: "nightly to stable",
      expected: true,
      input: {
        eventName: "pull_request",
        baseRef: "stable",
        headRef: "nightly",
        payload: sameRepositoryPullRequest("stable", "nightly")
      }
    },
    {
      label: "stable to release",
      expected: true,
      input: {
        eventName: "pull_request",
        baseRef: "release",
        headRef: "stable",
        payload: sameRepositoryPullRequest("release", "stable")
      }
    },
    { label: "main push", expected: false, input: { eventName: "push", refName: "main" } },
    {
      label: "PR to inactive main",
      expected: false,
      input: { eventName: "pull_request", baseRef: "main", headRef: "feature/ci-policy" }
    },
    {
      label: "long-lived branch to nightly",
      expected: false,
      input: { eventName: "pull_request", baseRef: "nightly", headRef: "stable" }
    },
    {
      label: "temporary branch to stable",
      expected: false,
      input: { eventName: "pull_request", baseRef: "stable", headRef: "feature/ci-policy" }
    },
    {
      label: "nightly to release",
      expected: false,
      input: { eventName: "pull_request", baseRef: "release", headRef: "nightly" }
    },
    {
      label: "fork to nightly",
      expected: false,
      input: {
        eventName: "pull_request",
        baseRef: "nightly",
        headRef: "feature/ci-policy",
        payload: {
          repository: { full_name: "example/meshrix" },
          pull_request: {
            base: { ref: "nightly" },
            head: { ref: "feature/ci-policy", repo: { full_name: "fork/meshrix" } }
          }
        }
      }
    }
  ];

  for (const fixture of fixtures) {
    const result = evaluateBranchFlow(fixture.input);
    if (result.ok !== fixture.expected) {
      throw new Error(`branch-flow fixture failed: ${fixture.label}`);
    }
  }
  const tips = {
    nightly: "nightly-tip",
    stable: "stable-tip",
    release: "release-tip"
  };
  const graph = new Map([
    ["feature-tip", new Set()],
    ["nightly-source", new Set(["nightly-tip"])],
    ["stable-source", new Set(["stable-tip"])]
  ]);
  const topologyFixtures = [
    {
      label: "temporary merge advances nightly",
      expected: true,
      input: { branch: "nightly", before: "old-nightly", after: "new-nightly" },
      parents: () => ["old-nightly", "feature-tip"]
    },
    {
      label: "nightly merge advances stable",
      expected: true,
      input: { branch: "stable", before: "old-stable", after: "new-stable" },
      parents: () => ["old-stable", "nightly-source"]
    },
    {
      label: "stable merge advances release",
      expected: true,
      input: { branch: "release", before: "old-release", after: "new-release" },
      parents: () => ["old-release", "stable-source"]
    },
    {
      label: "direct commit cannot advance nightly",
      expected: false,
      input: { branch: "nightly", before: "old-nightly", after: "direct" },
      parents: () => ["old-nightly"]
    },
    {
      label: "temporary branch cannot advance stable",
      expected: false,
      input: { branch: "stable", before: "old-stable", after: "new-stable" },
      parents: () => ["old-stable", "feature-tip"]
    },
    {
      label: "nightly cannot advance release",
      expected: false,
      input: { branch: "release", before: "old-release", after: "new-release" },
      parents: () => ["old-release", "nightly-source"]
    }
  ];
  const resolveBranch = (branch) => tips[branch] || "";
  const ancestor = (candidate, tip) => candidate === tip || graph.get(candidate)?.has(tip) === true;
  for (const fixture of topologyFixtures) {
    const result = verifyProtectedPushTopology({
      ...fixture.input,
      parents: fixture.parents,
      resolveBranch,
      ancestor
    });
    if (result.ok !== fixture.expected) {
      throw new Error(`branch-topology fixture failed: ${fixture.label}`);
    }
  }
  return { fixtureCount: fixtures.length + topologyFixtures.length };
}

function verifyCurrentEvent() {
  const payload = readEventPayload(process.env.GITHUB_EVENT_PATH);
  const result = evaluateBranchFlow({
    eventName: process.env.GITHUB_EVENT_NAME || "",
    refName: process.env.GITHUB_REF_NAME || "",
    baseRef: process.env.GITHUB_BASE_REF || "",
    headRef: process.env.GITHUB_HEAD_REF || "",
    payload
  });
  const prefix = result.ok ? "" : "ERROR: ";
  const stream = result.ok ? console.log : console.error;
  stream(`[branch-flow] ${prefix}${result.message}`);
  if (!result.ok) process.exitCode = 1;
  if (result.ok && process.env.GITHUB_EVENT_NAME === "push") {
    const topology = verifyProtectedPushTopology({
      branch: process.env.GITHUB_REF_NAME || "",
      before: payload.before || "",
      after: payload.after || process.env.GITHUB_SHA || ""
    });
    const topologyStream = topology.ok ? console.log : console.error;
    topologyStream(`[branch-flow] ${topology.ok ? "" : "ERROR: "}${topology.message}`);
    if (!topology.ok) process.exitCode = 1;
  }
}

function main(argv) {
  if (argv.length === 0) {
    verifyCurrentEvent();
    return;
  }
  if (argv.length === 1 && argv[0] === "--self-test") {
    const result = runBranchFlowSelfTest();
    console.log(`[branch-flow] ${result.fixtureCount} policy fixtures passed.`);
    return;
  }
  throw new Error("Usage: verify-branch-flow.mjs [--self-test]");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[branch-flow] ${error instanceof Error ? error.message : "verification failed"}`);
    process.exitCode = 1;
  }
}
