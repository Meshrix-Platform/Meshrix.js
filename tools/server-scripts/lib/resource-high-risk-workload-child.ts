#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { createEndpointTrafficController } from "../../../packages/agents/src/upstream-gateway/endpoint-traffic.ts";
import { createOperationAuditStore } from "../../../packages/foundation/src/security/operation-audit.ts";
import {
  openStoredObjectReadStream,
  putStoredObjectFromFile
} from "../../../packages/foundation/src/storage/object-store.ts";
import { createStorageBackup } from "../../../packages/foundation/src/storage/backup-snapshot.ts";
import { createServiceManifestStore } from "../../../packages/foundation/src/storage/service-manifest-store.ts";
import { createStorageKernel } from "../../../packages/foundation/src/storage/storage-kernel.ts";
import { createStorageProvider } from "../../../packages/foundation/src/storage/storage-provider.ts";
import { SERVICE_MANIFEST_SCHEMA_VERSION } from "../../../packages/foundation/src/storage/storage-ports.ts";
import { createLocalCustodyKeyBroker } from "../../../packages/server-runtime/src/execution-sandbox/custody-key-broker.ts";
import { createSqliteProtocolEventStore } from "../../../packages/server-runtime/src/events/sqlite-protocol-event-store.ts";
import { createJobProjectionStore } from "../../../packages/server-runtime/src/jobs/jobs/job-projection-store.ts";
import { createUploadNoRunCustody } from "../../../packages/server-runtime/src/jobs/upload-no-run-custody.ts";
import { createUploadSessionStore } from "../../../packages/server-runtime/src/state/upload-session-store.ts";
import { externalMemoryGrowth } from "./resource-discipline-analysis.ts";

const MIB: any = 1024 * 1024;
const rootPath: any = path.resolve(String(process.argv[2] || ""));
const releaseProfile: any = process.env.MESHRIX_RESOURCE_LOAD_PROFILE === "release";
const eventCount: any = releaseProfile ? 1_000_000 : 100_000;
const jobCount: any = releaseProfile ? 100_000 : 10_000;
const auditWriteCount: any = releaseProfile ? 100_000 : 10_000;
const manifestCommitCount: any = releaseProfile ? 8_000 : 1_000;

function fail(reasonCode?: any) : any {
  const error: Error & Record<string, any> = new Error(reasonCode);
  error.code = reasonCode;
  throw error;
}

function assert(condition?: any, reasonCode?: any) : any {
  if (!condition) fail(reasonCode);
}

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function memoryPoint() : any {
  const memory: any = process.memoryUsage();
  return {
    heapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss,
    externalBytes: memory.external,
    arrayBufferBytes: memory.arrayBuffers
  };
}

async function forceGc() : Promise<any> {
  if (typeof globalThis.gc !== "function") fail("high_risk_explicit_gc_unavailable");
  const gc: any = globalThis.gc;
  for (let pass: any = 0; pass < 3; pass += 1) {
    gc();
    await new Promise((resolve?: any) : any => setImmediate(resolve));
  }
}

async function measureScenario(id?: any, operationCount?: any, run?: any) : Promise<any> {
  await forceGc();
  const before: any = memoryPoint();
  let peak: Record<string, any> = { ...before };
  const histogram: any = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const sampler: any = setInterval(() : any => {
    const current: any = memoryPoint();
    for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], current[key]);
  }, 10);
  sampler.unref?.();
  const startedAt: any = performance.now();
  let facts: any;
  try {
    facts = await run();
  } finally {
    clearInterval(sampler);
    histogram.disable();
  }
  const durationMs: any = performance.now() - startedAt;
  const afterWork: any = memoryPoint();
  for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], afterWork[key]);
  await forceGc();
  const settled: any = memoryPoint();
  return {
    id,
    operationCount,
    durationMs: Math.round(durationMs * 1000) / 1000,
    operationsPerSecond: durationMs > 0
      ? Math.round(operationCount * 1_000_000 / durationMs) / 1000
      : 0,
    peakHeapGrowthBytes: Math.max(0, peak.heapUsedBytes - before.heapUsedBytes),
    peakRssGrowthBytes: Math.max(0, peak.rssBytes - before.rssBytes),
    peakExternalGrowthBytes: externalMemoryGrowth(
      peak.externalBytes,
      before.externalBytes
    ),
    settledHeapGrowthBytes: Math.max(0, settled.heapUsedBytes - before.heapUsedBytes),
    eventLoopDelayMaxMs: Math.round(Number(histogram.max || 0) / 1_000) / 1000,
    facts
  };
}

