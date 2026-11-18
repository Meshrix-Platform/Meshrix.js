import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteWorkspaceRequest } = vi.hoisted(() : any => ({
  deleteWorkspaceRequest: vi.fn(),
}));

vi.mock("../../../apps/console/lib/workspaces-client", () : any => ({
  createWorkspace: vi.fn(),
  deleteWorkspace: deleteWorkspaceRequest,
  setWorkspaceParent: vi.fn(),
  updateWorkspaceProfile: vi.fn(),
  updateWorkspaceShare: vi.fn(),
}));

import { useWorkspaceManagementController } from
  "../../../apps/console/composables/console-workspace-management-controller";

function deferred<T>() : any {
  let resolve!: (value: T) => void;
  const promise: any = new Promise<T>((next?: any) : any => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("workspace deletion", () : any => {
  beforeEach(() : any => {
    deleteWorkspaceRequest.mockReset();
    deleteWorkspaceRequest.mockResolvedValue(undefined);
  });

  it("uses the shared confirmation and rejects repeated deletion requests", async () : Promise<any> => {
    const confirmation: any = deferred<boolean>();
    const confirmAction: any = vi.fn(() : any => confirmation.promise);
    const selectedId: any = ref("workspace-1");
    const panel: any = ref<"list">("list");
    const localError: any = ref("");
    const setBusy: any = vi.fn();
    const clearBusy: any = vi.fn();
    const load: any = vi.fn(async () : Promise<any> => undefined);
    const controller: any = useWorkspaceManagementController({
      selectedId,
      panel,
      localError,
      setBusy,
      clearBusy,
      confirmAction,
      load,
      loadChain: vi.fn(async () : Promise<any> => undefined),
    });
    const first: any = controller.deleteWorkspace();
    const repeated: any = controller.deleteWorkspace();
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

  it("does not start or clear busy state when confirmation is cancelled", async () : Promise<any> => {
    const selectedId: any = ref("workspace-2");
    const setBusy: any = vi.fn();
    const clearBusy: any = vi.fn();
    const controller: any = useWorkspaceManagementController({
      selectedId,
      panel: ref<"list">("list"),
      localError: ref(""),
      setBusy,
      clearBusy,
      confirmAction: vi.fn(async () : Promise<any> => false),
      load: vi.fn(async () : Promise<any> => undefined),
      loadChain: vi.fn(async () : Promise<any> => undefined),
    });

    await controller.deleteWorkspace();

    expect(deleteWorkspaceRequest).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
    expect(clearBusy).not.toHaveBeenCalled();
    expect(selectedId.value).toBe("workspace-2");
  });
});
