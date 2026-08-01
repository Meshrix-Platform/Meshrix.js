import { describe, expect, it, vi } from "vitest";

import { createSystemController } from "../../../packages/protocols/http/controllers/system-controller.ts";

function captureResponse() : any {
  return {
    statusCode: 0,
    payload: null,
    writeHead(statusCode?: any) : any {
      this.statusCode = statusCode;
    },
    end(body: any = "") : any {
      this.payload = body ? JSON.parse(body) : null;
    }
  };
}

function consoleDomainServices(executeConsoleDomainOperation?: any, upstreamGatewayRegistry?: any) : any {
  return {
    executeConsoleDomainOperation,
    consoleOperationProviders: { upstreamGatewayRegistry },
    agentRuntimeProvider: {
      getAgentConfigRegistry() : any {},
      callAgentGateway() : any {},
      probeModelConnection() : any {},
      inspectAgentModelRouting() : any {}
    },
    uploadSessionStore: {
      resolveUploadSessionFiles() : any {},
      deleteUploadSession() : any {}
    }
  };
}

function settingsPort() : any {
  return {
    loadSettings: async () : Promise<any> => ({}),
    saveSettings: async (_path?: any, value?: any) : Promise<any> => value,
    normalizeSettings: (value?: any) : any => value || {},
    getSettingsPath: () : any => "<settings-path>"
  };
}

function discoveryPort() : any {
  return {
    saveDiscoveryConfig: async (_path?: any, value?: any) : Promise<any> => value || {}
  };
}

describe("upstream gateway console provider wiring", () : any => {
  it("passes the explicitly composed registry port through the system controller", async () : Promise<any> => {
    const upstreamGatewayRegistry: Record<string, any> = { forward: vi.fn() };
    const executeConsoleDomainOperation: any = vi.fn(async () : Promise<any> => ({
      status: 200,
      payload: { ok: true }
    }));
    const controller: any = createSystemController({
      userDataPath: "<user-data>",
      runtime: {},
      jobWorkflowProvider: {},
      getDiscoveryState: () : any => ({}),
      setDiscoveryState: () : any => {},
      getListenUrl: () : any => "",
      securityPermissions: {},
      settingsPort: settingsPort(),
      discoveryPort: discoveryPort(),
      consoleDomainServices: consoleDomainServices(
        executeConsoleDomainOperation,
        upstreamGatewayRegistry
      )
    });
    const response: any = captureResponse();
    const request: Record<string, any> = { method: "POST" };
    const abortController: any = new AbortController();

    await controller.handleUpstreamGatewayOperation({
      operation: { id: "gateway.forward", http: { method: "POST" } },
      request,
      requestBody: Buffer.from(JSON.stringify({
        serviceId: "fixture-service",
        operationKey: "echo"
      })),
      url: new URL("http://localhost/api/gateway/v1/forward"),
      response,
      authSession: { user: { subjectId: "fixture-subject" } },
      signal: abortController.signal
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toEqual({ ok: true });
    expect(executeConsoleDomainOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "gateway.forward",
      context: expect.objectContaining({
        upstreamGatewayRegistry,
        request,
        signal: abortController.signal
      })
    }));
  });

  it("authorizes upload routes through either the console session or the current MCP grant", async () : Promise<any> => {
    const authorizeOperation: any = vi.fn(async () : Promise<any> => ({
      ok: true,
      session: { user: { userId: "console-subject", scopes: ["uploads:write"] } }
    }));
    const authorizeRequest: any = vi.fn();
    const controller: any = createSystemController({
      userDataPath: "<user-data>",
      runtime: {},
      jobWorkflowProvider: {},
      getDiscoveryState: () : any => ({}),
      setDiscoveryState: () : any => {},
      getListenUrl: () : any => "",
      securityPermissions: { authorizeOperation },
      settingsPort: settingsPort(),
      discoveryPort: discoveryPort(),
      getToolSkillManagementProvider: () : any => ({ authorizeRequest }),
      consoleDomainServices: consoleDomainServices(vi.fn(), {})
    });
    const operation: Record<string, any> = { id: "uploads.create_session", requiredScopes: ["uploads:write"] };
    const externalAuth: Record<string, any> = { requiredScopes: ["uploads:write"], recordUse: true };
    const request: Record<string, any> = { headers: {} };
    const url: any = new URL("http://localhost/api/upload-sessions");

    const consoleResult: any = await controller.verifyConsoleOrToolSkillExternalAuth({
      operation,
      request,
      input: {},
      requestBody: Buffer.from("{}"),
      url,
      method: "POST",
      externalAuth
    });
    expect(consoleResult.ok).toBe(true);
    expect(consoleResult.authSession.user.userId).toBe("console-subject");
    expect(authorizeRequest).not.toHaveBeenCalled();

    authorizeOperation.mockResolvedValueOnce({ ok: false, status: 401 });
    authorizeRequest.mockResolvedValueOnce({
      ok: true,
      grant: {
        id: "grant-synthetic",
        label: "Synthetic grant",
        scopes: ["uploads:write"],
        toolsets: ["meshrix.uploads.write"]
      }
    });
    const grantResult: any = await controller.verifyConsoleOrToolSkillExternalAuth({
      operation,
      request,
      input: {},
      requestBody: Buffer.from("{}"),
      url,
      method: "POST",
      externalAuth
    });
    expect(grantResult.ok).toBe(true);
    expect(grantResult.authSession.user.userId).toBe("grant-synthetic");
    expect(authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      requiredScopes: ["uploads:write"],
      recordUse: true
    }));
  });
});
