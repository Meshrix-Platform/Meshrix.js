#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { RESOURCE_DISCIPLINE_POLICY } from "./lib/resource-discipline-policy.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const policy: any = RESOURCE_DISCIPLINE_POLICY;

async function readRepoFile(relativePath?: any) : Promise<any> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

async function collectSourceFiles(relativeRoot?: any) : Promise<any> {
  const files: any[] = [];
  const pending: any[] = [relativeRoot];
  while (pending.length > 0) {
    const current: any = pending.pop();
    const entries: any = await fs.readdir(path.join(repoRoot, current), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath: any = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (["dist", "build", "node_modules"].includes(entry.name)) continue;
        pending.push(relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(relativePath.split(path.sep).join("/"));
      }
    }
  }
  return files.sort();
}

function requireTokens(findings?: any, relativePath?: any, source?: any, tokens?: any) : any {
  for (const token of tokens) {
    if (!source.includes(token)) findings.push(`${relativePath}:missing:${token}`);
  }
}

const findings: any[] = [];
const packageJson: any = JSON.parse(await readRepoFile("package.json"));
const testRegistry: any = JSON.parse(await readRepoFile("tools/registry/tests.registry.json"));
const observabilityDocument: any = await readRepoFile(
  "docs/functionality/OPERATIONS-OBSERVABILITY.md"
);
const runbook: any = await readRepoFile("docs/RUNBOOK.md");

if (packageJson.devDependencies?.[policy.memoryLeak.framework] !== "^5.16.0") {
  findings.push("package.json:professional-memory-profiler-not-pinned");
}
if (
  packageJson.scripts?.["server:verify:resource-discipline"] !==
  "cross-env NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-resource-discipline.ts && npm run vitest -- tests/vitest/server/resource-discipline-policy.test.ts tests/vitest/server/job-pipeline-upload-session-persistence.test.ts tests/vitest/server/upload-custody-workspace-materialization.test.ts && cross-env NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-runtime-memory-leaks.ts"
) {
  findings.push("package.json:resource-discipline-gate-not-canonical");
}
if (
  packageJson.scripts?.["server:verify:memory-leaks"] !==
  "cross-env NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-runtime-memory-leaks.ts"
) {
  findings.push("package.json:memory-leak-gate-not-canonical");
}

