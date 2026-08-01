
import {
  authorizeToolSkillScopes,
  normalizeAgentSubscriptionInput,
  publishProtocolEvent,
  result
} from "./shared.ts";

export function defaultAgentSyncPolicy() : any {
  return {
    async loadAgentSyncConfig() : Promise<any> {
      return { topics: [] };
    },
    async saveAgentSyncConfig() : Promise<any> {
      return { topics: [] };
    },
    normalizeAgentSyncTopic(value?: any) : any {
      return String(value || "").trim();
    },
    filterRequestedSubscriptionTopics(_config?: any, requestedTopics: any = []) : any {
      const requested: any = requestedTopics.map((topic?: any) : any => String(topic || "").trim()).filter(Boolean);
      return {
        denyAll: false,
        requested,
        topics: requested
      };
    },
    filterAgentSyncSubscriptionResult(_config?: any, result: Record<string, any> = {}) : any {
      return result;
    },
    async publishAgentSyncEvent() : Promise<any> {
      return {
        ok: false,
        status: 404,
        error: "agent_sync feature is not active in this feature edition."
      };
    }
  };
}

export async function loadAgentSyncPolicy(context: Record<string, any> = {}) : Promise<any> {
  if (!context.agentSyncFeatureActive) {
    return defaultAgentSyncPolicy();
  }
  return import("@meshrix/protocols/agent-sync/policy");
}


export async function executeAgentSyncOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  const handledOperations: any = new Set<any>([
    "events.subscribe",
    "agent_sync.config.get",
    "agent_sync.config.set",
    "agent_sync.publish",
    "agent_sync.subscribe"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  const policy: any = await loadAgentSyncPolicy(context);
  const protocolEventBus: any = context.protocolEventBus;

  if (id === "agent_sync.config.get") {
    return result(200, {
      config: await policy.loadAgentSyncConfig(context.userDataPath)
    });
  }

  if (id === "agent_sync.config.set") {
    const saved: any = await policy.saveAgentSyncConfig(
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
    const authorization: any = await authorizeToolSkillScopes({
      provider: context.toolSkillManagementProvider,
      request: context.request,
      scopes: ["agent_sync:publish"]
    });
    if (!authorization.ok) {
      return result(authorization.status || 403, {
        error: authorization.error || "工具权限不足。"
      });
    }
    const publishResult: any = await policy.publishAgentSyncEvent({
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

  const subscriptionInput: any = normalizeAgentSubscriptionInput(input);
  const config: any = await policy.loadAgentSyncConfig(context.userDataPath);
  const cursor: any = subscriptionInput.cursor;
  const includeSnapshot: any = subscriptionInput.includeSnapshot;
  const timeoutMs: any = subscriptionInput.timeoutMs;
  const limit: any = subscriptionInput.limit;

  if (id === "events.subscribe") {
    const topicFilter: any = policy.filterRequestedSubscriptionTopics(config, subscriptionInput.topics || []);
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
    const abortController: any = new AbortController();
    context.response?.once?.("close", () : any => abortController.abort());
    const subscriptionResult: any = await protocolEventBus.subscribe({
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

  const requested: any = (subscriptionInput.topics || []).map((topic?: any) : any => policy.normalizeAgentSyncTopic(topic));
  const topicFilter: any = policy.filterRequestedSubscriptionTopics(config, requested);
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
  const abortController: any = new AbortController();
  context.response?.once?.("close", () : any => abortController.abort());
  const subscriptionResult: any = await protocolEventBus.subscribe({
    cursor,
    topics: topicFilter.topics.length > 0
      ? topicFilter.topics
      : config.topics.filter((topic?: any) : any => topic.enabled).map((topic?: any) : any => topic.topic),
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
