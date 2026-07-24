import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const reportDirectory = path.join(repoRoot, "build", "test-reports");
const temporaryRoots = [];

function reportDirectorySnapshot() {
  if (!fs.existsSync(reportDirectory)) {
    return [];
  }
  return fs.readdirSync(reportDirectory).sort().map((name) => {
    const stats = fs.statSync(path.join(reportDirectory, name));
    return [name, stats.size, stats.mtimeMs];
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("unified test runner dry-run", () => {
  it("selects canonical suites without creating or changing report files", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-test-runner-dry-run-"));
    temporaryRoots.push(temporaryRoot);
    const explicitReport = path.join(temporaryRoot, "report.json");
    const before = reportDirectorySnapshot();

    const result = spawnSync(process.execPath, [
      "tests/run.mjs",
      "--suite",
      "domains.manifest",
      "--dry-run",
      "--report",
      explicitReport
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("profile=core-public");
    expect(result.stdout).toContain("Report: not written (dry-run)");
    expect(fs.existsSync(explicitReport)).toBe(false);
    expect(reportDirectorySnapshot()).toEqual(before);
  });
});
