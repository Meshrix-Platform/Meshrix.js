#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { createEndpointTrafficController } from "../../../packages/agents/src/upstream-gateway/endpoint-traffic.mjs";
import { createOperationAuditStore } from "../../../packages/foundation/src/security/operation-audit.mjs";
import {
  openStoredObjectReadStream,
  putStoredObjectFromFile
} from "../../../packages/foundation/src/storage/object-store.mjs";
import { createStorageBackup } from "../../../packages/foundation/src/storage/backup-snapshot.mjs";
import { createServiceManifestStore } from "../../../packages/foundation/src/storage/service-manifest-store.mjs";
import { SERVICE_MANIFEST_SCHEMA_VERSION } from "../../../packages/foundation/src/storage/storage-ports.mjs";
import { createUploadWorkspaceMaterializationTransactionStore } from "../../../packages/server-runtime/src/composition/upload-workspace-materialization-provider.mjs";
import { createSqliteProtocolEventStore } from "../../../packages/server-runtime/src/events/sqlite-protocol-event-store.mjs";
import { createJobProjectionStore } from "../../../packages/server-runtime/src/jobs/jobs/job-projection-store.mjs";

const MIB = 1024 * 1024;
const rootPath = path.resolve(String(process.argv[2] || ""));
const releaseProfile = process.env.LICO_RESOURCE_LOAD_PROFILE === "release";
const eventCount = releaseProfile ? 1_000_000 : 100_000;
const jobCount = releaseProfile ? 100_000 : 10_000;
const auditWriteCount = releaseProfile ? 100_000 : 10_000;
const manifestCommitCount = releaseProfile ? 8_000 : 1_000;

function fail(reasonCode) {
  const error = new Error(reasonCode);
  error.code = reasonCode;
  throw error;
}

function assert(condition, reasonCode) {
  if (!condition) fail(reasonCode);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function memoryPoint() {
  const memory = process.memoryUsage();
  return {
    heapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss,
    externalBytes: memory.external,
    arrayBufferBytes: memory.arrayBuffers
  };
}

async function forceGc() {
  if (typeof globalThis.gc !== "function") fail("high_risk_explicit_gc_unavailable");
  for (let pass = 0; pass < 3; pass += 1) {
    globalThis.gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function measureScenario(id, operationCount, run) {
  await forceGc();
  const before = memoryPoint();
  let peak = { ...before };
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const sampler = setInterval(() => {
    const current = memoryPoint();
    for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], current[key]);
  }, 10);
  sampler.unref?.();
  const startedAt = performance.now();
  let facts;
  try {
    facts = await run();
  } finally {
    clearInterval(sampler);
    histogram.disable();
  }
  const durationMs = performance.now() - startedAt;
  const afterWork = memoryPoint();
  for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], afterWork[key]);
  await forceGc();
  const settled = memoryPoint();
  return {
    id,
    operationCount,
    durationMs: Math.round(durationMs * 1000) / 1000,
    operationsPerSecond: durationMs > 0
      ? Math.round(operationCount * 1_000_000 / durationMs) / 1000
      : 0,
    peakHeapGrowthBytes: Math.max(0, peak.heapUsedBytes - before.heapUsedBytes),
    peakRssGrowthBytes: Math.max(0, peak.rssBytes - before.rssBytes),
    peakExternalGrowthBytes: Math.max(
      0,
      peak.externalBytes + peak.arrayBufferBytes -
        before.externalBytes - before.arrayBufferBytes
    ),
    settledHeapGrowthBytes: Math.max(0, settled.heapUsedBytes - before.heapUsedBytes),
    eventLoopDelayMaxMs: Math.round(Number(histogram.max || 0) / 1_000) / 1000,
    facts
  };
}

async function writeRepeatedFile(filePath, bytes, marker = 0x61) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "w", 0o600);
  const chunk = Buffer.alloc(64 * 1024, marker);
  try {
    let written = 0;
    while (written < bytes) {
      const length = Math.min(chunk.length, bytes - written);
      await handle.write(chunk, 0, length, written);
      written += length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function allocatedBytes(directoryPath) {
  let total = 0;
  const pending = [directoryPath];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const selected = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(selected);
      else if (entry.isFile()) {
        const stat = await fs.stat(selected);
        total += Number(stat.blocks || 0) * 512;
      }
    }
  }
  return total;
}

