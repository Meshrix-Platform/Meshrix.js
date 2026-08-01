export type OperationPermissionScope = {
  id: string;
  label: string;
  description: string;
};

export type OperationPermissionGrant = {
  id: string;
  label: string;
  type?: string;
  enabled: boolean;
  toolsets?: string[];
  toolAllow?: string[];
  toolDeny?: string[];
  scopes: string[];
  expiresAt?: string;
  maxUses?: number;
  rateLimit?: Record<string, unknown>;
  allowedOrigins?: string[];
  allowedCidrs?: string[];
  metadata?: Record<string, unknown>;
  reason?: string;
  tokenPrefix: string;
  hasToken: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  lastUsedAt: string;
};

export type OperationPermissionGrantsResponse = {
  schemaVersion: string;
  grants: OperationPermissionGrant[];
};

export type OperationPermissionGrantIssue = {
  grant: OperationPermissionGrant;
  token: string;
};

export type OperationPermissionRisk =
  | "read_only"
  | "safe_write"
  | "repair_write"
  | "destructive"
  | string;

export type OperationPermissionToolset = {
  id: string;
  label: string;
  description?: string;
  requiredScopes: string[];
  maxRisk: OperationPermissionRisk;
  grantable?: boolean;
  defaultForAgents?: boolean;
};

export type OperationPermissionToolGroup = {
  id: string;
  label: string;
  description?: string;
  toolsetId: string;
  requiredScopes: string[];
  defaultForAgents: boolean;
  grantable: boolean;
  maxRisk: OperationPermissionRisk;
  toolCount: number;
  activeToolCount: number;
  internalToolCount: number;
  writeToolCount: number;
  sampleToolIds: string[];
};

export type OperationPermissionProfile = {
  id: string;
  label: string;
  agentType: string;
  toolsets: string[];
  toolAllow: string[];
  toolDeny: string[];
  maxRisk: OperationPermissionRisk;
  approvalPolicy: string;
  concurrencyLimit: number;
  sandboxPolicy: string;
  auditTags: string[];
};

export type OperationPermissionTool = {
  id: string;
  version: string;
  label: string;
  description: string;
  owner: string;
  source: string;
  operationId: string;
  handlerId: string;
  toolsets: string[];
  requiredScopes: string[];
  risk: OperationPermissionRisk;
  readOnly: boolean;
  destructive: boolean;
  concurrencySafe: boolean;
  requiresApproval: boolean;
  approvalScope: string;
  timeoutMs: number;
  maxResultBytes: number;
  status: string;
  tags: string[];
};

export type OperationPermissionCatalog = {
  schemaVersion: string;
  generatedAt: string;
  fingerprint: string;
  scopes: OperationPermissionScope[];
  toolsets: OperationPermissionToolset[];
  toolGroups?: OperationPermissionToolGroup[];
  profiles: OperationPermissionProfile[];
  tools: OperationPermissionTool[];
};

export type OperationPermissionAuditItem = {
  toolExecutionId: string;
  traceId: string;
  toolId: string;
  toolVersion: string;
  toolsetIds: string[];
  subjectType: string;
  subjectId: string;
  grantId: string;
  agentId: string;
  profileId: string;
  operationId: string;
  risk: OperationPermissionRisk;
  decision: string;
  resultSummary?: Record<string, unknown>;
  status: string;
  errorCode: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  policyDecisionId: string;
};

export type OperationPermissionAuditResponse = {
  schemaVersion: string;
  items: OperationPermissionAuditItem[];
};

export type OperationPermissionPendingOperation = {
  pendingOperationId: string;
  traceId?: string;
  toolExecutionId?: string;
  toolId: string;
  toolLabel?: string;
  toolVersion?: string;
  toolsetIds?: string[];
  operationId?: string;
  risk?: OperationPermissionRisk;
  approvalScope?: string;
  approvalLayers?: string[];
  grantId?: string;
  agentId?: string;
  profileId?: string;
  reasonCode?: string;
  riskReason?: string;
  requiredApproval?: {
    approvalLayers?: string[];
    expiresAt?: string;
    grantKinds?: string[];
    [key: string]: unknown;
  };
  redactedInput?: unknown;
  context?: unknown;
  status: string;
  resultSummary?: Record<string, unknown>;
  executionOutcome?:
    | "continued_pending_approval"
    | "executed_once"
    | "execution_failed";
  expiresAt?: string;
  createdAt?: string;
  resolvedAt?: string;
  completedAt?: string;
  resolvedBy?: string;
  resolutionReason?: string;
  resumedToolExecutionId?: string;
  errorCode?: string;
  [key: string]: unknown;
};

export type OperationPermissionPendingOperationsResponse = {
  schemaVersion: string;
  pendingOperations: OperationPermissionPendingOperation[];
};

export type OperationPermissionMetrics = {
  callsTotal: number;
  byStatus: Record<string, number>;
  byTool: Record<string, number>;
  byProfile: Record<string, number>;
  byGrant: Record<string, number>;
  byRisk: Record<string, number>;
  deniedByReason: Record<string, number>;
  timeoutTotal: number;
  rateLimitedTotal: number;
  activeExecutions: number;
  averageDurationMs: number;
  resultBytesTotal: number;
};

export type OperationPermissionMetricsResponse = {
  schemaVersion: string;
  metrics: OperationPermissionMetrics;
};
