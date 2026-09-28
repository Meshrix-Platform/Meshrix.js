import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const secretMaterial: any = vi.hoisted(() : any => ({
  revision: 1,
  value: "private-secret-generation-one"
}));

vi.mock("@meshrix/foundation/security/secrets/local-secret-store", () : any => ({
  resolveLocalSecretPayload: vi.fn(async ({ secretRef }: Record<string, any>) : Promise<any> => ({
    secretRef,
    revision: secretMaterial.revision,
    payload: {
      env: { FIXTURE_SECRET: secretMaterial.value }
    }
  }))
}));

import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { resolveMcpServiceConfigWithCredentials } from "../../../packages/agents/src/upstream-gateway/credential-material.ts";
import { compileUpstreamOperationCapability } from "../../../packages/agents/src/upstream-gateway/operation-capability.ts";
import { createOperationProofSubstrate } from "../../../packages/foundation/src/proof/proof-substrate/index.ts";
import { createUpstreamMcpSessionManager } from "../../../packages/protocols/mcp/upstream-mcp-gateway-transport.ts";
import { createPlatformMcpGateway } from "../../../packages/server-runtime/src/composition/gateway-composition.ts";
import { createUpstreamGatewayOperationExecutor } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/upstream-gateway-executor.ts";
import { executionSubject } from "../../helpers/mcp-downstream-request.ts";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.ts";
import { modernHttpRequest } from "../gateway/support.ts";

function fixtureTools() : any {
  return ["state.increment", "state.probe", "work.slow", "work.peer"].map((name?: any) : any => ({
    name,
    title: name,
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true }
  }));
}

async function registryFixture(mcpSessionManager?: any, overrides: Record<string, any> = {}) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-session-test-"));
  const services: any[] = [{
      serviceId: "session-fixture",
      serviceProtocol: "mcp",
      label: "Session fixture",
      trafficPolicy: {
        perMinute: 100,
        burst: 10,
        maxConcurrent: 2
      },
      mcp: {
        transport: "http",
        url: "https://session-fixture.invalid/mcp",
        protocolVersion: "2025-06-18",
        env: { FIXTURE_TOKEN: "private-config-value" },
        toolNamePrefix: "session-fixture",
        toolsCacheTtlMs: 60_000,
        timeoutMs: 10_000
      },
      ...overrides
    }];
  const registry: any = createUpstreamGatewayRegistry({
    userDataPath,
    mcpSessionManager
  });
  installUpstreamRuntimeServices(registry, services);
  return {
    registry,
    userDataPath,
    async cleanup() : Promise<any> {
      await registry.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  };
}

function controlledSessionManager(onCall: (input: Record<string, any>) => Promise<any>, observedConfigs: any[] = []) : any {
  return createUpstreamMcpSessionManager({
    fetchTransport: async (_url: string, init: Record<string, any>, options: Record<string, any> = {}) : Promise<Response> => {
      const config = options.config || {};
      observedConfigs.push(config);
      const message = JSON.parse(String(init.body || "{}"));
      const sessionId = `fixture-${config.sessionKey || "session"}`;
      const headers = { "content-type": "application/json", "mcp-session-id": sessionId };
      if (String(init.method || "POST").toUpperCase() === "DELETE") return new Response(null, { status: 204, headers });
      if (message.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "session-fixture", version: "1" }
        } }), { status: 200, headers });
      }
      if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
        return new Response(null, { status: 202, headers });
      }
      if (message.method === "tools/list") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: fixtureTools() } }), { status: 200, headers });
      }
      if (message.method === "tools/call") {
        if (typeof options.beforeFetch === "function") await options.beforeFetch();
        const result = await onCall({ config, call: message.params || {}, signal: init.signal });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { status: 200, headers });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported fixture method." } }), { status: 200, headers });
    }
  });
}

const SESSION_PUBLIC_TOOLS: readonly any[] = Object.freeze([
  "upstream.session-fixture.state.increment",
  "upstream.session-fixture.state.probe",
  "upstream.session-fixture.work.slow",
  "upstream.session-fixture.work.peer"
]);

function readSubject(overrides: Record<string, any> = {}) : any {
  return executionSubject({
    scopes: ["gateway:read", "gateway:write"],
    publicToolNames: [...SESSION_PUBLIC_TOOLS],
    ...overrides
  });
}