async function runObjectStreamScenario() {
  const userDataPath = path.join(rootPath, "object-stream");
  const sourcePath = path.join(rootPath, "fixtures", "object-source.bin");
  const sourceBytes = 32 * MIB;
  await writeRepeatedFile(sourcePath, sourceBytes);
  const object = await putStoredObjectFromFile({
    userDataPath,
    sourcePath,
    namespace: "resource-test",
    fileName: "synthetic.bin",
    expectedByteSize: sourceBytes
  });
  const opened = await openStoredObjectReadStream({
    userDataPath,
    storageRelativePath: object.storageRelativePath
  });
  let readBytes = 0;
  let maxChunkBytes = 0;
  for await (const chunk of opened.stream) {
    readBytes += chunk.length;
    maxChunkBytes = Math.max(maxChunkBytes, chunk.length);
  }
  assert(readBytes === sourceBytes, "object_stream_byte_count_mismatch");
  assert(maxChunkBytes <= 64 * 1024, "object_stream_chunk_unbounded");
  return { sourceBytes, readBytes, maxChunkBytes };
}

async function runMaterializationScenario() {
  const userDataPath = path.join(rootPath, "materialization");
  const stagedRoot = path.join(rootPath, "fixtures", "materialization");
  const fileCount = 8;
  const bytesPerFile = 2 * MIB;
  const inputs = [];
  for (let index = 0; index < fileCount; index += 1) {
    const stagedPath = path.join(stagedRoot, `source-${index}.bin`);
    await writeRepeatedFile(stagedPath, bytesPerFile, 0x61 + index);
    const content = Buffer.alloc(64 * 1024, 0x61 + index);
    const digest = crypto.createHash("sha256");
    for (let offset = 0; offset < bytesPerFile; offset += content.length) digest.update(content);
    inputs.push({
      sourcePath: `source-${index}.bin`,
      contentSha256: digest.digest("hex"),
      byteSize: bytesPerFile,
      stagedPath
    });
  }
  const store = createUploadWorkspaceMaterializationTransactionStore({ userDataPath });
  try {
    await store.create({
      requestRef: "resource-materialization",
      workspaceId: "workspace-resource"
    }, { inputs });
    const retained = await store.getInputs("resource-materialization");
    let activeReads = 0;
    let maxActiveReads = 0;
    let readBytes = 0;
    for (const input of retained) {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      const bytes = await input.contentHandle.read();
      readBytes += bytes.length;
      activeReads -= 1;
    }
    assert(maxActiveReads === 1, "materialization_reads_overlapped");
    assert(readBytes === fileCount * bytesPerFile, "materialization_byte_count_mismatch");
    return {
      fileCount,
      inputBytes: fileCount * bytesPerFile,
      readBytes,
      maxActiveReads
    };
  } finally {
    store.close();
  }
}

