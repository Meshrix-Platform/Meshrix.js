import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const secretMaterial = vi.hoisted(() => ({
  revision: 1,
  value: "private-secret-generation-one"
}));

vi.mock("@lico/foundation/security/secrets/local-secret-store", () => ({
  resolveLocalSecretPayload: vi.fn(async ({ secretRef }) => ({
    secretRef,
    revision: secretMaterial.revision,
    payload: {
      env: { FIXTURE_SECRET: secretMaterial.value }
    }
  }))
}));

import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.mjs";
import { resolveMcpServiceConfigWithCredentials } from "../../../packages/agents/src/upstream-gateway/credential-material.mjs";
import { createUpstreamGatewayOperationExecutor } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/upstream-gateway-executor.mjs";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.mjs";

function fixtureTools() {
  return ["state.increment", "state.probe", "work.slow", "work.peer"].map((name) => ({
    name,
    title: name,
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true }
  }));
}

async function registryFixture(mcpSessionManager, overrides = {}) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-upstream-session-test-"));
  const services = [{
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
  const registry = createUpstreamGatewayRegistry({
    userDataPath,
    mcpSessionManager
  });
  installUpstreamRuntimeServices(registry, services);
  return {
    registry,
    async cleanup() {
      await registry.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  };
}

function readSubject() {
  return { scopes: ["gateway:read"] };
}

describe("upstream gateway session ownership and cancellation", () => {
  it("passes the Operation Permission signal from the console executor into the registry", async () => {
    const abortController = new AbortController();
    const registry = {
      forward: vi.fn(async () => ({ ok: true }))
    };
    const execute = createUpstreamGatewayOperationExecutor({
      errorPayload: (error) => ({ error: error.message }),
      objectOrNull: (value) => value && typeof value === "object" ? value : null,
      protocolPayload: (value) => value,
      result: (status, payload) => ({ status, payload }),
      subjectFromAuthSession: () => ({ scopes: ["gateway:read"] }),
      upstreamGatewayRegistryFor: () => registry
    });

    const executed = await execute({
      operationId: "gateway.forward",
      input: { serviceId: "session-fixture", operationKey: "tools/call" },
      context: { signal: abortController.signal }
    });

    expect(executed.status).toBe(200);
    expect(registry.forward).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      { signal: abortController.signal, responseAdapter: "structured" }
    );
  });

  it("keeps increment and probe on one registry-owned upstream session identity", async () => {
    let state = 0;
    const observedConfigs = [];
    const manager = {
      async listTools(config) {
        observedConfigs.push(config);
        return { initialized: {}, tools: fixtureTools() };
      },
      async callTool(config, call) {
        observedConfigs.push(config);
        if (call.name === "state.increment") state += 1;
        return {
          initialized: {},
          result: { structuredContent: { state } }
        };
      },
      close: vi.fn(async () => {})
    };
    const { registry, cleanup } = await registryFixture(manager);

    try {
      await registry.callMcpToolByPublicName(
        "upstream.session-fixture.state.increment",
        { arguments: {} },
        readSubject()
      );
      const probed = await registry.callMcpToolByPublicName(
        "upstream.session-fixture.state.probe",
        { arguments: {} },
        readSubject()
      );

      expect(probed.response.structuredContent).toEqual({ state: 1 });
      expect(new Set(observedConfigs.map((config) => config.sessionKey)).size).toBe(1);
      expect(observedConfigs.every((config) => config.sessionScope === "session-fixture")).toBe(true);
      expect(observedConfigs[0].sessionKey).not.toContain("private-config-value");
    } finally {
      await cleanup();
    }
    expect(manager.close).toHaveBeenCalledOnce();
  });

  it("changes the session identity when a referenced credential revision changes", async () => {
    const callConfigs = [];
    const manager = {
      async listTools() {
        return { initialized: {}, tools: fixtureTools() };
      },
      async callTool(config) {
        callConfigs.push(config);
        return { initialized: {}, result: { structuredContent: { ok: true } } };
      },
      close: vi.fn(async () => {})
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
      const sessionKeys = callConfigs.map((config) => config.sessionKey).join(" ");
      expect(sessionKeys).not.toContain("private-secret-generation-one");
      expect(sessionKeys).not.toContain("private-secret-generation-two");
    } finally {
      await cleanup();
    }
  });

  it("changes the session identity when the endpoint or transport configuration changes", async () => {
    const baseService = {
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
    const first = await resolveMcpServiceConfigWithCredentials({ service: baseService });
    const endpointChanged = await resolveMcpServiceConfigWithCredentials({
      service: {
        ...baseService,
        mcp: { ...baseService.mcp, url: "https://fixture.invalid/mcp-b" }
      }
    });
    const headerChanged = await resolveMcpServiceConfigWithCredentials({
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

  it("preserves caller cancellation while discovering upstream MCP tools", async () => {
    const manager = {
      async listTools(_config, { signal }) {
        if (signal?.aborted) {
          throw Object.assign(new Error("private discovery cancellation detail"), {
            name: "AbortError"
          });
        }
        return { initialized: {}, tools: fixtureTools() };
      },
      async callTool() {
        return { initialized: {}, result: { structuredContent: {} } };
      },
      close: vi.fn(async () => {})
    };
    const { registry, cleanup } = await registryFixture(manager);
    const abortController = new AbortController();
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

  it("cancels only the addressed request and releases its traffic slot without side effects", async () => {
    let cancelNotifications = 0;
    let slowSideEffects = 0;
    let peerSideEffects = 0;
    let releasePeer;
    let markSlowStarted;
    let markPeerStarted;
    const slowStarted = new Promise((resolve) => { markSlowStarted = resolve; });
    const peerStarted = new Promise((resolve) => { markPeerStarted = resolve; });
    const peerRelease = new Promise((resolve) => { releasePeer = resolve; });
    const manager = {
      async listTools() {
        return { initialized: {}, tools: fixtureTools() };
      },
      async callTool(_config, call, { signal }) {
        if (call.name === "work.slow") {
          markSlowStarted();
          await new Promise((resolve, reject) => {
            const cancel = () => {
              cancelNotifications += 1;
              const error = Object.assign(new Error("private upstream cancellation detail"), {
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
      close: vi.fn(async () => {})
    };
    const { registry, cleanup } = await registryFixture(manager);
    const abortController = new AbortController();

    try {
      await registry.listMcpTools();
      const slow = registry.callMcpToolByPublicName(
        "upstream.session-fixture.work.slow",
        { arguments: {} },
        readSubject(),
        { signal: abortController.signal }
      );
      const peer = registry.callMcpToolByPublicName(
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
      const auditText = JSON.stringify(registry.listAudit({ limit: 20 }));
      expect(auditText).toContain("upstream_mcp_cancelled");
      expect(auditText).not.toContain("private caller cancellation detail");
      expect(auditText).not.toContain("private upstream cancellation detail");
    } finally {
      releasePeer?.();
      await cleanup();
    }
  });
});
