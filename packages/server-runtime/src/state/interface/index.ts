import {
  CONTEXT_RUNTIME_PROTOCOL_VERSION,
  createContextRuntime as createContextRuntimeInternal,
  estimateTokens as estimateRuntimeTokens
} from "../context-core/index.ts";
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
} from "../context-compact/index.ts";

export const AGENT_CONTEXT_INTERFACE_PROTOCOL_VERSION: any = "meshrix.agent_context.interface.v1";

// Agent-context is the internal runtime loop; external workflows live outside this interface.
const DEFAULT_METHODS: readonly any[] = Object.freeze([
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

function normalizeMethodName(name?: any) : any {
  return String(name || "").trim();
}

function createMethodRegistry(entries: any = DEFAULT_METHODS) : any {
  const methods: any = new Map<any, any>();
  for (const [name, handler] of entries) {
    register(name, handler);
  }

  function register(name?: any, handler?: any) : any {
    const methodName: any = normalizeMethodName(name);
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

  function call(name: any, ...args: any[]) : any {
    const methodName: any = normalizeMethodName(name);
    const handler: any = methods.get(methodName);
    if (!handler) {
      throw new Error(`agent_context_interface_method_unregistered:${methodName || "unknown"}`);
    }
    return handler(...args);
  }

  return Object.freeze({
    protocolVersion: AGENT_CONTEXT_INTERFACE_PROTOCOL_VERSION,
    call,
    has(name?: any) : any {
      return methods.has(normalizeMethodName(name));
    },
    listMethods() : any {
      return [...methods.keys()].sort();
    }
  });
}

const defaultInterface: any = createMethodRegistry();

export function createAgentContextInterface({ registrations = [] }: Record<string, any> = {}) : any {
  return createMethodRegistry([...DEFAULT_METHODS, ...registrations]);
}

export function getAgentContextInterface() : any {
  return defaultInterface;
}

export function callAgentContextMethod(name: any, ...args: any[]) : any {
  return defaultInterface.call(name, ...args);
}

export function createContextRuntime(options: Record<string, any> = {}) : any {
  return callAgentContextMethod("context.createRuntime", options);
}

export function createContextCompactionRuntime(options: Record<string, any> = {}) : any {
  return callAgentContextMethod("context.compaction.createRuntime", options);
}

export function estimateTokens(value?: any) : any {
  return callAgentContextMethod("context.estimateTokens", value);
}

export function computeCompactionBudget(profile: Record<string, any> = {}, policyPatch: Record<string, any> = {}) : any {
  return callAgentContextMethod("context.compaction.computeBudget", profile, policyPatch);
}

export function createContextCompactionStrategyAdapter(options: Record<string, any> = {}) : any {
  return callAgentContextMethod("context.compaction.createStrategyAdapter", options);
}

export function listContextCompactionStrategies(extraStrategies: any = []) : any {
  return callAgentContextMethod("context.compaction.listStrategies", extraStrategies);
}

export function normalizeCompactionPolicy(profile: Record<string, any> = {}, patch: Record<string, any> = {}) : any {
  return callAgentContextMethod("context.compaction.normalizePolicy", profile, patch);
}

export function buildMessageGraph(messages: any = []) : any {
  return callAgentContextMethod("context.compaction.buildMessageGraph", messages);
}

export function chooseCompactionCutPoint(messages: any = [], options: Record<string, any> = {}) : any {
  return callAgentContextMethod("context.compaction.chooseCutPoint", messages, options);
}

export function estimateContextTokens(value?: any) : any {
  return callAgentContextMethod("context.compaction.estimateTokens", value);
}

export function redactCompactionValue(value?: any, depth: any = 0) : any {
  return callAgentContextMethod("context.compaction.redactValue", value, depth);
}

export {
  CONTEXT_RUNTIME_PROTOCOL_VERSION,
  CONTEXT_COMPACTION_PROTOCOL_VERSION
};

export default getAgentContextInterface;
