import { getJson, postJson } from "@meshrix/ui-console/bridge-http";
import type {
  MaintenanceAgentConfig,
  MaintenanceAgentRunbook,
  MaintenanceAgentRun,
} from "./types";

export type MaintenanceAgentConfigResponse = {
  path: string;
  config: MaintenanceAgentConfig;
  runbookCatalog: MaintenanceAgentRunbook[];
};

export type SaveMaintenanceAgentConfigResponse = {
  config: MaintenanceAgentConfig;
};

export type MaintenanceAgentChatPayload = {
  message: string;
  modelAlias?: string;
  agentName?: string;
  wait?: boolean;
};

export type MaintenanceAgentChatResponse = {
  plan: MaintenanceAgentRun["plan"];
  run: MaintenanceAgentRun;
};

export type MaintenanceAgentRunPayload = {
  runbook?: string;
  wait?: boolean;
};

export type MaintenanceAgentRunsResponse = {
  items: MaintenanceAgentRun[];
  activeRunId: string;
  queuedRunIds: string[];
};

export function getMaintenanceAgentConfig() : any {
  return getJson<MaintenanceAgentConfigResponse>("/api/maintenance-agent/config");
}

export function saveMaintenanceAgentConfig(config: Partial<MaintenanceAgentConfig>) : any {
  return postJson<SaveMaintenanceAgentConfigResponse>(
    "/api/maintenance-agent/config",
    { config },
    { safetyConfirm: true },
  );
}

export function chatMaintenanceAgent(payload: MaintenanceAgentChatPayload) : any {
  return postJson<MaintenanceAgentChatResponse>("/api/maintenance-agent/chat", payload);
}

export function startMaintenanceAgentRun(payload: MaintenanceAgentRunPayload) : any {
  return postJson<MaintenanceAgentRun>("/api/maintenance-agent/runs", payload);
}

export function listMaintenanceAgentRuns(limit: any = 50) : any {
  return getJson<MaintenanceAgentRunsResponse>(
    `/api/maintenance-agent/runs?limit=${encodeURIComponent(String(limit))}`,
  );
}

export function getMaintenanceAgentRun(runId: string) : any {
  return getJson<{ run: MaintenanceAgentRun }>(
    `/api/maintenance-agent/runs/${encodeURIComponent(runId)}`,
  );
}

export function approveMaintenanceAgentRun(
  runId: string,
  payload: { planHash: string; wait?: boolean },
) : any {
  return postJson<{ run: MaintenanceAgentRun }>(
    `/api/maintenance-agent/runs/${encodeURIComponent(runId)}/approve`,
    payload,
  );
}

export function cancelMaintenanceAgentRun(
  runId: string,
  payload: { reason?: string } = {},
) : any {
  return postJson<{ run: MaintenanceAgentRun }>(
    `/api/maintenance-agent/runs/${encodeURIComponent(runId)}/cancel`,
    payload,
  );
}
