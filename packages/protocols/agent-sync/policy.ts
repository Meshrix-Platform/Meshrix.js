import fs from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  queueStateMutation,
  waitForStateIdle
} from "#meshrix/state-coordinator";

export const AGENT_SYNC_SCHEMA_VERSION = "v0.0.1:agent:sync-schema-1";
export const AGENT_SYNC_PREFIX = "agent.sync.";

export interface AgentSyncTopicRule {
  topic: string;
  label: string;
  description: string;
  enabled: boolean;
  retain: boolean;
}

export interface AgentSyncConfig {
  schemaVersion: typeof AGENT_SYNC_SCHEMA_VERSION;
  enabled: boolean;
  defaultTopicEnabled: boolean;
  updatedAt: string;
  topics: AgentSyncTopicRule[];
}

type UnknownRecord = Record<string, unknown>;

interface ProtocolEventBus {
  publish(topic: string, payload: UnknownRecord, options: UnknownRecord): Promise<unknown>;
}

interface PublishAgentSyncOptions {
  userDataPath?: string;
  protocolEventBus?: ProtocolEventBus | null;
  input?: UnknownRecord;
  grant?: { id?: string } | null;
}

const DEFAULT_TOPICS: AgentSyncTopicRule[] = [
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

function nowIso(): string {
  return new Date().toISOString();
}

export function getAgentSyncConfigPath(userDataPath = ""): string {
  return path.join(userDataPath, "agent-sync.json");
}

function agentSyncConfigStateKey(userDataPath = ""): string {
  return `agent-sync-config:${path.resolve(userDataPath)}`;
}

export function isAgentSyncTopic(topic?: unknown): boolean {
  return String(topic || "").trim().startsWith(AGENT_SYNC_PREFIX);
}

export function normalizeAgentSyncTopic(value?: unknown): string {
  const raw = String(value || "").trim();
  const topic = raw.startsWith(AGENT_SYNC_PREFIX) ? raw : `${AGENT_SYNC_PREFIX}${raw}`;
  if (!/^agent\.sync\.[A-Za-z0-9_.:-]{1,160}$/.test(topic)) {
    throw new Error(`非法智能体同步 topic：${raw || "(empty)"}`);
  }
  return topic;
}

function normalizeTopicRule(input: UnknownRecord = {}): AgentSyncTopicRule {
  const defaults = DEFAULT_TOPICS.find((item) => item.topic === input.topic);
  const topic = normalizeAgentSyncTopic(input.topic || defaults?.topic || "");
  return {
    topic,
    label: String(input.label || defaults?.label || topic).trim(),
    description: String(input.description || defaults?.description || "").trim(),
    enabled: input.enabled === undefined ? defaults?.enabled !== false : input.enabled !== false,
    retain: input.retain === undefined ? defaults?.retain === true : input.retain === true
  };
}

export function normalizeAgentSyncConfig(input: UnknownRecord = {}): AgentSyncConfig {
  const incomingTopics = Array.isArray(input.topics) ? input.topics : [];
  const byTopic = new Map<string, AgentSyncTopicRule>(DEFAULT_TOPICS.map((item) => [item.topic, normalizeTopicRule({ ...item })]));
  for (const item of incomingTopics) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const normalized = normalizeTopicRule(item as UnknownRecord);
    byTopic.set(normalized.topic, normalized);
  }

  return {
    schemaVersion: AGENT_SYNC_SCHEMA_VERSION,
    enabled: input.enabled === undefined ? true : input.enabled !== false,
    defaultTopicEnabled: input.defaultTopicEnabled === true,
    updatedAt: typeof input.updatedAt === "string" && input.updatedAt ? input.updatedAt : nowIso(),
    topics: [...byTopic.values()].sort((left, right) => left.topic.localeCompare(right.topic))
  };
}

