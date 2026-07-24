import { describe, expect, it, vi } from "vitest";

const contextCoreMocks = vi.hoisted(() => ({
  createContextRuntime: vi.fn((options = {}) => ({ service: "context-runtime", options })),
  estimateTokens: vi.fn((value) => String(value ?? "").length)
}));

const contextCompactMocks = vi.hoisted(() => ({
  buildMessageGraph: vi.fn((messages = []) => ({ graph: messages.length })),
  chooseCompactionCutPoint: vi.fn((messages = [], options = {}) => ({ cutIndex: messages.length - 1, options })),
  computeCompactionBudget: vi.fn((profile = {}, policyPatch = {}) => ({ profile, policyPatch })),
  createContextCompactionStrategyAdapter: vi.fn((options = {}) => ({ service: "strategy-adapter", options })),
  createContextCompactionRuntime: vi.fn((options = {}) => ({ service: "compaction-runtime", options })),
  estimateContextTokens: vi.fn((value) => String(value ?? "").split(/\s+/).filter(Boolean).length),
  listContextCompactionStrategies: vi.fn((extraStrategies = []) => ["deterministic", ...extraStrategies]),
  normalizeCompactionPolicy: vi.fn((profile = {}, patch = {}) => ({ ...profile, ...patch })),
  redactCompactionValue: vi.fn((value, depth = 0) => ({ redacted: value, depth }))
}));

vi.mock("../../../packages/server-runtime/src/state/context-core/index.mjs", () => ({
  CONTEXT_RUNTIME_PROTOCOL_VERSION: "context-runtime-test.v1",
  createContextRuntime: contextCoreMocks.createContextRuntime,
  estimateTokens: contextCoreMocks.estimateTokens
}));

vi.mock("../../../packages/server-runtime/src/state/context-compact/index.mjs", () => ({
  CONTEXT_COMPACTION_PROTOCOL_VERSION: "context-compaction-test.v1",
  buildMessageGraph: contextCompactMocks.buildMessageGraph,
  chooseCompactionCutPoint: contextCompactMocks.chooseCompactionCutPoint,
  computeCompactionBudget: contextCompactMocks.computeCompactionBudget,
  createContextCompactionStrategyAdapter: contextCompactMocks.createContextCompactionStrategyAdapter,
  createContextCompactionRuntime: contextCompactMocks.createContextCompactionRuntime,
  estimateContextTokens: contextCompactMocks.estimateContextTokens,
  listContextCompactionStrategies: contextCompactMocks.listContextCompactionStrategies,
  normalizeCompactionPolicy: contextCompactMocks.normalizeCompactionPolicy,
  redactCompactionValue: contextCompactMocks.redactCompactionValue
}));

const agentContextInterface = await import("../../../packages/server-runtime/src/state/interface/index.mjs");

describe("agent context interface", () => {
  it("exposes protocol versions and sorted default method metadata", () => {
    expect(agentContextInterface.AGENT_CONTEXT_INTERFACE_PROTOCOL_VERSION).toBe("meshrix.agent_context.interface.v1");
    expect(agentContextInterface.CONTEXT_RUNTIME_PROTOCOL_VERSION).toBe("context-runtime-test.v1");
    expect(agentContextInterface.CONTEXT_COMPACTION_PROTOCOL_VERSION).toBe("context-compaction-test.v1");

    const registry = agentContextInterface.getAgentContextInterface();
    expect(registry.protocolVersion).toBe("meshrix.agent_context.interface.v1");
    expect(registry.has(" context.createRuntime ")).toBe(true);
    expect(registry.has("missing.method")).toBe(false);
    expect(registry.listMethods()).toEqual([...registry.listMethods()].sort());
    expect(agentContextInterface.default()).toBe(registry);
  });

  it("calls default context and compaction handlers through wrapper helpers", () => {
    expect(agentContextInterface.createContextRuntime({ userDataPath: "/tmp/context" })).toEqual({
      service: "context-runtime",
      options: { userDataPath: "/tmp/context" }
    });
    expect(agentContextInterface.estimateTokens("abc")).toBe(3);
    expect(agentContextInterface.createContextCompactionRuntime({ mode: "unit" })).toEqual({
      service: "compaction-runtime",
      options: { mode: "unit" }
    });
    expect(agentContextInterface.computeCompactionBudget({ maxTokens: 100 }, { ratio: 0.5 })).toEqual({
      profile: { maxTokens: 100 },
      policyPatch: { ratio: 0.5 }
    });
    expect(agentContextInterface.createContextCompactionStrategyAdapter({ id: "s1" })).toEqual({
      service: "strategy-adapter",
      options: { id: "s1" }
    });
    expect(agentContextInterface.listContextCompactionStrategies(["custom"])).toEqual(["deterministic", "custom"]);
    expect(agentContextInterface.normalizeCompactionPolicy({ keep: true }, { max: 10 })).toEqual({
      keep: true,
      max: 10
    });
    expect(agentContextInterface.buildMessageGraph([{ role: "user" }, { role: "assistant" }])).toEqual({ graph: 2 });
    expect(agentContextInterface.chooseCompactionCutPoint([{ id: 1 }], { budget: 10 })).toEqual({
      cutIndex: 0,
      options: { budget: 10 }
    });
    expect(agentContextInterface.estimateContextTokens("one two")).toBe(2);
    expect(agentContextInterface.redactCompactionValue({ secret: "x" }, 2)).toEqual({
      redacted: { secret: "x" },
      depth: 2
    });
  });

  it("supports custom registrations and rejects invalid registry entries", () => {
    const custom = vi.fn((left, right) => left + right);
    const registry = agentContextInterface.createAgentContextInterface({
      registrations: [["custom.add", custom]]
    });

    expect(registry.has("custom.add")).toBe(true);
    expect(registry.call(" custom.add ", 2, 3)).toBe(5);
    expect(custom).toHaveBeenCalledWith(2, 3);
    expect(() => registry.call("missing")).toThrow("agent_context_interface_method_unregistered:missing");

    expect(() => agentContextInterface.createAgentContextInterface({
      registrations: [["", custom]]
    })).toThrow("agent_context_interface_method_required");
    expect(() => agentContextInterface.createAgentContextInterface({
      registrations: [["custom.bad", null]]
    })).toThrow("agent_context_interface_handler_invalid:custom.bad");
    expect(() => agentContextInterface.createAgentContextInterface({
      registrations: [["context.createRuntime", custom]]
    })).toThrow("agent_context_interface_method_duplicate:context.createRuntime");
  });
});
