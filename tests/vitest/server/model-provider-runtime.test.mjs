import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentConfigRegistry } from "@meshrix/agents/agent-configs/config-registry";
import {
  publicAgentGatewayRegistry,
  resolveAgentGatewayConfig
} from "@meshrix/agents/agent-gateway/index";
import { probeModelConnection } from "@meshrix/agents/agent-gateway/model-probe/index";
import { loadSettings, saveSettings, normalizeSettings, getSettingsPath } from "@meshrix/server-runtime/composition/settings";
import {
  applyAgentModelPatch,
  mergeSettingsForModelProbe,
  normalizeAgentModelPayload
} from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/settings-agent-gateway-models.mjs";
import { buildAgentSettingsConsoleProjection } from "../../../packages/server-runtime/src/composition/console-domain/state-projections.mjs";

const temporaryRoots = [];
const settingsPort = Object.freeze({
  loadSettings,
  saveSettings,
  normalizeSettings,
  getSettingsPath
});

beforeEach(() => {
  vi.stubEnv(
    "MESHRIX_MODEL_CREDENTIAL_MASTER_KEY",
    "test-only-model-credential-master-key-material"
  );
});

async function temporaryRoot(label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
  vi.unstubAllEnvs();
});

function configuredOpenAiAgent(overrides = {}) {
  return {
    uid: "agent_openai_primary",
    instanceId: "agent_openai_primary",
    alias: "agent_openai_primary",
    provider: "openai",
    label: "OpenAI primary",
    baseUrl: "https://api.example.test/v1",
    model: "example-model",
    apiKey: "test-only-key",
    apiKeyConfigured: true,
    tokenHeader: "Authorization",
    tokenPrefix: "Bearer ",
    timeoutMs: 30_000,
    moduleAccess: { mode: "selected", moduleIds: [] },
    ...overrides
  };
}

