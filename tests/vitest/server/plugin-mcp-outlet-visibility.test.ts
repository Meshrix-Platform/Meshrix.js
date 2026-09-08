import { describe, expect, it, vi } from "vitest";

import { createCapturedResponse } from "../../../packages/server-runtime/src/composition/dispatch-operation-captured-response.ts";
import { handleMeshrixMcpHttpRequest } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter.ts";
import { mcpModernHttpRequest } from "../../helpers/mcp-downstream-request.ts";

function responsePayload(response?: any) : any {
  return JSON.parse(Buffer.concat(response.chunks).toString("utf8"));
}

async function mcpRequest(provider?: any, body?: any, headers: Record<string, any> = {}) : Promise<any> {
  const response: any = createCapturedResponse();
  const isBatch: any = Array.isArray(body);
  const wire: any = isBatch
    ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
    : mcpModernHttpRequest(body);
  await handleMeshrixMcpHttpRequest({
    request: { headers: { authorization: "Bearer fixture", ...wire.headers, ...headers }, socket: {} },
    response,
    requestBody: Buffer.from(wire.body),
    method: "POST",
    url: new URL("http://127.0.0.1/mcp"),
    toolSkillManagementProvider: provider,
    agentMcpGatewayPipeline: createFixturePipeline()
  });
  return { response, payload: responsePayload(response) };
}

function createFixturePipeline() : any {
  return {
    async execute({ executeOperation }: Record<string, any>) : Promise<any> {
      const operationOutput: any = await executeOperation({ applicationOutput: null });
      return { operationOutput, applicationOutput: null };
    }
  };
}

function provider(visibleTools: any = []) : any {
  return {
    authorizeMcpClientRequest: vi.fn(async () : Promise<any> => ({ ok: true, grant: { id: "fixture", subject: {} } })),
    listVisibleTools: vi.fn(() : any => visibleTools),
    resolveActiveTool: vi.fn(() : any => visibleTools[0] || null),
    visibleGrantSummary: vi.fn(() : any => ({ id: "fixture" })),
    executeTool: vi.fn()
  };
}

const SAMPLE_OUTLET_DESCRIPTOR: Readonly<Record<string, any>> = Object.freeze({
  toolName: "meshrix.sample",
  title: "Sample plugin",
  description: "Fixture plugin outlet.",
  architectureCategory: "Sample extension",
  annotations: { readOnlyHint: false, destructiveHint: false }
});

