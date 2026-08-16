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
import { requestDestructiveConfirm } from "./console-destructive-operation-registry";

type RefreshState = (options?: { silent?: boolean; forceDrafts?: boolean }) => Promise<unknown>;

export type ConsoleAuthControllerOptions = {
  consoleState: Ref<ServerConsoleState | null>;
  error: Ref<string>;
  clearBusy: (key: string) => void;
  refreshState: RefreshState;
  resetServerEventCursor: () => void;
  setBusy: (key: string) => void;
  startServerEventSubscription: () => void;
  stopServerEventSubscription: () => void;
};

export function createConsoleAuthController(options: ConsoleAuthControllerOptions) : any {
  const authState: any = ref<ConsoleAuthSummary | null>(null);
  const consoleBootstrapping: any = ref(true);
  const loginForm: any = ref({ username: "", password: "" });
  const authUsers: any = ref<ConsoleUser[]>([]);
  const authAudit: any = ref<ConsoleAuditItem[]>([]);
  const authSessions: any = ref<Array<Record<string, unknown>>>([]);
  const oidcDraft: any = ref<ConsoleOidcConfig & { clientSecret?: string }>({
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
  const oidcAllowedDomainsText: any = ref("");
  const oidcRoleMappingText: any = ref("{}");

  const currentUser: any = computed(() : any => authState.value?.session.user || null);
  const isAuthenticated: any = computed(
    () : any => authState.value?.session.authenticated === true,
  );
  const currentUserScopes: any = computed(() : any => currentUser.value?.scopes || []);

  function hasScope(scopeId: string) : any {
    return isAuthenticated.value && currentUserScopes.value.includes(scopeId);
  }

  const canAdminAuth: any = computed(() : any => hasScope("auth:admin"));
  const canReadGateway: any = computed(() : any => hasScope("gateway:read"));
  const canWriteGateway: any = computed(() : any => hasScope("workspace:write"));
  const canMaintainGateway: any = computed(() : any => hasScope("gateway:maintain"));
  const canAdminGateway: any = computed(() : any => hasScope("gateway:admin"));
  const canWriteJobs: any = computed(() : any => hasScope("jobs:write"));
  const canBrowseServerPaths: any = computed(() : any => hasScope("workspace:write"));
  const canAdminRuntime: any = computed(() : any => hasScope("runtime:admin"));

  async function refreshAuthState() : Promise<any> {
    try {
      const session: any = await getAuthSession();
      authState.value = session;
      if (!session.session.authenticated) {
        options.consoleState.value = null;
        options.stopServerEventSubscription();
      }
      return session;
    } catch (nextError: any) {
      authState.value = null;
      options.consoleState.value = null;
      options.stopServerEventSubscription();
      options.error.value = nextError instanceof Error ? nextError.message : "加载认证状态失败。";
      return null;
    }
  }

  async function submitLoginAuth() : Promise<any> {
    consoleBootstrapping.value = true;
    options.setBusy("auth:login");
    options.error.value = "";
    try {
      await loginAuth(loginForm.value);
      const session: any = await refreshAuthState();
      if (!session?.session.authenticated) {
        options.error.value = "登录已返回，但会话状态尚未生效，请重试。";
        return;
      }
      await options.refreshState({ silent: true });
      options.startServerEventSubscription();
    } catch (nextError: any) {
      options.error.value = nextError instanceof Error ? nextError.message : "登录失败。";
    } finally {
      consoleBootstrapping.value = false;
      options.clearBusy("auth:login");
    }
  }

  async function logoutConsole() : Promise<any> {
    consoleBootstrapping.value = true;
    options.setBusy("auth:logout");
    options.error.value = "";
    options.stopServerEventSubscription();
    options.resetServerEventCursor();
    try {
      await logoutAuth();
      options.consoleState.value = null;
      await refreshAuthState();
    } catch (nextError: any) {
      options.error.value = nextError instanceof Error ? nextError.message : "退出失败。";
    } finally {
      consoleBootstrapping.value = false;
      options.clearBusy("auth:logout");
    }
  }

  async function refreshAuthAdmin() : Promise<any> {
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
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "加载认证管理数据失败。";
    }
  }

  async function updateConsoleUser(user: ConsoleUser, patch: Partial<ConsoleUser> & { password?: string }) : Promise<any> {
    options.setBusy(`auth:user:${user.userId}`);
    options.error.value = "";
    try {
      const result: any = await updateAuthUser(user.userId, patch);
      authUsers.value = result.users;
    } catch (nextError: any) {
      options.error.value = nextError instanceof Error ? nextError.message : "更新用户失败。";
    } finally {
      options.clearBusy(`auth:user:${user.userId}`);
    }
  }

  function updateConsoleUserRoleFromEvent(user: ConsoleUser, event: Event) : any {
    const roleId: any = (event.target as HTMLSelectElement).value;
    void updateConsoleUser(user, { roleId });
  }

  function updateConsoleUserRole(user: ConsoleUser, roleId: string) : any {
    void updateConsoleUser(user, { roleId });
  }

  async function saveOidcConfig() : Promise<any> {
    options.setBusy("auth:oidc");
    options.error.value = "";
    try {
      const result: any = await saveAuthOidc({
        ...oidcDraft.value,
        allowedDomains: oidcAllowedDomainsText.value
          .split(/[\n,，]/)
          .map((item?: any) : any => item.trim())
          .filter(Boolean),
        roleMapping: JSON.parse(oidcRoleMappingText.value || "{}") as Record<string, string>,
      });
      oidcDraft.value = {
        ...result.oidc,
        clientSecret: "",
      };
    } catch (nextError: any) {
      options.error.value = nextError instanceof Error ? nextError.message : "保存 OIDC 失败。";
    } finally {
      options.clearBusy("auth:oidc");
    }
  }

  async function revokeConsoleSession(sessionId: string) : Promise<any> {
    if (!(await requestDestructiveConfirm("auth.session.revoke", { resource: sessionId }))) {
      return;
    }
    options.setBusy(`auth:session:${sessionId}`);
    options.error.value = "";
    try {
      await revokeAuthSession(sessionId);
      await refreshAuthAdmin();
    } catch (nextError: any) {
      options.error.value = nextError instanceof Error ? nextError.message : "撤销会话失败。";
    } finally {
      options.clearBusy(`auth:session:${sessionId}`);
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
    canAdminRuntime,
    canBrowseServerPaths,
    canMaintainGateway,
    canReadGateway,
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
