import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const reportDirectory: any = path.join(repoRoot, "build", "test-reports");
const temporaryRoots: any[] = [];

function reportDirectorySnapshot() : any {
  if (!fs.existsSync(reportDirectory)) {
    return [];
  }
  return fs.readdirSync(reportDirectory).sort().map((name?: any) : any => {
    const stats: any = fs.statSync(path.join(reportDirectory, name));
    return [name, stats.size, stats.mtimeMs];
  });
}

afterEach(() : any => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("unified test runner dry-run", () : any => {
  it("selects canonical suites without creating or changing report files", () : any => {
    const temporaryRoot: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-test-runner-dry-run-"));
    temporaryRoots.push(temporaryRoot);
    const explicitReport: any = path.join(temporaryRoot, "report.json");
    const before: any = reportDirectorySnapshot();

    const result: any = spawnSync(process.execPath, [
      "tests/run.ts",
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

  it("prints the ordered regression phases and their parallel lanes", () : any => {
    const before: any = reportDirectorySnapshot();
    const result: any = spawnSync(process.execPath, [
      "tests/run.ts",
      "--profile",
      "core-public",
      "--dry-run"
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("phases=4 lanes=14");
    const phaseOffsets = ["environment", "functional", "interface", "platform"]
      .map((phase) => result.stdout.indexOf(`PHASE ${phase}:`));
    expect(phaseOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(phaseOffsets).toEqual([...phaseOffsets].sort((left, right) => left - right));
    expect(result.stdout).toContain(
      "LANES frontend, backend-build, backend-server-shard-a, backend-server-shard-b, backend-worker-thread, backend-unit, backend-contract"
    );
    expect(result.stdout).toContain("LANES services, plugins, agent-adapters");
    expect(result.stdout).toContain("Report: not written (dry-run)");
    expect(reportDirectorySnapshot()).toEqual(before);
  });
});