describe("enabled plugin MCP outlets", () : any => {
  it("rejects an HTTP JSON-RPC batch before authorization or execution", async () : Promise<any> => {
    const runtime: any = provider([]);
    const { response, payload } = await mcpRequest(runtime, [
      { jsonrpc: "2.0", id: 101, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 102, method: "tools/list", params: {} }
    ]);

    expect(response.statusCode).toBe(400);
    expect(payload.error).toMatchObject({
      code: -32600,
      message: "MCP Streamable HTTP accepts exactly one JSON-RPC request or notification per POST."
    });
    expect(runtime.authorizeMcpClientRequest).not.toHaveBeenCalled();
    expect(runtime.listVisibleTools).not.toHaveBeenCalled();
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });

  it("authenticates each ordinary tools/list request independently", async () : Promise<any> => {
    const runtime: any = provider([]);
    const first: any = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 101,
      method: "tools/list",
      params: {}
    });
    const second: any = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 102,
      method: "tools/list",
      params: {}
    });

    expect(first.response.statusCode).toBe(200);
    expect(second.response.statusCode).toBe(200);
    expect(first.payload.result).toMatchObject({ resultType: "complete", tools: expect.any(Array) });
    expect(second.payload.result).toMatchObject({ resultType: "complete", tools: expect.any(Array) });
    expect(runtime.authorizeMcpClientRequest).toHaveBeenCalledTimes(2);
  });

  it("omits disabled plugin outlets from tools/list", async () : Promise<any> => {
    const runtime: any = provider([]);
    const { payload } = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    });
    expect(payload.result.tools.map((tool?: any) : any => tool.name)).toEqual(["meshrix.discovery"]);

    const capabilities: any = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "meshrix.discovery",
        arguments: {
          apiVersion: "v0.0.1:mcp:interface-1",
          operation: "meshrix.capabilities.list",
          input: {}
        }
      }
    });
    expect(Object.keys(capabilities.payload.result.structuredContent.outlets)).toEqual([
      "meshrix.discovery"
    ]);
    expect(capabilities.payload.result.structuredContent.outlets).not.toHaveProperty("meshrix.sample");
  });

  it("rejects a disabled outlet before parsing or executing its operation", async () : Promise<any> => {
    const runtime: any = provider([]);
    const { payload } = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "meshrix.sample",
        arguments: { malformed: "not-an-operation-envelope" }
      }
    });
    expect(payload.error).toMatchObject({ code: -32601, data: { code: "method_not_found" } });
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });

  it("hides and denies unauthorized operations through the Operation Permission provider port", async () : Promise<any> => {
    const unauthorized: any = provider([{
      id: "meshrix.sample.file.read",
      operationId: "sample_plugin.file.read",
      mcpOutlet: "meshrix.sample",
      mcpOutletDescriptor: SAMPLE_OUTLET_DESCRIPTOR
    }]);
    unauthorized.authorizeMcpClientRequest.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Tag policy denied this grant.",
      reasonCode: "tag_policy_denied",
      deniedLayer: "tag_policy"
    });

    const listed: any = await mcpRequest(unauthorized, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/list",
      params: {}
    });
    expect(listed.response.statusCode).toBe(403);
    expect(listed.payload.error).toMatchObject({
      code: -32001,
      data: expect.objectContaining({ code: "tag_policy_denied" })
    });
    expect(unauthorized.listVisibleTools).not.toHaveBeenCalled();

    const called: any = await mcpRequest(unauthorized, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "meshrix.sample",
        arguments: {
          apiVersion: "v0.0.1:mcp:interface-1",
          operation: "sample_plugin.file.read",
          input: {}
        }
      }
    });
    expect(called.response.statusCode).toBe(403);
    expect(called.payload.error).toMatchObject({
      code: -32001,
      data: expect.objectContaining({ code: "tag_policy_denied" })
    });
    expect(unauthorized.executeTool).not.toHaveBeenCalled();
  });

  it("lists only Operation Permission visible tools and denies invisible calls", async () : Promise<any> => {
    const runtime: any = provider([]);
    const listed: any = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/list",
      params: {}
    });
    expect(listed.payload.result.tools.map((tool?: any) : any => tool.name)).toEqual(["meshrix.discovery"]);
    expect(listed.payload.result.tools.map((tool?: any) : any => tool.name)).not.toContain("meshrix.sample");

    const denied: any = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: {
        name: "meshrix.sample",
        arguments: {
          apiVersion: "v0.0.1:mcp:interface-1",
          operation: "sample_plugin.session.create",
          input: {}
        }
      }
    });
    expect(denied.payload.error).toMatchObject({ code: -32601, data: { code: "method_not_found" } });
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });

  it("lists an explicitly bound outlet only while its tool is visible", async () : Promise<any> => {
    const runtime: any = provider([{
      id: "meshrix.sample.file.read",
      operationId: "sample_plugin.file.read",
      mcpOutlet: "meshrix.sample",
      mcpOutletDescriptor: SAMPLE_OUTLET_DESCRIPTOR
    }]);
    const { payload } = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {}
    });
    expect(payload.result.tools.map((tool?: any) : any => tool.name)).toEqual([
      "meshrix.discovery",
      "meshrix.sample"
    ]);
    expect(payload.result.tools[1]).toMatchObject({
      title: SAMPLE_OUTLET_DESCRIPTOR.title,
      description: SAMPLE_OUTLET_DESCRIPTOR.description,
      annotations: SAMPLE_OUTLET_DESCRIPTOR.annotations,
      _meta: { architectureCategory: "Sample extension", pluginContributed: true }
    });
  });

  it("binds delegated MCP execution context to authenticated child-operation metadata", async () : Promise<any> => {
    const delegation: Record<string, any> = {
      issuer: "fixture-plugin",
      binding: "fixture-session",
      sessionId: "delegated-session-1",
      turnId: "delegated-turn-1",
      subjectId: "delegated-subject-1",
      targetId: "delegated-target-1",
      workspaceId: "delegated-workspace-1",
      parentOperationId: "fixture.prompt",
      traceId: "delegated-trace-1"
    };
    const visibleTool: Record<string, any> = {
      id: "meshrix.sample.file.read",
      operationId: "sample_plugin.file.read",
      mcpOutlet: "meshrix.sample",
      mcpOutletDescriptor: SAMPLE_OUTLET_DESCRIPTOR,
      trafficModel: "gateway_transit"
    };
    const runtime: any = provider([visibleTool]);
    runtime.authorizeMcpClientRequest.mockResolvedValue({
      ok: true,
      grant: {
        id: "delegated-grant-1",
        type: "delegated-mcp-child",
        scopes: ["sample_plugin:read"],
        toolsets: ["meshrix.sample.read"],
        metadata: { delegatedMcp: delegation }
      }
    });
    runtime.resolveMcpWorkspaceInput = vi.fn(async ({ input }: Record<string, any>) : Promise<any> => ({ input }));
    runtime.publicMcpToolPayload = vi.fn(async ({ payload }: Record<string, any>) : Promise<any> => payload);
    runtime.executeTool.mockResolvedValue({ ok: true, status: 200, payload: { ok: true } });
    const headers: Record<string, any> = {
      "X-Meshrix.js-Delegated-Mcp-Grant-Id": "delegated-grant-1",
      "X-Meshrix.js-Delegated-Session-Id": delegation.sessionId,
      "X-Meshrix.js-Delegated-Turn-Id": delegation.turnId,
      "X-Meshrix.js-Delegated-Subject-Id": delegation.subjectId,
      "X-Meshrix.js-Delegated-Target-Id": delegation.targetId,
      "X-Meshrix.js-Delegated-Workspace-Id": delegation.workspaceId,
      "X-Meshrix.js-Delegated-Parent-Operation-Id": delegation.parentOperationId,
      "X-Meshrix.js-Delegated-Trace-Id": delegation.traceId
    };
    const { payload } = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "meshrix.sample",
        arguments: {
          apiVersion: "v0.0.1:mcp:interface-1",
          operation: visibleTool.id,
          workspaceId: "caller-workspace",
          input: {}
        }
      }
    }, headers);

    expect(payload.error).toBeUndefined();
    const context: any = runtime.executeTool.mock.calls[0][0].context;
    expect(context.workspaceId).toBe(delegation.workspaceId);
    expect(context.traceId).toBe(delegation.traceId);
    expect(context).toMatchObject({
      delegatedMcpGrantId: "delegated-grant-1",
      delegatedSessionId: delegation.sessionId,
      delegatedTurnId: delegation.turnId,
      delegatedSubjectId: delegation.subjectId,
      delegatedTargetId: delegation.targetId,
      delegatedWorkspaceId: delegation.workspaceId,
      delegatedParentOperationId: delegation.parentOperationId,
      delegatedTraceId: delegation.traceId,
      delegatedChildOperation: {
        grantBindingVerified: true,
        missingRequestBindings: [],
        requestBindingMismatches: []
      }
    });

    runtime.executeTool.mockClear();
    const mismatch: any = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "meshrix.sample",
        arguments: {
          apiVersion: "v0.0.1:mcp:interface-1",
          operation: visibleTool.id,
          input: {}
        }
      }
    }, {
      ...headers,
      "X-Meshrix.js-Delegated-Subject-Id": "different-subject"
    });
    expect(mismatch.payload.error.data).toEqual({
      code: "delegated_child_operation_binding_mismatch",
      requestBindingMismatches: ["delegatedSubjectId"],
      missingRequestBindings: []
    });
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });
});
