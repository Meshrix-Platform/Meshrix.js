#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { RESOURCE_DISCIPLINE_POLICY } from "./lib/resource-discipline-policy.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const policy = RESOURCE_DISCIPLINE_POLICY;

async function readRepoFile(relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

async function collectSourceFiles(relativeRoot) {
  const files = [];
  const pending = [relativeRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fs.readdir(path.join(repoRoot, current), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
        files.push(relativePath.split(path.sep).join("/"));
      }
    }
  }
  return files.sort();
}

function requireTokens(findings, relativePath, source, tokens) {
  for (const token of tokens) {
    if (!source.includes(token)) findings.push(`${relativePath}:missing:${token}`);
  }
}

const findings = [];
const packageJson = JSON.parse(await readRepoFile("package.json"));
const testRegistry = JSON.parse(await readRepoFile("tools/registry/tests.registry.json"));
const observabilityDocument = await readRepoFile(
  "docs/functionality/OPERATIONS-OBSERVABILITY.md"
);
const runbook = await readRepoFile("docs/RUNBOOK.md");

if (packageJson.devDependencies?.[policy.memoryLeak.framework] !== "^5.16.0") {
  findings.push("package.json:professional-memory-profiler-not-pinned");
}
if (
  packageJson.scripts?.["server:verify:resource-discipline"] !==
  "node tools/server-scripts/verify-resource-discipline.mjs && npm run vitest -- tests/vitest/server/resource-discipline-policy.test.mjs && node tools/server-scripts/verify-runtime-memory-leaks.mjs"
) {
  findings.push("package.json:resource-discipline-gate-not-canonical");
}
if (
  packageJson.scripts?.["server:verify:memory-leaks"] !==
  "node tools/server-scripts/verify-runtime-memory-leaks.mjs"
) {
  findings.push("package.json:memory-leak-gate-not-canonical");
}

for (const profileId of ["core-public", "security-public"]) {
  if (testRegistry.profiles?.[profileId]?.suites?.[0] !== "runtime.resource-discipline") {
    findings.push(`tools/registry/tests.registry.json:${profileId}:resource-discipline-not-first`);
  }
}
const registeredSuite = testRegistry.suites.find(
  (suite) => suite.id === "runtime.resource-discipline"
);
if (!registeredSuite) {
  findings.push("tools/registry/tests.registry.json:resource-discipline-suite-missing");
} else {
  if (registeredSuite.command !== "npm") {
    findings.push("tools/registry/tests.registry.json:resource-discipline-command-invalid");
  }
  if (registeredSuite.args?.join("\0") !== "run\0server:verify:resource-discipline") {
    findings.push("tools/registry/tests.registry.json:resource-discipline-args-invalid");
  }
}

requireTokens(
  findings,
  "docs/functionality/OPERATIONS-OBSERVABILITY.md",
  observabilityDocument,
  [
    "Priority Zero Resource Discipline (天字号第一标准)",
    "Unbounded logging, metrics, events, queues,",
    "evidence and MUST NOT be persisted per request.",
    "Reusable tools are cache state, never diagnostic storage.",
    "No review waiver can permit an unbounded resource path."
  ]
);
requireTokens(findings, "docs/RUNBOOK.md", runbook, [
  "npm run server:verify:resource-discipline",
  "@datadog/pprof",
  "forced garbage collection",
  "reusable local tool state"
]);

