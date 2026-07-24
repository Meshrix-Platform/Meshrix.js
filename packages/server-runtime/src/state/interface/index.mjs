import {
  CONTEXT_RUNTIME_PROTOCOL_VERSION,
  createContextRuntime as createContextRuntimeInternal,
  estimateTokens as estimateRuntimeTokens
} from "../context-core/index.mjs";
import {
  CONTEXT_COMPACTION_PROTOCOL_VERSION,
  buildMessageGraph as buildMessageGraphInternal,
  chooseCompactionCutPoint as chooseCompactionCutPointInternal,
  computeCompactionBudget as computeCompactionBudgetInternal,
  createContextCompactionStrategyAdapter as createContextCompactionStrategyAdapterInternal,
  createContextCompactionRuntime as createContextCompactionRuntimeInternal,
  estimateContextTokens as estimateContextTokensInternal,
  listContextCompactionStrategies as listContextCompactionStrategiesInternal,
  normalizeCompactionPolicy as normalizeCompactionPolicyInternal,
  redactCompactionValue as redactCompactionValueInternal
} from "../context-compact/index.mjs";

export const AGENT_CONTEXT_INTERFACE_PROTOCOL_VERSION = "meshrix.agent_context.interface.v1";

// Agent-context is the internal runtime loop; external workflows live outside this interface.
const DEFAULT_METHODS = Object.freeze([
  ["context.createRuntime", createContextRuntimeInternal],
  ["context.estimateTokens", estimateRuntimeTokens],
  ["context.compaction.createRuntime", createContextCompactionRuntimeInternal],
  ["context.compaction.computeBudget", computeCompactionBudgetInternal],
  ["context.compaction.createStrategyAdapter", createContextCompactionStrategyAdapterInternal],
  ["context.compaction.listStrategies", listContextCompactionStrategiesInternal],
  ["context.compaction.normalizePolicy", normalizeCompactionPolicyInternal],
  ["context.compaction.buildMessageGraph", buildMessageGraphInternal],
  ["context.compaction.chooseCutPoint", chooseCompactionCutPointInternal],
  ["context.compaction.estimateTokens", estimateContextTokensInternal],
  ["context.compaction.redactValue", redactCompactionValueInternal]
]);

function normalizeMethodName(name) {
  return String(name || "").trim();
}

function createMethodRegistry(entries = DEFAULT_METHODS) {
  const methods = new Map();
  for (const [name, handler] of entries) {
    register(name, handler);
  }

  function register(name, handler) {
    const methodName = normalizeMethodName(name);
    if (!methodName) {
      throw new Error("agent_context_interface_method_required");
    }
    if (typeof handler !== "function") {
      throw new Error(`agent_context_interface_handler_invalid:${methodName}`);
    }
    if (methods.has(methodName)) {
      throw new Error(`agent_context_interface_method_duplicate:${methodName}`);
    }
    methods.set(methodName, handler);
    return methodName;
  }

  function call(name, ...args) {
    const methodName = normalizeMethodName(name);
    const handler = methods.get(methodName);
    if (!handler) {
      throw new Error(`agent_context_interface_method_unregistered:${methodName || "unknown"}`);
    }
    return handler(...args);
  }

  return Object.freeze({
    protocolVersion: AGENT_CONTEXT_INTERFACE_PROTOCOL_VERSION,
    call,
    has(name) {
      return methods.has(normalizeMethodName(name));
    },
    listMethods() {
      return [...methods.keys()].sort();
    }
  });
}

const defaultInterface = createMethodRegistry();

export function createAgentContextInterface({ registrations = [] } = {}) {
  return createMethodRegistry([...DEFAULT_METHODS, ...registrations]);
}

export function getAgentContextInterface() {
  return defaultInterface;
}

export function callAgentContextMethod(name, ...args) {
  return defaultInterface.call(name, ...args);
}

export function createContextRuntime(options = {}) {
  return callAgentContextMethod("context.createRuntime", options);
}

export function createContextCompactionRuntime(options = {}) {
  return callAgentContextMethod("context.compaction.createRuntime", options);
}

export function estimateTokens(value) {
  return callAgentContextMethod("context.estimateTokens", value);
}

export function computeCompactionBudget(profile = {}, policyPatch = {}) {
  return callAgentContextMethod("context.compaction.computeBudget", profile, policyPatch);
}

export function createContextCompactionStrategyAdapter(options = {}) {
  return callAgentContextMethod("context.compaction.createStrategyAdapter", options);
}

export function listContextCompactionStrategies(extraStrategies = []) {
  return callAgentContextMethod("context.compaction.listStrategies", extraStrategies);
}

export function normalizeCompactionPolicy(profile = {}, patch = {}) {
  return callAgentContextMethod("context.compaction.normalizePolicy", profile, patch);
}

export function buildMessageGraph(messages = []) {
  return callAgentContextMethod("context.compaction.buildMessageGraph", messages);
}

export function chooseCompactionCutPoint(messages = [], options = {}) {
  return callAgentContextMethod("context.compaction.chooseCutPoint", messages, options);
}

export function estimateContextTokens(value) {
  return callAgentContextMethod("context.compaction.estimateTokens", value);
}

export function redactCompactionValue(value, depth = 0) {
  return callAgentContextMethod("context.compaction.redactValue", value, depth);
}

export {
  CONTEXT_RUNTIME_PROTOCOL_VERSION,
  CONTEXT_COMPACTION_PROTOCOL_VERSION
};

export default getAgentContextInterface;
