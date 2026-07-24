import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const MODEL_ENV_KEYS = [
  "MESHRIX_DEFAULT_MODEL",
  "MESHRIX_DEFAULT_MODEL_PROVIDER",
];

afterEach(() => vi.unstubAllEnvs());

describe("user configuration truth", () => {
  it("keeps the server settings projection empty without explicit input", async () => {
    for (const key of MODEL_ENV_KEYS) vi.stubEnv(key, "");
    vi.resetModules();
    const {
      normalizeAgentToolExecution,
      normalizeModelLibraryAgents,
      normalizeSettings,
    } = await import("../../../packages/server-runtime/src/composition/platform-core/settings-normalizers.mjs");

    const normalized = normalizeSettings({});
    expect(normalized.defaultModelProvider).toBe("");
    expect(normalized.defaultModel).toBe("");
    expect(normalized.gatewayAssistantDefaults).toMatchObject({
      systemPrompt: "",
      answerTemplate: "",
      contextProfileId: "",
      thinkingMode: "",
      temperature: 0,
      maxTokens: 0,
      toolChoice: "",
    });
    expect(normalized.moduleIntelligence).toEqual({});
    expect(normalizeAgentToolExecution({})).toMatchObject({
      functionCallSchema: {},
      http: { enabled: false, allowedHosts: [], timeoutMs: 0, maxResponseBytes: 0 },
      local: { enabled: false, commands: [], timeoutMs: 0, maxOutputBytes: 0 },
    });
    expect(normalizeSettings({ defaultModel: "gpt-example" }).defaultModelProvider).toBe("");
    expect(normalizeModelLibraryAgents([{
      uid: "explicit-agent",
      provider: "deepseek",
      model: "explicit-model",
    }])[0]).toMatchObject({
      label: "",
      agentName: "",
      engine: "",
      moduleAccess: { mode: "selected", moduleIds: [] },
      timeoutMs: 0,
      tokenHeader: "",
    });
  });

  it("lets explicit empty settings override configured process environment", async () => {
    vi.stubEnv("MESHRIX_DEFAULT_MODEL_PROVIDER", "deepseek");
    vi.stubEnv("MESHRIX_DEFAULT_MODEL", "environment-model");
    vi.resetModules();
    const { normalizeSettings } = await import(
      "../../../packages/server-runtime/src/composition/platform-core/settings-normalizers.mjs"
    );
    const normalized = normalizeSettings({
      defaultModelProvider: "",
      defaultModel: "",
    });
    expect(normalized.defaultModelProvider).toBe("");
    expect(normalized.defaultModel).toBe("");
  });

  it("does not synthesize an agent from a default model selection", async () => {
    const {
      publicAgentGatewayRegistry,
      resolveAgentGatewayConfig,
      resolveAgentGatewayRegistry,
    } = await import("../../../packages/agents/src/agent-gateway/policy-validation.mjs");
    const defaultsOnly = {
      defaultModelProvider: "deepseek",
      defaultModel: "configured-model",
    };
    expect(resolveAgentGatewayRegistry(defaultsOnly)).toEqual([]);
    expect(publicAgentGatewayRegistry(defaultsOnly)).toMatchObject({
      defaultAlias: "",
      agents: [],
    });

    const settings = {
      modelLibraryAgents: [{
        uid: "explicit-agent",
        alias: "explicit-agent",
        provider: "local-model",
        model: "explicit-model",
        baseUrl: "http://127.0.0.1:9/v1",
        timeoutMs: 1000,
      }],
    };
    expect(resolveAgentGatewayConfig(settings).alias).toBe("");
    expect(resolveAgentGatewayConfig(settings, { modelAlias: "explicit-agent" }).alias)
      .toBe("explicit-agent");
  });

  it("requires an explicit runtime root for the agent configuration registry", async () => {
    const { AgentConfigRegistry, getAgentConfigRegistry } = await import(
      "../../../packages/agents/src/agent-configs/config-registry.mjs"
    );
    expect(() => new AgentConfigRegistry()).toThrow(/explicit runtime rootPath/u);
    expect(() => getAgentConfigRegistry()).toThrow(/explicit runtime rootPath/u);
  });

  it("keeps model-routing controls empty until explicitly configured", async () => {
    const { normalizeModelRoutingPolicy } = await import(
      "../../../packages/agents/src/agent-gateway/model-routing/index.mjs"
    );
    const policy = normalizeModelRoutingPolicy({
      input: {
        modelRouting: {
          enabled: true,
          routeId: "explicit-route",
          candidateChain: ["explicit-agent"],
        },
      },
    });
    expect(policy.candidateChain).toEqual(["explicit-agent"]);
    expect(policy.budget.currency).toBe("");
    expect(policy.rateLimit).toMatchObject({
      windowMs: 0,
      maxCalls: 0,
      maxConcurrent: 0,
      maxInFlightMs: 0,
    });
    expect(policy.circuitBreaker).toMatchObject({
      enabled: false,
      failureThreshold: 0,
      openMs: 0,
    });
  });

  it("keeps the console empty state and example environment unconfigured", async () => {
    const { emptySettings } = await import("../../../apps/console/composables/console-defaults.ts");
    expect(emptySettings.gatewayAssistantDefaults).toMatchObject({
      systemPrompt: "",
      answerTemplate: "",
      contextProfileId: "",
      temperature: 0,
    });
    expect(emptySettings.agentToolExecution.http.enabled).toBe(false);
    expect(emptySettings.agentToolExecution.local.commands).toEqual([]);
    expect(emptySettings.moduleIntelligence).toEqual({});

    const envExample = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
    expect(envExample).toContain("MESHRIX_DEFAULT_MODEL_PROVIDER=\n");
    expect(envExample).toContain("MESHRIX_DEFAULT_MODEL=\n");
    expect(envExample).not.toMatch(/MESHRIX_DEFAULT_MODEL(?:_PROVIDER)?=\S+/u);
  });

  it("keeps discovery identity, URLs, mode, and polling intervals empty before configuration", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-discovery-empty-"));
    try {
      const { loadDiscoveryConfig, resolveDiscoveryState } = await import(
        "../../../packages/server-runtime/src/composition/discovery-config.mjs"
      );
      await expect(loadDiscoveryConfig(root)).resolves.toEqual({
        serverId: "",
        serverLabel: "",
        bootstrapBaseUrl: "",
        advertisedBaseUrl: "",
        activeServiceUrl: "",
        forwardBaseUrl: "",
        mode: "",
        configVersion: "",
        refreshIntervalSeconds: 0,
        checkInIntervalSeconds: 0,
        offlineAfterSeconds: 0,
      });
      const runtimeObservation = await resolveDiscoveryState(root, {
        listenUrl: "http://127.0.0.1:7228",
      });
      expect(runtimeObservation.advertisedBaseUrl).toBe("");
      expect(runtimeObservation.activeServiceUrl).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not infer an MCP online/offline threshold", async () => {
    const { mcpGrantConnectionState } = await import(
      "../../../packages/capabilities/src/skills/tool-skill-management-provider-local-mcp.mjs"
    );
    expect(mcpGrantConnectionState({ lastUsedAt: new Date().toISOString() })).toMatchObject({
      state: "unknown",
      alignmentState: "unknown",
    });
  });

  it("keeps sandbox provider executables outside persisted user configuration", async () => {
    const { normalizeSettings } = await import(
      "../../../packages/server-runtime/src/composition/platform-core/settings-normalizers.mjs"
    );
    expect(normalizeSettings({}).executionSandbox).toBeNull();
    expect(normalizeSettings({ executionSandbox: {} }).executionSandbox).toBeNull();
    expect(normalizeSettings({ executionSandbox: { enabled: false } }).executionSandbox).toEqual({
      enabled: false,
      providerMode: "",
      providerId: "",
      profileId: "",
      policyRevision: "",
      receiptRequirement: "",
      allowedProviderClasses: [],
      profiles: []
    });
    expect(normalizeSettings({
      executionSandbox: {
        enabled: true,
        providerMode: "explicit",
        providerId: "governed-provider",
        profileId: "governed-profile",
        policyRevision: "policy-current",
        receiptRequirement: "receipt-current",
        allowedProviderClasses: ["docker"],
        profiles: [],
        providerExecutable: "<provider-binary>"
      }
    }).executionSandbox).toBeNull();

    expect(normalizeSettings({
      executionSandbox: {
        enabled: true,
        providerMode: "explicit",
        providerId: "governed-provider",
        profileId: "governed-profile",
        policyRevision: "policy-current",
        receiptRequirement: "receipt-current",
        allowedProviderClasses: ["docker"],
        profiles: []
      }
    }).executionSandbox).toEqual({
      enabled: true,
      providerMode: "explicit",
      providerId: "governed-provider",
      profileId: "governed-profile",
      policyRevision: "policy-current",
      receiptRequirement: "receipt-current",
      allowedProviderClasses: ["docker"],
      profiles: []
    });
  });

});
