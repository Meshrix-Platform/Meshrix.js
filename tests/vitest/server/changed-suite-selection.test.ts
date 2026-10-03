import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeChangedSelection,
  isVerificationSensitivePath,
  selectChangedSuites,
  selectionIsUnverifiable,
  triggerPathMatches
} from "../../../tools/scripts/lib/changed-suite-selection.ts";

const SUITES = [
  { id: "gateway.task-001", triggerPaths: ["packages/gateway"] },
  { id: "foundation.state-machine", triggerPaths: ["packages/foundation/src/workflow"] },
  { id: "repo.unified-test-runner", triggerPaths: ["tests/vitest/server/unified-test-runner-execution.test.ts", "tools/scripts"] },
  { id: "security.secret-hygiene", triggerPaths: ["."] },
  { id: "legacy.undeclared" }
];

describe("change-driven suite selection", () => {
  it("matches a trigger path only at a path boundary", () => {
    expect(triggerPathMatches("packages/gateway", "packages/gateway/src/index.ts")).toBe(true);
    expect(triggerPathMatches("packages/gateway", "packages/gateway")).toBe(true);
    // A sibling directory with a shared string prefix must not match.
    expect(triggerPathMatches("packages/gateway", "packages/gateway-extra/src/index.ts")).toBe(false);
    expect(triggerPathMatches("./packages/gateway/", "packages\\gateway\\src\\index.ts")).toBe(true);
    expect(triggerPathMatches("docs/guide.md", "docs/guide.md")).toBe(true);
    expect(triggerPathMatches("docs/guide.md", "docs/guide.md.bak")).toBe(false);
  });

  it("selects only the suites that declare the changed paths", () => {
    const selection = selectChangedSuites({
      changedFiles: ["packages/gateway/src/route.ts"],
      suites: SUITES
    });
    expect(selection.selected.map((entry: any) : any => entry.id)).toEqual(["gateway.task-001"]);
    expect(selection.selected[0].matchedPaths).toEqual(["packages/gateway/src/route.ts"]);
    expect(selection.uncoveredSensitiveFiles).toEqual([]);
  });

  it("reports whole-repository suites instead of running them on every change", () => {
    const selection = selectChangedSuites({
      changedFiles: ["packages/gateway/src/route.ts"],
      suites: SUITES
    });
    expect(selection.wholeRepository).toEqual(["security.secret-hygiene"]);
    expect(selection.selected.map((entry: any) : any => entry.id)).not.toContain("security.secret-hygiene");
  });

  it("treats undeclared suites as invisible without failing", () => {
    const selection = selectChangedSuites({
      changedFiles: ["packages/gateway/src/route.ts"],
      suites: SUITES
    });
    expect(selection.unscoped).toEqual(["legacy.undeclared"]);
    expect(selectionIsUnverifiable(selection)).toBe(false);
  });

  it("reports a verification-sensitive change that no suite declares", () => {
    const selection = selectChangedSuites({
      changedFiles: ["packages/capabilities/src/plugin.ts"],
      suites: SUITES
    });
    expect(selection.selected).toEqual([]);
    expect(selection.uncoveredSensitiveFiles).toEqual(["packages/capabilities/src/plugin.ts"]);
    // Nothing ran and something needed to run: that claim must not pass silently.
    expect(selectionIsUnverifiable(selection)).toBe(true);
    expect(describeChangedSelection(selection)).toContain("UNCOVERED");
  });

  it("needs no run for a documentation-only change, and does not call it unverifiable", () => {
    const selection = selectChangedSuites({
      changedFiles: ["docs/RUNBOOK.md", "README.md", "docs/verification/note.md"],
      suites: SUITES
    });
    expect(selection.sensitiveFiles).toEqual([]);
    expect(selection.selected).toEqual([]);
    expect(selectionIsUnverifiable(selection)).toBe(false);
    expect(describeChangedSelection(selection)).toContain("need no suite run");
  });

  it("separates covered from uncovered files in a mixed change", () => {
    const selection = selectChangedSuites({
      changedFiles: ["tools/scripts/local-ci.ts", "packages/agents/src/session.ts", "docs/RUNBOOK.md"],
      suites: SUITES
    });
    expect(selection.selected.map((entry: any) : any => entry.id)).toEqual(["repo.unified-test-runner"]);
    expect(selection.uncoveredSensitiveFiles).toEqual(["packages/agents/src/session.ts"]);
    expect(selection.sensitiveFiles).toEqual(["packages/agents/src/session.ts", "tools/scripts/local-ci.ts"]);
    // Something was verified and something was not: warn loudly, but do not fail the run.
    expect(selectionIsUnverifiable(selection)).toBe(false);
    expect(describeChangedSelection(selection)).toContain("packages/agents/src/session.ts");
  });

  it("classifies which paths need verification at all", () => {
    for (const path of [
      "packages/foundation/src/index.ts",
      "apps/console/src/App.vue",
      "tools/scripts/local-ci.ts",
      "tests/vitest/server/x.test.ts",
      "package.json",
      "package-lock.json",
      "tsconfig.tests.json",
      "vitest.config.ts",
      ".github/workflows/ci.yml"
    ]) {
      expect(isVerificationSensitivePath(path), path).toBe(true);
    }
    for (const path of ["docs/RUNBOOK.md", "README.md", "content/notes.md", ".gitignore"]) {
      expect(isVerificationSensitivePath(path), path).toBe(false);
    }
  });
});

describe("declared trigger paths in the registry", () => {
  const repoRoot = path.resolve(".");
  const registry = JSON.parse(readFileSync(path.join(repoRoot, "tools/registry/tests.registry.json"), "utf8"));
  const declared = registry.suites.filter((suite: any) : any =>
    Array.isArray(suite.triggerPaths) && suite.triggerPaths.length > 0);

  it("declares only paths that exist, so a declaration cannot silently rot", () => {
    const missing: string[] = [];
    for (const suite of declared) {
      for (const trigger of suite.triggerPaths) {
        if (trigger === ".") continue;
        if (!existsSync(path.join(repoRoot, trigger))) missing.push(`${suite.id} -> ${trigger}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps every declaration inside the repository", () => {
    const escaping: string[] = [];
    for (const suite of declared) {
      for (const trigger of suite.triggerPaths) {
        if (trigger.startsWith("/") || path.isAbsolute(trigger) || trigger.split("/").includes("..")) {
          escaping.push(`${suite.id} -> ${trigger}`);
        }
      }
    }
    expect(escaping).toEqual([]);
  });
});
