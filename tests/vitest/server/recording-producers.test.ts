import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRecordingSinkStore } from "../../../packages/foundation/src/recording/recording-sink-store.ts";
import {
  createRecordingProducer,
  recordingProducerForPort
} from "../../../packages/foundation/src/recording/recording-producer.ts";
import { createDispatchOperationRecorder } from "../../../packages/server-runtime/src/composition/dispatch-operation-recording.ts";

const SINK_ID = "sink.rec.prod.1";
const LIFECYCLE_VERSION = "v0.0.1:recording:lifecycle-1";
const POLICY_VERSION = "v0.0.1:recording:policy-1";
const READER = "role.rec.auditor";
const ADMIN = "role.rec.admin";

const temporaryRoots: Set<string> = new Set();
const openStores: Set<any> = new Set();

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-recording-producer-"));
  temporaryRoots.add(root);
  return root;
}

afterEach((): any => {
  for (const store of openStores) {
    try { store.close(); } catch { /* already closed */ }
  }
  openStores.clear();
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

function categorySelection(overrides: Record<string, any> = {}): any {
  return {
    obligation: "optional",
    sinkRef: SINK_ID,
    fieldAllow: [],
    fieldRedact: [],
    eventAllow: [],
    readerRoles: [READER],
    configurerRoles: [ADMIN],
    retention: { maxAgeSeconds: 3_600, maxRecords: 64, maxContentBytes: 0, maxIndexBytes: 65_536 },
    capacity: { maxBufferedRecords: 16, maxRecordBytes: 8_192 },
    ...overrides
  };
}

function makePolicy(categories: Record<string, any>, policyRevision = 1): any {
  return {
    schemaVersion: POLICY_VERSION,
    kind: "recording-policy",
    policyId: "pol.rec.producer",
    policyRevision,
    issuedAt: "2026-10-10T00:00:00Z",
    issuerRole: ADMIN,
    configurerRoles: [ADMIN],
    categories
  };
}

function openStore(rootPath: string, policy: any, budgets: Record<string, any> = {}): any {
  const store = createRecordingSinkStore({
    rootPath,
    sink: {
      schemaVersion: LIFECYCLE_VERSION,
      kind: "recording-sink",
      sinkId: SINK_ID,
      custody: "enterprise_local",
      durable: true,
      budgets: {
        maxRecordBytes: 16_384,
        maxContentBytes: 131_072,
        maxIndexBytes: 262_144,
        maxBufferedRecords: 128,
        maxPendingWrites: 16,
        ...budgets
      }
    },
    policy
  });
  openStores.add(store);
  return store;
}

function policyWith(overrides: Record<string, any> = {}, revision = 1): any {
  const categories: Record<string, any> = {
    content: categorySelection({
      fieldAllow: ["summary"],
      retention: { maxAgeSeconds: 3_600, maxRecords: 64, maxContentBytes: 65_536, maxIndexBytes: 65_536 }
    }),
    execution_history: categorySelection({ obligation: "required_before_effect" }),
    governance_history: categorySelection(),
    usage: categorySelection({ fieldAllow: ["operations.dispatched", "operations.succeeded", "operations.failed"] }),
    diagnostics: categorySelection({
      eventAllow: [
        "operation.dispatch.denied",
        "operation.dispatch.failed",
        "operation.dispatch.in_doubt"
      ]
    })
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete categories[key];
    else categories[key] = value;
  }
  return makePolicy(categories, revision);
}

function listAll(store: any, category: string, operationRef?: string): any[] {
  return store.listRecords({
    category,
    role: READER,
    ...(operationRef ? { operationRef } : {})
  });
}

describe("recording producer", () => {
  it("denies a disabled category before build and writes nothing", () => {
    const store = openStore(tempRoot(), policyWith({ diagnostics: undefined }));
    const producer = createRecordingProducer({ sink: store });
    const session = producer.session({ operationRef: "op.disabled.1", tenantRef: "tenant.a" });
    let builds = 0;
    const result = session.collect({
      category: "diagnostics",
      eventCode: "operation.dispatch.failed",
      build: () => { builds += 1; return { eventCode: "operation.dispatch.failed", counters: { occurrences: 1 } }; }
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("category_disabled");
    expect(result.collected).toBe(false);
    expect(builds).toBe(0); // no serialization for a disabled category
    expect(listAll(store, "diagnostics")).toEqual([]);
    producer.close();
  });

  it("denies forbidden and unselected fields before any payload is built", () => {
    const store = openStore(tempRoot(), policyWith());
    const producer = createRecordingProducer({ sink: store });
    const session = producer.session({ operationRef: "op.forbidden.1", tenantRef: "tenant.a" });
    let builds = 0;
    const forbidden = session.collect({
      category: "content",
      fieldNames: ["secret"],
      build: () => { builds += 1; return { fieldNames: ["secret"], contentDigest: "sha256:x", artifactRefs: ["a"] }; }
    });
    expect(forbidden.decision).toBe("deny");
    expect(forbidden.reason).toBe("forbidden_field");
    const unselected = session.collect({
      category: "content",
      fieldNames: ["internal"],
      build: () => { builds += 1; return { fieldNames: ["internal"], contentDigest: "sha256:x", artifactRefs: ["a"] }; }
    });
    expect(unselected.decision).toBe("deny");
    expect(unselected.reason).toBe("field_not_selected");
    expect(builds).toBe(0);
    expect(listAll(store, "content")).toEqual([]);
    producer.close();
  });

  it("reserves durable capacity for a required category before the effect and rejects when full", () => {
    const policy = policyWith({
      execution_history: categorySelection({
        obligation: "required_before_effect",
        capacity: { maxBufferedRecords: 1, maxRecordBytes: 8_192 }
      })
    });
    const store = openStore(tempRoot(), policy);
    const producer = createRecordingProducer({ sink: store });

    const first = producer.session({ operationRef: "op.required.first", tenantRef: "tenant.a" });
    const admitted = first.admitBeforeEffect({
      builders: {
        execution_history: () => ({ event: "started", effectClass: "read", durationBucket: "not_applicable" })
      }
    });
    expect(admitted.ok).toBe(true);
    const started = listAll(store, "execution_history", "op.required.first");
    expect(started.map((r: any) => r.detail.event)).toEqual(["started"]);
    expect(started[0].phase).toBe("pre_effect");
    expect(started[0].policyRevision).toBe(1);

    // The category is now at its per-category buffered ceiling: a second
    // required admission must reject recording_unavailable, not degrade.
    const second = producer.session({ operationRef: "op.required.refused", tenantRef: "tenant.a" });
    const refused = second.admitBeforeEffect({
      builders: {
        execution_history: () => ({ event: "started", effectClass: "read", durationBucket: "not_applicable" })
      }
    });
    expect(refused.ok).toBe(false);
    expect(refused.blocked.decision).toBe("reject");
    expect(refused.reasonCode).toBe("recording_unavailable");
    expect(listAll(store, "execution_history", "op.required.refused")).toEqual([]);
    producer.close();
  });

  it("stops capture at the next collection point on a live off flip and settles the owed terminal later", () => {
    const root = tempRoot();
    const store = openStore(root, policyWith());
    const producer = createRecordingProducer({ sink: store });
    const session = producer.session({ operationRef: "op.flip.1", tenantRef: "tenant.a" });
    const admitted = session.admitBeforeEffect({
      builders: {
        execution_history: () => ({ event: "started", effectClass: "read", durationBucket: "not_applicable" })
      }
    });
    expect(admitted.ok).toBe(true);
    expect(listAll(store, "execution_history", "op.flip.1").length).toBe(1);

    // Mid-flight off flip: revision 2 deselects execution_history.
    const revision2 = makePolicy({
      content: categorySelection({
        fieldAllow: ["summary"],
        retention: { maxAgeSeconds: 3_600, maxRecords: 64, maxContentBytes: 65_536, maxIndexBytes: 65_536 }
      }),
      governance_history: categorySelection(),
      usage: categorySelection({ fieldAllow: ["operations.dispatched", "operations.succeeded"] }),
      diagnostics: categorySelection({ eventAllow: ["operation.dispatch.failed"] })
    }, 2);
    store.publishPolicy(revision2, ADMIN);

    const settlement = session.settle({
      operationStatus: "succeeded",
      builders: {
        execution_history: () => ({ event: "completed", effectClass: "read", durationBucket: "lt_10ms" })
      },
      usageCounters: { "operations.dispatched": 1, "operations.succeeded": 1 }
    });
    // The start record stays; the terminal is refused at the collection point.
    const executions = listAll(store, "execution_history", "op.flip.1");
    expect(executions.map((r: any) => r.detail.event)).toEqual(["started"]);
    expect(executions[0].policyRevision).toBe(1);
    const owed = session.pendingObligations();
    expect(owed.map((row: any) => [row.operationRef, row.category])).toEqual([["op.flip.1", "execution_history"]]);
    expect(owed[0].reason).toBe("category_disabled");
    const outcome = settlement.outcomes.execution_history;
    expect(outcome.outcome).toBe("partially_recorded");
    expect(outcome.pendingTerminal).toBe(true);

    // While the category stays off, settlement cannot fabricate the record.
    const stillPending = session.settlePending({
      operationStatus: "succeeded",
      builders: {
        execution_history: () => ({ event: "completed", effectClass: "read", durationBucket: "lt_10ms" })
      }
    });
    expect(stillPending.results.execution_history.collected).toBe(false);
    expect(session.pendingObligations().length).toBe(1);

    // Re-enabled under revision 3: the owed terminal settles, the pre-off
    // start record is untouched, and the outcome reports the truth.
    const revision3 = makePolicy({
      execution_history: categorySelection({ obligation: "required_before_effect" }),
      governance_history: categorySelection(),
      usage: categorySelection({ fieldAllow: ["operations.dispatched", "operations.succeeded"] }),
      diagnostics: categorySelection({ eventAllow: ["operation.dispatch.failed"] })
    }, 3);
    store.publishPolicy(revision3, ADMIN);
    const settled = session.settlePending({
      operationStatus: "succeeded",
      builders: {
        execution_history: () => ({ event: "completed", effectClass: "read", durationBucket: "lt_10ms" })
      }
    });
    expect(settled.results.execution_history.collected).toBe(true);
    expect(settled.outcomes.execution_history.outcome).toBe("recorded");
    expect(session.pendingObligations()).toEqual([]);
    const after = listAll(store, "execution_history", "op.flip.1");
    expect(after.map((r: any) => r.detail.event)).toEqual(["started", "completed"]);
    expect(after[0].policyRevision).toBe(1);
    expect(after[1].policyRevision).toBe(3);
    producer.close();
  });

  it("sheds optional categories under capacity without faulting the operation", () => {
    const store = openStore(tempRoot(), policyWith({
      diagnostics: categorySelection({
        eventAllow: ["operation.dispatch.failed"],
        capacity: { maxBufferedRecords: 1, maxRecordBytes: 8_192 }
      })
    }));
    const producer = createRecordingProducer({ sink: store });
    const session = producer.session({ operationRef: "op.shed.1", tenantRef: "tenant.a" });
    const first = session.collect({
      category: "diagnostics",
      eventCode: "operation.dispatch.failed",
      build: () => ({ eventCode: "operation.dispatch.failed", counters: { occurrences: 1 } })
    });
    expect(first.collected).toBe(true);
    const shed = session.collect({
      category: "diagnostics",
      eventCode: "operation.dispatch.failed",
      build: () => ({ eventCode: "operation.dispatch.failed", counters: { occurrences: 1 } })
    });
    expect(shed.decision).toBe("shed");
    expect(shed.reason).toBe("capacity_exceeded");
    expect(shed.collected).toBe(false);
    expect(listAll(store, "diagnostics", "op.shed.1").length).toBe(1);
    producer.close();
  });

  it("aggregates usage per tenant bucket, filters to allowlisted counters, and drops buffered aggregates on off", () => {
    const root = tempRoot();
    const store = openStore(root, policyWith());
    const producer = createRecordingProducer({ sink: store });
    expect(producer.noteUsage({
      tenantRef: "tenant.a",
      operationRef: "op.use.1",
      counters: { "operations.dispatched": 1, "secret.counter": 9 }
    })).toBe(true);
    expect(producer.noteUsage({
      tenantRef: "tenant.a",
      operationRef: "op.use.2",
      counters: { "operations.dispatched": 1, "operations.succeeded": 1 }
    })).toBe(true);
    expect(producer.pendingUsageBuckets()).toBe(1);
    expect(producer.flushUsage({ force: true })).toBe(1);
    const usage = listAll(store, "usage");
    expect(usage.length).toBe(1);
    expect(usage[0].detail.counters).toEqual({ "operations.dispatched": 2, "operations.succeeded": 1 });
    expect(Object.keys(usage[0].detail.counters)).not.toContain("secret.counter");

    // Off flip: accumulation stops, and the aggregate buffered before the
    // flip is dropped rather than written under a disabled category.
    expect(producer.noteUsage({ tenantRef: "tenant.a", counters: { "operations.dispatched": 1 } })).toBe(true);
    expect(producer.pendingUsageBuckets()).toBe(1);
    const off = makePolicy({
      execution_history: categorySelection({ obligation: "required_before_effect" }),
      governance_history: categorySelection(),
      diagnostics: categorySelection({ eventAllow: ["operation.dispatch.failed"] })
    }, 2);
    store.publishPolicy(off, ADMIN);
    expect(producer.noteUsage({ tenantRef: "tenant.a", counters: { "operations.dispatched": 1 } })).toBe(false);
    producer.flushUsage({ force: true });
    expect(producer.pendingUsageBuckets()).toBe(0);
    expect(listAll(store, "usage").length).toBe(1);
    producer.close();
  });

  it("resolves one shared producer per sink port", () => {
    const store = openStore(tempRoot(), policyWith());
    const a = recordingProducerForPort(store);
    const b = recordingProducerForPort(store);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(recordingProducerForPort(null)).toBeNull();
    expect(recordingProducerForPort({})).toBeNull();
    a.close();
  });
});

describe("dispatch operation recorder", () => {
  function recorderFor(store: any, overrides: Record<string, any> = {}): any {
    return createDispatchOperationRecorder({
      recordingSink: store,
      operation: { id: "tool.search", readOnly: false, safety: { risk: "safe_write" } },
      operationInput: { summary: "quarterly report", secret: "do-not-record" },
      transport: "http",
      method: "POST",
      traceContext: { requestId: "req.1" },
      request: {},
      ...overrides
    });
  }

  it("is a no-op recorder without a sink", () => {
    const recorder = createDispatchOperationRecorder({
      recordingSink: null,
      operation: { id: "tool.search" },
      operationInput: {}
    });
    expect(recorder.admitBeforeEffect().ok).toBe(true);
    expect(recorder.settle({ status: "ok" })).toBeNull();
    expect(recorder.report().operationRef).toBe("");
  });

  it("records start, terminal, governance, content and usage for a healthy dispatch", () => {
    const store = openStore(tempRoot(), policyWith());
    const recorder = recorderFor(store, {
      getAuthSession: () => ({ tenantId: "tenant.real.1", user: { subjectId: "subject.9" } })
    });
    expect(recorder.admitBeforeEffect().ok).toBe(true);
    const settlement = recorder.settle({ status: "ok" });
    expect(settlement).not.toBeNull();

    const executions = listAll(store, "execution_history", recorder.operationRef);
    // Tenant attribution binds at the first collection point — after the
    // dispatch authorization has resolved — not at recorder construction.
    expect(executions[0].tenantRef).toBe("tenant.real.1");
    expect(executions.map((r: any) => r.detail.event)).toEqual(["started", "completed"]);
    expect(executions[1].detail.effectClass).toBe("safe_write");

    const governance = listAll(store, "governance_history", recorder.operationRef);
    expect(governance.length).toBeGreaterThanOrEqual(1);
    expect(["policy_decision", "approval"]).toContain(governance[0].detail.governanceEvent);

    const content = listAll(store, "content", recorder.operationRef);
    expect(content.length).toBe(1);
    expect(content[0].detail.fieldNames).toEqual(["summary"]);
    expect(content[0].detail.contentDigest.startsWith("sha256:")).toBe(true);
    // Only digests/artifact refs persist: the raw payload never reaches the record.
    expect(JSON.stringify(content[0].detail)).not.toContain("quarterly report");
    const artifact = store.readArtifact({
      artifactRef: content[0].detail.artifactRefs[0],
      role: READER
    });
    expect(JSON.parse(artifact.bytes.toString("utf8"))).toEqual({ summary: "quarterly report" });
    expect(JSON.stringify(content[0].detail)).not.toContain("do-not-record");

    const report = recorder.report();
    expect(report.operationRef).toBe(recorder.operationRef);
    expect(report.outcomes.execution_history.outcome).toBe("recorded");
    expect(report.pendingObligations).toEqual([]);
  });

  it("never fabricates a terminal execution event for an in_doubt dispatch", () => {
    const store = openStore(tempRoot(), policyWith());
    const recorder = recorderFor(store);
    expect(recorder.admitBeforeEffect().ok).toBe(true);
    const settlement = recorder.settle({ status: "in_doubt" });

    const executions = listAll(store, "execution_history", recorder.operationRef);
    expect(executions.map((r: any) => r.detail.event)).toEqual(["started"]);
    const outcome = settlement.outcomes.execution_history;
    expect(outcome.outcome).toBe("terminal_record_pending");
    expect(outcome.pendingTerminal).toBe(true);

    const diagnostics = listAll(store, "diagnostics", recorder.operationRef);
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].detail.eventCode).toBe("operation.dispatch.in_doubt");
  });

  it("writes only the diagnostics event for a denied dispatch", () => {
    const store = openStore(tempRoot(), policyWith());
    const recorder = recorderFor(store);
    const settlement = recorder.settle({ status: "denied" });
    expect(listAll(store, "execution_history", recorder.operationRef)).toEqual([]);
    const diagnostics = listAll(store, "diagnostics", recorder.operationRef);
    expect(diagnostics.map((r: any) => r.detail.eventCode)).toEqual(["operation.dispatch.denied"]);
    expect(settlement.outcomes.diagnostics.outcome).toBe("recorded");
  });
});
