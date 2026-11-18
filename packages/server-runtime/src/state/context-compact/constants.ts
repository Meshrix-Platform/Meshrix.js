export interface CompactionStrategyDescriptor {
  id: string;
  label: string;
}

export const CONTEXT_COMPACTION_PROTOCOL_VERSION = "v0.0.1:agent:context-compaction-1";

export const BUILTIN_COMPACTION_STRATEGIES: readonly CompactionStrategyDescriptor[] = Object.freeze([
  Object.freeze({
    id: "session-memory-first",
    label: "Session memory first, then model-assisted, then deterministic local summary"
  }),
  Object.freeze({
    id: "workbench-reconstruction",
    label: "Model-assisted compaction with payload dehydration and workbench state reinjection"
  }),
  Object.freeze({
    id: "model-assisted",
    label: "Model-assisted summary with deterministic local summary"
  }),
  Object.freeze({
    id: "deterministic-extractive",
    label: "Deterministic extractive context summary"
  })
]);
