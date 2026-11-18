export type WsWorkspace = {
  workspaceId: string;
  title?: string;
  objective?: string;
  status: string;
  updatedAt: string;
  parentWorkspaceId?: string;
  currentGeneration: number;
  ownedSourceIds: string[];
  accessibleWorkspaceIds: string[];
  summary: {
    sessionCount: number;
    [key: string]: unknown;
  };
  profile?: {
    contextProfileId?: string;
    toolGrantId?: string;
    modelAlias?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type WsSession = {
  sessionId: string;
  workspaceId: string;
  title?: string;
  objective?: string;
  parentSessionId?: string;
  branchIndex?: number;
  eventCount?: number;
  createdAt?: string;
  updatedAt?: string;
  lastEvent?: {
    createdAt?: string;
    summary?: string;
    [key: string]: unknown;
  };
  workspace?: {
    title?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type WsSessionDetail = WsSession & {
  events: Array<{
    eventId: string;
    sequence: string | number;
    title?: string;
    type?: string;
    createdAt?: string;
    [key: string]: unknown;
  }>;
};

export type WsSessionContext = {
  workspaceId?: string;
  agentSessionId?: string;
  sessionEventCount?: number;
  parentSessionId?: string;
  forkedFromEventId?: string;
  contextProfileId?: string;
  toolGrantId?: string;
  modelAlias?: string;
  [key: string]: unknown;
};

export type WsCheckpointNode = {
  nodeId: string;
  label?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: {
    workspaceFileSnapshot?: {
      files?: unknown[];
      basePath?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type WsCheckpointTreeSummary = {
  treeId: string;
  title?: string;
  status?: string;
  nodeCount?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

export type WsCheckpointTreeDetail = WsCheckpointTreeSummary & {
  nodes?: Record<string, WsCheckpointNode>;
};
