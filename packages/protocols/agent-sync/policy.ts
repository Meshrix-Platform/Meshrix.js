import fs from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  queueStateMutation,
  waitForStateIdle
} from "#meshrix/state-coordinator";

export const AGENT_SYNC_SCHEMA_VERSION: any = "v0.0.1:agent:sync-schema-1";
export const AGENT_SYNC_PREFIX: any = "agent.sync.";

const DEFAULT_TOPICS: any[] = [
  {
    topic: "agent.sync.answer",
    label: "智能体回答",
    description: "智能体面向客户端展示的最终回答或增量回答。",
    enabled: true,
    retain: true
  },
  {
    topic: "agent.sync.status",
    label: "智能体状态",
    description: "智能体运行状态、阶段和节点变化。",
    enabled: true,
    retain: true
  },
  {
    topic: "agent.sync.progress",
    label: "智能体进度",
    description: "任务进度、步骤进展和非最终中间状态。",
    enabled: true,
    retain: false
  },
  {
    topic: "agent.sync.risk",
    label: "风险提示",
    description: "需要人工感知的风险、拦截或安全提示。",
    enabled: false,
    retain: false
  },
  {
    topic: "agent.sync.debug",
    label: "调试信息",
    description: "智能体内部调试日志，默认不同步到客户端。",
    enabled: false,
    retain: false
  }
];

function nowIso() : any {
  return new Date().toISOString();
}

export function getAgentSyncConfigPath(userDataPath?: any) : any {
  return path.join(userDataPath, "agent-sync.json");
}

function agentSyncConfigStateKey(userDataPath?: any) : any {
  return `agent-sync-config:${path.resolve(userDataPath)}`;
}

export function isAgentSyncTopic(topic?: any) : any {
  return String(topic || "").trim().startsWith(AGENT_SYNC_PREFIX);
}

export function normalizeAgentSyncTopic(value?: any) : any {
  const raw: any = String(value || "").trim();
  const topic: any = raw.startsWith(AGENT_SYNC_PREFIX) ? raw : `${AGENT_SYNC_PREFIX}${raw}`;
  if (!/^agent\.sync\.[A-Za-z0-9_.:-]{1,160}$/.test(topic)) {
    throw new Error(`非法智能体同步 topic：${raw || "(empty)"}`);
  }
  return topic;
}

function normalizeTopicRule(input: Record<string, any> = {}) : any {
  const defaults: any = DEFAULT_TOPICS.find((item?: any) : any => item.topic === input.topic) || {};
  const topic: any = normalizeAgentSyncTopic(input.topic || defaults.topic || "");
  return {
    topic,
    label: String(input.label || defaults.label || topic).trim(),
    description: String(input.description || defaults.description || "").trim(),
    enabled: input.enabled === undefined ? defaults.enabled !== false : input.enabled !== false,
    retain: input.retain === undefined ? defaults.retain === true : input.retain === true
  };
}

export function normalizeAgentSyncConfig(input: Record<string, any> = {}) : any {
  const incomingTopics: any = Array.isArray(input.topics) ? input.topics : [];
  const byTopic: any = new Map<any, any>(DEFAULT_TOPICS.map((item?: any) : any => [item.topic, normalizeTopicRule(item)]));
  for (const item of incomingTopics) {
    const normalized: any = normalizeTopicRule(item);
    byTopic.set(normalized.topic, normalized);
  }

  return {
    schemaVersion: AGENT_SYNC_SCHEMA_VERSION,
    enabled: input.enabled === undefined ? true : input.enabled !== false,
    defaultTopicEnabled: input.defaultTopicEnabled === true,
    updatedAt: input.updatedAt || nowIso(),
    topics: [...byTopic.values()].sort((left?: any, right?: any) : any => left.topic.localeCompare(right.topic))
  };
}

async function loadAgentSyncConfigUnlocked(userDataPath?: any) : Promise<any> {
  try {
    const raw: any = await fs.readFile(getAgentSyncConfigPath(userDataPath), "utf8");
    return normalizeAgentSyncConfig(JSON.parse(raw));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return normalizeAgentSyncConfig();
    }
    throw error;
  }
}

export async function loadAgentSyncConfig(userDataPath?: any) : Promise<any> {
  await waitForStateIdle(agentSyncConfigStateKey(userDataPath));
  return loadAgentSyncConfigUnlocked(userDataPath);
}

async function saveAgentSyncConfigUnlocked(userDataPath?: any, input: Record<string, any> = {}) : Promise<any> {
  const configPath: any = getAgentSyncConfigPath(userDataPath);
  const normalized: any = normalizeAgentSyncConfig({
    ...input,
    updatedAt: nowIso()
  });
  await atomicWriteJson(configPath, normalized);
  return normalized;
}

