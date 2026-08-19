import { describe, expect, it } from "vitest";

import {
  mcpGatewayLoadPhaseShouldIssueNext,
  runMcpGatewayLoadPhase
} from "../../../tools/server-scripts/lib/mcp-gateway-load-phase.ts";

describe("MCP gateway load phase issuance", () : void => {
  it("keeps issuing until the requested count even after a wall-clock window that would have truncated dual-gateway work", () : void => {
    expect(mcpGatewayLoadPhaseShouldIssueNext({
      issued: 82,
      requestTarget: 120,
      safetyTriggered: false
    })).toBe(true);
    expect(mcpGatewayLoadPhaseShouldIssueNext({
      issued: 120,
      requestTarget: 120,
      safetyTriggered: false
    })).toBe(false);
    expect(mcpGatewayLoadPhaseShouldIssueNext({
      issued: 10,
      requestTarget: 120,
      safetyTriggered: true
    })).toBe(false);
  });

  it("completes the requested count when each call is slower than a short observation window", async () : Promise<void> => {
    let issued = 0;
    const phase: any = await runMcpGatewayLoadPhase({
      name: "slow-dual-gateway-forward",
      requestTarget: 8,
      concurrency: 2,
      safetyCheck: () : Record<string, any> => ({ triggered: false, reason: "" }),
      invoke: async () : Promise<Record<string, any>> => {
        issued += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { status: 200, payload: { result: { ok: true } } };
      }
    });
    expect(issued).toBe(8);
    expect(phase.completed).toBe(8);
    expect(phase.ok).toBe(8);
    expect(phase.failed).toBe(0);
    expect(phase.durationMs).toBeGreaterThan(40);
  });
});
