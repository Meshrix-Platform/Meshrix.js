import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PLATFORM_ACCEPTANCE_COMMANDS } from "../../../tools/server-scripts/lib/platform-acceptance-command-catalog.ts";
import { PLATFORM_ACCEPTANCE_REPORT_WRITE_ALLOWLIST } from "../../../tools/server-scripts/lib/platform-acceptance-report-catalog.ts";
import { createReleaseCommandSchedule, selectReleaseCommandBatch } from "../../../tools/server-scripts/lib/release-command-dag-runner.ts";

describe("functional prerequisites for resource profiling", () => {
  const commands = PLATFORM_ACCEPTANCE_COMMANDS;
  const profiles = commands.filter((command) => command.acceptanceLayer === "profile");
  const functionalIds = ["console-admin-browser-visual", "upstream-mcp-gateway"];
  const completed = commands.filter((command) => command.acceptanceLayer !== "profile").map((command) => command.id);

  it("keeps one memory report owner and a cycle-free acceptance graph", async () => {
    const manifest = JSON.parse(await fs.readFile(new URL("../../../package.json", import.meta.url), "utf8"));
    const engineering = manifest.scripts["server:verify:resource-discipline"];
    expect(engineering).not.toContain("verify-runtime-memory-leaks");
    expect(engineering).not.toContain("upload-custody-workspace-materialization.test.ts");
    expect(createReleaseCommandSchedule(commands).valid).toBe(true);
    const report = "build/reports/runtime-resource-discipline.json";
    expect(commands.filter((command) => command.ownedReports.includes(report)).map((command) => command.id))
      .toEqual(["runtime-memory-profile"]);
    expect(PLATFORM_ACCEPTANCE_REPORT_WRITE_ALLOWLIST).not.toContain(report);
  });

  it.each(functionalIds)("does not dispatch profiling while %s is missing or failed", (functionalId) => {
    for (const failed of [false, true]) {
      expect(selectReleaseCommandBatch({
        pendingCommands: profiles,
        completedCommandIds: failed ? completed : completed.filter((id) => id !== functionalId),
        failedCommandIds: failed ? [functionalId] : [],
        maxParallel: 4,
      })).toEqual([]);
    }
  });

  it("dispatches each resource command once after successful functional producers", () => {
    const remaining = [...profiles];
    const finished = [...completed];
    const dispatched: string[] = [];
    while (remaining.length) {
      const batch = selectReleaseCommandBatch({ pendingCommands: remaining, completedCommandIds: finished, maxParallel: 4 });
      expect(batch.length).toBeGreaterThan(0);
      for (const command of batch) {
        dispatched.push(command.id);
        finished.push(command.id);
        remaining.splice(remaining.findIndex((entry) => entry.id === command.id), 1);
      }
    }
    expect(dispatched).toEqual(["runtime-memory-profile", "mcp-gateway-load", "gateway-platform-profile"]);
  });
});
