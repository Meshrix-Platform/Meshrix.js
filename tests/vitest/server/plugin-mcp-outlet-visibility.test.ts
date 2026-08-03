import { describe, expect, it, vi } from "vitest";

import { createCapturedResponse } from "../../../packages/server-runtime/src/composition/dispatch-operation-captured-response.ts";
import { handleMeshrixMcpHttpRequest } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter.ts";

function responsePayload(response?: any) : any {
  return JSON.parse(Buffer.concat(response.chunks).toString("utf8"));
}

async function mcpRequest(provider?: any, body?: any, headers: Record<string, any> = {}) : Promise<any> {
  const response: any = createCapturedResponse();
  await handleMeshrixMcpHttpRequest({
    request: { headers: { authorization: "Bearer fixture", ...headers }, socket: {} },
    response,
    requestBody: Buffer.from(JSON.stringify(body)),
    method: "POST",
    url: new URL("http://127.0.0.1/mcp"),
    toolSkillManagementProvider: provider
  });
  return { response, payload: responsePayload(response) };
}

function provider(visibleTools: any = []) : any {
  return {
    authorizeMcpClientRequest: vi.fn(async () : Promise<any> => ({ ok: true, grant: { id: "fixture", subject: {} } })),
    listVisibleTools: vi.fn(() : any => visibleTools),
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
  it("authenticates one signed HTTP batch once before handling its messages", async () : Promise<any> => {
    const runtime: any = provider([]);
    runtime.authorizeMcpClientRequest
      .mockResolvedValueOnce({ ok: true, grant: { id: "fixture", subject: {} } })
      .mockResolvedValue({ ok: false, status: 401, reasonCode: "process_identity_nonce_replay" });

    const { response, payload } = await mcpRequest(runtime, [
      { jsonrpc: "2.0", id: 101, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 102, method: "tools/list", params: {} }
    ]);

    expect(response.statusCode).toBe(200);
    expect(payload).toHaveLength(2);
    expect(payload.every((entry?: any) : any => Array.isArray(entry.result?.tools))).toBe(true);
    expect(runtime.authorizeMcpClientRequest).toHaveBeenCalledTimes(1);
    expect(runtime.authorizeMcpClientRequest).toHaveBeenCalledWith(expect.objectContaining({ recordUse: false }));
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
      mcpOutletDescriptor: SAMPLE_OUTLET_DESCRIPTOR
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
      "X-Meshrix-Delegated-Mcp-Grant-Id": "delegated-grant-1",
      "X-Meshrix-Delegated-Session-Id": delegation.sessionId,
      "X-Meshrix-Delegated-Turn-Id": delegation.turnId,
      "X-Meshrix-Delegated-Subject-Id": delegation.subjectId,
      "X-Meshrix-Delegated-Target-Id": delegation.targetId,
      "X-Meshrix-Delegated-Workspace-Id": delegation.workspaceId,
      "X-Meshrix-Delegated-Parent-Operation-Id": delegation.parentOperationId,
      "X-Meshrix-Delegated-Trace-Id": delegation.traceId
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
      "X-Meshrix-Delegated-Subject-Id": "different-subject"
    });
    expect(mismatch.payload.error.data).toEqual({
      code: "delegated_child_operation_binding_mismatch",
      requestBindingMismatches: ["delegatedSubjectId"],
      missingRequestBindings: []
    });
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });
});
