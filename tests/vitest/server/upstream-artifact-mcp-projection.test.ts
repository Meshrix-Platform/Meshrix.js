import { describe, expect, it, vi } from "vitest";
import { executeUpstreamToolViaGatewayForward } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-upstream-tools.ts";

describe("upstream artifact MCP projection", () : any => {
  it("passes opaque references as arguments and returns a resource_link", async () : Promise<any> => {
    const executeTool: any = vi.fn(async () : Promise<any> => ({
      ok: true,
      status: 200,
      payload: {
        result: {
          response: {
            artifact: {
              reference: "artifact:artifact_12345678",
              uri: "http://gateway.invalid/api/gateway/v1/artifacts/artifact_12345678",
              name: "converted.pdf",
              mediaType: "application/pdf",
              byteLength: 42,
              sha256: "a".repeat(64)
            }
          }
        }
      }
    }));
    const visibleTool: Record<string, any> = {
      name: "upstream.format-convert.convert",
      _meta: {
        upstreamConfiguredOperation: true,
        toolId: "upstream.format-convert.convert",
        serviceId: "format-convert",
        operationKey: "convert",
        method: "POST",
        requiredScopes: ["gateway:write"],
        risk: "safe_write",
        payloadTransport: {
          request: { mode: "artifact_multipart" },
          response: { mode: "artifact" }
        },
        dynamicCapability: { capabilityId: "cap:upstream:format-convert:convert" }
      }
    };
    const result: any = await executeUpstreamToolViaGatewayForward({
      id: 7,
      toolName: visibleTool.name,
      visibleTool,
      params: { arguments: { file: "upload:session01:0", targetFormat: "pdf" } },
      request: { headers: {} },
      authorization: { grant: { id: "grant-fixture", scopes: ["gateway:write"] } },
      toolSkillManagementProvider: {
        executeTool,
        publicMcpToolPayload: async ({ payload }: Record<string, any>) : Promise<any> => payload
      }
    });
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      input: {
        serviceId: "format-convert",
        operationKey: "convert",
        arguments: { file: "upload:session01:0", targetFormat: "pdf" }
      },
      context: expect.objectContaining({ transport: "mcp" })
    }));
    expect(result.result.content).toEqual([
      {
        type: "resource_link",
        uri: "http://gateway.invalid/api/gateway/v1/artifacts/artifact_12345678",
        name: "converted.pdf",
        mimeType: "application/pdf",
        size: 42
      },
      {
        type: "text",
        text: "Artifact ready: converted.pdf (application/pdf, 42 bytes). Fetch it with meshrix-mcp fetch --artifact artifact_12345678."
      }
    ]);
    const [resourceLink, textReceipt] = result.result.content;
    expect(resourceLink.type).toBe("resource_link");
    expect(textReceipt.text).toContain("converted.pdf");
    expect(textReceipt.text).toContain("application/pdf");
    expect(textReceipt.text).toContain("42");
    expect(textReceipt.text).not.toContain(resourceLink.uri);
    expect(textReceipt.text).not.toContain("http");
  });

  it("passes workspace references through as opaque arguments", async () : Promise<any> => {
    const executeTool: any = vi.fn(async () : Promise<any> => ({
      ok: true,
      status: 200,
      payload: { result: { response: {} } }
    }));
    const visibleTool: Record<string, any> = {
      name: "upstream.format-convert.convert",
      _meta: {
        upstreamConfiguredOperation: true,
        toolId: "upstream.format-convert.convert",
        serviceId: "format-convert",
        operationKey: "convert",
        method: "POST",
        requiredScopes: ["gateway:write"],
        risk: "safe_write",
        payloadTransport: {
          request: { mode: "artifact_multipart" },
          response: { mode: "artifact" }
        },
        dynamicCapability: { capabilityId: "cap:upstream:format-convert:convert" }
      }
    };
    const workspaceReference: any = "workspace:workspace_0123456789abcdef01234567:notes/source.txt";
    await executeUpstreamToolViaGatewayForward({
      id: 8,
      toolName: visibleTool.name,
      visibleTool,
      params: { arguments: { file: workspaceReference, targetFormat: "pdf" } },
      request: { headers: {} },
      authorization: { grant: { id: "grant-fixture", scopes: ["gateway:write"] } },
      toolSkillManagementProvider: {
        executeTool,
        publicMcpToolPayload: async ({ payload }: Record<string, any>) : Promise<any> => payload
      }
    });
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      input: {
        serviceId: "format-convert",
        operationKey: "convert",
        arguments: { file: workspaceReference, targetFormat: "pdf" }
      },
      context: expect.objectContaining({ transport: "mcp" })
    }));
  });
});
