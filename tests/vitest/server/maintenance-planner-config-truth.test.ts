import { describe, expect, it, vi } from "vitest";

import { createMaintenancePlanner } from "#meshrix/agents/maintenance/planner";

function createToolRegistry() : any {
  const tools: any = [
    "system.health",
    "runtime.info",
    "storage.summary",
    "jobs.list"
  ].map((id?: any) : any => ({
    id,
    risk: "read_only",
    scopes: [],
    timeoutMs: 1000,
    inputSchema: {}
  }));
  const byId: any = new Map<any, any>(tools.map((tool?: any) : any => [tool.id, tool]));
  return {
    getTool: (id?: any) : any => byId.get(id) || null,
    listTools: () : any => tools
  };
}

describe("maintenance planner configuration truth", () : any => {
  it("keeps a missing context profile empty and preserves an explicit profile", async () : Promise<any> => {
    const runCompaction: any = vi.fn(async () : Promise<any> => ({ compacted: false }));
    const planner: any = createMaintenancePlanner({
      userDataPath: "<user-data>",
      toolRegistry: createToolRegistry(),
      contextRuntime: { runCompaction }
    });
    const input: Record<string, any> = {
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
