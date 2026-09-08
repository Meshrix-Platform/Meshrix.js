import { describe, expect, it, vi } from "vitest";

import {
  decodeMcpHeaderValue,
  encodeMcpHeaderValue,
  evaluateMcpProtocolContract
} from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-protocol.ts";
import { handleMeshrixMcpHttpRequest } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter.ts";
import { mcpModernBody, mcpModernHeaders } from "../../helpers/mcp-downstream-request.ts";

function responseFixture() : any {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = { ...headers };
    },
    end(chunk: any = "") : any {
      this.body = String(chunk || "");
    }
  };
}

describe("MCP downstream protocol header contract (revision 2026-07-28)", () : any => {
  it("rejects unsafe raw header values even when they match the body", () : any => {
    expect(decodeMcpHeaderValue(" leading")).toMatchObject({ ok: false, reason: "malformed" });
    expect(decodeMcpHeaderValue("trailing ")).toMatchObject({ ok: false, reason: "malformed" });
    expect(decodeMcpHeaderValue("café")).toMatchObject({ ok: false, reason: "malformed" });
    expect(decodeMcpHeaderValue("name\nvalue")).toMatchObject({ ok: false, reason: "malformed" });
    const evaluated: any = evaluateMcpProtocolContract({
      request: {
        headers: {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": " leading"
        }
      },
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: " leading",
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {}
          }
        }
      }
    });
    expect(evaluated.ok).toBe(false);
    expect(evaluated.httpStatus).toBe(400);
    expect(evaluated.body.error.message).toBe("Mcp-Name header is malformed.");
  });

  it("rejects a true malformed Base64 sentinel and invalid UTF-8", () : any => {
    expect(decodeMcpHeaderValue("=?base64?!!!?=")).toMatchObject({ ok: false, reason: "malformed" });
    expect(decodeMcpHeaderValue("=?base64?abc?=")).toMatchObject({ ok: false, reason: "malformed" });
    expect(decodeMcpHeaderValue("=?base64?////?=")).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("uses generic mismatch text that does not echo the body name", () : any => {
    const evaluated: any = evaluateMcpProtocolContract({
      request: {
        headers: {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "resources/read",
          "mcp-name": "public"
        }
      },
      message: {
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: {
          uri: "secret://records?token=private-query",
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {}
          }
        }
      }
    });
    expect(evaluated.body.error.message).toBe("Mcp-Name header does not match the request body name.");
    expect(JSON.stringify(evaluated.body)).not.toContain("private-query");
  });

  it("accepts a Unicode tool name through the production adapter when Base64-encoded", async () : Promise<any> => {
    const name: any = "upstream.unicode-service.上游";
    const body: any = mcpModernBody({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name, arguments: {} }
    });
    const response: any = responseFixture();
    const visibleTool: Record<string, any> = {
      name,
      title: name,
      _meta: {
        upstreamMcp: true,
        serviceId: "unicode-service",
        requiredCapabilities: ["cap:upstream:unicode-service:tools-call"],
        requiredScopes: ["gateway:read"],
        risk: "read_only",
        toolsets: ["upstream-mcp"]
      }
    };
    await handleMeshrixMcpHttpRequest({
      request: {
        headers: {
          authorization: "Bearer test-token",
          ...mcpModernHeaders(body),
          "mcp-name": encodeMcpHeaderValue(name)
        },
        socket: { remoteAddress: "127.0.0.1" }
      },
      response,
      requestBody: Buffer.from(JSON.stringify(body)),
      method: "POST",
      url: new URL("http://127.0.0.1/mcp"),
      toolSkillManagementProvider: {
        authorizeMcpClientRequest: vi.fn(async () : Promise<any> => ({
          ok: true,
          grant: {
            id: "grant-unicode",
            subjectId: "subject-unicode",
            scopes: ["gateway:read"],
            toolsets: ["upstream-mcp"],
            dynamicCapabilities: ["cap:upstream:unicode-service:tools-call"],
            maxRisk: "read_only"
          }
        })),
        executeTool: vi.fn(async () : Promise<any> => ({
          ok: true,
          status: 200,
          payload: {
            result: {
              response: {
                content: [{ type: "text", text: "ok" }],
                structuredContent: { ok: true }
              }
            }
          }
        })),
        publicMcpToolPayload: vi.fn(async ({ payload }: Record<string, any>) : Promise<any> => payload)
      },
      upstreamGatewayRegistry: {
        getMcpServiceForPublicToolName: () : any => ({
          serviceId: "unicode-service",
          serviceProtocol: "mcp"
        }),
        resolveMcpToolByPublicName: async () : Promise<any> => visibleTool
      }
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result).toMatchObject({
      resultType: "complete",
      structuredContent: { ok: true }
    });
  });

  it("rejects a malformed Base64 Mcp-Name through the production adapter", async () : Promise<any> => {
    const body: any = mcpModernBody({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "upstream.fixture.echo", arguments: {} }
    });
    const response: any = responseFixture();
    await handleMeshrixMcpHttpRequest({
      request: {
        headers: {
          authorization: "Bearer test-token",
          ...mcpModernHeaders(body),
          "mcp-name": "=?base64?abc?="
        },
        socket: { remoteAddress: "127.0.0.1" }
      },
      response,
      requestBody: Buffer.from(JSON.stringify(body)),
      method: "POST",
      url: new URL("http://127.0.0.1/mcp"),
      toolSkillManagementProvider: {
        authorizeMcpClientRequest: vi.fn()
      }
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatchObject({
      code: -32020,
      message: "Mcp-Name header is malformed."
    });
    expect(response.body).not.toContain("upstream.fixture.echo");
  });
});