function otherSubject() : any {
  return readSubject({
    subjectId: "subject-2",
    grantId: "grant-2",
    grant: { id: "grant-2", subjectId: "subject-2" }
  });
}

function isExecutionConfig(config?: any) : any {
  return String(config?.sessionKind || "") === "stateful" ||
    String(config?.sessionScope || "").includes(":exec:");
}

function isDiscoveryConfig(config?: any) : any {
  return String(config?.sessionKind || "") === "ephemeral" ||
    String(config?.sessionScope || "").endsWith(":discovery");
}

function observePromise(promise?: any) : any {
  return promise.then(
    (value?: any) : any => ({ status: "fulfilled", value }),
    (reason?: any) : any => ({ status: "rejected", reason })
  );
}

function publicGatewayFailure(response: any) : string {
  return JSON.stringify({
    status: response?.status,
    code: response?.body?.error?.data?.code || response?.body?.error?.code || "",
    message: String(response?.body?.error?.message || "").slice(0, 160)
  });
}

function rejectStartupIfSettledEarly(observed?: any, label?: any) : any {
  return observed.then((outcome?: any) : any => {
    if (outcome.status === "rejected") throw outcome.reason;
    throw new Error(`${label} completed before both requests started: ${publicGatewayFailure(outcome.value)}`);
  });
}

async function authorizedPlatformFixture(mcpSessionManager?: any, overrides: Record<string, any> = {}, initialSubject: any = readSubject()) : Promise<any> {
  const fixture: any = await registryFixture(mcpSessionManager, overrides);
  const proofSubstrate: any = createOperationProofSubstrate({ dataDir: path.join(fixture.userDataPath, "proof") });
  let activeSubject: any = initialSubject;
  const platform: any = createPlatformMcpGateway({
    upstreamGatewayRegistry: fixture.registry,
    operationProofSubstrate: proofSubstrate,
    toolSkillManagementProvider: {
      authorizeMcpClientRequest: async () => ({
        ok: true,
        tenantId: "session-fixture-tenant",
        workloadPrincipalId: activeSubject.subjectId,
        grant: { ...activeSubject.grant, scopes: activeSubject.scopes },
        subject: { ...activeSubject, grant: { ...activeSubject.grant, scopes: activeSubject.scopes } }
      }),
      listVisibleTools: () => []
    }
  });
  let requestId = 0;
  const send = (method: string, params: Record<string, any> = {}, subject: any = initialSubject, options: Record<string, any> = {}) => {
    activeSubject = subject;
    return platform.adapter.handle({
      ...modernHttpRequest(method, `session-${++requestId}`, params),
      ...(options.signal ? { signal: options.signal } : {})
    });
  };

  try {
    await platform.gateway.start();
    const listed: any = await send("tools/list");
    const tools: any[] = listed.body?.result?.tools || [];
    const namesByUpstreamTool: any = new Map(
      tools
        .filter((tool?: any) : any => tool?._meta?.serviceId === "session-fixture")
        .map((tool?: any) : any => [tool._meta.upstreamToolName, tool.name])
    );
    if (!namesByUpstreamTool.size) throw new Error("Authorized session fixture tools were not published.");
    return {
      registry: fixture.registry,
      platform,
      proofSubstrate,
      namesByUpstreamTool,
      call(toolName: string, args: Record<string, any> = {}, subject: any = initialSubject, options: Record<string, any> = {}) {
        const publicName = namesByUpstreamTool.get(toolName);
        if (!publicName) throw new Error("Authorized session fixture tool is unavailable.");
        return send("tools/call", { name: publicName, arguments: args }, subject, options);
      },
      async cleanup() : Promise<void> {
        await platform.close();
        await proofSubstrate.close();
        await fixture.cleanup();
      }
    };
  } catch (error) {
    await platform.close();
    await proofSubstrate.close();
    await fixture.cleanup();
    throw error;
  }
}

