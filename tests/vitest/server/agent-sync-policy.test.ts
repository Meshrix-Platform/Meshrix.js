import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_SYNC_PREFIX,
  AGENT_SYNC_SCHEMA_VERSION,
  filterAgentSyncEvents,
  filterAgentSyncSubscriptionResult,
  filterRequestedSubscriptionTopics,
  getAgentSyncConfigPath,
  getAgentSyncRule,
  isAgentSyncTopic,
  isAgentSyncTopicEnabled,
  loadAgentSyncConfig,
  normalizeAgentSyncConfig,
  normalizeAgentSyncPublishInput,
  normalizeAgentSyncTopic,
  publishAgentSyncEvent,
  saveAgentSyncConfig
} from "../../../packages/protocols/agent-sync/policy.ts";

const tempRoots: any[] = [];

async function tempDir() : Promise<any> {
  const dir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-agent-sync-policy-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () : Promise<any> => {
  await Promise.all(tempRoots.splice(0).map((dir?: any) : any => fs.rm(dir, { recursive: true, force: true })));
});

describe("agent sync policy", () : any => {
  it("normalizes topics and config defaults with overrides", () : any => {
    expect(AGENT_SYNC_PREFIX).toBe("agent.sync.");
    expect(isAgentSyncTopic(" agent.sync.answer ")).toBe(true);
    expect(isAgentSyncTopic("agent.other")).toBe(false);
    expect(normalizeAgentSyncTopic("status")).toBe("agent.sync.status");
    expect(normalizeAgentSyncTopic("agent.sync.custom:topic-1")).toBe("agent.sync.custom:topic-1");
    expect(() : any => normalizeAgentSyncTopic("bad topic")).toThrow("非法智能体同步 topic");

    const config: any = normalizeAgentSyncConfig({
      enabled: false,
      defaultTopicEnabled: true,
      updatedAt: "2026-06-04T00:00:00.000Z",
      topics: [
        { topic: "answer", label: " Answer ", enabled: false, retain: false },
        { topic: "custom", description: "Custom topic", enabled: true, retain: true }
      ]
    });

    expect(config).toMatchObject({
      schemaVersion: AGENT_SYNC_SCHEMA_VERSION,
      enabled: false,
      defaultTopicEnabled: true,
      updatedAt: "2026-06-04T00:00:00.000Z"
    });
    expect(config.topics.map((item?: any) : any => item.topic)).toEqual([...config.topics.map((item?: any) : any => item.topic)].sort());
    expect(getAgentSyncRule(config, "answer")).toMatchObject({
      topic: "agent.sync.answer",
      label: "Answer",
      enabled: false,
      retain: false
    });
    expect(getAgentSyncRule(config, "unknown")).toMatchObject({
      topic: "agent.sync.unknown",
      enabled: true,
      retain: false
    });
    expect(isAgentSyncTopicEnabled(config, "custom")).toBe(false);
  });

  it("loads default config, saves normalized config, and propagates corrupt JSON errors", async () : Promise<any> => {
    const root: any = await tempDir();

    const missing: any = await loadAgentSyncConfig(root);
    expect(missing.enabled).toBe(true);
    expect(missing.topics.some((item?: any) : any => item.topic === "agent.sync.answer")).toBe(true);

    const saved: any = await saveAgentSyncConfig(root, {
      topics: [{ topic: "risk", enabled: true, retain: true }]
    });
    expect(saved.topics.find((item?: any) : any => item.topic === "agent.sync.risk")).toMatchObject({
      enabled: true,
      retain: true
    });
    expect(JSON.parse(await fs.readFile(getAgentSyncConfigPath(root), "utf8"))).toMatchObject({
      schemaVersion: AGENT_SYNC_SCHEMA_VERSION
    });

    await fs.writeFile(getAgentSyncConfigPath(root), "{bad json", "utf8");
    await expect(loadAgentSyncConfig(root)).rejects.toThrow();
  });

  it("filters events, subscription requests, snapshots, and publish inputs", () : any => {
    const config: any = normalizeAgentSyncConfig({
      defaultTopicEnabled: false,
      topics: [
        { topic: "answer", enabled: true, retain: true },
        { topic: "debug", enabled: false }
      ]
    });
    const events: any[] = [
      { topic: "agent.sync.answer", id: "answer" },
      { topic: "agent.sync.debug", id: "debug" },
      { topic: "external.topic", id: "external" }
    ];

    expect(filterAgentSyncEvents(config, events).map((event?: any) : any => event.id)).toEqual(["answer", "external"]);
    expect(filterRequestedSubscriptionTopics(config, [" agent.sync.answer ", "agent.sync.answer", "agent.sync.debug"])).toEqual({
      requested: ["agent.sync.answer", "agent.sync.debug"],
      topics: ["agent.sync.answer"],
      denyAll: false
    });
    expect(filterRequestedSubscriptionTopics(config, ["agent.sync.debug"])).toEqual({
      requested: ["agent.sync.debug"],
      topics: [],
      denyAll: true
    });
    expect(filterRequestedSubscriptionTopics(config, [])).toEqual({
      requested: [],
      topics: [],
      denyAll: false
    });
    expect(filterAgentSyncSubscriptionResult(config, {
      events,
      snapshots: events
    })).toEqual({
      events: [{ topic: "agent.sync.answer", id: "answer" }, { topic: "external.topic", id: "external" }],
      snapshots: [{ topic: "agent.sync.answer", id: "answer" }, { topic: "external.topic", id: "external" }]
    });
    expect(filterAgentSyncSubscriptionResult(config, { events })).toEqual({
      events: [{ topic: "agent.sync.answer", id: "answer" }, { topic: "external.topic", id: "external" }],
      snapshots: undefined
    });

    expect(normalizeAgentSyncPublishInput({
      syncTopic: "progress",
      data: { step: 1 },
      type: "",
      agentName: " Agent ",
      clientId: " client-a ",
      sessionId: " session-a ",
      userId: " user-a ",
      projectId: " project-a ",
      retain: false
    })).toEqual({
      topic: "agent.sync.progress",
      type: "agent_sync.message",
      payload: { step: 1 },
      agentName: "Agent",
      clientId: "client-a",
      sessionId: "session-a",
      userId: "user-a",
      projectId: "project-a",
      retain: false
    });
  });

  it("publishes enabled topics and rejects unavailable, disabled, or unconfigured topics", async () : Promise<any> => {
    const root: any = await tempDir();
    const publish: any = async (topic?: any, payload?: any, options?: any) : Promise<any> => ({ id: `event:${topic}`, topic, payload, options });
    const protocolEventBus: Record<string, any> = { publish };

    await expect(publishAgentSyncEvent({ userDataPath: root })).resolves.toEqual({
      ok: false,
      status: 503,
      error: "事件总线不可用。"
    });

    await saveAgentSyncConfig(root, { enabled: false });
    await expect(publishAgentSyncEvent({
      userDataPath: root,
      protocolEventBus,
      input: { topic: "answer" }
    })).resolves.toEqual({
      ok: false,
      status: 403,
      error: "智能体同步已关闭。"
    });

    await saveAgentSyncConfig(root, {
      enabled: true,
      topics: [{ topic: "risk", enabled: false }]
    });
    await expect(publishAgentSyncEvent({
      userDataPath: root,
      protocolEventBus,
      input: { topic: "risk" }
    })).resolves.toEqual({
      ok: false,
      status: 403,
      error: "智能体同步 topic 未启用：agent.sync.risk"
    });

    await saveAgentSyncConfig(root, {
      enabled: true,
      topics: [{ topic: "answer", enabled: true, retain: true }]
    });
    const result: any = await publishAgentSyncEvent({
      userDataPath: root,
      protocolEventBus,
      input: {
        topic: "answer",
        payload: { text: "hello" },
        agentName: "Agent",
        clientId: "client-a",
        sessionId: "session-a",
        userId: "user-a",
        projectId: "project-a",
        type: "agent.answer"
      },
      grant: { id: "grant-1" }
    });

    expect(result).toEqual({
      ok: true,
      event: {
        id: "event:agent.sync.answer",
        topic: "agent.sync.answer",
        payload: {
          schemaVersion: AGENT_SYNC_SCHEMA_VERSION,
          source: "agent",
          agentName: "Agent",
          clientId: "client-a",
          sessionId: "session-a",
          userId: "user-a",
          projectId: "project-a",
          grantId: "grant-1",
          payload: { text: "hello" }
        },
        options: {
          type: "agent.answer",
          publisher: "agent:grant-1",
          retain: true
        }
      },
      policy: {
        topic: "agent.sync.answer",
        retain: true
      }
    });
  });
});
