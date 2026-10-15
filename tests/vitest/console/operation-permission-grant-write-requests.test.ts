import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConsoleOperationPermissionController } from "../../../apps/console/composables/console-operation-permission-controller";

const clientMock = vi.hoisted(() => ({
  createToolGrant: vi.fn(),
  deleteToolGrant: vi.fn(),
  getOperationPermissionAudit: vi.fn(),
  getOperationPermissionCatalog: vi.fn(),
  getOperationPermissionGrants: vi.fn(),
  getOperationPermissionMetrics: vi.fn(),
  previewToolPolicy: vi.fn(),
  rotateToolGrantToken: vi.fn(),
  updateToolGrant: vi.fn(),
}));

vi.mock("../../../apps/console/lib/operation-permission-client", () => clientMock);
vi.mock("../../../apps/console/composables/console-browser-effects", () => ({
  confirmConsoleAction: vi.fn(async () => true),
  copyConsoleText: vi.fn(),
}));
vi.mock("../../../apps/console/composables/console-browser-effects", () => ({
  confirmConsoleAction: vi.fn(async () => true),
  copyConsoleText: vi.fn(),
}));

const grant = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  label: id,
  enabled: true,
  scopes: ["scope.read"],
  toolsets: ["toolset.read"],
  toolAllow: [],
  toolDeny: [],
  tokenPrefix: "token…",
  hasToken: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: "",
  ...overrides,
});

describe("Operation Permission grant write requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.getOperationPermissionGrants.mockResolvedValue({ grants: [grant("existing")] });
    clientMock.getOperationPermissionCatalog.mockResolvedValue({ scopes: [], tools: [], toolsets: [], profiles: [] });
    clientMock.getOperationPermissionAudit.mockResolvedValue({ items: [] });
    clientMock.getOperationPermissionMetrics.mockResolvedValue({ metrics: { byStatus: {}, byRisk: {} } });
  });

  it("applies committed create and revoke rows while refreshing only activity data", async () => {
    const controller = createConsoleOperationPermissionController({
      clearBusy: vi.fn(),
      error: ref(""),
      setBusy: vi.fn(),
    });
    await controller.refreshOperationPermission();

    const createdGrant = grant("created", { createdAt: "2026-10-08T00:00:00.000Z" });
    clientMock.createToolGrant.mockResolvedValue({ grant: createdGrant, token: "one-time-token" });
    await controller.createGrant();

    expect(controller.operationPermissionGrantsState.value.map((item: { id: string }) => item.id)).toEqual([
      "created",
      "existing",
    ]);
    expect(controller.issuedToolToken.value).toBe("one-time-token");

    clientMock.deleteToolGrant.mockResolvedValue({
      grant: grant("created", { enabled: false, revokedAt: "2026-10-08T00:01:00.000Z" }),
    });
    await controller.deleteGrant(createdGrant);

    expect(controller.operationPermissionGrantsState.value.map((item: { id: string }) => item.id)).toEqual([
      "existing",
    ]);
    expect(clientMock.getOperationPermissionGrants).toHaveBeenCalledTimes(1);
    expect(clientMock.getOperationPermissionCatalog).toHaveBeenCalledTimes(1);
    expect(clientMock.getOperationPermissionAudit).toHaveBeenCalledTimes(3);
    expect(clientMock.getOperationPermissionMetrics).toHaveBeenCalledTimes(3);
    expect(clientMock.createToolGrant).toHaveBeenCalledTimes(1);
    expect(clientMock.deleteToolGrant).toHaveBeenCalledTimes(1);
  });
});
