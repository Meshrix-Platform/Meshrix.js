import { getJson, postJson } from "@meshrix/ui-console/bridge-http";
import type {
  ConsoleAuditItem,
  ConsoleAuthSummary,
  ConsoleOidcConfig,
  ConsoleUser,
} from "./auth-types";

export type AuthLoginPayload = {
  username: string;
  password: string;
};

export type AuthUserPatch = {
  displayName?: string;
  password?: string;
  roleId?: string;
  enabled?: boolean;
};

export type AuthOidcPatch = Partial<ConsoleOidcConfig> & {
  clientSecret?: string;
};

export type AuthUsersResponse = {
  users: ConsoleUser[];
  roles: ConsoleAuthSummary["roles"];
};

export type AuthAuditResponse = {
  items: ConsoleAuditItem[];
};

export type AuthSessionsResponse = {
  sessions: Array<Record<string, unknown>>;
};

export function getAuthSession() : any {
  return getJson<ConsoleAuthSummary>("/api/auth/session");
}

export function loginAuth(payload: AuthLoginPayload) : any {
  return postJson<ConsoleAuthSummary & { ok: boolean }>("/api/auth/login", payload);
}

export function logoutAuth() : any {
  return postJson<{ ok: boolean }>("/api/auth/logout", {});
}

export function listAuthUsers() : any {
  return getJson<AuthUsersResponse>("/api/auth/users");
}

export function updateAuthUser(userId: string, payload: AuthUserPatch) : any {
  return postJson<{ user: ConsoleUser; users: ConsoleUser[] }>(
    `/api/auth/users/${encodeURIComponent(userId)}`,
    payload,
    { safetyConfirm: true },
  );
}

export function getAuthOidc() : any {
  return getJson<{ oidc: ConsoleOidcConfig }>("/api/auth/oidc");
}

export function saveAuthOidc(payload: AuthOidcPatch) : any {
  return postJson<{ oidc: ConsoleOidcConfig }>("/api/auth/oidc", payload, {
    safetyConfirm: true,
  });
}

export function listAuthAudit(limit: any = 100) : any {
  return getJson<AuthAuditResponse>(`/api/auth/audit?limit=${encodeURIComponent(String(limit))}`);
}

export function listAuthSessions() : any {
  return getJson<AuthSessionsResponse>("/api/auth/sessions");
}

export function revokeAuthSession(sessionId: string) : any {
  return postJson<{ ok: boolean }>(`/api/auth/sessions/${encodeURIComponent(sessionId)}/revoke`, {});
}