async function runEventScenario() {
  const store = createSqliteProtocolEventStore({
    userDataPath: path.join(rootPath, "events"),
    policy: {
      maxRecords: eventCount,
      maxBytes: releaseProfile ? 1024 * MIB : 128 * MIB,
      maxEventBytes: 4096,
      retentionBatch: 256
    }
  });
  const checkpoints = [];
  try {
    const startedAt = performance.now();
    const publishedAtBase = Date.now();
    for (let index = 0; index < eventCount; index += 1) {
      await store.publish({
        schemaVersion: "resource-event-1",
        id: `resource-event-${index}`,
        topic: `topic-${index % 16}`,
        type: "resource.synthetic",
        publisher: "resource-gate",
        publishedAt: new Date(publishedAtBase + index).toISOString(),
        payload: { bucket: index % 32 }
      }, { retain: true });
      if ((index + 1) % Math.max(1, Math.floor(eventCount / 10)) === 0) {
        checkpoints.push({
          operations: index + 1,
          elapsedMs: performance.now() - startedAt
        });
      }
      if ((index + 1) % 1_024 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    const stats = await store.getStats();
    assert(stats.eventCount === eventCount, "event_retention_count_mismatch");
    const plan = store.explainRead({ topics: ["topic-1"] })
      .map((entry) => String(entry.detail || "")).join(" ");
    assert(plan.includes("idx_protocol_events_topic_offset"), "event_query_index_missing");
    await store.publish({
      schemaVersion: "resource-event-1",
      id: "resource-event-overflow",
      topic: "topic-overflow",
      type: "resource.synthetic",
      publisher: "resource-gate",
      publishedAt: new Date().toISOString(),
      payload: {}
    });
    const convergedStats = await store.getStats();
    assert(convergedStats.eventCount === eventCount, "event_count_did_not_converge");
    const first = checkpoints[0];
    const last = checkpoints.at(-1);
    const unitCostScale = (last.elapsedMs / last.operations) /
      (first.elapsedMs / first.operations);
    assert(unitCostScale <= 5, "event_unit_cost_scale_exceeded");
    store.checkpoint();
    return {
      eventCount: stats.eventCount,
      eventBytes: stats.eventBytes,
      latestCount: stats.latestCount,
      unitCostScale,
      queryIndexUsed: true,
      capacityReason: "rolling_retention"
    };
  } finally {
    store.close();
  }
}

async function runJobScenario() {
  const store = createJobProjectionStore({
    userDataPath: path.join(rootPath, "jobs"),
    policy: {
      maxRecords: jobCount,
      maxMetadataBytes: 256 * MIB,
      terminalRetentionMs: 365 * 24 * 60 * 60 * 1000
    }
  });
  const base = Date.now();
  const checkpoints = [];
  try {
    const startedAt = performance.now();
    for (let index = 0; index < jobCount; index += 1) {
      const createdAt = new Date(base + index).toISOString();
      store.importJob({
        id: `job-resource-${String(index).padStart(7, "0")}`,
        status: "completed",
        createdAt,
        updatedAt: createdAt,
        finishedAt: createdAt,
        progressPercent: 100,
        stage: "completed",
        ownerSubjectId: `owner-${index % 8}`,
        versionGroupId: `resource-group-${index}`,
        versionNumber: 1
      });
      if ((index + 1) % Math.max(1, Math.floor(jobCount / 10)) === 0) {
        checkpoints.push({
          operations: index + 1,
          elapsedMs: performance.now() - startedAt
        });
      }
      if ((index + 1) % 512 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    const page = store.list({ limit: 100, ownerSubjectId: "owner-1" });
    const counts = store.getCounts();
    const plan = store.explainList({ ownerSubjectId: "owner-1" })
      .map((entry) => String(entry.detail || "")).join(" ");
    const retentionPlan = store.explainTerminalRetention()
      .map((entry) => String(entry.detail || "")).join(" ");
    assert(page.items.length === 100, "job_keyset_page_incomplete");
    assert(counts.totalCount === jobCount, "job_projection_count_mismatch");
    assert(plan.includes("idx_jobs_owner_created_id"), "job_query_index_missing");
    assert(
      retentionPlan.includes("idx_jobs_terminal_finished_id"),
      "job_retention_index_missing"
    );
    const first = checkpoints[0];
    const last = checkpoints.at(-1);
    const unitCostScale = (last.elapsedMs / last.operations) /
      (first.elapsedMs / first.operations);
    assert(unitCostScale <= 5, "job_unit_cost_scale_exceeded");
    store.checkpoint();
    return {
      jobCount: counts.totalCount,
      pageSize: page.items.length,
      unitCostScale,
      queryIndexUsed: true
    };
  } finally {
    store.close();
  }
}

function endpointService(count) {
  return {
    serviceId: "svc_resource",
    baseUrl: "https://service.invalid:443",
    endpoints: Array.from({ length: count }, (_unused, index) => ({
      endpointId: `endpoint-${index}`,
      baseUrl: "https://service.invalid:443",
      weight: 16,
      trafficPolicySource: "service",
      trafficPolicyInherited: true,
      circuitBreaker: {
        enabled: true,
        failureThreshold: 3,
        cooldownMs: 60_000
      }
    })),
    trafficPolicy: {
      perMinute: 100_000,
      burst: 100_000,
      maxConcurrent: 100_000
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 3,
      cooldownMs: 60_000
    }
  };
}

function endpointSelectionDuration(endpointCount, iterations) {
  const endpointCircuits = new Map();
  const controller = createEndpointTrafficController({
    trafficBuckets: new Map(),
    endpointCursors: new Map(),
    endpointCircuits,
    appendAudit: () => ({}),
    recordMetric: () => {},
    persist: () => {}
  });
  const service = endpointService(endpointCount);
  const operation = { operationKey: "read", protocol: "http" };
  for (const endpoint of service.endpoints) {
    endpointCircuits.set(`svc_resource::read::${endpoint.endpointId}`, {
      consecutiveFailures: 3,
      openedUntilMs: Date.now() + 60_000
    });
  }
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const selected = controller.selectEndpointTraffic(service, operation, { consume: true });
    assert(selected.traffic.allowed === false, "endpoint_open_circuit_was_selected");
  }
  return performance.now() - startedAt;
}

async function runEndpointScenario() {
  const iterations = releaseProfile ? 20_000 : 2_000;
  const smallDuration = endpointSelectionDuration(8, iterations);
  const largeDuration = endpointSelectionDuration(64, iterations);
  const endpointScale = 64 / 8;
  const durationScale = largeDuration / Math.max(smallDuration, 0.001);
  const normalizedScale = durationScale / endpointScale;
  assert(normalizedScale <= 2.5, "endpoint_complexity_superlinear");
  return {
    endpointCount: 64,
    iterations,
    durationScale,
    normalizedScale,
    allRejected: true
  };
}

async function runAuditScenario() {
  const store = createOperationAuditStore({
    userDataPath: path.join(rootPath, "audit")
  });
  try {
    store.setRetentionPolicy({
      retentionDays: 1,
      maxRecords: Math.max(1024, Math.floor(auditWriteCount / 2)),
      maxLogicalBytes: 64 * MIB,
      cleanupBatchSize: 512,
      maintenanceEveryAppends: 64
    });
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    for (let index = 0; index < auditWriteCount; index += 1) {
      store.append({
        operationId: `resource.audit.${index % 8}`,
        transport: "resource-gate",
        status: "ok",
        createdAt: old,
        input: { bucket: index % 16 }
      });
      if ((index + 1) % 1000 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    const current = store.append({
      operationId: "resource.audit.current",
      transport: "resource-gate",
      status: "ok",
      input: {}
    });
    const meta = store.db.prepare(`
      SELECT row_count AS rowCount, logical_bytes AS logicalBytes
      FROM operation_audit_meta
      WHERE singleton=1
    `).get();
    assert(meta.rowCount <= 64, "audit_expired_rows_did_not_converge");
    assert(current.maintenance.deletedCount >= 0, "audit_maintenance_missing");
    const plan = store.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT audit_id
      FROM operation_audit_log
      WHERE created_at < ?
      ORDER BY created_at ASC,audit_id ASC
      LIMIT ?
    `).all(new Date().toISOString(), 10)
      .map((entry) => String(entry.detail || "")).join(" ");
    assert(plan.includes("idx_operation_audit_retention"), "audit_retention_index_missing");
    return {
      appended: auditWriteCount + 1,
      retainedRecords: meta.rowCount,
      logicalBytes: meta.logicalBytes,
      converged: true,
      queryIndexUsed: true
    };
  } finally {
    store.close();
  }
}

function manifest(label) {
  return {
    schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
    references: [],
    payload: {
      operations: [{ key: "probe", method: "POST" }],
      label
    },
    metadata: { source: "synthetic-resource-gate" }
  };
}

async function runManifestScenario() {
  const storageRoot = path.join(rootPath, "manifest");
  const store = createServiceManifestStore({ storageRoot });
  const serviceId = "svc_01JRESOURCE000000000000000";
  let serviceRevision = 0;
  let setRevision = 0;
  let last = null;
  for (let index = 0; index < manifestCommitCount; index += 1) {
    last = await store.commitManifestSet({
      serviceId,
      expectedServiceRevision: serviceRevision,
      expectedSetRevision: setRevision,
      requestDigest: sha256(`request-${index}`),
      manifest: manifest(`manifest-${index}`)
    });
    serviceRevision = last.serviceRevision;
    setRevision = last.setRevision;
    await store.acknowledgePublished({
      setRevision: last.setRevision,
      setDigest: last.setDigest
    });
    if ((index + 1) % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  const snapshot = await store.getSnapshot();
  assert(snapshot.serviceCount === 1, "manifest_snapshot_service_count_mismatch");
  const databasePath = path.join(storageRoot, "service-manifests", "authority.sqlite");
  const { openSqliteDatabase } = await import("../../../packages/foundation/src/storage/sqlite-database.mjs");
  const db = openSqliteDatabase(databasePath, { readonly: true, fileMustExist: true });
  try {
    const requests = Number(db.prepare("SELECT COUNT(*) AS value FROM manifest_requests").get().value);
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT request_digest
      FROM manifest_requests
      ORDER BY created_at_ms ASC,request_digest ASC
      LIMIT ?
    `).all(10).map((entry) => String(entry.detail || "")).join(" ");
    assert(requests <= 8192, "manifest_request_retention_exceeded");
    assert(plan.includes("idx_manifest_requests_created"), "manifest_request_index_missing");
    return {
      commits: manifestCommitCount,
      requestRecords: requests,
      serviceCount: snapshot.serviceCount,
      queryIndexUsed: true
    };
  } finally {
    db.close();
  }
}

async function runBackupScenario() {
  const userDataPath = path.join(rootPath, "backup");
  const sourcePath = path.join(userDataPath, "dataset", "large.bin");
  await writeRepeatedFile(sourcePath, 16 * MIB, 0x72);
  const first = await createStorageBackup({
    userDataPath,
    label: "resource-first",
    retentionPolicy: { keepLast: 2 }
  });
  const backupRoot = path.join(userDataPath, "backups");
  const allocatedAfterFirst = await allocatedBytes(backupRoot);
  const source = await fs.open(sourcePath, "r+");
  try {
    await source.write(Buffer.alloc(64 * 1024, 0x73), 0, 64 * 1024, 0);
    await source.sync();
  } finally {
    await source.close();
  }
  const second = await createStorageBackup({
    userDataPath,
    label: "resource-second",
    retentionPolicy: { keepLast: 2 }
  });
  const allocatedAfterSecond = await allocatedBytes(backupRoot);
  const pending = (await fs.readdir(backupRoot))
    .filter((name) => name.endsWith(".pending")).length;
  const copyMethod = second.files[0]?.copyMethod || "";
  assert(first.capacity.preflight === "statfs-before-copy", "backup_capacity_preflight_missing");
  assert(second.capacity.sequentialFileConcurrency === 1, "backup_concurrency_unbounded");
  assert(pending === 0, "backup_pending_snapshot_not_reclaimed");
  return {
    sourceBytes: second.summary.bytes,
    changedBytes: 64 * 1024,
    allocatedGrowthBytes: Math.max(0, allocatedAfterSecond - allocatedAfterFirst),
    copyMethod,
    preflight: true,
    sequentialFileConcurrency: second.capacity.sequentialFileConcurrency,
    pendingSnapshots: pending
  };
}

async function main() {
  if (!path.isAbsolute(rootPath) || rootPath === path.parse(rootPath).root) {
    fail("high_risk_private_root_invalid");
  }
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  const scenarios = [];
  scenarios.push(await measureScenario("object_stream", 1, runObjectStreamScenario));
  scenarios.push(await measureScenario("upload_materialization", 8, runMaterializationScenario));
  scenarios.push(await measureScenario("protocol_events", eventCount, runEventScenario));
  scenarios.push(await measureScenario("job_projection", jobCount, runJobScenario));
  scenarios.push(await measureScenario("endpoint_routing", releaseProfile ? 40_000 : 4_000, runEndpointScenario));
  scenarios.push(await measureScenario("operation_audit", auditWriteCount + 1, runAuditScenario));
  scenarios.push(await measureScenario("service_manifest", manifestCommitCount, runManifestScenario));
  scenarios.push(await measureScenario("backup_snapshot", 2, runBackupScenario));
  const result = {
    kind: "lico.resource-discipline.high-risk-result",
    profile: releaseProfile ? "release" : "quick",
    syntheticDataOnly: true,
    scenarios
  };
  if (typeof process.send === "function") {
    process.send(result);
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

await main();
