import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.ts";
import {
  publicUpstreamMcpTool,
  publicUpstreamOperationTool
} from "../../../packages/agents/src/upstream-gateway/tool-projection.ts";
import { handleMeshrixMcpHttpRequest } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter.ts";

function projectedFixtureTool({ name, title, description = "", inputSchema = { type: "object" }, annotations = {} }: Record<string, any>) : any {
  return publicUpstreamMcpTool({
    service: {
      serviceId: "fixture-upstream",
      label: "Upstream Fixture",
      credentialRefs: [],
      mcp: { toolNamePrefix: "fixture-upstream" }
    },
    tool: { name, title, description, inputSchema, annotations }
  });
}

function stdioMcpFixtureScript() : any {
  return `
let buffer = "";
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
function handle(message) {
  if (!message || !message.method || message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "records.list", title: "List records", description: "List fixture records", inputSchema: { type: "object", properties: { owner: { type: "string" } } }, annotations: { readOnlyHint: true } }] } });
    return;
  }
  if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { structuredContent: { ok: true, name: message.params.name, arguments: message.params.arguments || {} }, content: [{ type: "text", text: "ok" }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
`;
}

function destructiveStdioMcpFixtureScript() : any {
  return `
let buffer = "";
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
function handle(message) {
  if (!message || !message.method || message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "records.purge", title: "Purge records", inputSchema: { type: "object", properties: { path: { type: "string" } } }, annotations: { destructiveHint: true } }] } });
    return;
  }
  if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { structuredContent: { executed: true } } });
    return;
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
`;
}

function environmentStdioMcpFixtureScript() : any {
  return `
let buffer = "";
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
function handle(message) {
  if (!message || !message.method || message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "environment.probe", title: "Probe isolated environment", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] } });
    return;
  }
  if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { structuredContent: {
      unrelatedServerEnvVisible: Boolean(process.env.MESHRIX_UPSTREAM_ENV_ISOLATION_SENTINEL),
      explicitlyAllowedEnvVisible: Boolean(process.env.MCP_ALLOWED_SENTINEL)
    } } });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
`;
}

function responsePolicyStdioMcpFixtureScript() : any {
  return `
let buffer = "";
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
function handle(message) {
  if (!message || !message.method || message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "records.filtered", title: "Filtered response", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "records.opaque", title: "Opaque response", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "records.fail", title: "Private failure", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }
    ] } });
    return;
  }
  if (message.method === "tools/call" && message.params.name === "records.fail") {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "private-upstream-error-marker" } });
    return;
  }
  if (message.method === "tools/call" && message.params.name === "records.opaque") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      content: [{ type: "text", text: "opaque-upstream-response-marker" }]
    } });
    return;
  }
  if (message.method === "tools/call") {
    const structuredContent = {
      ok: true,
      token: ["private", "token", "marker"].join("-"),
      nested: { visible: "public-value", privateValue: "private-field-marker" },
      omitted: "not-public"
    };
    send({ jsonrpc: "2.0", id: message.id, result: {
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }]
    } });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
`;
}

function discoveryFailureStdioMcpFixtureScript() : any {
  return `
let buffer = "";
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
function handle(message) {
  if (!message || !message.method || message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "private-discovery-error-marker" } });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
`;
}

function createResponse() : any {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(chunk: any = "") : any {
      this.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      this.ended = true;
    }
  };
}

async function callMcp({ body, provider, upstreamGatewayRegistry, signal = null }: Record<string, any>) : Promise<any> {
  const response: any = createResponse();
  const handled: any = await handleMeshrixMcpHttpRequest({
    request: {
      headers: { authorization: "Bearer test-token" },
      socket: { remoteAddress: "127.0.0.1" },
      __meshrixRequestId: "req-1"
    },
    response,
    requestBody: Buffer.from(JSON.stringify(body), "utf8"),
    method: "POST",
    url: new URL("/mcp", "http://127.0.0.1"),
    toolSkillManagementProvider: provider,
    upstreamGatewayRegistry,
    listenUrl: "http://127.0.0.1:7331",
    discoveryState: null,
    signal
  });
  return {
    handled,
    statusCode: response.statusCode,
    payload: JSON.parse(response.body)
  };
}

