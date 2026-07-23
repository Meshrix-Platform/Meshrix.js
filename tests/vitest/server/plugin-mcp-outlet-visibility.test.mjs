import { describe, expect, it, vi } from "vitest";

import { createCapturedResponse } from "../../../packages/server-runtime/src/composition/dispatch-operation-captured-response.mjs";
import { handleLicoMcpHttpRequest } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter.mjs";

function responsePayload(response) {
  return JSON.parse(Buffer.concat(response.chunks).toString("utf8"));
}

async function mcpRequest(provider, body, headers = {}) {
  const response = createCapturedResponse();
  await handleLicoMcpHttpRequest({
    request: { headers: { authorization: "Bearer fixture", ...headers }, socket: {} },
    response,
    requestBody: Buffer.from(JSON.stringify(body)),
    method: "POST",
    url: new URL("http://127.0.0.1/mcp"),
    toolSkillManagementProvider: provider
  });
  return { response, payload: responsePayload(response) };
}

function provider(visibleTools = []) {
  return {
    authorizeRequest: vi.fn(async () => ({ ok: true, grant: { id: "fixture", subject: {} } })),
    listVisibleTools: vi.fn(() => visibleTools),
    visibleGrantSummary: vi.fn(() => ({ id: "fixture" })),
    executeTool: vi.fn()
  };
}

const SAMPLE_OUTLET_DESCRIPTOR = Object.freeze({
  toolName: "lico.sample",
  title: "Sample plugin",
  description: "Fixture plugin outlet.",
  architectureCategory: "Sample extension",
  annotations: { readOnlyHint: false, destructiveHint: false }
});

