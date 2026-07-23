import { describe, expect, it, vi } from "vitest";

import { createSystemController } from "../../../packages/protocols/http/controllers/system-controller.mjs";

function captureResponse() {
  return {
    statusCode: 0,
    payload: null,
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(body = "") {
      this.payload = body ? JSON.parse(body) : null;
    }
  };
}

function consoleDomainServices(executeConsoleDomainOperation, upstreamGatewayRegistry) {
  return {
    executeConsoleDomainOperation,
    consoleOperationProviders: { upstreamGatewayRegistry },
    agentRuntimeProvider: {
      getAgentConfigRegistry() {},
      callAgentGateway() {},
      probeModelConnection() {},
      inspectAgentModelRouting() {}
    },
    uploadSessionStore: {
      resolveUploadSessionFiles() {},
      deleteUploadSession() {}
    }
  };
}

function settingsPort() {
  return {
    loadSettings: async () => ({}),
    saveSettings: async (_path, value) => value,
    normalizeSettings: (value) => value || {},
    getSettingsPath: () => "<settings-path>"
  };
}

function discoveryPort() {
  return {
    saveDiscoveryConfig: async (_path, value) => value || {}
  };
}

describe("upstream gateway console provider wiring", () => {
  it("passes the explicitly composed registry port through the system controller", async () => {
    const upstreamGatewayRegistry = { forward: vi.fn() };
    const executeConsoleDomainOperation = vi.fn(async () => ({
      status: 200,
      payload: { ok: true }
    }));
    const controller = createSystemController({
      userDataPath: "<user-data>",
      runtime: {},
      jobWorkflowProvider: {},
      getDiscoveryState: () => ({}),
      setDiscoveryState: () => {},
      getListenUrl: () => "",
      securityPermissions: {},
      settingsPort: settingsPort(),
      discoveryPort: discoveryPort(),
      consoleDomainServices: consoleDomainServices(
        executeConsoleDomainOperation,
        upstreamGatewayRegistry
      )
    });
    const response = captureResponse();
    const request = { method: "POST" };
    const abortController = new AbortController();

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
});
