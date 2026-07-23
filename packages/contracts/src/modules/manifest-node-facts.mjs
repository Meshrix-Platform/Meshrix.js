import { CORE_ARCHITECTURE_NODE_FACTS } from "./manifest-node-facts-core.mjs";
import { RUNTIME_ARCHITECTURE_NODE_FACTS } from "./manifest-node-facts-runtime.mjs";

export const SYSTEM_ARCHITECTURE_NODE_FACTS = Object.freeze([
  ...CORE_ARCHITECTURE_NODE_FACTS,
  ...RUNTIME_ARCHITECTURE_NODE_FACTS
]);
