export const CONTEXT_COMPACTION_PROTOCOL_VERSION: any = "v0.0.1:agent:context-compaction-1";

const SENSITIVE_KEY_PATTERN: any =
  /token|secret|password|passwd|authorization|cookie|api[-_]?key|client[-_]?secret|csrf/i;
const SENSITIVE_TEXT_PATTERN: any =
  /(Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9._-]+|xox[baprs]-[A-Za-z0-9-]+|(?:(?:api[-_]?key|token|secret|password)\s*[:=]\s*)[^\s"',;]+)/gi;
const ABSOLUTE_PATH_PATTERN: any =
  /(?:[A-Za-z]:\\[^\s"'<>]+|\/(?:Users|home|var|tmp|private|Volumes|opt|etc)\/[^\s"'<>]+)/g;

export const BUILTIN_COMPACTION_STRATEGIES: readonly any[] = Object.freeze([
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
