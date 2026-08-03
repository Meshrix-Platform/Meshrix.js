import { reactive, ref, type Ref } from "vue";
import type { WsWorkspace } from "../types/workspaces";
import { errorMessage } from "@meshrix/ui-console/error-message";
import * as workspacesClient from "../lib/workspaces-client";
import type { ConsoleConfirmAction } from "./console-confirm-controller";

export type WorkspacePanel =
  | "list"
  | "create"
  | "profile"
  | "parent"
  | "share"
  | "assets"
  | "localDir";

export type WorkspaceManagementControllerOptions = {
  clearBusy: (key: string) => void;
  confirmAction: ConsoleConfirmAction;
  load: () => Promise<void>;
  loadChain: (id: string) => Promise<void>;
  localError: Ref<string>;
  panel: Ref<WorkspacePanel>;
  selectedId: Ref<string>;
  setBusy: (key: string) => void;
};

export function useWorkspaceManagementController(
  options: WorkspaceManagementControllerOptions,
) : any {
  const createForm: any = reactive({ title: "", objective: "", parentWorkspaceId: "" });
  const profileForm: any = reactive({
    contextProfileId: "",
    toolGrantId: "",
    modelAlias: "",
  });
  const parentForm: any = reactive({ parentWorkspaceId: "" });
  const shareForm: any = reactive({ targetWorkspaceId: "", action: "share" as "share" | "unshare" });
  let deletePending: any = false;

  async function createWorkspace() : Promise<any> {
    options.setBusy("ws:create");
    options.localError.value = "";
    try {
      await workspacesClient.createWorkspace({ ...createForm });
      Object.assign(createForm, { title: "", objective: "", parentWorkspaceId: "" });
      options.panel.value = "list";
      await options.load();
    } catch (e: unknown) {
      options.localError.value = errorMessage(e);
    } finally {
      options.clearBusy("ws:create");
    }
  }

  async function deleteWorkspace() : Promise<any> {
    const workspaceId: any = options.selectedId.value;
    if (!workspaceId || deletePending) return;
    deletePending = true;
    let operationStarted: any = false;
    try {
      const confirmed: any = await options.confirmAction(
        `确认永久删除工作空间 ${workspaceId} 及其全部受管数据？`,
        {
          title: "移除工作空间",
          tone: "danger",
          confirmLabel: "确认移除",
          requireText: "DELETE",
        },
      );
      if (!confirmed) return;

      operationStarted = true;
      options.setBusy("ws:delete");
      options.localError.value = "";
      await workspacesClient.deleteWorkspace(workspaceId);
      options.selectedId.value = "";
      options.panel.value = "list";
      await options.load();
    } catch (e: unknown) {
      options.localError.value = errorMessage(e);
    } finally {
      if (operationStarted) {
        options.clearBusy("ws:delete");
      }
      deletePending = false;
    }
  }

  async function setParent() : Promise<any> {
    if (!options.selectedId.value) return;
    options.setBusy("ws:parent");
    options.localError.value = "";
    try {
      await workspacesClient.setWorkspaceParent(options.selectedId.value, parentForm.parentWorkspaceId || null);
      options.panel.value = "list";
      await options.load();
      await options.loadChain(options.selectedId.value);
    } catch (e: unknown) {
      options.localError.value = errorMessage(e);
    } finally {
      options.clearBusy("ws:parent");
    }
  }

  async function hotSwapProfile() : Promise<any> {
    if (!options.selectedId.value) return;
    options.setBusy("ws:profile");
    options.localError.value = "";
    try {
      const patch: Record<string, unknown> = {};
      if (profileForm.contextProfileId) patch.contextProfileId = profileForm.contextProfileId;
      if (profileForm.toolGrantId) patch.toolGrantId = profileForm.toolGrantId;
      if (profileForm.modelAlias) patch.modelAlias = profileForm.modelAlias;
      await workspacesClient.updateWorkspaceProfile(options.selectedId.value, patch);
      options.panel.value = "list";
      await options.load();
      await options.loadChain(options.selectedId.value);
    } catch (e: unknown) {
      options.localError.value = errorMessage(e);
    } finally {
      options.clearBusy("ws:profile");
    }
  }

  async function shareOrUnshare() : Promise<any> {
    if (!options.selectedId.value || !shareForm.targetWorkspaceId) return;
    options.setBusy("ws:share");
    options.localError.value = "";
    try {
      await workspacesClient.updateWorkspaceShare(
        options.selectedId.value,
        shareForm.action,
        shareForm.targetWorkspaceId,
      );
      options.panel.value = "list";
      await options.load();
      await options.loadChain(options.selectedId.value);
    } catch (e: unknown) {
      options.localError.value = errorMessage(e);
    } finally {
      options.clearBusy("ws:share");
    }
  }

  function openProfile(ws: WsWorkspace) : any {
    Object.assign(profileForm, {
      contextProfileId: ws.profile?.contextProfileId ?? "",
      toolGrantId: ws.profile?.toolGrantId ?? "",
      modelAlias: ws.profile?.modelAlias ?? "",
    });
    options.panel.value = "profile";
  }

  function openParent(ws: WsWorkspace) : any {
    parentForm.parentWorkspaceId = ws.parentWorkspaceId ?? "";
    options.panel.value = "parent";
  }

  return {
    createForm,
    createWorkspace,
    deleteWorkspace,
    hotSwapProfile,
    openParent,
    openProfile,
    parentForm,
    profileForm,
    setParent,
    shareForm,
    shareOrUnshare,
  };
}
