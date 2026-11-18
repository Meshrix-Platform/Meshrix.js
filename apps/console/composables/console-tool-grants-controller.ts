import { computed, ref, type Ref } from "vue";
import {
  createToolGrant as createToolGrantApi,
  deleteToolGrant as deleteToolGrantApi,
  rotateToolGrantToken,
  updateToolGrant as updateToolGrantApi,
  type OperationPermissionGrant,
} from "../lib/operation-permission-client";
import {
  confirmConsoleAction,
  copyConsoleText,
} from "./console-browser-effects";

type ConsoleToolGrantsControllerOptions = {
  clearBusy: (key: string) => void;
  error: Ref<string>;
  refreshOperationPermission: (options?: { silent?: boolean }) => Promise<void>;
  refreshOperationPermissionActivity: () => Promise<void>;
  setBusy: (key: string) => void;
  operationPermissionGrantsState: Ref<OperationPermissionGrant[]>;
};

export function createConsoleToolGrantsController(
  options: ConsoleToolGrantsControllerOptions,
) : any {
  const newGrantLabel: any = ref("默认智能体");
  const newGrantScopes: any = ref<string[]>(["gateway:read"]);
  const newGrantToolsets: any = ref<string[]>(["meshrix.gateway.read"]);
  const issuedToolToken: any = ref("");

  function applyGrantResponse(grant: OperationPermissionGrant): boolean {
    if (!grant || typeof grant.id !== "string" || grant.id.length === 0) {
      return false;
    }

    const current = options.operationPermissionGrantsState.value;
    const index = current.findIndex((item) => item.id === grant.id);
    if (grant.revokedAt) {
      if (index >= 0) {
        options.operationPermissionGrantsState.value = current.filter((item) => item.id !== grant.id);
      }
      return true;
    }

    if (index >= 0) {
      options.operationPermissionGrantsState.value = current.map((item, itemIndex) =>
        itemIndex === index ? grant : item,
      );
    } else {
      options.operationPermissionGrantsState.value = [grant, ...current];
    }
    return true;
  }

  async function refreshAfterGrantWrite(
    grant: OperationPermissionGrant,
    expectedGrantId?: string,
  ): Promise<void> {
    if ((expectedGrantId && grant?.id !== expectedGrantId) || !applyGrantResponse(grant)) {
      await options.refreshOperationPermission({ silent: true });
      return;
    }
    await options.refreshOperationPermissionActivity();
  }

  const toolGrants: any = computed(() : any => options.operationPermissionGrantsState.value);
  const enabledToolGrantCount: any = computed(
    () : any => toolGrants.value.filter((grant?: any) : any => grant.enabled).length,
  );

  function grantToolRuleState(grant: OperationPermissionGrant, toolId: string) : any {
    if ((grant.toolDeny || []).includes(toolId)) {
      return "deny";
    }
    if ((grant.toolAllow || []).includes(toolId)) {
      return "allow";
    }
    return "inherit";
  }

  function toggleNewGrantScope(scopeId: string) : any {
    const current: any = new Set<any>(newGrantScopes.value);
    if (current.has(scopeId)) {
      current.delete(scopeId);
    } else {
      current.add(scopeId);
    }
    newGrantScopes.value = [...current];
  }

  function toggleNewGrantToolset(toolsetId: string) : any {
    const current: any = new Set<any>(newGrantToolsets.value);
    if (current.has(toolsetId)) {
      current.delete(toolsetId);
    } else {
      current.add(toolsetId);
    }
    newGrantToolsets.value = [...current];
  }

  function grantHasScope(grant: OperationPermissionGrant, scopeId: string) : any {
    return grant.scopes.includes(scopeId);
  }

  function grantHasToolset(grant: OperationPermissionGrant, toolsetId: string) : any {
    return (grant.toolsets || []).includes(toolsetId);
  }

  async function createGrant() : Promise<any> {
    if (newGrantScopes.value.length === 0 && newGrantToolsets.value.length === 0) {
      options.error.value = "请至少选择一个工具权限范围或工具集。";
      return;
    }

    options.setBusy("grant:create");
    options.error.value = "";
    issuedToolToken.value = "";

    try {
      const result: any = await createToolGrantApi({
        label: newGrantLabel.value,
        scopes: newGrantScopes.value,
        toolsets: newGrantToolsets.value,
      });
      issuedToolToken.value = result.token;
      await refreshAfterGrantWrite(result.grant);
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "创建工具授权失败。";
    } finally {
      options.clearBusy("grant:create");
    }
  }

  async function updateGrant(grant: OperationPermissionGrant, patch: Partial<OperationPermissionGrant>) : Promise<any> {
    options.setBusy(`grant:${grant.id}`);
    options.error.value = "";

    try {
      const result = await updateToolGrantApi(grant.id, {
        label: patch.label,
        enabled: patch.enabled,
        scopes: patch.scopes,
        toolsets: patch.toolsets,
        toolAllow: patch.toolAllow,
        toolDeny: patch.toolDeny,
      });
      await refreshAfterGrantWrite(result.grant, grant.id);
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "更新工具授权失败。";
    } finally {
      options.clearBusy(`grant:${grant.id}`);
    }
  }

  async function setGrantToolRule(grant: OperationPermissionGrant, toolId: string, rule: "inherit" | "allow" | "deny") : Promise<any> {
    const allow: any = new Set<any>(grant.toolAllow || []);
    const deny: any = new Set<any>(grant.toolDeny || []);
    allow.delete(toolId);
    deny.delete(toolId);
    if (rule === "allow") {
      allow.add(toolId);
    }
    if (rule === "deny") {
      deny.add(toolId);
    }
    await updateGrant(grant, {
      toolAllow: [...allow],
      toolDeny: [...deny],
    });
  }

  async function toggleGrantScope(grant: OperationPermissionGrant, scopeId: string) : Promise<any> {
    const nextScopes: any = new Set<any>(grant.scopes);
    if (nextScopes.has(scopeId)) {
      nextScopes.delete(scopeId);
    } else {
      nextScopes.add(scopeId);
    }
    await updateGrant(grant, {
      scopes: [...nextScopes],
    });
  }

  async function toggleGrantToolset(grant: OperationPermissionGrant, toolsetId: string) : Promise<any> {
    const nextToolsets: any = new Set<any>(grant.toolsets || []);
    if (nextToolsets.has(toolsetId)) {
      nextToolsets.delete(toolsetId);
    } else {
      nextToolsets.add(toolsetId);
    }
    await updateGrant(grant, {
      toolsets: [...nextToolsets],
    });
  }

  async function rotateGrant(grant: OperationPermissionGrant) : Promise<any> {
    options.setBusy(`grant:${grant.id}`);
    options.error.value = "";
    issuedToolToken.value = "";

    try {
      const result: any = await rotateToolGrantToken(grant.id);
      issuedToolToken.value = result.token;
      await refreshAfterGrantWrite(result.grant, grant.id);
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "轮换工具令牌失败。";
    } finally {
      options.clearBusy(`grant:${grant.id}`);
    }
  }

  async function deleteGrant(grant: OperationPermissionGrant) : Promise<any> {
    if (!(await confirmConsoleAction(`撤销工具授权“${grant.label}”？`, { tone: "danger" }))) {
      return;
    }

    options.setBusy(`grant:${grant.id}`);
    options.error.value = "";

    try {
      const result = await deleteToolGrantApi(grant.id);
      await refreshAfterGrantWrite(result.grant, grant.id);
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "撤销工具授权失败。";
    } finally {
      options.clearBusy(`grant:${grant.id}`);
    }
  }

  async function copyIssuedToolToken() : Promise<any> {
    if (!issuedToolToken.value) {
      return;
    }
    await copyConsoleText(issuedToolToken.value);
  }

  return {
    copyIssuedToolToken,
    createGrant,
    deleteGrant,
    enabledToolGrantCount,
    grantHasScope,
    grantHasToolset,
    grantToolRuleState,
    issuedToolToken,
    newGrantLabel,
    newGrantScopes,
    newGrantToolsets,
    rotateGrant,
    setGrantToolRule,
    toggleGrantScope,
    toggleGrantToolset,
    toggleNewGrantScope,
    toggleNewGrantToolset,
    toolGrants,
    updateGrant,
  };
}
