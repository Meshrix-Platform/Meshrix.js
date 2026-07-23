import type { UnifiedRegistrationRecord } from "./ops";

export type MaintenanceAgentRisk =
  | "read_only"
  | "safe_write"
  | "repair_write"
  | "destructive"
  | string;

export type MaintenanceAgentSchedule = {
  id: string;
  label: string;
  enabled: boolean;
  runbook: string;
  intervalMinutes: number;
  nextRunAt: string;
};

export type MaintenanceAgentRunbook = {
  id: string;
  label: string;
  description?: string;
  suggestedIntervalMinutes?: number;
};

export type MaintenanceAgentConfig = {
  schemaVersion: string;
  enabled: boolean;
  plannerMode: "gateway" | "fixed_runbook" | string;
  autoApproveRisk: MaintenanceAgentRisk;
  scheduler: {
    tickSeconds: number;
  };
  concurrency?: {
    maxActiveRuns: number;
  };
  schedules: MaintenanceAgentSchedule[];
};

export type MaintenanceAgentPlanStep = {
  toolId: string;
  input: Record<string, unknown>;
  risk: MaintenanceAgentRisk;
  reason: string;
};

export type MaintenanceAgentPlan = {
  schemaVersion: string;
  source: string;
  intent: string;
  summary: string;
  risk: MaintenanceAgentRisk;
  requiresApproval: boolean;
  approvalReason: string;
  steps: MaintenanceAgentPlanStep[];
};

export type MaintenanceAgentRunStep = MaintenanceAgentPlanStep & {
  stepId: string;
  index: number;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  output: Record<string, unknown> | null;
  error: string;
};

export type MaintenanceAgentRun = {
  schemaVersion: string;
  runId: string;
  status:
    | "awaiting_approval"
    | "queued"
    | "running"
    | "completed"
    | "completed_with_errors"
    | "failed"
    | "cancelled"
    | "rejected"
    | string;
  trigger: string;
  source: string;
  intent: string;
  summary: string;
  risk: MaintenanceAgentRisk;
  requiresApproval: boolean;
  approvalReason: string;
  planHash: string;
  plan: MaintenanceAgentPlan;
  steps: MaintenanceAgentRunStep[];
  actor?: Record<string, unknown> | null;
  input?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt: string;
  approvedAt: string;
  approvedBy?: Record<string, unknown> | null;
  cancelRequested: boolean;
  error: string;
  auditIds?: string[];
  unifiedRegistration?: UnifiedRegistrationRecord;
};

export type MaintenanceAgentTool = {
  id: string;
  risk: MaintenanceAgentRisk;
  scopes: string[];
  timeoutMs: number;
  inputSchema: Record<string, unknown>;
  redaction: string;
};

export type MaintenanceAgentSummary = {
  config: MaintenanceAgentConfig;
  tools: MaintenanceAgentTool[];
  latestRun: MaintenanceAgentRun | null;
  runs: MaintenanceAgentRun[];
  activeRunId: string;
  queuedRunIds: string[];
  pendingApprovalCount: number;
  nextRunAt: string;
  auditPath: string;
  runsPath: string;
};
