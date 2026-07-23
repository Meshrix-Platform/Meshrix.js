import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteWorkspaceRequest } = vi.hoisted(() => ({
  deleteWorkspaceRequest: vi.fn(),
}));

vi.mock("../../../apps/console/lib/workspaces-client", () => ({
  createWorkspace: vi.fn(),
  deleteWorkspace: deleteWorkspaceRequest,
  setWorkspaceParent: vi.fn(),
  updateWorkspaceProfile: vi.fn(),
  updateWorkspaceShare: vi.fn(),
}));

import { useWorkspaceManagementController } from
  "../../../apps/console/composables/console-workspace-management-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("workspace deletion", () => {
  beforeEach(() => {
    deleteWorkspaceRequest.mockReset();
    deleteWorkspaceRequest.mockResolvedValue(undefined);
  });

  it("uses the shared confirmation and rejects repeated deletion requests", async () => {
    const confirmation = deferred<boolean>();
    const confirmAction = vi.fn(() => confirmation.promise);
    const selectedId = ref("workspace-1");
    const panel = ref<"list">("list");
    const localError = ref("");
    const setBusy = vi.fn();
    const clearBusy = vi.fn();
    const load = vi.fn(async () => undefined);
    const controller = useWorkspaceManagementController({
      selectedId,
      panel,
      localError,
      setBusy,
      clearBusy,
      confirmAction,
      load,
      loadChain: vi.fn(async () => undefined),
    });
    const first = controller.deleteWorkspace();
    const repeated = controller.deleteWorkspace();
    expect(confirmAction).toHaveBeenCalledTimes(1);
    confirmation.resolve(true);
    await Promise.all([first, repeated]);

    expect(deleteWorkspaceRequest).toHaveBeenCalledTimes(1);
    expect(deleteWorkspaceRequest).toHaveBeenCalledWith("workspace-1");
    expect(setBusy).toHaveBeenCalledWith("ws:delete");
    expect(clearBusy).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(selectedId.value).toBe("");
  });

  it("does not start or clear busy state when confirmation is cancelled", async () => {
    const selectedId = ref("workspace-2");
    const setBusy = vi.fn();
    const clearBusy = vi.fn();
    const controller = useWorkspaceManagementController({
      selectedId,
      panel: ref<"list">("list"),
      localError: ref(""),
      setBusy,
      clearBusy,
      confirmAction: vi.fn(async () => false),
      load: vi.fn(async () => undefined),
      loadChain: vi.fn(async () => undefined),
    });

    await controller.deleteWorkspace();

    expect(deleteWorkspaceRequest).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
    expect(clearBusy).not.toHaveBeenCalled();
    expect(selectedId.value).toBe("workspace-2");
  });
});