async function loadAgentSyncConfigUnlocked(userDataPath = ""): Promise<AgentSyncConfig> {
  try {
    const raw = await fs.readFile(getAgentSyncConfigPath(userDataPath), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return normalizeAgentSyncConfig(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as UnknownRecord : {});
  } catch (error: unknown) {
    if (error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT") {
      return normalizeAgentSyncConfig();
    }
    throw error;
  }
}

export async function loadAgentSyncConfig(userDataPath = ""): Promise<AgentSyncConfig> {
  await waitForStateIdle(agentSyncConfigStateKey(userDataPath));
  return loadAgentSyncConfigUnlocked(userDataPath);
}

async function saveAgentSyncConfigUnlocked(userDataPath = "", input: UnknownRecord = {}): Promise<AgentSyncConfig> {
  const configPath = getAgentSyncConfigPath(userDataPath);
  const normalized = normalizeAgentSyncConfig({
    ...input,
    updatedAt: nowIso()
  });
  await atomicWriteJson(configPath, normalized);
  return normalized;
}

export async function saveAgentSyncConfig(userDataPath = "", input: UnknownRecord = {}): Promise<AgentSyncConfig> {
  return queueStateMutation(agentSyncConfigStateKey(userDataPath), () =>
    saveAgentSyncConfigUnlocked(userDataPath, input)
  );
}

export function getAgentSyncRule(config: AgentSyncConfig, topic?: unknown): AgentSyncTopicRule {
  const normalizedTopic = normalizeAgentSyncTopic(topic);
  return config.topics.find((item) => item.topic === normalizedTopic) || {
    topic: normalizedTopic,
    label: normalizedTopic,
    description: "",
    enabled: config.defaultTopicEnabled === true,
    retain: false
  };
}

export function isAgentSyncTopicEnabled(config: AgentSyncConfig, topic?: unknown): boolean {
  if (!config.enabled) {
    return false;
  }
  return getAgentSyncRule(config, topic).enabled === true;
}

export function filterAgentSyncEvents<T extends { topic?: unknown }>(config: AgentSyncConfig, events: readonly T[] = []): T[] {
  return events.filter((event) => {
    if (!isAgentSyncTopic(event.topic)) {
      return true;
    }
    return isAgentSyncTopicEnabled(config, event.topic);
  });
}

export function filterRequestedSubscriptionTopics(config: AgentSyncConfig, topics: readonly unknown[] = []) {
  const requested = [...new Set(topics.map((item) => String(item || "").trim()).filter(Boolean))];
  if (requested.length === 0) {
    return {
      requested,
      topics: [],
      denyAll: false
    };
  }
  const allowed = requested.filter((topic) => {
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

export function filterAgentSyncSubscriptionResult<T extends { events?: Array<{ topic?: unknown }>; snapshots?: Array<{ topic?: unknown }> }>(
  config: AgentSyncConfig,
  result: T
) {
  return {
    ...result,
    events: filterAgentSyncEvents(config, result.events || []),
    snapshots: result.snapshots
      ? filterAgentSyncEvents(config, result.snapshots || [])
      : result.snapshots
  };
}

export function normalizeAgentSyncPublishInput(input: UnknownRecord = {}) {
  const topic = normalizeAgentSyncTopic(input.topic || input.syncTopic || "");
  const payload =
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
}: PublishAgentSyncOptions = {}) {
  if (!protocolEventBus || typeof protocolEventBus.publish !== "function") {
    return { ok: false, status: 503, error: "事件总线不可用。" };
  }
  const config = await loadAgentSyncConfig(userDataPath);
  if (!config.enabled) {
    return { ok: false, status: 403, error: "智能体同步已关闭。" };
  }
  const publishInput = normalizeAgentSyncPublishInput(input);
  const rule = getAgentSyncRule(config, publishInput.topic);
  if (rule.enabled !== true) {
    return {
      ok: false,
      status: 403,
      error: `智能体同步 topic 未启用：${publishInput.topic}`
    };
  }

  const event = await protocolEventBus.publish(
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
