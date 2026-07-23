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
import { pathToFileURL } from "node:url";

export const LONG_LIVED_BRANCHES = Object.freeze(["nightly", "stable", "release"]);
const longLivedBranchSet = new Set(LONG_LIVED_BRANCHES);

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
        message: `main is not an active LicoMesh long-lived branch; use ${LONG_LIVED_BRANCHES.join(", ")}.`
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
    repository: { full_name: "example/licomesh" },
    pull_request: {
      base: { ref: baseRef },
      head: { ref: headRef, repo: { full_name: "example/licomesh" } }
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
          repository: { full_name: "example/licomesh" },
          pull_request: {
            base: { ref: "nightly" },
            head: { ref: "feature/ci-policy", repo: { full_name: "fork/licomesh" } }
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
  return { fixtureCount: fixtures.length };
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
