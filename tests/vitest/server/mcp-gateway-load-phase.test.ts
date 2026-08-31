import { describe, expect, it } from "vitest";

import {
  MCP_GATEWAY_LOAD_FIXTURE_OPERATION_TIMEOUT_MS,
  mcpGatewayLoadPhaseShouldIssueNext,
  runMcpGatewayLoadPhase
} from "../../../tools/server-scripts/lib/mcp-gateway-load-phase.ts";

describe("MCP gateway load phase issuance", () : void => {
  it("declares a stable fixture operation deadline independently from the product default", () : void => {
    expect(MCP_GATEWAY_LOAD_FIXTURE_OPERATION_TIMEOUT_MS).toBe(30_000);
  });

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
    expect(phase.failureClassifications).toEqual([]);
    expect(phase.durationMs).toBeGreaterThan(40);
  });

  it("retains bounded status and reason classifications without response payloads", async () : Promise<void> => {
    const responses: any[] = [
      { status: 200, payload: { error: { data: { code: "tool_call_failed", status: 504 } } } },
      { status: 200, payload: { error: { data: { code: "tool_call_failed", status: 504 } } } },
      { status: 429, payload: { error: { data: { code: "api_key_rate_limited", status: 429 } } } }
    ];
    const phase: any = await runMcpGatewayLoadPhase({
      name: "classified-failures",
      requestTarget: responses.length,
      concurrency: 1,
      safetyCheck: () : Record<string, any> => ({ triggered: false, reason: "" }),
      invoke: async () : Promise<any> => responses.shift()
    });

    expect(phase.failed).toBe(3);
    expect(phase.firstErrorCode).toBe("tool_call_failed");
    expect(phase.failureClassifications).toEqual([
      { code: "api_key_rate_limited", status: 429, count: 1 },
      { code: "tool_call_failed", status: 504, count: 2 }
    ]);
    expect(JSON.stringify(phase.failureClassifications)).not.toContain("payload");
  });
});