async function writeRepeatedFile(filePath?: any, bytes?: any, marker: any = 0x61) : Promise<any> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle: any = await fs.open(filePath, "w", 0o600);
  const chunk: any = Buffer.alloc(64 * 1024, marker);
  try {
    let written: any = 0;
    while (written < bytes) {
      const length: any = Math.min(chunk.length, bytes - written);
      await handle.write(chunk, 0, length, written);
      written += length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function allocatedBytes(directoryPath?: any) : Promise<any> {
  let total: any = 0;
  const pending: any[] = [directoryPath];
  while (pending.length > 0) {
    const current: any = pending.pop();
    const entries: any = await fs.readdir(current, { withFileTypes: true }).catch((error?: any) : any => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const selected: any = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(selected);
      else if (entry.isFile()) {
        const stat: any = await fs.stat(selected);
        total += Number(stat.blocks || 0) * 512;
      }
    }
  }
  return total;
}

async function runObjectStreamScenario() : Promise<any> {
  const userDataPath: any = path.join(rootPath, "object-stream");
  const sourcePath: any = path.join(rootPath, "fixtures", "object-source.bin");
  const sourceBytes: any = 32 * MIB;
  await writeRepeatedFile(sourcePath, sourceBytes);
  const object: any = await putStoredObjectFromFile({
    userDataPath,
    sourcePath,
    namespace: "resource-test",
    fileName: "synthetic.bin",
    expectedByteSize: sourceBytes
  });
  const opened: any = await openStoredObjectReadStream({
    userDataPath,
    storageRelativePath: object.storageRelativePath
  });
  let readBytes: any = 0;
  let maxChunkBytes: any = 0;
  for await (const chunk of opened.stream) {
    readBytes += chunk.length;
    maxChunkBytes = Math.max(maxChunkBytes, chunk.length);
  }
  assert(readBytes === sourceBytes, "object_stream_byte_count_mismatch");
  assert(maxChunkBytes <= 64 * 1024, "object_stream_chunk_unbounded");
  return { sourceBytes, readBytes, maxChunkBytes };
}

async function runMaterializationScenario() : Promise<any> {
  const userDataPath: any = path.join(rootPath, "materialization");
  const fileCount: any = 8;
  const bytesPerFile: any = 2 * MIB;
  const chunks: any[] = [];
  const files: any[] = [];
  for (let index: any = 0; index < fileCount; index += 1) {
    const content: any = Buffer.alloc(64 * 1024, 0x61 + index);
    const digest: any = crypto.createHash("sha256");
    for (let offset: any = 0; offset < bytesPerFile; offset += content.length) digest.update(content);
    chunks.push(content);
    files.push({
      relativePath: `source-${index}.bin`,
      sha256: digest.digest("hex"),
      byteSize: bytesPerFile,
      mediaType: "application/octet-stream"
    });
  }
  const storageKernel: any = createStorageKernel({ userDataPath });
  const storageProvider: any = createStorageProvider({ userDataPath, storageKernel });
  const keyBroker: any = createLocalCustodyKeyBroker({ userDataPath });
  const custody: any = createUploadNoRunCustody({
    userDataPath,
    storageKernel,
    storageProvider,
    keyBroker,
    reauthorizeCustodyRead: async () : Promise<any> => ({ allowed: false })
  });
  const store: any = createUploadSessionStore({
    userDataPath,
    custodyPort: custody.stagingPort,
    custodyDescribe: custody.describe
  });
  const owner: Readonly<Record<string, any>> = Object.freeze({
    subjectId: "resource-subject",
    tenantId: "resource-tenant",
    userId: "resource-user",
    username: "resource-user"
  });
  try {
    const created: any = await store.createOrResumeUploadSession({
      checkpoint: {
        checkpointId: "resource-checkpoint",
        archiveBatchId: "resource-batch",
        clientUid: "resource-client",
        sourceType: "upload"
      },
      manifest: {
        manifestDigest: sha256("resource-manifest"),
        inputDigest: sha256("resource-input")
      },
      owner,
      files
    });
    let writtenBytes: any = 0;
    for (let index: any = 0; index < fileCount; index += 1) {
      for (let offset: any = 0; offset < bytesPerFile; offset += chunks[index].length) {
        await store.appendUploadSessionChunk({
          sessionId: created.sessionId,
          fileIndex: index,
          offset,
          buffer: chunks[index],
          owner
        });
        writtenBytes += chunks[index].length;
      }
    }
    const resolved: any = await store.resolveUploadSessionFiles(
      created.sessionId,
      { owner }
    );
    const receipt: any = await store.buildCheckpointReceiptFromUploadSession(
      created.sessionId,
      { owner }
    );
    assert(writtenBytes === fileCount * bytesPerFile, "materialization_byte_count_mismatch");
    assert(resolved.length === fileCount, "materialization_descriptor_count_mismatch");
    assert(receipt.files.length === fileCount, "materialization_receipt_count_mismatch");
    assert(resolved.every((entry?: any) : any => entry.custodyState === "sealed_no_run"), "materialization_custody_not_sealed");
    return {
      fileCount,
      inputBytes: fileCount * bytesPerFile,
      sealedBytes: writtenBytes,
      maxChunkBytes: chunks[0].length
    };
  } finally {
    await keyBroker.close();
    storageKernel.close();
  }
}

async function runEventScenario() : Promise<any> {
  const store: any = createSqliteProtocolEventStore({
    userDataPath: path.join(rootPath, "events"),
    policy: {
      maxRecords: eventCount,
      maxBytes: releaseProfile ? 1024 * MIB : 128 * MIB,
      maxEventBytes: 4096,
      retentionBatch: 256
    }
  });
  const checkpoints: any[] = [];
  try {
    const startedAt: any = performance.now();
    const publishedAtBase: any = Date.now();
    for (let index: any = 0; index < eventCount; index += 1) {
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
        await new Promise((resolve?: any) : any => setImmediate(resolve));
      }
    }
    const stats: any = await store.getStats();
    assert(stats.eventCount === eventCount, "event_retention_count_mismatch");
    const plan: any = store.explainRead({ topics: ["topic-1"] })
      .map((entry?: any) : any => String(entry.detail || "")).join(" ");
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
    const convergedStats: any = await store.getStats();
    assert(convergedStats.eventCount === eventCount, "event_count_did_not_converge");
    const first: any = checkpoints[0];
    const last: any = checkpoints.at(-1);
    const unitCostScale: any = (last.elapsedMs / last.operations) /
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

async function runJobScenario() : Promise<any> {
  const store: any = createJobProjectionStore({
    userDataPath: path.join(rootPath, "jobs"),
    policy: {
      maxRecords: jobCount,
      maxMetadataBytes: 256 * MIB,
      terminalRetentionMs: 365 * 24 * 60 * 60 * 1000
    }
  });
  const base: any = Date.now();
  const checkpoints: any[] = [];
  try {
    const startedAt: any = performance.now();
    for (let index: any = 0; index < jobCount; index += 1) {
      const createdAt: any = new Date(base + index).toISOString();
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
      if ((index + 1) % 64 === 0) {
        await new Promise((resolve?: any) : any => setImmediate(resolve));
      }
    }
    const page: any = store.list({ limit: 100, ownerSubjectId: "owner-1" });
    const counts: any = store.getCounts();
    const plan: any = store.explainList({ ownerSubjectId: "owner-1" })
      .map((entry?: any) : any => String(entry.detail || "")).join(" ");
    const retentionPlan: any = store.explainTerminalRetention()
      .map((entry?: any) : any => String(entry.detail || "")).join(" ");
    assert(page.items.length === 100, "job_keyset_page_incomplete");
    assert(counts.totalCount === jobCount, "job_projection_count_mismatch");
    assert(plan.includes("idx_jobs_owner_created_id"), "job_query_index_missing");
    assert(
      retentionPlan.includes("idx_jobs_terminal_finished_id"),
      "job_retention_index_missing"
    );
    const first: any = checkpoints[0];
    const last: any = checkpoints.at(-1);
    const unitCostScale: any = (last.elapsedMs / last.operations) /
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

function endpointService(count?: any) : any {
  return {
    serviceId: "svc_resource",
    baseUrl: "https://service.invalid:443",
    endpoints: Array.from({ length: count }, (_unused?: any, index?: any) : any => ({
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

function endpointSelectionDuration(endpointCount?: any, iterations?: any) : any {
  const endpointCircuits: any = new Map<any, any>();
  const controller: any = createEndpointTrafficController({
    trafficBuckets: new Map<any, any>(),
    endpointCursors: new Map<any, any>(),
    endpointCircuits,
    appendAudit: () : any => ({}),
    recordMetric: () : any => {},
    persist: () : any => {}
  });
  const service: any = endpointService(endpointCount);
  const operation: Record<string, any> = { operationKey: "read", protocol: "http" };
  for (const endpoint of service.endpoints) {
    endpointCircuits.set(`svc_resource::read::${endpoint.endpointId}`, {
      consecutiveFailures: 3,
      openedUntilMs: Date.now() + 60_000
    });
  }
  const startedAt: any = performance.now();
  for (let index: any = 0; index < iterations; index += 1) {
    const selected: any = controller.selectEndpointTraffic(service, operation, { consume: true });
    assert(selected.traffic.allowed === false, "endpoint_open_circuit_was_selected");
  }
  return performance.now() - startedAt;
}

async function runEndpointScenario() : Promise<any> {
  const iterations: any = releaseProfile ? 20_000 : 2_000;
  const smallDuration: any = endpointSelectionDuration(8, iterations);
  const largeDuration: any = endpointSelectionDuration(64, iterations);
  const endpointScale: any = 64 / 8;
  const durationScale: any = largeDuration / Math.max(smallDuration, 0.001);
  const normalizedScale: any = durationScale / endpointScale;
  assert(normalizedScale <= 2.5, "endpoint_complexity_superlinear");
  return {
    endpointCount: 64,
    iterations,
    durationScale,
    normalizedScale,
    allRejected: true
  };
}

async function runAuditScenario() : Promise<any> {
  const store: any = createOperationAuditStore({
    userDataPath: path.join(rootPath, "audit")
  });
  try {
    await store.setRetentionPolicy({
      retentionDays: 1,
      maxRecords: Math.max(1024, Math.floor(auditWriteCount / 2)),
      maxLogicalBytes: 64 * MIB,
      cleanupBatchSize: 512,
      maintenanceEveryAppends: 64
    });
    const old: any = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const appendConcurrency: any = 256;
    for (let offset: any = 0; offset < auditWriteCount; offset += appendConcurrency) {
      const count: any = Math.min(appendConcurrency, auditWriteCount - offset);
      await Promise.all(Array.from({ length: count }, (_, batchIndex?: any) : any => {
        const index: any = offset + batchIndex;
        return store.append({
          operationId: `resource.audit.${index % 8}`,
          transport: "resource-gate",
          status: "ok",
          createdAt: old,
          input: { bucket: index % 16 }
        });
      }));
      await new Promise((resolve?: any) : any => setImmediate(resolve));
    }
    const current: any = await store.append({
      operationId: "resource.audit.current",
      transport: "resource-gate",
      status: "ok",
      input: {}
    });
    const meta: any = await store.getCapacityStats();
    const lane: any = store.getStats();
    assert(meta.rowCount <= 64, "audit_expired_rows_did_not_converge");
    assert(current.maintenance.deletedCount >= 0, "audit_maintenance_missing");
    assert(lane.pending === 0 && lane.writerWorkers === 1, "audit_lane_not_drained");
    return {
      appended: auditWriteCount + 1,
      retainedRecords: meta.rowCount,
      logicalBytes: meta.logicalBytes,
      converged: true,
      boundedLane: true
    };
  } finally {
    await store.close();
  }
}

function manifest(label?: any) : any {
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

async function runManifestScenario() : Promise<any> {
  const storageRoot: any = path.join(rootPath, "manifest");
  const store: any = createServiceManifestStore({ storageRoot });
  const serviceId: any = "svc_01JRESOURCE000000000000000";
  let serviceRevision: any = 0;
  let setRevision: any = 0;
  let last: any = null;
  for (let index: any = 0; index < manifestCommitCount; index += 1) {
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
    if ((index + 1) % 16 === 0) await new Promise((resolve?: any) : any => setImmediate(resolve));
  }
  const snapshot: any = await store.getSnapshot();
  assert(snapshot.serviceCount === 1, "manifest_snapshot_service_count_mismatch");
  const databasePath: any = path.join(storageRoot, "service-manifests", "authority.sqlite");
  const { openSqliteDatabase } = await import("../../../packages/foundation/src/storage/sqlite-database.ts");
  const db: any = openSqliteDatabase(databasePath, { readonly: true, fileMustExist: true });
  try {
    const requests: any = Number(db.prepare("SELECT COUNT(*) AS value FROM manifest_requests").get().value);
    const plan: any = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT request_digest
      FROM manifest_requests
      ORDER BY created_at_ms ASC,request_digest ASC
      LIMIT ?
    `).all(10).map((entry?: any) : any => String(entry.detail || "")).join(" ");
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

async function runBackupScenario() : Promise<any> {
  const userDataPath: any = path.join(rootPath, "backup");
  const sourcePath: any = path.join(userDataPath, "dataset", "large.bin");
  await writeRepeatedFile(sourcePath, 16 * MIB, 0x72);
  const first: any = await createStorageBackup({
    userDataPath,
    label: "resource-first",
    retentionPolicy: { keepLast: 2 }
  });
  const backupRoot: any = path.join(userDataPath, "backups");
  const allocatedAfterFirst: any = await allocatedBytes(backupRoot);
  const source: any = await fs.open(sourcePath, "r+");
  try {
    await source.write(Buffer.alloc(64 * 1024, 0x73), 0, 64 * 1024, 0);
    await source.sync();
  } finally {
    await source.close();
  }
  const second: any = await createStorageBackup({
    userDataPath,
    label: "resource-second",
    retentionPolicy: { keepLast: 2 }
  });
  const allocatedAfterSecond: any = await allocatedBytes(backupRoot);
  const pending: any = (await fs.readdir(backupRoot))
    .filter((name?: any) : any => name.endsWith(".pending")).length;
  const copyMethod: any = second.files[0]?.copyMethod || "";
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

async function main() : Promise<any> {
  if (!path.isAbsolute(rootPath) || rootPath === path.parse(rootPath).root) {
    fail("high_risk_private_root_invalid");
  }
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  const scenarios: any[] = [];
  scenarios.push(await measureScenario("object_stream", 1, runObjectStreamScenario));
  scenarios.push(await measureScenario("upload_materialization", 8, runMaterializationScenario));
  scenarios.push(await measureScenario("protocol_events", eventCount, runEventScenario));
  scenarios.push(await measureScenario("job_projection", jobCount, runJobScenario));
  scenarios.push(await measureScenario("endpoint_routing", releaseProfile ? 40_000 : 4_000, runEndpointScenario));
  scenarios.push(await measureScenario("operation_audit", auditWriteCount + 1, runAuditScenario));
  scenarios.push(await measureScenario("service_manifest", manifestCommitCount, runManifestScenario));
  scenarios.push(await measureScenario("backup_snapshot", 2, runBackupScenario));
  const result: Record<string, any> = {
    kind: "meshrix.resource-discipline.high-risk-result",
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