const requiredRuntimeContracts = [
  {
    file: "packages/foundation/src/observability/runtime-logger.mjs",
    tokens: [
      "DEFAULT_MAX_TOTAL_BYTES",
      "DEFAULT_MAX_FILE_BYTES",
      "DEFAULT_MAX_PENDING_RECORDS",
      "DEFAULT_MAX_RECORD_BYTES",
      "const defaultLevel = \"info\""
    ]
  },
  {
    file: "apps/server/runtime/http-server-routes.mjs",
    tokens: ["isRoutineProbeNoise", "rateLimitLogState.size >= 256"]
  },
  {
    file: "packages/capabilities/src/operation-permission-core/store-audit.mjs",
    tokens: [
      "DEFAULT_METRIC_RETENTION_DAYS",
      "DEFAULT_MAX_TOOL_METRIC_ROWS",
      "DEFAULT_MAX_HTTP_METRIC_ROWS",
      "isRoutineProbeMetricNoise"
    ]
  },
  {
    file: "packages/foundation/src/storage/bounded-jsonl.mjs",
    tokens: [
      "DEFAULT_MAX_BYTES",
      "DEFAULT_RETAINED_BYTES",
      "DEFAULT_MAX_RECORD_BYTES",
      "readJsonlTail",
      "appendBoundedJsonLine"
    ]
  },
  {
    file: "packages/agents/src/agent-memory/index.mjs",
    tokens: [
      "DEFAULT_MAX_STORAGE_BYTES",
      "DEFAULT_MAX_SCAN_BYTES",
      "DEFAULT_MAX_RECORD_BYTES",
      "DEFAULT_MAX_STORED_RECORDS"
    ]
  },
  {
    file: "packages/protocols/pubsub/event-bus.mjs",
    tokens: [
      "DEFAULT_MAX_EVENT_LOG_BYTES",
      "DEFAULT_MAX_MEMORY_EVENT_BYTES",
      "DEFAULT_MAX_LATEST_BYTES",
      "DEFAULT_MAX_EVENT_BYTES"
    ]
  },
  {
    file: "tools/server-scripts/lib/resource-discipline-analysis.mjs",
    tokens: ["median", "theilSenSlope", "positiveGrowth"]
  },
  {
    file: "tools/server-scripts/verify-runtime-memory-leaks.mjs",
    tokens: [
      "theilSenSlope",
      "--expose-gc",
      "captureProfile",
      "toolCacheCleanupAttempted: false"
    ]
  },
  {
    file: "tools/server-scripts/lib/runtime-memory-profiler-preload.mjs",
    tokens: ["pprof.heap.start", "pprof.heap.profile", "globalThis.gc"]
  }
];

for (const contract of requiredRuntimeContracts) {
  const source = await readRepoFile(contract.file);
  requireTokens(findings, contract.file, source, contract.tokens);
}

const runtimeMemoryVerifier = await readRepoFile(
  "tools/server-scripts/verify-runtime-memory-leaks.mjs"
);
const cleanupCalls = [...runtimeMemoryVerifier.matchAll(/\bfs\.rm\s*\(/gu)];
if (
  cleanupCalls.length !== 1 ||
  !runtimeMemoryVerifier.includes(
    "await fs.rm(runRoot, { recursive: true, force: true });"
  )
) {
  findings.push(
    "tools/server-scripts/verify-runtime-memory-leaks.mjs:cleanup-must-only-remove-private-run-root"
  );
}

const directAppendAllowlist = new Set([
  "packages/foundation/src/observability/runtime-logger.mjs",
  "packages/protocols/pubsub/event-bus.mjs"
]);
const unboundedJsonlPrimitiveAllowlist = new Set([
  "packages/agents/src/agent-memory/index.mjs",
  "packages/foundation/src/storage/bounded-jsonl.mjs",
  "packages/foundation/src/storage/state-coordinator.mjs"
]);
const sourceFiles = [
  ...(await collectSourceFiles("apps/server/runtime")),
  ...(await collectSourceFiles("packages"))
];
for (const relativePath of sourceFiles) {
  const source = await readRepoFile(relativePath);
  if (/\bappendFile(?:Sync)?\s*\(/u.test(source) && !directAppendAllowlist.has(relativePath)) {
    findings.push(`${relativePath}:direct-append-forbidden`);
  }
  if (
    /\bappendJsonLine(?:Serialized)?\s*\(/u.test(source) &&
    !unboundedJsonlPrimitiveAllowlist.has(relativePath)
  ) {
    findings.push(`${relativePath}:unbounded-jsonl-primitive-forbidden`);
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`[resource-discipline] ${finding}`);
  console.error(`[resource-discipline] failed findings=${findings.length}`);
  process.exitCode = 1;
} else {
  console.log(
    `[resource-discipline] staticPolicyReady=true priority=${policy.priority} ` +
    `runtimeFiles=${sourceFiles.length}`
  );
}
