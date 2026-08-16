import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("user configuration truth", () : any => {
  it("keeps the server settings projection empty without explicit input", async () : Promise<any> => {
    const {
      normalizeAgentToolExecution,
      normalizeSettings,
    } = await import("../../../packages/server-runtime/src/composition/platform-core/settings-normalizers.ts");

    const normalized: any = normalizeSettings({});
    expect(Object.keys(normalized).sort()).toEqual(["agentToolExecution", "executionSandbox"]);
    expect(normalized.executionSandbox).toBeNull();
    expect(normalizeAgentToolExecution({})).toMatchObject({
      functionCallSchema: {},
      http: { enabled: false, allowedHosts: [], timeoutMs: 0, maxResponseBytes: 0 },
      local: { enabled: false, commands: [], timeoutMs: 0, maxOutputBytes: 0 },
    });
    expect(normalizeSettings({
      defaultModel: "retired-model",
      modelLibraryAgents: [{ provider: "retired-provider" }],
      gatewayAssistantDefaults: { systemPrompt: "retired" }
    })).toEqual(normalized);
  });

  it("does not persist retired model registry fields", async () : Promise<any> => {
    const root: any = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(os.tmpdir(), "meshrix-settings-empty-"))
    );
    try {
      const { loadSettings, saveSettings } = await import(
        "../../../packages/server-runtime/src/composition/platform-core/settings-persistence.ts"
      );
      await saveSettings(root, {
        defaultModel: "retired-model",
        modelLibraryAgents: [{ provider: "retired-provider" }]
      });
      expect(await loadSettings(root)).toMatchObject({
        executionSandbox: null,
        agentToolExecution: { http: { enabled: false }, local: { enabled: false } }
      });
      const persisted = await import("node:fs/promises").then(({ readFile }) =>
        readFile(path.join(root, "settings.json"), "utf8")
      );
      expect(persisted).not.toMatch(/model|provider/iu);
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
    }
  });

  it("keeps discovery identity, URLs, mode, and polling intervals empty before configuration", async () : Promise<any> => {
    const root: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-discovery-empty-"));
    try {
      const { loadDiscoveryConfig, resolveDiscoveryState } = await import(
        "../../../packages/server-runtime/src/composition/discovery-config.ts"
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
      const runtimeObservation: any = await resolveDiscoveryState(root, {
        listenUrl: "http://127.0.0.1:7228",
      });
      expect(runtimeObservation.advertisedBaseUrl).toBe("");
      expect(runtimeObservation.activeServiceUrl).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps sandbox provider executables outside persisted user configuration", async () : Promise<any> => {
    const { normalizeSettings } = await import(
      "../../../packages/server-runtime/src/composition/platform-core/settings-normalizers.ts"
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
