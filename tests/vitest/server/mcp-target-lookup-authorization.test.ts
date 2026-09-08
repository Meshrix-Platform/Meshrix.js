import { describe, expect, it, vi } from "vitest";

import { resolveVisibleUpstreamMcpTool } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-upstream.ts";

function serviceB() : any {
  return {
    serviceId: "service-b",
    serviceProtocol: "mcp",
    mcp: { toolNamePrefix: "service-b" }
  };
}

function toolB() : any {
  return {
    name: "upstream.service-b.records.list",
    _meta: {
      upstreamMcp: true,
      serviceId: "service-b",
      requiredCapabilities: ["cap:upstream:service-b:tools-call-records-list"],
      requiredScopes: ["gateway:read"],
      risk: "read_only",
      toolsets: ["upstream-mcp"],
      dynamicCapability: {
        capabilityId: "cap:upstream:service-b:tools-call-records-list",
        credentialBindingIds: []
      }
    }
  };
}

describe("MCP target lookup authorization", () : any => {
  it("applies grant allowedServiceIds before refreshing service B", async () : Promise<any> => {
    const resolveMcpToolByPublicName: any = vi.fn(async () : Promise<any> => toolB());
    const tool: any = await resolveVisibleUpstreamMcpTool({
      toolName: "upstream.service-b.records.list",
      authorization: {
        grant: {
          id: "grant-a",
          scopes: ["gateway:read"],
          dynamicCapabilities: ["cap:upstream:service-b:tools-call-records-list"],
          allowedServiceIds: ["service-a"],
          maxRisk: "read_only"
        }
      },
      upstreamGatewayRegistry: {
        getMcpServiceForPublicToolName: vi.fn(() : any => serviceB()),
        resolveMcpToolByPublicName
      }
    });
    expect(tool).toBeNull();
    expect(resolveMcpToolByPublicName).not.toHaveBeenCalled();
  });

  it("applies scoped API key allowedServiceIds before refreshing service B", async () : Promise<any> => {
    const resolveMcpToolByPublicName: any = vi.fn(async () : Promise<any> => toolB());
    const tool: any = await resolveVisibleUpstreamMcpTool({
      toolName: "upstream.service-b.records.list",
      authorization: {
        credentialKind: "scoped_api_key",
        subject: {
          type: "scoped-api-key",
          subjectId: "workload-1",
          grantId: "key-1"
        },
        restriction: {
          scopes: ["gateway:read"],
          capabilities: ["cap:upstream:service-b:tools-call-records-list"],
          dynamicCapabilities: ["cap:upstream:service-b:tools-call-records-list"],
          allowedServiceIds: ["service-a"],
          maxRisk: "read_only"
        }
      },
      upstreamGatewayRegistry: {
        getMcpServiceForPublicToolName: vi.fn(() : any => serviceB()),
        resolveMcpToolByPublicName
      }
    });
    expect(tool).toBeNull();
    expect(resolveMcpToolByPublicName).not.toHaveBeenCalled();
  });

  it("resolves an allowed service after the discovery gate without cloning a catalog", async () : Promise<any> => {
    const resolveMcpToolByPublicName: any = vi.fn(async () : Promise<any> => toolB());
    const listMcpTools: any = vi.fn();
    const tool: any = await resolveVisibleUpstreamMcpTool({
      toolName: "upstream.service-b.records.list",
      authorization: {
        grant: {
          id: "grant-b",
          scopes: ["gateway:read"],
          dynamicCapabilities: ["cap:upstream:service-b:tools-call-records-list"],
          allowedServiceIds: ["service-b"],
          maxRisk: "read_only"
        }
      },
      upstreamGatewayRegistry: {
        getMcpServiceForPublicToolName: vi.fn(() : any => serviceB()),
        resolveMcpToolByPublicName,
        listMcpTools
      }
    });
    expect(tool?.name).toBe("upstream.service-b.records.list");
    expect(resolveMcpToolByPublicName).toHaveBeenCalledOnce();
    expect(listMcpTools).not.toHaveBeenCalled();
  });
});
