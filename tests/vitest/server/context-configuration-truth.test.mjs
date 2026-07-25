import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentMemory } from "../../../packages/agents/src/agent-memory/index.mjs";

import {
  createContextCompactionRuntime,
  normalizeCompactionPolicy
} from "../../../packages/server-runtime/src/state/context-compact/index.mjs";
import {
  buildReinjectionPayload,
  compactToBudget,
  modelInputForAttempt
} from "../../../packages/server-runtime/src/state/context-compact/projection.mjs";
import { selectRecentTurnsByBudget } from "../../../packages/server-runtime/src/state/context-core/projection.mjs";
import { chooseCompactionCutPoint } from "../../../packages/server-runtime/src/state/context-compact/graph.mjs";
import { createContextRuntime } from "../../../packages/server-runtime/src/state/context-core/index.mjs";
import {
  normalizeProfile,
  normalizeProfiles
} from "../../../packages/server-runtime/src/state/context-core/profile.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), label));
  roots.push(root);
  return root;
}

function explicitContextProfile(profileId = "explicit-context-profile") {
  return {
    profileId,
    label: "Explicit context profile",
    modelAlias: "",
    contextWindowTokens: 32_768,
    outputReserveTokens: 4_096,
    toolReserveTokens: 3_072,
    fixedMemoryBudget: 1_024,
    referenceBudget: 10_000,
    historyBudget: 8_000,
    recentTurnBudget: 6_576,
    budgetPolicy: {
      fixedMemoryRatio: 0.04,
      operatorGuidanceRatio: 0.08,
      referenceRatio: 0.36,
      historyRatio: 0.26,
      recentTurnRatio: 0.18,
      toolStateRatio: 0.08
    },
    rankingWeights: {
      queryRelevance: 0.36,
      recency: 0.12,
      evidenceConfidence: 0.18,
      humanExpertBoost: 0.2,
      toolFreshness: 0.06,
      hierarchyLevel: 0.08
    },
    protectedEvidenceFields: ["who", "what", "when", "amount", "conflict", "confidence"],
    placementPolicy: {
      criticalEvidenceHeadCount: 8,
      evidenceTailChecklist: true,
      repeatTaskInTail: true
    },
    modelCompression: {
      enabled: false,
      alias: "",
      maxInputTokens: 0,
      maxOutputTokens: 0,
      fallback: ""
    },
    compactionPolicy: {
      enabled: true,
      strategy: { id: "deterministic-extractive", params: {} },
      summaryReserveTokens: 4_096,
      reservedBufferTokens: 6_000,
      warningBufferTokens: 9_000,
      hardBufferTokens: 1_024,
      hardThresholdRatio: 0.98,
      recentMessageProtectionCount: 5,
      recentTurnProtectionCount: 3,
      maxConsecutiveFailures: 3,
      ptlRetryLimit: 0,
      ptlHeadTrimRatio: 0.2,
      modelMaxInputTokens: 0,
      modelMaxOutputTokens: 0,
      deterministicTargetRatio: 0.25,
      reinjectionBudgetTokens: 1_200,
      maxToolResultTokens: 600,
      maxAttachmentTokens: 400,
      allowAttachmentDehydration: true,
      persistSessionMemory: true,
      persistBoundaries: true,
      microCompaction: true
    },
    compression: {
      enabled: true,
      mode: "",
      threshold: 0.55,
      targetRatio: 0.3,
      protectLastNTurns: 5,
      summaryMaxTokens: 4_096,
      strategy: "deterministic-extractive"
    }
  };
}

