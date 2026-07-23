import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  OBSERVABILITY_BUDGETS,
  createBoundedSnapshotCache,
  createBoundedWorkQueue,
  startObservabilityBudgetObservation
} from "../../../packages/foundation/src/observability/observability-budgets.mjs";
import {
  createBoundedMetricRegistry
} from "../../../packages/foundation/src/observability/metric-registry.mjs";
import {
  assertNoSensitiveReportLeak,
  finalizeAndPublishSensitiveReport,
  finalizeSensitiveReport,
  sanitizeSensitiveReport
} from "../../../packages/foundation/src/observability/sensitive-report-scan.mjs";
import {
  createPublishingObservationSink,
  createUpstreamPublicationTracker
} from "../../../packages/foundation/src/observability/upstream-publication.mjs";
import {
  assertNoSensitiveReportLeak as assertNoSensitiveReportLeakFromVerifierPath
} from "../../../tools/server-scripts/lib/sensitive-report-scan.mjs";

describe("bounded observability primitives", () => {
  it("uses one shared scanner for runtime and verifier report finalization", () => {
    expect(assertNoSensitiveReportLeakFromVerifierPath).toBe(assertNoSensitiveReportLeak);
    const protectedValue = ["private", "token", "value"].join("-");
    const report = finalizeSensitiveReport({
      schemaVersion: "observability-test",
      summary: { reportLeakScan: false },
      localPath: "/tmp/private-observability-report",
      authorization: ["Bearer", protectedValue].join(" "),
      nested: { token: protectedValue }
    });
    expect(report.summary.reportLeakScan).toBe(true);
    expect(JSON.stringify(report)).not.toContain("private-observability-report");
    expect(JSON.stringify(report)).not.toContain(protectedValue);
    expect(() => assertNoSensitiveReportLeak({ value: "/tmp/private" }, "unsafe report"))
      .toThrow(/local_path/u);
    expect(sanitizeSensitiveReport({ path: "/tmp/private" })).toEqual({ path: "[redacted-path]" });
  });

  it("rejects invalid report ownership before atomically publishing a finalized report", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "observability-report-finalizer-"));
    const filePath = path.join(directory, "report.json");
    const provenance = {
      producer: "licomesh-core-observability",
      commandId: "test-report",
      sourceRevision: "sha256:test-source"
    };
    try {
      await expect(finalizeAndPublishSensitiveReport({
        schemaVersion: "observability-test",
        verifier: "wrong-owner",
        generatedAt: "2026-01-01T00:00:00.000Z",
        summary: {}
      }, {
        filePath,
        schemaVersion: "observability-test",
        verifier: "owned-verifier",
        provenance
      })).rejects.toMatchObject({ code: "observability_report_owner_mismatch" });
      await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });

      const report = await finalizeAndPublishSensitiveReport({
        schemaVersion: "observability-test",
        verifier: "owned-verifier",
        generatedAt: "2026-01-01T00:00:00.000Z",
        summary: { readyForReleaseReduction: true },
        pathFixture: "/tmp/private-report-value"
      }, {
        filePath,
        schemaVersion: "observability-test",
        verifier: "owned-verifier",
        provenance,
        checkpointDigest: `sha256:${"d".repeat(64)}`,
        requirements: ["REQ-REL-011"]
      });
      const published = JSON.parse(await fs.readFile(filePath, "utf8"));
      expect(published).toEqual(report);
      expect(published).toMatchObject({
        reportOwner: provenance.producer,
        checkpointDigest: `sha256:${"d".repeat(64)}`,
        requirements: ["REQ-REL-011"],
        privacyFinalization: {
          redactionApplied: true,
          privacyScanPassed: true,
          atomicPublication: true
        }
      });
      expect(JSON.stringify(published)).not.toContain("private-report-value");
      expect(published.payloadDigest).toBeTruthy();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("admits only finite metric dimensions and enforces series and cancellation budgets", () => {
    const registry = createBoundedMetricRegistry({
      families: ["alerts"],
      statuses: ["firing", "resolved"],
      reasons: ["condition_matched", "condition_recovered"],
      stages: ["evaluate"],
      maxSeries: 1
    });
    registry.record({
      family: "alerts",
      status: "firing",
      reason: "condition_matched",
      stage: "evaluate",
      durationMs: 20
    });
    expect(registry.snapshot()).toMatchObject({ seriesCount: 1, maxSeries: 1 });
    expect(() => registry.record({
      family: "alerts",
      status: "resolved",
      reason: "condition_recovered",
      stage: "evaluate"
    })).toThrowError(expect.objectContaining({ code: "observability_metric_series_budget_exceeded" }));
    expect(() => registry.record({
      family: "alerts",
      status: "subject-123",
      reason: "condition_matched",
      stage: "evaluate"
    })).toThrowError(expect.objectContaining({ code: "observability_metric_dimension_rejected" }));
    const controller = new AbortController();
    controller.abort();
    expect(() => registry.record({
      family: "alerts",
      status: "firing",
      reason: "condition_matched",
      stage: "evaluate"
    }, { signal: controller.signal })).toThrowError(expect.objectContaining({ code: "observability_cancelled" }));
  });

  it("rejects oversized metric descriptors and accumulator overflow", () => {
    expect(() => createBoundedMetricRegistry({
      families: Array.from({ length: OBSERVABILITY_BUDGETS.maxMetricVocabularyValues + 1 }, (_, index) => `family-${index}`),
      statuses: ["ok"],
      reasons: ["accepted"]
    })).toThrowError(expect.objectContaining({ code: "observability_metric_vocabulary_budget_exceeded" }));
    expect(() => createBoundedMetricRegistry({
      families: ["family"],
      statuses: ["ok"],
      reasons: ["accepted"],
      maxSeries: OBSERVABILITY_BUDGETS.maxMetricSeries + 1
    })).toThrowError(expect.objectContaining({ code: "observability_metric_series_budget_invalid" }));

    const registry = createBoundedMetricRegistry({
      families: ["family"],
      statuses: ["ok"],
      reasons: ["accepted"]
    });
    registry.record({ family: "family", status: "ok", reason: "accepted", count: Number.MAX_SAFE_INTEGER });
    expect(() => registry.record({ family: "family", status: "ok", reason: "accepted" }))
      .toThrowError(expect.objectContaining({ code: "observability_metric_accumulator_budget_exceeded" }));
  });

  it("reduces production publishing events without exposing partition identities", () => {
    const tracker = createUpstreamPublicationTracker();
    const partitionHash = "a".repeat(16);
    const stages = ["compile", "persist", "project", "notify", "pull", "acknowledge", "publish"];
    for (const [index, stage] of stages.entries()) {
      tracker.observe({
        stage,
        outcome: "succeeded",
        reason: stage === "publish" ? "server_published" : "accepted",
        revision: 2,
        previousRevision: 1,
        durationMs: index + 1,
        lagMs: stage === "publish" ? 10 : 0,
        affectedPartitionHashes: [partitionHash],
        occurredAt: "2026-01-01T00:00:00.000Z"
      });
    }
    const snapshot = tracker.snapshot();
    expect(snapshot).toMatchObject({
      partitionCount: 1,
      revisionCount: 1,
      latestRevision: 2,
      budgets: {
        maxPublicationPartitions: OBSERVABILITY_BUDGETS.maxPublicationPartitions,
        maxPublicationRevisions: OBSERVABILITY_BUDGETS.maxPublicationRevisions
      }
    });
    expect(snapshot.revisions[0].stages).toEqual(stages.slice().sort());
    expect(snapshot.metrics.seriesCount).toBe(7);
    expect(JSON.stringify(snapshot)).not.toContain(partitionHash);
    expect(tracker.observe({
      stage: "publish",
      outcome: "succeeded",
      reason: "server_published",
      revision: 2,
      previousRevision: 1,
      durationMs: 1,
      lagMs: 0,
      affectedPartitionHashes: [partitionHash],
      occurredAt: "2026-01-01T00:00:01.000Z"
    })).toMatchObject({ accepted: false, status: "duplicate" });
  });

  it("rejects incomplete publication, unknown fields, raw partition ids, and cancelled updates", () => {
    const tracker = createUpstreamPublicationTracker();
    const base = {
      outcome: "succeeded",
      reason: "server_published",
      revision: 1,
      previousRevision: 0,
      durationMs: 1,
      lagMs: 0,
      affectedPartitionHashes: ["b".repeat(16)],
      occurredAt: "2026-01-01T00:00:00.000Z"
    };
    expect(() => tracker.observe({ ...base, stage: "publish" }))
      .toThrowError(expect.objectContaining({ code: "upstream_observation_publication_incomplete" }));
    expect(() => tracker.observe({ ...base, stage: "compile", rawPayload: "forbidden" }))
      .toThrowError(expect.objectContaining({ code: "upstream_observation_unknown_field" }));
    expect(() => tracker.observe({ ...base, stage: "compile", reason: "rollback_applied" }))
      .toThrowError(expect.objectContaining({ code: "upstream_observation_stage_reason_invalid" }));
    expect(() => tracker.observe({ ...base, stage: "compile", affectedPartitionHashes: ["grant-private"] }))
      .toThrowError(expect.objectContaining({ code: "upstream_observation_partition_invalid" }));
    const controller = new AbortController();
    controller.abort();
    expect(() => tracker.observe({ ...base, stage: "compile" }, { signal: controller.signal }))
      .toThrowError(expect.objectContaining({ code: "observability_cancelled" }));
    expect(tracker.snapshot().revisionCount).toBe(0);
  });

  it("exposes a bounded PublishingObservationSink contract without production claims", () => {
    const sink = createPublishingObservationSink();
    expect(sink.publish({
      stage: "compile",
      outcome: "succeeded",
      reason: "accepted",
      revision: 1,
      previousRevision: 0,
      affectedPartitionHashes: ["e".repeat(16)],
      occurredAt: "2026-01-01T00:00:00.000Z"
    })).toMatchObject({ accepted: true, revision: 1 });
    expect(sink.snapshot()).toMatchObject({ revisionCount: 1, latestRevision: 1 });
    expect(Object.keys(sink).sort()).toEqual(["publish", "snapshot"]);
  });

  it("rejects out-of-order stages and non-monotonic affected-partition edges", () => {
    const tracker = createUpstreamPublicationTracker();
    const base = {
      outcome: "succeeded",
      reason: "accepted",
      revision: 1,
      previousRevision: 0,
      affectedPartitionHashes: ["f".repeat(16)],
      occurredAt: "2026-01-01T00:00:00.000Z"
    };
    tracker.observe({ ...base, stage: "compile" });
    expect(() => tracker.observe({ ...base, stage: "project" }))
      .toThrowError(expect.objectContaining({ code: "upstream_observation_stage_order_invalid" }));
    expect(() => tracker.observe({
      ...base,
      stage: "compile",
      revision: 2,
      previousRevision: 0
    })).toThrowError(expect.objectContaining({ code: "upstream_observation_previous_revision_mismatch" }));
    expect(tracker.snapshot()).toMatchObject({ partitionCount: 1, revisionCount: 1, latestRevision: 1 });
  });

  it("fails closed on duration, CPU, and RSS budget overruns", () => {
    const duration = startObservabilityBudgetObservation({
      now: (() => {
        const values = [0, 6];
        return () => values.shift();
      })(),
      cpuUsage: () => ({ user: 0, system: 0 }),
      rss: () => 0
    });
    expect(() => duration.finish({ budgets: {
      ...OBSERVABILITY_BUDGETS,
      maxCycleDurationMs: 5
    } })).toThrowError(expect.objectContaining({ code: "observability_duration_budget_exceeded" }));

    const cpu = startObservabilityBudgetObservation({
      now: () => 0,
      cpuUsage: (started) => started ? { user: 2_000, system: 0 } : { user: 0, system: 0 },
      rss: () => 0
    });
    expect(() => cpu.finish({ budgets: {
      ...OBSERVABILITY_BUDGETS,
      maxCycleCpuMs: 1
    } })).toThrowError(expect.objectContaining({ code: "observability_cpu_budget_exceeded" }));

    const rss = startObservabilityBudgetObservation({
      now: () => 0,
      cpuUsage: () => ({ user: 0, system: 0 }),
      rss: (() => {
        const values = [0, 2];
        return () => values.shift();
      })()
    });
    expect(() => rss.finish({ budgets: {
      ...OBSERVABILITY_BUDGETS,
      maxCycleRssDeltaBytes: 1
    } })).toThrowError(expect.objectContaining({ code: "observability_rss_budget_exceeded" }));
  });

  it("bounds queued work and snapshot cache capacity under pressure", async () => {
    const queue = createBoundedWorkQueue({ maxConcurrent: 1, maxPending: 1 });
    let release;
    const first = queue.run(() => new Promise((resolve) => {
      release = resolve;
    }));
    const second = queue.run(() => "second");
    expect(queue.snapshot()).toMatchObject({ active: 1, pending: 1 });
    expect(() => queue.run(() => "overflow"))
      .toThrowError(expect.objectContaining({ code: "observability_work_queue_budget_exceeded" }));
    await Promise.resolve();
    release("first");
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(queue.snapshot()).toMatchObject({ active: 0, pending: 0 });

    const strictCache = createBoundedSnapshotCache({ maxEntries: 1, overflow: "error" });
    strictCache.set("a", 1);
    expect(() => strictCache.set("b", 2))
      .toThrowError(expect.objectContaining({ code: "observability_snapshot_cache_budget_exceeded" }));
    const evictingCache = createBoundedSnapshotCache({ maxEntries: 1 });
    evictingCache.set("a", 1);
    evictingCache.set("b", 2);
    expect(evictingCache.get("a")).toBeUndefined();
    expect(evictingCache.snapshot()).toEqual({ size: 1, maxEntries: 1, evictions: 1 });
  });

  it("bounds publication partitions and revision windows under stress", () => {
    const tracker = createUpstreamPublicationTracker({
      budgets: { ...OBSERVABILITY_BUDGETS, maxPublicationPartitions: 1, maxPublicationRevisions: 1 }
    });
    tracker.observe({
      stage: "compile",
      outcome: "succeeded",
      reason: "accepted",
      revision: 1,
      previousRevision: 0,
      affectedPartitionHashes: ["c".repeat(16)],
      occurredAt: "2026-01-01T00:00:00.000Z"
    });
    expect(() => tracker.observe({
      stage: "compile",
      outcome: "succeeded",
      reason: "accepted",
      revision: 2,
      previousRevision: 1,
      affectedPartitionHashes: ["d".repeat(16)],
      occurredAt: "2026-01-01T00:00:01.000Z"
    })).toThrowError(expect.objectContaining({ code: "upstream_publication_partition_budget_exceeded" }));
    expect(tracker.snapshot()).toMatchObject({ partitionCount: 1, revisionCount: 1, latestRevision: 1 });
  });
});