export async function saveAgentSyncConfig(userDataPath?: any, input: Record<string, any> = {}) : Promise<any> {
  return queueStateMutation(agentSyncConfigStateKey(userDataPath), () : any =>
    saveAgentSyncConfigUnlocked(userDataPath, input)
  );
}

export function getAgentSyncRule(config?: any, topic?: any) : any {
  const normalizedTopic: any = normalizeAgentSyncTopic(topic);
  return config.topics.find((item?: any) : any => item.topic === normalizedTopic) || {
    topic: normalizedTopic,
    label: normalizedTopic,
    description: "",
    enabled: config.defaultTopicEnabled === true,
    retain: false
  };
}

export function isAgentSyncTopicEnabled(config?: any, topic?: any) : any {
  if (!config.enabled) {
    return false;
  }
  return getAgentSyncRule(config, topic).enabled === true;
}

export function filterAgentSyncEvents(config?: any, events: any = []) : any {
  return events.filter((event?: any) : any => {
    if (!isAgentSyncTopic(event.topic)) {
      return true;
    }
    return isAgentSyncTopicEnabled(config, event.topic);
  });
}

export function filterRequestedSubscriptionTopics(config?: any, topics: any = []) : any {
  const requested: any[] = [...new Set<any>((topics || []).map((item?: any) : any => String(item || "").trim()).filter(Boolean))];
  if (requested.length === 0) {
    return {
      requested,
      topics: [],
      denyAll: false
    };
  }
  const allowed: any = requested.filter((topic?: any) : any => {
    if (!isAgentSyncTopic(topic)) {
      return true;
    }
    return isAgentSyncTopicEnabled(config, topic);
  });
  return {
    requested,
    topics: allowed,
    denyAll: allowed.length === 0
  };
}

export function filterAgentSyncSubscriptionResult(config?: any, result: Record<string, any> = {}) : any {
  return {
    ...result,
    events: filterAgentSyncEvents(config, result.events || []),
    snapshots: result.snapshots
      ? filterAgentSyncEvents(config, result.snapshots || [])
      : result.snapshots
  };
}

export function normalizeAgentSyncPublishInput(input: Record<string, any> = {}) : any {
  const topic: any = normalizeAgentSyncTopic(input.topic || input.syncTopic || "");
  const payload: any =
    input.payload !== undefined
      ? input.payload
      : input.data !== undefined
        ? input.data
        : {};
  return {
    topic,
    type: String(input.type || "agent_sync.message").trim() || "agent_sync.message",
    payload,
    agentName: String(input.agentName || "").trim(),
    clientId: String(input.clientId || "").trim(),
    sessionId: String(input.sessionId || "").trim(),
    userId: String(input.userId || "").trim(),
    projectId: String(input.projectId || "").trim(),
    retain: input.retain
  };
}

export async function publishAgentSyncEvent({
  userDataPath,
  protocolEventBus,
  input = {},
  grant = null
}: Record<string, any> = {}) : Promise<any> {
  if (!protocolEventBus || typeof protocolEventBus.publish !== "function") {
    return { ok: false, status: 503, error: "事件总线不可用。" };
  }
  const config: any = await loadAgentSyncConfig(userDataPath);
  if (!config.enabled) {
    return { ok: false, status: 403, error: "智能体同步已关闭。" };
  }
  const publishInput: any = normalizeAgentSyncPublishInput(input);
  const rule: any = getAgentSyncRule(config, publishInput.topic);
  if (rule.enabled !== true) {
    return {
      ok: false,
      status: 403,
      error: `智能体同步 topic 未启用：${publishInput.topic}`
    };
  }

  const event: any = await protocolEventBus.publish(
    publishInput.topic,
    {
      schemaVersion: AGENT_SYNC_SCHEMA_VERSION,
      source: "agent",
      agentName: publishInput.agentName,
      clientId: publishInput.clientId,
      sessionId: publishInput.sessionId,
      userId: publishInput.userId,
      projectId: publishInput.projectId,
      grantId: grant?.id || "",
      payload: publishInput.payload
    },
    {
      type: publishInput.type,
      publisher: grant?.id ? `agent:${grant.id}` : "agent",
      retain:
        publishInput.retain === undefined ? rule.retain === true : publishInput.retain === true
    }
  );

  return {
    ok: true,
    event,
    policy: {
      topic: publishInput.topic,
      retain: publishInput.retain === undefined ? rule.retain === true : publishInput.retain === true
    }
  };
}