for (const profileId of ["core-public", "security-public"]) {
  if (testRegistry.profiles?.[profileId]?.suites?.[0] !== "runtime.resource-discipline") {
    findings.push(`tools/registry/tests.registry.json:${profileId}:resource-discipline-not-first`);
  }
}
const registeredSuite: any = testRegistry.suites.find(
  (suite?: any) : any => suite.id === "runtime.resource-discipline"
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

const requiredRuntimeContracts: any[] = [
  {
    file: "packages/foundation/src/observability/runtime-logger.ts",
    tokens: [
      "DEFAULT_MAX_TOTAL_BYTES",
      "DEFAULT_MAX_FILE_BYTES",
      "DEFAULT_MAX_PENDING_RECORDS",
      "DEFAULT_MAX_RECORD_BYTES",
      "const defaultLevel = \"info\""
    ]
  },
  {
    file: "apps/server/runtime/http-server-routes.ts",
    tokens: ["isRoutineProbeNoise", "rateLimitLogState.size >= 256"]
  },
  {
    file: "packages/capabilities/src/operation-permission-core/store-audit.ts",
    tokens: [
      "DEFAULT_METRIC_RETENTION_DAYS",
      "DEFAULT_MAX_TOOL_METRIC_ROWS",
      "DEFAULT_MAX_HTTP_METRIC_ROWS",
      "isRoutineProbeMetricNoise"
    ]
  },
  {
    file: "packages/foundation/src/storage/bounded-jsonl.ts",
    tokens: [
      "DEFAULT_MAX_BYTES",
      "DEFAULT_RETAINED_BYTES",
      "DEFAULT_MAX_RECORD_BYTES",
      "readJsonlTail",
      "appendBoundedJsonLine"
    ]
  },
  {
    file: "packages/agents/src/agent-memory/index.ts",
    tokens: [
      "DEFAULT_MAX_STORAGE_BYTES",
      "DEFAULT_MAX_SCAN_BYTES",
      "DEFAULT_MAX_RECORD_BYTES",
      "DEFAULT_MAX_STORED_RECORDS"
    ]
  },
  {
    file: "packages/protocols/pubsub/event-bus.ts",
    tokens: [
      "DEFAULT_MAX_TOPICS",
      "DEFAULT_MAX_EVENT_BYTES",
      "DEFAULT_MAX_RESPONSE_BYTES",
      "MAX_WAITERS",
      "MAX_TIMEOUT_MS"
    ]
  },
  {
    file: "packages/server-runtime/src/events/sqlite-protocol-event-store.ts",
    tokens: [
      "DEFAULT_MAX_RECORDS",
      "DEFAULT_MAX_BYTES",
      "DEFAULT_MAX_AGE_MS",
      "DEFAULT_RETENTION_BATCH",
      "DEFAULT_MAX_LATEST_TOPICS",
      "DEFAULT_MAX_LATEST_BYTES",
      "DEFAULT_MAX_EVENT_BYTES",
      "idx_protocol_events_topic_offset",
      "idx_protocol_events_published_offset"
    ]
  },
  {
    file: "packages/server-runtime/src/jobs/jobs/job-projection-store.ts",
    tokens: [
      "DEFAULT_MAX_RECORDS",
      "DEFAULT_MAX_ACTIVE_RECORDS",
      "DEFAULT_MAX_METADATA_BYTES",
      "DEFAULT_MAX_ARTIFACT_BYTES",
      "DEFAULT_TERMINAL_RETENTION_MS",
      "DEFAULT_CLEANUP_BATCH",
      "idx_jobs_created_id",
      "idx_jobs_owner_created_id",
      "pending_delete_bytes",
      "prepared_artifact_bytes"
    ]
  },
  {
    file: "packages/server-runtime/src/jobs/jobs/job-projection-recovery.ts",
    tokens: [
      "highWaterMark: 64 * 1024",
      "listArtifactJournal",
      "job_projection_artifact_digest_mismatch"
    ]
  },
  {
    file: "packages/server-runtime/src/jobs/jobs/job-manager-persistence.ts",
    tokens: [
      "readBoundedText",
      "MAX_JOB_METADATA_BYTES",
      "MAX_JOB_PAYLOAD_BYTES",
      "MAX_JOB_RESULT_BYTES"
    ]
  },
  {
    file: "packages/agents/src/upstream-gateway/support.ts",
    tokens: [
      "MAX_UPSTREAM_ENDPOINTS",
      "MAX_UPSTREAM_ENDPOINT_WEIGHT",
      "MAX_UPSTREAM_TOTAL_ENDPOINT_WEIGHT",
      "upstream_endpoint_total_weight_exceeded"
    ]
  },
  {
    file: "packages/agents/src/upstream-gateway/endpoint-traffic.ts",
    tokens: [
      "currentWeights",
      "eligibleWeight",
      "no_enabled_endpoint",
      "consumeAllowedTraffic"
    ]
  },
  {
    file: "packages/foundation/src/storage/service-manifest-transaction.ts",
    tokens: [
      "SERVICE_MANIFEST_MAX_UNPUBLISHED_SET_REVISIONS",
      "REQUEST_RETENTION_MS",
      "manifest_services",
      "manifest_service_versions",
      "manifest_requests",
      "idx_manifest_versions_retention",
      "idx_manifest_requests_created",
      "storage_manifest_request_capacity_exceeded",
      "withInitializationLock"
    ]
  },
  {
    file: "packages/foundation/src/storage/storage-ports.ts",
    tokens: [
      "maxRequestRecords",
      "maxRequestBytes"
    ]
  },
  {
    file: "packages/foundation/src/security/operation-audit.ts",
    tokens: [
      "createSqliteExecutionLane",
      'owner: "mandatory-evidence-operation-audit"',
      "operation-audit-worker.${import.meta.url.endsWith",
      "maxPending",
      "maxPendingBytes",
      "defaultDeadlineMs"
    ]
  },
  {
    file: "packages/foundation/src/security/operation-audit-worker-store.ts",
    tokens: [
      "DEFAULT_MAX_RECORDS",
      "DEFAULT_MAX_LOGICAL_BYTES",
      "DEFAULT_MAX_DATABASE_BYTES",
      "DEFAULT_CLEANUP_BATCH_SIZE",
      "DEFAULT_MAINTENANCE_EVERY_APPENDS",
      "OperationAuditCapacityError",
      "operation_audit_meta",
      "idx_operation_audit_retention",
      "wal_checkpoint(PASSIVE)",
      "incremental_vacuum"
    ]
  },
  {
    file: "packages/foundation/src/storage/backup-snapshot.ts",
    tokens: [
      "MINIMUM_FREE_SPACE_RESERVE_BYTES",
      "FREE_SPACE_RESERVE_PERCENT",
      "MAX_PENDING_BACKUP_CLEANUP",
      "reconcilePendingBackups",
      "estimateSnapshotBytes",
      "assertSnapshotCapacity",
      "fs.statfs",
      "cloneStableRegularFile",
      "retentionPolicy",
      "sequentialFileConcurrency: 1"
    ]
  },
  {
    file: "packages/foundation/src/storage/storage-file-safety.ts",
    tokens: [
      "COPYFILE_FICLONE_FORCE",
      "cloneStableRegularFile",
      "copy-on-write-page-update"
    ]
  },
  {
    file: "packages/foundation/src/storage/storage-maintenance-coordinator.ts",
    tokens: [
      "STORAGE_EXECUTION_BUDGET_HARD_LIMITS",
      "maxConcurrentMutationsPerRoot: 1",
      "queueAllocationBytes",
      "queuedBufferProductBytes",
      "storage_execution_budget_limit_exceeded",
      "storage_execution_budget_product_exceeded",
      "storage_operation_queue_capacity_invalid",
      "assertFits"
    ]
  },
  {
    file: "tools/server-scripts/lib/resource-discipline-analysis.ts",
    tokens: ["median", "theilSenSlope", "positiveGrowth"]
  },
  {
    file: "tools/server-scripts/verify-runtime-memory-leaks.ts",
    tokens: [
      "theilSenSlope",
      "--expose-gc",
      "captureProfile",
      "runHighRiskWorkloads",
      "highRiskWorkloads",
      "minimumProtocolEvents",
      "toolCacheCleanupAttempted: false"
    ]
  },
  {
    file: "tools/server-scripts/lib/resource-high-risk-workload-child.ts",
    tokens: [
      "openStoredObjectReadStream",
      "createUploadNoRunCustody",
      "createUploadSessionStore",
      "createSqliteProtocolEventStore",
      "createJobProjectionStore",
      "createEndpointTrafficController",
      "createOperationAuditStore",
      "createServiceManifestStore",
      "createStorageBackup",
      "1_000_000",
      "100_000",
      "eventLoopDelayP99Ms",
      "histogram.percentile(99)",
      "syntheticDataOnly: true"
    ]
  },
  {
    file: "tools/server-scripts/lib/runtime-memory-profiler-preload.ts",
    tokens: ["pprof.heap.start", "pprof.heap.profile", "globalThis.gc"]
  }
];

for (const contract of requiredRuntimeContracts) {
  const source: any = await readRepoFile(contract.file);
  requireTokens(findings, contract.file, source, contract.tokens);
}

const operationAuditFacade: any = await readRepoFile(
  "packages/foundation/src/security/operation-audit.ts"
);
for (const forbidden of ["openSqliteDatabase", "operation_audit_meta", ".prepare("]) {
  if (operationAuditFacade.includes(forbidden)) {
    findings.push(
      `packages/foundation/src/security/operation-audit.ts:worker-owner-leak:${forbidden}`
    );
  }
}

const runtimeMemoryVerifier: any = await readRepoFile(
  "tools/server-scripts/verify-runtime-memory-leaks.ts"
);
const cleanupCalls: any[] = [...runtimeMemoryVerifier.matchAll(/\bfs\.rm\s*\(/gu)];
if (
  cleanupCalls.length !== 1 ||
  !runtimeMemoryVerifier.includes(
    "await fs.rm(runRoot, { recursive: true, force: true });"
  )
) {
  findings.push(
    "tools/server-scripts/verify-runtime-memory-leaks.ts:cleanup-must-only-remove-private-run-root"
  );
}

const directAppendAllowlist: any = new Set<any>([
  "packages/foundation/src/observability/runtime-logger.ts"
]);
const unboundedJsonlPrimitiveAllowlist: any = new Set<any>([
  "packages/agents/src/agent-memory/index.ts",
  "packages/foundation/src/storage/bounded-jsonl.ts",
  "packages/foundation/src/storage/state-coordinator.ts"
]);
const sourceFiles: any[] = [
  ...(await collectSourceFiles("apps/server/runtime")),
  ...(await collectSourceFiles("packages"))
];
for (const relativePath of sourceFiles) {
  const source: any = await readRepoFile(relativePath);
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