describe("upstream gateway session ownership and cancellation", () : any => {
  it("passes the Operation Permission signal from the console executor into the registry", async () : Promise<any> => {
    const abortController: any = new AbortController();
    const registry: Record<string, any> = {
      forward: vi.fn(async () : Promise<any> => ({ ok: true }))
    };
    const execute: any = createUpstreamGatewayOperationExecutor({
      errorPayload: (error?: any) : any => ({ error: error.message }),
      objectOrNull: (value?: any) : any => value && typeof value === "object" ? value : null,
      protocolPayload: (value?: any) : any => value,
      result: (status?: any, payload?: any) : any => ({ status, payload }),
      subjectFromAuthSession: () : any => ({ scopes: ["gateway:read"] }),
      upstreamGatewayRegistryFor: () : any => registry
    });

    const executed: any = await execute({
      operationId: "gateway.forward",
      input: { serviceId: "session-fixture", operationKey: "tools/call" },
      context: { signal: abortController.signal }
    });

    expect(executed.status).toBe(200);
    expect(registry.forward).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      {
        signal: abortController.signal,
        responseAdapter: "structured",
        finalProtectedSinkPermit: null
      }
    );
  });

  it("keeps increment and probe on one registry-owned upstream session identity", async () : Promise<any> => {
    const stateByKey: any = new Map<any, any>();
    const observedConfigs: any[] = [];
    const manager: any = controlledSessionManager(async ({ config, call }: Record<string, any>) : Promise<any> => {
      const sessionKey: any = String(config.sessionKey || "");
      if (call.name === "state.increment") {
        stateByKey.set(sessionKey, Number(stateByKey.get(sessionKey) || 0) + 1);
      }
      return { structuredContent: { state: Number(stateByKey.get(sessionKey) || 0) } };
    }, observedConfigs);
    const closeManager = vi.spyOn(manager, "close");
    const { registry, call, cleanup } = await authorizedPlatformFixture(manager);
    const primary: any = readSubject();
    const other: any = otherSubject();

    try {
      await call("state.increment", {}, primary);
      const probed: any = await call("state.probe", {}, primary);
      await call("state.increment", {}, other);
      const otherProbed: any = await call("state.probe", {}, other);
      const primaryAgain: any = await call("state.probe", {}, primary);

      expect(probed.body?.result?.structuredContent, publicGatewayFailure(probed)).toEqual({ state: 1 });
      expect(otherProbed.body?.result?.structuredContent, publicGatewayFailure(otherProbed)).toEqual({ state: 1 });
      expect(primaryAgain.body?.result?.structuredContent, publicGatewayFailure(primaryAgain)).toEqual({ state: 1 });
      const discoveryConfigs: any[] = observedConfigs.filter(isDiscoveryConfig);
      const executionConfigs: any[] = observedConfigs.filter(isExecutionConfig);
      const primaryKeys: any[] = executionConfigs
        .filter((config?: any) : any => config.sessionScope === "svc:session-fixture:exec:subject-1:grant-1")
        .map((config?: any) : any => config.sessionKey);
      const otherKeys: any[] = executionConfigs
        .filter((config?: any) : any => config.sessionScope === "svc:session-fixture:exec:subject-2:grant-2")
        .map((config?: any) : any => config.sessionKey);
      expect(discoveryConfigs.length).toBeGreaterThan(0);
      expect(executionConfigs.length).toBeGreaterThan(0);
      expect(discoveryConfigs.every((config?: any) : any => config.sessionScope === "svc:session-fixture:discovery")).toBe(true);
      expect(new Set<any>(primaryKeys).size).toBe(1);
      expect(new Set<any>(otherKeys).size).toBe(1);
      expect(primaryKeys[0]).not.toBe(otherKeys[0]);
      expect(discoveryConfigs.every((config?: any) : any => config.sessionKey !== primaryKeys[0])).toBe(true);
      expect(observedConfigs.every((config?: any) : any => !String(config.sessionKey || "").includes("private-config-value"))).toBe(true);
    } finally {
      await cleanup();
    }
    expect(closeManager).toHaveBeenCalledOnce();
  });

  it("changes the session identity when a referenced credential revision changes", async () : Promise<any> => {
    const callConfigs: any[] = [];
    const manager: any = controlledSessionManager(async ({ config }: Record<string, any>) : Promise<any> => {
      callConfigs.push(config);
      return { structuredContent: { ok: true } };
    });
    secretMaterial.revision = 1;
    secretMaterial.value = "private-secret-generation-one";
    const credentialRef: any = "secret://fixture/session";
    const probeCapability: any = compileUpstreamOperationCapability(
      { serviceId: "session-fixture", serviceProtocol: "mcp", credentialRefs: [credentialRef] },
      { operationKey: "tools/call", protocol: "mcp", risk: "safe_write", requiredScopes: ["gateway:write"] },
      { upstreamToolName: "state.probe" }
    );
    const credentialSubject: any = readSubject({
      dynamicCapabilities: [probeCapability.capabilityId],
      allowedServiceIds: ["session-fixture"],
      allowedSecretBindings: [...probeCapability.credentialBindingIds],
      grant: {
        id: "grant-1",
        subjectId: "subject-1",
        dynamicCapabilities: [probeCapability.capabilityId],
        allowedServiceIds: ["session-fixture"],
        allowedSecretBindings: [...probeCapability.credentialBindingIds]
      }
    });
    const { call, cleanup } = await authorizedPlatformFixture(manager, {
      credentialRefs: [credentialRef]
    }, credentialSubject);

    try {
      const first: any = await call("state.probe", {}, credentialSubject);
      expect(first.body?.result, publicGatewayFailure(first)).toBeDefined();
      secretMaterial.revision = 2;
      secretMaterial.value = "private-secret-generation-two";
      const second: any = await call("state.probe", {}, credentialSubject);
      expect(second.body?.result, publicGatewayFailure(second)).toBeDefined();

      expect(callConfigs).toHaveLength(2);
      expect(callConfigs[0].sessionKey).not.toBe(callConfigs[1].sessionKey);
      expect(callConfigs[0].sessionScope).toBe("svc:session-fixture:exec:subject-1:grant-1");
      expect(callConfigs[1].sessionScope).toBe(callConfigs[0].sessionScope);
      const sessionKeys: any = callConfigs.map((config?: any) : any => config.sessionKey).join(" ");
      expect(sessionKeys).not.toContain("private-secret-generation-one");
      expect(sessionKeys).not.toContain("private-secret-generation-two");
    } finally {
      await cleanup();
    }
  });

  it("changes the session identity when the endpoint or transport configuration changes", async () : Promise<any> => {
    const baseService: Record<string, any> = {
      serviceId: "session-fixture",
      updatedAt: "2026-01-01T00:00:00.000Z",
      serviceProtocol: "mcp",
      mcp: {
        transport: "streamable-http",
        url: "https://fixture.invalid/mcp-a",
        headers: { "x-fixture-mode": "one" },
        timeoutMs: 1000
      }
    };
    const first: any = await resolveMcpServiceConfigWithCredentials({ service: baseService });
    const endpointChanged: any = await resolveMcpServiceConfigWithCredentials({
      service: {
        ...baseService,
        mcp: { ...baseService.mcp, url: "https://fixture.invalid/mcp-b" }
      }
    });
    const headerChanged: any = await resolveMcpServiceConfigWithCredentials({
      service: {
        ...baseService,
        mcp: {
          ...baseService.mcp,
          headers: { "x-fixture-mode": "two" }
        }
      }
    });

    expect(first.sessionKey).not.toBe(endpointChanged.sessionKey);
    expect(first.sessionKey).not.toBe(headerChanged.sessionKey);
    expect(first.sessionScope).toBe(endpointChanged.sessionScope);
    expect(first.sessionScope).toBe(headerChanged.sessionScope);
    expect(first.sessionKey).not.toContain("https://fixture.invalid");
  });

  it("preserves caller cancellation while discovering upstream MCP tools", async () : Promise<any> => {
    const manager: any = controlledSessionManager(async () : Promise<any> => ({ structuredContent: {} }));
    const { registry, cleanup } = await registryFixture(manager);
    const abortController: any = new AbortController();
    abortController.abort(new Error("private caller cancellation detail"));

    try {
      await expect(registry.listMcpTools({}, {
        signal: abortController.signal
      })).rejects.toMatchObject({
        status: 499,
        reasonCode: "upstream_mcp_cancelled",
        message: "Upstream MCP discovery was cancelled."
      });
    } finally {
      await cleanup();
    }
  });

  it("cancels only the addressed request and releases its traffic slot without side effects", async () : Promise<any> => {
    let cancelNotifications: any = 0;
    let slowSideEffects: any = 0;
    let peerSideEffects: any = 0;
    let releasePeer: any;
    let markSlowStarted: any;
    let markPeerStarted: any;
    const slowStarted: any = new Promise((resolve?: any) : any => { markSlowStarted = resolve; });
    const peerStarted: any = new Promise((resolve?: any) : any => { markPeerStarted = resolve; });
    const peerRelease: any = new Promise((resolve?: any) : any => { releasePeer = resolve; });
    const manager: any = controlledSessionManager(async ({ call, signal }: Record<string, any>) : Promise<any> => {
      if (call.name === "work.slow") {
        markSlowStarted();
        await new Promise((resolve?: any, reject?: any) : any => {
          const cancel: any = () : any => {
            cancelNotifications += 1;
            const error: any = Object.assign(new Error("private upstream cancellation detail"), {
              name: "AbortError",
              reasonCode: "upstream_mcp_cancelled"
            });
            reject(error);
          };
          if (signal.aborted) cancel();
          else signal.addEventListener("abort", cancel, { once: true });
        });
        slowSideEffects += 1;
      }
      if (call.name === "work.peer") {
        markPeerStarted();
        await peerRelease;
        peerSideEffects += 1;
        return { structuredContent: { completed: true } };
      }
      return { structuredContent: {} };
    });
    const { registry, call, proofSubstrate, cleanup } = await authorizedPlatformFixture(manager);
    const abortController: any = new AbortController();

    try {
      const slow: any = call("work.slow", {}, readSubject(), { signal: abortController.signal });
      const peer: any = call("work.peer", {}, readSubject());
      const slowObserved: any = observePromise(slow);
      const peerObserved: any = observePromise(peer);
      const started: any = Promise.all([slowStarted, peerStarted]);
      const slowStartupFailure: any = rejectStartupIfSettledEarly(slowObserved, "slow");
      const peerStartupFailure: any = rejectStartupIfSettledEarly(peerObserved, "peer");
      slowStartupFailure.catch(() : any => {});
      peerStartupFailure.catch(() : any => {});
      await Promise.race([started, slowStartupFailure, peerStartupFailure]);

      expect(registry.previewPolicy({
        serviceId: "session-fixture",
        operationKey: "tools/call"
      }, readSubject()).traffic.inFlight).toBe(2);

      abortController.abort(new Error("private caller cancellation detail"));
      const cancelled: any = await slowObserved;
      expect(cancelled.status).toBe("fulfilled");
      expect(cancelled.value.status).toBe(200);
      expect(cancelled.value.body.error?.data).toMatchObject({ code: "ABORT_ERR", effectOutcome: "unknown" });
      expect(registry.previewPolicy({
        serviceId: "session-fixture",
        operationKey: "tools/call"
      }, readSubject()).traffic.inFlight).toBe(1);

      releasePeer();
      const peerCompleted: any = await peerObserved;
      expect(peerCompleted.status).toBe("fulfilled");
      expect(peerCompleted.value).toMatchObject({
        status: 200,
        body: { result: { structuredContent: { completed: true } } }
      });
      expect(registry.previewPolicy({
        serviceId: "session-fixture",
        operationKey: "tools/call"
      }, readSubject()).traffic.inFlight).toBe(0);
      expect(cancelNotifications).toBe(1);
      expect(slowSideEffects).toBe(0);
      expect(peerSideEffects).toBe(1);
      const cancellationText: any = JSON.stringify(cancelled.value.body);
      expect(cancellationText).not.toContain("private caller cancellation detail");
      expect(cancellationText).not.toContain("private upstream cancellation detail");
      const receipts: any[] = await proofSubstrate.listReceipts({ limit: 100 });
      const operationReceipts: any[] = receipts.filter((receipt?: any) : any => receipt.operationId === "upstream.mcp.session-fixture.tools/call");
      expect(operationReceipts.map((receipt?: any) : any => receipt.status)).toEqual(expect.arrayContaining(["in_doubt", "succeeded"]));
    } finally {
      abortController.abort();
      releasePeer?.();
      await cleanup();
    }
  });
});