describe("context configuration truth", () => {
  it("keeps session memory bounded while preserving the newest valuable records", async () => {
    const root = await temporaryRoot("meshrix-context-memory-retention-");
    const agentMemory = createAgentMemory({
      userDataPath: root,
      maxStorageBytes: 4096,
      maxScanBytes: 4096,
      maxRecordBytes: 1024,
      maxStoredRecords: 5
    });

    for (let index = 0; index < 20; index += 1) {
      await agentMemory.appendSessionMemory({
        sessionId: `session-${index}`,
        summary: `valuable-${index}-${"x".repeat(700)}`,
        structured: { index, oversized: "y".repeat(2000) }
      });
      const stat = await fs.stat(agentMemory.sessionMemoryPath);
      expect(stat.size).toBeLessThanOrEqual(4096);
    }

    const listed = await agentMemory.listSessionMemory({ limit: 100 });
    expect(listed.records.length).toBeLessThanOrEqual(5);
    expect(listed.records[0]).toMatchObject({
      sessionId: "session-19",
      structured: {
        truncated: true,
        originalBytes: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{32}$/)
      }
    });
    expect(listed.records.some((record) => record.sessionId === "session-0")).toBe(false);
  });

  it("keeps sparse values empty and rejects incomplete or duplicate configured profiles", () => {
    const sparse = normalizeProfile({ profileId: "sparse" });
    expect(sparse).toMatchObject({
      profileId: "sparse",
      label: "",
      modelAlias: "",
      contextWindowTokens: null,
      outputReserveTokens: null,
      modelCompression: { enabled: null, alias: "", maxInputTokens: null },
      compression: { enabled: null, threshold: null, strategy: "" }
    });
    expect(sparse.compactionPolicy).not.toHaveProperty("strategyId");
    expect(() => normalizeProfiles([{ profileId: "sparse" }]))
      .toThrow(/context_profile_config_required:contextWindowTokens/u);
    expect(() => normalizeProfiles([explicitContextProfile(), explicitContextProfile()]))
      .toThrow(/context_profile_config_duplicate/u);
  });

  it("persists only canonical complete profiles and never resolves by a model or legacy id alias", async () => {
    const root = await temporaryRoot("meshrix-context-truth-");
    const runtime = createContextRuntime({
      userDataPath: root,
      agentMemory: createAgentMemory({ userDataPath: root })
    });
    await expect(runtime.listProfiles()).resolves.toMatchObject({ profiles: [] });
    await expect(runtime.saveProfiles({})).rejects.toThrow(/context_profiles_required/u);
    await runtime.saveProfiles({ profiles: [explicitContextProfile()] });
    await expect(runtime.resolveProfile({ modelAlias: "explicit-context-profile" }))
      .rejects.toThrow(/contextProfileId is required/u);
    await expect(runtime.resolveProfile({ profileId: "explicit-context-profile" }))
      .rejects.toThrow(/contextProfileId is required/u);
    await expect(runtime.resolveProfile({ contextProfileId: "explicit-context-profile" }))
      .resolves.toMatchObject({ profileId: "explicit-context-profile", modelAlias: "" });

    await fs.writeFile(runtime.profilesPath, "{not-json", "utf8");
    await expect(runtime.listProfiles()).rejects.toThrow();
  });

  it("honors zero budgets without retaining a first item or a hidden minimum", async () => {
    expect(compactToBudget("content that must not survive", 0)).toBe("");
    expect(buildReinjectionPayload({
      input: { taskBrief: "must not exceed a zero budget" },
      policy: { reinjectionBudgetTokens: 0 }
    })).toMatchObject({ items: [], budgetTokens: 0 });
    expect(modelInputForAttempt([{ text: "oversized message", apiRoundId: "round" }], 0, 0)).toEqual([]);
    expect(selectRecentTurnsByBudget([{ id: "old" }, { id: "latest" }], 0, 1)).toMatchObject({
      selected: [{ id: "latest" }],
      droppedCount: 1,
      protectedCount: 1,
      protectedBudgetOverrun: true
    });

    const profile = explicitContextProfile();
    const cutPoint = chooseCompactionCutPoint(
      [{ id: "only", role: "user", apiRoundId: "round", content: "one message" }],
      { profile }
    );
    expect(cutPoint.cutIndex).toBe(0);

    const emptyPolicy = normalizeCompactionPolicy({}, {});
    expect(emptyPolicy).not.toHaveProperty("strategyId");
    expect(emptyPolicy).toMatchObject({ enabled: null, strategy: { id: "", params: {} } });
    expect(() => normalizeCompactionPolicy({}, { strategy: "deterministic-extractive" }))
      .toThrow(/compactionPolicy.strategy/u);

    const root = await temporaryRoot("meshrix-context-compaction-truth-");
    const runtime = createContextCompactionRuntime({
      userDataPath: root,
      agentMemory: createAgentMemory({ userDataPath: root })
    });
    await expect(runtime.preview({ profile: {}, messages: [] }))
      .rejects.toThrow(/context_profile_config_required/u);
  });

  it("requires composition to inject the AgentMemory port", async () => {
    const root = await temporaryRoot("meshrix-context-memory-port-");
    expect(() => createContextCompactionRuntime({ userDataPath: root }))
      .toThrow(/explicit AgentMemory port/u);
    expect(() => createContextRuntime({ userDataPath: root }))
      .toThrow(/explicit AgentMemory port/u);
  });
});
