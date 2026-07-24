export type ConsoleRole = {
  roleId: "owner" | "admin" | "operator" | "viewer" | string;
  label: string;
  scopes: string[];
};

export type ConsoleUser = {
  userId: string;
  username: string;
  displayName: string;
  roleId: string;
  roleLabel: string;
  scopes: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string;
};

export type ConsoleAuthSession = {
  authenticated: boolean;
  csrfToken: string;
  expiresAt: string;
  user: ConsoleUser | null;
};

export type ConsoleOidcConfig = {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecretConfigured: boolean;
  redirectUri: string;
  allowedDomains: string[];
  roleMapping: Record<string, string>;
  updatedAt: string;
};

export type ConsoleAuthSummary = {
  enabled: boolean;
  bootstrap: {
    required: boolean;
    tokenPrefix: string;
    tokenFilePath: string;
  };
  session: ConsoleAuthSession;
  roles: ConsoleRole[];
  oidc: ConsoleOidcConfig;
};

export type ConsoleAuditItem = {
  auditId: string;
  userId?: string;
  username?: string;
  operationId: string;
  action?: string;
  method?: string;
  path?: string;
  transport?: string;
  actor?: Record<string, unknown>;
  risk?: string;
  readOnly?: boolean;
  durationMs?: number;
  inputHash?: string;
  redactedInput?: Record<string, unknown>;
  redactedOutputSummary?: Record<string, unknown>;
  status: string;
  target?: Record<string, unknown>;
  error: string;
  createdAt: string;
};
