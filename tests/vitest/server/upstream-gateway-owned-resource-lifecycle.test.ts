import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayRuntimeFactory: any = vi.hoisted(() : any => vi.fn());
const securityAlertStoreFactory: any = vi.hoisted(() : any => vi.fn());

vi.mock("@meshrix/foundation/security/security-alerts", () : any => ({
  createSecurityAlertStore: securityAlertStoreFactory
}));

vi.mock("../../../packages/agents/src/upstream-gateway/registry-runtime.ts", () : any => ({
  createGatewayRuntime: gatewayRuntimeFactory
}));

import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.ts";

function gatewayRuntimeFixture() : any {
  return {
    auditEvents: [],
    metrics: {},
    appendAudit: vi.fn(() : any => ({ auditId: "fixture-audit" })),
    appendSecurityAlert: vi.fn(),
    recordMetric: vi.fn(),
    refreshRuntimeStateFromDisk: vi.fn(),
    persist: vi.fn()
  };
}

beforeEach(() : any => {
  vi.clearAllMocks();
  gatewayRuntimeFactory.mockReturnValue(gatewayRuntimeFixture());
  securityAlertStoreFactory.mockReturnValue({ close: vi.fn() });
});

describe("upstream gateway owned-resource lifecycle", () : any => {
  it("closes its MCP sessions and security-alert store once across repeated close calls", async () : Promise<any> => {
    const securityAlertStore: Record<string, any> = { close: vi.fn() };
    const schemaPort = { assertSchemaBudget: vi.fn(), validate: vi.fn(), close: vi.fn(async () : Promise<any> => {}) };
    const mcpSessionManager: Record<string, any> = {
      callTool: vi.fn(),
      listTools: vi.fn(),
      close: vi.fn(async () : Promise<any> => {})
    };
    securityAlertStoreFactory.mockReturnValue(securityAlertStore);
    const registry: any = createUpstreamGatewayRegistry({ schemaPort,
      userDataPath: "<user-data>",
      mcpSessionManager
    });

    expect(registry.isClosed()).toBe(false);
    await registry.close();
    await registry.close();

    expect(registry.isClosed()).toBe(true);
    expect(mcpSessionManager.close).toHaveBeenCalledOnce();
    expect(schemaPort.close).toHaveBeenCalledOnce();
    expect(securityAlertStore.close).toHaveBeenCalledOnce();
  });

  it("aborts active schema validation before closing the registry-owned port", async () : Promise<any> => {
    let notifyValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolve) => { notifyValidationStarted = resolve; });
    let validationSettled = false;
    let portCloseSawSettledValidation = false;
    const schemaPort = {
      assertSchemaBudget: vi.fn(),
      validate: vi.fn(({ signal }: any) => new Promise((resolve) => {
        notifyValidationStarted();
        signal.addEventListener("abort", () => {
          validationSettled = true;
          resolve({ ok: false, code: "schema_validation_aborted", message: "Schema work was cancelled." });
        }, { once: true });
      })),
      close: vi.fn(async () : Promise<any> => { portCloseSawSettledValidation = validationSettled; })
    };
    const registry: any = createUpstreamGatewayRegistry({ schemaPort,
      mcpSessionManager: {
        listTools: async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }),
        invokeGateway: async () => ({ result: { content: [] } }),
        retireServiceScopes: async () => ({ retired: 0 }),
        close: vi.fn(async () : Promise<any> => {})
      }
    });
    installUpstreamRuntimeServices(registry, [{
      serviceId: "lifecycle",
      serviceProtocol: "mcp",
      label: "Lifecycle",
      allowLocalNetwork: true,
      operations: [{ operationKey: "tools/call", protocol: "mcp", risk: "safe_write", requiredScopes: ["gateway:write"], inputSchema: { type: "object" } }],
      mcp: { transport: "http", url: "http://127.0.0.1:9/mcp", protocolVersion: "2025-06-18" }
    }]);
    const subject = {
      type: "tool-grant",
      subjectId: "operator",
      grantId: "grant",
      grant: { id: "grant", subjectId: "operator", dynamicCapabilities: ["cap:upstream:lifecycle:tools-call-echo"] },
      scopes: ["gateway:write"],
      dynamicCapabilities: ["cap:upstream:lifecycle:tools-call-echo"]
    };

    const call = registry.forward({ serviceId: "lifecycle", operationKey: "tools/call", toolName: "echo", arguments: {} }, subject);
    await validationStarted;
    const closing = registry.close();
    await expect(call).rejects.toThrow();
    await closing;

    expect(validationSettled).toBe(true);
    expect(portCloseSawSettledValidation).toBe(true);
    expect(schemaPort.close).toHaveBeenCalledOnce();
  });

  it("preserves the construction error after attempting security-alert cleanup", () : any => {
    const constructionFailure: any = new Error("gateway runtime construction failed");
    const securityAlertStore: Record<string, any> = {
      close: vi.fn(() : any => {
        throw new Error("security alert close failed");
      })
    };
    securityAlertStoreFactory.mockReturnValue(securityAlertStore);
    gatewayRuntimeFactory.mockImplementation(() : any => {
      throw constructionFailure;
    });

    let failure: any = null;
    try {
      createUpstreamGatewayRegistry({ schemaPort: createGatewaySchemaPort(), userDataPath: "<user-data>" });
    } catch (error: any) {
      failure = error;
    }

    expect(failure).toBe(constructionFailure);
    expect(securityAlertStore.close).toHaveBeenCalledOnce();
  });

  it("keeps the registry retryable when owned-resource close fails", async () : Promise<any> => {
    const schemaPort = {
      assertSchemaBudget: vi.fn(),
      validate: vi.fn(),
      close: vi.fn()
        .mockRejectedValueOnce(new Error("schema port close failed"))
        .mockResolvedValueOnce(undefined)
    };
    const securityAlertStore: Record<string, any> = {
      close: vi.fn()
        .mockImplementationOnce(() : any => {
          throw new Error("security alert close failed");
        })
        .mockImplementationOnce(() : any => {})
    };
    securityAlertStoreFactory.mockReturnValue(securityAlertStore);
    const registry: any = createUpstreamGatewayRegistry({ schemaPort, userDataPath: "<user-data>" });

    await expect(registry.close()).rejects.toThrow("Upstream gateway registry did not close cleanly.");
    expect(registry.isClosed()).toBe(false);
    await expect(registry.close()).resolves.toBeUndefined();
    expect(registry.isClosed()).toBe(true);
    expect(schemaPort.close).toHaveBeenCalledTimes(2);
    expect(securityAlertStore.close).toHaveBeenCalledTimes(2);
  });

  it("still closes the security-alert store when MCP session shutdown fails", async () : Promise<any> => {
    const securityAlertStore: Record<string, any> = { close: vi.fn() };
    const mcpSessionManager: Record<string, any> = {
      callTool: vi.fn(),
      listTools: vi.fn(),
      close: vi.fn()
        .mockRejectedValueOnce(new Error("session close failed"))
        .mockResolvedValueOnce(undefined)
    };
    securityAlertStoreFactory.mockReturnValue(securityAlertStore);
    const registry: any = createUpstreamGatewayRegistry({ schemaPort: createGatewaySchemaPort(),
      userDataPath: "<user-data>",
      mcpSessionManager
    });

    await expect(registry.close()).rejects.toThrow("Upstream gateway registry did not close cleanly.");
    expect(securityAlertStore.close).toHaveBeenCalledOnce();
    expect(registry.isClosed()).toBe(false);

    await expect(registry.close()).resolves.toBeUndefined();
    expect(registry.isClosed()).toBe(true);
    expect(mcpSessionManager.close).toHaveBeenCalledTimes(2);
  });
});
