import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayRuntimeFactory = vi.hoisted(() => vi.fn());
const securityAlertStoreFactory = vi.hoisted(() => vi.fn());

vi.mock("@meshrix/foundation/security/security-alerts", () => ({
  createSecurityAlertStore: securityAlertStoreFactory
}));

vi.mock("../../../packages/agents/src/upstream-gateway/registry-runtime.mjs", () => ({
  createGatewayRuntime: gatewayRuntimeFactory
}));

import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.mjs";

function gatewayRuntimeFixture() {
  return {
    auditEvents: [],
    metrics: {},
    appendAudit: vi.fn(() => ({ auditId: "fixture-audit" })),
    appendSecurityAlert: vi.fn(),
    recordMetric: vi.fn(),
    refreshRuntimeStateFromDisk: vi.fn(),
    persist: vi.fn()
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gatewayRuntimeFactory.mockReturnValue(gatewayRuntimeFixture());
  securityAlertStoreFactory.mockReturnValue({ close: vi.fn() });
});

describe("upstream gateway owned-resource lifecycle", () => {
  it("closes its MCP sessions and security-alert store once across repeated close calls", async () => {
    const securityAlertStore = { close: vi.fn() };
    const mcpSessionManager = {
      callTool: vi.fn(),
      listTools: vi.fn(),
      close: vi.fn(async () => {})
    };
    securityAlertStoreFactory.mockReturnValue(securityAlertStore);
    const registry = createUpstreamGatewayRegistry({
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

  it("preserves the construction error after attempting security-alert cleanup", () => {
    const constructionFailure = new Error("gateway runtime construction failed");
    const securityAlertStore = {
      close: vi.fn(() => {
        throw new Error("security alert close failed");
      })
    };
    securityAlertStoreFactory.mockReturnValue(securityAlertStore);
    gatewayRuntimeFactory.mockImplementation(() => {
      throw constructionFailure;
    });

    let failure = null;
    try {
      createUpstreamGatewayRegistry({ userDataPath: "<user-data>" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(constructionFailure);
    expect(securityAlertStore.close).toHaveBeenCalledOnce();
  });

  it("keeps the registry retryable when owned-resource close fails", async () => {
    const securityAlertStore = {
      close: vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("security alert close failed");
        })
        .mockImplementationOnce(() => {})
    };
    securityAlertStoreFactory.mockReturnValue(securityAlertStore);
    const registry = createUpstreamGatewayRegistry({ userDataPath: "<user-data>" });

    await expect(registry.close()).rejects.toThrow("Upstream gateway registry did not close cleanly.");
    expect(registry.isClosed()).toBe(false);
    await expect(registry.close()).resolves.toBeUndefined();
    expect(registry.isClosed()).toBe(true);
    expect(securityAlertStore.close).toHaveBeenCalledTimes(2);
  });

  it("still closes the security-alert store when MCP session shutdown fails", async () => {
    const securityAlertStore = { close: vi.fn() };
    const mcpSessionManager = {
      callTool: vi.fn(),
      listTools: vi.fn(),
      close: vi.fn()
        .mockRejectedValueOnce(new Error("session close failed"))
        .mockResolvedValueOnce(undefined)
    };
    securityAlertStoreFactory.mockReturnValue(securityAlertStore);
    const registry = createUpstreamGatewayRegistry({
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
