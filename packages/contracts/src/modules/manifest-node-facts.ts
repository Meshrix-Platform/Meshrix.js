import { CORE_ARCHITECTURE_NODE_FACTS } from "./manifest-node-facts-core.ts";
import { RUNTIME_ARCHITECTURE_NODE_FACTS } from "./manifest-node-facts-runtime.ts";

export const SYSTEM_ARCHITECTURE_NODE_FACTS: readonly any[] = Object.freeze([
  ...CORE_ARCHITECTURE_NODE_FACTS,
  ...RUNTIME_ARCHITECTURE_NODE_FACTS
]);
