import { describe, expect, it, vi } from "vitest";
import { executeUpstreamToolViaGatewayForward } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-upstream-tools.mjs";

describe("upstream artifact MCP projection", () => {
  it("passes opaque references as arguments and returns a resource_link", async () => {
    const executeTool = vi.fn(async () => ({
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
    const visibleTool = {
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
    const result = await executeUpstreamToolViaGatewayForward({
      id: 7,
      toolName: visibleTool.name,
      visibleTool,
      params: { arguments: { file: "upload:session01:0", targetFormat: "pdf" } },
      request: { headers: {} },
      authorization: { grant: { id: "grant-fixture", scopes: ["gateway:write"] } },
      toolSkillManagementProvider: {
        executeTool,
        publicMcpToolPayload: async ({ payload }) => payload
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
    expect(result.result.content).toEqual([{
      type: "resource_link",
      uri: "http://gateway.invalid/api/gateway/v1/artifacts/artifact_12345678",
      name: "converted.pdf",
      mimeType: "application/pdf",
      size: 42
    }]);
  });
});
