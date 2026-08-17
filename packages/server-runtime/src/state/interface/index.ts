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

export const AGENT_CONTEXT_INTERFACE_PROTOCOL_VERSION = "meshrix.agent_context.interface.v1";

type MethodHandler = (...args: never[]) => unknown;
type MethodEntry = readonly [name: string, handler: MethodHandler];

interface AgentContextInterface {
  readonly protocolVersion: typeof AGENT_CONTEXT_INTERFACE_PROTOCOL_VERSION;
  call<TResult = unknown>(name: unknown, ...args: unknown[]): TResult;
  has(name?: unknown): boolean;
  listMethods(): string[];
}

// Agent-context is the internal runtime loop; external workflows live outside this interface.
const DEFAULT_METHODS: readonly MethodEntry[] = Object.freeze([
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

function normalizeMethodName(name?: unknown): string {
  return String(name || "").trim();
}

function createMethodRegistry(entries: readonly MethodEntry[] = DEFAULT_METHODS): AgentContextInterface {
  const methods = new Map<string, MethodHandler>();
  for (const [name, handler] of entries) {
    register(name, handler);
  }

  function register(name: unknown, handler: unknown): string {
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
    methods.set(methodName, handler as MethodHandler);
    return methodName;
  }

  function call<TResult = unknown>(name: unknown, ...args: unknown[]): TResult {
    const methodName = normalizeMethodName(name);
    const handler = methods.get(methodName);
    if (!handler) {
      throw new Error(`agent_context_interface_method_unregistered:${methodName || "unknown"}`);
    }
    return handler(...(args as never[])) as TResult;
  }

  return Object.freeze({
    protocolVersion: AGENT_CONTEXT_INTERFACE_PROTOCOL_VERSION,
    call,
    has(name?: unknown): boolean {
      return methods.has(normalizeMethodName(name));
    },
    listMethods(): string[] {
      return [...methods.keys()].sort();
    }
  });
}

const defaultInterface = createMethodRegistry();

export function createAgentContextInterface({ registrations = [] }: { registrations?: readonly MethodEntry[] } = {}): AgentContextInterface {
  return createMethodRegistry([...DEFAULT_METHODS, ...registrations]);
}

export function getAgentContextInterface(): AgentContextInterface {
  return defaultInterface;
}

export function callAgentContextMethod<TResult = unknown>(name: unknown, ...args: unknown[]): TResult {
  return defaultInterface.call<TResult>(name, ...args);
}

export function createContextRuntime(
  options: Parameters<typeof createContextRuntimeInternal>[0]
): ReturnType<typeof createContextRuntimeInternal> {
  return callAgentContextMethod("context.createRuntime", options);
}

export function createContextCompactionRuntime(
  options: Parameters<typeof createContextCompactionRuntimeInternal>[0]
): ReturnType<typeof createContextCompactionRuntimeInternal> {
  return callAgentContextMethod("context.compaction.createRuntime", options);
}

export function estimateTokens(value?: Parameters<typeof estimateRuntimeTokens>[0]): ReturnType<typeof estimateRuntimeTokens> {
  return callAgentContextMethod("context.estimateTokens", value);
}

export function computeCompactionBudget(
  profile: Parameters<typeof computeCompactionBudgetInternal>[0],
  policyPatch: Parameters<typeof computeCompactionBudgetInternal>[1]
): ReturnType<typeof computeCompactionBudgetInternal> {
  return callAgentContextMethod("context.compaction.computeBudget", profile, policyPatch);
}

export function createContextCompactionStrategyAdapter(
  options: Parameters<typeof createContextCompactionStrategyAdapterInternal>[0]
): ReturnType<typeof createContextCompactionStrategyAdapterInternal> {
  return callAgentContextMethod("context.compaction.createStrategyAdapter", options);
}

export function listContextCompactionStrategies(
  extraStrategies: Parameters<typeof listContextCompactionStrategiesInternal>[0] = []
): ReturnType<typeof listContextCompactionStrategiesInternal> {
  return callAgentContextMethod("context.compaction.listStrategies", extraStrategies);
}

export function normalizeCompactionPolicy(
  profile: Parameters<typeof normalizeCompactionPolicyInternal>[0],
  patch: Parameters<typeof normalizeCompactionPolicyInternal>[1]
): ReturnType<typeof normalizeCompactionPolicyInternal> {
  return callAgentContextMethod("context.compaction.normalizePolicy", profile, patch);
}

export function buildMessageGraph(
  messages: Parameters<typeof buildMessageGraphInternal>[0] = []
): ReturnType<typeof buildMessageGraphInternal> {
  return callAgentContextMethod("context.compaction.buildMessageGraph", messages);
}

export function chooseCompactionCutPoint(
  messages: Parameters<typeof chooseCompactionCutPointInternal>[0] = [],
  options: Parameters<typeof chooseCompactionCutPointInternal>[1]
): ReturnType<typeof chooseCompactionCutPointInternal> {
  return callAgentContextMethod("context.compaction.chooseCutPoint", messages, options);
}

export function estimateContextTokens(
  value?: Parameters<typeof estimateContextTokensInternal>[0]
): ReturnType<typeof estimateContextTokensInternal> {
  return callAgentContextMethod("context.compaction.estimateTokens", value);
}

export function redactCompactionValue(
  value?: Parameters<typeof redactCompactionValueInternal>[0],
  depth: Parameters<typeof redactCompactionValueInternal>[1] = 0
): ReturnType<typeof redactCompactionValueInternal> {
  return callAgentContextMethod("context.compaction.redactValue", value, depth);
}

export {
  CONTEXT_RUNTIME_PROTOCOL_VERSION,
  CONTEXT_COMPACTION_PROTOCOL_VERSION
};

export default getAgentContextInterface;
