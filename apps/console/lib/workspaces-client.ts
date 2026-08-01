import { deleteJson, getJson, postJson } from "@meshrix/ui-console/bridge-http";
import type {
  WsCheckpointTreeDetail,
  WsCheckpointTreeSummary,
  WsSession,
  WsSessionContext,
  WsSessionDetail,
  WsWorkspace,
} from "../types/workspaces";

export type WorkspaceConsolePayload = Record<string, any>;

export type WorkspaceListResponse = {
  workspaces?: WsWorkspace[];
};

export type WorkspaceSessionListResponse = {
  sessions?: WsSession[];
};

export type WorkspaceCheckpointTreeListResponse = {
  items?: WsCheckpointTreeSummary[];
};

export type WorkspaceChainBundle = {
  chain: WorkspaceConsolePayload;
  context: WorkspaceConsolePayload;
  files: WorkspaceConsolePayload;
};

export type WorkspaceSessionBundle = {
  sessionData: WsSessionDetail;
  context: WsSessionContext;
};

export type WorkspaceProfilePatch = {
  contextProfileId?: string;
  toolGrantId?: string;
  modelAlias?: string;
};

export type WorkspaceAssetQuery = {
  workspaceId: string;
  assetRef?: string;
  targetKind?: string;
  assetKind?: string;
  canonicalState?: string;
  limit?: number;
  [key: string]: unknown;
};

export const workspaceContextContract: Readonly<Record<string, any>> = Object.freeze({
  workspaceEndpoint: "/api/agent-workspaces",
  contextEndpoint: "/context",
  sessionsEndpoint: "/api/agent-sessions",
  sessionLinkField: "agentSessionId",
  forkActionLabel: "分叉",
});

export const workspaceContextSignature: any = JSON.stringify(workspaceContextContract);

function encoded(value: string) : any {
  return encodeURIComponent(value);
}

function buildQuery(params: Record<string, unknown>) : any {
  const query: any = new URLSearchParams();
  for (const [key, value] of (Object.entries(params) as [string, any][])) {
    if (value !== undefined && value !== null && String(value) !== "") {
      query.set(key, String(value));
    }
  }
  return query.toString();
}

