import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AGENT_MEMORY_PROTOCOL_VERSION,
  createAgentMemory
} from "../../packages/agents/src/agent-memory/index.mjs";
import { createContextRuntime } from "../../packages/server-runtime/src/state/interface/index.mjs";

const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-agent-memory-"));
const CONTEXT_PROFILE_ID = "memory-verifier-profile";
const CONTEXT_PROFILE = Object.freeze({
  profileId: CONTEXT_PROFILE_ID,
  label: "Agent memory verifier",
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
    fallback: "deterministic-extractive"
  },
  compactionPolicy: {
    enabled: true,
    strategy: { id: "session-memory-first", params: {} },
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
    mode: "session-memory-first",
    threshold: 0.55,
    targetRatio: 0.3,
    protectLastNTurns: 5,
    summaryMaxTokens: 4_096,
    strategy: "deterministic-extractive"
  }
});

function message(index) {
  return {
    id: `msg-${index}`,
    role: index % 2 === 0 ? "assistant" : "user",
    apiRoundId: `round-${Math.floor(index / 2)}`,
    content: [
      `Agent memory verification message ${index}.`,
      "Keep decisions, evidence:ev-agent-memory, and tool status stable across compaction.",
      "This sentence is intentionally repeated to make the source large enough for compaction."
    ].join(" ")
  };
}

const agentMemory = createAgentMemory({ userDataPath });
assert.equal(agentMemory.protocolVersion, AGENT_MEMORY_PROTOCOL_VERSION);
assert.equal(agentMemory.sessionMemoryPath, path.join(userDataPath, "agent-memory", "session-memory.jsonl"));

const appended = await agentMemory.appendSessionMemory({
  sessionId: "direct-session",
  profileId: CONTEXT_PROFILE_ID,
  sourceHash: "hash-a",
  summary: "Use API token=secret and local file /private/example/private/source.txt.",
  structured: {
    keep: "decision",
    nested: {
      apiKey: "secret"
    }
  }
});
assert.equal(appended.protocolVersion, AGENT_MEMORY_PROTOCOL_VERSION);
assert.match(appended.memoryId, /^agent_memory_/);
assert.match(appended.summary, /<redacted>/);
assert.equal(appended.structured.nested.apiKey, "<redacted>");

const exact = await agentMemory.latestSessionMemory({
  sessionId: "direct-session",
  profileId: CONTEXT_PROFILE_ID,
  sourceHash: "hash-a"
});
assert.equal(exact.memoryId, appended.memoryId);

const missingHash = await agentMemory.latestSessionMemory({
  sessionId: "direct-session",
  profileId: CONTEXT_PROFILE_ID,
  sourceHash: "hash-b"
});
assert.equal(missingHash, null);

const cleared = await agentMemory.clearSessionMemory({
  sessionId: "direct-session",
  profileId: CONTEXT_PROFILE_ID,
  reason: "verify"
});
assert.equal(cleared.ok, true);
const afterClear = await agentMemory.latestSessionMemory({
  sessionId: "direct-session",
  profileId: CONTEXT_PROFILE_ID
});
assert.equal(afterClear, null);

const contextRuntime = createContextRuntime({
  userDataPath,
  agentMemory
});
await contextRuntime.saveProfiles({ profiles: [CONTEXT_PROFILE] });
const messages = Array.from({ length: 24 }, (_, index) => message(index + 1));
const firstRun = await contextRuntime.runCompaction({
  contextProfileId: CONTEXT_PROFILE_ID,
  sessionId: "runtime-session",
  messages,
  taskBrief: "Verify ContextRuntime persists through AgentMemory.",
  force: true,
  useSessionMemory: false
});
assert.equal(firstRun.status, "completed");
assert.notEqual(firstRun.executionMode, "session-memory");

const runtimeRecords = await agentMemory.listSessionMemory({ sessionId: "runtime-session" });
assert.equal(runtimeRecords.path, agentMemory.sessionMemoryPath);
assert.equal(runtimeRecords.records.length >= 1, true);
assert.equal(runtimeRecords.records[0].storagePath, agentMemory.sessionMemoryPath);

const reusedRun = await contextRuntime.runCompaction({
  contextProfileId: CONTEXT_PROFILE_ID,
  sessionId: "runtime-session",
  messages,
  taskBrief: "Verify ContextRuntime persists through AgentMemory.",
  force: true
});
assert.equal(reusedRun.executionMode, "session-memory");

console.log("Agent memory verification passed.");
process.exit(0);
