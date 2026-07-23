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
  clearAllBusy: () => void;
  error: Ref<string>;
  refreshOperationPermission: (options?: { silent?: boolean }) => Promise<void>;
  setBusy: (key: string) => void;
  operationPermissionGrantsState: Ref<OperationPermissionGrant[]>;
};

export function createConsoleToolGrantsController(
  options: ConsoleToolGrantsControllerOptions,
) {
  const newGrantLabel = ref("默认智能体");
  const newGrantScopes = ref<string[]>(["gateway:read"]);
  const newGrantToolsets = ref<string[]>(["lico.gateway.read"]);
  const issuedToolToken = ref("");

  const toolGrants = computed(() => options.operationPermissionGrantsState.value);
  const enabledToolGrantCount = computed(
    () => toolGrants.value.filter((grant) => grant.enabled).length,
  );

  function grantToolRuleState(grant: OperationPermissionGrant, toolId: string) {
    if ((grant.toolDeny || []).includes(toolId)) {
      return "deny";
    }
    if ((grant.toolAllow || []).includes(toolId)) {
      return "allow";
    }
    return "inherit";
  }

  function toggleNewGrantScope(scopeId: string) {
    const current = new Set(newGrantScopes.value);
    if (current.has(scopeId)) {
      current.delete(scopeId);
    } else {
      current.add(scopeId);
    }
    newGrantScopes.value = [...current];
  }

  function toggleNewGrantToolset(toolsetId: string) {
    const current = new Set(newGrantToolsets.value);
    if (current.has(toolsetId)) {
      current.delete(toolsetId);
    } else {
      current.add(toolsetId);
    }
    newGrantToolsets.value = [...current];
  }

  function grantHasScope(grant: OperationPermissionGrant, scopeId: string) {
    return grant.scopes.includes(scopeId);
  }

  function grantHasToolset(grant: OperationPermissionGrant, toolsetId: string) {
    return (grant.toolsets || []).includes(toolsetId);
  }

  async function createGrant() {
    if (newGrantScopes.value.length === 0 && newGrantToolsets.value.length === 0) {
      options.error.value = "请至少选择一个工具权限范围或工具集。";
      return;
    }

    options.setBusy("grant:create");
    options.error.value = "";
    issuedToolToken.value = "";

    try {
      const result = await createToolGrantApi({
        label: newGrantLabel.value,
        scopes: newGrantScopes.value,
        toolsets: newGrantToolsets.value,
      });
      issuedToolToken.value = result.token;
      await options.refreshOperationPermission({ silent: true });
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "创建工具授权失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  async function updateGrant(grant: OperationPermissionGrant, patch: Partial<OperationPermissionGrant>) {
    options.setBusy(`grant:${grant.id}`);
    options.error.value = "";

    try {
      await updateToolGrantApi(grant.id, {
        label: patch.label,
        enabled: patch.enabled,
        scopes: patch.scopes,
        toolsets: patch.toolsets,
        toolAllow: patch.toolAllow,
        toolDeny: patch.toolDeny,
      });
      await options.refreshOperationPermission({ silent: true });
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "更新工具授权失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  async function setGrantToolRule(grant: OperationPermissionGrant, toolId: string, rule: "inherit" | "allow" | "deny") {
    const allow = new Set(grant.toolAllow || []);
    const deny = new Set(grant.toolDeny || []);
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

  async function toggleGrantScope(grant: OperationPermissionGrant, scopeId: string) {
    const nextScopes = new Set(grant.scopes);
    if (nextScopes.has(scopeId)) {
      nextScopes.delete(scopeId);
    } else {
      nextScopes.add(scopeId);
    }
    await updateGrant(grant, {
      scopes: [...nextScopes],
    });
  }

  async function toggleGrantToolset(grant: OperationPermissionGrant, toolsetId: string) {
    const nextToolsets = new Set(grant.toolsets || []);
    if (nextToolsets.has(toolsetId)) {
      nextToolsets.delete(toolsetId);
    } else {
      nextToolsets.add(toolsetId);
    }
    await updateGrant(grant, {
      toolsets: [...nextToolsets],
    });
  }

  async function rotateGrant(grant: OperationPermissionGrant) {
    options.setBusy(`grant:${grant.id}`);
    options.error.value = "";
    issuedToolToken.value = "";

    try {
      const result = await rotateToolGrantToken(grant.id);
      issuedToolToken.value = result.token;
      await options.refreshOperationPermission({ silent: true });
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "轮换工具令牌失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  async function deleteGrant(grant: OperationPermissionGrant) {
    if (!(await confirmConsoleAction(`撤销工具授权“${grant.label}”？`, { tone: "danger" }))) {
      return;
    }

    options.setBusy(`grant:${grant.id}`);
    options.error.value = "";

    try {
      await deleteToolGrantApi(grant.id);
      await options.refreshOperationPermission({ silent: true });
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "撤销工具授权失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  async function copyIssuedToolToken() {
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
