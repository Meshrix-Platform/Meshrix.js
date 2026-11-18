import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canAccessJob } from "../../../packages/protocols/http/controllers/jobs-controller-access.ts";
import { createSystemControllerContexts } from "../../../packages/protocols/http/controllers/system-controller-contexts.ts";
import { createSystemControllerRuntimeHandlers } from "../../../packages/protocols/http/controllers/system-controller-runtime-handlers.ts";
import { executeAgentSyncOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/agent-sync-executor.ts";
import { serverToken } from "../../../packages/foundation/src/security/client-strings.ts";
import { hasUploadSessionOwnerAccess } from "../../../packages/server-runtime/src/state/upload-session-store.ts";
import { SESSION_SCHEMA_VERSION, saveSessionMeta } from "../../../packages/server-runtime/src/state/upload-session-support.ts";

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

  it("authorizes job events in the general subscription before returning them", async () : Promise<any> => {
    let returnedEvents: any[] = [];
    const events: any[] = [
      { topic: "jobs.job", payload: { job: { id: "job-a", ownerUserId: "user-a", ownerTenantId: "tenant-a" } } },
      { topic: "jobs.job", payload: { job: { id: "job-b", ownerUserId: "user-a", ownerTenantId: "tenant-b" } } }
    ];
    const context: Record<string, any> = {
      authSession: { user: { userId: "user-a", subjectId: "user-a", tenantId: "tenant-a" } },
      canAccessJob,
      protocolEventBus: {
        async subscribe(input?: any) : Promise<any> {
          returnedEvents = [];
          for (const event of events) {
            if (await input.authorizeEvent(event)) returnedEvents.push(event);
          }
          return { cursor: 0, nextCursor: 2, topics: ["jobs.job"], events: returnedEvents };
        }
      }
    };

    const result: any = await executeAgentSyncOperation({
      operationId: "events.subscribe",
      input: { topic: "jobs.job", cursor: 0 },
      context
    });

    expect(result.status).toBe(200);
    expect(returnedEvents.map((event?: any) : any => event.payload.job.id)).toEqual(["job-a"]);
  });

  it("authorizes upload events through agent-sync subscription even when its feature is inactive", async () : Promise<any> => {
    let returnedEvents: any[] = [];
    const events: any[] = [
      { topic: "uploads.session", payload: { session: { sessionId: "upload-a", files: [{ name: "private-a.txt" }] } } },
      { topic: "uploads.trace", payload: { sessionId: "upload-b", message: "synthetic trace" } },
      { topic: "uploads.trace", payload: { message: "trace without a resolvable session" } }
    ];
    const context: Record<string, any> = {
      agentSyncFeatureActive: false,
      authSession: { user: { userId: "user-a", subjectId: "user-a", tenantId: "tenant-a" } },
      canAccessUploadSession: async (sessionId?: any) : Promise<any> => sessionId === "upload-a",
      protocolEventBus: {
        async subscribe(input?: any) : Promise<any> {
          returnedEvents = [];
          for (const event of events) {
            if (await input.authorizeEvent(event)) returnedEvents.push(event);
          }
          return { cursor: 0, nextCursor: 2, topics: ["uploads.session"], events: returnedEvents };
        }
      }
    };

    const result: any = await executeAgentSyncOperation({
      operationId: "agent_sync.subscribe",
      input: { topic: "uploads.session", cursor: 0 },
      context
    });

    expect(result.status).toBe(200);
    expect(returnedEvents.map((event?: any) : any => event.payload.session?.sessionId || event.payload.sessionId))
      .toEqual(["upload-a"]);
  });

  it("preserves global administrator access to upload traces without a session id", async () : Promise<any> => {
    let returnedEvents: any[] = [];
    const events: any[] = [
      { topic: "uploads.trace", payload: { message: "trace before session creation" } },
      { topic: "uploads.trace", payload: { sessionId: "expired-session", message: "retained trace" } }
    ];
    const context: Record<string, any> = {
      agentSyncFeatureActive: false,
      authSession: { user: { roleId: "owner" } },
      canAccessAllUploadSessions: () : any => true,
      canAccessUploadSession: async () : Promise<any> => true,
      protocolEventBus: {
        async subscribe(input?: any) : Promise<any> {
          returnedEvents = [];
          for (const event of events) {
            if (await input.authorizeEvent(event)) returnedEvents.push(event);
          }
          return { cursor: 0, nextCursor: 2, topics: ["uploads.trace"], events: returnedEvents };
        }
      }
    };

    await executeAgentSyncOperation({
      operationId: "events.subscribe",
      input: { topic: "uploads.trace", cursor: 0 },
      context
    });

    expect(returnedEvents).toEqual(events);
  });

  it("binds event authorization to the authenticated HTTP request context", async () : Promise<any> => {
    const authSession: Record<string, any> = {
      user: { userId: "user-a", subjectId: "user-a", tenantId: "tenant-a" }
    };
    const contextBuilder: any = createSystemControllerContexts({
      userDataPath: "/synthetic-root",
      jobWorkflowProvider: {},
      uploadSessionStore: {
        resolveUploadSessionFiles: async () : Promise<any> => [],
        deleteUploadSession: async () : Promise<any> => undefined,
        hasUploadSessionOwnerAccess: async (sessionId?: any, options?: any) : Promise<any> =>
          sessionId === "upload-a" && options?.owner?.tenantId === "tenant-a"
      },
      settingsPort: {},
      discoveryPort: {},
      consoleDomainServices: {
        executeConsoleDomainOperation: async () : Promise<any> => null,
        uploadSessionStore: {
          resolveUploadSessionFiles: async () : Promise<any> => [],
          deleteUploadSession: async () : Promise<any> => undefined,
          hasUploadSessionOwnerAccess: async (sessionId?: any, options?: any) : Promise<any> =>
            sessionId === "upload-a" && options?.owner?.tenantId === "tenant-a"
        }
      }
    });
    const runtimeContext: any = contextBuilder.runtimeWorkflowContext(authSession);
    const calls: any[] = [];
    const handlers: any = createSystemControllerRuntimeHandlers({
      sendConsoleDomainOperation: async (input?: any) : Promise<any> => calls.push(input),
      runtimeWorkflowContext: contextBuilder.runtimeWorkflowContext,
      queryPayload: () : any => ({ topic: "jobs.job" }),
      isFeatureActive: () : any => true,
      protocolEventBus: {}
    });

    expect(runtimeContext.canAccessJob({
      id: "job-a",
      ownerSubjectId: "user-a",
      ownerTenantId: "tenant-a"
    }, runtimeContext.authSession)).toBe(true);
    await expect(runtimeContext.canAccessUploadSession("upload-a")).resolves.toBe(true);
    await expect(runtimeContext.canAccessUploadSession("upload-b")).resolves.toBe(false);
    const adminContext: any = contextBuilder.runtimeWorkflowContext({ user: { roleId: "owner" } });
    expect(adminContext.canAccessAllUploadSessions()).toBe(true);
    await expect(adminContext.canAccessUploadSession("expired-session")).resolves.toBe(true);

    await handlers.handleSubscribeEvents({
      operation: { id: "events.subscribe" },
      request: { aborted: false },
      url: new URL("http://localhost/api/events"),
      response: {},
      authSession
    });
    expect(calls[0].context.authSession).toBe(authSession);
    expect(calls[0].context.canAccessJob).toBeTypeOf("function");
    expect(calls[0].context.canAccessUploadSession).toBeTypeOf("function");
  });

  it("uses stored upload-session owner and tenant facts for event authorization", async () : Promise<any> => {
    const root: any = await tempDir();
    const sessionId: any = serverToken("upload_session", "event-owner-fixture");
    await saveSessionMeta(root, {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId,
      checkpointId: "checkpoint-fixture",
      archiveBatchId: "archive-fixture",
      manifestDigest: "a".repeat(64),
      inputDigest: "b".repeat(64),
      status: "complete",
      createdAt: "2026-10-13T00:00:00.000Z",
      updatedAt: "2026-10-13T00:00:00.000Z",
      ownerSubjectId: "user-a",
      ownerUserId: "user-a",
      ownerUsername: "same-name",
      ownerTenantId: "tenant-a",
      files: []
    } as any);

    await expect(hasUploadSessionOwnerAccess(root, sessionId, {
      subjectId: "user-a",
      userId: "user-a",
      username: "same-name",
      tenantId: "tenant-a"
    })).resolves.toBe(true);
    await expect(hasUploadSessionOwnerAccess(root, sessionId, {
      subjectId: "other-user",
      userId: "other-user",
      username: "same-name",
      tenantId: "tenant-b"
    })).resolves.toBe(false);
    await expect(hasUploadSessionOwnerAccess(root, "invalid-session", {
      subjectId: "user-a",
      userId: "user-a",
      tenantId: "tenant-a"
    })).resolves.toBe(false);
  });
});
