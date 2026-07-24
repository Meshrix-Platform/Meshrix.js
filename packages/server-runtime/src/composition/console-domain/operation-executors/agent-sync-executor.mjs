
import {
  authorizeToolSkillScopes,
  normalizeAgentSubscriptionInput,
  publishProtocolEvent,
  result
} from "./shared.mjs";

export function defaultAgentSyncPolicy() {
  return {
    async loadAgentSyncConfig() {
      return { topics: [] };
    },
    async saveAgentSyncConfig() {
      return { topics: [] };
    },
    normalizeAgentSyncTopic(value) {
      return String(value || "").trim();
    },
    filterRequestedSubscriptionTopics(_config, requestedTopics = []) {
      const requested = requestedTopics.map((topic) => String(topic || "").trim()).filter(Boolean);
      return {
        denyAll: false,
        requested,
        topics: requested
      };
    },
    filterAgentSyncSubscriptionResult(_config, result = {}) {
      return result;
    },
    async publishAgentSyncEvent() {
      return {
        ok: false,
        status: 404,
        error: "agent_sync feature is not active in this feature edition."
      };
    }
  };
}

export async function loadAgentSyncPolicy(context = {}) {
  if (!context.agentSyncFeatureActive) {
    return defaultAgentSyncPolicy();
  }
  return import("@meshrix/protocols/agent-sync/policy");
}


export async function executeAgentSyncOperation({ operationId, input = {}, context }) {
  const id = String(operationId || "");
  const handledOperations = new Set([
    "events.subscribe",
    "agent_sync.config.get",
    "agent_sync.config.set",
    "agent_sync.publish",
    "agent_sync.subscribe"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  const policy = await loadAgentSyncPolicy(context);
  const protocolEventBus = context.protocolEventBus;

  if (id === "agent_sync.config.get") {
    return result(200, {
      config: await policy.loadAgentSyncConfig(context.userDataPath)
    });
  }

  if (id === "agent_sync.config.set") {
    const saved = await policy.saveAgentSyncConfig(
      context.userDataPath,
      input.value || input.config || input
    );
    await publishProtocolEvent(
      protocolEventBus,
      "agent_sync.config",
      saved,
      { type: "agent_sync.config.updated" }
    );
    return result(200, { config: saved });
  }

  if (id === "agent_sync.publish") {
    const authorization = await authorizeToolSkillScopes({
      provider: context.toolSkillManagementProvider,
      request: context.request,
      scopes: ["agent_sync:publish"]
    });
    if (!authorization.ok) {
      return result(authorization.status || 403, {
        error: authorization.error || "工具权限不足。"
      });
    }
    const publishResult = await policy.publishAgentSyncEvent({
      userDataPath: context.userDataPath,
      protocolEventBus,
      input,
      grant: authorization.grant
    });
    if (!publishResult.ok) {
      return result(publishResult.status || 400, {
        error: publishResult.error || "发布智能体同步事件失败。"
      });
    }
    return result(200, publishResult);
  }

  if (!protocolEventBus || typeof protocolEventBus.subscribe !== "function") {
    return result(503, { error: "事件总线不可用。" });
  }

  const subscriptionInput = normalizeAgentSubscriptionInput(input);
  const config = await policy.loadAgentSyncConfig(context.userDataPath);
  const cursor = subscriptionInput.cursor;
  const includeSnapshot = subscriptionInput.includeSnapshot;
  const timeoutMs = subscriptionInput.timeoutMs;
  const limit = subscriptionInput.limit;

  if (id === "events.subscribe") {
    const topicFilter = policy.filterRequestedSubscriptionTopics(config, subscriptionInput.topics || []);
    if (topicFilter.denyAll) {
      return result(200, {
        cursor,
        nextCursor: cursor,
        topics: topicFilter.topics,
        requestedTopics: topicFilter.requested,
        events: [],
        snapshots: includeSnapshot ? [] : undefined
      });
    }
    const abortController = new AbortController();
    context.response?.once?.("close", () => abortController.abort());
    const subscriptionResult = await protocolEventBus.subscribe({
      cursor,
      topics: topicFilter.topics,
      timeoutMs,
      limit,
      includeSnapshot,
      signal: context.request?.aborted ? AbortSignal.abort() : abortController.signal
    });
    if (context.response?.destroyed) {
      return result(200, { __responseHandled: true });
    }
    return result(200, {
      ...policy.filterAgentSyncSubscriptionResult(config, subscriptionResult),
      requestedTopics: topicFilter.requested
    });
  }

  const requested = (subscriptionInput.topics || []).map((topic) => policy.normalizeAgentSyncTopic(topic));
  const topicFilter = policy.filterRequestedSubscriptionTopics(config, requested);
  if (topicFilter.denyAll) {
    return result(200, {
      cursor,
      nextCursor: cursor,
      topics: [],
      requestedTopics: topicFilter.requested,
      events: [],
      snapshots: includeSnapshot ? [] : undefined
    });
  }
  const abortController = new AbortController();
  context.response?.once?.("close", () => abortController.abort());
  const subscriptionResult = await protocolEventBus.subscribe({
    cursor,
    topics: topicFilter.topics.length > 0
      ? topicFilter.topics
      : config.topics.filter((topic) => topic.enabled).map((topic) => topic.topic),
    timeoutMs,
    limit,
    includeSnapshot,
    signal: context.request?.aborted ? AbortSignal.abort() : undefined
  });
  if (context.response?.destroyed) {
    return result(200, { __responseHandled: true });
  }
  return result(200, {
    ...policy.filterAgentSyncSubscriptionResult(config, subscriptionResult),
    requestedTopics: topicFilter.requested
  });
}