function runConcurrentSettingsSave({ userDataPath, agentId }) {
  const source = `
    import { saveSettings } from "@meshrix/server-runtime/composition/settings";
    const agentId = process.env.MESHRIX_TEST_AGENT_ID;
    try {
      const saved = await saveSettings(process.env.MESHRIX_TEST_USER_DATA_PATH, {
        modelLibraryRevision: 1,
        modelLibraryEntries: ["openai"],
        modelLibraryAgents: [{
          uid: agentId,
          instanceId: agentId,
          alias: agentId,
          provider: "openai",
          label: agentId,
          baseUrl: "https://api.example.test/v1",
          model: "example-model",
          apiKey: "test-only-key",
          apiKeyConfigured: true,
          tokenHeader: "Authorization",
          tokenPrefix: "Bearer ",
          timeoutMs: 30000,
          moduleAccess: { mode: "selected", moduleIds: [] }
        }],
        gatewayAssistantDefaults: { systemPrompt: agentId }
      }, { redactSecrets: true });
      process.stdout.write(JSON.stringify({ ok: true, revision: saved.modelLibraryRevision, agentId }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error?.code || "unknown", agentId }));
      process.exitCode = 1;
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: {
        ...process.env,
        MESHRIX_TEST_USER_DATA_PATH: userDataPath,
        MESHRIX_TEST_AGENT_ID: agentId
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}

function runConcurrentRegistryReplace({ rootPath, agentId }) {
  const source = `
    import { AgentConfigRegistry } from "@meshrix/agents/agent-configs/config-registry";
    const agentId = process.env.MESHRIX_TEST_AGENT_ID;
    const registry = new AgentConfigRegistry({ rootPath: process.env.MESHRIX_TEST_REGISTRY_ROOT });
    try {
      await registry.replaceFromModelLibraryAgents([{
        uid: agentId,
        instanceId: agentId,
        alias: agentId,
        provider: "openai",
        label: agentId,
        baseUrl: "https://api.example.test/v1",
        model: "example-model",
        apiKey: "test-only-key",
        apiKeyConfigured: true,
        tokenHeader: "Authorization",
        tokenPrefix: "Bearer ",
        timeoutMs: 30000,
        moduleAccess: { mode: "selected", moduleIds: [] }
      }], { expectedRevision: 1 });
      process.stdout.write(JSON.stringify({ ok: true, revision: registry.revision, agentId }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error?.code || "unknown", agentId }));
      process.exitCode = 1;
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: {
        ...process.env,
        MESHRIX_TEST_REGISTRY_ROOT: rootPath,
        MESHRIX_TEST_AGENT_ID: agentId
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}

describe("canonical model provider runtime", () => {
  it("probes the explicitly selected OpenAI agent through the real gateway transport", async () => {
    const userDataPath = await temporaryRoot("meshrix-model-provider");
    const apiPatch = normalizeAgentModelPayload({
      tokenHeader: "Authorization",
      tokenPrefix: "Bearer "
    });
    expect(apiPatch.tokenPrefix).toBe("Bearer ");
    const entry = configuredOpenAiAgent(apiPatch);
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://api.example.test/v1/chat/completions");
      expect(init.headers.Authorization).toBe("Bearer test-only-key");
      const body = JSON.parse(init.body);
      expect(body.model).toBe("example-model");
      expect(body.messages).toEqual([
        expect.objectContaining({ role: "user", content: expect.stringContaining("MeshrixProbeOK") })
      ]);
      return new Response(JSON.stringify({
        id: "response-1",
        model: "example-model",
        choices: [{ finish_reason: "stop", message: { content: "MeshrixProbeOK" } }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const settings = { modelLibraryAgents: [entry] };
    expect(publicAgentGatewayRegistry(settings)).toMatchObject({
      defaultAlias: "",
      agents: [{ alias: entry.uid, provider: "openai", urlConfigured: true }]
    });
    const probe = await probeModelConnection({
      provider: "openai",
      modelAlias: entry.uid,
      settings,
      userDataPath,
      fetchImpl,
      egressLookup: async () => [{ address: "192.0.2.1", family: 4 }]
    });
    expect(probe).toMatchObject({
      ok: true,
      configured: true,
      provider: "openai",
      model: "example-model",
      statusCode: 200,
      answerSnippet: "MeshrixProbeOK"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects control characters in model credential prefixes", () => {
    expect(() => normalizeAgentModelPayload({ tokenPrefix: "Bearer\r\nInjected: yes" }))
      .toThrow(/CR, LF, or NUL/u);
    expect(() => normalizeAgentModelPayload({ tokenHeader: "Host" }))
      .toThrow(/reserved/u);
    expect(() => normalizeAgentModelPayload({ tokenHeader: "Authorization\nX-Test" }))
      .toThrow(/valid HTTP field name/u);
    expect(() => normalizeAgentModelPayload({
      baseUrl: ["https://user", "password@example.test/v1?credential=value"].join(":")
    })).toThrow(/userinfo, query, or fragment/u);
  });

  it("applies omitted, explicit-clear, replacement, and zero-timeout agent patches truthfully", () => {
    const current = configuredOpenAiAgent();
    expect(applyAgentModelPatch(current, normalizeAgentModelPayload({
      label: "renamed"
    }))).toMatchObject({
      label: "renamed",
      apiKey: "test-only-key",
      apiKeyConfigured: true
    });
    expect(applyAgentModelPatch(current, normalizeAgentModelPayload({
      apiKey: "",
      timeoutMs: 0
    }))).toMatchObject({
      apiKey: "",
      apiKeyConfigured: false,
      timeoutMs: 0
    });
    expect(applyAgentModelPatch(current, normalizeAgentModelPayload({
      apiKey: "replacement-key"
    }))).toMatchObject({
      apiKey: "replacement-key",
      apiKeyConfigured: true
    });
    expect(applyAgentModelPatch(current, normalizeAgentModelPayload({
      baseUrl: "https://changed.example.test/v1"
    }))).toMatchObject({
      baseUrl: "https://changed.example.test/v1",
      apiKey: "",
      apiKeyConfigured: false
    });
  });

  it("fails closed when provider or model identity is not explicit", async () => {
    const settings = { modelLibraryAgents: [configuredOpenAiAgent()] };
    expect(resolveAgentGatewayConfig(settings, { provider: "openai" }).alias).toBe("");
    expect(resolveAgentGatewayConfig(settings, { model: "example-model" }).alias).toBe("");
    expect(resolveAgentGatewayConfig(settings, {
      provider: "openai",
      modelAlias: "agent_openai_primary"
    }).alias).toBe("agent_openai_primary");
    await expect(probeModelConnection({ settings })).resolves.toMatchObject({
      ok: false,
      configured: false,
      provider: "unknown"
    });
    await expect(probeModelConnection({
      provider: "openai",
      modelAlias: "missing",
      settings
    })).resolves.toMatchObject({
      ok: false,
      configured: false,
      provider: "openai"
    });
  });

  it("persists agent credentials only in the canonical registry and redacts projections", async () => {
    const rootPath = await temporaryRoot("meshrix-agent-config-registry");
    const registry = new AgentConfigRegistry({ rootPath });
    const entry = configuredOpenAiAgent();
    await registry.replaceFromModelLibraryAgents([entry]);

    expect(registry.getModelLibraryAgents()).toEqual([
      expect.objectContaining({ uid: entry.uid, apiKey: "test-only-key" })
    ]);
    expect(registry.getModelLibraryAgents({ redactSecrets: true })).toEqual([
      expect.objectContaining({ uid: entry.uid, apiKey: "", apiKeyConfigured: true })
    ]);

    const modelFiles = (await fs.readdir(registry.modelListPath))
      .filter((file) => file !== "manifest.json");
    expect(modelFiles).toHaveLength(1);
    const modelPath = path.join(registry.modelListPath, modelFiles[0]);
    const stat = await fs.stat(modelPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const persistedModel = await fs.readFile(modelPath, "utf8");
    expect(persistedModel).not.toContain("test-only-key");
    expect(persistedModel).toContain("model-credential://");
    const credentialFiles = await fs.readdir(path.join(rootPath, "credentials"));
    expect(credentialFiles).toHaveLength(1);
    expect(await fs.readFile(path.join(rootPath, "credentials", credentialFiles[0]), "utf8"))
      .not.toContain("test-only-key");

    await registry.replaceFromModelLibraryAgents([
      { ...registry.getModelLibraryAgents({ redactSecrets: true })[0] }
    ]);
    expect(registry.getModelLibraryAgents()[0].apiKey).toBe("test-only-key");
  });

  it("keeps the previous generation intact when replacement staging fails", async () => {
    const rootPath = await temporaryRoot("meshrix-agent-config-rollback");
    const registry = new AgentConfigRegistry({ rootPath });
    const entry = configuredOpenAiAgent();
    await registry.replaceFromModelLibraryAgents([entry]);
    const before = JSON.parse(await fs.readFile(
      path.join(rootPath, "current.json"),
      "utf8"
    ));

    await expect(registry.replaceFromModelLibraryAgents([{
      ...entry,
      tokenPrefix: "Bearer\nInjected: yes"
    }])).rejects.toThrow(/CR, LF, or NUL/u);
    await registry.refresh();
    const after = JSON.parse(await fs.readFile(
      path.join(rootPath, "current.json"),
      "utf8"
    ));
    expect(after).toEqual(before);
    expect(registry.getModelLibraryAgents()).toEqual([
      expect.objectContaining({ uid: entry.uid, apiKey: "test-only-key" })
    ]);
  });

  it("rejects case-fold identity collisions without changing the active generation", async () => {
    const rootPath = await temporaryRoot("meshrix-agent-config-collision");
    const registry = new AgentConfigRegistry({ rootPath });
    const entry = configuredOpenAiAgent({
      uid: "Agent_X",
      instanceId: "Agent_X",
      alias: "Agent_X"
    });
    await registry.replaceFromModelLibraryAgents([entry]);
    const beforeGeneration = registry.generation;
    await expect(registry.replaceFromModelLibraryAgents([
      entry,
      configuredOpenAiAgent({
        uid: "agent_x",
        instanceId: "agent_x",
        alias: "agent_x"
      })
    ])).rejects.toThrow(/differs only by case/u);
    await registry.refresh();
    expect(registry.generation).toBe(beforeGeneration);
    expect(registry.getModelLibraryAgents()).toHaveLength(1);
  });

  it("commits one cross-process current-pointer replacement per expected revision", async () => {
    const rootPath = await temporaryRoot("meshrix-agent-config-cross-process-cas");
    const registry = new AgentConfigRegistry({ rootPath });
    await registry.replaceFromModelLibraryAgents([configuredOpenAiAgent()]);

    const attempts = await Promise.all([
      runConcurrentRegistryReplace({ rootPath, agentId: "agent_registry_alpha" }),
      runConcurrentRegistryReplace({ rootPath, agentId: "agent_registry_beta" })
    ]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([0, 1]);
    expect(attempts.every((attempt) => attempt.stderr === "")).toBe(true);
    const results = attempts.map((attempt) => JSON.parse(attempt.stdout));
    const success = results.find((result) => result.ok);
    const conflict = results.find((result) => !result.ok);
    expect(success.revision).toBe(2);
    expect(conflict.code).toBe("agent_config_registry_revision_conflict");

    await registry.refresh();
    expect(registry.revision).toBe(2);
    expect(registry.getModelLibraryAgents()).toEqual([
      expect.objectContaining({ uid: success.agentId, apiKey: "test-only-key" })
    ]);
    expect(JSON.parse(await fs.readFile(path.join(rootPath, "current.json"), "utf8")))
      .toMatchObject({ generation: registry.generation, revision: 2 });
    await expect(fs.access(path.join(rootPath, ".mutation.lock")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never preserves or sends a redacted credential after its provider origin changes", async () => {
    const rootPath = await temporaryRoot("meshrix-agent-credential-binding");
    const registry = new AgentConfigRegistry({ rootPath });
    const current = configuredOpenAiAgent({ baseUrl: "https://old.example.test/v1" });
    await registry.replaceFromModelLibraryAgents([current]);

    const changed = {
      ...registry.getModelLibraryAgents({ redactSecrets: true })[0],
      baseUrl: "https://changed.example.test/v1"
    };
    await registry.replaceFromModelLibraryAgents([changed]);
    expect(registry.getModelLibraryAgents()[0]).toMatchObject({
      apiKey: "",
      apiKeyConfigured: false,
      tokenConfigured: false
    });

    const merged = mergeSettingsForModelProbe(
      { modelLibraryAgents: [current] },
      { modelLibraryAgents: [changed] },
      normalizeSettings
    );
    expect(merged.modelLibraryAgents[0].apiKey).toBe("");

    const fetchImpl = vi.fn();
    const probe = await probeModelConnection({
      provider: "openai",
      modelAlias: current.uid,
      settings: merged,
      userDataPath: rootPath,
      fetchImpl,
      egressLookup: async () => [{ address: "192.0.2.1", family: 4 }]
    });
    expect(probe).toMatchObject({ ok: false, configured: false });
    expect(probe.message).toMatch(/missing-credential/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps registry-owned model records out of the main settings document", async () => {
    const userDataPath = await temporaryRoot("meshrix-settings-ownership");
    const entry = configuredOpenAiAgent();
    await saveSettings(userDataPath, {
      modelLibraryRevision: 0,
      modelLibraryEntries: ["openai"],
      modelLibraryAgentIds: [entry.uid],
      modelLibraryAgents: [entry]
    });
    const persisted = JSON.parse(
      await fs.readFile(path.join(userDataPath, "settings.json"), "utf8")
    );
    expect(persisted).not.toHaveProperty("modelLibraryEntries");
    expect(persisted).not.toHaveProperty("modelLibraryAgentIds");
    expect(persisted).not.toHaveProperty("modelLibraryAgents");
  });

  it("rolls back registry and split settings when a multi-document save fails", async () => {
    const userDataPath = await temporaryRoot("meshrix-settings-transaction-rollback");
    const original = configuredOpenAiAgent();
    await saveSettings(userDataPath, {
      modelLibraryRevision: 0,
      modelLibraryEntries: ["openai"],
      modelLibraryAgents: [original],
      agentToolExecution: {
        functionCallSchema: { version: "old" },
        http: {},
        local: {}
      }
    });
    const cyclic = {};
    cyclic.self = cyclic;
    const replacement = configuredOpenAiAgent({
      uid: "agent_openai_replacement",
      instanceId: "agent_openai_replacement",
      alias: "agent_openai_replacement"
    });

    await expect(saveSettings(userDataPath, {
      modelLibraryRevision: 1,
      modelLibraryEntries: ["openai"],
      modelLibraryAgents: [replacement],
      agentToolExecution: {
        functionCallSchema: { version: "new" },
        http: {},
        local: {}
      },
      gatewayAssistantDefaults: {
        invalidCyclicValue: cyclic
      }
    })).rejects.toThrow(/circular|cyclic/iu);

    const restored = await loadSettings(userDataPath);
    expect(restored.modelLibraryAgents).toEqual([
      expect.objectContaining({ uid: original.uid, apiKey: "test-only-key" })
    ]);
    expect(restored.agentToolExecution.functionCallSchema).toEqual({ version: "old" });
    expect(restored.gatewayAssistantDefaults).not.toHaveProperty("invalidCyclicValue");
  });

  it("rejects stale model-library snapshots with revision compare-and-swap", async () => {
    const userDataPath = await temporaryRoot("meshrix-model-library-cas");
    const original = configuredOpenAiAgent();
    const first = await saveSettings(userDataPath, {
      modelLibraryRevision: 0,
      modelLibraryEntries: ["openai"],
      modelLibraryAgents: [original]
    });
    expect(first.modelLibraryRevision).toBe(1);

    await expect(saveSettings(userDataPath, {
      modelLibraryRevision: 0,
      modelLibraryEntries: ["openai"],
      modelLibraryAgents: [configuredOpenAiAgent({
        uid: "stale-agent",
        instanceId: "stale-agent",
        alias: "stale-agent"
      })]
    })).rejects.toMatchObject({
      code: "model_library_revision_conflict",
      statusCode: 409,
      expectedRevision: 0,
      currentRevision: 1
    });
    expect((await loadSettings(userDataPath)).modelLibraryAgents[0].uid).toBe(original.uid);
  });

  it("serializes cross-process settings and model-pointer compare-and-swap", async () => {
    const userDataPath = await temporaryRoot("meshrix-settings-cross-process-cas");
    await saveSettings(userDataPath, {
      modelLibraryRevision: 0,
      modelLibraryEntries: ["openai"],
      modelLibraryAgents: [configuredOpenAiAgent()]
    });

    const attempts = await Promise.all([
      runConcurrentSettingsSave({ userDataPath, agentId: "agent_concurrent_alpha" }),
      runConcurrentSettingsSave({ userDataPath, agentId: "agent_concurrent_beta" })
    ]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([0, 1]);
    expect(attempts.every((attempt) => attempt.stderr === "")).toBe(true);
    const results = attempts.map((attempt) => JSON.parse(attempt.stdout));
    const success = results.find((result) => result.ok);
    const conflict = results.find((result) => !result.ok);
    expect(success.revision).toBe(2);
    expect(conflict.code).toBe("model_library_revision_conflict");

    const loaded = await loadSettings(userDataPath);
    expect(loaded.modelLibraryRevision).toBe(2);
    expect(loaded.modelLibraryAgents).toEqual([
      expect.objectContaining({ uid: success.agentId, apiKey: "test-only-key" })
    ]);
    expect(loaded.gatewayAssistantDefaults.systemPrompt).toBe(success.agentId);
    const pointer = JSON.parse(await fs.readFile(
      path.join(userDataPath, "agent-configs", "current.json"),
      "utf8"
    ));
    expect(pointer.revision).toBe(2);
    await expect(fs.access(path.join(userDataPath, ".settings.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(
      userDataPath,
      "agent-configs",
      ".settings-transaction.json"
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a prepared cross-document transaction after process termination", async () => {
    const userDataPath = await temporaryRoot("meshrix-settings-crash-recovery");
    const original = configuredOpenAiAgent();
    await saveSettings(userDataPath, {
      modelLibraryRevision: 0,
      modelLibraryEntries: ["openai"],
      modelLibraryAgents: [original],
      agentToolExecution: {
        functionCallSchema: { version: "stable" },
        http: {},
        local: {}
      },
      gatewayAssistantDefaults: { systemPrompt: "stable" }
    });
    const registryRoot = path.join(userDataPath, "agent-configs");
    const settingsPath = path.join(userDataPath, "settings.json");
    const agentToolPath = path.join(userDataPath, "operation-permission", "execution.json");
    const previousPointer = JSON.parse(await fs.readFile(path.join(registryRoot, "current.json"), "utf8"));
    const previousMain = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    const previousAgentTool = JSON.parse(await fs.readFile(agentToolPath, "utf8"));

    const registry = new AgentConfigRegistry({ rootPath: registryRoot });
    const replacement = configuredOpenAiAgent({
      uid: "agent_after_interrupted_save",
      instanceId: "agent_after_interrupted_save",
      alias: "agent_after_interrupted_save"
    });
    await registry.replaceFromModelLibraryAgents([replacement], { expectedRevision: 1 });
    const interruptedGeneration = registry.generation;
    await fs.writeFile(settingsPath, `${JSON.stringify({
      gatewayAssistantDefaults: { systemPrompt: "interrupted" }
    }, null, 2)}\n`, "utf8");
    await fs.writeFile(agentToolPath, `${JSON.stringify({
      functionCallSchema: { version: "interrupted" },
      http: {},
      local: {}
    }, null, 2)}\n`, "utf8");
    const transactionId = "a".repeat(32);
    await fs.writeFile(path.join(registryRoot, ".settings-transaction.json"), `${JSON.stringify({
      format: "settings-transaction-journal",
      schema: 1,
      phase: "prepared",
      transactionId,
      createdAt: new Date().toISOString(),
      previous: {
        main: { exists: true, value: previousMain },
        agentToolExecution: { exists: true, value: previousAgentTool },
        registryPointer: previousPointer
      }
    }, null, 2)}\n`, { mode: 0o600 });
    await fs.writeFile(path.join(userDataPath, ".settings.lock"), `${JSON.stringify({
      token: "interrupted-owner",
      pid: 2_147_483_647,
      createdAt: new Date().toISOString()
    })}\n`, { mode: 0o600 });

    const blockedRegistry = new AgentConfigRegistry({ rootPath: registryRoot });
    await expect(blockedRegistry.replaceFromModelLibraryAgents([replacement], {
      expectedRevision: 2
    })).rejects.toMatchObject({ code: "agent_config_registry_transaction_pending" });

    const recovered = await loadSettings(userDataPath);
    expect(recovered.modelLibraryRevision).toBe(1);
    expect(recovered.modelLibraryAgents).toEqual([
      expect.objectContaining({ uid: original.uid, apiKey: "test-only-key" })
    ]);
    expect(recovered.gatewayAssistantDefaults.systemPrompt).toBe("stable");
    expect(recovered.agentToolExecution.functionCallSchema).toEqual({ version: "stable" });
    expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual(previousMain);
    expect(JSON.parse(await fs.readFile(agentToolPath, "utf8"))).toEqual(previousAgentTool);
    expect(JSON.parse(await fs.readFile(path.join(registryRoot, "current.json"), "utf8")))
      .toEqual(previousPointer);
    await expect(fs.access(path.join(registryRoot, "generations", interruptedGeneration)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(registryRoot, ".settings-transaction.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(userDataPath, ".settings.lock")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps module bindings and profiles attached to registry-owned agents across save and load", async () => {
    const userDataPath = await temporaryRoot("meshrix-settings-agent-bindings");
    const entry = configuredOpenAiAgent({
      moduleAccess: { mode: "selected", moduleIds: ["gatewayRouting"] }
    });
    await saveSettings(userDataPath, {
      modelLibraryRevision: 0,
      modelLibraryEntries: ["openai"],
      modelLibraryAgents: [entry],
      moduleIntelligence: { gatewayRouting: true },
      moduleModelAssignments: {
        gatewayRouting: { provider: "openai", model: entry.uid }
      },
      moduleAgentProfiles: {
        gatewayRouting: {
          primaryAgent: entry.uid,
          agents: {
            [entry.uid]: {
              enabled: true,
              role: "router",
              contextProfileId: "explicit-context-profile",
              systemPrompt: "Route explicitly.",
              parameters: { temperature: 0 },
              dependencyContext: { source: "explicit" }
            }
          }
        }
      }
    });

    const loaded = await loadSettings(userDataPath);
    expect(loaded.modelLibraryAgents).toEqual([
      expect.objectContaining({ uid: entry.uid, apiKey: "test-only-key" })
    ]);
    expect(loaded.moduleModelAssignments).toEqual({
      gatewayRouting: { provider: "openai", model: entry.uid }
    });
    expect(loaded.moduleAgentProfiles.gatewayRouting).toMatchObject({
      primaryAgent: entry.uid,
      agents: {
        [entry.uid]: {
          enabled: true,
          role: "router",
          contextProfileId: "explicit-context-profile"
        }
      }
    });

    const persisted = JSON.parse(
      await fs.readFile(path.join(userDataPath, "settings.json"), "utf8")
    );
    expect(persisted.moduleModelAssignments).toEqual(loaded.moduleModelAssignments);
    expect(persisted.moduleAgentProfiles).toEqual(loaded.moduleAgentProfiles);
    expect(persisted).not.toHaveProperty("modelLibraryAgents");
  });

  it("projects the same readiness rules for all five runtime providers", async () => {
    const userDataPath = await temporaryRoot("meshrix-provider-readiness");
    const providers = ["openai", "deepseek", "openrouter", "copilot", "local-model"];
    const entries = providers.map((provider) => configuredOpenAiAgent({
      uid: `agent_${provider.replace(/-/gu, "_")}`,
      instanceId: `agent_${provider.replace(/-/gu, "_")}`,
      alias: `agent_${provider.replace(/-/gu, "_")}`,
      provider,
      label: provider,
      ...(provider === "local-model"
        ? {
            apiKey: "",
            apiKeyConfigured: false,
            token: "",
            tokenConfigured: false,
            tokenHeader: "",
            tokenPrefix: ""
          }
        : {})
    }));
    await saveSettings(userDataPath, {
      modelLibraryRevision: 0,
      modelLibraryEntries: providers,
      modelLibraryAgents: entries
    });
    const projection = await buildAgentSettingsConsoleProjection({
      userDataPath,
      settingsPort,
      getAgentConfigRegistry: () => new AgentConfigRegistry({
        rootPath: path.join(userDataPath, "agent-configs")
      })
    });
    expect(projection.agentSelector.options).toHaveLength(5);
    expect(projection.agentSelector.options.map((option) => ({
      provider: option.provider,
      selectable: option.selectable,
      capabilities: option.capabilities
    }))).toEqual(providers.map((provider) => ({
      provider,
      selectable: true,
      capabilities: ["agent.invoke", "gateway.forward"]
    })));

    const incomplete = publicAgentGatewayRegistry({
      modelLibraryAgents: [{ ...entries[0], timeoutMs: 0 }]
    });
    expect(incomplete.agents[0]).toMatchObject({
      configured: false,
      status: "unconfigured",
      capabilities: []
    });
    const localWithoutTimeout = publicAgentGatewayRegistry({
      modelLibraryAgents: [{ ...entries[4], timeoutMs: 0 }]
    });
    expect(localWithoutTimeout.agents[0]).toMatchObject({
      configured: false,
      status: "unconfigured",
      capabilities: []
    });
  });
});
