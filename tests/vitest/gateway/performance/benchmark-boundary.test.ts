import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../../../..");
describe("isolated benchmark entry prerequisites", () => {
  it("a missing explicit prefix fails before any network or report output", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "benchmark-entry-"));
    try {
      const scripts = join(scratch, "tools/server-scripts");
      await mkdir(scripts, { recursive: true });
      const file = join(scripts, "benchmark-gateway.ts");
      await copyFile(join(root, "tools/server-scripts/benchmark-gateway.ts"), file);
      const child = spawnSync(process.execPath, [file, "--evaluate", "--profile", "fixture"], {
        cwd: scratch, encoding: "utf8", timeout: 5000 });
      expect(child.status).toBe(1);
      expect(child.stderr).toContain("benchmark_tool_not_installed");
      expect(child.stdout).toBe("");
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
});
