import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceClientMock = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  setWorkspaceParent: vi.fn(),
  updateWorkspaceProfile: vi.fn(),
  updateWorkspaceShare: vi.fn(),
}));

vi.mock("../../../apps/console/lib/workspaces-client", () => workspaceClientMock);

import {
  useWorkspaceManagementController,
  type WorkspacePanel,
} from
  "../../../apps/console/composables/console-workspace-management-controller";

describe("workspace share refresh requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceClientMock.updateWorkspaceShare.mockResolvedValue({
      ok: true,
      workspace: { workspaceId: "workspace-target", currentGeneration: 2 },
    });
  });

  it.each(["share", "unshare"] as const)("refreshes the list/session views after %s without reloading the unchanged source chain", async (action) => {
    const listWorkspaceSummaries = vi.fn(async () => undefined);
    const listWorkspaceSessions = vi.fn(async () => undefined);
    const load = vi.fn(async () => {
      await Promise.all([listWorkspaceSummaries(), listWorkspaceSessions()]);
    });
    const loadChain = vi.fn(async () => undefined);
    const controller = useWorkspaceManagementController({
      clearBusy: vi.fn(),
      confirmAction: vi.fn(async () => true),
      load,
      loadChain,
      localError: ref(""),
      panel: ref<WorkspacePanel>("share"),
      selectedId: ref("workspace-source"),
      setBusy: vi.fn(),
    });
    controller.shareForm.targetWorkspaceId = "workspace-target";
    controller.shareForm.action = action;

    await controller.shareOrUnshare();

    expect(workspaceClientMock.updateWorkspaceShare).toHaveBeenCalledTimes(1);
    expect(workspaceClientMock.updateWorkspaceShare).toHaveBeenCalledWith(
      "workspace-source",
      action,
      "workspace-target",
    );
    expect(listWorkspaceSummaries).toHaveBeenCalledTimes(1);
    expect(listWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(loadChain).not.toHaveBeenCalled();
  });
});
