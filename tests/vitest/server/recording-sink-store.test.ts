import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RECORDING_CATEGORIES,
  parseRecordingOutcome,
  parseRecordAdmission,
  recordingAdmissionBlocksOperation,
  recordingMayReplayEffect
} from "../../../packages/contracts/src/recording/index.ts";
import {
  createRecordingSinkStore
} from "../../../packages/foundation/src/recording/recording-sink-store.ts";

const SINK_ID = "sink.rec.test.1";
const LIFECYCLE_VERSION = "v0.0.1:recording:lifecycle-1";
const POLICY_VERSION = "v0.0.1:recording:policy-1";

const temporaryRoots: Set<string> = new Set();

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-recording-sink-"));
  temporaryRoots.add(root);
  return root;
}

afterEach((): any => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

function sinkDescriptor(budgets: Record<string, any> = {}): any {
  return {
    schemaVersion: LIFECYCLE_VERSION,
    kind: "recording-sink",
    sinkId: SINK_ID,
    custody: "enterprise_local",
    durable: true,
    budgets: {
      maxRecordBytes: 8192,
      maxContentBytes: 65_536,
      maxIndexBytes: 131_072,
      maxBufferedRecords: 64,
      maxPendingWrites: 8,
      ...budgets
    }
  };
}

function categorySelection(overrides: Record<string, any> = {}): any {
  return {
    obligation: "optional",
    sinkRef: SINK_ID,
    fieldAllow: [],
    fieldRedact: [],
    eventAllow: [],
    readerRoles: ["role.rec.auditor"],
    configurerRoles: ["role.rec.admin"],
    retention: {
      maxAgeSeconds: 3_600,
      maxRecords: 32,
      maxContentBytes: 0,
      maxIndexBytes: 32_768
    },
    capacity: { maxBufferedRecords: 8, maxRecordBytes: 4_096 },
    ...overrides
  };
}

function makePolicy(categories: Record<string, any>, policyRevision = 1): any {
  return {
    schemaVersion: POLICY_VERSION,
    kind: "recording-policy",
    policyId: "pol.rec.test",
    policyRevision,
    issuedAt: "2026-10-10T00:00:00Z",
    issuerRole: "role.rec.admin",
    configurerRoles: ["role.rec.admin"],
    categories
  };
}

function isoAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function record(overrides: Record<string, any> = {}): any {
  return {
    schemaVersion: LIFECYCLE_VERSION,
    kind: "recording-record",
    recordId: `rec.${Math.abs(JSON.stringify(overrides).length)}`,
    tenantRef: "tenant.rec.1",
    operationRef: "op.rec.1",
    category: "usage",
    evidenceClass: "selected_history",
    policyRevision: 1,
    sinkRef: SINK_ID,
    phase: "post_effect",
    occurredAt: new Date().toISOString(),
    detail: { counters: { "ops.completed": 1 }, bucketStart: "2026-10-10T00:00:00Z" },
    indexBytes: 256,
    contentBytes: 0,
    ...overrides
  };
}

function executionRecord(recordId: string, operationRef: string, event: string, revision = 1, occurredAt?: string): any {
  return record({
    recordId,
    operationRef,
    category: "execution_history",
    policyRevision: revision,
    phase: event === "started" ? "pre_effect" : "post_effect",
    occurredAt: occurredAt || new Date().toISOString(),
    detail: {
      event,
      effectClass: "read",
      durationBucket: event === "started" ? "not_applicable" : "lt_100ms"
    }
  });
}

function usageRecord(recordId: string, operationRef: string, revision = 1, occurredAt?: string): any {
  return record({
    recordId,
    operationRef,
    category: "usage",
    policyRevision: revision,
    occurredAt: occurredAt || new Date().toISOString(),
    detail: { counters: { "ops.completed": 1 }, bucketStart: "2026-10-10T00:00:00Z" }
  });
}

function openStore(rootPath: string, policy: any, options: Record<string, any> = {}): any {
  const { sink, budgets, now, ...rest } = options;
  return createRecordingSinkStore({
    rootPath,
    sink: sink || sinkDescriptor(budgets),
    policy,
    ...(now ? { now } : {}),
    ...rest
  });
}

describe("enterprise recording sink store", () => {
  it("persists records, artifacts, policy and pending obligations across restart", () => {
    const root = tempRoot();
    const policy = makePolicy({
      content: categorySelection({
        fieldAllow: ["input.summary"],
        retention: { maxAgeSeconds: 3_600, maxRecords: 32, maxContentBytes: 65_536, maxIndexBytes: 32_768 }
      }),
      execution_history: categorySelection({ obligation: "required_before_effect" })
    });
    // The index budget admits the start record but not the terminal one.
    let store = openStore(root, policy, { budgets: { maxIndexBytes: 600 } });
    const artifact = store.putArtifact({ bytes: Buffer.from("selected content bytes") });
    expect(artifact.contentDigest.startsWith("sha256:")).toBe(true);
    store.writeRecord(record({
      recordId: "rec.content.1",
      category: "content",
      detail: {
        fieldNames: ["input.summary"],
        contentDigest: artifact.contentDigest,
        artifactRefs: [artifact.artifactRef]
      },
      contentBytes: artifact.byteSize
    }));
    const admission = parseRecordAdmission(store.admit({
      tenantRef: "tenant.rec.1",
      operationRef: "op.rec.1",
      category: "execution_history",
      phase: "pre_effect"
    }));
    expect(admission.decision).toBe("admit");
    store.writeRecord(executionRecord("rec.exec.start", "op.rec.1", "started"));
    // Post-effect capacity failure durably registers the owed terminal record.
    expect(() => store.writeRecord(executionRecord("rec.exec.end", "op.rec.1", "completed")))
      .toThrowError(expect.objectContaining({ code: "capacity_exceeded" }));
    expect(store.pendingObligations().map((p: any) => p.operationRef)).toEqual(["op.rec.1"]);
    store.close();

    store = openStore(root, policy, { budgets: { maxIndexBytes: 600 } });
    const executions = store.listRecords({ category: "execution_history", role: "role.rec.auditor" });
    expect(executions.map((r: any) => r.recordId)).toEqual(["rec.exec.start"]);
    const pending = store.pendingObligations();
    expect(pending.map((p: any) => p.operationRef)).toEqual(["op.rec.1"]);
    expect(pending[0].reason).toBe("capacity_exceeded");
    const restored = store.readArtifact({ artifactRef: artifact.artifactRef, role: "role.rec.auditor" });
    expect(restored.bytes.toString()).toBe("selected content bytes");
    expect(store.verifyIntegrity().intact).toBe(true);
    const outcome = parseRecordingOutcome(store.outcomeFor({
      operationRef: "op.rec.1",
      category: "execution_history",
      operationStatus: "succeeded"
    }));
    expect(outcome.outcome).toBe("terminal_record_pending");
    expect(outcome.pendingTerminal).toBe(true);
    store.close();
  });

  it("reserves durable capacity for required pre-effect admits and never sheds required work", () => {
    const root = tempRoot();
    const policy = makePolicy({
      execution_history: categorySelection({
        obligation: "required_before_effect",
        capacity: { maxBufferedRecords: 32, maxRecordBytes: 4_096 }
      })
    });
    const store = openStore(root, policy, { budgets: { maxPendingWrites: 3 } });
    const admitted: any[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const admission = parseRecordAdmission(store.admit({
        tenantRef: "tenant.rec.1",
        operationRef: `op.req.${i}`,
        category: "execution_history",
        phase: "pre_effect"
      }));
      expect(admission.decision).toBe("admit");
      expect(admission.obligation).toBe("required_before_effect");
      admitted.push(admission);
    }
    const state = store.sinkState("execution_history");
    expect(state.pendingWrites).toBe(3);
    expect(state.bufferedRecords).toBe(3);
    const rejected = parseRecordAdmission(store.admit({
      tenantRef: "tenant.rec.1",
      operationRef: "op.req.4",
      category: "execution_history",
      phase: "pre_effect"
    }));
    expect(rejected.decision).toBe("reject");
    expect(rejected.reason).toBe("recording_unavailable");
    expect(recordingAdmissionBlocksOperation(rejected.decision)).toBe(true);
    // Writing the admitted start record consumes its reservation.
    store.writeRecord(executionRecord("rec.req.1.start", "op.req.1", "started"));
    expect(store.sinkState("execution_history").pendingWrites).toBe(2);
    // An explicit release frees capacity honestly.
    expect(store.releaseAdmission(admitted[1].admissionId)).toBe(true);
    expect(store.sinkState("execution_history").pendingWrites).toBe(1);
    store.close();
  });

  it("sheds optional categories at capacity without blocking work", () => {
    const root = tempRoot();
    const policy = makePolicy({
      usage: categorySelection({
        fieldAllow: ["ops.completed"],
        capacity: { maxBufferedRecords: 2, maxRecordBytes: 4_096 }
      })
    });
    const store = openStore(root, policy);
    store.writeRecord(usageRecord("rec.u.1", "op.u.1"));
    store.writeRecord(usageRecord("rec.u.2", "op.u.2"));
    const shed = parseRecordAdmission(store.admit({
      tenantRef: "tenant.rec.1",
      operationRef: "op.u.3",
      category: "usage",
      phase: "post_effect"
    }));
    expect(shed.decision).toBe("shed");
    expect(shed.reason).toBe("capacity_exceeded");
    expect(recordingAdmissionBlocksOperation(shed.decision)).toBe(false);
    store.close();
  });

  it("denies disabled categories, foreign destinations, roles and unselected fields before serialization", () => {
    const root = tempRoot();
    const policy = makePolicy({
      content: categorySelection({ sinkRef: "sink.rec.other", fieldAllow: ["input.summary"] }),
      diagnostics: categorySelection({ eventAllow: ["upstream_timeout"] }),
      usage: categorySelection({ fieldAllow: ["ops.completed"], readerRoles: ["role.rec.ops"] })
    });
    const store = openStore(root, policy);
    const disabled = parseRecordAdmission(store.admit({
      tenantRef: "tenant.rec.1",
      operationRef: "op.d.1",
      category: "governance_history",
      phase: "post_effect"
    }));
    expect(disabled.decision).toBe("deny");
    expect(disabled.reason).toBe("category_disabled");

    const foreign = parseRecordAdmission(store.admit({
      tenantRef: "tenant.rec.1",
      operationRef: "op.d.2",
      category: "content",
      phase: "post_effect"
    }));
    expect(foreign.decision).toBe("deny");
    expect(foreign.reason).toBe("destination_unselected");

    const roleDenied = parseRecordAdmission(store.admit({
      tenantRef: "tenant.rec.1",
      operationRef: "op.d.3",
      category: "usage",
      phase: "post_effect",
      role: "role.rec.auditor"
    }));
    expect(roleDenied.decision).toBe("deny");
    expect(roleDenied.reason).toBe("role_unauthorized");

    const forbidden = parseRecordAdmission(store.admit({
      tenantRef: "tenant.rec.1",
      operationRef: "op.d.4",
      category: "usage",
      phase: "post_effect",
      fieldNames: ["token"]
    }));
    expect(forbidden.decision).toBe("deny");
    expect(forbidden.reason).toBe("forbidden_field");

    const unselected = parseRecordAdmission(store.admit({
      tenantRef: "tenant.rec.1",
      operationRef: "op.d.5",
      category: "diagnostics",
      phase: "post_effect",
      eventCode: "stack_dump"
    }));
    expect(unselected.decision).toBe("deny");
    expect(unselected.reason).toBe("field_not_selected");

    // The sink re-verifies fields at write time, not only at the gate.
    expect(() => store.writeRecord(record({
      recordId: "rec.diag.bad",
      category: "diagnostics",
      detail: { eventCode: "stack_dump", counters: { retries: 1 } }
    }))).toThrowError(expect.objectContaining({ code: "field_not_selected" }));
    expect(() => store.writeRecord(record({
      recordId: "rec.usage.bad",
      category: "usage",
      detail: { counters: { "ops.unlisted": 1 }, bucketStart: "2026-10-10T00:00:00Z" }
    }))).toThrowError(expect.objectContaining({ code: "field_not_selected" }));
    store.close();
  });

  it("enforces retention expiry and cohort budgets while freeing custody", () => {
    const root = tempRoot();
    const policy = makePolicy({
      usage: categorySelection({
        fieldAllow: ["ops.completed"],
        retention: { maxAgeSeconds: 60, maxRecords: 3, maxContentBytes: 0, maxIndexBytes: 32_768 }
      })
    });
    const store = openStore(root, policy);
    store.writeRecord(usageRecord("rec.old.1", "op.old.1", 1, isoAgo(120)));
    store.writeRecord(usageRecord("rec.new.1", "op.new.1"));
    store.writeRecord(usageRecord("rec.new.2", "op.new.2"));
    store.writeRecord(usageRecord("rec.new.3", "op.new.3"));
    // The fourth write prunes the expired row first, then the oldest to fit maxRecords.
    store.writeRecord(usageRecord("rec.new.4", "op.new.4"));
    const held = store.listRecords({ category: "usage", role: "role.rec.auditor" });
    expect(held.map((r: any) => r.recordId)).toEqual(["rec.new.2", "rec.new.3", "rec.new.4"]);
    const retention = store.enforceRetention();
    expect(retention.prunedRecords).toBe(0);
    expect(store.verifyIntegrity().intact).toBe(true);
    store.close();
  });

  it("prunes expired rows at open even when the category went idle while closed", () => {
    const root = tempRoot();
    let clock = 1_000_000_000;
    const now = () => clock;
    const policy = makePolicy({
      usage: categorySelection({
        fieldAllow: ["ops.completed"],
        retention: { maxAgeSeconds: 60, maxRecords: 32, maxContentBytes: 0, maxIndexBytes: 32_768 }
      })
    });
    let store = openStore(root, policy, { now });
    const at = () => new Date(clock).toISOString();
    store.writeRecord(usageRecord("rec.idle.1", "op.idle.1", 1, at()));
    store.writeRecord(usageRecord("rec.idle.2", "op.idle.2", 1, at()));
    store.close();

    // The category saw no writes while closed; the reopen sweep still
    // enforces the retention contract before the first read.
    clock += 120_000;
    store = openStore(root, policy, { now });
    expect(store.listRecords({ category: "usage", role: "role.rec.auditor" })).toEqual([]);
    expect(store.verifyIntegrity().intact).toBe(true);
    store.close();
  });

  it("runs the periodic sweep for idle categories and hides expired rows before it fires", () => {
    const root = tempRoot();
    let clock = 1_000_000_000;
    const now = () => clock;
    const policy = makePolicy({
      usage: categorySelection({
        fieldAllow: ["ops.completed"],
        retention: { maxAgeSeconds: 60, maxRecords: 32, maxContentBytes: 0, maxIndexBytes: 32_768 }
      })
    });
    vi.useFakeTimers();
    const store = openStore(root, policy, { now, retentionSweepMs: 1_000 });
    store.writeRecord(usageRecord("rec.sweep.1", "op.sweep.1", 1, new Date(clock).toISOString()));

    // Past maxAge but before the next sweep tick: the row is physically
    // held yet contractually retired — reads must not surface it.
    clock += 61_000;
    expect(store.listRecords({ category: "usage", role: "role.rec.auditor" })).toEqual([]);

    vi.advanceTimersByTime(1_500);
    const retention = store.enforceRetention();
    expect(retention.prunedRecords).toBe(0); // the timer already pruned it
    expect(store.db.prepare("SELECT COUNT(*) AS total FROM recording_records").get().total).toBe(0);
    vi.useRealTimers();
    store.close();
  });

  it("lets off win over admitted revisions while captured records settle under their own policy", () => {
    const root = tempRoot();
    const revision1 = makePolicy({
      content: categorySelection({
        fieldAllow: ["input.summary"],
        retention: { maxAgeSeconds: 3_600, maxRecords: 32, maxContentBytes: 65_536, maxIndexBytes: 32_768 }
      }),
      execution_history: categorySelection({ obligation: "required_before_effect" })
    });
    const store = openStore(root, revision1);
    const artifact = store.putArtifact({ bytes: Buffer.from("pre-off content") });
    store.writeRecord(record({
      recordId: "rec.off.1",
      category: "content",
      operationRef: "op.off.1",
      detail: {
        fieldNames: ["input.summary"],
        contentDigest: artifact.contentDigest,
        artifactRefs: [artifact.artifactRef]
      },
      contentBytes: artifact.byteSize
    }));
    store.writeRecord(executionRecord("rec.off.start", "op.off.2", "started"));

    const revision2 = makePolicy({
      execution_history: categorySelection({ obligation: "required_before_effect" })
    }, 2);
    const admitted = store.publishPolicy(revision2, "role.rec.admin");
    expect(admitted.policyRevision).toBe(2);

    // Post-off: no collection, serialization or write for the disabled category.
    const denied = parseRecordAdmission(store.admit({
      tenantRef: "tenant.rec.1",
      operationRef: "op.off.3",
      category: "content",
      phase: "post_effect"
    }));
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toBe("category_disabled");
    expect(() => store.putArtifact({ bytes: Buffer.from("post-off bytes") })).toThrowError(
      expect.objectContaining({ code: "category_disabled" })
    );
    expect(() => store.writeRecord(record({
      recordId: "rec.off.2",
      category: "content",
      detail: {
        fieldNames: ["input.summary"],
        contentDigest: artifact.contentDigest,
        artifactRefs: [artifact.artifactRef]
      },
      contentBytes: artifact.byteSize
    }))).toThrowError(expect.objectContaining({ code: "category_disabled" }));

    // Pre-off captured records still settle under their captured revision.
    const content = store.listRecords({ category: "content", role: "role.rec.auditor" });
    expect(content.map((r: any) => r.recordId)).toEqual(["rec.off.1"]);
    expect(store.readArtifact({ artifactRef: artifact.artifactRef, role: "role.rec.auditor" }).bytes.toString())
      .toBe("pre-off content");

    // Disabling a required category keeps the owed terminal record visible.
    const revision3 = makePolicy({}, 3);
    store.publishPolicy(revision3, "role.rec.admin");
    const pending = store.pendingObligations();
    expect(pending).toHaveLength(1);
    expect(pending[0].operationRef).toBe("op.off.2");
    expect(pending[0].reason).toBe("category_disabled");
    const outcome = parseRecordingOutcome(store.outcomeFor({
      operationRef: "op.off.2",
      category: "execution_history",
      operationStatus: "in_progress"
    }));
    expect(outcome.outcome).toBe("partially_recorded");
    expect(outcome.pendingTerminal).toBe(true);
    expect(store.verifyIntegrity().intact).toBe(true);
    store.close();
  });

  it("keeps terminal_record_pending visible after post-effect sink failure and reconciles recording only", () => {
    const root = tempRoot();
    const policy = makePolicy({
      execution_history: categorySelection({ obligation: "required_before_effect" })
    });
    const store = openStore(root, policy);
    store.writeRecord(executionRecord("rec.fail.start", "op.fail.1", "started"));

    // Post-effect durable failure: the effect stands; the obligation stays
    // owed. A read-only/full store cannot even mark the pending row —
    // `pendingObligations` is honestly empty — yet the derived outcome still
    // reports the owed terminal from the durable start record.
    store.db.pragma("query_only = ON");
    expect(() => store.writeRecord(executionRecord("rec.fail.end", "op.fail.1", "completed")))
      .toThrowError(expect.objectContaining({ code: "sink_unavailable" }));
    expect(store.pendingObligations()).toHaveLength(0);

    const degraded = parseRecordingOutcome(store.outcomeFor({
      operationRef: "op.fail.1",
      category: "execution_history",
      operationStatus: "succeeded",
      sinkFailure: { code: "sink_unavailable", phase: "post_effect" }
    }));
    expect(degraded.outcome).toBe("terminal_record_pending");
    expect(degraded.pendingTerminal).toBe(true);
    expect(degraded.operationStatus).toBe("succeeded");

    // A recording-only retry while the sink is still down stays visibly owed.
    const stillPending = parseRecordingOutcome(store.reconcile({
      operationRef: "op.fail.1",
      category: "execution_history",
      operationStatus: "succeeded",
      record: executionRecord("rec.fail.end", "op.fail.1", "completed")
    }));
    expect(stillPending.outcome).toBe("terminal_record_pending");
    expect(stillPending.pendingTerminal).toBe(true);

    store.db.pragma("query_only = OFF");
    const recovered = parseRecordingOutcome(store.reconcile({
      operationRef: "op.fail.1",
      category: "execution_history",
      operationStatus: "succeeded",
      record: executionRecord("rec.fail.end", "op.fail.1", "completed")
    }));
    expect(recovered.outcome).toBe("recorded");
    expect(recovered.pendingTerminal).toBe(false);
    expect(recovered.recordsWritten).toBe(2);
    expect(store.pendingObligations()).toHaveLength(0);
    expect(recordingMayReplayEffect(recovered)).toBe(false);
    expect(store.verifyIntegrity().intact).toBe(true);
    store.close();
  });

  it("rejects conflicting replays and stays idempotent for identical records", () => {
    const root = tempRoot();
    const policy = makePolicy({
      usage: categorySelection({ fieldAllow: ["ops.completed"] })
    });
    const store = openStore(root, policy);
    const first = usageRecord("rec.idem.1", "op.idem.1");
    expect(store.writeRecord(first).status).toBe("written");
    expect(store.writeRecord(first).status).toBe("replayed");
    expect(() => store.writeRecord(usageRecord("rec.idem.1", "op.idem.other")))
      .toThrowError(expect.objectContaining({ code: "recording_record_conflict" }));
    expect(store.listRecords({ category: "usage", role: "role.rec.auditor" })).toHaveLength(1);
    store.close();
  });

  it("isolates readers per category role and verifies artifact custody on read", () => {
    const root = tempRoot();
    const policy = makePolicy({
      content: categorySelection({
        fieldAllow: ["input.summary"],
        readerRoles: ["role.rec.auditor"],
        retention: { maxAgeSeconds: 3_600, maxRecords: 32, maxContentBytes: 65_536, maxIndexBytes: 32_768 }
      }),
      usage: categorySelection({ fieldAllow: ["ops.completed"], readerRoles: ["role.rec.ops"] })
    });
    const store = openStore(root, policy);
    const artifact = store.putArtifact({ bytes: Buffer.from("audited bytes") });
    store.writeRecord(record({
      recordId: "rec.read.1",
      category: "content",
      detail: {
        fieldNames: ["input.summary"],
        contentDigest: artifact.contentDigest,
        artifactRefs: [artifact.artifactRef]
      },
      contentBytes: artifact.byteSize
    }));
    store.writeRecord(usageRecord("rec.read.2", "op.rec.1"));

    expect(store.listRecords({ category: "content", role: "role.rec.auditor" })).toHaveLength(1);
    expect(store.listRecords({ category: "content", role: "role.rec.ops" })).toHaveLength(0);
    expect(store.listRecords({ category: "usage", role: "role.rec.ops" })).toHaveLength(1);
    expect(store.listRecords({ category: "usage", role: "role.rec.auditor" })).toHaveLength(0);
    expect(store.readArtifact({ artifactRef: artifact.artifactRef, role: "role.rec.auditor" }).bytes.toString())
      .toBe("audited bytes");
    expect(() => store.readArtifact({ artifactRef: artifact.artifactRef, role: "role.rec.ops" }))
      .toThrowError(expect.objectContaining({ code: "role_unauthorized" }));

    // Custody honesty: unresolved refs and byte mismatches are refused.
    const orphan = store.putArtifact({ bytes: Buffer.from("staged bytes") });
    expect(() => store.readArtifact({ artifactRef: orphan.artifactRef, role: "role.rec.auditor" }))
      .toThrowError(expect.objectContaining({ code: "role_unauthorized" }));
    expect(() => store.writeRecord(record({
      recordId: "rec.read.3",
      category: "content",
      detail: {
        fieldNames: ["input.summary"],
        contentDigest: artifact.contentDigest,
        artifactRefs: ["art.rec.missing"]
      },
      contentBytes: 8
    }))).toThrowError(expect.objectContaining({ code: "recording_artifact_unresolved" }));
    expect(() => store.writeRecord(record({
      recordId: "rec.read.4",
      category: "content",
      detail: {
        fieldNames: ["input.summary"],
        contentDigest: artifact.contentDigest,
        artifactRefs: [artifact.artifactRef]
      },
      contentBytes: artifact.byteSize + 1
    }))).toThrowError(expect.objectContaining({ code: "recording_artifact_bytes_mismatch" }));
    store.close();
  });

  it("detects record, journal and artifact tampering through the digest chain", () => {
    const root = tempRoot();
    const policy = makePolicy({
      content: categorySelection({
        fieldAllow: ["input.summary"],
        retention: { maxAgeSeconds: 3_600, maxRecords: 32, maxContentBytes: 65_536, maxIndexBytes: 32_768 }
      }),
      usage: categorySelection({ fieldAllow: ["ops.completed"] })
    });
    const store = openStore(root, policy);
    const artifact = store.putArtifact({ bytes: Buffer.from("chain bytes") });
    store.writeRecord(record({
      recordId: "rec.chain.1",
      category: "content",
      detail: {
        fieldNames: ["input.summary"],
        contentDigest: artifact.contentDigest,
        artifactRefs: [artifact.artifactRef]
      },
      contentBytes: artifact.byteSize
    }));
    store.writeRecord(usageRecord("rec.chain.2", "op.rec.1"));
    const intact = store.verifyIntegrity();
    expect(intact.intact).toBe(true);
    expect(intact.recordsChecked).toBe(2);
    expect(intact.artifactsChecked).toBe(1);

    // Row-level tampering diverges from the journaled digest chain.
    store.db.prepare("UPDATE recording_records SET record_json = ? WHERE record_id = ?")
      .run("{\"tampered\":true}", "rec.chain.2");
    const tampered = store.verifyIntegrity();
    expect(tampered.intact).toBe(false);
    expect(tampered.divergences.some((d: string) => d.includes("record digest mismatch"))).toBe(true);
    store.db.prepare("DELETE FROM recording_records WHERE record_id = ?").run("rec.chain.2");
    const missing = store.verifyIntegrity();
    expect(missing.divergences.some((d: string) => d.includes("journaled record missing"))).toBe(true);

    const artifactPath = path.join(root, "artifacts", artifact.artifactRef.slice(4));
    fs.writeFileSync(artifactPath, Buffer.from("forged bytes"));
    const forged = store.verifyIntegrity();
    expect(forged.divergences.some((d: string) => d.includes("artifact digest mismatch"))).toBe(true);
    expect(() => store.readArtifact({ artifactRef: artifact.artifactRef, role: "role.rec.auditor" }))
      .toThrowError(expect.objectContaining({ code: "recording_artifact_corrupt" }));
    store.close();
  });

  it("expires stale reservations so capacity recovers honestly", () => {
    const root = tempRoot();
    let clock = 1_000_000;
    const policy = makePolicy({
      execution_history: categorySelection({
        obligation: "required_before_effect",
        capacity: { maxBufferedRecords: 1, maxRecordBytes: 4_096 }
      })
    });
    const store = openStore(root, policy, {
      now: () => clock,
      budgets: { maxPendingWrites: 8 }
    });
    const first = parseRecordAdmission(store.admit({
      tenantRef: "tenant.rec.1",
      operationRef: "op.ttl.1",
      category: "execution_history",
      phase: "pre_effect"
    }));
    expect(first.decision).toBe("admit");
    const blocked = parseRecordAdmission(store.admit({
      tenantRef: "tenant.rec.1",
      operationRef: "op.ttl.2",
      category: "execution_history",
      phase: "pre_effect"
    }));
    expect(blocked.decision).toBe("reject");
    clock += 16 * 60 * 1000;
    const afterExpiry = parseRecordAdmission(store.admit({
      tenantRef: "tenant.rec.1",
      operationRef: "op.ttl.2",
      category: "execution_history",
      phase: "pre_effect"
    }));
    expect(afterExpiry.decision).toBe("admit");
    store.close();
  });

  it("admits nothing under an empty policy selection", () => {
    const root = tempRoot();
    const store = openStore(root, makePolicy({}));
    for (const category of RECORDING_CATEGORIES) {
      const admission = parseRecordAdmission(store.admit({
        tenantRef: "tenant.rec.1",
        operationRef: `op.empty.${category}`,
        category,
        phase: "post_effect"
      }));
      expect(admission.decision, category).toBe("deny");
      expect(admission.reason, category).toBe("category_disabled");
    }
    store.close();
  });
});
