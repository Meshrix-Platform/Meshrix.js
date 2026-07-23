import { computed, ref, type Ref } from "vue";
import {
  getAuthOidc,
  getAuthSession,
  listAuthAudit,
  listAuthSessions,
  listAuthUsers,
  loginAuth,
  logoutAuth,
  revokeAuthSession,
  saveAuthOidc,
  updateAuthUser,
} from "../lib/auth-client";
import type {
  ConsoleAuditItem,
  ConsoleAuthSummary,
  ConsoleOidcConfig,
  ConsoleUser,
} from "../lib/auth-types";
import type {
  ServerConsoleState,
} from "../lib/types";

type RefreshState = (options?: { silent?: boolean; forceDrafts?: boolean }) => Promise<unknown>;

export type ConsoleAuthControllerOptions = {
  consoleState: Ref<ServerConsoleState | null>;
  error: Ref<string>;
  clearAllBusy: () => void;
  refreshState: RefreshState;
  resetServerEventCursor: () => void;
  setBusy: (key: string) => void;
  startServerEventSubscription: () => void;
  stopServerEventSubscription: () => void;
};

export function createConsoleAuthController(options: ConsoleAuthControllerOptions) {
  const authState = ref<ConsoleAuthSummary | null>(null);
  const consoleBootstrapping = ref(true);
  const loginForm = ref({ username: "", password: "" });
  const authUsers = ref<ConsoleUser[]>([]);
  const authAudit = ref<ConsoleAuditItem[]>([]);
  const authSessions = ref<Array<Record<string, unknown>>>([]);
  const oidcDraft = ref<ConsoleOidcConfig & { clientSecret?: string }>({
    enabled: false,
    issuer: "",
    clientId: "",
    clientSecretConfigured: false,
    redirectUri: "",
    allowedDomains: [],
    roleMapping: {},
    updatedAt: "",
    clientSecret: "",
  });
  const oidcAllowedDomainsText = ref("");
  const oidcRoleMappingText = ref("{}");

  const currentUser = computed(() => authState.value?.session.user || null);
  const isAuthenticated = computed(
    () => authState.value?.session.authenticated === true,
  );
  const currentUserScopes = computed(() => currentUser.value?.scopes || []);

  function hasScope(scopeId: string) {
    return isAuthenticated.value && currentUserScopes.value.includes(scopeId);
  }

  const canAdminAuth = computed(() => hasScope("auth:admin"));
  const canReadGateway = computed(() => hasScope("gateway:read"));
  const canWriteGateway = computed(() => hasScope("workspace:write"));
  const canMaintainGateway = computed(() => hasScope("gateway:maintain"));
  const canAdminGateway = computed(() => hasScope("gateway:admin"));
  const canWriteJobs = computed(() => hasScope("jobs:write"));
  const canBrowseServerPaths = computed(() => hasScope("workspace:write"));
  const canAdminRuntime = computed(() => hasScope("runtime:admin"));
  const canReadMaintenanceAgent = computed(() => hasScope("maintenance:read"));
  const canRunMaintenanceAgent = computed(() => hasScope("maintenance:run"));
  const canApproveMaintenanceAgent = computed(() => hasScope("maintenance:approve"));
  const canAdminMaintenanceAgent = computed(() => hasScope("maintenance:admin"));

  async function refreshAuthState() {
    try {
      const session = await getAuthSession();
      authState.value = session;
      if (!session.session.authenticated) {
        options.consoleState.value = null;
        options.stopServerEventSubscription();
      }
      return session;
    } catch (nextError) {
      authState.value = null;
      options.consoleState.value = null;
      options.stopServerEventSubscription();
      options.error.value = nextError instanceof Error ? nextError.message : "加载认证状态失败。";
      return null;
    }
  }

  async function submitLoginAuth() {
    consoleBootstrapping.value = true;
    options.setBusy("auth:login");
    options.error.value = "";
    try {
      await loginAuth(loginForm.value);
      const session = await refreshAuthState();
      if (!session?.session.authenticated) {
        options.error.value = "登录已返回，但会话状态尚未生效，请重试。";
        return;
      }
      await options.refreshState({ silent: true });
      options.startServerEventSubscription();
    } catch (nextError) {
      options.error.value = nextError instanceof Error ? nextError.message : "登录失败。";
    } finally {
      consoleBootstrapping.value = false;
      options.clearAllBusy();
    }
  }

  async function logoutConsole() {
    consoleBootstrapping.value = true;
    options.setBusy("auth:logout");
    options.error.value = "";
    options.stopServerEventSubscription();
    options.resetServerEventCursor();
    try {
      await logoutAuth();
      options.consoleState.value = null;
      await refreshAuthState();
    } catch (nextError) {
      options.error.value = nextError instanceof Error ? nextError.message : "退出失败。";
    } finally {
      consoleBootstrapping.value = false;
      options.clearAllBusy();
    }
  }

  async function refreshAuthAdmin() {
    if (!canAdminAuth.value) {
      return;
    }
    try {
      const [users, audit, sessions, oidc] = await Promise.all([
        listAuthUsers(),
        listAuthAudit(80),
        listAuthSessions(),
        getAuthOidc(),
      ]);
      authUsers.value = users.users;
      authAudit.value = audit.items;
      authSessions.value = sessions.sessions;
      oidcDraft.value = {
        ...oidc.oidc,
        clientSecret: "",
      };
      oidcAllowedDomainsText.value = (oidc.oidc.allowedDomains || []).join("\n");
      oidcRoleMappingText.value = JSON.stringify(oidc.oidc.roleMapping || {}, null, 2);
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "加载认证管理数据失败。";
    }
  }

  async function updateConsoleUser(user: ConsoleUser, patch: Partial<ConsoleUser> & { password?: string }) {
    options.setBusy(`auth:user:${user.userId}`);
    options.error.value = "";
    try {
      const result = await updateAuthUser(user.userId, patch);
      authUsers.value = result.users;
    } catch (nextError) {
      options.error.value = nextError instanceof Error ? nextError.message : "更新用户失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  function updateConsoleUserRoleFromEvent(user: ConsoleUser, event: Event) {
    const roleId = (event.target as HTMLSelectElement).value;
    void updateConsoleUser(user, { roleId });
  }

  function updateConsoleUserRole(user: ConsoleUser, roleId: string) {
    void updateConsoleUser(user, { roleId });
  }

  async function saveOidcConfig() {
    options.setBusy("auth:oidc");
    options.error.value = "";
    try {
      const result = await saveAuthOidc({
        ...oidcDraft.value,
        allowedDomains: oidcAllowedDomainsText.value
          .split(/[\n,，]/)
          .map((item) => item.trim())
          .filter(Boolean),
        roleMapping: JSON.parse(oidcRoleMappingText.value || "{}") as Record<string, string>,
      });
      oidcDraft.value = {
        ...result.oidc,
        clientSecret: "",
      };
    } catch (nextError) {
      options.error.value = nextError instanceof Error ? nextError.message : "保存 OIDC 失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  async function revokeConsoleSession(sessionId: string) {
    options.setBusy(`auth:session:${sessionId}`);
    options.error.value = "";
    try {
      await revokeAuthSession(sessionId);
      await refreshAuthAdmin();
    } catch (nextError) {
      options.error.value = nextError instanceof Error ? nextError.message : "撤销会话失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  return {
    authAudit,
    consoleBootstrapping,
    authSessions,
    authState,
    authUsers,
    canAdminAuth,
    canAdminGateway,
    canAdminMaintenanceAgent,
    canAdminRuntime,
    canApproveMaintenanceAgent,
    canBrowseServerPaths,
    canMaintainGateway,
    canReadGateway,
    canReadMaintenanceAgent,
    canRunMaintenanceAgent,
    canWriteJobs,
    canWriteGateway,
    currentUser,
    currentUserScopes,
    hasScope,
    isAuthenticated,
    loginForm,
    logoutConsole,
    oidcAllowedDomainsText,
    oidcDraft,
    oidcRoleMappingText,
    refreshAuthAdmin,
    refreshAuthState,
    revokeConsoleSession,
    saveOidcConfig,
    submitLoginAuth,
    updateConsoleUser,
    updateConsoleUserRole,
    updateConsoleUserRoleFromEvent,
  };
}
