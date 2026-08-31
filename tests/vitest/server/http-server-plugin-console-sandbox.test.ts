import { describe, expect, it, vi } from "vitest";

import {
  handlePluginConsoleRequest
} from "../../../apps/server/runtime/http-server-plugin-console-sandbox.ts";

const DIGEST: any = `sha256:${"a".repeat(64)}`;
const SANDBOX_URL: any = `/api/plugins/v1/console-sandboxes/demo/1/${"a".repeat(64)}/YWRtaW4uZGVtbw.html`;
const BRIDGE_URL: any = `/api/plugins/v1/console-bridges/demo/1/${"a".repeat(64)}/YWRtaW4uZGVtbw/invoke`;
const ENTRY: Readonly<Record<string, any>> = Object.freeze({
  id: "admin.demo",
  pluginId: "demo",
  featureId: "demo-feature",
  viewKey: "demo",
  routePath: "/admin/demo",
  slotId: "",
  componentId: "demo/DemoView",
  sandboxUrl: SANDBOX_URL,
  bridgeVersion: "v0.0.1:plugin:console-bridge-1",
  requiredScopes: Object.freeze(["demo:read"]),
  toolIds: Object.freeze(["demo.read"]),
  artifactDigest: DIGEST,
  artifactGeneration: 1
});

function capturedResponse() : any {
  const headers: any = new Map<any, any>();
  return {
    statusCode: 0,
    body: undefined,
    headers,
    headersSent: false,
    setHeader(name?: any, value?: any) : any {
      headers.set(String(name).toLowerCase(), String(value));
    },
    writeHead(statusCode?: any, values: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      for (const [name, value] of (Object.entries(values) as [string, any][])) this.setHeader(name, value);
    },
    end(body?: any) : any {
      this.body = body;
      this.headersSent = true;
    }
  };
}

function contributions({ entry = ENTRY, bytes = Buffer.from("export function mountPluginConsole() {}") }: Record<string, any> = {}) : any {
  return {
    getConsoleSandboxEntry: vi.fn((url?: any) : any => url === SANDBOX_URL ? entry : null),
    readConsoleSandbox: vi.fn(async (url?: any) : Promise<any> => url === SANDBOX_URL ? { entry, bytes } : null),
    resolveConsoleBridgeInvocation: vi.fn((url?: any, toolId?: any) : any => (
      url === BRIDGE_URL && toolId === "demo.read"
        ? { entry, operationId: "demo.read", toolId }
        : null
    ))
  };
}

async function invoke({
  method = "GET",
  pathname = SANDBOX_URL,
  session = null,
  pluginContributions = contributions(),
  requestBody = Buffer.alloc(0),
  ...patch
}: Record<string, any> = {}) : Promise<any> {
  const response: any = capturedResponse();
  const request: any = { headers: {}, socket: {} };
  const handled: any = await handlePluginConsoleRequest({
    request,
    response,
    requestBody,
    method,
    url: new URL(`http://localhost${pathname}`),
    consoleAuth: { getSessionFromRequest: vi.fn(() : any => session) },
    pluginContributions,
    ...patch
  });
  return { handled, response, pluginContributions, request };
}

describe("plugin console sandbox HTTP boundary", () : any => {
  it("ignores unrelated routes and requires the current session and scopes", async () : Promise<any> => {
    expect((await invoke({ pathname: "/api/system/status" })).handled).toBe(false);

    const anonymous: any = await invoke();
    expect(anonymous.response.statusCode).toBe(401);
    expect(anonymous.pluginContributions.readConsoleSandbox).not.toHaveBeenCalled();

    const denied: any = await invoke({ session: { user: { scopes: [] } } });
    expect(denied.response.statusCode).toBe(403);
    expect(denied.pluginContributions.readConsoleSandbox).not.toHaveBeenCalled();
  });

  it("serves only a nonce-bound sandbox document, never a JavaScript asset", async () : Promise<any> => {
    const served: any = await invoke({ session: { user: { scopes: ["demo:read"] } } });
    const body: any = served.response.body.toString("utf8");
    expect(served.response.statusCode).toBe(200);
    expect(served.response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(served.response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(served.response.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(served.response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(body).toContain("meshrix.plugin-console.guest-ready");
    expect(body).toContain("createObjectURL");
    expect(body).not.toContain("/api/plugins/v1/console-assets/");
  });

  it("revalidates bridge identity and dispatches only the entry-owned operation", async () : Promise<any> => {
    const session: any = { sessionId: "session-1", user: { subjectId: "user-1", scopes: ["demo:read"] } };
    const envelope: any = {
      bridgeVersion: ENTRY.bridgeVersion,
      pluginId: ENTRY.pluginId,
      componentId: ENTRY.componentId,
      artifactDigest: ENTRY.artifactDigest,
      artifactGeneration: ENTRY.artifactGeneration,
      route: { path: ENTRY.routePath, viewKey: ENTRY.viewKey },
      toolId: "demo.read",
      payload: { value: 7 }
    };
    const operation: any = {
      id: "demo.read",
      pluginId: "demo",
      feature: "demo-feature",
      label: "Demo read",
      target: { controller: "plugin", method: "executePluginOperation" },
      http: { method: "POST", path: "/api/demo/read" },
      readOnly: true,
      concurrency: { maxParallel: 2 },
      inputSchema: { type: "object", additionalProperties: true },
      safety: { risk: "read_only", requiresConfirmation: false }
    };
    const executePluginOperation: any = vi.fn(async (call?: any) : Promise<any> => {
      call.response.statusCode = 200;
      call.response.setHeader("Content-Type", "application/json");
      call.response.end(JSON.stringify({ ok: true, value: call.input.value }));
    });
    const authorizeOperation: any = vi.fn(async () : Promise<any> => ({
      ok: true,
      session,
      authorizationDecision: { allowed: true, decisionId: "decision-1", reasonCode: "allowed" },
      governancePolicyRevision: { revision: 1 }
    }));
    const admitted: any = await invoke({
      method: "POST",
      pathname: BRIDGE_URL,
      session,
      requestBody: Buffer.from(JSON.stringify(envelope)),
      requestOperations: [operation],
      controllers: { plugin: { executePluginOperation } },
      authorizeOperation,
      operationProofSubstrate: {
        beginLifecycle: vi.fn(async () : Promise<any> => ({ ledgerEventId: "proof-1" })),
        recordReceipt: vi.fn(async () : Promise<any> => ({ ledgerEventId: "proof-1" })),
        finishLifecycle: vi.fn(async () : Promise<any> => ({ ledgerEventId: "proof-1" }))
      },
      operationAuditStore: null,
      concurrencyScope: "test",
      signal: new AbortController().signal
    });
    expect({ statusCode: admitted.response.statusCode, body: String(admitted.response.body) }).toEqual({
      statusCode: 200,
      body: JSON.stringify({ ok: true, value: 7 })
    });
    expect(authorizeOperation).toHaveBeenCalledTimes(2);
    expect(executePluginOperation).toHaveBeenCalledTimes(1);

    const drifted: any = await invoke({
      method: "POST",
      pathname: BRIDGE_URL,
      session,
      requestBody: Buffer.from(JSON.stringify({ ...envelope, artifactGeneration: 2 }))
    });
    expect(drifted.response.statusCode).toBe(409);

    const foreign: any = await invoke({
      method: "POST",
      pathname: BRIDGE_URL,
      session,
      requestBody: Buffer.from(JSON.stringify({ ...envelope, toolId: "other.secret" }))
    });
    expect(foreign.response.statusCode).toBe(404);
  });
});
