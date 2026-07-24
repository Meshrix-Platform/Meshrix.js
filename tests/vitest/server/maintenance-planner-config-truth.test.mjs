import { describe, expect, it, vi } from "vitest";

import { createMaintenancePlanner } from "#meshrix/agents/maintenance/planner";

function createToolRegistry() {
  const tools = [
    "system.health",
    "runtime.info",
    "storage.summary",
    "jobs.list"
  ].map((id) => ({
    id,
    risk: "read_only",
    scopes: [],
    timeoutMs: 1000,
    inputSchema: {}
  }));
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  return {
    getTool: (id) => byId.get(id) || null,
    listTools: () => tools
  };
}

describe("maintenance planner configuration truth", () => {
  it("keeps a missing context profile empty and preserves an explicit profile", async () => {
    const runCompaction = vi.fn(async () => ({ compacted: false }));
    const planner = createMaintenancePlanner({
      userDataPath: "<user-data>",
      toolRegistry: createToolRegistry(),
      contextRuntime: { runCompaction }
    });
    const input = {
      runbook: "health_smoke",
      messages: [{ role: "user", content: "check health" }]
    };

    await planner.plan(input, {});
    await planner.plan(input, { contextProfileId: "configured-profile" });

    expect(runCompaction).toHaveBeenNthCalledWith(1, expect.objectContaining({
      contextProfileId: ""
    }));
    expect(runCompaction).toHaveBeenNthCalledWith(2, expect.objectContaining({
      contextProfileId: "configured-profile"
    }));
  });
});
