import { describe, expect, it, vi } from "vitest";

import { createModernDownstreamAdapter } from "../../../../packages/protocols/mcp/modern-downstream/index.ts";
import { context, descriptor } from "../support.ts";

describe("modern MCP downstream cancellation", () => {
  it("[CASE-F02] passes the HTTP request signal into the single gateway invoke boundary", async () => {
    const controller = new AbortController();
    const invoke = vi.fn(async () => ({
      kind: "complete" as const,
      value: { content: [{ type: "text", text: "cancel-aware" }] }
    }));
    const gateway: any = {
      catalog: vi.fn(() => ({ items: [descriptor()] })),
      invoke
    };
    const adapter = createModernDownstreamAdapter({ gateway });

    const result = await adapter.handle({
      method: "POST",
      headers: { "content-type": "application/json", "mcp-method": "tools/call" },
      body: {
        jsonrpc: "2.0",
        id: "cancel-1",
        method: "tools/call",
        params: { name: "demo", arguments: {} }
      },
      context,
      signal: controller.signal
    });

    expect(result.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ routeRef: "route.demo", signal: controller.signal })
    );
  });
});
