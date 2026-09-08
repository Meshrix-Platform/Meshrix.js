import { describe, expect, it, vi } from "vitest";

import { executeUpstreamToolViaGatewayForward } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-upstream-tools.ts";

function authorization() : any {
  return {
    ok: true,
    grant: {
      id: "grant-1",
      subjectId: "subject-1"
    }
  };
}

async function forward(visibleTool?: any, payload?: any) : Promise<any> {
  return executeUpstreamToolViaGatewayForward({
    id: 1,
    toolName: visibleTool.name,
    visibleTool,
    params: { arguments: {} },
    request: { headers: {} },
    authorization: authorization(),
    toolSkillManagementProvider: {
      executeTool: vi.fn(async () : Promise<any> => ({ ok: true, status: 200, payload })),
      publicMcpToolPayload: vi.fn(async ({ payload: next }: Record<string, any>) : Promise<any> => next)
    }
  });
}

describe("configured and native MCP result projection", () : any => {
  it("keeps configured HTTP string, array, and content-shaped objects as business values", async () : Promise<any> => {
    const configured: any = {
      name: "upstream.http.echo",
      _meta: {
        serviceId: "http",
        operationKey: "echo",
        upstreamConfiguredOperation: true
      }
    };
    const stringResult: any = await forward(configured, "plain-text");
    expect(stringResult.result.structuredContent).toBe("plain-text");
    expect(JSON.parse(stringResult.result.content[0].text)).toBe("plain-text");

    const arrayResult: any = await forward(configured, ["alpha", "beta"]);
    expect(arrayResult.result.structuredContent).toEqual(["alpha", "beta"]);
    expect(JSON.parse(arrayResult.result.content[0].text)).toEqual(["alpha", "beta"]);

    const booleanResult: any = await forward(configured, false);
    expect(booleanResult.result.structuredContent).toBe(false);
    expect(JSON.parse(booleanResult.result.content[0].text)).toBe(false);

    const numberResult: any = await forward(configured, 0);
    expect(numberResult.result.structuredContent).toBe(0);
    expect(JSON.parse(numberResult.result.content[0].text)).toBe(0);

    const nullResult: any = await forward(configured, null);
    expect(nullResult.result.structuredContent).toBeNull();
    expect(JSON.parse(nullResult.result.content[0].text)).toBeNull();

    const owned: any = {
      content: [{ type: "text", text: "business" }],
      isError: false,
      toolExecutionId: "tool-exec-1",
      traceId: "trace-1"
    };
    const objectResult: any = await forward(configured, owned);
    expect(objectResult.result.structuredContent).toEqual({
      content: [{ type: "text", text: "business" }],
      isError: false
    });
    expect(objectResult.result._meta["io.meshrix/governance"]).toEqual({
      toolExecutionId: "tool-exec-1",
      traceId: "trace-1"
    });
    expect(owned).toEqual({
      content: [{ type: "text", text: "business" }],
      isError: false,
      toolExecutionId: "tool-exec-1",
      traceId: "trace-1"
    });
  });

  it("extracts native MCP content, isError, and structuredContent only at the MCP boundary", async () : Promise<any> => {
    const native: any = {
      name: "upstream.mcp.records.get",
      _meta: {
        serviceId: "mcp",
        upstreamMcp: true,
        upstreamToolName: "records.get"
      }
    };
    const result: any = await forward(native, {
      content: [{ type: "text", text: "native" }],
      isError: false,
      structuredContent: { id: 7 }
    });
    expect(result.result).toMatchObject({
      resultType: "complete",
      content: [{ type: "text", text: "native" }],
      isError: false,
      structuredContent: { id: 7 }
    });

    const variants: any = {
      content: [
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
        { type: "resource_link", name: "Synthetic", uri: "https://example.invalid/resource" },
        { type: "resource", resource: { uri: "https://example.invalid/embedded", text: "synthetic" } }
      ],
      isError: true,
      structuredContent: { code: "synthetic-error" },
      _meta: { "example.invalid/render": "synthetic" }
    };
    const nativeVariants: any = await forward(native, {
      protocolVersion: "upstream-fixture",
      ok: true,
      response: variants,
      auditId: "synthetic-proof"
    });
    expect(nativeVariants.result.content).toEqual(variants.content);
    expect(nativeVariants.result.isError).toBe(true);
    expect(nativeVariants.result.structuredContent).toEqual(variants.structuredContent);
    expect(nativeVariants.result._meta).toEqual(variants._meta);
    expect(nativeVariants.result).not.toHaveProperty("auditId");
  });
});