describe("enabled plugin MCP outlets", () => {
  it("authenticates one signed HTTP batch once before handling its messages", async () => {
    const runtime = provider([]);
    runtime.authorizeRequest
      .mockResolvedValueOnce({ ok: true, grant: { id: "fixture", subject: {} } })
      .mockResolvedValue({ ok: false, status: 401, reasonCode: "process_identity_nonce_replay" });

    const { response, payload } = await mcpRequest(runtime, [
      { jsonrpc: "2.0", id: 101, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 102, method: "tools/list", params: {} }
    ]);

    expect(response.statusCode).toBe(200);
    expect(payload).toHaveLength(2);
    expect(payload.every((entry) => Array.isArray(entry.result?.tools))).toBe(true);
    expect(runtime.authorizeRequest).toHaveBeenCalledTimes(1);
    expect(runtime.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({ recordUse: false }));
  });

  it("omits disabled plugin outlets from tools/list", async () => {
    const runtime = provider([]);
    const { payload } = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    });
    expect(payload.result.tools.map((tool) => tool.name)).toEqual(["lico.discovery"]);

    const capabilities = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "lico.discovery",
        arguments: {
          apiVersion: "v0.0.1:mcp:interface-1",
          operation: "lico.capabilities.list",
          input: {}
        }
      }
    });
    expect(Object.keys(capabilities.payload.result.structuredContent.outlets)).toEqual([
      "lico.discovery"
    ]);
    expect(capabilities.payload.result.structuredContent.outlets).not.toHaveProperty("lico.sample");
  });

  it("rejects a disabled outlet before parsing or executing its operation", async () => {
    const runtime = provider([]);
    const { payload } = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lico.sample",
        arguments: { malformed: "not-an-operation-envelope" }
      }
    });
    expect(payload.error).toMatchObject({ code: -32601, data: { code: "method_not_found" } });
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });

  it("hides and denies unauthorized operations through the Operation Permission provider port", async () => {
    const unauthorized = provider([{
      id: "lico.sample.file.read",
      operationId: "sample_plugin.file.read",
      mcpOutlet: "lico.sample",
      mcpOutletDescriptor: SAMPLE_OUTLET_DESCRIPTOR
    }]);
    unauthorized.authorizeRequest.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Tag policy denied this grant.",
      reasonCode: "tag_policy_denied",
      deniedLayer: "tag_policy"
    });

    const listed = await mcpRequest(unauthorized, {
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

    const called = await mcpRequest(unauthorized, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "lico.sample",
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

  it("lists only Operation Permission visible tools and denies invisible calls", async () => {
    const runtime = provider([]);
    const listed = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/list",
      params: {}
    });
    expect(listed.payload.result.tools.map((tool) => tool.name)).toEqual(["lico.discovery"]);
    expect(listed.payload.result.tools.map((tool) => tool.name)).not.toContain("lico.sample");

    const denied = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: {
        name: "lico.sample",
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

  it("lists an explicitly bound outlet only while its tool is visible", async () => {
    const runtime = provider([{
      id: "lico.sample.file.read",
      operationId: "sample_plugin.file.read",
      mcpOutlet: "lico.sample",
      mcpOutletDescriptor: SAMPLE_OUTLET_DESCRIPTOR
    }]);
    const { payload } = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {}
    });
    expect(payload.result.tools.map((tool) => tool.name)).toEqual([
      "lico.discovery",
      "lico.sample"
    ]);
    expect(payload.result.tools[1]).toMatchObject({
      title: SAMPLE_OUTLET_DESCRIPTOR.title,
      description: SAMPLE_OUTLET_DESCRIPTOR.description,
      annotations: SAMPLE_OUTLET_DESCRIPTOR.annotations,
      _meta: { architectureCategory: "Sample extension", pluginContributed: true }
    });
  });

  it("binds delegated MCP execution context to authenticated child-operation metadata", async () => {
    const delegation = {
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
    const visibleTool = {
      id: "lico.sample.file.read",
      operationId: "sample_plugin.file.read",
      mcpOutlet: "lico.sample",
      mcpOutletDescriptor: SAMPLE_OUTLET_DESCRIPTOR
    };
    const runtime = provider([visibleTool]);
    runtime.authorizeRequest.mockResolvedValue({
      ok: true,
      grant: {
        id: "delegated-grant-1",
        type: "delegated-mcp-child",
        scopes: ["sample_plugin:read"],
        toolsets: ["lico.sample.read"],
        metadata: { delegatedMcp: delegation }
      }
    });
    runtime.resolveMcpWorkspaceInput = vi.fn(async ({ input }) => ({ input }));
    runtime.publicMcpToolPayload = vi.fn(async ({ payload }) => payload);
    runtime.executeTool.mockResolvedValue({ ok: true, status: 200, payload: { ok: true } });
    const headers = {
      "X-LicoMesh-Delegated-Mcp-Grant-Id": "delegated-grant-1",
      "X-LicoMesh-Delegated-Session-Id": delegation.sessionId,
      "X-LicoMesh-Delegated-Turn-Id": delegation.turnId,
      "X-LicoMesh-Delegated-Subject-Id": delegation.subjectId,
      "X-LicoMesh-Delegated-Target-Id": delegation.targetId,
      "X-LicoMesh-Delegated-Workspace-Id": delegation.workspaceId,
      "X-LicoMesh-Delegated-Parent-Operation-Id": delegation.parentOperationId,
      "X-LicoMesh-Delegated-Trace-Id": delegation.traceId
    };
    const { payload } = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "lico.sample",
        arguments: {
          apiVersion: "v0.0.1:mcp:interface-1",
          operation: visibleTool.id,
          workspaceId: "caller-workspace",
          input: {}
        }
      }
    }, headers);

    expect(payload.error).toBeUndefined();
    const context = runtime.executeTool.mock.calls[0][0].context;
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
    const mismatch = await mcpRequest(runtime, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "lico.sample",
        arguments: {
          apiVersion: "v0.0.1:mcp:interface-1",
          operation: visibleTool.id,
          input: {}
        }
      }
    }, {
      ...headers,
      "X-LicoMesh-Delegated-Subject-Id": "different-subject"
    });
    expect(mismatch.payload.error.data).toEqual({
      code: "delegated_child_operation_binding_mismatch",
      requestBindingMismatches: ["delegatedSubjectId"],
      missingRequestBindings: []
    });
    expect(runtime.executeTool).not.toHaveBeenCalled();
  });
});