function stringArray(value: unknown) : any {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function normalizeWorkspace(value: WsWorkspace): WsWorkspace {
  const summary: any = value?.summary && typeof value.summary === "object"
    ? value.summary
    : { sessionCount: 0 };
  return {
    ...value,
    workspaceId: String(value?.workspaceId || ""),
    status: String(value?.status || "unknown"),
    updatedAt: String(value?.updatedAt || ""),
    currentGeneration: Number(value?.currentGeneration || 0),
    ownedSourceIds: stringArray(value?.ownedSourceIds),
    accessibleWorkspaceIds: stringArray(value?.accessibleWorkspaceIds),
    summary: {
      ...summary,
      sessionCount: Number(summary.sessionCount || 0),
    },
  };
}

export async function listWorkspaceSummaries() : Promise<any> {
  const response: any = await getJson<WorkspaceListResponse>("/api/agent-workspaces?includeSummary=true");
  return {
    ...response,
    workspaces: (response.workspaces || []).map(normalizeWorkspace).filter((item?: any) : any => item.workspaceId),
  };
}

export function listWorkspaceSessions() : any {
  return getJson<WorkspaceSessionListResponse>("/api/agent-sessions?limit=100&includeLastEvent=true");
}

export async function getWorkspaceChainBundle(workspaceId: string): Promise<WorkspaceChainBundle> {
  const [chain, context, files] = await Promise.all([
    getJson<WorkspaceConsolePayload>(`/api/agent-workspaces/${encoded(workspaceId)}/chain`),
    getJson<WorkspaceConsolePayload>(`/api/agent-workspaces/${encoded(workspaceId)}/context`),
    getJson<WorkspaceConsolePayload>(`/api/agent-workspaces/${encoded(workspaceId)}/files?recursive=true`)
      .catch(() : any => ({ files: [] })),
  ]);
  return { chain, context, files };
}

export function listWorkspaceCheckpointTrees(workspaceId: string) : any {
  return getJson<WorkspaceCheckpointTreeListResponse>(
    `/api/workspace/checkpoints/trees?ownerId=${encoded(workspaceId)}&kind=workspace_files&limit=20`,
  );
}

export function getWorkspaceCheckpointTree(treeId: string) : any {
  return getJson<WsCheckpointTreeDetail>(`/api/workspace/checkpoints/nodes/${encoded(treeId)}`);
}

export function previewWorkspaceCheckpointRestoreRequest(payload: WorkspaceConsolePayload) : any {
  return postJson<WorkspaceConsolePayload>(
    "/api/workspace/checkpoints/restore/preview",
    payload,
    { safetyConfirm: true },
  );
}

export function restoreWorkspaceCheckpointRequest(payload: WorkspaceConsolePayload) : any {
  return postJson<WorkspaceConsolePayload>(
    "/api/workspace/checkpoints/restore",
    payload,
    { safetyConfirm: true },
  );
}

export async function getWorkspaceSessionBundle(sessionId: string): Promise<WorkspaceSessionBundle> {
  const [sessionData, context] = await Promise.all([
    getJson<WsSessionDetail>(`/api/agent-sessions/${encoded(sessionId)}?includeEvents=true&eventLimit=200`),
    getJson<WsSessionContext>(`/api/agent-sessions/${encoded(sessionId)}/context`),
  ]);
  return {
    sessionData: {
      ...sessionData,
      events: (Array.isArray(sessionData.events) ? sessionData.events : []).map((event?: any, index?: any) : any => ({
        ...event,
        eventId: String(event?.eventId || `event-${index}`),
        sequence: typeof event?.sequence === "number" || typeof event?.sequence === "string"
          ? event.sequence
          : index,
      })),
    },
    context,
  };
}

export function forkWorkspaceSession(sessionId: string) : any {
  return postJson<WorkspaceConsolePayload>(`/api/agent-sessions/${encoded(sessionId)}/fork`, {});
}

export function createWorkspace(payload: WorkspaceConsolePayload) : any {
  return postJson<WorkspaceConsolePayload>("/api/agent-workspaces", payload);
}

export function deleteWorkspace(workspaceId: string) : any {
  return deleteJson<WorkspaceConsolePayload>(`/api/agent-workspaces/${encoded(workspaceId)}`);
}

export function setWorkspaceParent(workspaceId: string, parentWorkspaceId: string | null) : any {
  return postJson<WorkspaceConsolePayload>(
    `/api/agent-workspaces/${encoded(workspaceId)}/parent`,
    { parentWorkspaceId },
  );
}

export function updateWorkspaceProfile(workspaceId: string, payload: WorkspaceProfilePatch) : any {
  return postJson<WorkspaceConsolePayload>(`/api/agent-workspaces/${encoded(workspaceId)}/profile`, payload);
}

export function updateWorkspaceShare(workspaceId: string, action: "share" | "unshare", targetWorkspaceId: string) : any {
  return postJson<WorkspaceConsolePayload>(
    `/api/agent-workspaces/${encoded(workspaceId)}/${action}`,
    { targetWorkspaceId },
  );
}

export function listWorkspaceAssets(params: WorkspaceAssetQuery) : any {
  return getJson<WorkspaceConsolePayload>(`/api/workspace/assets?${buildQuery(params)}`);
}

export function readWorkspaceAsset(params: WorkspaceAssetQuery) : any {
  return getJson<WorkspaceConsolePayload>(`/api/workspace/assets/read?${buildQuery(params)}`);
}

export function submitWorkspaceAsset(payload: WorkspaceConsolePayload) : any {
  return postJson<WorkspaceConsolePayload>("/api/workspace/assets/submit", payload);
}

export function getWorkspaceAssetReceipts(payload: WorkspaceConsolePayload) : any {
  return postJson<WorkspaceConsolePayload>("/api/workspace/assets/receipts/get", payload);
}

export function backfillWorkspaceAssets(payload: WorkspaceConsolePayload) : any {
  return postJson<WorkspaceConsolePayload>("/api/workspace/assets/backfill", payload);
}

export function queryWorkspaceAudit(params: WorkspaceAssetQuery) : any {
  return getJson<WorkspaceConsolePayload>(`/api/workspace/audit?${buildQuery(params)}`);
}

export function listWorkspaceOperationHistory(params: WorkspaceAssetQuery) : any {
  return getJson<WorkspaceConsolePayload>(`/api/workspace/operations/history?${buildQuery(params)}`);
}

export function previewWorkspaceOperationRevert(payload: WorkspaceConsolePayload) : any {
  return postJson<WorkspaceConsolePayload>("/api/workspace/operations/revert/scope", payload);
}

export function applyWorkspaceOperationRevert(payload: WorkspaceConsolePayload) : any {
  return postJson<WorkspaceConsolePayload>("/api/workspace/operations/revert/apply", payload, {
    safetyConfirm: true,
  });
}
