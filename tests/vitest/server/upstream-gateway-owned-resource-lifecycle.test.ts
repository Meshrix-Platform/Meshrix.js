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
    const mcpSessionManager: Record<string, any> = {
      callTool: vi.fn(),
      listTools: vi.fn(),
      close: vi.fn(async () : Promise<any> => {})
    };
    securityAlertStoreFactory.mockReturnValue(securityAlertStore);
    const registry: any = createUpstreamGatewayRegistry({
      userDataPath: "<user-data>",
      mcpSessionManager
    });

    expect(registry.isClosed()).toBe(false);
    await registry.close();
    await registry.close();

    expect(registry.isClosed()).toBe(true);
    expect(mcpSessionManager.close).toHaveBeenCalledOnce();
    expect(securityAlertStore.close).toHaveBeenCalledOnce();
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
      createUpstreamGatewayRegistry({ userDataPath: "<user-data>" });
    } catch (error: any) {
      failure = error;
    }

    expect(failure).toBe(constructionFailure);
    expect(securityAlertStore.close).toHaveBeenCalledOnce();
  });

  it("keeps the registry retryable when owned-resource close fails", async () : Promise<any> => {
    const securityAlertStore: Record<string, any> = {
      close: vi.fn()
        .mockImplementationOnce(() : any => {
          throw new Error("security alert close failed");
        })
        .mockImplementationOnce(() : any => {})
    };
    securityAlertStoreFactory.mockReturnValue(securityAlertStore);
    const registry: any = createUpstreamGatewayRegistry({ userDataPath: "<user-data>" });

    await expect(registry.close()).rejects.toThrow("Upstream gateway registry did not close cleanly.");
    expect(registry.isClosed()).toBe(false);
    await expect(registry.close()).resolves.toBeUndefined();
    expect(registry.isClosed()).toBe(true);
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
    const registry: any = createUpstreamGatewayRegistry({
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
