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
import { createUpstreamGatewayOperationExecutor } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/upstream-gateway-executor.ts";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.ts";

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
        transport: "stdio",
        command: "fixture-command",
        env: { FIXTURE_TOKEN: "private-config-value" },
        toolNamePrefix: "session-fixture",
        toolsCacheTtlMs: 60_000,
        timeoutMs: 10_000
      },
      operations: [{
        operationKey: "tools/call",
        protocol: "mcp",
        risk: "read_only",
        requiredScopes: ["gateway:read"],
        timeoutMs: 10_000
      }],
      ...overrides
    }];
  const registry: any = createUpstreamGatewayRegistry({
    userDataPath,
    mcpSessionManager
  });
  installUpstreamRuntimeServices(registry, services);
  return {
    registry,
    async cleanup() : Promise<any> {
      await registry.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  };
}

function readSubject() : any {
  return { scopes: ["gateway:read"] };
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
    let state: any = 0;
    const observedConfigs: any[] = [];
    const manager: Record<string, any> = {
      async listTools(config?: any) : Promise<any> {
        observedConfigs.push(config);
        return { initialized: {}, tools: fixtureTools() };
      },
      async callTool(config?: any, call?: any) : Promise<any> {
        observedConfigs.push(config);
        if (call.name === "state.increment") state += 1;
        return {
          initialized: {},
          result: { structuredContent: { state } }
        };
      },
      close: vi.fn(async () : Promise<any> => {})
    };
    const { registry, cleanup } = await registryFixture(manager);

    try {
      await registry.callMcpToolByPublicName(
        "upstream.session-fixture.state.increment",
        { arguments: {} },
        readSubject()
      );
      const probed: any = await registry.callMcpToolByPublicName(
        "upstream.session-fixture.state.probe",
        { arguments: {} },
        readSubject()
      );

      expect(probed.response.structuredContent).toEqual({ state: 1 });
      expect(new Set<any>(observedConfigs.map((config?: any) : any => config.sessionKey)).size).toBe(1);
      expect(observedConfigs.every((config?: any) : any => config.sessionScope === "session-fixture")).toBe(true);
      expect(observedConfigs[0].sessionKey).not.toContain("private-config-value");
    } finally {
      await cleanup();
    }
    expect(manager.close).toHaveBeenCalledOnce();
  });

  it("changes the session identity when a referenced credential revision changes", async () : Promise<any> => {
    const callConfigs: any[] = [];
    const manager: Record<string, any> = {
      async listTools() : Promise<any> {
        return { initialized: {}, tools: fixtureTools() };
      },
      async callTool(config?: any) : Promise<any> {
        callConfigs.push(config);
        return { initialized: {}, result: { structuredContent: { ok: true } } };
      },
      close: vi.fn(async () : Promise<any> => {})
    };
    secretMaterial.revision = 1;
    secretMaterial.value = "private-secret-generation-one";
    const { registry, cleanup } = await registryFixture(manager, {
      credentialRefs: ["secret://fixture/session"]
    });

    try {
      await registry.callMcpToolByPublicName(
        "upstream.session-fixture.state.probe",
        { arguments: {} },
        readSubject()
      );
      secretMaterial.revision = 2;
      secretMaterial.value = "private-secret-generation-two";
      await registry.callMcpToolByPublicName(
        "upstream.session-fixture.state.probe",
        { arguments: {} },
        readSubject()
      );

      expect(callConfigs).toHaveLength(2);
      expect(callConfigs[0].sessionKey).not.toBe(callConfigs[1].sessionKey);
      expect(callConfigs[0].sessionScope).toBe(callConfigs[1].sessionScope);
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
    const manager: Record<string, any> = {
      async listTools(_config: any, { signal }: Record<string, any>) : Promise<any> {
        if (signal?.aborted) {
          throw Object.assign(new Error("private discovery cancellation detail"), {
            name: "AbortError"
          });
        }
        return { initialized: {}, tools: fixtureTools() };
      },
      async callTool() : Promise<any> {
        return { initialized: {}, result: { structuredContent: {} } };
      },
      close: vi.fn(async () : Promise<any> => {})
    };
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
    const manager: Record<string, any> = {
      async listTools() : Promise<any> {
        return { initialized: {}, tools: fixtureTools() };
      },
      async callTool(_config: any, call: any, { signal }: Record<string, any>) : Promise<any> {
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
          return { initialized: {}, result: { structuredContent: { completed: true } } };
        }
        return { initialized: {}, result: { structuredContent: {} } };
      },
      close: vi.fn(async () : Promise<any> => {})
    };
    const { registry, cleanup } = await registryFixture(manager);
    const abortController: any = new AbortController();

    try {
      await registry.listMcpTools();
      const slow: any = registry.callMcpToolByPublicName(
        "upstream.session-fixture.work.slow",
        { arguments: {} },
        readSubject(),
        { signal: abortController.signal }
      );
      const peer: any = registry.callMcpToolByPublicName(
        "upstream.session-fixture.work.peer",
        { arguments: {} },
        readSubject()
      );
      await Promise.all([slowStarted, peerStarted]);

      expect(registry.previewPolicy({
        serviceId: "session-fixture",
        operationKey: "tools/call"
      }, readSubject()).traffic.inFlight).toBe(2);

      abortController.abort(new Error("private caller cancellation detail"));
      await expect(slow).rejects.toMatchObject({
        status: 499,
        reasonCode: "upstream_mcp_cancelled",
        message: "Upstream MCP request was cancelled."
      });
      expect(registry.previewPolicy({
        serviceId: "session-fixture",
        operationKey: "tools/call"
      }, readSubject()).traffic.inFlight).toBe(1);

      releasePeer();
      await expect(peer).resolves.toMatchObject({
        ok: true,
        response: { structuredContent: { completed: true } }
      });
      expect(registry.previewPolicy({
        serviceId: "session-fixture",
        operationKey: "tools/call"
      }, readSubject()).traffic.inFlight).toBe(0);
      expect(cancelNotifications).toBe(1);
      expect(slowSideEffects).toBe(0);
      expect(peerSideEffects).toBe(1);
      const auditText: any = JSON.stringify(registry.listAudit({ limit: 20 }));
      expect(auditText).toContain("upstream_mcp_cancelled");
      expect(auditText).not.toContain("private caller cancellation detail");
      expect(auditText).not.toContain("private upstream cancellation detail");
    } finally {
      releasePeer?.();
      await cleanup();
    }
  });
});