async function createRegistryForServices(services: any = []) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-mcp-test-"));
  const registry: any = createUpstreamGatewayRegistry({ userDataPath });
  installUpstreamRuntimeServices(registry, services);
  return {
    registry,
    cleanup: async () : Promise<any> => {
      await registry.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  };
}

describe("upstream MCP gateway bridge", () : any => {
  it("maps plugin external-service MCP list and call through the governed session", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-external-mcp-"));
    const listTools: any = vi.fn(async () : Promise<any> => ({
      tools: [{
        name: "repositories.get",
        title: "Read synthetic repository",
        inputSchema: { type: "object", additionalProperties: false },
        annotations: { readOnlyHint: true }
      }]
    }));
    const callTool: any = vi.fn(async (_config?: any, request?: any) : Promise<any> => ({
      result: {
        structuredContent: {
          ok: true,
          toolName: request.name,
          input: request.arguments
        }
      }
    }));
    const registry: any = createUpstreamGatewayRegistry({
      userDataPath: root,
      mcpSessionManager: {
        listTools,
        callTool,
        async retireScope() : Promise<any> { return { retired: 0 }; },
        async close() : Promise<any> {}
      }
    });
    installUpstreamRuntimeServices(registry, [{
      serviceId: "plugin-mcp-fixture",
      serviceProtocol: "mcp",
      mcp: {
        transport: "http",
        url: "https://example.invalid:443/mcp",
        toolNamePrefix: "plugin-mcp-fixture"
      },
      operations: [{
        operationKey: "demo.mcp.tools.list",
        requiredScopes: ["gateway:read"],
        risk: "read_only"
      }, {
        operationKey: "demo.mcp.tools.call",
        requiredScopes: ["gateway:read"],
        risk: "read_only"
      }]
    }]);
    const subject: Record<string, any> = { scopes: ["gateway:read"] };
    try {
      const listed: any = await registry.requestPluginExternalService({
        pluginId: "demo",
        operationId: "demo.mcp.tools.list",
        serviceRef: "plugin-mcp-fixture",
        operationRef: "demo.mcp.tools.list",
        governance: {
          authorizationContextDigest: "authorization-fixture",
          riskDecisionRef: "risk-fixture",
          policyRevision: "policy-fixture"
        },
        input: { protocolMethod: "tools/list" }
      }, { subject });
      expect(listed).toMatchObject({
        ok: true,
        status: 200,
        data: {
          count: 1,
          items: [expect.objectContaining({
            name: "upstream.plugin-mcp-fixture.repositories.get"
          })]
        }
      });

      const called: any = await registry.requestPluginExternalService({
        pluginId: "demo",
        operationId: "demo.mcp.tools.call",
        serviceRef: "plugin-mcp-fixture",
        operationRef: "demo.mcp.tools.call",
        governance: {
          authorizationContextDigest: "authorization-fixture",
          riskDecisionRef: "risk-fixture",
          policyRevision: "policy-fixture"
        },
        input: {
          protocolMethod: "tools/call",
          toolName: "repositories.get",
          arguments: { repository: "synthetic" }
        }
      }, { subject });
      expect(called).toMatchObject({
        ok: true,
        status: 200,
        data: {
          structuredContent: {
            ok: true,
            toolName: "repositories.get",
            input: { repository: "synthetic" }
          }
        },
        receiptRef: expect.any(String)
      });
      expect(listTools).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledTimes(1);
    } finally {
      await registry.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("propagates the HTTP parent signal into downstream MCP tool execution", async () : Promise<any> => {
    let observeExecution: any;
    let executionSignal: any = null;
    const executionStarted: any = new Promise((resolve?: any) : any => {
      observeExecution = resolve;
    });
    const visibleTool: any = projectedFixtureTool({
      name: "records.list",
      title: "List records",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true }
    });
    const provider: Record<string, any> = {
      authorizeMcpClientRequest: vi.fn(async () : Promise<any> => ({
        ok: true,
        grant: {
          id: "grant-1",
          scopes: ["gateway:read"],
          toolsets: ["upstream-mcp"],
          dynamicCapabilities: [visibleTool._meta.capabilityId],
          maxRisk: "read_only"
        }
      })),
      executeTool: vi.fn(async ({ signal }: Record<string, any>) : Promise<any> => {
        executionSignal = signal;
        observeExecution();
        if (!signal.aborted) {
          await new Promise((resolve?: any) : any => signal.addEventListener("abort", resolve, { once: true }));
        }
        return {
          ok: false,
          status: 499,
          payload: { error: { code: "tool_aborted", message: "Tool execution was cancelled." } }
        };
      }),
      publicMcpToolPayload: vi.fn(async ({ payload }: Record<string, any>) : Promise<any> => payload)
    };
    const upstreamGatewayRegistry: Record<string, any> = {
      listMcpTools: vi.fn(async () : Promise<any> => ({
        items: [visibleTool],
        count: 1
      }))
    };
    const controller: any = new AbortController();
    const pending: any = callMcp({
      provider,
      upstreamGatewayRegistry,
      signal: controller.signal,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "upstream.fixture-upstream.records.list", arguments: {} }
      }
    });

    await executionStarted;
    controller.abort(new Error("private request detail"));
    const result: any = await pending;

    expect(provider.executeTool).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.any(Object)
    }));
    expect(executionSignal).not.toBe(controller.signal);
    expect(executionSignal?.aborted).toBe(true);
    expect(result.payload.error.data).toMatchObject({ code: "tool_aborted", status: 499 });
  });

  it("discovers and calls a stdio upstream MCP service through the registry", async () : Promise<any> => {
    const { registry, cleanup } = await createRegistryForServices([{
      serviceId: "fixture-upstream",
      serviceProtocol: "mcp",
      label: "Upstream MCP fixture",
      mcp: {
        transport: "stdio",
        command: process.execPath,
        args: ["-e", stdioMcpFixtureScript()],
        toolNamePrefix: "fixture-upstream",
        timeoutMs: 5000
      }
    }]);

    try {
      const listed: any = await registry.listMcpTools();
      expect(listed.items).toEqual([
        expect.objectContaining({
          name: "upstream.fixture-upstream.records.list",
          inputSchema: expect.objectContaining({ type: "object" }),
          _meta: expect.objectContaining({
            upstreamMcp: true,
            serviceId: "fixture-upstream",
            upstreamToolName: "records.list",
            requiredScopes: ["gateway:read"]
          })
        })
      ]);

      const called: any = await registry.callMcpToolByPublicName(
        "upstream.fixture-upstream.records.list",
        { arguments: { owner: "sample-org" } },
        { scopes: ["gateway:read"] }
      );
      expect(called).toMatchObject({
        ok: true,
        serviceId: "fixture-upstream",
        upstream: {
          protocol: "mcp",
          toolName: "records.list"
        },
        response: {
          structuredContent: {
            ok: true,
            name: "records.list",
            arguments: { owner: "sample-org" }
          }
        }
      });
    } finally {
      await cleanup();
    }
  });

  it("passes only execution baseline and explicitly configured values to stdio upstream services", async () : Promise<any> => {
    const previousSentinel: any = process.env.MESHRIX_UPSTREAM_ENV_ISOLATION_SENTINEL;
    process.env.MESHRIX_UPSTREAM_ENV_ISOLATION_SENTINEL = "verifier-only-value";
    const { registry, cleanup } = await createRegistryForServices([{
      serviceId: "environment-fixture",
      serviceProtocol: "mcp",
      label: "Environment isolation fixture",
      mcp: {
        transport: "stdio",
        command: process.execPath,
        args: ["-e", environmentStdioMcpFixtureScript()],
        env: {
          MCP_ALLOWED_SENTINEL: "$MESHRIX_UPSTREAM_ENV_ISOLATION_SENTINEL"
        },
        toolNamePrefix: "environment-fixture",
        timeoutMs: 5000
      }
    }]);

    try {
      const called: any = await registry.callMcpToolByPublicName(
        "upstream.environment-fixture.environment.probe",
        { arguments: {} },
        { scopes: ["gateway:read"] }
      );
      expect(called.response.structuredContent).toEqual({
        unrelatedServerEnvVisible: false,
        explicitlyAllowedEnvVisible: true
      });
    } finally {
      await cleanup();
      if (previousSentinel === undefined) {
        delete process.env.MESHRIX_UPSTREAM_ENV_ISOLATION_SENTINEL;
      } else {
        process.env.MESHRIX_UPSTREAM_ENV_ISOLATION_SENTINEL = previousSentinel;
      }
    }
  });

  it("filters structured MCP responses and persists only safe failure evidence", async () : Promise<any> => {
    const privateMarkers: any[] = [
      "private-token-marker",
      "private-field-marker",
      "private-upstream-error-marker",
      "not-public"
    ];
    const { registry, cleanup } = await createRegistryForServices([{
      serviceId: "response-policy-fixture",
      serviceProtocol: "mcp",
      label: "Response policy fixture",
      mcp: {
        transport: "stdio",
        command: process.execPath,
        args: ["-e", responsePolicyStdioMcpFixtureScript()],
        toolNamePrefix: "response-policy-fixture",
        timeoutMs: 5000
      },
      operations: [{
        operationKey: "tools/call",
        risk: "read_only",
        requiredScopes: ["gateway:read"],
        sensitiveBodyFields: ["nested.privateValue"],
        publicResponseFields: ["ok", "nested.visible"],
        responseSchema: {
          type: "object",
          required: ["ok", "nested"],
          properties: {
            ok: { type: "boolean" },
            nested: { type: "object" }
          },
          additionalProperties: true
        }
      }]
    }]);

    try {
      const called: any = await registry.callMcpToolByPublicName(
        "upstream.response-policy-fixture.records.filtered",
        { arguments: {} },
        { scopes: ["gateway:read"] }
      );
      expect(called.response.structuredContent).toEqual({
        ok: true,
        nested: { visible: "public-value" }
      });
      expect(JSON.parse(called.response.content[0].text)).toEqual(called.response.structuredContent);
      for (const marker of privateMarkers) {
        expect(JSON.stringify(called)).not.toContain(marker);
      }

      await expect(registry.callMcpToolByPublicName(
        "upstream.response-policy-fixture.records.fail",
        { arguments: {} },
        { scopes: ["gateway:read"] }
      )).rejects.toMatchObject({
        message: "Upstream MCP forwarding failed.",
        reasonCode: "upstream_mcp_call_failed"
      });
      const audit: any = registry.listAudit({ limit: 20 });
      for (const marker of privateMarkers) {
        expect(JSON.stringify(audit)).not.toContain(marker);
      }
      expect(audit.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventType: "upstream.mcp.call.completed",
          payload: expect.objectContaining({
            responsePolicy: expect.objectContaining({
              schemaValidated: true,
              publicFieldCount: 2
            })
          })
        }),
        expect.objectContaining({
          eventType: "upstream.mcp.call.failed",
          payload: expect.objectContaining({
            reasonCode: "upstream_mcp_call_failed"
          })
        })
      ]));
    } finally {
      await cleanup();
    }
  });

  it("passes default MCP results through without implicit field redaction or reconstruction", async () : Promise<any> => {
    const { registry, cleanup } = await createRegistryForServices([{
      serviceId: "default-transparent-mcp",
      serviceProtocol: "mcp",
      label: "Default transparent MCP fixture",
      mcp: {
        transport: "stdio",
        command: process.execPath,
        args: ["-e", responsePolicyStdioMcpFixtureScript()],
        toolNamePrefix: "default-transparent-mcp",
        timeoutMs: 5000
      },
      operations: [{
        operationKey: "tools/call",
        risk: "read_only",
        requiredScopes: ["gateway:read"]
      }]
    }]);

    try {
      const called: any = await registry.callMcpToolByPublicName(
        "upstream.default-transparent-mcp.records.filtered",
        { arguments: {} },
        { scopes: ["gateway:read"] }
      );
      expect(called.response.structuredContent).toEqual({
        ok: true,
        token: "private-token-marker",
        nested: { visible: "public-value", privateValue: "private-field-marker" },
        omitted: "not-public"
      });
      expect(called.response.content).toEqual([{
        type: "text",
        text: JSON.stringify(called.response.structuredContent)
      }]);
    } finally {
      await cleanup();
    }
  });

  it("rejects opaque MCP text when response fields require filtering without a schema", async () : Promise<any> => {
    const privateMarker: any = "opaque-upstream-response-marker";
    const { registry, cleanup } = await createRegistryForServices([{
      serviceId: "opaque-response-policy-fixture",
      serviceProtocol: "mcp",
      label: "Opaque response policy fixture",
      mcp: {
        transport: "stdio",
        command: process.execPath,
        args: ["-e", responsePolicyStdioMcpFixtureScript()],
        toolNamePrefix: "opaque-response-policy-fixture",
        timeoutMs: 5000
      },
      operations: [{
        operationKey: "tools/call",
        risk: "read_only",
        requiredScopes: ["gateway:read"],
        sensitiveBodyFields: ["credential"]
      }]
    }]);

    try {
      await expect(registry.callMcpToolByPublicName(
        "upstream.opaque-response-policy-fixture.records.opaque",
        { arguments: {} },
        { scopes: ["gateway:read"] }
      )).rejects.toMatchObject({
        message: "Upstream MCP forwarding failed.",
        reasonCode: "response_projection_unavailable",
        status: 502
      });
      expect(JSON.stringify(registry.listAudit({ limit: 20 }))).not.toContain(privateMarker);
    } finally {
      await cleanup();
    }
  });

  it("does not expose raw MCP discovery failures through list or health surfaces", async () : Promise<any> => {
    const { registry, cleanup } = await createRegistryForServices([{
      serviceId: "discovery-failure-fixture",
      serviceProtocol: "mcp",
      label: "Discovery failure fixture",
      mcp: {
        transport: "stdio",
        command: process.execPath,
        args: ["-e", discoveryFailureStdioMcpFixtureScript()],
        toolNamePrefix: "discovery-failure-fixture",
        timeoutMs: 5000
      }
    }]);

    try {
      await expect(registry.listMcpTools()).rejects.toMatchObject({
        message: "Upstream MCP discovery failed.",
        reasonCode: "upstream_mcp_discovery_failed"
      });
      const health: any = await registry.health("discovery-failure-fixture");
      expect(health).toMatchObject({
        ok: false,
        error: "upstream_mcp_discovery_failed"
      });
      expect(JSON.stringify(health)).not.toContain("private-discovery-error-marker");
    } finally {
      await cleanup();
    }
  });

  it("maps upstream MCP destructive annotations into approval-gated risk", async () : Promise<any> => {
    const { registry, cleanup } = await createRegistryForServices([{
      serviceId: "fixture-upstream",
      serviceProtocol: "mcp",
      label: "Upstream MCP fixture",
      mcp: {
        transport: "stdio",
        command: process.execPath,
        args: ["-e", destructiveStdioMcpFixtureScript()],
        toolNamePrefix: "fixture-upstream",
        timeoutMs: 5000
      }
    }]);

    try {
      const listed: any = await registry.listMcpTools();
    expect(listed.items[0]).toMatchObject({
      name: "upstream.fixture-upstream.records.purge",
      annotations: {
        destructiveHint: true
      },
      _meta: {
        requiredScopes: ["gateway:write"],
        risk: "repair_write"
      }
    });

      const pending: any = await registry.callMcpToolByPublicName(
        "upstream.fixture-upstream.records.purge",
        { arguments: { path: "README.md" } },
        { scopes: ["gateway:write"] }
      );
      expect(pending).toMatchObject({
        status: "pending_approval",
        risk: "repair_write"
      });
    } finally {
      await cleanup();
    }
  });

  it("exposes visible upstream MCP tools through downstream tools/list and tools/call", async () : Promise<any> => {
    const visibleTool: any = projectedFixtureTool({
      name: "records.list",
      title: "List records",
      description: "List fixture records",
      inputSchema: { type: "object", properties: { owner: { type: "string" } } },
      annotations: { readOnlyHint: true }
    });
    const provider: Record<string, any> = {
      authorizeMcpClientRequest: vi.fn(async () : Promise<any> => ({
        ok: true,
        grant: {
          id: "grant-1",
          label: "OpenCode",
          scopes: ["gateway:read"],
          toolsets: ["upstream-mcp"],
          dynamicCapabilities: [visibleTool._meta.capabilityId],
          maxRisk: "read_only"
        }
      })),
      executeTool: vi.fn(async ({ toolId, input }: Record<string, any>) : Promise<any> => ({
        ok: true,
        status: 200,
        payload: {
          toolExecutionId: "tool-exec-1",
          traceId: "trace-1",
          result: {
            upstreamMcp: true,
            response: {
              structuredContent: {
                owner: input.arguments.owner,
                forwarded: toolId === "upstream.fixture-upstream.tools-call"
              }
            },
            auditId: "audit-1"
          }
        }
      })),
      publicMcpToolPayload: vi.fn(async ({ payload }: Record<string, any>) : Promise<any> => payload)
    };
    const upstreamGatewayRegistry: Record<string, any> = {
      listMcpTools: vi.fn(async () : Promise<any> => ({
        items: [visibleTool],
        count: 1
      }))
    };

    const listed: any = await callMcp({
      provider,
      upstreamGatewayRegistry,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
    });
    expect(listed.handled).toBe(true);
    expect(listed.statusCode).toBe(200);
    expect(listed.payload.result.tools.map((tool?: any) : any => tool.name)).toContain("upstream.fixture-upstream.records.list");

    const called: any = await callMcp({
      provider,
      upstreamGatewayRegistry,
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "upstream.fixture-upstream.records.list",
          arguments: { owner: "sample-org" }
        }
      }
    });
    expect(called.statusCode).toBe(200);
    expect(provider.executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolId: "upstream.fixture-upstream.tools-call",
      input: expect.objectContaining({
        serviceId: "fixture-upstream",
        operationKey: "tools/call",
        toolName: "records.list",
        arguments: { owner: "sample-org" }
      })
    }));
    expect(called.payload.result.structuredContent).toMatchObject({
      upstreamMcp: true,
      toolName: "upstream.fixture-upstream.records.list",
      operation: "upstream.fixture-upstream.tools-call",
      payload: {
        response: {
          structuredContent: {
            owner: "sample-org",
            forwarded: true
          }
        },
        auditId: "audit-1"
      },
      toolExecutionId: "tool-exec-1",
      traceId: "trace-1"
    });
  });

  it("does not contact MCP services outside the grant capability partition", async () : Promise<any> => {
    const listMcpTools: any = vi.fn(async () : Promise<any> => ({ items: [], count: 0 }));
    const provider: Record<string, any> = {
      authorizeMcpClientRequest: vi.fn(async () : Promise<any> => ({
        ok: true,
        grant: {
          id: "grant-denied-service",
          scopes: ["gateway:read"],
          toolsets: ["upstream-mcp"],
          dynamicCapabilities: ["cap:upstream:other-service:tools-call-records-list"],
          allowedServiceIds: ["other-service"],
          maxRisk: "read_only"
        }
      }))
    };
    const upstreamGatewayRegistry: Record<string, any> = {
      listServices: () : any => ({
        items: [{ serviceId: "fixture-upstream", serviceProtocol: "mcp" }],
        count: 1
      }),
      listMcpTools
    };

    const listed: any = await callMcp({
      provider,
      upstreamGatewayRegistry,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.payload.result.tools.map((tool?: any) : any => tool.name))
      .not.toContain("upstream.fixture-upstream.records.list");
    expect(listMcpTools).not.toHaveBeenCalled();
  });

  it("does not discover credential-bound MCP services without the binding grant", async () : Promise<any> => {
    const listMcpTools: any = vi.fn(async () : Promise<any> => ({ items: [], count: 0 }));
    const provider: Record<string, any> = {
      authorizeMcpClientRequest: vi.fn(async () : Promise<any> => ({
        ok: true,
        grant: {
          id: "grant-without-binding",
          scopes: ["gateway:read"],
          dynamicCapabilities: ["cap:upstream:fixture-upstream:tools-call-records-list"],
          allowedServiceIds: ["fixture-upstream"],
          allowedSecretBindings: []
        }
      }))
    };
    const upstreamGatewayRegistry: Record<string, any> = {
      listServices: () : any => ({
        items: [{
          serviceId: "fixture-upstream",
          serviceProtocol: "mcp",
          credentialBindingIds: ["credential:fixture-binding"]
        }],
        count: 1
      }),
      listMcpTools
    };

    const listed: any = await callMcp({
      provider,
      upstreamGatewayRegistry,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
    });

    expect(listed.statusCode).toBe(200);
    expect(listMcpTools).not.toHaveBeenCalled();
  });

  it("keeps direct upstream tools out of categorized outlet summaries", async () : Promise<any> => {
    const directTools: any[] = [
      projectedFixtureTool({
        name: "records.list",
        title: "List records",
        description: "List fixture records",
        inputSchema: { type: "object", properties: { owner: { type: "string" } } },
        annotations: { readOnlyHint: true }
      }),
      publicUpstreamOperationTool({
        service: {
          serviceId: "fixture-upstream",
          label: "Upstream Fixture",
          credentialRefs: []
        },
        operation: {
          operationKey: "echo",
          protocol: "http",
          method: "POST",
          requiredScopes: ["gateway:read"],
          risk: "read_only"
        }
      })
    ];
    const grant: Record<string, any> = {
      id: "grant-1",
      scopes: ["gateway:read"],
      toolsets: ["upstream-mcp", "upstream-gateway"],
      dynamicCapabilities: directTools.map((tool?: any) : any => tool._meta.capabilityId),
      maxRisk: "read_only"
    };
    const configured: any = directTools[1];
    const configuredCatalogTool: Record<string, any> = {
      id: configured.name,
      label: configured.title,
      description: configured.description,
      inputSchema: configured.inputSchema,
      readOnly: true,
      destructive: false,
      risk: configured._meta.risk,
      requiredScopes: configured._meta.requiredScopes,
      toolsets: configured._meta.toolsets,
      upstreamProjectedOperation: true,
      operationId: "upstream_operation.fixture",
      sourceRevision: 1,
      sourceDigest: "a".repeat(64),
      serviceId: configured._meta.serviceId,
      serviceRevision: 1,
      operationKey: configured._meta.operationKey,
      protocol: configured._meta.protocol,
      dynamicCapability: configured._meta.dynamicCapability,
      resourceContext: configured._meta.resourceContext
    };
    const provider: Record<string, any> = {
      authorizeMcpClientRequest: vi.fn(async () : Promise<any> => ({ ok: true, grant })),
      listVisibleTools: vi.fn(() : any => [configuredCatalogTool]),
      visibleGrantSummary: vi.fn(() : any => ({ id: grant.id }))
    };
    const upstreamGatewayRegistry: Record<string, any> = {
      listMcpTools: vi.fn(async () : Promise<any> => ({ items: directTools, count: directTools.length }))
    };

    const discovered: any = await callMcp({
      provider,
      upstreamGatewayRegistry,
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "meshrix.discovery",
          arguments: {
            apiVersion: "v0.0.1:mcp:interface-1",
            operation: "meshrix.capabilities.list",
            input: {}
          }
        }
      }
    });

    expect(discovered.statusCode).toBe(200);
    expect(discovered.payload.error).toBeUndefined();
    const capabilities: any = discovered.payload.result.structuredContent;
    expect(capabilities.operations.map((tool?: any) : any => tool.name)).toEqual(expect.arrayContaining(
      directTools.map((tool?: any) : any => tool.name)
    ));
    for (const tool of capabilities.operations.filter((item?: any) : any => item.name.startsWith("upstream."))) {
      expect(tool._meta).not.toHaveProperty("mcpOutlet");
    }
    expect(Object.keys(capabilities.outlets)).toEqual(["meshrix.discovery"]);
    expect(capabilities.outlets).not.toHaveProperty("upstream");
  });

  it("filters upstream MCP tools by grant maxRisk", async () : Promise<any> => {
    const destructiveTool: any = projectedFixtureTool({
      name: "records.purge",
      title: "Purge records",
      description: "Purge fixture records",
      annotations: { readOnlyHint: false, destructiveHint: true }
    });
    const writeTool: any = projectedFixtureTool({
      name: "records.write",
      title: "Write record",
      description: "Write a fixture record",
      annotations: { readOnlyHint: false, destructiveHint: false }
    });
    const provider: Record<string, any> = {
      authorizeMcpClientRequest: vi.fn(async () : Promise<any> => ({
        ok: true,
        grant: {
          id: "grant-1",
          label: "OpenCode",
          scopes: ["gateway:write"],
          toolsets: ["upstream-mcp"],
          dynamicCapabilities: [destructiveTool._meta.capabilityId, writeTool._meta.capabilityId],
          maxRisk: "safe_write"
        }
      }))
    };
    const upstreamGatewayRegistry: Record<string, any> = {
      listMcpTools: vi.fn(async () : Promise<any> => ({
        items: [destructiveTool, writeTool],
        count: 2
      }))
    };

    const listed: any = await callMcp({
      provider,
      upstreamGatewayRegistry,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
    });
    const names: any = listed.payload.result.tools.map((tool?: any) : any => tool.name);
    expect(names).toContain("upstream.fixture-upstream.records.write");
    expect(names).not.toContain("upstream.fixture-upstream.records.purge");
  });
});
